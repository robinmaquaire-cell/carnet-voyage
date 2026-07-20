/* =========================================================
   app.js — Le coeur de l'application
   ---------------------------------------------------------
   ÉTAPE 1 : afficher une carte et y charger une trace GPX.
   Les étapes suivantes (souvenirs, photos, style, sauvegarde)
   viendront s'ajouter ici par-dessus cette base.
   ========================================================= */

// "État" de l'application : ce qu'on garde en mémoire pendant l'utilisation.
const etat = {
  carte: null,            // l'objet carte Leaflet
  coucheFond: null,       // la couche d'images de fond (tuiles) actuellement affichée
  glMap: null,            // la carte MapLibre sous-jacente (fond vectoriel seulement)
  grappe: null,           // groupe qui regroupe les épingles trop proches (clustering)
  filtre: { du: "", au: "", pictos: null }, // filtre visualisation (pictos: null = tous)
  carnets: [],            // l'index de tous les carnets : [{id, nom, visible}]
  carnetActifId: 1,       // le carnet ouvert (le seul modifiable)
  fantomes: new Map(),    // carnets AFFICHÉS en plus en visualisation : id → {couche, souvenirs, trace, pictosPerso}
  coucheTrace: null,      // le groupe de calques qui contient la trace dessinée
  trace: null,            // la RÉUNION des GPX du carnet { name, segments, waypoints }
  gpxListe: [],           // chaque GPX ajouté au carnet : [{id, nom, segments, waypoints}]
  zoomRefTrace: 13,       // zoom "de référence" du carnet (celui qui cadre la trace)
  chargeOk: false,        // vrai quand le carnet courant a été chargé correctement
  souvenirs: [],          // la liste des points souvenirs posés par l'utilisateur
  stock: [],              // souvenirs "en réserve" (sans position), à poser plus tard
  pictosPerso: [],        // pictogrammes personnalisés importés par l'utilisateur
  policesPerso: [],       // polices importées (partagées entre tous les carnets)
  decorsPerso: [],        // roses des vents / bordures importées (partagées aussi)
  annotations: [],        // pictogrammes et textes posés librement sur le fond de carte
  annotationActive: null, // l'annotation en cours de modification dans l'éditeur
  modeAnnotation: null,   // "picto" ou "texte" quand on attend un clic pour poser un élément
  modeAjout: false,       // vrai quand on attend un clic sur la carte pour poser un souvenir
  souvenirActif: null,    // le souvenir dont la fiche est ouverte dans le panneau
  style: null,            // les réglages d'apparence (rempli au démarrage)
  mode: "edition",        // "edition" ou "visualisation" (lecture seule)
  miniCarte: null,        // petite carte de situation dans la pop up (visualisation)
  miniCouche: null,       // calque (trace + épingle) de la mini-carte
};

// IMPORTANT : la fenêtre d'impression (impression.html) lit les données du
// carnet via window.opener.etat. Or une variable déclarée avec "const" n'est
// PAS une propriété de window : sans cette ligne, la fenêtre d'impression ne
// trouverait jamais le carnet.
window.etat = etat;

// Compteur pour donner un identifiant unique à chaque souvenir.
let prochainIdSouvenir = 1;

/* ---------- Réglages de style : valeurs et options ---------- */

// Style par défaut d'un carnet (repris du look actuel).
const STYLE_DEFAUT = {
  titre: "",
  titrePolice: "titre", // police du cartouche de titre (clé du catalogue)
  titreFond: "classique", // style du cartouche : classique | parchemin | pirate | sombre
  trace: { couleur: "#c8893d", epaisseur: 4, type: "plein" },
  fond: "topo",
  ambiance: "naturel",
  // Fond personnalisé : adresse de tuiles fournie par l'utilisateur.
  fondPerso: { url: "", maxZoom: 19, attribution: "", subdomains: "abc" },
  // Affichage des noms des souvenirs sur la carte.
  // taille : "petit" | "moyen" | "grand" OU un nombre de pixels (réglage fin).
  labels: { afficher: false, police: "systeme", couleur: "#2f3b34", taille: "moyen" },
  // Style des épingles de souvenirs : forme (goutte | rond | carre | minimal),
  // couleur, largeur en pixels, et affichage du numéro.
  epingles: { forme: "goutte", couleur: "#d35438", taille: 34, numero: true },
  // Arrondi des contours du fond (rayon en pixels, 0 = aucun). Contrairement
  // à l'ancien "lissage" (un simple flou), c'est un vrai arrondi des angles.
  arrondi: 0,
  // Décor posé sur la carte (repris sur l'affiche PDF et l'export en image).
  decor: { rose: false, bordure: false },
  // Personnalisation du fond VECTORIEL (couleur des zones, police des lieux).
  // null = on garde la couleur d'origine du fond vectoriel.
  vecteur: {
    zones: {
      eau: null, riviere: null, foret: null, reserve: null, prairie: null,
      glacier: null, bati: null, route: null, frontiere: null, noms: null, fond: null,
    },
    detail: "complet", // "complet" | "epure" (masque petites routes, bâtiments, POI)
    police: null,
    preset: null, // null = fond standard ; sinon une clé de PRESETS_FOND
    // Couches géographiques affichées (décochées = masquées).
    couches: { noms: true, frontiere: true, riviere: true, route: true, bati: true },
    // Simplification GÉOMÉTRIQUE des tracés du fond : zoom maximal des DONNÉES
    // vectorielles (14 = tout le détail ; plus bas = contours plus généralisés,
    // comme une carte à petite échelle).
    simplification: 14,
  },
};

// Correspondance des anciens réglages de simplification (mots) → zoom des données.
const SIMPLIFICATION_ANCIENNE = { aucune: 14, legere: 12, moyenne: 10, forte: 8 };

/** Normalise un réglage de simplification (nombre 1–14 ; mots des anciens carnets). */
function lireSimplification(valeur, defaut) {
  if (typeof valeur === "string" && SIMPLIFICATION_ANCIENNE[valeur] !== undefined) {
    return SIMPLIFICATION_ANCIENNE[valeur];
  }
  const n = Number(valeur);
  if (Number.isFinite(n) && n >= 1 && n <= 14) return Math.round(n);
  return defaut;
}

// Teinte d'ambiance et arrondi : filtres CSS combinés en une seule variable
// (--filtre-fond) posée sur la carte, pour que les deux réglages coexistent.
const AMBIANCE_FILTRES = {
  naturel: "",
  ancien: "sepia(0.35) saturate(0.8) brightness(1.03)",
  doux: "saturate(0.55) brightness(1.06)",
  medieval: "sepia(0.78) saturate(0.6) contrast(1.08) brightness(1.07)",
};

// Préréglages "carte médiévale" du fond vectoriel. Chacun règle d'un coup :
// la palette des zones, la teinte du grain de parchemin, la couleur des noms
// de lieux (écrits en italique, halo parchemin) et le décor (rose + bordure).
const PRESETS_FOND = {
  ancienne: {
    label: "Carte ancienne",
    zones: {
      fond: "#e9e0c4", eau: "#a7c0c4", foret: "#9fb083", reserve: "#b3ab7d",
      prairie: "#dcd3ab", bati: "#cdb89a", route: "#8a6b45",
    },
    teinte: "ancienne",           // variante du calque parchemin
    noms: "#5a4632", halo: "#e9e0c4",
  },
  clair: {
    label: "Parchemin clair",
    zones: {
      fond: "#f4ecd6", eau: "#ccdad1", riviere: "#b9cec5", foret: "#c4c69c",
      reserve: "#cfc99e", prairie: "#eae1c0", bati: "#ddcaa9", route: "#a58353",
      frontiere: "#a4886a", noms: "#6b5233",
    },
    teinte: "claire",
    noms: "#6b5233", halo: "#f4ecd6",
  },
  sombre: {
    label: "Parchemin sombre",
    zones: {
      fond: "#d8c49a", eau: "#8fa8a0", riviere: "#7f988f", foret: "#8a9468",
      reserve: "#9a9a6d", prairie: "#c7b587", bati: "#b39b74", route: "#6f5636",
      frontiere: "#7c5c3c", noms: "#4a3620",
    },
    teinte: "sombre",
    noms: "#4a3620", halo: "#d8c49a",
  },
  pirate: {
    label: "Carte de pirate",
    zones: {
      fond: "#e7d7b1", eau: "#7fa3a3", riviere: "#6f9393", foret: "#9aa878",
      reserve: "#a8a878", prairie: "#d8c894", bati: "#c0a578", route: "#7a5c3a",
      frontiere: "#8b3a2e", noms: "#5a3a22",
    },
    teinte: "pirate",
    noms: "#5a3a22", halo: "#e7d7b1",
  },
};

// Couleurs suggérées par défaut dans les sélecteurs de zones (non appliquées
// tant que l'utilisateur n'y touche pas).
const SUGGESTIONS_ZONE = {
  eau: "#3a7ca5",
  riviere: "#5f93b8",
  foret: "#3f7d52",
  reserve: "#8fbf8f",
  prairie: "#cfe3b5",
  glacier: "#eef6f9",
  bati: "#d9c9b0",
  route: "#9c8262",
  frontiere: "#b56576",
  noms: "#4a4a4a",
  fond: "#f3eee2",
};

// Polices proposées pour les noms des souvenirs.
const POLICES = {
  systeme: { label: "Système", css: '"Avenir Next", system-ui, sans-serif' },
  serif:   { label: "Serif",   css: 'Georgia, "Times New Roman", serif' },
  etroite: { label: "Étroite", css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
  titre:   { label: "Titre",   css: '"Bricolage Grotesque", "Avenir Next", sans-serif' },
  // Polices médiévales (chargées depuis Google Fonts dans index.html).
  medievale: { label: "Médiévale", css: '"UnifrakturMaguntia", "Luminari", fantasy' },
  pirate:    { label: "Pirate",    css: '"Pirata One", "Luminari", fantasy' },
};

/* ---------- Grand catalogue de polices (fenêtre « Choisir une police ») ----------
   Les polices Google sont téléchargées à la demande (à l'ouverture de la
   fenêtre de choix), pas au démarrage de l'application. */
const CATALOGUE_POLICES = [
  // Toujours disponibles (installées sur l'appareil).
  { cle: "systeme",  label: "Système",  css: POLICES.systeme.css },
  { cle: "serif",    label: "Serif",    css: POLICES.serif.css },
  { cle: "etroite",  label: "Étroite",  css: POLICES.etroite.css },
  { cle: "titre",    label: "Titre",    css: POLICES.titre.css },
  // Médiéval & fantastique.
  { cle: "medievale", label: "Unifraktur (gothique)", famille: "UnifrakturMaguntia", css: '"UnifrakturMaguntia", fantasy' },
  { cle: "pirate",    label: "Pirata One (pirate)",   famille: "Pirata One",         css: '"Pirata One", fantasy' },
  { cle: "g:medievalsharp", label: "MedievalSharp",   famille: "MedievalSharp",      css: '"MedievalSharp", fantasy' },
  { cle: "g:uncial",   label: "Uncial Antiqua",       famille: "Uncial Antiqua",     css: '"Uncial Antiqua", fantasy' },
  { cle: "g:almendra", label: "Almendra",             famille: "Almendra",           css: '"Almendra", serif' },
  { cle: "g:grenze",   label: "Grenze Gotisch",       famille: "Grenze Gotisch",     css: '"Grenze Gotisch", fantasy' },
  { cle: "g:metamorphous", label: "Metamorphous",     famille: "Metamorphous",       css: '"Metamorphous", serif' },
  { cle: "g:imfell",   label: "IM Fell English",      famille: "IM Fell English",    css: '"IM Fell English", serif' },
  { cle: "g:cinzel",   label: "Cinzel",               famille: "Cinzel",             css: '"Cinzel", serif' },
  { cle: "g:cinzeldeco", label: "Cinzel Decorative",  famille: "Cinzel Decorative",  css: '"Cinzel Decorative", serif' },
  // Manuscrites.
  { cle: "g:caveat",   label: "Caveat (manuscrite)",  famille: "Caveat",             css: '"Caveat", cursive' },
  { cle: "g:dancing",  label: "Dancing Script",       famille: "Dancing Script",     css: '"Dancing Script", cursive' },
  { cle: "g:satisfy",  label: "Satisfy",              famille: "Satisfy",            css: '"Satisfy", cursive' },
  { cle: "g:kalam",    label: "Kalam",                famille: "Kalam",              css: '"Kalam", cursive' },
  { cle: "g:patrick",  label: "Patrick Hand",         famille: "Patrick Hand",       css: '"Patrick Hand", cursive' },
  { cle: "g:homemade", label: "Homemade Apple",       famille: "Homemade Apple",     css: '"Homemade Apple", cursive' },
  { cle: "g:amatic",   label: "Amatic SC",            famille: "Amatic SC",          css: '"Amatic SC", cursive' },
  { cle: "g:berkshire", label: "Berkshire Swash",     famille: "Berkshire Swash",    css: '"Berkshire Swash", cursive' },
  // Classiques élégantes.
  { cle: "g:playfair", label: "Playfair Display",     famille: "Playfair Display",   css: '"Playfair Display", serif' },
  { cle: "g:garamond", label: "EB Garamond",          famille: "EB Garamond",        css: '"EB Garamond", serif' },
  { cle: "g:lora",     label: "Lora",                 famille: "Lora",               css: '"Lora", serif' },
  { cle: "g:merri",    label: "Merriweather",         famille: "Merriweather",       css: '"Merriweather", serif' },
  { cle: "g:quicksand", label: "Quicksand",           famille: "Quicksand",          css: '"Quicksand", sans-serif' },
  { cle: "g:nunito",   label: "Nunito",               famille: "Nunito",             css: '"Nunito", sans-serif' },
];

// La fenêtre d'impression lit le catalogue via window.opener (comme etat).
window.CATALOGUE_POLICES = CATALOGUE_POLICES;

// Familles Google déjà demandées au navigateur (pour ne pas les recharger).
const famillesChargees = new Set();

/** Charge une police Google (une balise <link> par famille, à la demande). */
function chargerPoliceGoogle(famille) {
  if (!famille || famillesChargees.has(famille)) return;
  famillesChargees.add(famille);
  const lien = document.createElement("link");
  lien.rel = "stylesheet";
  lien.crossOrigin = "anonymous"; // permet d'incorporer la police à l'export PNG
  lien.href = "https://fonts.googleapis.com/css2?family=" +
    encodeURIComponent(famille).replace(/%20/g, "+") + "&display=swap";
  document.head.appendChild(lien);
}

/**
 * Traduit une clé de police enregistrée en famille CSS utilisable :
 * clé du catalogue, "fontperso:<id>" (police importée), ou repli système.
 */
function cssDePolice(cle) {
  if (typeof cle === "string" && cle.startsWith("fontperso:")) {
    const id = Number(cle.slice("fontperso:".length));
    const p = etat.policesPerso.find((x) => x.id === id);
    return p ? `"PolicePerso${id}", sans-serif` : POLICES.systeme.css;
  }
  const entree = CATALOGUE_POLICES.find((p) => p.cle === cle);
  if (entree) {
    if (entree.famille) chargerPoliceGoogle(entree.famille);
    return entree.css;
  }
  return (POLICES[cle] || POLICES.systeme).css;
}

/** Nom lisible d'une clé de police (pour les boutons « Police : … »). */
function labelDePolice(cle) {
  if (typeof cle === "string" && cle.startsWith("fontperso:")) {
    const p = etat.policesPerso.find((x) => x.id === Number(cle.slice("fontperso:".length)));
    return p ? p.nom : "Police importée";
  }
  const entree = CATALOGUE_POLICES.find((p) => p.cle === cle);
  return entree ? entree.label : "Système";
}

/** Déclare une police importée auprès du navigateur (API FontFace). */
function enregistrerPolicePerso(p) {
  try {
    const face = new FontFace("PolicePerso" + p.id, `url(${p.data})`);
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch (e) { /* format non géré : la police restera en repli système */ }
}

/**
 * Charge au démarrage les ressources PARTAGÉES entre carnets :
 * polices importées et décors importés (stockés à part dans IndexedDB).
 */
async function chargerRessourcesGlobales() {
  try {
    const polices = await dbChargerCle("polices");
    if (Array.isArray(polices)) {
      etat.policesPerso = polices.filter((p) => p && p.data);
      etat.policesPerso.forEach(enregistrerPolicePerso);
    }
  } catch (e) { /* pas de polices importées */ }
  try {
    const decors = await dbChargerCle("decors");
    if (Array.isArray(decors)) etat.decorsPerso = decors.filter((d) => d && d.src);
  } catch (e) { /* pas de décors importés */ }
}

// La fenêtre de choix de police sert plusieurs cibles :
// "labels" (noms des souvenirs), "annot" (texte libre sélectionné),
// "titre" (cartouche de titre), "affiche" (texte de l'affiche PDF).
let ciblePolicePicker = null;

/** Clé de police actuellement utilisée par une cible. */
function cleActuellePolice(cible) {
  if (cible === "labels") return etat.style.labels.police;
  if (cible === "titre") return etat.style.titrePolice || "titre";
  if (cible === "affiche") return reglagesAffiche.police;
  if (cible === "annot" && etat.annotationActive) return etat.annotationActive.police;
  return "systeme";
}

/** Met à jour un bouton « Police : … » (nom + aperçu dans la police). */
function majBoutonPolice(cible) {
  const btn = document.getElementById("police-btn-" + cible);
  if (!btn) return;
  const cle = cleActuellePolice(cible);
  btn.textContent = labelDePolice(cle);
  btn.style.fontFamily = cssDePolice(cle);
}

/** Ouvre la fenêtre de choix de police pour la cible donnée. */
function ouvrirPolicePicker(cible) {
  ciblePolicePicker = cible;
  construireListePolices();
  document.getElementById("modal-police").hidden = false;
}

function fermerPolicePicker() {
  document.getElementById("modal-police").hidden = true;
}

/** (Re)construit la liste des polices (catalogue + importées). */
function construireListePolices() {
  const liste = document.getElementById("police-liste");
  liste.innerHTML = "";
  const actuelle = cleActuellePolice(ciblePolicePicker);

  const ajouterLigne = (cle, label, css, suppression) => {
    const ligne = document.createElement("div");
    ligne.className = "police-ligne";
    const b = document.createElement("button");
    b.className = "police-choix" + (cle === actuelle ? " actif" : "");
    b.style.fontFamily = css;
    b.textContent = label;
    b.addEventListener("click", () => choisirPolice(cle));
    ligne.appendChild(b);
    if (suppression) {
      const suppr = document.createElement("button");
      suppr.className = "icone-btn";
      suppr.title = "Retirer cette police";
      suppr.textContent = "✕";
      suppr.addEventListener("click", suppression);
      ligne.appendChild(suppr);
    }
    liste.appendChild(ligne);
  };

  CATALOGUE_POLICES.forEach((p) => {
    if (p.famille) chargerPoliceGoogle(p.famille); // l'aperçu se charge à l'ouverture
    ajouterLigne(p.cle, p.label, p.css);
  });
  etat.policesPerso.forEach((p) => {
    ajouterLigne("fontperso:" + p.id, p.nom + " (importée)", `"PolicePerso${p.id}", sans-serif`,
      () => supprimerPolicePerso(p.id));
  });
}

/** Applique la police choisie à la cible en cours. */
function choisirPolice(cle) {
  if (ciblePolicePicker === "labels") {
    etat.style.labels.police = cle;
    appliquerStyleLabels();
    planifierSauvegarde();
  } else if (ciblePolicePicker === "titre") {
    etat.style.titrePolice = cle;
    appliquerTitre();
    planifierSauvegarde();
  } else if (ciblePolicePicker === "affiche") {
    reglagesAffiche.police = cle;
  } else if (ciblePolicePicker === "annot") {
    majAnnotationActive({ police: cle });
  }
  majBoutonPolice(ciblePolicePicker);
  fermerPolicePicker();
}

/** Importe un fichier de police (.ttf, .otf, .woff, .woff2). */
function importerPolicePerso(fichier) {
  if (!fichier) return;
  const lecteur = new FileReader();
  lecteur.onerror = () => toast("Lecture du fichier impossible.", true);
  lecteur.onload = async () => {
    const p = {
      id: prochainIdRessource(),
      nom: (fichier.name || "Police").replace(/\.[^.]+$/, "").slice(0, 40),
      data: lecteur.result,
    };
    etat.policesPerso.push(p);
    enregistrerPolicePerso(p);
    try { await dbSauverCle("polices", etat.policesPerso.map((x) => ({ ...x }))); } catch (e) {}
    construireListePolices();
    toast(`Police « ${p.nom} » importée`);
  };
  lecteur.readAsDataURL(fichier);
}

/** Retire une police importée (les textes qui l'utilisaient reviennent au système). */
async function supprimerPolicePerso(id) {
  const p = etat.policesPerso.find((x) => x.id === id);
  if (!p) return;
  const ok = await demanderConfirmation(
    "Retirer cette police ?",
    `Les textes qui utilisent « ${p.nom} » reviendront à la police système.`,
    { okLibelle: "Retirer" }
  );
  if (!ok) return;
  etat.policesPerso = etat.policesPerso.filter((x) => x.id !== id);
  try { await dbSauverCle("polices", etat.policesPerso.map((x) => ({ ...x }))); } catch (e) {}
  construireListePolices();
}

/** Identifiant unique pour les ressources partagées (polices, décors). */
function prochainIdRessource() {
  const tous = [...etat.policesPerso, ...etat.decorsPerso];
  return tous.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

// Tailles proposées pour les noms des souvenirs.
const TAILLES = { petit: "11px", moyen: "13px", grand: "16px" };

// Fonds personnalisés "prêts à l'emploi" (boutons d'exemple).
const FONDS_EXEMPLES = {
  satellite: {
    libelle: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "© Esri, Maxar, Earthstar Geographics",
  },
  cyclable: {
    libelle: "Cyclable",
    url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
    subdomains: "abc",
    maxZoom: 18,
    attribution: "CyclOSM · © OpenStreetMap",
  },
  osmfr: {
    libelle: "OSM France",
    url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    subdomains: "abc",
    maxZoom: 20,
    attribution: "© OpenStreetMap France",
  },
};

// Couleurs proposées dans le nuancier du tracé (palette naturelle).
const NUANCIER = [
  "#c8893d", "#d35438", "#3f7d52", "#3a7ca5",
  "#0f4c4c", "#2f3b34", "#7d3f5a", "#b9842b",
];

// Correspondance "type de ligne" → pointillés Leaflet (dashArray).
const TYPES_LIGNE = {
  plein: null,
  pointilles: "2 8",
  tirets: "10 9",
};

// Pictogrammes posables sur une épingle de souvenir.
// "souvenir" (par défaut) = la pastille numérotée ; les autres = un symbole.
const PICTOS = [
  { cle: "souvenir", glyph: "", label: "Pastille" },
  { cle: "depart",   glyph: "🚩", label: "Départ" },
  { cle: "arrivee",  glyph: "🏁", label: "Arrivée" },
  { cle: "montagne", glyph: "⛰️", label: "Montagne" },
  { cle: "foret",    glyph: "🌲", label: "Forêt" },
  { cle: "lac",      glyph: "🏞️", label: "Lac" },
  { cle: "mer",      glyph: "🌊", label: "Mer" },
  { cle: "pont",     glyph: "🌉", label: "Pont" },
  { cle: "tunnel",   glyph: "🚇", label: "Tunnel" },
  { cle: "ferry",    glyph: "⛴️", label: "Ferry" },
  { cle: "avion",    glyph: "✈️", label: "Avion" },
  { cle: "village",  glyph: "🏘️", label: "Village" },
  { cle: "ville",    glyph: "🏙️", label: "Ville" },
  // Symboles médiévaux (pour décorer le fond de carte façon carte ancienne).
  { cle: "chateau",  glyph: "🏰", label: "Château" },
  { cle: "epees",    glyph: "⚔️", label: "Épées croisées" },
  { cle: "dragon",   glyph: "🐉", label: "Dragon" },
  { cle: "couronne", glyph: "👑", label: "Couronne" },
  { cle: "bouclier", glyph: "🛡️", label: "Bouclier" },
  { cle: "arc",      glyph: "🏹", label: "Arc" },
  { cle: "ancre",    glyph: "⚓", label: "Ancre" },
  { cle: "voilier",  glyph: "⛵", label: "Voilier" },
  { cle: "boussole", glyph: "🧭", label: "Boussole" },
  { cle: "crane",    glyph: "☠️", label: "Tête de mort" },
  { cle: "parchemin",glyph: "📜", label: "Parchemin" },
  { cle: "cheval",   glyph: "🐎", label: "Cheval" },
];
const PICTO_GLYPH = Object.fromEntries(PICTOS.map((p) => [p.cle, p.glyph]));

/**
 * Renvoie le symbole à afficher pour une clé de pictogramme :
 * - "emoji:🦄" → l'émoji librement choisi par l'utilisateur ;
 * - une clé prédéfinie ("montagne"…) → son émoji (anciens carnets compris) ;
 * - sinon rien (pastille numérotée ou image importée).
 */
function glyphDePicto(cle) {
  if (typeof cle === "string" && cle.startsWith("emoji:")) return cle.slice("emoji:".length);
  return PICTO_GLYPH[cle] || "";
}

/**
 * Garde le premier "caractère visuel" d'un texte saisi (un émoji peut être
 * composé de plusieurs caractères techniques : drapeaux, familles…).
 */
function premierEmoji(texte) {
  const t = (texte || "").trim();
  if (!t) return "";
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("fr", { granularity: "grapheme" });
    for (const s of seg.segment(t)) return s.segment;
  }
  return t.slice(0, 8); // repli grossier si le navigateur ne sait pas découper
}

// Taille maximale (en pixels) d'un pictogramme personnalisé importé (petite
// image, jamais affichée bien grande) ; export en PNG pour garder la transparence.
const PICTO_TAILLE_MAX = 128;

/* ---------- Annotations : pictogrammes et textes libres sur la carte ---------- */

// Valeurs par défaut d'un nouvel élément posé sur le fond de carte.
const ANNOT_PICTO_DEFAUT = { picto: "montagne", taille: 36 };
const ANNOT_TEXTE_DEFAUT = {
  texte: "Nouveau texte", police: "serif", couleur: "#2f3b34",
  taille: 18, align: "centre", gras: false, italique: false,
  souligne: false, barre: false,
};
// Photo posée sur la carte : taille = largeur en pixels.
const ANNOT_IMAGE_DEFAUT = { src: "", legende: "", taille: 170 };

// Alignement (mot français enregistré) → valeur CSS correspondante.
const ANNOT_ALIGN_CSS = { gauche: "left", centre: "center", droite: "right" };

// Grand catalogue de pictogrammes, classés par thème (fenêtre de choix).
const PICTO_CATALOGUE = [
  { titre: "Nature", emojis: ["⛰️","🏔️","🌋","🌲","🌳","🌴","🌵","🌊","🏞️","🏜️","🏝️","❄️","🌙","☀️","⭐","🌈","🍄","🌸"] },
  { titre: "Animaux", emojis: ["🐺","🦅","🦌","🐻","🐟","🐬","🐴","🐐","🦉","🐍","🐮","🦋"] },
  { titre: "Lieux", emojis: ["🏰","🏯","⛪","🕌","🗼","🏛️","🏘️","🏙️","⛺","🛖","🗿","💒","🌉","🚇","🏚️","⛲"] },
  { titre: "Transport", emojis: ["🚶","🥾","🚴","🛶","⛵","⛴️","🚂","✈️","🚗","🛳️","🚠","🚩","🏁"] },
  { titre: "Activités", emojis: ["🎣","🏊","🧗","🎿","🏕️","🔥","🍺","🍷","🧀","🥖","🍽️","🎶","📷","🛌","💧","🧭"] },
  { titre: "Médiéval & pirate", emojis: ["⚔️","🗡️","🛡️","🏹","👑","🐉","☠️","🏴‍☠️","⚓","📜","🕯️","🗝️","🪙","🐎"] },
];

// Bornes de la taille selon le type d'élément (texte en px de police,
// pictogramme en px de hauteur).
const ANNOT_TAILLES = {
  texte: { min: 10, max: 48 },
  picto: { min: 16, max: 96 },
  image: { min: 60, max: 440 },
};

/**
 * Renvoie le pictogramme personnalisé correspondant à une clé "perso:<id>",
 * ou null si la clé désigne un pictogramme prédéfini (ou n'existe plus).
 */
function obtenirPictoPerso(cle) {
  if (!cle || !cle.startsWith("perso:")) return null;
  const id = Number(cle.slice("perso:".length));
  return etat.pictosPerso.find((p) => p.id === id) || null;
}

// Fonds de carte disponibles (tous gratuits, sans clé).
const FONDS = {
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 17,
      crossOrigin: "anonymous", // nécessaire pour l'export PNG de la carte
      attribution:
        'Carte : © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · ' +
        'Données : © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  clair: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
      crossOrigin: "anonymous",
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  epure: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
      crossOrigin: "anonymous",
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
};

/* ---------------------------------------------------------
   1. Création de la carte
   --------------------------------------------------------- */
function initCarte() {
  // On crée la carte dans la <div id="map">, centrée par défaut sur la France.
  etat.carte = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  }).setView([46.6, 2.5], 6);

  // On initialise le style (par défaut) et on pose le fond + l'ambiance.
  etat.style = JSON.parse(JSON.stringify(STYLE_DEFAUT));
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);

  // Groupe des épingles de souvenirs : celles qui se chevauchent sont
  // regroupées en une pastille avec un compteur (clic = zoom/éventail).
  // Si le plugin n'a pas pu se charger (hors ligne), on retombe sur un
  // simple groupe de calques, sans regroupement.
  if (typeof L.markerClusterGroup === "function") {
    etat.grappe = L.markerClusterGroup({
      maxClusterRadius: 44,          // on ne regroupe que ce qui se chevauche
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,       // au zoom max, le clic ouvre en éventail
      iconCreateFunction: creerIconeGrappe,
    });
    // Quand des grappes se forment/défont, on rafraîchit les étiquettes de noms.
    etat.grappe.on("animationend spiderfied unspiderfied", majVisibiliteLabels);
    etat.carte.on("zoomend", majVisibiliteLabels);
  } else {
    etat.grappe = L.layerGroup();
  }
  etat.grappe.addTo(etat.carte);

  // Clic sur la carte : selon le mode en cours, on pose un élément de
  // décoration (pictogramme/texte) ou un souvenir.
  etat.carte.on("click", (e) => {
    // Pose d'un pictogramme ou d'un texte sur le fond de carte.
    if (etat.modeAnnotation) {
      creerAnnotation(etat.modeAnnotation, e.latlng);
      return;
    }
    // Pose d'un souvenir. Le mode reste actif après : on peut en poser
    // plusieurs à la suite.
    if (!etat.modeAjout) return;
    masquerAideAjout(); // l'utilisateur a compris, plus besoin de la bannière
    demanderNomSouvenir(e.latlng);
  });
}

/* ---------------------------------------------------------
   2. Affichage d'une trace sur la carte
   --------------------------------------------------------- */
function afficherTrace(trace) {
  etat.trace = trace;

  // On efface une éventuelle trace précédente.
  if (etat.coucheTrace) {
    etat.coucheTrace.remove();
  }

  // On regroupe tout ce qui concerne la trace dans un même calque,
  // ce qui simplifiera les évolutions futures (restyle, suppression...).
  etat.coucheTrace = L.layerGroup().addTo(etat.carte);

  // Style du tracé issu des réglages courants (couleur, épaisseur, type).
  const t = (etat.style && etat.style.trace) || STYLE_DEFAUT.trace;
  const styleTrace = {
    color: t.couleur,
    weight: t.epaisseur,
    opacity: 0.9,
    dashArray: TYPES_LIGNE[t.type],
  };

  // Une polyline (ligne brisée) par segment de la trace.
  trace.segments.forEach((segment) => {
    L.polyline(segment, styleTrace).addTo(etat.coucheTrace);
  });

  // Les waypoints du GPX, affichés comme petits repères (informatifs).
  trace.waypoints.forEach((w) => {
    L.circleMarker([w.lat, w.lng], {
      radius: 5,
      color: "#2f5e3e",
      fillColor: "#3f7d52",
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(w.name || "Point", { direction: "top" })
      .addTo(etat.coucheTrace);
  });

  // Recadrage automatique : on ajuste le zoom pour voir toute la trace.
  const tousLesPoints = [];
  trace.segments.forEach((seg) => seg.forEach((p) => tousLesPoints.push(p)));
  trace.waypoints.forEach((w) => tousLesPoints.push([w.lat, w.lng]));

  if (tousLesPoints.length > 0) {
    const bornes = L.latLngBounds(tousLesPoints);
    etat.carte.fitBounds(bornes, { padding: [40, 40] });
    // Le zoom qui cadre la trace sert de référence : les épingles sont à
    // taille pleine à ce zoom, et rétrécissent quand on dézoome.
    etat.zoomRefTrace = etat.carte.getBoundsZoom(bornes, false, L.point(40, 40));
  }

  // Mise à jour du bandeau d'infos (nom + statistiques).
  majBandeauInfos(trace);

  // On masque l'écran d'accueil maintenant qu'une trace est chargée.
  document.getElementById("welcome").hidden = true;

  // On rend disponibles l'ajout de souvenirs, le style, l'export et la réinit.
  document.getElementById("btn-mode").hidden = false;
  document.getElementById("btn-ajout-souvenir").hidden = false;
  document.getElementById("btn-reserve").hidden = false;
  document.getElementById("btn-trier-dates").hidden = false;
  document.getElementById("btn-filtrer").hidden = false;
  document.getElementById("btn-style").hidden = false;
  document.getElementById("btn-fond").hidden = false;
  document.getElementById("btn-exporter").hidden = false;
  document.getElementById("btn-export-affiche").hidden = false;
  document.getElementById("btn-export-png").hidden = false;
  document.getElementById("btn-reinitialiser").hidden = false;
  document.getElementById("fab-ajout").hidden = false;
  document.getElementById("fab-recentrer").hidden = false;
}

/** Met à jour le petit bandeau en bas à gauche. */
function majBandeauInfos(trace) {
  const bandeau = document.getElementById("trace-info");
  const nbPoints = trace.segments.reduce((n, s) => n + s.length, 0);
  const km = longueurKm(trace.segments);

  // On affiche le nom du CARNET (pas celui du fichier GPX).
  const carnet = carnetActif();
  document.getElementById("trace-name").textContent = (carnet && carnet.nom) || trace.name;
  document.getElementById("trace-stats").textContent =
    `${km.toFixed(1)} km · ${nbPoints} points` +
    (trace.waypoints.length ? ` · ${trace.waypoints.length} repères` : "");

  bandeau.hidden = false;
}

/* ---------------------------------------------------------
   3. Chargement des fichiers GPX (un carnet peut en avoir plusieurs)
   --------------------------------------------------------- */

/**
 * Reconstruit la trace AFFICHÉE (etat.trace) en réunissant tous les GPX du
 * carnet. Renvoie null si le carnet n'a plus aucun GPX.
 */
function fusionnerTraces() {
  if (etat.gpxListe.length === 0) {
    etat.trace = null;
    return null;
  }
  const segments = [];
  const waypoints = [];
  etat.gpxListe.forEach((g) => {
    (g.segments || []).forEach((s) => segments.push(s));
    (g.waypoints || []).forEach((w) => waypoints.push(w));
  });
  etat.trace = { name: etat.gpxListe[0].nom || "Trace", segments, waypoints };
  return etat.trace;
}

/** Ajoute un fichier GPX au carnet (en plus des éventuels GPX déjà là). */
function chargerFichierGpx(fichier) {
  if (!fichier) return;

  const nomOk = /\.gpx$/i.test(fichier.name);
  if (!nomOk) {
    toast("Merci de choisir un fichier .gpx", true);
    return;
  }

  const lecteur = new FileReader();

  lecteur.onload = () => {
    try {
      const trace = parseGpx(lecteur.result);
      etat.gpxListe.push({
        id: prochainIdSouvenir++,
        nom: (fichier.name || trace.name || "Trace").replace(/\.gpx$/i, "").slice(0, 60),
        segments: trace.segments,
        waypoints: trace.waypoints,
      });
      afficherTrace(fusionnerTraces());
      if (typeof renderGpxListe === "function") renderGpxListe();
      toast(`Trace « ${trace.name} » ajoutée au carnet`);
      planifierSauvegarde();
    } catch (e) {
      toast(e.message || "Impossible de lire ce fichier GPX.", true);
    }
  };

  lecteur.onerror = () => toast("Erreur de lecture du fichier.", true);
  lecteur.readAsText(fichier);
}

/* =========================================================
   ÉTAPE 2 — Les points souvenirs
   ========================================================= */

// Formes d'épingles proposées (onglet Fond de carte → Épingles des souvenirs).
const EPINGLE_FORMES = ["goutte", "rond", "carre", "minimal"];

/**
 * Fabrique le HTML et les dimensions d'une épingle de souvenir, selon le
 * style du carnet (forme, couleur, taille, numéro). Utilisée par la carte,
 * les carnets affichés sur l'accueil ET la fenêtre d'impression.
 */
function fabriquerEpingle(numero, pictoCle, pictosPerso, styleEpingles) {
  const ep = {
    ...STYLE_DEFAUT.epingles,
    ...(styleEpingles || (etat.style && etat.style.epingles) || {}),
  };
  const forme = EPINGLE_FORMES.includes(ep.forme) ? ep.forme : "goutte";
  const couleur = typeof ep.couleur === "string" ? ep.couleur : "#d35438";
  const t = Math.max(20, Math.min(72, Number(ep.taille) || 34)); // largeur en px

  // Par défaut on cherche dans les pictos du carnet ouvert ; un carnet
  // affiché "en plus" (accueil) fournit sa propre bibliothèque.
  const perso = pictosPerso
    ? (pictoCle && pictoCle.startsWith("perso:")
        ? pictosPerso.find((p) => p.id === Number(pictoCle.slice("perso:".length))) || null
        : null)
    : obtenirPictoPerso(pictoCle);
  const glyph = perso ? "" : glyphDePicto(pictoCle); // vide pour la pastille par défaut

  // La forme de fond, ses dimensions, son point d'ancrage sur la carte, et
  // le centre de la pastille claire (où se place le contenu).
  let w, h, ancre, fond, cx, cy, rInterieur;
  if (forme === "goutte") {
    w = t;
    h = Math.round((t * 44) / 34);
    ancre = [w / 2, h - 1]; // la pointe touche le point GPS
    fond = `<svg class="pin-souvenir" width="${w}" height="${h}" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1 C8 1 1 8 1 17 C1 29 17 43 17 43 C17 43 33 29 33 17 C33 8 26 1 17 1 Z"
            fill="${couleur}" stroke="#ffffff" stroke-width="2"/>
      <circle cx="17" cy="16" r="8.5" fill="#ffffff"/>
    </svg>`;
    cx = w / 2;
    cy = (16 / 44) * h;
    rInterieur = (8.5 / 34) * w;
  } else if (forme === "rond" || forme === "carre") {
    w = t;
    h = t;
    ancre = [w / 2, h / 2]; // centré sur le point GPS
    const dessin = forme === "rond"
      ? `<circle cx="17" cy="17" r="16" fill="${couleur}" stroke="#ffffff" stroke-width="2"/>`
      : `<rect x="1" y="1" width="32" height="32" rx="8" fill="${couleur}" stroke="#ffffff" stroke-width="2"/>`;
    fond = `<svg class="pin-souvenir" width="${w}" height="${h}" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
      ${dessin}<circle cx="17" cy="17" r="11" fill="#ffffff"/>
    </svg>`;
    cx = w / 2;
    cy = h / 2;
    rInterieur = (11 / 34) * w;
  } else {
    // "minimal" : une pastille claire cerclée de la couleur, discrète.
    w = Math.max(18, Math.round(t * 0.8));
    h = w;
    ancre = [w / 2, h / 2];
    fond = `<svg class="pin-souvenir" width="${w}" height="${h}" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
      <circle cx="17" cy="17" r="15" fill="rgba(255,255,255,0.92)" stroke="${couleur}" stroke-width="3"/>
    </svg>`;
    cx = w / 2;
    cy = h / 2;
    rInterieur = (15 / 34) * w;
  }

  // Contenu centré dans la pastille : image importée, émoji, ou numéro.
  const centre = `position:absolute;left:${cx}px;top:${cy}px;transform:translate(-50%,-50%);pointer-events:none;`;
  let contenu = "";
  if (perso) {
    const d = Math.round(rInterieur * 2.1);
    contenu = `<img src="${perso.src}" alt="" style="${centre}width:${d}px;height:${d}px;border-radius:50%;object-fit:cover;">`;
  } else if (glyph) {
    contenu = `<span style="${centre}font-size:${Math.round(rInterieur * 1.5)}px;line-height:1;">${glyph}</span>`;
  } else if (ep.numero !== false) {
    contenu = `<span style="${centre}font:700 ${Math.max(9, Math.round(rInterieur * 1.15))}px Arial,sans-serif;color:${couleur};">${numero}</span>`;
  }
  // Badge numéro en coin quand un pictogramme occupe déjà la pastille.
  if ((perso || glyph) && ep.numero !== false) {
    contenu += `<span class="pin-num">${numero}</span>`;
  }

  return {
    // data-ancre : sert au zoom (l'épingle rétrécit vers sa pointe ou son centre).
    html: `<div class="pin-wrap" data-ancre="${forme === "goutte" ? "pointe" : "centre"}" style="width:${w}px;height:${h}px">${fond}${contenu}</div>`,
    iconSize: [w, h],
    iconAnchor: ancre,
    popupAnchor: [0, -h + 4],
  };
}
// La fenêtre d'impression fabrique les mêmes épingles via window.opener.
window.fabriquerEpingle = fabriquerEpingle;

/**
 * Crée l'icône Leaflet "épingle souvenir", portant son numéro d'ordre dans
 * le carnet, au style d'épingles du carnet (ou de celui fourni).
 * @param {number} numero  Le rang du souvenir (1, 2, 3...).
 */
function creerIconeSouvenir(numero, pictoCle, pictosPerso, styleEpingles) {
  const ep = fabriquerEpingle(numero, pictoCle, pictosPerso, styleEpingles);
  return L.divIcon({
    className: "",
    html: ep.html,
    iconSize: ep.iconSize,
    iconAnchor: ep.iconAnchor,
    popupAnchor: ep.popupAnchor,
  });
}

/**
 * Icône d'une grappe : même forme d'épingle que les souvenirs, avec le
 * nombre de souvenirs regroupés à la place du numéro.
 */
/** Assombrit une couleur hex (#rrggbb) — pour les grappes d'épingles. */
function assombrirCouleur(hex, facteur = 0.78) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#b23c28";
  const n = parseInt(m[1], 16);
  const c = (v) => Math.round(v * facteur);
  return "#" + [c(n >> 16), c((n >> 8) & 255), c(n & 255)]
    .map((v) => v.toString(16).padStart(2, "0")).join("");
}

function creerIconeGrappe(grappe) {
  const n = grappe.getChildCount();
  // La grappe reprend la couleur des épingles du carnet, en plus foncé.
  const ep = (etat.style && etat.style.epingles) || STYLE_DEFAUT.epingles;
  const couleur = assombrirCouleur(ep.couleur);
  const pin = `
    <svg class="pin-souvenir" width="38" height="48" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1 C8 1 1 8 1 17 C1 29 17 43 17 43 C17 43 33 29 33 17 C33 8 26 1 17 1 Z"
            fill="${couleur}" stroke="#ffffff" stroke-width="2"/>
      <circle cx="17" cy="16" r="9.5" fill="#ffffff"/>
    </svg>`;
  return L.divIcon({
    className: "",
    html: `<div class="pin-wrap grappe-wrap">${pin}<span class="grappe-nombre" style="color:${couleur}">${n}</span></div>`,
    iconSize: [38, 48],
    iconAnchor: [19, 47],
  });
}

/** Applique le style des épingles : redessine toutes les épingles et grappes. */
function appliquerStyleEpingles() {
  renumeroterSouvenirs();
  if (etat.grappe && typeof etat.grappe.refreshClusters === "function") {
    etat.grappe.refreshClusters();
  }
  // La mini-carte de la fiche ouverte suit aussi.
  if (etat.souvenirActif && etat.miniCarte) majMiniCarte(etat.souvenirActif);
  if (typeof majEchellesZoom === "function") majEchellesZoom();
}

/**
 * Affiche ou masque l'étiquette de nom de chaque souvenir selon que son
 * épingle est visible telle quelle ou fondue dans une grappe.
 */
function majVisibiliteLabels() {
  etat.souvenirs.forEach((s) => {
    if (!s.label || !s.marker) return;
    // getVisibleParent : l'épingle elle-même si elle est visible, sinon sa grappe.
    const visible = !etat.grappe.getVisibleParent ||
      etat.grappe.getVisibleParent(s.marker) === s.marker;
    s.label.setOpacity(visible ? 1 : 0);
  });
}

/** Rend inoffensif un texte saisi avant de l'insérer dans du HTML. */
function echapperHtml(texte) {
  const div = document.createElement("div");
  div.textContent = texte;
  return div.innerHTML;
}

/** Renvoie l'objet photo de couverture d'un souvenir, ou null. */
function photoCouverture(souvenir) {
  const i = souvenir.couverture;
  if (i === null || i === undefined) return null;
  return souvenir.photos[i] || null;
}

/**
 * Construit le contenu HTML de l'étiquette (tooltip) d'un souvenir :
 * sa photo de couverture (si elle existe) + sa légende, le numéro et le nom.
 */
/**
 * Renvoie la liste à laquelle appartient un souvenir : celle du carnet
 * ouvert, ou celle d'un carnet affiché en plus (visualisation).
 */
function listeDuSouvenir(souvenir) {
  if (etat.souvenirs.includes(souvenir) || etat.stock.includes(souvenir)) return etat.souvenirs;
  for (const f of etat.fantomes.values()) {
    if (f.souvenirs.includes(souvenir)) return f.souvenirs;
  }
  return etat.souvenirs;
}

/** Renvoie la trace du carnet auquel appartient un souvenir. */
function traceDuSouvenir(souvenir) {
  if (etat.souvenirs.includes(souvenir)) return etat.trace;
  for (const f of etat.fantomes.values()) {
    if (f.souvenirs.includes(souvenir)) return f.trace;
  }
  return etat.trace;
}

function libelleTooltip(souvenir) {
  const numero = listeDuSouvenir(souvenir).indexOf(souvenir) + 1;
  const titre = `${numero || "•"}. ${echapperHtml(souvenir.nom || "Souvenir")}`;
  const couv = photoCouverture(souvenir);

  let html = "";
  if (couv) html += `<img class="tt-photo" src="${couv.src}" alt="">`;
  html += `<div class="tt-titre">${titre}</div>`;
  if (couv && couv.legende) {
    html += `<div class="tt-legende">${echapperHtml(couv.legende)}</div>`;
  }
  return html;
}

/** Met à jour l'étiquette d'un souvenir (après changement de nom/photo/légende). */
function majTooltip(souvenir) {
  if (souvenir.marker) {
    souvenir.marker.setTooltipContent(libelleTooltip(souvenir));
  }
}

/**
 * Remet à jour le numéro de chaque épingle selon l'ordre actuel de la liste.
 * À appeler après tout ajout ou suppression de souvenir.
 */
function renumeroterSouvenirs() {
  etat.souvenirs.forEach((s, i) => {
    if (!s.marker) return;
    s.marker.setIcon(creerIconeSouvenir(i + 1, s.pictogramme));
    majTooltip(s); // le numéro a pu changer
  });
}

/** Active le "mode ajout" : chaque clic sur la carte pose un nouveau souvenir. */
function armerAjout() {
  if (etat.mode === "visualisation") return; // pas d'ajout en lecture seule
  etat.modeAjout = true;
  document.getElementById("map").classList.add("mode-ajout");
  majBoutonAjout();
  afficherAideAjoutSiPremiereFois();
}

/** Quitte le "mode ajout". */
function desarmerAjout() {
  etat.modeAjout = false;
  document.getElementById("map").classList.remove("mode-ajout");
  masquerAideAjout();
  majBoutonAjout();
}

/** Active ou désactive le mode ajout (bouton du menu). */
function basculerAjout() {
  if (etat.modeAjout) desarmerAjout();
  else armerAjout();
}

/** Met à jour l'apparence du bouton "Ajouter des souvenirs" selon le mode. */
function majBoutonAjout() {
  const btn = document.getElementById("btn-ajout-souvenir");
  if (!btn) return;
  btn.classList.toggle("actif", etat.modeAjout);
  btn.innerHTML = etat.modeAjout
    ? '<span class="btn-ico">✕</span> Arrêter l’ajout'
    : '<span class="btn-ico">📍</span> Ajouter des souvenirs';
  // Le bouton flottant « ＋ » reflète le même état.
  const fab = document.getElementById("fab-ajout");
  if (fab) {
    fab.classList.toggle("actif", etat.modeAjout);
    fab.textContent = etat.modeAjout ? "✕" : "＋";
    fab.title = etat.modeAjout ? "Arrêter l'ajout" : "Ajouter des souvenirs";
  }
}

// Clé localStorage : la bannière d'aide n'est montrée qu'une seule fois.
const CLE_AIDE_AJOUT_VUE = "carnet-aide-ajout-vue";
let timerAideAjout = null;

/** Affiche la bannière d'aide, seulement la toute première fois. */
function afficherAideAjoutSiPremiereFois() {
  let vue = false;
  try { vue = localStorage.getItem(CLE_AIDE_AJOUT_VUE) === "1"; } catch (e) {}
  if (vue) return;
  document.getElementById("banniere-ajout").hidden = false;
  try { localStorage.setItem(CLE_AIDE_AJOUT_VUE, "1"); } catch (e) {}
  clearTimeout(timerAideAjout);
  timerAideAjout = setTimeout(masquerAideAjout, 5000);
}

/** Masque la bannière d'aide. */
function masquerAideAjout() {
  clearTimeout(timerAideAjout);
  document.getElementById("banniere-ajout").hidden = true;
}

/**
 * Ouvre la petite fenêtre de saisie du nom, en mémorisant l'endroit cliqué.
 * @param {{lat:number, lng:number}} latlng  Coordonnées du clic sur la carte.
 */
let latLngEnAttente = null;
function demanderNomSouvenir(latlng) {
  latLngEnAttente = latlng;
  const modal = document.getElementById("modal-nom");
  const champ = document.getElementById("champ-nom");
  champ.value = "";
  renderStockPourModal(); // propose aussi de piocher dans la réserve
  modal.hidden = false;
  champ.focus();
}

/** Ferme la fenêtre de saisie du nom sans créer de souvenir. */
function fermerModalNom() {
  document.getElementById("modal-nom").hidden = true;
  latLngEnAttente = null;
}

/**
 * Valide la saisie du nom et crée le souvenir à l'endroit mémorisé.
 * @param {boolean} ouvrirFiche  true = ouvre la fiche pour l'éditer,
 *   false = revient directement à la carte (le mode ajout reste actif).
 */
function validerNomSouvenir(ouvrirFiche) {
  const nom = document.getElementById("champ-nom").value.trim();
  if (!nom) {
    toast("Donne un nom à ton souvenir.", true);
    return;
  }
  if (!latLngEnAttente) return;

  ajouterSouvenir(latLngEnAttente.lat, latLngEnAttente.lng, nom, {}, ouvrirFiche);
  document.getElementById("modal-nom").hidden = true;
  latLngEnAttente = null;
}

/**
 * Crée un souvenir : l'enregistre en mémoire et pose son marqueur sur la carte.
 * @param {boolean} ouvrirFiche  true (par défaut) = ouvre la fiche du souvenir créé.
 * @returns le souvenir créé.
 */
function ajouterSouvenir(lat, lng, nom, contenu = {}, ouvrirFiche = true) {
  const souvenir = {
    id: prochainIdSouvenir++,
    nom,
    lat,
    lng,
    // Le contenu peut venir d'un souvenir "en réserve" qu'on pose sur la carte.
    photos: contenu.photos ? contenu.photos.map((p) => ({ ...p })) : [],
    couverture: contenu.couverture !== undefined ? contenu.couverture : null,
    textes: contenu.textes || "",
    pictogramme: contenu.pictogramme || "souvenir",
    dates: Array.isArray(contenu.dates) ? contenu.dates.slice() : [],
    audios: Array.isArray(contenu.audios) ? contenu.audios.map((a) => ({ ...a })) : [],
    marker: null,
    label: null,             // étiquette de nom permanente (si activée)
  };

  etat.souvenirs.push(souvenir);
  attacherMarqueur(souvenir);
  majLabel(souvenir); // crée l'étiquette de nom si l'affichage est activé

  toast(`Souvenir « ${nom} » ajouté`);
  if (ouvrirFiche) ouvrirPanneau(souvenir);
  planifierSauvegarde();
  return souvenir;
}

/**
 * Crée le marqueur Leaflet d'un souvenir déjà présent dans la liste et le
 * pose sur la carte. Séparé d'ajouterSouvenir pour être réutilisé lors de
 * la restauration d'un carnet sauvegardé.
 */
function attacherMarqueur(souvenir) {
  const numero = etat.souvenirs.indexOf(souvenir) + 1;
  const marker = L.marker([souvenir.lat, souvenir.lng], {
    icon: creerIconeSouvenir(numero, souvenir.pictogramme),
    draggable: true, // permet de déplacer le souvenir en le glissant sur la carte
  })
    .bindTooltip(libelleTooltip(souvenir), {
      direction: "top",
      offset: [0, -38],
      className: "tt-souvenir",
    })
    .on("click", () => ouvrirPanneau(souvenir))
    .on("dragend", (e) => deplacerSouvenirVersPoint(souvenir, e.target.getLatLng()));

  // L'épingle passe par le groupe de regroupement (grappes si chevauchement).
  etat.grappe.addLayer(marker);

  if (etat.mode === "visualisation" && marker.dragging) marker.dragging.disable();

  souvenir.marker = marker;
  majVisibiliteLabels();
  return marker;
}

/** Déplace un souvenir à un nouvel endroit (après avoir glissé son épingle). */
function deplacerSouvenirVersPoint(souvenir, latlng) {
  souvenir.lat = latlng.lat;
  souvenir.lng = latlng.lng;
  if (souvenir.label) souvenir.label.setLatLng(latlng);
  // On ressort puis on remet l'épingle dans le groupe : si elle a été posée
  // sur une autre, elles se regroupent aussitôt.
  if (souvenir.marker && etat.grappe.hasLayer(souvenir.marker)) {
    etat.grappe.removeLayer(souvenir.marker);
    etat.grappe.addLayer(souvenir.marker);
    majVisibiliteLabels();
  }
  if (etat.souvenirActif === souvenir) {
    document.getElementById("souvenir-coords").textContent =
      `📍 ${souvenir.lat.toFixed(5)}, ${souvenir.lng.toFixed(5)}`;
    majMiniCarte(souvenir);
  }
  toast("Souvenir déplacé");
  planifierSauvegarde();
}

/* ---------- Pictogramme d'un souvenir ---------- */

/**
 * Crée les boutons du sélecteur de pictogramme.
 * Pour un SOUVENIR : seulement la pastille numérotée + les images importées
 * (la liste d'émojis prédéfinis a été retirée : on tape l'émoji de son choix).
 * Pour un élément du FOND DE CARTE : la liste de symboles reste proposée.
 */
function construirePictos(cible) {
  cible = cible || ciblePictoPicker || "souvenir";
  const c = document.getElementById("souvenir-pictos");
  c.innerHTML = "";

  // Pour un souvenir : la pastille numérotée reste le premier choix.
  if (cible === "souvenir") {
    const b = document.createElement("button");
    b.className = "picto-btn";
    b.dataset.picto = "souvenir";
    b.title = "Pastille numérotée";
    b.textContent = "①";
    b.addEventListener("click", () => choisirPictogramme("souvenir"));
    c.appendChild(b);
  }

  // Le grand catalogue, classé par thème.
  PICTO_CATALOGUE.forEach((groupe) => {
    const titre = document.createElement("div");
    titre.className = "picto-groupe-titre";
    titre.textContent = groupe.titre;
    c.appendChild(titre);
    const grille = document.createElement("div");
    grille.className = "picto-grille-groupe";
    groupe.emojis.forEach((emoji) => {
      const b = document.createElement("button");
      b.className = "picto-btn";
      b.dataset.picto = "emoji:" + emoji;
      b.textContent = emoji;
      b.addEventListener("click", () => choisirPictogramme("emoji:" + emoji));
      grille.appendChild(b);
    });
    c.appendChild(grille);
  });

  // Pictogrammes personnalisés importés par l'utilisateur (avec suppression).
  if (etat.pictosPerso.length > 0) {
    const titre = document.createElement("div");
    titre.className = "picto-groupe-titre";
    titre.textContent = "Importés";
    c.appendChild(titre);
  }
  etat.pictosPerso.forEach((p) => {
    const cle = "perso:" + p.id;
    const b = document.createElement("button");
    b.className = "picto-btn picto-btn-perso";
    b.dataset.picto = cle;
    b.title = p.nom;
    b.innerHTML = `<img src="${p.src}" alt="">`;
    b.addEventListener("click", () => choisirPictogramme(cle));

    const suppr = document.createElement("button");
    suppr.className = "picto-perso-suppr";
    suppr.type = "button";
    suppr.textContent = "✕";
    suppr.title = "Retirer ce pictogramme";
    suppr.addEventListener("click", (e) => {
      e.stopPropagation();
      supprimerPictoPerso(p.id);
    });

    const wrap = document.createElement("div");
    wrap.className = "picto-perso-wrap";
    wrap.appendChild(b);
    wrap.appendChild(suppr);
    c.appendChild(wrap);
  });
}

/** Importe une image et l'ajoute à la bibliothèque de pictogrammes personnalisés. */
async function ajouterPictoPerso(fichier) {
  if (!fichier || !fichier.type.startsWith("image/")) return;
  try {
    const src = await importerImage(fichier, PICTO_TAILLE_MAX, "image/png");
    const nom = (fichier.name || "").replace(/\.[^.]+$/, "").slice(0, 40) || "Pictogramme";
    etat.pictosPerso.push({ id: prochainIdSouvenir++, nom, src });
    construirePictos();
    planifierSauvegarde();
    toast("Pictogramme importé");
  } catch (e) {
    toast(e.message || "Impossible d'importer ce pictogramme.", true);
  }
}

/**
 * Retire un pictogramme personnalisé de la bibliothèque. Les souvenirs qui
 * l'utilisaient reviennent à la pastille numérotée par défaut.
 */
async function supprimerPictoPerso(id) {
  const p = etat.pictosPerso.find((x) => x.id === id);
  if (!p) return;
  const ok = await demanderConfirmation(
    "Retirer ce pictogramme ?",
    `Les souvenirs qui utilisent « ${p.nom} » reprendront la pastille numérotée.`,
    { okLibelle: "Retirer" }
  );
  if (!ok) return;

  const cle = "perso:" + id;
  etat.pictosPerso = etat.pictosPerso.filter((x) => x.id !== id);

  etat.souvenirs.forEach((s) => {
    if (s.pictogramme !== cle) return;
    s.pictogramme = "souvenir";
    if (s.marker) s.marker.setIcon(creerIconeSouvenir(etat.souvenirs.indexOf(s) + 1, "souvenir"));
  });
  etat.stock.forEach((s) => {
    if (s.pictogramme === cle) s.pictogramme = "souvenir";
  });
  if (etat.souvenirActif && etat.souvenirActif.pictogramme === cle) {
    etat.souvenirActif.pictogramme = "souvenir";
    majPictoBoutonActuel("souvenir");
  }

  // Les éléments posés sur le fond de carte reprennent le pictogramme par défaut.
  etat.annotations.forEach((a) => {
    if (a.type !== "picto" || a.picto !== cle) return;
    a.picto = ANNOT_PICTO_DEFAUT.picto;
    redessinerAnnotation(a);
  });
  if (etat.annotationActive && etat.annotationActive.picto === cle) {
    majAnnotPictoBouton(ANNOT_PICTO_DEFAUT.picto);
  }

  construirePictos();
  planifierSauvegarde();
  toast("Pictogramme retiré");
}

/** Met en évidence le pictogramme actif. */
function majPictoActif(cle) {
  document.querySelectorAll("#souvenir-pictos .picto-btn").forEach((b) => {
    b.classList.toggle("actif", b.dataset.picto === (cle || "souvenir"));
  });
}

/** Met à jour le glyphe affiché sur le bouton "Choisir un pictogramme". */
function majPictoBoutonActuel(cle) {
  const el = document.getElementById("picto-actuel-glyph");
  const perso = obtenirPictoPerso(cle);
  if (perso) {
    el.innerHTML = `<img src="${perso.src}" alt="">`;
    return;
  }
  el.textContent = glyphDePicto(cle) || "①";
}

// La fenêtre de choix sert à deux endroits : l'épingle d'un souvenir
// ("souvenir") ou un pictogramme posé sur le fond de carte ("annotation").
let ciblePictoPicker = "souvenir";

/** Applique le pictogramme choisi à la cible en cours (souvenir ou annotation). */
function choisirPictogramme(cle) {
  if (ciblePictoPicker === "annotation") {
    majAnnotationActive({ picto: cle });
    majAnnotPictoBouton(cle);
    fermerPictoPicker();
    return;
  }
  const s = etat.souvenirActif;
  if (!s) return;
  s.pictogramme = cle;
  const numero = etat.souvenirs.indexOf(s) + 1;
  if (s.marker) s.marker.setIcon(creerIconeSouvenir(numero, cle));
  majPictoActif(cle);
  majPictoBoutonActuel(cle);
  fermerPictoPicker();
  planifierSauvegarde();
}

/** Pré-remplit le champ émoji avec le choix actuel (s'il en est un). */
function preremplirChampEmoji(cle) {
  document.getElementById("picto-emoji-input").value =
    (typeof cle === "string" && cle.startsWith("emoji:")) ? cle.slice("emoji:".length) : "";
}

/** Valide l'émoji tapé dans le champ et l'applique à la cible en cours. */
function appliquerEmojiSaisi() {
  const emoji = premierEmoji(document.getElementById("picto-emoji-input").value);
  if (!emoji) {
    toast("Tape d'abord un émoji dans le champ.", true);
    return;
  }
  choisirPictogramme("emoji:" + emoji);
}

/** Ouvre la fenêtre de choix du pictogramme (pour l'épingle du souvenir). */
function ouvrirPictoPicker() {
  if (!etat.souvenirActif) return;
  ciblePictoPicker = "souvenir";
  construirePictos("souvenir");
  majPictoActif(etat.souvenirActif.pictogramme);
  preremplirChampEmoji(etat.souvenirActif.pictogramme);
  document.getElementById("modal-picto").hidden = false;
}

/** Ouvre la même fenêtre pour un pictogramme posé sur le fond de carte. */
function ouvrirPictoPickerAnnotation() {
  if (!etat.annotationActive || etat.annotationActive.type !== "picto") return;
  ciblePictoPicker = "annotation";
  construirePictos("annotation");
  majPictoActif(etat.annotationActive.picto);
  preremplirChampEmoji(etat.annotationActive.picto);
  document.getElementById("modal-picto").hidden = false;
}

/** Ferme la fenêtre de choix du pictogramme. */
function fermerPictoPicker() {
  document.getElementById("modal-picto").hidden = true;
}

/** Ouvre le panneau latéral sur la fiche d'un souvenir (posé ou en réserve). */
function ouvrirPanneau(souvenir) {
  // Si un enregistrement audio est en cours sur une autre fiche, on l'arrête.
  if (etat.souvenirActif !== souvenir) arreterEnregistrementAudio();

  etat.souvenirActif = souvenir;
  const enReserve = etat.stock.includes(souvenir);

  const panneau = document.getElementById("panneau");
  panneau.hidden = false;
  panneau.classList.toggle("fiche-stock", enReserve); // masque les parties "position"

  document.getElementById("souvenir-titre").value = souvenir.nom;
  document.getElementById("souvenir-texte").value = souvenir.textes || "";
  document.getElementById("supprimer-souvenir").textContent =
    enReserve ? "Retirer de la réserve" : "Supprimer ce souvenir";
  majPictoActif(souvenir.pictogramme);
  majPictoBoutonActuel(souvenir.pictogramme);
  afficherGalerie(souvenir);
  afficherDates(souvenir);
  afficherAudios(souvenir);
  majBoutonAudio(false);

  if (enReserve) {
    // Un souvenir en réserve n'a pas de position : pas de coordonnées,
    // pas de navigation entre points, pas de mini-carte, pas de pop up.
    fermerReserve();
    return;
  }

  document.getElementById("souvenir-coords").textContent =
    `📍 ${souvenir.lat.toFixed(5)}, ${souvenir.lng.toFixed(5)}`;
  majNavigation();
  majFondPanneau();
  majMiniCarte(souvenir);
}

/** Met à jour le compteur "n / total" et l'état (actif/grisé) des flèches. */
function majNavigation() {
  const liste = listeDuSouvenir(etat.souvenirActif);
  const total = liste.length;
  const index = liste.indexOf(etat.souvenirActif); // 0 si introuvable
  document.getElementById("souvenir-compteur").textContent =
    `${index + 1} / ${total}`;
  // On grise la flèche "précédent" sur le premier, "suivant" sur le dernier.
  document.getElementById("souvenir-precedent").disabled = index <= 0;
  document.getElementById("souvenir-suivant").disabled = index >= total - 1;
  // "Avancer" = plus loin dans le carnet (grisé sur le dernier).
  // "Reculer" = plus tôt, vers le n°1 (grisé sur le premier).
  document.getElementById("souvenir-avancer").disabled = index >= total - 1;
  document.getElementById("souvenir-reculer").disabled = index <= 0;
}

/**
 * Déplace le souvenir actif dans l'ordre du carnet en l'échangeant avec
 * son voisin. décalage +1 = "Avancer" (plus loin), -1 = "Reculer" (vers le n°1).
 */
function deplacerSouvenir(decalage) {
  const s = etat.souvenirActif;
  if (!s) return;
  const i = etat.souvenirs.indexOf(s);
  const j = i + decalage;
  if (j < 0 || j >= etat.souvenirs.length) return;

  // Échange des deux souvenirs dans la liste.
  etat.souvenirs[i] = etat.souvenirs[j];
  etat.souvenirs[j] = s;

  renumeroterSouvenirs(); // épingles + étiquettes
  majNavigation();        // compteur "n / total" + grisage des boutons
  planifierSauvegarde();
}

/** Ouvre le souvenir voisin (décalage -1 = précédent, +1 = suivant). */
function naviguerSouvenir(decalage) {
  const liste = listeDuSouvenir(etat.souvenirActif);
  let index = liste.indexOf(etat.souvenirActif);
  let cible = null;
  // On saute les souvenirs masqués par le filtre (mode visualisation).
  do {
    index += decalage;
    cible = liste[index];
  } while (cible && cible.masque);
  if (!cible) return;
  ouvrirPanneau(cible);
  // On recentre la carte sur le souvenir visé, sans changer le zoom.
  etat.carte.panTo([cible.lat, cible.lng]);
}

/** Ferme le panneau latéral. */
function fermerPanneau() {
  arreterEnregistrementAudio(); // au cas où un enregistrement tournait encore
  const etaitEnReserve = etat.souvenirActif && etat.stock.includes(etat.souvenirActif);
  document.getElementById("panneau").hidden = true;
  document.getElementById("panneau").classList.remove("fiche-stock");
  etat.souvenirActif = null;
  majFondPanneau();
  // Si on éditait un souvenir en réserve, on revient à la liste de la réserve.
  if (etaitEnReserve) ouvrirReserve();
}

/**
 * Affiche le fond assombri seulement quand la fiche est ouverte en mode
 * visualisation (où elle s'affiche comme une pop up centrée).
 */
function majFondPanneau() {
  const ouvert = !document.getElementById("panneau").hidden;
  document.getElementById("panneau-fond").hidden =
    !(ouvert && etat.mode === "visualisation");
}

/* ---------- Mini-carte de situation (pop up visualisation) ---------- */

/** Crée la petite carte de situation (non interactive) une seule fois. */
function creerMiniCarte() {
  etat.miniCarte = L.map("mini-map", {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    tap: false,
  });
  // Fond clair et léger (indépendant du fond principal).
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { subdomains: "abcd", maxZoom: 20 }
  ).addTo(etat.miniCarte);
  etat.miniCouche = L.layerGroup().addTo(etat.miniCarte);
}

/** Met à jour la mini-carte pour situer le souvenir donné sur le parcours. */
function majMiniCarte(souvenir) {
  const trace = traceDuSouvenir(souvenir); // celle du carnet du souvenir
  if (!trace || !souvenir) return;
  if (!etat.miniCarte) creerMiniCarte();

  etat.miniCouche.clearLayers();

  // Le tracé, en fin pour le contexte.
  trace.segments.forEach((seg) => {
    L.polyline(seg, { color: "#c8893d", weight: 3, opacity: 0.85 })
      .addTo(etat.miniCouche);
  });

  // L'épingle du souvenir (même pictogramme que sur la grande carte).
  const numero = listeDuSouvenir(souvenir).indexOf(souvenir) + 1;
  L.marker([souvenir.lat, souvenir.lng], {
    icon: creerIconeSouvenir(numero, souvenir.pictogramme),
  }).addTo(etat.miniCouche);

  // Tous les points pour cadrer sur l'ensemble du parcours.
  const points = [];
  trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
  points.push([souvenir.lat, souvenir.lng]);

  // La carte vient peut-être d'être affichée : on recalcule sa taille puis on cadre.
  setTimeout(() => {
    etat.miniCarte.invalidateSize();
    if (points.length) {
      // Plus de marge en haut pour que l'épingle (qui pointe vers le bas)
      // ne soit pas coupée par le bord.
      etat.miniCarte.fitBounds(points, {
        paddingTopLeft: [20, 46],
        paddingBottomRight: [20, 20],
      });
    }
  }, 30);
}

/** Renomme le souvenir actif (au fil de la frappe dans le champ titre). */
function renommerSouvenirActif(nouveauNom) {
  const s = etat.souvenirActif;
  if (!s) return;
  s.nom = nouveauNom;
  majTooltip(s); // l'infobulle au survol reflète le nouveau nom
  majLabel(s);   // l'étiquette permanente aussi
  planifierSauvegarde();
}

/** Supprime le souvenir actif, après confirmation. */
async function supprimerSouvenirActif() {
  const s = etat.souvenirActif;
  if (!s) return;

  // Cas d'un souvenir en réserve : on le retire simplement de la réserve.
  if (etat.stock.includes(s)) {
    const okStock = await demanderConfirmation(
      "Retirer de la réserve ?",
      `« ${s.nom || "Sans nom"} » sera retiré de la réserve.`,
      { okLibelle: "Retirer" }
    );
    if (!okStock) return;
    const index = etat.stock.indexOf(s);
    etat.stock = etat.stock.filter((x) => x.id !== s.id);
    document.getElementById("panneau").hidden = true;
    document.getElementById("panneau").classList.remove("fiche-stock");
    etat.souvenirActif = null;
    ouvrirReserve();
    planifierSauvegarde();
    // On peut se raviser pendant quelques secondes.
    toastAvecAction("Retiré de la réserve.", "Annuler", () => {
      etat.stock.splice(Math.min(index, etat.stock.length), 0, s);
      renderReserve();
      planifierSauvegarde();
    });
    return;
  }

  const ok = await demanderConfirmation(
    "Supprimer ce souvenir ?",
    `« ${s.nom || "Sans nom"} », ses photos et ses audios seront supprimés.`,
    { okLibelle: "Supprimer" }
  );
  if (!ok) return;

  const index = etat.souvenirs.indexOf(s);
  if (s.marker) etat.grappe.removeLayer(s.marker);
  retirerLabel(s);
  etat.souvenirs = etat.souvenirs.filter((x) => x.id !== s.id);
  renumeroterSouvenirs(); // les numéros suivants se décalent
  majVisibiliteLabels();
  fermerPanneau();
  planifierSauvegarde();
  // Bouton « Annuler » : le souvenir revient à sa place, intact.
  toastAvecAction("Souvenir supprimé.", "Annuler", () => {
    s.marker = null;
    s.label = null;
    etat.souvenirs.splice(Math.min(index, etat.souvenirs.length), 0, s);
    attacherMarqueur(s);
    majLabel(s);
    renumeroterSouvenirs();
    majVisibiliteLabels();
    planifierSauvegarde();
  });
}

/* =========================================================
   Dates des souvenirs (une ou plusieurs par point)
   ========================================================= */

/** Formate une date ISO (2026-07-14) en français court : 14 juil. 2026. */
function formaterDate(iso) {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

/** La plus ancienne date d'un souvenir, ou "" s'il n'en a pas. */
function premiereDate(souvenir) {
  const dates = (souvenir.dates || []).filter(Boolean).slice().sort();
  return dates[0] || "";
}

/** (Re)construit la liste des dates dans la fiche du souvenir ouvert. */
function afficherDates(souvenir) {
  const liste = document.getElementById("souvenir-dates");
  const vide = document.getElementById("dates-vide");
  liste.innerHTML = "";
  const dates = souvenir.dates || (souvenir.dates = []);
  vide.hidden = dates.length > 0;

  dates.forEach((d, i) => {
    const ligne = document.createElement("div");
    ligne.className = "date-ligne";

    if (etat.mode === "visualisation") {
      // Lecture seule : la date joliment écrite, sans champ de saisie.
      const texte = document.createElement("span");
      texte.className = "date-texte";
      texte.textContent = "📅 " + (d ? formaterDate(d) : "—");
      ligne.appendChild(texte);
    } else {
      const champ = document.createElement("input");
      champ.type = "date";
      champ.className = "style-input date-champ";
      champ.value = d || "";
      champ.addEventListener("change", () => {
        dates[i] = champ.value;
        planifierSauvegarde();
      });

      const suppr = document.createElement("button");
      suppr.className = "icone-btn date-suppr";
      suppr.title = "Retirer cette date";
      suppr.textContent = "✕";
      suppr.addEventListener("click", () => {
        dates.splice(i, 1);
        afficherDates(souvenir);
        planifierSauvegarde();
      });

      ligne.appendChild(champ);
      ligne.appendChild(suppr);
    }
    liste.appendChild(ligne);
  });
}

/** Ajoute une ligne de date vide à la fiche du souvenir ouvert. */
function ajouterDate() {
  const s = etat.souvenirActif;
  if (!s) return;
  (s.dates = s.dates || []).push("");
  afficherDates(s);
  // On met le curseur directement dans le champ tout juste ajouté.
  const champs = document.querySelectorAll("#souvenir-dates input");
  const dernier = champs[champs.length - 1];
  if (dernier) dernier.focus();
}

/** Range les souvenirs par date (les souvenirs sans date vont à la fin). */
async function trierSouvenirsParDate() {
  const dates = etat.souvenirs.filter((s) => premiereDate(s));
  if (dates.length === 0) {
    toast("Renseigne d'abord des dates dans les fiches des souvenirs.", true);
    return;
  }
  const ok = await demanderConfirmation(
    "Ranger par date ?",
    "Les souvenirs seront numérotés dans l'ordre de leurs dates ; ceux sans date iront à la fin.",
    { okLibelle: "Ranger", danger: false }
  );
  if (!ok) return;

  // Tri stable : à date égale (ou sans date), l'ordre actuel est conservé.
  etat.souvenirs = etat.souvenirs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const da = premiereDate(a.s), db = premiereDate(b.s);
      if (!da && !db) return a.i - b.i;
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : da > db ? 1 : a.i - b.i;
    })
    .map((x) => x.s);

  renumeroterSouvenirs();
  if (etat.souvenirActif) majNavigation();
  toast("Souvenirs rangés par date");
  planifierSauvegarde();
}

/* =========================================================
   Filtre des souvenirs par dates et pictogrammes (visualisation)
   ========================================================= */

/** Ouvre le panneau des filtres (mode visualisation seulement). */
function ouvrirPanneauFiltre() {
  if (etat.mode !== "visualisation") return;
  fermerPanneauCarnets();
  construireFiltrePictos();
  document.getElementById("filtre-du").value = etat.filtre.du || "";
  document.getElementById("filtre-au").value = etat.filtre.au || "";
  majBilanFiltre();
  document.getElementById("panneau-filtre").hidden = false;
}

/** Ferme le panneau des filtres (le filtre reste appliqué). */
function fermerPanneauFiltre() {
  document.getElementById("panneau-filtre").hidden = true;
}

/** Les pictogrammes réellement utilisés par les souvenirs, avec leur nombre. */
function pictosUtilises() {
  const vus = new Map();
  etat.souvenirs.forEach((s) => {
    const cle = s.pictogramme || "souvenir";
    vus.set(cle, (vus.get(cle) || 0) + 1);
  });
  return vus;
}

/** (Re)construit les cases à cocher des pictogrammes utilisés. */
function construireFiltrePictos() {
  const c = document.getElementById("filtre-pictos");
  c.innerHTML = "";
  const vus = pictosUtilises();

  vus.forEach((nb, cle) => {
    const ligne = document.createElement("label");
    ligne.className = "filtre-picto";

    const caseACocher = document.createElement("input");
    caseACocher.type = "checkbox";
    caseACocher.dataset.picto = cle;
    caseACocher.checked = !etat.filtre.pictos || etat.filtre.pictos.has(cle);
    caseACocher.addEventListener("change", () => {
      // On reconstitue l'ensemble des pictogrammes cochés.
      const coches = new Set();
      c.querySelectorAll("input[type=checkbox]").forEach((inp) => {
        if (inp.checked) coches.add(inp.dataset.picto);
      });
      etat.filtre.pictos = coches.size === vus.size ? null : coches;
      appliquerFiltreSouvenirs();
    });

    const glyphe = document.createElement("span");
    glyphe.className = "filtre-picto-glyphe";
    const perso = obtenirPictoPerso(cle);
    if (perso) glyphe.innerHTML = `<img src="${perso.src}" alt="">`;
    else glyphe.textContent = glyphDePicto(cle) || "①";

    const compteur = document.createElement("span");
    compteur.className = "filtre-picto-nb";
    compteur.textContent = nb > 1 ? `× ${nb}` : "";

    ligne.append(caseACocher, glyphe, compteur);
    c.appendChild(ligne);
  });
}

/** Un souvenir passe-t-il le filtre courant ? */
function souvenirPasseFiltre(s) {
  const f = etat.filtre;
  if (f.pictos && !f.pictos.has(s.pictogramme || "souvenir")) return false;
  if (f.du || f.au) {
    const dates = (s.dates || []).filter(Boolean);
    if (dates.length === 0) return false; // période demandée → sans date : masqué
    const dansPeriode = dates.some((d) => (!f.du || d >= f.du) && (!f.au || d <= f.au));
    if (!dansPeriode) return false;
  }
  return true;
}

/** Applique le filtre : masque/réaffiche épingles et étiquettes. */
function appliquerFiltreSouvenirs() {
  etat.souvenirs.forEach((s) => {
    s.masque = etat.mode === "visualisation" && !souvenirPasseFiltre(s);
    if (!s.marker) return;
    const surCarte = etat.grappe.hasLayer(s.marker);
    if (s.masque && surCarte) {
      etat.grappe.removeLayer(s.marker);
      retirerLabel(s);
    } else if (!s.masque && !surCarte) {
      etat.grappe.addLayer(s.marker);
      majLabel(s);
    }
  });
  majVisibiliteLabels();
  majBilanFiltre();
}

/** Petit bilan « x souvenirs affichés sur y » dans le panneau des filtres. */
function majBilanFiltre() {
  const el = document.getElementById("filtre-bilan");
  const total = etat.souvenirs.length;
  const visibles = etat.souvenirs.filter((s) => !s.masque).length;
  el.textContent = visibles === total
    ? `Les ${total} souvenirs sont affichés.`
    : `${visibles} souvenir${visibles > 1 ? "s" : ""} affiché${visibles > 1 ? "s" : ""} sur ${total}.`;
}

/** Efface le filtre et réaffiche tous les souvenirs. */
function reinitialiserFiltre() {
  etat.filtre = { du: "", au: "", pictos: null };
  document.getElementById("filtre-du").value = "";
  document.getElementById("filtre-au").value = "";
  construireFiltrePictos();
  appliquerFiltreSouvenirs();
}

/* =========================================================
   Enregistrements audio des souvenirs (façon mini podcast)
   ========================================================= */

let enregistreurAudio = null; // le MediaRecorder en cours, ou null
let fluxMicro = null;         // le flux du micro, pour bien l'éteindre après
let morceauxAudio = [];       // les bouts d'enregistrement reçus au fil de l'eau
let timerAudio = null;        // met à jour la durée affichée sur le bouton
let debutAudio = 0;

/** 75 secondes → "1:15". */
function formaterDuree(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Met le bouton d'enregistrement dans le bon état (repos / en cours). */
function majBoutonAudio(enCours) {
  const btn = document.getElementById("audio-enregistrer");
  btn.classList.toggle("enregistre", !!enCours);
  btn.textContent = enCours
    ? `⏹ Arrêter · ${formaterDuree((Date.now() - debutAudio) / 1000)}`
    : "🎙️ Enregistrer";
}

/** Démarre ou arrête l'enregistrement (bouton de la fiche). */
async function basculerEnregistrementAudio() {
  if (enregistreurAudio) {
    arreterEnregistrementAudio();
    return;
  }
  const souvenir = etat.souvenirActif;
  if (!souvenir) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("Ce navigateur ne sait pas enregistrer de l'audio.", true);
    return;
  }

  try {
    fluxMicro = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("Micro refusé. Autorise le micro dans ton navigateur pour enregistrer.", true);
    return;
  }

  morceauxAudio = [];
  enregistreurAudio = new MediaRecorder(fluxMicro);
  enregistreurAudio.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) morceauxAudio.push(e.data);
  };
  enregistreurAudio.onstop = () => {
    const type = enregistreurAudio.mimeType || "audio/webm";
    const duree = Math.round((Date.now() - debutAudio) / 1000);
    const blob = new Blob(morceauxAudio, { type });

    // On éteint le micro et on remet tout au repos.
    fluxMicro.getTracks().forEach((t) => t.stop());
    fluxMicro = null;
    enregistreurAudio = null;
    morceauxAudio = [];
    clearInterval(timerAudio);
    majBoutonAudio(false);

    // Le son devient un texte (data URL), stockable dans le carnet comme les photos.
    const lecteur = new FileReader();
    lecteur.onload = () => {
      (souvenir.audios = souvenir.audios || []).push({
        src: lecteur.result,
        legende: "",
        duree,
      });
      if (etat.souvenirActif === souvenir) afficherAudios(souvenir);
      toast("Enregistrement ajouté");
      planifierSauvegarde();
    };
    lecteur.onerror = () => toast("Impossible d'enregistrer ce son.", true);
    lecteur.readAsDataURL(blob);
  };

  enregistreurAudio.start();
  debutAudio = Date.now();
  majBoutonAudio(true);
  timerAudio = setInterval(() => majBoutonAudio(true), 500);
}

/** Arrête proprement l'enregistrement en cours (s'il y en a un). */
function arreterEnregistrementAudio() {
  if (enregistreurAudio && enregistreurAudio.state !== "inactive") {
    enregistreurAudio.stop(); // le reste se fait dans onstop
  }
}

/** (Re)construit la liste des enregistrements dans la fiche. */
function afficherAudios(souvenir) {
  const liste = document.getElementById("souvenir-audios");
  const vide = document.getElementById("audios-vide");
  liste.innerHTML = "";
  const audios = souvenir.audios || (souvenir.audios = []);
  vide.hidden = audios.length > 0;

  audios.forEach((a, i) => {
    const ligne = document.createElement("div");
    ligne.className = "audio-ligne";

    const lecteur = document.createElement("audio");
    lecteur.controls = true;
    lecteur.preload = "metadata";
    lecteur.src = a.src;
    ligne.appendChild(lecteur);

    if (etat.mode === "visualisation") {
      if (a.legende) {
        const texte = document.createElement("p");
        texte.className = "audio-legende-texte";
        texte.textContent = a.legende;
        ligne.appendChild(texte);
      }
    } else {
      const bas = document.createElement("div");
      bas.className = "audio-ligne-bas";

      const legende = document.createElement("input");
      legende.type = "text";
      legende.className = "style-input audio-legende";
      legende.placeholder = "Légende de cet enregistrement…";
      legende.maxLength = 140;
      legende.value = a.legende || "";
      legende.addEventListener("input", () => {
        a.legende = legende.value;
        planifierSauvegarde();
      });

      const suppr = document.createElement("button");
      suppr.className = "icone-btn audio-suppr";
      suppr.title = "Supprimer cet enregistrement";
      suppr.textContent = "✕";
      suppr.addEventListener("click", async () => {
        const ok = await demanderConfirmation(
          "Supprimer cet enregistrement ?",
          a.legende ? `« ${a.legende} » sera supprimé.` : "L'enregistrement audio sera supprimé.",
          { okLibelle: "Supprimer" }
        );
        if (!ok) return;
        audios.splice(i, 1);
        afficherAudios(souvenir);
        planifierSauvegarde();
      });

      bas.appendChild(legende);
      bas.appendChild(suppr);
      ligne.appendChild(bas);
    }
    liste.appendChild(ligne);
  });
}

/* =========================================================
   ÉTAPE 3 — Photos et récit du souvenir
   ========================================================= */

// Taille maximale (en pixels) du plus grand côté d'une photo importée.
// On réduit les photos pour garder un carnet léger à sauvegarder/partager.
const PHOTO_TAILLE_MAX = 1600;

/**
 * Lit un fichier image choisi par l'utilisateur, le redimensionne si besoin,
 * et renvoie une "data URL" (l'image encodée en texte) prête à être stockée.
 * @param {File} fichier  Le fichier image.
 * @param {number} tailleMax  Taille max (px) du plus grand côté.
 * @param {string} format  Format d'export ("image/jpeg" ou "image/png").
 * @returns {Promise<string>} l'image en data URL.
 */
function importerImage(fichier, tailleMax = PHOTO_TAILLE_MAX, format = "image/jpeg") {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onerror = () => reject(new Error("Lecture de l'image impossible."));
    lecteur.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image illisible."));
      img.onload = () => {
        // Calcul de la nouvelle taille en gardant les proportions.
        let { width, height } = img;
        const plusGrandCote = Math.max(width, height);
        if (plusGrandCote > tailleMax) {
          const ratio = tailleMax / plusGrandCote;
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        // On redessine l'image à la bonne taille sur un "canvas" (toile).
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        // JPEG qualité 0,82 (bon compromis netteté / poids) ; le PNG garde
        // la transparence, utile pour les pictogrammes importés.
        resolve(canvas.toDataURL(format, 0.82));
      };
      img.src = lecteur.result;
    };
    lecteur.readAsDataURL(fichier);
  });
}

/** Importe une liste de fichiers images et les ajoute au souvenir actif. */
async function ajouterPhotos(fichiers) {
  const s = etat.souvenirActif;
  if (!s || !fichiers || fichiers.length === 0) return;

  let ajoutees = 0;
  for (const fichier of fichiers) {
    if (!fichier.type.startsWith("image/")) continue; // on ignore les non-images
    try {
      const dataUrl = await importerImage(fichier);
      s.photos.push({ src: dataUrl, legende: "" });
      ajoutees++;
    } catch (e) {
      toast(e.message || "Une image n'a pas pu être ajoutée.", true);
    }
  }

  if (ajoutees > 0) {
    // S'il n'y avait pas encore de couverture, la 1re photo le devient.
    if (s.couverture === null && s.photos.length > 0) s.couverture = 0;
    afficherGalerie(s);
    majTooltip(s); // l'étiquette peut désormais montrer la couverture
    toast(ajoutees > 1 ? `${ajoutees} photos ajoutées` : "Photo ajoutée");
    planifierSauvegarde();
  }
}

/** Affiche les miniatures des photos du souvenir dans la fiche. */
function afficherGalerie(souvenir) {
  const galerie = document.getElementById("souvenir-photos");
  const vide = document.getElementById("galerie-vide");
  galerie.innerHTML = "";

  souvenir.photos.forEach((photo, index) => {
    const vignette = document.createElement("div");
    vignette.className = "vignette";
    const estCouverture = souvenir.couverture === index;
    if (estCouverture) vignette.classList.add("est-couverture");

    const img = document.createElement("img");
    img.src = photo.src;
    img.alt = photo.legende || `Photo ${index + 1}`;
    // Clic sur la miniature : ouvrir la photo en grand.
    img.addEventListener("click", () => ouvrirLightbox(souvenir, index));

    const suppr = document.createElement("button");
    suppr.className = "vignette-suppr";
    suppr.textContent = "✕";
    suppr.title = "Retirer cette photo";
    suppr.addEventListener("click", (e) => {
      e.stopPropagation(); // ne pas ouvrir la visionneuse
      supprimerPhoto(souvenir, index);
    });

    vignette.appendChild(img);
    vignette.appendChild(suppr);
    // Petit badge sur la photo de couverture.
    if (estCouverture) {
      const badge = document.createElement("span");
      badge.className = "vignette-couv";
      badge.textContent = "★ Couverture";
      vignette.appendChild(badge);
    }

    // Cellule = la miniature + sa légende affichée en dessous.
    const cellule = document.createElement("div");
    cellule.className = "photo-cell";
    cellule.appendChild(vignette);

    const legende = document.createElement("div");
    if (photo.legende) {
      legende.className = "vignette-legende";
      legende.textContent = photo.legende;
      legende.title = photo.legende; // infobulle si tronquée
    } else {
      legende.className = "vignette-legende vide";
      legende.textContent = "Sans légende";
    }
    cellule.appendChild(legende);

    galerie.appendChild(cellule);
  });

  // Message "aucune photo" affiché seulement si la galerie est vide.
  vide.hidden = souvenir.photos.length > 0;
}

/** Retire une photo d'un souvenir et réajuste la couverture si besoin. */
function supprimerPhoto(souvenir, index) {
  souvenir.photos.splice(index, 1);

  // On recale l'index de couverture après la suppression.
  if (souvenir.photos.length === 0) {
    souvenir.couverture = null;
  } else if (souvenir.couverture === index) {
    souvenir.couverture = 0;          // la couverture supprimée → 1re photo
  } else if (souvenir.couverture > index) {
    souvenir.couverture--;            // décalage des index suivants
  }

  afficherGalerie(souvenir);
  majTooltip(souvenir);
  planifierSauvegarde();
}

/* ---------- Visionneuse plein écran (lightbox) ---------- */
// Elle travaille sur un souvenir donné, pour pouvoir éditer la légende
// de chaque photo et désigner la photo de couverture.
const lightbox = { souvenir: null, index: 0 };

/** Ouvre la photo n°`index` d'un souvenir en plein écran. */
function ouvrirLightbox(souvenir, index) {
  lightbox.souvenir = souvenir;
  lightbox.index = index;
  document.getElementById("lightbox").hidden = false;
  majLightbox();
}

/** Met à jour l'image, la légende, le bouton couverture et les flèches. */
function majLightbox() {
  const s = lightbox.souvenir;
  if (!s) return;
  const photo = s.photos[lightbox.index];
  if (!photo) return;
  const total = s.photos.length;

  document.getElementById("lightbox-img").src = photo.src;
  document.getElementById("lightbox-legende").value = photo.legende || "";
  document.getElementById("lightbox-compteur").textContent =
    `${lightbox.index + 1} / ${total}`;

  // Bouton couverture : état actif si la photo affichée est la couverture.
  const btn = document.getElementById("lightbox-couverture");
  const estCouv = s.couverture === lightbox.index;
  btn.classList.toggle("actif", estCouv);
  btn.textContent = estCouv ? "★ Photo de couverture" : "☆ Couverture";

  // Pas de boucle : flèches masquées aux extrémités (et si une seule photo).
  document.getElementById("lightbox-prec").style.visibility =
    lightbox.index > 0 ? "visible" : "hidden";
  document.getElementById("lightbox-suiv").style.visibility =
    lightbox.index < total - 1 ? "visible" : "hidden";
}

/** Change de photo dans la visionneuse (-1 précédente, +1 suivante). */
function naviguerLightbox(decalage) {
  const s = lightbox.souvenir;
  if (!s) return;
  const cible = lightbox.index + decalage;
  if (cible < 0 || cible >= s.photos.length) return;
  lightbox.index = cible;
  majLightbox();
}

/** Enregistre la légende saisie pour la photo en cours d'affichage. */
function saisirLegende(valeur) {
  const s = lightbox.souvenir;
  if (!s) return;
  const photo = s.photos[lightbox.index];
  if (!photo) return;
  photo.legende = valeur;
  // Si c'est la couverture, l'étiquette du marqueur doit suivre.
  if (s.couverture === lightbox.index) majTooltip(s);
  planifierSauvegarde();
}

/** Désigne la photo affichée comme couverture du souvenir. */
function definirCouverture() {
  const s = lightbox.souvenir;
  if (!s) return;
  s.couverture = lightbox.index;
  majLightbox();
  afficherGalerie(s); // met à jour le badge ★ dans la fiche
  majTooltip(s);      // met à jour l'étiquette du marqueur
  toast("Photo de couverture définie");
  planifierSauvegarde();
}

/** Ferme la visionneuse plein écran. */
function fermerLightbox() {
  document.getElementById("lightbox").hidden = true;
  // La galerie de la fiche peut avoir des légendes modifiées : on la réaffiche.
  if (lightbox.souvenir && lightbox.souvenir === etat.souvenirActif) {
    afficherGalerie(lightbox.souvenir);
  }
}

/* =========================================================
   ÉTAPE 5 — Style de la carte
   ========================================================= */

/** Vérifie qu'une adresse de tuiles contient bien {z}, {x} et {y}. */
function urlTuilesValide(url) {
  return /\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url);
}

// Style vectoriel gratuit et sans clé (OpenFreeMap, schéma OpenMapTiles).
const STYLE_VECTORIEL_URL = "https://tiles.openfreemap.org/styles/liberty";

/** Remplace le fond de carte (tuiles) par celui correspondant à la clé. */
function appliquerFond(cle) {
  // Fond vectoriel : moteur MapLibre intégré dans Leaflet (sous nos calques).
  if (cle === "vectoriel" && L.maplibreGL) {
    if (etat.coucheFond) etat.coucheFond.remove();
    // La couche vectorielle ne déclare pas de zoom maximal à Leaflet (ce
    // n'est pas une couche de tuiles classique) : on le pose sur la carte
    // elle-même, sinon le regroupement d'épingles (markercluster) plante.
    etat.carte.setMaxZoom(19);
    etat.coucheFond = L.maplibreGL({
      pane: "tilePane", // sous le tracé et les marqueurs
      style: STYLE_VECTORIEL_URL,
      attribution:
        '© <a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ' +
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      // Sans ça, le tampon WebGL est effacé juste après chaque image affichée :
      // le fond vectoriel disparaît alors à l'impression (capture d'un tampon vide).
      preserveDrawingBuffer: true,
    }).addTo(etat.carte);
    etat.glMap = etat.coucheFond.getMaplibreMap();
    // Une fois le style chargé, on applique nos personnalisations enregistrées
    // (en passant par la version simplifiée du style si elle est demandée).
    surStyleVecteurPret(() => {
      const niveau = lireSimplification(etat.style.vecteur.simplification, 14);
      const arrondi = lireArrondi(etat.style.arrondi);
      if (niveau < 14 || arrondi > 0) appliquerSimplificationVecteur();
      else appliquerStyleVecteur();
    });
    return;
  }
  etat.glMap = null;
  majClasseAncienne(false); // le grain de papier ne concerne que le vectoriel

  let url, options;

  if (cle === "perso" && etat.style.fondPerso && urlTuilesValide(etat.style.fondPerso.url)) {
    // Fond personnalisé fourni par l'utilisateur.
    const fp = etat.style.fondPerso;
    url = fp.url;
    options = {
      maxZoom: fp.maxZoom || 19,
      crossOrigin: "anonymous", // nécessaire pour l'export PNG
      attribution: fp.attribution || "Fond personnalisé",
    };
    if (url.includes("{s}")) options.subdomains = fp.subdomains || "abc";
  } else {
    // Fond prédéfini (et repli sur le topo si "perso" sans adresse valide).
    const fond = FONDS[cle] || FONDS.topo;
    url = fond.url;
    options = fond.options;
  }

  if (etat.coucheFond) etat.coucheFond.remove();
  // Le zoom maximal de la carte suit celui du fond choisi (voir plus haut).
  etat.carte.setMaxZoom(options.maxZoom || 19);
  // Les tuiles vont sur le calque du fond : la trace et les marqueurs
  // restent automatiquement au-dessus.
  etat.coucheFond = L.tileLayer(url, options).addTo(etat.carte);
}

/* ---------- Personnalisation du fond vectoriel ---------- */

/** Appelle `cb` dès que le style du fond vectoriel est prêt. */
function surStyleVecteurPret(cb) {
  const m = etat.glMap;
  if (!m) return;
  if (m.isStyleLoaded()) cb();
  else m.once("idle", cb); // "idle" = rendu stabilisé, style chargé
}

/**
 * Range une couche du fond vectoriel dans une catégorie de zone
 * (eau, forêt, prairie, bâti, fond) — ou null si elle n'en fait pas partie.
 */
function classeZone(couche) {
  const id = (couche.id || "").toLowerCase();
  const sl = (couche["source-layer"] || "").toLowerCase();
  if (id === "background") return "fond";
  // Les lignes d'eau (rivières, canaux) avant les surfaces d'eau : le
  // source-layer "waterway" est plus spécifique que "water".
  if (sl === "waterway" || /waterway|stream|canal/.test(id)) return "riviere";
  if (/ice|glacier|snow/.test(id)) return "glacier";
  if (sl === "water" || /water|ocean|sea|lake|river|bay/.test(id)) return "eau";
  // Parcs nationaux et réserves naturelles : leur propre catégorie,
  // testée AVANT la forêt (les identifiants contiennent souvent "park").
  if (sl === "park" || /national_park|nature_reserve|protected|park/.test(id)) return "reserve";
  if (/wood|forest|golf|cemetery|orchard|vineyard/.test(id)) return "foret";
  if (/grass|meadow|scrub|heath|wetland|farmland|landcover|landuse/.test(id)) return "prairie";
  if (sl === "building" || /building/.test(id)) return "bati";
  if (sl === "boundary" || /boundary|admin/.test(id)) return "frontiere";
  if (sl === "transportation" || sl === "transportation_name" ||
      /road|highway|street|path|track|bridge|tunnel|rail|ferry/.test(id)) return "route";
  return null;
}

/** Repeint toutes les couches d'une catégorie de zone avec la couleur donnée. */
function appliquerCouleurZone(categorie, couleur) {
  const m = etat.glMap;
  if (!m) return;
  // Catégorie spéciale "noms" : la couleur du texte des noms de lieux.
  if (categorie === "noms") {
    m.getStyle().layers.forEach((couche) => {
      if (couche.type !== "symbol") return;
      try { m.setPaintProperty(couche.id, "text-color", couleur); } catch (e) {}
    });
    return;
  }
  m.getStyle().layers.forEach((couche) => {
    if (classeZone(couche) !== categorie) return;
    try {
      if (couche.type === "fill") m.setPaintProperty(couche.id, "fill-color", couleur);
      else if (couche.type === "line") m.setPaintProperty(couche.id, "line-color", couleur);
      else if (couche.type === "background") m.setPaintProperty(couche.id, "background-color", couleur);
      else if (couche.type === "fill-extrusion") m.setPaintProperty(couche.id, "fill-extrusion-color", couleur);
    } catch (e) { /* couche non colorable : on ignore */ }
  });
}

/**
 * Applique le niveau de détail du fond vectoriel : "épuré" masque les
 * petites routes, bâtiments et points d'intérêt (les mêmes couches que le
 * préréglage "ancienne") ; "complet" les réaffiche.
 */
function appliquerNiveauDetail(epure) {
  const m = etat.glMap;
  if (!m) return;
  m.getStyle().layers.forEach((l) => {
    if (!masquerDetail(l)) return;
    try { m.setLayoutProperty(l.id, "visibility", epure ? "none" : "visible"); } catch (e) {}
  });
}

/** Applique toutes les personnalisations vectorielles enregistrées. */
function appliquerStyleVecteur() {
  const preset = PRESETS_FOND[etat.style.vecteur.preset] || null;
  majClasseAncienne(etat.style.fond === "vectoriel" && !!preset); // grain de papier
  if (!etat.glMap || !etat.glMap.isStyleLoaded()) return;
  const z = etat.style.vecteur.zones;
  Object.keys(z).forEach((cat) => {
    if (z[cat]) appliquerCouleurZone(cat, z[cat]);
  });
  appliquerNiveauDetail(etat.style.vecteur.detail === "epure" || !!preset);
  if (preset) styliserLabelsPreset(preset);
  appliquerCouchesVisibles(); // les couches décochées passent en dernier
}

/** Active/désactive le grain de papier (calque parchemin) et sa teinte. */
function majClasseAncienne(on) {
  document.getElementById("map").classList.toggle("vecteur-ancienne", !!on);
  const parchemin = document.getElementById("parchemin");
  parchemin.classList.remove("teinte-ancienne", "teinte-claire", "teinte-sombre", "teinte-pirate");
  const preset = PRESETS_FOND[etat.style.vecteur.preset];
  if (on && preset) parchemin.classList.add("teinte-" + preset.teinte);
}

/** Masque les couches géographiques décochées (noms, frontières, rivières…). */
function appliquerCouchesVisibles() {
  const m = etat.glMap;
  if (!m) return;
  const couches = etat.style.vecteur.couches || {};
  m.getStyle().layers.forEach((l) => {
    let cat = classeZone(l);
    if (l.type === "symbol") cat = "noms"; // tous les textes = "noms de lieux"
    if (!cat || couches[cat] !== false) return;
    try { m.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {}
  });
}

/** Décide si une couche du fond vectoriel relève du "détail" à masquer. */
function masquerDetail(couche) {
  const id = (couche.id || "").toLowerCase();
  const sl = (couche["source-layer"] || "").toLowerCase();
  if (["building", "housenumber", "poi", "aeroway"].includes(sl)) return true;
  if (/building|housenumber|poi|aeroway|ferry/.test(id)) return true;
  // Routes : on ne garde que les grands axes.
  if (sl === "transportation" || sl === "transportation_name" || /road|bridge|tunnel|rail|path|track|service/.test(id)) {
    return !/motorway|trunk|primary/.test(id);
  }
  return false;
}

/** Masque les détails du fond vectoriel (grosse maille). */
function appliquerMailleGrossiere() {
  const m = etat.glMap;
  if (!m) return;
  m.getStyle().layers.forEach((l) => {
    if (masquerDetail(l)) {
      try { m.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {}
    }
  });
}

/** Met les noms de lieux en italique, aux couleurs du préréglage choisi. */
function styliserLabelsPreset(preset) {
  const m = etat.glMap;
  if (!m) return;
  appliquerMailleGrossiere();
  m.getStyle().layers.forEach((l) => {
    if (l.type !== "symbol" || !(l.layout && l.layout["text-field"])) return;
    try { if (m.getLayoutProperty(l.id, "visibility") === "none") return; } catch (e) {}
    try { m.setLayoutProperty(l.id, "text-font", ["Noto Sans Italic"]); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-color", preset.noms); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-halo-color", preset.halo); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-halo-width", 1.4); } catch (e) {}
  });
}

/** Active un préréglage médiéval (palette + grosse maille + papier + décor). */
function appliquerPresetFond(cle) {
  const preset = PRESETS_FOND[cle];
  if (!preset) return;
  const v = etat.style.vecteur;
  v.preset = cle;
  // On repart des couleurs du préréglage (les zones absentes restent d'origine).
  Object.keys(v.zones).forEach((k) => { v.zones[k] = preset.zones[k] || null; });

  // Le décor "carte ancienne" complet : rose des vents + bordure
  // (on garde les variantes déjà choisies par l'utilisateur, s'il y en a).
  etat.style.decor = {
    rose: etat.style.decor.rose || "ancienne",
    bordure: etat.style.decor.bordure || "double",
  };
  appliquerDecor();

  // On s'assure que le fond vectoriel est actif.
  if (etat.style.fond !== "vectoriel") {
    etat.style.fond = "vectoriel";
    majSegment("fond-carte", "fond", "vectoriel");
    basculerBlocPerso(false);
    basculerBlocVecteur(true);
    document.getElementById("fond-aide-vectoriel").hidden = true;
    appliquerFond("vectoriel");
  } else {
    // Le style vectoriel est peut-être personnalisé : on le recharge proprement
    // (au niveau de simplification/arrondi en cours) puis on repeint tout.
    appliquerSimplificationVecteur();
  }
  majClasseAncienne(true);
  synchroniserControlesStyle();
  planifierSauvegarde();
}

/** Change la couleur d'une zone (depuis un sélecteur) et la mémorise. */
function choisirCouleurZone(categorie, couleur) {
  etat.style.vecteur.zones[categorie] = couleur;
  appliquerCouleurZone(categorie, couleur);
  planifierSauvegarde();
}

/** Remet les couleurs d'origine du fond vectoriel (recharge le style de base). */
function reinitialiserZonesVecteur() {
  const z = etat.style.vecteur.zones;
  Object.keys(z).forEach((k) => (z[k] = null));
  etat.style.vecteur.preset = null;     // on quitte aussi le préréglage "ancienne"
  majClasseAncienne(false);
  // On recharge le style de base (au niveau de simplification en cours).
  appliquerSimplificationVecteur();
  synchroniserControlesStyle();
  planifierSauvegarde();
}

/* ---------- Simplification et arrondi des tracés du fond vectoriel ----------
   Simplification : on plafonne le zoom des DONNÉES (tuiles moins détaillées).
   Arrondi : on LISSE la géométrie des tuiles elles-mêmes (algorithme de
   Chaikin) via un "protocole" MapLibre qui intercepte chaque tuile, la
   décode, arrondit ses lignes et polygones, puis la ré-encode. Résultat :
   des formes vraiment arrondies, parfaitement nettes (aucun flou). */

// Le style vectoriel d'origine (JSON), téléchargé une seule fois : on en a
// besoin pour fabriquer une variante "simplifiée".
let styleVectorielBase = null;

// Les adresses de tuiles (TileJSON) de chaque source, résolues une seule fois.
const tileJsonCache = new Map();

// Bibliothèques de décodage/encodage des tuiles vectorielles (chargées à la
// demande depuis un CDN ; si indisponibles, l'arrondi est ignoré sans casser).
let modulesMvt = null;
async function chargerModulesMvt() {
  if (modulesMvt) return modulesMvt;
  const [vt, pbf, vtpbf] = await Promise.all([
    import("https://esm.sh/@mapbox/vector-tile@1.3.1"),
    import("https://esm.sh/pbf@3.2.1"),
    import("https://esm.sh/vt-pbf@3.1.3"),
  ]);
  modulesMvt = {
    VectorTile: vt.VectorTile,
    Pbf: pbf.default || pbf,
    vtpbf: vtpbf.default || vtpbf,
  };
  return modulesMvt;
}

/**
 * Arrondit une ligne brisée par l'algorithme de Chaikin : chaque passe
 * remplace chaque angle par deux points aux 1/4 et 3/4 des segments,
 * ce qui adoucit les angles tout en suivant la forme d'origine.
 */
function lisserLigneChaikin(points, passes, fermee) {
  for (let p = 0; p < passes; p++) {
    const n = points.length;
    if (n < (fermee ? 3 : 3)) break;
    const res = [];
    if (!fermee) res.push(points[0]); // on garde les extrémités des lignes
    const fin = fermee ? n : n - 1;
    for (let i = 0; i < fin; i++) {
      const a = points[i], b = points[(i + 1) % n];
      res.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      res.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    if (!fermee) res.push(points[n - 1]);
    points = res;
  }
  return points;
}

/** Décode une tuile vectorielle, arrondit ses tracés, la ré-encode. */
function tuileArrondie(brut, passes) {
  const { VectorTile, Pbf, vtpbf } = modulesMvt;
  const tuile = new VectorTile(new Pbf(new Uint8Array(brut)));
  const couches = {};

  Object.keys(tuile.layers).forEach((nom) => {
    const src = tuile.layers[nom];
    couches[nom] = {
      version: src.version || 2,
      name: nom,
      extent: src.extent,
      length: src.length,
      feature: (i) => {
        const f = src.feature(i);
        const geometrie = f.loadGeometry().map((ligne) => {
          if (f.type === 1) return ligne; // points : rien à arrondir
          if (f.type === 3) {
            // Anneau de polygone : fermé (dernier point = premier).
            const ouvert = ligne.slice(0, ligne.length - 1);
            const lisse = lisserLigneChaikin(ouvert, passes, true);
            lisse.push({ x: lisse[0].x, y: lisse[0].y }); // on referme
            return lisse;
          }
          return lisserLigneChaikin(ligne, passes, false); // ligne (route…)
        });
        return {
          id: f.id,
          type: f.type,
          properties: f.properties,
          loadGeometry: () => geometrie,
        };
      },
    };
  });

  return vtpbf.fromVectorTileJs({ layers: couches });
}

// Enregistre le protocole "lisse://" auprès de MapLibre (une seule fois).
// Adresse des tuiles : lisse://<passes>/<adresse https sans le préfixe>.
let protocoleLisseEnregistre = false;
function enregistrerProtocoleLisse() {
  if (protocoleLisseEnregistre || typeof maplibregl === "undefined" || !maplibregl.addProtocol) return;
  protocoleLisseEnregistre = true;
  maplibregl.addProtocol("lisse", async (params) => {
    const m = params.url.match(/^lisse:\/\/(\d+)\/(.+)$/);
    if (!m) throw new Error("adresse de tuile invalide");
    const passes = Number(m[1]);
    const reponse = await fetch("https://" + m[2]);
    if (!reponse.ok) throw new Error("tuile indisponible");
    const brut = await reponse.arrayBuffer();
    try {
      await chargerModulesMvt();
      const d = tuileArrondie(brut, passes);
      // MapLibre attend un ArrayBuffer : on extrait celui du tampon encodé.
      return { data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) };
    } catch (e) {
      return { data: brut }; // repli : tuile telle quelle, sans arrondi
    }
  });
}

/** Résout l'adresse des tuiles d'une source (via son TileJSON), avec cache. */
async function resoudreTuiles(urlTileJson) {
  if (tileJsonCache.has(urlTileJson)) return tileJsonCache.get(urlTileJson);
  const reponse = await fetch(urlTileJson);
  if (!reponse.ok) throw new Error("TileJSON indisponible");
  const infos = await reponse.json();
  tileJsonCache.set(urlTileJson, infos);
  return infos;
}

/**
 * Renvoie le style vectoriel (adresse ou objet JSON) correspondant à un
 * niveau de simplification. Principe : on plafonne le zoom des DONNÉES
 * vectorielles ; au-delà, la carte agrandit des tuiles moins détaillées,
 * dont les contours (côtes, rivières, routes) sont naturellement généralisés.
 */
async function obtenirStyleVectoriel(maxzoom, arrondi) {
  const simplifie = maxzoom && maxzoom < 14;
  if (!simplifie && !arrondi) return STYLE_VECTORIEL_URL; // réglages d'origine

  if (!styleVectorielBase) {
    const reponse = await fetch(STYLE_VECTORIEL_URL);
    if (!reponse.ok) throw new Error("Style vectoriel indisponible");
    styleVectorielBase = await reponse.json();
  }
  const style = JSON.parse(JSON.stringify(styleVectorielBase));

  for (const src of Object.values(style.sources || {})) {
    if (src.type !== "vector") continue;
    if (simplifie) src.maxzoom = Math.min(src.maxzoom || 14, maxzoom);
    if (arrondi > 0) {
      // Les tuiles passent par notre protocole d'arrondi. Pour cela, il faut
      // l'adresse directe des tuiles : on la lit dans le TileJSON de la source.
      let tuiles = src.tiles;
      if (!tuiles && src.url) {
        const infos = await resoudreTuiles(src.url);
        tuiles = infos.tiles;
        if (!src.maxzoom && infos.maxzoom) src.maxzoom = simplifie ? Math.min(infos.maxzoom, maxzoom) : infos.maxzoom;
        if (infos.minzoom !== undefined) src.minzoom = infos.minzoom;
      }
      if (Array.isArray(tuiles)) {
        src.tiles = tuiles.map((u) => "lisse://" + arrondi + "/" + u.replace(/^https?:\/\//, ""));
        delete src.url;
      }
    }
  }
  return style;
}

/** Recharge le fond vectoriel (simplification + arrondi enregistrés). */
function appliquerSimplificationVecteur() {
  const m = etat.glMap;
  if (!m) return;
  const niveau = lireSimplification(etat.style.vecteur.simplification, 14);
  const arrondi = lireArrondi(etat.style.arrondi);
  montrerPatience("La carte se redessine…");
  obtenirStyleVectoriel(niveau, arrondi)
    .then((style) => {
      m.setStyle(style);
      // Une fois le nouveau style affiché, on re-applique couleurs et détail.
      m.once("idle", () => {
        appliquerStyleVecteur();
        cacherPatience();
      });
    })
    .catch(() => {
      cacherPatience();
      toast("Impossible de charger ce réglage (pas de connexion ?)", true);
    });
}

/** Affiche ou masque le bloc de réglages du fond vectoriel. */
function basculerBlocVecteur(visible) {
  document.getElementById("vecteur-bloc").hidden = !visible;
}

/** Compose le filtre du fond (teinte d'ambiance) et le pose sur la carte. */
function appliquerFiltreFond() {
  const fa = AMBIANCE_FILTRES[etat.style.ambiance] || "";
  document.getElementById("map").style.setProperty("--filtre-fond", fa || "none");
}

/** Applique l'ambiance (teinte générale) : classe (pour le parchemin) + filtre. */
function appliquerAmbiance(cle) {
  const map = document.getElementById("map");
  map.classList.remove(
    "ambiance-naturel", "ambiance-ancien", "ambiance-doux", "ambiance-medieval"
  );
  map.classList.add("ambiance-" + (cle || "naturel"));
  appliquerFiltreFond();
}

/* ---------- Décor : variantes de roses des vents et de bordures ---------- */

// Chaque rose est un petit dessin SVG complet (affiché en bas à droite).
const ROSES_VENTS = {
  classique: {
    label: "Classique",
    svg: `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      <circle cx="30" cy="30" r="28" fill="rgba(244,236,215,0.85)" stroke="#5a4632" stroke-width="1.4"/>
      <circle cx="30" cy="30" r="21" fill="none" stroke="#5a4632" stroke-width="0.6" opacity="0.6"/>
      <g stroke="#5a4632" stroke-width="0.5" opacity="0.55">
        <line x1="30" y1="4" x2="30" y2="56"/><line x1="4" y1="30" x2="56" y2="30"/>
        <line x1="12" y1="12" x2="48" y2="48"/><line x1="48" y1="12" x2="12" y2="48"/>
      </g>
      <polygon points="30,6 34,27 30,23 26,27" fill="#a33d2a"/>
      <polygon points="30,54 34,33 30,37 26,33" fill="#5a4632"/>
      <polygon points="6,30 27,26 23,30 27,34" fill="#5a4632"/>
      <polygon points="54,30 33,26 37,30 33,34" fill="#5a4632"/>
      <text x="30" y="14.5" text-anchor="middle" font-size="7.5" font-weight="bold"
            font-family="Georgia, serif" fill="#5a4632">N</text>
    </svg>`,
  },
  etoile: {
    label: "Étoile 8 branches",
    svg: `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      <polygon points="30,2 33,25 30,21 27,25" fill="#a33d2a"/>
      <polygon points="30,58 33,35 30,39 27,35" fill="#3d3021"/>
      <polygon points="2,30 25,27 21,30 25,33" fill="#3d3021"/>
      <polygon points="58,30 35,27 39,30 35,33" fill="#3d3021"/>
      <polygon points="11,11 27,25 24,26 26,28" fill="#8a6b45"/>
      <polygon points="49,11 33,25 36,26 34,28" fill="#8a6b45"/>
      <polygon points="11,49 27,35 24,34 26,32" fill="#8a6b45"/>
      <polygon points="49,49 33,35 36,34 34,32" fill="#8a6b45"/>
      <circle cx="30" cy="30" r="4.5" fill="#f4ecd7" stroke="#3d3021" stroke-width="1"/>
    </svg>`,
  },
  epuree: {
    label: "Épurée",
    svg: `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      <circle cx="30" cy="30" r="26" fill="rgba(255,255,255,0.8)" stroke="#2f3b34" stroke-width="2"/>
      <polygon points="30,9 36,34 30,29 24,34" fill="#2f3b34"/>
      <text x="30" y="52" text-anchor="middle" font-size="12" font-weight="bold"
            font-family="'Avenir Next', sans-serif" fill="#2f3b34">N</text>
    </svg>`,
  },
  ancienne: {
    label: "Ancienne ornée",
    svg: `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      <circle cx="30" cy="30" r="28" fill="rgba(233,224,196,0.9)" stroke="#5a4632" stroke-width="2"/>
      <circle cx="30" cy="30" r="24" fill="none" stroke="#5a4632" stroke-width="0.6"/>
      <circle cx="30" cy="30" r="17" fill="none" stroke="#5a4632" stroke-width="0.6" stroke-dasharray="2 2"/>
      <g stroke="#5a4632" stroke-width="0.45" opacity="0.7">
        <line x1="30" y1="6" x2="30" y2="54"/><line x1="6" y1="30" x2="54" y2="30"/>
        <line x1="13" y1="13" x2="47" y2="47"/><line x1="47" y1="13" x2="13" y2="47"/>
      </g>
      <polygon points="30,7 33.5,28 30,24.5 26.5,28" fill="#a33d2a" stroke="#5a4632" stroke-width="0.5"/>
      <polygon points="30,53 33.5,32 30,35.5 26.5,32" fill="#e9e0c4" stroke="#5a4632" stroke-width="0.7"/>
      <polygon points="7,30 28,26.5 24.5,30 28,33.5" fill="#e9e0c4" stroke="#5a4632" stroke-width="0.7"/>
      <polygon points="53,30 32,26.5 35.5,30 32,33.5" fill="#e9e0c4" stroke="#5a4632" stroke-width="0.7"/>
      <text x="30" y="15" text-anchor="middle" font-size="7" font-style="italic"
            font-family="Georgia, serif" fill="#5a4632">N</text>
      <circle cx="30" cy="30" r="2.4" fill="#5a4632"/>
    </svg>`,
  },
};

// Bordures prédéfinies : chacune correspond à une classe CSS .bordure-<cle>.
const BORDURES = {
  double: { label: "Double filet" },
  epaisse: { label: "Filet épais" },
  pointillee: { label: "Pointillée" },
  corde: { label: "Corde" },
  ornee: { label: "Ornée" },
};

/** Renvoie le décor importé correspondant à une clé "perso:<id>", ou null. */
function decorPerso(cle) {
  if (typeof cle !== "string" || !cle.startsWith("perso:")) return null;
  return etat.decorsPerso.find((x) => x.id === Number(cle.slice("perso:".length))) || null;
}

/** Applique la rose des vents et la bordure choisies (ou les masque). */
function appliquerDecor() {
  const d = etat.style.decor || {};

  // Rose des vents (true = "classique", pour les anciennes sauvegardes).
  const cleRose = d.rose === true ? "classique" : d.rose;
  const roseEl = document.getElementById("rose-carte");
  roseEl.hidden = !cleRose;
  if (cleRose) {
    const perso = decorPerso(cleRose);
    roseEl.innerHTML = perso
      ? `<img src="${perso.src}" alt="" style="width:100%;height:100%;object-fit:contain">`
      : (ROSES_VENTS[cleRose] || ROSES_VENTS.classique).svg;
  }

  // Bordure (true = "double").
  const cleBordure = d.bordure === true ? "double" : d.bordure;
  const bordEl = document.getElementById("bordure-carte");
  bordEl.hidden = !cleBordure;
  bordEl.className = "bordure-carte";
  bordEl.style.borderImageSource = "";
  if (cleBordure) {
    const perso = decorPerso(cleBordure);
    if (perso) {
      bordEl.classList.add("bordure-perso");
      bordEl.style.borderImageSource = `url(${perso.src})`;
    } else {
      bordEl.classList.add("bordure-" + (BORDURES[cleBordure] ? cleBordure : "double"));
    }
  }
}

/* ---------- Fenêtre de choix du décor (roses + bordures + import) ---------- */

let cibleDecorPicker = "rose"; // "rose" | "bordure"

function ouvrirDecorPicker(cible) {
  cibleDecorPicker = cible;
  document.getElementById("decor-titre-modal").textContent =
    cible === "rose" ? "Choisir une rose des vents" : "Choisir une bordure";
  construireListeDecors();
  document.getElementById("modal-decor").hidden = false;
}

function fermerDecorPicker() {
  document.getElementById("modal-decor").hidden = true;
}

/** (Re)construit la grille des décors proposés (prédéfinis + importés). */
function construireListeDecors() {
  const liste = document.getElementById("decor-liste");
  liste.innerHTML = "";
  const d = etat.style.decor || {};
  const actuel = cibleDecorPicker === "rose"
    ? (d.rose === true ? "classique" : d.rose)
    : (d.bordure === true ? "double" : d.bordure);

  const ajouter = (cle, label, apercuHtml, suppression) => {
    const carte = document.createElement("div");
    carte.className = "decor-choix-wrap";
    const b = document.createElement("button");
    b.className = "decor-choix" + (cle === actuel ? " actif" : "");
    b.innerHTML = `<span class="decor-apercu">${apercuHtml}</span><span class="decor-nom">${label}</span>`;
    b.addEventListener("click", () => choisirDecor(cle));
    carte.appendChild(b);
    if (suppression) {
      const suppr = document.createElement("button");
      suppr.className = "picto-perso-suppr";
      suppr.textContent = "✕";
      suppr.title = "Retirer ce décor";
      suppr.addEventListener("click", (e) => { e.stopPropagation(); suppression(); });
      carte.appendChild(suppr);
    }
    liste.appendChild(carte);
  };

  if (cibleDecorPicker === "rose") {
    Object.entries(ROSES_VENTS).forEach(([cle, r]) => ajouter(cle, r.label, r.svg));
  } else {
    Object.entries(BORDURES).forEach(([cle, b]) =>
      ajouter(cle, b.label, `<span class="apercu-bordure bordure-${cle}"></span>`));
  }
  etat.decorsPerso
    .filter((x) => x.type === cibleDecorPicker)
    .forEach((x) => {
      const apercu = cibleDecorPicker === "rose"
        ? `<img src="${x.src}" alt="" style="max-width:100%;max-height:100%;object-fit:contain">`
        : `<span class="apercu-bordure bordure-perso" style="border-image-source:url(${x.src})"></span>`;
      ajouter("perso:" + x.id, x.nom, apercu, () => supprimerDecorPerso(x.id));
    });
}

/** Applique le décor choisi (et coche la case correspondante). */
function choisirDecor(cle) {
  etat.style.decor[cibleDecorPicker] = cle;
  document.getElementById("decor-" + cibleDecorPicker).checked = true;
  appliquerDecor();
  fermerDecorPicker();
  planifierSauvegarde();
}

/** Importe une image comme rose des vents ou bordure. */
async function importerDecorPerso(fichier) {
  if (!fichier || !fichier.type.startsWith("image/")) return;
  try {
    const src = await importerImage(fichier, 512, "image/png");
    const d = {
      id: prochainIdRessource(),
      nom: (fichier.name || "Décor").replace(/\.[^.]+$/, "").slice(0, 40),
      type: cibleDecorPicker,
      src,
    };
    etat.decorsPerso.push(d);
    try { await dbSauverCle("decors", etat.decorsPerso.map((x) => ({ ...x }))); } catch (e) {}
    construireListeDecors();
    toast(`Décor « ${d.nom} » importé`);
  } catch (e) {
    toast("Impossible d'importer cette image.", true);
  }
}

/** Retire un décor importé. */
async function supprimerDecorPerso(id) {
  const d = etat.decorsPerso.find((x) => x.id === id);
  if (!d) return;
  const ok = await demanderConfirmation("Retirer ce décor ?", `« ${d.nom} » sera retiré de la liste.`, { okLibelle: "Retirer" });
  if (!ok) return;
  etat.decorsPerso = etat.decorsPerso.filter((x) => x.id !== id);
  try { await dbSauverCle("decors", etat.decorsPerso.map((x) => ({ ...x }))); } catch (e) {}
  construireListeDecors();
  appliquerDecor(); // au cas où il était utilisé
}

// Styles proposés pour le cartouche de titre (classes CSS .titre-<cle>).
const TITRE_FONDS = ["classique", "parchemin", "pirate", "sombre"];

/** Affiche (ou masque) le cartouche de titre sur la carte. */
function appliquerTitre() {
  const el = document.getElementById("carte-titre");
  const titre = (etat.style.titre || "").trim();
  el.textContent = titre;
  el.style.fontFamily = cssDePolice(etat.style.titrePolice || "titre");
  const fond = TITRE_FONDS.includes(etat.style.titreFond) ? etat.style.titreFond : "classique";
  el.className = "carte-titre" + (fond === "classique" ? "" : " titre-" + fond);
  el.hidden = titre.length === 0;
}

/** Ré-applique le style (couleur/épaisseur/type) à toutes les lignes du tracé. */
function appliquerStyleTrace() {
  if (!etat.coucheTrace) return;
  const t = etat.style.trace;
  etat.coucheTrace.eachLayer((l) => {
    if (l instanceof L.Polyline) {
      l.setStyle({
        color: t.couleur,
        weight: t.epaisseur,
        dashArray: TYPES_LIGNE[t.type],
      });
    }
  });
}

/* ---------- Noms des souvenirs affichés sur la carte ---------- */

/** Crée l'étiquette permanente de nom d'un souvenir. */
function creerLabel(souvenir) {
  souvenir.label = L.tooltip({
    permanent: true,
    direction: "bottom",
    offset: [0, 2],
    className: "label-souvenir",
    interactive: false,
  })
    .setLatLng([souvenir.lat, souvenir.lng])
    .setContent(echapperHtml(souvenir.nom || ""))
    .addTo(etat.carte);
}

/** Retire l'étiquette de nom d'un souvenir. */
function retirerLabel(souvenir) {
  if (souvenir.label) {
    souvenir.label.remove();
    souvenir.label = null;
  }
}

/** Crée / met à jour / retire l'étiquette d'un souvenir selon le réglage. */
function majLabel(souvenir) {
  // Un souvenir "en réserve" n'a pas de position : pas d'étiquette sur la carte.
  if (souvenir.lat === undefined || souvenir.lat === null) return;
  if (!etat.style || !etat.style.labels.afficher) {
    retirerLabel(souvenir);
    return;
  }
  if (!souvenir.label) creerLabel(souvenir);
  else souvenir.label.setContent(echapperHtml(souvenir.nom || ""));
}

/** Applique le style des étiquettes (police, couleur, taille) et leur affichage. */
function appliquerStyleLabels() {
  const lab = etat.style.labels;
  const map = document.getElementById("map");
  // Les étiquettes héritent de ces variables CSS posées sur la carte.
  map.style.setProperty("--label-police", cssDePolice(lab.police));
  map.style.setProperty("--label-couleur", lab.couleur);
  // Taille : mot-clé (petit/moyen/grand) ou nombre de pixels (réglage fin).
  map.style.setProperty("--label-taille",
    TAILLES[lab.taille] || (Number(lab.taille) ? lab.taille + "px" : TAILLES.moyen));
  // Création ou retrait des étiquettes selon l'activation.
  etat.souvenirs.forEach(majLabel);
  majVisibiliteLabels(); // pas d'étiquette pour une épingle fondue dans une grappe
}

/** Applique l'intégralité du style et synchronise les contrôles du panneau. */
function appliquerStyleComplet() {
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);
  appliquerStyleTrace();
  appliquerStyleLabels();
  appliquerStyleVecteur();
  appliquerTitre();
  appliquerDecor();
  synchroniserControlesStyle();
}

/** Construit un objet style valide à partir d'un style sauvegardé (ou rien). */
function fusionnerStyle(s) {
  const base = JSON.parse(JSON.stringify(STYLE_DEFAUT));
  if (!s) return base;
  return {
    titre: typeof s.titre === "string" ? s.titre : base.titre,
    titrePolice: typeof s.titrePolice === "string" ? s.titrePolice : base.titrePolice,
    titreFond: TITRE_FONDS.includes(s.titreFond) ? s.titreFond : base.titreFond,
    trace: {
      couleur: (s.trace && s.trace.couleur) || base.trace.couleur,
      epaisseur: (s.trace && s.trace.epaisseur) || base.trace.epaisseur,
      type: (s.trace && TYPES_LIGNE[s.trace.type] !== undefined)
        ? s.trace.type : base.trace.type,
    },
    fond: (FONDS[s.fond] || s.fond === "perso" || s.fond === "vectoriel") ? s.fond : base.fond,
    ambiance: ["naturel", "ancien", "doux", "medieval"].includes(s.ambiance)
      ? s.ambiance : base.ambiance,
    fondPerso: {
      url: (s.fondPerso && typeof s.fondPerso.url === "string") ? s.fondPerso.url : base.fondPerso.url,
      maxZoom: (s.fondPerso && s.fondPerso.maxZoom) || base.fondPerso.maxZoom,
      attribution: (s.fondPerso && s.fondPerso.attribution) || base.fondPerso.attribution,
      subdomains: (s.fondPerso && s.fondPerso.subdomains) || base.fondPerso.subdomains,
    },
    labels: {
      afficher: !!(s.labels && s.labels.afficher),
      // Toute clé de police est acceptée (catalogue, importée…) : le rendu
      // retombe sur la police système si elle n'existe plus.
      police: (s.labels && typeof s.labels.police === "string") ? s.labels.police : base.labels.police,
      couleur: (s.labels && s.labels.couleur) || base.labels.couleur,
      taille: lireTailleLabels(s.labels && s.labels.taille, base.labels.taille),
    },
    // Style des épingles (les carnets d'avant gardent l'épingle classique).
    epingles: {
      forme: (s.epingles && EPINGLE_FORMES.includes(s.epingles.forme))
        ? s.epingles.forme : base.epingles.forme,
      couleur: (s.epingles && typeof s.epingles.couleur === "string")
        ? s.epingles.couleur : base.epingles.couleur,
      taille: (s.epingles && Number.isFinite(Number(s.epingles.taille)))
        ? Math.max(20, Math.min(72, Number(s.epingles.taille))) : base.epingles.taille,
      numero: s.epingles ? s.epingles.numero !== false : true,
    },
    // L'ancien "lissage" (flou) n'existe plus : on lit le nouvel "arrondi".
    arrondi: lireArrondi(s.arrondi),
    vecteur: {
      zones: Object.fromEntries(
        Object.keys(base.vecteur.zones).map((cle) => [cle, lireCouleurOuNull(s.vecteur, cle)])
      ),
      detail: (s.vecteur && s.vecteur.detail === "epure") ? "epure" : "complet",
      police: (s.vecteur && typeof s.vecteur.police === "string") ? s.vecteur.police : base.vecteur.police,
      preset: (s.vecteur && PRESETS_FOND[s.vecteur.preset]) ? s.vecteur.preset : null,
      couches: Object.fromEntries(
        Object.keys(base.vecteur.couches).map((cle) => [
          cle,
          !(s.vecteur && s.vecteur.couches && s.vecteur.couches[cle] === false),
        ])
      ),
      simplification: lireSimplification(s.vecteur && s.vecteur.simplification, base.vecteur.simplification),
    },
    decor: {
      rose: lireCleDecor(s.decor && s.decor.rose, "classique"),
      bordure: lireCleDecor(s.decor && s.decor.bordure, "double"),
    },
  };
}

/** Lit un choix de décor : false, une clé de variante, ou true (ancien format). */
function lireCleDecor(valeur, cleParDefaut) {
  if (valeur === true) return cleParDefaut;
  return typeof valeur === "string" && valeur ? valeur : false;
}

/** Lit une taille de noms de souvenirs : mot-clé (petit/moyen/grand) ou nombre de px. */
function lireTailleLabels(valeur, defaut) {
  if (TAILLES[valeur]) return valeur;
  const n = Number(valeur);
  if (Number.isFinite(n) && n >= 8 && n <= 28) return Math.round(n);
  return defaut;
}

/** Lit un nombre de passes d'arrondi (0 à 4). */
function lireArrondi(valeur) {
  const n = Number(valeur);
  if (Number.isFinite(n) && n >= 0 && n <= 4) return Math.round(n);
  return 0;
}

/** Lit une couleur de zone sauvegardée (chaîne hex) ou null. */
function lireCouleurOuNull(vecteur, cle) {
  const v = vecteur && vecteur.zones && vecteur.zones[cle];
  return typeof v === "string" ? v : null;
}

/* ---------- Contrôles du panneau Style ---------- */

/** Crée les pastilles de couleur d'un nuancier (réutilisable). */
function construireNuancier(containerId, onChoix) {
  const c = document.getElementById(containerId);
  c.innerHTML = "";
  NUANCIER.forEach((couleur) => {
    const b = document.createElement("button");
    b.className = "nuancier-pastille";
    b.style.background = couleur;
    b.dataset.couleur = couleur;
    b.title = couleur;
    b.addEventListener("click", () => onChoix(couleur));
    c.appendChild(b);
  });
}

/** Met en évidence la pastille active dans un nuancier donné. */
function majPastillesActives(containerId, couleur) {
  const c = (couleur || "").toLowerCase();
  document.querySelectorAll("#" + containerId + " .nuancier-pastille").forEach((b) => {
    b.classList.toggle("actif", b.dataset.couleur.toLowerCase() === c);
  });
}

/** Marque le bouton actif d'un groupe "segmenté". */
function majSegment(containerId, attr, valeur) {
  document.querySelectorAll("#" + containerId + " .segment-btn").forEach((b) => {
    b.classList.toggle("actif", b.dataset[attr] === valeur);
  });
}

/** Branche les clics d'un groupe "segmenté" sur une fonction de choix. */
function brancherSegment(containerId, attr, onChoix) {
  document.getElementById(containerId).addEventListener("click", (e) => {
    const btn = e.target.closest(".segment-btn");
    if (btn) onChoix(btn.dataset[attr]);
  });
}

/** Recale tous les contrôles du panneau sur les valeurs du style courant. */
function synchroniserControlesStyle() {
  const s = etat.style;
  document.getElementById("style-titre").value = s.titre || "";
  document.getElementById("trace-epaisseur").value = s.trace.epaisseur;
  document.getElementById("trace-epaisseur-val").textContent = s.trace.epaisseur;
  document.getElementById("trace-couleur-perso").value = s.trace.couleur;
  majPastillesActives("trace-couleurs", s.trace.couleur);
  majSegment("trace-type", "type", s.trace.type);
  majSegment("fond-carte", "fond", s.fond);
  majSegment("ambiance-carte", "ambiance", s.ambiance);
  // Arrondi : bouton en évidence si le rayon correspond à un préréglage.
  majSegment("arrondi-carte", "arrondi", String(s.arrondi));
  document.getElementById("arrondi-valeur").value = s.arrondi;

  // Bloc du fond personnalisé : visible et rempli si "perso" est choisi.
  basculerBlocPerso(s.fond === "perso");
  document.getElementById("fond-perso-url").value =
    (s.fondPerso && s.fondPerso.url) || "";
  majExemplesActifs();

  // Bloc du fond vectoriel : visible si "vectoriel" est choisi ; sélecteurs
  // remplis avec la couleur choisie ou la suggestion par défaut.
  basculerBlocVecteur(s.fond === "vectoriel");
  majSegment("vecteur-detail", "detail", s.vecteur.detail);
  majSegment("preset-fond", "preset", s.vecteur.preset || "");
  document.querySelectorAll(".couches-liste input[data-couche]").forEach((inp) => {
    inp.checked = s.vecteur.couches[inp.dataset.couche] !== false;
  });
  document.getElementById("decor-rose").checked = !!(s.decor && s.decor.rose);
  document.getElementById("decor-bordure").checked = !!(s.decor && s.decor.bordure);

  // Réglages des épingles de souvenirs.
  const ep = s.epingles || STYLE_DEFAUT.epingles;
  majSegment("epingle-forme", "forme", ep.forme);
  majPastillesActives("epingle-couleurs", ep.couleur);
  document.getElementById("epingle-couleur-perso").value = ep.couleur;
  document.getElementById("epingle-taille").value = ep.taille;
  document.getElementById("epingle-taille-val").textContent = ep.taille;
  document.getElementById("epingle-numero").checked = ep.numero !== false;
  const simplification = lireSimplification(s.vecteur.simplification, 14);
  majSegment("vecteur-simplification", "simplification", String(simplification));
  document.getElementById("simplification-valeur").value = simplification;
  document.querySelectorAll("#vecteur-bloc input[data-zone]").forEach((inp) => {
    const cat = inp.dataset.zone;
    inp.value = s.vecteur.zones[cat] || SUGGESTIONS_ZONE[cat] || "#888888";
  });
  // Petit rappel affiché quand le fond choisi n'est pas le vectoriel.
  document.getElementById("fond-aide-vectoriel").hidden = s.fond === "vectoriel";

  // Réglages des noms de souvenirs.
  document.getElementById("labels-afficher").checked = s.labels.afficher;
  document.getElementById("labels-reglages").hidden = !s.labels.afficher;
  majBoutonPolice("labels");
  majBoutonPolice("titre");
  majSegment("titre-fond", "titrefond", s.titreFond || "classique");
  majSegment("labels-taille", "taille", String(s.labels.taille));
  document.getElementById("labels-taille-valeur").value =
    TAILLES[s.labels.taille] ? parseInt(TAILLES[s.labels.taille], 10) : s.labels.taille;
  majPastillesActives("labels-couleurs", s.labels.couleur);
}

/** Choisit une couleur de tracé (depuis le nuancier ou le sélecteur). */
function choisirCouleurTrace(couleur) {
  etat.style.trace.couleur = couleur;
  document.getElementById("trace-couleur-perso").value = couleur;
  majPastillesActives("trace-couleurs", couleur);
  appliquerStyleTrace();
  planifierSauvegarde();
}

/** Choisit la couleur des noms de souvenirs. */
function choisirCouleurLabel(couleur) {
  etat.style.labels.couleur = couleur;
  majPastillesActives("labels-couleurs", couleur);
  appliquerStyleLabels();
  planifierSauvegarde();
}

/* ---------- Fond de carte personnalisé ---------- */

/** Crée les boutons d'exemples de fonds personnalisés. */
function construireExemplesFond() {
  const c = document.getElementById("fond-perso-exemples");
  c.innerHTML = "";
  Object.entries(FONDS_EXEMPLES).forEach(([cle, ex]) => {
    const b = document.createElement("button");
    b.className = "fond-exemple-btn";
    b.dataset.exemple = cle;
    b.textContent = ex.libelle;
    b.addEventListener("click", () => choisirExempleFond(cle));
    c.appendChild(b);
  });
}

/** Marque l'exemple actif si l'URL courante correspond à l'un d'eux. */
function majExemplesActifs() {
  const url = (etat.style.fondPerso && etat.style.fondPerso.url) || "";
  document.querySelectorAll("#fond-perso-exemples .fond-exemple-btn").forEach((b) => {
    const ex = FONDS_EXEMPLES[b.dataset.exemple];
    b.classList.toggle("actif", ex && ex.url === url);
  });
}

/** Applique un exemple de fond personnalisé. */
function choisirExempleFond(cle) {
  const ex = FONDS_EXEMPLES[cle];
  if (!ex) return;
  etat.style.fondPerso = {
    url: ex.url,
    maxZoom: ex.maxZoom || 19,
    attribution: ex.attribution || "",
    subdomains: ex.subdomains || "abc",
  };
  etat.style.fond = "perso";
  document.getElementById("fond-perso-url").value = ex.url;
  appliquerFond("perso");
  majExemplesActifs();
  planifierSauvegarde();
}

/** Prend en compte une adresse de tuiles saisie à la main. */
function saisirUrlPerso(url) {
  etat.style.fondPerso.url = url.trim();
  etat.style.fond = "perso";
  majExemplesActifs();
  // On n'applique que si l'adresse est complète (sinon on laisse le fond actuel).
  if (urlTuilesValide(url)) {
    appliquerFond("perso");
    planifierSauvegarde();
  }
}

/** Affiche ou masque le bloc de réglage du fond personnalisé. */
function basculerBlocPerso(visible) {
  document.getElementById("fond-perso-bloc").hidden = !visible;
}

/** Ouvre le panneau Style. */
function ouvrirPanneauStyle() {
  if (etat.mode === "visualisation") return; // édition seulement
  fermerPanneauFond(); // un seul panneau de gauche à la fois
  fermerPanneauCarnets();
  synchroniserControlesStyle();
  document.getElementById("panneau-style").hidden = false;
}

/** Ferme le panneau Style. */
function fermerPanneauStyle() {
  document.getElementById("panneau-style").hidden = true;
}

/* =========================================================
   Édition du fond de carte : panneau, pictogrammes et textes libres
   ========================================================= */

/** Ouvre le panneau Fond de carte. */
function ouvrirPanneauFond() {
  if (etat.mode === "visualisation") return; // édition seulement
  fermerPanneauStyle(); // un seul panneau de gauche à la fois
  fermerPanneauCarnets();
  synchroniserControlesStyle();
  majEditeurAnnotation();
  // Attention : "panneau-fond" (sans -carte) est le voile sombre des pop up !
  document.getElementById("panneau-fond-carte").hidden = false;
}

/** Ferme le panneau Fond de carte (et met fin à la pose en cours). */
function fermerPanneauFond() {
  document.getElementById("panneau-fond-carte").hidden = true;
  desarmerAjoutAnnotation();
  deselectionnerAnnotation();
}

/* ---------- Icônes et marqueurs des annotations ---------- */

/**
 * Fabrique l'icône Leaflet d'une annotation (pictogramme ou texte).
 * Tout le style est porté en ligne pour que la fenêtre d'impression
 * puisse reproduire le même rendu sans dépendre de notre CSS.
 */
function creerIconeAnnotation(a) {
  let contenu;
  if (a.type === "picto") {
    const perso = obtenirPictoPerso(a.picto);
    contenu = perso
      ? `<img class="annot-picto-img" src="${perso.src}" style="height:${a.taille}px" alt="">`
      : `<span class="annot-picto" style="font-size:${a.taille}px">${glyphDePicto(a.picto) || "⛰️"}</span>`;
  } else if (a.type === "image") {
    // Photo posée sur la carte, façon polaroid, avec sa légende.
    const legende = a.legende
      ? `<figcaption>${echapperHtml(a.legende)}</figcaption>`
      : "";
    contenu = `<figure class="annot-image" style="width:${a.taille}px">` +
      `<img src="${a.src}" alt="">${legende}</figure>`;
  } else {
    // Souligné et barré se combinent dans la même propriété CSS.
    const deco = [a.souligne ? "underline" : "", a.barre ? "line-through" : ""]
      .filter(Boolean).join(" ") || "none";
    const css = [
      `font-family:${cssDePolice(a.police)}`,
      `color:${a.couleur}`,
      `font-size:${a.taille}px`,
      `text-align:${ANNOT_ALIGN_CSS[a.align] || "center"}`,
      `font-weight:${a.gras ? "800" : "400"}`,
      `font-style:${a.italique ? "italic" : "normal"}`,
      `text-decoration:${deco}`,
    ].join(";");
    const html = echapperHtml(a.texte || "").replace(/\n/g, "<br>");
    // Les noms de polices contiennent des guillemets : on les échappe pour
    // ne pas couper l'attribut style en plein milieu.
    contenu = `<div class="annot-texte" style="${css.replace(/"/g, "&quot;")}">${html}</div>`;
  }
  const actif = etat.annotationActive === a ? " annot-actif" : "";
  return L.divIcon({
    className: "",
    html: `<div class="annot-wrap${actif}">${contenu}</div>`,
    iconSize: [0, 0], // le contenu se centre lui-même sur le point (CSS)
  });
}

/** Pose (ou repose) le marqueur d'une annotation sur la carte. */
function attacherMarqueurAnnotation(a) {
  const marker = L.marker([a.lat, a.lng], {
    icon: creerIconeAnnotation(a),
    draggable: true,
  })
    .addTo(etat.carte)
    .on("click", () => {
      if (etat.mode === "edition") selectionnerAnnotation(a);
    })
    .on("dragend", (e) => {
      const p = e.target.getLatLng();
      a.lat = p.lat;
      a.lng = p.lng;
      planifierSauvegarde();
    });

  if (etat.mode === "visualisation") marker.dragging.disable();
  a.marker = marker;
  return marker;
}

/** Vrai pour un élément dessiné (trait, forme, dessin) plutôt qu'une épingle. */
function estAnnotationVecteur(a) {
  return a && (a.type === "trait" || a.type === "forme" || a.type === "dessin");
}

/** Redessine une annotation après un changement de réglage. */
function redessinerAnnotation(a) {
  if (!a || !a.marker) return;
  // Les traits, formes et dessins sont des calques Leaflet (pas des icônes) :
  // leur mise à jour est gérée par ui.js.
  if (estAnnotationVecteur(a)) {
    if (typeof majStyleAnnotationVecteur === "function") majStyleAnnotationVecteur(a);
    return;
  }
  a.marker.setIcon(creerIconeAnnotation(a));
}

/** Retire toutes les annotations de la carte et de l'état. */
function effacerAnnotations() {
  etat.annotations.forEach((a) => { if (a.marker) a.marker.remove(); });
  etat.annotations = [];
  etat.annotationActive = null;
  majEditeurAnnotation();
}

/**
 * Pose une annotation sur la carte, selon son type : épingle (picto, texte,
 * photo) ou calque dessiné (trait, forme, dessin — géré par ui.js).
 */
function attacherAnnotation(a) {
  if (estAnnotationVecteur(a)) {
    if (typeof attacherAnnotationVecteur === "function") {
      return attacherAnnotationVecteur(a);
    }
    return null;
  }
  return attacherMarqueurAnnotation(a);
}

/**
 * Reconstruit une annotation à partir de sa forme sauvegardée (en validant
 * chaque champ). Renvoie null si les données sont inutilisables.
 */
function lireAnnotationSauvee(sa) {
  if (!sa) return null;
  const TYPES = ["picto", "texte", "image", "trait", "forme", "dessin"];
  const type = TYPES.includes(sa.type) ? sa.type : "texte";

  // Traits et dessins : une liste de points [lat, lng] suffit.
  if (type === "trait" || type === "dessin") {
    const points = Array.isArray(sa.points)
      ? sa.points.filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number")
      : [];
    if (points.length < 2) return null;
    return {
      id: sa.id,
      type,
      points,
      couleur: typeof sa.couleur === "string" ? sa.couleur : "#b4452f",
      epaisseur: typeof sa.epaisseur === "number" ? sa.epaisseur : 4,
      marker: null,
    };
  }

  // Formes : deux coins (lat/lng et lat2/lng2) + le type de forme.
  if (type === "forme") {
    if ([sa.lat, sa.lng, sa.lat2, sa.lng2].some((v) => typeof v !== "number")) return null;
    return {
      id: sa.id,
      type,
      forme: ["rect", "cercle", "fleche"].includes(sa.forme) ? sa.forme : "rect",
      lat: sa.lat, lng: sa.lng, lat2: sa.lat2, lng2: sa.lng2,
      couleur: typeof sa.couleur === "string" ? sa.couleur : "#b4452f",
      epaisseur: typeof sa.epaisseur === "number" ? sa.epaisseur : 4,
      remplir: !!sa.remplir,
      marker: null,
    };
  }

  // Épingles (picto, texte, photo) : un point + le contenu.
  if (typeof sa.lat !== "number" || typeof sa.lng !== "number") return null;
  // Zoom de référence (les anciens éléments reçoivent un zoom moyen).
  const zoomRef = typeof sa.zoomRef === "number" ? sa.zoomRef : 14;
  if (type === "image") {
    if (typeof sa.src !== "string" || !sa.src) return null;
    return {
      id: sa.id,
      type,
      lat: sa.lat, lng: sa.lng,
      zoomRef,
      src: sa.src,
      legende: typeof sa.legende === "string" ? sa.legende : "",
      taille: typeof sa.taille === "number" ? sa.taille : ANNOT_IMAGE_DEFAUT.taille,
      marker: null,
    };
  }
  const base = type === "picto" ? ANNOT_PICTO_DEFAUT : ANNOT_TEXTE_DEFAUT;
  return {
    id: sa.id,
    type,
    lat: sa.lat, lng: sa.lng,
    zoomRef,
    picto: typeof sa.picto === "string" ? sa.picto : ANNOT_PICTO_DEFAUT.picto,
    texte: typeof sa.texte === "string" ? sa.texte : ANNOT_TEXTE_DEFAUT.texte,
    police: typeof sa.police === "string" ? sa.police : ANNOT_TEXTE_DEFAUT.police,
    couleur: typeof sa.couleur === "string" ? sa.couleur : ANNOT_TEXTE_DEFAUT.couleur,
    taille: typeof sa.taille === "number" ? sa.taille : base.taille,
    align: ANNOT_ALIGN_CSS[sa.align] ? sa.align : ANNOT_TEXTE_DEFAUT.align,
    gras: !!sa.gras,
    italique: !!sa.italique,
    souligne: !!sa.souligne,
    barre: !!sa.barre,
    marker: null,
  };
}

/* ---------- Pose d'une nouvelle annotation ---------- */

/** Passe en mode "pose d'un élément" : le prochain clic sur la carte le place. */
function armerAjoutAnnotation(type) {
  if (etat.mode === "visualisation") return;
  desarmerAjout(); // on ne pose pas un souvenir ET un élément en même temps
  if (typeof desarmerOutil === "function") desarmerOutil(); // ni un dessin
  etat.modeAnnotation = type;
  document.getElementById("map").classList.add("mode-ajout");
  const libelles = {
    picto: "🖌️ Clique sur la carte pour placer le pictogramme.",
    texte: "🖌️ Clique sur la carte pour placer le texte.",
    image: "🖼️ Clique sur la carte pour poser la photo.",
  };
  document.getElementById("banniere-annot-texte").textContent =
    libelles[type] || libelles.texte;
  document.getElementById("banniere-annot").hidden = false;
}

/** Quitte le mode "pose d'un élément". */
function desarmerAjoutAnnotation() {
  etat.modeAnnotation = null;
  document.getElementById("banniere-annot").hidden = true;
  if (!etat.modeAjout) document.getElementById("map").classList.remove("mode-ajout");
}

// Réglages à appliquer au PROCHAIN élément posé (préréglages des onglets
// Textes et Importer : gros titre, texte de lieu, photo importée…).
let annotationPreset = null;

/** Crée une annotation à l'endroit cliqué, puis ouvre son éditeur. */
function creerAnnotation(type, latlng) {
  const base = type === "picto" ? ANNOT_PICTO_DEFAUT
    : type === "image" ? ANNOT_IMAGE_DEFAUT
    : ANNOT_TEXTE_DEFAUT;
  const a = {
    id: prochainIdSouvenir++,
    type,
    lat: latlng.lat,
    lng: latlng.lng,
    // Le zoom au moment de la pose : l'élément garde cette taille à ce zoom,
    // et rétrécit quand on dézoome (voir majEchellesZoom dans ui.js).
    zoomRef: etat.carte.getZoom(),
    ...JSON.parse(JSON.stringify(base)),
    ...(annotationPreset || {}),
    marker: null,
  };
  annotationPreset = null;
  etat.annotations.push(a);
  attacherMarqueurAnnotation(a);
  desarmerAjoutAnnotation();
  selectionnerAnnotation(a);
  // Pour un texte, on met le curseur directement dans le champ de saisie.
  if (type === "texte") {
    const champ = document.getElementById("annot-texte");
    champ.focus();
    champ.select();
  }
  planifierSauvegarde();
}

/* ---------- Sélection et éditeur d'une annotation ---------- */

/** Sélectionne une annotation : cadre visible + éditeur ouvert dans le panneau. */
function selectionnerAnnotation(a) {
  const precedente = etat.annotationActive;
  etat.annotationActive = a;
  if (precedente && precedente !== a) redessinerAnnotation(precedente);
  redessinerAnnotation(a);
  // L'éditeur de l'élément vit dans le tiroir « Élément sélectionné » (ui.js).
  if (typeof ouvrirPanneauElement === "function") ouvrirPanneauElement();
  majEditeurAnnotation();
}

/** Désélectionne l'annotation en cours (referme l'éditeur). */
function deselectionnerAnnotation() {
  const a = etat.annotationActive;
  if (!a) return;
  etat.annotationActive = null;
  redessinerAnnotation(a);
  majEditeurAnnotation();
}

/** Recale l'éditeur du panneau sur l'annotation sélectionnée (ou le cache). */
function majEditeurAnnotation() {
  const a = etat.annotationActive;
  const editeur = document.getElementById("annot-editeur");
  editeur.hidden = !a;
  const vide = document.getElementById("element-vide");
  if (vide) vide.hidden = !!a;
  if (!a) return;

  const titres = {
    picto: "Pictogramme sélectionné",
    texte: "Texte sélectionné",
    image: "Photo sélectionnée",
    trait: "Trait sélectionné",
    forme: "Forme sélectionnée",
    dessin: "Dessin sélectionné",
  };
  document.getElementById("annot-editeur-titre").textContent =
    titres[a.type] || "Élément sélectionné";
  document.getElementById("annot-bloc-texte").hidden = a.type !== "texte";
  document.getElementById("annot-bloc-picto").hidden = a.type !== "picto";
  const blocImage = document.getElementById("annot-bloc-image");
  if (blocImage) blocImage.hidden = a.type !== "image";
  const blocVecteur = document.getElementById("annot-bloc-vecteur");
  if (blocVecteur) blocVecteur.hidden = !estAnnotationVecteur(a);

  // Curseur de taille (texte, picto, photo) — sans objet pour les dessins.
  const blocTaille = document.getElementById("annot-bloc-taille");
  if (blocTaille) blocTaille.hidden = estAnnotationVecteur(a);
  if (!estAnnotationVecteur(a)) {
    const bornes = ANNOT_TAILLES[a.type] || ANNOT_TAILLES.texte;
    const curseur = document.getElementById("annot-taille");
    curseur.min = bornes.min;
    curseur.max = bornes.max;
    curseur.value = a.taille;
    document.getElementById("annot-taille-val").textContent = a.taille;
  }

  if (a.type === "texte") {
    document.getElementById("annot-texte").value = a.texte || "";
    document.getElementById("annot-couleur").value = a.couleur;
    majBoutonPolice("annot");
    majSegment("annot-align", "align", a.align);
    document.getElementById("annot-gras").classList.toggle("actif", !!a.gras);
    document.getElementById("annot-italique").classList.toggle("actif", !!a.italique);
    const soul = document.getElementById("annot-souligne");
    if (soul) soul.classList.toggle("actif", !!a.souligne);
    const barre = document.getElementById("annot-barre");
    if (barre) barre.classList.toggle("actif", !!a.barre);
  } else if (a.type === "picto") {
    majAnnotPictoBouton(a.picto);
  } else if (a.type === "image") {
    const champ = document.getElementById("annot-legende");
    if (champ) champ.value = a.legende || "";
  } else if (estAnnotationVecteur(a)) {
    document.getElementById("annot-trait-couleur").value = a.couleur || "#b4452f";
    const ep = document.getElementById("annot-trait-epaisseur");
    ep.value = a.epaisseur || 4;
    document.getElementById("annot-trait-epaisseur-val").textContent = ep.value;
    const remplirLigne = document.getElementById("annot-remplir-ligne");
    remplirLigne.hidden = a.type !== "forme" || a.forme === "fleche";
    document.getElementById("annot-remplir").checked = !!a.remplir;
  }
}

/** Affiche le pictogramme courant sur le bouton "Changer de pictogramme". */
function majAnnotPictoBouton(cle) {
  const el = document.getElementById("annot-picto-glyph");
  const perso = obtenirPictoPerso(cle);
  if (perso) el.innerHTML = `<img src="${perso.src}" alt="">`;
  else el.textContent = glyphDePicto(cle) || "⛰️";
}

/** Modifie l'annotation sélectionnée et redessine son marqueur. */
function majAnnotationActive(champs) {
  const a = etat.annotationActive;
  if (!a) return;
  Object.assign(a, champs);
  redessinerAnnotation(a);
  planifierSauvegarde();
}

/** Supprime l'annotation sélectionnée (annulable pendant quelques secondes). */
function supprimerAnnotationActive() {
  const a = etat.annotationActive;
  if (!a) return;
  if (a.marker) a.marker.remove();
  etat.annotations = etat.annotations.filter((x) => x !== a);
  etat.annotationActive = null;
  majEditeurAnnotation();
  planifierSauvegarde();
  toastAvecAction("Élément supprimé.", "Annuler", () => {
    a.marker = null;
    etat.annotations.push(a);
    attacherAnnotation(a);
    planifierSauvegarde();
  });
}

/* =========================================================
   Plusieurs carnets sur la même carte
   ---------------------------------------------------------
   Un seul carnet est OUVERT (modifiable) à la fois. En mode
   visualisation, on peut AFFICHER d'autres carnets en plus :
   leur trace et leurs épingles apparaissent, consultables en
   lecture seule (on les appelle des carnets "affichés en plus",
   gérés dans etat.fantomes).
   ========================================================= */

/** La fiche (id, nom, visible) du carnet actuellement ouvert. */
function carnetActif() {
  return etat.carnets.find((c) => c.id === etat.carnetActifId) || null;
}

/**
 * Identifiant universel d'un carnet : contrairement au petit numéro local
 * (1, 2, 3…), il est unique entre appareils — c'est lui qui sert de clé
 * pour la sauvegarde en ligne.
 */
function genUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Repli pour les très vieux navigateurs.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Garde-fou : tant que l'index n'a pas été lu correctement au démarrage,
// on n'écrit RIEN (sinon un raté de lecture écraserait la liste des carnets).
let indexCarnetsPret = false;

/**
 * Plage de dates du carnet OUVERT (du plus ancien au plus récent souvenir).
 * Rangée dans l'index pour que l'accueil puisse filtrer sans tout charger.
 */
function calculerPlageDates() {
  const dates = [];
  [...etat.souvenirs, ...etat.stock].forEach((s) => {
    (s.dates || []).forEach((d) => { if (typeof d === "string" && d) dates.push(d); });
  });
  if (dates.length === 0) return { du: "", au: "" };
  dates.sort(); // les dates ISO (AAAA-MM-JJ) se trient par ordre alphabétique
  return { du: dates[0], au: dates[dates.length - 1] };
}

/** Enregistre l'index des carnets (liste + carnet ouvert). */
async function sauverIndexCarnets() {
  if (!indexCarnetsPret) return;
  // On rafraîchit la plage de dates du carnet ouvert au passage.
  const actif = carnetActif();
  if (actif && etat.trace) {
    const plage = calculerPlageDates();
    actif.du = plage.du;
    actif.au = plage.au;
  }
  await dbSauverCle("index", {
    carnets: etat.carnets.map((c) => ({
      id: c.id,
      uuid: c.uuid || "",
      nom: c.nom,
      visible: !!c.visible,
      logo: c.logo || "",
      categorie: c.categorie || "",
      description: c.description || "",
      du: c.du || "",
      au: c.au || "",
      modifieLe: c.modifieLe || "",
      // Carnet partagé AVEC MOI : qui en est propriétaire, et mon droit.
      partage: c.partage ? { proprietaire: c.partage.proprietaire, droit: c.partage.droit } : null,
    })),
    actifId: etat.carnetActifId,
  });
}

/**
 * Au démarrage : lit l'index des carnets (en migrant l'ancien format à un
 * seul carnet si besoin), puis recharge le carnet ouvert.
 */
async function demarrerCarnets() {
  try {
    let index = await dbChargerCle("index");

    // Migration depuis l'ancien format (un seul carnet sous la clé "actuel").
    if (!index) {
      const ancien = await dbChargerCle("actuel");
      if (ancien && ancien.trace) {
        index = {
          carnets: [{ id: 1, nom: ancien.trace.name || "Mon carnet", visible: true }],
          actifId: 1,
        };
        await dbSauverCle("carnet-1", ancien);
        await dbSauverCle("index", index);
        await dbEffacerCle("actuel");
      }
    }

    if (!index || !Array.isArray(index.carnets) || index.carnets.length === 0) {
      // Tout premier démarrage : aucun carnet — l'accueil proposera d'en
      // créer un (ou de se connecter pour retrouver les siens).
      etat.carnets = [];
      etat.carnetActifId = 0;
      indexCarnetsPret = true; // lecture réussie (il n'y avait rien) : on peut écrire
      return;
    }

    etat.carnets = index.carnets.map((c) => ({
      id: c.id,
      // Les carnets d'avant la sauvegarde en ligne reçoivent leur identifiant
      // universel au premier démarrage.
      uuid: (typeof c.uuid === "string" && c.uuid) ? c.uuid : genUuid(),
      nom: c.nom || "Carnet",
      visible: c.visible !== false,
      logo: typeof c.logo === "string" ? c.logo : "",
      categorie: typeof c.categorie === "string" ? c.categorie : "",
      description: typeof c.description === "string" ? c.description : "",
      du: typeof c.du === "string" ? c.du : "",
      au: typeof c.au === "string" ? c.au : "",
      modifieLe: typeof c.modifieLe === "string" ? c.modifieLe : "",
      partage: (c.partage && typeof c.partage.proprietaire === "string")
        ? { proprietaire: c.partage.proprietaire, droit: c.partage.droit === "edition" ? "edition" : "lecture" }
        : null,
    }));
    // Ménage : l'ancien « Mon carnet » créé automatiquement par les vieilles
    // versions disparaît s'il est resté vide (pas de trace, pas de fiche).
    const aGarder = [];
    for (const c of etat.carnets) {
      const vide = c.nom === "Mon carnet" && !c.logo && !c.categorie && !c.description;
      if (vide) {
        const donnees = await dbChargerCle("carnet-" + c.id).catch(() => null);
        if (!donnees || !donnees.trace) {
          try { await dbEffacerCle("carnet-" + c.id); } catch (e) {}
          continue;
        }
      }
      aGarder.push(c);
    }
    etat.carnets = aGarder;

    etat.carnetActifId = etat.carnets.some((c) => c.id === index.actifId)
      ? index.actifId
      : (etat.carnets[0] ? etat.carnets[0].id : 0);
    indexCarnetsPret = true; // l'index a bien été lu : les écritures sont sûres

    if (etat.carnetActifId) {
      const donnees = await dbChargerCle("carnet-" + etat.carnetActifId);
      if (donnees && donnees.trace) restaurerCarnet(donnees);
    }
  } catch (e) {
    // IndexedDB indisponible : on démarre à vide, sans bruit.
    if (!Array.isArray(etat.carnets)) etat.carnets = [];
    if (etat.carnets.length === 0) etat.carnetActifId = 0;
  }
}

/**
 * Vide l'écran du carnet courant (sans toucher aux sauvegardes) : utilisé
 * quand on ouvre un carnet encore vide ou qu'on réinitialise.
 */
function viderCarnetCourant() {
  desarmerAjout();
  fermerPanneauFond(); // met aussi fin à la pose d'un pictogramme/texte
  effacerSouvenirs();
  effacerAnnotations();
  etat.stock = [];
  etat.pictosPerso = [];
  construirePictos();
  fermerReserve();
  if (etat.coucheTrace) { etat.coucheTrace.remove(); etat.coucheTrace = null; }
  etat.trace = null;
  etat.gpxListe = [];
  etat.chargeOk = true; // état vide voulu (pas un raté de chargement)
  if (typeof renderGpxListe === "function") renderGpxListe();
  prochainIdSouvenir = 1;

  etat.style = JSON.parse(JSON.stringify(STYLE_DEFAUT));
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);
  appliquerFiltreFond();
  appliquerTitre();
  appliquerDecor();
  fermerPanneauStyle();

  etat.carte.setView([46.6, 2.5], 6);

  // On masque les boutons liés à une trace et on réaffiche l'accueil.
  ["btn-mode", "btn-ajout-souvenir", "btn-reserve", "btn-trier-dates", "btn-filtrer",
   "btn-style", "btn-fond", "btn-exporter", "btn-export-affiche", "btn-export-png",
   "btn-reinitialiser", "fab-ajout", "fab-recentrer"]
    .forEach((id) => { document.getElementById(id).hidden = true; });
  document.getElementById("trace-info").hidden = true;
  document.getElementById("welcome").hidden = false;
}

/** Ouvre un autre carnet (le carnet courant est d'abord sauvegardé). */
async function ouvrirCarnet(id) {
  if (id === etat.carnetActifId) return;
  await sauvegarderMaintenant(); // le carnet courant est mis à l'abri
  retirerTousFantomes();

  etat.carnetActifId = id;
  let donnees = null;
  try { donnees = await dbChargerCle("carnet-" + id); } catch (e) {}

  if (donnees && donnees.trace) {
    restaurerCarnet(donnees);
  } else {
    viderCarnetCourant(); // carnet encore vide : écran d'accueil
  }
  definirMode("edition"); // on repasse en édition sur le carnet ouvert
  await sauverIndexCarnets();
  renderCarnets();
  toast(`Carnet « ${carnetActif().nom} » ouvert`);
}

/** Crée un nouveau carnet vide et l'ouvre. */
async function nouveauCarnet() {
  const nom = await demanderTexte("Nom du nouveau carnet", "Nouveau carnet", "Créer");
  if (!nom) return;
  await sauvegarderMaintenant();
  retirerTousFantomes();

  const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
  etat.carnets.push({ id, uuid: genUuid(), nom, visible: true, logo: "", categorie: "", description: "", modifieLe: new Date().toISOString() });
  etat.carnetActifId = id;
  viderCarnetCourant();
  await sauverIndexCarnets();
  renderCarnets();
  toast(`Carnet « ${nom} » créé — charge un fichier GPX pour commencer`);
}

/** Renomme un carnet. */
async function renommerCarnet(carnet) {
  const nom = await demanderTexte("Renommer le carnet", carnet.nom, "Renommer");
  if (!nom || nom === carnet.nom) return;
  carnet.nom = nom;
  await sauverIndexCarnets();
  renderCarnets();
  // Le bandeau en bas à gauche affiche le nom du carnet ouvert.
  if (carnet.id === etat.carnetActifId && etat.trace) majBandeauInfos(etat.trace);
}

/** Supprime un carnet (avec confirmation). */
async function supprimerCarnet(carnet) {
  const ok = await demanderConfirmation(
    `Supprimer « ${carnet.nom} » ?`,
    "Sa trace, ses souvenirs, photos et audios seront définitivement effacés. " +
    "Pense à l'ouvrir et à « Sauvegarder (.json) » d'abord si tu veux le conserver.",
    { okLibelle: "Supprimer" }
  );
  if (!ok) return;

  retirerFantome(carnet.id);
  try { await dbEffacerCle("carnet-" + carnet.id); } catch (e) {}
  // S'il est aussi sauvegardé en ligne, on l'y supprime également.
  if (typeof supprimerCarnetNuage === "function") supprimerCarnetNuage(carnet);
  etat.carnets = etat.carnets.filter((c) => c.id !== carnet.id);

  // Si on vient de supprimer le carnet ouvert, on bascule sur un autre.
  if (carnet.id === etat.carnetActifId) {
    if (etat.carnets.length === 0) {
      // Plus aucun carnet : l'accueil proposera d'en créer un.
      etat.carnetActifId = 0;
      viderCarnetCourant();
      if (typeof majPopupsAccueil === "function") majPopupsAccueil();
    } else {
      etat.carnetActifId = etat.carnets[0].id;
      let donnees = null;
      try { donnees = await dbChargerCle("carnet-" + etat.carnetActifId); } catch (e) {}
      if (donnees && donnees.trace) restaurerCarnet(donnees);
      else viderCarnetCourant();
    }
  }
  await sauverIndexCarnets();
  renderCarnets();
  toast(`Carnet « ${carnet.nom} » supprimé`);
}

/* ---------- Panneau « Mes carnets » ---------- */

function ouvrirPanneauCarnets() {
  fermerPanneauStyle();
  fermerPanneauFond();
  fermerPanneauFiltre();
  renderCarnets();
  document.getElementById("panneau-carnets").hidden = false;
}

function fermerPanneauCarnets() {
  document.getElementById("panneau-carnets").hidden = true;
}

/** (Re)construit la liste des carnets dans l'onglet Carnets. */
function renderCarnets() {
  const liste = document.getElementById("carnets-liste");
  liste.innerHTML = "";

  etat.carnets.forEach((c) => {
    const actif = c.id === etat.carnetActifId;
    const ligne = document.createElement("div");
    ligne.className = "carnet-ligne" + (actif ? " carnet-ligne-actif" : "");

    const nom = document.createElement("span");
    nom.className = "carnet-nom";
    nom.textContent = (c.logo ? c.logo + " " : "") + c.nom + (actif ? " — ouvert" : "");
    ligne.appendChild(nom);

    const actions = document.createElement("span");
    actions.className = "carnet-actions";
    if (!actif) {
      const ouvrir = document.createElement("button");
      ouvrir.className = "btn btn-ghost btn-petit";
      ouvrir.textContent = "Ouvrir";
      ouvrir.addEventListener("click", () => ouvrirCarnet(c.id));
      actions.appendChild(ouvrir);
    }
    const suppr = document.createElement("button");
    suppr.className = "icone-btn";
    suppr.title = "Supprimer ce carnet";
    suppr.textContent = "🗑";
    suppr.addEventListener("click", () => supprimerCarnet(c));
    actions.appendChild(suppr);

    ligne.appendChild(actions);
    liste.appendChild(ligne);
  });

  // La nouvelle interface (accueil, fiche d'identité, barre du haut) se met
  // à jour en même temps.
  if (typeof majInterfaceCarnets === "function") majInterfaceCarnets();
}

/* ---------- Carnets affichés en plus (mode visualisation) ---------- */

/** Coche/décoche l'affichage d'un carnet sur la carte (visualisation). */
async function basculerVisibiliteCarnet(carnet, visible) {
  carnet.visible = visible;
  await sauverIndexCarnets();
  if (etat.mode !== "visualisation" || carnet.id === etat.carnetActifId) return;
  if (visible) afficherFantome(carnet.id);
  else retirerFantome(carnet.id);
}

/** Charge et affiche un carnet en plus sur la carte (lecture seule). */
async function afficherFantome(id) {
  if (etat.fantomes.has(id) || id === etat.carnetActifId) return;
  let donnees = null;
  try { donnees = await dbChargerCle("carnet-" + id); } catch (e) {}
  // Un carnet encore vide (pas de trace) n'a simplement rien à afficher.
  if (!donnees || !donnees.trace) return;

  const couche = L.layerGroup().addTo(etat.carte);

  // Sur la carte globale, un carnet ne montre QUE son tracé et son nom
  // (au style du carnet) — le détail se découvre en l'ouvrant.
  const t = (donnees.style && donnees.style.trace) || { couleur: "#8a8a8a", epaisseur: 3, type: "plein" };
  const points = [];
  donnees.trace.segments.forEach((seg) => {
    seg.forEach((p) => points.push(p));
    L.polyline(seg, {
      color: t.couleur,
      weight: t.epaisseur,
      opacity: 0.85,
      dashArray: TYPES_LIGNE[t.type],
    }).addTo(couche);
  });

  // Le nom du carnet, posé au centre de son tracé, dans sa police de titre.
  const fiche = etat.carnets.find((c) => c.id === id);
  if (fiche && points.length) {
    const centre = L.latLngBounds(points).getCenter();
    L.marker(centre, {
      icon: creerEtiquetteCarnet(fiche, donnees.style),
      interactive: true,
    })
      .on("click", () => {
        if (typeof zoomerSurCarnet === "function") zoomerSurCarnet(id);
      })
      .addTo(couche);
  }

  const fantome = { couche, souvenirs: [], trace: donnees.trace, pictosPerso: [] };
  etat.fantomes.set(id, fantome);
}

/** L'étiquette « nom du carnet » affichée sur la carte globale. */
function creerEtiquetteCarnet(fiche, style) {
  const police = cssDePolice((style && style.titrePolice) || "titre");
  const couleur = (style && style.trace && style.trace.couleur) || "#2f3b34";
  const texte = `${fiche.logo ? echapperHtml(fiche.logo) + " " : ""}${echapperHtml(fiche.nom)}`;
  const css = [
    `font-family:${police.replace(/"/g, "&quot;")}`,
    "font-size:15px",
    "font-weight:700",
    `color:${couleur}`,
    "white-space:nowrap",
    "text-shadow:0 1px 3px rgba(255,255,255,0.95), 0 -1px 3px rgba(255,255,255,0.95), 1px 0 3px rgba(255,255,255,0.95), -1px 0 3px rgba(255,255,255,0.95)",
    "transform:translate(-50%,-50%)",
    "cursor:pointer",
  ].join(";");
  return L.divIcon({
    className: "",
    html: `<div style="${css}">${texte}</div>`,
    iconSize: [0, 0],
  });
}

/** Retire un carnet affiché en plus. */
function retirerFantome(id) {
  const f = etat.fantomes.get(id);
  if (!f) return;
  // Si la fiche ouverte appartient à ce carnet, on la ferme d'abord.
  if (etat.souvenirActif && f.souvenirs.includes(etat.souvenirActif)) fermerPanneau();
  f.couche.remove();
  etat.fantomes.delete(id);
}

/** Retire tous les carnets affichés en plus. */
function retirerTousFantomes() {
  [...etat.fantomes.keys()].forEach(retirerFantome);
}

/** À l'entrée en visualisation : affiche les carnets cochés « visibles ». */
function majFantomes() {
  if (etat.mode !== "visualisation") {
    retirerTousFantomes();
    return;
  }
  etat.carnets.forEach((c) => {
    if (c.id !== etat.carnetActifId && c.visible) afficherFantome(c.id);
  });
}

/* =========================================================
   ÉTAPE 4 — Sauvegarde locale, export et import
   ========================================================= */

/**
 * Transforme l'état courant en un objet simple (sans éléments Leaflet),
 * adapté à la sauvegarde et à l'export en fichier.
 */
function serialiserCarnet() {
  const carnet = carnetActif();
  return {
    version: 1,
    // L'identité du carnet (logo, catégorie, description) voyage avec le
    // fichier exporté, pour la retrouver à l'import sur un autre appareil.
    meta: carnet ? {
      nom: carnet.nom,
      logo: carnet.logo || "",
      categorie: carnet.categorie || "",
      description: carnet.description || "",
    } : null,
    trace: etat.trace,
    // Chaque GPX du carnet (etat.trace ci-dessus est leur réunion, gardée
    // pour la fenêtre d'impression et les anciennes versions).
    gpx: etat.gpxListe.map((g) => ({
      id: g.id, nom: g.nom, segments: g.segments, waypoints: g.waypoints,
    })),
    style: etat.style,
    prochainId: prochainIdSouvenir,
    // Pictogrammes personnalisés importés par l'utilisateur.
    pictosPerso: etat.pictosPerso.map((p) => ({ id: p.id, nom: p.nom, src: p.src })),
    // Souvenirs "en réserve" (sans position).
    stock: etat.stock.map((s) => ({
      id: s.id,
      nom: s.nom,
      photos: s.photos,
      couverture: s.couverture,
      textes: s.textes,
      pictogramme: s.pictogramme || "souvenir",
      dates: s.dates || [],
      audios: s.audios || [],
    })),
    souvenirs: etat.souvenirs.map((s) => ({
      id: s.id,
      nom: s.nom,
      lat: s.lat,
      lng: s.lng,
      photos: s.photos,        // [{ src, legende }]
      couverture: s.couverture,
      textes: s.textes,
      pictogramme: s.pictogramme || "souvenir",
      dates: s.dates || [],               // dates ISO ("2026-07-14")
      audios: s.audios || [],             // [{ src, legende, duree }]
    })),
    // Éléments posés librement sur le fond de carte : pictogrammes, textes,
    // photos, traits, formes et dessins.
    annotations: etat.annotations.map((a) => ({
      id: a.id,
      type: a.type,
      lat: a.lat,
      lng: a.lng,
      picto: a.picto,
      texte: a.texte,
      police: a.police,
      couleur: a.couleur,
      taille: a.taille,
      align: a.align,
      gras: a.gras,
      italique: a.italique,
      souligne: a.souligne,
      barre: a.barre,
      zoomRef: a.zoomRef,
      // Photo posée sur la carte.
      src: a.src,
      legende: a.legende,
      // Traits, formes et dessins.
      points: a.points,       // [[lat, lng], …]
      forme: a.forme,         // "rect" | "cercle" | "fleche"
      lat2: a.lat2,
      lng2: a.lng2,
      epaisseur: a.epaisseur,
      remplir: a.remplir,
    })),
  };
}

/** Lit un tableau de dates sauvegardé (en ignorant ce qui n'est pas une chaîne). */
function lireDates(dates) {
  return Array.isArray(dates) ? dates.filter((d) => typeof d === "string") : [];
}

/** Lit un tableau d'enregistrements audio sauvegardé. */
function lireAudios(audios) {
  if (!Array.isArray(audios)) return [];
  return audios
    .filter((a) => a && typeof a.src === "string")
    .map((a) => ({ src: a.src, legende: a.legende || "", duree: a.duree || 0 }));
}

/** Retire tous les souvenirs (et leurs marqueurs) de la carte. */
function effacerSouvenirs() {
  etat.souvenirs.forEach((s) => {
    if (s.marker) etat.grappe.removeLayer(s.marker);
    retirerLabel(s);
  });
  etat.souvenirs = [];
  fermerPanneau();
}

/**
 * Reconstruit l'application à partir d'un carnet (objet simple) : la trace,
 * puis chaque souvenir avec son marqueur. Renvoie false si le carnet est vide.
 */
function restaurerCarnet(donnees) {
  if (!donnees || !donnees.trace) return false;

  // On reconstitue d'abord le style : afficherTrace l'utilise pour dessiner.
  etat.style = fusionnerStyle(donnees.style);

  // Les pictogrammes personnalisés, AVANT les souvenirs : leurs épingles en ont besoin.
  etat.pictosPerso = Array.isArray(donnees.pictosPerso)
    ? donnees.pictosPerso.map((p) => ({ id: p.id, nom: p.nom || "Pictogramme", src: p.src }))
    : [];
  construirePictos();

  // La réserve (souvenirs sans position).
  etat.stock = (donnees.stock || []).map((s) => ({
    id: s.id,
    nom: s.nom || "",
    photos: Array.isArray(s.photos) ? s.photos : [],
    couverture: s.couverture === undefined ? null : s.couverture,
    textes: s.textes || "",
    pictogramme: s.pictogramme || "souvenir",
    dates: lireDates(s.dates),
    audios: lireAudios(s.audios),
  }));

  effacerSouvenirs();

  // Les GPX du carnet (les anciens carnets n'en avaient qu'un : on l'emballe).
  etat.gpxListe = Array.isArray(donnees.gpx) && donnees.gpx.length
    ? donnees.gpx.map((g) => ({
        id: g.id, nom: g.nom || "Trace",
        segments: Array.isArray(g.segments) ? g.segments : [],
        waypoints: Array.isArray(g.waypoints) ? g.waypoints : [],
      }))
    : [{
        id: 0, nom: donnees.trace.name || "Trace",
        segments: donnees.trace.segments, waypoints: donnees.trace.waypoints,
      }];
  afficherTrace(fusionnerTraces());
  if (typeof renderGpxListe === "function") renderGpxListe();

  (donnees.souvenirs || []).forEach((sv) => {
    const souvenir = {
      id: sv.id,
      nom: sv.nom || "",
      lat: sv.lat,
      lng: sv.lng,
      photos: Array.isArray(sv.photos) ? sv.photos : [],
      couverture: sv.couverture === undefined ? null : sv.couverture,
      textes: sv.textes || "",
      pictogramme: sv.pictogramme || "souvenir",
      dates: lireDates(sv.dates),
      audios: lireAudios(sv.audios),
      marker: null,
      label: null,
    };
    etat.souvenirs.push(souvenir);
    attacherMarqueur(souvenir);
  });

  renumeroterSouvenirs();

  // Les éléments posés sur le fond de carte (pictos, textes, photos, dessins).
  effacerAnnotations();
  (donnees.annotations || []).forEach((sa) => {
    const a = lireAnnotationSauvee(sa);
    if (!a) return;
    etat.annotations.push(a);
    attacherAnnotation(a);
  });

  // On reprend le compteur d'identifiants là où il en était
  // (souvenirs + réserve + pictos + annotations + GPX).
  const maxId = [...etat.souvenirs, ...etat.stock, ...etat.pictosPerso,
    ...etat.annotations, ...etat.gpxListe]
    .reduce((m, s) => Math.max(m, s.id || 0), 0);
  prochainIdSouvenir = Math.max(donnees.prochainId || 1, maxId + 1);

  // On applique fond, ambiance, titre et style de trace, + les contrôles.
  appliquerStyleComplet();
  etat.chargeOk = true;
  if (typeof majEchellesZoom === "function") majEchellesZoom();
  return true;
}

/* ---------- Sauvegarde automatique (différée) ---------- */
// On attend ~0,6 s après la dernière modification avant d'écrire, pour ne
// pas sauvegarder à chaque frappe de clavier.
let timerSauvegarde = null;
function planifierSauvegarde() {
  clearTimeout(timerSauvegarde);
  timerSauvegarde = setTimeout(sauvegarderMaintenant, 600);
  // Les listes de la nouvelle interface (souvenirs, photos posées…) suivent
  // les modifications, avec le même léger différé.
  if (typeof planifierMajListes === "function") planifierMajListes();
}

async function sauvegarderMaintenant() {
  try {
    // Sans carnet ouvert (tout premier démarrage), il n'y a rien à écrire.
    if (!carnetActif()) return;
    const cle = "carnet-" + etat.carnetActifId;
    // Garde-fou : on ne remplace JAMAIS un carnet sauvegardé (avec trace)
    // par un état vide issu d'un chargement raté. (Si l'utilisateur a
    // volontairement retiré tous les GPX, chargeOk est vrai : on écrit.)
    if (!etat.trace && !etat.chargeOk) {
      const existant = await dbChargerCle(cle).catch(() => null);
      if (existant && existant.trace) return;
    }
    // On horodate la modification : c'est ce qui permet à la sauvegarde en
    // ligne de savoir quelle version (appareil ou nuage) est la plus récente.
    const actif = carnetActif();
    if (actif && etat.trace) actif.modifieLe = new Date().toISOString();
    await dbSauverCle(cle, serialiserCarnet());
    await sauverIndexCarnets();
    indiquerEnregistre();
    // Et on programme l'envoi en ligne (si on est connecté à un compte).
    if (typeof planifierPousseeNuage === "function") planifierPousseeNuage();
  } catch (e) {
    toast("La sauvegarde locale a échoué (stockage plein ?).", true);
  }
}

/** Affiche brièvement l'indicateur "✓ Enregistré" dans la barre du haut. */
let timerStatut = null;
function indiquerEnregistre() {
  const el = document.getElementById("statut-sauvegarde");
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("visible"));
  clearTimeout(timerStatut);
  timerStatut = setTimeout(() => el.classList.remove("visible"), 1600);
}

/* ---------- Export / Import en fichier .json ---------- */

/** Télécharge le carnet courant sous forme d'un fichier .json autonome. */
function exporterCarnet() {
  if (!etat.trace) {
    toast("Charge d'abord une trace avant d'exporter.", true);
    return;
  }
  const json = JSON.stringify(serialiserCarnet());
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const carnet = carnetActif();
  const nomBrut = (carnet && carnet.nom) || etat.trace.name || "carnet";
  const nomFichier = "carnet-" + nomBrut.replace(/[^\w\-]+/g, "_");

  const a = document.createElement("a");
  a.href = url;
  a.download = `${nomFichier}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Carnet exporté");
}

/* ---------- Export de la carte en image PNG ----------
   On utilise dom-to-image-more (bien plus fidèle que html2canvas avec les
   cartes Leaflet/MapLibre : transformations, polices, calques). Le canvas
   WebGL du fond vectoriel est d'abord FIGÉ en image, car un canvas ne
   survit pas au clonage de la page pendant la capture. */

// La bibliothèque de capture est chargée seulement au premier export.
let domToImagePromesse = null;
function chargerDomToImage() {
  if (window.domtoimage) return Promise.resolve(window.domtoimage);
  if (!domToImagePromesse) {
    domToImagePromesse = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/dom-to-image-more@3.5.0/dist/dom-to-image-more.min.js";
      script.onload = () => resolve(window.domtoimage);
      script.onerror = () => {
        domToImagePromesse = null;
        reject(new Error("Bibliothèque d'export indisponible"));
      };
      document.head.appendChild(script);
    });
  }
  return domToImagePromesse;
}

/** Dessine un élément SVG (trace, rose des vents…) sur le canvas de sortie. */
async function dessinerSvgSurCanvas(ctx, svg, r) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.style.transform = ""; // pas de position d'écran dans l'image
  const texte = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  await new Promise((ok, ko) => {
    image.onload = ok;
    image.onerror = () => ko(new Error("SVG illisible"));
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(texte);
  });
  ctx.drawImage(image, r.x, r.y, r.l, r.h);
}

/**
 * Compose l'image de la carte couche par couche, dans un canvas :
 * fond (tuiles ou vectoriel) → trace → parchemin → épingles/étiquettes/textes
 * (rendus un par un : un élément récalcitrant n'efface pas les autres) →
 * décor (bordure, rose des vents) et titre. Renvoie le canvas.
 * `zone` peut appartenir à une autre fenêtre (l'affiche) ; `domtoimage` est
 * l'instance de la bibliothèque de capture chargée dans cette fenêtre-là.
 */
async function composerImageCarte(zone, echelle, domtoimage) {
  const doc = zone.ownerDocument;
  const rZone = zone.getBoundingClientRect();
  const L2 = Math.max(1, Math.round(rZone.width * echelle));
  const H2 = Math.max(1, Math.round(rZone.height * echelle));

  const sortie = doc.createElement("canvas");
  sortie.width = L2;
  sortie.height = H2;
  const ctx = sortie.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, L2, H2);

  // Position d'un élément dans l'image (par rapport au coin de la zone).
  const rectDe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - rZone.left) * echelle,
      y: (r.top - rZone.top) * echelle,
      l: r.width * echelle,
      h: r.height * echelle,
    };
  };
  const visible = (r) => r.l > 0 && r.h > 0 && r.x < L2 && r.y < H2 && r.x + r.l > 0 && r.y + r.h > 0;

  // 1) Le fond : tuiles d'images (fonds classiques) et/ou canvas vectoriel,
  //    composés d'abord à part pour recevoir la teinte d'ambiance d'un bloc.
  const fond = doc.createElement("canvas");
  fond.width = L2;
  fond.height = H2;
  const fctx = fond.getContext("2d");
  zone.querySelectorAll(".leaflet-tile-pane img.leaflet-tile").forEach((tuile) => {
    if (!tuile.complete || !tuile.naturalWidth) return;
    const r = rectDe(tuile);
    if (!visible(r)) return;
    try { fctx.drawImage(tuile, r.x, r.y, r.l, r.h); } catch (e) { /* tuile non exportable */ }
  });
  const canvasGl = zone.querySelector("canvas.maplibregl-canvas");
  if (canvasGl) {
    const r = rectDe(canvasGl);
    try { fctx.drawImage(canvasGl, r.x, r.y, r.l, r.h); } catch (e) {}
  }
  const paneTuiles = zone.querySelector(".leaflet-tile-pane");
  const filtreAmbiance = paneTuiles ? doc.defaultView.getComputedStyle(paneTuiles).filter : "none";
  ctx.filter = (filtreAmbiance && filtreAmbiance !== "none") ? filtreAmbiance : "none";
  ctx.drawImage(fond, 0, 0);
  ctx.filter = "none";

  // 2) La trace (et les repères ronds) : calques SVG de Leaflet.
  for (const svg of zone.querySelectorAll(".leaflet-overlay-pane svg")) {
    const r = rectDe(svg);
    if (!visible(r)) continue;
    try { await dessinerSvgSurCanvas(ctx, svg, r); } catch (e) {}
  }

  // 3) Le grain de parchemin (fondu "multiply", comme à l'écran).
  const parchemin = doc.getElementById("parchemin");
  if (parchemin && doc.defaultView.getComputedStyle(parchemin).display !== "none") {
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = doc.defaultView.getComputedStyle(parchemin).backgroundColor;
    ctx.fillRect(0, 0, L2, H2);
    const vignette = ctx.createRadialGradient(
      L2 / 2, H2 / 2, Math.min(L2, H2) * 0.32,
      L2 / 2, H2 / 2, Math.hypot(L2, H2) / 2
    );
    vignette.addColorStop(0, "rgba(120,85,40,0)");
    vignette.addColorStop(1, "rgba(78,52,22,0.6)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, L2, H2);
    ctx.globalCompositeOperation = "source-over";
  }

  // Rendu d'un élément HTML isolé (épingle, étiquette, cartouche, bordure).
  const dessinerElement = async (el) => {
    if (!el || el.hidden) return;
    // Les textes/pictogrammes libres ont un marqueur de taille nulle dont le
    // contenu déborde : on mesure et on dessine alors ce contenu-là.
    let cible = el;
    let r = rectDe(el);
    if ((r.l < 2 || r.h < 2) && el.firstElementChild) {
      cible = el.firstElementChild;
      r = rectDe(cible);
    }
    if (!visible(r)) return;
    const opacite = parseFloat(doc.defaultView.getComputedStyle(el).opacity);
    if (opacite < 0.05) return; // étiquette masquée (souvenir dans une grappe)
    try {
      const png = await domtoimage.toPng(cible, {
        bgcolor: null,
        // On neutralise le POSITIONNEMENT (transform de Leaflet) pendant le
        // rendu isolé : sinon le contenu est dessiné hors du cadre.
        style: { transform: "none", position: "static", left: "auto", top: "auto", margin: "0" },
        width: Math.max(1, Math.round(r.l / echelle)),
        height: Math.max(1, Math.round(r.h / echelle)),
      });
      const image = new Image();
      await new Promise((ok, ko) => {
        image.onload = ok;
        image.onerror = () => ko(new Error("élément illisible"));
        image.src = png;
      });
      ctx.globalAlpha = Math.min(1, opacite || 1);
      ctx.drawImage(image, r.x, r.y, r.l, r.h);
      ctx.globalAlpha = 1;
    } catch (e) { /* on continue sans cet élément */ }
  };

  // 4) Épingles (souvenirs, grappes, pictogrammes, textes) puis étiquettes.
  for (const el of zone.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon")) {
    await dessinerElement(el);
  }
  for (const el of zone.querySelectorAll(".leaflet-tooltip-pane .leaflet-tooltip")) {
    await dessinerElement(el);
  }

  // 5) Le décor par-dessus : bordure, rose des vents, cartouche de titre.
  const bordure = doc.getElementById("bordure-carte");
  if (bordure && !bordure.hidden) await dessinerElement(bordure);
  const rose = doc.getElementById("rose-carte") || doc.getElementById("rose-vents");
  if (rose && !rose.hidden) {
    const r = rectDe(rose);
    const svgRose = rose.querySelector("svg");
    const imgRose = rose.querySelector("img");
    if (svgRose && visible(r)) {
      try { await dessinerSvgSurCanvas(ctx, svgRose, r); } catch (e) {}
    } else if (imgRose && visible(r)) {
      try { ctx.drawImage(imgRose, r.x, r.y, r.l, r.h); } catch (e) {}
    }
  }
  const titre = doc.getElementById("carte-titre");
  if (titre && !titre.hidden) await dessinerElement(titre);

  return sortie;
}

/** Capture la carte (fond + trace + épingles + décor) et la télécharge en PNG. */
async function exporterImagePng() {
  if (!etat.trace) {
    toast("Charge d'abord une trace avant d'exporter.", true);
    return;
  }
  toast("Préparation de l'image… (quelques secondes)");
  try {
    const domtoimage = await chargerDomToImage();
    const canvas = await composerImageCarte(document.querySelector("main.layout"), 2, domtoimage);
    const lien = document.createElement("a");
    const nom = (carnetActif() && carnetActif().nom) || "carte";
    lien.download = "carte-" + nom.replace(/[^\w\-]+/g, "_") + ".png";
    lien.href = canvas.toDataURL("image/png");
    lien.click();
    toast("Image PNG exportée");
  } catch (e) {
    toast("Export en image impossible ici. Essaie plutôt « Affiche PDF ».", true);
  }
}

/* ---------- Export "affiche" (PDF, via une fenêtre d'impression à part) ---------- */

// Réglages courants de l'affiche (mémorisés le temps de la session).
// La disposition est toujours en mosaïque : le nombre d'unités de la grille
// est calculé automatiquement selon le format de papier (voir impression.js).
const reglagesAffiche = {
  format: "A4",
  orientation: "portrait",
  police: "systeme",
  couleur: "#2f3b34",
};
// Comme pour etat ci-dessus : la fenêtre d'impression lit ces réglages via
// window.opener.reglagesAffiche, ce qui exige une vraie propriété de window.
window.reglagesAffiche = reglagesAffiche;

/** Ouvre la fenêtre de réglages de l'affiche PDF. */
function ouvrirModalAffiche() {
  if (!etat.trace) {
    toast("Charge d'abord une trace avant d'exporter une affiche.", true);
    return;
  }
  majSegment("affiche-format", "format", reglagesAffiche.format);
  majSegment("affiche-orientation", "orientation", reglagesAffiche.orientation);
  majBoutonPolice("affiche");
  document.getElementById("affiche-couleur").value = reglagesAffiche.couleur;
  // La disposition (souvenirs inclus + ordre des pages) se règle ici aussi.
  if (typeof majDispositionAffiche === "function") majDispositionAffiche();
  document.getElementById("modal-affiche").hidden = false;
}

/** Ferme la fenêtre de réglages de l'affiche PDF. */
function fermerModalAffiche() {
  document.getElementById("modal-affiche").hidden = true;
}

/**
 * Ouvre l'affiche dans une fenêtre à part (impression.html), qui construit
 * elle-même sa propre carte et ses propres cartes de souvenirs à partir des
 * données du carnet (lues via window.opener). Cette fenêtre est entièrement
 * indépendante : quoi qu'il s'y passe (y compris une impression annulée),
 * l'application principale n'est jamais modifiée et reste utilisable.
 */
function exporterAffiche(reglages) {
  if (!etat.trace) {
    toast("Charge d'abord une trace avant d'exporter une affiche.", true);
    return;
  }
  const fenetre = window.open("impression.html", "_blank", "width=900,height=1000");
  if (!fenetre) {
    toast("La fenêtre d'impression a été bloquée par le navigateur : autorise les fenêtres pop-up pour ce site.", true);
    return;
  }
  toast("Fenêtre d'impression ouverte");
}

/**
 * Réinitialise le carnet : efface la trace et tous les souvenirs, vide la
 * sauvegarde locale et revient à l'écran d'accueil. Action irréversible,
 * donc précédée d'une confirmation.
 */
async function reinitialiserCarnet() {
  const ok = await demanderConfirmation(
    "Réinitialiser ce carnet ?",
    "La trace et TOUS les souvenirs de ce carnet (photos, audios, textes) seront " +
    "définitivement effacés. Pense à « Sauvegarder (.json) » d'abord si tu veux le conserver.",
    { okLibelle: "Tout effacer" }
  );
  if (!ok) return;

  // On vide l'écran, on revient en édition, et on efface la sauvegarde
  // de CE carnet (les autres carnets ne sont pas touchés).
  viderCarnetCourant();
  definirMode("edition");
  try { await dbEffacerCle("carnet-" + etat.carnetActifId); } catch (e) {}
  toast("Carte réinitialisée");
}

/**
 * Lit un fichier .json choisi et l'importe comme un NOUVEAU carnet
 * (le carnet en cours est sauvegardé, rien n'est écrasé).
 */
function importerCarnetFichier(fichier) {
  if (!fichier) return;
  const lecteur = new FileReader();
  lecteur.onerror = () => toast("Lecture du fichier impossible.", true);
  lecteur.onload = async () => {
    try {
      const donnees = JSON.parse(lecteur.result);
      if (!donnees || !donnees.trace) {
        throw new Error("Ce fichier n'est pas un carnet valide.");
      }
      await sauvegarderMaintenant(); // met le carnet courant à l'abri
      retirerTousFantomes();

      const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
      const meta = donnees.meta || {};
      const nom = meta.nom || (donnees.trace && donnees.trace.name) || "Carnet importé";
      etat.carnets.push({
        id, uuid: genUuid(), nom, visible: true,
        logo: typeof meta.logo === "string" ? meta.logo : "",
        categorie: typeof meta.categorie === "string" ? meta.categorie : "",
        description: typeof meta.description === "string" ? meta.description : "",
        modifieLe: new Date().toISOString(),
      });
      etat.carnetActifId = id;

      restaurerCarnet(donnees);
      await sauvegarderMaintenant();
      renderCarnets();
      toast(`Importé comme nouveau carnet « ${nom} »`);
    } catch (e) {
      toast(e.message || "Import impossible.", true);
    }
  };
  lecteur.readAsText(fichier);
}

// (Le rechargement au démarrage est géré par demarrerCarnets(), plus haut.)

/* =========================================================
   Mode Édition / Visualisation (lecture seule)
   ========================================================= */

/** Applique le mode demandé : "edition" ou "visualisation". */
function definirMode(mode) {
  etat.mode = mode === "visualisation" ? "visualisation" : "edition";
  const vue = etat.mode === "visualisation";

  document.body.classList.toggle("mode-visualisation", vue);
  document.getElementById("btn-mode").textContent =
    vue ? "✏️ Mode édition" : "👁 Mode visualisation";

  // Les champs de saisie passent en lecture seule en visualisation.
  document.getElementById("souvenir-titre").readOnly = vue;
  const recit = document.getElementById("souvenir-texte");
  recit.readOnly = vue;
  // En lecture seule, on retire le texte d'invite (qui suggère d'écrire).
  recit.placeholder = vue ? "" : "Raconte ce moment : ce que tu as vu, ressenti, vécu…";
  const legende = document.getElementById("lightbox-legende");
  legende.readOnly = vue;
  legende.placeholder = vue ? "" : "Ajouter une légende à cette photo…";

  // En visualisation : on coupe l'ajout en cours et le panneau Style.
  // Un enregistrement audio en cours s'arrête au changement de mode.
  arreterEnregistrementAudio();

  if (vue) {
    desarmerAjout();
    fermerPanneauStyle();
    fermerPanneauFond(); // met aussi fin à la pose/sélection d'un élément
  } else {
    // Retour en édition : plus de filtre, tout le monde réapparaît.
    fermerPanneauFiltre();
    reinitialiserFiltre();
  }

  // La fiche affiche les dates/audios différemment selon le mode.
  if (etat.souvenirActif) {
    afficherDates(etat.souvenirActif);
    afficherAudios(etat.souvenirActif);
  }

  // Carnets affichés en plus : seulement en visualisation.
  majFantomes();
  // Le panneau des carnets change de contenu selon le mode.
  if (!document.getElementById("panneau-carnets").hidden) renderCarnets();

  // Les épingles ne se déplacent qu'en édition.
  etat.souvenirs.forEach((s) => {
    if (!s.marker || !s.marker.dragging) return;
    if (vue) s.marker.dragging.disable();
    else s.marker.dragging.enable();
  });

  // Même chose pour les pictogrammes et textes posés sur le fond de carte.
  etat.annotations.forEach((a) => {
    if (!a.marker || !a.marker.dragging) return;
    if (vue) a.marker.dragging.disable();
    else a.marker.dragging.enable();
  });

  // Le fond assombri (pop up) ne concerne que la visualisation.
  majFondPanneau();

  // Si on passe en visualisation avec une fiche ouverte, on rafraîchit la mini-carte.
  if (vue && etat.souvenirActif) majMiniCarte(etat.souvenirActif);

  // On mémorise le choix pour le prochain démarrage.
  try { localStorage.setItem("carnet-mode", etat.mode); } catch (e) {}
}

/** Bascule entre Édition et Visualisation. */
function basculerMode() {
  definirMode(etat.mode === "visualisation" ? "edition" : "visualisation");
}

/* =========================================================
   Réserve de souvenirs (stock, sans position sur la carte)
   ========================================================= */

/** Ouvre l'onglet Souvenirs (qui contient la réserve « à placer »). */
function ouvrirReserve() {
  if (typeof ouvrirOnglet === "function") ouvrirOnglet("souvenirs");
}

/** Ferme le panneau de la réserve. */
function fermerReserve() {
  document.getElementById("panneau-reserve").hidden = true;
}

/** (Re)construit la liste des souvenirs (placés + à placer, dans ui.js). */
function renderReserve() {
  if (typeof renderSouvenirsListe === "function") renderSouvenirsListe();
}

/** Crée un souvenir en réserve (vide) et l'ouvre pour l'éditer. */
function creerStock() {
  const item = {
    id: prochainIdSouvenir++,
    nom: "",
    textes: "",
    photos: [],
    couverture: null,
    pictogramme: "souvenir",
    dates: [],
    audios: [],
  };
  etat.stock.push(item);
  ouvrirStockEdition(item);
  planifierSauvegarde();
}

/** Ouvre un souvenir de la réserve dans la fiche pour l'éditer. */
function ouvrirStockEdition(item) {
  fermerReserve();
  ouvrirPanneau(item); // la fiche détecte qu'il s'agit d'un souvenir en réserve
}

/* ---------- Piocher dans la réserve au moment de poser un point ---------- */

/** Remplit la liste "depuis la réserve" dans la fenêtre de saisie du nom. */
function renderStockPourModal() {
  const bloc = document.getElementById("modal-stock");
  const liste = document.getElementById("modal-stock-liste");
  liste.innerHTML = "";
  if (etat.stock.length === 0) {
    bloc.hidden = true;
    return;
  }
  bloc.hidden = false;
  etat.stock.forEach((item) => {
    const b = document.createElement("button");
    b.className = "modal-stock-item";
    const perso = obtenirPictoPerso(item.pictogramme);
    const icone = perso
      ? `<img class="modal-stock-icone" src="${perso.src}" alt="">`
      : `<span class="modal-stock-icone-emoji">${glyphDePicto(item.pictogramme) || "📝"}</span>`;
    b.innerHTML = icone + echapperHtml(item.nom || "Sans nom");
    b.addEventListener("click", () => appliquerStockSurCarte(item));
    liste.appendChild(b);
  });
}

/**
 * Pose un souvenir de la réserve à l'endroit cliqué, puis le retire de la
 * réserve. On revient directement à la carte, sans ouvrir sa fiche.
 */
function appliquerStockSurCarte(item) {
  if (!latLngEnAttente) return;
  ajouterSouvenir(latLngEnAttente.lat, latLngEnAttente.lng, item.nom || "Souvenir", {
    textes: item.textes,
    photos: item.photos,
    couverture: item.couverture,
    pictogramme: item.pictogramme,
    dates: item.dates,
    audios: item.audios,
  }, false);
  etat.stock = etat.stock.filter((x) => x.id !== item.id);
  document.getElementById("modal-nom").hidden = true;
  latLngEnAttente = null;
  planifierSauvegarde();
}

/* ---------- Génération de souvenirs par IA (Claude) ---------- */

const IA_MODELE = "claude-opus-4-8";
const IA_CLE_STOCKAGE = "carnet-cle-ia";

function lireCleIA() {
  try { return localStorage.getItem(IA_CLE_STOCKAGE) || ""; } catch (e) { return ""; }
}
function enregistrerCleIA(cle) {
  try { localStorage.setItem(IA_CLE_STOCKAGE, (cle || "").trim()); } catch (e) {}
}

/** Ouvre la fenêtre de génération et prépare son état. */
function ouvrirGenerer() {
  etat.genPhotos = [];
  document.getElementById("gen-texte").value = "";
  document.getElementById("gen-photos-info").textContent = "";
  document.getElementById("gen-statut").hidden = true;
  const cle = lireCleIA();
  document.getElementById("gen-cle-input").value = cle;
  document.getElementById("gen-cle-bloc").open = !cle; // ouvert si aucune clé
  document.getElementById("gen-cle-etat").textContent =
    cle ? "✓ Clé enregistrée." : "Aucune clé enregistrée.";
  document.getElementById("modal-generer").hidden = false;
}
function fermerGenerer() { document.getElementById("modal-generer").hidden = true; }

/** Ajoute des photos (dont l'IA lira le texte) à la génération en cours. */
async function ajouterPhotosGen(fichiers) {
  etat.genPhotos = etat.genPhotos || [];
  for (const f of fichiers) {
    if (!f.type.startsWith("image/")) continue;
    try { etat.genPhotos.push(await importerImage(f)); } catch (e) {}
  }
  const n = etat.genPhotos.length;
  document.getElementById("gen-photos-info").textContent =
    n ? `${n} photo(s) ajoutée(s)` : "";
}

/** Affiche un message d'état dans la fenêtre de génération. */
function statutGen(message, erreur) {
  const el = document.getElementById("gen-statut");
  el.textContent = message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
  el.hidden = false;
}

/** Envoie le texte + photos à Claude et range les souvenirs obtenus en réserve. */
async function lancerGeneration() {
  const cle = document.getElementById("gen-cle-input").value.trim();
  if (!cle) {
    statutGen("Ajoute d'abord ta clé Claude (section « Clé IA »).", true);
    document.getElementById("gen-cle-bloc").open = true;
    return;
  }
  enregistrerCleIA(cle);
  document.getElementById("gen-cle-etat").textContent = "✓ Clé enregistrée.";

  const texte = document.getElementById("gen-texte").value.trim();
  const photos = etat.genPhotos || [];
  if (!texte && photos.length === 0) {
    statutGen("Ajoute un texte ou des photos à transformer.", true);
    return;
  }

  const bouton = document.getElementById("gen-lancer");
  bouton.disabled = true;
  statutGen("Génération en cours… (quelques secondes)", false);

  // Contenu du message : les photos, puis la consigne + le texte.
  const contenu = [];
  photos.forEach((dataUrl) => {
    contenu.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: dataUrl.replace(/^data:image\/jpeg;base64,/, ""),
      },
    });
  });
  const consigne =
    "Tu transformes des notes de voyage en vrac en une liste de souvenirs pour " +
    "un carnet de voyage. À partir du texte ci-dessous et des éventuelles photos " +
    "(notes manuscrites ou imprimées à lire), découpe le récit en plusieurs " +
    "souvenirs distincts, dans l'ordre chronologique du voyage. Pour chaque " +
    "souvenir : un « nom » court et évocateur (max ~50 caractères) et un « textes » " +
    "qui raconte ce moment en 1 à 3 courts paragraphes, en français. Reste fidèle " +
    "aux informations fournies, n'invente pas de faits. Si le contenu est vide ou " +
    "inexploitable, renvoie une liste vide.\n\nTEXTE :\n" + (texte || "(voir photos)");
  contenu.push({ type: "text", text: consigne });

  // Format de sortie imposé : une liste de { nom, textes }.
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["souvenirs"],
    properties: {
      souvenirs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["nom", "textes"],
          properties: { nom: { type: "string" }, textes: { type: "string" } },
        },
      },
    },
  };

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: IA_MODELE,
        max_tokens: 8000,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: contenu }],
      }),
    });

    if (!resp.ok) {
      let apiMsg = "";
      try { const e = await resp.json(); apiMsg = (e.error && e.error.message) || ""; } catch (_) {}
      let msg;
      if (/credit balance/i.test(apiMsg)) {
        msg = "Crédit Anthropic insuffisant : ajoute du crédit dans « Plans & Billing » sur console.anthropic.com, puis réessaie.";
      } else if (resp.status === 401) {
        msg = "Clé refusée : vérifie ta clé Claude.";
      } else if (resp.status === 429) {
        msg = "Trop de requêtes ou limite atteinte — réessaie plus tard.";
      } else if (resp.status === 400) {
        msg = "Requête refusée" + (apiMsg ? " : " + apiMsg : ".");
      } else {
        msg = `Erreur (${resp.status})` + (apiMsg ? " : " + apiMsg : ".");
      }
      statutGen(msg, true);
      bouton.disabled = false;
      return;
    }

    const data = await resp.json();
    if (data.stop_reason === "refusal") {
      statutGen("L'IA a refusé de traiter ce contenu.", true);
      bouton.disabled = false;
      return;
    }
    const bloc = (data.content || []).find((b) => b.type === "text");
    const parsed = JSON.parse(bloc.text);
    const liste = (parsed.souvenirs || []).filter((s) => s && (s.nom || s.textes));
    if (liste.length === 0) {
      statutGen("Aucun souvenir n'a pu être dégagé de ce contenu.", true);
      bouton.disabled = false;
      return;
    }
    liste.forEach((s) => {
      etat.stock.push({
        id: prochainIdSouvenir++,
        nom: (s.nom || "").slice(0, 80),
        textes: s.textes || "",
        photos: [],
        couverture: null,
        pictogramme: "souvenir",
      });
    });
    planifierSauvegarde();
    fermerGenerer();
    ouvrirReserve();
    toast(`${liste.length} souvenir(s) ajouté(s) à la réserve`);
  } catch (e) {
    statutGen("Échec de la génération (connexion ou réponse invalide).", true);
  } finally {
    bouton.disabled = false;
  }
}

/* ---------------------------------------------------------
   4. Petit message temporaire en bas d'écran (toast)
   --------------------------------------------------------- */
let toastTimer = null;
function toast(message, estErreur = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast" + (estErreur ? " toast-error" : "");
  el.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/** Toast avec un bouton d'action (« Annuler » après une suppression, etc.). */
function toastAvecAction(message, libelle, action, duree = 7000) {
  const el = document.getElementById("toast");
  el.className = "toast";
  el.textContent = message + " ";
  const bouton = document.createElement("button");
  bouton.className = "toast-action";
  bouton.textContent = libelle;
  bouton.addEventListener("click", () => {
    el.hidden = true;
    clearTimeout(toastTimer);
    action();
  });
  el.appendChild(bouton);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, duree);
}

/* ---------- Boîte de dialogue maison (confirmation / saisie) ---------- */

// Résolution de la promesse du dialogue en cours (null si aucun).
let resoudreDialogue = null;

/** Ferme le dialogue et renvoie la réponse à celui qui attendait. */
function terminerDialogue(reponse) {
  const resoudre = resoudreDialogue;
  resoudreDialogue = null;
  document.getElementById("modal-dialogue").hidden = true;
  if (resoudre) resoudre(reponse);
}

/** Ouvre le dialogue (interne aux deux fonctions ci-dessous). */
function ouvrirDialogue({ titre, message, saisie, valeur, okLibelle, danger }) {
  return new Promise((resolve) => {
    if (resoudreDialogue) terminerDialogue(null); // un seul dialogue à la fois
    resoudreDialogue = resolve;
    document.getElementById("dialogue-titre").textContent = titre;
    const msg = document.getElementById("dialogue-message");
    msg.textContent = message || "";
    msg.hidden = !message;
    const champ = document.getElementById("dialogue-champ");
    champ.hidden = !saisie;
    champ.value = valeur || "";
    const ok = document.getElementById("dialogue-ok");
    ok.textContent = okLibelle || "OK";
    ok.className = danger ? "btn btn-danger" : "btn btn-accent";
    document.getElementById("modal-dialogue").hidden = false;
    if (saisie) { champ.focus(); champ.select(); }
    else ok.focus();
  });
}

/** Demande une confirmation. Renvoie true (OK) ou false (Annuler). */
async function demanderConfirmation(titre, message, options = {}) {
  const reponse = await ouvrirDialogue({
    titre,
    message,
    okLibelle: options.okLibelle || "Confirmer",
    danger: options.danger !== false, // par défaut : action sensible (rouge)
  });
  return reponse === true;
}

/** Demande un texte court (nom de carnet…). Renvoie la saisie, ou null. */
async function demanderTexte(titre, valeurInitiale, okLibelle) {
  const reponse = await ouvrirDialogue({
    titre,
    saisie: true,
    valeur: valeurInitiale || "",
    okLibelle: okLibelle || "Valider",
    danger: false,
  });
  if (reponse !== true) return null;
  return document.getElementById("dialogue-champ").value.trim() || null;
}

/* ---------- Pastille d'attente (redessin du fond vectoriel) ---------- */

let patienceTimer = null;
function montrerPatience(texte) {
  document.getElementById("patience-texte").textContent = texte || "La carte se redessine…";
  document.getElementById("patience").hidden = false;
  // Filet de sécurité : la pastille ne reste jamais plus de 30 s.
  clearTimeout(patienceTimer);
  patienceTimer = setTimeout(cacherPatience, 30000);
}
function cacherPatience() {
  clearTimeout(patienceTimer);
  document.getElementById("patience").hidden = true;
}

/* ---------- Recadrage sur le parcours ---------- */

/** Recadre la carte pour voir toute la trace et tous les souvenirs. */
function recadrerSurParcours() {
  if (!etat.trace) return;
  const points = [];
  etat.trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
  etat.souvenirs.forEach((s) => points.push([s.lat, s.lng]));
  etat.annotations.forEach((a) => {
    // Les traits et dessins portent une liste de points ; les autres un point.
    if (Array.isArray(a.points)) a.points.forEach((p) => points.push(p));
    else if (typeof a.lat === "number" && typeof a.lng === "number") points.push([a.lat, a.lng]);
  });
  if (points.length) etat.carte.fitBounds(points, { padding: [40, 40] });
}

/** Charge la randonnée d'exemple (depuis l'écran d'accueil). */
async function chargerExemple() {
  try {
    const reponse = await fetch("exemple-rando.gpx");
    const trace = parseGpx(await reponse.text());
    afficherTrace(trace);
    toast(`Trace d'exemple chargée — pose ton premier souvenir avec le bouton ＋`);
    planifierSauvegarde();
  } catch (e) {
    toast("Impossible de charger l'exemple.", true);
  }
}

/* ---------- Menu des actions (bouton hamburger) ---------- */
function ouvrirMenu() {
  document.getElementById("menu-actions").hidden = false;
  document.getElementById("btn-menu").setAttribute("aria-expanded", "true");
}
function fermerMenu() {
  document.getElementById("menu-actions").hidden = true;
  document.getElementById("btn-menu").setAttribute("aria-expanded", "false");
}
function basculerMenu() {
  if (document.getElementById("menu-actions").hidden) ouvrirMenu();
  else fermerMenu();
}

/* ---------------------------------------------------------
   5. Démarrage : on branche les boutons et on crée la carte
   --------------------------------------------------------- */
function init() {
  enregistrerProtocoleLisse(); // l'arrondi des tuiles vectorielles
  initCarte();

  // Les deux boutons "Charger un GPX" (barre du haut + écran d'accueil)
  // déclenchent la même action.
  ["gpx-input", "gpx-input-welcome"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", (ev) => {
      chargerFichierGpx(ev.target.files[0]);
      ev.target.value = ""; // permet de recharger le même fichier ensuite
    });
  });

  // --- Ajout de souvenirs ---
  document.getElementById("btn-ajout-souvenir")
    .addEventListener("click", basculerAjout);
  document.getElementById("annuler-ajout")
    .addEventListener("click", desarmerAjout);

  // --- Fenêtre de saisie du nom ---
  document.getElementById("valider-nom")
    .addEventListener("click", () => validerNomSouvenir(true));
  document.getElementById("creer-retour-nom")
    .addEventListener("click", () => validerNomSouvenir(false));
  document.getElementById("annuler-nom")
    .addEventListener("click", fermerModalNom);
  document.getElementById("champ-nom")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") validerNomSouvenir(true);
    });

  // --- Panneau latéral (fiche du souvenir) ---
  document.getElementById("fermer-panneau")
    .addEventListener("click", fermerPanneau);
  document.getElementById("revenir-carte")
    .addEventListener("click", fermerPanneau);
  document.getElementById("panneau-fond")
    .addEventListener("click", fermerPanneau);
  document.getElementById("supprimer-souvenir")
    .addEventListener("click", supprimerSouvenirActif);
  document.getElementById("souvenir-titre")
    .addEventListener("input", (e) => renommerSouvenirActif(e.target.value));
  document.getElementById("souvenir-precedent")
    .addEventListener("click", () => naviguerSouvenir(-1));
  document.getElementById("souvenir-suivant")
    .addEventListener("click", () => naviguerSouvenir(1));
  document.getElementById("souvenir-avancer")
    .addEventListener("click", () => deplacerSouvenir(1));
  document.getElementById("souvenir-reculer")
    .addEventListener("click", () => deplacerSouvenir(-1));

  // --- Sélecteur de pictogramme (fenêtre à part) ---
  document.getElementById("btn-choisir-picto")
    .addEventListener("click", ouvrirPictoPicker);
  document.getElementById("fermer-picto")
    .addEventListener("click", fermerPictoPicker);
  document.getElementById("picto-import")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = ""; // permet de réimporter le même fichier ensuite
      ajouterPictoPerso(fichier);
    });
  // Émoji libre : bouton "Utiliser" ou touche Entrée dans le champ.
  document.getElementById("picto-emoji-ok")
    .addEventListener("click", appliquerEmojiSaisi);
  document.getElementById("picto-emoji-input")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") appliquerEmojiSaisi();
    });

  // --- Photos et récit ---
  document.getElementById("ajout-photos")
    .addEventListener("change", (e) => {
      // On fige la liste des fichiers AVANT de vider le champ : sinon, comme
      // l'ajout est asynchrone (redimensionnement), vider le champ effacerait
      // la sélection en cours et seule la 1re photo serait ajoutée.
      const fichiers = Array.from(e.target.files);
      e.target.value = ""; // permet de re-sélectionner les mêmes fichiers ensuite
      ajouterPhotos(fichiers);
    });
  document.getElementById("souvenir-texte")
    .addEventListener("input", (e) => {
      if (etat.souvenirActif) {
        etat.souvenirActif.textes = e.target.value;
        planifierSauvegarde();
      }
    });

  // --- Visionneuse plein écran ---
  document.getElementById("lightbox-fermer")
    .addEventListener("click", fermerLightbox);
  document.getElementById("lightbox-prec")
    .addEventListener("click", () => naviguerLightbox(-1));
  document.getElementById("lightbox-suiv")
    .addEventListener("click", () => naviguerLightbox(1));
  document.getElementById("lightbox-couverture")
    .addEventListener("click", definirCouverture);
  document.getElementById("lightbox-legende")
    .addEventListener("input", (e) => saisirLegende(e.target.value));
  // Clic sur le fond noir (hors image et flèches) : fermer.
  document.getElementById("lightbox")
    .addEventListener("click", (e) => {
      if (e.target.id === "lightbox") fermerLightbox();
    });

  // --- Sélecteur de pictogramme (fiche souvenir) ---
  construirePictos();

  // --- Panneau Style ---
  construireNuancier("trace-couleurs", choisirCouleurTrace);
  construireNuancier("labels-couleurs", choisirCouleurLabel);
  document.getElementById("btn-style")
    .addEventListener("click", ouvrirPanneauStyle);
  document.getElementById("fermer-style")
    .addEventListener("click", fermerPanneauStyle);

  // --- Panneau Fond de carte ---
  document.getElementById("btn-fond")
    .addEventListener("click", ouvrirPanneauFond);
  document.getElementById("fermer-fond")
    .addEventListener("click", fermerPanneauFond);
  // Simplification des tracés : préréglages + réglage fin numérique.
  const choisirSimplification = (v) => {
    const niveau = lireSimplification(v, 14);
    etat.style.vecteur.simplification = niveau;
    majSegment("vecteur-simplification", "simplification", String(niveau));
    document.getElementById("simplification-valeur").value = niveau;
    appliquerSimplificationVecteur();
    planifierSauvegarde();
  };
  brancherSegment("vecteur-simplification", "simplification", choisirSimplification);
  document.getElementById("simplification-valeur")
    .addEventListener("change", (e) => choisirSimplification(e.target.value));

  // --- Pictogrammes et textes posés sur le fond de carte ---
  document.getElementById("btn-ajout-annot-picto")
    .addEventListener("click", () => armerAjoutAnnotation("picto"));
  document.getElementById("btn-ajout-annot-texte")
    .addEventListener("click", () => armerAjoutAnnotation("texte"));
  document.getElementById("annuler-annot")
    .addEventListener("click", desarmerAjoutAnnotation);
  document.getElementById("annot-terminer")
    .addEventListener("click", deselectionnerAnnotation);
  document.getElementById("annot-supprimer")
    .addEventListener("click", supprimerAnnotationActive);
  document.getElementById("annot-choisir-picto")
    .addEventListener("click", ouvrirPictoPickerAnnotation);
  document.getElementById("annot-texte")
    .addEventListener("input", (e) => majAnnotationActive({ texte: e.target.value }));
  document.getElementById("annot-couleur")
    .addEventListener("input", (e) => majAnnotationActive({ couleur: e.target.value }));
  document.getElementById("annot-taille")
    .addEventListener("input", (e) => {
      const taille = parseInt(e.target.value, 10);
      document.getElementById("annot-taille-val").textContent = taille;
      majAnnotationActive({ taille });
    });
  brancherSegment("annot-align", "align", (v) => {
    majSegment("annot-align", "align", v);
    majAnnotationActive({ align: v });
  });
  document.getElementById("annot-gras")
    .addEventListener("click", (e) => {
      const a = etat.annotationActive;
      if (!a) return;
      majAnnotationActive({ gras: !a.gras });
      e.target.classList.toggle("actif", a.gras);
    });
  document.getElementById("annot-italique")
    .addEventListener("click", (e) => {
      const a = etat.annotationActive;
      if (!a) return;
      majAnnotationActive({ italique: !a.italique });
      e.target.classList.toggle("actif", a.italique);
    });

  // --- Fenêtre de choix de police (catalogue + import) ---
  document.getElementById("police-btn-labels")
    .addEventListener("click", () => ouvrirPolicePicker("labels"));
  document.getElementById("police-btn-titre")
    .addEventListener("click", () => ouvrirPolicePicker("titre"));
  document.getElementById("police-btn-annot")
    .addEventListener("click", () => ouvrirPolicePicker("annot"));
  document.getElementById("police-btn-affiche")
    .addEventListener("click", () => ouvrirPolicePicker("affiche"));
  document.getElementById("fermer-police")
    .addEventListener("click", fermerPolicePicker);
  document.getElementById("police-import")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      importerPolicePerso(fichier);
    });

  // --- Dates des souvenirs ---
  document.getElementById("ajout-date")
    .addEventListener("click", ajouterDate);
  document.getElementById("btn-trier-dates")
    .addEventListener("click", trierSouvenirsParDate);

  // --- Enregistrements audio ---
  document.getElementById("audio-enregistrer")
    .addEventListener("click", basculerEnregistrementAudio);

  // --- Filtre des souvenirs (mode visualisation) ---
  document.getElementById("btn-filtrer")
    .addEventListener("click", ouvrirPanneauFiltre);
  document.getElementById("fermer-filtre")
    .addEventListener("click", fermerPanneauFiltre);
  document.getElementById("filtre-du")
    .addEventListener("change", (e) => {
      etat.filtre.du = e.target.value;
      appliquerFiltreSouvenirs();
    });
  document.getElementById("filtre-au")
    .addEventListener("change", (e) => {
      etat.filtre.au = e.target.value;
      appliquerFiltreSouvenirs();
    });
  document.getElementById("filtre-reset")
    .addEventListener("click", reinitialiserFiltre);

  // --- Boutons flottants sur la carte ---
  document.getElementById("fab-ajout")
    .addEventListener("click", basculerAjout);
  document.getElementById("fab-recentrer")
    .addEventListener("click", recadrerSurParcours);

  // --- Écran d'accueil ---
  document.getElementById("btn-exemple")
    .addEventListener("click", chargerExemple);
  document.getElementById("btn-carnets-accueil")
    .addEventListener("click", ouvrirPanneauCarnets);

  // --- Boîte de dialogue maison (confirmation / saisie) ---
  document.getElementById("dialogue-ok")
    .addEventListener("click", () => terminerDialogue(true));
  document.getElementById("dialogue-annuler")
    .addEventListener("click", () => terminerDialogue(false));
  document.getElementById("dialogue-champ")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") terminerDialogue(true);
    });

  // --- Mes carnets ---
  document.getElementById("btn-carnets")
    .addEventListener("click", ouvrirPanneauCarnets);
  document.getElementById("fermer-carnets")
    .addEventListener("click", fermerPanneauCarnets);
  document.getElementById("carnet-nouveau")
    .addEventListener("click", nouveauCarnet);

  // --- Réserve de souvenirs ---
  document.getElementById("btn-reserve")
    .addEventListener("click", ouvrirReserve);
  document.getElementById("fermer-reserve")
    .addEventListener("click", fermerReserve);
  document.getElementById("reserve-nouveau")
    .addEventListener("click", creerStock);
  document.getElementById("reserve-generer")
    .addEventListener("click", ouvrirGenerer);
  document.getElementById("gen-annuler")
    .addEventListener("click", fermerGenerer);
  document.getElementById("gen-lancer")
    .addEventListener("click", lancerGeneration);
  document.getElementById("gen-photos")
    .addEventListener("change", (e) => {
      ajouterPhotosGen(e.target.files);
      e.target.value = "";
    });
  document.getElementById("gen-cle-input")
    .addEventListener("change", (e) => enregistrerCleIA(e.target.value));

  // Titre de la carte
  document.getElementById("style-titre")
    .addEventListener("input", (e) => {
      etat.style.titre = e.target.value;
      appliquerTitre();
      planifierSauvegarde();
    });

  // Style du cartouche de titre (classique, parchemin, pirate, sombre)
  brancherSegment("titre-fond", "titrefond", (v) => {
    etat.style.titreFond = TITRE_FONDS.includes(v) ? v : "classique";
    majSegment("titre-fond", "titrefond", etat.style.titreFond);
    appliquerTitre();
    planifierSauvegarde();
  });

  // Couleur personnalisée du tracé
  document.getElementById("trace-couleur-perso")
    .addEventListener("input", (e) => choisirCouleurTrace(e.target.value));

  // Épaisseur du tracé
  document.getElementById("trace-epaisseur")
    .addEventListener("input", (e) => {
      etat.style.trace.epaisseur = parseInt(e.target.value, 10);
      document.getElementById("trace-epaisseur-val").textContent = e.target.value;
      appliquerStyleTrace();
      planifierSauvegarde();
    });

  // Groupes "segmentés" : type de ligne, fond de carte, ambiance
  brancherSegment("trace-type", "type", (v) => {
    etat.style.trace.type = v;
    majSegment("trace-type", "type", v);
    appliquerStyleTrace();
    planifierSauvegarde();
  });
  brancherSegment("fond-carte", "fond", (v) => {
    etat.style.fond = v;
    majSegment("fond-carte", "fond", v);
    basculerBlocPerso(v === "perso");
    basculerBlocVecteur(v === "vectoriel");
    document.getElementById("fond-aide-vectoriel").hidden = v === "vectoriel";
    appliquerFond(v);
    planifierSauvegarde();
  });

  // Fond vectoriel : couleurs des zones + réinitialisation
  document.getElementById("vecteur-bloc")
    .addEventListener("input", (e) => {
      const inp = e.target.closest("input[data-zone]");
      if (inp) choisirCouleurZone(inp.dataset.zone, inp.value);
    });
  document.getElementById("zones-reset")
    .addEventListener("click", reinitialiserZonesVecteur);

  // Styles médiévaux prêts à l'emploi.
  brancherSegment("preset-fond", "preset", appliquerPresetFond);

  // Couches géographiques affichées / masquées.
  document.querySelectorAll(".couches-liste input[data-couche]").forEach((inp) => {
    inp.addEventListener("change", () => {
      etat.style.vecteur.couches[inp.dataset.couche] = inp.checked;
      // On recharge le style pour ré-afficher proprement une couche recochée.
      appliquerSimplificationVecteur();
      planifierSauvegarde();
    });
  });

  // Décor : rose des vents et bordure (case = afficher, bouton = choisir le style).
  document.getElementById("decor-rose")
    .addEventListener("change", (e) => {
      etat.style.decor.rose = e.target.checked ? (lireCleDecor(etat.style.decor.rose, "classique") || "classique") : false;
      appliquerDecor();
      planifierSauvegarde();
    });
  document.getElementById("decor-bordure")
    .addEventListener("change", (e) => {
      etat.style.decor.bordure = e.target.checked ? (lireCleDecor(etat.style.decor.bordure, "double") || "double") : false;
      appliquerDecor();
      planifierSauvegarde();
    });
  document.getElementById("decor-rose-choisir")
    .addEventListener("click", () => ouvrirDecorPicker("rose"));
  document.getElementById("decor-bordure-choisir")
    .addEventListener("click", () => ouvrirDecorPicker("bordure"));
  document.getElementById("fermer-decor")
    .addEventListener("click", fermerDecorPicker);
  document.getElementById("decor-import")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      importerDecorPerso(fichier);
    });

  // Fond personnalisé : exemples + saisie d'adresse
  construireExemplesFond();
  document.getElementById("fond-perso-url")
    .addEventListener("input", (e) => saisirUrlPerso(e.target.value));

  // Noms des souvenirs sur la carte : affichage, police, taille
  document.getElementById("labels-afficher")
    .addEventListener("change", (e) => {
      etat.style.labels.afficher = e.target.checked;
      document.getElementById("labels-reglages").hidden = !e.target.checked;
      appliquerStyleLabels();
      planifierSauvegarde();
    });
  brancherSegment("labels-taille", "taille", (v) => {
    etat.style.labels.taille = v;
    majSegment("labels-taille", "taille", v);
    document.getElementById("labels-taille-valeur").value = parseInt(TAILLES[v], 10);
    appliquerStyleLabels();
    planifierSauvegarde();
  });
  // Taille des noms : réglage fin numérique (en pixels).
  document.getElementById("labels-taille-valeur")
    .addEventListener("change", (e) => {
      etat.style.labels.taille = lireTailleLabels(e.target.value, "moyen");
      majSegment("labels-taille", "taille", String(etat.style.labels.taille));
      appliquerStyleLabels();
      planifierSauvegarde();
    });
  brancherSegment("ambiance-carte", "ambiance", (v) => {
    etat.style.ambiance = v;
    majSegment("ambiance-carte", "ambiance", v);
    appliquerAmbiance(v);
    planifierSauvegarde();
  });
  // Arrondi des formes : préréglages + réglage fin numérique.
  const choisirArrondi = (passes) => {
    etat.style.arrondi = lireArrondi(passes);
    majSegment("arrondi-carte", "arrondi", String(etat.style.arrondi));
    document.getElementById("arrondi-valeur").value = etat.style.arrondi;
    appliquerSimplificationVecteur(); // recharge les tuiles, arrondies
    planifierSauvegarde();
  };
  brancherSegment("arrondi-carte", "arrondi", choisirArrondi);
  document.getElementById("arrondi-valeur")
    .addEventListener("change", (e) => choisirArrondi(e.target.value));
  brancherSegment("vecteur-detail", "detail", (v) => {
    etat.style.vecteur.detail = v;
    majSegment("vecteur-detail", "detail", v);
    appliquerNiveauDetail(v === "epure" || !!PRESETS_FOND[etat.style.vecteur.preset]);
    planifierSauvegarde();
  });

  // --- Export / Import du carnet ---
  document.getElementById("btn-exporter")
    .addEventListener("click", exporterCarnet);
  document.getElementById("btn-export-affiche")
    .addEventListener("click", ouvrirModalAffiche);
  document.getElementById("btn-export-png")
    .addEventListener("click", exporterImagePng);
  document.getElementById("btn-reinitialiser")
    .addEventListener("click", reinitialiserCarnet);


  // --- Réglages de l'affiche PDF (format, orientation, police, couleur) ---
  document.getElementById("affiche-annuler")
    .addEventListener("click", fermerModalAffiche);
  document.getElementById("affiche-generer")
    .addEventListener("click", () => {
      fermerModalAffiche();
      exporterAffiche(reglagesAffiche);
    });
  brancherSegment("affiche-format", "format", (v) => {
    reglagesAffiche.format = v;
    majSegment("affiche-format", "format", v);
  });
  brancherSegment("affiche-orientation", "orientation", (v) => {
    reglagesAffiche.orientation = v;
    majSegment("affiche-orientation", "orientation", v);
  });
  document.getElementById("affiche-couleur")
    .addEventListener("input", (e) => { reglagesAffiche.couleur = e.target.value; });
  document.getElementById("btn-mode")
    .addEventListener("click", basculerMode);

  // On restaure le mode (édition / visualisation) choisi la dernière fois.
  let modeSauve = "edition";
  try { modeSauve = localStorage.getItem("carnet-mode") || "edition"; } catch (e) {}
  definirMode(modeSauve);
  document.getElementById("import-input")
    .addEventListener("change", (e) => {
      importerCarnetFichier(e.target.files[0]);
      e.target.value = ""; // permet de réimporter le même fichier
    });

  // Au démarrage : ressources partagées (polices, décors importés), puis
  // l'index des carnets et le rechargement du carnet ouvert, et enfin la
  // nouvelle interface (page d'accueil avec tous les carnets).
  chargerRessourcesGlobales()
    .then(demarrerCarnets)
    .then(() => { if (typeof demarrerUI === "function") demarrerUI(); });

  // On enregistre le service worker (pour l'installation et le hors-ligne).
  if ("serviceWorker" in navigator) {
    // Quand une nouvelle version prend le contrôle, on recharge la page pour
    // l'appliquer aussitôt (sinon l'app resterait sur l'ancien code en cache).
    let rechargement = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (rechargement) return;
      rechargement = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* sans service worker, l'app fonctionne quand même (juste pas hors-ligne) */
    });
  }

  // --- Menu des actions (hamburger) ---
  document.getElementById("btn-menu")
    .addEventListener("click", (e) => {
      e.stopPropagation();
      basculerMenu();
    });
  // On referme le menu après avoir choisi une action.
  document.getElementById("menu-actions")
    .addEventListener("click", fermerMenu);
  // ...ou en cliquant n'importe où ailleurs.
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("menu-actions");
    if (menu.hidden) return;
    if (menu.contains(e.target) || document.getElementById("btn-menu").contains(e.target)) return;
    fermerMenu();
  });

  // Raccourcis clavier.
  document.addEventListener("keydown", (e) => {
    const lightboxOuverte = !document.getElementById("lightbox").hidden;

    // 1) Si la visionneuse est ouverte, elle capte tout.
    if (lightboxOuverte) {
      const dansLegende = document.activeElement &&
        document.activeElement.id === "lightbox-legende";
      if (e.key === "Escape") fermerLightbox();
      // On ne change de photo avec les flèches que si on n'écrit pas la légende.
      else if (!dansLegende && e.key === "ArrowLeft") naviguerLightbox(-1);
      else if (!dansLegende && e.key === "ArrowRight") naviguerLightbox(1);
      return;
    }

    // 2) Échap : annule l'ajout en cours, sinon ferme ce qui est ouvert.
    if (e.key === "Escape") {
      if (!document.getElementById("modal-dialogue").hidden) terminerDialogue(false);
      else if (!document.getElementById("menu-actions").hidden) fermerMenu();
      else if (!document.getElementById("modal-police").hidden) fermerPolicePicker();
      else if (!document.getElementById("modal-decor").hidden) fermerDecorPicker();
      else if (!document.getElementById("modal-generer").hidden) fermerGenerer();
      else if (!document.getElementById("modal-affiche").hidden) fermerModalAffiche();
      else if (!document.getElementById("modal-picto").hidden) fermerPictoPicker();
      else if (!document.getElementById("modal-nom").hidden) fermerModalNom();
      else if (etat.modeAnnotation) desarmerAjoutAnnotation();
      else if (etat.modeAjout) desarmerAjout();
      else if (etat.annotationActive) deselectionnerAnnotation();
      else if (!document.getElementById("panneau-fond-carte").hidden) fermerPanneauFond();
      else if (!document.getElementById("panneau-filtre").hidden) fermerPanneauFiltre();
      else if (!document.getElementById("panneau-carnets").hidden) fermerPanneauCarnets();
      else if (!document.getElementById("panneau-style").hidden) fermerPanneauStyle();
      else if (!document.getElementById("panneau").hidden) fermerPanneau();
      else if (!document.getElementById("panneau-reserve").hidden) fermerReserve();
      return;
    }

    // 3) Flèches ← / → : naviguer entre souvenirs quand la fiche est ouverte.
    // On ignore si on est en train de taper (nom ou récit).
    const panneauOuvert = !document.getElementById("panneau").hidden;
    const tag = document.activeElement && document.activeElement.tagName;
    const enTrainDeTaper = tag === "INPUT" || tag === "TEXTAREA";
    if (panneauOuvert && !enTrainDeTaper) {
      if (e.key === "ArrowLeft") naviguerSouvenir(-1);
      else if (e.key === "ArrowRight") naviguerSouvenir(1);
    }
  });
}

// On attend que la page soit prête avant de lancer l'application.
document.addEventListener("DOMContentLoaded", init);
