/* =========================================================
   sw.js — Service Worker (cache de l'application)
   ---------------------------------------------------------
   Un "service worker" est un petit programme que le navigateur
   garde en mémoire pour servir l'application même hors ligne.
   On met en cache les fichiers de l'app (sa "coquille"). Les
   images de carte, elles, viennent d'Internet à la demande.
   ========================================================= */

const CACHE = "carnet-voyage-v1";

// Les fichiers locaux de l'application à garder en cache.
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "gpx.js",
  "db.js",
  "manifest.webmanifest",
  "icon.svg",
  "exemple-rando.gpx",
];

// Installation : on précharge la coquille de l'app.
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activation : on supprime les anciens caches.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Requêtes : pour nos fichiers (même origine), on sert le cache puis le réseau.
// Le reste (tuiles de carte, librairies CDN) part directement sur le réseau.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tuiles & CDN : réseau direct

  e.respondWith(
    caches.match(e.request).then((cache) => {
      return (
        cache ||
        fetch(e.request)
          .then((reponse) => {
            const copie = reponse.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copie));
            return reponse;
          })
          .catch(() => caches.match("index.html"))
      );
    })
  );
});
