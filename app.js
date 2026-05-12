// ============================================
// 旅行プランナー
// ============================================

const STORAGE_KEY = 'travel-planner-data';
const HOME_CENTER = [48.5, 7.0];
const HOME_ZOOM = 5;

// 状態
let state = {
  pins: [],
  trips: [],
  showPolylines: false
};

// 地図関連
let map;
let pinMarkers = {}; // id -> Leaflet marker
let tripPolylines = {}; // tripId -> Leaflet polyline
let pendingLatLng = null; // クリック位置（新規追加時）
let editingPinId = null;
let editingTripId = null;

// ============================================
// 初期化
// ============================================
function init() {
  loadData();
  initMap();
  bindEvents();
  document.getElementById('show-polylines').checked = !!state.showPolylines;
  renderAll();
}

// ============================================
// データ永続化
// ============================================
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = JSON.parse(raw);
      if (!state.pins) state.pins = [];
      if (!state.trips) state.trips = [];
      if (typeof state.showPolylines !== 'boolean') state.showPolylines = false;
      // マイグレーション: 旧データに updatedAt が無ければ 0 を補完
      state.pins.forEach(p => { if (typeof p.updatedAt !== 'number') p.updatedAt = 0; });
      state.trips.forEach(t => { if (typeof t.updatedAt !== 'number') t.updatedAt = 0; });
    }
  } catch (e) {
    console.error('データ読み込みエラー', e);
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ============================================
// 地図
// ============================================
function initMap() {
  // 西欧を中心に表示
  map = L.map('map').setView(HOME_CENTER, HOME_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
    crossOrigin: true
  }).addTo(map);

  // 地図クリック → 新規ピン追加
  map.on('click', (e) => {
    pendingLatLng = e.latlng;
    openPinModal(null);
  });
}

function createPinIcon(status) {
  return L.divIcon({
    className: 'custom-pin-wrapper',
    html: `<div class="custom-pin ${status}"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -8]
  });
}

function renderPinMarkers() {
  // 既存マーカーを削除
  Object.values(pinMarkers).forEach(m => map.removeLayer(m));
  pinMarkers = {};

  state.pins.forEach(pin => {
    const marker = L.marker([pin.lat, pin.lng], {
      icon: createPinIcon(pin.status)
    }).addTo(map);

    marker.bindPopup(buildPopupHtml(pin));
    marker.on('popupopen', () => bindPopupEvents(pin.id));

    pinMarkers[pin.id] = marker;
  });
}

function buildPopupHtml(pin) {
  const statusLabel = pin.status === 'visited' ? '✅ 訪問済み' : '📅 訪問予定';
  const dateLabel = pin.dateUnknown
    ? `<div class="popup-meta">📆 日付不明</div>`
    : (pin.date ? `<div class="popup-meta">📆 ${pin.date}</div>` : '');
  const memo = pin.memo ? `<div class="popup-memo">${escapeHtml(pin.memo)}</div>` : '';

  const tripOptions = state.trips.map(t =>
    `<option value="${t.id}" ${t.id === pin.tripId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');
  const tripSelector = `
    <div class="popup-trip-row">
      <label>🗺️ 旅程
        <select class="popup-trip-select" data-id="${pin.id}">
          <option value="" ${!pin.tripId ? 'selected' : ''}>（旅程に含めない）</option>
          ${tripOptions}
        </select>
      </label>
    </div>
  `;

  return `
    <div class="pin-popup">
      <h4>${escapeHtml(pin.name)}</h4>
      <div class="popup-meta">${statusLabel}</div>
      ${dateLabel}
      ${tripSelector}
      ${memo}
      <div class="popup-actions">
        <button data-action="edit" data-id="${pin.id}">編集</button>
        <button data-action="delete" data-id="${pin.id}">削除</button>
      </div>
    </div>
  `;
}

function bindPopupEvents(pinId) {
  const popup = document.querySelector('.leaflet-popup-content');
  if (!popup) return;

  popup.querySelectorAll('button').forEach(btn => {
    btn.onclick = (e) => {
      const action = e.target.dataset.action;
      const id = e.target.dataset.id;
      if (action === 'edit') {
        openPinModal(id);
      } else if (action === 'delete') {
        if (confirm('このピンを削除しますか？')) {
          deletePin(id);
        }
      }
    };
  });

  const tripSelect = popup.querySelector('.popup-trip-select');
  if (tripSelect) {
    tripSelect.onchange = (e) => {
      const id = e.target.dataset.id;
      changePinTrip(id, e.target.value || null);
    };
  }
}

function changePinTrip(pinId, newTripId) {
  const pin = state.pins.find(p => p.id === pinId);
  if (!pin) return;
  pin.tripId = newTripId;
  pin.updatedAt = Date.now();
  saveData();

  // ポップアップを開いたままサイドバーとポリラインを更新
  renderTripsList();
  renderPinsList();
  renderStats();
  renderPolylines();
}

function renderPolylines() {
  // 既存ポリラインを削除
  Object.values(tripPolylines).forEach(p => map.removeLayer(p));
  tripPolylines = {};

  // グローバル設定: 経路線を表示しない場合は早期リターン
  if (!state.showPolylines) return;

  state.trips.forEach(trip => {
    if (trip.visible === false) return;

    const tripPins = state.pins
      .filter(p => p.tripId === trip.id)
      .sort((a, b) => {
        // 日付不明・空のピンは末尾に
        const aUnknown = a.dateUnknown || !a.date;
        const bUnknown = b.dateUnknown || !b.date;
        if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
        return (a.date || '').localeCompare(b.date || '');
      });

    if (tripPins.length < 2) return;

    const latlngs = tripPins.map(p => [p.lat, p.lng]);
    const polyline = L.polyline(latlngs, {
      color: trip.color,
      weight: 3,
      opacity: 0.7,
      dashArray: '8, 6'
    }).addTo(map);

    tripPolylines[trip.id] = polyline;
  });
}

// ============================================
// レンダリング
// ============================================
function renderAll() {
  renderPinMarkers();
  renderPolylines();
  renderTripsList();
  renderPinsList();
  renderStats();
  renderTripDropdown();
}

function renderStats() {
  document.getElementById('stat-visited').textContent =
    state.pins.filter(p => p.status === 'visited').length;
  document.getElementById('stat-planned').textContent =
    state.pins.filter(p => p.status === 'planned').length;
  document.getElementById('stat-trips').textContent = state.trips.length;
}

function renderTripsList() {
  const ul = document.getElementById('trips-list');
  ul.innerHTML = '';

  if (state.trips.length === 0) {
    ul.innerHTML = '<li class="empty-msg">旅程はまだありません</li>';
    return;
  }

  state.trips.forEach(trip => {
    const count = state.pins.filter(p => p.tripId === trip.id).length;
    const li = document.createElement('li');
    li.className = 'trip-item';
    li.innerHTML = `
      <div class="trip-color-box" style="background:${trip.color}"></div>
      <span class="trip-name">${escapeHtml(trip.name)} (${count})</span>
      <span class="trip-visible-toggle">${trip.visible === false ? '🚫' : '👁️'}</span>
    `;
    li.querySelector('.trip-visible-toggle').onclick = (e) => {
      e.stopPropagation();
      trip.visible = trip.visible === false ? true : false;
      saveData();
      renderAll();
    };
    li.querySelector('.trip-name').onclick = () => openTripModal(trip.id);
    li.querySelector('.trip-color-box').onclick = () => openTripModal(trip.id);
    ul.appendChild(li);
  });
}

function renderPinsList() {
  const ul = document.getElementById('pins-list');
  const filter = document.getElementById('filter-status').value;
  ul.innerHTML = '';

  let filtered = state.pins;
  if (filter !== 'all') {
    filtered = filtered.filter(p => p.status === filter);
  }
  filtered = filtered.slice().sort((a, b) => {
    const aUnknown = a.dateUnknown || !a.date;
    const bUnknown = b.dateUnknown || !b.date;
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return (a.date || '').localeCompare(b.date || '');
  });

  if (filtered.length === 0) {
    ul.innerHTML = '<li class="empty-msg">ピンはまだありません</li>';
    return;
  }

  filtered.forEach(pin => {
    const li = document.createElement('li');
    li.className = 'pin-item';
    const dateText = (!pin.dateUnknown && pin.date) ? ' · ' + pin.date : '';
    const trip = state.trips.find(t => t.id === pin.tripId);
    const tripBadge = trip
      ? `<span class="pin-trip-badge" style="background:${trip.color}" title="${escapeHtml(trip.name)}">${escapeHtml(trip.name)}</span>`
      : '';
    li.innerHTML = `
      <span class="pin-status-dot ${pin.status}"></span>
      <span class="pin-name">${escapeHtml(pin.name)}${dateText}</span>
      ${tripBadge}
    `;
    li.onclick = () => {
      map.setView([pin.lat, pin.lng], 10);
      const marker = pinMarkers[pin.id];
      if (marker) marker.openPopup();
    };
    ul.appendChild(li);
  });
}

function renderTripDropdown() {
  const select = document.getElementById('pin-trip');
  const current = select.value;
  select.innerHTML = '<option value="">（旅程に含めない）</option>';
  state.trips.forEach(trip => {
    const opt = document.createElement('option');
    opt.value = trip.id;
    opt.textContent = trip.name;
    select.appendChild(opt);
  });
  select.value = current;
}

// ============================================
// ピン操作
// ============================================
function openPinModal(pinId) {
  editingPinId = pinId;
  const modal = document.getElementById('pin-modal');
  const title = document.getElementById('pin-modal-title');
  const deleteBtn = document.getElementById('pin-delete-btn');

  renderTripDropdown();

  if (pinId) {
    const pin = state.pins.find(p => p.id === pinId);
    title.textContent = 'ピンを編集';
    document.getElementById('pin-name').value = pin.name;
    document.getElementById('pin-status').value = pin.status;
    document.getElementById('pin-date').value = pin.date || '';
    document.getElementById('pin-trip').value = pin.tripId || '';
    document.getElementById('pin-memo').value = pin.memo || '';
    document.getElementById('pin-date-unknown').checked = !!pin.dateUnknown;
    deleteBtn.classList.remove('hidden');
  } else {
    title.textContent = 'ピンを追加';
    document.getElementById('pin-form').reset();
    document.getElementById('pin-date-unknown').checked = false;
    deleteBtn.classList.add('hidden');
  }

  updateDateInputState();
  modal.classList.remove('hidden');
  document.getElementById('pin-name').focus();
}

function updateDateInputState() {
  // 日付不明チェック時、日付入力欄を無効化
  const checked = document.getElementById('pin-date-unknown').checked;
  const dateInput = document.getElementById('pin-date');
  dateInput.disabled = checked;
  if (checked) dateInput.value = '';
}

function closePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
  editingPinId = null;
  pendingLatLng = null;
}

function savePin() {
  const name = document.getElementById('pin-name').value.trim();
  if (!name) return;

  const dateUnknown = document.getElementById('pin-date-unknown').checked;

  const data = {
    name,
    status: document.getElementById('pin-status').value,
    date: dateUnknown ? '' : document.getElementById('pin-date').value,
    dateUnknown,
    tripId: document.getElementById('pin-trip').value || null,
    memo: document.getElementById('pin-memo').value.trim(),
    updatedAt: Date.now()
  };

  if (editingPinId) {
    const pin = state.pins.find(p => p.id === editingPinId);
    Object.assign(pin, data);
  } else {
    if (!pendingLatLng) return;
    state.pins.push({
      id: uuid(),
      lat: pendingLatLng.lat,
      lng: pendingLatLng.lng,
      ...data
    });
  }

  saveData();
  renderAll();
  closePinModal();

  // 入力完了後はホームポジションに戻す
  map.setView(HOME_CENTER, HOME_ZOOM);
}

function deletePin(id) {
  state.pins = state.pins.filter(p => p.id !== id);
  saveData();
  renderAll();
}

// ============================================
// 旅程操作
// ============================================
function openTripModal(tripId) {
  editingTripId = tripId;
  const modal = document.getElementById('trip-modal');
  const title = document.getElementById('trip-modal-title');
  const deleteBtn = document.getElementById('trip-delete-btn');

  if (tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    title.textContent = '旅程を編集';
    document.getElementById('trip-name').value = trip.name;
    document.getElementById('trip-color').value = trip.color;
    deleteBtn.classList.remove('hidden');
  } else {
    title.textContent = '旅程を追加';
    document.getElementById('trip-form').reset();
    document.getElementById('trip-color').value = randomColor();
    deleteBtn.classList.add('hidden');
  }

  modal.classList.remove('hidden');
  document.getElementById('trip-name').focus();
}

function closeTripModal() {
  document.getElementById('trip-modal').classList.add('hidden');
  editingTripId = null;
}

function saveTrip() {
  const name = document.getElementById('trip-name').value.trim();
  if (!name) return;

  const data = {
    name,
    color: document.getElementById('trip-color').value,
    updatedAt: Date.now()
  };

  if (editingTripId) {
    const trip = state.trips.find(t => t.id === editingTripId);
    Object.assign(trip, data);
  } else {
    state.trips.push({
      id: uuid(),
      visible: true,
      ...data
    });
  }

  saveData();
  renderAll();
  closeTripModal();
}

function deleteTrip(id) {
  if (!confirm('この旅程を削除しますか？\n（含まれるピン自体は残ります）')) return;
  state.trips = state.trips.filter(t => t.id !== id);
  state.pins.forEach(p => {
    if (p.tripId === id) p.tripId = null;
  });
  saveData();
  renderAll();
  closeTripModal();
}

function randomColor() {
  const colors = ['#FF5722', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
                  '#009688', '#FF9800', '#795548', '#607D8B', '#F44336'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ============================================
// 検索（Nominatim）
// ============================================
async function searchCity() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=de,fr,it,es,pt,gb&limit=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'ja' } });
    const data = await res.json();
    if (data.length === 0) {
      alert('見つかりませんでした');
      return;
    }
    const place = data[0];
    map.setView([parseFloat(place.lat), parseFloat(place.lon)], 11);
  } catch (e) {
    alert('検索エラー: ' + e.message);
  }
}

// ============================================
// エクスポート / インポート
// ============================================
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `travel-planner-${today}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportMapImage() {
  const btn = document.getElementById('export-image-btn');
  const originalText = btn.textContent;
  btn.textContent = '⏳ 生成中...';
  btn.disabled = true;

  try {
    // タイルが完全に読み込まれるのを少し待つ
    await new Promise(resolve => setTimeout(resolve, 500));

    const mapEl = document.getElementById('map');
    const dataUrl = await htmlToImage.toPng(mapEl, {
      quality: 1,
      pixelRatio: 2,
      cacheBust: true,
      filter: (node) => {
        // Leafletのコントロール（ズームボタン、attribution）を除外したい場合はここで
        if (node.classList && node.classList.contains('leaflet-control-zoom')) {
          return false;
        }
        return true;
      }
    });

    const a = document.createElement('a');
    a.href = dataUrl;
    const today = new Date().toISOString().slice(0, 10);
    a.download = `travel-map-${today}.png`;
    a.click();
  } catch (err) {
    alert('画像エクスポート失敗: ' + err.message);
    console.error(err);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// 取り込み待ちのデータ（モーダル表示中に保持）
let pendingImport = null;

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.pins || !data.trips) throw new Error('無効なファイル');

      // updatedAt が無い旧形式データは 0 を補完
      data.pins.forEach(p => { if (typeof p.updatedAt !== 'number') p.updatedAt = 0; });
      data.trips.forEach(t => { if (typeof t.updatedAt !== 'number') t.updatedAt = 0; });

      pendingImport = data;
      openImportModal(data);
    } catch (err) {
      alert('インポートエラー: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function openImportModal(data) {
  // サマリ計算
  const importedPinIds = new Set(data.pins.map(p => p.id));
  const importedTripIds = new Set(data.trips.map(t => t.id));
  const newPins = data.pins.filter(p => !state.pins.find(local => local.id === p.id)).length;
  const newTrips = data.trips.filter(t => !state.trips.find(local => local.id === t.id)).length;
  const commonPins = data.pins.length - newPins;
  const commonTrips = data.trips.length - newTrips;

  const summary = `📥 取込ファイル: ピン ${data.pins.length}件 / 旅程 ${data.trips.length}件\n` +
                  `　うち新規追加: ピン ${newPins}件、旅程 ${newTrips}件\n` +
                  `　既存と重複: ピン ${commonPins}件、旅程 ${commonTrips}件\n` +
                  `📍 現在の端末: ピン ${state.pins.length}件 / 旅程 ${state.trips.length}件`;

  document.getElementById('import-summary').textContent = summary;
  document.getElementById('import-modal').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.add('hidden');
  pendingImport = null;
}

function performMergeImport() {
  if (!pendingImport) return;
  const data = pendingImport;

  // 旅程をマージ（ID一致なら updatedAt が新しい方、無ければそのまま追加）
  let tripsAdded = 0, tripsUpdated = 0;
  data.trips.forEach(imp => {
    const local = state.trips.find(t => t.id === imp.id);
    if (!local) {
      state.trips.push(imp);
      tripsAdded++;
    } else if ((imp.updatedAt || 0) > (local.updatedAt || 0)) {
      Object.assign(local, imp);
      tripsUpdated++;
    }
  });

  // ピンも同様にマージ
  let pinsAdded = 0, pinsUpdated = 0;
  data.pins.forEach(imp => {
    const local = state.pins.find(p => p.id === imp.id);
    if (!local) {
      state.pins.push(imp);
      pinsAdded++;
    } else if ((imp.updatedAt || 0) > (local.updatedAt || 0)) {
      Object.assign(local, imp);
      pinsUpdated++;
    }
  });

  saveData();
  renderAll();
  closeImportModal();
  alert(`結合インポート完了\n\n` +
        `ピン: ${pinsAdded}件追加 / ${pinsUpdated}件更新\n` +
        `旅程: ${tripsAdded}件追加 / ${tripsUpdated}件更新`);
}

function performReplaceImport() {
  if (!pendingImport) return;
  if (!confirm('本当に既存データをすべて削除して置き換えますか？\nこの操作は取り消せません。')) return;
  state = pendingImport;
  saveData();
  renderAll();
  closeImportModal();
  alert('置き換えインポート完了');
}

// ============================================
// ユーティリティ
// ============================================
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// イベントバインド
// ============================================
function bindEvents() {
  // ピンフォーム
  document.getElementById('pin-form').onsubmit = (e) => {
    e.preventDefault();
    savePin();
  };
  document.getElementById('pin-cancel-btn').onclick = closePinModal;
  document.getElementById('pin-date-unknown').onchange = updateDateInputState;
  document.getElementById('pin-delete-btn').onclick = () => {
    if (editingPinId && confirm('このピンを削除しますか？')) {
      deletePin(editingPinId);
      closePinModal();
    }
  };

  // 旅程フォーム
  document.getElementById('trip-form').onsubmit = (e) => {
    e.preventDefault();
    saveTrip();
  };
  document.getElementById('trip-cancel-btn').onclick = closeTripModal;
  document.getElementById('trip-delete-btn').onclick = () => {
    if (editingTripId) deleteTrip(editingTripId);
  };
  document.getElementById('add-trip-btn').onclick = () => openTripModal(null);

  // フィルター
  document.getElementById('filter-status').onchange = renderPinsList;

  // 経路線表示トグル
  document.getElementById('show-polylines').onchange = (e) => {
    state.showPolylines = e.target.checked;
    saveData();
    renderPolylines();
  };

  // 検索
  document.getElementById('search-btn').onclick = searchCity;
  document.getElementById('search-input').onkeydown = (e) => {
    if (e.key === 'Enter') searchCity();
  };

  // エクスポート/インポート
  document.getElementById('export-btn').onclick = exportData;
  document.getElementById('export-image-btn').onclick = exportMapImage;
  document.getElementById('import-btn').onclick = () =>
    document.getElementById('import-file').click();
  document.getElementById('import-file').onchange = (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  };

  // 取込モード選択モーダル
  document.getElementById('import-merge-btn').onclick = performMergeImport;
  document.getElementById('import-replace-btn').onclick = performReplaceImport;
  document.getElementById('import-cancel-btn').onclick = closeImportModal;

  // モーダル外クリックで閉じる
  document.getElementById('pin-modal').onclick = (e) => {
    if (e.target.id === 'pin-modal') closePinModal();
  };
  document.getElementById('trip-modal').onclick = (e) => {
    if (e.target.id === 'trip-modal') closeTripModal();
  };
  document.getElementById('import-modal').onclick = (e) => {
    if (e.target.id === 'import-modal') closeImportModal();
  };
}

// Service Worker登録（PWA・オフライン対応）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW登録失敗:', err);
    });
  });
}

// 起動
init();
