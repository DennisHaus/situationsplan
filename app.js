'use strict';

/* =========================================================
   Lageplan-Generator
   Datenquellen: OpenStreetMap (Overpass API) und
   swisstopo / amtliche Vermessung (api3.geo.admin.ch)
   Läuft komplett im Browser (GitHub Pages tauglich).
   ========================================================= */

/* ---------- Freiwilliger Beitrag ----------
   PayPal-Spendenlink. Betrag und Währung werden angehängt; je nach Einstellung
   des Spendenbuttons übernimmt PayPal den Betrag oder man gibt ihn dort ein. */
const DONATE = {
  url: 'https://www.paypal.com/donate/?hosted_button_id=6L6ZGY48FR7A6',
  currency: 'EUR',
  amounts: [2, 5, 10, 50]
};

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
  grass: '#dce8cf', grassEdge: '#a6bf98', forest: '#aec59e', forestEdge: '#7e9d70',
  water: '#d0e2ec', waterDeep: '#b9d3e2', waterEdge: '#6f97ae', parcel: '#2b2b2b', ground: '#eeeeeb',
  treeEdge: '#4f6f45', shadow: '#1d2630'
};

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const ui = {
  width: $('width'), height: $('height'), scale: $('scale'), dpi: $('dpi'),
  style: $('style'), optRoof: $('optRoof'), optShadow: $('optShadow'), optTexture: $('optTexture'),
  optTerrain: $('optTerrain'), optGround: $('optGround'), sun: $('sun'),
  treeSize: $('treeSize'), treeVar: $('treeVar'),
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
    terrain: ui.optTerrain.checked,
    ground: ui.optGround.checked,
    treeSize: clamp(parseFloat(ui.treeSize.value) || 7, 2, 20),
    treeVar: clamp((parseFloat(ui.treeVar.value) || 0) / 100, 0, 1),
    sun: ui.sun.value
  };
}

function setStatus(msg, isError = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', isError);
}

/* ---------- Karte ---------- */
const map = L.map('map', { zoomControl: true }).setView([47.3769, 8.5417], 17);
const baseOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20, maxNativeZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
}).addTo(map);
const baseSwiss = L.tileLayer(
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
  { maxZoom: 20, maxNativeZoom: 18, attribution: '© swisstopo' }
);
L.control.layers({ 'OpenStreetMap': baseOsm, 'swisstopo grau (nur CH)': baseSwiss }, null, { position: 'topright' }).addTo(map);

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
  ui.optTerrain.checked = detail;
  setTreeStyle(detail ? 'flat_x' : 'circle');
}

function setTreeStyle(id) {
  treeStyle = id;
  const el = document.querySelector(`input[name="treeStyle"][value="${id}"]`);
  if (el) el.checked = true;
}

// Auswahl als Raster: Zeilen = Familien, Spalten = Varianten
function buildTreePicker() {
  const wrap = $('treeStyles');
  wrap.innerHTML = '';
  const dpr = window.devicePixelRatio || 1;
  const sun = sunVectors(ui.sun.value);
  wrap.appendChild(document.createElement('span'));
  for (const v of TREE_VARIANTS) {
    const h = document.createElement('span');
    h.className = 'tg-head';
    h.textContent = v.label;
    wrap.appendChild(h);
  }
  for (const fam of TREE_FAMILIES) {
    const row = document.createElement('span');
    row.className = 'tg-row';
    row.textContent = fam.label;
    const kind = document.createElement('span');
    kind.textContent = fam.kind;
    row.appendChild(kind);
    wrap.appendChild(row);
    for (const v of TREE_VARIANTS) {
      const id = v.id ? `${fam.id}_${v.id}` : fam.id;
      const lab = document.createElement('label');
      lab.className = 'tree-opt';
      lab.title = `${fam.label}, ${v.label}`;
      const inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'treeStyle'; inp.value = id;
      inp.checked = id === treeStyle;
      inp.setAttribute('aria-label', `${fam.label}, ${v.label}`);
      inp.addEventListener('change', () => { treeStyle = id; renderPreview(); });
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.round(48 * dpr);
      const c = cv.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, cv.width, cv.height);
      const r = 6, pxPerM = 19 * dpr / r;
      drawTree(c, id, cv.width / 2, cv.height / 2, r, 11, pxPerM, mmv => mmv * 3.4 * dpr, sun);
      lab.append(inp, cv);
      wrap.appendChild(lab);
    }
  }

  const extra = $('treeExtra');
  extra.innerHTML = '';
  for (const st of EXTRA_TREES) {
    const lab = document.createElement('label');
    lab.className = 'tree-opt';
    lab.title = st.label;
    const inp = document.createElement('input');
    inp.type = 'radio'; inp.name = 'treeStyle'; inp.value = st.id;
    inp.checked = st.id === treeStyle;
    inp.setAttribute('aria-label', st.label);
    inp.addEventListener('change', () => {
      treeStyle = st.id;
      if (st.id === 'custom' && !customTree.img) $('treeFile').click();
      renderPreview();
    });
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.round(48 * dpr);
    const c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    const r = 6, pxPerM = 19 * dpr / r;
    drawTree(c, st.id, cv.width / 2, cv.height / 2, r, 11, pxPerM, mmv => mmv * 3.4 * dpr, sun);
    const cap = document.createElement('span');
    cap.textContent = st.label;
    lab.append(inp, cv, cap);
    extra.appendChild(lab);
  }
}

/* ---------- Eigenes Baumsymbol ---------- */
const CUSTOM_KEY = 'lageplan.customTree';

function setCustomTreeImage(dataUrl, select) {
  const im = new Image();
  im.onload = () => {
    customTree.img = im;
    if (select) treeStyle = 'custom';
    buildTreePicker();
    renderPreview();
  };
  im.onerror = () => setStatus('Das Bild konnte nicht gelesen werden. Bitte PNG, JPG, WebP oder SVG verwenden.', true);
  im.src = dataUrl;
}

$('treeUpload').addEventListener('click', () => $('treeFile').click());
$('treeFile').addEventListener('change', ev => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > 15e6) { setStatus('Das Bild ist sehr gross (über 15 MB). Bitte eine kleinere Datei wählen.', true); return; }
  const rd = new FileReader();
  rd.onload = () => {
    const data = rd.result;
    try {
      localStorage.setItem(CUSTOM_KEY, data);
      setStatus('Eigenes Baumsymbol geladen und gespeichert.');
    } catch (e) {
      setStatus('Eigenes Baumsymbol geladen. Zu gross zum Speichern, es gilt bis zum Neuladen der Seite.');
    }
    setCustomTreeImage(data, true);
  };
  rd.readAsDataURL(file);
});
$('treeMultiply').addEventListener('change', e => { customTree.multiply = e.target.checked; buildTreePicker(); renderPreview(); });
$('treeRotate').addEventListener('change', e => { customTree.rotate = e.target.checked; renderPreview(); });
try {
  const saved = localStorage.getItem(CUSTOM_KEY);
  if (saved) setCustomTreeImage(saved, false);
} catch (e) { /* kein Speicher verfügbar */ }
ui.style.addEventListener('change', () => { applyStylePreset(); renderPreview(); });
[ui.optRoof, ui.optShadow, ui.optTexture, ui.optTerrain, ui.optGround, ui.treeSize].forEach(el => el.addEventListener('change', renderPreview));
ui.treeVar.addEventListener('input', () => { clearTimeout(ui.treeVar._t); ui.treeVar._t = setTimeout(renderPreview, 120); });
ui.optTerrain.addEventListener('change', () => {
  if (ui.optTerrain.checked && state.plan && !state.plan.terrain) setStatus('Für die Geländeschattierung den Plan neu erzeugen.');
});
ui.sun.addEventListener('change', () => { buildTreePicker(); renderPreview(); });
ui.optRoof.addEventListener('change', () => {
  if (ui.optRoof.checked && state.plan && !state.plan.roofsLoaded) {
    setStatus('Für echte Dachformen den Plan neu erzeugen.');
  }
});

/* ---------- Ortssuche: geo.admin.ch für die Schweiz, sonst OpenStreetMap (Nominatim) ---------- */
async function searchPlace(q) {
  try {
    const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer' +
      `?searchText=${encodeURIComponent(q)}&type=locations&limit=1&sr=4326`;
    const res = await fetch(url).then(r => r.json());
    const a = res.results && res.results[0] && res.results[0].attrs;
    if (a) return { lat: a.lat, lon: a.lon, label: stripTags(a.label || q) };
  } catch (e) { /* weiter mit Nominatim */ }
  const url = 'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=1&accept-language=de&q=${encodeURIComponent(q)}`;
  const res = await fetch(url).then(r => r.json());
  const hit = res && res[0];
  return hit ? { lat: +hit.lat, lon: +hit.lon, label: hit.display_name } : null;
}

$('searchForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  setStatus('Suche läuft …');
  try {
    const hit = await searchPlace(q);
    if (!hit) { setStatus(`Kein Treffer für «${q}».`, true); return; }
    state.center = toLV([hit.lon, hit.lat]);
    map.setView([hit.lat, hit.lon], 18);
    updatePerimeter();
    invalidatePlan();
    setStatus(hit.label);
  } catch (err) {
    setStatus('Suche fehlgeschlagen: ' + err.message, true);
  }
});

// Grobe Prüfung, ob der Ausschnitt in der Schweiz liegt (Rechteck der Landesvermessung).
// Ausserhalb werden die Schweizer Dienste (Parzellen, Dächer, Gelände) übersprungen.
function inSwitzerland([minE, minN, maxE, maxN]) {
  return minE < 2834000 && maxE > 2485000 && minN < 1296000 && maxN > 1075000;
}

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

// Zwischenspeicher: derselbe Ausschnitt wird beim erneuten Erzeugen nicht neu geladen.
// Fehlgeschlagene Abfragen werden nicht gespeichert.
const dataCache = new Map();
function cached(kind, box, loader) {
  const key = kind + ':' + box.map(v => Math.round(v * 100000) / 100000).join(',');
  if (dataCache.has(key)) return dataCache.get(key);
  const p = loader().catch(err => { dataCache.delete(key); throw err; });
  dataCache.set(key, p);
  if (dataCache.size > 24) dataCache.delete(dataCache.keys().next().value);
  return p;
}

async function fetchOverpass([s, w, n, e], hooks = {}) {
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
  way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"]${b};
  node["highway"="crossing"]${b};
  way["building:part"="arcade"]${b};
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
      return await readJsonWithProgress(r, hooks);
    } catch (err) {
      lastErr = err;
      if (hooks.onRetry) hooks.onRetry();
    }
  }
  throw new Error('OpenStreetMap-Server nicht erreichbar (' + (lastErr && lastErr.message) + ')');
}

// Antwort stückweise lesen, damit die empfangene Datenmenge angezeigt werden kann
async function readJsonWithProgress(r, hooks) {
  const total = +r.headers.get('Content-Length') || 0;
  if (hooks.onHeaders) hooks.onHeaders(total);
  if (!r.body || !r.body.getReader) return r.json();
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (hooks.onBytes) hooks.onBytes(received);
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

// Parzellen aus der amtlichen Vermessung über die geo.admin.ch Identify-API
async function fetchParcels(bbox, onPage) {
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
    if (onPage) onPage(page + 1);
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

// Dachflächen aus Sonnendach.ch (BFE): jede Dachfläche einzeln, mit Neigung und Ausrichtung.
// Der Dienst liefert höchstens 50 Flächen pro Anfrage. Damit das Blättern nicht
// nacheinander passiert, werden pro Zelle mehrere Seiten gleichzeitig vorausgeladen;
// sobald eine Seite nicht mehr voll ist, ist die Zelle fertig.
async function fetchRoofs(bbox, onProgress) {
  const LIMIT = 50, CELL = 100, AHEAD = 3, WORKERS = 8;
  const cells = [];
  for (let e = bbox[0]; e < bbox[2]; e += CELL) {
    for (let n = bbox[1]; n < bbox[3]; n += CELL) {
      cells.push({ box: [e, n, Math.min(e + CELL, bbox[2]), Math.min(n + CELL, bbox[3])], next: 0, end: Infinity });
    }
  }
  const queue = [];
  const enqueue = (cell, k = AHEAD) => { while (k-- > 0) queue.push({ cell, page: cell.next++ }); };
  cells.forEach(c => enqueue(c));
  const seen = new Map();
  let finished = 0, failed = 0, active = 0;

  const request = async ({ cell, page }) => {
    const [a, b, c, d] = cell.box.map(v => v.toFixed(1));
    const url = 'https://api3.geo.admin.ch/rest/services/all/MapServer/identify' +
      `?geometry=${a},${b},${c},${d}&geometryType=esriGeometryEnvelope` +
      '&layers=all:ch.bfe.solarenergie-eignung-daecher' +
      `&mapExtent=${a},${b},${c},${d}&imageDisplay=1000,1000,96&tolerance=0` +
      '&sr=2056&returnGeometry=true&geometryFormat=geojson' +
      `&limit=${LIMIT}&offset=${page * LIMIT}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const results = (await r.json()).results || [];
    let added = 0;
    for (const f of results) {
      const id = f.featureId != null ? f.featureId : f.id;
      if (!seen.has(id)) { seen.set(id, f); added++; }
    }
    // Eine nicht volle Seite markiert das Ende der Zelle. Volle Seiten ohne neue
    // Flächen heissen, dass der Dienst kein Blättern kann: dann ebenfalls Ende.
    if (results.length < LIMIT || (added === 0 && results.length)) cell.end = Math.min(cell.end, page);
    // letzte vorausgeladene Seite war voll: weitere Seiten nachschieben;
    // freie Abfrage-Plätze bekommt die Zelle, die noch Daten hat
    else if (page === cell.next - 1 && page < 200) enqueue(cell, Math.max(AHEAD, WORKERS - queue.length - active + 1));
  };

  const worker = async () => {
    for (;;) {
      let task = queue.shift();
      while (task && task.page > task.cell.end) task = queue.shift(); // Seiten hinter dem Ende überspringen
      if (!task) {
        if (active === 0) return;
        await new Promise(r => setTimeout(r, 25));
        continue;
      }
      active++;
      try { await request(task); } catch (e) { failed++; }
      active--;
      finished++;
      if (onProgress) {
        const open = cells.filter(c => c.end === Infinity).length;
        onProgress((cells.length - open) / cells.length * 0.7 + finished / (finished + queue.length + active) * 0.3, seen.size);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failed && failed === finished) throw new Error('Dachdaten nicht erreichbar');
  return [...seen.values()];
}

// Sonnendach: Ausrichtung 0° = Süd, -90° = Ost, 90° = West, ±180° = Nord.
// Daraus die Fallrichtung der Dachfläche als Vektor (Ost, Nord).
function roofFaceFrom(f) {
  const p = f.properties || f.attributes || {};
  const tilt = parseFloat(p.neigung);
  const az = parseFloat(p.ausrichtung);
  const pitched = isFinite(tilt) && tilt > 5 && isFinite(az);
  const rad = az * Math.PI / 180;
  const polys = [];
  collectPolys(f.geometry, polys);
  const bid = p.building_id != null ? 'b' + p.building_id : 'f' + (f.featureId != null ? f.featureId : f.id);
  return polys.map(poly => {
    const ring = poly[0];
    let cx = 0, cy = 0;
    for (const q of ring) { cx += q[0]; cy += q[1]; }
    return {
      poly: poly.map(r => r.map(q => [q[0], q[1]])),
      tilt: isFinite(tilt) ? tilt : null,
      dir: pitched ? [-Math.sin(rad), -Math.cos(rad)] : null,
      bid, c: [cx / ring.length, cy / ring.length]
    };
  });
}

function isZebra(t) {
  return t.crossing === 'zebra' || t.crossing_ref === 'zebra' || t.crossing === 'marked' ||
    t.crossing === 'uncontrolled' || (t['crossing:markings'] && t['crossing:markings'] !== 'no');
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
  (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || (t.layer && parseFloat(t.layer) < 0) ||
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
  return {
    kind, rank, outerW: w + sw, innerW: sw ? w : 0, hw,
    name: t.name || '',
    oneway: t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout',
    passage: t.covered === 'arcade' || t.tunnel === 'building_passage' || (kind === 'foot' && t.covered === 'yes')
  };
}

function classify(osm) {
  const out = { buildings: [], roadLines: [], roadAreas: [], green: [], trees: [], rails: [], crossings: [], arcades: [] };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') out.trees.push({ lon: el.lon, lat: el.lat, tags: t });
      else if (t.highway === 'crossing') out.crossings.push({ id: el.id, tags: t });
      continue;
    }
    if (t.railway && el.type === 'way') {
      if (!isUnderground(t) && /^(rail|tram|light_rail|narrow_gauge)$/.test(t.railway)) {
        out.rails.push({ coords: wayCoords(el), kind: t.railway });
      }
      continue;
    }
    if (t['building:part'] === 'arcade') { out.arcades.push(...elementToPolygons(el)); continue; }
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
      if (c.length >= 2) out.roadLines.push({ coords: c, tags: t, nodes: el.nodes || [] });
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

// Polylinie seitlich um d versetzen (für Gleise und Laubenränder)
function offsetPolyline(pts, d) {
  const n = pts.length;
  if (n < 2) return pts;
  const nrm = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    nrm.push([-dy / len, dx / len]);
  }
  return pts.map((p, i) => {
    const a = nrm[Math.max(0, i - 1)], b = nrm[Math.min(n - 2, i)];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = d / Math.max(0.3, mx * b[0] + my * b[1]);
    return [p[0] + mx * k, p[1] + my * k];
  });
}

function clipLine(pts, bbox) {
  try {
    const g = turf.bboxClip(turf.lineString(pts), bbox).geometry;
    if (g.type === 'LineString') return g.coordinates.length >= 2 ? [g.coordinates] : [];
    return g.coordinates.filter(c => c.length >= 2);
  } catch (e) { return []; }
}

// Positionen für Strassennamen: lange, fast gerade Abschnitte, ein Name pro ca. 7 cm Papier
function streetLabels(plan) {
  const h = 2.1 * plan.scale / 1000;
  const [minE, minN, maxE, maxN] = plan.bbox;
  const m = h * 2;
  const cands = [];
  for (const l of plan.roadLines) {
    if (!l.name || (l.kind === 'foot' && l.hw !== 'pedestrian')) continue;
    const need = l.name.length * 0.56 * h * 1.25;
    const pts = l.lv;
    let s = 0;
    while (s < pts.length - 1) {
      const a0 = Math.atan2(pts[s + 1][1] - pts[s][1], pts[s + 1][0] - pts[s][0]);
      let e = s + 1;
      while (e < pts.length - 1) {
        const a1 = Math.atan2(pts[e + 1][1] - pts[e][1], pts[e + 1][0] - pts[e][0]);
        let d = Math.abs(a1 - a0);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > 0.18) break;
        e++;
      }
      const A = pts[s], B = pts[e];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      if (len >= need && mid[0] > minE + m && mid[0] < maxE - m && mid[1] > minN + m && mid[1] < maxN - m) {
        let ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang <= -Math.PI / 2) ang += Math.PI;
        cands.push({ name: l.name, e: mid[0], n: mid[1], ang, len, need });
      }
      s = e;
    }
  }
  cands.sort((a, b) => b.len - a.len);
  const out = [];
  for (const c of cands) {
    if (out.some(o => o.name === c.name && Math.hypot(o.e - c.e, o.n - c.n) < 0.07 * plan.scale)) continue;
    if (out.some(o => Math.hypot(o.e - c.e, o.n - c.n) < (o.need + c.need) / 2)) continue;
    out.push(c);
  }
  return out;
}

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
  progress.start('Lade Daten');
  let ticker = null;

  try {
    const pad = 60;
    const padBox = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
    const roofBox = [bbox[0] - 25, bbox[1] - 25, bbox[2] + 25, bbox[3] + 25];
    const wgsBox = wgsBounds(padBox);

    const needOsm = opts.buildings || opts.roads || opts.green || opts.trees;
    const swiss = inSwitzerland(bbox);
    const needParcels = swiss && (opts.parcels || opts.parcelNr);
    const needRoofs = swiss && opts.buildings && ui.optRoof.checked;
    const needTerrain = swiss && opts.green && ui.optTerrain.checked;
    setStatus('');

    // Ladefortschritt. Overpass meldet keine Gesamtgrösse, daher dort eine Schätzung
    // aus Wartezeit und empfangener Datenmenge; Parzellen und Dächer zählen echt.
    const load = {
      phase: 'wait', t0: performance.now(), received: 0, total: 0,
      pages: 0, roofFrac: 0, roofCount: 0, terrFrac: 0,
      osmDone: !needOsm, parcDone: !needParcels, roofDone: !needRoofs, terrDone: !needTerrain
    };
    const areaHa = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / 1e4;
    const expectedBytes = Math.max(4e5, areaHa * 2.5e5);
    const tick = () => {
      let o = 1;
      if (!load.osmDone) {
        if (load.phase === 'wait') o = 0.4 * (1 - Math.exp(-(performance.now() - load.t0) / 12000));
        else o = Math.min(0.98, 0.4 + 0.6 * (load.total ? load.received / load.total : 1 - Math.exp(-load.received / expectedBytes)));
      }
      const p = load.parcDone ? 1 : Math.min(0.9, 0.15 + load.pages * 0.3);
      const r = load.roofDone ? 1 : load.roofFrac;
      const parts = [];
      if (needOsm) parts.push([0.55, o]);
      if (needParcels) parts.push([0.15, p]);
      if (needRoofs) parts.push([0.3, r]);
      if (needTerrain) parts.push([0.12, load.terrDone ? 1 : load.terrFrac]);
      const wsum = parts.reduce((t, x) => t + x[0], 0) || 1;
      const f = parts.reduce((t, x) => t + x[0] * x[1], 0) / wsum;
      const bits = [];
      if (needOsm && !load.osmDone) bits.push(load.phase === 'wait' ? 'OpenStreetMap stellt Daten zusammen' : `${(load.received / 1e6).toFixed(1)} MB von OpenStreetMap`);
      if (needRoofs && !load.roofDone) bits.push(`${load.roofCount} Dachflächen`);
      if (needParcels && !load.parcDone) bits.push('Parzellen');
      if (needTerrain && !load.terrDone) bits.push('Höhenmodell');
      progress.set(2 + 58 * f, 'Lade Daten', bits.length ? bits.join(', ') + ' …' : 'Fast fertig …');
    };
    ticker = setInterval(tick, 200);

    const warnings = [];
    if (!swiss) warnings.push('Ausserhalb der Schweiz: Parzellen, echte Dachformen und Geländeschattierung sind hier noch nicht verfügbar.');
    const [osm, parcelsRaw, roofsRaw, terrain] = await Promise.all([
      needOsm
        ? cached('osm', wgsBox, () => fetchOverpass(wgsBox, {
            onHeaders: total => { load.phase = 'bytes'; load.total = total; },
            onBytes: n => { load.received = n; },
            onRetry: () => { load.phase = 'wait'; load.received = 0; load.t0 = performance.now(); }
          })).then(r => { load.osmDone = true; return r; })
        : Promise.resolve({ elements: [] }),
      needParcels
        ? cached('parcels', bbox, () => fetchParcels(bbox, n => { load.pages = n; }))
            .catch(err => { warnings.push('Parzellen nicht verfügbar (' + err.message + ').'); return []; })
            .then(r => { load.parcDone = true; return r; })
        : Promise.resolve([]),
      needRoofs
        ? cached('roofs', roofBox, () => fetchRoofs(roofBox, (frac, count) => { load.roofFrac = frac; load.roofCount = count; }))
            .catch(err => { warnings.push('Echte Dachformen nicht verfügbar, Dächer schematisch (' + err.message + ').'); return []; })
            .then(r => { load.roofDone = true; return r; })
        : Promise.resolve([]),
      needTerrain
        ? cached('terrain', bbox, () => fetchTerrain(bbox, frac => { load.terrFrac = frac; }))
            .catch(err => { warnings.push('Höhenmodell nicht verfügbar, ohne Geländeschattierung (' + err.message + ').'); return null; })
            .then(r => { load.terrDone = true; return r; })
        : Promise.resolve(null)
    ]);
    clearInterval(ticker); ticker = null;

    progress.set(60, 'Verarbeite Daten', 'Objekte werden sortiert …');
    await yieldUI();

    const data = classify(osm);
    const plan = {
      bbox, scale, buildings: [], green: [], roadAreas: [], roadLines: [],
      trees: [], parcels: [], labels: [], rails: [], zebras: [], passages: [], arcades: [],
      roofFaces: [], roofOutlines: [], roofsLoaded: needRoofs, terrain
    };

    if (opts.buildings) {
      const n = data.buildings.length;
      for (let i = 0; i < n; i++) {
        if (i % 40 === 0) {
          progress.set(62 + 10 * i / n, 'Verarbeite Gebäude', `${i} von ${n}`);
          await yieldUI();
        }
        const b = data.buildings[i];
        const poly = projPoly(b.poly);
        if (!bboxHit(polyBBox(poly), padBox)) continue;
        const area = planarArea(poly);
        plan.buildings.push({
          poly, height: buildingHeight(b.tags, area), roof: computeRoof(poly, b.tags, area), hasRoof: false
        });
      }
      plan.arcades = data.arcades.map(projPoly).filter(p => bboxHit(polyBBox(p), padBox));
    }

    // Echte Dachflächen: pro Gebäude vereinigen (Dachumriss) und den OSM-Gebäuden zuordnen
    if (roofsRaw.length) {
      for (const f of roofsRaw) plan.roofFaces.push(...roofFaceFrom(f));
      const groups = new Map();
      for (const f of plan.roofFaces) {
        if (!groups.has(f.bid)) groups.set(f.bid, []);
        groups.get(f.bid).push(f.poly);
      }
      let k = 0;
      for (const polys of groups.values()) {
        if (k++ % 30 === 0) {
          progress.set(72 + 10 * k / groups.size, 'Verarbeite Dächer', `${k} von ${groups.size} Gebäuden`);
          await yieldUI();
        }
        plan.roofOutlines.push(...unionAll(polys));
      }
      // Rasterindex der Flächenmittelpunkte für die Zuordnung
      const G = 20, grid = new Map();
      for (const f of plan.roofFaces) {
        const key = Math.floor(f.c[0] / G) + ':' + Math.floor(f.c[1] / G);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(f);
      }
      for (const b of plan.buildings) {
        const [x0, y0, x1, y1] = polyBBox(b.poly);
        search:
        for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
          for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) {
            for (const f of grid.get(gx + ':' + gy) || []) {
              if (pointInRing(f.c, b.poly[0])) { b.hasRoof = true; break search; }
            }
          }
        }
      }
    }

    progress.set(84, 'Verarbeite Grünflächen und Strassen', '');
    await yieldUI();

    if (opts.green) {
      for (const g of data.green) {
        const poly = projPoly(g.poly);
        if (bboxHit(polyBBox(poly), padBox)) plan.green.push({ poly, kind: g.kind });
      }
    }

    if (opts.roads) {
      plan.roadAreas = data.roadAreas.map(projPoly).filter(p => bboxHit(polyBBox(p), padBox));
      plan.roadLines = data.roadLines
        .map(l => ({ wgs: l.coords, lv: l.coords.map(toLV), nodes: l.nodes, ...roadSpec(l.tags) }))
        .sort((a, b) => a.rank - b.rank);
      plan.passages = plan.roadLines.filter(l => l.passage);
      plan.rails = data.rails.map(r => ({ kind: r.kind, lv: r.coords.map(toLV) }));

      // Fussgängerstreifen: Querungsknoten auf Fahrbahnen, Richtung aus den Nachbarpunkten
      const zebraIds = new Set(data.crossings.filter(c => isZebra(c.tags)).map(c => c.id));
      const used = new Set();
      for (const l of plan.roadLines) {
        if (l.kind === 'foot' || !l.nodes) continue;
        l.nodes.forEach((id, i) => {
          if (!zebraIds.has(id) || used.has(id) || !l.lv[i]) return;
          const a = l.lv[Math.max(0, i - 1)], b = l.lv[Math.min(l.lv.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
          if (len < 1e-6) return;
          used.add(id);
          plan.zebras.push({ e: l.lv[i][0], n: l.lv[i][1], dx: dx / len, dy: dy / len, w: l.innerW || l.outerW });
        });
      }
    }

    if (opts.trees) {
      for (const t of data.trees) {
        const [e, n] = toLV([t.lon, t.lat]);
        if (e < bbox[0] - 20 || e > bbox[2] + 20 || n < bbox[1] - 20 || n > bbox[3] + 20) continue;
        const dc = parseFloat(t.tags.diameter_crown);
        const h = parseFloat(t.tags.height);
        const h0 = h > 0 && h < 60 ? h : 0;
        const d0 = dc > 0.5 && dc < 40 ? dc : h0 ? clamp(h0 * 0.55, 3, 18) : 0;
        const ie = Math.round(e * 10), in_ = Math.round(n * 10);
        plan.trees.push({
          e, n, d0, h0, rv: hash2(ie, in_, 7),
          conifer: t.tags.leaf_type === 'needleleaved',
          seed: Math.abs(Math.floor(e * 13 + n * 7))
        });
      }
    }

    progress.set(88, 'Verarbeite Parzellen', '');
    await yieldUI();

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

    progress.set(94, 'Zeichne Plan', '');
    await yieldUI();

    state.plan = plan;
    await document.fonts.ready;
    showTab('plan');
    renderPreview();
    ui.btnPng.disabled = ui.btnDxf.disabled = false;
    progress.done('Plan erzeugt');

    const roofInfo = needRoofs
      ? `, ${plan.buildings.filter(b => b.hasRoof).length} davon mit echten Dachflächen`
      : '';
    const summary = `${plan.buildings.length} Gebäude${roofInfo}, ${plan.trees.length} Bäume, ` +
      `${plan.roadLines.length} Strassenabschnitte, ${plan.parcels.length} Parzellenflächen.`;
    setStatus(warnings.length ? summary + ' ' + warnings.join(' ') : 'Plan erzeugt: ' + summary, warnings.length > 0);
  } catch (err) {
    console.error(err);
    progress.fail();
    setStatus('Fehler: ' + err.message, true);
  } finally {
    if (ticker) clearInterval(ticker);
    ui.btnGenerate.disabled = false;
  }
}

function wgsBounds([minE, minN, maxE, maxN]) {
  const c = [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]].map(toWGS);
  const lons = c.map(p => p[0]), lats = c.map(p => p[1]);
  // Reihenfolge für Overpass: süd, west, nord, ost
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}

/* =========================================================
   Rendering (Canvas, für Vorschau und PNG)
   ========================================================= */

/* ---------- Texturen ---------- */

function gauss(rnd) { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }

// Kachelbares Muster. Wiese: Halme in unregelmässigen Büscheln; zwei verschieden grosse,
// gedrehte Kacheln überlagert ergeben keine sichtbare Wiederholung.
function makePattern(ctx, dpi, kind, variant = 0) {
  const mm = v => v * dpi / 25.4;
  const rnd = mulberry32(kind.length * 9973 + variant * 7717 + 7);
  const tile = sizeMm => {
    const S = Math.max(32, Math.round(mm(sizeMm)));
    const p = document.createElement('canvas');
    p.width = p.height = S;
    return [p, p.getContext('2d'), S];
  };
  // Zeichnet eine Form mit Umbruch über die Kachelränder
  const wrap = (S, x, y, reach, fn) => {
    x = ((x % S) + S) % S; y = ((y % S) + S) % S;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const sx = x + ox, sy = y + oy;
      if (sx < -reach || sx > S + reach || sy < -reach || sy > S + reach) continue;
      fn(sx, sy);
    }
  };

  if (kind === 'grass') {
    const [p, c, S] = tile(variant ? 37 : 23);
    c.lineCap = 'round';
    const count = Math.round((S / mm(1)) ** 2 * 0.085);
    const clusters = Array.from({ length: 4 + Math.floor(rnd() * 5) }, () => [rnd() * S, rnd() * S, mm(1.2 + rnd() * 3.5)]);
    for (let i = 0; i < count; i++) {
      let x, y;
      if (rnd() < 0.72) {
        const cl = clusters[Math.floor(rnd() * clusters.length)];
        x = cl[0] + gauss(rnd) * cl[2]; y = cl[1] + gauss(rnd) * cl[2];
      } else { x = rnd() * S; y = rnd() * S; }
      const a = -Math.PI / 2 + (rnd() - 0.5) * 1.3, len = mm(0.22 + rnd() * 0.5);
      const light = rnd() < 0.22;
      c.strokeStyle = light ? `rgba(244,250,226,${0.35 + rnd() * 0.3})` : `rgba(64,102,48,${0.14 + rnd() * 0.26})`;
      c.lineWidth = Math.max(0.5, mm(0.05 + rnd() * 0.06));
      const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
      wrap(S, x, y, len, (sx, sy) => { c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + dx, sy + dy); c.stroke(); });
    }
    return ctx.createPattern(p, 'repeat');
  }
  if (kind === 'forest') {
    const [p, c, S] = tile(19);
    for (let i = 0; i < 16; i++) {
      const r = mm(0.5 + rnd() * 1.1);
      c.strokeStyle = `rgba(52,88,46,${0.2 + rnd() * 0.2})`;
      c.lineWidth = Math.max(0.6, mm(0.08));
      wrap(S, rnd() * S, rnd() * S, r, (sx, sy) => { c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.stroke(); });
    }
    return ctx.createPattern(p, 'repeat');
  }
  // Belag
  const [p, c, S] = tile(8);
  const d = Math.max(1, mm(0.07));
  for (let i = 0; i < 420; i++) {
    c.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`;
    c.fillRect(rnd() * S, rnd() * S, d, d);
  }
  return ctx.createPattern(p, 'repeat');
}

// Weiche, grossflächige Helligkeitsflecken (wie unregelmässiger Rasen)
function mottle(c, W, H, cell, seed, dark, light, amp) {
  cell = Math.max(3, cell);
  const w = Math.ceil(W / cell) + 3, h = Math.ceil(H / cell) + 3;
  const nc = document.createElement('canvas');
  nc.width = w; nc.height = h;
  const x = nc.getContext('2d');
  const img = x.createImageData(w, h);
  const rnd = mulberry32(seed);
  for (let i = 0; i < w * h; i++) {
    const v = rnd(), k = i * 4;
    const col = v < 0.5 ? dark : light;
    img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2];
    img.data[k + 3] = Math.round(Math.abs(v - 0.5) * 2 * amp * 255);
  }
  x.putImageData(img, 0, 0);
  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(nc, -cell * 1.5, -cell * 1.5, w * cell, h * cell);
  c.restore();
}

/* ---------- Bäume ---------- */

// Drei Familien mit je drei Varianten: einfach, komplex, Grundriss (Stamm geschnitten, Krone gestrichelt).
// Stil-ID: Familie + Variante, z.B. 'grey_x' oder 'circle_plan'.
const TREE_FAMILIES = [
  { id: 'flat', label: 'Flach', kind: 'Bild' },
  { id: 'grey', label: 'Grau', kind: 'Bild' },
  { id: 'circle', label: 'Kreis', kind: 'Vektor' }
];
const TREE_VARIANTS = [
  { id: '', label: 'Einfach' },
  { id: 'x', label: 'Komplex' },
  { id: 'plan', label: 'Grundriss' }
];
let treeStyle = 'flat';

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// Kronenumriss aus unregelmässigen Bögen (verschieden breite und tiefe Ausbuchtungen)
function lobedOutline(r, rnd, amp = 1) {
  const n = 7 + Math.floor(rnd() * 5);
  const widths = Array.from({ length: n }, () => 0.6 + rnd() * 0.8);
  const sum = widths.reduce((x, y) => x + y, 0);
  let a = rnd() * Math.PI * 2;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const wk = widths[k] / sum * Math.PI * 2;
    const rk = r * (0.87 + rnd() * 0.11);
    const depth = (0.06 + rnd() * 0.07) * amp;
    const m = Math.max(6, Math.round(wk * 16));
    for (let j = 0; j < m; j++) {
      const u = j / m, ang = a + wk * u;
      const rr = rk * (1 - depth + depth * Math.pow(Math.sin(Math.PI * u), 0.6)) + r * 0.006 * (rnd() - 0.5);
      pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
    }
    a += wk;
  }
  pts.push(pts[0]);
  return pts;
}

// Gewachsenes Astwerk: unregelmässige Hauptäste, leicht gebogen, mit einseitigen Seitenzweigen
function organicBranches(r, rnd) {
  const lines = [];
  const curve = (start, ang, len, lv, steps) => {
    const pts = [start];
    let p = start, a = ang;
    const bend = (rnd() - 0.5) * 0.9;
    for (let s = 0; s < steps; s++) {
      a += bend / steps + (rnd() - 0.5) * 0.16;
      const q = [p[0] + Math.cos(a) * len / steps, p[1] + Math.sin(a) * len / steps];
      if (Math.hypot(q[0], q[1]) > r * 0.92) break;
      pts.push(q);
      p = q;
    }
    if (pts.length > 1) lines.push({ pts, lv });
    return pts;
  };
  const nMain = 4 + Math.floor(rnd() * 3), ph = rnd() * Math.PI * 2;
  for (let m = 0; m < nMain; m++) {
    const a = ph + m * Math.PI * 2 / nMain + (rnd() - 0.5) * (Math.PI * 2 / nMain) * 0.7;
    const main = curve([Math.cos(a) * r * 0.04, Math.sin(a) * r * 0.04], a, r * (0.5 + rnd() * 0.32), 0, 8);
    const nt = 1 + Math.floor(rnd() * 3);
    for (let t = 0; t < nt && main.length > 3; t++) {
      const idx = 2 + Math.floor(rnd() * (main.length - 3));
      const p = main[idx], q = main[idx - 1];
      const base = Math.atan2(p[1] - q[1], p[0] - q[0]);
      const side = rnd() < 0.5 ? -1 : 1;
      const twig = curve(p, base + side * (0.45 + rnd() * 0.5), r * (0.14 + rnd() * 0.22), 1, 4);
      if (rnd() < 0.5 && twig.length > 2) {
        const tp = twig[twig.length - 2];
        curve(tp, base + side * (0.9 + rnd() * 0.4), r * (0.07 + rnd() * 0.08), 2, 3);
      }
    }
  }
  return lines;
}

// Geometrie eines Baums in Metern relativ zum Stamm (y nach Norden)
function treeGeom(style, r, seed) {
  const [fam, v = ''] = style.split('_');
  const rnd = mulberry32(seed + 17);
  const g = {
    fam, v, outline: null, inner: [], branches: [],
    dashed: v === 'plan',
    trunk: v === 'plan' ? clamp(r * 0.07, 0.15, 0.45) : 0,
    cross: fam === 'circle' && v === '' ? r * 0.12 : 0
  };
  if (v === 'wavy') {
    g.outline = wavyOutline(r, rnd);
    g.inner = [lobedOutline(r * 0.6, rnd, 0.8)];
  }
  if (v === 'x') {
    if (fam !== 'circle') g.outline = lobedOutline(r, rnd);
    if (fam === 'flat') g.inner = [lobedOutline(r * 0.62, rnd, 0.8)];
    if (fam !== 'flat') g.branches = organicBranches(r, rnd);
  }
  return g;
}

// Unregelmässige, wellige Kronenlinie (mehrere überlagerte Frequenzen)
function wavyOutline(r, rnd, N = 240) {
  const ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3, rnd() * 6.3, rnd() * 6.3];
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    const k = 0.9 + 0.045 * Math.sin(3 * a + ph[0]) + 0.03 * Math.sin(7 * a + ph[1]) +
      0.02 * Math.sin(19 * a + ph[2]) + 0.012 * Math.sin(37 * a + ph[3]) + 0.008 * (rnd() - 0.5);
    pts.push([Math.cos(a) * r * k, Math.sin(a) * r * k]);
  }
  pts.push(pts[0]);
  return pts;
}

// Kreis komplex: Rand aus Bögen wie «Wellig», aber unterbrochen; innen Blätter als leichte Textur
function leafLoopGeom(g, r, rnd, s, P, shadeAt) {
  let a = rnd() * Math.PI * 2;
  const end = a + Math.PI * 2;
  let seg = [];
  while (a < end - 0.05) {
    const w = Math.min(end - a, 0.22 + rnd() * 0.22);
    const rr = r * (0.88 + rnd() * 0.06);
    const bulge = rr * w * (0.28 + rnd() * 0.12);
    // Lücken häufiger auf der Lichtseite
    const skip = rnd() < 0.08 + 0.32 * (1 - shadeAt(a + w / 2));
    if (skip) {
      if (seg.length > 1) g.lines.push(seg);
      seg = [];
    } else {
      for (let j = seg.length ? 1 : 0; j <= 6; j++) {
        const u = j / 6, ang = a + w * u;
        seg.push(P(ang, rr + bulge * Math.sin(Math.PI * u)));
      }
    }
    a += w;
  }
  if (seg.length > 1) g.lines.push(seg);
  // innere Schlaufenreihe auf der Schattenseite
  for (let a2 = s - 1.2; a2 < s + 1.2; ) {
    const w = 0.28 + rnd() * 0.2, rr = r * (0.58 + rnd() * 0.08), bulge = rr * w * 0.3;
    if (rnd() < 0.75) {
      const arc = [];
      for (let j = 0; j <= 5; j++) { const u = j / 5; arc.push(P(a2 + w * u, rr + bulge * Math.sin(Math.PI * u))); }
      g.lines.push(arc);
    }
    a2 += w + 0.05 + rnd() * 0.12;
  }
  // Blätter als füllende Textur: überall, zur Schattenseite hin dichter
  for (let i = 0; i < 380; i++) {
    const ang = rnd() * Math.PI * 2, d = r * 0.84 * Math.sqrt(rnd());
    if (rnd() > 0.28 + 0.5 * shadeAt(ang) * (0.5 + 0.5 * d / r)) continue;
    const c = P(ang, d), L = r * (0.035 + rnd() * 0.025), o = rnd() * Math.PI * 2;
    const leaf = [];
    for (let k = 0; k <= 5; k++) {
      const t = -Math.PI * 0.55 + Math.PI * 1.1 * k / 5;
      const lx = Math.cos(t) * L, ly = Math.sin(t) * L * 0.6;
      leaf.push([c[0] + lx * Math.cos(o) - ly * Math.sin(o), c[1] + lx * Math.sin(o) + ly * Math.cos(o)]);
    }
    g.leaves = g.leaves || [];
    g.leaves.push(leaf);
  }
}

/* ---------- Weitere Symbole: handgezeichnet, gemalt, eigenes Bild ---------- */

const EXTRA_TREES = [
  { id: 'hand_loops', label: 'Schlaufen' },
  { id: 'hand_wavy', label: 'Wellig' },
  { id: 'hand_leaves', label: 'Blätter' },
  { id: 'paint', label: 'Gemalt' },
  { id: 'flat_wavy', label: 'Flach wellig' },
  { id: 'custom', label: 'Eigenes' }
];
const customTree = { img: null, multiply: true, rotate: true };
const spriteCache = new Map();

// Handgezeichnete Symbole als Linien in Metern relativ zum Stamm (y nach Norden).
// Schattenseite folgt der gewählten Sonnenrichtung.
function handGeom(style, r, seed, sun) {
  const rnd = mulberry32(seed + 29);
  const s = Math.atan2(sun.shadow[1], sun.shadow[0]);
  const P = (a, d) => [Math.cos(a) * d, Math.sin(a) * d];
  const shadeAt = a => Math.max(0, Math.cos(a - s));
  const g = { r, circle: 0, outline: null, lines: [], rings: [], fills: [], cross: 0, heavy: false };

  if (style === 'hand_leafloop') {
    leafLoopGeom(g, r, rnd, s, P, shadeAt);
  } else if (style === 'hand_loops') {
    const loop = (c, ang, rho) => {
      const pts = [];
      for (let k = 0; k <= 7; k++) {
        const u = -Math.PI / 2 + Math.PI * k / 7;
        const rad = Math.cos(u) * rho * 1.3, tan = Math.sin(u) * rho;
        pts.push([c[0] + Math.cos(ang) * rad - Math.sin(ang) * tan, c[1] + Math.sin(ang) * rad + Math.cos(ang) * tan]);
      }
      g.lines.push(pts);
    };
    const rho0 = r * 0.07;
    const m = Math.round(2 * Math.PI * 0.9 / (0.07 * 2.4));
    for (let k = 0; k < m; k++) {
      const a = k / m * Math.PI * 2 + (rnd() - 0.5) * 0.06;
      if (rnd() < 0.3 + 0.7 * shadeAt(a)) loop(P(a, r * 0.88), a, rho0 * (0.8 + rnd() * 0.4));
    }
    const n = 70;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, d = r * (0.2 + 0.6 * Math.sqrt(rnd()));
      if (rnd() < 0.12 + 0.6 * shadeAt(a) * (d / r)) loop(P(a, d), a + (rnd() - 0.5) * 0.6, rho0 * (0.7 + rnd() * 0.4));
    }
  } else if (style === 'hand_wavy') {
    const ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3, rnd() * 6.3];
    const N = 240, pts = [];
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      pts.push(P(a, r * (0.93 + 0.03 * Math.sin(5 * a + ph[0]) + 0.022 * Math.sin(23 * a + ph[1]) +
        0.014 * Math.sin(41 * a + ph[2]) + 0.01 * (rnd() - 0.5))));
    }
    // Umriss mit zwei, drei kleinen Lücken
    const gaps = new Set();
    for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) {
      const c0 = Math.floor(rnd() * N);
      for (let j = 0; j < 4; j++) gaps.add((c0 + j) % N);
    }
    let seg = [];
    for (let i = 0; i <= N; i++) {
      if (gaps.has(i)) { if (seg.length > 1) g.lines.push(seg); seg = []; } else seg.push(pts[i]);
    }
    if (seg.length > 1) g.lines.push(seg);
    // zweite, innere Linie auf der Schattenseite
    const inner = [];
    for (let i = 0; i <= 40; i++) {
      const a = s - 0.9 + 1.8 * i / 40;
      inner.push(P(a, r * (0.85 + 0.02 * Math.sin(29 * a + ph[3]) + 0.01 * (rnd() - 0.5))));
    }
    g.lines.push(inner);
    // kleine abgelöste Flecken am Rand
    for (let k = 0; k < 3; k++) {
      const a = rnd() * Math.PI * 2, c = P(a, r * (1.0 + rnd() * 0.05)), q = r * 0.025;
      const ring = Array.from({ length: 9 }, (_, i) => [c[0] + Math.cos(i / 8 * Math.PI * 2) * q * (0.8 + rnd() * 0.4), c[1] + Math.sin(i / 8 * Math.PI * 2) * q]);
      ring[8] = ring[0];
      g.rings.push(ring);
    }
    g.cross = r * 0.07;
  } else if (style === 'hand_leaves') {
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2, d = r * 0.94 * Math.sqrt(rnd());
      if (rnd() > 0.12 + 0.6 * shadeAt(a) + 0.35 * (d / r) ** 2) continue;
      const L = r * (0.05 + rnd() * 0.035), Wd = L * 0.45, o = rnd() * Math.PI;
      const c = P(a, d);
      const ring = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10 * Math.PI * 2;
        const lx = Math.cos(t) * L, ly = Math.sin(t) * Wd * (1 - 0.35 * Math.cos(t));
        ring.push([c[0] + lx * Math.cos(o) - ly * Math.sin(o), c[1] + lx * Math.sin(o) + ly * Math.cos(o)]);
      }
      ring[10] = ring[0];
      g.rings.push(ring);
    }
  }
  return g;
}

function drawHandTree(c, g, x, y, pxPerM, mm) {
  const T = p => [x + p[0] * pxPerM, y - p[1] * pxPerM];
  const path = (pts, close) => {
    c.beginPath();
    pts.forEach((p, i) => { const [px, py] = T(p); i ? c.lineTo(px, py) : c.moveTo(px, py); });
    if (close) c.closePath();
  };
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  // helle Unterlage, damit das Symbol auch auf Belag lesbar bleibt
  c.beginPath(); c.arc(x, y, g.r * 0.96 * pxPerM, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.5)'; c.fill();
  c.fillStyle = '#1b1b1a';
  for (const f of g.fills) { path(f, true); c.fill(); }
  c.strokeStyle = '#1b1b1a';
  if (g.circle) {
    c.beginPath(); c.arc(x, y, g.circle * pxPerM, 0, Math.PI * 2);
    c.lineWidth = mm(g.heavy ? 0.18 : 0.13); c.stroke();
  }
  if (g.outline) { path(g.outline, true); c.lineWidth = mm(0.13); c.stroke(); }
  c.lineWidth = mm(0.1);
  for (const l of g.lines) { path(l, false); c.stroke(); }
  c.lineWidth = mm(0.08);
  for (const ring of g.rings) { path(ring, true); c.stroke(); }
  if (g.leaves) {
    c.lineWidth = mm(0.06);
    c.strokeStyle = 'rgba(27,27,26,0.75)';
    for (const l of g.leaves) { path(l, false); c.stroke(); }
    c.strokeStyle = '#1b1b1a';
  }
  if (g.cross) {
    const k = g.cross * pxPerM;
    c.lineWidth = mm(0.12);
    c.beginPath(); c.moveTo(x - k, y); c.lineTo(x + k, y); c.moveTo(x, y - k); c.lineTo(x, y + k); c.stroke();
  }
  c.restore();
}

// Gemalt: ruhige Kronenform wie «Flach komplex», gefüllt mit wenigen grossen,
// ausgefransten Farbflächen; Lichtseite heller, Schattenseite dunkler.
function paintPainterly(c, cx, cy, R, rnd, lx, ly) {
  const pal = [[112, 138, 82], [126, 152, 92], [142, 166, 104], [158, 180, 118]];
  const outline = lobedOutline(R, rnd);
  const crown = () => {
    c.beginPath();
    outline.forEach(([x, y], i) => i ? c.lineTo(cx + x, cy - y) : c.moveTo(cx + x, cy - y));
    c.closePath();
  };
  crown();
  c.fillStyle = rgba(pal[1], 1);
  c.fill();
  c.save();
  crown(); c.clip();
  const clump = (px, py, rad, col, alpha) => {
    const n = 34;
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const k = rad * (0.82 + 0.18 * rnd()) * (1 + 0.1 * Math.sin(4 * a + rad));
      const x = px + Math.cos(a) * k, y = py + Math.sin(a) * k;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath();
    c.fillStyle = rgba(col, alpha);
    c.fill();
  };
  const at = (bias, spread) => {
    const a = rnd() * Math.PI * 2, d = spread * Math.sqrt(rnd());
    return [cx + Math.cos(a) * d + lx * R * bias, cy + Math.sin(a) * d + ly * R * bias];
  };
  for (let k = 0; k < 2; k++) { const [x, y] = at(-0.32, R * 0.25); clump(x, y, R * (0.6 + rnd() * 0.12), pal[0], 0.6); }
  for (let k = 0; k < 2; k++) { const [x, y] = at(0.08, R * 0.25); clump(x, y, R * (0.45 + rnd() * 0.1), pal[2], 0.55); }
  { const [x, y] = at(0.3, R * 0.15); clump(x, y, R * (0.32 + rnd() * 0.08), pal[3], 0.6); }
  // wenige, grössere Pinsel-Lücken am Rand
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2, d = R * (0.82 + rnd() * 0.22);
    const sz = Math.max(1, R * (0.025 + rnd() * 0.04));
    c.fillStyle = `rgba(0,0,0,${0.4 + rnd() * 0.5})`;
    c.beginPath(); c.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, sz, sz * 0.6, a, 0, Math.PI * 2); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
  crown();
  c.lineWidth = Math.max(1, R * 0.025);
  c.strokeStyle = 'rgba(70,94,54,0.8)';
  c.stroke();
  c.fillStyle = rgba(pal[0], 1);
  c.beginPath(); c.arc(cx, cy, Math.max(1, R * 0.04), 0, Math.PI * 2); c.fill();
}

function paintedSprite(rpx, variant, sun) {
  const rb = Math.max(6, Math.round(rpx / 3) * 3);
  const key = `paint|${rb}|${variant}|${sun.toSun.join()}`;
  let sp = spriteCache.get(key);
  if (sp) return sp;
  if (spriteCache.size > 300) spriteCache.clear();
  const pad = Math.ceil(rb * 0.12) + 2, S = 2 * (rb + pad);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  paintPainterly(cv.getContext('2d'), S / 2, S / 2, rb, mulberry32(variant * 7919 + rb * 31), sun.toSun[0], -sun.toSun[1]);
  sp = { canvas: cv, scale: rpx / rb };
  spriteCache.set(key, sp);
  return sp;
}

function drawCustomTree(c, x, y, R, seed, mm) {
  const im = customTree.img;
  if (!im) {
    c.save();
    c.setLineDash([mm(0.8), mm(0.6)]);
    c.strokeStyle = '#888'; c.lineWidth = mm(0.12);
    c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.moveTo(x - R * 0.3, y); c.lineTo(x + R * 0.3, y); c.moveTo(x, y - R * 0.3); c.lineTo(x, y + R * 0.3); c.stroke();
    c.restore();
    return;
  }
  const w = im.naturalWidth || 300, h = im.naturalHeight || 300;
  const k = 2 * R / Math.max(w, h);
  c.save();
  if (customTree.multiply) c.globalCompositeOperation = 'multiply';
  c.translate(x, y);
  if (customTree.rotate) c.rotate((seed % 360) * Math.PI / 180);
  c.drawImage(im, -w * k / 2, -h * k / 2, w * k, h * k);
  c.restore();
}

// Verteiler für alle Baumstile
const resolveTree = st => st === 'circle_x' ? 'hand_leafloop' : st;

function drawTree(c, style, x, y, r, seed, pxPerM, mm, sun) {
  style = resolveTree(style);
  if (style.startsWith('hand_')) return drawHandTree(c, handGeom(style, r, seed, sun), x, y, pxPerM, mm);
  if (style === 'custom') return drawCustomTree(c, x, y, r * pxPerM, seed, mm);
  if (style === 'paint') {
    const sp = paintedSprite(r * pxPerM, seed % 4, sun);
    const S = sp.canvas.width * sp.scale;
    c.drawImage(sp.canvas, x - S / 2, y - S / 2, S, S);
    return;
  }
  return drawFamilyTree(c, style, x, y, r, seed, pxPerM, mm, sun);
}

// Zeichnen der Familien Flach/Grau/Kreis. r in Metern, pxPerM für die Umrechnung, mm für Strichstärken
function drawFamilyTree(c, style, x, y, r, seed, pxPerM, mm, sun) {
  const g = treeGeom(style, r, seed);
  const R = r * pxPerM;
  const lx = sun.toSun[0], ly = -sun.toSun[1];
  const crown = () => {
    c.beginPath();
    if (g.outline) {
      g.outline.forEach(([px, py], i) => i ? c.lineTo(x + px * pxPerM, y - py * pxPerM) : c.moveTo(x + px * pxPerM, y - py * pxPerM));
      c.closePath();
    } else c.arc(x, y, R, 0, Math.PI * 2);
  };
  const polyline = pts => {
    c.beginPath();
    pts.forEach(([px, py], i) => i ? c.lineTo(x + px * pxPerM, y - py * pxPerM) : c.moveTo(x + px * pxPerM, y - py * pxPerM));
  };
  const dash = g.dashed ? [mm(1.0), mm(0.6)] : [];

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (g.fam === 'flat') {
    c.save();
    c.globalCompositeOperation = 'multiply';
    crown();
    const grad = c.createRadialGradient(x + lx * R * 0.4, y + ly * R * 0.4, R * 0.05, x, y, R);
    grad.addColorStop(0, g.dashed ? 'rgb(214,226,198)' : 'rgb(190,207,168)');
    grad.addColorStop(1, g.dashed ? 'rgb(180,200,164)' : 'rgb(146,170,128)');
    c.fillStyle = grad;
    c.fill();
    c.restore();
    if (g.inner.length) {
      c.strokeStyle = 'rgba(92,118,82,0.5)';
      c.lineWidth = mm(0.08);
      for (const ring of g.inner) { polyline(ring); c.stroke(); }
    }
    crown();
    c.setLineDash(dash);
    c.strokeStyle = 'rgb(92,118,82)';
    c.lineWidth = mm(g.outline ? 0.12 : 0.13);
    c.stroke();
    c.setLineDash([]);
  } else if (g.fam === 'grey') {
    c.save();
    c.globalCompositeOperation = 'multiply';
    crown();
    c.fillStyle = g.dashed ? 'rgba(160,160,156,0.35)' : 'rgba(150,150,146,0.5)';
    c.fill();
    c.restore();
    if (!g.dashed) {
      const a = Math.atan2(ly, lx);
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = Math.max(1, R * 0.06);
      c.beginPath(); c.arc(x, y, R * 0.72, a - 0.7, a + 0.7); c.stroke();
    }
    c.strokeStyle = 'rgba(70,70,68,0.6)';
    for (const b of g.branches) {
      c.lineWidth = mm([0.12, 0.08, 0.06][b.lv]);
      polyline(b.pts); c.stroke();
    }
    crown();
    c.setLineDash(dash);
    c.strokeStyle = 'rgba(64,64,62,0.85)';
    c.lineWidth = mm(0.13);
    c.stroke();
    c.setLineDash([]);
  } else {
    crown();
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fill();
    c.setLineDash(dash);
    c.strokeStyle = '#1f1f1e';
    c.lineWidth = mm(g.dashed ? 0.13 : 0.15);
    c.stroke();
    c.setLineDash([]);
    if (g.cross) {
      const k = g.cross * pxPerM;
      c.lineWidth = mm(0.1);
      c.beginPath(); c.moveTo(x - k, y); c.lineTo(x + k, y); c.moveTo(x, y - k); c.lineTo(x, y + k); c.stroke();
    }
    for (const b of g.branches) {
      c.lineWidth = mm([0.13, 0.08, 0.06][b.lv]);
      polyline(b.pts); c.stroke();
    }
  }

  // Stamm: geschnitten (Grundriss) oder als Punkt
  if (g.trunk) {
    c.beginPath(); c.arc(x, y, Math.max(mm(0.5), g.trunk * pxPerM), 0, Math.PI * 2);
    c.fillStyle = '#111'; c.fill();
  } else if (!g.cross) {
    c.beginPath(); c.arc(x, y, Math.max(mm(0.25), R * 0.04), 0, Math.PI * 2);
    c.fillStyle = g.fam === 'flat' ? 'rgb(92,118,82)' : g.fam === 'grey' ? 'rgba(64,64,62,0.9)' : '#1f1f1e';
    c.fill();
  }
  c.restore();
}

// Kronendurchmesser: aus den Daten, sonst aus der Baumhöhe, sonst Standard mit Variation
function treeDiameter(t, o) {
  if (t.d0) return t.d0;
  const base = (o.treeSize || 7) * (t.conifer ? 0.65 : 1);
  return Math.max(1.5, base * (1 + (o.treeVar || 0) * (t.rv - 0.5) * 1.4));
}

/* ---------- Wiesensignatur und Gelände ---------- */

function hash2(i, j, s = 0) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Punktsignatur als Vektoren: ein Punkt pro Rasterzelle (in Papier-mm), zufällig versetzt.
// Die Lage hängt an Weltkoordinaten, darum sehen Vorschau und Export gleich aus.
function stipple(c, plan, pxPerM, mm, kind) {
  const [minE, minN, maxE, maxN] = plan.bbox;
  let step = (kind === 'forest' ? 2.4 : 1.6) * plan.scale / 1000;
  while (((maxE - minE) / step) * ((maxN - minN) / step) > 350000) step *= 1.25;
  const X = e => (e - minE) * pxPerM, Y = n => (maxN - n) * pxPerM;
  const i0 = Math.floor(minE / step), i1 = Math.ceil(maxE / step);
  const j0 = Math.floor(minN / step), j1 = Math.ceil(maxN / step);
  if (kind === 'forest') {
    c.strokeStyle = 'rgba(58,88,52,0.55)';
    c.lineWidth = Math.max(0.5, mm(0.08));
    const r = Math.max(1, mm(0.45));
    c.beginPath();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const px = X((i + 0.15 + 0.7 * hash2(i, j, 3)) * step), py = Y((j + 0.15 + 0.7 * hash2(i, j, 4)) * step);
      const rr = r * (0.7 + 0.6 * hash2(i, j, 5));
      c.moveTo(px + rr, py); c.arc(px, py, rr, 0, Math.PI * 2);
    }
    c.stroke();
    return;
  }
  const r = Math.max(0.45, mm(0.1));
  c.fillStyle = 'rgba(72,104,62,0.6)';
  c.beginPath();
  const tufts = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const px = X((i + 0.1 + 0.8 * hash2(i, j, 1)) * step), py = Y((j + 0.1 + 0.8 * hash2(i, j, 2)) * step);
    if (hash2(i, j, 9) < 0.04) { tufts.push([px, py]); continue; }
    c.moveTo(px + r, py); c.arc(px, py, r, 0, Math.PI * 2);
  }
  c.fill();
  // vereinzelte Grasbüschel
  c.strokeStyle = 'rgba(72,104,62,0.7)';
  c.lineWidth = Math.max(0.5, mm(0.08));
  c.lineCap = 'round';
  const L = mm(0.7);
  c.beginPath();
  for (const [px, py] of tufts) {
    for (const a of [-0.45, 0, 0.45]) {
      c.moveTo(px, py);
      c.lineTo(px + Math.sin(a) * L, py - Math.cos(a) * L);
    }
  }
  c.stroke();
}

// Waldsignatur im Stil «Flach wellig»: überlappende Kronen mit welliger Kante,
// leicht unterschiedliche Grüntöne, Kontur nur auf der Schattenseite.
// Lage an Weltkoordinaten gebunden, damit Vorschau und Export übereinstimmen.
function forestCanopy(c, plan, pxPerM, mm, sun) {
  const [minE, minN, maxE, maxN] = plan.bbox;
  let step = Math.max(5.5, 2.8 * plan.scale / 1000);
  while (((maxE - minE) / step) * ((maxN - minN) / step) > 40000) step *= 1.2;
  const X = e => (e - minE) * pxPerM, Y = n => (maxN - n) * pxPerM;
  const s = Math.atan2(sun.shadow[1], sun.shadow[0]);
  const crowns = [];
  const i0 = Math.floor(minE / step) - 1, i1 = Math.ceil(maxE / step) + 1;
  const j0 = Math.floor(minN / step) - 1, j1 = Math.ceil(maxN / step) + 1;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    crowns.push({
      e: (i + 0.1 + 0.8 * hash2(i, j, 31)) * step,
      n: (j + 0.1 + 0.8 * hash2(i, j, 32)) * step,
      r: step * (0.62 + 0.22 * hash2(i, j, 33)),
      t: hash2(i, j, 34), p1: hash2(i, j, 35) * 6.3, p2: hash2(i, j, 36) * 6.3
    });
  }
  crowns.sort((a, b) => a.t - b.t);
  const N = 36;
  const pt = (k, a) => {
    const rr = k.r * (0.93 + 0.04 * Math.sin(5 * a + k.p1) + 0.025 * Math.sin(13 * a + k.p2));
    return [X(k.e + Math.cos(a) * rr), Y(k.n + Math.sin(a) * rr)];
  };
  c.lineWidth = Math.max(0.5, mm(0.09));
  c.strokeStyle = 'rgba(74,102,62,0.6)';
  for (const k of crowns) {
    const col = mix([170, 192, 152], [190, 207, 172], k.t);
    c.beginPath();
    for (let q = 0; q < N; q++) {
      const [x, y] = pt(k, q / N * Math.PI * 2);
      q ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath();
    c.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    c.fill();
    c.beginPath();
    for (let q = 0; q <= 18; q++) {
      const [x, y] = pt(k, s - 1.4 + 2.8 * q / 18);
      q ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
}

// Höhengitter aus dem swisstopo-Höhenmodell über den Profil-Dienst: eine Linie pro Zeile
async function fetchTerrain(bbox, onProgress) {
  const [minE, minN, maxE, maxN] = bbox;
  const w = maxE - minE, h = maxN - minN;
  const cols = clamp(Math.round(w / 10) + 1, 12, 80);
  const rows = clamp(Math.round(h / 10) + 1, 10, 60);
  const z = new Float32Array(cols * rows);
  const okRows = new Set();
  let done = 0;
  const one = async j => {
    const n = maxN - j * h / (rows - 1); // Zeile 0 = Norden
    const geom = JSON.stringify({ type: 'LineString', coordinates: [[minE, n], [maxE, n]] });
    const url = 'https://api3.geo.admin.ch/rest/services/profile.json' +
      `?geom=${encodeURIComponent(geom)}&sr=2056&nb_points=${cols}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const pts = await r.json();
    const vals = (Array.isArray(pts) ? pts : []).map(p => {
      const a = p.alts || {};
      return a.DTM2 != null ? a.DTM2 : a.COMB != null ? a.COMB : a.DTM25;
    }).filter(v => isFinite(v));
    if (vals.length < 2) throw new Error('leer');
    for (let i = 0; i < cols; i++) {
      const t = i / (cols - 1) * (vals.length - 1), k = Math.floor(t), f = t - k;
      z[j * cols + i] = vals[k] * (1 - f) + vals[Math.min(k + 1, vals.length - 1)] * f;
    }
    okRows.add(j);
  };
  const queue = Array.from({ length: rows }, (_, j) => j);
  const worker = async () => {
    while (queue.length) {
      const j = queue.shift();
      try { await one(j); } catch (e) { /* Zeile später auffüllen */ }
      done++;
      if (onProgress) onProgress(done / rows);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (okRows.size < rows / 2) throw new Error('Höhendaten nicht erreichbar');
  for (let j = 0; j < rows; j++) {
    if (okRows.has(j)) continue;
    let best = -1;
    for (const k of okRows) if (best < 0 || Math.abs(k - j) < Math.abs(best - j)) best = k;
    z.copyWithin(j * cols, best * cols, best * cols + cols);
  }
  return { cols, rows, z };
}

// Geländeschattierung: Hangschattierung (überhöht, damit auch sanftes Gelände lesbar wird)
// plus leichter Verlauf nach Höhe; hell auf Kuppen und Sonnenhängen, dunkler in Mulden.
function terrainShade(c, plan, pxPerM, sun) {
  const T = plan.terrain;
  if (!T) return;
  const { cols, rows, z } = T;
  const [minE, minN, maxE, maxN] = plan.bbox;
  const dx = (maxE - minE) / (cols - 1), dy = (maxN - minN) / (rows - 1);
  const at = (i, j) => z[clamp(j, 0, rows - 1) * cols + clamp(i, 0, cols - 1)];
  let zmin = Infinity, zmax = -Infinity;
  const gx = new Float32Array(cols * rows), gy = new Float32Array(cols * rows), mags = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, v = z[k];
    if (v < zmin) zmin = v; if (v > zmax) zmax = v;
    gx[k] = (at(i + 1, j) - at(i - 1, j)) / ((Math.min(i + 1, cols - 1) - Math.max(i - 1, 0)) * dx);
    gy[k] = (at(i, j - 1) - at(i, j + 1)) / ((Math.min(j + 1, rows - 1) - Math.max(j - 1, 0)) * dy); // nach Norden
    mags.push(Math.hypot(gx[k], gy[k]));
  }
  mags.sort((a, b) => a - b);
  const p90 = mags[Math.floor(mags.length * 0.9)] || 0;
  const ex = clamp(0.3 / (p90 || 1e-3), 1, 8);
  const ca = Math.cos(Math.PI / 4), sa = Math.sin(Math.PI / 4);
  const L = [sun.toSun[0] * ca, sun.toSun[1] * ca, sa];
  const nc = document.createElement('canvas');
  nc.width = cols; nc.height = rows;
  const x = nc.getContext('2d');
  const img = x.createImageData(cols, rows);
  for (let k = 0; k < cols * rows; k++) {
    const nx = -ex * gx[k], ny = -ex * gy[k], nz = 1, nl = Math.hypot(nx, ny, nz);
    const s = (nx * L[0] + ny * L[1] + nz * L[2]) / nl - L[2];
    const e = (z[k] - zmin) / ((zmax - zmin) || 1) - 0.5;
    const t = s * 1.8 + e * 0.22;
    const col = t > 0 ? [255, 255, 245] : [38, 66, 34];
    img.data[k * 4] = col[0]; img.data[k * 4 + 1] = col[1]; img.data[k * 4 + 2] = col[2];
    img.data[k * 4 + 3] = Math.round(Math.min(0.5, Math.abs(t)) * 255);
  }
  x.putImageData(img, 0, 0);
  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(nc, -0.5 * dx * pxPerM, -0.5 * dy * pxPerM, cols * dx * pxPerM, rows * dy * pxPerM);
  c.restore();
}

/* ---------- Plan zeichnen ---------- */

function faceShade(f, sun) {
  if (!f.dir) return 'rgb(244,244,242)';
  const dot = f.dir[0] * sun.toSun[0] + f.dir[1] * sun.toSun[1];
  const k = Math.min(1, (f.tilt || 30) / 35);
  const v = Math.round(236 + 18 * dot * k);
  return `rgb(${v},${v},${v - 2})`;
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

  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lc = layer.getContext('2d');
  // Ebene zeichnen, Textur nur auf die gezeichneten Pixel legen, dann einblenden
  const composite = (draw, texture, alpha = 1) => {
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);
    lc.lineJoin = 'round'; lc.lineCap = 'round'; lc.setLineDash([]);
    draw(lc);
    if (texture) {
      lc.save();
      lc.globalCompositeOperation = 'source-atop';
      if (typeof texture === 'function') texture(lc);
      else { lc.fillStyle = texture; lc.fillRect(0, 0, W, H); }
      lc.restore();
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
  const linePath = (c, pts) => {
    c.beginPath();
    pts.forEach(([e, n], i) => i ? c.lineTo(X(e), Y(n)) : c.moveTo(X(e), Y(n)));
  };

  // Restflächen (Höfe, Zwischenräume) hellgrau hinterlegen
  ctx.fillStyle = o.ground ? COL.ground : '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const greens = kind => plan.green.filter(g => g.kind === kind).map(g => g.poly);

  // Hilfsebene für Linien in festem Abstand innerhalb einer Fläche (Uferlinien)
  let scratch = null;
  const innerLine = (c, polys, dist, lw, color) => {
    if (!scratch) { scratch = document.createElement('canvas'); scratch.width = W; scratch.height = H; }
    const t = scratch.getContext('2d');
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, W, H);
    t.lineJoin = 'round';
    t.beginPath(); polys.forEach(p => tracePoly(t, p));
    t.strokeStyle = color; t.lineWidth = 2 * dist + lw; t.stroke();
    t.globalCompositeOperation = 'destination-out';
    t.strokeStyle = '#000'; t.lineWidth = Math.max(0, 2 * dist - lw); t.stroke();
    t.globalCompositeOperation = 'destination-in';
    t.fillStyle = '#000'; t.fill('evenodd');
    t.globalCompositeOperation = 'source-over';
    c.drawImage(scratch, 0, 0);
  };

  // Wasser: zur Mitte dunkler (Tiefe), heller Uferstreifen, feine Uferlinien
  const water = greens('water');
  if (water.length) {
    composite(c => {
      fillStroke(c, water, COL.waterDeep, null, 0);
      c.save();
      c.beginPath(); water.forEach(p => tracePoly(c, p)); c.clip('evenodd');
      c.strokeStyle = 'rgba(238,245,250,0.16)';
      for (let k = 9; k >= 1; k--) {
        c.lineWidth = 2 * k * mm(0.8);
        c.beginPath(); water.forEach(p => tracePoly(c, p)); c.stroke();
      }
      c.restore();
      if (o.detail) {
        innerLine(c, water, mm(1.1), mm(0.09), 'rgba(92,136,168,0.6)');
        innerLine(c, water, mm(2.4), mm(0.08), 'rgba(92,136,168,0.4)');
      }
      fillStroke(c, water, null, COL.waterEdge, mm(0.18));
    });
  }

  // Wiese und Wald: Geländeschattierung und Punktsignatur nur auf den Grünflächen
  const greenTex = kind => (o.texture || (o.terrain && plan.terrain)) ? c => {
    if (kind === 'forest') {
      if (o.texture) forestCanopy(c, plan, pxPerM, mm, sun);
      if (o.terrain) terrainShade(c, plan, pxPerM, sun);
      return;
    }
    if (o.terrain) terrainShade(c, plan, pxPerM, sun);
    if (o.texture) stipple(c, plan, pxPerM, mm, kind);
  } : null;
  composite(c => fillStroke(c, greens('grass'), COL.grass, COL.grassEdge, mm(0.13)), greenTex('grass'));
  composite(c => fillStroke(c, greens('forest'), COL.forest, COL.forestEdge, mm(0.13)), greenTex('forest'));

  // Schotterbett der Eisenbahn
  for (const r of plan.rails) {
    if (r.kind === 'tram') continue;
    linePath(ctx, r.lv);
    ctx.lineWidth = 3.4 * pxPerM; ctx.strokeStyle = '#dcd8cf'; ctx.stroke();
  }

  // Strassen
  composite(c => {
    fillStroke(c, plan.roadAreas, COL.paved, COL.edge, mm(0.15));
    const strokeLine = (l, w, col) => {
      c.beginPath();
      l.lv.forEach(([e, n], i) => i ? c.lineTo(X(e), Y(n)) : c.moveTo(X(e), Y(n)));
      c.lineWidth = w; c.strokeStyle = col; c.stroke();
    };
    const edge = mm(0.2), curb = mm(0.12);
    for (const l of plan.roadLines) strokeLine(l, l.outerW * pxPerM + 2 * edge, COL.edge);
    for (const l of plan.roadLines) strokeLine(l, l.outerW * pxPerM,
      l.innerW || l.kind === 'foot' ? COL.sidewalk : COL.carriage);
    for (const l of plan.roadLines) if (l.innerW) strokeLine(l, l.innerW * pxPerM + 2 * curb, COL.curb);
    for (const l of plan.roadLines) if (l.innerW) strokeLine(l, l.innerW * pxPerM, COL.carriage);

    if (o.detail) {
      // Mittellinien
      c.lineCap = 'butt';
      c.setLineDash([3 * pxPerM, 6 * pxPerM]);
      for (const l of plan.roadLines) {
        if ((l.kind === 'major' || l.kind === 'minor') && !l.oneway && (l.innerW || l.outerW) >= 6) {
          strokeLine(l, Math.max(mm(0.1), 0.12 * pxPerM), 'rgba(255,255,255,0.9)');
        }
      }
      c.setLineDash([]);
      c.lineCap = 'round';
      // Fussgängerstreifen
      c.fillStyle = '#ffffff';
      for (const z of plan.zebras) {
        const nx = -z.dy, ny = z.dx;
        for (let t = -z.w / 2 + 0.25; t <= z.w / 2 - 0.25; t += 1.0) {
          const cx = z.e + nx * t, cy = z.n + ny * t;
          const pts = [[2, 0.25], [2, -0.25], [-2, -0.25], [-2, 0.25]]
            .map(([u, v]) => [cx + z.dx * u + nx * v, cy + z.dy * u + ny * v]);
          c.beginPath(); traceRing(c, pts); c.fill();
        }
      }
    }
  }, o.texture ? makePattern(ctx, dpi, 'paving') : null);

  // Gleise
  ctx.strokeStyle = '#5b5b58';
  ctx.lineWidth = mm(0.1);
  for (const r of plan.rails) {
    for (const s of [-0.72, 0.72]) { linePath(ctx, offsetPolyline(r.lv, s)); ctx.stroke(); }
  }

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
        const d = treeDiameter(t, o);
        const len = (t.h0 || d * 1.6) * SHADOW_FACTOR * 0.8 * pxPerM;
        c.beginPath();
        c.arc(X(t.e) + sun.shadow[0] * len, Y(t.n) - sun.shadow[1] * len, d / 2 * pxPerM * 0.95, 0, Math.PI * 2);
        c.fill();
      }
    }, null, 0.2);
  }

  // Parzellen
  fillStroke(ctx, plan.parcels, null, COL.parcel, mm(0.1));

  // Bäume
  for (const t of plan.trees) drawTree(ctx, treeStyle, X(t.e), Y(t.n), treeDiameter(t, o) / 2, t.seed, pxPerM, mm, sun);

  // Gebäude
  if (o.roof && plan.roofFaces.length) {
    for (const f of plan.roofFaces) {
      ctx.beginPath(); tracePoly(ctx, f.poly);
      ctx.fillStyle = faceShade(f, sun); ctx.fill('evenodd');
    }
    ctx.strokeStyle = '#4a4a47'; ctx.lineWidth = mm(0.1);
    for (const f of plan.roofFaces) { ctx.beginPath(); tracePoly(ctx, f.poly); ctx.stroke(); }
    ctx.strokeStyle = '#000'; ctx.lineWidth = mm(0.3);
    for (const p of plan.roofOutlines) { ctx.beginPath(); tracePoly(ctx, p); ctx.stroke(); }
  }
  for (const b of plan.buildings) {
    if (o.roof && b.hasRoof && plan.roofFaces.length) {
      // Fassade unter dem Dachvorsprung gestrichelt
      ctx.setLineDash([mm(1.2), mm(0.8)]);
      ctx.beginPath(); tracePoly(ctx, b.poly);
      ctx.strokeStyle = '#555'; ctx.lineWidth = mm(0.12); ctx.stroke();
      ctx.setLineDash([]);
    } else if (o.roof) {
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

  // Lauben und Durchgänge unter Gebäuden, gestrichelt
  if (o.roof) {
    ctx.setLineDash([mm(1), mm(0.7)]);
    ctx.strokeStyle = '#333'; ctx.lineWidth = mm(0.12);
    for (const l of plan.passages) {
      for (const sgn of [-1, 1]) { linePath(ctx, offsetPolyline(l.lv, sgn * l.outerW / 2)); ctx.stroke(); }
    }
    for (const p of plan.arcades) { ctx.beginPath(); tracePoly(ctx, p); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // Strassennamen
  ctx.font = `italic 500 ${mm(2.1)}px Archivo, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of streetLabels(plan)) {
    ctx.save();
    ctx.translate(X(s.e), Y(s.n));
    ctx.rotate(-s.ang);
    ctx.lineWidth = mm(0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeText(s.name, 0, 0);
    ctx.fillStyle = '#3a3a38';
    ctx.fillText(s.name, 0, 0);
    ctx.restore();
  }

  // Parzellennummern
  if (plan.labels.length) {
    ctx.font = `italic 500 ${mm(2.2)}px Archivo, Arial, sans-serif`;
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
  const roofNote = o.roof
    ? (plan.roofFaces.length ? ' Dachflächen: BFE Sonnendach.ch.' : ' Dachaufsicht schematisch.')
    : '';
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
  c.toBlob(blob => { download(blob, fileBase() + '.png'); askForSupport(); }, 'image/png');
});

ui.btnDxf.addEventListener('click', async () => {
  if (!state.plan) return;
  setStatus('');
  ui.btnDxf.disabled = true;
  progress.start('Erzeuge DXF');
  try {
    const dxf = await buildDXF(state.plan, renderOpts());
    download(new Blob([dxf], { type: 'application/dxf' }), fileBase() + '.dxf');
    progress.done('DXF erzeugt');
    askForSupport();
    setStatus('DXF erzeugt.');
  } catch (err) {
    console.error(err);
    progress.fail();
    setStatus('DXF-Fehler: ' + err.message, true);
  } finally {
    ui.btnDxf.disabled = false;
  }
});

/* ---------- Flächen für DXF ---------- */

async function roadOutlines(plan) {
  const outer = [...plan.roadAreas], inner = [];
  const n = plan.roadLines.length;
  const buf = (coords, w, target) => {
    try {
      const b = turf.buffer(turf.lineString(coords), w / 2, { units: 'meters', steps: 6 });
      if (b) collectPolys({ type: b.geometry.type, coordinates: projectCoords(b.geometry.coordinates) }, target);
    } catch (e) { /* überspringen */ }
  };
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) {
      progress.set(10 + 30 * i / n, 'Erzeuge DXF', `Strassenflächen ${i} von ${n}`);
      await yieldUI();
    }
    const l = plan.roadLines[i];
    buf(l.wgs, l.outerW, outer);
    if (l.innerW) buf(l.wgs, l.innerW, inner);
  }
  progress.set(40, 'Erzeuge DXF', 'Strassenränder werden vereinigt …');
  await yieldUI();
  const o = clipPolys(unionAll(outer), plan.bbox);
  progress.set(50, 'Erzeuge DXF', 'Trottoirkanten werden vereinigt …');
  await yieldUI();
  return { outer: o, inner: clipPolys(unionAll(inner), plan.bbox) };
}

async function shadowPolys(plan, sun) {
  const all = [];
  const n = plan.buildings.length;
  for (let i = 0; i < n; i++) {
    if (i % 25 === 0) {
      progress.set(60 + 25 * i / n, 'Erzeuge DXF', `Schatten ${i} von ${n}`);
      await yieldUI();
    }
    const b = plan.buildings[i];
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
  progress.set(85, 'Erzeuge DXF', 'Schatten werden vereinigt …');
  await yieldUI();
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
async function buildDXF(plan, o) {
  const out = [];
  const g = (code, val) => out.push(String(code), String(val));
  const f = v => v.toFixed(3);
  const bbox = plan.bbox;
  const [minE, minN, maxE, maxN] = bbox;
  const sun = sunVectors(o.sun);

  // Layername, ACI-Farbe, Linientyp
  const layers = [
    ['RAHMEN', 7], ['GEBAEUDE', 7], ['GEBAEUDE_FUELLUNG', 7], ['GEBAEUDE_FASSADE', 8, 'DASHED'],
    ['DACH', 8], ['DACH_UMRISS', 7], ['LAUBEN', 8, 'DASHED'],
    ['SCHATTEN', 9], ['SCHATTEN_FUELLUNG', 254],
    ['STRASSE_RAND', 8], ['TROTTOIRKANTE', 9], ['MARKIERUNG', 9, 'MARKIERUNG'], ['FUSSGAENGERSTREIFEN', 9],
    ['BAHN', 8], ['STRASSENNAMEN', 7],
    ['GRUEN', 3], ['WALD', 94], ['WASSER', 5], ['BAEUME', 94],
    ['BAEUME_KRONE_GESTRICHELT', 94, 'DASHED'], ['BAEUME_AESTE', 94], ['BAEUME_STAMM', 7], ['BAEUME_FUELLUNG', 7], ['BAEUME_BLAETTER', 94],
    ['PARZELLEN', 7], ['PARZELLEN_NR', 7]
  ];
  const dash = 1.2 * plan.scale / 1000, gap = 0.8 * plan.scale / 1000;

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
  g(9, '$EXTMIN'); g(10, f(minE)); g(20, f(minN)); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, f(maxE)); g(20, f(maxN)); g(30, '0.0');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, 'Dashed'); g(72, 65); g(73, 2);
  g(40, f(dash + gap)); g(49, f(dash)); g(49, f(-gap));
  g(0, 'LTYPE'); g(2, 'MARKIERUNG'); g(70, 0); g(3, 'Leitlinie 3 m / 6 m'); g(72, 65); g(73, 2);
  g(40, '9.0'); g(49, '3.0'); g(49, '-6.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [name, color, lt] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, lt || 'CONTINUOUS');
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
  const plineOpen = (layer, pts) => {
    if (pts.length < 2) return;
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(70, 0);
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
    const roads = await roadOutlines(plan);
    for (const p of roads.outer) p.forEach(r => pline('STRASSE_RAND', r));
    for (const p of roads.inner) p.forEach(r => pline('TROTTOIRKANTE', r));
  }
  if (o.detail) {
    for (const l of plan.roadLines) {
      if ((l.kind === 'major' || l.kind === 'minor') && !l.oneway && (l.innerW || l.outerW) >= 6) {
        for (const part of clipLine(l.lv, bbox)) plineOpen('MARKIERUNG', part);
      }
    }
    for (const z of plan.zebras) {
      if (z.e < minE || z.e > maxE || z.n < minN || z.n > maxN) continue;
      const nx = -z.dy, ny = z.dx;
      for (let t = -z.w / 2 + 0.25; t <= z.w / 2 - 0.25; t += 1.0) {
        const cx = z.e + nx * t, cy = z.n + ny * t;
        const ring = [[2, 0.25], [2, -0.25], [-2, -0.25], [-2, 0.25], [2, 0.25]]
          .map(([u, v]) => [cx + z.dx * u + nx * v, cy + z.dy * u + ny * v]);
        pline('FUSSGAENGERSTREIFEN', ring);
      }
    }
  }

  for (const r of plan.rails) {
    for (const sgn of [-0.72, 0.72]) for (const part of clipLine(offsetPolyline(r.lv, sgn), bbox)) plineOpen('BAHN', part);
  }

  for (const p of plan.parcels) p.forEach(r => pline('PARZELLEN', r));

  if (o.shadow && plan.buildings.length) {
    for (const p of await shadowPolys(plan, sun)) {
      p.forEach(r => pline('SCHATTEN', r));
      solids('SCHATTEN_FUELLUNG', p);
    }
  }

  progress.set(90, 'Erzeuge DXF', 'Gebäude und Dächer …');
  await yieldUI();
  const realRoofs = o.roof && plan.roofFaces.length > 0;
  if (realRoofs) {
    for (const fc of plan.roofFaces) for (const p of clipPolys([fc.poly], bbox)) p.forEach(r => pline('DACH', r));
    for (const p of clipPolys(plan.roofOutlines, bbox)) p.forEach(r => pline('DACH_UMRISS', r));
  }
  for (const b of plan.buildings) {
    const clipped = clipPolys([b.poly], bbox);
    if (realRoofs && b.hasRoof) {
      for (const p of clipped) p.forEach(r => pline('GEBAEUDE_FASSADE', r));
      continue;
    }
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

  if (o.roof) {
    for (const l of plan.passages) {
      for (const sgn of [-1, 1]) for (const part of clipLine(offsetPolyline(l.lv, sgn * l.outerW / 2), bbox)) plineOpen('LAUBEN', part);
    }
    for (const p of clipPolys(plan.arcades, bbox)) p.forEach(r => pline('LAUBEN', r));
  }

  for (const t of plan.trees) {
    if (t.e < minE || t.e > maxE || t.n < minN || t.n > maxN) continue;
    const r = treeDiameter(t, o) / 2;
    const at = pts => pts.map(([x, y]) => [t.e + x, t.n + y]);
    const ts = resolveTree(treeStyle);
    if (ts.startsWith('hand_')) {
      const hg = handGeom(ts, r, t.seed, sun);
      if (hg.circle) { g(0, 'CIRCLE'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0'); g(40, f(hg.circle)); }
      if (hg.outline) pline('BAEUME', at(hg.outline));
      for (const l of hg.lines) plineOpen('BAEUME', at(l));
      for (const ring of hg.rings) pline('BAEUME', at(ring));
      for (const l of hg.leaves || []) plineOpen('BAEUME_BLAETTER', at(l));
      for (const fl of hg.fills) { pline('BAEUME_FUELLUNG', at(fl)); solids('BAEUME_FUELLUNG', [at(fl)]); }
      if (hg.cross) {
        line('BAEUME', [t.e - hg.cross, t.n], [t.e + hg.cross, t.n]);
        line('BAEUME', [t.e, t.n - hg.cross], [t.e, t.n + hg.cross]);
      }
      continue;
    }
    if (treeStyle === 'paint' || treeStyle === 'custom') {
      g(0, 'CIRCLE'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0'); g(40, f(r));
      g(0, 'POINT'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0');
      continue;
    }
    const gm = treeGeom(treeStyle, r, t.seed);
    const crownLayer = gm.dashed ? 'BAEUME_KRONE_GESTRICHELT' : 'BAEUME';
    if (gm.outline) pline(crownLayer, at(gm.outline));
    else { g(0, 'CIRCLE'); g(8, crownLayer); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0'); g(40, f(r)); }
    for (const ring of gm.inner) pline('BAEUME', at(ring));
    if (gm.cross) {
      line('BAEUME', [t.e - gm.cross, t.n], [t.e + gm.cross, t.n]);
      line('BAEUME', [t.e, t.n - gm.cross], [t.e, t.n + gm.cross]);
    }
    for (const b of gm.branches) plineOpen('BAEUME_AESTE', at(b.pts));
    if (gm.trunk) {
      const ring = Array.from({ length: 17 }, (_, i) => {
        const a = i / 16 * Math.PI * 2;
        return [t.e + Math.cos(a) * gm.trunk, t.n + Math.sin(a) * gm.trunk];
      });
      pline('BAEUME_STAMM', ring);
      solids('BAEUME_STAMM', [ring]);
    } else {
      g(0, 'POINT'); g(8, 'BAEUME'); g(10, f(t.e)); g(20, f(t.n)); g(30, '0.0');
    }
  }

  const nameH = 2.1 * plan.scale / 1000;
  for (const sl of streetLabels(plan)) {
    g(0, 'TEXT'); g(8, 'STRASSENNAMEN');
    g(10, f(sl.e)); g(20, f(sl.n)); g(30, '0.0');
    g(40, f(nameH)); g(1, asciiSafe(sl.name)); g(50, f(sl.ang * 180 / Math.PI));
    g(72, 1); g(73, 2);
    g(11, f(sl.e)); g(21, f(sl.n)); g(31, '0.0');
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
// Kurz an den Browser abgeben, damit Fortschritt gezeichnet wird (auch im Hintergrund-Tab)
function yieldUI() {
  return new Promise(r => {
    let done = false;
    const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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

/* =========================================================
   Fortschrittsanzeige
   ========================================================= */
const progress = {
  el: $('progress'), bar: $('progBar'), pct: $('progPct'), label: $('progLabel'), detail: $('progDetail'),
  value: 0, hideTimer: null,
  start(label) {
    clearTimeout(this.hideTimer);
    this.value = 0;
    this.el.hidden = false;
    this.set(0, label, '');
  },
  set(v, label, detail) {
    v = clamp(v, 0, 100);
    if (v < this.value) v = this.value; // nie rückwärts
    this.value = v;
    this.bar.style.width = v + '%';
    this.pct.textContent = Math.round(v) + ' %';
    this.el.setAttribute('aria-valuenow', String(Math.round(v)));
    if (label != null) this.label.textContent = label;
    if (detail != null) this.detail.textContent = detail;
  },
  done(label) {
    this.set(100, label || 'Fertig', '');
    this.hideTimer = setTimeout(() => { this.el.hidden = true; }, 900);
  },
  fail() { this.el.hidden = true; }
};

/* =========================================================
   3D-Daten von swisstopo (STAC API)
   ========================================================= */
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/';
const DATASETS = {
  cloud: { id: 'ch.swisstopo.swisssurface3d', title: 'Punktwolke swissSURFACE3D', unit: 'Kachel', units: 'Kacheln' },
  bldg: { id: 'ch.swisstopo.swissbuildings3d_3_0', title: '3D-Gebäude swissBUILDINGS3D 3.0', unit: 'Kartenblatt', units: 'Kartenblätter' }
};
const dl3d = $('dl3d');

async function stacItems(collection, bboxWgs, onPage) {
  let url = `${STAC}${collection}/items?bbox=${bboxWgs.join(',')}&limit=100`;
  const items = [];
  for (let page = 0; url && page < 30; page++) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    items.push(...(j.features || []));
    if (onPage) onPage(items.length);
    const next = (j.links || []).find(l => l.rel === 'next');
    url = next ? next.href : null;
  }
  return items;
}

// Pro Kachel nur den neusten Jahrgang behalten
function latestPerTile(items) {
  const best = new Map();
  for (const it of items) {
    const m = /_(\d{4})_([0-9-]+)$/.exec(it.id);
    const tile = m ? m[2] : it.id, year = m ? +m[1] : 0;
    const cur = best.get(tile);
    if (!cur || year > cur.year) best.set(tile, { tile, year, item: it });
  }
  return [...best.values()].sort((a, b) => a.tile.localeCompare(b.tile));
}

function formatOf(href) {
  const name = href.split('/').pop().toLowerCase();
  const m = /\.([a-z0-9]+)\.zip$/.exec(name) || /\.([a-z0-9]+)$/.exec(name);
  return m ? m[1].toUpperCase() : 'Datei';
}

function fmtBytes(n) {
  if (!n) return '';
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return Math.round(n / 1e6) + ' MB';
  return Math.round(n / 1e3) + ' kB';
}

async function search3d(kind) {
  const ds = DATASETS[kind];
  const [s, w, n, e] = wgsBounds(getBBox());
  ui.btnCloud.disabled = ui.btnBldg3d.disabled = true;
  progress.start('Suche ' + ds.units);
  progress.set(10, null, 'Frage swisstopo an …');
  try {
    const items = await stacItems(ds.id, [w, s, e, n], count => progress.set(30, null, `${count} Einträge gefunden`));
    progress.set(70, null, 'Wähle den neusten Stand pro ' + ds.unit + ' …');
    const tiles = latestPerTile(items);
    const files = [];
    for (const t of tiles) {
      for (const [name, a] of Object.entries(t.item.assets || {})) {
        files.push({ tile: t.tile, year: t.year, name, href: a.href, fmt: formatOf(a.href), size: a['file:size'] || 0 });
      }
    }
    progress.done(`${tiles.length} ${tiles.length === 1 ? ds.unit : ds.units} gefunden`);
    render3d(kind, tiles.length, files);
  } catch (err) {
    console.error(err);
    progress.fail();
    dl3d.hidden = false;
    dl3d.innerHTML = `<p class="status error">Suche fehlgeschlagen: ${escapeHtml(err.message)}</p>`;
  } finally {
    ui.btnCloud.disabled = ui.btnBldg3d.disabled = false;
  }
}

function render3d(kind, tileCount, files) {
  const ds = DATASETS[kind];
  dl3d.hidden = false;
  if (!files.length) {
    dl3d.innerHTML = `<p>Für diesen Ausschnitt gibt es keine Daten von ${escapeHtml(ds.title)}.</p>`;
    return;
  }
  const formats = [...new Set(files.map(f => f.fmt))];
  const pref = ['DXF', 'DWG', 'GML', 'GDB', 'LAS', 'LAZ'];
  formats.sort((a, b) => (pref.indexOf(a) + 99) % 99 - (pref.indexOf(b) + 99) % 99);
  let fmt = formats[0];

  const draw = () => {
    const list = files.filter(f => f.fmt === fmt);
    const [minE, minN, maxE, maxN] = getBBox().map(v => Math.round(v));
    const cropHelp = kind === 'cloud' ? `
      <details>
        <summary>Auf den Ausschnitt zuschneiden</summary>
        <p class="hint">Jede Kachel deckt 1 km² ab. Nach dem Entpacken lässt sich die Punktwolke z.B. mit PDAL auf den Ausschnitt zuschneiden:</p>
        <pre id="pdalCmd">pdal merge ${list.map(f => escapeHtml(f.name.replace(/\.zip$/, ''))).join(' ')} merged.las
pdal translate merged.las ausschnitt.laz crop --filters.crop.bounds="([${minE}, ${maxE}], [${minN}, ${maxN}])"</pre>
        <button id="copyPdal">Befehle kopieren</button>
      </details>` : '';
    dl3d.innerHTML = `
      <div class="dl-head"><span><strong>${escapeHtml(ds.title)}</strong></span><span>${tileCount} ${tileCount === 1 ? ds.unit : ds.units}</span></div>
      ${formats.length > 1 ? `<label class="inline">Format<select id="fmt3d">${formats.map(f => `<option${f === fmt ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select></label>` : ''}
      <ul class="dl-list">
        ${list.map((f, i) => `<li><a href="${escapeHtml(f.href)}" rel="noopener" title="${escapeHtml(f.name)}">${escapeHtml(f.tile)} (${f.year || 'o. J.'})</a><span class="size" data-i="${i}">${fmtBytes(f.size)}</span></li>`).join('')}
      </ul>
      <button id="dlAll">Alle ${list.length} herunterladen</button>
      <p class="hint">Die Downloads starten einzeln. Erlaubt der Browser nachfragen, mehrere Dateien zuzulassen. Punktwolken-Kacheln sind gross, oft mehrere hundert MB.</p>
      ${cropHelp}`;

    const sel = $('fmt3d');
    if (sel) sel.addEventListener('change', () => { fmt = sel.value; draw(); });
    $('dlAll').addEventListener('click', () => downloadAll(list));
    const cp = $('copyPdal');
    if (cp) cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('pdalCmd').textContent); cp.textContent = 'Kopiert'; }
      catch (e) { cp.textContent = 'Kopieren nicht möglich'; }
    });
    fillSizes(list);
  };
  draw();
}

// Dateigrössen nachladen, falls die API sie nicht mitliefert
async function fillSizes(list) {
  const queue = list.map((f, i) => ({ f, i })).filter(x => !x.f.size);
  const worker = async () => {
    while (queue.length) {
      const { f, i } = queue.shift();
      try {
        const r = await fetch(f.href, { method: 'HEAD' });
        f.size = +r.headers.get('Content-Length') || 0;
      } catch (e) { f.size = 0; }
      const el = dl3d.querySelector(`.size[data-i="${i}"]`);
      if (el) el.textContent = fmtBytes(f.size);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// Mehrere Downloads über unsichtbare iframes, damit die Seite nicht verlassen wird
function downloadAll(list) {
  list.forEach((f, k) => setTimeout(() => {
    const fr = document.createElement('iframe');
    fr.style.display = 'none';
    fr.src = f.href;
    document.body.appendChild(fr);
    setTimeout(() => fr.remove(), 120000);
  }, k * 1500));
  setStatus(`${list.length} Downloads werden gestartet …`);
}

ui.btnCloud = $('btnCloud');
ui.btnBldg3d = $('btnBldg3d');
ui.btnCloud.addEventListener('click', () => search3d('cloud'));
ui.btnBldg3d.addEventListener('click', () => search3d('bldg'));

/* =========================================================
   Freiwilliger Beitrag: Fenster nach dem Download, höchstens einmal pro Sitzung
   ========================================================= */
const donateDlg = $('donate');
(function buildDonate() {
  const box = $('donateAmounts');
  for (const amt of DONATE.amounts) {
    const a = document.createElement('a');
    a.textContent = `${amt} ${DONATE.currency === 'EUR' ? '€' : DONATE.currency}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = `${DONATE.url}&amount=${amt}&currency_code=${DONATE.currency}`;
    a.addEventListener('click', () => setTimeout(() => donateDlg.close(), 300));
    box.appendChild(a);
  }
})();

function showDonate() {
  if (typeof donateDlg.showModal === 'function') donateDlg.showModal();
  else donateDlg.setAttribute('open', '');
}

// Nach jedem Export (PNG oder DXF) kurz nach dem Start des Downloads anzeigen
function askForSupport() {
  setTimeout(showDonate, 600);
}

$('btnSupport').addEventListener('click', showDonate);

buildTreePicker();
applyStylePreset();
updatePerimeter();
