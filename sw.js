// Service Worker - 旅行プランナー
// オフライン対応用キャッシュ
//
// バージョンを変えるとブラウザが古いキャッシュを削除して新しいキャッシュを構築する
const VERSION = 'v3';
const CACHE_NAME = `travel-planner-europe-${VERSION}`;

// アプリ本体（同一オリジン）
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 外部CDN（Leaflet, html-to-image）
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js'
];

// インストール時：必要なファイルをキャッシュに保存
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all([
        cache.addAll(APP_SHELL),
        // CDNは失敗しても致命的でないので個別に
        ...CDN_ASSETS.map((url) =>
          fetch(url, { mode: 'cors' })
            .then((res) => res.ok && cache.put(url, res))
            .catch(() => null)
        )
      ])
    )
  );
  self.skipWaiting();
});

// アクティブ化時：古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// フェッチ：地図タイル以外はキャッシュ優先、なければネットワーク
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 地図タイル・検索APIはキャッシュしない（容量肥大化を避ける）
  // ネットワーク要求のままにしてブラウザ標準処理に任せる
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('nominatim.openstreetmap.org')
  ) {
    return;
  }

  // GETリクエストのみキャッシュ対象
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // 成功した同一オリジン・CDNレスポンスをキャッシュに追加
          if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // オフラインかつキャッシュにない場合：ナビゲーション要求ならindex.htmlを返す
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
