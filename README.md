# Koordinatkart – E/N ↔ WGS84

En statisk nettside som kan publiseres direkte med GitHub Pages.

## Funksjoner

- Konverterer UTM Easting/Northing (E/N) til WGS84 bredde-/lengdegrad.
- Viser WGS84-posisjon som UTM E/N med automatisk sonevalg.
- Bruker telefonens/nettleserens GPS-posisjon.
- Klikk i kartet for å hente begge koordinatformatene.
- Kartlag:
  - OpenTopoMap terrengkart
  - Esri World Imagery satellittbilder
  - OpenStreetMap detaljkart
- Mobilvennlig og uten backend.

## Publiser på GitHub Pages

1. Opprett et nytt GitHub-repository, for eksempel `koordinatkart`.
2. Last opp `index.html`, `style.css` og `app.js` til roten av repoet.
3. Åpne **Settings → Pages**.
4. Under **Build and deployment**, velg **Deploy from a branch**.
5. Velg branch `main` og mappe `/ (root)`, og lagre.
6. GitHub viser adressen til nettsiden når Pages er aktivert.

GitHub Pages bruker HTTPS, som er nødvendig for at nettleseren skal gi nettsiden tilgang til telefonens GPS.

## Koordinatsystem

Nettsiden bruker WGS84 / UTM (EPSG:326xx i nordlig halvkule og EPSG:327xx i sørlig halvkule). For norske feltkoordinater må riktig UTM-sone velges når du legger inn E/N manuelt.

## Eksterne biblioteker og kart

- Leaflet 1.9.4
- Proj4js 2.21.0
- OpenTopoMap
- OpenStreetMap
- Esri World Imagery

Kartlagene lastes over internett. Selve koordinatkonverteringen skjer lokalt i nettleseren.
