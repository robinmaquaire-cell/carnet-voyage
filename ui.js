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

  definirMode("visualisation");     // lecture seule + fiches en pop up
  definirVisibiliteCarnetActif(true);
  await afficherTousLesCarnets();
  appliquerFiltresAccueil();
  majInterfaceCarnets();
  majEcranVide();
  ajusterVueMonde();
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
  definirVisibiliteCarnetActif(true);

  etat.vue = "editeur";
  document.body.classList.add("vue-editeur");
  document.body.classList.remove("vue-accueil");

  majInterfaceCarnets();
  majEcranVide();
  if (etat.trace) recadrerSurParcours();
  setTimeout(() => etat.carte.invalidateSize(), 60);
}

/**
 * Montre ou cache les calques du carnet OUVERT (trace, épingles, noms,
 * éléments décoratifs) — utilisé par les filtres de l'accueil.
 */
function definirVisibiliteCarnetActif(visible) {
  const carte = etat.carte;
  const couches = [];
  if (etat.coucheTrace) couches.push(etat.coucheTrace);
  if (etat.grappe) couches.push(etat.grappe);
  etat.souvenirs.forEach((s) => { if (s.label) couches.push(s.label); });
  etat.annotations.forEach((a) => { if (a.marker) couches.push(a.marker); });
  couches.forEach((c) => {
    if (visible) { if (!carte.hasLayer(c)) carte.addLayer(c); }
    else if (carte.hasLayer(c)) carte.removeLayer(c);
  });
}

/** À l'accueil : charge et affiche tous les autres carnets (lecture seule). */
async function afficherTousLesCarnets() {
  for (const c of etat.carnets) {
    if (c.id === etat.carnetActifId) continue;
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
  if (points.length > 0) {
    etat.carte.fitBounds(points, { padding: [60, 60], maxZoom: 12 });
  } else {
    etat.carte.setView([46.6, 2.5], 5);
  }
}

/** L'écran « carnet vide » : textes adaptés à la vue en cours. */
function majEcranVide() {
  const enEditeur = etat.vue === "editeur";
  const rienNullePart = !etat.trace && etat.fantomes.size === 0;
  const vide = enEditeur ? !etat.trace : rienNullePart;

  document.getElementById("welcome").hidden = !vide;
  if (!vide) return;
  document.getElementById("welcome-titre").textContent = enEditeur
    ? "Ce carnet est encore vide"
    : "Transforme ta trace en carnet de voyage";
  document.getElementById("welcome-texte").innerHTML = enEditeur
    ? "Charge un fichier <strong>.gpx</strong> pour dessiner le parcours de ce carnet, puis pose tes souvenirs dessus."
    : "Charge un fichier <strong>.gpx</strong> de ta randonnée, pose des souvenirs (photos, récits, audios), personnalise le style de la carte… et imprime un beau livre.";
}

/* =========================================================
   2. Rail d'onglets et tiroir (éditeur façon Canva)
   ========================================================= */

// Nom d'onglet → id de la section correspondante dans le tiroir.
const ONGLETS = {
  carnets: "panneau-carnets",
  modeles: "panneau-modeles",
  souvenirs: "panneau-reserve",
  textes: "panneau-textes",
  importer: "panneau-importer",
  outils: "panneau-outils",
  fond: "panneau-fond-carte",
  export: "panneau-export",
  element: "panneau-element",
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
  if (nom === "carnets") { renderCarnets(); }
  else if (nom === "modeles") { renderModeles(); }
  else if (nom === "souvenirs") { renderSouvenirsListe(); }
  else if (nom === "importer") { renderImagesListe(); }
  else if (nom === "textes" || nom === "fond") { synchroniserControlesStyle(); }
  else if (nom === "element") { majEditeurAnnotation(); }
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

/** Ouvre le panneau « Élément sélectionné » (appelé depuis app.js). */
function ouvrirPanneauElement() {
  if (etat.vue !== "editeur") return;
  ouvrirOnglet("element");
}

/* =========================================================
   3. Accueil : cartes des carnets + filtres
   ========================================================= */

const filtreAccueil = { texte: "", categorie: "", du: "", au: "" };

/** Un carnet passe-t-il les filtres de l'accueil ? */
function carnetVisibleAccueil(c) {
  if (!c) return true;
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
    if (c.categorie) {
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
    editer.textContent = "✏️ Éditer";
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
  if (!trace) { toast("Ce carnet est encore vide (pas de trace)."); return; }
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
  majCategories();
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
    if (etat.vue !== "editeur" || !etat.trace) return;
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
  ouvrirOnglet("textes");
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

/** (Re)construit la liste des photos posées sur la carte. */
function renderImagesListe() {
  const liste = document.getElementById("importer-liste");
  const vide = document.getElementById("importer-vide");
  if (!liste) return;
  liste.innerHTML = "";
  const images = etat.annotations.filter((a) => a.type === "image");
  vide.hidden = images.length > 0;

  images.forEach((a) => {
    const item = document.createElement("button");
    item.className = "importer-item";
    const img = document.createElement("img");
    img.src = a.src;
    const legende = document.createElement("span");
    legende.className = "importer-item-legende";
    legende.textContent = a.legende || "(sans légende)";
    item.appendChild(img);
    item.appendChild(legende);
    item.addEventListener("click", () => {
      etat.carte.panTo([a.lat, a.lng]);
      selectionnerAnnotation(a);
    });
    liste.appendChild(item);
  });
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
    marker: null,
    ...champs,
  };
  etat.annotations.push(a);
  attacherAnnotationVecteur(a);
  selectionnerAnnotation(a);
  planifierSauvegarde();
}

/* ---------- Rendu des traits, formes et dessins ---------- */

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
    weight: a.epaisseur || 4,
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
  return calque;
}

/** Met à jour le style d'un trait / forme / dessin (sélection comprise). */
function majStyleAnnotationVecteur(a) {
  if (!a || !a.marker || !a.marker.setStyle) return;
  const actif = etat.annotationActive === a;
  a.marker.setStyle({
    color: a.couleur || "#b4452f",
    weight: (a.epaisseur || 4) + (actif ? 1 : 0),
    opacity: actif ? 1 : 0.9,
    dashArray: actif ? "6 6" : null,
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
  if (!etat.trace) {
    toast("Ce carnet est encore vide : charge d'abord un GPX.", true);
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
   11. Rafraîchissement différé des listes
   ========================================================= */

let timerListes = null;

/** Replanifie la mise à jour des listes (appelé par planifierSauvegarde). */
function planifierMajListes() {
  clearTimeout(timerListes);
  timerListes = setTimeout(() => {
    if (ongletOuvert === "souvenirs") renderSouvenirsListe();
    if (ongletOuvert === "importer") renderImagesListe();
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

  /* --- Accueil : nouveau carnet depuis un GPX --- */
  document.getElementById("accueil-gpx-input")
    .addEventListener("change", (e) => {
      const fichier = e.target.files[0];
      e.target.value = "";
      nouveauCarnetDepuisGpx(fichier);
    });
  // L'écran « aucun carnet » et l'exemple mènent aussi à l'éditeur.
  document.getElementById("gpx-input-welcome")
    .addEventListener("change", () => {
      if (etat.vue === "accueil") basculerVersEditeur();
    });
  document.getElementById("btn-exemple")
    .addEventListener("click", () => {
      if (etat.vue === "accueil") basculerVersEditeur();
    });

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
      if (ongletOuvert === "importer") renderImagesListe();
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
    .addEventListener("click", desarmerOutil);

  /* --- Gestes de dessin sur la carte --- */
  etat.carte.on("click", (e) => {
    if (etat.modeOutil === "trait") clicTrait(e.latlng);
  });
  etat.carte.on("dblclick", () => {
    if (etat.modeOutil === "trait") terminerTrait();
  });
  etat.carte.on("mousedown", (e) => {
    if (etat.modeOutil && etat.modeOutil !== "trait") debutGlisse(e.latlng);
  });
  etat.carte.on("mousemove", (e) => {
    if (etat.modeOutil && etat.modeOutil !== "trait" && dessinEnCours) pendantGlisse(e.latlng);
  });
  etat.carte.on("mouseup", (e) => {
    if (etat.modeOutil && etat.modeOutil !== "trait" && dessinEnCours) finGlisse(e.latlng);
  });

  /* --- Échap : d'abord l'outil de dessin, avant tout le reste --- */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("modal-souvenir").hidden) {
      fermerModalSouvenir();
      e.stopPropagation();
      return;
    }
    if (!document.getElementById("modal-impression").hidden) {
      fermerModalImpression();
      e.stopPropagation();
      return;
    }
    if (etat.modeOutil) {
      desarmerOutil();
      e.stopPropagation();
    }
  }, true);

  // Les réglages d'impression par défaut : tout imprimer, dans l'ordre.
  reglagesAffiche.ordre = null;
  reglagesAffiche.exclusions = [];
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
