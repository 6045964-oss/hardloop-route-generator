# Tests

`e2e.mjs` test de app in echte WebKit met iPhone-emulatie (Playwright): service worker,
update-melding, route genereren, kaarttegels, en elke voorkeur/functie in een eigen blok.
Gebruikt naast de nep-ORS (`fake-ors.mjs`) ook een nep-Overpass (`fake-overpass.mjs`): een klein
stratenrastertje met een rustige/landelijke en een drukke/bebouwde helft, zodat getest kan worden
dat voorkeuren de richting écht sturen (zie de test "route plannen") zonder van de echte,
publieke Overpass-servers afhankelijk te zijn — die weren verkeer uit datacenters sowieso vaak
als anti-misbruikmaatregel.

`field-check.mjs` is geen geautomatiseerde test (geen pass/fail): het genereert routes vanaf een
echt startpunt met de ECHTE OpenRouteService- én Overpass-diensten, en drukt een tabel af
(afstand, platteland-aandeel, bochten/km, dubbel gelopen meters, generatietijd) voor 5/10/15 km ×
Platteland aan/uit × Weinig bochten aan/uit. **Draai dit vanaf een gewone internetverbinding**
(thuis, 4G/5G) — niet vanuit een CI-server of cloud-sandbox: de publieke Overpass-servers
blokkeren datacenter-IP's vaak, waardoor alles dan stil terugvalt op een ongestuurde round trip
en de cijfers niets zeggen. Gebruik: `HRG_ORS_KEY=… PW=… node tests/field-check.mjs`
(`--start=lat,lng` en `--km=5,10,15` zijn optioneel).

Playwright staat bewust níet in het project. Installeer het eenmalig in een losse map:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm install playwright@1.49.1
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers npx playwright install webkit
```

Daarna, vanuit de projectmap:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers PW=/tmp/pw/node_modules/playwright/index.mjs node tests/e2e.mjs
```

- Standaard gebruikt de test een **nep-ORS** (`fake-ors.mjs`): snel, gratis, voorspelbaar.
- `--real` gebruikt de echte OpenRouteService. Geef de sleutel mee als omgevingsvariabele
  (nooit in een bestand in de repository): `HRG_ORS_KEY=… node tests/e2e.mjs --real`. Dat kost
  routeverzoeken (gratis plan: 2000 per dag, 40 per minuut); de test wacht zelf als de
  minuutlimiet in zicht komt.
- De test "service worker" gebruikt altijd de echte ORS (een actieve service worker omzeilt
  de nep-ORS). Zonder `HRG_ORS_KEY` slaat hij het route-deel over.
- `--only=woord` draait alleen de tests waarvan de naam dat woord bevat.
