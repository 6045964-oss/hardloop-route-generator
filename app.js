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

  const TOLERANCE_M = 250;          // max. verschil met de gevraagde afstand
  const MAX_ATTEMPTS = 8;           // max. aantal ORS-aanvragen per "Genereer route"
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
    ratio: 'hrg.lengthRatio',
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

  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    crossOrigin: true, // CORS-responses: beter te cachen dan opaque responses
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Route: <a href="https://openrouteservice.org">openrouteservice</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);

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

  els.btnMinus.addEventListener('click', () => {
    const cur = parseKm(els.distanceInput.value) || 5;
    setKm(Math.ceil(cur / STEP_KM) * STEP_KM - STEP_KM);
  });
  els.btnPlus.addEventListener('click', () => {
    const cur = parseKm(els.distanceInput.value) || 5;
    setKm(Math.floor(cur / STEP_KM) * STEP_KM + STEP_KM);
  });
  els.chips.forEach((chip) => chip.addEventListener('click', () => setKm(Number(chip.dataset.km))));
  els.distanceInput.addEventListener('change', () => {
    const km = parseKm(els.distanceInput.value);
    if (Number.isFinite(km)) setKm(km, { bump: false });
  });
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

  async function requestRoundTrip(start, meters, seed, key) {
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
        body: JSON.stringify({
          coordinates: [[start[1], start[0]]], // ORS verwacht [lng, lat]
          instructions: true,
          instructions_format: 'text',
          language: 'nl',
          elevation: false,
          options: { round_trip: { length: Math.round(meters), points: 3, seed } },
        }),
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new AppError('Geen antwoord', 'De routeservice reageert niet op tijd. Controleer je verbinding en probeer het opnieuw.', { retry: true, fatal: true });
      }
      throw new AppError('Geen verbinding', 'De routeservice is niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.', { retry: true, fatal: true });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try { body = await res.json(); } catch { /* geen JSON */ }
    if (!res.ok) throw orsError(res.status, body);

    const feature = body && body.features && body.features[0];
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
    return { coords, distance, steps };
  }

  // Meet hoeveel meter van de route je dubbel loopt (heen en terug over hetzelfde stuk,
  // of er vlak naast). Kruisingen tellen niet mee: alleen (anti)parallelle stukken.
  // Rond start/finish mag het (je eigen straat uit en weer in).
  function measureOverlap(coords) {
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
    const inZone = (a) => a < START_ZONE_M || a > total - START_ZONE_M;
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
        if (inZone(s.a) && inZone(q.a)) continue;
        hit[i] = 1;
        hit[j] = 1;
      }
    }
    // Twee keer over hetzelfde stuk = twee rakende samples; /2 geeft de lengte van het stuk.
    return (hit.reduce((n, h) => n + h, 0) * STEP) / 2;
  }

  // Vraagt meerdere rondjes aan en past de gevraagde lengte bij tot het rondje
  // binnen de marge valt en niet dubbelt. Geeft anders het beste resultaat terug.
  async function findRoundTrip(start, target, key, onProgress) {
    let ratio = clamp(Number(store.get(KEYS.ratio, 1.1)) || 1.1, 0.7, 1.6);
    let seed = newSeed();
    let sameSeed = 0;
    let best = null;
    let lastErr = null;
    const better = (a, b) => {
      if (!b) return true;
      if (a.clean !== b.clean) return a.clean;
      return a.dev + a.overlap * 3 < b.dev + b.overlap * 3;
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      onProgress(attempt);
      const asked = clamp(target / ratio, target * 0.5, target * 1.5);
      let cand;
      try {
        cand = await requestRoundTrip(start, asked, seed, key);
      } catch (err) {
        lastErr = err;
        if (err.fatal) {
          if (best) break;
          throw err;
        }
        seed = newSeed();
        sameSeed = 0;
        continue;
      }

      // Leren hoe ORS de lengte "opvat": volgende poging corrigeert daarvoor.
      const r = cand.distance / asked;
      ratio = clamp(r, 0.7, 1.6);
      store.set(KEYS.ratio, clamp(0.7 * (Number(store.get(KEYS.ratio, 1.1)) || 1.1) + 0.3 * r, 0.7, 1.6));

      cand.seed = seed;
      cand.dev = Math.abs(cand.distance - target);
      cand.overlap = measureOverlap(cand.coords);
      cand.uturn = cand.steps.some((s) => s.t === 9);
      cand.clean = cand.overlap <= OVERLAP_ALLOWED_M && !cand.uturn;
      cand.attempts = attempt;
      if (better(cand, best)) best = cand;
      if (cand.clean && cand.dev <= TOLERANCE_M) return { ...cand, ok: true };

      if (!cand.clean || ++sameSeed >= MAX_SAME_SEED) {
        seed = newSeed(); // vorm is het probleem (of convergeert niet): andere richting
        sameSeed = 0;
      }
    }
    if (!best) {
      throw lastErr || new AppError('Geen route gevonden',
        'Er kon geen rondje gevonden worden vanaf dit startpunt. Probeer een ander startpunt of een andere afstand.', { retry: true });
    }
    return { ...best, ok: best.clean && best.dev <= TOLERANCE_M };
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
    const km = readKm();
    if (!km) return;
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

    const again = !!state.route;
    const btn = again ? els.btnAgain : els.btnGenerate;
    const oldLabel = again ? 'Andere route' : 'Genereer route';
    state.generating = true;
    setBusy(btn, true, 'Route zoeken…');
    els.btnStart.disabled = true;
    hideNotice();

    try {
      const start = state.start.latlng;
      const target = km * 1000;
      const found = await findRoundTrip(start, target, key, (n) => {
        btn.querySelector('.btn__label').textContent = n === 1 ? 'Route zoeken…' : `Zoeken… ${n}/${MAX_ATTEMPTS}`;
      });
      const entry = {
        id: `r${Date.now().toString(36)}${found.seed.toString(36)}`,
        createdAt: Date.now(),
        requested: target,
        distance: found.distance,
        seed: found.seed,
        start,
        coords: found.coords,
        steps: found.steps,
        overlap: Math.round(found.overlap),
        walkedAt: null,
        run: null,
      };
      saveToHistory(entry);
      showRoute(entry);

      if (!found.ok) {
        const parts = [];
        if (found.dev > TOLERANCE_M) {
          parts.push(`Dit rondje is ${nf2.format(found.distance / 1000)} km, ${nf2.format(found.dev / 1000)} km ${found.distance > target ? 'langer' : 'korter'} dan gevraagd.`);
        }
        if (!found.clean) {
          parts.push(found.uturn
            ? 'Er zit een punt in waar je moet omkeren.'
            : `Er zit ongeveer ${Math.round(found.overlap / 10) * 10} m in die je heen en terug loopt.`);
        }
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
    const within = Math.abs(diff) <= TOLERANCE_M;
    els.resultKm.textContent = nf2.format(entry.distance / 1000);
    const reqTxt = `Gevraagd ${nfKm.format(entry.requested / 1000)} km`;
    const sign = Math.abs(diff) < 5 ? '±' : diff > 0 ? '+' : '−';
    const diffTxt = `<mark${within ? '' : ' class="is-far"'}>${sign}${nf2.format(Math.abs(diff) / 1000)} km${within ? ' ✓' : ''}</mark>`;
    let overlapTxt = '';
    if (typeof entry.overlap === 'number') {
      overlapTxt = entry.overlap <= OVERLAP_ALLOWED_M && !(entry.steps || []).some((s) => s.t === 9)
        ? ' · <mark>niet dubbel ✓</mark>'
        : ` · <mark class="is-far">~${Math.round(entry.overlap / 10) * 10} m dubbel</mark>`;
    }
    els.resultMeta.innerHTML = `${reqTxt} · ${diffTxt}${overlapTxt}`;
    els.result.hidden = false;
    els.planView.classList.add('has-route');
    setKm(entry.requested / 1000, { bump: false });

    map.fitBounds(routeLine.getBounds(), { ...fitPadding(), maxZoom: 16, animate: false });
    animateLine(routeLine);
    prefetchTiles(route.coords);
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
  // Opstarten
  // ---------------------------------------------------------------------------
  if (!getApiKey()) {
    showNotice('warn', 'API-sleutel nodig',
      'Voeg je gratis OpenRouteService-sleutel toe om routes te kunnen maken.',
      { action: { label: 'Toevoegen', onClick: openKeyDialog } });
  }
  locate();
})();
