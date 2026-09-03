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

const LAYER_FILES = ['exclusion', 'water_gaps', 'paddock', 'allotments', 'ownership', 'springs', 'roads'];

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
    paint: { 'line-color': '#4caf87', 'line-width': BRUSH_RADIUS_PX * 2, 'line-opacity': 0.35 }
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
      'text-field': 'Potential Spring',
      'text-font': firstSymbolFont(),
      'text-size': 10,
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
  let reviewBtn = '';
  try {
    const n = buildReviewList(currentRegion).length;
    if (n) {
      reviewBtn = '<div class="gap-toggle"><button id="review-btn" class="sel-open">' +
        `Check ${n} suggested spot${n > 1 ? 's' : ''}</button></div>`;
    }
  } catch (e) {}
  $('#card-body').innerHTML =
    '<p class="card-main">Cows stay out of the shaded blue areas. Tap anything on the map to learn about it.</p>' +
    reviewBtn;
  const rb = $('#review-btn');
  if (rb) rb.onclick = startReview;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showExclusionCard(props) {
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
      '<p class="card-sub" style="color:#ffd28a"><b>Too small for collars</b>: this spot is under 10 m wide &mdash; ' +
      'no collar system has ever held a boundary that tight, so it is not part of the keep-out area. ' +
      'If it matters (a seep, a spring), widen it: the whole widened circle becomes the keep-out.</p>' +
      '<div class="gap-toggle"><button id="ex-widen-btn" class="sel-open">Widen to protect this spot</button></div>';
  } else if (props.enforce === 'irrigated') {
    narrowNote =
      '<p class="card-sub" style="color:#bfe0ff"><b>Watered ground</b>: this land is green because it gets ' +
      'irrigated (satellite irrigation map, 2+ of the last 10 years' +
      (props.irr_freq != null ? ' &mdash; watered in ' + Math.round(props.irr_freq * 10) + ' of 10' : '') +
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
      'boundary is at least 30 m across &mdash; wide enough for collars to hold.</p>' +
      '<div class="gap-toggle"><button id="ex-unwiden-btn">Undo widening</button></div>';
  }
  const isGuard = !!props.spring_guard;
  const est = props.established === '2026';
  const estBtn = (!narrowNote && ['ok', 'included', 'widened'].includes(props.enforce || 'ok') && !isGuard)
    ? (est
      ? '<p class="card-sub" style="color:#d9a03a"><b>Established for the 2026 season.</b></p>' +
        '<div class="gap-toggle"><button id="ex-unest-btn">Un-mark</button></div>'
      : '<div class="gap-toggle"><button id="ex-est-btn" class="sel-open">Mark established for 2026</button></div>')
    : '';
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    `<p class="card-kicker">${isGuard ? 'Spring guard' : 'Exclusion zone'}</p>` +
    `<p class="card-main">${esc(props.name || 'Creek bottom')}${acres ? ' &middot; ' + acres + ' acres' : ''}</p>` +
    (isGuard
      ? '<p class="card-sub">A ready-made circle around a mapped spring, sized so collars can hold it. ' +
        'If this spring is not real any more, remove it.</p>' +
        '<div class="gap-toggle"><button id="ex-guard-off">Remove this guard</button></div>'
      : '<p class="card-sub">This spot stays green late into the summer, year after year. Keeping cows out protects the water and the banks.</p>') +
    '<details class="data-details"><summary>Where this comes from</summary>' +
    '<p class="card-sub">Drawn from 40 years of satellite pictures: a spot counts when it was green in at least 5 of the last 10 summers and is not irrigated farm ground. ' +
    'Data: Univ. of Montana mesic maps, USGS water maps, IrrMapper irrigation maps.' +
    (attrs.length ? '<br>This piece: ' + attrs.join('; ') + '.' : '') +
    (props.source ? '<br>Source tag: ' + esc(props.source) : '') + '</p></details>' +
    narrowNote + estBtn +
    '<div class="gap-toggle"><button id="ex-edit-btn" class="sel-open">Adjust boundary</button></div>';
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
function setEnforce(fid, val, msg) {
  const f = regionData[currentRegion].exclusion.features.find(x => x.properties.id === fid);
  if (!f) return;
  f.properties.enforce = val;
  persistSeasonEdit(currentRegion);
  refreshGapSources();
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
  $('#card-body').innerHTML =
    '<button class="card-close" aria-label="Close">&times;</button>' +
    '<p class="card-kicker">Potential Spring</p>' +
    `<p class="card-main">${esc(props.name || 'Potential spring')}</p>` +
    '<p class="card-sub">USGS spring point, some are outdated. If real, exclude.</p>' +
    (props.source ? `<p class="card-sub" style="opacity:.7">Source tag: ${esc(props.source)}</p>` : '');
  $('.card-close').onclick = showHintCard;
}

function showSeasonCard() {
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
    ' This map IS your saved version — what you see is what is saved.</p>' +
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

// The review tour: fly the rancher to the spots most worth a look —
// small wet spots (widen or leave out?), the widest narrow pieces, and the
// biggest zones. "Looks good" is remembered per device.
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
    ...pick('irrigated', 4, 'Watered ground — green because it gets irrigated. Add it if it should be kept out.'),
    ...pick('too_small', 4, 'Small wet spot — widen it to protect it, or leave it out.'),
    ...pick('narrow', 2, 'Narrow piece — collars may not hold it. Widen or shrink it away.'),
    ...pick('ok', 2, 'One of your biggest zones — check the edges match your land.')
  ].slice(0, 12);
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
    toast('All checked. Nice work.');
    clearReviewHighlight();
    showHintCard();
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
  // Compact card on purpose: the point is to LOOK at the map, not read.
  // Tap the zone itself for the full technical card.
  const canWiden = (p.enforce === 'too_small' || p.enforce === 'narrow') ? '<button id="rv-widen">Widen</button>'
    : (p.enforce === 'irrigated') ? '<button id="rv-widen">Add it to the exclusion area</button>' : '';
  $('#card-body').innerHTML =
    '<button class="card-close" id="rv-stop" aria-label="Stop checking">&times;</button>' +
    `<p class="card-kicker">Check ${reviewIdx + 1} of ${reviewList.length}</p>` +
    `<p class="card-sub" style="margin-top:2px">${item.reason}</p>` +
    (canWiden ? '<div class="gap-toggle">' + canWiden + '</div>' : '') +
    '<div class="gap-toggle">' +
    '<button id="rv-ok" class="sel-open">Looks good</button>' +
    '<button id="rv-skip">Next</button>' +
    '</div>';
  const wbtn = $('#rv-widen');
  if (wbtn) wbtn.onclick = () => {
    if (p.enforce === 'irrigated') setEnforce(p.id, 'included', 'Added to the keep-out area.');
    else widenFeature(p.id);
    goReviewItem();
  };
  $('#rv-ok').onclick = () => {
    try {
      const done = reviewedIds(currentRegion);
      done.add(p.id);
      localStorage.setItem('reviewed:' + currentRegion, JSON.stringify([...done]));
    } catch (e) {}
    reviewIdx += 1;
    goReviewItem();
  };
  $('#rv-skip').onclick = () => { reviewIdx += 1; goReviewItem(); };
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
function widenFeature(fid) {
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
  if (placingGap || editMode) return;
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
    if (editMode) return;
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

  if (editMode === 'add') {
    if (!hit.length) {
      feats.push({
        type: 'Feature',
        properties: { id: 'edit-' + Date.now(), kind: 'exclusion', name: 'Added by you', acres: null, editable: true, source: 'rancher edit (brush)' },
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
  map.setPaintProperty('brush-stroke-line', 'line-color', mode === 'add' ? '#4caf87' : '#e08a4a');
}

function enterBoundaryEdit() {
  if (editMode) return;
  if (map.getZoom() < 13.5) map.easeTo({ zoom: 14, essential: true });
  const d = regionData[currentRegion];
  editEntrySnapshot = JSON.stringify(d.exclusion.features);
  editUndoStack = [];
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
    refreshGapSources();
    updateSeasonChip();
    exitBoundaryEdit();
    toast('Saved as your 2026 riparian area. Now check your water gaps.');
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
  $('#areas-sheet').hidden = true;
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
  water_gaps: ['gap-fill', 'gap-line-open', 'gap-line-closed', 'gap-icons'],
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
  { title: 'The blue areas are creek bottoms',
    body: 'Forty years of satellite pictures show these places stay green late into summer. Cows camp there and wear down the banks, so the collars keep them out.' },
  { title: 'You know this land better than a satellite',
    body: 'Tap any area to see why it is there. Dotted areas are questions, not rules — watered hay ground and tiny wet spots. Tap one to decide.' },
  { title: 'Fix it with your finger',
    body: 'Tap an area, then "Adjust boundary" to paint it bigger or smaller. Tap + to add a water gap where cows should drink. Tip: pan the map on WiFi first so it works out of service.' }
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
    $('#intro-body').textContent = st.body;
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

function openAreasSheet() {
  const list = $('#areas-list');
  const feats = regionData[currentRegion] ? regionData[currentRegion].exclusion.features : [];
  const mine = feats.filter(f =>
    f.properties.established === '2026' ||
    f.properties.enforce === 'included' ||
    f.properties.enforce === 'widened');
  if (!mine.length) {
    list.innerHTML = '<p class="areas-empty">Nothing saved yet. Tap an exclusion zone on the map and choose ' +
      '"Mark established for 2026" — it will show up here with a gold outline on the map.</p>';
  } else {
    list.innerHTML = mine.map(f => {
      const p = f.properties;
      const what = p.established === '2026' ? 'Established 2026'
        : p.enforce === 'widened' ? 'Widened spot' : 'Added by you';
      const ac = p.acres != null ? Math.round(p.acres).toLocaleString() + ' acres' : '';
      return `<button class="area-row" data-fid="${esc(p.id)}">` +
        `<span>${esc(p.name || 'Area')}<small>${ac}</small></span>` +
        `<span class="area-badge">${what}</span></button>`;
    }).join('');
    list.querySelectorAll('.area-row').forEach(btn => {
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
  }
  openSheet($('#areas-sheet'));
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
  flyToRegion(region);
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
    // data is loaded now — the hint card can show the review count,
    // and the season chip can reflect saved edits
    showHintCard();
    updateSeasonChip();
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
