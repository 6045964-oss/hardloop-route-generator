// End-to-end-test in echte WebKit met iPhone-emulatie (Playwright).
//
// Gebruik (Playwright staat bewust níet in het project):
//   PW=/pad/naar/node_modules/playwright/index.mjs node tests/e2e.mjs            nep-ORS (snel, gratis)
//   PW=… node tests/e2e.mjs --real                                               echte ORS (kost verzoeken!)
//   PW=… node tests/e2e.mjs --only=richting                                      alleen tests met dit woord
// Zie tests/README.md.
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installFakeOrs } from './fake-ors.mjs';

const { webkit, devices } = await import(process.env.PW || 'playwright');

const REAL = process.argv.includes('--real');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STARTS = {
  utrecht: { latitude: 52.0907, longitude: 5.1214 },
  alphen: { latitude: 52.1294, longitude: 4.6574 }, // Alphen aan den Rijn
};

// ---------------------------------------------------------------------------
// Statische server op een kopie van het project (de update-test past die kopie aan)
// ---------------------------------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'hrg-e2e-'));
cpSync(PROJECT, ROOT, { recursive: true, filter: (src) => !/[/\\](\.git|tests|node_modules)([/\\]|$)/.test(src.slice(PROJECT.length - 1)) });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;

// ---------------------------------------------------------------------------
// Hulpmiddelen
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
let skipped = 0;
function check(ok, msg) {
  checks++;
  console.log(`  ${ok ? 'OK  ' : 'FOUT'} ${msg}`);
  if (!ok) failures++;
}
function skip(msg) {
  skipped++;
  console.log(`  OVERGESLAGEN ${msg}`);
}

const browser = await webkit.launch();
const realCalls = []; // tijdstippen van echte ORS-verzoeken, om de minuutlimiet te respecteren

// Nieuwe iPhone-context (verse localStorage) met nep-ORS, of echte ORS bij --real.
async function openApp({ start = 'utrecht', scheme = 'light', viewport, serviceWorkers = 'block', fake = {}, realOrs = REAL, key = true, wakeLock = null, fakeGps = false } = {}) {
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    ...(viewport ? { viewport } : {}),
    colorScheme: scheme,
    geolocation: { ...STARTS[start], accuracy: 8 },
    permissions: ['geolocation'],
    serviceWorkers,
  });
  const calls = [];
  // Let op: met een actieve service worker omzeilen verzoeken in WebKit de onderschepping
  // van Playwright. Tests mét service worker gebruiken daarom de echte ORS en tegels.
  if (!realOrs) await installFakeOrs(context, calls, fake);
  await context.route(/tile\.openstreetmap\.org/, (r) => (realOrs ? r.continue()
    : r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE_PNG })));
  // Sleutel alleen in deze test-browser, zoals de app hem op het apparaat bewaart: echt via
  // HRG_ORS_KEY (nooit in de repository), bij de nep-ORS een nepsleutel.
  const testKey = realOrs ? process.env.HRG_ORS_KEY : 'nep-sleutel-voor-tests';
  if (key && testKey) {
    await context.addInitScript((k) => { try { if (!localStorage.getItem('hrg.orsKey')) localStorage.setItem('hrg.orsKey', JSON.stringify(k)); } catch {} }, testKey);
  }
  if (wakeLock) await context.addInitScript(WAKE_STUB, wakeLock);
  if (fakeGps) await context.addInitScript(GPS_STUB, STARTS[start]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (!/Context is stopped/.test(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('request', (r) => { if (realOrs && r.url().includes('/directions/') && r.method() === 'POST') realCalls.push(Date.now()); });
  page.on('response', async (r) => { // echte ORS: gevraagde en geleverde lengte per poging bijhouden
    if (!realOrs || !r.url().includes('/directions/') || r.request().method() !== 'POST') return;
    let asked = null;
    let distance = null;
    try { asked = JSON.parse(r.request().postData()).options?.round_trip?.length ?? null; } catch {}
    try { distance = (await r.json()).features[0].properties.summary.distance; } catch {}
    calls.push({ real: true, status: r.status(), asked, distance });
  });
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('btnGenerate') && !document.getElementById('btnGenerate').disabled);
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  return { context, page, calls, errors };
}

function hasRealKey(what) {
  if (process.env.HRG_ORS_KEY) return true;
  skip(`${what}: echte ORS nodig, geen HRG_ORS_KEY opgegeven`);
  return false;
}

async function respectMinuteLimit(need = 8) {
  for (;;) {
    const now = Date.now();
    const recent = realCalls.filter((t) => now - t < 61000);
    if (recent.length + need <= 34) return;
    await sleep(2000);
  }
}

// Afstand zetten via het invoerveld (km, of minuten als die stand aan staat).
async function setDistance(page, value) {
  await page.evaluate((v) => {
    const i = document.getElementById('distanceInput');
    i.value = String(v).replace('.', ',');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Genereer (of "Andere route") en geef de nieuwste opgeslagen route + scherminfo terug.
async function generate(page, value) {
  await respectMinuteLimit();
  if (value !== undefined) await setDistance(page, value);
  const again = await page.evaluate(() => !document.getElementById('result').hidden);
  await page.evaluate((a) => document.getElementById(a ? 'btnAgain' : 'btnGenerate').click(), again);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 240000 });
  await sleep(400);
  // Paneel klapt na een route in (functie 9): weer openen zodat de test bij de bediening kan.
  const collapsed = await page.evaluate(() => document.getElementById('sheet').dataset.snap === 'collapsed');
  if (collapsed) await openPanel(page);
  return page.evaluate((wasCollapsed) => {
    const hist = JSON.parse(localStorage.getItem('hrg.history.v1') || '[]');
    const n = document.getElementById('notice');
    const txt = (id) => (document.getElementById(id) ? document.getElementById(id).innerText.replace(/\s+/g, ' ').trim() : '');
    return {
      entry: hist[0] || null,
      notice: n && !n.hidden ? n.innerText.replace(/\s+/g, ' ').trim() : '',
      meta: txt('resultMeta'),
      info: txt('resultInfo'),
      checks: txt('resultChecks'),
      collapsed: wasCollapsed,
    };
  }, collapsed);
}

// Paneel naar "half" (zoals de gebruiker op het greepje tikt) als het ingeklapt is.
async function openPanel(page) {
  const snap = await page.evaluate(() => document.getElementById('sheet').dataset.snap);
  if (snap !== 'collapsed') return;
  await page.click('.sheet__handle');
  await page.waitForFunction(() => document.getElementById('sheet').dataset.snap === 'half' && !document.getElementById('sheet').classList.contains('is-snapping'));
}

// Wachten tot de kaarttegels langs de route opgeslagen zijn (herladen tijdens het opslaan breekt
// verzoeken af; WebKit meldt dat als "access control checks").
async function waitTiles(page) {
  await page.waitForFunction(() => /klaar|opgeslagen|mislukt|niet ondersteund/i.test(document.getElementById('tileText').textContent), null, { timeout: 90000 });
}

async function setSwitch(page, prefId, on) {
  await openPanel(page);
  const sel = `[data-pref="${prefId}"] input[role="switch"]`;
  const cur = await page.$eval(sel, (el) => el.checked);
  if (cur !== on) await page.click(sel);
}

async function choose(page, prefId, value) {
  await openPanel(page);
  await page.click(`[data-pref="${prefId}"] input[value="${value}"] + span`); // tikken op het zichtbare label
}

const pct = (x) => `${Math.round(x * 100)}%`;

// Nagebootste Screen Wake Lock API ('stub' = werkt, 'none' = niet ondersteund, 'reject' = geweigerd)
// en zichtbaarheid (window.__vis), met tellers in window.__wl.
function WAKE_STUB(mode) {
  window.__vis = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__vis !== 'visible'; } });
  window.__wl = { requests: 0, releases: 0, active: 0 };
  const api = mode === 'none' ? undefined : {
    async request(type) {
      window.__wl.requests++;
      if (mode === 'reject') throw new DOMException('Niet toegestaan', 'NotAllowedError');
      const s = new EventTarget();
      s.type = type; s.released = false;
      s.release = async () => {
        if (s.released) return;
        s.released = true; window.__wl.active--; window.__wl.releases++;
        s.dispatchEvent(new Event('release'));
      };
      window.__wl.active++; window.__wlLast = s;
      return s;
    },
  };
  Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get() { return api; } });
}

// Nagebootste GPS: window.__gpsMove(lat, lng, nauwkeurigheid) stuurt een positie naar de app.
function GPS_STUB(startPos) {
  const watchers = new Map();
  let id = 0;
  let pos = { lat: startPos.latitude, lng: startPos.longitude, acc: 6 };
  const make = () => ({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: pos.acc, altitude: null, heading: null, speed: null }, timestamp: Date.now() });
  const geo = {
    getCurrentPosition(ok) { setTimeout(() => ok(make()), 30); },
    watchPosition(ok) { id++; watchers.set(id, ok); setTimeout(() => ok(make()), 30); return id; },
    clearWatch(w) { watchers.delete(w); },
  };
  Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get() { return geo; } });
  window.__gpsMove = (lat, lng, acc = 5) => { pos = { lat, lng, acc }; watchers.forEach((cb) => cb(make())); };
  window.__gpsWatchers = () => watchers.size;
}

// 1×1 png voor nep-tegels (geen verkeer naar OSM bij nep-tests)
const TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('basis: service worker, update-melding, route, kaarttegels', async () => {
  // Met service worker: echte ORS en echte tegels (zie openApp), 1–3 verzoeken.
  const { context, page, calls, errors } = await openApp({ serviceWorkers: 'allow', realOrs: true });
  await page.waitForFunction(() => navigator.serviceWorker.ready.then((r) => !!r.active), null, { timeout: 20000 });
  await page.reload(); // tweede keer openen: nu gecontroleerd door de service worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  const caches1 = await page.evaluate(() => caches.keys());
  check(caches1.some((k) => /^hrg-static-v/.test(k)), `service worker actief, caches: ${caches1.join(', ')}`);
  check(await page.evaluate(() => document.querySelector('link[rel=manifest]').getAttribute('href') === 'manifest.json'), 'manifest.json gekoppeld');

  // Update zonder route in beeld -> automatisch herladen
  const swPath = join(ROOT, 'service-worker.js');
  const sw = readFileSync(swPath, 'utf8');
  await page.evaluate(() => { window.__marker = 1; });
  writeFileSync(swPath, sw.replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-test1'"));
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.waitForFunction(() => window.__marker === undefined && document.readyState === 'complete', null, { timeout: 20000 });
  check(true, 'nieuwe versie zonder route in beeld: automatisch herladen');
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));

  if (!hasRealKey('route, kaarttegels en update-melding met route')) {
    writeFileSync(swPath, sw);
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
    return;
  }
  // Route van 5 km
  const r = await generate(page, 5);
  if (!r.entry) throw new Error(`geen route; melding: "${r.notice}"`);
  check(Math.abs(r.entry.distance - 5000) <= 250, `route 5 km → ${(r.entry.distance / 1000).toFixed(2)} km (${calls.length} echte verzoeken)`);
  check(await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length > 0), 'route op de kaart');
  await page.waitForFunction(() => /klaar|opgeslagen|mislukt/i.test(document.getElementById('tileText').textContent), null, { timeout: 90000 });
  const tiles = await page.evaluate(() => caches.open('hrg-tiles-v1').then((c) => c.keys()).then((k) => k.length));
  check(tiles > 20, `kaarttegels offline: ${tiles} in hrg-tiles-v1 ("${await page.$eval('#tileText', (e) => e.textContent)}")`);

  // Update met route in beeld -> melding, geen herlaad
  await page.evaluate(() => { window.__marker = 2; });
  writeFileSync(swPath, sw.replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-test2'"));
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.waitForFunction(() => /nieuwe versie/i.test(document.getElementById('notice').innerText), null, { timeout: 20000 });
  check(await page.evaluate(() => window.__marker === 2), 'nieuwe versie met route in beeld: melding "Nieuwe versie", geen herlaad');
  writeFileSync(swPath, sw);
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});

test('basis: voorkeuren-paneel, max. 8 verzoeken, minuutlimiet', async () => {
  const { context, page, calls, errors } = await openApp({ fake: { scale: 2.2 } });
  check(await page.$('#prefs') !== null, 'paneel "Voorkeuren" aanwezig');
  const r = await generate(page, 5);
  if (!REAL) {
    check(calls.length <= 8, `onhaalbare lengte (nep-ORS 2,2× te lang): ${calls.length} verzoeken (max. 8)`);
    check(/beste rondje/i.test(r.notice), `melding: "${r.notice.slice(0, 90)}…"`);
    // Minuutlimiet: 36 verzoeken in de laatste minuut → eerst wachten
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem('hrg.orsLog.v1', JSON.stringify(Array.from({ length: 36 }, (_, i) => now - 57000 + i)));
    });
    const before = calls.length;
    const t0 = Date.now();
    await page.evaluate(() => document.getElementById('btnAgain').click());
    await page.waitForFunction(() => /limiet/i.test(document.getElementById('btnAgain').innerText), null, { timeout: 5000 });
    while (calls.length === before) await sleep(100);
    check(Date.now() - t0 >= 2500, `minuutlimiet: eerste verzoek pas na ${((Date.now() - t0) / 1000).toFixed(1)} s ("Limiet ORS"-label getoond)`);
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 60000 });
  }
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});

// ---------------------------------------------------------------------------
// Voorkeur 1: platteland
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 1: platteland', async () => {
  const { context, page, calls, errors } = await openApp();
  await setSwitch(page, 'rural', true);
  await page.reload();
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  check(await page.$eval('[data-pref="rural"] input[role="switch"]', (e) => e.checked), 'keuze onthouden na herladen');
  check(/platteland/.test(await page.$eval('#prefsSummary', (e) => e.textContent)), 'samenvatting noemt "platteland"');
  const r = await generate(page, 8);
  check(/platteland/.test(r.checks), `onder de route: "${r.checks}"`);
  if (!REAL) {
    const sent = calls[calls.length - 1].body;
    check(['waytype', 'surface', 'green'].every((k) => sent.extra_info.includes(k)), `extra_info in hetzelfde verzoek: ${sent.extra_info.join(', ')}`);
    const within = calls.filter((c) => Math.abs(c.distance - 8000) <= 400);
    const chosen = calls.find((c) => Math.abs(c.distance - r.entry.distance) < 0.01);
    // Vanaf 60% telt een route als "helemaal platteland": daarboven beslist de afstand.
    const bestRural = Math.min(0.6, Math.max(...within.map((c) => c.stats.rural)));
    check(chosen && chosen.stats.rural >= bestRural - 0.02, `gekozen: ${pct(chosen.stats.rural)} paden/onverhard; beste kandidaat binnen 5%: ${pct(Math.max(...within.map((c) => c.stats.rural)))} (${calls.length} verzoeken)`);
  }
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Voorkeur 2: weinig bochten
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 2: weinig bochten', async () => {
  const { context, page, calls, errors } = await openApp({ start: 'alphen' });
  await setSwitch(page, 'turns', true);
  const r = await generate(page, 6);
  check(/weinig bochten: \d+ afslagen/.test(r.checks), `onder de route: "${r.checks}"`);
  if (!REAL) {
    const within = calls.filter((c) => Math.abs(c.distance - 6000) <= 300);
    const chosen = calls.find((c) => Math.abs(c.distance - r.entry.distance) < 0.01);
    const fewest = Math.min(...within.map((c) => c.stats.turns));
    check(chosen && chosen.stats.turns <= fewest + 2, `gekozen: ${chosen && chosen.stats.turns} stappen; rustigste kandidaat binnen 5%: ${fewest} (${calls.length} verzoeken)`);
  }
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Voorkeur 3: drukke hoofdwegen vermijden
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 3: drukke hoofdwegen vermijden', async () => {
  const { context, page, calls, errors } = await openApp();
  let r = await generate(page, 5);
  check(/drukke wegen/i.test(r.info), `zonder voorkeur toch getoond: "${r.info}"`);
  await setSwitch(page, 'quiet', true);
  const before = calls.length;
  r = await generate(page);
  check(/rustige wegen: \d+ m langs drukke weg/.test(r.checks), `onder de route: "${r.checks}"`);
  check(/drukke wegen/i.test(r.info), `regel onder de route: "${r.info}"`);
  if (!REAL) {
    const own = calls.slice(before);
    const within = own.filter((c) => Math.abs(c.distance - 5000) <= 250);
    const chosen = own.find((c) => Math.abs(c.distance - r.entry.distance) < 0.01);
    const least = Math.min(...within.map((c) => c.stats.busy));
    check(chosen && chosen.stats.busy <= least + 0.03, `gekozen: ${pct(chosen.stats.busy)} drukke weg; rustigste kandidaat binnen 5%: ${pct(least)} (${own.length} verzoeken)`);
    check(own[0].body.extra_info.includes('waycategory'), 'waycategory in hetzelfde verzoek');
  }
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Voorkeur 4: ondergrond
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 4: ondergrond', async () => {
  const { context, page, calls, errors } = await openApp({ start: 'alphen' });
  for (const want of ['paved', 'unpaved']) {
    await choose(page, 'surface', want);
    const before = calls.length;
    const r = await generate(page, 5);
    check(/Verhard \d+% · onverhard \d+%/.test(r.info), `${want}: onder de route "${r.info}"`);
    check(new RegExp(`${want === 'paved' ? '(?<!on)verhard' : 'onverhard'}: \\d+%`).test(r.checks), `${want}: voorkeur "${r.checks}"`);
    if (!REAL) {
      const own = calls.slice(before);
      const key = want === 'paved' ? 'paved' : 'unpaved';
      const within = own.filter((c) => Math.abs(c.distance - 5000) <= 250);
      const chosen = own.find((c) => Math.abs(c.distance - r.entry.distance) < 0.01);
      const bestShare = Math.max(...within.map((c) => c.stats[key]));
      check(chosen && chosen.stats[key] >= bestShare - 0.05, `${want}: gekozen ${pct(chosen.stats[key])}, beste kandidaat binnen 5% ${pct(bestShare)} (${own.length} verzoeken)`);
    }
  }
  await waitTiles(page);
  await page.reload();
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  check(await page.$eval('[data-pref="surface"] input[value="unpaved"]', (e) => e.checked), 'keuze "onverhard" onthouden na herladen');
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Voorkeur 5: hoogteverschil
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 5: hoogteverschil', async () => {
  const { context, page, calls, errors } = await openApp({ start: 'alphen' });
  let r = await generate(page, 5);
  check(/Stijgen \d+ m · dalen \d+ m/.test(r.info), `stijgen/dalen onder de route: "${r.info}"`);
  if (!REAL) check(calls[calls.length - 1].body.elevation === true, 'elevation in hetzelfde verzoek');
  check(await page.$eval('#maxClimbInput', (e) => e.closest('.pref__extra').hidden), 'maximum standaard uit');
  await setSwitch(page, 'climb', true);
  check(await page.$eval('#maxClimbInput', (e) => e.value === '50' && !e.closest('.pref__extra').hidden), 'aan: standaard 50 m, invoer zichtbaar');
  // Onhaalbaar laag maximum → duidelijke melding met het werkelijke hoogteverschil
  await page.fill('#maxClimbInput', '10');
  await page.$eval('#maxClimbInput', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  r = await generate(page);
  const up = Math.round(r.entry.stats.ascent);
  if (up > 10) {
    check(new RegExp(`${up} m stijgen, meer dan je maximum van 10 m`).test(r.notice), `melding: "${r.notice.slice(0, 160)}"`);
    check(/✗ Niet gehaald: max\. 10 m stijgen/.test(r.checks), `onder de route: "${r.checks}"`);
  } else {
    check(/✓ Gehaald: max\. 10 m stijgen/.test(r.checks), `vlak rondje gevonden: "${r.checks}"`);
  }
  // Ruim maximum → gehaald
  await page.click('[data-pref="climb"] .mini-stepper__btn[data-dir="1"]');
  check(await page.$eval('#maxClimbInput', (e) => e.value) === '20', 'knop + verhoogt met 10 m');
  await page.fill('#maxClimbInput', '400');
  await page.$eval('#maxClimbInput', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  r = await generate(page);
  check(/✓ Gehaald: max\. 400 m stijgen/.test(r.checks), `ruim maximum: "${r.checks}"`);
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Voorkeur 6: richting kiezen
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('voorkeur 6: richting kiezen', async () => {
  const { context, page, calls, errors } = await openApp({ start: 'alphen' });
  const DIRS = { N: 0, O: 90, Z: 180, W: 270 };
  // Aandeel van de route aan de kant `deg` van het startpunt, onafhankelijk van de app berekend.
  const share = (coords, deg) => {
    const [la0, ln0] = coords[0];
    const kx = 111320 * Math.cos((la0 * Math.PI) / 180);
    const ux = Math.sin((deg * Math.PI) / 180), uy = Math.cos((deg * Math.PI) / 180);
    let a = 0, t = 0;
    for (let i = 1; i < coords.length; i++) {
      const x0 = (coords[i - 1][1] - ln0) * kx, y0 = (coords[i - 1][0] - la0) * 110574;
      const x1 = (coords[i][1] - ln0) * kx, y1 = (coords[i][0] - la0) * 110574;
      const m = Math.hypot(x1 - x0, y1 - y0);
      t += m;
      if (((x0 + x1) / 2) * ux + ((y0 + y1) / 2) * uy > 0) a += m;
    }
    return a / t;
  };
  for (const dir of REAL ? ['N', 'Z'] : ['N', 'O', 'Z', 'W']) {
    await choose(page, 'direction', dir);
    const before = calls.length;
    const r = await generate(page, 6);
    const s = share(r.entry.coords, DIRS[dir]);
    const dev = (r.entry.distance - 6000) / 60;
    check(s >= 0.75 && Math.abs(dev) <= 5, `${dir}: ${pct(s)} van de route in die richting, afstand ${(r.entry.distance / 1000).toFixed(2)} km (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%), ${calls.length - before} verzoeken`);
    check(/✓ Gehaald: richting/.test(r.checks), `${dir}: onder de route "${r.checks}"`);
    if (!REAL) check(Array.isArray(calls[before].body.bearings), `${dir}: bearings in het verzoek (${JSON.stringify(calls[before].body.bearings)})`);
  }
  await choose(page, 'direction', 'any');
  const r = await generate(page);
  check(!/richting/.test(r.checks), 'maakt niet uit: geen richtingseis');
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Functie 7: tijd in plaats van km
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('functie 7: tijd in plaats van km', async () => {
  const { context, page, calls, errors } = await openApp();
  await page.click('.seg--unit input[value="min"] + span');
  check(await page.$eval('.stepper__unit', (e) => e.textContent) === 'min', 'eenheid "min" in het invoerveld');
  check(/≈ 5,0 km bij 6:00 min\/km/.test(await page.$eval('#unitKm', (e) => e.textContent)), `standaard 30 min, 6:00 min/km: "${await page.$eval('#unitKm', (e) => e.textContent)}"`);
  check((await page.$$eval('.chip', (cs) => cs.map((c) => c.textContent))).join(',') === '20 min,30 min,45 min,60 min,90 min', 'snelkeuzes in minuten');
  await page.click('#btnPlus');
  check(await page.$eval('#distanceInput', (e) => e.value) === '35', 'stap van 5 minuten');
  // Tempo 5:00 → 35 min = 7,0 km
  for (let i = 0; i < 4; i++) await page.click('[data-pref="pace"] .mini-stepper__btn[data-dir="-1"]');
  check(await page.$eval('#paceInput', (e) => e.value) === '5:00', 'tempo 4× sneller in stappen van 15 s: 5:00');
  check(/≈ 7,0 km bij 5:00/.test(await page.$eval('#unitKm', (e) => e.textContent)), `35 min bij 5:00: "${await page.$eval('#unitKm', (e) => e.textContent)}"`);
  const r = await generate(page);
  check(Math.abs(r.entry.requested - 7000) < 1 && r.entry.requestedMin === 35, `gevraagd: ${r.entry.requestedMin} min = ${r.entry.requested / 1000} km`);
  check(/Gevraagd 35 min \(7 km\)/.test(r.meta), `onder de route: "${r.meta}"`);
  check(/Looptijd ≈ \d+ min bij 5:00 min\/km/.test(r.info), `looptijd: "${r.info.match(/Looptijd[^·]*km/)}"`);
  await waitTiles(page);
  await page.reload();
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  check(await page.$eval('#distanceInput', (e) => e.value) === '35' && await page.$eval('#paceInput', (e) => e.value) === '5:00', 'minuten en tempo onthouden na herladen');
  await page.click('.seg--unit input[value="km"] + span');
  check(await page.$eval('.stepper__unit', (e) => e.textContent) === 'km' && await page.$eval('#unitKm', (e) => e.hidden), 'terug naar km');
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Functie 8: via een punt naar keuze
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('functie 8: via een punt naar keuze', async () => {
  const { context, page, calls, errors } = await openApp({ start: 'alphen' });
  // Kiezen: knop, dan tikken op het zichtbare stuk kaart rechtsboven de start
  await page.click('#btnVia');
  check(/via-punt kiezen/i.test(await page.$eval('#notice', (e) => e.innerText)), 'melding "Via-punt kiezen" na tik op "Via punt"');
  const box = await page.evaluate(() => {
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const sheet = document.getElementById('sheet').getBoundingClientRect().top;
    return { x: Math.round(innerWidth * 0.62), y: Math.round(top + (sheet - top) * 0.3) }; // links van de locatieknop
  });
  await page.mouse.click(box.x, box.y);
  await page.waitForFunction(() => !!document.querySelector('.pin--via'));
  const via = await page.evaluate(() => JSON.parse(localStorage.getItem('hrg.prefs.v1')).via);
  check(Array.isArray(via), `via-punt gekozen en onthouden: ${via}`);
  check(/via punt/.test(await page.$eval('#prefsSummary', (e) => e.textContent)), 'samenvatting noemt "via punt"');

  const before = calls.length;
  const r = await generate(page, 5);
  const near = Math.min(...r.entry.coords.map(([la, ln]) => Math.hypot((la - via[0]) * 110574, (ln - via[1]) * 111320 * Math.cos((via[0] * Math.PI) / 180))));
  const dev = (r.entry.distance - 5000) / 50;
  check(near <= 100, `route gaat ${Math.round(near)} m langs het via-punt; ${(r.entry.distance / 1000).toFixed(2)} km (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%), ${calls.length - before} verzoeken`);
  check(/✓ Gehaald: via-punt/.test(r.checks), `onder de route: "${r.checks}"`);
  check(r.entry.overlap <= 30 || /dubbel/.test(r.meta), `niet dubbel: ${r.entry.overlap} m ("${r.meta}")`);
  if (!REAL) {
    const body = calls[before].body;
    check(!body.options?.round_trip && body.coordinates.length >= 5 && body.continue_straight === true, `verzoek met ${body.coordinates.length} waypoints, continue_straight`);
  }
  await waitTiles(page);

  // Te ver weg voor de afstand → melding met minimale afstand, geen verzoek
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('hrg.prefs.v1'));
    p.via = [52.1294 + 0.045, 4.6574]; // ~5 km noordelijk
    localStorage.setItem('hrg.prefs.v1', JSON.stringify(p));
  });
  await page.reload();
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  const n0 = calls.length;
  await setDistance(page, 5);
  await page.click('#btnGenerate');
  await page.waitForFunction(() => !document.getElementById('notice').hidden);
  const notice = await page.$eval('#notice', (e) => e.innerText.replace(/\s+/g, ' '));
  check(/te ver weg/i.test(notice) && /minstens \d+(,\d)? km/.test(notice), `melding: "${notice.slice(0, 150)}"`);
  check(calls.length === n0, 'geen ORS-verzoek gedaan');

  // Weghalen
  await page.click('#btnViaRemove');
  check(!(await page.$('.pin--via')) && !/via punt/.test(await page.$eval('#prefsSummary', (e) => e.textContent)), 'via-punt weggehaald (pin weg, samenvatting bijgewerkt)');
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});


// ---------------------------------------------------------------------------
// Functie 9: paneel inklappen
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('functie 9: paneel inklappen (iPhone)', async () => {
  const geom = (page) => page.evaluate(() => {
    const sheet = document.getElementById('sheet').getBoundingClientRect();
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const route = document.querySelector('.leaflet-overlay-pane path.route-line');
    const rr = route ? route.getBoundingClientRect() : null;
    const go = document.querySelector('#peek:not([hidden]) .peek__plan:not([hidden]) .peek__go');
    const gr = go ? go.getBoundingClientRect() : null;
    const hit = gr ? document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2) : null;
    return {
      snap: document.getElementById('sheet').dataset.snap,
      vh: innerHeight, sheetTop: Math.round(sheet.top), sheetBottom: Math.round(sheet.bottom), sheetH: Math.round(sheet.height), topbar: Math.round(top),
      route: rr && { top: Math.round(rr.top), bottom: Math.round(rr.bottom), left: Math.round(rr.left), right: Math.round(rr.right), h: Math.round(rr.height), w: Math.round(rr.width) },
      goText: go ? go.textContent : null, goVisible: !!(gr && gr.bottom <= innerHeight && hit && go.contains(hit)),
      peekText: (document.getElementById('peek') || {}).innerText || '',
    };
  });
  const settle = (page) => page.waitForFunction(() => !document.getElementById('sheet').classList.contains('is-snapping') && document.getElementById('sheet').dataset.snap !== 'drag');
  // Volledig zichtbaar (niet achter topbalk of paneel) en niet piepklein. Leaflet zoomt in hele
  // stappen (factor 2), dus de route vult 50–100% van het deel binnen de marges.
  const routeFits = (g) => g.route && g.route.top >= g.topbar - 2 && g.route.bottom <= g.sheetTop + 2 && g.route.left >= -2 && g.route.right <= 392
    && (g.route.h > (g.sheetTop - g.topbar) * 0.35 || g.route.w > 390 * 0.35);

  // iPhone 13; tweede ronde met de Safari-adresbalk onderin (lagere viewport) en daarna weer weg
  for (const variant of [{ name: 'iPhone 13' }, { name: 'adresbalk onderin', viewport: { width: 390, height: 580 } }]) {
    console.log(`  · ${variant.name}`);
    const { context, page, errors } = await openApp({ start: 'alphen', viewport: variant.viewport, scheme: 'dark' });
    page.on('dialog', (d) => d.accept());
    await sleep(1000); // paneel schuift bij het openen 0,8 s omhoog
    let g = await geom(page);
    check(g.snap === 'half' && g.sheetBottom === g.vh && g.sheetH <= g.vh * 0.75 + 1, `start "half": ${g.sheetH}px van ${g.vh}px, onderkant op ${g.sheetBottom}`);
    // Tikken: half → volledig → ingeklapt
    await page.click('.sheet__handle'); await settle(page);
    g = await geom(page);
    check(g.snap === 'full' && g.sheetTop <= g.topbar + 12, `tik: volledig (bovenkant ${g.sheetTop}px, topbalk ${g.topbar}px)`);
    check(await page.evaluate(() => { const p = document.getElementById('prefs'); p.scrollIntoView(); const r = p.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), 'volledig: voorkeuren bereikbaar');
    await page.click('.sheet__handle'); await settle(page);
    g = await geom(page);
    check(g.snap === 'collapsed' && g.sheetH <= 150 && g.sheetBottom === g.vh, `tik: ingeklapt, ${g.sheetH}px hoog (kaart ${Math.round((g.sheetTop / g.vh) * 100)}% van het scherm)`);
    check(/Afstand\s*5\s*km/i.test(g.peekText) && g.goText === 'Genereer' && g.goVisible, `balk: "${g.peekText.replace(/\s+/g, ' ')}", knop "${g.goText}" volledig zichtbaar en raakbaar`);
    // Vegen: omhoog naar half/volledig, omlaag naar ingeklapt
    const h = await page.$eval('.sheet__handle', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(h.x, h.y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(h.x, h.y - i * 25); await sleep(30); }
    await page.mouse.up(); await settle(page);
    g = await geom(page);
    check(g.snap === 'half' || g.snap === 'full', `veeg omhoog (250px): ${g.snap}`);
    const h2 = await page.$eval('.sheet__handle', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(h2.x, h2.y); await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(h2.x, h2.y + i * 60); await sleep(10); }
    await page.mouse.up(); await settle(page);
    g = await geom(page);
    check(g.snap === 'collapsed', `snelle veeg omlaag: ${g.snap}`);
    // Genereren vanuit de balk → route; paneel blijft ingeklapt, route past in het zichtbare deel
    await page.click('.peek__go');
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.getElementById('sheet').dataset.snap === 'collapsed' && !document.getElementById('result').hidden, null, { timeout: 120000 });
    await settle(page); await sleep(500);
    g = await geom(page);
    check(g.goText === 'Start' && /\d+,\d+\s*km/.test(g.peekText) && g.goVisible, `na genereren: ingeklapt, balk "${g.peekText.replace(/\s+/g, ' ')}" + "Start"`);
    check(routeFits(g), `route past in het zichtbare deel: route ${JSON.stringify(g.route)}, zichtbaar ${g.topbar}–${g.sheetTop}px`);
    // Na genereren vanuit "half" klapt het paneel automatisch in
    await openPanel(page);
    const r = await generate(page);
    check(r.collapsed, 'na "Andere route" (vanuit half): automatisch ingeklapt');
    await waitTiles(page);
    // Hardlopen: standaard ingeklapt met afslag + Stop; daarna weer half
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction(() => document.body.classList.contains('is-running'));
    await settle(page); await sleep(300);
    g = await geom(page);
    const runPeek = await page.$eval('.peek__run', (e) => !e.hidden && e.getBoundingClientRect().bottom <= innerHeight);
    check(g.snap === 'collapsed' && runPeek && /Nog \d/.test(g.peekText), `tijdens lopen: ingeklapt, "${g.peekText.replace(/\s+/g, ' ')}"`);
    await page.click('.peek__stop');
    await page.waitForFunction(() => !document.body.classList.contains('is-running'));
    await settle(page);
    check((await geom(page)).snap === 'half', 'na stoppen: weer half');
    if (variant.viewport) {
      // Adresbalk verdwijnt (viewport groter): ingeklapte stand blijft onderaan, route past nog
      await page.click('.sheet__handle'); await settle(page); await page.click('.sheet__handle'); await settle(page);
      await page.setViewportSize({ width: 390, height: 664 });
      await sleep(700); await settle(page);
      g = await geom(page);
      check(g.snap === 'collapsed' && g.sheetBottom === 664 && routeFits(g), `adresbalk weg (664px): onderkant ${g.sheetBottom}, route ${JSON.stringify(g.route)} past in ${g.topbar}–${g.sheetTop}px`);
    }
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }
});


// ---------------------------------------------------------------------------
// v1.4.0 — 1: afstand bij lange routes
// ---------------------------------------------------------------------------
test('afstand: beste poging bewaren, lange routes binnen 5%', async () => {
  if (!REAL) {
    // Nep-ORS maakt alles 2,2× te lang: geen poging haalt 5%, dus de dichtstbijzijnde moet winnen.
    const { context, page, calls, errors } = await openApp({ fake: { scale: 2.2 } });
    const r = await generate(page, 15);
    const closest = calls.reduce((a, c) => (Math.abs(c.distance - 15000) < Math.abs(a.distance - 15000) ? c : a));
    const last = calls[calls.length - 1];
    check(Math.abs(r.entry.distance - closest.distance) < 0.01,
      `bewaard: ${(r.entry.distance / 1000).toFixed(2)} km = dichtstbijzijnde van ${calls.length} pogingen (laatste was ${(last.distance / 1000).toFixed(2)} km)`);
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
    return;
  }
  const rows = [];
  const starts = (process.env.HRG_STARTS || 'utrecht,alphen').split(',');
  for (const start of starts) {
    const { context, page, calls, errors } = await openApp({ start });
    for (const km of [5, 10, 15, 20]) {
      const n0 = calls.length;
      const r = await generate(page, km);
      const dev = ((r.entry.distance - km * 1000) / (km * 1000)) * 100;
      rows.push({ start, km, got: r.entry.distance / 1000, dev, overlap: r.entry.overlap });
      const tries = calls.slice(n0).map((c) => `${((c.asked || 0) / 1000).toFixed(1)}→${c.distance ? (c.distance / 1000).toFixed(1) : c.status}`).join(' ');
      check(Math.abs(dev) <= 5, `${start.padEnd(7)} ${String(km).padStart(2)} km → ${(r.entry.distance / 1000).toFixed(2)} km (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%), dubbel ${r.entry.overlap} m  [${tries}]`);
    }
    check(errors.length === 0, `${start}: geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }
  const worst = Math.max(...rows.map((x) => Math.abs(x.dev)));
  console.log(`  · grootste afwijking ${worst.toFixed(1)}%, gemiddeld ${(rows.reduce((a, x) => a + Math.abs(x.dev), 0) / rows.length).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// v1.4.0 — 2: API-sleutel alleen op het apparaat
// ---------------------------------------------------------------------------
test('sleutel: niet in de code, app vraagt erom, alleen op het apparaat', async () => {
  // Geen sleutel in de repository (alle bestanden die git volgt)
  const { execFileSync } = await import('node:child_process');
  const files = execFileSync('git', ['ls-files'], { cwd: PROJECT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const leaks = files.filter((f) => !/\.png$/.test(f) && /eyJ[A-Za-z0-9_\-+/=]{30,}/.test(readFileSync(join(PROJECT, f), 'utf8')));
  check(leaks.length === 0, `geen sleutel in ${files.length} bestanden van de repository${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
  check(!/ORS_API_KEY\s*:/.test(readFileSync(join(PROJECT, 'config.js'), 'utf8')), 'config.js bevat geen sleutelveld');

  const { context, page, calls, errors } = await openApp({ key: false });
  page.on('dialog', (d) => d.accept());
  const notice = () => page.$eval('#notice', (e) => (e.hidden ? '' : e.innerText.replace(/\s+/g, ' ')));
  check(/API-sleutel nodig/i.test(await notice()), `bij opstarten zonder sleutel: "${(await notice()).slice(0, 90)}"`);
  await page.evaluate(() => document.getElementById('btnGenerate').click());
  await page.waitForTimeout(500);
  check(/API-sleutel nodig/i.test(await notice()) && calls.length === 0, 'genereren zonder sleutel: melding, geen verzoek naar ORS');
  // Toevoegen via de melding → venster → opslaan
  await page.click('#noticeAction');
  await page.waitForFunction(() => document.getElementById('keyDialog').open);
  check(/account\.heigit\.org/.test(await page.$eval('#keyDialog', (e) => e.innerHTML)), 'venster verwijst naar account.heigit.org');
  await page.fill('#keyInput', '  mijn-test-sleutel  ');
  await page.click('#btnKeySave');
  await page.waitForFunction(() => !document.getElementById('keyDialog').open);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('hrg.orsKey'))) === 'mijn-test-sleutel', 'sleutel (zonder spaties) in localStorage van dit apparaat');
  const r = await generate(page, 5);
  check(r.entry && calls.length > 0 && calls.every((c) => c.auth === 'mijn-test-sleutel'), `route gemaakt; ${calls.length} verzoeken met de sleutel in de Authorization-header`);
  await waitTiles(page);
  await page.reload();
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  check(!/API-sleutel nodig/i.test(await notice()), 'na herladen: sleutel onthouden, geen vraag meer');
  // Wissen
  await page.click('#btnKey');
  await page.waitForFunction(() => document.getElementById('keyDialog').open);
  await page.click('#btnKeyClear');
  await page.click('#keyDialog [data-close]');
  check(await page.evaluate(() => localStorage.getItem('hrg.orsKey')) === null, 'Wissen haalt de sleutel van het apparaat');
  check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
});

// ---------------------------------------------------------------------------
// v1.4.0 — 3: scherm aan houden (Screen Wake Lock API)
// ---------------------------------------------------------------------------
test('scherm aan: wake lock tijdens navigatie', async () => {
  const startRun = async (page) => {
    await generate(page, 5);
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction(() => document.body.classList.contains('is-running'));
    await page.waitForTimeout(300);
  };
  const wl = (page) => page.evaluate(() => ({ ...window.__wl }));
  {
    const { context, page, errors } = await openApp({ wakeLock: 'stub' });
    page.on('dialog', (d) => d.accept());
    await startRun(page);
    let w = await wl(page);
    check(w.requests === 1 && w.active === 1, `navigatie gestart: lock aangevraagd (${w.requests}×, ${w.active} actief)`);
    // Naar de achtergrond: systeem laat los; niet opnieuw zolang verborgen
    await page.evaluate(() => { window.__vis = 'hidden'; window.__wlLast.release(); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(1500);
    w = await wl(page);
    check(w.requests === 1 && w.active === 0, `app verborgen: losgelaten, niet opnieuw aangevraagd (${w.requests}×)`);
    await page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    w = await wl(page);
    check(w.requests === 2 && w.active === 1, `weer zichtbaar: opnieuw aangevraagd (${w.requests}×, ${w.active} actief)`);
    // Systeem laat los terwijl de app zichtbaar is → na ~1 s opnieuw
    await page.evaluate(() => window.__wlLast.release());
    await page.waitForTimeout(1500);
    w = await wl(page);
    check(w.requests === 3 && w.active === 1, `losgelaten door het systeem terwijl zichtbaar: opnieuw aangevraagd (${w.requests}×)`);
    await page.evaluate(() => document.getElementById('btnStop').click());
    await page.waitForFunction(() => !document.body.classList.contains('is-running'));
    await page.waitForTimeout(1500);
    w = await wl(page);
    check(w.active === 0 && w.requests === 3, `navigatie gestopt: losgelaten en niet opnieuw aangevraagd (${w.releases}× losgelaten)`);
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }
  for (const mode of ['none', 'reject']) {
    const { context, page, errors } = await openApp({ wakeLock: mode });
    page.on('dialog', (d) => d.accept());
    await startRun(page);
    const n = await page.$eval('#notice', (e) => (e.hidden ? '' : e.innerText.replace(/\s+/g, ' ')));
    const visible = await page.$eval('#notice', (e) => { const r = e.getBoundingClientRect(); return !e.hidden && r.top >= 0 && r.bottom <= innerHeight; });
    check(/scherm blijft niet aan/i.test(n) && visible, `${mode === 'none' ? 'niet ondersteund' : 'geweigerd'}: korte melding zichtbaar bij ingeklapt paneel: "${n.slice(0, 100)}"`);
    check(await page.$eval('#wakeWarn', (e) => !e.hidden && /Automatische vergrendeling/.test(e.textContent)), `${mode}: uitgebreide uitleg in het paneel`);
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Direct terug: kortste weg naar de start tijdens het lopen
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------
test('Direct terug: online (ORS), offline terugval, en voltooien', async () => {
  // Online: een stuk van het rondje lopen, dan "Direct terug" → ORS-aanvraag voor het kortste
  // stuk naar de start, en dat stuk uitlopen tot "Terug bij de start".
  {
    const { context, page, calls, errors } = await openApp({ start: 'alphen', fakeGps: true });
    page.on('dialog', (d) => d.accept());
    const r = await generate(page, 5);
    if (!r.entry) throw new Error(`geen route; melding: "${r.notice}"`);
    const coords = r.entry.coords;
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction(() => document.body.classList.contains('is-running'));
    await page.waitForTimeout(300);

    // Ruim 60% van het rondje lopen: ver genoeg van start/finish voor een ORS-terugpad, én over
    // de markWalked-drempel (run.back.loopAlong >= 60% van de lus) zodat "gelopen" ook echt test.
    const idx = Math.floor(coords.length * 0.68);
    for (let i = 1; i <= idx; i += 3) {
      await page.evaluate(([la, ln]) => window.__gpsMove(la, ln, 6), coords[i]);
      await page.waitForTimeout(12);
    }
    await page.waitForTimeout(200);
    check(!(await page.$eval('#btnBack', (e) => e.disabled)), '"Direct terug" aanklikbaar na een stuk lopen');

    const before = calls.length;
    await page.evaluate(() => document.getElementById('btnBack').click());
    await page.waitForFunction(() => !document.getElementById('backInfo').hidden, null, { timeout: 15000 });
    check(calls.length === before + 1, `online: precies 1 extra ORS-verzoek voor het terugpad (${calls.length - before})`);
    const afterClickBody = calls[calls.length - 1].body;
    check(Array.isArray(afterClickBody.coordinates) && afterClickBody.coordinates.length === 2 && !afterClickBody.options,
      `verzoek is punt-naar-punt, geen round_trip: ${JSON.stringify(afterClickBody.coordinates)}`);
    const hasBackLine = await page.evaluate(() => !!document.querySelector('.leaflet-overlay-pane path.route-back'));
    check(hasBackLine, 'terugpad getekend op de kaart (.route-back)');
    const btnTxt = await page.$eval('#btnBack', (e) => e.textContent.trim());
    check(btnTxt === 'Op weg terug', `knoptekst na starten: "${btnTxt}"`);
    const backKm = await page.$eval('#backKm', (e) => e.textContent);
    check(/^\d+,\d$/.test(backKm), `afstand-naar-start getoond: "${backKm}" km`);

    // Het terugpad uitlopen (lineair van het huidige punt naar de start) tot "Terug bij de start".
    const from = coords[idx];
    const to = coords[0];
    for (let s = 1; s <= 12; s++) {
      const t = s / 12;
      await page.evaluate(([la, ln]) => window.__gpsMove(la, ln, 6),
        [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
      await page.waitForTimeout(12);
    }
    await page.waitForTimeout(300);
    const status = await page.$eval('#runStatusText', (e) => e.textContent);
    const state = await page.$eval('#runStatus', (e) => e.dataset.state);
    check(state === 'done' && /terug bij de start/i.test(status), `status na uitlopen terugpad: "${status}" (${state})`);
    const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('hrg.history.v1') || '[]'));
    const item = hist.find((h) => h.id === r.entry.id);
    check(!!(item && item.walkedAt), `rondje via Direct terug als gelopen opgeslagen (walkedAt: ${item && item.walkedAt})`);
    check(errors.length === 0, `geen consolefouten${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }

  // Offline: geen ORS-verzoek, terugval op het kortste van "rest van het rondje" /
  // "terug langs de gelopen weg"; daarna Stop herstelt het oorspronkelijke rondje.
  {
    const { context, page, calls, errors } = await openApp({ start: 'alphen', fakeGps: true });
    page.on('dialog', (d) => d.accept());
    const r = await generate(page, 5);
    if (!r.entry) throw new Error(`geen route; melding: "${r.notice}"`);
    // Wachten tot het vooraf cachen van kaarttegels klaar is: anders breekt het zelf zetten van
    // de browser op "offline" die lopende verzoeken af (net als bij herladen, zie waitTiles),
    // wat hier niets met Direct terug te maken heeft maar wel als consolefout binnenkomt.
    await waitTiles(page);
    const coords = r.entry.coords;
    const originalId = r.entry.id;
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction(() => document.body.classList.contains('is-running'));
    await page.waitForTimeout(300);

    const idx = Math.floor(coords.length * 0.4);
    for (let i = 1; i <= idx; i += 3) {
      await page.evaluate(([la, ln]) => window.__gpsMove(la, ln, 6), coords[i]);
      await page.waitForTimeout(12);
    }
    await page.waitForTimeout(200);

    await context.setOffline(true);
    const before = calls.length;
    await page.evaluate(() => document.getElementById('btnBack').click());
    await page.waitForFunction(() => !document.getElementById('backInfo').hidden, null, { timeout: 15000 });
    check(calls.length === before, `offline: geen ORS-verzoek gedaan (${calls.length - before} extra)`);
    const label = await page.$eval('#backLabel', (e) => e.textContent);
    check(/rest van het rondje|gelopen weg/i.test(label), `offline terugval: "${label}"`);
    await context.setOffline(false);
    // Terwijl de live kaart meebeweegt (focusOn op elke fix) blijft Leaflet nieuwe tegels buiten
    // het vooraf gecachte gebied opvragen; "offline" zetten breekt die lopende verzoeken af, wat
    // WebKit als generieke resource-fout in de console meldt — niets met Direct terug te maken
    // (reproduceert identiek zonder die knop ooit aan te raken, geverifieerd los van deze test).
    // Al afgehandeld op app-niveau via tileLayer's eigen 'tileerror' (zie checkTiles/warnTiles);
    // hier dus gericht filteren i.p.v. de hele consolefouten-check laten falen.
    const realErrors = errors.filter((e) => !/Failed to load resource: WebKit encountered an internal error/.test(e));

    // Stoppen zonder het terugpad af te maken: oorspronkelijke rondje moet hersteld worden
    // (state.route terug naar de volledige lus, niet het korte terugpad).
    await page.evaluate(() => document.getElementById('btnStop').click());
    await page.waitForFunction(() => !document.body.classList.contains('is-running'));
    await page.waitForTimeout(200);
    const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('hrg.history.v1') || '[]'));
    const original = hist.find((h) => h.id === originalId);
    // Bij 40% gelopen (< 60%) mag het oorspronkelijke rondje NIET als gelopen gemarkeerd zijn.
    check(!!original && !original.walkedAt, `< 60% gelopen vóór Stop: oorspronkelijke route niet als gelopen gemarkeerd (walkedAt: ${original && original.walkedAt})`);

    // Opnieuw starten: bevestigt dat state.route echt terug is naar de volledige lus
    // (anders zou "Nog" hier de korte terugpad-afstand tonen, niet de oorspronkelijke ~5 km).
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction(() => document.body.classList.contains('is-running'));
    await page.waitForTimeout(200);
    const left2 = await page.$eval('#statLeft', (e) => parseFloat(e.textContent.replace(',', '.')));
    check(Math.abs(left2 - r.entry.distance / 1000) < 0.05,
      `restoreLoop: na Stop + opnieuw Start toont "Nog" weer de volledige lus (${left2} km, origineel ${(r.entry.distance / 1000).toFixed(2)} km)`);
    check(await page.$eval('#backInfo', (e) => e.hidden), 'terug-info verborgen bij een verse start (geen Direct terug ingedrukt)');

    check(realErrors.length === 0, `geen consolefouten (afgezien van offline tegel-ruis)${realErrors.length ? `: ${realErrors.join(' | ')}` : ''}`);
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Uitvoeren
// ---------------------------------------------------------------------------
try {
  for (const t of tests) {
    if (ONLY && !t.name.toLowerCase().includes(ONLY)) continue;
    console.log(`\n▸ ${t.name}${REAL ? ' [echte ORS]' : ''}`);
    try { await t.fn(); } catch (e) { check(false, `afgebroken: ${e.message.split("\n").slice(0, 12).join(" | ")}`); }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${checks - failures}/${checks} controles geslaagd${skipped ? ` · ${skipped} overgeslagen` : ''}${realCalls.length ? ` · ${realCalls.length} echte ORS-verzoeken` : ''}`);
process.exitCode = failures ? 1 : 0;
