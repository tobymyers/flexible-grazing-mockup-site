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

const LAYER_FILES = ['exclusion', 'water_gaps', 'paddock', 'allotments', 'ownership', 'springs', 'roads', 'water'];

const REGIONS = {
  'red-canyon': { label: 'Red Canyon', center: [-108.65, 42.63], zoom: 12.4,
                  detail: { center: [-108.628, 42.667], zoom: 15.4 } },
  'bear-lake':  { label: 'Bear Lake',  center: [-111.302, 41.999], zoom: 12.2,
                  detail: { center: [-111.392, 42.124], zoom: 15.1 } },
  'holland':    { label: 'Big Hole (Holland)', center: [-113.03, 45.29], zoom: 11.6,
                  detail: { center: [-112.985, 45.225], zoom: 14.8 } },
  'martinell':  { label: 'Centennial (Martinell)', center: [-111.82, 44.71], zoom: 12.0,
                  detail: { center: [-111.79, 44.72], zoom: 14.5 } }
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
  // Keep the untouched pipeline shape for "Start over", and restore the
  // rancher's saved seasonal boundary edits if any exist on this device.
  out.exclusionPristine = JSON.parse(JSON.stringify(out.exclusion));
  try {
    const edit = JSON.parse(localStorage.getItem('riparianEdit:' + region));
    if (edit && Array.isArray(edit.features)) {
      out.exclusion = { type: 'FeatureCollection', features: edit.features };
      out.editSavedAt = edit.savedAt;
    }
  } catch (e) { /* no saved edits — use the suggested boundary */ }
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
  const points = [], seals = [], toes = [];
  for (const g of gaps) {
    const open = state[g.id] !== false;
    const props = { id: g.id, name: g.name || 'Water gap', width_m: g.width_m, open };
    const src = raw.find(x => x.properties.id === g.id);
    if (src) { props.lane_ft = src.properties.lane_ft; props.lane_to = src.properties.lane_to; }
    points.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: g.center } });
    seals.push({ type: 'Feature', properties: props, geometry: g.sealGeom });
    // the far-end handle shows while placing or when the gap's card is open
    if (props.lane_to && (g.id === 'user-pending' || g.id === selectedGapId)) {
      toes.push({ type: 'Feature', properties: { id: g.id }, geometry: { type: 'Point', coordinates: props.lane_to } });
    }
  }
  return {
    points: { type: 'FeatureCollection', features: points },
    seals: { type: 'FeatureCollection', features: seals },
    toes: { type: 'FeatureCollection', features: toes }
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
  map.addSource('gap-toes', { type: 'geojson', data: gaps.toes });
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
        ['in', 'ranch land', ownerStr], 'rgba(124, 179, 66, 0.25)',
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
      'text-field': ['get', 'name'],
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
    paint: {
      // ghosts (too_small + irrigated) = faint blue with dotted edge;
      // narrow fades; everything else solid blue
      'fill-color': '#6fb3e8',
      'fill-opacity': ['case',
        ['==', ['get', 'enforce'], 'too_small'], 0.12,
        ['==', ['get', 'enforce'], 'irrigated'], 0.12,
        ['==', ['get', 'enforce'], 'narrow'], 0.14,
        0.3]
    }
  });
  map.addLayer({
    id: 'exclusion-line', type: 'line', source: 'exclusion',
    filter: ['all', ['!=', ['get', 'enforce'], 'narrow'], ['!=', ['get', 'enforce'], 'too_small'], ['!=', ['get', 'enforce'], 'irrigated']],
    paint: { 'line-color': '#4f9fd9', 'line-width': 2 }
  });
  map.addLayer({
    id: 'exclusion-line-narrow', type: 'line', source: 'exclusion',
    filter: ['==', ['get', 'enforce'], 'narrow'],
    paint: { 'line-color': '#7fb8d8', 'line-width': 1.5, 'line-dasharray': [1.5, 1.5] }
  });
  map.addLayer({
    id: 'exclusion-line-established', type: 'line', source: 'exclusion',
    filter: ['==', ['get', 'established'], '2026'],
    paint: { 'line-color': '#d9a03a', 'line-width': 3 }
  });
  map.addSource('review-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'review-highlight-line', type: 'line', source: 'review-highlight',
    paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.9, 'line-dasharray': [1.2, 1] }
  });
  map.addLayer({
    id: 'exclusion-line-toosmall', type: 'line', source: 'exclusion',
    filter: ['any', ['==', ['get', 'enforce'], 'too_small'], ['==', ['get', 'enforce'], 'irrigated']],
    paint: { 'line-color': '#7fb8d8', 'line-width': 2, 'line-dasharray': [0.6, 1.6] }
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

  // Brush stroke live preview (boundary edit mode)
  map.addSource('brush-stroke', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'brush-stroke-line', type: 'line', source: 'brush-stroke',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#5aa9e8', 'line-width': BRUSH_RADIUS_PX * 2, 'line-opacity': 0.35 }
  });

  // Data-source labels: every feature says where its data really came from
  // (the "source" property written by the pipeline). Toggleable in the sheet.
  const srcLabelPaint = {
    'text-color': '#d8ecff',
    'text-halo-color': 'rgba(0,0,0,0.85)',
    'text-halo-width': 1.3
  };
  map.addLayer({
    id: 'ownership-source-label', type: 'symbol', source: 'ownership',
    minzoom: 11,
    layout: {
      visibility: 'none',
      'text-field': ['concat', ['get', 'name'], ' · ', ['get', 'source']],
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
      'text-field': 'Potential Spring',
      'text-font': firstSymbolFont(),
      'text-size': 10,
      'text-offset': [0, 1.1],
      'text-anchor': 'top'
    },
    paint: { ...srcLabelPaint, 'text-color': '#bff0ff' }
  });

  map.addLayer({
    id: 'gap-name-label', type: 'symbol', source: 'gap-points',
    minzoom: 14.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': firstSymbolFont(),
      'text-size': 11,
      'text-offset': [0, 1.6],
      'text-anchor': 'top'
    },
    paint: {
      'text-color': '#bfe0ff',
      'text-halo-color': 'rgba(0,0,0,0.85)',
      'text-halo-width': 1.3
    }
  });

  // Far-end lane handle: a white square you drag to the real water.
  map.addLayer({
    id: 'gap-toe-handle', type: 'circle', source: 'gap-toes',
    paint: {
      'circle-radius': 9,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#2979ff',
      'circle-stroke-width': 3
    }
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
  if (!map.getSource('exclusion')) return;
  const d = regionData[currentRegion];
  const gaps = buildGapCollections(currentRegion);
  map.getSource('ownership').setData(d.ownership);
  map.getSource('allotments').setData(d.allotments);
  map.getSource('exclusion').setData(displayedExclusionFC(currentRegion));
  map.getSource('gap-seals').setData(gaps.seals);
  map.getSource('gap-points').setData(gaps.points);
  map.getSource('gap-toes').setData(gaps.toes);
  map.getSource('paddock').setData(d.paddock);
  map.getSource('springs').setData(d.springs);
}

function refreshGapSources() {
  // sources exist only after the style loads; data edits made before that
  // are picked up by addSourcesAndLayers anyway
  if (!map.getSource('gap-seals')) return;
  const gaps = buildGapCollections(currentRegion);
  map.getSource('gap-seals').setData(gaps.seals);
  map.getSource('gap-points').setData(gaps.points);
  map.getSource('gap-toes').setData(gaps.toes);
  map.getSource('exclusion').setData(displayedExclusionFC(currentRegion));
}

/* ---------------- UI helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

let toastTimer;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}

// Map-first (Toby-approved 3 Sep): nothing floats at rest. The map is the
// app; cards only exist while something is tapped. "showHintCard" now means
// "return to rest" — every existing caller keeps working.
function showHintCard() {
  if (selectedGapId) { selectedGapId = null; try { refreshGapSources(); } catch (e) {} }
  const c = $('#card');
  if (c) c.hidden = true;
  $('#card-body').innerHTML = '';
}

function revealCard() {
  const c = $('#card');
  if (c) c.hidden = false;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let lastZoneId = null;

function showExclusionCard(props) {
  revealCard();
  lastZoneId = props.id;
  const acres = (props.acres != null) ? Math.round(props.acres).toLocaleString() : null;
  const attrs = [];
  if (props.strm_type) attrs.push('dominant Strm_Type: ' + esc(props.strm_type));
  if (props.veg_pct != null) attrs.push('mesic persistence (Veg_Pct): ' + Math.round(props.veg_pct) + '%');
  let narrowNote = '';
  if (props.enforce === 'narrow') {
    narrowNote =
      '<p class="card-sub" style="color:#ffd28a"><b>Narrow zone</b>: this piece is under 25 m wide everywhere. ' +
      'Collar GPS error plus the warning band need about 25&ndash;30 m to hold a boundary reliably ' +
      '(Nofence 25 m rule; AZ Extension 100 ft; USDA burn study used a 30 m cue buffer).</p>' +
      '<div class="gap-toggle"><button id="ex-widen-btn" class="sel-open">Widen to a size collars can hold</button></div>';
  } else if (props.enforce === 'too_small') {
    narrowNote =
      '<p class="card-sub" style="color:#ffd28a"><b>Too small for collars</b>: this spot is under 10 m wide. ' +
      'No collar system has ever held a boundary that tight, so it is not part of the keep-out area. ' +
      'If it matters (a seep, a spring), widen it: the whole widened circle becomes the keep-out.</p>' +
      '<div class="gap-toggle"><button id="ex-widen-btn" class="sel-open">Widen to protect this spot</button></div>';
  } else if (props.enforce === 'irrigated') {
    narrowNote =
      '<p class="card-sub" style="color:#bfe0ff"><b>Watered ground</b>: this land is green because it gets ' +
      'irrigated (satellite irrigation map, 2+ of the last 10 years' +
      (props.irr_freq != null ? ', watered in ' + Math.round(props.irr_freq * 10) + ' of 10' : '') +
      '). It is not part of the keep-out area by default. If it should be, add it.</p>' +
      '<div class="gap-toggle"><button id="ex-promote-btn" class="sel-open">Add to exclusion</button></div>';
  } else if (props.enforce === 'included') {
    narrowNote =
      '<p class="card-sub" style="color:#9fe3b9"><b>Added by you</b>: watered ground you chose to include ' +
      'in the keep-out area.</p>' +
      '<div class="gap-toggle"><button id="ex-demote-btn">Remove again</button></div>';
  } else if (props.enforce === 'widened') {
    narrowNote =
      '<p class="card-sub" style="color:#9fe3b9"><b>Widened by you</b>: grown by 15 m on every side so the ' +
      'boundary is at least 30 m across, wide enough for collars to hold.</p>' +
      '<div class="gap-toggle"><button id="ex-unwiden-btn">Undo widening</button></div>';
  }
  const isGuard = !!props.spring_guard;
  const est = props.established === '2026';
  const lifecycle = (!narrowNote && ['ok', 'included', 'widened'].includes(props.enforce || 'ok') && !isGuard);
  const edited = !!props._edited;
  const badge = lifecycle
    ? (est ? '<span class="zone-badge gold">Established 2026</span>'
       : edited ? '<span class="zone-badge mid">Edited &middot; not yet established</span>'
       : '<span class="zone-badge prop">Proposed</span>')
    : '';
  const estBtn = lifecycle
    ? (est
      ? '<div class="gap-toggle"><button id="ex-unest-btn">Un-mark established</button></div>'
      : `<div class="gap-toggle"><button id="ex-est-btn" class="${edited ? 'sel-open' : ''}">Mark established for 2026</button></div>`)
    : '';
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    `<p class="card-kicker">${isGuard ? 'Spring guard' : 'Exclusion zone'}</p>` +
    `<p class="card-main">${esc(props.name || 'Creek bottom')}${acres ? ' &middot; ' + acres + ' acres' : ''}</p>` +
    badge +
    (isGuard
      ? '<p class="card-sub">A ready-made circle around a mapped spring, sized so collars can hold it. ' +
        'If this spring is not real any more, remove it.</p>' +
        '<div class="gap-toggle"><button id="ex-guard-off">Remove this guard</button></div>'
      : '') +
    '<details class="data-details"><summary>Where this comes from</summary>' +
    '<p class="card-sub">Drawn from 40 years of satellite pictures: a spot counts when it was green in at least 5 of the last 10 summers and is not irrigated farm ground. ' +
    'Data: Univ. of Montana mesic maps, USGS water maps, IrrMapper irrigation maps.' +
    (attrs.length ? '<br>This piece: ' + attrs.join('; ') + '.' : '') +
    (props.source ? '<br>Source tag: ' + esc(props.source) : '') + '</p></details>' +
    narrowNote +
    '<div class="gap-toggle"><button id="ex-edit-btn" class="sel-open">Adjust boundary</button></div>' +
    estBtn;
  $('.card-close').onclick = showHintCard;
  $('#ex-edit-btn').onclick = enterBoundaryEdit;
  const wbtn = $('#ex-widen-btn');
  if (wbtn) wbtn.onclick = () => widenFeature(props.id);
  const ubtn = $('#ex-unwiden-btn');
  if (ubtn) ubtn.onclick = () => unwidenFeature(props.id);
  const pbtn = $('#ex-promote-btn');
  if (pbtn) pbtn.onclick = () => setEnforce(props.id, 'included', 'Added to the keep-out area.');
  const dbtn = $('#ex-demote-btn');
  if (dbtn) dbtn.onclick = () => setEnforce(props.id, 'irrigated', 'Back to watered-ground status.');
  const gbtn = $('#ex-guard-off');
  if (gbtn) gbtn.onclick = () => removeSpringGuard(props.id);
  const ebtn = $('#ex-est-btn');
  if (ebtn) ebtn.onclick = () => setEstablished(props.id, '2026', 'Established for the 2026 season.');
  const ubtn2 = $('#ex-unest-btn');
  if (ubtn2) ubtn2.onclick = () => setEstablished(props.id, null, 'Un-marked.');
}

function setEstablished(fid, val, msg) {
  const f = regionData[currentRegion].exclusion.features.find(x => x.properties.id === fid);
  if (!f) return;
  if (val) f.properties.established = val; else delete f.properties.established;
  persistSeasonEdit(currentRegion);
  refreshGapSources();
  showExclusionCard(f.properties);
  toast(msg);
}

function removeSpringGuard(fid) {
  const feats = regionData[currentRegion].exclusion.features;
  const i = feats.findIndex(x => x.properties.id === fid);
  if (i < 0) return;
  feats.splice(i, 1);
  persistSeasonEdit(currentRegion);
  refreshGapSources();
  showHintCard();
  toast('Spring guard removed.');
}

// Flip a feature between ghost and included (no geometry change), persisted
// with the seasonal edit.
function setEnforce(fid, val, msg, quiet) {
  const f = regionData[currentRegion].exclusion.features.find(x => x.properties.id === fid);
  if (!f) return;
  f.properties.enforce = val;
  persistSeasonEdit(currentRegion);
  refreshGapSources();
  if (quiet) return;
  showExclusionCard(f.properties);
  toast(msg);
}

/* ---------------- Saved-season chip + guided review tour ---------------- */

function updateSeasonChip() {
  const chip = $('#season-chip');
  if (!chip) return;
  const d = regionData[currentRegion];
  if (d && d.editSavedAt) {
    chip.textContent = 'Your 2026 area · saved ' + new Date(d.editSavedAt).toLocaleDateString();
    chip.hidden = false;
    chip.onclick = showSeasonCard;
  } else {
    chip.hidden = true;
  }
}

function showSpringCard(props) {
  revealCard();
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Potential Spring</p>' +
    `<p class="card-main">${esc(props.name || 'Potential spring')}</p>` +
    '<p class="card-sub">USGS spring point, some are outdated. If real, exclude.</p>' +
    (props.source ? `<p class="card-sub" style="opacity:.7">Source tag: ${esc(props.source)}</p>` : '');
  $('.card-close').onclick = showHintCard;
}

function showSeasonCard() {
  revealCard();
  const d = regionData[currentRegion];
  const feats = d.exclusion.features;
  const enforced = feats.filter(f => f.properties.enforce !== 'too_small' && f.properties.enforce !== 'irrigated');
  const totalAc = Math.round(enforced.reduce((a, f) => a + (f.properties.acres || 0), 0));
  const widened = feats.filter(f => f.properties.enforce === 'widened').length;
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Your 2026 riparian area</p>' +
    `<p class="card-main">${totalAc.toLocaleString()} acres excluded</p>` +
    `<p class="card-sub">Saved ${new Date(d.editSavedAt).toLocaleDateString()} on this device.` +
    (widened ? ` ${widened} small spot${widened > 1 ? 's' : ''} widened to protect.` : '') +
    ' This map IS your saved version. What you see is what is saved.</p>' +
    '<div class="gap-toggle">' +
    '<button id="sc-edit" class="sel-open">Adjust boundary</button>' +
    '<button id="sc-reset">Back to suggested</button>' +
    '</div>';
  $('.card-close').onclick = showHintCard;
  $('#sc-edit').onclick = enterBoundaryEdit;
  $('#sc-reset').onclick = () => {
    const dd = regionData[currentRegion];
    dd.exclusion.features = JSON.parse(JSON.stringify(dd.exclusionPristine.features));
    dd.editSavedAt = null;
    try { localStorage.removeItem('riparianEdit:' + currentRegion); } catch (e) {}
    refreshGapSources();
    updateSeasonChip();
    showHintCard();
    toast('Back to the suggested boundary.');
  };
}

// The review tour: fly the rancher to every spot that needs a real decision.
// Watered ground and small wet spots (in or out?), and narrow pieces (widen
// or keep?). Big healthy zones need no decision, so they are not in the tour.
// Each decision is remembered per device.
function reviewedIds(region) {
  try { return new Set(JSON.parse(localStorage.getItem('reviewed:' + region)) || []); }
  catch (e) { return new Set(); }
}

function buildReviewList(region) {
  const d = regionData[region];
  if (!d) return [];
  const done = reviewedIds(region);
  const feats = d.exclusion.features.filter(f => !done.has(f.properties.id));
  const byAcres = (a, b) => (b.properties.acres || 0) - (a.properties.acres || 0);
  const pick = (flag, n, reason) =>
    feats.filter(f => f.properties.enforce === flag).sort(byAcres).slice(0, n)
      .map(f => ({ f, reason }));
  return [
    ...pick('irrigated', 4, 'Watered ground, green because it gets irrigated. It is left out unless you add it. Add it to the keep-out area, or leave it out.'),
    ...pick('too_small', 4, 'A small wet spot, under 10 m wide. Collars cannot hold it as is. Widen it to protect it, or leave it out.'),
    ...pick('narrow', 2, 'A narrow piece of the keep-out area, under 25 m wide. Collars may not hold a line this tight. Widen it, or keep it as is.')
  ].slice(0, 10);
}

let reviewList = [], reviewIdx = 0;

function startReview() {
  reviewList = buildReviewList(currentRegion);
  reviewIdx = 0;
  if (!reviewList.length) { toast('Nothing left to check. Nice.'); showHintCard(); return; }
  goReviewItem();
}

function clearReviewHighlight() {
  try { map.getSource('review-highlight').setData({ type: 'FeatureCollection', features: [] }); } catch (e) {}
}

function goReviewItem() {
  if (reviewIdx >= reviewList.length) {
    clearReviewHighlight();
    showHintCard();
    // the queue refills with the next-biggest spots, so only say "all
    // checked" when it is actually empty (skipped spots come back too)
    const more = buildReviewList(currentRegion).length;
    toast(more
      ? 'Done for now. The next spots to check are in My areas.'
      : 'All checked. Nice work.', 3600);
    return;
  }
  const item = reviewList[reviewIdx];
  const f = item.f;
  const p = f.properties;
  try {
    map.getSource('review-highlight').setData({ type: 'FeatureCollection', features: [f] });
    const bb = turf.bbox(f);
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 90, maxZoom: 17, duration: 900 });
  } catch (e) {}
  revealCard();
  // Compact card on purpose: the point is to LOOK at the map, not read.
  // Two decision buttons per spot; each label says exactly what happens.
  // Any decision records the spot as reviewed and moves to the next one.
  let actLabel, passLabel, passToast;
  if (p.enforce === 'too_small') {
    actLabel = 'Widen to protect'; passLabel = 'Leave it out';
    passToast = 'Left out. Nothing changes here.';
  } else if (p.enforce === 'irrigated') {
    actLabel = 'Add to exclusion'; passLabel = 'Leave it out';
    passToast = 'Left out. Nothing changes here.';
  } else { // narrow
    actLabel = 'Widen'; passLabel = 'Keep as is';
    passToast = 'Kept as is.';
  }
  $('#card-body').innerHTML =
    '<button class="card-close" id="rv-stop" aria-label="Stop checking">&times;</button>' +
    `<p class="card-kicker">Check ${reviewIdx + 1} of ${reviewList.length}</p>` +
    `<p class="card-sub" style="margin-top:2px">${item.reason}</p>` +
    '<div class="gap-toggle">' +
    `<button id="rv-act" class="sel-open">${actLabel}</button>` +
    `<button id="rv-pass">${passLabel}</button>` +
    '</div>' +
    '<button id="rv-later" class="rv-later">Decide later</button>';
  const markReviewed = () => {
    try {
      const done = reviewedIds(currentRegion);
      done.add(p.id);
      localStorage.setItem('reviewed:' + currentRegion, JSON.stringify([...done]));
    } catch (e) {}
  };
  const advance = () => { reviewIdx += 1; goReviewItem(); };
  // After a decision we STAY on the spot so the color change is visible
  // (dotted turns solid blue, the widen circle grows). Next moves on.
  const showResult = (txt, mapChanged) => {
    revealCard();
    $('#card-body').innerHTML =
      '<button class="card-close" id="rv-stop" aria-label="Stop checking">&times;</button>' +
      `<p class="card-kicker">Check ${reviewIdx + 1} of ${reviewList.length}</p>` +
      `<p class="card-main">&#10003; ${txt}</p>` +
      (mapChanged ? '<p class="card-sub">The change shows on the map.</p>' : '') +
      '<div class="gap-toggle"><button id="rv-next" class="sel-open">Next spot</button></div>';
    $('#rv-next').onclick = advance;
    $('#rv-stop').onclick = () => { clearReviewHighlight(); showHintCard(); };
  };
  $('#rv-act').onclick = () => {
    if (p.enforce === 'irrigated') {
      setEnforce(p.id, 'included', '', true);
      markReviewed();
      showResult('Added to the exclusion.', true);
      return;
    }
    widenFeature(p.id, true);
    // widenFeature can fail (bad geometry); only proceed if it worked
    if (p.enforce === 'widened') {
      markReviewed();
      showResult('Widened. Collars can hold it now.', true);
    } else goReviewItem();
  };
  $('#rv-pass').onclick = () => {
    markReviewed();
    showResult(passToast, false);
  };
  $('#rv-later').onclick = () => { reviewIdx += 1; goReviewItem(); };
  $('#rv-stop').onclick = () => { clearReviewHighlight(); showHintCard(); };
}

function persistSeasonEdit(region) {
  try {
    localStorage.setItem('riparianEdit:' + region, JSON.stringify({
      season: '2026', savedAt: Date.now(),
      features: regionData[region].exclusion.features
    }));
    regionData[region].editSavedAt = Date.now();
  } catch (e) { /* storage unavailable — change is session-only */ }
  updateSeasonChip();
}

// Widen a too-small/narrow piece by 15 m on every side, guaranteeing the
// result is at least 30 m across everywhere — collar-enforceable. The
// original shape is kept on the feature so widening can be undone.
function widenFeature(fid, quiet) {
  const f = regionData[currentRegion].exclusion.features.find(x => x.properties.id === fid);
  if (!f) return;
  let grown;
  try { grown = turf.buffer(f, 15, { units: 'meters', steps: 8 }); }
  catch (e) { toast('Could not widen this piece.'); return; }
  // never widen across a road (Toby, 3 Sep: Jacobs Canyon Rd case)
  try {
    const roads = (regionData[currentRegion].roads || { features: [] }).features;
    for (const rd of roads) {
      if (!turf.booleanIntersects(grown, rd)) continue;
      const cut = turf.difference(turf.featureCollection([grown, turf.buffer(rd, 6, { units: 'meters' })]));
      if (cut) grown = cut;
    }
  } catch (e) { /* roads unavailable — widen as-is */ }
  f.properties._origGeom = f.geometry;
  f.properties._origEnforce = f.properties.enforce;
  f.geometry = grown.geometry;
  f.properties.enforce = 'widened';
  f.properties.acres = Math.round(turf.area(f) / 4046.8564 * 10) / 10;
  persistSeasonEdit(currentRegion);
  refreshGapSources();
  if (quiet) return;
  showExclusionCard(f.properties);
  toast('Widened. Collars can hold this now.');
}

function unwidenFeature(fid) {
  const f = regionData[currentRegion].exclusion.features.find(x => x.properties.id === fid);
  if (!f || !f.properties._origGeom) return;
  f.geometry = f.properties._origGeom;
  f.properties.enforce = f.properties._origEnforce || 'too_small';
  delete f.properties._origGeom;
  delete f.properties._origEnforce;
  f.properties.acres = Math.round(turf.area(f) / 4046.8564 * 10) / 10;
  persistSeasonEdit(currentRegion);
  refreshGapSources();
  showExclusionCard(f.properties);
  toast('Back to the original size.');
}

function showGapCard(props) {
  revealCard();
  selectedGapId = String(props.id).startsWith('user-') ? props.id : null;
  refreshGapSources();
  const open = gapOpenState[currentRegion][props.id] !== false;
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Water gap</p>' +
    `<p class="card-main">${esc(props.name || 'Water gap')}</p>` +
    `<p class="card-sub" id="gap-status">${open
      ? (props.lane_ft
        ? 'Open. A ' + props.lane_ft + ' ft lane lets cows walk down to the water.'
        : 'Open. Cows can walk in here to drink. The gap is about 100 feet wide.')
      : 'Closed. Cows cannot reach the water here.'}</p>` +
    '<div class="gap-toggle">' +
    `<button id="gap-open-btn" class="${open ? 'sel-open' : ''}">Open</button>` +
    `<button id="gap-close-btn" class="${open ? '' : 'sel-closed'}">Closed</button>` +
    '</div>' +
    (String(props.id).startsWith('user-')
      ? '<div class="gap-toggle"><button id="gap-rename-btn">Rename</button></div>' +
        '<button id="gap-del-btn" class="gap-remove">Remove this gap</button>'
      : '');
  $('.card-close').onclick = showHintCard;
  $('#gap-open-btn').onclick = () => setGap(props, true);
  $('#gap-close-btn').onclick = () => setGap(props, false);
  const del = $('#gap-del-btn');
  if (del) del.onclick = () => removeUserGap(props);
  const rn = $('#gap-rename-btn');
  if (rn) rn.onclick = () => {
    $('#card-body').querySelector('.gap-toggle').outerHTML =
      '<div class="gap-toggle"><input id="gap-name-input" type="text" maxlength="40" ' +
      `value="${esc(props.name || '')}"><button id="gap-name-save" class="sel-open">Save</button></div>`;
    const inp = $('#gap-name-input');
    inp.focus(); inp.select();
    $('#gap-name-save').onclick = () => {
      const nm = inp.value.trim() || 'Water gap';
      const f = regionData[currentRegion].water_gaps.features.find(x => x.properties.id === props.id);
      if (f) f.properties.name = nm;
      props.name = nm;
      saveUserGaps(currentRegion);
      refreshGapSources();
      showGapCard(props);
      toast('Saved.');
    };
  };
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
let editSelectMode = false;
let selectedGapId = null;
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

// A water gap is a lane TO water (Toby-approved 3 Sep pm): 30 m wide, from
// the fence line to the nearest mapped water line, stopping at the channel.
// If water is farther than ~155 m (500 ft) or unmapped, fall back to the
// classic 30 m square notch.
// Square-cornered 30 m wide rectangle from the fence point to the water end.
function laneRect(center, to) {
  const A = turf.point(center);
  const B = turf.point(to);
  const brg = turf.bearing(A, B);
  const km = 0.015; // 15 m half-width
  const c1 = turf.destination(A, km, brg - 90).geometry.coordinates;
  const c2 = turf.destination(A, km, brg + 90).geometry.coordinates;
  const c3 = turf.destination(B, km, brg + 90).geometry.coordinates;
  const c4 = turf.destination(B, km, brg - 90).geometry.coordinates;
  return { type: 'Polygon', coordinates: [[c1, c2, c3, c4, c1]] };
}

// Best guess for where the lane should end: nearest mapped water line. The
// guess can be wrong (flowlines drift from the visible channel), so the far
// end is a draggable handle the rancher pulls to the real water.
function guessWaterTo(center) {
  const water = (regionData[currentRegion].water || { features: [] }).features;
  let best = null, bestKm = 0.155;
  const from = turf.point(center);
  for (const w of water) {
    try {
      const np = turf.nearestPointOnLine(w, from, { units: 'kilometers' });
      if (np.properties.dist < bestKm) { bestKm = np.properties.dist; best = np; }
    } catch (e) {}
  }
  if (!best || bestKm < 0.01) return null;
  return best.geometry.coordinates;
}

function buildGapPlugGeometry(center, to) {
  if (to === undefined) to = guessWaterTo(center);
  if (!to) {
    return { geom: squareAround(center[0], center[1], GAP_HALF_M), laneFt: null, to: null };
  }
  return {
    geom: laneRect(center, to),
    laneFt: Math.round(turf.distance(turf.point(center), turf.point(to), { units: 'kilometers' }) * 3280.84),
    to
  };
}

function pendingFeature() {
  return regionData[currentRegion].water_gaps.features
    .find(f => f.properties.id === 'user-pending');
}

function showPlacementCard() {
  revealCard();
  const has = !!pendingGapCenter;
  const f = has && pendingFeature();
  const lane = f && f.properties.lane_ft;
  $('#card-body').innerHTML =
    '<p class="card-kicker">New water gap</p>' +
    `<p class="card-main">${has
      ? (lane ? 'A ' + lane + ' ft lane down to the water.' : 'A 100 ft opening in the line.')
      : 'Tap the fence line where cows should walk in.'}</p>` +
    (has ? '<p class="card-sub">Drag the drop to move it. If the lane stops short, pull the white handle to the water.</p>' : '') +
    '<div class="gap-toggle">' +
    (has ? '<button id="gap-done-btn" class="sel-open">Place gap</button>' : '') +
    '<button id="gap-cancel-btn">Cancel</button>' +
    '</div>';
  if (has) $('#gap-done-btn').onclick = finishGapPlacement;
  $('#gap-cancel-btn').onclick = cancelGapPlacement;
}

function enterGapPlacement() {
  if (placingGap || editMode) return;
  placingGap = true;
  pendingGapCenter = null;
  map.touchZoomRotate.disableRotation();
  if (map.getZoom() < 14.5) map.easeTo({ zoom: 15, essential: true });
  showPlacementCard();
}

function upsertPendingGap(center) {
  pendingGapCenter = center;
  const feats = regionData[currentRegion].water_gaps.features;
  const prev = pendingFeature();
  const keepTo = prev && prev.properties.lane_custom ? prev.properties.lane_to : undefined;
  const plugInfo = buildGapPlugGeometry(center, keepTo);
  let f = pendingFeature();
  if (!f) {
    f = {
      type: 'Feature',
      properties: { id: 'user-pending', name: 'My water gap', width_m: 30, open: true, source: 'placed by you' },
      geometry: { type: 'Point', coordinates: center }
    };
    feats.push(f);
    gapOpenState[currentRegion]['user-pending'] = true;
  } else {
    f.geometry.coordinates = center;
  }
  f.properties.lane_ft = plugInfo.laneFt;
  f.properties.lane_to = plugInfo.to || null;
  let plug = feats.find(x => x.properties.id === 'user-pending-plug');
  if (!plug) {
    plug = { type: 'Feature', properties: { id: 'user-pending-plug', name: 'My water gap', width_m: 30, open: true, source: 'placed by you' }, geometry: plugInfo.geom };
    feats.push(plug);
  } else {
    plug.geometry = plugInfo.geom;
  }
  refreshGapSources();
}

function handlePlacementTap(e) {
  const snapped = snapToBoundary(e.point, 48);
  if (!snapped) {
    if (!pendingGapCenter) toast('Tap right on the blue line.');
    return;
  }
  upsertPendingGap([snapped.lng, snapped.lat]);
  showPlacementCard();
}

// One-time seed when entering placement: put the preview on the fence line
// nearest the screen center, then leave it alone. Move it by dragging the
// drop or tapping another spot on the line (Toby, 3 Sep: the map should pan
// freely; the gap must never move on its own).
// Gaps saved before lanes existed are point-only squares; upgrade them to
// the lane shape once water data is available.
function migrateLegacyGaps() {
  const d = regionData[currentRegion];
  if (!d || !d.water) return;
  const feats = d.water_gaps.features;
  let changed = false;
  for (const f of feats.filter(x => x.geometry.type === 'Point' && String(x.properties.id).startsWith('user-'))) {
    if (feats.some(x => x.properties.id === f.properties.id + '-plug')) continue;
    const info = buildGapPlugGeometry(f.geometry.coordinates);
    f.properties.lane_ft = info.laneFt;
    feats.push({ type: 'Feature', properties: { id: f.properties.id + '-plug', name: f.properties.name, width_m: 30, open: true, source: 'placed by you' }, geometry: info.geom });
    changed = true;
  }
  if (changed) { saveUserGaps(currentRegion); refreshGapSources(); }
}

function finishGapPlacement() {
  const f = pendingFeature();
  if (f) {
    userGapCounter += 1;
    const newId = 'user-' + Date.now();
    f.properties.id = newId;
    f.properties.name = 'My water gap ' + userGapCounter;
    const plug = regionData[currentRegion].water_gaps.features.find(x => x.properties.id === 'user-pending-plug');
    if (plug) { plug.properties.id = newId + '-plug'; plug.properties.name = f.properties.name; }
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
  for (const pid of ['user-pending', 'user-pending-plug']) {
    const i = feats.findIndex(x => x.properties.id === pid);
    if (i >= 0) feats.splice(i, 1);
  }
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
    if (editMode) return;
    const f = e.features && e.features[0];
    if (!f || !String(f.properties.id).startsWith('user-')) return;
    if (placingGap && f.properties.id !== 'user-pending') return;
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
      const keepTo = feat.properties.lane_custom ? feat.properties.lane_to : undefined;
      const plugInfo = buildGapPlugGeometry([snapped.lng, snapped.lat], keepTo);
      feat.properties.lane_ft = plugInfo.laneFt;
      feat.properties.lane_to = plugInfo.to || null;
      const plug = regionData[currentRegion].water_gaps.features.find(
        x => x.properties.id === draggingGapId + '-plug');
      if (plug) plug.geometry = plugInfo.geom;
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
  // far-end handle drag: aim and stretch the lane to the real water
  let draggingToeId = null;
  const toeStart = (e) => {
    if (editMode) return;
    const f = e.features && e.features[0];
    if (!f) return;
    e.preventDefault();
    draggingToeId = f.properties.id;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  };
  const toeMove = (e) => {
    if (!draggingToeId) return;
    const feat = regionData[currentRegion].water_gaps.features.find(
      x => x.properties.id === draggingToeId);
    if (!feat) return;
    const to = [e.lngLat.lng, e.lngLat.lat];
    feat.properties.lane_to = to;
    feat.properties.lane_custom = true;
    feat.properties.lane_ft = Math.round(turf.distance(
      turf.point(feat.geometry.coordinates), turf.point(to), { units: 'kilometers' }) * 3280.84);
    const plug = regionData[currentRegion].water_gaps.features.find(
      x => x.properties.id === draggingToeId + '-plug');
    if (plug) plug.geometry = laneRect(feat.geometry.coordinates, to);
    refreshGapSources();
  };
  const toeEnd = () => {
    if (!draggingToeId) return;
    const wasPending = draggingToeId === 'user-pending';
    draggingToeId = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    if (!wasPending) saveUserGaps(currentRegion);
    toast('Lane adjusted.');
  };
  map.on('mousedown', 'gap-toe-handle', toeStart);
  map.on('touchstart', 'gap-toe-handle', toeStart);
  map.on('mousemove', toeMove);
  map.on('touchmove', toeMove);
  map.on('mouseup', toeEnd);
  map.on('touchend', toeEnd);

  map.on('mousedown', 'gap-icons', start);
  map.on('touchstart', 'gap-icons', start);
  map.on('mousemove', move);
  map.on('touchmove', move);
  map.on('mouseup', end);
  map.on('touchend', end);
  map.on('mouseenter', 'gap-icons', () => { map.getCanvas().style.cursor = 'grab'; });
  map.on('mouseleave', 'gap-icons', () => { if (!draggingGapId) map.getCanvas().style.cursor = ''; });
}

/* ---------------- Boundary editing: highlighter & eraser ----------------
   Per UX research (2 Sep 2026): ranchers reshape the machine-suggested zone
   by PAINTING area in (green brush) or scribbling it out (orange eraser) —
   the medical-segmentation-correction pattern. No vertices, ever. One finger
   paints; pinch zooms (zoom = precision). Undo per stroke; Save stores the
   result as this season's riparian area on the device. */

const BRUSH_RADIUS_PX = 28; // 56 px diameter — gloved-thumb floor
let editMode = null;        // null | 'add' | 'erase'
let strokePts = [];
let strokeActive = false;
let editUndoStack = [];
let editEntrySnapshot = null;
let editTouchedIds = new Set();

function metersPerPixel() {
  const c = map.getCenter();
  const a = map.unproject([0, 300]);
  const b2 = map.unproject([1, 300]);
  return turf.distance([a.lng, a.lat], [b2.lng, b2.lat], { units: 'kilometers' }) * 1000 || 1;
}

function updateBrushLabel() {
  const el = $('#eb-brush-label');
  if (!el) return;
  const m = Math.round(BRUSH_RADIUS_PX * 2 * metersPerPixel());
  el.innerHTML = 'Brush &asymp; ' + m + ' m on the ground &middot; pinch to zoom for a finer brush';
}

function cleanedParts(feat, minSqm) {
  // drop slivers smaller than ~a GPS error circle
  const flat = turf.flatten(feat);
  const keep = flat.features.filter(p => turf.area(p) >= minSqm);
  if (!keep.length) return null;
  if (keep.length === 1) { keep[0].properties = feat.properties; return keep[0]; }
  return {
    type: 'Feature', properties: feat.properties,
    geometry: { type: 'MultiPolygon', coordinates: keep.map(p => p.geometry.coordinates) }
  };
}

function applyStroke() {
  const pts = strokePts;
  strokePts = [];
  map.getSource('brush-stroke').setData({ type: 'FeatureCollection', features: [] });
  if (!pts.length) return;
  const rM = BRUSH_RADIUS_PX * metersPerPixel();
  let swath;
  try {
    swath = pts.length < 2
      ? turf.circle([pts[0].lng, pts[0].lat], rM / 1000, { steps: 16, units: 'kilometers' })
      : turf.buffer(turf.lineString(pts.map(p => [p.lng, p.lat])), rM, { units: 'meters', steps: 8 });
  } catch (e) { return; }

  const d = regionData[currentRegion];
  editUndoStack.push(JSON.stringify(d.exclusion.features));
  if (editUndoStack.length > 20) editUndoStack.shift();

  const feats = d.exclusion.features;
  const hit = feats.filter(f => { try { return turf.booleanIntersects(f, swath); } catch (e) { return false; } });

  for (const f of hit) editTouchedIds.add(f.properties.id);
  if (editMode === 'add') {
    if (!hit.length) {
      const nid = 'edit-' + Date.now();
      editTouchedIds.add(nid);
      feats.push({
        type: 'Feature',
        properties: { id: nid, kind: 'exclusion', name: 'Added by you', acres: null, editable: true, source: 'rancher edit (brush)' },
        geometry: swath.geometry
      });
    } else {
      let merged = swath;
      for (const f of hit) { try { merged = turf.union(turf.featureCollection([merged, f])); } catch (e) {} }
      merged.properties = hit[0].properties;
      const keepRest = feats.filter(f => !hit.includes(f));
      keepRest.push(merged);
      d.exclusion.features = keepRest;
    }
  } else { // erase
    const next = [];
    for (const f of feats) {
      if (!hit.includes(f)) { next.push(f); continue; }
      let diff = null;
      try { diff = turf.difference(turf.featureCollection([f, swath])); } catch (e) { next.push(f); continue; }
      if (diff) {
        diff.properties = f.properties;
        const cleaned = cleanedParts(diff, 50);
        if (cleaned) next.push(cleaned);
      }
    }
    d.exclusion.features = next;
  }
  refreshGapSources();
}

function setEditMode(mode) {
  editMode = mode;
  $('#eb-add').classList.toggle('sel', mode === 'add');
  $('#eb-erase').classList.toggle('sel', mode === 'erase');
  map.setPaintProperty('brush-stroke-line', 'line-color', mode === 'add' ? '#5aa9e8' : '#e8e4da');
}

function enterBoundaryEdit() {
  if (editMode) return;
  if (map.getZoom() < 13.5) map.easeTo({ zoom: 14, essential: true });
  const d = regionData[currentRegion];
  editEntrySnapshot = JSON.stringify(d.exclusion.features);
  editUndoStack = [];
  editTouchedIds = new Set();
  map.dragPan.disable();
  $('#edit-bar').hidden = false;
  $('#card-body').parentElement.style.display = 'none';
  setEditMode('add');
  updateBrushLabel();
  map.on('zoom', updateBrushLabel);
  toast('Drag one finger to paint. Pinch to zoom.');
}

function exitBoundaryEdit() {
  editMode = null;
  strokeActive = false;
  strokePts = [];
  map.getSource('brush-stroke').setData({ type: 'FeatureCollection', features: [] });
  map.dragPan.enable();
  map.off('zoom', updateBrushLabel);
  $('#edit-bar').hidden = true;
  $('#card-body').parentElement.style.display = '';
  showHintCard();
}

function wireBoundaryEditing() {
  $('#eb-add').onclick = () => setEditMode('add');
  $('#eb-erase').onclick = () => setEditMode('erase');
  $('#eb-undo').onclick = () => {
    const prev = editUndoStack.pop();
    if (!prev) { toast('Nothing to undo.'); return; }
    regionData[currentRegion].exclusion.features = JSON.parse(prev);
    refreshGapSources();
  };
  $('#eb-reset').onclick = () => {
    const d = regionData[currentRegion];
    editUndoStack.push(JSON.stringify(d.exclusion.features));
    d.exclusion.features = JSON.parse(JSON.stringify(d.exclusionPristine.features));
    refreshGapSources();
    toast('Back to the suggested boundary.');
  };
  $('#eb-cancel').onclick = () => {
    regionData[currentRegion].exclusion.features = JSON.parse(editEntrySnapshot);
    refreshGapSources();
    exitBoundaryEdit();
  };
  $('#eb-save').onclick = () => {
    const d = regionData[currentRegion];
    // keep the saved shape light: ~1 m simplify, per UX research
    d.exclusion.features = d.exclusion.features.map(f => {
      try { return Object.assign(turf.simplify(f, { tolerance: 0.00001, highQuality: true }), { properties: f.properties }); }
      catch (e) { return f; }
    });
    try {
      localStorage.setItem('riparianEdit:' + currentRegion, JSON.stringify({
        season: '2026', savedAt: Date.now(), features: d.exclusion.features
      }));
      d.editSavedAt = Date.now();
    } catch (e) {}
    // lifecycle: touched zones become "edited"; an established zone that
    // changed loses its established mark (approval must match the shape)
    let changedEstablished = false;
    for (const f of d.exclusion.features) {
      if (!editTouchedIds.has(f.properties.id)) continue;
      f.properties._edited = true;
      if (f.properties.established === '2026') {
        delete f.properties.established;
        changedEstablished = true;
      }
    }
    try {
      localStorage.setItem('riparianEdit:' + currentRegion, JSON.stringify({
        season: '2026', savedAt: Date.now(), features: d.exclusion.features
      }));
    } catch (e) {}
    refreshGapSources();
    updateSeasonChip();
    exitBoundaryEdit();
    const zone = lastZoneId && d.exclusion.features.find(x => x.properties.id === lastZoneId);
    if (zone) showExclusionCard(zone.properties);
    toast(changedEstablished
      ? 'This zone changed. Mark it established again when it looks right.'
      : 'Changes saved.');
  };

  // One finger paints. TWO fingers move the map (so wide riparian areas can
  // be edited screen by screen without leaving edit mode). On desktop, hold
  // Shift and drag to move the map.
  let panMid = null;
  const midOf = (pts) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
  const clearStroke = () => {
    strokeActive = false; strokePts = [];
    map.getSource('brush-stroke').setData({ type: 'FeatureCollection', features: [] });
  };
  const begin = (e) => {
    if (!editMode) return;
    if (e.originalEvent && e.originalEvent.shiftKey) { clearStroke(); return; } // desktop pan
    if (e.points && e.points.length > 1) { clearStroke(); panMid = midOf(e.points); return; }
    e.preventDefault && e.preventDefault();
    strokeActive = true;
    strokePts = [e.lngLat];
  };
  const moveStroke = (e) => {
    if (!editMode) return;
    if (e.originalEvent && e.originalEvent.shiftKey && e.originalEvent.buttons) {
      clearStroke();
      map.panBy([-e.originalEvent.movementX, -e.originalEvent.movementY], { duration: 0 });
      return;
    }
    if (e.points && e.points.length > 1) {
      clearStroke();
      const mid = midOf(e.points);
      if (panMid) map.panBy([panMid.x - mid.x, panMid.y - mid.y], { duration: 0 });
      panMid = mid;
      return;
    }
    if (!strokeActive) return;
    strokePts.push(e.lngLat);
    if (strokePts.length > 1) {
      map.getSource('brush-stroke').setData(turf.lineString(strokePts.map(p => [p.lng, p.lat])));
    }
  };
  const endStroke = (e) => {
    panMid = null;
    if (!editMode || !strokeActive) return;
    strokeActive = false;
    applyStroke();
  };
  map.on('mousedown', begin);
  map.on('mousemove', moveStroke);
  map.on('mouseup', endStroke);
  map.on('touchstart', begin);
  map.on('touchmove', moveStroke);
  map.on('touchend', endStroke);
}

function removeUserGap(props) {
  const feats = regionData[currentRegion].water_gaps.features;
  for (const pid of [props.id, props.id + '-plug']) {
    const i = feats.findIndex(x => x.properties.id === pid);
    if (i >= 0) feats.splice(i, 1);
  }
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
  $('#areas-sheet').hidden = true;
  $('#info-sheet').hidden = true;
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
  exclusion: ['exclusion-fill', 'exclusion-line', 'exclusion-line-narrow', 'exclusion-line-toosmall', 'exclusion-line-established'],
  water_gaps: ['gap-fill', 'gap-line-open', 'gap-line-closed', 'gap-icons', 'gap-name-label'],
  allotments: ['allotments-line', 'allotments-label'],
  ownership: ['ownership-fill', 'ownership-source-label'],
  springs: ['springs-dot', 'springs-source-label']
};

function wireUI() {
  $('#btn-layers').onclick = () => openSheet($('#layer-sheet'));
  $('#btn-info').onclick = () => openSheet($('#info-sheet'));
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
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.tab === 'areas') openAreasSheet();
      else closeSheets();
    };
  });

  // first-visit walkthrough (3 short steps)
  wireIntro();
}

const INTRO_STEPS = [
  { title: 'Keeping cows out of creek bottoms is hard',
    body: 'Riparian areas are important, contentious, and difficult to manage. Keeping cows off them takes miles of fence or a lot of riding. Virtual fence collars can do that work.' },
  { title: 'Blue areas are proposed riparian exclusions',
    body: 'They are proposals, not final lines. We draw them from three public data sets: 40 years of satellite greenness from the University of Montana, federal river and wetland maps from USGS and Fish and Wildlife, and an irrigation map so watered hay ground stays out. You know this land better than any satellite.' },
  { title: 'Approve exclusions and add water gaps',
    body: '&bull; Tap a blue area to fix its shape, then mark it established for the season.<br>&bull; Tap the Water gap button to add a spot where cows walk in to drink.<br>&bull; Tap Check spots to see places where the data disagrees with itself. We may have those wrong.' }
];
let introIdx = 0;

function wireIntro() {
  let seen = false;
  try { seen = localStorage.getItem('introSeen') === '1'; } catch (e) {}
  if (seen) return;
  const show = () => {
    const st = INTRO_STEPS[introIdx];
    $('#intro-step-label').textContent = (introIdx + 1) + ' of ' + INTRO_STEPS.length;
    $('#intro-title').textContent = st.title;
    $('#intro-body').innerHTML = st.body;
    $('#intro-next').textContent = introIdx === INTRO_STEPS.length - 1 ? 'Got it' : 'Next';
  };
  const done = () => {
    $('#intro').hidden = true;
    try { localStorage.setItem('introSeen', '1'); } catch (e) {}
  };
  $('#intro').hidden = false;
  show();
  $('#intro-next').onclick = () => {
    introIdx += 1;
    if (introIdx >= INTRO_STEPS.length) done(); else show();
  };
  $('#intro-skip').onclick = done;
}

function openAreasSheet(section) {
  const list = $('#areas-list');
  const d = regionData[currentRegion];
  const feats = d ? d.exclusion.features : [];
  const mine = feats.filter(f =>
    f.properties.established === '2026' ||
    f.properties.enforce === 'included' ||
    f.properties.enforce === 'widened');
  const myGaps = (d ? d.water_gaps.features : []).filter(f =>
    String(f.properties.id).startsWith('user-') && f.properties.id !== 'user-pending');

  const zoneRows = mine.length ? mine.map(f => {
    const p = f.properties;
    const what = p.established === '2026' ? 'Established 2026'
      : p.enforce === 'widened' ? 'Widened spot' : 'Added by you';
    const ac = p.acres != null ? Math.round(p.acres).toLocaleString() + (Math.round(p.acres) === 1 ? ' acre' : ' acres') : '';
    return `<button class="area-row" data-fid="${esc(p.id)}">` +
      `<span>${esc(p.name || 'Area')}<small>${ac}</small></span>` +
      `<span class="area-badge">${what}</span></button>`;
  }).join('')
    : '<p class="areas-empty">None yet. Tap a blue area, then "Mark established for 2026."</p>';

  const gapRows = myGaps.length ? myGaps.map(f => {
    const p = f.properties;
    const closed = gapOpenState[currentRegion] && gapOpenState[currentRegion][p.id] === false;
    const sub = closed ? 'Closed. Cows cannot drink here.' : 'Open. Cows can drink here.';
    return `<button class="area-row" data-gid="${esc(p.id)}">` +
      `<span>${esc(p.name || 'Water gap')}<small>${sub}</small></span>` +
      `<span class="area-badge gap">Water gap${closed ? ' &middot; closed' : ''}</span></button>`;
  }).join('')
    : '<p class="areas-empty">None yet. Tap the Water gap button, then tap the fence line.</p>';

  const savedNote = d && d.editSavedAt
    ? `<p class="areas-empty" style="margin:0 0 4px">Your edits are saved on this phone (last save ${new Date(d.editSavedAt).toLocaleDateString()}).</p>`
    : '';
  let toCheck = 0;
  try { toCheck = buildReviewList(currentRegion).length; } catch (e) {}
  const checkRow = toCheck
    ? `<button class="area-row" id="areas-check-row"><span>&#9888; Check suggested spots<small>Places the data is not sure about</small></span><span class="area-badge">${toCheck}</span></button>`
    : '';
  list.innerHTML = savedNote + checkRow +
    `<h3 class="area-section-h" id="sec-approved">Approved for 2026 (${mine.length})</h3>` + zoneRows +
    `<h3 class="area-section-h" id="sec-gaps">Water gaps (${myGaps.length})</h3>` + gapRows;

  list.querySelectorAll('.area-row[data-fid]').forEach(btn => {
    btn.onclick = () => {
      const f = feats.find(x => x.properties.id === btn.dataset.fid);
      closeSheets();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === 'map'));
      if (!f) return;
      try {
        const bb = turf.bbox(f);
        map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 90, maxZoom: 16.5, duration: 800 });
      } catch (e) {}
      showExclusionCard(f.properties);
    };
  });
  list.querySelectorAll('.area-row[data-gid]').forEach(btn => {
    btn.onclick = () => {
      const f = myGaps.find(x => x.properties.id === btn.dataset.gid);
      closeSheets();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === 'map'));
      if (!f) return;
      try {
        map.easeTo({ center: f.geometry.coordinates, zoom: 16, duration: 800 });
      } catch (e) {}
      showGapCard(f.properties);
    };
  });

  const cr = $('#areas-check-row');
  if (cr) cr.onclick = () => {
    closeSheets();
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === 'map'));
    startReview();
  };

  openSheet($('#areas-sheet'));
  if (section) {
    const h = $(section === 'gaps' ? '#sec-gaps' : '#sec-approved');
    if (h) h.scrollIntoView({ block: 'start' });
  }
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
  updateSeasonChip();
  migrateLegacyGaps();
  const det = REGIONS[region].detail;
  map.flyTo({ center: det.center, zoom: det.zoom, essential: true });
}

/* ---------------- Map clicks ---------------- */

function wireMapClicks() {
  map.on('click', (e) => {
    if (editMode) return;
    if (placingGap) { handlePlacementTap(e); return; }
    const gapHits = map.queryRenderedFeatures(e.point, { layers: ['gap-icons', 'gap-fill'] });
    if (gapHits.length) { showGapCard(gapHits[0].properties); return; }
    const spHits = map.queryRenderedFeatures(e.point, { layers: ['springs-dot'] });
    if (spHits.length) { showSpringCard(spHits[0].properties); return; }
    const exHits = map.queryRenderedFeatures(e.point, { layers: ['exclusion-fill'] });
    if (exHits.length) {
      if (editSelectMode) { editSelectMode = false; enterBoundaryEdit(); return; }
      showExclusionCard(exHits[0].properties);
      return;
    }
    editSelectMode = false;
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
  // Scale bar in feet/miles (Adrienne's ask, 2 Sep prototype test).
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'imperial' }), 'bottom-left');
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
    wireBoundaryEditing();
    // Open zoomed in on a real riparian corridor so the first thing anyone
    // sees is a blue exclusion hugging a real creek (Toby, 3 Sep pm).
    const det = REGIONS[currentRegion].detail;
    map.jumpTo({ center: det.center, zoom: det.zoom });
    if (usedStubData) {
      console.warn('Some layers are using stub-data/ placeholders (real data/ files not found yet).');
    }
    // Start with the attribution collapsed to its small "i" button.
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    if (attrib) attrib.classList.remove('maplibregl-compact-show');
    // data is loaded now — the hint card can show the review count,
    // and the season chip can reflect saved edits
    showHintCard();
    updateSeasonChip();
    migrateLegacyGaps();
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

/* ---------------- Invite gate ----------------
   Keeps the prototype off random screens: the app only boots with a valid
   invite key (?key=... in the link, remembered on the device). Keys are
   checked as SHA-256 hashes; revoke one by removing its hash + redeploy.
   This is a screen door, not a vault: fine for a prototype, not security. */
const INVITE_HASHES = [
  'c7145d4de27110e2dfc4eabdbb9e7511214118cf965fa41c47d2cdb9e7c793af',
  'dfb9000d54ed31e2c44bbdc0addf17782452598a580f54f68ed9f19a10826960',
  '8337b0ad30a9f76ea525b12411994aec7d7c0fa4fa20dc225aef94350a75b60f',
  'a17b4ab5ed2d730df00e7212e6610ad8dddcf7c4baf3d7d558a780f2c7b2fbd3',
  '234eb0eaab329296eef33ccd9ba6e934ffd7f232d35bfb3b78ce6d7f22e672b0',
  'c36576d78294895a44eedd51dfa493b4e984ec2ec6da156d03d6a728b77ad673'
];

async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function inviteOk() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
  const u = new URL(location.href);
  let key = u.searchParams.get('key');
  if (!key) { try { key = localStorage.getItem('inviteKey'); } catch (e) {} }
  if (!key) return false;
  key = key.trim();
  const h = await sha256Hex(key);
  if (!INVITE_HASHES.includes(h)) return false;
  try { localStorage.setItem('inviteKey', key); } catch (e) {}
  if (u.searchParams.has('key')) {
    u.searchParams.delete('key');
    history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : ''));
  }
  return true;
}

function showLockScreen() {
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;background:#14150f;color:#f2f3ee;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,sans-serif">' +
    '<div style="max-width:340px;text-align:center">' +
    '<p style="font-size:40px;margin:0">&#128274;</p>' +
    '<h2 style="margin:10px 0 8px">Private prototype</h2>' +
    '<p style="color:#b9bdb0;font-size:15px;line-height:1.5">This map is invite-only. Open the invite link you were sent, or type the code from it.</p>' +
    '<input id="lock-key" type="text" placeholder="invite code" autocapitalize="none" autocorrect="off" ' +
    'style="width:100%;min-height:48px;border-radius:12px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#f2f3ee;font-size:16px;padding:0 14px;margin:14px 0 10px;text-align:center">' +
    '<button id="lock-go" style="width:100%;min-height:52px;border:none;border-radius:12px;background:#2979ff;color:#fff;font-size:16px;font-weight:700">Open the map</button>' +
    '</div></div>';
  document.getElementById('lock-go').onclick = async () => {
    const k = document.getElementById('lock-key').value.trim();
    if (k && INVITE_HASHES.includes(await sha256Hex(k))) {
      try { localStorage.setItem('inviteKey', k); } catch (e) {}
      location.reload();
    } else {
      document.getElementById('lock-key').style.borderColor = '#e53935';
    }
  };
}

inviteOk().then(ok => { if (ok) boot(); else showLockScreen(); });

