/* =========================================================
   ui.js — La nouvelle interface
   ---------------------------------------------------------
   Deux vues :
   - ACCUEIL : la carte du monde avec TOUS les carnets affichés,
     un panneau de filtres (titre, logo, catégorie, dates, mots de
     la description) et le menu d'impression.
   - ÉDITEUR : le carnet ouvert, avec un rail d'onglets façon Canva
     (Carnets, Modèles, Souvenirs, Textes, Importer, Outils,
     Fond de carte, Export).

   Ce fichier s'appuie sur app.js (chargé avant lui) : l'état
   global `etat`, la carte Leaflet, les souvenirs, les annotations,
   la sauvegarde… restent gérés là-bas.
   ========================================================= */

/* =========================================================
   1. Les deux vues : Accueil ⇆ Éditeur
   ========================================================= */

etat.vue = "accueil";     // "accueil" | "editeur"
etat.modeOutil = null;    // outil de dessin en cours (trait, dessin, forme…)

// Réglages du prochain trait / forme / dessin (onglet Outils).
const reglagesOutil = { couleur: "#b4452f", epaisseur: 4 };

/** Point d'entrée : appelé par app.js quand les carnets sont chargés. */
async function demarrerUI() {
  brancherUI();
  await basculerVersAccueil(true);
  // Le compte en ligne démarre en dernier (il synchronise si on est connecté).
  if (typeof demarrerNuage === "function") demarrerNuage();
}

/** Passe (ou revient) à l'accueil : tous les carnets sur la carte du monde. */
async function basculerVersAccueil(premierChargement) {
  if (!premierChargement) await sauvegarderMaintenant();

  // On range tout ce qui est propre à l'édition.
  desarmerOutil();
  deselectionnerAnnotation();
  desarmerAjout();
  desarmerAjoutAnnotation();
  fermerTiroir();
  fermerPanneau();

  etat.vue = "accueil";
  document.body.classList.add("vue-accueil");
  document.body.classList.remove("vue-editeur");
  // Le masque/bornage de zone est propre à l'éditeur : on le retire.
  if (typeof appliquerZoneCarnet === "function") appliquerZoneCarnet(false);

  definirMode("visualisation");     // lecture seule
  appliquerStyleCarteGlobale();     // le fond de la carte globale (pas celui du carnet)
  majTitreCarteGlobale();
  definirVisibiliteCarnetActif(true);
  await afficherTousLesCarnets();
  appliquerFiltresAccueil();
  majInterfaceCarnets();
  majEcranVide();
  ajusterVueMonde();
  majPopupsAccueil();
  // La carte doit remesurer sa place (le panneau de gauche a changé).
  setTimeout(() => etat.carte.invalidateSize(), 60);
}

/** Ouvre un carnet dans l'éditeur (celui demandé, ou le carnet actif). */
async function basculerVersEditeur(id) {
  if (id && id !== etat.carnetActifId) {
    await ouvrirCarnet(id);         // sauvegarde l'ancien, charge le nouveau
  } else {
    definirMode("edition");
  }

  etat.vue = "editeur";
  document.body.classList.add("vue-editeur");
  document.body.classList.remove("vue-accueil");

  // On quitte le style de la carte globale : le carnet reprend le sien
  // (fond, ambiance, cartouche de titre et décor propres au carnet).
  appliquerFond(etat.style.fond);
  appliquerAmbiance(etat.style.ambiance);
  if (typeof appliquerTitre === "function") appliquerTitre();
  if (typeof appliquerDecor === "function") appliquerDecor();
  // Le titre de la carte globale ne doit pas rester affiché dans l'éditeur.
  const bandeauGlobal = document.getElementById("accueil-titre");
  if (bandeauGlobal) bandeauGlobal.hidden = true;

  // Un carnet partagé « en lecture » se consulte sans se modifier.
  const c = carnetActif();
  if (c && c.partage && c.partage.droit !== "edition") {
    definirMode("visualisation");
    toast("Carnet partagé en lecture : tu peux le regarder, pas le modifier.");
  }

  definirVisibiliteCarnetActif(true);
  majInterfaceCarnets();
  majEcranVide();
  const zone = c && typeof normaliserZone === "function" && normaliserZone(c.zone);
  if (zone) {
    // Une zone définie prime : la carte se cadre dessus (et se borne).
    appliquerZoneCarnet(true);
  } else {
    if (etat.trace) recadrerSurParcours();
    else if (c && c.point) etat.carte.setView([c.point.lat, c.point.lng], 13);
    if (typeof appliquerZoneCarnet === "function") appliquerZoneCarnet(false);
  }
  setTimeout(() => etat.carte.invalidateSize(), 60);
}

/**
 * Montre ou cache les calques du carnet OUVERT. Sur la carte globale
 * (accueil), seul le tracé et le nom du carnet apparaissent — les épingles,
 * noms de souvenirs et décorations restent réservés à l'éditeur.
 */
let etiquetteCarnetActif = null;

function definirVisibiliteCarnetActif(visible) {
  const carte = etat.carte;
  const accueil = etat.vue === "accueil";

  const basculer = (couche, montrer) => {
    if (!couche) return;
    if (montrer) { if (!carte.hasLayer(couche)) carte.addLayer(couche); }
    else if (carte.hasLayer(couche)) carte.removeLayer(couche);
  };

  // Le tracé : visible partout (au style du carnet).
  basculer(etat.coucheTrace, visible);
  // Les détails : seulement dans l'éditeur.
  basculer(etat.grappe, visible && !accueil);
  etat.souvenirs.forEach((s) => basculer(s.label, visible && !accueil));
  etat.annotations.forEach((a) => basculer(a.marker, visible && !accueil));

  // Sur l'accueil : le nom du carnet ouvert, comme pour les autres carnets.
  if (etiquetteCarnetActif) { etiquetteCarnetActif.remove(); etiquetteCarnetActif = null; }
  const fiche = carnetActif();
  if (visible && accueil && fiche) {
    let centre = null;
    if (etat.trace) {
      const points = [];
      etat.trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
      if (points.length) centre = L.latLngBounds(points).getCenter();
    } else if (fiche.point) {
      // Carnet situé d'un point (sans GPX) : son étiquette se pose là.
      centre = [fiche.point.lat, fiche.point.lng];
    }
    if (centre) {
      etiquetteCarnetActif = L.marker(centre, {
        icon: creerEtiquetteCarnet(fiche, etat.style),
      })
        .on("click", () => zoomerSurCarnet(fiche.id))
        .addTo(carte);
    }
  }
}

/** À l'accueil : charge et affiche tous les autres carnets (lecture seule). */
async function afficherTousLesCarnets() {
  for (const c of etat.carnets) {
    if (c.id === etat.carnetActifId) continue;
    if ((c.statut || "actif") !== "actif") continue; // les archivés ne s'affichent pas
    try { await afficherFantome(c.id); } catch (e) { /* carnet illisible */ }
  }
}

/** Recadre la carte pour voir tous les carnets affichés. */
function ajusterVueMonde() {
  const points = [];
  const ajouterTrace = (trace) => {
    if (!trace) return;
    trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
  };
  if (etat.trace && carnetVisibleAccueil(carnetActif())) ajouterTrace(etat.trace);
  etat.fantomes.forEach((f, id) => {
    const c = etat.carnets.find((x) => x.id === id);
    if (!c || carnetVisibleAccueil(c)) ajouterTrace(f.trace);
  });
  // Les carnets situés d'un simple point (sans GPX) comptent aussi.
  etat.carnets.forEach((c) => {
    if (!c.point || !carnetVisibleAccueil(c)) return;
    points.push([c.point.lat, c.point.lng]);
  });
  if (points.length > 0) {
    etat.carte.fitBounds(points, { padding: [60, 60], maxZoom: 12 });
  } else {
    etat.carte.setView([46.6, 2.5], 5);
  }
}

/** L'écran « carnet vide » (éditeur seulement ; l'accueil a ses pop-ups). */
function majEcranVide() {
  const enEditeur = etat.vue === "editeur";
  const c = typeof carnetActif === "function" ? carnetActif() : null;
  // Carnet déjà situé : par une zone de cadrage, ou par un point (ancien format).
  const situe = !!(c && ((typeof normaliserZone === "function" && normaliserZone(c.zone)) || c.point));
  // Un carnet situé (ou pendant qu'on le situe : point OU tracé de zone) est déjà
  // utilisable : on n'affiche pas l'écran « charge un GPX » qui bloque la carte.
  const enTrainDeSituer = placementPointActif ||
    (typeof dessinZoneActif !== "undefined" && dessinZoneActif);
  const vide = enEditeur && !etat.trace && !situe && !enTrainDeSituer;
  document.getElementById("welcome").hidden = !vide;
  if (!vide) return;
  document.getElementById("welcome-titre").textContent = "Ce carnet est encore vide";
  document.getElementById("welcome-texte").innerHTML =
    "Charge un fichier <strong>.gpx</strong> pour dessiner son parcours, " +
    "ou délimite une zone sur la carte — puis pose tes souvenirs dessus.";
}

/**
 * Pop-ups de l'accueil : si aucun carnet n'existe, on propose d'en créer un
 * — et de se connecter d'abord si on n'a pas de compte.
 */
function majPopupsAccueil() {
  const bienvenue = document.getElementById("modal-bienvenue");
  const creation = document.getElementById("modal-nouveau-carnet");
  if (etat.vue !== "accueil" || etat.carnets.length > 0) {
    bienvenue.hidden = true;
    return;
  }
  // Pas de compte connecté : proposer connexion OU carnet local.
  const connecte = typeof nuageConnecte === "function" && nuageConnecte();
  if (!connecte) {
    if (creation.hidden && document.getElementById("modal-compte").hidden) {
      bienvenue.hidden = false;
    }
  } else {
    // Connecté mais aucun carnet (même après synchronisation) : en créer un.
    bienvenue.hidden = true;
    if (creation.hidden) ouvrirModalNouveauCarnet();
  }
}

/* =========================================================
   2. Rail d'onglets et tiroir (éditeur façon Canva)
   ========================================================= */

// Nom d'onglet → id de la section correspondante dans le tiroir.
const ONGLETS = {
  carnets: "panneau-carnets",
  souvenirs: "panneau-reserve",
  outils: "panneau-outils",
  fond: "panneau-fond-carte",
  export: "panneau-export",
};

let ongletOuvert = null;

/** Ouvre un onglet du tiroir (et met à jour son contenu). */
function ouvrirOnglet(nom) {
  if (etat.vue !== "editeur") return;
  const idSection = ONGLETS[nom];
  if (!idSection) return;

  Object.values(ONGLETS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== idSection;
  });
  ongletOuvert = nom;
  majRailActif();

  // Contenu à rafraîchir à l'ouverture.
  if (nom === "carnets") {
    renderCarnets();
    renderModeles();
    renderGpxListe();
    renderPartagesUI();
  }
  else if (nom === "souvenirs") { renderSouvenirsListe(); }
  else if (nom === "outils") { renderImagesListe(); }
  else if (nom === "fond") { synchroniserControlesStyle(); }
}

/** Ferme le tiroir (aucune section visible). */
function fermerTiroir() {
  Object.values(ONGLETS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ongletOuvert = null;
  majRailActif();
}

/** Surligne l'onglet ouvert dans le rail. */
function majRailActif() {
  document.querySelectorAll("#rail .rail-btn").forEach((b) => {
    b.classList.toggle("actif", b.dataset.onglet === ongletOuvert);
  });
}

/* La sélection d'un élément n'ouvre plus de panneau : la barre flottante
   apparaît au-dessus de l'élément (voir selection.js), et l'onglet en cours
   du tiroir — Outils par exemple — reste ouvert. */

/* =========================================================
   3. Accueil : cartes des carnets + filtres
   ========================================================= */

const filtreAccueil = { texte: "", categorie: "", du: "", au: "" };

/** Un carnet passe-t-il les filtres de l'accueil ? */
function carnetVisibleAccueil(c) {
  if (!c) return true;
  if ((c.statut || "actif") !== "actif") return false; // archivé : masqué de l'accueil
  const t = filtreAccueil.texte.trim().toLowerCase();
  if (t) {
    const texte = [c.nom, c.description, c.categorie, c.logo]
      .filter(Boolean).join(" ").toLowerCase();
    if (!texte.includes(t)) return false;
  }
  if (filtreAccueil.categorie && (c.categorie || "") !== filtreAccueil.categorie) return false;
  // Chevauchement de plages : le carnet est gardé si sa période touche la
  // période demandée. Un carnet sans dates est masqué si on filtre par dates.
  if (filtreAccueil.du && (!c.au || c.au < filtreAccueil.du)) return false;
  if (filtreAccueil.au && (!c.du || c.du > filtreAccueil.au)) return false;
  return true;
}

/** Applique les filtres : à la liste ET aux carnets affichés sur la carte. */
function appliquerFiltresAccueil() {
  if (etat.vue !== "accueil") return;
  etat.carnets.forEach((c) => {
    const visible = carnetVisibleAccueil(c);
    if (c.id === etat.carnetActifId) {
      definirVisibiliteCarnetActif(visible);
    } else if (visible) {
      afficherFantome(c.id);
    } else {
      retirerFantome(c.id);
    }
  });
  renderAccueilListe();
}

/** Texte « 12 juil. 2026 → 15 juil. 2026 » pour la plage d'un carnet. */
function libellePlageDates(c) {
  if (!c.du && !c.au) return "";
  if (c.du === c.au) return formaterDate(c.du);
  return `${formaterDate(c.du)} → ${formaterDate(c.au)}`;
}

/** (Re)construit la liste des cartes de carnets sur l'accueil. */
function renderAccueilListe() {
  const liste = document.getElementById("accueil-liste");
  liste.innerHTML = "";
  const visibles = etat.carnets.filter(carnetVisibleAccueil);

  document.getElementById("accueil-compte").textContent =
    visibles.length === etat.carnets.length
      ? `(${etat.carnets.length})`
      : `(${visibles.length} / ${etat.carnets.length})`;

  if (visibles.length === 0) {
    const p = document.createElement("p");
    p.className = "galerie-vide";
    p.textContent = etat.carnets.length === 0
      ? "Aucun carnet pour l'instant : charge un GPX pour créer le premier !"
      : "Aucun carnet ne correspond aux filtres.";
    liste.appendChild(p);
    return;
  }

  visibles.forEach((c) => {
    const carte = document.createElement("div");
    carte.className = "carnet-carte" + (c.id === etat.carnetActifId ? " actif" : "");
    carte.setAttribute("role", "button");
    carte.tabIndex = 0;

    const tete = document.createElement("div");
    tete.className = "carnet-carte-tete";
    const logo = document.createElement("span");
    logo.className = "carnet-carte-logo";
    logo.textContent = c.logo || "📖";
    const titres = document.createElement("div");
    titres.className = "carnet-carte-titres";
    const nom = document.createElement("div");
    nom.className = "carnet-carte-nom";
    nom.textContent = c.nom;
    titres.appendChild(nom);
    const dates = libellePlageDates(c);
    if (dates) {
      const d = document.createElement("div");
      d.className = "carnet-carte-dates";
      d.textContent = "📅 " + dates;
      titres.appendChild(d);
    }
    tete.appendChild(logo);
    tete.appendChild(titres);
    if (c.partage) {
      const badge = document.createElement("span");
      badge.className = "carnet-carte-categorie";
      badge.textContent = c.partage.droit === "edition" ? "🤝 partagé ✏️" : "🤝 partagé";
      badge.title = "Carnet partagé avec toi";
      tete.appendChild(badge);
    } else if (c.categorie) {
      const cat = document.createElement("span");
      cat.className = "carnet-carte-categorie";
      cat.textContent = c.categorie;
      tete.appendChild(cat);
    }
    carte.appendChild(tete);

    if (c.description) {
      const desc = document.createElement("p");
      desc.className = "carnet-carte-desc";
      desc.textContent = c.description;
      carte.appendChild(desc);
    }

    const actions = document.createElement("div");
    actions.className = "carnet-carte-actions";
    const editer = document.createElement("button");
    editer.className = "btn btn-accent btn-petit";
    editer.textContent = (c.partage && c.partage.droit !== "edition") ? "👁 Ouvrir" : "✏️ Éditer";
    editer.addEventListener("click", (e) => {
      e.stopPropagation();
      basculerVersEditeur(c.id);
    });
    actions.appendChild(editer);
    const imprimer = document.createElement("button");
    imprimer.className = "btn btn-ghost btn-petit";
    imprimer.textContent = "🖨️ Imprimer";
    imprimer.addEventListener("click", (e) => {
      e.stopPropagation();
      imprimerCarnet(c.id);
    });
    actions.appendChild(imprimer);
    carte.appendChild(actions);

    // Clic sur la carte (hors boutons) : zoom sur ce carnet sur la carte.
    carte.addEventListener("click", () => zoomerSurCarnet(c.id));
    liste.appendChild(carte);
  });
}

/** Recadre la carte du monde sur un carnet précis. */
function zoomerSurCarnet(id) {
  let trace = null;
  if (id === etat.carnetActifId) trace = etat.trace;
  else if (etat.fantomes.has(id)) trace = etat.fantomes.get(id).trace;
  if (!trace) {
    // Pas de trace : on cadre sur la zone, sinon sur le point (ancien format).
    const c = etat.carnets.find((x) => x.id === id);
    const z = c && typeof normaliserZone === "function" && normaliserZone(c.zone);
    if (z) { etat.carte.fitBounds(bornesZone(z), { padding: [40, 40] }); return; }
    if (c && c.point) { etat.carte.setView([c.point.lat, c.point.lng], 12); return; }
    toast("Ce carnet est encore vide (pas de lieu).");
    return;
  }
  const points = [];
  trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
  if (points.length) etat.carte.fitBounds(points, { padding: [50, 50] });
}

/** Alimente le sélecteur de catégories et la liste d'aide à la saisie. */
function majCategories() {
  const categories = [...new Set(etat.carnets.map((c) => c.categorie).filter(Boolean))].sort();
  const select = document.getElementById("accueil-categorie");
  const valeur = select.value;
  select.innerHTML = '<option value="">Toutes catégories</option>';
  categories.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
  select.value = categories.includes(valeur) ? valeur : "";

  const datalist = document.getElementById("liste-categories");
  datalist.innerHTML = "";
  categories.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    datalist.appendChild(opt);
  });
}

/* =========================================================
   4. Identité du carnet (logo, catégorie, description) + duplication
   ========================================================= */

/** Remplit un champ sans marcher sur les pieds de l'utilisateur qui tape. */
function remplirChamp(id, valeur) {
  const el = document.getElementById(id);
  if (el && document.activeElement !== el) el.value = valeur || "";
}

/**
 * Met à jour tout ce qui affiche les carnets : la barre du haut de
 * l'éditeur, la fiche d'identité, l'accueil, les catégories.
 * Appelée par renderCarnets() (app.js) après chaque changement.
 */
function majInterfaceCarnets() {
  const c = carnetActif();
  if (c) {
    document.getElementById("editeur-logo").textContent = c.logo || "📖";
    document.getElementById("editeur-nom").textContent = c.nom;
    remplirChamp("meta-logo", c.logo);
    remplirChamp("meta-nom", c.nom);
    remplirChamp("meta-categorie", c.categorie);
    remplirChamp("meta-description", c.description);
    const dates = libellePlageDates(c);
    document.getElementById("meta-dates").textContent =
      "📅 Dates : " + (dates || "aucune (elles suivent les dates de tes souvenirs)");
  }
  majBoutonsZone();
  majCategories();
  majTitreCarteGlobale();
  if (etat.vue === "accueil") renderAccueilListe();
}

let timerMeta = null;

/** Enregistre la fiche d'identité (avec un léger différé pendant la frappe). */
function saisirMeta(champ, valeur) {
  const c = carnetActif();
  if (!c) return;
  if (champ === "logo") valeur = premierEmoji(valeur);
  if (champ === "nom") valeur = valeur.trim() || c.nom;
  c[champ] = valeur;

  // La barre du haut suit en direct.
  document.getElementById("editeur-logo").textContent = c.logo || "📖";
  document.getElementById("editeur-nom").textContent = c.nom;
  if (champ === "nom" && etat.trace) majBandeauInfos(etat.trace);

  c.modifieLe = new Date().toISOString();
  clearTimeout(timerMeta);
  timerMeta = setTimeout(async () => {
    await sauverIndexCarnets();
    indiquerEnregistre();
    majCategories();
    // La fiche d'identité est aussi sauvegardée en ligne.
    if (typeof planifierPousseeNuage === "function") planifierPousseeNuage();
  }, 600);
}

/** Duplique le carnet demandé (par défaut le carnet ouvert). */
async function dupliquerCarnet(idSource) {
  const source = etat.carnets.find((c) => c.id === (idSource || etat.carnetActifId));
  if (!source) return;
  await sauvegarderMaintenant();

  let donnees = null;
  if (source.id === etat.carnetActifId) {
    donnees = serialiserCarnet();
  } else {
    try { donnees = await dbChargerCle("carnet-" + source.id); } catch (e) {}
  }

  const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
  etat.carnets.push({
    id,
    uuid: genUuid(), // la copie a sa propre vie (y compris en ligne)
    nom: source.nom + " (copie)",
    visible: true,
    logo: source.logo || "",
    categorie: source.categorie || "",
    description: source.description || "",
    du: source.du || "",
    au: source.au || "",
    modifieLe: new Date().toISOString(),
  });
  if (donnees && donnees.trace) {
    try { await dbSauverCle("carnet-" + id, donnees); } catch (e) {}
  }
  await sauverIndexCarnets();
  renderCarnets();
  toast(`Carnet « ${source.nom} » dupliqué`);
}

/* =========================================================
   5. Onglet Modèles : styles complets prêts à l'emploi
   ========================================================= */

const MODELES = [
  {
    cle: "topographique", nom: "Topographique", emoji: "⛰️", fond: "#dfe9d5",
    desc: "Carte de rando : relief, sentiers, courbes de niveau.",
    appliquer() {
      Object.assign(etat.style, { fond: "topo", ambiance: "naturel", titreFond: "classique", titrePolice: "titre" });
      etat.style.vecteur.preset = null;
      etat.style.trace = { couleur: "#d35438", epaisseur: 4, type: "plein" };
      etat.style.labels = { ...etat.style.labels, police: "systeme", couleur: "#2f3b34" };
      etat.style.decor = { rose: false, bordure: false };
    },
  },
  {
    cle: "aerienne", nom: "Vue aérienne", emoji: "✈️", fond: "#3c4b3f",
    desc: "Photo satellite, tracé lumineux par-dessus.",
    appliquer() {
      etat.style.fondPerso = {
        url: FONDS_EXEMPLES.satellite.url,
        maxZoom: FONDS_EXEMPLES.satellite.maxZoom || 19,
        attribution: FONDS_EXEMPLES.satellite.attribution || "",
        subdomains: "abc",
      };
      Object.assign(etat.style, { fond: "perso", ambiance: "naturel", titreFond: "sombre", titrePolice: "titre" });
      etat.style.vecteur.preset = null;
      etat.style.trace = { couleur: "#ffd166", epaisseur: 4, type: "plein" };
      etat.style.labels = { ...etat.style.labels, police: "systeme", couleur: "#ffffff" };
      etat.style.decor = { rose: false, bordure: false };
    },
  },
  {
    cle: "voyage", nom: "Voyage clair", emoji: "🧭", fond: "#eef3ee",
    desc: "Fond doux et lisible, parfait pour les city-trips.",
    appliquer() {
      Object.assign(etat.style, { fond: "clair", ambiance: "doux", titreFond: "classique", titrePolice: "g:quicksand" });
      etat.style.vecteur.preset = null;
      etat.style.trace = { couleur: "#3a7ca5", epaisseur: 5, type: "plein" };
      etat.style.labels = { ...etat.style.labels, police: "g:nunito", couleur: "#2f3b34" };
      etat.style.decor = { rose: false, bordure: false };
    },
  },
  {
    cle: "medieval", nom: "Médiéval", emoji: "🏰", fond: "#e9e0c4",
    desc: "Parchemin, encre brune et lettres gothiques.",
    preset: "ancienne",
    appliquer() {
      Object.assign(etat.style, { titreFond: "parchemin", titrePolice: "medievale", ambiance: "naturel" });
      etat.style.trace = { couleur: "#5a4632", epaisseur: 4, type: "tirets" };
      etat.style.labels = { ...etat.style.labels, police: "medievale", couleur: "#5a4632" };
    },
  },
  {
    cle: "pirate", nom: "Pirate", emoji: "☠️", fond: "#e7d7b1",
    desc: "Carte au trésor : parchemin brûlé et encre rouge sang.",
    preset: "pirate",
    appliquer() {
      Object.assign(etat.style, { titreFond: "pirate", titrePolice: "pirate", ambiance: "naturel" });
      etat.style.trace = { couleur: "#8b3a2e", epaisseur: 4, type: "tirets" };
      etat.style.labels = { ...etat.style.labels, police: "pirate", couleur: "#5a3a22" };
    },
  },
  {
    cle: "epure", nom: "Épuré", emoji: "✨", fond: "#f6f6f4",
    desc: "Minimaliste : la trace et tes souvenirs, rien d'autre.",
    appliquer() {
      Object.assign(etat.style, { fond: "epure", ambiance: "naturel", titreFond: "classique", titrePolice: "g:playfair" });
      etat.style.vecteur.preset = null;
      etat.style.trace = { couleur: "#2f3b34", epaisseur: 3, type: "plein" };
      etat.style.labels = { ...etat.style.labels, police: "g:lora", couleur: "#2f3b34" };
      etat.style.decor = { rose: false, bordure: false };
    },
  },
];

let modeleActif = null; // simple surbrillance de session

/** Construit la grille des modèles. */
function renderModeles() {
  const liste = document.getElementById("modeles-liste");
  liste.innerHTML = "";
  MODELES.forEach((m) => {
    const carte = document.createElement("button");
    carte.className = "modele-carte" + (modeleActif === m.cle ? " actif" : "");
    carte.innerHTML =
      `<div class="modele-apercu" style="background:${m.fond}">${m.emoji}</div>` +
      `<div class="modele-infos"><div class="modele-nom">${m.nom}</div>` +
      `<div class="modele-desc">${m.desc}</div></div>`;
    carte.addEventListener("click", () => choisirModele(m.cle));
    liste.appendChild(carte);
  });
}

/** Applique un modèle complet (après confirmation). */
async function choisirModele(cle) {
  const m = MODELES.find((x) => x.cle === cle);
  if (!m) return;
  const ok = await demanderConfirmation(
    `Appliquer le modèle « ${m.nom} » ?`,
    "Tout le style de la carte sera remplacé (fond, couleurs, tracé, polices, décor). " +
    "Tes souvenirs, textes et dessins ne bougent pas.",
    { okLibelle: "Appliquer" }
  );
  if (!ok) return;

  m.appliquer();
  appliquerStyleComplet();
  if (m.preset) appliquerPresetFond(m.preset);
  modeleActif = cle;
  renderModeles();
  planifierSauvegarde();
  toast(`Modèle « ${m.nom} » appliqué`);
}

/* =========================================================
   6. Onglet Souvenirs : liste unifiée, création rapide, drag & drop
   ========================================================= */

let filtreSouvenirs = "tous"; // "tous" | "places" | "reserve"

/** Vignette (photo de couverture ou pictogramme) d'un souvenir. */
function vignetteSouvenir(s) {
  const vign = document.createElement("div");
  vign.className = "souvenir-vignette";
  const couv = photoCouverture(s);
  const perso = obtenirPictoPerso(s.pictogramme);
  if (couv) {
    const im = document.createElement("img");
    im.src = couv.src;
    vign.appendChild(im);
  } else if (perso) {
    const im = document.createElement("img");
    im.src = perso.src;
    vign.appendChild(im);
  } else {
    vign.textContent = glyphDePicto(s.pictogramme) || "📝";
  }
  return vign;
}

/** (Re)construit la liste unifiée des souvenirs (placés + à placer). */
function renderSouvenirsListe() {
  const liste = document.getElementById("souvenirs-liste");
  const vide = document.getElementById("souvenirs-vide");
  if (!liste) return;
  liste.innerHTML = "";

  const lignes = [];
  if (filtreSouvenirs !== "reserve") {
    etat.souvenirs.forEach((s, i) => lignes.push({ s, place: true, numero: i + 1 }));
  }
  if (filtreSouvenirs !== "places") {
    etat.stock.forEach((s) => lignes.push({ s, place: false }));
  }
  vide.hidden = lignes.length > 0;

  lignes.forEach(({ s, place, numero }) => {
    const item = document.createElement("div");
    item.className = "souvenir-item" + (place ? "" : " a-placer");
    item.setAttribute("role", "button");

    item.appendChild(vignetteSouvenir(s));

    const infos = document.createElement("div");
    infos.className = "souvenir-item-infos";
    const nom = document.createElement("div");
    nom.className = "souvenir-item-nom";
    nom.textContent = (place ? numero + ". " : "") + (s.nom || "Sans nom");
    const detail = document.createElement("div");
    detail.className = "souvenir-item-detail";
    const date = premiereDate(s);
    detail.textContent = date ? formaterDate(date) : "Sans date";
    infos.appendChild(nom);
    infos.appendChild(detail);
    item.appendChild(infos);

    const badge = document.createElement("span");
    badge.className = "souvenir-item-badge " + (place ? "badge-place" : "badge-reserve");
    badge.textContent = place ? "Placé" : "À placer";
    item.appendChild(badge);

    if (place) {
      item.addEventListener("click", () => {
        if (typeof s.lat === "number") etat.carte.panTo([s.lat, s.lng]);
        ouvrirPanneau(s);
      });
    } else {
      // Souvenir « à placer » : clic = éditer sa fiche, glisser = le poser.
      item.draggable = true;
      item.addEventListener("click", () => ouvrirStockEdition(s));
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(s.id));
        e.dataTransfer.effectAllowed = "copy";
        item.classList.add("en-glisse");
      });
      item.addEventListener("dragend", () => item.classList.remove("en-glisse"));
    }
    liste.appendChild(item);
  });
}

/** Reçoit un souvenir déposé (drag & drop) sur la carte. */
function brancherDepotSurCarte() {
  const mapEl = document.getElementById("map");
  mapEl.addEventListener("dragover", (e) => {
    if (etat.vue !== "editeur") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  mapEl.addEventListener("drop", (e) => {
    if (etat.vue !== "editeur") return;
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain"));
    const item = etat.stock.find((s) => s.id === id);
    if (!item) return;
    const latlng = etat.carte.mouseEventToLatLng(e);
    ajouterSouvenir(latlng.lat, latlng.lng, item.nom || "Souvenir", item, false);
    etat.stock = etat.stock.filter((s) => s.id !== id);
    planifierSauvegarde();
    renderSouvenirsListe();
  });
}

/* ---------- Création rapide : nom + date (petit calendrier) ---------- */

let dateChoisie = "";
let moisAffiche = new Date();

/** Transforme une Date en chaîne ISO locale (AAAA-MM-JJ). */
function versIso(d) {
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  const jour = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mois}-${jour}`;
}

/** Ouvre la fenêtre de création d'un souvenir (nom + date). */
function ouvrirModalSouvenir() {
  dateChoisie = versIso(new Date());   // aujourd'hui, présélectionné
  moisAffiche = new Date();
  document.getElementById("souvenir-nouveau-nom").value = "";
  construireCalendrier();
  document.getElementById("modal-souvenir").hidden = false;
  document.getElementById("souvenir-nouveau-nom").focus();
}

function fermerModalSouvenir() {
  document.getElementById("modal-souvenir").hidden = true;
}

/** (Re)construit le petit calendrier du mois affiché. */
function construireCalendrier() {
  const conteneur = document.getElementById("calendrier");
  conteneur.innerHTML = "";

  // En-tête : ‹ Mois Année ›
  const tete = document.createElement("div");
  tete.className = "calendrier-tete";
  const prec = document.createElement("button");
  prec.className = "calendrier-nav";
  prec.textContent = "‹";
  prec.addEventListener("click", () => {
    moisAffiche = new Date(moisAffiche.getFullYear(), moisAffiche.getMonth() - 1, 1);
    construireCalendrier();
  });
  const titre = document.createElement("span");
  titre.className = "titre-mois";
  titre.textContent = moisAffiche.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const suiv = document.createElement("button");
  suiv.className = "calendrier-nav";
  suiv.textContent = "›";
  suiv.addEventListener("click", () => {
    moisAffiche = new Date(moisAffiche.getFullYear(), moisAffiche.getMonth() + 1, 1);
    construireCalendrier();
  });
  tete.appendChild(prec);
  tete.appendChild(titre);
  tete.appendChild(suiv);
  conteneur.appendChild(tete);

  // Grille : noms des jours puis les cases.
  const grille = document.createElement("div");
  grille.className = "calendrier-grille";
  ["L", "M", "M", "J", "V", "S", "D"].forEach((n) => {
    const el = document.createElement("div");
    el.className = "calendrier-jour-nom";
    el.textContent = n;
    grille.appendChild(el);
  });

  const annee = moisAffiche.getFullYear();
  const mois = moisAffiche.getMonth();
  const premier = new Date(annee, mois, 1);
  // Lundi = première colonne (getDay : 0 = dimanche).
  const decalage = (premier.getDay() + 6) % 7;
  const debut = new Date(annee, mois, 1 - decalage);
  const aujourdhui = versIso(new Date());

  for (let i = 0; i < 42; i++) {
    const d = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + i);
    const iso = versIso(d);
    const btn = document.createElement("button");
    btn.className = "calendrier-jour" +
      (d.getMonth() !== mois ? " autre-mois" : "") +
      (iso === aujourdhui ? " aujourdhui" : "") +
      (iso === dateChoisie ? " choisi" : "");
    btn.textContent = d.getDate();
    btn.addEventListener("click", () => {
      dateChoisie = iso;
      moisAffiche = new Date(d.getFullYear(), d.getMonth(), 1);
      construireCalendrier();
    });
    grille.appendChild(btn);
  }
  conteneur.appendChild(grille);

  document.getElementById("date-choisie").textContent = dateChoisie
    ? "📅 " + formaterDate(dateChoisie)
    : "Aucune date choisie";
}

/** Crée le souvenir saisi (il part dans les souvenirs « à placer »). */
function creerSouvenirRapide() {
  const nom = document.getElementById("souvenir-nouveau-nom").value.trim();
  if (!nom) {
    toast("Donne un nom à ton souvenir.", true);
    return;
  }
  etat.stock.push({
    id: prochainIdSouvenir++,
    nom,
    textes: "",
    photos: [],
    couverture: null,
    pictogramme: "souvenir",
    dates: dateChoisie ? [dateChoisie] : [],
    audios: [],
  });
  fermerModalSouvenir();
  planifierSauvegarde();
  ouvrirOnglet("souvenirs");
  renderSouvenirsListe();
  toast(`« ${nom} » créé — glisse-le sur la carte pour le placer`);
}

/* =========================================================
   7. Onglet Textes : préréglages de textes posés sur la carte
   ========================================================= */

/** Prépare la pose d'un texte avec un préréglage (titre, lieu, libre). */
function armerTextePreset(preset) {
  annotationPreset = preset;
  armerAjoutAnnotation("texte");
}

/* =========================================================
   8. Onglet Importer : photo posée sur la carte
   ========================================================= */

/** Importe une photo puis attend un clic sur la carte pour la poser. */
async function importerPhotoSurCarte(fichier) {
  if (!fichier || !fichier.type.startsWith("image/")) return;
  if (etat.vue !== "editeur") return;
  try {
    const src = await importerImage(fichier, 900);
    annotationPreset = { src, legende: "", taille: 180 };
    armerAjoutAnnotation("image");
  } catch (e) {
    toast("Impossible de lire cette image.", true);
  }
}

// Filtre courant de la liste des éléments ajoutés (onglet Outils).
let filtreElements = "tous"; // "tous" | "texte" | "picto" | "image" | "dessin"

/** Vrai si l'annotation entre dans la catégorie de filtre demandée. */
function elementDansFiltre(a, filtre) {
  if (filtre === "tous") return true;
  if (filtre === "dessin") return a.type === "trait" || a.type === "forme" || a.type === "dessin";
  return a.type === filtre;
}

/** Icône + libellé courts d'un élément posé, pour la liste. */
function descriptionElement(a) {
  if (a.type === "texte") {
    const t = (a.texte || "").replace(/\s+/g, " ").trim();
    return { icone: "🔤", label: t ? (t.length > 28 ? t.slice(0, 28) + "…" : t) : "Texte" };
  }
  if (a.type === "picto") {
    const perso = obtenirPictoPerso(a.picto);
    return { icone: perso ? "🖼️" : (glyphDePicto(a.picto) || "📍"), label: "Pictogramme" };
  }
  if (a.type === "image") return { icone: "🖼️", label: a.legende || "Photo" };
  if (a.type === "trait") return { icone: "📏", label: "Trait" };
  if (a.type === "dessin") return { icone: "✍️", label: "Dessin" };
  if (a.type === "forme") {
    const noms = { rect: "Rectangle", cercle: "Cercle", fleche: "Flèche" };
    const icones = { rect: "▭", cercle: "◯", fleche: "➤" };
    return { icone: icones[a.forme] || "▭", label: noms[a.forme] || "Forme" };
  }
  return { icone: "•", label: "Élément" };
}

/** (Re)construit la liste des éléments ajoutés sur la carte (avec filtre). */
function renderElementsListe() {
  const liste = document.getElementById("elements-liste");
  const vide = document.getElementById("elements-vide");
  if (!liste) return;
  liste.innerHTML = "";
  const elements = etat.annotations.filter((a) => elementDansFiltre(a, filtreElements));
  if (vide) {
    vide.hidden = elements.length > 0;
    vide.textContent = etat.annotations.length === 0
      ? "Aucun élément ajouté pour l'instant."
      : "Aucun élément de ce type.";
  }

  elements.forEach((a) => {
    const d = descriptionElement(a);
    const item = document.createElement("div");
    item.className = "element-item" + (etat.annotationActive === a ? " actif" : "");
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const icone = document.createElement("span");
    icone.className = "element-item-icone";
    if (a.type === "image" && a.src) {
      const img = document.createElement("img");
      img.src = a.src;
      icone.appendChild(img);
    } else if (a.type === "picto") {
      const perso = obtenirPictoPerso(a.picto);
      if (perso) { const im = document.createElement("img"); im.src = perso.src; icone.appendChild(im); }
      else icone.textContent = d.icone;
    } else {
      icone.textContent = d.icone;
      if (estAnnotationVecteur(a)) icone.style.color = a.couleur || "#b4452f";
    }

    const label = document.createElement("span");
    label.className = "element-item-label";
    label.textContent = d.label;

    const suppr = document.createElement("button");
    suppr.className = "icone-btn element-item-suppr";
    suppr.title = "Supprimer cet élément";
    suppr.textContent = "🗑";
    suppr.addEventListener("click", (e) => {
      e.stopPropagation();
      const etaitActif = etat.annotationActive === a;
      if (!etaitActif) selectionnerAnnotation(a);
      supprimerAnnotationActive();
      renderElementsListe();
    });

    const aller = () => {
      const pt = a.lat != null ? [a.lat, a.lng]
        : (Array.isArray(a.points) && a.points[0]) ? a.points[0] : null;
      if (pt) etat.carte.panTo(pt);
      selectionnerAnnotation(a);
      renderElementsListe();
      if (a.type === "texte" && typeof demarrerEditionTexte === "function") demarrerEditionTexte(a);
    };
    item.addEventListener("click", aller);
    item.addEventListener("keydown", (e) => { if (e.key === "Enter") aller(); });

    item.appendChild(icone);
    item.appendChild(label);
    item.appendChild(suppr);
    liste.appendChild(item);
  });
}

/** Ancien nom conservé : la liste des photos fait désormais partie des éléments. */
function renderImagesListe() {
  renderElementsListe();
}

/* =========================================================
   9. Onglet Outils : traits, formes, dessin à main levée
   ========================================================= */

// Libellés de la bannière selon l'outil en cours.
const LIBELLES_OUTILS = {
  trait: "📏 Clique point par point, puis « Terminer » (ou double-clique).",
  dessin: "✍️ Garde le clic appuyé et dessine sur la carte.",
  rect: "▭ Garde le clic appuyé et fais glisser pour tracer le rectangle.",
  cercle: "◯ Garde le clic appuyé et fais glisser pour tracer le cercle.",
  fleche: "➤ Garde le clic appuyé et fais glisser, de la base vers la pointe.",
};

let dessinEnCours = null; // { points | depart, apercu } pendant le tracé

/** Active un outil de dessin : le prochain geste sur la carte dessine. */
function armerOutil(type) {
  if (etat.vue !== "editeur" || etat.mode === "visualisation") return;
  desarmerOutil();
  desarmerAjout();
  desarmerAjoutAnnotation();
  deselectionnerAnnotation();

  etat.modeOutil = type;
  document.getElementById("map").classList.add("mode-ajout");
  document.getElementById("banniere-annot-texte").textContent = LIBELLES_OUTILS[type];
  document.getElementById("terminer-outil").hidden = type !== "trait";
  document.getElementById("banniere-annot").hidden = false;
  majBoutonsOutils();

  // Pendant un tracé à main levée / forme, la carte ne doit pas bouger.
  if (type !== "trait") etat.carte.dragging.disable();
  etat.carte.doubleClickZoom.disable();
}

/** Range l'outil en cours (et son aperçu). */
function desarmerOutil() {
  if (dessinEnCours && dessinEnCours.apercu) dessinEnCours.apercu.remove();
  dessinEnCours = null;
  if (!etat.modeOutil) return;
  etat.modeOutil = null;
  document.getElementById("map").classList.remove("mode-ajout");
  document.getElementById("banniere-annot").hidden = true;
  document.getElementById("terminer-outil").hidden = true;
  etat.carte.dragging.enable();
  etat.carte.doubleClickZoom.enable();
  majBoutonsOutils();
  // Si un élément vient d'être dessiné (donc sélectionné), son cadre
  // de sélection peut maintenant apparaître.
  if (typeof majSelectionUI === "function") majSelectionUI();
}

/** Surligne le bouton de l'outil actif. */
function majBoutonsOutils() {
  document.querySelectorAll("#panneau-outils .outil-btn[data-outil]").forEach((b) => {
    b.classList.toggle("actif", b.dataset.outil === etat.modeOutil);
  });
}

/** Style Leaflet d'un aperçu en cours de tracé. */
function styleApercu() {
  return {
    color: reglagesOutil.couleur,
    weight: reglagesOutil.epaisseur,
    opacity: 0.8,
    dashArray: "6 6",
    interactive: false,
  };
}

/* ---------- Trait : point par point ---------- */

function clicTrait(latlng) {
  if (!dessinEnCours) {
    dessinEnCours = { points: [latlng], apercu: L.polyline([latlng], styleApercu()).addTo(etat.carte) };
  } else {
    dessinEnCours.points.push(latlng);
    dessinEnCours.apercu.setLatLngs(dessinEnCours.points);
  }
}

function terminerTrait() {
  if (etat.modeOutil !== "trait" || !dessinEnCours || dessinEnCours.points.length < 2) {
    desarmerOutil();
    return;
  }
  creerAnnotationVecteur({
    type: "trait",
    points: dessinEnCours.points.map((p) => [p.lat, p.lng]),
  });
  desarmerOutil();
}

/* ---------- Dessin à main levée et formes : glisser-tracer ---------- */

function debutGlisse(latlng) {
  if (etat.modeOutil === "dessin") {
    dessinEnCours = { points: [latlng], apercu: L.polyline([latlng], styleApercu()).addTo(etat.carte) };
  } else {
    dessinEnCours = { depart: latlng, apercu: null };
  }
}

function pendantGlisse(latlng) {
  if (!dessinEnCours) return;
  const outil = etat.modeOutil;
  if (outil === "dessin") {
    dessinEnCours.points.push(latlng);
    dessinEnCours.apercu.setLatLngs(dessinEnCours.points);
    return;
  }
  const d = dessinEnCours.depart;
  if (dessinEnCours.apercu) dessinEnCours.apercu.remove();
  if (outil === "rect") {
    dessinEnCours.apercu = L.rectangle([d, latlng], styleApercu()).addTo(etat.carte);
  } else if (outil === "cercle") {
    const centre = [(d.lat + latlng.lat) / 2, (d.lng + latlng.lng) / 2];
    const rayon = etat.carte.distance(centre, [centre[0], latlng.lng]);
    dessinEnCours.apercu = L.circle(centre, { radius: Math.max(rayon, 1), ...styleApercu() }).addTo(etat.carte);
  } else if (outil === "fleche") {
    dessinEnCours.apercu = L.polyline(pointsFleche({
      lat: d.lat, lng: d.lng, lat2: latlng.lat, lng2: latlng.lng,
    }), styleApercu()).addTo(etat.carte);
  }
}

function finGlisse(latlng) {
  if (!dessinEnCours) return;
  const outil = etat.modeOutil;
  if (outil === "dessin") {
    if (dessinEnCours.points.length >= 2) {
      creerAnnotationVecteur({
        type: "dessin",
        points: dessinEnCours.points.map((p) => [p.lat, p.lng]),
      });
    }
  } else {
    const d = dessinEnCours.depart;
    const assezGrand = Math.abs(d.lat - latlng.lat) > 1e-7 || Math.abs(d.lng - latlng.lng) > 1e-7;
    if (assezGrand) {
      creerAnnotationVecteur({
        type: "forme",
        forme: outil === "rect" ? "rect" : outil === "cercle" ? "cercle" : "fleche",
        lat: d.lat, lng: d.lng, lat2: latlng.lat, lng2: latlng.lng,
        remplir: false,
      });
    }
  }
  if (dessinEnCours.apercu) dessinEnCours.apercu.remove();
  dessinEnCours = null;
  desarmerOutil();
}

/** Crée l'annotation dessinée, la pose sur la carte et la sélectionne. */
function creerAnnotationVecteur(champs) {
  const a = {
    id: prochainIdSouvenir++,
    couleur: reglagesOutil.couleur,
    epaisseur: reglagesOutil.epaisseur,
    // Zoom de référence : l'épaisseur du trait est pleine à ce zoom et
    // rétrécit quand on dézoome (comme les textes et pictogrammes).
    zoomRef: etat.carte.getZoom(),
    marker: null,
    ...champs,
  };
  etat.annotations.push(a);
  attacherAnnotationVecteur(a);
  selectionnerAnnotation(a);
  planifierSauvegarde();
}

/* ---------- Rendu des traits, formes et dessins ---------- */

/** Échelle d'un tracé selon le zoom courant (par rapport à son zoom de pose). */
function echelleVecteur(a) {
  const ref = typeof a.zoomRef === "number" ? a.zoomRef : (etat.zoomRefTrace || 14);
  return Math.max(0.15, Math.min(3, Math.pow(2, etat.carte.getZoom() - ref)));
}

/** Épaisseur du trait à afficher au zoom courant (jamais nulle). */
function poidsVecteur(a) {
  return Math.max(0.5, (a.epaisseur || 4) * echelleVecteur(a));
}

/** Les points d'une flèche : la ligne + les deux branches de la pointe. */
function pointsFleche(a) {
  // Angles calculés « à plat », avec la longitude corrigée par cos(latitude)
  // pour que la pointe garde une forme correcte partout en Europe.
  const k = Math.cos(((a.lat + a.lat2) / 2) * Math.PI / 180) || 1;
  const dx = (a.lng2 - a.lng) * k;
  const dy = a.lat2 - a.lat;
  const longueur = Math.hypot(dx, dy) || 1e-9;
  const ux = dx / longueur;
  const uy = dy / longueur;
  const t = longueur * 0.22; // taille de la pointe, proportionnelle

  const branche = (angle) => {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const bx = -ux * cos + uy * sin;   // direction inverse, tournée
    const by = -ux * sin - uy * cos;
    return [a.lat2 + t * by, a.lng2 + (t * bx) / k];
  };

  return [
    [a.lat, a.lng],
    [a.lat2, a.lng2],
    branche(0.45),
    [a.lat2, a.lng2],
    branche(-0.45),
  ];
}

/** Construit le calque Leaflet d'un trait / forme / dessin. */
function coucheAnnotationVecteur(a, interactif) {
  const style = {
    color: a.couleur || "#b4452f",
    weight: poidsVecteur(a),
    opacity: 0.9,
    interactive: interactif !== false,
  };
  if (a.type === "trait" || a.type === "dessin") {
    return L.polyline(a.points, style);
  }
  if (a.type === "forme" && a.forme === "rect") {
    return L.rectangle([[a.lat, a.lng], [a.lat2, a.lng2]], {
      ...style, fill: !!a.remplir, fillColor: style.color, fillOpacity: a.remplir ? 0.25 : 0,
    });
  }
  if (a.type === "forme" && a.forme === "cercle") {
    const centre = [(a.lat + a.lat2) / 2, (a.lng + a.lng2) / 2];
    const rayon = etat.carte.distance(centre, [centre[0], a.lng2]);
    return L.circle(centre, {
      radius: Math.max(rayon, 1),
      ...style, fill: !!a.remplir, fillColor: style.color, fillOpacity: a.remplir ? 0.25 : 0,
    });
  }
  if (a.type === "forme" && a.forme === "fleche") {
    return L.polyline(pointsFleche(a), style);
  }
  return null;
}

/** Pose (ou repose) le calque d'une annotation dessinée sur la carte. */
function attacherAnnotationVecteur(a) {
  const calque = coucheAnnotationVecteur(a, true);
  if (!calque) return null;
  calque.on("click", (e) => {
    if (etat.mode !== "edition" || etat.modeOutil) return;
    L.DomEvent.stopPropagation(e);
    selectionnerAnnotation(a);
  });
  calque.addTo(etat.carte);
  a.marker = calque;
  // Appuyer sur la forme la sélectionne et la déplace (selection.js).
  if (typeof brancherDeplacementVecteur === "function") brancherDeplacementVecteur(a);
  return calque;
}

/** Met à jour le style d'un trait / forme / dessin.
    (La sélection est montrée par le cadre à poignées, pas par le style.) */
function majStyleAnnotationVecteur(a) {
  if (!a || !a.marker || !a.marker.setStyle) return;
  a.marker.setStyle({
    color: a.couleur || "#b4452f",
    weight: poidsVecteur(a),
    opacity: 0.9,
    dashArray: null,
    fill: a.type === "forme" && !!a.remplir,
    fillColor: a.couleur || "#b4452f",
    fillOpacity: a.type === "forme" && a.remplir ? 0.25 : 0,
  });
}

/* =========================================================
   10. Impression depuis l'accueil + disposition de l'affiche
   ========================================================= */

/** Ouvre la fenêtre « quel carnet imprimer ? ». */
function ouvrirModalImpression() {
  const liste = document.getElementById("impr-liste");
  liste.innerHTML = "";
  if (etat.carnets.length === 0) {
    const p = document.createElement("p");
    p.className = "galerie-vide";
    p.textContent = "Aucun carnet à imprimer pour l'instant.";
    liste.appendChild(p);
  }
  etat.carnets.forEach((c) => {
    const item = document.createElement("button");
    item.className = "impr-item";
    const dates = libellePlageDates(c);
    item.innerHTML =
      `<span class="impr-logo">${echapperHtml(c.logo || "📖")}</span>` +
      `<span>${echapperHtml(c.nom)}` +
      (dates ? `<div class="impr-detail">📅 ${echapperHtml(dates)}</div>` : "") +
      `</span>`;
    item.addEventListener("click", () => imprimerCarnet(c.id));
    liste.appendChild(item);
  });
  document.getElementById("modal-impression").hidden = false;
}

function fermerModalImpression() {
  document.getElementById("modal-impression").hidden = true;
}

/** Ouvre le carnet demandé dans l'éditeur puis la mise en page d'impression. */
async function imprimerCarnet(id) {
  fermerModalImpression();
  await basculerVersEditeur(id);
  if (typeof carnetExportable === "function" && !carnetExportable()) {
    toast("Ce carnet est vide : ajoute une trace, une zone ou des souvenirs.", true);
    return;
  }
  ouvrirModalAffiche();
}

/**
 * Construit la liste « disposition » de la fenêtre d'impression :
 * cocher/décocher les souvenirs et changer leur ordre d'impression.
 */
function majDispositionAffiche() {
  // L'ordre proposé suit l'ordre du carnet ; les réglages sont remis à zéro
  // à chaque ouverture (on imprime ce qu'on voit).
  reglagesAffiche.ordre = etat.souvenirs.map((s) => s.id);
  reglagesAffiche.exclusions = [];

  const liste = document.getElementById("affiche-souvenirs-liste");
  liste.innerHTML = "";
  if (etat.souvenirs.length === 0) {
    const p = document.createElement("p");
    p.className = "galerie-vide";
    p.textContent = "Aucun souvenir : seule la carte sera imprimée.";
    liste.appendChild(p);
    return;
  }

  const redessiner = () => {
    liste.querySelectorAll(".affiche-souvenir-ligne").forEach((ligne, i) => {
      const id = reglagesAffiche.ordre[i];
      const s = etat.souvenirs.find((x) => x.id === id);
      ligne.querySelector(".affiche-souvenir-nom").textContent =
        `${i + 1}. ${s ? (s.nom || "Sans nom") : "?"}`;
      ligne.querySelector("input").checked = !reglagesAffiche.exclusions.includes(id);
      ligne.dataset.id = id;
    });
  };

  reglagesAffiche.ordre.forEach((id, i) => {
    const ligne = document.createElement("div");
    ligne.className = "affiche-souvenir-ligne";
    ligne.dataset.id = id;

    const coche = document.createElement("input");
    coche.type = "checkbox";
    coche.checked = true;
    coche.addEventListener("change", () => {
      const sid = Number(ligne.dataset.id);
      reglagesAffiche.exclusions = coche.checked
        ? reglagesAffiche.exclusions.filter((x) => x !== sid)
        : [...reglagesAffiche.exclusions, sid];
    });

    const nom = document.createElement("span");
    nom.className = "affiche-souvenir-nom";

    const monter = document.createElement("button");
    monter.className = "ordre-btn";
    monter.textContent = "↑";
    monter.title = "Imprimer plus tôt";
    monter.addEventListener("click", () => {
      const idx = reglagesAffiche.ordre.indexOf(Number(ligne.dataset.id));
      if (idx > 0) {
        [reglagesAffiche.ordre[idx - 1], reglagesAffiche.ordre[idx]] =
          [reglagesAffiche.ordre[idx], reglagesAffiche.ordre[idx - 1]];
        redessiner();
      }
    });
    const descendre = document.createElement("button");
    descendre.className = "ordre-btn";
    descendre.textContent = "↓";
    descendre.title = "Imprimer plus tard";
    descendre.addEventListener("click", () => {
      const idx = reglagesAffiche.ordre.indexOf(Number(ligne.dataset.id));
      if (idx >= 0 && idx < reglagesAffiche.ordre.length - 1) {
        [reglagesAffiche.ordre[idx + 1], reglagesAffiche.ordre[idx]] =
          [reglagesAffiche.ordre[idx], reglagesAffiche.ordre[idx + 1]];
        redessiner();
      }
    });

    ligne.appendChild(coche);
    ligne.appendChild(nom);
    ligne.appendChild(monter);
    ligne.appendChild(descendre);
    liste.appendChild(ligne);
  });
  redessiner();
}

/* =========================================================
   10 bis. Nouveau carnet (nom d'abord, GPX ensuite)
   ========================================================= */

// Format d'impression choisi à la création (sert de défaut à la zone, à
// l'auto-zone d'un GPX et à l'export). Modifiable ensuite dans l'éditeur.
const nouveauCarnetFormat = { format: "A4", orientation: "portrait" };

function ouvrirModalNouveauCarnet() {
  document.getElementById("modal-bienvenue").hidden = true;
  document.getElementById("nouveau-carnet-nom").value = "";
  nouveauCarnetFormat.format = "A4";
  nouveauCarnetFormat.orientation = "portrait";
  majSegment("nouveau-carnet-format", "nformat", nouveauCarnetFormat.format);
  majSegment("nouveau-carnet-orientation", "norientation", nouveauCarnetFormat.orientation);
  majOrientationNouveauCarnet();
  document.getElementById("modal-nouveau-carnet").hidden = false;
  document.getElementById("nouveau-carnet-nom").focus();
}

/** Désactive l'orientation pour les formats sans orientation (carré). */
function majOrientationNouveauCarnet() {
  const fixe = !!(FORMATS_ZONE[nouveauCarnetFormat.format] || {}).fixe;
  document.querySelectorAll("#nouveau-carnet-orientation .segment-btn")
    .forEach((b) => { b.disabled = fixe; });
}

function fermerModalNouveauCarnet() {
  document.getElementById("modal-nouveau-carnet").hidden = true;
  majPopupsAccueil(); // s'il n'y a toujours aucun carnet, la bienvenue revient
}

/**
 * Crée un carnet vierge (sans GPX) et l'ouvre dans l'éditeur.
 * Renvoie son identifiant, ou null si le nom manque.
 */
async function creerCarnetVierge(nom) {
  nom = (nom || "").trim();
  if (!nom) {
    toast("Donne un nom à ton carnet.", true);
    return null;
  }
  document.getElementById("modal-nouveau-carnet").hidden = true;
  await sauvegarderMaintenant();
  retirerTousFantomes();

  const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
  etat.carnets.push({
    id, uuid: genUuid(), nom: nom.slice(0, 60), visible: true,
    logo: "", categorie: "", description: "", modifieLe: new Date().toISOString(),
    statut: "actif",
    // Format d'impression du carnet (défaut de la zone + de l'export).
    formatZone: nouveauCarnetFormat.format,
    orientationZone: nouveauCarnetFormat.orientation,
  });
  etat.carnetActifId = id;
  viderCarnetCourant();
  await sauverIndexCarnets();
  renderCarnets();
  await basculerVersEditeur();
  return id;
}

/** Bouton « Créer un carnet vide » : sans lieu ni trace. */
async function creerNouveauCarnet() {
  const nom = document.getElementById("nouveau-carnet-nom").value.trim();
  const id = await creerCarnetVierge(nom);
  if (!id) return;
  ouvrirOnglet("carnets");
  toast(`Carnet « ${nom} » créé — ajoute un GPX, un point ou des souvenirs`);
}

/** Bouton « Situer d'un point » : crée le carnet puis attend un clic sur la carte. */
async function creerNouveauCarnetPoint() {
  const nom = document.getElementById("nouveau-carnet-nom").value.trim();
  const id = await creerCarnetVierge(nom);
  if (!id) return;
  armerPlacementPointCarnet();
}

/** Bouton « Importer un GPX » du nouveau carnet : crée le carnet puis charge le GPX. */
async function creerNouveauCarnetDepuisGpxChoisi(fichier) {
  if (!fichier) return;
  if (!/\.gpx$/i.test(fichier.name)) {
    toast("Merci de choisir un fichier .gpx", true);
    return;
  }
  const nomSaisi = document.getElementById("nouveau-carnet-nom").value.trim();
  const nom = nomSaisi || fichier.name.replace(/\.gpx$/i, "").slice(0, 60) || "Nouveau carnet";
  const id = await creerCarnetVierge(nom);
  if (!id) return;
  chargerFichierGpx(fichier);
  ouvrirOnglet("carnets");
}

/* ---------- Situer un carnet d'un point sur la carte ---------- */

let placementPointActif = false;

/** Passe en mode « clique sur la carte pour situer le carnet ». */
function armerPlacementPointCarnet() {
  placementPointActif = true;
  document.getElementById("map").classList.add("mode-ajout");
  const b = document.getElementById("banniere-annot");
  document.getElementById("banniere-annot-texte").textContent =
    "📍 Clique sur la carte pour situer ton carnet.";
  document.getElementById("terminer-outil").hidden = true;
  b.hidden = false;
  majEcranVide(); // masque l'écran « carnet vide » pendant le placement
}

/** Abandonne la pose du point (bouton Annuler, Échap). Renvoie true si elle était en cours. */
function annulerPlacementPointCarnet() {
  if (!placementPointActif) return false;
  placementPointActif = false;
  document.getElementById("banniere-annot").hidden = true;
  if (!etat.modeAjout) document.getElementById("map").classList.remove("mode-ajout");
  majEcranVide(); // l'écran « carnet vide » peut revenir
  return true;
}

/** Enregistre le point choisi pour le carnet ouvert et recadre dessus. */
function poserPointCarnet(latlng) {
  placementPointActif = false;
  document.getElementById("banniere-annot").hidden = true;
  if (!etat.modeAjout) document.getElementById("map").classList.remove("mode-ajout");
  const c = carnetActif();
  if (!c) return;
  c.point = { lat: latlng.lat, lng: latlng.lng };
  c.modifieLe = new Date().toISOString();
  etat.carte.setView([latlng.lat, latlng.lng], 13);
  majEcranVide();
  sauverIndexCarnets();
  if (typeof planifierPousseeNuage === "function") planifierPousseeNuage();
  toast("Carnet situé ! Ajoute des souvenirs, des photos et des éléments.");
  ouvrirOnglet("souvenirs");
}

/* ---------- Délimiter la zone de cadrage d'un carnet (formats + poignées) ---------- */

// Chaque format donne une PROPORTION largeur/hauteur en portrait (`base`).
// Les formats A partagent la proportion √2 (1/√2 ≈ 0,707 en portrait).
const FORMATS_ZONE = {
  A5:    { base: Math.SQRT1_2, papier: "A5", label: "A5" },
  A4:    { base: Math.SQRT1_2, papier: "A4", label: "A4" },
  A3:    { base: Math.SQRT1_2, papier: "A3", label: "A3" },
  A2:    { base: Math.SQRT1_2, papier: "A2", label: "A2" },
  carre: { base: 1,           papier: null, label: "Carré", fixe: true },
  photo: { base: 2 / 3,       papier: null, label: "Photo 3:2" },
  pano:  { base: 9 / 16,      papier: null, label: "Pano 16:9" },
};

/** Proportion largeur/hauteur (en pixels) d'un format selon l'orientation. */
function ratioZone(format, orientation) {
  const f = FORMATS_ZONE[format] || FORMATS_ZONE.A4;
  if (f.fixe) return f.base;
  return orientation === "paysage" ? 1 / f.base : f.base;
}

/** Format/orientation dont la proportion est la plus proche d'un ratio donné. */
function formatProcheRatio(r) {
  const cands = [];
  Object.keys(FORMATS_ZONE).forEach((f) => {
    const info = FORMATS_ZONE[f];
    cands.push([f, "portrait", info.base]);
    if (!info.fixe) cands.push([f, "paysage", 1 / info.base]);
  });
  let best = cands[0], bd = Infinity;
  cands.forEach((c) => { const d = Math.abs(Math.log(c[2] / r)); if (d < bd) { bd = d; best = c; } });
  return { format: best[0], orientation: best[1] };
}

let dessinZoneActif = false;   // vrai tant que l'éditeur de zone est ouvert
let editeurZone = null;        // état de l'éditeur en cours

/** Bouton « Délimiter une zone » du nouveau carnet : crée le carnet puis ouvre l'éditeur. */
async function creerNouveauCarnetZone() {
  const nom = document.getElementById("nouveau-carnet-nom").value.trim();
  const id = await creerCarnetVierge(nom);
  if (!id) return;
  armerDessinZoneCarnet();
}

/** Ouvre l'éditeur de zone : un rectangle au bon format, déplaçable et redimensionnable. */
function armerDessinZoneCarnet() {
  const c = carnetActif();
  if (!c) return;
  if (editeurZone) fermerEditeurZone(false);
  if (typeof annulerPlacementPointCarnet === "function") annulerPlacementPointCarnet();
  // On efface le masque de la zone existante pendant l'édition.
  if (etat.coucheZone) { etat.coucheZone.remove(); etat.coucheZone = null; }
  etat.carte.setMaxBounds(null);

  dessinZoneActif = true;
  etat.carte.dragging.disable();
  etat.carte.scrollWheelZoom.disable();
  etat.carte.doubleClickZoom.disable();
  document.getElementById("map").classList.add("mode-zone");

  const rectMap = document.getElementById("map").getBoundingClientRect();
  const zExist = typeof normaliserZone === "function" ? normaliserZone(c.zone) : null;

  // Format par défaut : celui choisi pour le carnet (à la création).
  let format = (c.formatZone && FORMATS_ZONE[c.formatZone]) ? c.formatZone : "A4";
  let orientation = c.orientationZone === "paysage" ? "paysage" : "portrait";
  let x, y, w, h;
  if (zExist) {
    // On repose le rectangle sur la zone existante (projection actuelle de la carte).
    const p1 = etat.carte.latLngToContainerPoint([zExist.nord, zExist.ouest]);
    const p2 = etat.carte.latLngToContainerPoint([zExist.sud, zExist.est]);
    x = Math.min(p1.x, p2.x); y = Math.min(p1.y, p2.y);
    w = Math.max(30, Math.abs(p2.x - p1.x)); h = Math.max(30, Math.abs(p2.y - p1.y));
    if (zExist.format && FORMATS_ZONE[zExist.format]) {
      format = zExist.format;
      orientation = zExist.orientation === "paysage" ? "paysage" : "portrait";
    } else {
      const proche = formatProcheRatio(w / h);
      format = proche.format; orientation = proche.orientation;
    }
  } else {
    const r = ratioZone(format, orientation);
    h = Math.min(rectMap.height * 0.7, (rectMap.width * 0.7) / r);
    w = h * r;
    x = (rectMap.width - w) / 2;
    y = (rectMap.height - h) / 2;
  }

  editeurZone = { format, orientation, x, y, w, h, rectMap };
  construireEditeurZone();
  majEcranVide();
}

/** Construit l'overlay de l'éditeur (rectangle, poignées, barre de formats). */
function construireEditeurZone() {
  const z = editeurZone;
  const host = document.getElementById("map");

  const el = document.createElement("div");
  el.className = "zone-editeur";
  el.id = "zone-editeur";

  const box = document.createElement("div");
  box.className = "zone-editeur-box";
  const ratioEl = document.createElement("div");
  ratioEl.className = "zone-editeur-ratio";
  box.appendChild(ratioEl);
  ["nw", "ne", "sw", "se"].forEach((coin) => {
    const p = document.createElement("span");
    p.className = "zone-editeur-poignee " + coin;
    p.addEventListener("pointerdown", (e) => demarrerResizeBox(e, coin));
    box.appendChild(p);
  });
  box.addEventListener("pointerdown", demarrerDeplacementBox);

  const barre = document.createElement("div");
  barre.className = "zone-editeur-barre";
  const gFmt = document.createElement("div");
  gFmt.className = "zeb-groupe";
  Object.keys(FORMATS_ZONE).forEach((f) => {
    const b = document.createElement("button");
    b.className = "zone-fmt-btn"; b.dataset.fmt = f; b.textContent = FORMATS_ZONE[f].label;
    b.addEventListener("click", () => { z.format = f; reformerBoxEditeur(); });
    gFmt.appendChild(b);
  });
  const gOri = document.createElement("div");
  gOri.className = "zeb-groupe";
  [["portrait", "Portrait"], ["paysage", "Paysage"]].forEach(([o, lib]) => {
    const b = document.createElement("button");
    b.className = "zone-ori-btn"; b.dataset.ori = o; b.textContent = lib;
    b.addEventListener("click", () => { z.orientation = o; reformerBoxEditeur(); });
    gOri.appendChild(b);
  });
  const bValider = document.createElement("button");
  bValider.className = "btn btn-accent btn-petit"; bValider.textContent = "Valider";
  bValider.addEventListener("click", validerEditeurZone);
  const bAnnuler = document.createElement("button");
  bAnnuler.className = "btn btn-ghost btn-petit"; bAnnuler.textContent = "Annuler";
  bAnnuler.addEventListener("click", () => fermerEditeurZone(true));

  const sep1 = document.createElement("span"); sep1.className = "zone-editeur-sep";
  const sep2 = document.createElement("span"); sep2.className = "zone-editeur-sep";
  barre.append(gFmt, sep1, gOri, sep2, bValider, bAnnuler);

  el.append(box, barre);
  host.appendChild(el);
  z.el = el; z.boxEl = box; z.ratioEl = ratioEl;
  majBoxEditeur();
}

/** Coordonnées d'un événement pointeur, relatives au conteneur de la carte. */
function pointDansCarte(e) {
  const r = document.getElementById("map").getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Reflète l'état (position, taille, libellés) dans le DOM. */
function majBoxEditeur() {
  const z = editeurZone; if (!z || !z.boxEl) return;
  z.boxEl.style.left = z.x + "px";
  z.boxEl.style.top = z.y + "px";
  z.boxEl.style.width = z.w + "px";
  z.boxEl.style.height = z.h + "px";
  const f = FORMATS_ZONE[z.format] || FORMATS_ZONE.A4;
  const suffixe = f.fixe ? "" : (z.orientation === "paysage" ? " · Paysage" : " · Portrait");
  if (z.ratioEl) z.ratioEl.textContent = f.label + suffixe;
  z.el.querySelectorAll(".zone-fmt-btn").forEach((b) => b.classList.toggle("actif", b.dataset.fmt === z.format));
  z.el.querySelectorAll(".zone-ori-btn").forEach((b) => {
    b.classList.toggle("actif", !f.fixe && b.dataset.ori === z.orientation);
    b.disabled = !!f.fixe;
  });
}

/** Borne le rectangle à l'intérieur de la carte (sans changer sa taille si possible). */
function clampBoxEditeur() {
  const z = editeurZone; const W = z.rectMap.width, H = z.rectMap.height;
  z.w = Math.min(z.w, W); z.h = Math.min(z.h, H);
  z.x = Math.max(0, Math.min(z.x, W - z.w));
  z.y = Math.max(0, Math.min(z.y, H - z.h));
}

/** Ré-applique la proportion du format courant (en gardant le centre). */
function reformerBoxEditeur() {
  const z = editeurZone; const r = ratioZone(z.format, z.orientation);
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const maxW = z.rectMap.width * 0.98, maxH = z.rectMap.height * 0.98;
  let h = z.h, w = h * r;
  if (w > maxW) { w = maxW; h = w / r; }
  if (h > maxH) { h = maxH; w = h * r; }
  z.w = w; z.h = h; z.x = cx - w / 2; z.y = cy - h / 2;
  clampBoxEditeur(); majBoxEditeur();
}

/** Déplacement du rectangle (glisser le corps, pas les poignées). */
function demarrerDeplacementBox(e) {
  if (e.target.classList.contains("zone-editeur-poignee")) return;
  e.preventDefault();
  const z = editeurZone;
  const debut = pointDansCarte(e);
  const ox = z.x, oy = z.y;
  const bouger = (ev) => {
    const p = pointDansCarte(ev);
    z.x = ox + (p.x - debut.x); z.y = oy + (p.y - debut.y);
    clampBoxEditeur(); majBoxEditeur();
  };
  const relacher = () => {
    window.removeEventListener("pointermove", bouger);
    window.removeEventListener("pointerup", relacher);
  };
  window.addEventListener("pointermove", bouger);
  window.addEventListener("pointerup", relacher);
}

/** Redimensionnement depuis une poignée de coin, en gardant la proportion. */
function demarrerResizeBox(e, coin) {
  e.preventDefault(); e.stopPropagation();
  const z = editeurZone;
  // Coin opposé (ancre fixe).
  const ax = coin.indexOf("w") >= 0 ? z.x + z.w : z.x;
  const ay = coin.indexOf("n") >= 0 ? z.y + z.h : z.y;
  const bouger = (ev) => {
    const p = pointDansCarte(ev);
    const r = ratioZone(z.format, z.orientation);
    let w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
    if (w / r >= h) h = w / r; else w = h * r;
    if (w < 40) { w = 40; h = w / r; }
    const maxW = z.rectMap.width, maxH = z.rectMap.height;
    if (w > maxW) { w = maxW; h = w / r; }
    if (h > maxH) { h = maxH; w = h * r; }
    z.w = w; z.h = h;
    z.x = (p.x >= ax) ? ax : ax - w;
    z.y = (p.y >= ay) ? ay : ay - h;
    clampBoxEditeur(); majBoxEditeur();
  };
  const relacher = () => {
    window.removeEventListener("pointermove", bouger);
    window.removeEventListener("pointerup", relacher);
  };
  window.addEventListener("pointermove", bouger);
  window.addEventListener("pointerup", relacher);
}

/** Valide : convertit le rectangle en coordonnées géo et enregistre la zone. */
function validerEditeurZone() {
  const z = editeurZone, c = carnetActif();
  if (!z || !c) return;
  const p1 = etat.carte.containerPointToLatLng(L.point(z.x, z.y));
  const p2 = etat.carte.containerPointToLatLng(L.point(z.x + z.w, z.y + z.h));
  const f = FORMATS_ZONE[z.format] || FORMATS_ZONE.A4;
  const orientation = f.fixe ? "portrait" : z.orientation;
  c.zone = {
    sud: Math.min(p1.lat, p2.lat), nord: Math.max(p1.lat, p2.lat),
    ouest: Math.min(p1.lng, p2.lng), est: Math.max(p1.lng, p2.lng),
    auto: false, format: z.format, orientation, ratio: z.w / z.h,
  };
  // Le format devient celui du carnet (défaut d'un prochain GPX / export).
  c.formatZone = z.format;
  c.orientationZone = orientation;
  c.modifieLe = new Date().toISOString();
  fermerEditeurZone(false);
  appliquerZoneCarnet(true);
  majBoutonsZone();
  majEcranVide();
  sauverIndexCarnets();
  if (typeof planifierPousseeNuage === "function") planifierPousseeNuage();
  toast("Zone enregistrée ! Modifiable depuis l'onglet Fond de carte.");
}

/** Ferme l'éditeur. `reappliquer` = remettre le masque de la zone déjà enregistrée. */
function fermerEditeurZone(reappliquer) {
  if (editeurZone && editeurZone.el) editeurZone.el.remove();
  editeurZone = null;
  dessinZoneActif = false;
  etat.carte.dragging.enable();
  etat.carte.scrollWheelZoom.enable();
  etat.carte.doubleClickZoom.enable();
  document.getElementById("map").classList.remove("mode-zone");
  if (reappliquer && typeof appliquerZoneCarnet === "function") appliquerZoneCarnet(false);
  majEcranVide();
}

/** Abandonne l'édition (bouton Annuler du bandeau, Échap). Renvoie true si actif. */
function annulerDessinZoneCarnet() {
  if (!dessinZoneActif && !editeurZone) return false;
  fermerEditeurZone(true);
  return true;
}

/** Retire la zone du carnet ouvert (l'affichage redevient libre). */
function retirerZoneCarnet() {
  const c = carnetActif();
  if (!c || !c.zone) return;
  c.zone = null;
  c.modifieLe = new Date().toISOString();
  if (typeof appliquerZoneCarnet === "function") appliquerZoneCarnet(false);
  // On recadre sur la trace ou le point, faute de zone.
  if (etat.trace && typeof recadrerSurParcours === "function") recadrerSurParcours();
  else if (c.point) etat.carte.setView([c.point.lat, c.point.lng], 13);
  majBoutonsZone();
  sauverIndexCarnets();
  if (typeof planifierPousseeNuage === "function") planifierPousseeNuage();
  toast("Zone retirée.");
}

/** Met à jour l'état affiché + les libellés des boutons de zone (onglet Carnet). */
function majBoutonsZone() {
  const c = carnetActif();
  const etatEl = document.getElementById("zone-etat");
  const btnDef = document.getElementById("zone-definir");
  const btnRet = document.getElementById("zone-retirer");
  if (!etatEl || !btnDef || !btnRet) return;
  const z = c && typeof normaliserZone === "function" ? normaliserZone(c.zone) : null;
  if (z) {
    const f = FORMATS_ZONE[z.format];
    let libelle = "✓ Zone définie";
    if (f) libelle += " — format " + f.label + (f.fixe ? "" : (z.orientation === "paysage" ? " paysage" : " portrait"));
    else if (z.auto) libelle += " (automatique, autour du GPX)";
    etatEl.textContent = libelle + ".";
  } else {
    etatEl.textContent = "Aucune zone définie.";
  }
  btnDef.textContent = z ? "🗺️ Modifier la zone" : "🗺️ Définir la zone";
  btnRet.hidden = !z;
}

/* =========================================================
   10 ter. Carte globale : style propre + titre « LogBookMap de … »
   ========================================================= */

const CLE_CARTE_GLOBALE = "carte-globale-style";
// Le titre (bandeau) et la rose des vents de la carte globale sont MASQUÉS par
// défaut : à l'utilisateur de les activer dans « 🎨 Style de la carte globale ».
let styleCarteGlobale = { fond: "clair", ambiance: "naturel", titre: false, rose: false };
try {
  const lu = JSON.parse(localStorage.getItem(CLE_CARTE_GLOBALE) || "{}");
  if (["topo", "clair", "epure", "satellite"].includes(lu.fond)) styleCarteGlobale.fond = lu.fond;
  if (["naturel", "ancien", "doux", "medieval"].includes(lu.ambiance)) styleCarteGlobale.ambiance = lu.ambiance;
  if (typeof lu.titre === "boolean") styleCarteGlobale.titre = lu.titre;
  if (typeof lu.rose === "boolean") styleCarteGlobale.rose = lu.rose;
} catch (e) { /* premiers pas : style par défaut */ }

/** Applique le style de la CARTE GLOBALE (sans toucher au style des carnets). */
function appliquerStyleCarteGlobale() {
  if (etat.vue !== "accueil") return;
  etat.glMap = null;
  majClasseAncienne(false);
  let url, options;
  if (styleCarteGlobale.fond === "satellite") {
    const ex = FONDS_EXEMPLES.satellite;
    url = ex.url;
    options = { maxZoom: ex.maxZoom || 19, crossOrigin: "anonymous", attribution: ex.attribution || "" };
  } else {
    const fond = FONDS[styleCarteGlobale.fond] || FONDS.clair;
    url = fond.url;
    options = fond.options;
  }
  if (etat.coucheFond) etat.coucheFond.remove();
  // Comme dans l'éditeur : on peut zoomer au-delà du zoom fourni par le fond,
  // les dernières tuiles étant alors agrandies (copie des options, l'objet
  // FONDS étant partagé).
  const optionsZoom = {
    ...options,
    maxNativeZoom: options.maxZoom || 19,
    maxZoom: ZOOM_MAX_APP,
  };
  etat.carte.setMaxZoom(ZOOM_MAX_APP);
  etat.coucheFond = L.tileLayer(url, optionsZoom).addTo(etat.carte);
  appliquerAmbiance(styleCarteGlobale.ambiance);
  appliquerDecorGlobal();
}

/**
 * Décor de la carte globale : titre (bandeau) et rose des vents, chacun
 * affiché seulement si l'utilisateur l'a activé. Masque au passage les
 * décors PROPRES AUX CARNETS (cartouche, bordure) pour qu'ils ne débordent
 * pas sur la carte d'accueil.
 */
function appliquerDecorGlobal() {
  // Décors de carnet : jamais sur l'accueil.
  const carteTitre = document.getElementById("carte-titre");
  if (carteTitre) carteTitre.hidden = true;
  const bordure = document.getElementById("bordure-carte");
  if (bordure) bordure.hidden = true;

  // Rose des vents de la carte globale (masquée par défaut).
  const roseEl = document.getElementById("rose-carte");
  if (roseEl) {
    roseEl.hidden = !styleCarteGlobale.rose;
    if (styleCarteGlobale.rose && typeof ROSES_VENTS !== "undefined") {
      roseEl.innerHTML = (ROSES_VENTS.classique || {}).svg || roseEl.innerHTML;
    }
  }
  majTitreCarteGlobale();
}

function ouvrirModalCarteGlobale() {
  majSegment("global-fond", "gfond", styleCarteGlobale.fond);
  majSegment("global-ambiance", "gambiance", styleCarteGlobale.ambiance);
  const t = document.getElementById("global-titre");
  if (t) t.checked = !!styleCarteGlobale.titre;
  const r = document.getElementById("global-rose");
  if (r) r.checked = !!styleCarteGlobale.rose;
  document.getElementById("modal-carte-globale").hidden = false;
}

function sauverStyleCarteGlobale() {
  try { localStorage.setItem(CLE_CARTE_GLOBALE, JSON.stringify(styleCarteGlobale)); } catch (e) {}
}

/** Le titre affiché sur la carte globale : « LogBookMap de <pseudo> » (si activé). */
function majTitreCarteGlobale() {
  const el = document.getElementById("accueil-titre");
  if (!el) return;
  // Masqué par défaut : ne s'affiche que si l'utilisateur l'a activé.
  if (etat.vue === "accueil" && !styleCarteGlobale.titre) {
    el.hidden = true;
    return;
  }
  el.hidden = etat.vue !== "accueil";
  const pseudo = typeof lirePseudo === "function" ? lirePseudo() : "";
  el.textContent = pseudo ? `LogBookMap de ${pseudo}` : "LogBookMap";
}

/* =========================================================
   10 quater. Les GPX du carnet (liste, ajout, suppression)
   ========================================================= */

/** (Re)construit la liste des traces GPX du carnet ouvert. */
function renderGpxListe() {
  const liste = document.getElementById("gpx-liste");
  const vide = document.getElementById("gpx-vide");
  if (!liste) return;
  liste.innerHTML = "";
  vide.hidden = etat.gpxListe.length > 0;

  etat.gpxListe.forEach((g) => {
    const km = typeof longueurKm === "function" ? longueurKm(g.segments) : 0;
    const ligne = document.createElement("div");
    ligne.className = "gpx-ligne";
    const nom = document.createElement("span");
    nom.className = "gpx-nom";
    nom.textContent = `🥾 ${g.nom}`;
    const detail = document.createElement("span");
    detail.className = "gpx-detail";
    detail.textContent = km ? `${km.toFixed(1)} km` : "";
    const suppr = document.createElement("button");
    suppr.className = "icone-btn";
    suppr.title = "Retirer cette trace du carnet";
    suppr.textContent = "🗑";
    suppr.addEventListener("click", () => retirerGpx(g.id));
    ligne.appendChild(nom);
    ligne.appendChild(detail);
    ligne.appendChild(suppr);
    liste.appendChild(ligne);
  });
}

/** Retire une trace GPX du carnet (avec confirmation). */
async function retirerGpx(id) {
  const g = etat.gpxListe.find((x) => x.id === id);
  if (!g) return;
  const ok = await demanderConfirmation(
    `Retirer « ${g.nom} » ?`,
    "Cette trace ne sera plus dessinée sur la carte du carnet (tes souvenirs restent en place).",
    { okLibelle: "Retirer" }
  );
  if (!ok) return;
  etat.gpxListe = etat.gpxListe.filter((x) => x.id !== id);
  fusionnerTraces();
  if (etat.trace) {
    afficherTrace(etat.trace);
  } else if (etat.coucheTrace) {
    etat.coucheTrace.remove();
    etat.coucheTrace = null;
    document.getElementById("trace-info").hidden = true;
    majEcranVide();
  }
  if (typeof majZoneAutoApresGpx === "function") majZoneAutoApresGpx();
  renderGpxListe();
  planifierSauvegarde();
}

/* =========================================================
   10 quinquies. Partage du carnet ouvert
   ========================================================= */

/** (Re)construit la section Partage de l'onglet Carnet. */
async function renderPartagesUI() {
  const connecte = typeof nuageConnecte === "function" && nuageConnecte();
  document.getElementById("partage-connecte").hidden = !connecte;
  document.getElementById("partage-deconnecte").hidden = connecte;
  const liste = document.getElementById("partage-liste");
  liste.innerHTML = "";
  const c = carnetActif();
  if (!connecte || !c) return;

  if (c.partage) {
    const p = document.createElement("p");
    p.className = "style-aide";
    p.textContent = `Ce carnet t'a été partagé (${c.partage.droit === "edition" ? "édition" : "lecture"}) : seule la personne qui l'a créé gère sa liste de partage.`;
    liste.appendChild(p);
    document.querySelector(".partage-ajout").hidden = true;
    document.getElementById("partage-ajouter").hidden = true;
    return;
  }
  document.querySelector(".partage-ajout").hidden = false;
  document.getElementById("partage-ajouter").hidden = false;

  const partages = await listerPartages(c.uuid);
  if (partages.length === 0) {
    const p = document.createElement("p");
    p.className = "galerie-vide";
    p.textContent = "Ce carnet n'est partagé avec personne.";
    liste.appendChild(p);
    return;
  }
  partages.forEach((p) => {
    const ligne = document.createElement("div");
    ligne.className = "gpx-ligne";
    const email = document.createElement("span");
    email.className = "gpx-nom";
    email.textContent = p.email;
    const droit = document.createElement("span");
    droit.className = "gpx-detail";
    droit.textContent = p.droit === "edition" ? "✏️ édition" : "👁 lecture";
    const suppr = document.createElement("button");
    suppr.className = "icone-btn";
    suppr.title = "Ne plus partager avec cette personne";
    suppr.textContent = "✕";
    suppr.addEventListener("click", async () => {
      try {
        await retirerPartage(c.uuid, p.email);
        renderPartagesUI();
        toast(`Partage retiré pour ${p.email}`);
      } catch (e) { toast("Impossible de retirer ce partage.", true); }
    });
    ligne.appendChild(email);
    ligne.appendChild(droit);
    ligne.appendChild(suppr);
    liste.appendChild(ligne);
  });
}

/** Ajoute la personne saisie à la liste de partage du carnet ouvert. */
async function ajouterPartageDepuisFormulaire() {
  const c = carnetActif();
  if (!c) return;
  const email = document.getElementById("partage-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("Écris une adresse e-mail valide.", true);
    return;
  }
  const droit = document.getElementById("partage-droit").value;
  try {
    await ajouterPartage(c.uuid, email, droit);
    document.getElementById("partage-email").value = "";
    renderPartagesUI();
    toast(`Carnet partagé avec ${email} — il apparaîtra sur sa carte globale`);
  } catch (e) {
    toast("Partage impossible : vérifie ta connexion (et que le SQL « partage » a bien été installé).", true);
  }
}

/* =========================================================
   10 sexies. Tailles liées au niveau de zoom
   ========================================================= */

/**
 * À chaque zoom : les épingles de souvenirs et les éléments posés
 * (pictos, textes, photos) rétrécissent quand on dézoome, et les
 * éléments décoratifs disparaissent en dézoom fort. Les traits et
 * formes dessinés suivent déjà la géographie, rien à faire pour eux.
 */
let timerEchelles = null;
function majEchellesZoom() {
  if (timerEchelles) return;
  // Un petit minuteur (et pas requestAnimationFrame, qui ne tourne pas dans
  // un onglet en arrière-plan) : plusieurs appels rapprochés n'en font qu'un.
  timerEchelles = setTimeout(() => {
    timerEchelles = null;
    const z = etat.carte.getZoom();

    // Épingles de souvenirs : pleine taille au zoom du carnet, mini 40 %.
    const eSouvenir = Math.max(0.4, Math.min(1.2, Math.pow(2, (z - etat.zoomRefTrace) * 0.5)));
    etat.souvenirs.forEach((s) => {
      if (!s.marker) return;
      const el = s.marker.getElement && s.marker.getElement();
      if (!el) return; // fondue dans une grappe
      const wrap = el.querySelector(".pin-wrap");
      if (!wrap) return;
      wrap.style.transformOrigin = wrap.dataset.ancre === "pointe" ? "50% 100%" : "50% 50%";
      wrap.style.transform = `scale(${eSouvenir})`;
    });

    // Éléments posés : taille pleine à leur zoom de pose. Ils rétrécissent
    // au dézoom mais ne disparaissent jamais (minuscules au minimum).
    etat.annotations.forEach((a) => {
      if (!a.marker) return;
      // Traits, formes, dessins : on ajuste l'épaisseur du trait au zoom.
      if (estAnnotationVecteur(a)) {
        if (a.marker.setStyle) a.marker.setStyle({ weight: poidsVecteur(a) });
        return;
      }
      const el = a.marker.getElement && a.marker.getElement();
      if (!el) return;
      const ref = typeof a.zoomRef === "number" ? a.zoomRef : 14;
      const echelle = Math.max(0.12, Math.min(1.3, Math.pow(2, z - ref)));
      el.style.display = ""; // toujours affiché, même minuscule
      const wrap = el.querySelector(".annot-wrap") || el.firstElementChild;
      if (wrap) {
        // Le translate(-50%,-50%) centre l'élément sur son point : on le
        // garde, et on ajoute l'échelle puis l'éventuelle rotation.
        wrap.style.transform =
          `translate(-50%, -50%) scale(${echelle}) rotate(${a.rotation || 0}deg)`;
      }
    });

    // Le cadre de sélection suit la nouvelle taille de l'élément actif.
    if (typeof majSelectionUI === "function") majSelectionUI();
  }, 30);
}

/* =========================================================
   11. Rafraîchissement différé des listes
   ========================================================= */

let timerListes = null;

/** Replanifie la mise à jour des listes (appelé par planifierSauvegarde). */
function planifierMajListes() {
  clearTimeout(timerListes);
  timerListes = setTimeout(() => {
    majEchellesZoom(); // les nouveaux éléments prennent leur taille de zoom
    if (ongletOuvert === "souvenirs") renderSouvenirsListe();
    if (ongletOuvert === "outils") renderImagesListe();
    const c = carnetActif();
    if (c) {
      const dates = libellePlageDates(c);
      document.getElementById("meta-dates").textContent =
        "📅 Dates : " + (dates || "aucune (elles suivent les dates de tes souvenirs)");
    }
    if (etat.vue === "accueil") renderAccueilListe();
  }, 400);
}

/* =========================================================
   12. Branchements (une seule fois, au démarrage)
   ========================================================= */

function brancherUI() {
  /* --- Barre du haut --- */
  document.getElementById("btn-retour-accueil")
    .addEventListener("click", () => basculerVersAccueil());
  document.getElementById("editeur-identite")
    .addEventListener("click", () => ouvrirOnglet("carnets"));
  document.getElementById("accueil-imprimer")
    .addEventListener("click", ouvrirModalImpression);
  document.getElementById("impr-annuler")
    .addEventListener("click", fermerModalImpression);

  /* --- Rail d'onglets --- */
  document.querySelectorAll("#rail .rail-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const nom = b.dataset.onglet;
      const section = document.getElementById(ONGLETS[nom]);
      // Re-cliquer sur l'onglet déjà ouvert (et visible) le referme.
      if (ongletOuvert === nom && section && !section.hidden) fermerTiroir();
      else ouvrirOnglet(nom);
    });
  });
  // Boutons ✕ des sections (les trois « historiques » ferment déjà leur
  // section via app.js ; ceux-ci couvrent les nouvelles sections).
  document.querySelectorAll(".tiroir-fermer").forEach((b) => {
    b.addEventListener("click", fermerTiroir);
  });
  ["fermer-carnets", "fermer-reserve", "fermer-fond"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      ongletOuvert = null;
      majRailActif();
    });
  });

  /* --- Accueil : filtres --- */
  document.getElementById("accueil-recherche")
    .addEventListener("input", (e) => {
      filtreAccueil.texte = e.target.value;
      appliquerFiltresAccueil();
    });
  document.getElementById("accueil-categorie")
    .addEventListener("change", (e) => {
      filtreAccueil.categorie = e.target.value;
      appliquerFiltresAccueil();
    });
  document.getElementById("accueil-du")
    .addEventListener("change", (e) => {
      filtreAccueil.du = e.target.value;
      appliquerFiltresAccueil();
    });
  document.getElementById("accueil-au")
    .addEventListener("change", (e) => {
      filtreAccueil.au = e.target.value;
      appliquerFiltresAccueil();
    });
  document.getElementById("accueil-reset")
    .addEventListener("click", () => {
      filtreAccueil.texte = "";
      filtreAccueil.categorie = "";
      filtreAccueil.du = "";
      filtreAccueil.au = "";
      document.getElementById("accueil-recherche").value = "";
      document.getElementById("accueil-categorie").value = "";
      document.getElementById("accueil-du").value = "";
      document.getElementById("accueil-au").value = "";
      appliquerFiltresAccueil();
    });

  /* --- Accueil : nouveau carnet, recherche repliée, style de la carte --- */
  document.getElementById("accueil-nouveau")
    .addEventListener("click", ouvrirModalNouveauCarnet);
  document.getElementById("nouveau-carnet-creer")
    .addEventListener("click", creerNouveauCarnet);
  document.getElementById("nouveau-carnet-zone")
    .addEventListener("click", creerNouveauCarnetZone);
  brancherSegment("nouveau-carnet-format", "nformat", (v) => {
    nouveauCarnetFormat.format = v;
    majSegment("nouveau-carnet-format", "nformat", v);
    majOrientationNouveauCarnet();
  });
  brancherSegment("nouveau-carnet-orientation", "norientation", (v) => {
    nouveauCarnetFormat.orientation = v;
    majSegment("nouveau-carnet-orientation", "norientation", v);
  });
  document.getElementById("zone-definir")
    .addEventListener("click", armerDessinZoneCarnet);
  document.getElementById("zone-retirer")
    .addEventListener("click", retirerZoneCarnet);
  document.getElementById("nouveau-carnet-gpx-input")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      creerNouveauCarnetDepuisGpxChoisi(fichier);
    });
  document.getElementById("nouveau-carnet-annuler")
    .addEventListener("click", fermerModalNouveauCarnet);
  document.getElementById("nouveau-carnet-nom")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") creerNouveauCarnetZone(); });
  document.getElementById("bienvenue-connexion")
    .addEventListener("click", () => {
      document.getElementById("modal-bienvenue").hidden = true;
      ouvrirModalCompte();
    });
  document.getElementById("bienvenue-local")
    .addEventListener("click", () => {
      document.getElementById("modal-bienvenue").hidden = true;
      ouvrirModalNouveauCarnet();
    });
  document.getElementById("accueil-rechercher")
    .addEventListener("click", () => {
      const filtres = document.getElementById("accueil-filtres");
      filtres.hidden = !filtres.hidden;
      if (!filtres.hidden) document.getElementById("accueil-recherche").focus();
    });
  document.getElementById("accueil-style-btn")
    .addEventListener("click", ouvrirModalCarteGlobale);
  document.getElementById("carte-globale-fermer")
    .addEventListener("click", () => {
      document.getElementById("modal-carte-globale").hidden = true;
    });
  brancherSegment("global-fond", "gfond", (v) => {
    styleCarteGlobale.fond = v;
    majSegment("global-fond", "gfond", v);
    sauverStyleCarteGlobale();
    appliquerStyleCarteGlobale();
  });
  brancherSegment("global-ambiance", "gambiance", (v) => {
    styleCarteGlobale.ambiance = v;
    majSegment("global-ambiance", "gambiance", v);
    sauverStyleCarteGlobale();
    appliquerStyleCarteGlobale();
  });
  document.getElementById("global-titre")
    .addEventListener("change", (e) => {
      styleCarteGlobale.titre = e.target.checked;
      sauverStyleCarteGlobale();
      appliquerDecorGlobal();
    });
  document.getElementById("global-rose")
    .addEventListener("change", (e) => {
      styleCarteGlobale.rose = e.target.checked;
      sauverStyleCarteGlobale();
      appliquerDecorGlobal();
    });

  // L'écran « carnet vide » de l'éditeur : GPX direct ou exemple.
  document.getElementById("btn-exemple")
    .addEventListener("click", () => {
      if (etat.vue === "accueil") basculerVersEditeur();
    });
  // …ou situer le carnet en délimitant une zone, sans GPX.
  document.getElementById("welcome-point")
    .addEventListener("click", () => {
      if (etat.vue !== "editeur") return;
      armerDessinZoneCarnet();
    });

  /* --- Onglet Carnet : partage --- */
  document.getElementById("partage-ajouter")
    .addEventListener("click", ajouterPartageDepuisFormulaire);

  /* --- Onglet Carnets : identité + duplication --- */
  document.getElementById("meta-logo")
    .addEventListener("input", (e) => saisirMeta("logo", e.target.value));
  document.getElementById("meta-nom")
    .addEventListener("input", (e) => saisirMeta("nom", e.target.value));
  document.getElementById("meta-categorie")
    .addEventListener("input", (e) => saisirMeta("categorie", e.target.value.trim()));
  document.getElementById("meta-description")
    .addEventListener("input", (e) => saisirMeta("description", e.target.value));
  document.getElementById("carnet-dupliquer")
    .addEventListener("click", () => dupliquerCarnet());

  /* --- Onglet Outils : poser un souvenir (même mode que le bouton flottant) --- */
  document.getElementById("outil-souvenir")
    .addEventListener("click", () => { if (typeof basculerAjout === "function") basculerAjout(); });

  /* --- Onglet Souvenirs --- */
  document.getElementById("souvenir-nouveau")
    .addEventListener("click", ouvrirModalSouvenir);
  document.getElementById("souvenir-nouveau-annuler")
    .addEventListener("click", fermerModalSouvenir);
  document.getElementById("souvenir-nouveau-creer")
    .addEventListener("click", creerSouvenirRapide);
  document.getElementById("souvenir-nouveau-nom")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") creerSouvenirRapide();
    });
  document.querySelectorAll("#modal-souvenir .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const quoi = chip.dataset.daterapide;
      if (quoi === "aujourdhui") dateChoisie = versIso(new Date());
      else if (quoi === "hier") {
        const hier = new Date();
        hier.setDate(hier.getDate() - 1);
        dateChoisie = versIso(hier);
      } else dateChoisie = "";
      if (dateChoisie) moisAffiche = new Date(dateChoisie);
      construireCalendrier();
    });
  });
  document.querySelectorAll("#souvenirs-filtre .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      filtreSouvenirs = chip.dataset.souvfiltre;
      document.querySelectorAll("#souvenirs-filtre .chip").forEach((c) =>
        c.classList.toggle("actif", c === chip));
      renderSouvenirsListe();
    });
  });
  brancherDepotSurCarte();

  // Filtre de la liste des éléments ajoutés (onglet Outils).
  document.querySelectorAll("#elements-filtre .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      filtreElements = chip.dataset.elemfiltre;
      document.querySelectorAll("#elements-filtre .chip").forEach((c) =>
        c.classList.toggle("actif", c === chip));
      renderElementsListe();
    });
  });

  /* --- Onglet Textes : préréglages --- */
  document.getElementById("texte-ajouter-titre")
    .addEventListener("click", () => armerTextePreset({
      texte: "Titre", taille: 34, gras: true, police: "titre",
    }));
  document.getElementById("texte-ajouter-lieu")
    .addEventListener("click", () => armerTextePreset({
      texte: "Nom du lieu", taille: 20, italique: true, police: "serif",
    }));
  document.getElementById("texte-ajouter-libre")
    .addEventListener("click", () => armerTextePreset({
      texte: "Nouveau texte", taille: 16, police: "serif",
    }));

  /* --- Éditeur d'élément : souligné, barré, légende, style des dessins --- */
  document.getElementById("annot-souligne")
    .addEventListener("click", (e) => {
      const a = etat.annotationActive;
      if (!a) return;
      majAnnotationActive({ souligne: !a.souligne });
      e.currentTarget.classList.toggle("actif", a.souligne);
    });
  document.getElementById("annot-barre")
    .addEventListener("click", (e) => {
      const a = etat.annotationActive;
      if (!a) return;
      majAnnotationActive({ barre: !a.barre });
      e.currentTarget.classList.toggle("actif", a.barre);
    });
  document.getElementById("annot-legende")
    .addEventListener("input", (e) => {
      majAnnotationActive({ legende: e.target.value });
      if (ongletOuvert === "outils") renderElementsListe();
    });
  document.getElementById("annot-trait-couleur")
    .addEventListener("input", (e) => majAnnotationActive({ couleur: e.target.value }));
  document.getElementById("annot-trait-epaisseur")
    .addEventListener("input", (e) => {
      const epaisseur = parseInt(e.target.value, 10);
      document.getElementById("annot-trait-epaisseur-val").textContent = epaisseur;
      majAnnotationActive({ epaisseur });
    });
  document.getElementById("annot-remplir")
    .addEventListener("change", (e) => majAnnotationActive({ remplir: e.target.checked }));

  /* --- Fond de carte : épingles des souvenirs --- */
  construireNuancier("epingle-couleurs", choisirCouleurEpingle);
  majControlesEpingle();
  brancherSegment("epingle-forme", "forme", (v) => {
    etat.style.epingles.forme = EPINGLE_FORMES.includes(v) ? v : "goutte";
    majSegment("epingle-forme", "forme", etat.style.epingles.forme);
    appliquerStyleEpingles();
    planifierSauvegarde();
  });
  document.getElementById("epingle-couleur-perso")
    .addEventListener("input", (e) => choisirCouleurEpingle(e.target.value));
  document.getElementById("epingle-taille")
    .addEventListener("input", (e) => {
      etat.style.epingles.taille = parseInt(e.target.value, 10);
      document.getElementById("epingle-taille-val").textContent = e.target.value;
      appliquerStyleEpingles();
      planifierSauvegarde();
    });
  document.getElementById("epingle-numero")
    .addEventListener("change", (e) => {
      etat.style.epingles.numero = e.target.checked;
      appliquerStyleEpingles();
      planifierSauvegarde();
    });
  // Import d'une image d'épingle personnalisée.
  document.getElementById("epingle-image-input")
    .addEventListener("change", async (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      if (!fichier || !fichier.type.startsWith("image/")) return;
      try {
        // Format PNG : préserve la transparence (idéal pour une épingle).
        const src = await importerImage(fichier, 200, "image/png");
        etat.style.epingles.image = src;
        etat.style.epingles.forme = "perso";
        majControlesEpingle();
        appliquerStyleEpingles();
        planifierSauvegarde();
        toast("Épingle personnalisée appliquée");
      } catch (err) {
        toast("Impossible de lire cette image.", true);
      }
    });
  document.getElementById("epingle-image-retirer")
    .addEventListener("click", () => {
      etat.style.epingles.image = null;
      if (etat.style.epingles.forme === "perso") etat.style.epingles.forme = "goutte";
      majControlesEpingle();
      appliquerStyleEpingles();
      planifierSauvegarde();
    });

  /* --- Onglet Importer --- */
  document.getElementById("importer-photo-input")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      importerPhotoSurCarte(fichier);
    });

  /* --- Onglet Outils --- */
  document.querySelectorAll("#panneau-outils .outil-btn[data-outil]").forEach((b) => {
    b.addEventListener("click", () => {
      if (etat.modeOutil === b.dataset.outil) desarmerOutil();
      else armerOutil(b.dataset.outil);
    });
  });
  document.getElementById("outil-couleur")
    .addEventListener("input", (e) => { reglagesOutil.couleur = e.target.value; });
  document.getElementById("outil-epaisseur")
    .addEventListener("input", (e) => {
      reglagesOutil.epaisseur = parseInt(e.target.value, 10);
      document.getElementById("outil-epaisseur-val").textContent = e.target.value;
    });
  document.getElementById("terminer-outil")
    .addEventListener("click", terminerTrait);
  document.getElementById("annuler-annot")
    .addEventListener("click", () => {
      // Le bouton « Annuler » du bandeau sert aussi au tracé de zone et à la pose d'un point.
      if (annulerDessinZoneCarnet()) return;
      if (annulerPlacementPointCarnet()) return;
      desarmerOutil();
    });

  /* --- Gestes de dessin sur la carte (souris ET doigt : pointer events) --- */
  etat.carte.on("click", (e) => {
    if (etat.modeOutil === "trait") clicTrait(e.latlng);
  });
  etat.carte.on("dblclick", () => {
    if (etat.modeOutil === "trait") terminerTrait();
  });
  const mapEl = document.getElementById("map");
  mapEl.addEventListener("pointerdown", (e) => {
    if (!etat.modeOutil || etat.modeOutil === "trait" || etat.vue !== "editeur") return;
    e.preventDefault();
    try { mapEl.setPointerCapture(e.pointerId); } catch (err) {}
    debutGlisse(etat.carte.mouseEventToLatLng(e));
  });
  mapEl.addEventListener("pointermove", (e) => {
    if (!etat.modeOutil || etat.modeOutil === "trait" || !dessinEnCours) return;
    e.preventDefault();
    pendantGlisse(etat.carte.mouseEventToLatLng(e));
  });
  mapEl.addEventListener("pointerup", (e) => {
    if (!etat.modeOutil || etat.modeOutil === "trait" || !dessinEnCours) return;
    e.preventDefault();
    finGlisse(etat.carte.mouseEventToLatLng(e));
  });
  mapEl.addEventListener("pointercancel", () => {
    if (dessinEnCours && dessinEnCours.apercu) dessinEnCours.apercu.remove();
    dessinEnCours = null;
  });

  /* --- Tailles liées au zoom (épingles + éléments posés) --- */
  etat.carte.on("zoomend", majEchellesZoom);
  etat.grappe.on && etat.grappe.on("animationend spiderfied unspiderfied", majEchellesZoom);

  /* --- Échap : d'abord les fenêtres et l'outil en cours --- */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const fermetures = [
      ["modal-souvenir", fermerModalSouvenir],
      ["modal-impression", fermerModalImpression],
      ["modal-nouveau-carnet", fermerModalNouveauCarnet],
      ["modal-carte-globale", () => { document.getElementById("modal-carte-globale").hidden = true; }],
    ];
    for (const [id, fermer] of fermetures) {
      if (!document.getElementById(id).hidden) {
        fermer();
        e.stopPropagation();
        return;
      }
    }
    if (annulerDessinZoneCarnet()) {
      e.stopPropagation();
      return;
    }
    if (annulerPlacementPointCarnet()) {
      e.stopPropagation();
      return;
    }
    if (etat.modeOutil) {
      desarmerOutil();
      e.stopPropagation();
      return;
    }
    // Échap désélectionne aussi l'élément en cours (façon Miro).
    if (etat.annotationActive) {
      deselectionnerAnnotation();
      e.stopPropagation();
    }
  }, true);

  /* --- Sélection façon Miro : cadre, poignées, clavier (selection.js) --- */
  if (typeof brancherSelectionUI === "function") brancherSelectionUI();

  // Les réglages d'impression par défaut : tout imprimer, dans l'ordre.
  reglagesAffiche.ordre = null;
  reglagesAffiche.exclusions = [];
}

/** Affiche/masque les contrôles liés à l'image d'épingle personnalisée. */
function majControlesEpingle() {
  const ep = (etat.style && etat.style.epingles) || {};
  const aImage = !!ep.image;
  const btnPerso = document.getElementById("epingle-forme-perso");
  const btnRetirer = document.getElementById("epingle-image-retirer");
  if (btnPerso) btnPerso.hidden = !aImage;
  if (btnRetirer) btnRetirer.hidden = !aImage;
  // Le segment « forme » reflète la forme réellement active.
  if (typeof majSegment === "function") majSegment("epingle-forme", "forme", ep.forme || "goutte");
}

/** Change la couleur des épingles (nuancier ou sélecteur personnalisé). */
function choisirCouleurEpingle(couleur) {
  etat.style.epingles.couleur = couleur;
  document.getElementById("epingle-couleur-perso").value = couleur;
  majPastillesActives("epingle-couleurs", couleur);
  appliquerStyleEpingles();
  planifierSauvegarde();
}

/** Crée un nouveau carnet à partir d'un GPX choisi depuis l'accueil. */
async function nouveauCarnetDepuisGpx(fichier) {
  if (!fichier) return;
  if (!/\.gpx$/i.test(fichier.name)) {
    toast("Merci de choisir un fichier .gpx", true);
    return;
  }
  await sauvegarderMaintenant();
  retirerTousFantomes();

  const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
  const nom = fichier.name.replace(/\.gpx$/i, "").slice(0, 60) || "Nouveau carnet";
  etat.carnets.push({
    id, uuid: genUuid(), nom, visible: true,
    logo: "", categorie: "", description: "", modifieLe: new Date().toISOString(),
  });
  etat.carnetActifId = id;
  viderCarnetCourant();
  await sauverIndexCarnets();
  renderCarnets();
  await basculerVersEditeur();
  chargerFichierGpx(fichier);
  ouvrirOnglet("carnets");
  toast(`Carnet « ${nom} » créé — complète sa fiche (logo, catégorie…)`);
}
