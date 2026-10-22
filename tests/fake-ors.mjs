// Nep-OpenRouteService voor de tests: snel, gratis en voorspelbaar.
// Begrijpt round_trip (+ bearings), waypoints, extra_info en elevation. Elke "vorm" (seed of
// ligging van de tussenpunten) krijgt eigen kenmerken (drukke wegen, ondergrond, bochten,
// hoogte), zodat de keuzelogica van de app echt iets te kiezen heeft.

const M_LAT = 110574;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function hash(n) {
  let x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Cirkel door het startpunt, middelpunt in richting `heading` (graden, 0 = noord).
function circleLoop(start, perimeter, heading, n = 240) {
  const R = perimeter / (2 * Math.PI);
  const h = (heading * Math.PI) / 180;
  const cx = R * Math.sin(h), cy = R * Math.cos(h);
  const a0 = Math.atan2(-cy, -cx); // hoek van het startpunt vanaf het middelpunt
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (2 * Math.PI * i) / n;
    const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
    pts.push([start[0] + x / mLng(start[1]), start[1] + y / M_LAT]);
  }
  pts[pts.length - 1] = [...start];
  return pts;
}

// Lijn door de waypoints, met een licht kronkelende weg ertussen.
function viaLine(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(4, Math.ceil(haversine(a, b) / 40));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const wiggle = Math.sin(t * Math.PI * 3) * 0.00012 * (s < steps ? 1 : 0);
      out.push([a[0] + (b[0] - a[0]) * t + wiggle, a[1] + (b[1] - a[1]) * t - wiggle]);
    }
  }
  return out;
}

function lineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

// Stukjes [van, tot, waarde] over de hele lijn, waarde gekozen met kansen `weights`.
function segments(n, key, values, weights) {
  const out = [];
  let i = 0, k = 0;
  while (i < n - 1) {
    const len = 8 + Math.floor(hash(key + k * 7.1) * 30);
    const to = Math.min(n - 1, i + len);
    let r = hash(key + k * 3.3), acc = 0, v = values[values.length - 1];
    for (let j = 0; j < values.length; j++) { acc += weights[j]; if (r < acc) { v = values[j]; break; } }
    out.push([i, to, v]);
    i = to; k++;
  }
  return out;
}

export function fakeRoute(body, { scale = 1 } = {}) {
  const coords = body.coordinates;
  const start = coords[0];
  let line, shapeKey;
  if (body.options && body.options.round_trip) {
    const { length, seed } = body.options.round_trip;
    const bearing = body.bearings && body.bearings[0] ? body.bearings[0][0] : null;
    const heading = bearing !== null ? bearing + 35 : (seed * 137) % 360; // zoals ORS: ~35° rechtsom van de bearing
    const shape = 1 + 0.05 * (hash(seed) - 0.5);
    line = circleLoop(start, length * 1.1 * shape, heading);
    shapeKey = seed;
  } else {
    line = viaLine(coords);
    shapeKey = Math.round((coords[1][0] + coords[1][1]) * 1e4);
  }
  const n = line.length;
  const distance = lineLength(line) * (body.options && body.options.round_trip ? 1 : 1.25) * scale;
  const busy = hash(shapeKey * 1.7);           // aandeel drukke wegen verschilt per vorm
  const unpaved = hash(shapeKey * 2.9);
  const extrasAll = {
    waytype: segments(n, shapeKey * 1.1, [1, 2, 3, 4, 5, 7], [busy * 0.3, busy * 0.3, 0.3 - busy * 0.2, 0.15, 0.1, 0.45 - busy * 0.4]),
    surface: segments(n, shapeKey * 1.3, [3, 14, 0, 10, 12], [0.4 * (1 - unpaved), 0.2 * (1 - unpaved), 0.2, 0.2 * unpaved + 0.1, 0.1 + 0.1 * unpaved]),
    waycategory: [[0, n - 1, 0]],
    green: [[0, n - 1, 10]],
    steepness: [[0, n - 1, 0]],
    noise: [[0, n - 1, 7]],
  };
  const extras = {};
  (body.extra_info || []).forEach((k) => {
    const values = extrasAll[k] || [[0, n - 1, 0]];
    extras[k] = { values, summary: [] };
  });
  const turns = 4 + Math.floor(hash(shapeKey * 3.7) * 30);
  const steps = [];
  for (let t = 0; t < turns; t++) {
    const w = Math.floor(((t + 1) / (turns + 1)) * (n - 1));
    steps.push({ type: [0, 1, 2, 3, 4, 5, 6][Math.floor(hash(shapeKey + t) * 7)], name: `Straat ${t}`, way_points: [w, w + 1], distance: 50 });
  }
  steps.push({ type: 10, name: '', way_points: [n - 1, n - 1], distance: 0 });
  const elevation = !!body.elevation;
  const climb = Math.round(5 + hash(shapeKey * 4.3) * 120);
  const geometry = { type: 'LineString', coordinates: elevation ? line.map(([x, y], i) => [x, y, Math.round(climb * Math.sin((i / n) * Math.PI))]) : line };
  const properties = { summary: { distance, duration: distance / 1.4 }, segments: [{ distance, steps }], extras, way_points: [0, n - 1] };
  if (elevation) { properties.ascent = climb; properties.descent = climb; }
  // Kenmerken van deze kandidaat (aandelen per lengte), zodat tests de keuze kunnen narekenen.
  const share = (vals, pick) => vals.reduce((a, [f, t, v]) => a + (pick(v) ? t - f : 0), 0) / (n - 1);
  // Ondergrond zoals de app hem afleidt: onbekend (0) → uit het wegtype (1/2/3/6/7 verhard, 5 onverhard).
  const edge = (vals) => { const e = new Array(n - 1).fill(-1); vals.forEach(([f, t, v]) => { for (let i = f; i < t; i++) e[i] = v; }); return e; };
  const sE = edge(extrasAll.surface), wE = edge(extrasAll.waytype);
  let pv = 0, up = 0;
  for (let i = 0; i < n - 1; i++) {
    if ([1, 3, 4, 5, 6, 7, 14, 18].includes(sE[i])) pv++;
    else if ([2, 8, 9, 10, 11, 12, 15, 16, 17].includes(sE[i])) up++;
    else if ([1, 2, 3, 6, 7].includes(wE[i])) pv++;
    else if (wE[i] === 5) up++;
  }
  const stats = {
    busy: share(extrasAll.waytype, (v) => v === 1 || v === 2),
    paths: share(extrasAll.waytype, (v) => v === 4 || v === 5),
    // Platteland zoals de app het meet: max(paden/landwegen, expliciet onverhard)
    rural: Math.max(share(extrasAll.waytype, (v) => v === 4 || v === 5), share(extrasAll.surface, (v) => v === 10 || v === 12)),
    unpaved: up / (n - 1),
    paved: pv / (n - 1),
    turns,
    climb: elevation ? climb : null,
  };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties }], stats };
}

// Koppelt de nep-ORS aan een Playwright-context. calls: lijst waarin elk verzoek belandt.
export async function installFakeOrs(context, calls = [], opts = {}) {
  await context.route(/\/openrouteservice\/v2\/directions\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    }
    const body = JSON.parse(req.postData());
    const json = fakeRoute(body, opts);
    calls.push({ body, distance: json.features[0].properties.summary.distance, stats: json.stats });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(json) });
  });
  return calls;
}
