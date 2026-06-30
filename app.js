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
  coucheTrace: null,      // le groupe de calques qui contient la trace dessinée
  trace: null,            // les données de la trace { name, segments, waypoints }
  souvenirs: [],          // la liste des points souvenirs posés par l'utilisateur
  modeAjout: false,       // vrai quand on attend un clic sur la carte pour poser un souvenir
  souvenirActif: null,    // le souvenir dont la fiche est ouverte dans le panneau
  style: null,            // les réglages d'apparence (rempli au démarrage)
  mode: "edition",        // "edition" ou "visualisation" (lecture seule)
};

// Compteur pour donner un identifiant unique à chaque souvenir.
let prochainIdSouvenir = 1;

/* ---------- Réglages de style : valeurs et options ---------- */

// Style par défaut d'un carnet (repris du look actuel).
const STYLE_DEFAUT = {
  titre: "",
  trace: { couleur: "#c8893d", epaisseur: 4, type: "plein" },
  fond: "topo",
  ambiance: "naturel",
  // Fond personnalisé : adresse de tuiles fournie par l'utilisateur.
  fondPerso: { url: "", maxZoom: 19, attribution: "", subdomains: "abc" },
  // Affichage des noms des souvenirs sur la carte.
  labels: { afficher: false, police: "systeme", couleur: "#2f3b34", taille: "moyen" },
  // Personnalisation du fond VECTORIEL (couleur des zones, police des lieux).
  // null = on garde la couleur d'origine du fond vectoriel.
  vecteur: {
    zones: { eau: null, foret: null, prairie: null, bati: null, fond: null },
    police: null,
    preset: null, // null = fond vectoriel standard ; "ancienne" = look parchemin
  },
};

// Palette du préréglage "Carte ancienne".
const PALETTE_ANCIENNE = {
  fond: "#e9e0c4", eau: "#a7c0c4", foret: "#9fb083", prairie: "#dcd3ab", bati: "#cdb89a",
};

// Couleurs suggérées par défaut dans les sélecteurs de zones (non appliquées
// tant que l'utilisateur n'y touche pas).
const SUGGESTIONS_ZONE = {
  eau: "#3a7ca5",
  foret: "#3f7d52",
  prairie: "#cfe3b5",
  bati: "#d9c9b0",
  fond: "#f3eee2",
};

// Polices proposées pour les noms des souvenirs.
const POLICES = {
  systeme: { label: "Système", css: '"Avenir Next", system-ui, sans-serif' },
  serif:   { label: "Serif",   css: 'Georgia, "Times New Roman", serif' },
  etroite: { label: "Étroite", css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
  titre:   { label: "Titre",   css: '"Bricolage Grotesque", "Avenir Next", sans-serif' },
};

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
];
const PICTO_GLYPH = Object.fromEntries(PICTOS.map((p) => [p.cle, p.glyph]));

// Fonds de carte disponibles (tous gratuits, sans clé).
const FONDS = {
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 17,
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
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  epure: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 20,
      subdomains: "abcd",
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

  // Clic sur la carte : si on est en "mode ajout", on récupère les
  // coordonnées du point cliqué et on demande un nom pour le souvenir.
  etat.carte.on("click", (e) => {
    if (!etat.modeAjout) return;
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
    etat.carte.fitBounds(tousLesPoints, { padding: [40, 40] });
  }

  // Mise à jour du bandeau d'infos (nom + statistiques).
  majBandeauInfos(trace);

  // On masque l'écran d'accueil maintenant qu'une trace est chargée.
  document.getElementById("welcome").hidden = true;

  // On rend disponibles l'ajout de souvenirs, le style, l'export et la réinit.
  document.getElementById("btn-mode").hidden = false;
  document.getElementById("btn-ajout-souvenir").hidden = false;
  document.getElementById("btn-style").hidden = false;
  document.getElementById("btn-exporter").hidden = false;
  document.getElementById("btn-reinitialiser").hidden = false;
}

/** Met à jour le petit bandeau en bas à gauche. */
function majBandeauInfos(trace) {
  const bandeau = document.getElementById("trace-info");
  const nbPoints = trace.segments.reduce((n, s) => n + s.length, 0);
  const km = longueurKm(trace.segments);

  document.getElementById("trace-name").textContent = trace.name;
  document.getElementById("trace-stats").textContent =
    `${km.toFixed(1)} km · ${nbPoints} points` +
    (trace.waypoints.length ? ` · ${trace.waypoints.length} repères` : "");

  bandeau.hidden = false;
}

/* ---------------------------------------------------------
   3. Chargement d'un fichier GPX choisi par l'utilisateur
   --------------------------------------------------------- */
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
      afficherTrace(trace);
      toast(`Trace « ${trace.name} » chargée`);
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

/**
 * Crée l'icône "épingle souvenir" (dessinée en SVG), portant son numéro
 * d'ordre dans le carnet. On la fabrique en JavaScript pour pouvoir, plus
 * tard, varier la couleur ou le pictogramme selon le type de souvenir.
 * @param {number} numero  Le rang du souvenir (1, 2, 3...).
 */
function creerIconeSouvenir(numero, pictoCle) {
  const glyph = PICTO_GLYPH[pictoCle]; // vide pour la pastille par défaut

  // La forme de l'épingle (goutte + pastille blanche).
  const pin = `
    <svg class="pin-souvenir" width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1 C8 1 1 8 1 17 C1 29 17 43 17 43 C17 43 33 29 33 17 C33 8 26 1 17 1 Z"
            fill="#d35438" stroke="#ffffff" stroke-width="2"/>
      <circle cx="17" cy="16" r="8.5" fill="#ffffff"/>
    </svg>`;

  // Contenu : soit le numéro (pastille), soit le pictogramme + un petit badge numéro.
  const contenu = glyph
    ? `<span class="pin-glyph">${glyph}</span><span class="pin-num">${numero}</span>`
    : `<span class="pin-chiffre">${numero}</span>`;

  return L.divIcon({
    className: "",
    html: `<div class="pin-wrap">${pin}${contenu}</div>`,
    iconSize: [34, 44],
    iconAnchor: [17, 43],          // la pointe de l'épingle touche le point GPS
    popupAnchor: [0, -40],
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
function libelleTooltip(souvenir) {
  const numero = etat.souvenirs.indexOf(souvenir) + 1;
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

/** Active le "mode ajout" : le prochain clic sur la carte posera un souvenir. */
function armerAjout() {
  if (etat.mode === "visualisation") return; // pas d'ajout en lecture seule
  etat.modeAjout = true;
  document.getElementById("map").classList.add("mode-ajout");
  document.getElementById("banniere-ajout").hidden = false;
}

/** Quitte le "mode ajout". */
function desarmerAjout() {
  etat.modeAjout = false;
  document.getElementById("map").classList.remove("mode-ajout");
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
  modal.hidden = false;
  champ.focus();
}

/** Ferme la fenêtre de saisie du nom sans créer de souvenir. */
function fermerModalNom() {
  document.getElementById("modal-nom").hidden = true;
  latLngEnAttente = null;
}

/** Valide la saisie du nom et crée le souvenir à l'endroit mémorisé. */
function validerNomSouvenir() {
  const nom = document.getElementById("champ-nom").value.trim();
  if (!nom) {
    toast("Donne un nom à ton souvenir.", true);
    return;
  }
  if (!latLngEnAttente) return;

  ajouterSouvenir(latLngEnAttente.lat, latLngEnAttente.lng, nom);
  document.getElementById("modal-nom").hidden = true;
  latLngEnAttente = null;
  desarmerAjout();
}

/**
 * Crée un souvenir : l'enregistre en mémoire et pose son marqueur sur la carte.
 * @returns le souvenir créé.
 */
function ajouterSouvenir(lat, lng, nom) {
  const souvenir = {
    id: prochainIdSouvenir++,
    nom,
    lat,
    lng,
    photos: [],       // chaque photo = { src: dataUrl, legende: "" }
    couverture: null, // index de la photo de couverture (null = aucune)
    textes: "",
    pictogramme: "souvenir", // pastille numérotée par défaut
    marker: null,
    label: null,             // étiquette de nom permanente (si activée)
  };

  etat.souvenirs.push(souvenir);
  attacherMarqueur(souvenir);
  majLabel(souvenir); // crée l'étiquette de nom si l'affichage est activé

  toast(`Souvenir « ${nom} » ajouté`);
  ouvrirPanneau(souvenir);
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
  })
    .addTo(etat.carte)
    .bindTooltip(libelleTooltip(souvenir), {
      direction: "top",
      offset: [0, -38],
      className: "tt-souvenir",
    })
    .on("click", () => ouvrirPanneau(souvenir));

  souvenir.marker = marker;
  return marker;
}

/* ---------- Pictogramme d'un souvenir ---------- */

/** Crée les boutons du sélecteur de pictogramme. */
function construirePictos() {
  const c = document.getElementById("souvenir-pictos");
  c.innerHTML = "";
  PICTOS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "picto-btn";
    b.dataset.picto = p.cle;
    b.title = p.label;
    b.innerHTML = p.glyph || "①"; // la pastille par défaut n'a pas de symbole
    b.addEventListener("click", () => choisirPictogramme(p.cle));
    c.appendChild(b);
  });
}

/** Met en évidence le pictogramme actif. */
function majPictoActif(cle) {
  document.querySelectorAll("#souvenir-pictos .picto-btn").forEach((b) => {
    b.classList.toggle("actif", b.dataset.picto === (cle || "souvenir"));
  });
}

/** Change le pictogramme du souvenir affiché et met à jour son épingle. */
function choisirPictogramme(cle) {
  const s = etat.souvenirActif;
  if (!s) return;
  s.pictogramme = cle;
  const numero = etat.souvenirs.indexOf(s) + 1;
  if (s.marker) s.marker.setIcon(creerIconeSouvenir(numero, cle));
  majPictoActif(cle);
  planifierSauvegarde();
}

/** Ouvre le panneau latéral sur la fiche d'un souvenir. */
function ouvrirPanneau(souvenir) {
  etat.souvenirActif = souvenir;
  document.getElementById("panneau").hidden = false;
  document.getElementById("souvenir-titre").value = souvenir.nom;
  document.getElementById("souvenir-coords").textContent =
    `📍 ${souvenir.lat.toFixed(5)}, ${souvenir.lng.toFixed(5)}`;
  document.getElementById("souvenir-texte").value = souvenir.textes || "";
  majPictoActif(souvenir.pictogramme);
  afficherGalerie(souvenir);
  majNavigation();
}

/** Met à jour le compteur "n / total" et l'état (actif/grisé) des flèches. */
function majNavigation() {
  const total = etat.souvenirs.length;
  const index = etat.souvenirs.indexOf(etat.souvenirActif); // 0 si introuvable
  document.getElementById("souvenir-compteur").textContent =
    `${index + 1} / ${total}`;
  // On grise la flèche "précédent" sur le premier, "suivant" sur le dernier.
  document.getElementById("souvenir-precedent").disabled = index <= 0;
  document.getElementById("souvenir-suivant").disabled = index >= total - 1;
  // Mêmes bornes pour les boutons de réorganisation.
  document.getElementById("souvenir-avancer").disabled = index <= 0;
  document.getElementById("souvenir-reculer").disabled = index >= total - 1;
}

/**
 * Déplace le souvenir actif dans l'ordre du carnet en l'échangeant avec
 * son voisin. décalage -1 = "Avancer" (vers le début), +1 = "Reculer".
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
  const index = etat.souvenirs.indexOf(etat.souvenirActif);
  const cible = etat.souvenirs[index + decalage];
  if (!cible) return;
  ouvrirPanneau(cible);
  // On recentre la carte sur le souvenir visé, sans changer le zoom.
  etat.carte.panTo([cible.lat, cible.lng]);
}

/** Ferme le panneau latéral. */
function fermerPanneau() {
  document.getElementById("panneau").hidden = true;
  etat.souvenirActif = null;
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
function supprimerSouvenirActif() {
  const s = etat.souvenirActif;
  if (!s) return;

  const ok = window.confirm(
    `Supprimer définitivement le souvenir « ${s.nom || "sans nom"} » ?`
  );
  if (!ok) return;

  if (s.marker) s.marker.remove();
  retirerLabel(s);
  etat.souvenirs = etat.souvenirs.filter((x) => x.id !== s.id);
  renumeroterSouvenirs(); // les numéros suivants se décalent
  fermerPanneau();
  toast("Souvenir supprimé");
  planifierSauvegarde();
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
 * @returns {Promise<string>} l'image en data URL (format JPEG).
 */
function importerImage(fichier) {
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
        if (plusGrandCote > PHOTO_TAILLE_MAX) {
          const ratio = PHOTO_TAILLE_MAX / plusGrandCote;
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        // On redessine l'image à la bonne taille sur un "canvas" (toile).
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        // Export en JPEG, qualité 0,82 (bon compromis netteté / poids).
        resolve(canvas.toDataURL("image/jpeg", 0.82));
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
    etat.coucheFond = L.maplibreGL({
      pane: "tilePane", // sous le tracé et les marqueurs
      style: STYLE_VECTORIEL_URL,
      attribution:
        '© <a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ' +
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(etat.carte);
    etat.glMap = etat.coucheFond.getMaplibreMap();
    // Une fois le style chargé, on applique nos personnalisations enregistrées.
    surStyleVecteurPret(appliquerStyleVecteur);
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
  if (sl === "water" || sl === "waterway" || /water|ocean|sea|lake|river|bay/.test(id)) return "eau";
  if (/wood|forest|park|golf|cemetery|orchard|vineyard/.test(id)) return "foret";
  if (/grass|meadow|scrub|heath|wetland|farmland|landcover|landuse/.test(id)) return "prairie";
  if (sl === "building" || /building/.test(id)) return "bati";
  return null;
}

/** Repeint toutes les couches d'une catégorie de zone avec la couleur donnée. */
function appliquerCouleurZone(categorie, couleur) {
  const m = etat.glMap;
  if (!m) return;
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

/** Applique toutes les personnalisations vectorielles enregistrées. */
function appliquerStyleVecteur() {
  const ancienne = etat.style.vecteur.preset === "ancienne";
  majClasseAncienne(etat.style.fond === "vectoriel" && ancienne); // grain de papier
  if (!etat.glMap || !etat.glMap.isStyleLoaded()) return;
  const z = etat.style.vecteur.zones;
  Object.keys(z).forEach((cat) => {
    if (z[cat]) appliquerCouleurZone(cat, z[cat]);
  });
  if (ancienne) appliquerPresetAncienneAuStyle();
}

/** Active/désactive le grain de papier (calque parchemin) sur la carte. */
function majClasseAncienne(on) {
  document.getElementById("map").classList.toggle("vecteur-ancienne", !!on);
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

/** Met les noms de lieux en italique, encre brune sur halo parchemin. */
function styliserLabelsAncienne() {
  const m = etat.glMap;
  if (!m) return;
  m.getStyle().layers.forEach((l) => {
    if (l.type !== "symbol" || !(l.layout && l.layout["text-field"])) return;
    try { if (m.getLayoutProperty(l.id, "visibility") === "none") return; } catch (e) {}
    try { m.setLayoutProperty(l.id, "text-font", ["Noto Sans Italic"]); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-color", "#5a4632"); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-halo-color", "#e9e0c4"); } catch (e) {}
    try { m.setPaintProperty(l.id, "text-halo-width", 1.4); } catch (e) {}
  });
}

/** Applique les retouches "ancienne" au style vectoriel déjà chargé. */
function appliquerPresetAncienneAuStyle() {
  appliquerMailleGrossiere();
  styliserLabelsAncienne();
}

/** Active le préréglage "Carte ancienne" (palette + grosse maille + papier). */
function appliquerPresetAncienne() {
  const v = etat.style.vecteur;
  v.preset = "ancienne";
  v.zones = { ...PALETTE_ANCIENNE };

  // On s'assure que le fond vectoriel est actif.
  if (etat.style.fond !== "vectoriel") {
    etat.style.fond = "vectoriel";
    majSegment("fond-carte", "fond", "vectoriel");
    basculerBlocPerso(false);
    basculerBlocVecteur(true);
    appliquerFond("vectoriel");
  }
  surStyleVecteurPret(appliquerStyleVecteur);
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
  if (etat.glMap) {
    etat.glMap.setStyle(STYLE_VECTORIEL_URL);
    etat.glMap.once("idle", appliquerStyleVecteur);
  }
  synchroniserControlesStyle();
  planifierSauvegarde();
}

/** Affiche ou masque le bloc de réglages du fond vectoriel. */
function basculerBlocVecteur(visible) {
  document.getElementById("vecteur-bloc").hidden = !visible;
}

/** Applique l'ambiance (teinte générale) en changeant la classe du conteneur. */
function appliquerAmbiance(cle) {
  const map = document.getElementById("map");
  map.classList.remove(
    "ambiance-naturel", "ambiance-ancien", "ambiance-doux", "ambiance-medieval"
  );
  map.classList.add("ambiance-" + (cle || "naturel"));
}

/** Affiche (ou masque) le cartouche de titre sur la carte. */
function appliquerTitre() {
  const el = document.getElementById("carte-titre");
  const titre = (etat.style.titre || "").trim();
  el.textContent = titre;
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
  map.style.setProperty("--label-police", (POLICES[lab.police] || POLICES.systeme).css);
  map.style.setProperty("--label-couleur", lab.couleur);
  map.style.setProperty("--label-taille", TAILLES[lab.taille] || TAILLES.moyen);
  // Création ou retrait des étiquettes selon l'activation.
  etat.souvenirs.forEach(majLabel);
}

/** Applique l'intégralité du style et synchronise les contrôles du panneau. */
function appliquerStyleComplet() {
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);
  appliquerStyleTrace();
  appliquerStyleLabels();
  appliquerStyleVecteur();
  appliquerTitre();
  synchroniserControlesStyle();
}

/** Construit un objet style valide à partir d'un style sauvegardé (ou rien). */
function fusionnerStyle(s) {
  const base = JSON.parse(JSON.stringify(STYLE_DEFAUT));
  if (!s) return base;
  return {
    titre: typeof s.titre === "string" ? s.titre : base.titre,
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
      police: (s.labels && POLICES[s.labels.police]) ? s.labels.police : base.labels.police,
      couleur: (s.labels && s.labels.couleur) || base.labels.couleur,
      taille: (s.labels && TAILLES[s.labels.taille]) ? s.labels.taille : base.labels.taille,
    },
    vecteur: {
      zones: {
        eau:     lireCouleurOuNull(s.vecteur, "eau"),
        foret:   lireCouleurOuNull(s.vecteur, "foret"),
        prairie: lireCouleurOuNull(s.vecteur, "prairie"),
        bati:    lireCouleurOuNull(s.vecteur, "bati"),
        fond:    lireCouleurOuNull(s.vecteur, "fond"),
      },
      police: (s.vecteur && typeof s.vecteur.police === "string") ? s.vecteur.police : base.vecteur.police,
      preset: (s.vecteur && s.vecteur.preset === "ancienne") ? "ancienne" : null,
    },
  };
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

  // Bloc du fond personnalisé : visible et rempli si "perso" est choisi.
  basculerBlocPerso(s.fond === "perso");
  document.getElementById("fond-perso-url").value =
    (s.fondPerso && s.fondPerso.url) || "";
  majExemplesActifs();

  // Bloc du fond vectoriel : visible si "vectoriel" est choisi ; sélecteurs
  // remplis avec la couleur choisie ou la suggestion par défaut.
  basculerBlocVecteur(s.fond === "vectoriel");
  document.querySelectorAll("#vecteur-bloc input[data-zone]").forEach((inp) => {
    const cat = inp.dataset.zone;
    inp.value = s.vecteur.zones[cat] || SUGGESTIONS_ZONE[cat] || "#888888";
  });

  // Réglages des noms de souvenirs.
  document.getElementById("labels-afficher").checked = s.labels.afficher;
  document.getElementById("labels-reglages").hidden = !s.labels.afficher;
  majSegment("labels-police", "police", s.labels.police);
  majSegment("labels-taille", "taille", s.labels.taille);
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
  synchroniserControlesStyle();
  document.getElementById("panneau-style").hidden = false;
}

/** Ferme le panneau Style. */
function fermerPanneauStyle() {
  document.getElementById("panneau-style").hidden = true;
}

/* =========================================================
   ÉTAPE 4 — Sauvegarde locale, export et import
   ========================================================= */

/**
 * Transforme l'état courant en un objet simple (sans éléments Leaflet),
 * adapté à la sauvegarde et à l'export en fichier.
 */
function serialiserCarnet() {
  return {
    version: 1,
    trace: etat.trace,
    style: etat.style,
    prochainId: prochainIdSouvenir,
    souvenirs: etat.souvenirs.map((s) => ({
      id: s.id,
      nom: s.nom,
      lat: s.lat,
      lng: s.lng,
      photos: s.photos,        // [{ src, legende }]
      couverture: s.couverture,
      textes: s.textes,
      pictogramme: s.pictogramme || "souvenir",
    })),
  };
}

/** Retire tous les souvenirs (et leurs marqueurs) de la carte. */
function effacerSouvenirs() {
  etat.souvenirs.forEach((s) => {
    if (s.marker) s.marker.remove();
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

  effacerSouvenirs();
  afficherTrace(donnees.trace);

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
      marker: null,
      label: null,
    };
    etat.souvenirs.push(souvenir);
    attacherMarqueur(souvenir);
  });

  renumeroterSouvenirs();

  // On reprend le compteur d'identifiants là où il en était.
  const maxId = etat.souvenirs.reduce((m, s) => Math.max(m, s.id || 0), 0);
  prochainIdSouvenir = donnees.prochainId || maxId + 1;

  // On applique fond, ambiance, titre et style de trace, + les contrôles.
  appliquerStyleComplet();
  return true;
}

/* ---------- Sauvegarde automatique (différée) ---------- */
// On attend ~0,6 s après la dernière modification avant d'écrire, pour ne
// pas sauvegarder à chaque frappe de clavier.
let timerSauvegarde = null;
function planifierSauvegarde() {
  clearTimeout(timerSauvegarde);
  timerSauvegarde = setTimeout(sauvegarderMaintenant, 600);
}

async function sauvegarderMaintenant() {
  try {
    await dbSauver(serialiserCarnet());
    indiquerEnregistre();
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

  const nomBrut = etat.trace.name || "carnet";
  const nomFichier = "carnet-" + nomBrut.replace(/[^\w\-]+/g, "_");

  const a = document.createElement("a");
  a.href = url;
  a.download = `${nomFichier}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Carnet exporté");
}

/**
 * Réinitialise le carnet : efface la trace et tous les souvenirs, vide la
 * sauvegarde locale et revient à l'écran d'accueil. Action irréversible,
 * donc précédée d'une confirmation.
 */
async function reinitialiserCarnet() {
  const ok = window.confirm(
    "Réinitialiser la carte ?\n\n" +
    "Cela efface la trace et TOUS les souvenirs de ce carnet " +
    "(photos et textes compris). Pense à « Exporter » d'abord si tu " +
    "veux le conserver.\n\nCette action est irréversible."
  );
  if (!ok) return;

  // On vide l'état et la carte.
  desarmerAjout();
  effacerSouvenirs();
  if (etat.coucheTrace) { etat.coucheTrace.remove(); etat.coucheTrace = null; }
  etat.trace = null;
  prochainIdSouvenir = 1;

  // On remet le style par défaut (fond, ambiance, titre).
  etat.style = JSON.parse(JSON.stringify(STYLE_DEFAUT));
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);
  appliquerTitre();
  fermerPanneauStyle();

  // On recentre la carte sur la vue par défaut (la France).
  etat.carte.setView([46.6, 2.5], 6);

  // On revient en mode édition pour le prochain carnet.
  definirMode("edition");

  // On masque les boutons liés à une trace et on réaffiche l'accueil.
  document.getElementById("btn-mode").hidden = true;
  document.getElementById("btn-ajout-souvenir").hidden = true;
  document.getElementById("btn-style").hidden = true;
  document.getElementById("btn-exporter").hidden = true;
  document.getElementById("btn-reinitialiser").hidden = true;
  document.getElementById("trace-info").hidden = true;
  document.getElementById("welcome").hidden = false;

  // On efface la sauvegarde locale pour ne pas la recharger au prochain départ.
  try { await dbEffacer(); } catch (e) { /* rien à faire si déjà vide */ }
  toast("Carte réinitialisée");
}

/** Lit un fichier .json choisi et restaure le carnet qu'il contient. */
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
      restaurerCarnet(donnees);
      await sauvegarderMaintenant();
      toast("Carnet importé");
    } catch (e) {
      toast(e.message || "Import impossible.", true);
    }
  };
  lecteur.readAsText(fichier);
}

/** Au démarrage : recharge le carnet précédemment sauvegardé, s'il existe. */
async function chargerCarnetSauvegarde() {
  try {
    const donnees = await dbCharger();
    if (donnees && donnees.trace) {
      restaurerCarnet(donnees);
      toast("Carnet précédent rechargé");
    }
  } catch (e) {
    // Pas de carnet ou IndexedDB indisponible : on démarre à vide, sans bruit.
  }
}

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
  document.getElementById("souvenir-texte").readOnly = vue;
  const legende = document.getElementById("lightbox-legende");
  legende.readOnly = vue;
  legende.placeholder = vue ? "" : "Ajouter une légende à cette photo…";

  // En visualisation : on coupe l'ajout en cours et le panneau Style.
  if (vue) {
    desarmerAjout();
    fermerPanneauStyle();
  }

  // On mémorise le choix pour le prochain démarrage.
  try { localStorage.setItem("carnet-mode", etat.mode); } catch (e) {}
}

/** Bascule entre Édition et Visualisation. */
function basculerMode() {
  definirMode(etat.mode === "visualisation" ? "edition" : "visualisation");
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

/* ---------------------------------------------------------
   5. Démarrage : on branche les boutons et on crée la carte
   --------------------------------------------------------- */
function init() {
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
    .addEventListener("click", armerAjout);
  document.getElementById("annuler-ajout")
    .addEventListener("click", desarmerAjout);

  // --- Fenêtre de saisie du nom ---
  document.getElementById("valider-nom")
    .addEventListener("click", validerNomSouvenir);
  document.getElementById("annuler-nom")
    .addEventListener("click", fermerModalNom);
  document.getElementById("champ-nom")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") validerNomSouvenir();
    });

  // --- Panneau latéral (fiche du souvenir) ---
  document.getElementById("fermer-panneau")
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
    .addEventListener("click", () => deplacerSouvenir(-1));
  document.getElementById("souvenir-reculer")
    .addEventListener("click", () => deplacerSouvenir(1));

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

  // Titre de la carte
  document.getElementById("style-titre")
    .addEventListener("input", (e) => {
      etat.style.titre = e.target.value;
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
  document.getElementById("preset-ancienne")
    .addEventListener("click", appliquerPresetAncienne);

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
  brancherSegment("labels-police", "police", (v) => {
    etat.style.labels.police = v;
    majSegment("labels-police", "police", v);
    appliquerStyleLabels();
    planifierSauvegarde();
  });
  brancherSegment("labels-taille", "taille", (v) => {
    etat.style.labels.taille = v;
    majSegment("labels-taille", "taille", v);
    appliquerStyleLabels();
    planifierSauvegarde();
  });
  brancherSegment("ambiance-carte", "ambiance", (v) => {
    etat.style.ambiance = v;
    majSegment("ambiance-carte", "ambiance", v);
    appliquerAmbiance(v);
    planifierSauvegarde();
  });

  // --- Export / Import du carnet ---
  document.getElementById("btn-exporter")
    .addEventListener("click", exporterCarnet);
  document.getElementById("btn-reinitialiser")
    .addEventListener("click", reinitialiserCarnet);
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

  // Au démarrage, on tente de recharger le carnet sauvegardé localement.
  chargerCarnetSauvegarde();

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
      if (!document.getElementById("modal-nom").hidden) fermerModalNom();
      else if (etat.modeAjout) desarmerAjout();
      else if (!document.getElementById("panneau-style").hidden) fermerPanneauStyle();
      else if (!document.getElementById("panneau").hidden) fermerPanneau();
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
