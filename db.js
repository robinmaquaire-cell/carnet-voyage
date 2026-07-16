/* =========================================================
   db.js — Sauvegarde locale des carnets (IndexedDB)
   ---------------------------------------------------------
   IndexedDB est une petite base de données intégrée au
   navigateur, capable de stocker beaucoup de données (utile
   pour les photos et les audios, trop lourds pour le
   stockage classique).

   Organisation (plusieurs carnets depuis la v2) :
   - clé "index"        : la liste des carnets {carnets:[{id,nom,visible}], actifId}
   - clé "carnet-<id>"  : les données complètes d'un carnet
   - clé "actuel"       : ANCIEN emplacement (un seul carnet) — migré au
                          premier démarrage puis supprimé.
   ========================================================= */

const DB_NOM = "carnet-voyage";
const DB_VERSION = 1;
const STORE = "carnet";

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

/** Enregistre des données (objet simple) sous la clé donnée. */
async function dbSauverCle(cle, donnees) {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(donnees, cle);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Charge les données enregistrées sous la clé donnée, ou null. */
async function dbChargerCle(cle) {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(cle);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Efface les données enregistrées sous la clé donnée. */
async function dbEffacerCle(cle) {
  const db = await ouvrirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(cle);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
