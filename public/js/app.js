'use strict';

// Test photo: place nusantara.jpg in uploads/ and thumbnails/ (300px version) directories.
// Photo is from Nusantara, Indonesia's new capital.

// ── Constants ─────────────────────────────────────────────────────────────────
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const CATEGORY_COLORS = {
  'お客様': '#2563eb',
  '政府・当局関係者': '#dc2626',
  '内部': '#16a34a',
  'プライベート': '#7c3aed',
  'その他': '#6b7280',
};

// ── MapLibre map style (OSM raster) ──────────────────────────────────────────
const MAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [OSM_TILE_URL],
      tileSize: 256,
      attribution: OSM_ATTRIBUTION,
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

// ── State ─────────────────────────────────────────────────────────────────────
let map = null;
let miniMap = null;
let miniMapMarker = null;
let selectedLat = null;
let selectedLng = null;
let pendingFile = null;
let uploadedFileInfo = null; // {filename, thumbnail, date}

// ── Helper: category badge HTML ───────────────────────────────────────────────
function categoryBadge(category) {
  const safeCategory = category || 'その他';
  const cls = `badge badge-${CSS.escape(safeCategory)}`;
  const color = CATEGORY_COLORS[safeCategory] || CATEGORY_COLORS['その他'];
  return `<span class="badge" style="background:${color}">${escapeHtml(safeCategory)}</span>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(isoString) {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return isoString;
  }
}

// ── Initialize main map ───────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [113.0, -1.5], // Indonesia
    zoom: 5,
  });

  map.on('load', async () => {
    await loadPhotos();
    setupMapInteractions();
  });
}

// ── Load photos from API and add to map ───────────────────────────────────────
async function loadPhotos() {
  try {
    const res = await fetch('/api/photos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();

    // Remove existing source/layers if refreshing
    ['clusters', 'cluster-count', 'unclustered-point'].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('photos')) map.removeSource('photos');

    map.addSource('photos', {
      type: 'geojson',
      data: geojson,
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 50,
    });

    // Cluster circles
    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'photos',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step', ['get', 'point_count'],
          '#60a5fa', 10,
          '#2563eb', 30,
          '#1d4ed8',
        ],
        'circle-radius': [
          'step', ['get', 'point_count'],
          20, 10,
          28, 30,
          36,
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
        'circle-opacity': 0.9,
      },
    });

    // Cluster count labels
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'photos',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-size': 14,
      },
      paint: {
        'text-color': '#fff',
      },
    });

    // Individual photo points
    map.addLayer({
      id: 'unclustered-point',
      type: 'circle',
      source: 'photos',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#2563eb',
        'circle-radius': 9,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
        'circle-opacity': 0.92,
      },
    });
  } catch (err) {
    console.error('Failed to load photos:', err);
  }
}

// ── Map interactions (clusters & popups) ──────────────────────────────────────
function setupMapInteractions() {
  // Click cluster → zoom in
  map.on('click', 'clusters', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
    if (!features.length) return;
    const clusterId = features[0].properties.cluster_id;
    map.getSource('photos').getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({
        center: features[0].geometry.coordinates,
        zoom: zoom,
      });
    });
  });

  // Cursor style on clusters
  map.on('mouseenter', 'clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'clusters', () => { map.getCanvas().style.cursor = ''; });

  // Click individual point → show popup
  map.on('click', 'unclustered-point', (e) => {
    const feature = e.features[0];
    const coords = feature.geometry.coordinates.slice();
    const { filename, thumbnail, date, address, category, comment } = feature.properties;

    const thumbSrc = thumbnail ? `/thumbnails/${encodeURIComponent(thumbnail)}` : '';
    const thumbHtml = thumbSrc
      ? `<img class="popup-thumb" src="${escapeHtml(thumbSrc)}" alt="サムネイル"
              data-filename="${escapeHtml(filename)}"
              data-date="${escapeHtml(date)}"
              data-address="${escapeHtml(address)}"
              data-category="${escapeHtml(category)}"
              data-comment="${escapeHtml(comment)}"
              onclick="openLightbox(this)" />`
      : '';

    const html = `
      <div>
        ${thumbHtml}
        <div class="popup-body">
          ${categoryBadge(category)}
          <div class="popup-address">${escapeHtml(address || '住所未設定')}</div>
          <div class="popup-date">${formatDate(date)}</div>
        </div>
      </div>`;

    new maplibregl.Popup({ maxWidth: '300px' })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);
  });

  map.on('mouseenter', 'unclustered-point', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'unclustered-point', () => { map.getCanvas().style.cursor = ''; });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(imgEl) {
  const filename = imgEl.dataset.filename;
  const date = imgEl.dataset.date;
  const address = imgEl.dataset.address;
  const category = imgEl.dataset.category;
  const comment = imgEl.dataset.comment;

  document.getElementById('lightboxImg').src = `/uploads/${encodeURIComponent(filename)}`;
  document.getElementById('lightboxDate').textContent = formatDate(date);
  document.getElementById('lightboxAddress').textContent = address || '';
  document.getElementById('lightboxCategory').innerHTML = categoryBadge(category);
  document.getElementById('lightboxComment').textContent = comment || '';

  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightboxImg').src = '';
}

// ── Modal open/close ──────────────────────────────────────────────────────────
function openModal() {
  document.getElementById('addPhotoModal').classList.remove('hidden');
  if (!miniMap) {
    setTimeout(() => initMiniMap(), 100);
  } else {
    // Resize in case container changed
    setTimeout(() => miniMap.resize(), 100);
  }
}

function closeModal() {
  document.getElementById('addPhotoModal').classList.add('hidden');
  resetForm();
}

function resetForm() {
  document.getElementById('fileInput').value = '';
  document.getElementById('photoPreview').src = '';
  document.getElementById('photoPreview').classList.add('hidden');
  const hint = document.getElementById('dropHint');
  if (hint) hint.style.display = '';
  document.getElementById('addressInput').value = '';
  document.getElementById('categorySelect').selectedIndex = 0;
  document.getElementById('commentInput').value = '';
  document.getElementById('coordsText').textContent = '位置が選択されていません';
  document.getElementById('saveBtn').disabled = true;
  selectedLat = null;
  selectedLng = null;
  pendingFile = null;
  uploadedFileInfo = null;

  if (miniMapMarker) {
    miniMapMarker.remove();
    miniMapMarker = null;
  }
}

// ── Mini-map ──────────────────────────────────────────────────────────────────
function initMiniMap() {
  miniMap = new maplibregl.Map({
    container: 'miniMap',
    style: MAP_STYLE,
    center: [113.0, -1.5],
    zoom: 5,
  });

  miniMap.on('click', (e) => {
    const { lng, lat } = e.lngLat;
    selectedLng = lng;
    selectedLat = lat;

    document.getElementById('coordsDisplay').textContent =
      `緯度: ${lat.toFixed(6)}  経度: ${lng.toFixed(6)}`;

    if (miniMapMarker) {
      miniMapMarker.setLngLat([lng, lat]);
    } else {
      miniMapMarker = new maplibregl.Marker({ color: '#2563eb', draggable: true })
        .setLngLat([lng, lat])
        .addTo(miniMap);

      miniMapMarker.on('dragend', () => {
        const pos = miniMapMarker.getLngLat();
        selectedLng = pos.lng;
        selectedLat = pos.lat;
        document.getElementById('coordsDisplay').textContent =
          `緯度: ${pos.lat.toFixed(6)}  経度: ${pos.lng.toFixed(6)}`;
        checkSaveReady();
      });
    }

    checkSaveReady();
  });
}

// ── Drag & drop / file selection ──────────────────────────────────────────────
function setupDropZone() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const preview = document.getElementById('photoPreview');
  const hint = document.getElementById('dropHint');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleFileSelected(file);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
  });

  function handleFileSelected(file) {
    pendingFile = file;
    uploadedFileInfo = null;

    // Show local preview immediately
    const reader = new FileReader();
    reader.onload = (ev) => {
      preview.src = ev.target.result;
      preview.classList.remove('hidden');
      hint.style.display = 'none';
    };
    reader.readAsDataURL(file);

    checkSaveReady();
  }
}

// ── Enable Save button when both photo and location are set ───────────────────
function checkSaveReady() {
  const ready = !!(pendingFile && selectedLat !== null && selectedLng !== null);
  document.getElementById('saveBtn').disabled = !ready;
}

// ── Save: upload photo then save metadata ─────────────────────────────────────
async function savePhoto() {
  if (!pendingFile || selectedLat === null || selectedLng === null) return;

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中…';

  try {
    // Step 1: Upload photo
    const formData = new FormData();
    formData.append('photo', pendingFile);

    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!uploadRes.ok) {
      const err = await uploadRes.json();
      throw new Error(err.error || `Upload failed (${uploadRes.status})`);
    }
    uploadedFileInfo = await uploadRes.json();

    // Step 2: Save metadata to Google Sheets
    const metaRes = await fetch('/api/photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: uploadedFileInfo.filename,
        thumbnail: uploadedFileInfo.thumbnail,
        date: uploadedFileInfo.date,
        address: document.getElementById('addressInput').value.trim(),
        category: document.getElementById('categorySelect').value,
        comment: document.getElementById('commentInput').value.trim(),
        lat: selectedLat,
        lng: selectedLng,
      }),
    });

    if (!metaRes.ok) {
      const err = await metaRes.json();
      throw new Error(err.error || `Metadata save failed (${metaRes.status})`);
    }

    // Step 3: Refresh map data
    await loadPhotos();

    // Step 4: Close modal
    closeModal();
  } catch (err) {
    console.error('Save failed:', err);
    alert(`保存に失敗しました: ${err.message}`);
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Open modal
  document.getElementById('addPhotoBtn').addEventListener('click', openModal);

  // Save & cancel
  document.getElementById('saveBtn').addEventListener('click', savePhoto);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);

  // Close modal by clicking overlay background
  document.getElementById('addPhotoModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('addPhotoModal')) closeModal();
  });

  // Lightbox close
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxOverlay').addEventListener('click', closeLightbox);

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('lightbox').classList.contains('hidden')) {
        closeLightbox();
      } else if (document.getElementById('addPhotoModal').classList.contains('open')) {
        closeModal();
      }
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupDropZone();
  setupEventListeners();
});
