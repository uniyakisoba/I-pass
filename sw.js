/*
 * サービスワーカー：アプリのファイルをスマホ内にキャッシュ（一時保存）して、
 * 電波がない場所でも起動できるようにする仕組み。
 * ファイルを更新したら CACHE の番号を上げると、古いキャッシュが入れ替わる。
 */
const CACHE = 'ipass-v5';
const FILES = [
  './', './index.html', './css/style.css', './js/app.js', './js/questions.js', './js/past_questions.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// まずネットから最新版を取りに行き、失敗したら（オフライン時）キャッシュを返す
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
