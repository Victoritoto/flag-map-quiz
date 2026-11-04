# Flag Map Quiz

See a flag, click that country on the world map. 197 countries: the 193 UN members plus Vatican City, Palestine, Kosovo and Taiwan.

Play: https://victoritoto.github.io/flag-map-quiz/

Static site, no build step. Run locally with `python -m http.server` in this folder.

## Data
- Map: [world-atlas](https://github.com/topojson/world-atlas) 2.0.2, Natural Earth 1:50m (public domain). Tuvalu is missing at 50m, so it comes from the 1:10m file (`data/extra-10m.json`).
- Flags: the current flag shown on each country's English Wikipedia "Flag of …" page (files from Wikimedia Commons, mostly public domain), checked in November 2026 and bundled in `flags/` at their real proportions. Afghanistan uses the Islamic Republic tricolour (`Flag of the Islamic Republic of Afghanistan.svg`), as at the UN. The list of source files is in `data/flag-sources.json`.
- [D3](https://d3js.org) 7.9.0 and topojson-client 3.1.0, ISC licence.

## Special cases
- Kosovo, Northern Cyprus and Somaliland have no ISO code in Natural Earth and are matched by name: Kosovo is its own country, Northern Cyprus counts as Cyprus, Somaliland counts as Somalia.
- Western Sahara, Greenland, Puerto Rico and other territories are drawn in grey and are not quiz answers.
- Antarctica is left out.
