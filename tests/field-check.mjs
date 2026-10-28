// Veldcontrole: genereert routes vanaf een echt startpunt met de ECHTE OpenRouteService- en
// Overpass-diensten, en drukt een tabel af met afstand, platteland-aandeel, bochten/km, dubbel
// gelopen meters en de gemeten generatietijd — precies de cijfers uit de opdracht (Alphen aan
// den Rijn, 5/10/15 km, Platteland/Weinig bochten aan/uit).
//
// Gebruik (Playwright staat bewust níet in het project, zie tests/README.md):
//   HRG_ORS_KEY=… PW=/pad/naar/node_modules/playwright/index.mjs node tests/field-check.mjs
//   … node tests/field-check.mjs --start=52.1294,4.6574          ander startpunt
//   … node tests/field-check.mjs --km=5,10                       andere afstanden
//
// Let op: dit script gebruikt de ECHTE Overpass API (geen nep-data). De publieke Overpass-
// servers (overpass-api.de, overpass.kumi.systems) weren verkeer uit datacenters vaak als
// anti-misbruikmaatregel — draai dit dus vanaf een gewone internetverbinding (thuis, 4G/5G),
// niet vanuit een CI-server of cloud-sandbox, anders vallen alle routes terug op een gewone
// round trip zonder sturing en zijn de platteland-/bochten-cijfers niet representatief.
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const { webkit, devices } = await import(process.env.PW || 'playwright');

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const ARG = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const START = ARG('start', '52.1294,4.6574').split(',').map(Number); // Alphen aan den Rijn
const KMS = ARG('km', '5,10,15').split(',').map(Number);
const KEY = process.env.HRG_ORS_KEY;
if (!KEY) {
  console.error('HRG_ORS_KEY ontbreekt. Zie tests/README.md voor hoe je een gratis sleutel aanmaakt.');
  process.exit(1);
}

const ROOT = mkdtempSync(join(tmpdir(), 'hrg-field-'));
cpSync(PROJECT, ROOT, { recursive: true, filter: (src) => !/[/\\](\.git|tests|node_modules)([/\\]|$)/.test(src.slice(PROJECT.length - 1)) });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(ROOT, p.endsWith('/') ? `${p}index.html` : p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;
const TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const browser = await webkit.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  geolocation: { latitude: START[0], longitude: START[1], accuracy: 8 },
  permissions: ['geolocation'],
  serviceWorkers: 'block',
});
// Kaarttegels neplaten: dit script meet routes, niet de kaart, en zo belasten we de
// gratis OSM-tegelservers niet nodeloos.
await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE_PNG }));
await context.addInitScript((k) => { try { localStorage.setItem('hrg.orsKey', JSON.stringify(k)); } catch {} }, KEY);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

await page.goto(BASE);
await page.waitForFunction(() => document.getElementById('btnGenerate') && !document.getElementById('btnGenerate').disabled);
await page.waitForFunction(() => /locatie/i.test(document.getElementById('startLabel').textContent));

async function setSwitch(prefId, on) {
  const snap = await page.evaluate(() => document.getElementById('sheet').dataset.snap);
  if (snap === 'collapsed') { await page.click('.sheet__handle'); await page.waitForTimeout(400); }
  const sel = `[data-pref="${prefId}"] input[role="switch"]`;
  const cur = await page.$eval(sel, (el) => el.checked);
  if (cur !== on) await page.click(sel);
}

async function generate(km) {
  await page.evaluate((v) => {
    const i = document.getElementById('distanceInput');
    i.value = String(v).replace('.', ',');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, km);
  const again = await page.evaluate(() => !document.getElementById('result').hidden);
  const t0 = Date.now();
  await page.evaluate((a) => document.getElementById(a ? 'btnAgain' : 'btnGenerate').click(), again);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120000 });
  const ms = Date.now() - t0;
  const entry = await page.evaluate(() => (JSON.parse(localStorage.getItem('hrg.history.v1') || '[]'))[0] || null);
  const notice = await page.$eval('#notice', (e) => (e.hidden ? '' : e.innerText.replace(/\s+/g, ' ')));
  return { entry, notice, ms };
}

const rows = [];
for (const km of KMS) {
  for (const rural of [false, true]) {
    for (const fewTurns of [false, true]) {
      await setSwitch('rural', rural);
      await setSwitch('turns', fewTurns);
      const { entry, notice, ms } = await generate(km);
      if (!entry) {
        rows.push({ km, rural, fewTurns, fout: notice || 'geen route' });
        continue;
      }
      const devPct = ((entry.distance - km * 1000) / (km * 1000)) * 100;
      rows.push({
        km,
        rural,
        fewTurns,
        km_echt: (entry.distance / 1000).toFixed(2),
        afwijking: `${devPct >= 0 ? '+' : ''}${devPct.toFixed(1)}%`,
        platteland: entry.stats && entry.stats.rural !== undefined ? `${Math.round(entry.stats.rural * 100)}%` : '–',
        bochten_km: entry.stats && entry.stats.turnsPerKm !== undefined ? entry.stats.turnsPerKm : '–',
        dubbel_m: entry.overlap,
        tijd_s: (ms / 1000).toFixed(1),
      });
    }
  }
}

console.log(`\n# Veldcontrole: ${START[0]},${START[1]} (echte ORS + echte Overpass)\n`);
console.log('| km gevraagd | platteland | weinig bochten | km echt | afwijking | platteland-aandeel | bochten/km | dubbel (m) | tijd (s) |');
console.log('|---|---|---|---|---|---|---|---|---|');
rows.forEach((r) => {
  if (r.fout) { console.log(`| ${r.km} | ${r.rural ? 'aan' : 'uit'} | ${r.fewTurns ? 'aan' : 'uit'} | **mislukt: ${r.fout}** | | | | | |`); return; }
  console.log(`| ${r.km} | ${r.rural ? 'aan' : 'uit'} | ${r.fewTurns ? 'aan' : 'uit'} | ${r.km_echt} | ${r.afwijking} | ${r.platteland} | ${r.bochten_km} | ${r.dubbel_m} | ${r.tijd_s} |`);
});
if (errors.length) console.log(`\nConsolefouten tijdens het draaien:\n${errors.join('\n')}`);

await browser.close();
server.close();
