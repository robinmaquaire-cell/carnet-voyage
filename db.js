/* =========================================================
   db.js — Sauvegarde locale du carnet (IndexedDB)
   ---------------------------------------------------------
   IndexedDB est une petite base de données intégrée au
   navigateur, capable de stocker beaucoup de données (utile
   pour les photos, trop lourdes pour le stockage classique).

   On garde les choses simples : une seule base, un seul tiroir
   ("store"), et un seul carnet enregistré sous une clé fixe.
   ========================================================= */

const DB_NOM = "carnet-voyage";
const DB_VERSION = 1;
const STORE = "carnet";
const CLE = "actuel"; // on ne gère qu'un carnet à la fois

/** Ouvre (ou crée) la base de données. Renvoie une promesse. */
function ouvrirDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOM, DB_VERSION);
    // Appelé la première fois (ou si on change DB_VERSION) : on crée le tiroir.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Enregistre le carnet (objet simple, sans éléments Leaflet). */
async function dbSauver(donnees) {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(donnees, CLE);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Charge le carnet enregistré, ou null s'il n'y en a pas. */
async function dbCharger() {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(CLE);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Efface le carnet enregistré (utilisé par "Nouveau carnet"). */
async function dbEffacer() {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(CLE);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
