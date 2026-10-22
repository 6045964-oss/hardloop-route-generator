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
function check(ok, msg) {
  checks++;
  console.log(`  ${ok ? 'OK  ' : 'FOUT'} ${msg}`);
  if (!ok) failures++;
}

const browser = await webkit.launch();
const realCalls = []; // tijdstippen van echte ORS-verzoeken, om de minuutlimiet te respecteren

// Nieuwe iPhone-context (verse localStorage) met nep-ORS, of echte ORS bij --real.
async function openApp({ start = 'utrecht', scheme = 'light', viewport, serviceWorkers = 'block', fake = {}, realOrs = REAL } = {}) {
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (!/Context is stopped/.test(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('request', (r) => { if (realOrs && r.url().includes('/directions/') && r.method() === 'POST') { realCalls.push(Date.now()); calls.push({ real: true }); } });
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('btnGenerate') && !document.getElementById('btnGenerate').disabled);
  await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));
  return { context, page, calls, errors };
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
  return page.evaluate(() => {
    const hist = JSON.parse(localStorage.getItem('hrg.history.v1') || '[]');
    const n = document.getElementById('notice');
    const txt = (id) => (document.getElementById(id) ? document.getElementById(id).innerText.replace(/\s+/g, ' ').trim() : '');
    return {
      entry: hist[0] || null,
      notice: n && !n.hidden ? n.innerText.replace(/\s+/g, ' ').trim() : '',
      meta: txt('resultMeta'),
      info: txt('resultInfo'),
      checks: txt('resultChecks'),
    };
  });
}

// Wachten tot de kaarttegels langs de route opgeslagen zijn (herladen tijdens het opslaan breekt
// verzoeken af; WebKit meldt dat als "access control checks").
async function waitTiles(page) {
  await page.waitForFunction(() => /klaar|opgeslagen|mislukt|niet ondersteund/i.test(document.getElementById('tileText').textContent), null, { timeout: 90000 });
}

async function setSwitch(page, prefId, on) {
  const sel = `[data-pref="${prefId}"] input[role="switch"]`;
  const cur = await page.$eval(sel, (el) => el.checked);
  if (cur !== on) await page.click(sel);
}

async function choose(page, prefId, value) {
  await page.click(`[data-pref="${prefId}"] input[value="${value}"] + span`); // tikken op het zichtbare label
}

const pct = (x) => `${Math.round(x * 100)}%`;

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

  // Route van 5 km
  const r = await generate(page, 5);
  check(r.entry && Math.abs(r.entry.distance - 5000) <= 250, `route 5 km → ${(r.entry.distance / 1000).toFixed(2)} km (${calls.length} echte verzoeken)`);
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

// ---------------------------------------------------------------------------
// Functie 8: via een punt naar keuze
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Functie 9: paneel inklappen
// (eigen blok; los terug te draaien via de bijbehorende commit)
// ---------------------------------------------------------------------------

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
console.log(`\n${checks - failures}/${checks} controles geslaagd${REAL ? ` · ${realCalls.length} echte ORS-verzoeken` : ''}`);
process.exitCode = failures ? 1 : 0;
