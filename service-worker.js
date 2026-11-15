"use strict";

const CACHE_NAME = "mch-bdtms-shell-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./manifest.webmanifest",
  "./assets/css/styles.css",
  "./assets/js/app.js",
  "./assets/images/app-icon.svg",
  "./assets/images/pwa-icon-180.png",
  "./assets/images/pwa-icon-192.png",
  "./assets/images/pwa-icon-512.png",
  "./assets/images/avatar-placeholder.svg",
  "./assets/images/hospital-logo.png"
];
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

function cacheThenReturn(key, response) {
  if (!response.ok) return Promise.resolve(response);
  return caches.open(CACHE_NAME)
    .then((cache) => cache.put(key, response.clone()))
    .then(() => response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((path) => new URL(path, self.registration.scope).href)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("mch-bdtms-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => cacheThenReturn(INDEX_URL, response))
        .catch(() => caches.match(INDEX_URL))
    );
    return;
  }

  if (/\b(config\.js|app\.js|styles\.css|manifest\.webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => cacheThenReturn(request, response))
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => cacheThenReturn(request, response)))
  );
});
