/* =========================================================
   sw.js — Service Worker (cache de l'application)
   ---------------------------------------------------------
   Un "service worker" est un petit programme que le navigateur
   garde en mémoire pour servir l'application même hors ligne.
   On met en cache les fichiers de l'app (sa "coquille"). Les
   images de carte, elles, viennent d'Internet à la demande.
   ========================================================= */

const CACHE = "logbookmap-v104";

// Les fichiers locaux de l'application à garder en cache.
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "ui.js",
  "selection.js",
  "config.js",
  "medias.js",
  "nuage.js",
  "gpx.js",
  "db.js",
  "impression.js",
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

// La page peut nous demander de sauter la file d'attente (nouveau SW
// installe mais pas encore actif car l'ancien SW controle toujours des
// clients). On saute pour appliquer la nouvelle version tout de suite.
self.addEventListener("message", (e) => {
  if (e && e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Activation : on supprime les anciens caches.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Requêtes : pour nos fichiers (même origine), on tente d'abord le réseau
// (pour toujours avoir la dernière version), et on retombe sur le cache si
// on est hors-ligne. Le reste (tuiles de carte, librairies CDN) part
// directement sur le réseau, sans intervention du service worker.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tuiles & CDN : réseau direct

  e.respondWith(
    fetch(e.request)
      .then((reponse) => {
        // On ne met en cache que les réponses valides (évite d'écraser un
        // fichier correct par une page d'erreur du serveur).
        if (reponse && reponse.ok) {
          const copie = reponse.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie));
        }
        return reponse;
      })
      .catch(() =>
        caches.match(e.request).then((cache) => cache || caches.match("index.html"))
      )
  );
});
