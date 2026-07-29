/* =========================================================
   medias.js — Photos et sons stockés à part, en ligne
   ---------------------------------------------------------
   PROBLÈME : jusqu'ici, chaque photo (et chaque son) d'un carnet
   était collée EN TEXTE (base64) à l'intérieur du fichier du
   carnet. Un carnet de 25 souvenirs pesait 40-50 Mo et dépassait
   la limite du stockage en ligne → la synchronisation échouait.

   SOLUTION : chaque photo/son devient un FICHIER séparé en ligne,
   nommé d'après son empreinte (une signature calculée sur son
   contenu). Le fichier du carnet ne garde qu'un petit renvoi vers
   cette empreinte. Résultat :
   - le fichier du carnet redevient minuscule (du texte) ;
   - une même photo n'est stockée qu'UNE fois, même si le carnet
     est dupliqué ou si deux souvenirs la partagent ;
   - une photo déjà en ligne n'est jamais renvoyée.

   IMPORTANT : tout ceci ne concerne QUE la version en ligne. Sur
   l'appareil (IndexedDB), les carnets gardent leurs photos en
   entier (base64), donc l'affichage, l'impression et le mode hors
   ligne ne changent pas. La conversion se fait uniquement au
   moment d'envoyer (on extrait) et de recevoir (on rétablit).
   ========================================================= */

// En-dessous de cette taille (caractères), une donnée intégrée reste dans le
// fichier du carnet (petits pictogrammes SVG par ex.) : la sortir coûterait
// plus cher que de la garder.
const MEDIA_SEUIL = 1024;

// Renvoi écrit dans le fichier du carnet en ligne à la place d'une photo :
//   "#media:<empreinte>:<type>"
// (l'empreinte est en hexadécimal, sans deux-points ; le type suit, ex.
//  "image/jpeg" — sans deux-points non plus.)
const MEDIA_PREFIXE = "#media:";

/** Une chaîne est-elle une donnée intégrée « data:… » (photo, son) ? */
function estDataUri(v) {
  return typeof v === "string" && v.slice(0, 5) === "data:";
}

/** Le type (« image/jpeg »…) d'une data URI, ou "application/octet-stream". */
function typeDeDataUri(uri) {
  const m = /^data:([^;,]+)[;,]/.exec(uri);
  return (m && m[1]) || "application/octet-stream";
}

/** Décode la partie base64 d'une data URI en octets. */
function dataUriEnOctets(uri) {
  const virgule = uri.indexOf(",");
  const base64 = uri.slice(virgule + 1);
  const binaire = atob(base64);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return octets;
}

/** Encode des octets en base64 (par tranches, pour ne pas saturer la pile). */
function octetsEnBase64(octets) {
  let binaire = "";
  const tranche = 0x8000;
  for (let i = 0; i < octets.length; i += tranche) {
    binaire += String.fromCharCode.apply(null, octets.subarray(i, i + tranche));
  }
  return btoa(binaire);
}

/** Empreinte SHA-256 (hexadécimal) d'octets — l'identité en ligne du fichier. */
async function empreinteOctets(octets) {
  const condensat = await crypto.subtle.digest("SHA-256", octets);
  return Array.from(new Uint8Array(condensat))
    .map((o) => o.toString(16).padStart(2, "0")).join("");
}

/**
 * Parcourt en profondeur une valeur (objet/tableau) et remplace chaque chaîne
 * par le résultat de `transformer(chaine)` — s'il renvoie une chaîne. Utilisé
 * pour repérer partout les data URI (et les renvois #media) sans devoir
 * énumérer la structure exacte d'un carnet (souvenirs, réserve, éléments
 * posés, pictogrammes…). Asynchrone : le calcul d'empreinte l'est.
 */
async function parcourirEtRemplacer(valeur, transformer) {
  if (typeof valeur === "string") {
    const remplacee = await transformer(valeur);
    return typeof remplacee === "string" ? remplacee : valeur;
  }
  if (Array.isArray(valeur)) {
    const sortie = new Array(valeur.length);
    for (let i = 0; i < valeur.length; i++) {
      sortie[i] = await parcourirEtRemplacer(valeur[i], transformer);
    }
    return sortie;
  }
  if (valeur && typeof valeur === "object") {
    const sortie = {};
    for (const cle of Object.keys(valeur)) {
      sortie[cle] = await parcourirEtRemplacer(valeur[cle], transformer);
    }
    return sortie;
  }
  return valeur;
}

/**
 * Prépare un carnet pour l'envoi en ligne : sort les photos/sons volumineux et
 * les remplace par des renvois. Renvoie une COPIE allégée (l'original en
 * mémoire n'est pas touché) + la liste des médias à téléverser.
 * @returns {Promise<{allege:object, medias:Map<string,{octets:Uint8Array,type:string}>}>}
 */
async function extraireMediasPourNuage(donnees) {
  const medias = new Map();
  const allege = await parcourirEtRemplacer(donnees, async (chaine) => {
    if (!estDataUri(chaine) || chaine.length < MEDIA_SEUIL) return null;
    const type = typeDeDataUri(chaine);
    const octets = dataUriEnOctets(chaine);
    const empreinte = await empreinteOctets(octets);
    if (!medias.has(empreinte)) medias.set(empreinte, { octets, type });
    return MEDIA_PREFIXE + empreinte + ":" + type;
  });
  return { allege, medias };
}

/** Décompose un renvoi "#media:<empreinte>:<type>" (ou null si ce n'en est pas un). */
function lireRenvoiMedia(chaine) {
  if (typeof chaine !== "string" || chaine.slice(0, MEDIA_PREFIXE.length) !== MEDIA_PREFIXE) {
    return null;
  }
  const reste = chaine.slice(MEDIA_PREFIXE.length);
  const sep = reste.indexOf(":");
  if (sep < 0) return null;
  return { empreinte: reste.slice(0, sep), type: reste.slice(sep + 1) };
}

/**
 * Rétablit un carnet reçu du nuage : remplace chaque renvoi par la vraie
 * photo/son (téléchargé et re-encodé en data URI), pour le stockage local.
 * `telechargerMedia(empreinte)` doit renvoyer les octets du fichier, ou null.
 * Un média manquant en ligne laisse un renvoi non résolu (mieux que de perdre
 * tout le reste du carnet) ; il sera récupéré à une prochaine synchro.
 */
async function resoudreMediasNuage(donnees, telechargerMedia) {
  const cache = new Map();
  return parcourirEtRemplacer(donnees, async (chaine) => {
    const renvoi = lireRenvoiMedia(chaine);
    if (!renvoi) return null;
    if (cache.has(renvoi.empreinte)) return cache.get(renvoi.empreinte);
    let dataUri = null;
    try {
      const octets = await telechargerMedia(renvoi.empreinte);
      if (octets) dataUri = "data:" + renvoi.type + ";base64," + octetsEnBase64(octets);
    } catch (e) { /* média indisponible : on garde le renvoi */ }
    if (dataUri) cache.set(renvoi.empreinte, dataUri);
    return dataUri; // null → le renvoi reste tel quel
  });
}

/** Un carnet contient-il encore des renvois non résolus (média absent) ? */
function carnetADesRenvoisManquants(donnees) {
  let trouve = false;
  const scan = (v) => {
    if (trouve) return;
    if (lireRenvoiMedia(v)) { trouve = true; return; }
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  scan(donnees);
  return trouve;
}
