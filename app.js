/* Riparian exclusion mockup — app shell.
 * Halter-style demo map. No framework, no build step. See SPEC.md §5.
 */
'use strict';

/* ---------------- Constants ---------------- */

// Client-side basemap key by design (SPEC trap #13): Toby must add a referrer
// restriction in the ArcGIS dashboard before this URL circulates.
// The basemap key lives in config.js (kept out of git — see config.example.js).
const ARCGIS_KEY = window.ARCGIS_KEY || '';
const BASEMAP_STYLE = 'https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/arcgis/imagery?token=' + ARCGIS_KEY;

// Real data lands in data/. Until it exists, fetches fall back to stub-data/
// (tiny fake shapes) with zero code changes.
const DATA_ROOT = 'data';
const STUB_ROOT = 'stub-data';

const LAYER_FILES = ['exclusion', 'water_gaps', 'paddock', 'allotments', 'ownership', 'springs'];

const REGIONS = {
  'red-canyon': { label: 'Red Canyon', center: [-108.65, 42.63], zoom: 12.4 },
  'bear-lake':  { label: 'Bear Lake',  center: [-111.302, 41.999], zoom: 12.2 }
};

const GAP_HALF_M = 15; // half of the 30 m gap width, for point→square seals

/* ---------------- State ---------------- */

let map;
let currentRegion = 'red-canyon';
const regionData = {};      // region -> {layer: FeatureCollection}
const gapOpenState = {};    // region -> {gapId: bool}
let usedStubData = false;
let geolocate;

/* ---------------- Data loading ---------------- */

async function fetchLayer(region, layer) {
  for (const root of [DATA_ROOT, STUB_ROOT]) {
    try {
      const res = await fetch(`${root}/${region}/${layer}.geojson`);
      if (res.ok) {
        if (root === STUB_ROOT) usedStubData = true;
        return await res.json();
      }
    } catch (e) { /* offline or missing — try next root / give up quietly */ }
  }
  return { type: 'FeatureCollection', features: [] };
}

async function loadRegion(region) {
  if (regionData[region]) return regionData[region];
  const out = {};
  const results = await Promise.all(LAYER_FILES.map(l => fetchLayer(region, l)));
  LAYER_FILES.forEach((l, i) => { out[l] = results[i]; });
  // Toby places every water gap himself — ignore any shipped/default gaps,
  // and restore the gaps he placed earlier on this device.
  out.water_gaps.features = out.water_gaps.features.filter(
    f => String(f.properties && f.properties.id).startsWith('user-'));
  try {
    const saved = JSON.parse(localStorage.getItem('userGaps:' + region));
    if (saved && Array.isArray(saved.feats)) {
      out.water_gaps.features = saved.feats;
      gapOpenState[region] = saved.state || {};
    }
  } catch (e) { /* no saved gaps, or storage unavailable — start clean */ }
  regionData[region] = out;
  // seed gap open/closed state from the data (default: open)
  gapOpenState[region] = gapOpenState[region] || {};
  for (const f of out.water_gaps.features) {
    const id = f.properties.id;
    if (!(id in gapOpenState[region])) {
      gapOpenState[region][id] = f.properties.open !== false;
    }
  }
  return out;
}

/* ---------------- Gap geometry helpers ---------------- */

function polygonCentroid(geom) {
  const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0];
  let x = 0, y = 0;
  for (const c of ring) { x += c[0]; y += c[1]; }
  return [x / ring.length, y / ring.length];
}

function squareAround(lon, lat, halfM) {
  const dLat = halfM / 111320;
  const dLon = halfM / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    type: 'Polygon',
    coordinates: [[
      [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
      [lon - dLon, lat - dLat]
    ]]
  };
}

// From raw water_gaps features build two collections: icon points, and seal
// polygons — the precomputed "closed" patch drawn in red atop the exclusion
// layer (visual seal, no geometry math on the phone). The pipeline ships each
// gap as a Point ("wg-a1") plus a plug polygon ("wg-a1-plug"); pair them by
// id. A lone point gets a synthesized 30 m square; a lone polygon stands on
// its own with its centroid as the icon anchor.
function buildGapCollections(region) {
  const raw = regionData[region].water_gaps.features;
  const state = gapOpenState[region];
  const pts = raw.filter(f => f.geometry.type === 'Point');
  const polys = raw.filter(f => f.geometry.type !== 'Point');
  const usedPoly = new Set();
  const gaps = [];
  for (const f of pts) {
    const pid = f.properties.id;
    const seal =
      polys.find(q => q.properties.id === pid + '-plug') ||
      polys.find(q => !usedPoly.has(q.properties.id) && q.properties.name === f.properties.name) ||
      null;
    if (seal) usedPoly.add(seal.properties.id);
    const c = f.geometry.coordinates;
    gaps.push({
      id: pid, name: f.properties.name, width_m: f.properties.width_m || 30,
      center: c,
      sealGeom: seal ? seal.geometry : squareAround(c[0], c[1], GAP_HALF_M)
    });
  }
  for (const q of polys) {
    if (usedPoly.has(q.properties.id)) continue;
    gaps.push({
      id: q.properties.id, name: q.properties.name, width_m: q.properties.width_m || 30,
      center: polygonCentroid(q.geometry), sealGeom: q.geometry
    });
  }
  const points = [], seals = [];
  for (const g of gaps) {
    const open = state[g.id] !== false;
    const props = { id: g.id, name: g.name || 'Water gap', width_m: g.width_m, open };
    points.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: g.center } });
    seals.push({ type: 'Feature', properties: props, geometry: g.sealGeom });
  }
  return {
    points: { type: 'FeatureCollection', features: points },
    seals: { type: 'FeatureCollection', features: seals }
  };
}

/* ---------------- Map setup ---------------- */

function makeDropletImage(fillColor) {
  const s = 44, r = window.devicePixelRatio || 1;
  const cv = document.createElement('canvas');
  cv.width = s * r; cv.height = s * r;
  const g = cv.getContext('2d');
  g.scale(r, r);
  g.beginPath();
  g.moveTo(22, 5);
  g.bezierCurveTo(28, 15, 34, 21, 34, 27);
  g.arc(22, 27, 12, 0, Math.PI, false);
  g.bezierCurveTo(10, 21, 16, 15, 22, 5);
  g.closePath();
  g.fillStyle = fillColor;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = '#ffffff';
  g.stroke();
  return { img: g.getImageData(0, 0, s * r, s * r), ratio: r };
}

function firstSymbolFont() {
  try {
    const found = [];
    for (const lyr of map.getStyle().layers) {
      if (lyr.type === 'symbol' && lyr.layout && lyr.layout['text-font']) {
        const f = lyr.layout['text-font'];
        if (Array.isArray(f)) found.push(...f.filter(x => typeof x === 'string'));
        else if (typeof f === 'string') found.push(f);
      }
    }
    const reg = found.find(f => /regular/i.test(f));
    if (reg) return [reg];
    if (found.length) return [found[0]];
  } catch (e) { /* fall through */ }
  return ['Arial Regular'];
}

function addSourcesAndLayers() {
  const d = regionData[currentRegion];
  const gaps = buildGapCollections(currentRegion);

  map.addSource('ownership', { type: 'geojson', data: d.ownership });
  map.addSource('allotments', { type: 'geojson', data: d.allotments });
  map.addSource('exclusion', { type: 'geojson', data: d.exclusion });
  map.addSource('gap-seals', { type: 'geojson', data: gaps.seals });
  map.addSource('gap-points', { type: 'geojson', data: gaps.points });
  map.addSource('paddock', { type: 'geojson', data: d.paddock });
  map.addSource('springs', { type: 'geojson', data: d.springs });

  const ownerStr = ['downcase', ['to-string', ['coalesce', ['get', 'owner'], ['get', 'name'], '']]];

  // Ownership: muted tints. BLM yellow, state blue, USFWS purple, private untinted.
  map.addLayer({
    id: 'ownership-fill', type: 'fill', source: 'ownership',
    layout: { visibility: 'none' },
    paint: {
      'fill-color': ['case',
        ['in', 'blm', ownerStr], 'rgba(255, 214, 79, 0.22)',
        ['in', 'bureau of land', ownerStr], 'rgba(255, 214, 79, 0.22)',
        ['in', 'usfws', ownerStr], 'rgba(171, 71, 188, 0.25)',
        ['in', 'fish and wildlife', ownerStr], 'rgba(171, 71, 188, 0.25)',
        ['in', 'state', ownerStr], 'rgba(66, 165, 245, 0.22)',
        'rgba(0,0,0,0)']
    }
  });

  // Allotments: thin orange outlines + name labels.
  map.addLayer({
    id: 'allotments-line', type: 'line', source: 'allotments',
    paint: { 'line-color': '#ff9d2e', 'line-width': 1.5, 'line-opacity': 0.9 }
  });
  map.addLayer({
    id: 'allotments-label', type: 'symbol', source: 'allotments',
    layout: {
      'text-field': ['format',
        ['get', 'name'], {},
        '\n', {},
        ['get', 'source'], { 'font-scale': 0.72 }],
      'text-font': firstSymbolFont(),
      'text-size': 13,
      'symbol-placement': 'point'
    },
    paint: {
      'text-color': '#ffc46b',
      'text-halo-color': 'rgba(0,0,0,0.85)',
      'text-halo-width': 1.4
    }
  });

  // Exclusion: translucent light-blue fill, solid edge (calm, not aggressive).
  map.addLayer({
    id: 'exclusion-fill', type: 'fill', source: 'exclusion',
    paint: { 'fill-color': '#6fb3e8', 'fill-opacity': 0.3 }
  });
  map.addLayer({
    id: 'exclusion-line', type: 'line', source: 'exclusion',
    paint: { 'line-color': '#4f9fd9', 'line-width': 2 }
  });

  // Water gaps. OPEN = a real hole cut out of the exclusion polygons (see
  // displayedExclusionFC) — the ground shows through; only a dashed white
  // gate outline marks where it is. CLOSED = no cut; a subtle solid outline.
  map.addLayer({
    id: 'gap-fill', type: 'fill', source: 'gap-seals',
    filter: ['==', ['get', 'open'], false],
    paint: { 'fill-color': '#6fb3e8', 'fill-opacity': 0.12 }
  });
  map.addLayer({
    id: 'gap-line-open', type: 'line', source: 'gap-seals',
    filter: ['==', ['get', 'open'], true],
    paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1.5] }
  });
  map.addLayer({
    id: 'gap-line-closed', type: 'line', source: 'gap-seals',
    filter: ['==', ['get', 'open'], false],
    paint: { 'line-color': '#4f9fd9', 'line-width': 2.5 }
  });

  // Paddock: white/yellow line with a soft glow.
  map.addLayer({
    id: 'paddock-glow', type: 'line', source: 'paddock',
    paint: { 'line-color': '#fff8c4', 'line-width': 7, 'line-opacity': 0.25, 'line-blur': 2 }
  });
  map.addLayer({
    id: 'paddock-line', type: 'line', source: 'paddock',
    paint: { 'line-color': '#f6f0b8', 'line-width': 2.5 }
  });

  // Springs: small light-blue dots.
  map.addLayer({
    id: 'springs-dot', type: 'circle', source: 'springs',
    paint: {
      'circle-radius': 4.5,
      'circle-color': '#7fe3ff',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5
    }
  });

  // Data-source labels: every feature says where its data really came from
  // (the "source" property written by the pipeline). Toggleable in the sheet.
  const srcLabelPaint = {
    'text-color': '#d8ecff',
    'text-halo-color': 'rgba(0,0,0,0.85)',
    'text-halo-width': 1.3
  };
  map.addLayer({
    id: 'exclusion-source-label', type: 'symbol', source: 'exclusion',
    minzoom: 11.5,
    layout: {
      'text-field': ['get', 'source'],
      'text-font': firstSymbolFont(),
      'text-size': 10,
      'symbol-placement': 'point',
      'text-allow-overlap': false
    },
    paint: srcLabelPaint
  });
  map.addLayer({
    id: 'paddock-source-label', type: 'symbol', source: 'paddock',
    minzoom: 11,
    layout: {
      'text-field': ['concat', 'Paddock — ', ['get', 'source']],
      'text-font': firstSymbolFont(),
      'text-size': 10,
      'symbol-placement': 'line',
      'text-offset': [0, 1]
    },
    paint: { ...srcLabelPaint, 'text-color': '#f6f0b8' }
  });
  map.addLayer({
    id: 'ownership-source-label', type: 'symbol', source: 'ownership',
    minzoom: 11,
    layout: {
      visibility: 'none',
      'text-field': ['concat', ['get', 'name'], ' — ', ['get', 'source']],
      'text-font': firstSymbolFont(),
      'text-size': 10,
      'symbol-placement': 'point'
    },
    paint: { ...srcLabelPaint, 'text-color': '#ffe9a8' }
  });
  map.addLayer({
    id: 'springs-source-label', type: 'symbol', source: 'springs',
    minzoom: 13.5,
    layout: {
      'text-field': ['get', 'source'],
      'text-font': firstSymbolFont(),
      'text-size': 9,
      'text-offset': [0, 1.1],
      'text-anchor': 'top'
    },
    paint: { ...srcLabelPaint, 'text-color': '#bff0ff' }
  });

  // Droplet markers on top.
  map.addLayer({
    id: 'gap-icons', type: 'symbol', source: 'gap-points',
    layout: {
      'icon-image': ['case', ['get', 'open'], 'drop-open', 'drop-closed'],
      'icon-size': 0.75,
      'icon-allow-overlap': true
    }
  });
}

// Exclusion as displayed: the pristine pipeline polygons minus every OPEN
// water gap (a real geometry cut via turf.difference, so the ground shows
// through the gap — no layers stacked on top). Closed gaps cut nothing.
function displayedExclusionFC(region) {
  const orig = regionData[region].exclusion;
  const state = gapOpenState[region];
  const cutters = [];
  const gaps = buildGapCollections(region);
  for (const s of gaps.seals.features) {
    if (state[s.properties.id] !== false) cutters.push(s); // open gaps cut
  }
  if (!cutters.length || typeof turf === 'undefined') return orig;
  const feats = orig.features.map(f => {
    let g = f;
    for (const c of cutters) {
      try {
        if (turf.booleanIntersects(g, c)) {
          const diff = turf.difference(turf.featureCollection([g, c]));
          if (diff) { diff.properties = f.properties; g = diff; }
        }
      } catch (e) { /* keep the un-cut feature rather than crash */ }
    }
    return g;
  }).filter(Boolean);
  return { type: 'FeatureCollection', features: feats };
}

function refreshRegionSources() {
  const d = regionData[currentRegion];
  const gaps = buildGapCollections(currentRegion);
  map.getSource('ownership').setData(d.ownership);
  map.getSource('allotments').setData(d.allotments);
  map.getSource('exclusion').setData(displayedExclusionFC(currentRegion));
  map.getSource('gap-seals').setData(gaps.seals);
  map.getSource('gap-points').setData(gaps.points);
  map.getSource('paddock').setData(d.paddock);
  map.getSource('springs').setData(d.springs);
}

function refreshGapSources() {
  const gaps = buildGapCollections(currentRegion);
  map.getSource('gap-seals').setData(gaps.seals);
  map.getSource('gap-points').setData(gaps.points);
  map.getSource('exclusion').setData(displayedExclusionFC(currentRegion));
}

/* ---------------- UI helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showHintCard() {
  $('#card-body').innerHTML =
    '<p class="card-kicker">Now</p>' +
    '<p class="card-main">Cows stay out of the shaded blue areas. Tap a water drop to open or close a water gap.</p>';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showExclusionCard(props) {
  const acres = (props.acres != null) ? Math.round(props.acres).toLocaleString() : null;
  const attrs = [];
  if (props.strm_type) attrs.push('dominant Strm_Type: ' + esc(props.strm_type));
  if (props.veg_pct != null) attrs.push('mesic persistence (Veg_Pct): ' + Math.round(props.veg_pct) + '%');
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Exclusion zone</p>' +
    `<p class="card-main">${esc(props.name || 'Creek bottom')}${acres ? ' &middot; ' + acres + ' acres' : ''}</p>` +
    '<p class="card-sub" style="font-size:12px;line-height:1.5">' +
    '<b>Selection rule</b> (per mesic valley-bottom segment): ' +
    '(Strm_Type &isin; {Perennial, Intermittent} AND Veg_Pct &gt; 50) OR ' +
    '(Veg_Pct + Tree_Pct &gt; 60 AND Tree_Pct &gt; 15); Slope_Deg &lt; 15&deg;; area &ge; 0.25 ac; ' +
    'segments deduped on geometry WKB.<br>' +
    '<b>Inputs</b>: Mesic Analysis Platform valley-bottom segments (30 m Landsat, 1984&ndash;2025 late-season NDVI persistence) ' +
    '&cup; NWI riparian + wetland supplement &cup; USGS 3DHP hydrography.<br>' +
    '<b>Post-processing</b> (EPSG:6341): dissolve &rarr; morphological closing &plusmn;20 m &rarr; simplify 5 m ' +
    '&rarr; drop holes &lt; 1 ac &rarr; subtract road corridors (TIGER/UGRC centerlines, 5 m half-width) at crossings.' +
    (attrs.length ? '<br><b>This polygon</b>: ' + attrs.join('; ') + '.' : '') +
    '</p>' +
    (props.source ? `<p class="card-sub" style="opacity:.7">Source tag: ${esc(props.source)}</p>` : '');
  $('.card-close').onclick = showHintCard;
}

function showGapCard(props) {
  const open = gapOpenState[currentRegion][props.id] !== false;
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Water gap</p>' +
    `<p class="card-main">${esc(props.name || 'Water gap')}</p>` +
    `<p class="card-sub" id="gap-status">${open
      ? 'Open. Cows can walk in here to drink. The gap is about 100 feet wide.'
      : 'Closed. Cows cannot reach the water here.'}</p>` +
    '<div class="gap-toggle">' +
    `<button id="gap-open-btn" class="${open ? 'sel-open' : ''}">Open</button>` +
    `<button id="gap-close-btn" class="${open ? '' : 'sel-closed'}">Closed</button>` +
    '</div>' +
    (String(props.id).startsWith('user-')
      ? '<button id="gap-del-btn" class="gap-remove">Remove this gap</button>'
      : '');
  $('.card-close').onclick = showHintCard;
  $('#gap-open-btn').onclick = () => setGap(props, true);
  $('#gap-close-btn').onclick = () => setGap(props, false);
  const del = $('#gap-del-btn');
  if (del) del.onclick = () => removeUserGap(props);
}

function saveUserGaps(region) {
  try {
    localStorage.setItem('userGaps:' + region, JSON.stringify({
      feats: regionData[region].water_gaps.features,
      state: gapOpenState[region]
    }));
  } catch (e) { /* private mode or storage full — gaps just won't persist */ }
}

function setGap(props, open) {
  gapOpenState[currentRegion][props.id] = open;
  refreshGapSources();
  saveUserGaps(currentRegion);
  showGapCard(props);
  toast(open ? 'Gap open. Cows can drink here.' : 'Gap closed. The line is sealed.');
}

/* ---------------- Rancher-placed water gaps ----------------
   UX (per field research): tap the + button, then tap anywhere near the blue
   fence line. The gap snaps to the nearest point on the exclusion boundary
   (48 px tolerance — glove-friendly). Tap again to move it. Done keeps it,
   Cancel throws it away. Fixed 30 m width; nothing small to drag. */

let placingGap = false;
let pendingGapCenter = null;
let userGapCounter = 0;

function exclusionRings() {
  const rings = [];
  for (const f of regionData[currentRegion].exclusion.features) {
    const g = f.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  }
  return rings;
}

// Nearest point on the exclusion boundary to the tap, in screen pixels.
function snapToBoundary(pointPx, tolPx) {
  let best = null, bestD = tolPx;
  for (const ring of exclusionRings()) {
    let a = map.project(ring[0]);
    for (let i = 1; i < ring.length; i++) {
      const b = map.project(ring[i]);
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      let t = len2 ? ((pointPx.x - a.x) * abx + (pointPx.y - a.y) * aby) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * abx, py = a.y + t * aby;
      const d = Math.hypot(pointPx.x - px, pointPx.y - py);
      if (d < bestD) { bestD = d; best = { x: px, y: py }; }
      a = b;
    }
  }
  return best ? map.unproject([best.x, best.y]) : null;
}

function pendingFeature() {
  return regionData[currentRegion].water_gaps.features
    .find(f => f.properties.id === 'user-pending');
}

function showPlacementCard() {
  const has = !!pendingGapCenter;
  $('#card-body').innerHTML =
    '<p class="card-kicker">New water gap</p>' +
    `<p class="card-main">${has
      ? 'Gap placed. Tap another spot on the line to move it.'
      : 'Tap the blue fence line where cows should walk in to drink.'}</p>` +
    '<div class="gap-toggle">' +
    (has ? '<button id="gap-done-btn" class="sel-open">Done</button>' : '') +
    '<button id="gap-cancel-btn">Cancel</button>' +
    '</div>';
  if (has) $('#gap-done-btn').onclick = finishGapPlacement;
  $('#gap-cancel-btn').onclick = cancelGapPlacement;
}

function enterGapPlacement() {
  if (placingGap) return;
  placingGap = true;
  pendingGapCenter = null;
  map.touchZoomRotate.disableRotation();
  if (map.getZoom() < 14.5) map.easeTo({ zoom: 15, essential: true });
  showPlacementCard();
}

function handlePlacementTap(e) {
  const snapped = snapToBoundary(e.point, 48);
  if (!snapped) { toast('Tap right on the blue line.'); return; }
  pendingGapCenter = [snapped.lng, snapped.lat];
  const feats = regionData[currentRegion].water_gaps.features;
  let f = pendingFeature();
  if (!f) {
    f = {
      type: 'Feature',
      properties: { id: 'user-pending', name: 'My water gap', width_m: 30, open: true, source: 'placed by you' },
      geometry: { type: 'Point', coordinates: pendingGapCenter }
    };
    feats.push(f);
    gapOpenState[currentRegion]['user-pending'] = true;
  } else {
    f.geometry.coordinates = pendingGapCenter;
  }
  refreshGapSources();
  showPlacementCard();
}

function finishGapPlacement() {
  const f = pendingFeature();
  if (f) {
    userGapCounter += 1;
    const newId = 'user-' + Date.now();
    f.properties.id = newId;
    f.properties.name = 'My water gap ' + userGapCounter;
    gapOpenState[currentRegion][newId] = true;
    delete gapOpenState[currentRegion]['user-pending'];
  }
  exitGapPlacement();
  refreshGapSources();
  saveUserGaps(currentRegion);
  if (f) { showGapCard(f.properties); toast('Water gap saved.'); }
}

function cancelGapPlacement() {
  const feats = regionData[currentRegion].water_gaps.features;
  const i = feats.findIndex(x => x.properties.id === 'user-pending');
  if (i >= 0) feats.splice(i, 1);
  delete gapOpenState[currentRegion]['user-pending'];
  exitGapPlacement();
  refreshGapSources();
  showHintCard();
}

function exitGapPlacement() {
  placingGap = false;
  pendingGapCenter = null;
  map.touchZoomRotate.enableRotation();
}

/* Drag-to-move: press a droplet and drag — the gap slides along, snapping to
   the exclusion boundary (standard marker-drag; no modifier keys). */
let draggingGapId = null;

function wireGapDragging() {
  const start = (e) => {
    const f = e.features && e.features[0];
    if (!f || !String(f.properties.id).startsWith('user-')) return;
    e.preventDefault();
    draggingGapId = f.properties.id;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  };
  const move = (e) => {
    if (!draggingGapId) return;
    const snapped = snapToBoundary(e.point, 120) || e.lngLat;
    const feat = regionData[currentRegion].water_gaps.features.find(
      x => x.properties.id === draggingGapId);
    if (feat) {
      feat.geometry.coordinates = [snapped.lng, snapped.lat];
      refreshGapSources();
    }
  };
  const end = () => {
    if (!draggingGapId) return;
    draggingGapId = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    saveUserGaps(currentRegion);
    toast('Water gap moved.');
  };
  map.on('mousedown', 'gap-icons', start);
  map.on('touchstart', 'gap-icons', start);
  map.on('mousemove', move);
  map.on('touchmove', move);
  map.on('mouseup', end);
  map.on('touchend', end);
  map.on('mouseenter', 'gap-icons', () => { map.getCanvas().style.cursor = 'grab'; });
  map.on('mouseleave', 'gap-icons', () => { if (!draggingGapId) map.getCanvas().style.cursor = ''; });
}

function removeUserGap(props) {
  const feats = regionData[currentRegion].water_gaps.features;
  const i = feats.findIndex(x => x.properties.id === props.id);
  if (i >= 0) feats.splice(i, 1);
  delete gapOpenState[currentRegion][props.id];
  refreshGapSources();
  saveUserGaps(currentRegion);
  showHintCard();
  toast('Water gap removed.');
}

/* ---------------- Sheets, nav, region switching ---------------- */

let scrimEl = null;
function closeSheets() {
  $('#layer-sheet').hidden = true;
  $('#region-menu').hidden = true;
  if (scrimEl) { scrimEl.remove(); scrimEl = null; }
}
function openSheet(el) {
  closeSheets();
  scrimEl = document.createElement('div');
  scrimEl.id = 'scrim';
  scrimEl.onclick = closeSheets;
  document.body.appendChild(scrimEl);
  el.hidden = false;
}

const LAYER_GROUPS = {
  exclusion: ['exclusion-fill', 'exclusion-line', 'exclusion-source-label'],
  water_gaps: ['gap-fill', 'gap-line-open', 'gap-line-closed', 'gap-icons'],
  paddock: ['paddock-glow', 'paddock-line', 'paddock-source-label'],
  allotments: ['allotments-line', 'allotments-label'],
  ownership: ['ownership-fill', 'ownership-source-label'],
  springs: ['springs-dot', 'springs-source-label']
};

function wireUI() {
  $('#btn-layers').onclick = () => openSheet($('#layer-sheet'));
  $('#region-pill').onclick = () => openSheet($('#region-menu'));
  $('#btn-home').onclick = () => flyToRegion(currentRegion);
  $('#btn-locate').onclick = () => {
    if (!window.isSecureContext) {
      toast('The blue dot needs a secure web link (https). It will work on the field test link.');
      return;
    }
    try { geolocate.trigger(); }
    catch (e) { toast('Your location is not available on this device.'); }
  };
  $('#btn-search').onclick = () => toast('Search is not in this demo.');
  $('#btn-bell').onclick = () => toast('Alerts are not in this demo.');
  $('#fab-add').onclick = () => {
    if (placingGap) { cancelGapPlacement(); return; }
    enterGapPlacement();
  };

  document.querySelectorAll('#layer-sheet input[data-layer]').forEach(cb => {
    cb.onchange = () => {
      const vis = cb.checked ? 'visible' : 'none';
      for (const id of LAYER_GROUPS[cb.dataset.layer]) {
        map.setLayoutProperty(id, 'visibility', vis);
      }
    };
  });

  document.querySelectorAll('#region-menu .menu-item').forEach(btn => {
    btn.onclick = () => { closeSheets(); switchRegion(btn.dataset.region); };
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.tab !== 'live') {
        toast('This demo only shows the map.');
        return;
      }
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // one-time WiFi note
  let seen = false;
  try { seen = localStorage.getItem('wifiNoteSeen') === '1'; } catch (e) {}
  if (!seen) $('#wifi-note').hidden = false;
  $('#wifi-ok').onclick = () => {
    $('#wifi-note').hidden = true;
    try { localStorage.setItem('wifiNoteSeen', '1'); } catch (e) {}
  };
}

// Camera for a region: fit the paddock (or exclusion) bounds from the data
// itself, so the view lands on the demo area no matter what data drops in.
function regionBounds(region) {
  const d = regionData[region];
  if (!d) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  const eat = (coords) => {
    if (typeof coords[0] === 'number') {
      any = true;
      if (coords[0] < minX) minX = coords[0];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[1] > maxY) maxY = coords[1];
    } else coords.forEach(eat);
  };
  for (const layer of ['paddock', 'exclusion']) {
    for (const f of d[layer].features) eat(f.geometry.coordinates);
    if (any) break;
  }
  return any ? [[minX, minY], [maxX, maxY]] : null;
}

function flyToRegion(region) {
  const b = regionBounds(region);
  if (b) {
    map.fitBounds(b, { padding: 60, maxZoom: 14, essential: true });
  } else {
    const r = REGIONS[region];
    map.flyTo({ center: r.center, zoom: r.zoom, essential: true });
  }
}

async function switchRegion(region) {
  if (!REGIONS[region]) return;
  currentRegion = region;
  $('#region-name').textContent = REGIONS[region].label;
  document.querySelectorAll('#region-menu .menu-item').forEach(b =>
    b.classList.toggle('current', b.dataset.region === region));
  await loadRegion(region);
  refreshRegionSources();
  showHintCard();
  flyToRegion(region);
}

/* ---------------- Map clicks ---------------- */

function wireMapClicks() {
  map.on('click', (e) => {
    if (placingGap) { handlePlacementTap(e); return; }
    const gapHits = map.queryRenderedFeatures(e.point, { layers: ['gap-icons', 'gap-fill'] });
    if (gapHits.length) { showGapCard(gapHits[0].properties); return; }
    const exHits = map.queryRenderedFeatures(e.point, { layers: ['exclusion-fill'] });
    if (exHits.length) { showExclusionCard(exHits[0].properties); return; }
  });
  for (const id of ['gap-icons', 'gap-fill', 'exclusion-fill']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

/* ---------------- Boot ---------------- */

async function boot() {
  const r = REGIONS[currentRegion];
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP_STYLE,
    center: r.center,
    zoom: r.zoom,
    attributionControl: { compact: true }
  });

  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
  });
  map.addControl(geolocate, 'bottom-right'); // container hidden via CSS; custom button triggers it
  geolocate.on('trackuserlocationstart', () => $('#btn-locate').classList.add('on'));
  geolocate.on('trackuserlocationend', () => $('#btn-locate').classList.remove('on'));
  geolocate.on('error', () => toast('Could not find your spot. Check that this page is allowed to use your location.'));

  // Load both regions up front (small files; also warms the offline cache).
  const dataReady = Promise.all([loadRegion('red-canyon'), loadRegion('bear-lake')]);

  // Run setup when the style is ready. Uses both the 'load' event and a poll:
  // in a throttled/background tab the 'load' event can stall even though the
  // style has finished loading.
  let setupDone = false;
  const setup = async () => {
    if (setupDone) return;
    setupDone = true;
    const dOpen = makeDropletImage('#2979ff');
    const dClosed = makeDropletImage('#9e9e9e');
    map.addImage('drop-open', dOpen.img, { pixelRatio: dOpen.ratio });
    map.addImage('drop-closed', dClosed.img, { pixelRatio: dClosed.ratio });
    await dataReady;
    addSourcesAndLayers();
    wireMapClicks();
    wireGapDragging();
    // Land the first view on the data itself (real data may sit elsewhere
    // in the region than the hard-coded fallback center).
    const b = regionBounds(currentRegion);
    if (b) map.fitBounds(b, { padding: 60, maxZoom: 14, duration: 0 });
    if (usedStubData) {
      console.warn('Some layers are using stub-data/ placeholders (real data/ files not found yet).');
    }
    // Start with the attribution collapsed to its small "i" button.
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    if (attrib) attrib.classList.remove('maplibregl-compact-show');
  };
  map.once('load', setup);
  const readyPoll = setInterval(() => {
    if (setupDone) { clearInterval(readyPoll); return; }
    if (map.isStyleLoaded()) { clearInterval(readyPoll); setup(); }
  }, 300);

  // Keep the canvas matched to the screen (rotation, browser chrome changes).
  window.addEventListener('resize', () => map.resize());
  window.__map = map; // debug handle

  wireUI();
  showHintCard();
  document.querySelector('#region-menu .menu-item[data-region="red-canyon"]').classList.add('current');

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(err =>
      console.warn('Service worker registration failed:', err));
  }
}

boot();
