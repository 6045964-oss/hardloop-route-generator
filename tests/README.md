# Tests

`e2e.mjs` test de app in echte WebKit met iPhone-emulatie (Playwright): service worker,
update-melding, route genereren, kaarttegels, en elke voorkeur/functie in een eigen blok.

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
