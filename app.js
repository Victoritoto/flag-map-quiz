(() => {
'use strict';

const REGIONS = ['Africa', 'Americas', 'Asia', 'Europe', 'Oceania'];
// Rough lon/lat boxes used to frame the map on the chosen region(s).
const REGION_BOX = {
  Africa:   [[-26, -36], [58, 38]],
  Americas: [[-170, -56], [-30, 72]],
  Asia:     [[25, -11], [150, 56]],
  Europe:   [[-25, 34], [45, 71]],
  Oceania:  [[110, -48], [190, 20]],
};
// Natural Earth shapes without an ISO id that belong to a quiz country.
const NAME_TO_CODE = { 'Kosovo': 'xk', 'N. Cyprus': 'cy', 'Somaliland': 'so' };
const TERRITORY_NAMES = { 'W. Sahara': 'Western Sahara', 'Siachen Glacier': 'Siachen Glacier (disputed)' };
const ANTARCTICA = '010';
const MAX_K = 400;           // max zoom factor
const TINY_PX = 12;          // show a ring when a small country is smaller than this on screen
const SMALL_SR = 30000 / 40.6e6; // only countries under ~30,000 km² (in steradians) get rings
const CORRECT_DELAY = 1150;  // ms the name stays up after a right answer
const FIXED_DELAY = 1350;    // ms after finally clicking the right one

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const svg = d3.select('#map');
const wrap = $('mapWrap');
const labelsEl = $('labels');
const flagImg = $('flag');
const nameEl = $('name');
const promptEl = $('prompt');
const counterEl = $('counter');
const modal = $('modal');
const modalBody = $('modalBody');

// ---------- data ----------
let countries = [];        // [{code,num,name,region}]
const byCode = new Map();
let features = [];         // [{feature, code|null, name}]
const geo = new Map();     // code -> {paths:[], core, ring}

// ---------- map state ----------
const zoomLayer = svg.append('g');
const landG = zoomLayer.append('g').attr('class', 'land');
const ringsG = zoomLayer.append('g').attr('class', 'rings');
let projection, path, W = 0, H = 0, homeT = d3.zoomIdentity, curT = d3.zoomIdentity;
let rotation = -11;
let labels = [];           // [{el, x, y}] in projected (unzoomed) coords
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
  phase: 'main', round: 0, current: null, attempts: 0, locked: true,
  firstTry: new Set(), missed: new Set(), pending: new Set(), answered: new Set(),
  started: 0, autoZoomFrom: null, timer: null,
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

// The "core" of a country: its largest polygon plus everything within ~650 km.
// Used to place rings and to zoom, so far-flung islands (e.g. Kiribati, US Aleutians) don't break framing.
function coreOf(fs) {
  const polys = fs.flatMap(polygonsOf).map(c => {
    const p = { type: 'Polygon', coordinates: c };
    return { p, area: d3.geoArea(p), c: d3.geoCentroid(p) };
  });
  polys.sort((a, b) => b.area - a.area);
  const main = polys[0];
  const near = polys.filter(q => d3.geoDistance(q.c, main.c) < 0.1);
  return {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: near.map(q => q.p.coordinates) },
    area: polys.reduce((s, q) => s + q.area, 0),
  };
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
    features.push({ feature: f, code, name: code ? byCode.get(code).name : (TERRITORY_NAMES[nm] || nm) });
  }
  for (const c of list) geo.set(c.code, { paths: [], fs: [] });
  for (const f of features) if (f.code) geo.get(f.code).fs.push(f.feature);
  const missing = list.filter(c => !geo.get(c.code).fs.length);
  if (missing.length) console.error('No shape for', missing.map(c => c.name));
  for (const [code, g] of geo) g.core = coreOf(g.fs);
  window.__quiz = { countries, geo, features, S, pick: code => pick({ code, name: byCode.get(code).name }, 0, 0) };  // handy for checking in the console
}

// ---------- map rendering ----------
function rotationFor(regions) {
  if (regions.size === 1 && regions.has('Oceania')) return -165;
  if (regions.size === 1 && regions.has('Americas')) return 80;
  return -11;
}

function render() {
  W = wrap.clientWidth; H = wrap.clientHeight;
  svg.attr('viewBox', null);
  const world = { type: 'FeatureCollection', features: features.map(f => f.feature) };
  projection = d3.geoNaturalEarth1().rotate([rotation, 0]).fitExtent([[6, 6], [W - 6, H - 6]], world);
  path = d3.geoPath(projection);

  for (const g of geo.values()) g.paths = [];
  landG.selectAll('path').remove();
  for (const f of features) {
    const el = landG.append('path').attr('d', path(f.feature)).node();
    el.__f = f;
    if (f.code) geo.get(f.code).paths.push(el);
    else el.classList.add('terr');
  }

  ringsG.selectAll('circle').remove();
  for (const [code, g] of geo) {
    const b = path.bounds(g.core);
    const [x, y] = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    const half = Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) / 2;
    const size = Math.sqrt(path.area(g.core));
    const el = ringsG.append('circle').attr('cx', x).attr('cy', y).node();
    g.ring = { el, x, y, half, size, bounds: b, small: g.core.area < SMALL_SR, visible: false, r: 0 };
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
      const p = projection([lo > 180 ? lo - 360 : lo, la]);
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

function applyRegionClasses() {
  for (const [code, g] of geo) {
    const out = !S.regions.has(byCode.get(code).region);
    g.paths.forEach(p => p.classList.toggle('out', out));
    g.ring.el.classList.toggle('out', out);
  }
}

// Permanent colours for answered flags: done1 = right on the first try, done2 = right later in a replay round.
function doneState(code) {
  if (S.firstTry.has(code)) return 1;
  if (S.missed.has(code) && !S.pending.has(code)) return 2;
  return 0;
}
function applyDone() {
  for (const [code, g] of geo) {
    const d = doneState(code);
    for (const el of [...g.paths, g.ring.el]) {
      el.classList.toggle('done1', d === 1);
      el.classList.toggle('done2', d === 2);
    }
  }
}

function ringRadius(g, k) {
  const min = g.ring.el.classList.contains('target') ? 13 : isTouch ? 10 : 7;
  return Math.max(min, Math.min(16, g.ring.half * k + 3));
}

function updateRings() {
  const k = curT.k;
  for (const g of geo.values()) {
    const ring = g.ring;
    const cls = ring.el.classList;
    const vis = (ring.small && !cls.contains('out') && ring.size * k < TINY_PX) ||
      (ring.size * k < 6 && (cls.contains('target') || cls.contains('bad') || cls.contains('good')));
    if (vis !== ring.visible) { ring.visible = vis; ring.el.classList.toggle('hidden', !vis); }
    if (vis) {
      ring.r = ringRadius(g, k);
      ring.el.setAttribute('r', ring.r / k);
    }
  }
}

// ---------- hit testing ----------
// Priority: a tiny country's own shape > nearest ring under the pointer > whatever shape is under the pointer.
function hitTest(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const f = el && el.__f;
  if (f && f.code && geo.get(f.code).ring.visible) return f;
  const rect = svg.node().getBoundingClientRect();
  const sx = clientX - rect.left, sy = clientY - rect.top;
  let best = null, bestD = Infinity;
  for (const [code, g] of geo) {
    const ring = g.ring;
    if (!ring.visible) continue;
    const [px, py] = curT.apply([ring.x, ring.y]);
    const d = Math.hypot(px - sx, py - sy);
    if (d <= ring.r + (isTouch ? 4 : 1) && d < bestD) { bestD = d; best = code; }
  }
  if (best) return { code: best, name: byCode.get(best).name };
  return f || null;
}

let hovered = null;
function setHover(code) {
  if (code === hovered) return;
  if (hovered) { const g = geo.get(hovered); g.paths.forEach(p => p.classList.remove('hover')); g.ring.el.classList.remove('hover'); }
  hovered = code;
  if (code) { const g = geo.get(code); g.paths.forEach(p => p.classList.add('hover')); g.ring.el.classList.add('hover'); }
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
  const g = geo.get(code);
  g.paths.forEach(p => p.classList.toggle(cls, on));
  g.ring.el.classList.toggle(cls, on);
}
function clearMarks() {
  landG.selectAll('path.good, path.bad, path.target').classed('good bad target', false);
  ringsG.selectAll('circle').classed('good bad target', false);
  updateRings();
}
function flashBadTerritory(el) {
  el.classList.add('bad');
  setTimeout(() => el.classList.remove('bad'), 900);
}

// Bring the right answer into view if it is off-screen or too small to see.
function focusOn(code) {
  const b = geo.get(code).ring.bounds;
  const [[x0, y0], [x1, y1]] = b;
  const k = curT.k;
  const [sx0, sy0] = curT.apply([x0, y0]), [sx1, sy1] = curT.apply([x1, y1]);
  const onScreen = sx0 > 10 && sy0 > 10 && sx1 < W - 60 && sy1 < H - 10;
  const size = Math.max(x1 - x0, y1 - y0) * k;
  if (onScreen && size >= 24) return;
  const dim = Math.max(1e-6, Math.max(x1 - x0, y1 - y0));
  // Zoom in only enough to see it in context; tiny ones are marked by their pulsing ring.
  // k = 1 shows the whole world, so k = 30 still shows ~12° of longitude around the target.
  let k2 = Math.max(k, Math.min(30, 36 / dim));
  k2 = Math.min(k2, 0.8 * Math.min(W / Math.max(1e-6, x1 - x0), H / Math.max(1e-6, y1 - y0)));
  k2 = Math.max(k2, Math.min(k, homeT.k));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k2).translate(-cx, -cy);
  if (!S.autoZoomFrom) S.autoZoomFrom = curT;
  svg.transition().duration(750).ease(d3.easeCubicInOut).call(zoom.transform, t);
}

// ---------- game flow ----------
function startSession(regions) {
  clearTimeout(S.timer);
  const rot = rotationFor(regions);
  S.regions = new Set(regions);
  if (rot !== rotation || !projection) { rotation = rot; render(); }
  else { applyRegionClasses(); homeT = fitTransform(homeBounds(), 0.92, MAX_K, homeCrop()); svg.transition().duration(600).call(zoom.transform, homeT); }
  Object.assign(S, {
    pool: countries.filter(c => S.regions.has(c.region)).map(c => c.code),
    idx: 0, phase: 'main', round: 0, current: null, attempts: 0, locked: false,
    firstTry: new Set(), missed: new Set(), pending: new Set(), answered: new Set(),
    started: Date.now(), autoZoomFrom: null,
  });
  S.queue = shuffle(S.pool);
  applyDone();
  clearMarks(); clearLabels();
  closeModal();
  nextFlag();
}

function nextFlag() {
  clearMarks(); clearLabels();
  if (S.autoZoomFrom) { svg.transition().duration(600).ease(d3.easeCubicInOut).call(zoom.transform, S.autoZoomFrom); S.autoZoomFrom = null; }
  if (S.idx >= S.queue.length) {
    if (S.pending.size === 0) return finish();
    S.phase = 'review'; S.round++;
    S.queue = shuffle([...S.pending]); S.idx = 0;
  }
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
  promptEl.textContent = S.phase === 'review' ? `Review round ${S.round} · where is this flag?` : 'Where is this flag?';
  nameEl.className = ''; nameEl.textContent = ' ';
  updateCounter();
}

function pick(f, clientX, clientY) {
  if (S.locked || !S.current) return;
  const target = S.current;
  if (f.code === target) {
    S.locked = true;
    if (S.attempts === 0) {
      if (S.phase === 'main') S.firstTry.add(target);
      else S.pending.delete(target);
      applyDone();
    }
    if (S.phase === 'main') S.answered.add(target);
    mark(target, 'target', false);
    mark(target, 'good');
    showName(byCode.get(target).name, 'good', S.attempts === 0 ? 'Correct!' : 'Got it.');
    updateCounter();
    S.timer = setTimeout(nextFlag, S.attempts === 0 ? CORRECT_DELAY : FIXED_DELAY);
    return;
  }
  // wrong
  if (S.attempts === 0) {
    if (S.phase === 'main') { S.missed.add(target); S.pending.add(target); S.answered.add(target); }
  }
  S.attempts++;
  clearLabels();
  landG.selectAll('path.bad').classed('bad', false);
  ringsG.selectAll('circle.bad').classed('bad', false);
  if (f.code) mark(f.code, 'bad');
  else { const el = document.elementFromPoint(clientX, clientY); if (el && el.__f) flashBadTerritory(el); }
  addLabel(f.name, f.code ? '' : '(not in quiz)', clientX, clientY);
  mark(target, 'target');
  updateRings();
  showName(byCode.get(target).name, 'bad', `You clicked ${f.name} — this flag is`);
  updateCounter();
  focusOn(target);
}

function showName(name, cls, prompt) {
  promptEl.textContent = prompt;
  nameEl.textContent = name;
  nameEl.className = cls;
  requestAnimationFrame(() => nameEl.classList.add('show'));
}

function updateCounter() {
  const N = S.pool.length;
  const toGo = N - S.answered.size;
  const later = S.missed.size - S.pending.size;
  let html = `<b>${S.firstTry.size}</b> / ${N} first try · <b>${later}</b> later try · <b>${S.pending.size}</b> missed · <b>${toGo}</b> to go`;
  if (S.phase === 'review') html += ` · review round ${S.round}`;
  counterEl.innerHTML = html;
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
    <p>${first ? 'You see a flag — click that country on the map. Miss one and it comes back at the end until you get it right first time.' : 'Starting with a new selection restarts the session.'}</p>
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

function progressView() {
  const notSeen = S.pool.filter(c => !S.answered.has(c) && c !== S.current);
  openModal(`
    <h2>This session</h2>
    <p>${[...S.regions].length === REGIONS.length ? 'Whole world' : [...S.regions].join(', ')} · ${S.pool.length} flags${S.phase === 'review' ? ` · review round ${S.round}` : ''}</p>
    ${section('<i class="sw done1"></i>First try', [...S.firstTry])}
    ${section('<i class="sw done2"></i>Later try', [...S.missed].filter(c => !S.pending.has(c)))}
    ${section('Missed, not yet right', [...S.pending], c => cell(c), 'Nothing waiting for a replay')}
    ${section('Not yet seen', notSeen, c => cell(c), 'You have seen every flag')}
    <p class="hint" style="margin-top:18px">The flag you're on right now isn't listed.</p>`);
}

function finish() {
  S.locked = true; S.current = null; S.phase = 'done';
  const N = S.pool.length, ok = S.firstTry.size;
  const mins = Math.max(1, Math.round((Date.now() - S.started) / 60000));
  flagImg.classList.add('swap');
  promptEl.textContent = 'Session complete';
  nameEl.className = 'good show'; nameEl.textContent = `${ok} / ${N}`;
  updateCounter();
  openModal(`
    <h2>Session complete 🎉</h2>
    <div class="score">${ok} <small>/ ${N} right first try (${Math.round(100 * ok / N)}%)</small></div>
    <div class="stats"><span><b>${S.missed.size}</b> later try</span><span><b>${S.round}</b> review round${S.round === 1 ? '' : 's'}</span><span>about <b>${mins}</b> min</span></div>
    ${S.missed.size ? section('<i class="sw done2"></i>Later try', [...S.missed]) : '<p>A perfect run — every flag right first time.</p>'}
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
$('zReset').onclick = () => { S.autoZoomFrom = null; svg.transition().duration(500).call(zoom.transform, homeT); };

let resizeTimer;
new ResizeObserver(() => {
  if (!projection) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (Math.abs(wrap.clientWidth - W) < 2 && Math.abs(wrap.clientHeight - H) < 2) return;
    render();
    S.autoZoomFrom = null;
    clearLabels();
    // Paths were redrawn, so re-apply the pulsing hint if a wrong answer is pending.
    if (S.current && S.attempts > 0 && !S.locked) { mark(S.current, 'target'); updateRings(); }
  }, 150);
}).observe(wrap);

load().then(() => {
  rotation = rotationFor(S.regions);
  render();
  bindPointer();
  $('loading').remove();
  regionPicker(true);
}).catch(err => {
  console.error(err);
  $('loading').textContent = 'Could not load the map. Please reload.';
});
})();
