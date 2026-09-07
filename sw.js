// 美顔カメラ Service Worker
//
// 方針: ネットワーク優先・キャッシュはフォールバック。
// push した更新が必ず届くことを最優先にしている（キャッシュ優先だと
// 古い app.js が residual で残り、実機で「直したのに変わらない」が起きる）。
// オフラインでも起動できるよう、取得に成功したものは都度キャッシュへ写す。

const CACHE = 'selfie-cam-v1';

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/renderer.js',
  './js/shaders.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 1つ失敗しても install 全体を落とさない
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
