# Design log — Hardloop Route Generator

## Sessie 1 — 2026-09-23: eerste versie

### Uitgangspunten (met de gebruiker afgestemd)
- **Doelgroep:** één hardloper, iPhone, buiten, vaak in fel zonlicht, met bezwete vingers.
- **Sfeer:** "Sportief signaal": verkeersbord- en hardloopschoen-esthetiek, veel contrast.
- **Toon:** kort en zakelijk ("Je wijkt 35 meter af van de route." / "Terug op de route.").

### Beslissingen
| Beslissing | Waarom |
|---|---|
| Kleuren overgenomen uit de bestaande iconen: inkt `#0E0F11`, limoen `#C6FF3D`, oranje `#FF5C35` | Icoon en app vormen één geheel. Limoen = actie, oranje = route, blauw `#2F6BFF` = jij |
| Lichte modus als standaard, met handmatige schakelaar (auto/licht/donker) | Licht papier + zwarte inkt leest het best in de zon. Een schakelaar omdat de automatische stand 's avonds donker kiest, ook als je dan net buiten loopt |
| Donkere modus: kaarttegels via CSS-filter omgekeerd | Geen tweede tegelbron of API-sleutel nodig. De route-overlay valt buiten het filter en blijft oranje |
| Barlow Condensed (koppen/cijfers) + Barlow (tekst) | Smalle, sportieve cijfers zoals op een startnummer. Grote getallen passen op een smal scherm. `tabular-nums` houdt tellers stil |
| Knoppen ≥ 60–72 px hoog, 3 px rand, "harde" schaduw die bij indrukken inzakt | Makkelijk te raken tijdens het lopen, voelbare feedback zonder trillen (de Vibration API werkt niet op iOS) |
| Kaart over het hele scherm met een bottom sheet; vanaf 768 px een zijpaneel | De kaart is de hoofdzaak. `focusOn()`/`fitPadding()` houden rekening met sheet en topbar, zodat de route in het zichtbare deel valt |
| Live-HUD: status + 4 stats; bij afwijking wordt alles oranje en knippert het, plus een stippellijn naar het dichtstbijzijnde routepunt | Je kunt het in één blik zien, ook zonder geluid |
| Afwijkingsdetectie met hysterese (waarschuwen > 20 m, "terug" ≤ 14 m), 2 opeenvolgende fixes nodig, fixes met nauwkeurigheid > 35 m negeren | Voorkomt valse alarmen door GPS-ruis |
| Voortgang langs de route zoeken in een venster rond de laatste positie | Begin en eind van een rondje liggen op dezelfde plek; zo haalt de app die niet door elkaar |
| Tegels vooraf cachen op z13–17 in een corridor langs de route (max. 700, 2 tegelijk) | Offline bruikbaar, maar vriendelijk voor de OSM-servers |
| API-sleutel via `config.js` óf in de app (localStorage) | Op GitHub Pages is `config.js` openbaar. Zo kan de sleutel ook privé blijven |

### Toegepaste technieken
CSS custom properties met themaselectors (`prefers-color-scheme` + `data-theme`), container queries (stats 2→4 kolommen, `cqi`-fonts), `clamp()`, `svh`, safe-area insets, `<dialog>`, IntersectionObserver voor scroll-animaties in de geschiedenis, SVG `stroke-dashoffset`-animatie om de route te "tekenen", `prefers-reduced-motion`, Screen Wake Lock met terugvaloptie, SpeechSynthesis ontgrendeld binnen een tik (iOS), service worker met cache-first voor tegels en stale-while-revalidate voor de app.

### Wat werkte goed
- Met een test-stub (nep-GPS + nep-ORS) in headless Chrome kun je de hele flow testen zonder API-sleutel: afwijking, "terug op route", km-meldingen en "rondje voltooid" komen allemaal correct door.
- De kleurcodering (oranje = route/alarm, limoen = actie/goed) is meteen duidelijk.

### Wat kon beter / gevonden tijdens het testen
- `display: grid` op `.plan` overschreef het `hidden`-attribuut → planscherm bleef zichtbaar in de live modus. **Les:** zet altijd een `[hidden] { display: none }` bij componenten met een eigen `display`.
- Een entree-animatie met `fill-mode: both` overschreef de `opacity: 0` in de live modus. **Les:** verberg met `visibility` of zonder animatie-eigenschappen.
- Een geanimeerde `box-shadow`/`background` in een scroll-container gaf een bleke rechthoek → vervangen door een overlay met `::after`, `opacity` en `overflow: hidden`.
- "5 kilometer. Nog 0,0 kilometer." klonk vlak voor de finish → km-melding onderdrukt als er < 300 m over is.

### Ideeën voor later
- Tempo per km uitspreken (min/km) en tonen.
- Hoogteprofiel (ORS `elevation: true`) en een voorkeur voor parken/onverharde paden.
- Meerdere seeds tegelijk opvragen en de route kiezen die het dichtst bij de gevraagde afstand ligt (kost meer API-quota).
- De gelopen GPS-track opslaan en als tweede lijn tonen.
- Echte test op een iPhone: wake lock in een standalone PWA, spraak bij de stille-modusschakelaar, gedrag van de GPS op de achtergrond.

## Sessie 2 — 2026-09-23: preciezere afstand, nooit dubbel lopen, navigatie

### Aanleiding (feedback na een testloop)
- Rondje was 8,05 km bij 6,5 km gevraagd (+24%).
- De route liep een doodlopend stuk in en weer terug. Dat was verwarrend en voelde als verdwalen.

### Afspraken met de gebruiker
- Afstand maximaal ±0,25 km. Lukt dat niet, dan het beste rondje tonen met een melding.
- Nooit dubbel lopen, behalve ≤ 150 m rond de start/finish.
- Navigatie: gesproken afslagen en een duidelijkere kaart.

### Beslissingen
| Beslissing | Waarom |
|---|---|
| Tot 8 ORS-aanvragen per klik. De gevraagde lengte wordt telkens gedeeld door de gemeten verhouding werkelijk/gevraagd; die verhouding wordt ook onthouden (`hrg.lengthRatio`) | ORS `round_trip.length` is een richtwaarde. Met een correctie komt het rondje in 2–3 pogingen binnen de marge |
| Zelfde seed houden bij bijstellen van de lengte (max. 3×), nieuwe seed bij dubbel lopen | De vorm blijft dan ongeveer gelijk, zodat de correctie klopt. Bij een slechte vorm helpt alleen een andere richting |
| Dubbel lopen meten door de route elke 10 m te bemonsteren en punten ≤ 12 m van elkaar te zoeken die ver uit elkaar liggen langs de route en (anti)parallel lopen | Kruisingen (loodrecht) tellen niet mee, heen-en-terug en "andere stoep terug" wel. O(n²), maar < 50 ms voor 42 km |
| Zoekvolgorde: eerst "niet dubbel", dan afstand | Dubbel lopen was voor de gebruiker het grootste probleem |
| ORS `instructions: true`, `language: nl`. Stappen compact opgeslagen (type, straat, index, afslagnummer) | Oude routes zonder stappen tonen "Volg de oranje lijn" |
| Afslagkaart in limoen bovenaan de HUD, met een draaiende pijl, of een rotonde-ring met het afslagnummer | In één blik te lezen. Het eerste rotonde-icoon leek op ♂ en is vervangen |
| Gelopen stuk grijs, komende 400 m met bewegende stippen (`stroke-dashoffset`-animatie) | De looprichting zie je zonder te lezen. Tijdens het plannen lopen de stippen over de hele route |
| Km-melding overslaan als er binnen 100 m een afslag komt | Afslagen gaan voor, anders praat de app door elkaar |
| Stats in 4 smalle kolommen | Ruimte voor de afslagkaart zonder te scrollen |

### Wat werkte goed
- Een realistische nep-ORS (lengte ×1,12–1,32 per seed, soms een doodlopend stuk) maakte de zoeklogica goed testbaar: het doodlopende stuk werd afgewezen en het rondje kwam in 3 aanvragen exact op 6,50 km.

### Wat kon beter
- Het eerste rotonde-icoon was dubbelzinnig. **Les:** test iconen op kleine grootte en vraag je af waar ze nog meer op lijken.
- "Over 70 meter" klinkt minder rond dan "Over 50 meter". Eventueel later vaste afstanden gebruiken.
- Nog niet getest met de echte ORS-API en een echte iPhone.

### Ideeën voor later
- Instelbare marge (bijv. ±0,1 / ±0,25 / ±0,5 km).
- Voorkeur voor parken en onverharde paden (ORS `options.profile_params` / `avoid_features`).

## Sessie 3 — 2026-09-23: controle en verbeteringen

### Gevonden en opgelost
- **Bug: de verkeerde kant op starten gaf een vals "Rondje voltooid".** Als je vanaf de start de verkeerde kant op liep, zat je op het laatste stuk van de lus. De app nam dat meteen over als voortgang ("Te gaan 0,0", alle afslagen overgeslagen) en markeerde het rondje na 0,57 km als gelopen. Met een test in de stub nagebootst en bevestigd.
  - Oplossing: invoegen op een ander deel van de route telt pas na 3 fixes vooruit, nooit bij de verkeerde looprichting, en nooit als je daarmee meer dan de helft van het rondje zou overslaan. "Rondje voltooid" vereist daarnaast ≥ 60% van de afstand gelopen.
- **Nieuw: waarschuwing bij de verkeerde looprichting.** Je beweging over ≥ 12 m wordt vergeleken met de richting van het routestuk; na 2 keer tegengesteld hoor je "Verkeerde richting. Draai om.", daarna elke 15 s opnieuw, en "Goede richting." zodra het klopt. Van de route af gaat voor. Er zijn geen valse meldingen bij een omweg naast de route (getest).
- **Spraak op iPhone robuuster:** Safari slikt soms een `speak()` direct na `cancel()` (nu 120 ms vertraging), blijft soms "gepauzeerd" na de achtergrond (`resume()`), en ruimt uitingen soms te vroeg op (referenties worden nu vastgehouden). De eerste uiting blijft synchroon binnen de tik, zodat iOS spraak toestaat.
- **Updates:** bij een nieuwe service worker laadt de app automatisch opnieuw, behalve tijdens het lopen, zoeken of met een route in beeld (dan komt er een melding met "Laden").
- De afslag-aankondiging begint op 55 m, zodat je "Over 50 meter" hoort in plaats van "Over 70 meter".
- De afslagkaart is geen live-regio meer: die veranderde elke seconde en was voor een schermlezer alleen ruis. De spraak meldt afslagen al.

### Les
- Een lus heeft een naad: begin en eind liggen op dezelfde plek. Test voortgangslogica daarom altijd ook met "de verkeerde kant op starten" en "terug naar de start lopen".

## Sessie 4 — 2026-10-22: volledige herbouw naar een eenvoudigere, preciezer gespecificeerde basis

### Aanleiding
De gebruiker gaf een zeer gedetailleerde, exacte spec (endpoints, retry-aantallen,
tolerantie, bestandsnamen `manifest.webmanifest`/`sw.js`) voor herbouw "in deze
lege map" — zonder zich bewust te zijn dat sessies 1–3 hier al een uitgebreidere,
veldgeteste versie hadden neergezet (afslagnavigatie, dubbel-lopen-detectie,
verkeerde-richting-waarschuwing, iOS-spraakfixes). Ik heb dit expliciet gemeld en
om een keuze gevraagd; de gebruiker heeft die vraag afgewezen en wilde direct
doorbouwen volgens de nieuwe spec, met de API-sleutel erbij. Conclusie: de nieuwe,
simpelere spec is leidend; de oudere navigatiefuncties zijn (bewust) niet
meegenomen in deze versie.

### Beslissingen
| Beslissing | Waarom |
|---|---|
| Volledige herbouw van `index.html`, `style.css`, `app.js`, `config.js`; nieuwe bestanden `manifest.webmanifest` en `sw.js`; oude `manifest.json`/`service-worker.js` verwijderd | Exact volgens de nieuwe spec van de gebruiker, geen dubbele/verouderde PWA-registratiebestanden |
| ORS-eindpunt `api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson` i.p.v. `api.openrouteservice.org/...` | Gebruiker gaf aan dat het oude adres begin november wordt uitgeschakeld (volg-up-bericht tijdens de bouw) |
| Iconen (oranje lus op donkere achtergrond) uit sessie 1 hergebruikt, niet opnieuw gegenereerd | Voldeden al precies aan de nieuwe spec-eis, geen reden tot wijzigen |
| Zelfde kleur-/font-systeem als de Claude-artifact-preview die eerder is gedeeld (Space Grotesk + Manrope, oranje/limoen op antraciet, donker standaard met `prefers-color-scheme: light`) | Consistente merkidentiteit tussen preview en uitgeleverde app |
| Afwijkingsdetectie met hysterese (waarschuwen > 25 m, "op koers" < 15 m) + max. 1 gesproken waarschuwing per 30 s, ook herhaald zolang je van de route af blijft | Letterlijk uit de nieuwe spec; eenvoudiger dan sessie 3's richtingsdetectie, maar voorkomt wel flikkeren |
| Lengte-correctielus: zelfde seed, lengte evenredig bijgesteld, max. 3 pogingen totaal | Letterlijk uit de nieuwe spec (15% tolerantie, max. 2 keer opnieuw) |

### Zelfcontrole uitgevoerd
- Alle `id`'s die `app.js` opvraagt, komen voor in `index.html` (met een script
  gecontroleerd, geen missers).
- lon/lat-volgorde: expliciet omgedraaid op beide plekken waar dat nodig is
  (request naar ORS: `[lng, lat]`; GeoJSON-respons naar Leaflet: `[lat, lng]`),
  met een waarschuwende code-comment op beide plekken.
- Punt-tot-segment-berekening: vectorprojectie met `t` geklemd op `[0,1]`,
  in lokale platte meters t.o.v. de breedtegraad van de live positie — standaard,
  correcte implementatie voor de korte afstanden van een hardlooproute.
- Leaflet 1.9.4 SRI-hashes voor `leaflet.js`/`leaflet.css` gedownload en met
  `openssl dgst -sha256` geverifieerd tegen de hashes in `index.html` — kloppen
  exact.
- `node --check` op `app.js` en `sw.js`, `manifest.webmanifest` als JSON geparsed.
- Geen live test met de echte API-sleutel of op een echte iPhone uitgevoerd
  (geen headless-GPS/ORS-stub zoals in sessie 1–2 gebouwd voor deze simpelere
  versie).

### Ideeën voor later
- De in sessie 2–3 gebouwde navigatie- en dubbel-lopen-logica alsnog toevoegen
  aan deze basis, als de gebruiker daar later om vraagt.
- Een test-stub (nep-GPS + nep-ORS) zoals in sessie 1, zodat de live-volglogica
  zonder een echte loop buiten te testen is.

## Sessie 5 — 2026-10-22: v1.2.0 teruggezet (nu v1.2.1), nieuw API-adres

### Wat er is gebeurd
- De versie van vóór sessie 4 (afslagnavigatie, "niet dubbel", verkeerde-richting-waarschuwing,
  iOS-spraakfixes, offline kaarttegels) is teruggezet uit de Claude Code-herstelpunten
  (`~/.claude/file-history`). `app.js`, `index.html`, `style.css`, `config.js` en `README.md`
  komen uit de toestand vlak vóór de herbouw van vandaag. Van `service-worker.js` en
  `manifest.json` was alleen de versie van 23 september (v1.1.0) bewaard; die is gebruikt en
  gecontroleerd op aansluiting bij `app.js`.
- `sw.js` en `manifest.webmanifest` van sessie 4 zijn verwijderd: er is weer één service worker
  (`service-worker.js`) en één manifest (`manifest.json`).
- API-adres: `api.heigit.org/openrouteservice/v2/` (het oude adres stopt begin november), ook in de
  "nooit cachen"-regel van de service worker. API-sleutel uit sessie 4 behouden.
- Versie `v1.2.1`, zodat telefoons met een oudere versie de nieuwe zeker ophalen.

### Getest (headless Chrome via DevTools-protocol, nep-GPS in Utrecht)
- Service worker installeert en neemt de pagina over (`skipWaiting` + `clients.claim`).
- Nieuwe versie zonder route in beeld → app herlaadt vanzelf; mét route in beeld → melding
  "Nieuwe versie" met knop *Laden*, geen herlaad.
- Route van 5 km gegenereerd via het nieuwe adres (5,07 km, 54 afslagen, 0 m dubbel), kaarttegels
  langs de route in `hrg-tiles-v1` opgeslagen. Geen consolefouten.

### Les
- `app.js` negeert een `controllerchange` in dezelfde sessie als de allereerste installatie
  (`hadController` wordt bij het opstarten vastgelegd). Bij testen eerst één keer normaal herladen,
  en niet met "cache negeren": een harde verversing omzeilt de service worker.

## Sessie 6 — 2026-10-22: kaart op iPhone, nauwkeuriger lange routes (v1.2.2)

### Lege kaart op iPhone — oorzaak
- Niet de tegels zelf: in echte WebKit (Playwright, iPhone 13-emulatie) kwamen tegels via de
  service worker gewoon binnen (200, echte 256×256-beelden). Ook niet het donkere filter: in lichte
  modus (`filter: none`) was de kaart net zo leeg.
- Wél een race: de scripts staan op `defer`, en WebKit voerde `app.js` soms uit vóórdat `style.css`
  was toegepast (vooral als de service worker alles direct uit de cache levert). Leaflet ziet dan
  `position: static` op `#map`, zet inline `position: relative`, en die inline stijl wint van
  `.map { position: absolute; inset: 0 }` → kaart 0 px hoog. Desktop-Chrome wacht wel op de
  stylesheet, daarom werkte het daar.

### Aanpassingen
| Wijziging | Waarom |
|---|---|
| `.map { position: absolute !important }` | Inline stijl van Leaflet kan de kaart nooit meer 0 px maken |
| `ResizeObserver` → `map.invalidateSize()` | Leaflet meet opnieuw zodra de container echt een maat krijgt |
| Tegelbewaking (`tileload`/`tileerror`): geen tegel na 12 s of ≥ 8 mislukte op rij → melding "Kaart laadt niet" met *Opnieuw* (offline: korte info) | Nooit meer stil een lege kaart |
| Service worker geeft bij een mislukte tegel `Response.error()` i.p.v. een transparante PNG | De transparante tegel verborg fouten; nu ziet de app ze |
| Lengte: tolerantie `max(250 m, 3%)`; correctiemodel per afstand (recente metingen, gewogen naar vergelijkbare lengte, getrimd gemiddelde rond de mediaan); binnen dezelfde vorm secant-bijstelling; 12 pogingen vanaf 10 km | Eén globale verhouding (geleerd bij 5 km) paste niet bij 15–21 km, en ORS is per vorm erg grillig |
| Melding "Na N pogingen" telt nu alle pogingen | Toonde het nummer van de beste poging |

### Getest
- WebKit, iPhone 13, donker + licht, 6× laden met actieve service worker: altijd 664 px hoog met
  echte tegels, ook als de race optrad; ook na route genereren. Tegelserver geblokkeerd → melding,
  *Opnieuw* herstelt. Bestaande Chrome-test (SW, update-melding, route, tiles) slaagt.
- Echte ORS, Utrecht centrum en Amersfoort, 5/10/15/21 km: vanaf 10 km max. 3,1% afwijking
  (eerst 9,3%), max. 20 m dubbel. Simulatie "ORS +25% lang, veel dubbele vormen": oud 3 van 9
  lange routes > 5%, nieuw 1 van 18.

### Wat kon beter / open
- Het donkere kaartfilter kon ik niet visueel controleren: headless WebKit tekent geen filters op
  gecomposite lagen (ook niet in een minimale testpagina). Op de iPhone zelf nakijken.
- `hadController` in `app.js` negeert updates in dezelfde sessie als de eerste installatie (bekend
  sinds sessie 5, bewust ongemoeid gelaten).

## Sessie 7 — 2026-10-22: Voorkeuren en paneel (v1.3.0)

### ORS eerst getest (documentatie + echte verzoeken, foot-walking)
- `profile_params.weightings.green/quiet`: object-vorm geeft 400; integer-vorm wordt geaccepteerd
  maar levert exact dezelfde round trip op. extra_info `green` en `noise` hebben in Nederland geen
  data (overal 10 resp. 7). → Platteland en drukke wegen worden **achteraf gescoord** met
  extra_info `waytype`/`waycategory`/`surface`.
- `extra_info` en `elevation` werken met round_trip én met waypoints, in hetzelfde verzoek.
- `bearings` bij round_trip zet de beginkoers; het middelpunt van het rondje ligt ~35° rechtsom.
- Round trip kan niet via een punt → eigen strategie met waypoints.

### Beslissingen
| Beslissing | Waarom |
|---|---|
| Basis met `registerFeature()`, haken (hooks) en events; elke functie in een eigen blok met vaste ankerplekken in app.js, style.css en de test | Elke functie apart terug te draaien. Gecontroleerd: per functie `git revert` zonder conflict, daarna slaagt de rest van de suite |
| Gedeelde testhulpmiddelen in een eigen commit | Stonden eerst in de commits van functie 1 en 4, waardoor die niet los terug konden |
| Kiezen in volgorde: binnen 5% → niet dubbel → harde eisen (via, richting, max. stijgen) → gewogen voorkeuren (drukke wegen 8, ondergrond 4, platteland 2, bochten 1) | Prioriteit van de gebruiker; gewogen i.p.v. strikt lexicografisch, zodat 1 m minder drukke weg niet alles wint |
| Max. 8 verzoeken per keer (ook ≥ 10 km; was 12) + glijdend minuutvenster (36/60 s) in localStorage | Gratis plan; herladen of tweede tabblad telt mee |
| Richting via `bearings` | Gemeten tegen tussenpunten op een cirkel: lengte ±6% vs ±10%, niet dubbel 11/16 vs 2/16; filteren kost te veel verzoeken |
| Via-punt: lus (cirkel, of smalle ellips) door start en via, tussenpunten op beide bogen, `continue_straight` | Heen en terug over andere wegen; ellips maakt kortere rondjes mogelijk (minimum ±2,9× de afstand tot het punt) |
| Ondergrond: onbekend (in NL ~60%) afleiden uit wegtype (straat/weg/fietspad/stoep = verhard, landweg = onverhard) | Anders is "verhard" vrijwel nooit te halen |
| Paneel: drie standen, alleen < 768 px; inpassen van de route alleen bij "ingeklapt", na een lopende zoomanimatie, 200 ms na een resize | Bij "half" blijft te weinig kaart over; Leaflet negeert zoom tijdens animatie; Safari schuift de adresbalk in stapjes |

### Getest
`tests/e2e.mjs` (WebKit, iPhone-emulatie), nep-ORS: alle controles groen; per functie ook met de
echte ORS (Utrecht en Alphen aan den Rijn). Gevonden en opgelost onderweg: paneelinhoud niet
scrollbaar (grid groeide buiten de max-hoogte), een tik op het greepje die na een snelle veeg werd
genegeerd, en route niet opnieuw ingepast na het verdwijnen van de adresbalk.

### Wat kon beter / open
- Via-routes lopen vaker een stukje dubbel (~50% van de kandidaten schoon) en zijn minder precies
  in lengte dan gewone rondjes.
- Platteland is in NL een benadering (paden/landwegen/onverhard), geen echte groendata.
- Hoogte in vlak NL: ~20 m "stijgen" per 5 km is ruis van het hoogtemodel, dijken en bruggen.
- "Adresbalk onderin" is benaderd met een lagere viewport; echte Safari-chrome is niet te emuleren.

### Technieken
CustomEvents tussen losse blokken, `inert` op verborgen paneelinhoud, pointer capture met
snelheid-snapping, `role="switch"`-checkboxes en radiogroepen, Ramanujan-ellipsomtrek met
bisectie, Playwright-route-onderschepping als nep-ORS.
