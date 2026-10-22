# Hardloop Route Generator

Persoonlijke PWA voor de iPhone: kies een afstand, krijg een rondje dat start en eindigt op je locatie (of een punt dat je op de kaart tikt), en laat je tijdens het lopen gesproken waarschuwen als je meer dan ~20 m van de route afwijkt.

Puur statische bestanden, geen server, geen account.

| Bestand | Wat |
|---|---|
| `index.html` | De app |
| `style.css` | Vormgeving (licht/donker, mobiel-eerst) |
| `app.js` | Kaart, route, live modus, spraak, geschiedenis |
| `config.js` | **Hier komt je OpenRouteService API-sleutel** |
| `manifest.json` | PWA-gegevens (naam, icoon, standalone) |
| `service-worker.js` | Offline cache voor de app en de kaarttegels |
| `icons/` | App-iconen |

---

## 1. Gratis OpenRouteService-sleutel aanmaken

1. Ga naar **https://openrouteservice.org/dev/#/signup** en maak een gratis account aan.
2. Bevestig je e-mailadres via de link in de mail en log in.
3. Je komt op je **Dashboard**. Kies bij *Request a token* het type **Standard**, vul een naam in (bijv. `hardlopen`) en klik op **CREATE TOKEN**.
4. Kopieer de lange sleutel die verschijnt.

Het gratis plan is ruim genoeg voor persoonlijk gebruik (ongeveer 2.000 routes per dag, 40 per minuut).

### Sleutel invullen: kies één van twee manieren

**A. In `config.js`** (makkelijk):
```js
window.HRG_CONFIG = {
  ORS_API_KEY: 'plak-hier-je-sleutel',
  OFF_ROUTE_METERS: 20,
};
```
> Let op: op GitHub Pages is dit bestand openbaar leesbaar. Het risico is klein (iemand kan hooguit jouw gratis quotum gebruiken), maar weet het.

**B. In de app zelf** (sleutel blijft privé): laat `config.js` leeg, open de app, tik rechtsboven op het **sleutel-icoon** en plak hem daar. Hij wordt alleen op je iPhone bewaard.

---

## 2. Online zetten met GitHub Pages

1. Maak op GitHub een nieuwe repository, bijv. `hardlopen`.
2. Upload alle bestanden uit deze map (inclusief de map `icons/`) naar de hoofdmap van de repository.
   - Via de website: *Add file → Upload files*, alles erin slepen, *Commit changes*.
3. Ga naar **Settings → Pages**. Kies bij *Source*: **Deploy from a branch**, branch **main**, map **/ (root)**, en klik op **Save**.
4. Na ongeveer een minuut staat de app op `https://<jouw-gebruikersnaam>.github.io/hardlopen/`.

HTTPS is nodig voor locatie, het scherm aan houden en installeren als app. GitHub Pages regelt dat automatisch.

### Een nieuwe versie uitrollen
Verander je iets aan de bestanden? Verhoog dan in `service-worker.js` het versienummer (`const VERSION = 'v1.2.1'`). Dan haalt de iPhone de nieuwe bestanden op. De app laadt de nieuwe versie daarna vanzelf. Heb je op dat moment al een route op het scherm, dan krijg je een melding met een knop *Laden*.

---

## 3. Op je iPhone zetten

1. Open de GitHub Pages-link in **Safari**.
2. Tik op de **Deel-knop** (vierkant met pijl) → **Zet op beginscherm** → **Voeg toe**.
3. Open de app via het nieuwe icoon en tik op **Sta toe** bij de vraag om je locatie.

**Locatie per ongeluk geweigerd?**
Ga naar *Instellingen → Privacy en beveiliging → Locatievoorzieningen → Safari-websites* en kies *Bij gebruik van de app*. Staat de app op je beginscherm, controleer dan ook *Instellingen → Safari → Locatie*.

---

## Gebruik

1. **Startpunt**: je huidige locatie wordt automatisch gebruikt. Tik op de kaart om een ander startpunt te kiezen, bijvoorbeeld om thuis alvast een route te plannen. Met **Mijn locatie** ga je terug naar je eigen positie.
2. **Afstand**: gebruik − / +, een snelkeuze, of typ een getal (1–42 km).
3. **Genereer route**: de app zoekt een rondje dat **binnen ±0,25 km** van je afstand valt en **nergens dubbelt**. Alleen vlak bij de start mag maximaal ~150 m heen en terug, bijvoorbeeld je eigen straat. Daarvoor vraagt de app tot 8 routes aan en stelt hij de lengte telkens bij. Dat kan een paar seconden duren (je ziet "Zoeken… 3/8"). Lukt het niet, dan krijg je het beste rondje met een melding wat eraan schort.
4. Niet tevreden? **Andere route** zoekt een nieuw rondje met dezelfde regels.
5. Zodra de route er is, slaat de app de **kaart langs de route offline op**. Een balkje laat zien hoe ver het is.
6. **Start hardlopen**: je positie beweegt live mee en het scherm blijft aan.
   - **Afslagen**: bovenin staat een grote kaart met de volgende afslag en de afstand ernaartoe. Je hoort *"Over 50 meter linksaf, Amerikalaan."* en daarna *"Nu linksaf."* Bij een rotonde staat het nummer van de afslag in het icoon.
   - **Op de kaart** wordt het gelopen stuk grijs. Bewegende zwarte stippen laten de komende 400 m in looprichting zien.
   - Loop je de verkeerde kant op (bijvoorbeeld linksom in plaats van rechtsom), dan hoor je na zo'n 25 m *"Verkeerde richting. Draai om."* en daarna *"Goede richting."* als je goed loopt.
   - Bij meer dan ~20 m afwijking hoor je *"Let op. Je wijkt 35 meter af van de route."* Zolang je te ver weg zit, wordt dat elke 15 seconden herhaald. Ben je terug, dan hoor je *"Terug op de route."* Na elke kilometer hoor je hoeveel je nog moet.
7. **Stop** beëindigt de live modus. Heb je het rondje (grotendeels) afgemaakt, dan staat het in **Mijn rondjes** (klok-icoon) als *Gelopen ✓*.

### Tips voor onderweg
- **Zet de stille modus uit** (schakelaar aan de zijkant van je iPhone) en het volume omhoog. Anders hoor je de gesproken waarschuwingen niet.
- Hou de app **op de voorgrond**. Als het scherm op slot gaat of je naar een andere app wisselt, pauzeert iOS de GPS en de spraak.
- Kan de app het scherm niet aan houden, dan zie je een gele melding. Zet dan tijdelijk *Instellingen → Beeldscherm en helderheid → Automatische vergrendeling* op **Nooit**. Het scherm aan houden in een app op het beginscherm werkt vanaf iOS 18.4.
- Voor fel zonlicht: tik op het **half-gevulde cirkel-icoon** om te wisselen tussen automatisch, licht en donker. Licht heeft het meeste contrast in de zon.

---

## Instellingen

In `config.js`:
- `ORS_API_KEY`: je sleutel.
- `OFF_ROUTE_METERS`: bij hoeveel meter afwijking je een waarschuwing krijgt (standaard 20). GPS op een telefoon is vaak 5–15 m nauwkeurig. Ga daarom niet veel lager dan 15.

## Lokaal testen

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
Locatie werkt op `localhost` ook zonder HTTPS. Op je iPhone werkt het alleen via HTTPS (GitHub Pages).

## Privacy & bronnen
- Alles blijft op je telefoon (`localStorage`). Alleen je startpunt gaat naar OpenRouteService om de route te berekenen.
- Kaart © [OpenStreetMap](https://www.openstreetmap.org/copyright)-bijdragers. Routes via [openrouteservice](https://openrouteservice.org).
- De app slaat alleen kaarttegels langs je eigen route op (max. ~700 per route, 2 tegelijk), in lijn met het [OSM-tegelbeleid](https://operations.osmfoundation.org/policies/tiles/) voor licht persoonlijk gebruik.
