# Flag Map Quiz

See a flag, click that country on the world map. 197 countries: the 193 UN members plus Vatican City, Palestine, Kosovo and Taiwan.

Play: https://victoritoto.github.io/flag-map-quiz/

Static site, no build step. Run locally with `python -m http.server` in this folder.

## Data
- Map: [world-atlas](https://github.com/topojson/world-atlas) 2.0.2, Natural Earth 1:50m (public domain). Tuvalu and a few small territories (Gibraltar, Akrotiri, Dhekelia, US Minor Outlying Islands, Coral Sea Islands, Clipperton) are missing at 50m, so they come from the 1:10m file (`data/extra-10m.json`).
- Flags: the current flag shown on each country's English Wikipedia "Flag of …" page (files from Wikimedia Commons, mostly public domain), checked in November 2026 and bundled in `flags/` at their real proportions. Afghanistan uses the Islamic Republic tricolour (`Flag of the Islamic Republic of Afghanistan.svg`), as at the UN. Bolivia uses its state flag with the coat of arms. The list of source files is in `data/flag-sources.json`.
- [D3](https://d3js.org) 7.9.0 and topojson-client 3.1.0, ISC licence.

## Special cases
- Every map shape belongs to one of the 197 countries. Dependent territories count as their sovereign country (from Natural Earth's SOVEREIGNT field), listed in `data/territories.json`: e.g. Greenland → Denmark, Puerto Rico → USA, French Polynesia → France. Overrides: Western Sahara → Morocco, Northern Cyprus → Cyprus, Somaliland → Somalia, Siachen Glacier → India.
- Kosovo has no ISO code in Natural Earth and is matched by name as its own country.
- Pacific islands wholly between 169°W and 125°W (south of 30°N) are drawn past the right edge of the map so Oceania stays together.
- Antarctica is left out.
