(() => {
'use strict';

const REGIONS = ['Africa', 'Americas', 'Asia', 'Europe', 'Oceania'];
// Rough lon/lat boxes used to frame the map on the chosen region(s).
const REGION_BOX = {
  Africa:   [[-26, -36], [58, 38]],
  Americas: [[-168, -56], [-30, 72]],
  Asia:     [[25, -11], [150, 56]],
  Europe:   [[-25, 34], [45, 71]],
  Oceania:  [[110, -48], [205, 20]],  // past 180° so it reaches Kiritimati (drawn right of the edge)
};
// Natural Earth shapes without an ISO id that belong to a quiz country.
const NAME_TO_CODE = { 'Kosovo': 'xk', 'N. Cyprus': 'cy', 'Somaliland': 'so' };
const TERRITORY_NAMES = { 'W. Sahara': 'Western Sahara', 'Siachen Glacier': 'Siachen Glacier (disputed)' };
const ANTARCTICA = '010';
// The map is centred on 11°E, so its wrap-around edge runs down 169°W, through the Bering Strait.
// That keeps Alaska and Russia whole, but would leave the Pacific islands east of 169°W on the far left.
// So the split line bends: island polygons lying wholly in this box are drawn past the RIGHT edge instead,
// continuing the same projection smoothly beyond 180° (Kiribati's Line Islands incl. Kiritimati, Cook Islands,
// Niue, French Polynesia, Pitcairn, Hawaii). They still belong to their own country's shape.
const ROTATION = -11;
const PAST_EDGE = { west: -169, east: -125, maxLat: 30 };
// Manual ring positions, [longitude, latitude]. A country listed here gets its single ring centred
// exactly on this point instead of a computed one; the ring is sized to the island under the point.
// Longitudes above 180 are past the right edge.
const RING_POSITION = {
  ki: [202.5, 1.9],  // Kiribati: Kiritimati (Christmas Island), 1.9°N 157.5°W, i.e. -157.5 + 360
};
const MAX_K = 400;           // max zoom factor
const TINY_PX = 12;          // show a ring when a small country is smaller than this on screen
const SMALL_SR = 30000 / 40.6e6; // only countries under ~30,000 km² (in steradians) get rings
const CORRECT_DELAY = 1150;  // ms the name stays up after a right answer
const FIXED_DELAY = 1350;    // ms after finally clicking the right one
const WRONG_FLASH = 1100;    // ms a wrongly clicked country stays red

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const svg = d3.select('#map');
const wrap = $('mapWrap');
const labelsEl = $('labels');
const flagImg = $('flag');
const nameEl = $('name');
const promptEl = $('prompt');
const attemptEl = $('attempt');
const counterEl = $('counter');
const modal = $('modal');
const modalBody = $('modalBody');

// ---------- data ----------
let countries = [];        // [{code,num,name,region}]
const byCode = new Map();
let features = [];         // [{feature, code|null, name}]
const geo = new Map();     // code -> {paths:[], cores:[], rings:[], area}

// ---------- map state ----------
const zoomLayer = svg.append('g');
const landG = zoomLayer.append('g').attr('class', 'land');
const ringsG = zoomLayer.append('g').attr('class', 'rings');
let projection, path, W = 0, H = 0, homeT = d3.zoomIdentity, curT = d3.zoomIdentity;
let labels = [];           // [{el, x, y}] in projected (unzoomed) coords
let allRings = [];         // every ring of every country, for overlap checks and hit testing
let isTouch = matchMedia('(pointer: coarse)').matches;
const zoom = d3.zoom().scaleExtent([0.7, MAX_K]).on('zoom', ev => {
  curT = ev.transform;
  zoomLayer.attr('transform', curT);
  updateRings();
  placeLabels();
});

// ---------- game state ----------
const S = {
  regions: new Set(REGIONS), pool: [], queue: [], idx: 0,
  current: null, attempts: 0, locked: true,
  // firstTry: right on the first click; tries: code -> clicks needed when it took more than one
  firstTry: new Set(), tries: new Map(), answered: new Set(), wrongClicks: 0,
  started: 0, timer: null, flashTimer: null,
};

// ---------- utils ----------
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const FLAG_VERSION = 4;  // bump when flag files change so browsers don't show cached old flags
const flagSrc = c => `flags/${c}.svg?v=${FLAG_VERSION}`;
const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function polygonsOf(f) {
  const g = f.geometry;
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

// ---------- map space: the normal projection, plus the islands drawn past the right edge ----------
const inPastBox = ([lon, lat]) => lon >= PAST_EDGE.west && lon <= PAST_EDGE.east && lat < PAST_EDGE.maxLat;
const isPastEdge = poly => poly[0].every(inPastBox);
// Same Natural Earth formula and scale as `projection`, but with the longitude unwrapped past 180°
// and no antimeridian clipping, so these islands sit to the right of the 180° line.
function projectPast([lon, lat]) {
  const rad = Math.PI / 180;
  const [x, y] = d3.geoNaturalEarth1Raw(((lon < 0 ? lon + 360 : lon) + ROTATION) * rad, lat * rad);
  const k = projection.scale(), [tx, ty] = projection.translate();
  return [tx + k * x, ty - k * y];
}
const pastPath = d3.geoPath(d3.geoTransform({ point(lon, lat) { this.stream.point(...projectPast([lon, lat])); } }));
// Splits a feature's polygons into the part drawn normally and the part drawn past the right edge.
function splitPast(feature) {
  const main = [], past = [];
  for (const poly of polygonsOf(feature)) (isPastEdge(poly) ? past : main).push(poly);
  const mp = c => c.length ? { type: 'MultiPolygon', coordinates: c } : null;
  return { main: mp(main), past: mp(past) };
}
const pathOf = parts => (parts.main ? path(parts.main) : '') + (parts.past ? pastPath(parts.past) : '');
const areaOf = parts => (parts.main ? path.area(parts.main) : 0) + (parts.past ? pastPath.area(parts.past) : 0);
function boundsOf(parts) {
  const bs = [parts.main && path.bounds(parts.main), parts.past && pastPath.bounds(parts.past)].filter(Boolean);
  return [[d3.min(bs, b => b[0][0]), d3.min(bs, b => b[0][1])], [d3.max(bs, b => b[1][0]), d3.max(bs, b => b[1][1])]];
}
// Any [lon, lat] to map pixels: past the right edge for points in PAST_EDGE's box or with lon > 180.
const projectPoint = ll => (ll[0] > 180 || inPastBox(ll)) ? projectPast(ll) : projection(ll);

// Where a country's ring goes: its largest polygon plus everything within ~650 km, so far-flung
// islands (e.g. US Aleutians) don't pull the ring away. With an anchor (RING_POSITION), it is just the
// one island nearest that point, e.g. Kiribati's Kiritimati.
function coreOf(fs, anchor) {
  const polys = fs.flatMap(polygonsOf).map(c => {
    const p = { type: 'Polygon', coordinates: c };
    return { p, area: d3.geoArea(p), c: d3.geoCentroid(p) };
  });
  const near = anchor
    ? [polys[d3.minIndex(polys, q => d3.geoDistance(q.c, anchor))]]
    : (main => polys.filter(q => d3.geoDistance(q.c, main.c) < 0.1))(polys.reduce((m, q) => q.area > m.area ? q : m));
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: near.map(q => q.p.coordinates) } };
}

// ---------- loading ----------
async function load() {
  const [list, topo, extra] = await Promise.all([
    fetch('data/countries.json').then(r => r.json()),
    fetch('data/countries-50m.json').then(r => r.json()),
    fetch('data/extra-10m.json').then(r => r.json()),
  ]);
  countries = list;
  const numToCode = new Map();
  for (const c of list) { byCode.set(c.code, c); numToCode.set(c.num, c.code); }

  const all = topojson.feature(topo, topo.objects.countries).features.concat(extra.features);
  for (const f of all) {
    if (f.id === ANTARCTICA) continue;
    const nm = f.properties.name;
    const code = numToCode.get(f.id) || NAME_TO_CODE[nm] || null;
    features.push({ feature: f, parts: splitPast(f), code, name: code ? byCode.get(code).name : (TERRITORY_NAMES[nm] || nm) });
  }
  for (const c of list) geo.set(c.code, { paths: [], fs: [] });
  for (const f of features) if (f.code) geo.get(f.code).fs.push(f.feature);
  const missing = list.filter(c => !geo.get(c.code).fs.length);
  if (missing.length) console.error('No shape for', missing.map(c => c.name));
  for (const [code, g] of geo) {
    g.cores = [coreOf(g.fs, RING_POSITION[code])].map(core => Object.assign(core, { parts: splitPast(core) }));  // one ring per country
    g.area = d3.sum(g.fs, f => d3.geoArea(f));
  }
  // handy for checking in the console
  window.__quiz = {
    countries, geo, features, S,
    pick: code => pick({ code, name: byCode.get(code).name }, 0, 0),
    view: (lon, lat, k) => { const [x, y] = projectPoint([lon, lat]); svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-x, -y)); },
  };
}

// ---------- map rendering ----------
function render() {
  W = wrap.clientWidth; H = wrap.clientHeight;
  svg.attr('viewBox', null);
  // Fit the whole map, including the islands past the right edge, into the drawing area.
  projection = d3.geoNaturalEarth1().rotate([ROTATION, 0]).scale(1).translate([0, 0]);
  path = d3.geoPath(projection);
  const all = features.map(f => boundsOf(f.parts));
  const [x0, y0, x1, y1] = [d3.min(all, b => b[0][0]), d3.min(all, b => b[0][1]), d3.max(all, b => b[1][0]), d3.max(all, b => b[1][1])];
  const k = Math.min((W - 12) / (x1 - x0), (H - 12) / (y1 - y0));
  projection.scale(k).translate([W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2]);

  for (const g of geo.values()) g.paths = [];
  landG.selectAll('path').remove();
  for (const f of features) {
    const el = landG.append('path').attr('d', pathOf(f.parts)).node();
    el.__f = f;
    if (f.code) geo.get(f.code).paths.push(el);
    else el.classList.add('terr');
  }

  ringsG.selectAll('circle').remove();
  allRings = [];
  for (const [code, g] of geo) {
    g.rings = g.cores.map(core => {
      const b = boundsOf(core.parts);
      // A manual position wins; otherwise the land-weighted centre, which sits on the main islands
      // rather than the middle of an archipelago's box.
      const [x, y] = projectPoint(RING_POSITION[code] || d3.geoCentroid(core));
      const half = Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) / 2;
      const size = Math.sqrt(areaOf(core.parts));
      const el = ringsG.append('circle').attr('cx', x).attr('cy', y).node();
      const ring = { code, el, x, y, half, size, bounds: b, small: g.area < SMALL_SR, visible: false, r: 0 };
      allRings.push(ring);
      return ring;
    });
  }
  applyRegionClasses();
  applyDone();
  homeT = fitTransform(homeBounds(), 0.92, MAX_K, homeCrop());
  zoom.translateExtent([[-W * 0.5, -H * 0.5], [W * 1.5, H * 1.5]]);
  svg.call(zoom).on('dblclick.zoom', null);
  svg.call(zoom.transform, homeT);
}

function homeBounds() {
  if (S.regions.size === REGIONS.length) return [[0, 0], [W, H]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of S.regions) {
    const [[lo0, la0], [lo1, la1]] = REGION_BOX[r];
    for (let i = 0; i <= 20; i++) for (const [lo, la] of [
      [lo0 + (lo1 - lo0) * i / 20, la0], [lo0 + (lo1 - lo0) * i / 20, la1],
      [lo0, la0 + (la1 - la0) * i / 20], [lo1, la0 + (la1 - la0) * i / 20]]) {
      const p = projectPoint([lo, la]);
      if (!p) continue;
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
  }
  return [[x0, y0], [x1, y1]];
}

// Oceania's islands sit at the edges of its box, so never crop it; other regions may overflow sideways a bit.
function homeCrop() {
  return S.regions.size === REGIONS.length || S.regions.has('Oceania') ? 1 : 1.45;
}

function fitTransform([[x0, y0], [x1, y1]], pad = 0.9, maxK = MAX_K, crop = 1) {
  // crop > 1 lets a wide region overflow the sides a little on tall (phone) screens
  const kw = W / Math.max(1, x1 - x0), kh = H / Math.max(1, y1 - y0);
  const k = Math.min(maxK, pad * Math.min(kw * crop, kh));
  return d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
}

// A country's map shapes plus its rings: everything that is coloured together.
const shapesOf = g => [...g.paths, ...g.rings.map(r => r.el)];

function applyRegionClasses() {
  for (const [code, g] of geo) {
    const out = !S.regions.has(byCode.get(code).region);
    shapesOf(g).forEach(el => el.classList.toggle('out', out));
  }
}

// Permanent colours for answered flags: done1 = right on the first try, done2 = right after several tries.
function doneState(code) {
  if (S.firstTry.has(code)) return 1;
  if (S.tries.has(code)) return 2;
  return 0;
}
function applyDone() {
  for (const [code, g] of geo) {
    const d = doneState(code);
    for (const el of shapesOf(g)) {
      el.classList.toggle('done1', d === 1);
      el.classList.toggle('done2', d === 2);
    }
  }
}

function ringRadius(ring, k) {
  const min = isTouch ? 10 : 7;
  return Math.max(min, Math.min(16, ring.half * k + 3));
}

function updateRings() {
  const k = curT.k;
  const shown = [];
  for (const ring of allRings) {
    const cls = ring.el.classList;
    const vis = (ring.small && !cls.contains('out') && ring.size * k < TINY_PX) ||
      (ring.size * k < 6 && (cls.contains('bad') || cls.contains('good')));
    if (vis !== ring.visible) { ring.visible = vis; ring.el.classList.toggle('hidden', !vis); }
    if (vis) { ring.r = ringRadius(ring, k); ring.sx = ring.x * k; ring.sy = ring.y * k; shown.push(ring); }
  }
  // Rings never overlap: when two are closer than their radii allow, both shrink to half the gap,
  // so crowded groups (e.g. Nauru, Kiribati, Tuvalu at world zoom) get small rings instead of moving.
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i], b = shown[j];
    const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
    if (a.r + b.r > d - 1) { const r = d / 2 - 0.5; a.r = Math.min(a.r, r); b.r = Math.min(b.r, r); }
  }
  // A ring squeezed below 2px is too small to see or hit, so it waits until you zoom in a little.
  for (const ring of shown) {
    const fits = ring.r >= 2;
    if (!fits) { ring.visible = false; ring.el.classList.add('hidden'); }
    else ring.el.setAttribute('r', ring.r / k);
  }
}

// ---------- hit testing ----------
// Priority: a tiny country's own shape > nearest ring under the pointer > whatever shape is under the pointer.
function hitTest(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const f = el && el.__f;
  if (f && f.code && geo.get(f.code).rings.some(r => r.visible)) return f;
  const rect = svg.node().getBoundingClientRect();
  const sx = clientX - rect.left, sy = clientY - rect.top;
  let best = null, bestD = Infinity;
  for (const ring of allRings) {
    if (!ring.visible) continue;
    const [px, py] = curT.apply([ring.x, ring.y]);
    const d = Math.hypot(px - sx, py - sy);
    if (d <= ring.r + (isTouch ? 4 : 1) && d < bestD) { bestD = d; best = ring.code; }
  }
  if (best) return { code: best, name: byCode.get(best).name };
  return f || null;
}

let hovered = null;
function setHover(code) {
  if (code === hovered) return;
  if (hovered) shapesOf(geo.get(hovered)).forEach(el => el.classList.remove('hover'));
  hovered = code;
  if (code) shapesOf(geo.get(code)).forEach(el => el.classList.add('hover'));
}
let hoveredTerr = null;
function setHoverTerr(el) {
  if (hoveredTerr === el) return;
  if (hoveredTerr) hoveredTerr.classList.remove('hover');
  hoveredTerr = el; if (el) el.classList.add('hover');
}

// Tap vs drag: a press only counts as a click if the pointer barely moved and only one finger was down.
const press = { id: null, x: 0, y: 0, moved: false, multi: false, down: new Set() };
function bindPointer() {
  const node = svg.node();
  node.addEventListener('pointerdown', e => {
    press.down.add(e.pointerId);
    if (press.down.size > 1) { press.multi = true; return; }
    Object.assign(press, { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, multi: false });
    isTouch = e.pointerType !== 'mouse';
    if (isTouch) { setHover(null); setHoverTerr(null); }
  });
  window.addEventListener('pointermove', e => {
    if (e.pointerId === press.id && press.down.size > 0) {
      const tol = e.pointerType === 'mouse' ? 5 : 10;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > tol) { press.moved = true; node.classList.add('grabbing'); }
    }
  });
  node.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' && press.down.size === 0) {
      const f = hitTest(e.clientX, e.clientY);
      setHover(f && f.code ? f.code : null);
      setHoverTerr(f && !f.code ? document.elementFromPoint(e.clientX, e.clientY) : null);
    }
  });
  const end = e => {
    if (!press.down.delete(e.pointerId)) return;
    node.classList.remove('grabbing');
    if (e.type !== 'pointerup' || e.pointerId !== press.id) return;
    const isTap = !press.moved && !press.multi;
    press.id = null;
    if (!isTap || e.button > 0 || !node.contains(e.target)) return;
    const f = hitTest(e.clientX, e.clientY);
    if (f) pick(f, e.clientX, e.clientY);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  node.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { setHover(null); setHoverTerr(null); } });
}

// ---------- labels on the map ----------
function addLabel(text, sub, clientX, clientY) {
  const rect = svg.node().getBoundingClientRect();
  const [x, y] = curT.invert([clientX - rect.left, clientY - rect.top]);
  const el = document.createElement('div');
  el.className = 'tag';
  el.innerHTML = esc(text) + (sub ? ` <small>${esc(sub)}</small>` : '');
  labelsEl.appendChild(el);
  labels.push({ el, x, y });
  placeLabels();
}
function clearLabels() { labels.forEach(l => l.el.remove()); labels = []; }
function placeLabels() {
  for (const l of labels) {
    const [x, y] = curT.apply([l.x, l.y]);
    l.el.style.left = x + 'px'; l.el.style.top = y + 'px';
  }
}

// ---------- highlighting ----------
function mark(code, cls, on = true) {
  shapesOf(geo.get(code)).forEach(el => el.classList.toggle(cls, on));
}
function clearMarks() {
  landG.selectAll('path.good, path.bad').classed('good bad', false);
  ringsG.selectAll('circle').classed('good bad', false);
  updateRings();
}
function flashBadTerritory(el) {
  el.classList.add('bad');
  setTimeout(() => el.classList.remove('bad'), 900);
}

// ---------- game flow ----------
function startSession(regions) {
  clearTimeout(S.timer); clearTimeout(S.flashTimer);
  S.regions = new Set(regions);
  applyRegionClasses();
  homeT = fitTransform(homeBounds(), 0.92, MAX_K, homeCrop());
  svg.transition().duration(600).call(zoom.transform, homeT);
  Object.assign(S, {
    pool: countries.filter(c => S.regions.has(c.region)).map(c => c.code),
    idx: 0, current: null, attempts: 0, locked: false,
    firstTry: new Set(), tries: new Map(), answered: new Set(), wrongClicks: 0,
    started: Date.now(),
  });
  S.queue = shuffle(S.pool);
  applyDone();
  clearMarks(); clearLabels();
  closeModal();
  nextFlag();
}

function nextFlag() {
  clearTimeout(S.flashTimer);
  clearMarks(); clearLabels();
  // Every flag is asked exactly once per session.
  if (S.idx >= S.queue.length) return finish();
  S.current = S.queue[S.idx++];
  S.attempts = 0; S.locked = false;
  flagImg.classList.add('swap');
  const src = flagSrc(S.current);
  const img = new Image();
  img.onload = img.onerror = () => {
    flagImg.src = src;
    requestAnimationFrame(() => flagImg.classList.remove('swap'));
  };
  img.src = src;
  const nxt = S.queue[S.idx]; if (nxt) new Image().src = flagSrc(nxt);
  promptEl.textContent = 'Where is this flag?';
  nameEl.className = ''; nameEl.textContent = ' ';
  showAttempt();
  updateCounter();
}

function pick(f, clientX, clientY) {
  if (S.locked || !S.current) return;
  const target = S.current;
  if (f.code === target) {
    S.locked = true;
    clearTimeout(S.flashTimer); clearMarks(); clearLabels();
    const tries = S.attempts + 1;
    if (tries === 1) S.firstTry.add(target); else S.tries.set(target, tries);
    S.answered.add(target);
    applyDone();
    mark(target, 'good');
    showName(byCode.get(target).name, 'good', tries === 1 ? 'Correct!' : `Got it in ${tries} tries`);
    attemptEl.classList.remove('show');
    updateCounter();
    S.timer = setTimeout(nextFlag, tries === 1 ? CORRECT_DELAY : FIXED_DELAY);
    return;
  }
  // Wrong: flash what was clicked and name it, but never reveal the answer. The same flag stays up.
  S.attempts++; S.wrongClicks++;
  clearTimeout(S.flashTimer); clearMarks(); clearLabels();
  landG.selectAll('path.terr.bad').classed('bad', false);
  let terr = null;
  if (f.code) mark(f.code, 'bad');
  else { terr = document.elementFromPoint(clientX, clientY); if (terr && terr.__f) terr.classList.add('bad'); else terr = null; }
  updateRings();
  addLabel(`That's ${f.name}`, f.code ? '' : '(not in quiz)', clientX, clientY);
  S.flashTimer = setTimeout(() => { if (terr) terr.classList.remove('bad'); clearMarks(); clearLabels(); }, WRONG_FLASH);
  promptEl.textContent = `That's ${f.name} — keep looking`;
  showAttempt();
}

function showAttempt() {
  attemptEl.textContent = `Attempt ${S.attempts + 1}`;
  attemptEl.classList.toggle('show', S.attempts > 0);
}

function showName(name, cls, prompt) {
  promptEl.textContent = prompt;
  nameEl.textContent = name;
  nameEl.className = cls;
  requestAnimationFrame(() => nameEl.classList.add('show'));
}

function updateCounter() {
  const N = S.pool.length;
  counterEl.innerHTML = `<i class="sw done1"></i><b>${S.firstTry.size}</b> first try · ` +
    `<i class="sw done2"></i><b>${S.tries.size}</b> after several tries · <b>${N - S.answered.size}</b> / ${N} to go`;
}

// ---------- modals ----------
function openModal(html, closable = true) {
  modalBody.innerHTML = html;
  $('modalClose').style.display = closable ? '' : 'none';
  modal.dataset.closable = closable ? '1' : '';
  modal.classList.remove('hidden');
}
function closeModal() { modal.classList.add('hidden'); }
modal.addEventListener('pointerdown', e => { if (e.target === modal && modal.dataset.closable) closeModal(); });
$('modalClose').onclick = closeModal;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.dataset.closable) closeModal(); });

function regionPicker(first) {
  const counts = Object.fromEntries(REGIONS.map(r => [r, countries.filter(c => c.region === r).length]));
  const world = S.regions.size === REGIONS.length;
  openModal(`
    <h2>${first ? 'Flag Map Quiz' : 'Choose regions'}</h2>
    <p>${first ? 'You see a flag — click that country on the map. A wrong click shows you what you clicked; keep looking until you find the right one.' : 'Starting with a new selection restarts the session.'}</p>
    <div class="regions">
      <label class="world"><input type="checkbox" id="rgWorld" ${world ? 'checked' : ''}> Whole world <span class="cnt">${countries.length}</span></label>
      ${REGIONS.map(r => `<label><input type="checkbox" class="rg" value="${r}" ${S.regions.has(r) ? 'checked' : ''}> ${r} <span class="cnt">${counts[r]}</span></label>`).join('')}
    </div>
    <div class="actions">
      ${first ? '' : '<button id="rgCancel">Cancel</button>'}
      <button class="primary" id="rgStart">Start</button>
    </div>`, !first);
  const boxes = [...modalBody.querySelectorAll('.rg')];
  const worldBox = $('rgWorld'), startBtn = $('rgStart');
  const sync = () => { worldBox.checked = boxes.every(b => b.checked); startBtn.disabled = !boxes.some(b => b.checked); startBtn.style.opacity = startBtn.disabled ? .5 : 1; };
  worldBox.onchange = () => { boxes.forEach(b => b.checked = worldBox.checked); sync(); };
  boxes.forEach(b => b.onchange = sync);
  sync();
  if (!first) $('rgCancel').onclick = closeModal;
  startBtn.onclick = () => startSession(boxes.filter(b => b.checked).map(b => b.value));
}

const cell = (code, extra = '') => {
  const c = byCode.get(code);
  return `<div class="cell"><div class="fl"><img src="${flagSrc(code)}" alt="" loading="lazy"></div>${esc(c.name)}${extra}</div>`;
};
const byName = (a, b) => byCode.get(a).name.localeCompare(byCode.get(b).name);
function section(title, codes, render = c => cell(c), empty = 'None yet') {
  return `<h3>${title} <span class="n">${codes.length}</span></h3>` +
    (codes.length ? `<div class="grid">${codes.sort(byName).map(render).join('')}</div>` : `<div class="empty">${empty}</div>`);
}

const triesCell = c => cell(c, `<div class="tries">${S.tries.get(c)} tries</div>`);

function progressView() {
  const toGo = S.pool.filter(c => !S.answered.has(c) && c !== S.current);
  openModal(`
    <h2>This session</h2>
    <p>${[...S.regions].length === REGIONS.length ? 'Whole world' : [...S.regions].join(', ')} · ${S.pool.length} flags · ${S.wrongClicks} wrong click${S.wrongClicks === 1 ? '' : 's'} so far</p>
    ${section('<i class="sw done1"></i>Correct first try', [...S.firstTry])}
    ${section('<i class="sw done2"></i>Correct after several tries', [...S.tries.keys()], triesCell)}
    ${section('Still to go', toGo, c => cell(c), 'Only the current flag is left')}
    <p class="hint" style="margin-top:18px">The flag you're on right now isn't listed.</p>`);
}

function finish() {
  S.locked = true; S.current = null;
  attemptEl.classList.remove('show');
  const N = S.pool.length, ok = S.firstTry.size;
  const mins = Math.max(1, Math.round((Date.now() - S.started) / 60000));
  flagImg.classList.add('swap');
  promptEl.textContent = 'Session complete';
  nameEl.className = 'good show'; nameEl.textContent = `${ok} / ${N}`;
  updateCounter();
  openModal(`
    <h2>Session complete 🎉</h2>
    <div class="score">${ok} <small>/ ${N} correct first try (${Math.round(100 * ok / N)}%)</small></div>
    <div class="stats"><span><i class="sw done2"></i><b>${S.tries.size}</b> after several tries</span><span><b>${S.wrongClicks}</b> wrong click${S.wrongClicks === 1 ? '' : 's'} in total</span><span>about <b>${mins}</b> min</span></div>
    ${S.tries.size ? section('<i class="sw done2"></i>Correct after several tries', [...S.tries.keys()], triesCell) : '<p>A perfect run — every flag right first time.</p>'}
    <div class="actions" style="margin-top:22px">
      <button id="endRegions">Change regions</button>
      <button class="primary" id="endAgain">Play again</button>
    </div>`, false);
  $('endAgain').onclick = () => startSession([...S.regions]);
  $('endRegions').onclick = () => regionPicker(false);
}

// ---------- controls ----------
$('btnSettings').onclick = () => regionPicker(false);
$('btnProgress').onclick = progressView;
$('zIn').onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.8);
$('zOut').onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.8);
$('zReset').onclick = () => svg.transition().duration(500).call(zoom.transform, homeT);

let resizeTimer;
new ResizeObserver(() => {
  if (!projection) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (Math.abs(wrap.clientWidth - W) < 2 && Math.abs(wrap.clientHeight - H) < 2) return;
    render();
    clearLabels();
  }, 150);
}).observe(wrap);

load().then(() => {
  render();
  bindPointer();
  $('loading').remove();
  regionPicker(true);
}).catch(err => {
  console.error(err);
  $('loading').textContent = 'Could not load the map. Please reload.';
});
})();
