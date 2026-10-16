(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Config - VEFÚTGÁFA (Azure Static Web App). Allt er statískt: data/photos.csv
  // og data/geojson/ eru búin til af build_site.py. Myndaslóðir koma úr
  // site-config.js (photoBase/thumbBase) - getur bent á möppu í síðunni sjálfri
  // eða á Azure Blob Storage ef myndirnar eru of stórar fyrir síðuna.
  // ---------------------------------------------------------------------
  const SITE = Object.assign({ photoBase: 'photos/', thumbBase: 'thumbs/' }, window.SITE_CONFIG || {});
  const CSV_URL = 'data/photos.csv';
  const PHOTO_BASE = SITE.photoBase;
  const THUMB_BASE = SITE.thumbBase;

  const CACHE_KEY = 'landsnet_vefsja_photo_cache_v1';
  const LABEL_ZOOM_THRESHOLD = 15;

  // Línuleiðir (shapefile/GeoJSON) — sömu ISN93 hnit og EFLA notar almennt.
  const ISN93 =
    '+proj=lcc +lat_1=64.25 +lat_2=65.75 +lat_0=65 +lon_0=-19 +x_0=500000 +y_0=500000 +ellps=GRS80 +units=m +no_defs +type=crs';
  const SHAPE_CACHE_KEY = 'landsnet_vefsja_shape_layers_v1';
  const DEFAULT_SHAPE_COLOR = '#2b7de9';

  // .geojson/.json skrár sem liggja í sömu möppu og photos.csv (á netdrifinu
  // sjálfu) - sóttar og hlaðnar sjálfkrafa við ræsingu, ólíkt handvirkt
  // innfluttum skrám (sjá "auto" merkinguna á shape-hlutum hér að neðan).
  const GEOJSON_LIST_URL = 'data/geojson-list.json';
  const GEOJSON_BASE = 'data/geojson/';
  const SHAPES_LIST_URL = 'data/shapes-list.json';
  const SHAPES_BASE = 'data/shapes/';
  const AUTO_SHAPE_PREFS_KEY = 'landsnet_vefsja_auto_shape_prefs_v1';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let photoCache = loadCache();
  const markersByFilename = new Map();
  let visiblePhotos = [];
  const importedShapes = []; // { id, name, color, visible, geojson, layer }
  let shapeIdCounter = 0;
  const disabledCategories = new Set(); // flokkar sem notandinn hefur slökkt á
  let categoryFilterOpen = false;

  // ---------------------------------------------------------------------
  // localStorage cache helpers
  // ---------------------------------------------------------------------
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch (err) {
      console.warn('Could not read photo cache, starting empty.', err);
      return new Map();
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(photoCache)));
    } catch (err) {
      console.warn('Could not persist photo cache (storage full/blocked?).', err);
    }
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function photoUrl(photo) {
    return PHOTO_BASE + photo.id.split('/').map(encodeURIComponent).join('/');
  }

  // Smámynd (build_site.py býr hana til) - notuð í sprettglugga á kortinu.
  function thumbUrl(photo) {
    return THUMB_BASE + photo.id.split('/').map(encodeURIComponent).join('/');
  }

  function setStatus(text) {
    document.getElementById('status-bar').textContent = text;
  }

  // ---------------------------------------------------------------------
  // Map setup
  // ---------------------------------------------------------------------
  const map = L.map('map', { zoomControl: true }).setView([64.9631, -19.0208], 6); // Ísland

  const esriLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Loftmynd &copy; Esri, Maxar, Earthstar Geographics' }
  ).addTo(map);

  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });

  L.control.layers(
    { 'Loftmynd (Esri)': esriLayer, 'Kort (OSM)': osmLayer },
    {},
    { position: 'topright' }
  ).addTo(map);

  // Eigið "label" pane með lægra z-index en marker-pane, svo punkturinn
  // sjálfur birtist alltaf ofan á nafnatextanum þegar margar myndir skarast.
  map.createPane('labelPane');
  map.getPane('labelPane').style.zIndex = 550;
  map.getPane('labelPane').style.pointerEvents = 'none';

  const shapeLayerGroup = L.layerGroup();
  map.addLayer(shapeLayerGroup);

  const clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
  });
  map.addLayer(clusterGroup);

  function updateLabelVisibility() {
    document.body.classList.toggle('show-labels', map.getZoom() >= LABEL_ZOOM_THRESHOLD);
  }
  map.on('zoomend', updateLabelVisibility);

  // ---------------------------------------------------------------------
  // Marker construction
  // ---------------------------------------------------------------------
  function photoIcon(heading, pano) {
    const arrow =
      typeof heading === 'number'
        ? `<div class="photo-marker-arrow" style="transform: rotate(${heading}deg)"></div>`
        : '';
    return L.divIcon({
      className: `photo-marker-wrap${pano ? ' pano' : ''}`,
      html: `<div class="photo-marker">${arrow}<div class="photo-marker-dot"></div></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -11],
    });
  }

  function buildPopupHtml(photo) {
    const url = photoUrl(photo);
    const thumb = thumbUrl(photo);
    const dateHtml = photo.date ? new Date(photo.date).toLocaleString('is-IS') : 'Óþekkt dagsetning';
    return `
      <div class="popup-content">
        <img class="popup-thumb" src="${thumb}" alt="${escapeHtml(photo.filename)}"
             onclick="window.__netdiskMap.openLightbox('${photo.id.replace(/'/g, "\\'")}')" />
        <div class="popup-filename">${escapeHtml(photo.filename)}</div>
        ${photo.category ? `<div class="popup-date">Flokkur: ${escapeHtml(photo.category)}</div>` : ''}
        <div class="popup-date">${dateHtml}</div>
        <div class="popup-coords">${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}</div>
        <a class="btn popup-link" href="${url}" target="_blank" rel="noopener">🔗 Opna mynd</a>
      </div>`;
  }

  function createOrUpdateMarker(photo) {
    if (photo.lat == null || photo.lon == null) return null;

    let marker = markersByFilename.get(photo.id);
    if (!marker) {
      marker = L.marker([photo.lat, photo.lon], { icon: photoIcon(photo.heading, photo.pano) });
      marker.bindTooltip(photo.filename, {
        permanent: true,
        direction: 'top',
        offset: [0, -14],
        className: 'photo-label',
        pane: 'labelPane',
      });
      marker.bindPopup(() => buildPopupHtml(photo), { maxWidth: 260 });
      markersByFilename.set(photo.id, marker);
    } else {
      marker.setLatLng([photo.lat, photo.lon]);
      marker.setIcon(photoIcon(photo.heading, photo.pano));
      marker.setTooltipContent(photo.filename);
    }
    marker.__photo = photo;
    return marker;
  }

  function rebuildMarkersFromCache() {
    markersByFilename.forEach((marker, id) => {
      if (!photoCache.has(id) || photoCache.get(id).invalid) {
        markersByFilename.delete(id);
      }
    });

    photoCache.forEach((photo) => {
      if (photo.invalid || photo.lat == null || photo.lon == null) return;
      createOrUpdateMarker(photo);
    });

    applyFilters(); // (re)populates clusterGroup from markersByFilename
    renderLegend();
    renderCategoryFilter();
  }

  function renderCategoryFilter() {
    const el = document.getElementById('category-filter');
    const toggleBtn = document.getElementById('category-toggle-btn');
    const categories = new Set();
    photoCache.forEach((p) => { if (p.category) categories.add(p.category); });

    if (categories.size === 0) {
      el.innerHTML = '';
      el.classList.remove('open');
      toggleBtn.hidden = true;
      return;
    }

    toggleBtn.hidden = false;
    toggleBtn.textContent = `🏷️ Flokkar (${categories.size - disabledCategories.size}/${categories.size})`;
    el.classList.toggle('open', categoryFilterOpen);

    const allOff = Array.from(categories).every((cat) => disabledCategories.has(cat));
    const sorted = Array.from(categories).sort((a, b) => a.localeCompare(b, 'is'));
    el.innerHTML = `
      <button type="button" class="category-toggle-all" data-action="toggle-all">${allOff ? 'Sýna allar' : 'Fela allar'}</button>
      ${sorted.map((cat) => `
        <label class="category-chip ${disabledCategories.has(cat) ? '' : 'active'}">
          <input type="checkbox" data-category="${escapeHtml(cat)}" ${disabledCategories.has(cat) ? '' : 'checked'} />
          ${escapeHtml(cat)}
        </label>
      `).join('')}
    `;
    el.querySelectorAll('input[data-category]').forEach((input) => {
      input.addEventListener('change', () => {
        const cat = input.dataset.category;
        if (input.checked) disabledCategories.delete(cat);
        else disabledCategories.add(cat);
        input.closest('.category-chip').classList.toggle('active', input.checked);
        toggleBtn.textContent = `🏷️ Flokkar (${categories.size - disabledCategories.size}/${categories.size})`;
        applyFilters();
        renderCategoryFilter();
      });
    });
    el.querySelector('[data-action="toggle-all"]').addEventListener('click', () => {
      if (allOff) disabledCategories.clear();
      else categories.forEach((cat) => disabledCategories.add(cat));
      applyFilters();
      renderCategoryFilter();
    });
  }

  document.getElementById('category-toggle-btn').addEventListener('click', () => {
    categoryFilterOpen = !categoryFilterOpen;
    document.getElementById('category-filter').classList.toggle('open', categoryFilterOpen);
  });

  // ---------------------------------------------------------------------
  // Filters (search + date range)
  // ---------------------------------------------------------------------
  function applyFilters() {
    const q = document.getElementById('search-input').value.trim().toLowerCase();
    const fromVal = document.getElementById('date-from').value;
    const toVal = document.getElementById('date-to').value;
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    clusterGroup.clearLayers();
    visiblePhotos = [];
    const visible = [];

    markersByFilename.forEach((marker) => {
      const photo = marker.__photo;
      const dateStr = photo.date ? new Date(photo.date).toLocaleString('is-IS') : '';
      const matchesSearch =
        !q || photo.filename.toLowerCase().includes(q) || dateStr.toLowerCase().includes(q);

      let matchesDate = true;
      if (photo.date && (from || to)) {
        const d = new Date(photo.date);
        if (from && d < from) matchesDate = false;
        if (to && d > to) matchesDate = false;
      } else if (!photo.date && (from || to)) {
        matchesDate = false;
      }

      const matchesCategory = !photo.category || !disabledCategories.has(photo.category);

      if (matchesSearch && matchesDate && matchesCategory) {
        visible.push(marker);
        visiblePhotos.push(photo);
      }
    });

    if (visible.length) clusterGroup.addLayers(visible);
    setStatus(`${visiblePhotos.length} af ${markersByFilename.size} myndum sýndar.`);
  }

  document.getElementById('search-input').addEventListener('input', applyFilters);
  document.getElementById('date-from').addEventListener('change', applyFilters);
  document.getElementById('date-to').addEventListener('change', applyFilters);
  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    document.getElementById('search-input').value = '';
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    applyFilters();
  });

  // ---------------------------------------------------------------------
  // Legend
  // ---------------------------------------------------------------------
  function renderLegend() {
    const el = document.getElementById('legend');
    const sections = [];

    if (markersByFilename.size > 0) {
      let panoCount = 0;
      markersByFilename.forEach((m) => { if (m.__photo?.pano) panoCount++; });
      sections.push(`
        <div class="legend-section">
          <h3>Myndir</h3>
          <div class="legend-row"><span class="legend-swatch" style="background:var(--photo)"></span><span class="legend-label">Ljósmynd (${markersByFilename.size - panoCount})</span></div>
          ${panoCount ? `<div class="legend-row"><span class="legend-swatch" style="background:var(--red)"></span><span class="legend-label">360° mynd (${panoCount})</span></div>` : ''}
        </div>`);
    }

    if (importedShapes.length > 0) {
      sections.push(`
        <div class="legend-section">
          <h3>Línuleiðir</h3>
          ${importedShapes.map((s) => `
            <div class="legend-row">
              <input type="checkbox" class="legend-checkbox" data-shape-id="${s.id}" data-action="toggle" ${s.visible ? 'checked' : ''} title="Sýna/fela" />
              <input type="color" class="legend-color-input" data-shape-id="${s.id}" data-action="color" value="${s.color}" title="Breyta lit" />
              <span class="legend-label">${escapeHtml(s.name)}</span>
              ${s.sourceFilename
                ? `<span class="legend-auto-badge" title="Sótt sjálfkrafa úr ${escapeHtml(s.sourceFilename)} á drifinu">🔄</span>`
                : `<button class="legend-remove" type="button" data-shape-id="${s.id}" data-action="remove" title="Fjarlægja">✕</button>`}
            </div>
            ${s.propertyKeys.length ? `
            <div class="legend-row legend-row-sub">
              <span class="legend-label-hint">Merking á punktum:</span>
              <select class="legend-label-select" data-shape-id="${s.id}" data-action="label">
                <option value=""${s.labelField ? '' : ' selected'}>Engin</option>
                ${s.propertyKeys.map((k) => `<option value="${escapeHtml(k)}"${k === s.labelField ? ' selected' : ''}>${escapeHtml(k)}</option>`).join('')}
              </select>
            </div>` : ''}
          `).join('')}
        </div>`);
    }

    if (!sections.length) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = `<h3>Skýring</h3>${sections.join('')}`;

    el.querySelectorAll('[data-action="toggle"]').forEach((input) => {
      input.addEventListener('change', () => toggleShapeVisibility(Number(input.dataset.shapeId), input.checked));
    });
    el.querySelectorAll('[data-action="color"]').forEach((input) => {
      input.addEventListener('input', () => changeShapeColor(Number(input.dataset.shapeId), input.value));
    });
    el.querySelectorAll('[data-action="remove"]').forEach((btn) => {
      btn.addEventListener('click', () => removeShape(Number(btn.dataset.shapeId)));
    });
    el.querySelectorAll('[data-action="label"]').forEach((select) => {
      select.addEventListener('change', () => changeShapeLabelField(Number(select.dataset.shapeId), select.value));
    });
  }

  // ---------------------------------------------------------------------
  // Línuleiðir (shapefile/GeoJSON) — litavali, sýna/fela og fjarlægja
  // hvert lag fyrir sig, allt vistað í localStorage.
  // ---------------------------------------------------------------------
  function reprojectIsn93IfNeeded(geojson) {
    function walk(coords, fn) {
      if (typeof coords[0] === 'number') return fn(coords);
      return coords.map((c) => walk(c, fn));
    }
    const feats = geojson.features || [];
    let needsReproject = false;
    for (const f of feats) {
      const g = f.geometry;
      if (!g || !g.coordinates) continue;
      walk(g.coordinates, (pt) => {
        if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) needsReproject = true;
        return pt;
      });
      break;
    }
    if (!needsReproject) return geojson;
    feats.forEach((f) => {
      const g = f.geometry;
      if (!g || !g.coordinates) return;
      g.coordinates = walk(g.coordinates, (pt) => proj4(ISN93, 'EPSG:4326', [pt[0], pt[1]]));
    });
    return geojson;
  }

  // Reynir að giska á hvaða eiginda-dálkur (t.d. úr shapefile-attribute-töflu)
  // er mastranúmerið, svo hægt sé að merkja punkta sjálfkrafa án þess að
  // notandinn þurfi að velja dálkinn handvirkt í hvert sinn.
  const LABEL_FIELD_GUESSES = [
    'mastranumer', 'mastranúmer', 'mastnr', 'mastur_nr', 'mastnumer',
    'nr', 'no', 'numer', 'nafn', 'name', 'id', 'label',
  ];

  function collectPropertyKeys(geojson) {
    const keys = new Set();
    (geojson.features || []).forEach((f) => {
      if (f.properties) Object.keys(f.properties).forEach((k) => keys.add(k));
    });
    return Array.from(keys);
  }

  function guessLabelField(propertyKeys) {
    const lowerMap = new Map(propertyKeys.map((k) => [k.toLowerCase(), k]));
    for (const guess of LABEL_FIELD_GUESSES) {
      if (lowerMap.has(guess)) return lowerMap.get(guess);
    }
    return '';
  }

  // Merkimiðar á punktum eru EKKI bundnir strax við innflutning — ef línan er
  // með hundruð/þúsundir punkta myndi það búa til jafnmargar DOM-einingar
  // samtímis og frjósa/hrynja vafrann. Í staðinn er merkitextinn geymdur á
  // laginu sjálfu (__labelText) og raunverulegi tooltip-inn ekki búinn til
  // fyrr en notandinn er kominn í nægan aðdrátt — sjá updateShapeLabels().
  function buildShapeLayer(geojson, color, labelField) {
    return L.geoJSON(geojson, {
      style: { color, weight: 3, opacity: 0.9 },
      pointToLayer: (feature, latlng) => {
        const marker = L.circleMarker(latlng, { radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 });
        const labelValue = labelField ? feature.properties?.[labelField] : null;
        if (labelValue !== null && labelValue !== undefined && labelValue !== '') {
          marker.__labelText = String(labelValue);
        }
        return marker;
      },
      onEachFeature: (feature, fl) => {
        const props = feature.properties || {};
        const keys = Object.keys(props).filter((k) => props[k] !== null && props[k] !== '');
        if (!keys.length) return;
        fl.bindPopup(keys.map((k) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(props[k])}`).join('<br>'));
      },
    });
  }

  // Bindur/fjarlægir merkimiða-tooltip á punktum eftir því hvort punkturinn
  // er í núverandi útsýni OG hvort heildarfjöldi sýnilegra merktra punkta er
  // ekki of hár — EKKI fast aðdráttarþrep (mastrapunktar eru oft margir km í
  // sundur og eiga að merkjast strax, ekki bara við mjög nákvæman aðdrátt).
  // Þannig birtast merkin um leið og skjárinn er ekki of þéttsetinn, og
  // stórt safn af punktum (t.d. heil háspennulína með þúsundum mastra)
  // truflar samt ekki afköst þegar allir eru í mynd í einu (t.d. súmmað
  // langt út) — þá er merkjunum einfaldlega sleppt þar til færri eru í mynd.
  const MAX_VISIBLE_SHAPE_LABELS = 150;

  // L.geoJSON pakkar MultiPoint-eiginleikum (og GeometryCollection) inn í falið
  // undirlag (nested FeatureGroup) — eitt fyrir hvern eiginleika, með raun-
  // verulegu punktunum þar inni. Venjulegt shape.layer.eachLayer() sér bara
  // þessi ytri lög, ekki punktana sjálfa þar sem __labelText er geymt, svo
  // hér er kafað ofan í hvert undirlag þar til komið er á raunverulega punkta.
  function eachPointLayer(layerGroup, callback) {
    layerGroup.eachLayer((layer) => {
      if (typeof layer.eachLayer === 'function') {
        eachPointLayer(layer, callback);
      } else {
        callback(layer);
      }
    });
  }

  function updateShapeLabels() {
    const bounds = map.getBounds();
    // Þakið er reiknað PER LAG, ekki samanlagt yfir öll lög — annars myndi
    // fjölmennt lag (t.d. heil háspennulína) slökkva á merkjum lítillar,
    // ótengdrar línu sem er líka hlaðin inn á kortið.
    importedShapes.forEach((shape) => {
      if (!shape.visible) return;
      const inView = [];
      eachPointLayer(shape.layer, (layer) => {
        if (layer.__labelText == null) return;
        if (typeof layer.getLatLng === 'function' && bounds.contains(layer.getLatLng())) {
          inView.push(layer);
        } else if (layer.getTooltip()) {
          layer.unbindTooltip();
        }
      });

      const show = inView.length > 0 && inView.length <= MAX_VISIBLE_SHAPE_LABELS;
      inView.forEach((layer) => {
        if (show) {
          if (!layer.getTooltip()) {
            layer.bindTooltip(layer.__labelText, {
              permanent: true,
              direction: 'top',
              offset: [0, -6],
              className: 'shape-label',
              pane: 'labelPane',
            });
          }
        } else if (layer.getTooltip()) {
          layer.unbindTooltip();
        }
      });
    });
  }
  map.on('zoomend moveend', updateShapeLabels);

  // Punktarnir sjálfir (t.d. mastur) eiga ekki að birtast fyrr en notandinn
  // er kominn í nægan aðdrátt — annars fyllist skjárinn af punktum um leið og
  // stór skrá (t.d. öll möstur landsins) er flutt inn. Línur/margnötungar úr
  // sömu skrá eru samt alltaf sýnilegir óháð aðdrætti (þeir hafa ekki
  // getLatLng, svo síunin fyrir neðan hefur engin áhrif á þá).
  const POINT_ZOOM_THRESHOLD = 11;

  function updateShapePointVisibility() {
    const show = map.getZoom() >= POINT_ZOOM_THRESHOLD;
    importedShapes.forEach((shape) => {
      if (!shape.visible) return;
      eachPointLayer(shape.layer, (layer) => {
        if (typeof layer.setStyle !== 'function' || typeof layer.getLatLng !== 'function') return;
        layer.setStyle({ opacity: show ? 1 : 0, fillOpacity: show ? 0.9 : 0 });
      });
    });
  }
  map.on('zoomend', updateShapePointVisibility);

  function addShapeEntry(name, geojson, color, visible, labelField, sourceFilename) {
    const reprojected = reprojectIsn93IfNeeded(geojson);
    const propertyKeys = collectPropertyKeys(reprojected);
    const resolvedLabelField = labelField !== undefined ? labelField : guessLabelField(propertyKeys);
    const layer = buildShapeLayer(reprojected, color, resolvedLabelField);
    const entry = {
      id: shapeIdCounter++, name, color, visible, geojson: reprojected, layer,
      propertyKeys, labelField: resolvedLabelField, sourceFilename: sourceFilename || null,
    };
    importedShapes.push(entry);
    if (visible) shapeLayerGroup.addLayer(layer);
    updateShapeLabels();
    updateShapePointVisibility();
    return entry;
  }

  // Handvirkt innfluttar skrár (úr "Línuleið" hnappinum) eru vistaðar heilar
  // í localStorage. Skrár sem eru sjálfkrafa sóttar úr sömu möppu og
  // photos.csv (sourceFilename sett) eru það EKKI — þær eru alltaf sóttar
  // ferskar af netdrifinu við næstu ræsingu, sjá loadAutoGeojsonFiles().
  function persistShapes() {
    const toSave = importedShapes
      .filter((s) => !s.sourceFilename)
      .map((s) => ({ name: s.name, geojson: s.geojson, color: s.color, visible: s.visible, labelField: s.labelField }));
    try {
      localStorage.setItem(SHAPE_CACHE_KEY, JSON.stringify(toSave));
    } catch (err) {
      console.warn('Gat ekki vistað línuleið (localStorage full?).', err);
    }
  }

  // Fyrir sjálfkrafa-sóttar skrár er bara litur/merking/sýnileiki geymt
  // (lyklað á skráarnafn), ekki gögnin sjálf - þau koma alltaf af drifinu.
  function persistAutoShapePrefs() {
    const prefs = {};
    importedShapes
      .filter((s) => s.sourceFilename)
      .forEach((s) => { prefs[s.sourceFilename] = { color: s.color, labelField: s.labelField, visible: s.visible }; });
    try {
      localStorage.setItem(AUTO_SHAPE_PREFS_KEY, JSON.stringify(prefs));
    } catch (err) {
      console.warn('Gat ekki vistað stillingar fyrir sjálfvirkar línuleiðir.', err);
    }
  }

  function loadAutoShapePrefs() {
    try {
      return JSON.parse(localStorage.getItem(AUTO_SHAPE_PREFS_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function loadCachedShapes() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SHAPE_CACHE_KEY)) || [];
    } catch (err) {
      saved = [];
    }
    saved.forEach((s) => addShapeEntry(s.name, s.geojson, s.color || DEFAULT_SHAPE_COLOR, s.visible !== false, s.labelField));
    renderLegend();
  }

  function stripGeojsonExt(filename) {
    return filename.replace(/\.(geo)?json$/i, '');
  }

  // Sækir .geojson/.json skrár sem liggja í sömu möppu og photos.csv á
  // netdrifinu og hleður þeim sjálfkrafa inn á kortið - notandinn þarf ekki
  // lengur að velja þær handvirkt í hvert sinn. Keyrt einu sinni við ræsingu;
  // hver skrá er sótt fyrir sig svo ein biluð skrá stöðvi ekki hinar.
  async function loadAutoGeojsonFiles(skipFiles = new Set()) {
    let files;
    try {
      const res = await fetch(`${GEOJSON_LIST_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      files = ((await res.json()).files || []).filter((f) => !skipFiles.has(f.toLowerCase()));
    } catch (err) {
      console.warn('Gat ekki sótt lista yfir geojson-skrár.', err);
      return;
    }
    if (!files.length) return;

    const prefs = loadAutoShapePrefs();
    let loaded = 0;
    await Promise.all(files.map(async (filename) => {
      try {
        const res = await fetch(`${GEOJSON_BASE}${encodeURIComponent(filename)}?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const geojson = await res.json();
        const pref = prefs[filename] || {};
        const entry = addShapeEntry(
          stripGeojsonExt(filename), geojson,
          pref.color || DEFAULT_SHAPE_COLOR, pref.visible !== false, pref.labelField, filename
        );
        loaded++;
      } catch (err) {
        console.warn(`Gat ekki lesið ${filename}:`, err);
      }
    }));
    if (loaded) renderLegend();
  }

  // Sameiginleg mappa á netdrifinu ("!HLinur - SHP skrar", undirmappa í
  // myndamöppunni): öll lög sem þar liggja (zip, aðskildar .shp/.dbf/.prj
  // skrár eða GeoJSON) hlaðast sjálfkrafa inn hjá öllum við ræsingu. Til að
  // bæta við nýju lagi fyrir alla er nóg að setja skrána í þá möppu.
  async function fetchShapesBuffer(name) {
    const res = await fetch(`${SHAPES_BASE}${encodeURIComponent(name)}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${name})`);
    return res;
  }

  async function readSharedShape(item) {
    if (item.kind === 'geojson') {
      return (await fetchShapesBuffer(item.file)).json();
    }
    if (item.kind === 'zip') {
      return shp(await (await fetchShapesBuffer(item.file)).arrayBuffer());
    }
    // aðskildar skrár: .shp (+ .dbf eigindi, + .prj hnitakerfi)
    const shpBuf = await (await fetchShapesBuffer(item.file)).arrayBuffer();
    const dbfBuf = item.dbf ? await (await fetchShapesBuffer(item.dbf)).arrayBuffer() : null;
    const prj = item.prj ? await (await fetchShapesBuffer(item.prj)).text() : undefined;
    const cpg = item.cpg ? (await (await fetchShapesBuffer(item.cpg)).text()).trim() : undefined;

    const build = (prjText) => {
      const geoms = shp.parseShp(shpBuf, prjText);
      if (!dbfBuf) return { type: 'FeatureCollection', features: geoms.map((g) => ({ type: 'Feature', properties: {}, geometry: g })) };
      return shp.combine([geoms, shp.parseDbf(dbfBuf, cpg)]);
    };
    try {
      return build(prj);
    } catch (err) {
      // Óþekkt .prj: lesa án hnitakerfis - ISN93 er þá umbreytt sjálfkrafa ef þarf.
      console.warn(`Gat ekki túlkað .prj fyrir ${item.file}, les án þess.`, err);
      return build(undefined);
    }
  }

  async function loadSharedShapes() {
    const loadedFiles = new Set(); // skráarnöfn sem komust inn - rótarhleðslan sleppir þeim
    let items;
    try {
      const res = await fetch(`${SHAPES_LIST_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return loadedFiles;
      items = (await res.json()).items || [];
    } catch (err) {
      console.warn('Gat ekki sótt lista yfir sameiginleg lög.', err);
      return loadedFiles;
    }
    if (!items.length) return loadedFiles;

    const prefs = loadAutoShapePrefs();
    let loaded = 0;
    for (const item of items) {
      try {
        const result = await readSharedShape(item);
        const collections = Array.isArray(result) ? result : [result];
        collections.forEach((geojson, i) => {
          const key = `${SHAPES_BASE}${item.file}${collections.length > 1 ? '#' + i : ''}`;
          const pref = prefs[key] || {};
          addShapeEntry(
            collections.length > 1 ? `${item.name} (${i + 1})` : item.name, geojson,
            pref.color || DEFAULT_SHAPE_COLOR, pref.visible !== false, pref.labelField, key
          );
          loaded++;
        });
        loadedFiles.add(item.file.toLowerCase());
      } catch (err) {
        console.warn(`Gat ekki lesið sameiginlegt lag ${item.file}:`, err);
      }
    }
    if (loaded) renderLegend();
    return loadedFiles;
  }

  function toggleShapeVisibility(id, visible) {
    const shape = importedShapes.find((s) => s.id === id);
    if (!shape) return;
    shape.visible = visible;
    if (visible) shapeLayerGroup.addLayer(shape.layer);
    else shapeLayerGroup.removeLayer(shape.layer);
    updateShapeLabels();
    updateShapePointVisibility();
    persistShapes();
    persistAutoShapePrefs();
  }

  function changeShapeColor(id, color) {
    const shape = importedShapes.find((s) => s.id === id);
    if (!shape) return;
    shape.color = color;
    shape.layer.setStyle({ color, fillColor: color });
    persistShapes();
    persistAutoShapePrefs();
  }

  function changeShapeLabelField(id, labelField) {
    const shape = importedShapes.find((s) => s.id === id);
    if (!shape) return;
    shape.labelField = labelField;
    const wasVisible = shape.visible;
    shapeLayerGroup.removeLayer(shape.layer);
    shape.layer = buildShapeLayer(shape.geojson, shape.color, labelField);
    if (wasVisible) shapeLayerGroup.addLayer(shape.layer);
    updateShapeLabels();
    updateShapePointVisibility();
    persistShapes();
    persistAutoShapePrefs();
  }

  function removeShape(id) {
    const idx = importedShapes.findIndex((s) => s.id === id);
    if (idx === -1) return;
    shapeLayerGroup.removeLayer(importedShapes[idx].layer);
    importedShapes.splice(idx, 1);
    persistShapes();
    renderLegend();
  }

  document.getElementById('shape-btn').addEventListener('click', () => {
    document.getElementById('shape-input').click();
  });

  document.getElementById('shape-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const isZip = /\.zip$/i.test(file.name);
    const name = file.name.replace(/\.(zip|geo)?json$/i, '').replace(/\.zip$/i, '');
    const parsed = isZip
      ? file.arrayBuffer().then((buf) => shp(buf))
      : file.text().then((t) => JSON.parse(t));

    parsed
      .then((result) => {
        const collections = Array.isArray(result) ? result : [result];
        collections.forEach((geojson) => addShapeEntry(name, geojson, DEFAULT_SHAPE_COLOR, true));
        persistShapes();
        renderLegend();
        setStatus(`Lína flutt inn: ${name} (${collections.length} safn)`);
      })
      .catch((err) => {
        console.error(err);
        setStatus(`Villa við lestur lags: ${err.message} — er þetta zippuð shapefile eða GeoJSON?`);
      });
  });

  // ---------------------------------------------------------------------
  // Forreiknaður gagnagrunnur (photos.csv, búinn til af build_index.py) —
  // miklu hraðara en að lesa EXIF úr hverri mynd í vafranum fyrir stór söfn.
  // ---------------------------------------------------------------------
  function parseCsvSemicolon(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ';') {
        row.push(cell); cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function loadCsvIndex() {
    try {
      const res = await fetch(`${CSV_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return { ok: false, added: 0 };
      const rows = parseCsvSemicolon(await res.text());
      if (!rows.length) return { ok: false, added: 0 };

      photoCache.clear(); // CSV-skráin er eina heimildin í vefútgáfunni
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const idx = {
        filename: header.indexOf('filename'),
        lat: header.indexOf('lat'),
        lon: header.indexOf('lon'),
        date: header.indexOf('date'),
        heading: header.indexOf('heading'),
        category: header.indexOf('category'),
        pano: header.indexOf('pano'),
      };
      if (idx.filename === -1 || idx.lat === -1 || idx.lon === -1) {
        console.warn('photos.csv: vantar filename/lat/lon dálka.');
        return { ok: false, added: 0 };
      }

      let added = 0;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const filename = (row[idx.filename] || '').trim();
        if (!filename) continue;
        const lat = parseFloat(row[idx.lat]);
        const lon = parseFloat(row[idx.lon]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const heading = idx.heading !== -1 ? parseFloat(row[idx.heading]) : NaN;

        photoCache.set(filename, {
          id: filename,
          filename: filename.split('/').pop(),
          sig: 'csv',
          source: 'csv',
          lat,
          lon,
          date: idx.date !== -1 && row[idx.date] ? row[idx.date].trim() : null,
          heading: isFinite(heading) ? heading : null,
          category: idx.category !== -1 ? (row[idx.category] || '').trim() : '',
          pano: idx.pano !== -1 && (row[idx.pano] || '').trim() === '1',
        });
        added++;
      }
      saveCache();
      return { ok: true, added };
    } catch (err) {
      console.warn('Gat ekki lesið photos.csv.', err);
      return { ok: false, added: 0 };
    }
  }

  // ---------------------------------------------------------------------
  // Lightbox — leyfir að fletta áfram á milli mynda (næsta/fyrri) innan
  // þeirra mynda sem eru sýnilegar eftir núverandi síu, ekki bara loka og
  // þurfa að opna næstu mynd handvirkt af kortinu.
  // ---------------------------------------------------------------------
  let lightboxIndex = -1;
  let panoViewer = null;
  // DJI 360-myndir eru "equirectangular" - mjög breiðar (um 2:1 hlutfall).
  // Venjulegur <img> sýnir þær flatar og skakkar, svo þær eru greindar út
  // frá hlutfalli myndarinnar og opnaðar í Pannellum (draga til að horfa í
  // kring) í staðinn. Þetta er bara ágiskun út frá stærðarhlutfalli, ekki
  // raunverulegum merkjum frá myndavélinni - mjög breiðar venjulegar myndir
  // gætu ranglega opnast sem panorama.
  const PANO_MIN_RATIO = 1.9;
  const PANO_MAX_RATIO = 2.1;

  function updateLightboxNavButtons() {
    const disabled = visiblePhotos.length <= 1;
    document.getElementById('lightbox-prev').disabled = disabled;
    document.getElementById('lightbox-next').disabled = disabled;
  }

  function destroyPanoViewer() {
    stopPanoOverlay();
    if (panoViewer) {
      panoViewer.destroy();
      panoViewer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Eigin 360° viewer (three.js). Pannellum notar hvorki mipmaps né
  // devicePixelRatio, sem gerir 12000 px myndir mjúkar/óskýrar á skjám með
  // stækkun. Hér er áferðin með mipmaps + anisotropic filtering og teiknað í
  // fullri skjáupplausn. Sömu getYaw/getPitch/getHfov og yfirlagið notar.
  // ---------------------------------------------------------------------
  function createPanoViewer(container, image) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const dom = renderer.domElement;
    dom.className = 'pano-gl';
    container.appendChild(dom);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1100);
    camera.rotation.order = 'YXZ';
    const state = { yaw: 0, pitch: 0, hfov: 100, dirty: true, raf: 0, destroyed: false };

    const geometry = new THREE.SphereGeometry(500, 96, 64);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0x1a1c20 });
    scene.add(new THREE.Mesh(geometry, material));

    // Áferð: stærri en hámark skjákorts er minnkuð í hámarkið.
    const maxTex = renderer.capabilities.maxTextureSize;
    let source = image;
    if (image.naturalWidth > maxTex || image.naturalHeight > maxTex) {
      const k = Math.min(maxTex / image.naturalWidth, maxTex / image.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.floor(image.naturalWidth * k);
      c.height = Math.floor(image.naturalHeight * k);
      c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
      source = c;
    }
    const texture = new THREE.Texture(source);
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    material.map = texture;
    material.color.set(0xffffff);

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wrapYaw = (y) => ((((y + 180) % 360) + 360) % 360) - 180;

    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      state.dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    const render = () => {
      state.raf = requestAnimationFrame(render);
      if (!state.dirty || state.destroyed) return;
      state.dirty = false;
      const hf = (state.hfov * Math.PI) / 180;
      camera.fov = (2 * Math.atan(Math.tan(hf / 2) / camera.aspect) * 180) / Math.PI;
      camera.rotation.y = Math.PI / 2 - (state.yaw * Math.PI) / 180;
      camera.rotation.x = (state.pitch * Math.PI) / 180;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    state.raf = requestAnimationFrame(render);

    // Stjórnun: draga, hjól, klípa.
    const pointers = new Map();
    let pinchStart = null;
    const onDown = (e) => {
      dom.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), hfov: state.hfov };
      }
    };
    const onMove = (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 1) {
        const w = dom.clientWidth, h = dom.clientHeight;
        const vfov = (2 * Math.atan(Math.tan((state.hfov * Math.PI) / 360) / (w / h)) * 180) / Math.PI;
        state.yaw = wrapYaw(state.yaw - ((e.clientX - p.x) * state.hfov) / w);
        state.pitch = clamp(state.pitch + ((e.clientY - p.y) * vfov) / h, -90, 90);
      }
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        state.hfov = clamp((pinchStart.hfov * pinchStart.d) / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 20, 120);
      }
      state.dirty = true;
    };
    const onUp = (e) => { pointers.delete(e.pointerId); pinchStart = null; };
    const onWheel = (e) => {
      e.preventDefault();
      state.hfov = clamp(state.hfov * Math.exp(e.deltaY * 0.001), 20, 120);
      state.dirty = true;
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });

    const zoom = (f) => { state.hfov = clamp(state.hfov * f, 20, 120); state.dirty = true; };
    const btns = document.createElement('div');
    btns.className = 'pano-btns';
    btns.innerHTML = '<button type="button" data-a="in" aria-label="Súmma inn">+</button>' +
      '<button type="button" data-a="out" aria-label="Súmma út">−</button>' +
      '<button type="button" data-a="fs" aria-label="Fullur skjár">⛶</button>';
    btns.addEventListener('click', (e) => {
      const a = e.target.dataset?.a;
      if (a === 'in') zoom(0.8);
      else if (a === 'out') zoom(1.25);
      else if (a === 'fs') {
        const lb = document.getElementById('lightbox');
        if (document.fullscreenElement) document.exitFullscreen();
        else lb.requestFullscreen?.();
      }
    });
    container.appendChild(btns);

    return {
      getYaw: () => state.yaw,
      getPitch: () => state.pitch,
      getHfov: () => state.hfov,
      setYaw: (v) => { state.yaw = wrapYaw(v); state.dirty = true; },
      setPitch: (v) => { state.pitch = clamp(v, -90, 90); state.dirty = true; },
      setHfov: (v) => { state.hfov = clamp(v, 20, 120); state.dirty = true; },
      destroy() {
        state.destroyed = true;
        cancelAnimationFrame(state.raf);
        ro.disconnect();
        texture.dispose(); material.dispose(); geometry.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        dom.remove();
        btns.remove();
      },
    };
  }

  // ---------------------------------------------------------------------
  // 360° yfirlag: línur og möstur úr kortlögunum (GeoJSON/shapefile) teiknuð
  // á réttum stað ofan á panorama-myndinni. Staðsetning og stefna myndavélar
  // koma úr DJI-metadata (EXIF GPS + XMP). Hæðir eru áætlaðar (flatt land,
  // mastur/lína í valinni hæð) og stefna/hæð fínstillt með sleðum.
  // ---------------------------------------------------------------------
  const PANO_OVERLAY_KEY = 'efla_netdisk_pano_overlay_v1'; // sameiginlegar stillingar
  const PANO_CALIB_KEY = 'efla_netdisk_pano_calib_v1'; // kvörðun per mynd
  const EARTH_R = 6371000;
  const NEAR_Z = 1; // m - nær en þetta er ekki teiknað
  let panoOverlay = null;

  function lsGetJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch (err) {
      return fallback;
    }
  }

  function lsSetJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('Gat ekki vistað stillingar.', err);
    }
  }

  const panoSettings = Object.assign(
    { enabled: true, dxfEnabled: true, mastH: 30, lineH: 22, radiusKm: 8 },
    lsGetJson(PANO_OVERLAY_KEY, {})
  );

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  // Les staðsetningu/stefnu úr myndinni (EXIF + DJI XMP). Fellur til baka á
  // hnit úr photos.csv ef metadata vantar.
  async function readPanoMeta(url, photo) {
    const meta = { lat: null, lon: null, relAlt: null, heading: null, headingSource: '' };
    try {
      const t = await exifr.parse(url, { xmp: true, gps: true });
      if (t) {
        meta.lat = num(t.latitude) ?? num(t.GpsLatitude);
        meta.lon = num(t.longitude) ?? num(t.GpsLongitude);
        meta.relAlt = num(t.RelativeAltitude);
        const flightYaw = num(t.FlightYawDegree);
        const gimbalYaw = num(t.GimbalYawDegree);
        if (flightYaw !== null) { meta.heading = flightYaw; meta.headingSource = 'FlightYaw'; }
        else if (gimbalYaw !== null) { meta.heading = gimbalYaw; meta.headingSource = 'GimbalYaw'; }
      }
    } catch (err) {
      console.warn('Gat ekki lesið metadata úr 360° mynd.', err);
    }
    if (meta.lat === null || meta.lon === null) {
      meta.lat = photo.lat;
      meta.lon = photo.lon;
    }
    if (meta.heading === null) { meta.heading = photo.heading ?? 0; meta.headingSource = 'óþekkt'; }
    return meta;
  }

  // Safnar punktum og línum úr sýnilegum lögum innan radíus, í staðbundnum
  // hnitum (m austur/norður) miðað við myndavél. Línur eru klipptar í bita
  // sem liggja innan radíuss (+ einn nágrannapunktur).
  function collectOverlayGeometry(cam, radiusM) {
    const cosLat = Math.cos((cam.lat * Math.PI) / 180);
    const toEN = (lon, lat) => [(lon - cam.lon) * 111320 * cosLat, (lat - cam.lat) * 110574];
    const vertex = (lon, lat) => {
      const [e, n] = toEN(lon, lat);
      return { d: Math.hypot(e, n), beta: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360 };
    };
    const masts = [];
    const lines = [];

    importedShapes.forEach((shape) => {
      if (!shape.visible) return;
      (shape.geojson.features || []).forEach((f) => {
        const g = f.geometry;
        if (!g || !g.coordinates) return;
        const addPoint = (c) => {
          const v = vertex(c[0], c[1]);
          if (v.d > radiusM) return;
          const label = shape.labelField ? f.properties?.[shape.labelField] : null;
          masts.push({ ...v, label: label == null ? '' : String(label), color: shape.color });
        };
        const addLine = (coords) => {
          let run = [];
          const flush = () => { if (run.length > 1) lines.push({ pts: run, color: shape.color }); run = []; };
          let prevOutside = null;
          coords.forEach((c) => {
            const v = vertex(c[0], c[1]);
            if (v.d <= radiusM) {
              if (!run.length && prevOutside) run.push(prevOutside);
              run.push(v);
              prevOutside = null;
            } else {
              if (run.length) { run.push(v); flush(); }
              prevOutside = v;
            }
          });
          flush();
        };
        if (g.type === 'Point') addPoint(g.coordinates);
        else if (g.type === 'MultiPoint') g.coordinates.forEach(addPoint);
        else if (g.type === 'LineString') addLine(g.coordinates);
        else if (g.type === 'MultiLineString') g.coordinates.forEach(addLine);
      });
    });
    masts.sort((a, b) => a.d - b.d);
    return { masts, lines };
  }

  // ---------------------------------------------------------------------
  // 3D úr PLS-CADD DXF (.dxf3d, búið til með dxf-i-3d.bat): mannvirki (möstur,
  // einangrarar), leiðarar og stög teiknuð í réttri 3D-stöðu miðað við
  // myndavélina. Hnit eru ISN93 (grid), svo stefna myndar er leiðrétt um
  // hnitasamleitni (stefna sannra norðurs í grid). Hæð myndavélar er hæð yfir
  // jörð við næsta mannvirki (DXF gefur jörðina), stillanleg per mynd.
  // ---------------------------------------------------------------------
  const DXF3D_LIST_URL = 'data/dxf3d-list.json';
  const DXF3D_BASE = 'data/dxf3d/';
  const DXF_COLORS = { mast: '#ffd23f', insulator: '#ff7a59', conductor: '#38e1ff', stay: '#9bff8a' };
  const DXF_INSULATOR_RADIUS = 600; // m - einangrarar (þúsundir flata) bara nálægt
  const DXF_MAX_AGL = 250;
  let dxf3dPromise = null;

  function parseDxf3d(buf) {
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
    if (magic !== 'DXF3D001') throw new Error('ekki .dxf3d skrá');
    const hl = new DataView(buf).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
    const base = 12 + hl;
    const sec = {};
    header.sections.forEach((s) => { sec[s.name] = s; });
    const view = (name, Ctor) => new Ctor(buf, base + sec[name].offset, sec[name].count);
    return {
      header, ox: header.origin[0], oy: header.origin[1],
      faceVerts: view('faceVerts', Float32Array), faceIdx: view('faceIdx', Uint32Array),
      wireVerts: view('wireVerts', Float32Array),
    };
  }

  function loadDxf3dDatasets() {
    if (!dxf3dPromise) {
      dxf3dPromise = (async () => {
        const out = [];
        try {
          const list = (await (await fetch(`${DXF3D_LIST_URL}?_=${Date.now()}`, { cache: 'no-store' })).json()).files || [];
          for (const f of list) {
            try {
              const res = await fetch(`${DXF3D_BASE}${encodeURIComponent(f.name)}?_=${f.mtime}`);
              const ds = parseDxf3d(await res.arrayBuffer());
              ds.name = f.name;
              if (ds.header.crs !== 'EPSG:3057') { console.warn(`${f.name}: óstutt hnitakerfi ${ds.header.crs}`); continue; }
              out.push(ds);
            } catch (err) {
              console.warn(`Gat ekki lesið ${f.name}:`, err);
            }
          }
        } catch (err) {
          console.warn('Gat ekki sótt lista yfir 3D-skrár.', err);
        }
        return out;
      })();
    }
    return dxf3dPromise;
  }

  // Finnur 3D-gögn sem ná yfir myndavélina og reiknar stöðu hennar í ISN93.
  async function initDxfForOverlay(o) {
    if (!o.cam || o.cam.lat == null) return;
    const datasets = await loadDxf3dDatasets();
    if (panoOverlay !== o) return;
    const [x, y] = proj4('EPSG:4326', ISN93, [o.cam.lon, o.cam.lat]);
    const ds = datasets.find((d) => {
      const e = d.header.extent;
      return x > e[0] - 5000 && x < e[2] + 5000 && y > e[1] - 5000 && y < e[3] + 5000;
    });
    if (!ds) return;
    // Stefna sannra norðurs í ISN93-gridi (hnitasamleitni).
    const [nx, ny] = proj4('EPSG:4326', ISN93, [o.cam.lon, o.cam.lat + 0.01]);
    const theta = (Math.atan2(nx - x, ny - y) * 180) / Math.PI;
    let near = null;
    let nd = Infinity;
    ds.header.structures.forEach((s) => {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < nd) { nd = d; near = s; }
    });
    o.dxf = { ds, x, y, theta, near, nearDist: nd, scene: null, rev: 0 };
    document.getElementById('po-dxf-name').textContent = ds.header.source.replace(/\.dxf$/i, '');
    document.getElementById('po-dxf-section').classList.remove('hidden');
    if (o.calib.agl == null) o.calib.agl = Math.round(Math.max(3, Math.min(DXF_MAX_AGL, o.cam.height)));
    syncPanoPanel();
    rebuildDxfScene();
  }

  function dxfCamZ(o) {
    return o.dxf.near.groundZ + (o.calib.agl ?? 30);
  }

  // Velur mannvirki/línur innan radíuss og setur hornpunkta í þjappaðar fylkingar
  // (e,n = m frá myndavél í ISN93-gridi, z = hæð yfir sjó).
  function rebuildDxfScene() {
    const o = panoOverlay;
    if (!o || !o.dxf) return;
    const { ds, x: cx, y: cy } = o.dxf;
    const R = panoSettings.radiusKm * 1000;
    const ox = ds.ox, oy = ds.oy;
    const map = new Map();
    const vE = [], vN = [], vZ = [];
    const vid = (i) => {
      let k = map.get(i);
      if (k === undefined) {
        k = vE.length;
        map.set(i, k);
        vE.push(ds.faceVerts[i * 3] + ox - cx);
        vN.push(ds.faceVerts[i * 3 + 1] + oy - cy);
        vZ.push(ds.faceVerts[i * 3 + 2]);
      }
      return k;
    };
    const faces = { mast: [], insulator: [] };
    const labels = [];
    let nStruct = 0;
    ds.header.structures.forEach((s) => {
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d > R) return;
      nStruct++;
      labels.push({ name: s.name, e: s.x - cx, n: s.y - cy, z: s.topZ, d });
      Object.entries(s.groups).forEach(([role, [first, count]]) => {
        if (!faces[role] || (role === 'insulator' && d > DXF_INSULATOR_RADIUS)) return;
        for (let f = first; f < first + count; f++) {
          for (let j = 0; j < 4; j++) faces[role].push(vid(ds.faceIdx[f * 4 + j]));
        }
      });
    });
    const wires = [];
    ds.header.wires.forEach((w) => {
      if (w.role !== 'conductor' && w.role !== 'stay') return;
      const [x0, y0, x1, y1] = w.bbox;
      if (Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(y0 - cy, 0, cy - y1)) > R) return;
      const e = new Float32Array(w.count), n = new Float32Array(w.count), z = new Float32Array(w.count);
      for (let i = 0; i < w.count; i++) {
        const k = (w.first + i) * 3;
        e[i] = ds.wireVerts[k] + ox - cx;
        n[i] = ds.wireVerts[k + 1] + oy - cy;
        z[i] = ds.wireVerts[k + 2];
      }
      wires.push({ role: w.role, e, n, z });
    });
    labels.sort((a, b) => a.d - b.d);
    const nv = vE.length;
    o.dxf.scene = {
      nv, e: Float32Array.from(vE), n: Float32Array.from(vN), z: Float32Array.from(vZ),
      sx: new Float32Array(nv), sy: new Float32Array(nv), sz: new Float32Array(nv),
      faces: { mast: Uint32Array.from(faces.mast), insulator: Uint32Array.from(faces.insulator) },
      wires, labels, nStruct,
    };
    o.dxf.rev++;
    o.dirty = true;
    updatePanoInfo();
  }

  // Teiknar 3D-lagið á canvas (live). ψ = stefna miðju í gridi + núverandi yaw.
  function drawDxfScene(o, ctx, W, H, f, yaw, pitch) {
    const sc = o.dxf.scene;
    if (!sc) return;
    const rad = Math.PI / 180;
    const psi = (o.cam.heading + o.calib.yawOffset + o.dxf.theta + yaw) * rad;
    const c = Math.cos(psi), s = Math.sin(psi);
    const sp = Math.sin(pitch * rad), cp = Math.cos(pitch * rad);
    const camZ = dxfCamZ(o);
    const kc = 0.87 / (2 * EARTH_R);
    const cxs = W / 2, cys = H / 2;
    // Hornpunktar -> skjár
    for (let i = 0; i < sc.nv; i++) {
      const e = sc.e[i], n = sc.n[i];
      const u = sc.z[i] - camZ - (e * e + n * n) * kc;
      const zh = n * c + e * s;
      const z = zh * cp + u * sp;
      sc.sz[i] = z;
      if (z > NEAR_Z) {
        sc.sx[i] = cxs + (f * (e * c - n * s)) / z;
        sc.sy[i] = cys - (f * (u * cp - zh * sp)) / z;
      }
    }
    ctx.lineJoin = 'round';
    ['insulator', 'mast'].forEach((role) => {
      const idx = sc.faces[role];
      if (!idx.length) return;
      ctx.strokeStyle = DXF_COLORS[role];
      ctx.lineWidth = role === 'mast' ? 1.1 : 0.8;
      ctx.beginPath();
      for (let k = 0; k < idx.length; k += 4) {
        const a = idx[k], b = idx[k + 1], cc = idx[k + 2], d = idx[k + 3];
        if (sc.sz[a] <= NEAR_Z || sc.sz[b] <= NEAR_Z || sc.sz[cc] <= NEAR_Z || sc.sz[d] <= NEAR_Z) continue;
        const xa = sc.sx[a], xb = sc.sx[b], xc = sc.sx[cc], xd = sc.sx[d];
        if ((xa < -60 && xb < -60 && xc < -60 && xd < -60) || (xa > W + 60 && xb > W + 60 && xc > W + 60 && xd > W + 60)) continue;
        ctx.moveTo(xa, sc.sy[a]);
        ctx.lineTo(xb, sc.sy[b]);
        ctx.lineTo(xc, sc.sy[cc]);
        if (d !== cc) ctx.lineTo(xd, sc.sy[d]);
        ctx.closePath();
      }
      ctx.stroke();
    });
    // Leiðarar og stög (klippt við near-plane)
    ['stay', 'conductor'].forEach((role) => {
      ctx.strokeStyle = DXF_COLORS[role];
      ctx.lineWidth = role === 'conductor' ? 1.6 : 0.9;
      ctx.beginPath();
      sc.wires.forEach((w) => {
        if (w.role !== role) return;
        let px = 0, py = 0, pz = 0, pxc = 0, pyc = 0;
        for (let i = 0; i < w.e.length; i++) {
          const e = w.e[i], n = w.n[i];
          const u = w.z[i] - camZ - (e * e + n * n) * kc;
          const zh = n * c + e * s;
          const z = zh * cp + u * sp;
          const xc = e * c - n * s, yc = u * cp - zh * sp;
          if (i) {
            let ax = pxc, ay = pyc, az = pz, bx = xc, by = yc, bz = z;
            if (az > NEAR_Z || bz > NEAR_Z) {
              if (az <= NEAR_Z || bz <= NEAR_Z) {
                const t = (NEAR_Z - (az > NEAR_Z ? az : bz)) / ((az > NEAR_Z ? bz : az) - (az > NEAR_Z ? az : bz));
                if (az > NEAR_Z) { bx = ax + t * (bx - ax); by = ay + t * (by - ay); bz = NEAR_Z; }
                else { ax = bx + t * (ax - bx); ay = by + t * (ay - by); az = NEAR_Z; }
              }
              ctx.moveTo(cxs + (f * ax) / az, cys - (f * ay) / az);
              ctx.lineTo(cxs + (f * bx) / bz, cys - (f * by) / bz);
            }
          }
          pxc = xc; pyc = yc; pz = z;
        }
      });
      ctx.stroke();
    });
    // Nöfn mannvirkja (nálægustu fyrst)
    ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    let shown = 0;
    for (const lb of sc.labels) {
      if (shown >= 25) break;
      const u = lb.z - camZ - (lb.d * lb.d) * kc;
      const zh = lb.n * c + lb.e * s;
      const z = zh * cp + u * sp;
      if (z <= NEAR_Z) continue;
      const sx = cxs + (f * (lb.e * c - lb.n * s)) / z;
      const sy = cys - (f * (u * cp - zh * sp)) / z;
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      shown++;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(lb.name, sx, sy - 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(lb.name, sx, sy - 6);
    }
  }

  function stopPanoOverlay() {
    if (!panoOverlay) return;
    cancelAnimationFrame(panoOverlay.raf);
    panoOverlay.canvas.remove();
    document.getElementById('pano-overlay-panel').classList.add('hidden');
    panoOverlay = null;
  }

  async function startPanoOverlay(photo, url, image) {
    stopPanoOverlay();
    const panoEl = document.getElementById('lightbox-pano');
    const panel = document.getElementById('pano-overlay-panel');
    const canvas = document.createElement('canvas');
    canvas.className = 'pano-overlay-canvas';
    panoEl.appendChild(canvas);

    const overlay = {
      photo, url, image, canvas, ctx: canvas.getContext('2d'), raf: 0, dirty: true, lastKey: '',
      cam: null, geo: { masts: [], lines: [] },
      dxf: null,
      calib: Object.assign({ yawOffset: 0, groundDelta: 0, agl: null }, lsGetJson(PANO_CALIB_KEY, {})[photo.id] || {}),
    };
    panoOverlay = overlay;
    panel.classList.remove('hidden');
    syncPanoPanel();

    const meta = await readPanoMeta(url, photo);
    if (panoOverlay !== overlay) return; // lightbox lokað/skipt um mynd á meðan
    overlay.cam = {
      lat: meta.lat, lon: meta.lon, height: meta.relAlt ?? 2,
      heading: meta.heading, headingSource: meta.headingSource, hasRelAlt: meta.relAlt !== null,
    };
    rebuildPanoGeometry();
    overlay.raf = requestAnimationFrame(drawPanoOverlay);
    initDxfForOverlay(overlay).catch((err) => console.warn('3D-gögn tókust ekki.', err));
  }

  function rebuildPanoGeometry() {
    const o = panoOverlay;
    if (!o || !o.cam || o.cam.lat == null) return;
    o.geo = collectOverlayGeometry(o.cam, panoSettings.radiusKm * 1000);
    if (o.dxf) rebuildDxfScene();
    o.dirty = true;
    updatePanoInfo();
  }

  function updatePanoInfo() {
    const o = panoOverlay;
    if (!o || !o.cam) return;
    const near = o.geo.masts[0];
    let text =
      `Myndavél ${o.cam.lat?.toFixed(5)}, ${o.cam.lon?.toFixed(5)} · ${o.cam.height.toFixed(1)} m (DJI relative)` +
      `${o.cam.hasRelAlt ? '' : ' (áætluð)'} · stefna ${(o.cam.heading + o.calib.yawOffset).toFixed(1)}° (${o.cam.headingSource}) · ` +
      `${o.geo.masts.length} möstur, ${o.geo.lines.length} línubútar innan ${panoSettings.radiusKm} km` +
      (near ? ` · næsta mastur ${Math.round(near.d)} m (${near.label || 'án nafns'})` : '');
    if (o.dxf) {
      text += ` · 3D: næsta mannvirki ${o.dxf.near.name} (${Math.round(o.dxf.nearDist)} m, jörð ${o.dxf.near.groundZ.toFixed(1)} m y.s.), ` +
        `${o.dxf.scene ? o.dxf.scene.nStruct : 0} mannvirki innan ${panoSettings.radiusKm} km, hnitasamleitni ${o.dxf.theta.toFixed(2)}°`;
    }
    document.getElementById('po-info').textContent = text;
  }

  function syncPanoPanel() {
    const o = panoOverlay;
    const set = (id, outId, value, unit) => {
      document.getElementById(id).value = value;
      document.getElementById(outId).textContent = `${value}${unit}`;
    };
    document.getElementById('po-enabled').checked = panoSettings.enabled;
    document.getElementById('po-dxf-enabled').checked = panoSettings.dxfEnabled;
    document.getElementById('po-fields').classList.toggle('collapsed', !panoSettings.enabled && !(o && o.dxf && panoSettings.dxfEnabled));
    document.getElementById('po-dxf-section').classList.toggle('hidden', !(o && o.dxf));
    set('po-agl', 'po-agl-out', o && o.calib.agl != null ? o.calib.agl : 30, ' m');
    set('po-yaw', 'po-yaw-out', o ? o.calib.yawOffset : 0, '°');
    set('po-ground', 'po-ground-out', o ? o.calib.groundDelta : 0, ' m');
    set('po-mast', 'po-mast-out', panoSettings.mastH, ' m');
    set('po-line', 'po-line-out', panoSettings.lineH, ' m');
    set('po-radius', 'po-radius-out', panoSettings.radiusKm, ' km');
  }

  function savePanoCalib() {
    const o = panoOverlay;
    if (!o) return;
    const all = lsGetJson(PANO_CALIB_KEY, {});
    all[o.photo.id] = o.calib;
    lsSetJson(PANO_CALIB_KEY, all);
  }

  // Skrefið frá myndavélarhnitum yfir í skjáhnit (Pannellum: rectilinear).
  function projectPano(beta, d, u, st) {
    const yr = ((beta - st.heading - st.yaw) * Math.PI) / 180;
    const xh = d * Math.sin(yr);
    const zh = d * Math.cos(yr);
    return { x: xh, y: u * st.cp - zh * st.sp, z: zh * st.cp + u * st.sp };
  }

  function toScreen(p, st) {
    return [st.W / 2 + (st.f * p.x) / p.z, st.H / 2 - (st.f * p.y) / p.z];
  }

  function drawPanoOverlay() {
    const o = panoOverlay;
    if (!o) return;
    o.raf = requestAnimationFrame(drawPanoOverlay);
    if (!panoViewer || !o.cam) return;

    const dpr = window.devicePixelRatio || 1;
    const W = o.canvas.clientWidth;
    const H = o.canvas.clientHeight;
    if (!W || !H) return;
    const yaw = panoViewer.getYaw();
    const pitch = panoViewer.getPitch();
    const hfov = panoViewer.getHfov();
    const key = [yaw, pitch, hfov, W, H, o.calib.yawOffset, o.calib.groundDelta, o.calib.agl,
      panoSettings.enabled, panoSettings.dxfEnabled, panoSettings.mastH, panoSettings.lineH,
      o.geo.masts.length, o.dxf ? o.dxf.rev : 0].join('|');
    if (key === o.lastKey && !o.dirty) return;
    o.lastKey = key;
    o.dirty = false;

    if (o.canvas.width !== Math.round(W * dpr) || o.canvas.height !== Math.round(H * dpr)) {
      o.canvas.width = Math.round(W * dpr);
      o.canvas.height = Math.round(H * dpr);
    }
    const ctx = o.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (o.dxf && panoSettings.dxfEnabled) {
      drawDxfScene(o, ctx, W, H, (W / 2) / Math.tan((hfov * Math.PI) / 360), yaw, pitch);
    }
    if (!panoSettings.enabled) return;

    const pr = (pitch * Math.PI) / 180;
    const st = {
      W, H, yaw, f: (W / 2) / Math.tan((hfov * Math.PI) / 360),
      heading: o.cam.heading + o.calib.yawOffset, sp: Math.sin(pr), cp: Math.cos(pr),
    };
    // Grunnhæð lands miðað við myndavél (flatt land + hæðarmunur frá sleða),
    // með sveigju jarðar (þ. m. ljósbrot) dregna frá fyrir fjarlæga hluti.
    const baseU = (d) => -o.cam.height + o.calib.groundDelta - (d * d) / (2 * EARTH_R) * 0.87;

    // Línur
    ctx.lineWidth = 2;
    o.geo.lines.forEach((ln) => {
      ctx.strokeStyle = ln.color;
      ctx.beginPath();
      let prev = null;
      ln.pts.forEach((v) => {
        const p = projectPano(v.beta, v.d, baseU(v.d) + panoSettings.lineH, st);
        if (prev) {
          let a = prev, b = p;
          if (a.z > NEAR_Z || b.z > NEAR_Z) {
            if (a.z <= NEAR_Z || b.z <= NEAR_Z) { // klippa við near-plane
              const front = a.z > NEAR_Z ? a : b;
              const back = a.z > NEAR_Z ? b : a;
              const t = (NEAR_Z - front.z) / (back.z - front.z);
              const c = { x: front.x + t * (back.x - front.x), y: front.y + t * (back.y - front.y), z: NEAR_Z };
              if (a.z > NEAR_Z) b = c; else a = c;
            }
            const [x1, y1] = toScreen(a, st);
            const [x2, y2] = toScreen(b, st);
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
        }
        prev = p;
      });
      ctx.stroke();
    });

    // Möstur: lóðrétt lína frá jörð upp í topp, hringur á toppi, nafn næst
    ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    let labels = 0;
    o.geo.masts.forEach((m) => {
      const bu = baseU(m.d);
      const base = projectPano(m.beta, m.d, bu, st);
      const top = projectPano(m.beta, m.d, bu + panoSettings.mastH, st);
      if (base.z <= NEAR_Z || top.z <= NEAR_Z) return;
      const [bx, by] = toScreen(base, st);
      const [tx, ty] = toScreen(top, st);
      if (tx < -50 || tx > W + 50) return;
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (m.label && labels < 40) {
        labels++;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(m.label, tx, ty - 8);
        ctx.fillStyle = '#fff';
        ctx.fillText(m.label, tx, ty - 8);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Útflutningur: yfirlagið teiknað fast inn í sjálfa equirectangular
  // myndina (JPG). Hver punktur (stefna, hæðarhorn) er varpað beint í
  // x/y á 2:1 myndinni, svo skráin virkar í hvaða 360° viewer sem er.
  // Frum-EXIF (GPS, dagsetning) er afritað og GPano-merking bætt við.
  // ---------------------------------------------------------------------
  function drawOverlayEquirect(ctx, W, H, o) {
    const heading = o.cam.heading + o.calib.yawOffset;
    const rad = Math.PI / 180;
    const toXY = (e, n, u) => {
      const d = Math.hypot(e, n);
      let yaw = Math.atan2(e, n) / rad - heading;
      yaw = ((yaw + 540) % 360) - 180;
      return [(yaw / 360 + 0.5) * W, (0.5 - Math.atan2(u, d) / rad / 180) * H];
    };
    const baseU = (d) => -o.cam.height + o.calib.groundDelta - (d * d) / (2 * EARTH_R) * 0.87;
    const vec = (v, up) => ({ e: v.d * Math.sin(v.beta * rad), n: v.d * Math.cos(v.beta * rad), u: baseU(v.d) + up });
    const sc = W / 3000;

    // Teiknar beint 3D-strik a->b sem feril (skipt í bita því hann sveigist í equirect).
    const traceSegment = (a, b, state) => {
      const la = Math.hypot(a.e, a.n, a.u), lb = Math.hypot(b.e, b.n, b.u);
      const cosA = (a.e * b.e + a.n * b.n + a.u * b.u) / (la * lb);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) / rad;
      const steps = Math.max(1, Math.min(400, Math.ceil(ang / 0.25)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const [x, y] = toXY(a.e + t * (b.e - a.e), a.n + t * (b.n - a.n), a.u + t * (b.u - a.u));
        if (state.px === null || Math.abs(x - state.px) > W / 2) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        state.px = x;
      }
    };

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    o.geo.lines.forEach((ln) => {
      ctx.strokeStyle = ln.color;
      ctx.lineWidth = 1.3 * sc;
      ctx.beginPath();
      const state = { px: null };
      const pts = ln.pts.map((v) => vec(v, panoSettings.lineH));
      for (let i = 1; i < pts.length; i++) traceSegment(pts[i - 1], pts[i], state);
      ctx.stroke();
    });

    ctx.font = `600 ${Math.round(11 * sc)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    let labels = 0;
    o.geo.masts.forEach((m) => {
      const base = vec(m, 0);
      const top = vec(m, panoSettings.mastH);
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 1.3 * sc;
      ctx.beginPath();
      traceSegment(base, top, { px: null });
      ctx.stroke();
      const [tx, ty] = toXY(top.e, top.n, top.u);
      ctx.beginPath();
      ctx.arc(tx, ty, 1.8 * sc, 0, Math.PI * 2);
      ctx.fill();
      if (m.label && labels < 80) {
        labels++;
        ctx.lineWidth = 0.9 * sc;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(m.label, tx, ty - 2.6 * sc);
        ctx.fillStyle = '#fff';
        ctx.fillText(m.label, tx, ty - 2.6 * sc);
      }
    });
  }

  // 3D-lagið úr DXF í equirect-mynd (sömu gögn og drawDxfScene, önnur vörpun).
  function drawDxfEquirect(ctx, W, H, o) {
    const sc3 = o.dxf && o.dxf.scene;
    if (!sc3) return;
    const rad = Math.PI / 180;
    const psi = o.cam.heading + o.calib.yawOffset + o.dxf.theta;
    const camZ = dxfCamZ(o);
    const kc = 0.87 / (2 * EARTH_R);
    const sc = W / 3000;
    const vu = (e, n, z) => z - camZ - (e * e + n * n) * kc;
    const toXY = (e, n, u) => {
      let yaw = Math.atan2(e, n) / rad - psi;
      yaw = ((yaw + 540) % 360) - 180;
      return [(yaw / 360 + 0.5) * W, (0.5 - Math.atan2(u, Math.hypot(e, n)) / rad / 180) * H];
    };
    const trace = (a, b, state) => {
      const la = Math.hypot(a.e, a.n, a.u), lb = Math.hypot(b.e, b.n, b.u);
      if (la < 0.5 || lb < 0.5) return;
      const cosA = (a.e * b.e + a.n * b.n + a.u * b.u) / (la * lb);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) / rad;
      const steps = Math.max(1, Math.min(400, Math.ceil(ang / 0.25)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const [x, y] = toXY(a.e + t * (b.e - a.e), a.n + t * (b.n - a.n), a.u + t * (b.u - a.u));
        if (state.px === null || Math.abs(x - state.px) > W / 2) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        state.px = x;
      }
    };
    const pt = (i) => ({ e: sc3.e[i], n: sc3.n[i], u: vu(sc3.e[i], sc3.n[i], sc3.z[i]) });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ['insulator', 'mast'].forEach((role) => {
      const idx = sc3.faces[role];
      if (!idx.length) return;
      ctx.strokeStyle = DXF_COLORS[role];
      ctx.lineWidth = (role === 'mast' ? 1.1 : 0.8) * sc;
      ctx.beginPath();
      for (let k = 0; k < idx.length; k += 4) {
        const a = pt(idx[k]), b = pt(idx[k + 1]), c = pt(idx[k + 2]), d = pt(idx[k + 3]);
        const st = { px: null };
        trace(a, b, st); trace(b, c, st);
        if (idx[k + 3] !== idx[k + 2]) trace(c, d, st);
        trace(idx[k + 3] !== idx[k + 2] ? d : c, a, st);
      }
      ctx.stroke();
    });
    ['stay', 'conductor'].forEach((role) => {
      ctx.strokeStyle = DXF_COLORS[role];
      ctx.lineWidth = (role === 'conductor' ? 1.6 : 0.9) * sc;
      ctx.beginPath();
      sc3.wires.forEach((w) => {
        if (w.role !== role) return;
        const st = { px: null };
        for (let i = 1; i < w.e.length; i++) {
          trace(
            { e: w.e[i - 1], n: w.n[i - 1], u: vu(w.e[i - 1], w.n[i - 1], w.z[i - 1]) },
            { e: w.e[i], n: w.n[i], u: vu(w.e[i], w.n[i], w.z[i]) },
            st
          );
        }
      });
      ctx.stroke();
    });
    ctx.font = `600 ${Math.round(11 * sc)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    sc3.labels.slice(0, 40).forEach((lb) => {
      const [x, y] = toXY(lb.e, lb.n, vu(lb.e, lb.n, lb.z));
      ctx.lineWidth = 0.9 * sc;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(lb.name, x, y - 2.6 * sc);
      ctx.fillStyle = '#fff';
      ctx.fillText(lb.name, x, y - 2.6 * sc);
    });
  }

  // Les EXIF-hluta (APP1) úr haus upprunalegu JPG-skrárinnar - bara fyrstu bætin.
  async function readExifSegment(url) {
    const res = await fetch(url);
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    while (buf.length < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      const nb = new Uint8Array(buf.length + value.length);
      nb.set(buf);
      nb.set(value, buf.length);
      buf = nb;
    }
    reader.cancel().catch(() => {});
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (marker === 0xe1 && buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66) {
        return buf.slice(i, i + 2 + len);
      }
      i += 2 + len;
    }
    return null;
  }

  function buildPanoJpeg(jpegBytes, exifSeg, W, H, headingDeg) {
    const xmp =
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
      'xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" ' +
      'GPano:UsePanoramaViewer="True" ' +
      `GPano:FullPanoWidthPixels="${W}" GPano:FullPanoHeightPixels="${H}" ` +
      `GPano:CroppedAreaImageWidthPixels="${W}" GPano:CroppedAreaImageHeightPixels="${H}" ` +
      `GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0" ` +
      `GPano:PoseHeadingDegrees="${(((headingDeg % 360) + 360) % 360).toFixed(1)}"/>` +
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const enc = new TextEncoder();
    const hdr = enc.encode('http://ns.adobe.com/xap/1.0/\0');
    const body = enc.encode(xmp);
    const len = 2 + hdr.length + body.length;
    const xmpSeg = new Uint8Array(2 + len);
    xmpSeg[0] = 0xff; xmpSeg[1] = 0xe1; xmpSeg[2] = len >> 8; xmpSeg[3] = len & 255;
    xmpSeg.set(hdr, 4);
    xmpSeg.set(body, 4 + hdr.length);
    let pos = 2; // eftir SOI (og JFIF APP0 ef hann er til)
    if (jpegBytes[2] === 0xff && jpegBytes[3] === 0xe0) pos = 4 + ((jpegBytes[4] << 8) | jpegBytes[5]);
    const parts = [jpegBytes.subarray(0, pos)];
    if (exifSeg) parts.push(exifSeg);
    parts.push(xmpSeg, jpegBytes.subarray(pos));
    return new Blob(parts, { type: 'image/jpeg' });
  }

  async function exportPanoWithOverlay() {
    const o = panoOverlay;
    const btn = document.getElementById('po-export');
    if (!o || !o.cam || !o.image) return;
    const dxfOn = panoSettings.dxfEnabled && o.dxf && o.dxf.scene;
    if (!panoSettings.enabled && !dxfOn) {
      setStatus('Kveiktu á yfirlaginu áður en myndin er vistuð.');
      return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Bý til mynd…';
    try {
      const exifSeg = await readExifSegment(o.url).catch(() => null);
      const natW = o.image.naturalWidth, natH = o.image.naturalHeight;
      let blob = null;
      // Fyrst í fullri upplausn; ef vafrinn ræður ekki við hana, í 8192 px.
      for (const w of [natW, Math.min(natW, 8192)]) {
        const h = Math.round((natH * w) / natW);
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(o.image, 0, 0, w, h);
          if (dxfOn) drawDxfEquirect(ctx, w, h, o);
          if (panoSettings.enabled) drawOverlayEquirect(ctx, w, h, o);
          const jpeg = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
          if (!jpeg) continue;
          blob = buildPanoJpeg(new Uint8Array(await jpeg.arrayBuffer()), exifSeg, w, h, o.cam.heading + o.calib.yawOffset);
          break;
        } catch (err) {
          console.warn(`Útflutningur í ${w} px tókst ekki.`, err);
        }
      }
      if (!blob) throw new Error('vafrinn gat ekki búið til myndina');
      const name = `${o.photo.filename.replace(/\.[^.]+$/, '')}_yfirlag.jpg`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      setStatus(`Vistað: ${name} (${(blob.size / 1048576).toFixed(1)} MB) - sjá niðurhalsmöppu vafrans.`);
    } catch (err) {
      console.error(err);
      setStatus(`Gat ekki vistað mynd með yfirlagi: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function wirePanoPanel() {
    const byId = (id) => document.getElementById(id);
    byId('po-export').addEventListener('click', exportPanoWithOverlay);
    const redraw = () => { if (panoOverlay) panoOverlay.dirty = true; };
    byId('po-enabled').addEventListener('change', (e) => {
      panoSettings.enabled = e.target.checked;
      lsSetJson(PANO_OVERLAY_KEY, panoSettings);
      syncPanoPanel();
      redraw();
    });
    byId('po-dxf-enabled').addEventListener('change', (e) => {
      panoSettings.dxfEnabled = e.target.checked;
      lsSetJson(PANO_OVERLAY_KEY, panoSettings);
      syncPanoPanel();
      redraw();
    });
    const bindSetting = (id, outId, unit, apply) => {
      byId(id).addEventListener('input', (e) => {
        const v = Number(e.target.value);
        byId(outId).textContent = `${v}${unit}`;
        apply(v);
        redraw();
        updatePanoInfo();
      });
    };
    bindSetting('po-yaw', 'po-yaw-out', '°', (v) => { if (panoOverlay) { panoOverlay.calib.yawOffset = v; savePanoCalib(); } });
    bindSetting('po-agl', 'po-agl-out', ' m', (v) => { if (panoOverlay) { panoOverlay.calib.agl = v; savePanoCalib(); } });
    bindSetting('po-ground', 'po-ground-out', ' m', (v) => { if (panoOverlay) { panoOverlay.calib.groundDelta = v; savePanoCalib(); } });
    bindSetting('po-mast', 'po-mast-out', ' m', (v) => { panoSettings.mastH = v; lsSetJson(PANO_OVERLAY_KEY, panoSettings); });
    bindSetting('po-line', 'po-line-out', ' m', (v) => { panoSettings.lineH = v; lsSetJson(PANO_OVERLAY_KEY, panoSettings); });
    bindSetting('po-radius', 'po-radius-out', ' km', (v) => {
      panoSettings.radiusKm = v;
      lsSetJson(PANO_OVERLAY_KEY, panoSettings);
      rebuildPanoGeometry();
    });
  }

  function showLightboxPhoto(photo) {
    const url = photoUrl(photo);
    const imgEl = document.getElementById('lightbox-img');
    const panoEl = document.getElementById('lightbox-pano');

    document.getElementById('lightbox-caption').textContent = photo.filename;
    document.getElementById('lightbox').classList.remove('hidden');
    updateLightboxNavButtons();

    const showFlat = () => {
      destroyPanoViewer();
      panoEl.classList.add('hidden');
      imgEl.classList.remove('hidden');
      imgEl.src = url;
    };

    const probe = new Image();
    // Myndir geta legið á öðru léni (R2/Blob): WebGL-áferð og útflutningur krefjast CORS.
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      const ratio = probe.naturalWidth / probe.naturalHeight;
      if (ratio >= PANO_MIN_RATIO && ratio <= PANO_MAX_RATIO) {
        destroyPanoViewer();
        imgEl.classList.add('hidden');
        imgEl.src = '';
        panoEl.classList.remove('hidden');
        try {
          panoViewer = createPanoViewer(panoEl, probe);
        } catch (err) {
          console.warn('360° viewer (WebGL) tókst ekki, sýni flata mynd.', err);
          showFlat();
          return;
        }
        startPanoOverlay(photo, url, probe);
      } else {
        showFlat();
      }
    };
    probe.onerror = showFlat;
    probe.src = url;
  }

  function openLightbox(id) {
    const idx = visiblePhotos.findIndex((p) => p.id === id);
    if (idx !== -1) {
      lightboxIndex = idx;
      showLightboxPhoto(visiblePhotos[idx]);
      return;
    }
    // Myndin er ekki í núverandi síuðum lista (t.d. flokkur falinn) -
    // sýna hana samt eina og sér, án flettingar.
    const photo = markersByFilename.get(id)?.__photo;
    if (!photo) return;
    lightboxIndex = -1;
    showLightboxPhoto(photo);
  }

  function lightboxStep(delta) {
    if (lightboxIndex === -1 || visiblePhotos.length === 0) return;
    lightboxIndex = (lightboxIndex + delta + visiblePhotos.length) % visiblePhotos.length;
    showLightboxPhoto(visiblePhotos[lightboxIndex]);
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('lightbox-img').src = '';
    destroyPanoViewer();
    lightboxIndex = -1;
  }

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxStep(-1);
  });
  document.getElementById('lightbox-next').addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxStep(1);
  });
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  wirePanoPanel();
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') { closeLightbox(); return; }
    if (e.target instanceof HTMLInputElement) return; // örvar í sleðum fletta ekki myndum
    if (e.key === 'ArrowLeft') lightboxStep(-1);
    else if (e.key === 'ArrowRight') lightboxStep(1);
  });

  window.__netdiskMap = { openLightbox };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  updateLabelVisibility();
  loadCachedShapes(); // línuleiðir frá fyrri heimsókn (handvirkt innfluttar)
  // lög úr data/ (búin til af build_site.py)
  loadSharedShapes().then((loadedFiles) => loadAutoGeojsonFiles(loadedFiles));
  rebuildMarkersFromCache(); // paint whatever's cached from a previous run
  setStatus('Sæki myndalista…');
  loadCsvIndex().then((csvResult) => {
    rebuildMarkersFromCache();
    if (csvResult.ok && csvResult.added > 0) {
      setStatus(`${csvResult.added} myndir.`);
      if (markersByFilename.size > 0) {
        const bounds = L.latLngBounds(Array.from(markersByFilename.values()).map((m) => m.getLatLng()));
        map.invalidateSize();
        map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
      }
    } else {
      setStatus('Engar myndir fundust (data/photos.csv vantar eða er tóm).');
    }
  });
})();
