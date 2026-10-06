'use strict';

/* =========================================================
   Lageplan-Generator
   Datenquellen: OpenStreetMap (Overpass API) und
   swisstopo / amtliche Vermessung (api3.geo.admin.ch)
   Läuft komplett im Browser (GitHub Pages tauglich).
   ========================================================= */

/* ---------- Koordinatensysteme ---------- */
proj4.defs('EPSG:2056',
  '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 ' +
  '+x_0=2600000 +y_0=1200000 +ellps=bessel ' +
  '+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');
const toLV  = ([lon, lat]) => proj4('EPSG:4326', 'EPSG:2056', [lon, lat]);
const toWGS = ([e, n])     => proj4('EPSG:2056', 'EPSG:4326', [e, n]);

/* ---------- Konfiguration ---------- */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

const RE_LANDUSE = '^(grass|meadow|recreation_ground|village_green|forest|orchard|allotments|cemetery|vineyard|flowerbed|greenfield)$';
const RE_LEISURE = '^(park|garden|playground|dog_park|golf_course)$';
const RE_NATURAL = '^(wood|scrub|grassland|heath|water)$';
const reLanduse = new RegExp(RE_LANDUSE), reLeisure = new RegExp(RE_LEISURE), reNatural = new RegExp(RE_NATURAL);

const SKIP_HIGHWAY = new Set([
  'proposed', 'construction', 'platform', 'bus_stop', 'elevator', 'corridor',
  'abandoned', 'razed', 'raceway', 'via_ferrata', 'escape', 'emergency_bay', 'services', 'rest_area'
]);

// Geschätzte Fahrbahnbreiten (ohne Trottoir) in Metern
const ROAD_WIDTH = {
  motorway: 11, trunk: 10, primary: 8, secondary: 7, tertiary: 6.5,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  unclassified: 5, residential: 5.5, living_street: 5, road: 5,
  service: 3.5, pedestrian: 6, track: 3,
  footway: 2, cycleway: 2.2, path: 1.5, bridleway: 2, steps: 2
};
const FOOT_TYPES = new Set(['footway', 'path', 'cycleway', 'bridleway', 'steps', 'pedestrian', 'track']);
const MAJOR_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
const SIDEWALK_WIDTH = 2.0;
const DEFAULT_TREE_CROWN = 6;   // m
const SHADOW_FACTOR = 0.55;     // Schattenlänge = Höhe × Faktor

const COL = {
  carriage: '#c9c9c6', sidewalk: '#e1e1de', edge: '#7c7c78', curb: '#a2a29e', paved: '#e1e1de',
  grass: '#dce8cf', grassEdge: '#a6bf98', forest: '#c3d7b3', forestEdge: '#8cab7d',
  water: '#d0e2ec', waterEdge: '#85a8bd', parcel: '#2b2b2b',
  treeEdge: '#4f6f45', shadow: '#1d2630'
};

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const ui = {
  width: $('width'), height: $('height'), scale: $('scale'), dpi: $('dpi'),
  style: $('style'), optRoof: $('optRoof'), optShadow: $('optShadow'), optTexture: $('optTexture'), sun: $('sun'),
  btnGenerate: $('btnGenerate'), btnPng: $('btnPng'), btnDxf: $('btnDxf'),
  status: $('status'), preview: $('preview'), planEmpty: $('planEmpty'),
  tabMap: $('tabMap'), tabPlan: $('tabPlan'), mapView: $('map'), planView: $('planView')
};
const layerOn = id => $(id).checked;

const state = {
  center: toLV([8.5417, 47.3769]), // Zürich
  plan: null
};

function renderOpts() {
  return {
    detail: ui.style.value === 'detail',
    roof: ui.optRoof.checked,
    shadow: ui.optShadow.checked,
    texture: ui.optTexture.checked,
    sun: ui.sun.value
  };
}

function setStatus(msg, isError = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', isError);
}

/* ---------- Karte ---------- */
const map = L.map('map', { zoomControl: true }).setView([47.3769, 8.5417], 17);
L.tileLayer(
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
  { maxZoom: 20, maxNativeZoom: 18, attribution: '© swisstopo' }
).addTo(map);

const perimeter = L.polygon([], {
  color: '#d7141a', weight: 2, dashArray: '6 4', fillOpacity: 0.05
}).addTo(map);

function getBBox() {
  const w = clamp(+ui.width.value || 300, 50, 1500);
  const h = clamp(+ui.height.value || 200, 50, 1500);
  const [e, n] = state.center;
  return [e - w / 2, n - h / 2, e + w / 2, n + h / 2];
}

function updatePerimeter() {
  const [minE, minN, maxE, maxN] = getBBox();
  const corners = [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]]
    .map(c => { const [lon, lat] = toWGS(c); return [lat, lon]; });
  perimeter.setLatLngs(corners);

  $('tbScale').textContent = '1:' + ui.scale.value;
  $('tbSize').textContent = `${Math.round(maxE - minE)} × ${Math.round(maxN - minN)} m`;
  $('tbCenter').textContent =
    `${Math.round(state.center[0]).toLocaleString('de-CH')} / ${Math.round(state.center[1]).toLocaleString('de-CH')}`;
}

function invalidatePlan() {
  if (state.plan) {
    state.plan = null;
    ui.btnPng.disabled = ui.btnDxf.disabled = true;
    setStatus('Ausschnitt geändert. Plan neu erzeugen.');
  }
}

map.on('click', e => {
  state.center = toLV([e.latlng.lng, e.latlng.lat]);
  updatePerimeter();
  invalidatePlan();
});
[ui.width, ui.height].forEach(el => el.addEventListener('change', () => {
  updatePerimeter();
  invalidatePlan();
}));

// Massstab ändert nur die Darstellung, die Daten bleiben gültig
ui.scale.addEventListener('change', () => {
  ui.style.value = +ui.scale.value <= 500 ? 'detail' : 'simple';
  applyStylePreset();
  updatePerimeter();
  if (state.plan) { state.plan.scale = +ui.scale.value; renderPreview(); }
});

function applyStylePreset() {
  const detail = ui.style.value === 'detail';
  ui.optRoof.checked = detail;
  ui.optShadow.checked = detail;
  ui.optTexture.checked = detail;
}
ui.style.addEventListener('change', () => { applyStylePreset(); renderPreview(); });
[ui.optRoof, ui.optShadow, ui.optTexture, ui.sun].forEach(el => el.addEventListener('change', renderPreview));

/* ---------- Ortssuche (geo.admin.ch) ---------- */
$('searchForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  setStatus('Suche läuft …');
  try {
    const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer' +
      `?searchText=${encodeURIComponent(q)}&type=locations&limit=1&sr=4326`;
    const res = await fetch(url).then(r => r.json());
    const a = res.results && res.results[0] && res.results[0].attrs;
    if (!a) { setStatus(`Kein Treffer für «${q}».`, true); return; }
    state.center = toLV([a.lon, a.lat]);
    map.setView([a.lat, a.lon], 18);
    updatePerimeter();
    invalidatePlan();
    setStatus(stripTags(a.label || q));
  } catch (err) {
    setStatus('Suche fehlgeschlagen: ' + err.message, true);
  }
});

/* ---------- Tabs ---------- */
function showTab(which) {
  const plan = which === 'plan';
  ui.tabMap.setAttribute('aria-selected', String(!plan));
  ui.tabPlan.setAttribute('aria-selected', String(plan));
  ui.mapView.hidden = plan;
  ui.planView.hidden = !plan;
  if (!plan) map.invalidateSize();
}
ui.tabMap.addEventListener('click', () => showTab('map'));
ui.tabPlan.addEventListener('click', () => showTab('plan'));

/* =========================================================
   Daten holen
   ========================================================= */

async function fetchOverpass([s, w, n, e]) {
  const b = `(${s},${w},${n},${e})`;
  const q = `[out:json][timeout:90];
(
  way["building"]${b};
  relation["building"]["type"="multipolygon"]${b};
  way["highway"]${b};
  way["area:highway"]${b};
  way["amenity"="parking"]${b};
  way["landuse"~"${RE_LANDUSE}"]${b};
  relation["type"="multipolygon"]["landuse"~"${RE_LANDUSE}"]${b};
  way["leisure"~"${RE_LEISURE}"]${b};
  relation["type"="multipolygon"]["leisure"~"${RE_LEISURE}"]${b};
  way["natural"~"${RE_NATURAL}"]${b};
  relation["type"="multipolygon"]["natural"~"${RE_NATURAL}"]${b};
  way["waterway"="riverbank"]${b};
  node["natural"="tree"]${b};
);
out geom;`;

  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('OpenStreetMap-Server nicht erreichbar (' + (lastErr && lastErr.message) + ')');
}

// Parzellen aus der amtlichen Vermessung über die geo.admin.ch Identify-API
async function fetchParcels(bbox) {
  const [a, b, c, d] = bbox.map(v => v.toFixed(1));
  const LIMIT = 50;
  const seen = new Map();

  for (let page = 0; page < 20; page++) {
    const url = 'https://api3.geo.admin.ch/rest/services/all/MapServer/identify' +
      `?geometry=${a},${b},${c},${d}&geometryType=esriGeometryEnvelope` +
      '&layers=all:ch.kantone.cadastralwebmap-farbe' +
      `&mapExtent=${a},${b},${c},${d}&imageDisplay=1000,1000,96&tolerance=0` +
      '&sr=2056&returnGeometry=true&geometryFormat=geojson' +
      `&limit=${LIMIT}&offset=${page * LIMIT}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const results = j.results || [];
    let added = 0;
    for (const f of results) {
      const id = f.featureId != null ? f.featureId : (f.id != null ? f.id : JSON.stringify(f.properties));
      if (!seen.has(id)) { seen.set(id, f); added++; }
    }
    if (results.length < LIMIT || added === 0) break;
  }

  const parcels = [];
  for (const f of seen.values()) {
    const props = f.properties || f.attributes || {};
    const polys = [];
    collectPolys(f.geometry, polys);
    parcels.push({ polys, number: String(props.number != null ? props.number : (props.label || '')) });
  }
  return parcels;
}

/* =========================================================
   OSM-Daten aufbereiten
   ========================================================= */

const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

function wayCoords(el) {
  return (el.geometry || []).filter(Boolean).map(p => [p.lon, p.lat]);
}

// Offene Wegstücke zu geschlossenen Ringen zusammensetzen
function joinWays(ways) {
  const rings = [];
  const pool = ways.filter(w => w.length >= 2).map(w => w.slice());
  while (pool.length) {
    let cur = pool.shift();
    let guard = 0;
    while (!samePt(cur[0], cur[cur.length - 1]) && guard++ < 5000) {
      const last = cur[cur.length - 1];
      const idx = pool.findIndex(w => samePt(w[0], last) || samePt(w[w.length - 1], last));
      if (idx < 0) break;
      let w = pool.splice(idx, 1)[0];
      if (!samePt(w[0], last)) w = w.reverse();
      cur = cur.concat(w.slice(1));
    }
    if (cur.length >= 4 && samePt(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Liefert Polygone als Array von Ringen in WGS84
function elementToPolygons(el) {
  if (el.type === 'way') {
    const c = wayCoords(el);
    return (c.length >= 4 && samePt(c[0], c[c.length - 1])) ? [[c]] : [];
  }
  if (el.type === 'relation') {
    const members = (el.members || []).filter(m => m.type === 'way' && m.geometry);
    const outers = joinWays(members.filter(m => m.role !== 'inner').map(wayCoords));
    const inners = joinWays(members.filter(m => m.role === 'inner').map(wayCoords));
    return outers.map(o => [o, ...inners.filter(i => pointInRing(i[0], o))]);
  }
  return [];
}

const isUnderground = t =>
  (t.tunnel && t.tunnel !== 'no') || (t.layer && parseFloat(t.layer) < 0) ||
  t.location === 'underground' || t.indoor === 'yes' ||
  t.parking === 'underground' || t.parking === 'multi-storey';

function greenKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank') return 'water';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (reLanduse.test(t.landuse || '') || reLeisure.test(t.leisure || '') || reNatural.test(t.natural || '')) return 'grass';
  return null;
}

function sidewalkSides(t) {
  const v = t.sidewalk || t['sidewalk:both'];
  if (v === 'both') return 2;
  if (v === 'left' || v === 'right') return 1;
  if (t['sidewalk:both'] === 'yes') return 2;
  let n = 0;
  if (t['sidewalk:left'] === 'yes') n++;
  if (t['sidewalk:right'] === 'yes') n++;
  if (!n && v === 'yes') return 2;
  return n;
}

function roadSpec(t) {
  const hw = t.highway;
  const kind = FOOT_TYPES.has(hw) ? 'foot' : MAJOR_TYPES.has(hw) ? 'major' : hw === 'service' ? 'service' : 'minor';
  let w = parseFloat(t.width);
  if (!(w >= 1 && w <= 40)) {
    w = ROAD_WIDTH[hw] || 4;
    const lanes = parseInt(t.lanes, 10);
    if (lanes > 0 && kind !== 'foot') w = Math.max(w, lanes * 3.1);
  }
  const sw = kind === 'foot' ? 0 : sidewalkSides(t) * SIDEWALK_WIDTH;
  const rank = { foot: 0, service: 1, minor: 2, major: 3 }[kind];
  return { kind, rank, outerW: w + sw, innerW: sw ? w : 0 };
}

function classify(osm) {
  const out = { buildings: [], roadLines: [], roadAreas: [], green: [], trees: [] };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') out.trees.push({ lon: el.lon, lat: el.lat, tags: t });
      continue;
    }
    if (t.building && t.building !== 'no') {
      if (!isUnderground(t)) elementToPolygons(el).forEach(poly => out.buildings.push({ poly, tags: t }));
      continue;
    }
    if (t['area:highway'] || (t.amenity === 'parking' && !isUnderground(t)) || (t.highway && t.area === 'yes')) {
      out.roadAreas.push(...elementToPolygons(el));
      continue;
    }
    if (t.highway && el.type === 'way') {
      if (SKIP_HIGHWAY.has(t.highway) || isUnderground(t)) continue;
      const c = wayCoords(el);
      if (c.length >= 2) out.roadLines.push({ coords: c, tags: t });
      continue;
    }
    const kind = greenKind(t);
    if (kind) elementToPolygons(el).forEach(poly => out.green.push({ poly, kind }));
  }
  return out;
}

/* =========================================================
   Geometrie
   ========================================================= */

const projPoly = poly => poly.map(ring => ring.map(toLV));

function projectCoords(c) {
  return typeof c[0] === 'number' ? toLV(c) : c.map(projectCoords);
}

function collectPolys(g, res) {
  if (!g || !g.coordinates) return;
  const add = rings => {
    if (!rings.length || rings[0].length < 4) return;
    res.push([rings[0], ...rings.slice(1).filter(r => r.length >= 4)]);
  };
  if (g.type === 'Polygon') add(g.coordinates);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(add);
}

function clipPolys(polys, bbox) {
  const res = [];
  for (const p of polys) {
    try {
      const f = turf.bboxClip(turf.polygon(p), bbox);
      collectPolys(f.geometry, res);
    } catch (e) { /* ungültige Geometrie überspringen */ }
  }
  return res;
}

function unionAll(polys) {
  if (polys.length < 2) return polys;
  try {
    const u = turf.union(turf.featureCollection(polys.map(p => turf.polygon(p))));
    const res = [];
    if (u) collectPolys(u.geometry, res);
    return res;
  } catch (e) {
    console.warn('Vereinigung fehlgeschlagen, verwende Einzelflächen.', e);
    return polys;
  }
}

function polyBBox(poly) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of poly[0]) {
    if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y;
  }
  return [a, b, c, d];
}
const bboxHit = (p, q) => p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1];

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2; // Vorzeichen abhängig von der Umlaufrichtung
}
const planarArea = poly => Math.abs(ringArea(poly[0]));

function labelPoint(poly) {
  try { return turf.pointOnFeature(turf.polygon(poly)).geometry.coordinates; }
  catch (e) { return null; }
}

function convexHull(pts) {
  const p = pts.map(q => q.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Minimales umschliessendes Rechteck (orientiert), Achse u = Längsrichtung
function orientedBox(ring) {
  const ox = ring[0][0], oy = ring[0][1];
  const h = convexHull(ring.slice(0, -1).map(([x, y]) => [x - ox, y - oy]));
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    let ux = b[0] - a[0], uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len < 1e-9) continue;
    ux /= len; uy /= len;
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of h) {
      const u = p[0] * ux + p[1] * uy, v = p[0] * vx + p[1] * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  let r = {
    cx: ox + cu * best.ux + cv * best.vx, cy: oy + cu * best.uy + cv * best.vy,
    ux: best.ux, uy: best.uy, vx: best.vx, vy: best.vy,
    L: (best.maxU - best.minU) / 2, W: (best.maxV - best.minV) / 2
  };
  if (r.W > r.L) r = { ...r, ux: r.vx, uy: r.vy, vx: -r.ux, vy: -r.uy, L: r.W, W: r.L };
  return r;
}

// Ring um d nach innen versetzen (für Attika bei Flachdächern)
function insetRing(ring, d) {
  const pts = [];
  for (const p of ring.slice(0, -1)) if (!pts.length || !samePt(pts[pts.length - 1], p)) pts.push(p);
  const n = pts.length;
  if (n < 3) return null;
  const sgn = ringArea(ring) > 0 ? -1 : 1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    if (len < 1e-6) { lines.push(null); continue; }
    const nx = -dy / len * d * sgn, ny = dx / len * d * sgn;
    lines.push({ p: [p[0] + nx, p[1] + ny], d: [dx, dy], nrm: [nx, ny] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    if (!A || !B) continue;
    const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    let pt;
    if (Math.abs(den) < 1e-9) pt = [pts[i][0] + B.nrm[0], pts[i][1] + B.nrm[1]];
    else {
      const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
      pt = [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t];
      if (Math.hypot(pt[0] - pts[i][0], pt[1] - pts[i][1]) > 4 * d) pt = [pts[i][0] + B.nrm[0], pts[i][1] + B.nrm[1]];
    }
    out.push(pt);
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
}

/* ---------- Gebäude: Höhe und schematische Dachform ---------- */

function buildingHeight(t, area) {
  const h = parseFloat(t.height);
  if (h > 0 && h < 300) return h;
  const lv = parseFloat(t['building:levels']);
  if (lv > 0) return lv * 3 + (parseFloat(t['roof:levels']) > 0 ? parseFloat(t['roof:levels']) * 2.5 : 1.5);
  if (['garage', 'garages', 'shed', 'carport', 'roof', 'hut', 'kiosk'].includes(t.building) || area < 40) return 3.5;
  return 10;
}

const PITCHED_DEFAULT = new Set([
  'house', 'detached', 'semidetached_house', 'farm', 'farm_auxiliary', 'barn', 'shed', 'garage',
  'cabin', 'chalet', 'hut', 'church', 'chapel', 'terrace', 'residential', 'yes', 'stable'
]);

function roofShape(t, area) {
  const raw = (t['roof:shape'] || '').toLowerCase();
  if (raw) {
    if (['gabled', 'gambrel', 'saltbox', 'round'].includes(raw)) return 'gabled';
    if (['hipped', 'half-hipped', 'pyramidal', 'mansard', 'side_hipped'].includes(raw)) return 'hipped';
    if (['skillion', 'lean_to'].includes(raw)) return 'skillion';
    return 'flat';
  }
  return PITCHED_DEFAULT.has(t.building) && area < 500 ? 'gabled' : 'flat';
}

function computeRoof(poly, t, area) {
  const flat = () => ({
    shape: 'flat', faces: [{ poly: poly[0], dir: null }], lines: [],
    inset: area > 40 ? insetRing(poly[0], 0.45) : null
  });
  let shape = roofShape(t, area);
  if (shape === 'flat') return flat();

  const o = orientedBox(poly[0]);
  if (!o || o.W < 1.5 || area / (4 * o.L * o.W) < 0.75) return flat();

  let { cx, cy, ux, uy, vx, vy, L, W } = o;
  if (shape === 'gabled' && t['roof:orientation'] === 'across') {
    [ux, uy, vx, vy] = [vx, vy, -ux, -uy];
    [L, W] = [W, L];
  }
  const P = (s, q) => [cx + s * ux + q * vx, cy + s * uy + q * vy];
  const U = [ux, uy], V = [vx, vy], nU = [-ux, -uy], nV = [-vx, -vy];

  if (shape === 'gabled') {
    return {
      shape, inset: null,
      faces: [
        { poly: [P(-L, 0), P(L, 0), P(L, W), P(-L, W)], dir: V },
        { poly: [P(-L, 0), P(L, 0), P(L, -W), P(-L, -W)], dir: nV }
      ],
      lines: [[P(-L, 0), P(L, 0)]]
    };
  }
  if (shape === 'hipped') {
    const r = Math.max(0, L - W);
    const lines = [[P(-L, W), P(-r, 0)], [P(-L, -W), P(-r, 0)], [P(L, W), P(r, 0)], [P(L, -W), P(r, 0)]];
    if (r > 0) lines.push([P(-r, 0), P(r, 0)]);
    return {
      shape, inset: null, lines,
      faces: [
        { poly: [P(-L, W), P(L, W), P(r, 0), P(-r, 0)], dir: V },
        { poly: [P(-L, -W), P(L, -W), P(r, 0), P(-r, 0)], dir: nV },
        { poly: [P(L, W), P(L, -W), P(r, 0)], dir: U },
        { poly: [P(-L, W), P(-L, -W), P(-r, 0)], dir: nU }
      ]
    };
  }
  // Pultdach
  return {
    shape, inset: null, lines: [],
    faces: [{ poly: [P(-L, -W), P(L, -W), P(L, W), P(-L, W)], dir: nV }]
  };
}

function sunVectors(opt) {
  const k = Math.SQRT1_2;
  // toSun: Richtung zur Sonne (E, N), shadow: Richtung des Schattens
  return opt === 'se'
    ? { toSun: [-k, k], shadow: [k, -k] }
    : { toSun: [-k, -k], shadow: [k, k] };
}

/* =========================================================
   Plan erzeugen
   ========================================================= */

ui.btnGenerate.addEventListener('click', generate);

async function generate() {
  const bbox = getBBox();
  const scale = +ui.scale.value;
  const opts = {
    buildings: layerOn('lyBuildings'), roads: layerOn('lyRoads'), green: layerOn('lyGreen'),
    trees: layerOn('lyTrees'), parcels: layerOn('lyParcels'), parcelNr: layerOn('lyParcelNr')
  };

  ui.btnGenerate.disabled = true;
  ui.btnPng.disabled = ui.btnDxf.disabled = true;

  try {
    const pad = 60;
    const padBox = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
    const fetchCorners = [
      [padBox[0], padBox[1]], [padBox[2], padBox[1]], [padBox[2], padBox[3]], [padBox[0], padBox[3]]
    ].map(toWGS);
    const lons = fetchCorners.map(c => c[0]), lats = fetchCorners.map(c => c[1]);
    const wgsBox = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];

    const needOsm = opts.buildings || opts.roads || opts.green || opts.trees;
    const needParcels = opts.parcels || opts.parcelNr;
    setStatus('Lade Daten von OpenStreetMap und geo.admin.ch …');

    const warnings = [];
    const [osm, parcelsRaw] = await Promise.all([
      needOsm ? fetchOverpass(wgsBox) : Promise.resolve({ elements: [] }),
      needParcels
        ? fetchParcels(bbox).catch(err => { warnings.push('Parzellen nicht verfügbar (' + err.message + ')'); return []; })
        : Promise.resolve([])
    ]);

    setStatus('Verarbeite Geometrien …');
    await nextFrame();

    const data = classify(osm);
    const plan = {
      bbox, scale, buildings: [], green: [], roadAreas: [], roadLines: [],
      trees: [], parcels: [], labels: []
    };

    if (opts.buildings) {
      for (const b of data.buildings) {
        const poly = projPoly(b.poly);
        if (!bboxHit(polyBBox(poly), padBox)) continue;
        const area = planarArea(poly);
        plan.buildings.push({
          poly, height: buildingHeight(b.tags, area), roof: computeRoof(poly, b.tags, area)
        });
      }
    }

    if (opts.green) {
      for (const g of data.green) {
        const poly = projPoly(g.poly);
        if (bboxHit(polyBBox(poly), padBox)) plan.green.push({ poly, kind: g.kind });
      }
    }

    if (opts.roads) {
      plan.roadAreas = data.roadAreas.map(projPoly).filter(p => bboxHit(polyBBox(p), padBox));
      plan.roadLines = data.roadLines
        .map(l => ({ wgs: l.coords, lv: l.coords.map(toLV), ...roadSpec(l.tags) }))
        .sort((a, b) => a.rank - b.rank);
    }

    if (opts.trees) {
      for (const t of data.trees) {
        const [e, n] = toLV([t.lon, t.lat]);
        const d0 = parseFloat(t.tags.diameter_crown);
        const d = d0 > 0.5 && d0 < 40 ? d0 : DEFAULT_TREE_CROWN;
        if (e < bbox[0] - d || e > bbox[2] + d || n < bbox[1] - d || n > bbox[3] + d) continue;
        const h = parseFloat(t.tags.height);
        plan.trees.push({ e, n, d, h: h > 0 && h < 60 ? h : d * 1.6, seed: Math.floor(e * 13 + n * 7) });
      }
    }

    if (needParcels) {
      for (const p of parcelsRaw) {
        const clipped = clipPolys(p.polys, bbox);
        if (!clipped.length) continue;
        if (opts.parcels) plan.parcels.push(...clipped);
        if (opts.parcelNr && p.number) {
          const biggest = clipped.reduce((a, b) => planarArea(a) > planarArea(b) ? a : b);
          if (planarArea(biggest) > 40) {
            const pt = labelPoint(biggest);
            if (pt) plan.labels.push({ e: pt[0], n: pt[1], text: p.number });
          }
        }
      }
    }

    state.plan = plan;
    await document.fonts.ready;
    renderPreview();
    showTab('plan');
    ui.btnPng.disabled = ui.btnDxf.disabled = false;

    const summary = `${plan.buildings.length} Gebäude, ${plan.trees.length} Bäume, ` +
      `${plan.roadLines.length} Strassenabschnitte, ${plan.parcels.length} Parzellenflächen.`;
    setStatus(warnings.length ? summary + ' ' + warnings.join(' ') : 'Plan erzeugt: ' + summary, warnings.length > 0);
  } catch (err) {
    console.error(err);
    setStatus('Fehler: ' + err.message, true);
  } finally {
    ui.btnGenerate.disabled = false;
  }
}

/* =========================================================
   Rendering (Canvas, für Vorschau und PNG)
   ========================================================= */

function makePattern(ctx, dpi, kind) {
  const mm = v => v * dpi / 25.4;
  const S = Math.max(24, Math.round(mm(8)));
  const p = document.createElement('canvas');
  p.width = p.height = S;
  const c = p.getContext('2d');
  const rnd = mulberry32(kind.length * 9973 + 7);

  if (kind === 'grass') {
    c.strokeStyle = 'rgba(70, 110, 55, 0.32)';
    c.lineWidth = Math.max(0.6, mm(0.08));
    c.lineCap = 'round';
    for (let i = 0; i < 55; i++) {
      const x = rnd() * S, y = rnd() * S;
      const a = -Math.PI / 2 + (rnd() - 0.5) * 0.9, len = mm(0.3 + rnd() * 0.35);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); c.stroke();
    }
  } else if (kind === 'forest') {
    c.strokeStyle = 'rgba(60, 95, 50, 0.35)';
    c.lineWidth = Math.max(0.6, mm(0.08));
    for (let i = 0; i < 9; i++) {
      const x = rnd() * S, y = rnd() * S, r = mm(0.5 + rnd() * 0.7);
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    }
  } else { // paving
    const s = Math.max(1, mm(0.07));
    for (let i = 0; i < 420; i++) {
      c.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`;
      c.fillRect(rnd() * S, rnd() * S, s, s);
    }
  }
  return ctx.createPattern(p, 'repeat');
}

function drawPlan(canvas, plan, dpi, o) {
  const [minE, minN, maxE, maxN] = plan.bbox;
  const pxPerM = dpi / 0.0254 / plan.scale;
  const W = Math.round((maxE - minE) * pxPerM);
  const H = Math.round((maxN - minN) * pxPerM);
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  const mm = v => v * dpi / 25.4;
  const X = e => (e - minE) * pxPerM;
  const Y = n => (maxN - n) * pxPerM;
  const sun = sunVectors(o.sun);

  // Eine Zwischenebene für Texturen und Schatten
  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lc = layer.getContext('2d');
  const composite = (draw, pattern, alpha = 1) => {
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);
    lc.lineJoin = 'round'; lc.lineCap = 'round';
    draw(lc);
    if (pattern) {
      lc.globalCompositeOperation = 'source-atop';
      lc.fillStyle = pattern;
      lc.fillRect(0, 0, W, H);
      lc.globalCompositeOperation = 'source-over';
    }
    ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(layer, 0, 0); ctx.restore();
  };

  const traceRing = (c, ring, dx = 0, dy = 0) => {
    ring.forEach(([e, n], i) => i ? c.lineTo(X(e) + dx, Y(n) + dy) : c.moveTo(X(e) + dx, Y(n) + dy));
    c.closePath();
  };
  const tracePoly = (c, poly) => poly.forEach(r => traceRing(c, r));
  const fillStroke = (c, polys, fill, stroke, lw) => {
    for (const p of polys) {
      c.beginPath(); tracePoly(c, p);
      if (fill) { c.fillStyle = fill; c.fill('evenodd'); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
    }
  };

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const greens = kind => plan.green.filter(g => g.kind === kind).map(g => g.poly);

  // Wasser, Wiese, Wald
  fillStroke(ctx, greens('water'), COL.water, COL.waterEdge, mm(0.15));
  composite(c => fillStroke(c, greens('grass'), COL.grass, COL.grassEdge, mm(0.13)),
    o.texture ? makePattern(ctx, dpi, 'grass') : null);
  composite(c => fillStroke(c, greens('forest'), COL.forest, COL.forestEdge, mm(0.13)),
    o.texture ? makePattern(ctx, dpi, 'forest') : null);

  // Strassen: Rand, Belag, Trottoirkante, Fahrbahn
  composite(c => {
    fillStroke(c, plan.roadAreas, COL.paved, COL.edge, mm(0.15));
    const strokeLine = (l, w, col) => {
      c.beginPath();
      l.lv.forEach(([e, n], i) => i ? c.lineTo(X(e), Y(n)) : c.moveTo(X(e), Y(n)));
      c.lineWidth = w; c.strokeStyle = col; c.stroke();
    };
    const edge = mm(0.18), curb = mm(0.12);
    for (const l of plan.roadLines) strokeLine(l, l.outerW * pxPerM + 2 * edge, COL.edge);
    for (const l of plan.roadLines) strokeLine(l, l.outerW * pxPerM,
      l.innerW || l.kind === 'foot' ? COL.sidewalk : COL.carriage);
    for (const l of plan.roadLines) if (l.innerW) strokeLine(l, l.innerW * pxPerM + 2 * curb, COL.curb);
    for (const l of plan.roadLines) if (l.innerW) strokeLine(l, l.innerW * pxPerM, COL.carriage);
  }, o.texture ? makePattern(ctx, dpi, 'paving') : null);

  // Schatten von Gebäuden und Bäumen
  if (o.shadow) {
    composite(c => {
      c.fillStyle = COL.shadow;
      for (const b of plan.buildings) {
        const len = b.height * SHADOW_FACTOR * pxPerM;
        const dx = sun.shadow[0] * len, dy = -sun.shadow[1] * len;
        const ring = b.poly[0];
        c.beginPath(); traceRing(c, ring, dx, dy); c.fill();
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], q = ring[i + 1];
          c.beginPath();
          c.moveTo(X(a[0]), Y(a[1])); c.lineTo(X(q[0]), Y(q[1]));
          c.lineTo(X(q[0]) + dx, Y(q[1]) + dy); c.lineTo(X(a[0]) + dx, Y(a[1]) + dy);
          c.closePath(); c.fill();
        }
      }
      for (const t of plan.trees) {
        const len = t.h * SHADOW_FACTOR * 0.8 * pxPerM;
        c.beginPath();
        c.arc(X(t.e) + sun.shadow[0] * len, Y(t.n) - sun.shadow[1] * len, t.d / 2 * pxPerM, 0, Math.PI * 2);
        c.fill();
      }
    }, null, 0.2);
  }

  // Parzellen
  fillStroke(ctx, plan.parcels, null, COL.parcel, mm(0.1));

  // Bäume
  for (const t of plan.trees) {
    const r = t.d / 2 * pxPerM;
    if (o.detail) drawTreeDetailed(ctx, X(t.e), Y(t.n), r, t.seed, mm, sun);
    else drawTreeSimple(ctx, X(t.e), Y(t.n), r, mm);
  }

  // Gebäude
  for (const b of plan.buildings) {
    if (o.roof) {
      ctx.save();
      ctx.beginPath(); tracePoly(ctx, b.poly); ctx.clip('evenodd');
      for (const f of b.roof.faces) {
        ctx.beginPath(); traceRing(ctx, f.poly);
        ctx.fillStyle = roofShade(f.dir, sun);
        ctx.fill();
      }
      ctx.strokeStyle = '#3d3d3b';
      ctx.lineWidth = mm(0.13);
      for (const [a, q] of b.roof.lines) {
        ctx.beginPath(); ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(q[0]), Y(q[1])); ctx.stroke();
      }
      if (b.roof.inset) {
        ctx.strokeStyle = '#6a6a67';
        ctx.lineWidth = mm(0.1);
        ctx.beginPath(); traceRing(ctx, b.roof.inset); ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath(); tracePoly(ctx, b.poly);
      ctx.strokeStyle = '#000'; ctx.lineWidth = mm(0.3); ctx.stroke();
    } else {
      ctx.beginPath(); tracePoly(ctx, b.poly);
      ctx.fillStyle = '#000'; ctx.fill('evenodd');
      ctx.strokeStyle = '#000'; ctx.lineWidth = mm(0.1); ctx.stroke();
    }
  }

  // Parzellennummern
  if (plan.labels.length) {
    ctx.font = `italic 500 ${mm(2.2)}px Archivo, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of plan.labels) {
      const x = X(l.e), y = Y(l.n);
      ctx.lineWidth = mm(0.6);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(l.text, x, y);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillText(l.text, x, y);
    }
  }

  // Rahmen, Nordpfeil, Massstab, Quelle
  ctx.strokeStyle = '#000';
  ctx.lineWidth = mm(0.35);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  drawNorthArrow(ctx, W - mm(10), mm(12), mm);
  drawScaleBar(ctx, plan.scale, W - mm(6), H - mm(6), pxPerM, mm);

  ctx.font = `400 ${mm(1.6)}px Archivo, Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#333';
  const roofNote = o.roof ? ' Dachaufsicht schematisch.' : '';
  ctx.fillText(
    `Situation 1:${plan.scale}, LV95. Daten: © swisstopo, © OpenStreetMap-Mitwirkende.${roofNote}`,
    mm(4), H - mm(4)
  );
}

function roofShade(dir, sun) {
  if (!dir) return 'rgb(245,245,243)';
  const dot = dir[0] * sun.toSun[0] + dir[1] * sun.toSun[1];
  const v = Math.round(233 + 17 * dot);
  return `rgb(${v},${v},${v - 2})`;
}

function drawTreeSimple(c, x, y, r, mm) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = 'rgba(120, 160, 105, 0.35)';
  c.fill();
  c.strokeStyle = COL.treeEdge;
  c.lineWidth = mm(0.13);
  c.stroke();
  c.beginPath();
  c.arc(x, y, mm(0.25), 0, Math.PI * 2);
  c.fillStyle = COL.treeEdge;
  c.fill();
}

function drawTreeDetailed(c, x, y, r, seed, mm, sun) {
  const rnd = mulberry32(seed);
  const lobes = 6 + Math.floor(rnd() * 4), ph = rnd() * Math.PI * 2;
  const crown = (rad, amp) => {
    c.beginPath();
    for (let i = 0; i <= 90; i++) {
      const a = i / 90 * Math.PI * 2;
      const k = rad * (1 - amp + amp * Math.abs(Math.cos(lobes * a / 2 + ph)));
      const px = x + Math.cos(a) * k, py = y + Math.sin(a) * k;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
  };
  // Lichtpunkt zur Sonne hin
  const hx = x + sun.toSun[0] * r * 0.3, hy = y - sun.toSun[1] * r * 0.3;
  const g = c.createRadialGradient(hx, hy, r * 0.1, x, y, r);
  g.addColorStop(0, 'rgba(204, 222, 186, 0.93)');
  g.addColorStop(1, 'rgba(146, 178, 128, 0.93)');
  crown(r, 0.12);
  c.fillStyle = g; c.fill();
  c.strokeStyle = COL.treeEdge; c.lineWidth = mm(0.13); c.stroke();

  crown(r * 0.6, 0.2);
  c.strokeStyle = 'rgba(79, 111, 69, 0.4)'; c.lineWidth = mm(0.08); c.stroke();

  const nb = 5 + Math.floor(rnd() * 3);
  c.strokeStyle = 'rgba(66, 94, 56, 0.55)';
  c.lineWidth = mm(0.1);
  for (let i = 0; i < nb; i++) {
    const a = ph + i * Math.PI * 2 / nb + (rnd() - 0.5) * 0.5;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + Math.cos(a + 0.2) * r * 0.4, y + Math.sin(a + 0.2) * r * 0.4,
      x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
    c.stroke();
  }
  c.beginPath();
  c.arc(x, y, Math.max(mm(0.35), r * 0.07), 0, Math.PI * 2);
  c.fillStyle = '#3f5a37';
  c.fill();
}

function drawNorthArrow(ctx, cx, cy, mm) {
  const h = mm(9), w = mm(3.2);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(cx, cy, mm(6.5), 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2); ctx.lineTo(cx + w / 2, cy + h / 2); ctx.lineTo(cx, cy + h / 4);
  ctx.closePath(); ctx.fillStyle = '#000'; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2); ctx.lineTo(cx - w / 2, cy + h / 2); ctx.lineTo(cx, cy + h / 4);
  ctx.closePath(); ctx.strokeStyle = '#000'; ctx.lineWidth = mm(0.2); ctx.stroke();
  ctx.font = `700 ${mm(2.6)}px Archivo, Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('N', cx, cy - h / 2 - mm(0.3));
  ctx.restore();
}

function niceLength(target) {
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [5, 2, 1]) if (m * p <= target) return m * p;
  return p;
}

function drawScaleBar(ctx, scale, right, bottom, pxPerM, mm) {
  const meters = niceLength(40 * scale / 1000);
  const len = meters * pxPerM;
  const h = mm(1.4);
  const x0 = right - len, y0 = bottom - h;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(x0 - mm(2), y0 - mm(5), len + mm(4), h + mm(7));
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(x0 + i * len / 4, y0, len / 4, h);
  }
  ctx.strokeStyle = '#000'; ctx.lineWidth = mm(0.2); ctx.strokeRect(x0, y0, len, h);
  ctx.fillStyle = '#000';
  ctx.font = `500 ${mm(2)}px Archivo, Arial, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left'; ctx.fillText('0', x0, y0 - mm(0.6));
  ctx.textAlign = 'right'; ctx.fillText(`${meters} m`, x0 + len, y0 - mm(0.6));
  ctx.restore();
}

function renderPreview() {
  const plan = state.plan;
  if (!plan) return;
  const widthM = plan.bbox[2] - plan.bbox[0];
  const avail = (ui.planView.clientWidth || ui.mapView.clientWidth || 1000) - 48;
  const target = Math.min(avail, 1600) * (window.devicePixelRatio || 1);
  const dpi = clamp(target / (widthM / plan.scale / 0.0254), 30, 300);
  drawPlan(ui.preview, plan, dpi, renderOpts());
  ui.preview.hidden = false;
  ui.planEmpty.hidden = true;
}

/* =========================================================
   Export
   ========================================================= */

function fileBase() {
  const p = state.plan;
  const e = Math.round((p.bbox[0] + p.bbox[2]) / 2), n = Math.round((p.bbox[1] + p.bbox[3]) / 2);
  return `lageplan_${e}_${n}_1-${p.scale}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

ui.btnPng.addEventListener('click', () => {
  const plan = state.plan;
  if (!plan) return;
  let dpi = +ui.dpi.value;
  const ppm = d => d / 0.0254 / plan.scale;
  const w = plan.bbox[2] - plan.bbox[0], h = plan.bbox[3] - plan.bbox[1];
  // Browser-Grenzen (inkl. Zwischenebene) einhalten
  const MAX_SIDE = 16000, MAX_AREA = 8e7;
  const factor = Math.min(1,
    MAX_SIDE / (w * ppm(dpi)), MAX_SIDE / (h * ppm(dpi)),
    Math.sqrt(MAX_AREA / (w * h * ppm(dpi) ** 2)));
  if (factor < 1) {
    dpi = Math.floor(dpi * factor);
    setStatus(`Ausschnitt sehr gross: PNG wird mit ${dpi} dpi erzeugt.`);
  }
  const c = document.createElement('canvas');
  drawPlan(c, plan, dpi, renderOpts());
  c.toBlob(blob => download(blob, fileBase() + '.png'), 'image/png');
});

ui.btnDxf.addEventListener('click', async () => {
  if (!state.plan) return;
  setStatus('Erzeuge DXF …');
  ui.btnDxf.disabled = true;
  await nextFrame();
  try {
    const dxf = buildDXF(state.plan, renderOpts());
    download(new Blob([dxf], { type: 'application/dxf' }), fileBase() + '.dxf');
    setStatus('DXF erzeugt.');
  } catch (err) {
    console.error(err);
    setStatus('DXF-Fehler: ' + err.message, true);
  } finally {
    ui.btnDxf.disabled = false;
  }
});

/* ---------- Flächen für DXF ---------- */

function roadOutlines(plan) {
  const outer = [...plan.roadAreas], inner = [];
  const buf = (coords, w, target) => {
    try {
      const b = turf.buffer(turf.lineString(coords), w / 2, { units: 'meters', steps: 6 });
      if (b) collectPolys({ type: b.geometry.type, coordinates: projectCoords(b.geometry.coordinates) }, target);
    } catch (e) { /* überspringen */ }
  };
  for (const l of plan.roadLines) {
    buf(l.wgs, l.outerW, outer);
    if (l.innerW) buf(l.wgs, l.innerW, inner);
  }
  return {
    outer: clipPolys(unionAll(outer), plan.bbox),
    inner: clipPolys(unionAll(inner), plan.bbox)
  };
}

function shadowPolys(plan, sun) {
  const all = [];
  for (const b of plan.buildings) {
    const len = b.height * SHADOW_FACTOR;
    const dx = sun.shadow[0] * len, dy = sun.shadow[1] * len;
    const ring = b.poly[0];
    const parts = [ring, ring.map(([x, y]) => [x + dx, y + dy])];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], q = ring[i + 1];
      const cross = (q[0] - a[0]) * dy - (q[1] - a[1]) * dx;
      if (Math.abs(cross) < 1e-6) continue;
      parts.push([a, q, [q[0] + dx, q[1] + dy], [a[0] + dx, a[1] + dy], a]);
    }
    all.push(...unionAll(parts.map(r => [r])));
  }
  return clipPolys(unionAll(all), plan.bbox);
}

function clipSegment(a, b, bbox) {
  try {
    const f = turf.bboxClip(turf.lineString([a, b]), bbox);
    const c = f.geometry.coordinates;
    if (f.geometry.type === 'LineString' && c.length >= 2) return [c[0], c[c.length - 1]];
  } catch (e) { /* ignorieren */ }
  return null;
}

/* ---------- DXF (R12, ASCII, Koordinaten in LV95 / Meter) ---------- */
function buildDXF(plan, o) {
  const out = [];
  const g = (code, val) => out.push(String(code), String(val));
  const f = v => v.toFixed(3);
  const bbox = plan.bbox;
  const [minE, minN, maxE, maxN] = bbox;
  const sun = sunVectors(o.sun);

  const layers = [
    ['RAHMEN', 7], ['GEBAEUDE', 7], ['GEBAEUDE_FUELLUNG', 7], ['DACH', 8],
    ['SCHATTEN', 9], ['SCHATTEN_FUELLUNG', 254],
    ['STRASSE_RAND', 8], ['TROTTOIRKANTE', 9],
    ['GRUEN', 3], ['WALD', 94], ['WASSER', 5], ['BAEUME', 94],
    ['PARZELLEN', 7], ['PARZELLEN_NR', 7]
  ];

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
  g(9, '$EXTMIN'); g(10, f(minE)); g(20, f(minN)); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, f(maxE)); g(20, f(maxN)); g(30, '0.0');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [name, color] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, '0.0'); g(41, '1.0'); g(50, '0.0');
  g(71, 0); g(42, '2.5'); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');

  const pline = (layer, ring) => {
    const pts = samePt(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
    if (pts.length < 2) return;
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(70, 1);
    for (const [x, y] of pts) {
      g(0, 'VERTEX'); g(8, layer); g(10, f(x)); g(20, f(y)); g(30, '0.0');
    }
    g(0, 'SEQEND'); g(8, layer);
  };
  const line = (layer, a, b) => {
    g(0, 'LINE'); g(8, layer);
    g(10, f(a[0])); g(20, f(a[1])); g(30, '0.0');
    g(11, f(b[0])); g(21, f(b[1])); g(31, '0.0');
  };
  // Füllung über Dreiecke (SOLID), da R12 keine Schraffur kennt
  const solids = (layer, poly) => {
    const ox = poly[0][0][0], oy = poly[0][0][1];
    const flat = [], holes = [];
    poly.forEach((ring, i) => {
      if (i) holes.push(flat.length / 2);
      const r = samePt(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
      for (const [x, y] of r) flat.push(x - ox, y - oy);
    });
    const tri = earcut(flat, holes.length ? holes : null);
    const P = k => [flat[2 * k] + ox, flat[2 * k + 1] + oy];
    for (let i = 0; i < tri.length; i += 3) {
      const A = P(tri[i]), B = P(tri[i + 1]), C = P(tri[i + 2]);
      g(0, 'SOLID'); g(8, layer);
      g(10, f(A[0])); g(20, f(A[1])); g(30, '0.0');
      g(11, f(B[0])); g(21, f(B[1])); g(31, '0.0');
      g(12, f(C[0])); g(22, f(C[1])); g(32, '0.0');
      g(13, f(C[0])); g(23, f(C[1])); g(33, '0.0');
    }
  };

  pline('RAHMEN', [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]]);

  const greens = kind => clipPolys(plan.green.filter(x => x.kind === kind).map(x => x.poly), bbox);
  for (const p of greens('grass')) p.forEach(r => pline('GRUEN', r));
  for (const p of greens('forest')) p.forEach(r => pline('WALD', r));
  for (const p of greens('water')) p.forEach(r => pline('WASSER', r));

  if (plan.roadLines.length || plan.roadAreas.length) {
    const roads = roadOutlines(plan);
    for (const p of roads.outer) p.forEach(r => pline('STRASSE_RAND', r));
    for (const p of roads.inner) p.forEach(r => pline('TROTTOIRKANTE', r));
  }

  for (const p of plan.parcels) p.forEach(r => pline('PARZELLEN', r));

  if (o.shadow && plan.buildings.length) {
    for (const p of shadowPolys(plan, sun)) {
      p.forEach(r => pline('SCHATTEN', r));
      solids('SCHATTEN_FUELLUNG', p);
    }
  }

  for (const b of plan.buildings) {
    const clipped = clipPolys([b.poly], bbox);
    for (const p of clipped) {
      p.forEach(r => pline('GEBAEUDE', r));
      if (!o.roof) solids('GEBAEUDE_FUELLUNG', p);
    }
    if (o.roof && clipped.length) {
      for (const [a, q] of b.roof.lines) {
        const s = clipSegment(a, q, bbox);
        if (s) line('DACH', s[0], s[1]);
      }
      if (b.roof.inset) for (const p of clipPolys([[b.roof.inset]], bbox)) p.forEach(r => pline('DACH', r));
    }
  }

  for (const t of plan.trees) {
    if (t.e < minE || t.e > maxE || t.n < minN || t.n > maxN) continue;
    g(0, 'CIRCLE'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0'); g(40, f(t.d / 2));
    g(0, 'POINT'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0');
  }

  const textH = 2.2 * plan.scale / 1000;
  for (const l of plan.labels) {
    g(0, 'TEXT'); g(8, 'PARZELLEN_NR');
    g(10, f(l.e)); g(20, f(l.n)); g(30, '0.0');
    g(40, f(textH)); g(1, asciiSafe(l.text));
    g(72, 1); g(73, 2);
    g(11, f(l.e)); g(21, f(l.n)); g(31, '0.0');
  }

  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

/* ---------- Hilfsfunktionen ---------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function nextFrame() { return new Promise(r => requestAnimationFrame(() => r())); }
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }
function asciiSafe(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?');
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

applyStylePreset();
updatePerimeter();
