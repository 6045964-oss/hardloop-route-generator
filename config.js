/*
 * Hardloop Route Generator — configuratie
 * ----------------------------------------
 * Plak hieronder je gratis OpenRouteService API-sleutel tussen de aanhalingstekens.
 *
 * Zo maak je een sleutel aan (duurt ± 2 minuten):
 *   1. Ga naar https://openrouteservice.org/dev/#/signup en maak een gratis account.
 *   2. Bevestig je e-mailadres via de mail die je krijgt en log in.
 *   3. Open je Dashboard, kies bij "Request a token" het type "Standard",
 *      geef het een naam (bijv. "hardlopen") en klik op "CREATE TOKEN".
 *   4. Kopieer de lange sleutel die verschijnt en plak hem hieronder.
 *
 * Let op: op GitHub Pages is dit bestand openbaar. Wil je de sleutel liever niet
 * publiceren? Laat hem hier leeg en plak hem in de app via het sleutel-icoon
 * rechtsboven. Dan wordt hij alleen op je iPhone bewaard.
 */
window.HRG_CONFIG = {
  ORS_API_KEY: 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjQwMjg1ZTUwOGQ5YzRiY2I5NWNiY2I4MDY0OGIzMjNmIiwiaCI6Im11cm11cjY0In0=',

  // Vanaf hoeveel meter afstand tot de route je een gesproken waarschuwing krijgt.
  OFF_ROUTE_METERS: 20,
};
