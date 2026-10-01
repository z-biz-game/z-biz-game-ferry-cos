'use strict';
// 离线壳。两条硬规矩，都是踩过的坑：
//   1) 缓存名带版本号（VERSION）。发版时把 VERSION 提一格，activate 里旧版本缓存整批判掉，
//      不会出现"新 HTML 配旧 JS"的鬼状态。
//   2) 同源子资源一律**网络优先，失败才退缓存**。手工定版 + cache-first 会把 js/css 永久钉死
//      在第一次抓到的那份上；这仓是零构建的 ES module，钉住一支 js/core/*.js 就等于钉住整个游戏。
// 跨域请求（字体 CDN 等）直接放行不接管；非 GET 一律不接管。
const VERSION = 'ferry-v1';
const SHELL = ['./', './index.html', './css/game.css', './js/main.js', './manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: false });
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a deploy is picked up at once; offline falls back to the shell.
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => fromCache('./index.html').then((hit) => hit || Response.error()))
    );
    return;
  }

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => fromCache(req).then((hit) => hit || Response.error()))
  );
});
