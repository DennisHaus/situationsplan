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

const RE_LANDUSE = '^(grass|meadow|recreation_ground|village_green|forest|orchard|allotments|cemetery|vineyard|flowerbed)$';
const RE_LEISURE = '^(park|garden|playground|dog_park)$';
const RE_NATURAL = '^(wood|scrub|grassland|heath)$';

const SKIP_HIGHWAY = new Set([
  'proposed', 'construction', 'platform', 'bus_stop', 'elevator', 'corridor',
  'abandoned', 'razed', 'raceway', 'via_ferrata', 'escape', 'emergency_bay'
]);

// Geschätzte Strassenbreiten in Metern, falls OSM keine width hat
const ROAD_WIDTH = {
  motorway: 11, trunk: 10, primary: 9, secondary: 8, tertiary: 7,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  unclassified: 5.5, residential: 6, living_street: 5, road: 5,
  service: 4, pedestrian: 6, track: 3,
  footway: 2, cycleway: 2.5, path: 1.5, bridleway: 2, steps: 2
};

const DEFAULT_TREE_CROWN = 6; // m

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const ui = {
  width: $('width'), height: $('height'), scale: $('scale'), dpi: $('dpi'),
  btnGenerate: $('btnGenerate'), btnPng: $('btnPng'), btnDxf: $('btnDxf'),
  status: $('status'), preview: $('preview'), planEmpty: $('planEmpty'),
  tabMap: $('tabMap'), tabPlan: $('tabPlan'), mapView: $('map'), planView: $('planView')
};
const layerOn = id => $(id).checked;

const state = {
  center: toLV([8.5417, 47.3769]), // Zürich
  plan: null
};

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
[ui.width, ui.height, ui.scale].forEach(el => el.addEventListener('change', () => {
  updatePerimeter();
  invalidatePlan();
}));

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
  way["landuse"~"${RE_LANDUSE}"]${b};
  relation["type"="multipolygon"]["landuse"~"${RE_LANDUSE}"]${b};
  way["leisure"~"${RE_LEISURE}"]${b};
  relation["type"="multipolygon"]["leisure"~"${RE_LEISURE}"]${b};
  way["natural"~"${RE_NATURAL}"]${b};
  relation["type"="multipolygon"]["natural"~"${RE_NATURAL}"]${b};
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

function roadWidth(t) {
  const w = parseFloat(t.width);
  if (w >= 1 && w <= 40) return w;
  let base = ROAD_WIDTH[t.highway] || 4;
  const lanes = parseInt(t.lanes, 10);
  if (lanes > 0) base = Math.max(base, lanes * 3.2);
  return base;
}

const isUnderground = t =>
  (t.tunnel && t.tunnel !== 'no') || (t.layer && parseFloat(t.layer) < 0) ||
  t.location === 'underground' || t.indoor === 'yes';

const isGreen = t =>
  new RegExp(RE_LANDUSE).test(t.landuse || '') ||
  new RegExp(RE_LEISURE).test(t.leisure || '') ||
  new RegExp(RE_NATURAL).test(t.natural || '');

function classify(osm) {
  const out = { buildings: [], roadLines: [], roadAreas: [], green: [], trees: [] };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') out.trees.push({ lon: el.lon, lat: el.lat, tags: t });
      continue;
    }
    if (t.building && t.building !== 'no') {
      if (!isUnderground(t)) out.buildings.push(...elementToPolygons(el));
      continue;
    }
    if (t['area:highway']) { out.roadAreas.push(...elementToPolygons(el)); continue; }
    if (t.highway && el.type === 'way') {
      if (SKIP_HIGHWAY.has(t.highway) || isUnderground(t)) continue;
      if (t.area === 'yes') { out.roadAreas.push(...elementToPolygons(el)); continue; }
      const c = wayCoords(el);
      if (c.length >= 2) out.roadLines.push({ coords: c, width: roadWidth(t) });
      continue;
    }
    if (isGreen(t)) out.green.push(...elementToPolygons(el));
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

// GeoJSON-Geometrie in eine Liste von Polygonen (Ringe) zerlegen
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
    const fc = turf.featureCollection(polys.map(p => turf.polygon(p)));
    const u = turf.union(fc);
    const res = [];
    if (u) collectPolys(u.geometry, res);
    return res;
  } catch (e) {
    console.warn('Vereinigung der Strassenflächen fehlgeschlagen, verwende Einzelflächen.', e);
    return polys;
  }
}

function labelPoint(poly) {
  try {
    const pt = turf.pointOnFeature(turf.polygon(poly));
    return pt.geometry.coordinates;
  } catch (e) {
    return null;
  }
}

function planarArea(poly) {
  const ring = poly[0];
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
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
    // Etwas grösserer Abfragebereich, damit Strassen am Rand sauber gepuffert werden
    const pad = 60;
    const fetchCorners = [
      [bbox[0] - pad, bbox[1] - pad], [bbox[2] + pad, bbox[1] - pad],
      [bbox[2] + pad, bbox[3] + pad], [bbox[0] - pad, bbox[3] + pad]
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
    const plan = { bbox, scale, opts, buildings: [], roads: [], green: [], trees: [], parcels: [], labels: [] };

    if (opts.buildings) plan.buildings = clipPolys(data.buildings.map(projPoly), bbox);
    if (opts.green) plan.green = clipPolys(data.green.map(projPoly), bbox);

    if (opts.roads) {
      const roadPolys = data.roadAreas.map(projPoly);
      for (const l of data.roadLines) {
        try {
          const buf = turf.buffer(turf.lineString(l.coords), l.width / 2, { units: 'meters', steps: 6 });
          if (buf) collectPolys({ type: buf.geometry.type, coordinates: projectCoords(buf.geometry.coordinates) }, roadPolys);
        } catch (e) { /* überspringen */ }
      }
      setStatus(`Vereinige ${roadPolys.length} Strassenflächen …`);
      await nextFrame();
      plan.roads = clipPolys(unionAll(roadPolys), bbox);
    }

    if (opts.trees) {
      for (const t of data.trees) {
        const [e, n] = toLV([t.lon, t.lat]);
        if (e < bbox[0] || e > bbox[2] || n < bbox[1] || n > bbox[3]) continue;
        const d = parseFloat(t.tags.diameter_crown);
        plan.trees.push({ e, n, d: d > 0.5 && d < 40 ? d : DEFAULT_TREE_CROWN });
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
      `${plan.parcels.length} Parzellenflächen.`;
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

function drawPlan(canvas, plan, dpi) {
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

  const tracePoly = poly => {
    for (const ring of poly) {
      ring.forEach(([e, n], i) => i ? ctx.lineTo(X(e), Y(n)) : ctx.moveTo(X(e), Y(n)));
      ctx.closePath();
    }
  };
  const fillPolys = (polys, fill, stroke, lw) => {
    for (const p of polys) {
      ctx.beginPath();
      tracePoly(p);
      if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    }
  };

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Grünflächen
  fillPolys(plan.green, '#dde9d4', '#9cb894', mm(0.13));

  // Strassen: erst alle Flächen, dann alle Ränder
  fillPolys(plan.roads, '#e8e8e5', null, 0);
  fillPolys(plan.roads, null, '#555a57', mm(0.18));

  // Parzellen
  fillPolys(plan.parcels, null, '#2b2b2b', mm(0.1));

  // Bäume
  for (const t of plan.trees) {
    ctx.beginPath();
    ctx.arc(X(t.e), Y(t.n), (t.d / 2) * pxPerM, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(78, 122, 73, 0.22)';
    ctx.fill();
    ctx.strokeStyle = '#4e7a49';
    ctx.lineWidth = mm(0.13);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(t.e), Y(t.n), mm(0.25), 0, Math.PI * 2);
    ctx.fillStyle = '#4e7a49';
    ctx.fill();
  }

  // Gebäude im Schwarzplan
  fillPolys(plan.buildings, '#000000', '#000000', mm(0.1));

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

  // Rahmen
  ctx.strokeStyle = '#000';
  ctx.lineWidth = mm(0.35);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);

  drawNorthArrow(ctx, W - mm(10), mm(12), mm);
  drawScaleBar(ctx, plan.scale, W - mm(6), H - mm(6), pxPerM, mm);

  // Quellenangabe
  ctx.font = `400 ${mm(1.6)}px Archivo, Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#333';
  ctx.fillText(
    `Situation 1:${plan.scale}, LV95. Daten: © swisstopo, © OpenStreetMap-Mitwirkende`,
    mm(4), H - mm(4)
  );
}

function drawNorthArrow(ctx, cx, cy, mm) {
  const h = mm(9), w = mm(3.2);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, mm(6.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy + h / 2);
  ctx.lineTo(cx, cy + h / 4);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - w / 2, cy + h / 2);
  ctx.lineTo(cx, cy + h / 4);
  ctx.closePath();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = mm(0.2);
  ctx.stroke();
  ctx.font = `700 ${mm(2.6)}px Archivo, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', cx, cy - h / 2 - mm(0.3));
  ctx.restore();
}

function niceLength(target) {
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [5, 2, 1]) if (m * p <= target) return m * p;
  return p;
}

function drawScaleBar(ctx, scale, right, bottom, pxPerM, mm) {
  const meters = niceLength(40 * scale / 1000); // ca. 40 mm auf Papier
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
  ctx.strokeStyle = '#000';
  ctx.lineWidth = mm(0.2);
  ctx.strokeRect(x0, y0, len, h);
  ctx.fillStyle = '#000';
  ctx.font = `500 ${mm(2)}px Archivo, Arial, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('0', x0, y0 - mm(0.6));
  ctx.textAlign = 'right';
  ctx.fillText(`${meters} m`, x0 + len, y0 - mm(0.6));
  ctx.restore();
}

function renderPreview() {
  const plan = state.plan;
  if (!plan) return;
  const widthM = plan.bbox[2] - plan.bbox[0];
  const target = Math.min(ui.planView.clientWidth - 48, 1600) * (window.devicePixelRatio || 1);
  const dpi = clamp(target / (widthM / plan.scale / 0.0254), 30, 300);
  drawPlan(ui.preview, plan, dpi);
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
  const pxPerMAt = d => d / 0.0254 / plan.scale;
  const w = (plan.bbox[2] - plan.bbox[0]), h = (plan.bbox[3] - plan.bbox[1]);
  // Browser-Grenzen für Canvas-Grösse einhalten
  const MAX_SIDE = 16000, MAX_AREA = 1.2e8;
  const factor = Math.min(1,
    MAX_SIDE / (w * pxPerMAt(dpi)), MAX_SIDE / (h * pxPerMAt(dpi)),
    Math.sqrt(MAX_AREA / (w * h * pxPerMAt(dpi) ** 2)));
  if (factor < 1) {
    dpi = Math.floor(dpi * factor);
    setStatus(`Ausschnitt sehr gross: PNG wird mit ${dpi} dpi erzeugt.`);
  }
  const c = document.createElement('canvas');
  drawPlan(c, plan, dpi);
  c.toBlob(blob => download(blob, fileBase() + '.png'), 'image/png');
});

ui.btnDxf.addEventListener('click', () => {
  if (!state.plan) return;
  const dxf = buildDXF(state.plan);
  download(new Blob([dxf], { type: 'application/dxf' }), fileBase() + '.dxf');
});

/* ---------- DXF (R12, ASCII, Koordinaten in LV95 / Meter) ---------- */
function buildDXF(plan) {
  const out = [];
  const g = (code, val) => out.push(String(code), String(val));
  const f = v => v.toFixed(3);
  const [minE, minN, maxE, maxN] = plan.bbox;

  // Layername, ACI-Farbe
  const layers = [
    ['RAHMEN', 7], ['GEBAEUDE', 7], ['GEBAEUDE_FUELLUNG', 7],
    ['STRASSE_RAND', 8], ['GRUEN', 3], ['BAEUME', 94],
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

  for (const p of plan.green) p.forEach(r => pline('GRUEN', r));
  for (const p of plan.roads) p.forEach(r => pline('STRASSE_RAND', r));
  for (const p of plan.parcels) p.forEach(r => pline('PARZELLEN', r));
  for (const p of plan.buildings) {
    p.forEach(r => pline('GEBAEUDE', r));
    solids('GEBAEUDE_FUELLUNG', p);
  }
  for (const t of plan.trees) {
    g(0, 'CIRCLE'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0'); g(40, f(t.d / 2));
    g(0, 'POINT'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0');
  }
  const textH = 2.2 * plan.scale / 1000; // 2.2 mm auf Papier
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

updatePerimeter();
