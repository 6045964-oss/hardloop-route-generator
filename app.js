/* ==========================================================================
   Hardloop Route Generator — app.js
   Puur client-side: Leaflet + OpenRouteService + Web APIs.
   ========================================================================== */
'use strict';

(() => {
  // ---------------------------------------------------------------------------
  // Instellingen
  // ---------------------------------------------------------------------------
  const CONFIG = Object.assign({ ORS_API_KEY: '', OFF_ROUTE_METERS: 20 }, window.HRG_CONFIG || {});

  const ORS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson';
  const ORS_TIMEOUT_MS = 25000;
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_CACHE = 'hrg-tiles-v1';          // zelfde naam als in service-worker.js
  const PREFETCH_ZOOMS = [13, 14, 15, 16, 17];
  const MAX_PREFETCH_TILES = 700;
  const PREFETCH_CONCURRENCY = 2;             // vriendelijk voor de OSM-tileservers

  const OFF_ROUTE_M = Number(CONFIG.OFF_ROUTE_METERS) || 20;
  const BACK_ON_ROUTE_M = Math.max(8, OFF_ROUTE_M - 6); // hysterese: geen gestotter rond de grens
  const MAX_GPS_ACCURACY_M = 35;              // slechtere fixes negeren we voor de afwijking
  const WARN_REPEAT_MS = 15000;
  const GPS_STALE_MS = 15000;

  const MIN_KM = 1;
  const MAX_KM = 42;
  const STEP_KM = 0.5;
  const HISTORY_LIMIT = 60;

  const TOLERANCE_M = 250;          // max. verschil met de gevraagde afstand (minimaal)…
  const TOLERANCE_REL = 0.03;       // …en vanaf ~8 km relatief: 3% van de gevraagde afstand
  const PRIORITY_DEV_REL = 0.05;    // bij het kiezen tussen kandidaten: eerst "binnen 5%"
  const MAX_ATTEMPTS = 8;           // max. aantal ORS-aanvragen per "Genereer route" (gratis plan)
  const ORS_PER_MINUTE = 36;        // ORS staat 40 per minuut toe (glijdend venster); marge voor andere tabbladen
  const ORS_WINDOW_MS = 60000;
  const LENGTH_OBS_LIMIT = 40;      // zoveel recente (lengte, verhouding)-metingen bewaren
  const MAX_SAME_SEED = 3;          // lengte bijstellen met dezelfde vorm, daarna andere vorm
  const OVERLAP_ALLOWED_M = 30;     // dubbel lopen buiten de start/finish-zone
  const START_ZONE_M = 150;         // rond start/finish mag wel een stukje dubbel
  const AHEAD_M = 400;              // lengte van het gemarkeerde komende stuk tijdens het lopen
  const TURN_PREWARN_M = 55;        // "Over 50 meter linksaf"
  const TURN_NOW_M = 18;            // "Nu linksaf"

  const KEYS = {
    history: 'hrg.history.v1',
    theme: 'hrg.theme',
    apiKey: 'hrg.orsKey',
    distance: 'hrg.distance',
    lengthObs: 'hrg.lengthObs.v1',
    prefs: 'hrg.prefs.v1',
    orsLog: 'hrg.orsLog.v1',
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    sheet: $('sheet'),
    planView: $('planView'),
    runView: $('runView'),
    notice: $('notice'),
    noticeTitle: $('noticeTitle'),
    noticeText: $('noticeText'),
    noticeAction: $('noticeAction'),
    noticeClose: $('noticeClose'),
    startLabel: $('startLabel'),
    btnUseGps: $('btnUseGps'),
    distanceInput: $('distanceInput'),
    btnMinus: $('btnMinus'),
    btnPlus: $('btnPlus'),
    chips: document.querySelectorAll('.chip'),
    btnGenerate: $('btnGenerate'),
    result: $('result'),
    resultKm: $('resultKm'),
    resultMeta: $('resultMeta'),
    resultInfo: $('resultInfo'),
    resultChecks: $('resultChecks'),
    prefsList: $('prefsList'),
    prefsSummary: $('prefsSummary'),
    tileBar: $('tileBar'),
    tileText: $('tileText'),
    btnAgain: $('btnAgain'),
    btnStart: $('btnStart'),
    runStatus: $('runStatus'),
    runStatusText: $('runStatusText'),
    statTime: $('statTime'),
    statDone: $('statDone'),
    statLeft: $('statLeft'),
    statDev: $('statDev'),
    wakeWarn: $('wakeWarn'),
    speechWarn: $('speechWarn'),
    btnStop: $('btnStop'),
    navIcon: $('navIcon'),
    navDist: $('navDist'),
    navWhat: $('navWhat'),
    btnLocate: $('btnLocate'),
    btnHistory: $('btnHistory'),
    btnTheme: $('btnTheme'),
    btnKey: $('btnKey'),
    historyDialog: $('historyDialog'),
    historyList: $('historyList'),
    historySummary: $('historySummary'),
    historyEmpty: $('historyEmpty'),
    keyDialog: $('keyDialog'),
    keyForm: $('keyForm'),
    keyInput: $('keyInput'),
    btnKeyClear: $('btnKeyClear'),
  };

  // ---------------------------------------------------------------------------
  // Hulpfuncties
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* negeren */ }
    },
  };

  const nf1 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfKm = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
  const dateFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');
  const round5 = (m) => Math.max(5, Math.round(m / 5) * 5);

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  // Afstand in meters tussen [lat, lng]-paren
  function haversine(a, b) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toRad;
    const dLng = (b[1] - a[1]) * toRad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Lokale platte projectie (meters) rond een referentiepunt — nauwkeurig genoeg op hardloopschaal.
  function makeProjector(lat0, lng0) {
    const kx = Math.cos(lat0 * Math.PI / 180) * 111320;
    const ky = 110574;
    return {
      fwd: (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * ky],
      inv: (x, y) => [lat0 + y / ky, lng0 + x / kx],
    };
  }

  function bearing(a, b) {
    const dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
    const dy = b[0] - a[0];
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  }

  class AppError extends Error {
    constructor(title, message, { retry = false, fatal = false } = {}) {
      super(message);
      this.title = title;
      this.retry = retry;
      this.fatal = fatal;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Gebeurtenissen voor losse functies (bijv. het paneel): 'route-shown', 'route-cleared',
  // 'generate-start', 'run-start', 'run-stop'.
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(`hrg:${name}`, { detail }));
  }

  // Aanhaakpunten: de standaard is "afstand in km". Functies verderop mogen ze vervangen.
  const hooks = {
    readTarget: () => { const km = readKm(); return km ? { meters: km * 1000 } : null; },
    step: (dir) => {
      const cur = parseKm(els.distanceInput.value) || 5;
      setKm(dir < 0 ? Math.ceil(cur / STEP_KM) * STEP_KM - STEP_KM : Math.floor(cur / STEP_KM) * STEP_KM + STEP_KM);
    },
    chip: (chip) => setKm(Number(chip.dataset.km)),
    inputChange: () => {
      const km = parseKm(els.distanceInput.value);
      if (Number.isFinite(km)) setKm(km, { bump: false });
    },
    requestedText: (entry) => `Gevraagd ${nfKm.format(entry.requested / 1000)} km`,
    restoreInput: (entry) => setKm(entry.requested / 1000, { bump: false }),
    mapClick: () => false, // true = klik is afgehandeld (niet als startpunt gebruiken)
  };

  // ---------------------------------------------------------------------------
  // Toestand
  // ---------------------------------------------------------------------------
  const state = {
    userPos: null,        // [lat, lng]
    start: null,          // { latlng: [lat, lng], source: 'gps' | 'manual' }
    route: null,          // opgeslagen route + .geo (berekende geometrie)
    lastSeed: null,
    run: null,
    generating: false,
  };

  // ---------------------------------------------------------------------------
  // Meldingen
  // ---------------------------------------------------------------------------
  let noticeActionHandler = null;
  let noticeTimer = null;

  function showNotice(type, title, text, { action = null, autoHide = 0 } = {}) {
    clearTimeout(noticeTimer);
    const n = els.notice;
    n.hidden = false;
    n.dataset.type = type;
    els.noticeTitle.textContent = title;
    els.noticeText.textContent = text;
    if (action) {
      els.noticeAction.hidden = false;
      els.noticeAction.textContent = action.label;
      noticeActionHandler = action.onClick;
    } else {
      els.noticeAction.hidden = true;
      noticeActionHandler = null;
    }
    // animatie opnieuw starten
    n.style.animation = 'none';
    void n.offsetWidth;
    n.style.animation = '';
    if (autoHide) noticeTimer = setTimeout(hideNotice, autoHide);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    els.notice.hidden = true;
    noticeActionHandler = null;
  }

  els.noticeClose.addEventListener('click', hideNotice);
  els.noticeAction.addEventListener('click', () => {
    const fn = noticeActionHandler;
    hideNotice();
    if (fn) fn();
  });

  // ---------------------------------------------------------------------------
  // Thema (auto / licht / donker)
  // ---------------------------------------------------------------------------
  const THEME_LABELS = { auto: 'automatisch', light: 'licht (zonlicht)', dark: 'donker' };

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
    els.btnTheme.dataset.mode = mode;
    els.btnTheme.setAttribute('aria-label', `Weergave: ${THEME_LABELS[mode]}. Tik om te wisselen.`);
  }

  els.btnTheme.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const current = store.get(KEYS.theme, 'auto');
    const next = order[(order.indexOf(current) + 1) % order.length];
    store.set(KEYS.theme, next);
    applyTheme(next);
    showNotice('info', 'Weergave', `Weergave staat nu op ${THEME_LABELS[next]}.`, { autoHide: 2200 });
  });

  applyTheme(store.get(KEYS.theme, 'auto'));

  // ---------------------------------------------------------------------------
  // Kaart
  // ---------------------------------------------------------------------------
  if (typeof L === 'undefined') {
    showNotice('error', 'Kaart niet geladen',
      'De kaartbibliotheek kon niet worden geladen. Controleer je internetverbinding en open de app opnieuw.',
      { action: { label: 'Herladen', onClick: () => location.reload() } });
    return;
  }

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
  }).setView([52.2, 5.3], 7);

  const tileLayer = L.tileLayer(TILE_URL, {
    maxZoom: 19,
    crossOrigin: true, // CORS-responses: beter te cachen dan opaque responses
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Route: <a href="https://openrouteservice.org">openrouteservice</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);

  // Kreeg de kaart bij het opstarten nog geen maat (stylesheet nog niet toegepast, of
  // het scherm draait), dan meet Leaflet opnieuw zodra de container echt groot is.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());
  }

  // Kaarttegels bewaken: nooit stil een lege kaart. Laden er na het opstarten geen
  // tegels, of mislukken ze herhaaldelijk zonder dat er één lukt, dan een melding.
  const tileHealth = { loaded: 0, failedSinceLoad: 0, warned: false };
  const MAP_NOTICE_TITLE = 'Kaart laadt niet';
  function retryTiles() {
    tileHealth.failedSinceLoad = 0;
    tileHealth.warned = false;
    map.invalidateSize();
    tileLayer.redraw();
    setTimeout(checkTiles, 10000);
  }
  function warnTiles() {
    if (tileHealth.warned) return;
    tileHealth.warned = true;
    if (!navigator.onLine) {
      showNotice('info', MAP_NOTICE_TITLE,
        'Geen internet, en dit stuk van de kaart is niet offline opgeslagen. Je route en de gesproken aanwijzingen werken gewoon door.',
        { autoHide: 6000 });
    } else {
      showNotice('warn', MAP_NOTICE_TITLE,
        'De kaarttegels komen niet binnen. Je route en de gesproken aanwijzingen werken gewoon door.',
        { action: { label: 'Opnieuw', onClick: retryTiles } });
    }
  }
  function checkTiles() {
    if (map.getContainer().clientHeight < 50) map.invalidateSize();
    if (tileHealth.loaded === 0 || tileHealth.failedSinceLoad >= 8) warnTiles();
  }
  tileLayer.on('tileload', () => {
    tileHealth.loaded++;
    tileHealth.failedSinceLoad = 0;
    if (tileHealth.warned) {
      tileHealth.warned = false;
      if (els.noticeTitle.textContent === MAP_NOTICE_TITLE) hideNotice();
    }
  });
  tileLayer.on('tileerror', (e) => {
    tileHealth.failedSinceLoad++;
    console.warn('Kaarttegel niet geladen:', e.coords && `${e.coords.z}/${e.coords.x}/${e.coords.y}`);
    if (tileHealth.failedSinceLoad >= 8) warnTiles();
  });
  setTimeout(checkTiles, 12000);

  const routeLayer = L.layerGroup().addTo(map);
  const decoLayer = L.layerGroup().addTo(map);
  let routeLine = null;
  let doneLine = null;
  let antsLine = null;
  let startMarker = null;
  let userMarker = null;
  let accuracyCircle = null;
  let guideLine = null;

  const startIcon = L.divIcon({ className: 'pin pin--start', html: '<span>S</span>', iconSize: [36, 36], iconAnchor: [18, 18] });
  const meIcon = L.divIcon({ className: 'pin pin--me', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] });

  // Hoeveel van de kaart wordt bedekt door de sheet/topbar? Nodig om punten zichtbaar te centreren.
  function isWide() { return window.matchMedia('(min-width: 768px)').matches; }

  function visibleCenterOffset() {
    const mapRect = map.getContainer().getBoundingClientRect();
    const sheetRect = els.sheet.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const cx = mapRect.width / 2;
    const cy = mapRect.height / 2;
    if (isWide()) {
      const vx = (sheetRect.right + mapRect.width) / 2;
      const vy = (topbar.bottom + mapRect.height) / 2;
      return L.point(cx - vx, cy - vy);
    }
    const vy = (topbar.bottom + sheetRect.top) / 2;
    return L.point(0, cy - vy);
  }

  function focusOn(latlng, zoom, animate = true) {
    const z = zoom ?? map.getZoom();
    const p = map.project(latlng, z).add(visibleCenterOffset());
    map.setView(map.unproject(p, z), z, { animate });
  }

  function fitPadding() {
    const sheetRect = els.sheet.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    if (isWide()) {
      return { paddingTopLeft: [sheetRect.right + 24, topbar.bottom + 16], paddingBottomRight: [32, 32] };
    }
    const mapH = map.getContainer().getBoundingClientRect().height;
    return { paddingTopLeft: [24, topbar.bottom + 16], paddingBottomRight: [24, mapH - sheetRect.top + 24] };
  }

  function setStartMarker(latlng) {
    if (!startMarker) {
      startMarker = L.marker(latlng, { icon: startIcon, keyboard: false, interactive: false, zIndexOffset: 500 }).addTo(map);
    } else {
      startMarker.setLatLng(latlng);
    }
  }

  function setUserMarker(latlng, accuracy) {
    if (!userMarker) {
      userMarker = L.marker(latlng, { icon: meIcon, keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
      accuracyCircle = L.circle(latlng, { radius: accuracy || 10, className: 'accuracy', interactive: false }).addTo(map);
    } else {
      userMarker.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng).setRadius(accuracy || 10);
    }
  }

  // ---------------------------------------------------------------------------
  // Startpunt & locatie
  // ---------------------------------------------------------------------------
  function setStart(latlng, source) {
    const moved = !state.start || haversine(state.start.latlng, latlng) > 15;
    state.start = { latlng, source };
    setStartMarker(latlng);
    els.startLabel.textContent = source === 'gps' ? 'Jouw huidige locatie' : 'Gekozen punt op de kaart';
    els.btnUseGps.hidden = source === 'gps';
    if (moved && state.route && !state.run) clearRoute();
  }

  function geoErrorMessage(err) {
    switch (err && err.code) {
      case 1: return new AppError('Locatie geweigerd',
        'De app mag je locatie niet gebruiken. Zet het aan via Instellingen › Privacy en beveiliging › Locatievoorzieningen › Safari-websites (of via de app op je beginscherm) › "Bij gebruik". Je kunt ook op de kaart tikken om zelf een startpunt te kiezen.');
      case 2: return new AppError('Locatie niet gevonden',
        'Je positie kon niet bepaald worden. Ga naar buiten voor beter GPS-bereik, of tik op de kaart om zelf een startpunt te kiezen.', { retry: true });
      case 3: return new AppError('Locatie duurt te lang',
        'Het bepalen van je positie duurde te lang. Probeer het opnieuw, of tik op de kaart om zelf een startpunt te kiezen.', { retry: true });
      default: return new AppError('Locatie niet beschikbaar',
        'Je locatie kon niet worden opgehaald. Tik op de kaart om zelf een startpunt te kiezen.', { retry: true });
    }
  }

  let locating = false;

  function locate({ setAsStart = true } = {}) {
    if (!('geolocation' in navigator)) {
      els.startLabel.textContent = 'Tik op de kaart';
      showNotice('error', 'Geen locatie', 'Deze browser kan je locatie niet bepalen. Tik op de kaart om zelf een startpunt te kiezen.');
      return;
    }
    if (locating) return;
    locating = true;
    els.btnLocate.classList.add('is-busy');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        els.btnLocate.classList.remove('is-busy');
        const latlng = [pos.coords.latitude, pos.coords.longitude];
        state.userPos = latlng;
        setUserMarker(latlng, pos.coords.accuracy);
        if (setAsStart) setStart(latlng, 'gps');
        if (!state.route) focusOn(latlng, 15);
        if (els.notice.dataset.type === 'error' && /Locatie/.test(els.noticeTitle.textContent)) hideNotice();
      },
      (err) => {
        locating = false;
        els.btnLocate.classList.remove('is-busy');
        if (!state.start) els.startLabel.textContent = 'Tik op de kaart';
        const e = geoErrorMessage(err);
        showNotice('error', e.title, e.message, e.retry ? { action: { label: 'Opnieuw', onClick: () => locate({ setAsStart }) } } : {});
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 }
    );
  }

  map.on('click', (e) => {
    if (state.run || state.generating) return;
    if (hooks.mapClick(e)) return;
    const hadRoute = !!state.route;
    setStart([e.latlng.lat, e.latlng.lng], 'manual');
    if (hadRoute && !state.route) {
      showNotice('info', 'Nieuw startpunt', 'Genereer een nieuwe route vanaf dit punt. De vorige staat in je geschiedenis.', { autoHide: 4000 });
    } else {
      hideNotice();
    }
  });

  els.btnUseGps.addEventListener('click', () => {
    if (state.userPos) {
      setStart(state.userPos, 'gps');
      focusOn(state.userPos, Math.max(map.getZoom(), 15));
    }
    locate({ setAsStart: true });
  });

  els.btnLocate.addEventListener('click', () => {
    if (state.run) {
      state.run.follow = true;
      els.btnLocate.classList.remove('is-lost');
      if (state.userPos) focusOn(state.userPos, Math.max(map.getZoom(), 16));
      return;
    }
    if (state.userPos) focusOn(state.userPos, Math.max(map.getZoom(), 15));
    locate({ setAsStart: !state.start || state.start.source === 'gps' });
  });

  // ---------------------------------------------------------------------------
  // Afstand-invoer
  // ---------------------------------------------------------------------------
  function parseKm(value) {
    const n = parseFloat(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  function setKm(km, { bump = true } = {}) {
    const v = clamp(Math.round(km * 10) / 10, MIN_KM, MAX_KM);
    els.distanceInput.value = nfKm.format(v);
    store.set(KEYS.distance, v);
    els.chips.forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.km) === v)));
    if (bump && !reducedMotion) {
      const field = els.distanceInput.parentElement;
      field.classList.remove('bump');
      void field.offsetWidth;
      field.classList.add('bump');
    }
  }

  function readKm() {
    const km = parseKm(els.distanceInput.value);
    if (!Number.isFinite(km) || km < MIN_KM || km > MAX_KM) {
      showNotice('error', 'Ongeldige afstand', `Vul een afstand in tussen ${MIN_KM} en ${MAX_KM} kilometer.`);
      els.distanceInput.focus();
      return null;
    }
    return km;
  }

  els.btnMinus.addEventListener('click', () => hooks.step(-1));
  els.btnPlus.addEventListener('click', () => hooks.step(1));
  els.chips.forEach((chip) => chip.addEventListener('click', () => hooks.chip(chip)));
  els.distanceInput.addEventListener('change', () => hooks.inputChange());
  els.distanceInput.addEventListener('focus', () => els.distanceInput.select());
  els.distanceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.distanceInput.blur();
      generateRoute();
    }
  });

  setKm(store.get(KEYS.distance, 5), { bump: false });

  // ---------------------------------------------------------------------------
  // API-sleutel
  // ---------------------------------------------------------------------------
  function getApiKey() {
    const local = store.get(KEYS.apiKey, '');
    if (local) return local;
    const cfg = String(CONFIG.ORS_API_KEY || '').trim();
    return cfg && !/jouw|your|hier/i.test(cfg) ? cfg : '';
  }

  function openKeyDialog() {
    els.keyInput.value = store.get(KEYS.apiKey, '');
    openDialog(els.keyDialog);
    setTimeout(() => els.keyInput.focus(), 50);
  }

  els.btnKey.addEventListener('click', openKeyDialog);
  els.keyForm.addEventListener('submit', (e) => {
    const key = els.keyInput.value.trim();
    if (!key) { e.preventDefault(); els.keyInput.focus(); return; }
    store.set(KEYS.apiKey, key);
    showNotice('success', 'Sleutel opgeslagen', 'Je kunt nu routes genereren.', { autoHide: 3000 });
  });
  els.btnKeyClear.addEventListener('click', () => {
    store.remove(KEYS.apiKey);
    els.keyInput.value = '';
    els.keyInput.focus();
  });

  // ---------------------------------------------------------------------------
  // Route genereren (OpenRouteService round trip)
  // ---------------------------------------------------------------------------
  function newSeed() {
    let seed;
    do {
      const buf = new Uint32Array(1);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(buf) : (buf[0] = Math.random() * 2 ** 32);
      seed = (buf[0] % 99999) + 1;
    } while (seed === state.lastSeed);
    state.lastSeed = seed;
    return seed;
  }

  // fatal = opnieuw proberen met een andere seed heeft geen zin
  function orsError(status, body) {
    const code = body && body.error && (body.error.code ?? body.error);
    const apiMsg = body && body.error && body.error.message;
    if (status === 403 && /quota|limit/i.test(JSON.stringify(body || ''))) {
      return new AppError('Daglimiet bereikt',
        'Je hebt vandaag alle gratis routeverzoeken van OpenRouteService gebruikt (2000 per dag). Morgen kan het weer.', { fatal: true });
    }
    if (status === 401 || status === 403) {
      return new AppError('Sleutel werkt niet',
        'OpenRouteService weigert je API-sleutel. Controleer of je hem goed hebt geplakt, of maak een nieuwe aan.', { fatal: true });
    }
    if (status === 429) {
      return new AppError('Even te veel verzoeken',
        'Je hebt de gratis limiet van OpenRouteService (tijdelijk) bereikt. Wacht een minuut en probeer het opnieuw.', { retry: true, fatal: true });
    }
    if (code === 2010) {
      return new AppError('Startpunt niet bereikbaar',
        'Er ligt geen weg of pad vlak bij dit startpunt. Tik op de kaart op een punt dichter bij een weg of pad.', { fatal: true });
    }
    if (code === 2009 || status === 404) {
      return new AppError('Geen route gevonden',
        'Er kon geen rondje over looppaden gevonden worden binnen deze afstand vanaf dit startpunt. Kies een startpunt dichter bij een weg of pad, of probeer een andere afstand.', { retry: true });
    }
    if (code === 2004) {
      return new AppError('Afstand te groot', 'Deze afstand is te groot voor de routeservice. Kies een kortere afstand.', { fatal: true });
    }
    if (status >= 500) {
      return new AppError('Routeservice onbereikbaar',
        'OpenRouteService heeft op dit moment een storing. Probeer het over een paar minuten opnieuw.', { retry: true, fatal: true });
    }
    return new AppError('Route maken mislukt',
      `De routeservice gaf een foutmelding${apiMsg ? `: "${apiMsg}"` : ` (code ${status})`}.`, { retry: true, fatal: true });
  }

  // Alleen stappen die een richtingsverandering zijn, compact opgeslagen.
  const TURN_TYPES = new Set([0, 1, 2, 3, 4, 5, 7, 9, 12, 13]);

  // Minuutlimiet van ORS (glijdend venster van 60 s): wachten tot er ruimte is. Het logboek
  // staat in localStorage, zodat ook herladen of een tweede tabblad meetelt.
  let orsLogMem = [];
  function recentOrsCalls(now) {
    const saved = store.get(KEYS.orsLog, []);
    const all = (Array.isArray(saved) ? saved : []).concat(orsLogMem);
    return [...new Set(all)].filter((t) => now - t < ORS_WINDOW_MS).sort((x, y) => x - y);
  }
  async function waitForOrsSlot(onWait) {
    for (;;) {
      const now = Date.now();
      const log = recentOrsCalls(now);
      if (log.length < ORS_PER_MINUTE) {
        log.push(now);
        orsLogMem = log;
        store.set(KEYS.orsLog, log);
        return;
      }
      onWait(Math.ceil((ORS_WINDOW_MS - (now - log[0])) / 1000));
      await sleep(1000);
    }
  }

  // Eén ORS-verzoek. Alle extra_info en de hoogte zitten in hetzelfde verzoek (buildRequest).
  async function requestRoute(body, key, onWait = () => {}) {
    await waitForOrsSlot(onWait);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ORS_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(ORS_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': key,
          'Content-Type': 'application/json',
          'Accept': 'application/geo+json, application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new AppError('Geen antwoord', 'De routeservice reageert niet op tijd. Controleer je verbinding en probeer het opnieuw.', { retry: true, fatal: true });
      }
      throw new AppError('Geen verbinding', 'De routeservice is niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.', { retry: true, fatal: true });
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    try { json = await res.json(); } catch { /* geen JSON */ }
    if (!res.ok) throw orsError(res.status, json);

    const feature = json && json.features && json.features[0];
    const line = feature && feature.geometry && feature.geometry.coordinates;
    if (!line || line.length < 2) {
      throw new AppError('Geen route gevonden',
        'Er kon geen rondje gevonden worden binnen deze afstand. Probeer een ander startpunt of een andere afstand.', { retry: true });
    }

    const coords = line.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
    const props = feature.properties || {};
    let distance = props.summary && props.summary.distance;
    if (!Number.isFinite(distance)) {
      distance = coords.reduce((sum, c, i) => (i ? sum + haversine(coords[i - 1], c) : 0), 0);
    }
    if (distance < 200) {
      throw new AppError('Geen route gevonden',
        'Er is geen bruikbaar rondje gevonden vanaf dit punt. Kies een startpunt op of vlak bij een weg of pad.', { retry: true });
    }
    const steps = (props.segments || [])
      .flatMap((s) => s.steps || [])
      .filter((st) => TURN_TYPES.has(st.type) && Array.isArray(st.way_points))
      .map((st) => ({
        t: st.type,
        n: st.name && st.name !== '-' ? st.name : '',
        w: st.way_points[0],
        x: st.exit_number || 0,
      }));
    const extras = {};
    Object.entries(props.extras || {}).forEach(([kind, v]) => {
      if (v && Array.isArray(v.values)) extras[kind] = v.values;
    });
    return { coords, distance, steps, extras, ascent: props.ascent, descent: props.descent };
  }

  function cumulativeMeters(coords) {
    const cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1], coords[i]);
    return cum;
  }

  // Meters per waarde van één extra_info-soort ('surface', 'waytype', …), geschaald naar de
  // routelengte van ORS. ORS levert [vanIndex, totIndex, waarde] per stuk.
  function extraMeters(cand, kind) {
    const values = cand.extras && cand.extras[kind];
    if (!values || !values.length) return null;
    const cum = cand.cumM || (cand.cumM = cumulativeMeters(cand.coords));
    const last = cum.length - 1;
    const out = {};
    let sum = 0;
    values.forEach(([from, to, value]) => {
      const m = Math.max(0, cum[Math.min(to, last)] - cum[Math.min(from, last)]);
      out[value] = (out[value] || 0) + m;
      sum += m;
    });
    const scale = sum > 0 ? cand.distance / sum : 1;
    Object.keys(out).forEach((v) => { out[v] *= scale; });
    return out;
  }

  // Meet hoeveel meter van de route je dubbel loopt (heen en terug over hetzelfde stuk,
  // of er vlak naast). Kruisingen tellen niet mee: alleen (anti)parallelle stukken.
  // Rond start/finish mag het (je eigen straat uit en weer in), en rond freePoints ook
  // (bijv. een zelfgekozen via-punt aan het eind van een doodlopend pad).
  function measureOverlap(coords, freePoints = []) {
    const geo = prepareGeo(coords);
    const { pts, cum, total } = geo;
    const STEP = 10;
    const NEAR = 12;
    const GAP = 80;
    const samples = [];
    let seg = 1;
    for (let a = 0; a <= total; a += STEP) {
      while (seg < cum.length - 1 && cum[seg] < a) seg++;
      const p0 = pts[seg - 1];
      const p1 = pts[seg];
      const len = cum[seg] - cum[seg - 1] || 1;
      const t = clamp((a - cum[seg - 1]) / len, 0, 1);
      samples.push({
        x: p0[0] + (p1[0] - p0[0]) * t,
        y: p0[1] + (p1[1] - p0[1]) * t,
        ux: (p1[0] - p0[0]) / len,
        uy: (p1[1] - p0[1]) / len,
        a,
      });
    }
    const free = freePoints.map(([la, ln]) => geo.proj.fwd(la, ln));
    const inZone = (s) => s.a < START_ZONE_M || s.a > total - START_ZONE_M
      || free.some(([fx, fy]) => Math.hypot(s.x - fx, s.y - fy) < START_ZONE_M);
    const hit = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      for (let j = i + 1; j < samples.length; j++) {
        const q = samples[j];
        const gap = q.a - s.a;
        if (gap <= GAP || total - gap <= GAP) continue; // buren langs de lus
        const dx = q.x - s.x;
        const dy = q.y - s.y;
        if (dx * dx + dy * dy > NEAR * NEAR) continue;
        if (Math.abs(s.ux * q.ux + s.uy * q.uy) < 0.85) continue; // kruising, geen dubbel stuk
        if (inZone(s) && inZone(q)) continue;
        hit[i] = 1;
        hit[j] = 1;
      }
    }
    // Twee keer over hetzelfde stuk = twee rakende samples; /2 geeft de lengte van het stuk.
    return (hit.reduce((n, h) => n + h, 0) * STEP) / 2;
  }

  function lengthTolerance(target) {
    return Math.max(TOLERANCE_M, target * TOLERANCE_REL);
  }

  // Hoeveel langer (of korter) dan gevraagd maakt ORS een rondje van ongeveer deze lengte?
  // ORS wijkt per afstand anders af, dus alleen metingen van vergelijkbare lengte tellen
  // (gewicht valt weg met de log-verhouding). Gewogen gemiddelde van de metingen rond de
  // gewogen mediaan: uitschieters (een rare vorm) tellen niet mee, en het springt minder.
  // Elke strategie (round trip, via-punt) heeft een eigen geheugen (storeKey).
  function predictLengthRatio(meters, storeKey = KEYS.lengthObs, prior = 1.05) {
    const obs = store.get(storeKey, []);
    const items = [{ r: prior, w: 0.5 }]; // zwakke startwaarde zolang er weinig metingen zijn
    if (Array.isArray(obs)) {
      obs.forEach(([m, r], i) => {
        if (!(m > 0 && r > 0)) return;
        const d = Math.log(meters / m);
        const recency = 0.5 + (0.5 * (i + 1)) / obs.length;
        items.push({ r, w: Math.exp(-(d * d) / (2 * 0.25 * 0.25)) * recency });
      });
    }
    items.sort((a, b) => a.r - b.r);
    const half = items.reduce((sum, it) => sum + it.w, 0) / 2;
    let acc = 0;
    let median = prior;
    for (const it of items) {
      acc += it.w;
      if (acc >= half) { median = it.r; break; }
    }
    const near = items.filter((it) => Math.abs(it.r / median - 1) <= 0.15);
    const w = near.reduce((sum, it) => sum + it.w, 0);
    const mean = w > 0 ? near.reduce((sum, it) => sum + it.r * it.w, 0) / w : median;
    return clamp(mean, 0.7, 1.6);
  }

  function rememberLength(distance, asked, storeKey = KEYS.lengthObs) {
    const obs = store.get(storeKey, []);
    const list = Array.isArray(obs) ? obs : [];
    list.push([Math.round(distance), Math.round((distance / asked) * 1000) / 1000]);
    store.set(storeKey, list.slice(-LENGTH_OBS_LIMIT));
  }

  // Hoe een kandidaat wordt aangevraagd. Standaard een ORS round trip vanaf het startpunt;
  // een functie (bijv. "via een punt") kan in prepare() een eigen strategie kiezen.
  const roundTripStrategy = {
    ratioKey: KEYS.lengthObs,
    ratioPrior: 1.05,
    askedRange: (ctx) => [ctx.target * 0.6, ctx.target * 1.4],
    body: (ctx, asked, seed) => ({
      coordinates: [[ctx.start[1], ctx.start[0]]], // ORS verwacht [lng, lat]
      options: { round_trip: { length: Math.round(asked), points: 3, seed } },
    }),
  };

  function buildRequest(ctx, asked, seed) {
    const body = {
      ...ctx.strategy.body(ctx, asked, seed),
      instructions: true,
      instructions_format: 'text',
      language: 'nl',
      elevation: false,
      extra_info: [],
    };
    // Elke functie vult hier aan wat hij nodig heeft (extra_info, hoogte, richting) —
    // alles in dit ene verzoek, nooit een extra verzoek.
    features.forEach((f) => f.request && f.request(body, ctx, seed));
    body.extra_info = [...new Set(body.extra_info)];
    if (!body.extra_info.length) delete body.extra_info;
    return body;
  }

  function evaluateCandidate(cand, ctx) {
    cand.dev = Math.abs(cand.distance - ctx.target);
    cand.within5 = cand.dev <= ctx.target * PRIORITY_DEV_REL;
    cand.overlap = measureOverlap(cand.coords, ctx.overlapFree);
    cand.uturn = cand.steps.some((s) => s.t === 9);
    cand.clean = cand.overlap <= OVERLAP_ALLOWED_M && !cand.uturn;
    cand.stats = { ascent: cand.ascent, descent: cand.descent };
    features.forEach((f) => f.analyze && f.analyze(cand, ctx));
    cand.hard = [];
    cand.soft = [];
    features.forEach((f) => {
      if (!f.active || !f.active()) return;
      if (f.hard) cand.hard.push({ id: f.id, ...f.hard(cand, ctx) });
      if (f.soft) cand.soft.push({ id: f.id, ...f.soft(cand, ctx) });
    });
    cand.hardFails = cand.hard.filter((h) => !h.ok).length;
    cand.hardOk = cand.hardFails === 0;
    cand.softOk = cand.soft.every((s) => s.ok);
    cand.softScore = cand.soft.reduce((sum, s) => sum + s.weight * clamp(s.score, 0, 1), 0);
  }

  // Prioriteit bij het kiezen: 1. binnen 5% van de gevraagde afstand, 2. niet dubbel,
  // 3. harde eisen (via-punt, richting, max. stijgen), 4–7. voorkeuren met afnemend gewicht
  // (drukke wegen > ondergrond > platteland > bochten), daarna de kleinste afwijking.
  function betterCandidate(a, b, target) {
    if (!b) return true;
    if (a.within5 !== b.within5) return a.within5;
    if (!a.within5) { // allebei te kort of te lang: eerst niet dubbel, dan het dichtst bij
      if (a.clean !== b.clean) return a.clean;
      return a.dev + a.overlap * 3 < b.dev + b.overlap * 3;
    }
    if (a.clean !== b.clean) return a.clean;
    if (a.hardFails !== b.hardFails) return a.hardFails < b.hardFails;
    const rest = (c) => c.softScore + (c.dev + c.overlap * 3) / target;
    return rest(a) < rest(b);
  }

  // Vraagt kandidaten aan (max. MAX_ATTEMPTS), past de gevraagde lengte bij tot het rondje
  // binnen de marge valt, en houdt altijd de beste kandidaat vast.
  async function findRoute(ctx, key, onProgress, onWait) {
    const { target, strategy } = ctx;
    const tolerance = lengthTolerance(target);
    const [minAsked, maxAsked] = strategy.askedRange(ctx);
    let seed = newSeed();
    let tries = []; // { asked, got } met de huidige seed (zelfde vorm)
    let best = null;
    let lastErr = null;
    let attemptsMade = 0;
    // Volgende gevraagde lengte: met twee pogingen van dezelfde vorm de lijn ertussen
    // doortrekken (secant), met één poging de verhouding daarvan, anders het geleerde model.
    const nextAsked = () => {
      const n = tries.length;
      if (n >= 2) {
        const p = tries[n - 2];
        const q = tries[n - 1];
        const slope = (q.got - p.got) / (q.asked - p.asked);
        if (Number.isFinite(slope) && slope > 0.4 && slope < 2.5) return q.asked + (target - q.got) / slope;
      }
      if (n >= 1) {
        const q = tries[n - 1];
        return q.asked * (target / q.got);
      }
      return target / predictLengthRatio(target, strategy.ratioKey, strategy.ratioPrior);
    };
    const switchSeed = () => {
      seed = newSeed();
      tries = [];
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      onProgress(attempt, MAX_ATTEMPTS);
      attemptsMade = attempt;
      const asked = clamp(nextAsked(), minAsked, maxAsked);
      let cand;
      try {
        cand = await requestRoute(buildRequest(ctx, asked, seed), key, onWait);
      } catch (err) {
        lastErr = err;
        if (err.fatal) {
          if (best) break;
          throw err;
        }
        switchSeed();
        continue;
      }

      // Leren hoe ORS de lengte "opvat", per afstand: volgende routes starten dichterbij.
      rememberLength(cand.distance, asked, strategy.ratioKey);
      tries.push({ asked, got: cand.distance });

      cand.seed = seed;
      cand.attempts = attempt;
      evaluateCandidate(cand, ctx);
      if (betterCandidate(cand, best, target)) best = cand;
      const lengthOk = cand.dev <= tolerance;
      if (cand.clean && lengthOk && cand.hardOk && cand.softOk) return { ...cand, ok: true };

      // Andere vorm als de vorm het probleem is (dubbel, eis of voorkeur niet gehaald bij een
      // goede lengte), of als bijstellen met deze vorm niet convergeert.
      if (!cand.clean || !cand.hardOk || lengthOk || tries.length >= MAX_SAME_SEED) switchSeed();
    }
    if (!best) {
      throw lastErr || new AppError('Geen route gevonden',
        'Er kon geen rondje gevonden worden vanaf dit startpunt. Probeer een ander startpunt of een andere afstand.', { retry: true });
    }
    return { ...best, attempts: attemptsMade, ok: best.clean && best.dev <= tolerance && best.hardOk };
  }

  function setBusy(btn, busy, label) {
    btn.setAttribute('aria-busy', String(busy));
    btn.disabled = busy;
    if (label) btn.querySelector('.btn__label').textContent = label;
  }

  async function generateRoute() {
    if (state.generating || state.run) return;
    if (!state.start) {
      showNotice('error', 'Nog geen startpunt', 'Sta locatietoegang toe, of tik op de kaart om een startpunt te kiezen.',
        { action: { label: 'Locatie', onClick: () => locate() } });
      return;
    }
    const want = hooks.readTarget();
    if (!want) return;
    const key = getApiKey();
    if (!key) {
      showNotice('warn', 'API-sleutel nodig', 'Voeg eerst je gratis OpenRouteService-sleutel toe.',
        { action: { label: 'Toevoegen', onClick: openKeyDialog } });
      return;
    }
    if (!navigator.onLine) {
      showNotice('error', 'Geen internet', 'Voor het maken van een nieuwe route is internet nodig. Opgeslagen routes kun je wel openen via de geschiedenis.');
      return;
    }

    const start = state.start.latlng;
    const target = want.meters;
    const ctx = { start, target, strategy: roundTripStrategy, overlapFree: [] };
    try {
      // Functies kunnen hier de strategie kiezen of vooraf weigeren (bijv. via-punt te ver weg).
      features.forEach((f) => f.active && f.active() && f.prepare && f.prepare(ctx));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      showNotice('warn', err.title, err.message);
      return;
    }

    const again = !!state.route;
    const btn = again ? els.btnAgain : els.btnGenerate;
    const oldLabel = again ? 'Andere route' : 'Genereer route';
    state.generating = true;
    setBusy(btn, true, 'Route zoeken…');
    els.btnStart.disabled = true;
    hideNotice();
    emit('generate-start');

    try {
      const found = await findRoute(ctx, key, (n, max) => {
        btn.querySelector('.btn__label').textContent = n === 1 ? 'Route zoeken…' : `Zoeken… ${n}/${max}`;
      }, (secs) => {
        btn.querySelector('.btn__label').textContent = `Limiet ORS: ${secs} s…`;
      });
      const { meters, ...wantInfo } = want;
      const entry = {
        id: `r${Date.now().toString(36)}${found.seed.toString(36)}`,
        createdAt: Date.now(),
        requested: target,
        ...wantInfo,
        distance: found.distance,
        seed: found.seed,
        start,
        coords: found.coords,
        steps: found.steps,
        overlap: Math.round(found.overlap),
        stats: found.stats,
        checks: [...found.hard, ...found.soft].map(({ text, ok }) => ({ text, ok })),
        walkedAt: null,
        run: null,
      };
      saveToHistory(entry);
      showRoute(entry);

      if (!found.ok) {
        const parts = [];
        if (found.dev > lengthTolerance(target)) {
          parts.push(`Dit rondje is ${nf2.format(found.distance / 1000)} km, ${nf2.format(found.dev / 1000)} km ${found.distance > target ? 'langer' : 'korter'} dan gevraagd.`);
        }
        if (!found.clean) {
          parts.push(found.uturn
            ? 'Er zit een punt in waar je moet omkeren.'
            : `Er zit ongeveer ${Math.round(found.overlap / 10) * 10} m in die je heen en terug loopt.`);
        }
        found.hard.filter((h) => !h.ok && h.failText).forEach((h) => parts.push(h.failText));
        showNotice('warn', 'Beste rondje dat er was',
          `Na ${found.attempts} pogingen geen perfect rondje gevonden. ${parts.join(' ')} Tik op "Andere route" om verder te zoeken.`,
          { action: { label: 'Nog eens', onClick: generateRoute } });
      }
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('Er ging iets mis', err.message || String(err), { retry: true });
      let action = e.retry ? { label: 'Opnieuw', onClick: generateRoute } : null;
      if (e.title === 'Sleutel werkt niet') action = { label: 'Sleutel', onClick: openKeyDialog };
      showNotice('error', e.title, e.message, { action });
    } finally {
      state.generating = false;
      setBusy(btn, false, oldLabel);
      els.btnStart.disabled = false;
    }
  }

  els.btnGenerate.addEventListener('click', generateRoute);
  els.btnAgain.addEventListener('click', generateRoute);

  // ---------------------------------------------------------------------------
  // Route tonen
  // ---------------------------------------------------------------------------
  function prepareGeo(coords) {
    const proj = makeProjector(coords[0][0], coords[0][1]);
    const pts = coords.map(([la, ln]) => proj.fwd(la, ln));
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return { proj, pts, cum, total: cum[cum.length - 1] || 1 };
  }

  // Dichtstbijzijnde punt op de route; optioneel beperkt tot een stuk [fromAlong, toAlong].
  function nearestOnRoute(geo, p, fromAlong = -Infinity, toAlong = Infinity) {
    const { pts, cum } = geo;
    let best = { dist: Infinity, along: 0, x: 0, y: 0, i: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      if (cum[i + 1] < fromAlong || cum[i] > toAlong) continue;
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
      const x = a[0] + t * dx;
      const y = a[1] + t * dy;
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < best.dist) best = { dist: d, along: cum[i] + t * Math.sqrt(len2), x, y, i };
    }
    return best;
  }

  // Punt op een bepaalde afstand langs de route + richting daar.
  function pointAlong(geo, coords, along) {
    const { cum } = geo;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < along) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = clamp((along - cum[i - 1]) / seg, 0, 1);
    const a = coords[i - 1];
    const b = coords[i];
    return { latlng: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearing(a, b) };
  }

  // Stuk van de route tussen twee afstanden (voor gelopen / komend stuk).
  function sliceRoute(geo, coords, from, to) {
    from = clamp(from, 0, geo.total);
    to = clamp(to, 0, geo.total);
    if (to - from < 1) return [];
    const out = [pointAlong(geo, coords, from).latlng];
    for (let i = 1; i < coords.length - 1; i++) {
      if (geo.cum[i] > from && geo.cum[i] < to) out.push(coords[i]);
    }
    out.push(pointAlong(geo, coords, to).latlng);
    return out;
  }

  function drawDecorations(route) {
    decoLayer.clearLayers();
    const { geo, coords } = route;
    // km-bordjes
    for (let km = 1; km * 1000 < geo.total - 150; km++) {
      const { latlng } = pointAlong(geo, coords, km * 1000);
      L.marker(latlng, {
        icon: L.divIcon({ className: 'pin pin--km', html: `<span>${km}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, interactive: false,
      }).addTo(decoLayer);
    }
    // looprichting-pijlen, halverwege elke kilometer (en vlak na de start)
    const arrowsAt = [120];
    for (let m = 500; m < geo.total - 150; m += 1000) arrowsAt.push(m);
    arrowsAt.forEach((m) => {
      const { latlng, bearing: deg } = pointAlong(geo, coords, m);
      L.marker(latlng, {
        icon: L.divIcon({
          className: 'pin pin--arrow',
          html: `<span style="transform:rotate(${deg.toFixed(0)}deg)"><svg viewBox="0 0 24 24"><path d="M12 3 20 20 12 15.5 4 20Z"/></svg></span>`,
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
        keyboard: false, interactive: false,
      }).addTo(decoLayer);
    });
  }

  function animateLine(layer) {
    if (reducedMotion) return;
    const el = layer.getElement && layer.getElement();
    if (!el || typeof el.getTotalLength !== 'function') return;
    const len = el.getTotalLength();
    const clear = () => {
      el.style.transition = '';
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    };
    el.style.strokeDasharray = `${len} ${len}`;
    el.style.strokeDashoffset = String(len);
    el.getBoundingClientRect();
    el.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(.6,0,.2,1)';
    el.style.strokeDashoffset = '0';
    el.addEventListener('transitionend', clear, { once: true });
    map.once('zoomstart', clear);
  }

  function showRoute(entry) {
    const geo = prepareGeo(entry.coords);
    const turns = (entry.steps || [])
      .map((s) => ({ ...s, along: geo.cum[clamp(s.w, 0, geo.cum.length - 1)] }))
      .filter((s) => s.along > 5 && s.along < geo.total - 20);
    const route = { ...entry, geo, turns };
    state.route = route;

    routeLayer.clearLayers();
    L.polyline(route.coords, { className: 'route-casing', weight: 11, opacity: 1, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
    routeLine = L.polyline(route.coords, { className: 'route-line', weight: 6, opacity: 1, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
    doneLine = L.polyline([], { className: 'route-done', weight: 7, opacity: 1, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
    // Bewegende stippen in looprichting: tijdens plannen over de hele route, tijdens lopen alleen het komende stuk.
    antsLine = L.polyline(route.coords, { className: 'route-ants', weight: 4, opacity: 1, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
    drawDecorations(route);

    if (!state.start || haversine(state.start.latlng, entry.start) > 15) {
      state.start = { latlng: entry.start, source: 'manual' };
      els.startLabel.textContent = 'Startpunt van opgeslagen route';
      els.btnUseGps.hidden = false;
    }
    setStartMarker(entry.start);

    // Resultaat
    const diff = entry.distance - entry.requested;
    const within = Math.abs(diff) <= lengthTolerance(entry.requested);
    els.resultKm.textContent = nf2.format(entry.distance / 1000);
    const reqTxt = escapeHtml(hooks.requestedText(entry));
    const sign = Math.abs(diff) < 5 ? '±' : diff > 0 ? '+' : '−';
    const diffTxt = `<mark${within ? '' : ' class="is-far"'}>${sign}${nf2.format(Math.abs(diff) / 1000)} km${within ? ' ✓' : ''}</mark>`;
    let overlapTxt = '';
    if (typeof entry.overlap === 'number') {
      overlapTxt = entry.overlap <= OVERLAP_ALLOWED_M && !(entry.steps || []).some((s) => s.t === 9)
        ? ' · <mark>niet dubbel ✓</mark>'
        : ` · <mark class="is-far">~${Math.round(entry.overlap / 10) * 10} m dubbel</mark>`;
    }
    els.resultMeta.innerHTML = `${reqTxt} · ${diffTxt}${overlapTxt}`;
    renderRouteDetails(entry);
    els.result.hidden = false;
    els.planView.classList.add('has-route');
    hooks.restoreInput(entry);

    fitRoute();
    animateLine(routeLine);
    prefetchTiles(route.coords);
    emit('route-shown', entry);
  }

  // Route precies in het zichtbare deel van de kaart (tussen topbalk en paneel).
  function fitRoute({ animate = false } = {}) {
    if (routeLine) map.fitBounds(routeLine.getBounds(), { ...fitPadding(), maxZoom: 16, animate });
  }

  // Onder de route: gegevens per functie (hoogte, ondergrond, …) en welke voorkeuren
  // gehaald zijn. Oude opgeslagen routes hebben geen stats: dan blijft dit leeg.
  function renderRouteDetails(entry) {
    const info = entry.stats
      ? features.map((f) => (f.info ? f.info(entry.stats, entry) : '')).filter(Boolean)
      : [];
    els.resultInfo.innerHTML = info.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    els.resultInfo.hidden = !info.length;
    const checks = entry.checks || [];
    els.resultChecks.innerHTML = checks.map((c) => `<li class="check ${c.ok ? 'is-ok' : 'is-miss'}">`
      + `<span aria-hidden="true">${c.ok ? '✓' : '✗'}</span>`
      + `<span class="visually-hidden">${c.ok ? 'Gehaald:' : 'Niet gehaald:'}</span> ${escapeHtml(c.text)}</li>`).join('');
    els.resultChecks.hidden = !checks.length;
  }

  function clearRoute() {
    state.route = null;
    routeLayer.clearLayers();
    decoLayer.clearLayers();
    routeLine = null;
    doneLine = null;
    antsLine = null;
    prefetchToken++;
    els.result.hidden = true;
    els.planView.classList.remove('has-route');
    emit('route-cleared');
  }

  // ---------------------------------------------------------------------------
  // Kaarttegels langs de route cachen (offline bruikbaar onderweg)
  // ---------------------------------------------------------------------------
  let prefetchToken = 0;

  function lng2tile(lng, z) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
  function lat2tile(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  }

  function tilesForRoute(coords) {
    // Route verdichten tot een punt per ~40 m, zodat geen tegel gemist wordt.
    const dense = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1];
      const b = coords[i];
      const steps = Math.ceil(haversine(a, b) / 40);
      for (let s = 1; s <= steps; s++) {
        dense.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
      }
    }
    const build = (bufferAtMax) => {
      const urls = [];
      const seen = new Set();
      for (const z of PREFETCH_ZOOMS) {
        const buf = z === PREFETCH_ZOOMS[PREFETCH_ZOOMS.length - 1] ? bufferAtMax : 1;
        const n = 2 ** z;
        for (const [lat, lng] of dense) {
          const tx = lng2tile(lng, z);
          const ty = lat2tile(lat, z);
          for (let dx = -buf; dx <= buf; dx++) {
            for (let dy = -buf; dy <= buf; dy++) {
              const x = ((tx + dx) % n + n) % n;
              const y = clamp(ty + dy, 0, n - 1);
              const k = `${z}/${x}/${y}`;
              if (!seen.has(k)) {
                seen.add(k);
                urls.push(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
              }
            }
          }
        }
      }
      return urls;
    };
    let urls = build(1);
    if (urls.length > MAX_PREFETCH_TILES) urls = build(0);
    return urls.slice(0, MAX_PREFETCH_TILES);
  }

  function setTileStatus(pct, text) {
    els.tileBar.style.width = `${clamp(pct, 0, 100)}%`;
    els.tileText.textContent = text;
  }

  async function prefetchTiles(coords) {
    const token = ++prefetchToken;
    if (!('caches' in window)) {
      setTileStatus(0, 'Offline kaart wordt niet ondersteund in deze browser.');
      return;
    }
    let cache;
    try { cache = await caches.open(TILE_CACHE); } catch {
      setTileStatus(0, 'Offline kaart opslaan lukt niet (opslag geblokkeerd).');
      return;
    }
    const urls = tilesForRoute(coords);
    const queue = urls.slice();
    let done = 0;
    let failed = 0;
    setTileStatus(0, `Kaart offline opslaan… 0/${urls.length}`);

    const worker = async () => {
      while (queue.length && token === prefetchToken) {
        const url = queue.shift();
        try {
          const hit = await cache.match(url);
          if (!hit) {
            const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (res.ok) await cache.put(url, res);
            else failed++;
          }
        } catch { failed++; }
        done++;
        if (token === prefetchToken && (done % 5 === 0 || done === urls.length)) {
          setTileStatus((done / urls.length) * 100, `Kaart offline opslaan… ${done}/${urls.length}`);
        }
      }
    };

    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    if (token !== prefetchToken) return;
    if (failed === 0) setTileStatus(100, 'Kaart langs de route staat offline klaar ✓');
    else if (failed < urls.length) setTileStatus(100, `Kaart grotendeels offline opgeslagen (${urls.length - failed}/${urls.length}).`);
    else setTileStatus(0, 'Offline kaart opslaan mislukt. De kaart werkt alleen met internet.');
  }

  // ---------------------------------------------------------------------------
  // Geschiedenis (localStorage)
  // ---------------------------------------------------------------------------
  function loadHistory() {
    const list = store.get(KEYS.history, []);
    return Array.isArray(list) ? list : [];
  }

  function persistHistory(list) {
    let items = list.slice();
    // Bij te weinig opslag: oudste niet-gelopen routes eerst opruimen.
    while (!store.set(KEYS.history, items)) {
      const idx = items.map((r) => !r.walkedAt).lastIndexOf(true);
      if (idx === -1) {
        if (items.length <= 1) return false;
        items.pop();
      } else {
        items.splice(idx, 1);
      }
    }
    return true;
  }

  function saveToHistory(entry) {
    let list = [entry, ...loadHistory()];
    while (list.length > HISTORY_LIMIT) {
      const idx = list.map((r) => !r.walkedAt).lastIndexOf(true);
      list.splice(idx === -1 ? list.length - 1 : idx, 1);
    }
    if (!persistHistory(list)) {
      showNotice('warn', 'Niet opgeslagen', 'De route kon niet lokaal bewaard worden (opslag vol of geblokkeerd).', { autoHide: 5000 });
    }
  }

  function markWalked(id, run) {
    const list = loadHistory();
    const item = list.find((r) => r.id === id);
    if (!item) return;
    item.walkedAt = Date.now();
    item.run = { time: run.elapsed, travelled: Math.round(run.travelled) };
    persistHistory(list);
  }

  function deleteFromHistory(id) {
    persistHistory(loadHistory().filter((r) => r.id !== id));
    renderHistory();
  }

  let histObserver = null;

  function renderHistory() {
    const list = loadHistory();
    const walked = list.filter((r) => r.walkedAt);
    const totalKm = walked.reduce((s, r) => s + r.distance, 0) / 1000;
    els.historySummary.innerHTML = walked.length
      ? `<strong>${walked.length}</strong> ${walked.length === 1 ? 'rondje' : 'rondjes'} gelopen · <strong>${nf1.format(totalKm)} km</strong>`
      : 'Nog geen rondjes gelopen';
    els.historyEmpty.hidden = list.length > 0;
    els.historyList.replaceChildren();

    if (histObserver) histObserver.disconnect();
    histObserver = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add('is-visible');
            histObserver.unobserve(en.target);
          }
        });
      }, { root: els.historyDialog, threshold: 0.15 })
      : null;

    list.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = `hist${r.walkedAt ? ' is-walked' : ''}`;
      li.style.transitionDelay = `${Math.min(i, 6) * 40}ms`;

      const km = document.createElement('p');
      km.className = 'hist__km';
      km.innerHTML = `${nf2.format(r.distance / 1000)}<small>km</small>`;

      const badge = document.createElement('span');
      badge.className = 'hist__badge';
      badge.textContent = r.walkedAt ? 'Gelopen ✓' : 'Gepland';

      const meta = document.createElement('p');
      meta.className = 'hist__meta';
      const parts = [dateFmt.format(new Date(r.createdAt)), `gevraagd ${nfKm.format(r.requested / 1000)} km`];
      if (r.run) parts.push(`gelopen in ${fmtDuration(r.run.time)}`);
      meta.textContent = parts.join(' · ');

      const actions = document.createElement('div');
      actions.className = 'hist__actions';
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'link-btn';
      show.textContent = 'Toon op kaart';
      show.addEventListener('click', () => {
        if (state.run) return;
        closeDialog(els.historyDialog);
        showRoute(r);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link-btn link-btn--danger';
      del.textContent = 'Verwijder';
      del.setAttribute('aria-label', `Verwijder route van ${nf2.format(r.distance / 1000)} kilometer`);
      del.addEventListener('click', () => {
        if (confirm('Deze route verwijderen?')) deleteFromHistory(r.id);
      });
      actions.append(show, del);

      li.append(km, badge, meta, actions);
      els.historyList.append(li);
      if (histObserver && !reducedMotion) histObserver.observe(li);
      else li.classList.add('is-visible');
    });
  }

  els.btnHistory.addEventListener('click', () => {
    openDialog(els.historyDialog);
    renderHistory();
  });

  // ---------------------------------------------------------------------------
  // Dialogen
  // ---------------------------------------------------------------------------
  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeDialog(dlg) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(dlg)));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(dlg); }); // tik op achtergrond
  });

  // ---------------------------------------------------------------------------
  // Spraak (Web Speech API)
  // ---------------------------------------------------------------------------
  const speech = {
    supported: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    voice: null,
    init() {
      if (!this.supported) return;
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice = voices.find((v) => /^nl[-_]NL/i.test(v.lang)) || voices.find((v) => /^nl/i.test(v.lang)) || null;
      };
      pick();
      if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', pick);
    },
    active: new Set(), // referenties vasthouden: anders ruimt de browser uitingen soms te vroeg op
    say(text, { interrupt = false } = {}) {
      if (!this.supported) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'nl-NL';
        if (this.voice) u.voice = this.voice;
        u.rate = 1;
        u.volume = 1;
        this.active.add(u);
        u.onend = u.onerror = () => this.active.delete(u);
        if (speechSynthesis.paused) speechSynthesis.resume(); // iOS blijft soms hangen na de achtergrond
        if (interrupt && (speechSynthesis.speaking || speechSynthesis.pending)) {
          speechSynthesis.cancel();
          // Safari slikt soms een speak() direct na cancel(): even wachten.
          setTimeout(() => speechSynthesis.speak(u), 120);
        } else {
          speechSynthesis.speak(u); // synchroon: de eerste uiting moet binnen de tik vallen (iOS)
        }
      } catch { /* spraak is een extraatje; nooit de app laten crashen */ }
    },
  };
  speech.init();

  // ---------------------------------------------------------------------------
  // Scherm wakker houden (Screen Wake Lock API)
  // ---------------------------------------------------------------------------
  let wakeLock = null;

  const WAKE_FALLBACK = 'Zet zelf Instellingen › Beeldscherm en helderheid › Automatische vergrendeling op "Nooit" tijdens het lopen. Als het scherm op slot gaat, stopt de GPS en hoor je geen waarschuwingen.';

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      showWakeWarning(`Deze browser kan het scherm niet aan houden. ${WAKE_FALLBACK}`);
      return false;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      els.wakeWarn.hidden = true;
      return true;
    } catch (err) {
      wakeLock = null;
      showWakeWarning(`Het scherm aan houden lukte niet${err && err.name ? ` (${err.name})` : ''}. ${WAKE_FALLBACK}`);
      return false;
    }
  }

  function showWakeWarning(text) {
    els.wakeWarn.textContent = text;
    els.wakeWarn.hidden = false;
  }

  async function releaseWakeLock() {
    try { if (wakeLock) await wakeLock.release(); } catch { /* al vrijgegeven */ }
    wakeLock = null;
  }

  // Wake lock vervalt als de app naar de achtergrond gaat: opnieuw aanvragen bij terugkomst.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.run && !wakeLock) requestWakeLock();
  });

  // ---------------------------------------------------------------------------
  // Live hardlopen
  // ---------------------------------------------------------------------------
  function setRunStatus(kind, text) {
    if (els.runStatus.dataset.state === kind && els.runStatusText.textContent === text) return;
    els.runStatus.dataset.state = kind;
    els.runStatusText.textContent = text;
    els.runView.classList.toggle('is-off', kind === 'off');
  }

  function remainingMeters(run) {
    const r = state.route;
    return Math.max(0, r.distance * (1 - run.maxAlong / r.geo.total));
  }

  // ---------------------------------------------------------------------------
  // Afslag-navigatie
  // ---------------------------------------------------------------------------
  const TURN_WORDS = {
    0: 'linksaf', 1: 'rechtsaf', 2: 'scherp linksaf', 3: 'scherp rechtsaf',
    4: 'flauw linksaf', 5: 'flauw rechtsaf', 9: 'omkeren', 12: 'links aanhouden', 13: 'rechts aanhouden',
  };
  const TURN_ROTATION = { 0: -90, 1: 90, 2: -135, 3: 135, 4: -45, 5: 45, 9: 180, 12: -25, 13: 25 };

  function turnPhrase(turn, withName = true) {
    let p = turn.t === 7
      ? (turn.x ? `op de rotonde de ${turn.x}e afslag` : 'de rotonde op')
      : TURN_WORDS[turn.t] || 'afslaan';
    if (withName && turn.n) p += `, ${turn.n}`;
    return p;
  }

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtAhead = (m) => (m >= 1000 ? `${nf1.format(m / 1000)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

  function setNav(kind, dist, what, rotation = 0, exit = 0) {
    els.navIcon.dataset.kind = kind;
    els.navIcon.style.setProperty('--rot', `${rotation}deg`);
    els.navDist.textContent = dist;
    els.navDist.hidden = !dist;
    els.navWhat.textContent = what;
    const exitEl = document.getElementById('navExit');
    if (exitEl) exitEl.textContent = exit ? String(exit) : '';
  }

  // Werkt de afslagkaart bij en spreekt afslagen uit. Geeft de afstand tot de volgende afslag terug.
  function updateNav(run) {
    const route = state.route;
    if (!route.steps) { // oude opgeslagen route zonder afslaginformatie
      setNav('turn', '', 'Volg de oranje lijn');
      return Infinity;
    }
    const turns = route.turns;
    while (run.turnIdx < turns.length && turns[run.turnIdx].along < run.maxAlong - 8) run.turnIdx++;
    const next = turns[run.turnIdx];
    if (!next) {
      setNav('finish', fmtAhead(Math.max(0, route.geo.total - run.maxAlong)), 'Rechtdoor naar de finish');
      return Infinity;
    }
    const dist = next.along - run.maxAlong;
    setNav(next.t === 7 ? 'round' : 'turn', fmtAhead(Math.max(0, dist)), capitalize(turnPhrase(next)), TURN_ROTATION[next.t] ?? 0, next.x);
    if (run.offRoute || run.finished || run.wrongWay) return dist;

    const after = turns[run.turnIdx + 1];
    const then = after && after.along - next.along < 60 ? `, daarna ${turnPhrase(after, false)}` : '';
    if (dist <= TURN_NOW_M && !next.saidNow) {
      next.saidNow = true;
      next.saidPre = true;
      speech.say(`Nu ${turnPhrase(next, false)}${then}.`, { interrupt: true });
    } else if (dist <= TURN_PREWARN_M && dist > TURN_NOW_M + 10 && !next.saidPre) {
      next.saidPre = true;
      speech.say(`Over ${Math.max(10, Math.round(dist / 10) * 10)} meter ${turnPhrase(next)}${then}.`);
    }
    return dist;
  }

  // Loop je de route in de goede richting? Vergelijkt je beweging (over ≥ 12 m, tegen GPS-ruis)
  // met de richting van het routestuk waar je op zit.
  function checkDirection(run, geo, p, ref, dev) {
    if (!run.dirAnchor || dev > OFF_ROUTE_M) { run.dirAnchor = p; return; }
    const mx = p[0] - run.dirAnchor[0];
    const my = p[1] - run.dirAnchor[1];
    const ml = Math.hypot(mx, my);
    if (ml < 12) return;
    run.dirAnchor = p;
    const s0 = geo.pts[ref.i];
    const s1 = geo.pts[Math.min(ref.i + 1, geo.pts.length - 1)];
    const sx = s1[0] - s0[0];
    const sy = s1[1] - s0[1];
    const sl = Math.hypot(sx, sy);
    if (!sl) return;
    const cos = (mx * sx + my * sy) / (ml * sl);
    if (cos < -0.5) run.wrongCount++;
    else if (cos > 0.3) run.wrongCount = 0;

    if (!run.wrongWay && run.wrongCount >= 2 && !run.offRoute && !run.finished) {
      run.wrongWay = true;
      run.lastWrongWarnAt = Date.now();
      speech.say('Verkeerde richting. Draai om.', { interrupt: true });
    } else if (run.wrongWay && run.wrongCount === 0) {
      run.wrongWay = false;
      speech.say('Goede richting.', { interrupt: true });
    }
  }

  // Gelopen stuk grijs, komende meters met bewegende stippen.
  function updateRouteProgress(run) {
    const { geo, coords } = state.route;
    if (run.drawnAlong === run.maxAlong) return;
    run.drawnAlong = run.maxAlong;
    if (doneLine) doneLine.setLatLngs(sliceRoute(geo, coords, 0, run.maxAlong));
    if (antsLine) antsLine.setLatLngs(sliceRoute(geo, coords, run.maxAlong, run.maxAlong + AHEAD_M));
  }

  async function startRun() {
    if (!state.route || state.run) return;
    if (!('geolocation' in navigator)) {
      showNotice('error', 'Geen locatie', 'Deze browser kan je locatie niet volgen, dus live hardlopen is niet mogelijk.');
      return;
    }

    // Spraak moet op iPhone binnen een tik "ontgrendeld" worden: meteen iets zeggen.
    speech.say(`Gestart. Rondje van ${nf1.format(state.route.distance / 1000)} kilometer.`, { interrupt: true });
    els.speechWarn.hidden = speech.supported;
    if (!speech.supported) {
      els.speechWarn.textContent = 'Gesproken waarschuwingen werken niet in deze browser. Let op het scherm: het wordt oranje als je afwijkt.';
    }

    hideNotice();
    const run = {
      startedAt: Date.now(),
      elapsed: 0,
      watchId: null,
      timer: null,
      lastFix: null,
      lastFixAt: 0,
      travelled: 0,
      maxAlong: 0,
      offCount: 0,
      offRoute: false,
      lastWarnAt: 0,
      nextKm: 1,
      finished: false,
      follow: true,
      turnIdx: 0,
      drawnAlong: -1,
      rejoin: null,
      dirAnchor: null,
      wrongCount: 0,
      wrongWay: false,
      lastWrongWarnAt: 0,
    };
    state.run = run;
    state.route.turns.forEach((t) => { t.saidPre = false; t.saidNow = false; });
    updateRouteProgress(run);
    updateNav(run);

    document.body.classList.add('is-running');
    els.planView.hidden = true;
    els.runView.hidden = false;
    els.wakeWarn.hidden = true;
    setRunStatus('wait', 'Wachten op GPS…');
    els.statTime.textContent = '00:00';
    els.statDone.textContent = nf2.format(0);
    els.statLeft.textContent = nf1.format(state.route.distance / 1000);
    els.statDev.textContent = '–';

    run.watchId = navigator.geolocation.watchPosition(onFix, onWatchError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });

    run.timer = setInterval(() => {
      run.elapsed = Date.now() - run.startedAt;
      els.statTime.textContent = fmtDuration(run.elapsed);
      if (run.lastFixAt && Date.now() - run.lastFixAt > GPS_STALE_MS && !run.finished) {
        setRunStatus('weak', 'Geen GPS-signaal…');
      }
    }, 1000);

    emit('run-start');
    focusOn(state.start.latlng, 17, false);
    await requestWakeLock();
  }

  function onFix(pos) {
    const run = state.run;
    const route = state.route;
    if (!run || !route) return;

    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const ll = [lat, lng];
    state.userPos = ll;
    run.lastFixAt = Date.now();
    setUserMarker(ll, accuracy);
    if (run.follow) focusOn(ll, undefined, true);

    if (accuracy > MAX_GPS_ACCURACY_M) {
      if (!run.finished) setRunStatus('weak', `Zwak GPS-signaal (±${Math.round(accuracy)} m)`);
      return;
    }

    // Afgelegde afstand (kleine sprongen van GPS-ruis negeren)
    if (!run.lastFix) run.lastFix = ll;
    else {
      const d = haversine(run.lastFix, ll);
      if (d >= 4 && d < 150) { run.travelled += d; run.lastFix = ll; }
      else if (d >= 150) run.lastFix = ll; // GPS-sprong: niet meetellen
    }

    // Afwijking tot de route
    const geo = route.geo;
    const p = geo.proj.fwd(lat, lng);
    const nearest = nearestOnRoute(geo, p);
    const dev = nearest.dist;

    // Voortgang langs de route: kijk in een venster rond de laatste positie, zodat
    // begin en eind van het rondje (die op dezelfde plek liggen) niet verward worden.
    const local = nearestOnRoute(geo, p, run.maxAlong - 150, run.maxAlong + 400);
    const now = Date.now();
    checkDirection(run, geo, p, local.dist < 25 ? local : nearest, dev);

    if (local.dist < 40) {
      run.maxAlong = Math.max(run.maxAlong, local.along);
      run.rejoin = null;
    } else if (dev < OFF_ROUTE_M && !run.wrongWay) {
      // Op een ander stuk van de route ingevoegd (bijv. afgesneden). Pas meetellen als je
      // daar een paar fixes achter elkaar vooruit loopt: anders zou de verkeerde kant op
      // lopen vanaf de start meteen als "bijna bij de finish" tellen.
      const r = run.rejoin;
      const plausible = nearest.along - run.maxAlong < geo.total * 0.5; // meer dan half rondje afsnijden: geen voortgang
      run.rejoin = plausible && r && nearest.along > r.along && nearest.along - r.along < 100
        ? { along: nearest.along, n: r.n + 1 }
        : { along: nearest.along, n: plausible ? 1 : 0 };
      if (run.rejoin.n >= 3) {
        run.maxAlong = Math.max(run.maxAlong, nearest.along);
        run.rejoin = null;
      }
    }

    if (run.wrongWay && !run.offRoute) {
      if (now - run.lastWrongWarnAt > WARN_REPEAT_MS) {
        run.lastWrongWarnAt = now;
        speech.say('Nog steeds de verkeerde kant op. Draai om.', { interrupt: true });
      }
    }

    if (dev > OFF_ROUTE_M) {
      run.offCount++;
      if (!run.offRoute && run.offCount >= 2) {
        run.offRoute = true;
        run.wrongWay = false; // van de route af gaat voor
        run.wrongCount = 0;
        run.lastWarnAt = now;
        speech.say(`Let op. Je wijkt ${round5(dev)} meter af van de route.`, { interrupt: true });
      } else if (run.offRoute && now - run.lastWarnAt > WARN_REPEAT_MS) {
        run.lastWarnAt = now;
        speech.say(`Nog steeds ${round5(dev)} meter van de route.`, { interrupt: true });
      }
    } else {
      run.offCount = 0;
      if (run.offRoute && dev <= BACK_ON_ROUTE_M) {
        run.offRoute = false;
        speech.say('Terug op de route.', { interrupt: true });
      }
    }

    // Stippellijn naar de route als je afwijkt
    if (run.offRoute) {
      const target = geo.proj.inv(nearest.x, nearest.y);
      if (!guideLine) guideLine = L.polyline([ll, target], { className: 'guide-line', weight: 4, interactive: false }).addTo(map);
      else guideLine.setLatLngs([ll, target]);
    } else if (guideLine) {
      map.removeLayer(guideLine);
      guideLine = null;
    }

    const remaining = remainingMeters(run);
    updateRouteProgress(run);
    const turnDist = updateNav(run);

    // Kilometer-melding (niet vlak voor een afslag, dan gaat de afslag voor)
    const kmDone = Math.floor(run.travelled / 1000);
    if (kmDone >= run.nextKm) {
      run.nextKm = kmDone + 1;
      if (!run.offRoute && !run.wrongWay && !run.finished && remaining > 300 && turnDist > 100) {
        speech.say(`${kmDone} kilometer. Nog ${nf1.format(remaining / 1000)} kilometer.`);
      }
    }

    // Rondje voltooid?
    if (!run.finished && run.maxAlong > geo.total - 80 && run.travelled > route.distance * 0.6 && haversine(ll, route.coords[0]) < 40) {
      run.finished = true;
      run.elapsed = Date.now() - run.startedAt;
      markWalked(route.id, run);
      speech.say(`Rondje voltooid. ${nf2.format(run.travelled / 1000)} kilometer in ${spokenDuration(run.elapsed)}.`, { interrupt: true });
    }

    // Scherm bijwerken
    els.statDev.textContent = String(Math.round(dev));
    els.statDone.textContent = nf2.format(run.travelled / 1000);
    els.statLeft.textContent = nf1.format(remaining / 1000);
    if (run.finished) setRunStatus('done', 'Rondje voltooid!');
    else if (run.offRoute) setRunStatus('off', `Afwijking ${Math.round(dev)} m — terug naar de route`);
    else if (run.wrongWay) setRunStatus('off', 'Verkeerde richting — draai om');
    else setRunStatus('ok', 'Op route');
  }

  function spokenDuration(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h) return `${h} uur${m ? ` en ${m} minuten` : ''}`;
    return `${m} ${m === 1 ? 'minuut' : 'minuten'}`;
  }

  function onWatchError(err) {
    if (!state.run) return;
    if (err.code === 1) {
      stopRun({ confirmFirst: false, silent: true });
      const e = geoErrorMessage(err);
      showNotice('error', e.title, e.message);
      return;
    }
    // Time-out of tijdelijk geen positie: watchPosition blijft doorlopen.
    setRunStatus('weak', err.code === 3 ? 'Wachten op GPS…' : 'Geen GPS-signaal…');
  }

  function stopRun({ confirmFirst = true, silent = false } = {}) {
    const run = state.run;
    if (!run) return;
    if (confirmFirst && !window.confirm('Stoppen met hardlopen?')) return;

    navigator.geolocation.clearWatch(run.watchId);
    clearInterval(run.timer);
    releaseWakeLock();
    run.elapsed = Date.now() - run.startedAt;

    const route = state.route;
    const mostlyDone = route && run.maxAlong >= route.geo.total * 0.6;
    if (route && !run.finished && mostlyDone) markWalked(route.id, run);

    state.run = null;
    if (guideLine) { map.removeLayer(guideLine); guideLine = null; }
    if (route) {
      if (doneLine) doneLine.setLatLngs([]);
      if (antsLine) antsLine.setLatLngs(route.coords);
    }
    document.body.classList.remove('is-running');
    els.btnLocate.classList.remove('is-lost');
    els.runView.hidden = true;
    els.planView.hidden = false;
    emit('run-stop');

    if (!silent) {
      speech.say('Gestopt.', { interrupt: true });
      const saved = run.finished || mostlyDone;
      showNotice(saved ? 'success' : 'info', saved ? 'Goed gelopen!' : 'Gestopt',
        `${fmtDuration(run.elapsed)} · ${nf2.format(run.travelled / 1000)} km${saved ? ' · opgeslagen als gelopen' : ''}`);
    }
  }

  els.btnStart.addEventListener('click', startRun);
  els.btnStop.addEventListener('click', () => stopRun());

  // Als je de kaart zelf versleept tijdens het lopen, stopt het automatisch volgen.
  map.on('dragstart', () => {
    if (state.run && state.run.follow) {
      state.run.follow = false;
      els.btnLocate.classList.add('is-lost');
    }
  });

  // ---------------------------------------------------------------------------
  // Online/offline
  // ---------------------------------------------------------------------------
  window.addEventListener('offline', () => {
    showNotice('info', 'Offline',
      state.route ? 'Geen internet. De opgeslagen kaart langs je route blijft werken.' : 'Geen internet. Nieuwe routes maken lukt pas weer met verbinding.',
      { autoHide: 5000 });
  });
  window.addEventListener('online', () => {
    if (els.noticeTitle.textContent === 'Offline') hideNotice();
  });

  // ---------------------------------------------------------------------------
  // Service worker
  // ---------------------------------------------------------------------------
  if ('serviceWorker' in navigator) {
    // Nieuwe versie actief geworden? Herladen als dat niets verstoort, anders een melding.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // eerste installatie, geen update
      if (!state.run && !state.generating && !state.route) {
        location.reload();
      } else if (!state.run) {
        showNotice('info', 'Nieuwe versie', 'Er staat een nieuwe versie van de app klaar.',
          { action: { label: 'Laden', onClick: () => location.reload() } });
      }
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('Service worker registratie mislukt:', err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Voorkeuren — basis
  // Elke voorkeur/functie staat hieronder in een eigen blok en meldt zich aan met
  // registerFeature(). Haal je zo'n blok weg, dan werkt de rest gewoon door.
  //
  // Een functie kan hebben:
  //   defaults                 standaardwaarden (onthouden in localStorage)
  //   ui()                     bediening opbouwen (in "Voorkeuren" of elders)
  //   active()                 doet hij nu mee bij het kiezen tussen kandidaten?
  //   label()                  korte tekst voor de samenvatting van het paneel
  //   prepare(ctx)             vóór het zoeken: strategie kiezen, of weigeren met een AppError
  //   request(body, ctx, seed) het ene ORS-verzoek aanvullen (extra_info, hoogte, richting)
  //   analyze(cand, ctx)       cand.stats vullen
  //   hard(cand, ctx)          eis, prioriteit 3: { ok, text, failText }
  //   soft(cand, ctx)          voorkeur: { ok, text, score 0..1 (lager = beter), weight }
  //                            gewichten volgen de prioriteit: drukke wegen 8, ondergrond 4,
  //                            platteland 2, bochten 1
  //   info(stats, entry)       regel onder de route
  // ---------------------------------------------------------------------------
  const features = [];
  const prefs = {};

  function registerFeature(def) {
    features.push(def);
    Object.assign(prefs, def.defaults || {});
  }

  function loadPrefs() {
    const saved = store.get(KEYS.prefs, null);
    if (!saved || typeof saved !== 'object') return;
    Object.keys(prefs).forEach((k) => {
      const v = saved[k];
      if (v === undefined) return;
      if (v === null || prefs[k] === null || typeof v === typeof prefs[k]) prefs[k] = v;
    });
  }

  function setPref(k, v) {
    prefs[k] = v;
    const saved = store.get(KEYS.prefs, {});
    store.set(KEYS.prefs, { ...(saved && typeof saved === 'object' ? saved : {}), ...prefs });
    renderPrefsSummary();
  }

  function renderPrefsSummary() {
    const on = features.filter((f) => f.label && f.active && f.active()).map((f) => f.label());
    els.prefsSummary.textContent = on.length ? on.join(' · ') : 'Geen: elk goed rondje telt.';
  }

  // Bouwstenen voor het paneel. Een rij = titel + bediening (+ uitleg).
  function prefRow(id, title, hint = '') {
    const row = document.createElement('div');
    row.className = 'pref';
    row.dataset.pref = id;
    const head = document.createElement('p');
    head.className = 'pref__title';
    head.id = `pref-${id}-title`;
    head.textContent = title;
    row.append(head);
    if (hint) {
      const p = document.createElement('p');
      p.className = 'pref__hint';
      p.id = `pref-${id}-hint`;
      p.textContent = hint;
      row.append(p);
    }
    els.prefsList.append(row);
    return row;
  }

  function prefSwitch(row, key, onChange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-labelledby', `${row.querySelector('.pref__title').id}`);
    const hint = row.querySelector('.pref__hint');
    if (hint) input.setAttribute('aria-describedby', hint.id);
    input.checked = !!prefs[key];
    input.addEventListener('change', () => {
      setPref(key, input.checked);
      if (onChange) onChange(input.checked);
    });
    row.classList.add('pref--switch');
    row.append(input);
    return input;
  }

  function prefChoice(row, key, options, onChange) {
    const group = document.createElement('div');
    group.className = 'seg';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', row.querySelector('.pref__title').id);
    options.forEach(({ value, text, aria }) => {
      const label = document.createElement('label');
      label.className = 'seg__opt';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `pref-${key}`;
      input.value = String(value);
      input.checked = prefs[key] === value;
      if (aria) input.setAttribute('aria-label', aria);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        setPref(key, value);
        if (onChange) onChange(value);
      });
      const span = document.createElement('span');
      span.textContent = text;
      span.setAttribute('aria-hidden', aria ? 'true' : 'false');
      label.append(input, span);
      group.append(label);
    });
    row.append(group);
    return group;
  }

  // Meters → aandeel van de route (0..1)
  const shareOf = (m, cand) => (cand.distance > 0 ? m / cand.distance : 0);
  const pct = (x) => `${Math.round(x * 100)}%`;

  // ---------------------------------------------------------------------------
  // Voorkeur 1: platteland
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // ORS' eigen "green"-weging doet niets bij round trips in Nederland (getest: zelfde route),
  // en de green-index heeft hier geen data (overal 10). Daarom achteraf scoren: aandeel paden
  // en landwegen (waytype 4/5) of onverhard; waar ORS wél groendata heeft (wisselende
  // green-waarden, o.a. Duitsland) telt de green-index.
  {
    const RURAL_GOOD = 0.6;   // vanaf dit aandeel telt de route als "helemaal platteland"
    const RURAL_OK = 0.3;     // vanaf dit aandeel: voorkeur gehaald
    const RURAL_WEIGHT = 2;
    const UNPAVED = new Set([2, 8, 9, 10, 11, 12, 15, 16, 17]);

    registerFeature({
      id: 'rural',
      defaults: { rural: false },
      ui() {
        prefSwitch(prefRow('rural', 'Platteland', 'Liever paden, landwegen en buitengebied dan straten.'), 'rural');
      },
      active: () => prefs.rural,
      label: () => 'platteland',
      request(body) { body.extra_info.push('waytype', 'surface', 'green'); },
      analyze(cand) {
        const green = cand.extras.green;
        if (green && new Set(green.map((v) => v[2])).size > 1) {
          const m = extraMeters(cand, 'green');
          const avg = Object.entries(m).reduce((sum, [v, meters]) => sum + Number(v) * meters, 0) / cand.distance;
          cand.stats.rural = clamp(avg / 10, 0, 1);
          cand.stats.ruralBy = 'green';
          return;
        }
        const way = extraMeters(cand, 'waytype') || {};
        const surf = extraMeters(cand, 'surface') || {};
        const paths = (way[4] || 0) + (way[5] || 0);
        const unpaved = Object.entries(surf).reduce((sum, [v, m]) => sum + (UNPAVED.has(Number(v)) ? m : 0), 0);
        cand.stats.rural = clamp(shareOf(Math.max(paths, unpaved), cand), 0, 1);
        cand.stats.ruralBy = 'paden';
      },
      soft(cand) {
        const r = cand.stats.rural || 0;
        const what = cand.stats.ruralBy === 'green' ? 'groen' : 'paden en landwegen';
        return { ok: r >= RURAL_OK, score: 1 - Math.min(1, r / RURAL_GOOD), weight: RURAL_WEIGHT, text: `platteland: ${pct(r)} ${what}` };
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Voorkeur 2: weinig bochten
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // ORS heeft hier geen optie voor: kandidaten scoren op het aantal afslagen en hoe scherp
  // die zijn (uit de stappen van de routebeschrijving), per kilometer.
  {
    // Gewicht per staptype: scherp en omkeren tellen zwaarder, flauw en aanhouden lichter.
    const TURN_WEIGHT = { 0: 1, 1: 1, 2: 1.6, 3: 1.6, 4: 0.4, 5: 0.4, 7: 0.8, 9: 2, 12: 0.3, 13: 0.3 };
    const REAL_TURNS = new Set([0, 1, 2, 3, 7, 9]); // wat je echt als "afslag" voelt
    const CALM_PER_KM = 4;    // tot zoveel gewogen bochten per km: voorkeur gehaald
    const BUSY_PER_KM = 8;    // vanaf zoveel: slechtst mogelijke score
    const TURNS_WEIGHT = 1;

    registerFeature({
      id: 'turns',
      defaults: { fewTurns: false },
      ui() {
        prefSwitch(prefRow('turns', 'Weinig bochten', 'Liever lange rechte stukken dan steeds afslaan.'), 'fewTurns');
      },
      active: () => prefs.fewTurns,
      label: () => 'weinig bochten',
      analyze(cand) {
        const km = Math.max(0.5, cand.distance / 1000);
        const weighted = cand.steps.reduce((sum, st) => sum + (TURN_WEIGHT[st.t] || 0), 0);
        cand.stats.turns = cand.steps.filter((st) => REAL_TURNS.has(st.t)).length;
        cand.stats.turnsPerKm = Math.round((weighted / km) * 10) / 10;
      },
      soft(cand) {
        const perKm = cand.stats.turnsPerKm;
        return {
          ok: perKm <= CALM_PER_KM,
          score: clamp(perKm / BUSY_PER_KM, 0, 1),
          weight: TURNS_WEIGHT,
          text: `weinig bochten: ${cand.stats.turns} afslagen (${nf1.format(perKm)} per km)`,
        };
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Voorkeur 3: drukke hoofdwegen vermijden
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // ORS' "quiet"-weging geeft bij round trips in Nederland exact dezelfde route (getest), dus
  // achteraf scoren met extra_info: waytype 1 = hoofdweg (telt dubbel), 2 = "Road"
  // (secundaire/tertiaire/ongeclassificeerde weg); waycategory-bit 1 = snelweg.
  // Onder elke route staat hoeveel meter langs zo'n weg loopt, ook als de voorkeur uit staat.
  {
    const QUIET_OK_SHARE = 0.05;  // tot 5% van de route langs drukke wegen: voorkeur gehaald
    const QUIET_BAD_SHARE = 0.25; // vanaf 25% (gewogen): slechtst mogelijke score
    const QUIET_WEIGHT = 8;

    registerFeature({
      id: 'quiet',
      defaults: { quiet: false },
      ui() {
        prefSwitch(prefRow('quiet', 'Drukke wegen vermijden', 'Liever rustige straten en paden dan langs doorgaande wegen.'), 'quiet');
      },
      active: () => prefs.quiet,
      label: () => 'rustige wegen',
      request(body) { body.extra_info.push('waytype', 'waycategory'); },
      analyze(cand) {
        const way = extraMeters(cand, 'waytype');
        if (!way) return;
        const cat = extraMeters(cand, 'waycategory') || {};
        const highway = Object.entries(cat).reduce((sum, [v, m]) => sum + (Number(v) & 1 ? m : 0), 0);
        const main = Math.max(way[1] || 0, highway);
        cand.stats.busyM = Math.round(main + (way[2] || 0));
        cand.stats.busyWeighted = shareOf(main * 2 + (way[2] || 0), cand);
      },
      soft(cand) {
        const m = cand.stats.busyM;
        if (m === undefined) return { ok: true, score: 0, weight: 0, text: 'drukke wegen: onbekend' };
        return {
          ok: shareOf(m, cand) <= QUIET_OK_SHARE,
          score: clamp(cand.stats.busyWeighted / QUIET_BAD_SHARE, 0, 1),
          weight: QUIET_WEIGHT,
          text: `rustige wegen: ${m} m langs drukke weg`,
        };
      },
      info(stats) {
        if (stats.busyM === undefined) return '';
        return stats.busyM < 20 ? 'Niet langs drukke wegen' : `${new Intl.NumberFormat('nl-NL').format(Math.round(stats.busyM / 10) * 10)} m langs drukke wegen`;
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Voorkeur 4: ondergrond
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // Ondergrond uit extra_info surface. In Nederland is van een groot deel van de wegen de
  // ondergrond onbekend (0); die stukken leiden we af uit het wegtype: straten, wegen,
  // fietspaden en voetpaden (stoepen) zijn hier vrijwel altijd verhard, landwegen (track)
  // meestal niet. Gewone paden (path) blijven "onbekend".
  {
    const PAVED = new Set([1, 3, 4, 5, 6, 7, 14, 18]);
    const UNPAVED = new Set([2, 8, 9, 10, 11, 12, 15, 16, 17]);
    const WAY_PAVED = new Set([1, 2, 3, 6, 7]);
    const WAY_UNPAVED = new Set([5]);
    const SURFACE_OK = { paved: 0.75, unpaved: 0.5 }; // aandeel waarbij de voorkeur gehaald is
    const SURFACE_WEIGHT = 4;

    // Waarde per lijnstuk (tussen punt i en i+1) uit [van, tot, waarde]-reeksen.
    function perEdge(values, n) {
      const out = new Int16Array(Math.max(0, n - 1)).fill(-1);
      (values || []).forEach(([from, to, v]) => { for (let i = from; i < to && i < out.length; i++) out[i] = v; });
      return out;
    }

    registerFeature({
      id: 'surface',
      defaults: { surface: 'any' },
      ui() {
        const row = prefRow('surface', 'Ondergrond');
        prefChoice(row, 'surface', [
          { value: 'any', text: 'Maakt niet uit' },
          { value: 'paved', text: 'Verhard' },
          { value: 'unpaved', text: 'Onverhard' },
        ]);
      },
      active: () => prefs.surface === 'paved' || prefs.surface === 'unpaved',
      label: () => (prefs.surface === 'paved' ? 'verhard' : 'onverhard'),
      request(body) { body.extra_info.push('surface', 'waytype'); },
      analyze(cand) {
        if (!cand.extras.surface) return;
        const n = cand.coords.length;
        const surf = perEdge(cand.extras.surface, n);
        const way = perEdge(cand.extras.waytype, n);
        const cum = cand.cumM || (cand.cumM = cumulativeMeters(cand.coords));
        let paved = 0; let unpaved = 0; let unknown = 0; let guessed = 0;
        for (let i = 0; i < n - 1; i++) {
          const m = cum[i + 1] - cum[i];
          if (PAVED.has(surf[i])) paved += m;
          else if (UNPAVED.has(surf[i])) unpaved += m;
          else if (WAY_PAVED.has(way[i])) { paved += m; guessed += m; }
          else if (WAY_UNPAVED.has(way[i])) { unpaved += m; guessed += m; }
          else unknown += m;
        }
        const total = paved + unpaved + unknown || 1;
        cand.stats.paved = paved / total;
        cand.stats.unpaved = unpaved / total;
        cand.stats.surfaceUnknown = unknown / total;
        cand.stats.surfaceGuessed = guessed / total;
      },
      soft(cand) {
        const st = cand.stats;
        if (st.paved === undefined) return { ok: true, score: 0, weight: 0, text: 'ondergrond: onbekend' };
        const want = prefs.surface;
        const match = want === 'paved' ? st.paved : st.unpaved;
        const other = want === 'paved' ? st.unpaved : st.paved;
        return {
          ok: match >= SURFACE_OK[want],
          score: clamp(other + st.surfaceUnknown * 0.5, 0, 1),
          weight: SURFACE_WEIGHT,
          text: `${want === 'paved' ? 'verhard' : 'onverhard'}: ${pct(match)}`,
        };
      },
      info(stats) {
        if (stats.paved === undefined) return '';
        let t = `Verhard ${pct(stats.paved)} · onverhard ${pct(stats.unpaved)}`;
        if (stats.surfaceUnknown >= 0.05) t += ` · onbekend ${pct(stats.surfaceUnknown)}`;
        if (stats.surfaceGuessed >= 0.2) t += ' (deels geschat uit het wegtype)';
        return t;
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Voorkeur 5: hoogteverschil
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // Hoogte (elevation) in hetzelfde verzoek: ORS geeft dan ascent/descent. Onder elke route
  // staat het stijgen en dalen; met een maximum is dat een harde eis (prioriteit 3).
  {
    const CLIMB_STEP = 10;
    const CLIMB_MIN = 10;
    const CLIMB_MAX = 2000;

    registerFeature({
      id: 'climb',
      defaults: { maxClimbOn: false, maxClimb: 50 },
      ui() {
        const row = prefRow('climb', 'Max. stijgen', 'Alleen rondjes met niet meer hoogtemeters omhoog dan dit.');
        const box = document.createElement('div');
        box.className = 'pref__extra mini-stepper';
        box.innerHTML = `
          <button type="button" class="mini-stepper__btn" data-dir="-1" aria-label="${CLIMB_STEP} meter minder">−</button>
          <label class="mini-stepper__field"><span class="visually-hidden">Maximaal stijgen in meters</span>
            <input type="text" inputmode="numeric" id="maxClimbInput" autocomplete="off"></label>
          <span class="mini-stepper__unit" aria-hidden="true">m</span>
          <button type="button" class="mini-stepper__btn" data-dir="1" aria-label="${CLIMB_STEP} meter meer">+</button>`;
        const input = box.querySelector('input');
        const show = () => { input.value = String(prefs.maxClimb); box.hidden = !prefs.maxClimbOn; };
        const save = (v) => {
          const n = clamp(Math.round((Number(v) || CLIMB_MIN) / CLIMB_STEP) * CLIMB_STEP, CLIMB_MIN, CLIMB_MAX);
          setPref('maxClimb', n);
          show();
        };
        prefSwitch(row, 'maxClimbOn', show);
        row.append(box);
        box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => save(prefs.maxClimb + Number(b.dataset.dir) * CLIMB_STEP)));
        input.addEventListener('change', () => save(String(input.value).replace(/[^\d]/g, '')));
        show();
      },
      active: () => prefs.maxClimbOn,
      label: () => `max. ${prefs.maxClimb} m stijgen`,
      request(body) { body.elevation = true; },
      hard(cand) {
        const up = cand.stats.ascent;
        if (!Number.isFinite(up)) return { ok: true, text: `max. ${prefs.maxClimb} m stijgen: onbekend` };
        const m = Math.round(up);
        return {
          ok: m <= prefs.maxClimb,
          text: `max. ${prefs.maxClimb} m stijgen: ${m} m`,
          failText: `Dit rondje heeft ${m} m stijgen, meer dan je maximum van ${prefs.maxClimb} m. Een vlakker rondje binnen de afstand was er niet.`,
        };
      },
      info(stats) {
        if (!Number.isFinite(stats.ascent)) return '';
        return `Stijgen ${Math.round(stats.ascent)} m · dalen ${Math.round(stats.descent || 0)} m`;
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Voorkeur 6: richting kiezen
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------
  // Gekozen: ORS round trip met "bearings". Dat zet de beginkoers van het rondje; het
  // middelpunt ligt dan ~35° rechtsom van die koers (gemeten in Utrecht en Alphen). Vergeleken
  // met tussenpunten op een cirkel (functie 8) en achteraf filteren op het middelpunt houdt dit
  // de afstand het nauwkeurigst (lengte ±6% tegen ±10%) en loopt het veel minder vaak dubbel
  // (11/16 tegen 2/16 niet dubbel); filteren kost te veel van de 8 verzoeken (~1 op 4 raak).
  // Eis (prioriteit 3): minstens 75% van de route ligt aan die kant van het startpunt.
  {
    const DIRS = {
      N: { deg: 0, name: 'noorden' },
      O: { deg: 90, name: 'oosten' },
      Z: { deg: 180, name: 'zuiden' },
      W: { deg: 270, name: 'westen' },
    };
    const LOOP_OFFSET = 35;   // middelpunt van het rondje ligt zoveel graden rechtsom van de koers
    const JITTER = 10;        // per poging ±2×10° variëren, voor andere vormen
    const DIR_OK = 0.75;

    // Aandeel van de route (in meters) aan de kant `deg` van het startpunt.
    function shareTowards(coords, start, deg) {
      const proj = makeProjector(start[0], start[1]);
      const ux = Math.sin((deg * Math.PI) / 180);
      const uy = Math.cos((deg * Math.PI) / 180);
      let inside = 0;
      let total = 0;
      let prev = proj.fwd(coords[0][0], coords[0][1]);
      for (let i = 1; i < coords.length; i++) {
        const cur = proj.fwd(coords[i][0], coords[i][1]);
        const m = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
        total += m;
        if (((prev[0] + cur[0]) / 2) * ux + ((prev[1] + cur[1]) / 2) * uy > 0) inside += m;
        prev = cur;
      }
      return total ? inside / total : 0;
    }

    registerFeature({
      id: 'direction',
      defaults: { direction: 'any' },
      ui() {
        const row = prefRow('direction', 'Richting', 'Het rondje ligt grotendeels aan deze kant van je startpunt.');
        prefChoice(row, 'direction', [
          { value: 'any', text: 'Maakt niet uit' },
          { value: 'N', text: 'N', aria: 'Noord' },
          { value: 'O', text: 'O', aria: 'Oost' },
          { value: 'Z', text: 'Z', aria: 'Zuid' },
          { value: 'W', text: 'W', aria: 'West' },
        ]);
      },
      active: () => prefs.direction in DIRS,
      label: () => `richting ${DIRS[prefs.direction].name}`,
      request(body, ctx, seed) {
        if (!(prefs.direction in DIRS) || !body.options || !body.options.round_trip) return;
        const jitter = ((seed % 5) - 2) * JITTER;
        const course = (DIRS[prefs.direction].deg - LOOP_OFFSET + jitter + 360) % 360;
        body.bearings = [[Math.round(course), 90]]; // 90: ruime marge bij het vastpakken van de weg
      },
      analyze(cand, ctx) {
        if (prefs.direction in DIRS) cand.stats.dirShare = shareTowards(cand.coords, ctx.start, DIRS[prefs.direction].deg);
      },
      hard(cand) {
        const d = DIRS[prefs.direction];
        const share = cand.stats.dirShare || 0;
        return {
          ok: share >= DIR_OK,
          text: `richting ${d.name}: ${pct(share)} van de route`,
          failText: `Maar ${pct(share)} van dit rondje ligt in het ${d.name}.`,
        };
      },
    });
  }


  // ---------------------------------------------------------------------------
  // Functie 7: tijd in plaats van km
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Functie 8: via een punt naar keuze
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Functie 9: paneel inklappen
  // (eigen blok; los terug te draaien via de bijbehorende commit)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Opstarten
  // ---------------------------------------------------------------------------
  loadPrefs();
  features.forEach((f) => f.ui && f.ui());
  renderPrefsSummary();

  if (!getApiKey()) {
    showNotice('warn', 'API-sleutel nodig',
      'Voeg je gratis OpenRouteService-sleutel toe om routes te kunnen maken.',
      { action: { label: 'Toevoegen', onClick: openKeyDialog } });
  }
  locate();
})();
