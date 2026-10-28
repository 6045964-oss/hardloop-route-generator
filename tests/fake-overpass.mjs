// Nep-Overpass voor de tests: een klein, voorspelbaar stratenrastertje in plaats van de echte
// Overpass API. Oostelijke helft rustig/landelijk (residential + farmland), westelijke helft
// druk/bebouwd (secondary + residential landuse), zodat richting-sturende voorkeuren (platteland,
// weinig bochten, drukke wegen) hier echt iets te kiezen hebben. Het rastertje wordt gecentreerd
// op de bbox die de app zelf aanvraagt (uit de Overpass-queryt ekst gehaald), dus werkt voor elk
// startpunt zonder dat een test dat zelf hoeft door te geven.

function pt(center, spacing, i, j, n) {
  const mLat = 1 / 110574;
  const mLng = 1 / (111320 * Math.cos((center.latitude * Math.PI) / 180));
  return { lat: center.latitude + (i - n / 2) * spacing * mLat, lon: center.longitude + (j - n / 2) * spacing * mLng };
}

export function fakeOverpassJson(center, { halfKm = 3, n = 10 } = {}) {
  const spacing = (halfKm * 2 * 1000) / n;
  const elements = [];
  let id = 1;
  const addWay = (a, b, tags) => elements.push({
    type: 'way', id: id++, tags, geometry: [pt(center, spacing, a[0], a[1], n), pt(center, spacing, b[0], b[1], n)],
  });
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const east = j >= n / 2; // oost = rustig/landelijk, west = druk
      if (j < n) addWay([i, j], [i, j + 1], { highway: east ? 'residential' : 'secondary' });
      if (i < n) addWay([i, j], [i + 1, j], { highway: east ? 'residential' : 'secondary' });
    }
  }
  const rect = (a, b, c, d) => [a, b, c, d, a].map(([i, j]) => pt(center, spacing, i, j, n));
  elements.push({ type: 'way', id: id++, tags: { landuse: 'farmland' }, geometry: rect([0, n / 2], [0, n], [n, n], [n, n / 2]) });
  elements.push({ type: 'way', id: id++, tags: { landuse: 'residential' }, geometry: rect([0, 0], [0, n / 2], [n, n / 2], [n, 0]) });
  return { elements };
}

// Koppelt de nep-Overpass aan een Playwright-context. calls: lijst waarin elk verzoek belandt.
export async function installFakeOverpass(context, calls = [], opts = {}) {
  await context.route(/overpass-api\.de|overpass\.kumi\.systems/, async (route) => {
    // Verzoek gaat als application/x-www-form-urlencoded (data=...): eerst decoderen.
    const raw = route.request().postData() || '';
    const body = decodeURIComponent(raw.replace(/^data=/, ''));
    const m = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/); // eerste bbox in de querytekst
    let center = { latitude: 52.13, longitude: 4.66 };
    if (m) {
      const [, south, west, north, east] = m.map(Number); // m[0] is de volledige match, overslaan
      center = { latitude: (south + north) / 2, longitude: (west + east) / 2 };
    }
    calls.push({ body, center });
    if (opts.fail) { await route.fulfill({ status: 504, body: 'nep-storing' }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeOverpassJson(center, opts)) });
  });
}
