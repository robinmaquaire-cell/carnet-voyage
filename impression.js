/* =========================================================
   impression.js — Écran « Mise en page & impression » (in-app)
   ---------------------------------------------------------
   4e écran du schéma : un éditeur libre façon « affiche ».
   L'utilisateur pose et dimensionne comme il veut :
     • la carte du carnet, ses souvenirs,
     • des blocs de texte (mis en forme),
     • des formes (rectangle, cercle, ligne),
     • des images importées, des pictos du thème,
   puis imprime (ou enregistre en PDF via le navigateur).

   Choix de page par RATIO (1:1, 3:4, 16:9…), plus de format papier.
   Panneau de propriétés contextuel, rotation, fond de page,
   annuler / rétablir. Disposition mémorisée par carnet.
   ========================================================= */

const Impression = (function () {
  "use strict";

  /* Ratios proposés (largeur : hauteur). */
  const RATIOS = [
    { k: "1:1", r: 1 },
    { k: "3:4", r: 3 / 4 },
    { k: "4:3", r: 4 / 3 },
    { k: "2:3", r: 2 / 3 },
    { k: "3:2", r: 3 / 2 },
    { k: "9:16", r: 9 / 16 },
    { k: "16:9", r: 16 / 9 },
  ];
  const ratioDe = (k) => (RATIOS.find((x) => x.k === k) || RATIOS[1]).r;

  /* Polices disponibles (déjà chargées par l'application). */
  const POLICES = {
    systeme: { label: "Système", css: "system-ui, sans-serif" },
    serif: { label: "Serif", css: "Georgia, 'Times New Roman', serif" },
    titre: { label: "Titre", css: "'Bricolage Grotesque', 'Avenir Next', sans-serif" },
    medievale: { label: "Médiévale", css: "'UnifrakturMaguntia', fantasy" },
    pirate: { label: "Pirate", css: "'Pirata One', fantasy" },
  };

  /* Filtres d'image (CSS). */
  const FILTRES = {
    aucun: { label: "Aucun", css: "none" },
    nb: { label: "Noir & blanc", css: "grayscale(1)" },
    sepia: { label: "Sépia", css: "sepia(0.75)" },
    satur: { label: "Saturé", css: "saturate(1.6)" },
    doux: { label: "Doux", css: "saturate(0.6) brightness(1.05)" },
    contraste: { label: "Contrasté", css: "contrast(1.25)" },
  };

  /* Fonds « image » pour la carte imprimée (vectoriel/perso → repli « clair »). */
  const FONDS = {
    topo: { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", opts: { maxZoom: 17 } },
    clair: { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", opts: { maxZoom: 20, subdomains: "abcd" } },
    epure: { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", opts: { maxZoom: 20, subdomains: "abcd" } },
  };
  const TYPES_LIGNE = { plein: null, pointilles: "2 8", tirets: "10 9" };

  /* ---------- État de l'écran ---------- */
  let ratioKey = "3:4";
  let pageBg = "#ffffff";
  let blocs = [];          // éléments de la PAGE en cours (référence vers pages[pageIdx].blocs)
  let pages = [];          // le livre = liste de pages { bg, blocs }
  let pageIdx = 0;         // index de la page en cours d'édition
  let selId = null;
  let carte = null;
  let carnetId = null;
  let cleLayout = null;
  let seq = 1, zTop = 1;
  let histo = [], histoIdx = -1;

  const $ = (id) => document.getElementById(id);
  const page = () => $("impr2-page");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const echapper = (t) => String(t).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ============================================================
     Ouverture / fermeture
     ============================================================ */

  function ouvrir() {
    if (typeof etat === "undefined" || etat.vue !== "editeur" || !etat.carnetActifId) {
      if (typeof toast === "function") toast("Ouvre d'abord un carnet.", true);
      return;
    }
    carnetId = etat.carnetActifId;
    const fiche = (typeof carnetActif === "function") ? carnetActif() : null;
    $("impr2-nom").textContent = (fiche && fiche.nom) || "Carnet";
    cleLayout = "logbookmap-impr-" + ((fiche && fiche.uuid) || carnetId);

    ratioKey = ratioDefautCarnet(fiche);
    pageBg = "#ffffff";

    $("impression-ecran").hidden = false;
    document.body.classList.add("vue-impression");

    if (!chargerLayout()) dispositionParDefaut();
    chargerPage(pageIdx);

    construireBarreRatio();
    majRatioUI();
    rendreListeSouvenirs();
    rendreThemePictos();
    rendreIllustrations();
    $("impr2-bg").value = pageBg;
    ajusterPage();
    reconstruireTout();
    rendreBarrePages();
    select(null);
    histo = []; histoIdx = -1; pushHisto();
    setTimeout(() => { if (carte) carte.invalidateSize(); }, 120);
  }

  function fermer() {
    sauverLayout();
    detruireCarte();
    $("impression-ecran").hidden = true;
    document.body.classList.remove("vue-impression");
  }

  function ratioDefautCarnet(fiche) {
    // On repart du ratio du carnet (zone), traduit vers le ratio le plus proche.
    let r = null;
    try {
      if (fiche && fiche.formatZone && typeof ratioZone === "function") {
        r = ratioZone(fiche.formatZone, fiche.orientationZone);
      }
    } catch (e) {}
    if (!(r > 0)) return "3:4";
    let best = RATIOS[1], bd = Infinity;
    RATIOS.forEach((x) => { const d = Math.abs(Math.log(x.r / r)); if (d < bd) { bd = d; best = x; } });
    return best.k;
  }

  /* ============================================================
     Souvenirs du carnet
     ============================================================ */

  function souvenirs() {
    return (typeof etat !== "undefined" && Array.isArray(etat.souvenirs)) ? etat.souvenirs : [];
  }
  function coverSrc(s) {
    if (!s || !Array.isArray(s.photos) || s.photos.length === 0) return null;
    const i = (typeof s.couverture === "number" && s.photos[s.couverture]) ? s.couverture : 0;
    return s.photos[i] ? s.photos[i].src : null;
  }

  /* ============================================================
     Modèle de blocs
     ============================================================ */

  function nouveauBloc(type, extra) {
    const b = { id: seq++, type: type, x: 22, y: 22, w: 32, h: 22, z: zTop++, rot: 0 };
    if (type === "texte") Object.assign(b, {
      w: 46, h: 12, contenu: "Ton texte ici", police: "titre", taille: 46,
      couleur: "#10302c", gras: false, italique: false, souligne: false,
      align: "center", fond: "none",
    });
    else if (type === "forme") Object.assign(b, {
      forme: (extra && extra.forme) || "rect", remplissage: "#2c7da0",
      bordureCouleur: "#10302c", bordure: 0, opacite: 1,
    });
    else if (type === "ligne") Object.assign(b, { type: "forme", forme: "ligne", h: 1.5, remplissage: "#10302c", bordure: 3, bordureCouleur: "#10302c", opacite: 1 });
    else if (type === "image") Object.assign(b, { w: 30, h: 24, src: (extra && extra.src) || "", filtre: "aucun", opacite: 1 });
    else if (type === "carte") Object.assign(b, { w: 84, h: 52 });
    else if (type === "souvenir") Object.assign(b, { w: 30, h: 22, sid: extra && extra.sid });
    return Object.assign(b, extra || {});
  }

  function dispositionParDefaut() {
    seq = 1; zTop = 1;
    const bl = [];
    bl.push(nouveauBloc("carte", { x: 4, y: 4, w: 92, h: 54 }));
    const liste = souvenirs().slice(0, 6);
    const cols = 3, gap = 2, larg = (92 - gap * (cols - 1)) / cols, haut = 17;
    liste.forEach((s, i) => {
      const col = i % cols, ligne = Math.floor(i / cols);
      bl.push(nouveauBloc("souvenir", {
        sid: s.id, x: 4 + col * (larg + gap), y: 60 + ligne * (haut + gap), w: larg, h: haut,
      }));
    });
    pages = [{ bg: "#ffffff", blocs: bl }];
    pageIdx = 0;
  }

  /* ============================================================
     Pages du livre (barre de miniatures, ajout / duplication /
     suppression / réordonnancement / navigation)
     ============================================================ */

  /* Recopie la page en cours d'édition dans la structure du livre. */
  function syncPage() {
    if (pages[pageIdx]) { pages[pageIdx].bg = pageBg; pages[pageIdx].blocs = blocs; }
  }

  /* Charge la page d'index i comme page active (met à jour blocs / pageBg). */
  function chargerPage(i) {
    if (!pages.length) pages = [{ bg: "#ffffff", blocs: [] }];
    pageIdx = clamp(i, 0, pages.length - 1);
    const p = pages[pageIdx];
    pageBg = (typeof p.bg === "string") ? p.bg : "#ffffff";
    blocs = Array.isArray(p.blocs) ? p.blocs : (p.blocs = []);
    seq = 1; zTop = 1;
    blocs.forEach((b) => { b.id = seq++; if (!(b.z > 0)) b.z = zTop; if (typeof b.rot !== "number") b.rot = 0; zTop = Math.max(zTop, b.z + 1); });
  }

  /* Réaffiche entièrement la page active + la barre de pages. */
  function rafraichirScene() {
    $("impr2-bg").value = pageBg;
    ajusterPage();
    reconstruireTout();
    rendreBarrePages();
  }

  function allerPage(i) {
    i = clamp(i, 0, pages.length - 1);
    if (i === pageIdx) return;
    syncPage();
    select(null);
    chargerPage(i);
    rafraichirScene();
    sauverLayout();
  }

  function ajouterPage() {
    syncPage();
    pages.splice(pageIdx + 1, 0, { bg: "#ffffff", blocs: [] });
    select(null);
    chargerPage(pageIdx + 1);
    rafraichirScene();
    pushHisto(); sauverLayout();
  }

  function dupliquerPage(i) {
    syncPage();
    const src = pages[i];
    if (!src) return;
    const copie = { bg: src.bg, blocs: (src.blocs || []).map((b) => Object.assign({}, b)) };
    pages.splice(i + 1, 0, copie);
    select(null);
    chargerPage(i + 1);
    rafraichirScene();
    pushHisto(); sauverLayout();
  }

  function supprimerPage(i) {
    if (pages.length <= 1) {
      if (typeof toast === "function") toast("Ton livre doit garder au moins une page.");
      return;
    }
    if (typeof confirm === "function" && !confirm("Supprimer la page " + (i + 1) + " ?\n(tu pourras revenir en arrière avec Ctrl+Z)")) return;
    syncPage();
    pages.splice(i, 1);
    let cible = pageIdx;
    if (i < pageIdx) cible = pageIdx - 1;
    else if (i === pageIdx) cible = Math.min(pageIdx, pages.length - 1);
    select(null);
    chargerPage(cible);
    rafraichirScene();
    pushHisto(); sauverLayout();
  }

  function deplacerPage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    syncPage();
    const tmp = pages[i]; pages[i] = pages[j]; pages[j] = tmp;
    if (pageIdx === i) pageIdx = j;
    else if (pageIdx === j) pageIdx = i;
    rendreBarrePages();
    pushHisto(); sauverLayout();
  }

  function rendreBarrePages() {
    const cont = $("impr2-pages");
    if (!cont) return;
    cont.innerHTML = "";
    const r = ratioDe(ratioKey);
    const H = 58, W = Math.round(H * r);
    pages.forEach((p, i) => {
      const item = document.createElement("div");
      item.className = "impr2-vign" + (i === pageIdx ? " actif" : "");
      item.dataset.i = i;

      const mini = document.createElement("div");
      mini.className = "impr2-vign-page";
      mini.style.width = W + "px"; mini.style.height = H + "px";
      remplirMini(mini, p);
      mini.addEventListener("click", () => allerPage(i));
      item.appendChild(mini);

      const num = document.createElement("span");
      num.className = "impr2-vign-num"; num.textContent = i + 1;
      item.appendChild(num);

      const ops = document.createElement("div");
      ops.className = "impr2-vign-ops";
      ops.appendChild(vignBtn("◀", "Déplacer avant", (e) => { e.stopPropagation(); deplacerPage(i, -1); }, i === 0));
      ops.appendChild(vignBtn("⧉", "Dupliquer cette page", (e) => { e.stopPropagation(); dupliquerPage(i); }, false));
      ops.appendChild(vignBtn("🗑", "Supprimer cette page", (e) => { e.stopPropagation(); supprimerPage(i); }, pages.length <= 1));
      ops.appendChild(vignBtn("▶", "Déplacer après", (e) => { e.stopPropagation(); deplacerPage(i, 1); }, i === pages.length - 1));
      item.appendChild(ops);

      cont.appendChild(item);
    });

    const add = document.createElement("button");
    add.className = "impr2-vign-add"; add.title = "Ajouter une page vierge";
    add.innerHTML = "＋<span>Page</span>";
    add.addEventListener("click", ajouterPage);
    cont.appendChild(add);
  }

  function vignBtn(txt, title, fn, disabled) {
    const b = document.createElement("button");
    b.className = "impr2-vign-op"; b.textContent = txt; b.title = title;
    if (disabled) b.disabled = true;
    b.addEventListener("click", fn);
    return b;
  }

  /* Mini-aperçu d'une page (léger : pas de carte Leaflet dans la miniature). */
  function remplirMini(mini, p) {
    mini.innerHTML = "";
    mini.style.background = (p && typeof p.bg === "string") ? p.bg : "#ffffff";
    const list = (p && Array.isArray(p.blocs)) ? p.blocs.slice().sort((a, b) => (a.z || 0) - (b.z || 0)) : [];
    list.forEach((b) => {
      const e = document.createElement("div");
      e.className = "impr2-mini-bloc";
      e.style.left = b.x + "%"; e.style.top = b.y + "%";
      e.style.width = b.w + "%"; e.style.height = b.h + "%";
      if (b.rot) e.style.transform = "rotate(" + b.rot + "deg)";
      if (b.type === "carte") {
        e.style.background = "#dbe7df";
        e.textContent = "🗺"; e.style.fontSize = "9px";
        e.style.display = "flex"; e.style.alignItems = "center"; e.style.justifyContent = "center";
      } else if (b.type === "souvenir") {
        const s = souvenirs().find((x) => x.id === b.sid); const c = coverSrc(s);
        if (c) { e.style.backgroundImage = "url(" + c + ")"; e.style.backgroundSize = "cover"; e.style.backgroundPosition = "center"; }
        else e.style.background = "#cdd8d0";
      } else if (b.type === "image") {
        if (b.src) { e.style.backgroundImage = "url(" + b.src + ")"; e.style.backgroundSize = "cover"; e.style.backgroundPosition = "center"; }
        else e.style.background = "#e2e2e2";
      } else if (b.type === "forme") {
        if (b.forme === "ligne") e.style.background = b.remplissage || "#10302c";
        else { e.style.background = b.remplissage || "#2c7da0"; if (b.forme === "ellipse") e.style.borderRadius = "50%"; }
        e.style.opacity = (typeof b.opacite === "number") ? b.opacite : 1;
      } else if (b.type === "texte") {
        e.style.background = (b.fond && b.fond !== "none") ? b.fond : "transparent";
        e.style.color = b.couleur || "#10302c";
        e.style.fontSize = "5px"; e.style.overflow = "hidden"; e.style.lineHeight = "1.1";
        e.style.padding = "1px"; e.style.textAlign = b.align || "left";
        e.textContent = (b.contenu || "").slice(0, 40);
      }
      mini.appendChild(e);
    });
  }

  /* Rafraîchit seulement la miniature de la page en cours (après une édition). */
  function rafraichirVignetteCourante() {
    if (!pages[pageIdx]) return;
    syncPage();
    const mini = document.querySelector('#impr2-pages .impr2-vign[data-i="' + pageIdx + '"] .impr2-vign-page');
    if (mini) remplirMini(mini, pages[pageIdx]);
  }

  /* ============================================================
     Sauvegarde / restauration
     ============================================================ */

  function sauverLayout() {
    if (!cleLayout) return;
    syncPage();
    try { localStorage.setItem(cleLayout, JSON.stringify({ ratioKey, pageIdx, pages })); } catch (e) {}
  }
  function chargerLayout() {
    if (!cleLayout) return false;
    let brut = null;
    try { brut = localStorage.getItem(cleLayout); } catch (e) {}
    if (!brut) return false;
    try {
      const d = JSON.parse(brut);
      if (!d) return false;
      if (RATIOS.some((x) => x.k === d.ratioKey)) ratioKey = d.ratioKey;
      // Nouveau format : un livre de pages.
      if (Array.isArray(d.pages) && d.pages.length) {
        pages = d.pages.map((p) => ({
          bg: (typeof p.bg === "string") ? p.bg : "#ffffff",
          blocs: (Array.isArray(p.blocs) ? p.blocs : []).filter((b) => b && b.type),
        }));
        pageIdx = clamp((typeof d.pageIdx === "number") ? d.pageIdx : 0, 0, pages.length - 1);
        return true;
      }
      // Rétrocompat : ancien format « une seule page ».
      if (Array.isArray(d.blocs)) {
        pages = [{ bg: (typeof d.pageBg === "string") ? d.pageBg : "#ffffff", blocs: d.blocs.filter((b) => b && b.type) }];
        pageIdx = 0;
        return pages[0].blocs.length > 0;
      }
      return false;
    } catch (e) { return false; }
  }

  /* ============================================================
     Historique (annuler / rétablir)
     ============================================================ */

  function snapshot() { syncPage(); return JSON.stringify({ ratioKey, pageIdx, pages }); }
  function pushHisto() {
    const s = snapshot();
    if (histo[histoIdx] === s) return;
    histo = histo.slice(0, histoIdx + 1);
    histo.push(s);
    if (histo.length > 60) histo.shift();
    histoIdx = histo.length - 1;
    majUndoRedo();
    rafraichirVignetteCourante();
  }
  function appliquerSnapshot(s) {
    try {
      const d = JSON.parse(s);
      ratioKey = d.ratioKey;
      pages = Array.isArray(d.pages) ? d.pages : [{ bg: d.pageBg || "#ffffff", blocs: d.blocs || [] }];
      chargerPage(typeof d.pageIdx === "number" ? d.pageIdx : 0);
    } catch (e) { return; }
    $("impr2-bg").value = pageBg;
    majRatioUI(); ajusterPage(); reconstruireTout(); rendreBarrePages(); select(null); sauverLayout();
  }
  function annuler() { if (histoIdx > 0) { histoIdx--; appliquerSnapshot(histo[histoIdx]); majUndoRedo(); } }
  function retablir() { if (histoIdx < histo.length - 1) { histoIdx++; appliquerSnapshot(histo[histoIdx]); majUndoRedo(); } }
  function majUndoRedo() {
    const u = $("impr2-undo"), r = $("impr2-redo");
    if (u) u.disabled = histoIdx <= 0;
    if (r) r.disabled = histoIdx >= histo.length - 1;
  }

  /* ============================================================
     Rendu des blocs
     ============================================================ */

  function reconstruireTout() {
    detruireCarte();
    const pg = page();
    pg.style.background = pageBg;
    pg.innerHTML = "";
    blocs.forEach((b) => pg.appendChild(construireBlocEl(b)));
    pg.appendChild(construireSelection());
    majSelection();
    const bc = blocs.find((b) => b.type === "carte");
    if (bc) construireCarte(bc);
  }

  function construireBlocEl(bloc) {
    const el = document.createElement("div");
    el.className = "impr2-bloc impr2-bloc-" + bloc.type + (bloc.id === selId ? " selected" : "");
    el.dataset.id = bloc.id;
    appliquerGeo(el, bloc);
    el.appendChild(contenuBloc(bloc));

    el.addEventListener("pointerdown", (e) => {
      if (el.classList.contains("edition-texte")) return; // en cours d'édition de texte
      select(bloc.id);
      commencerDrag(e, bloc, el);
    });
    if (bloc.type === "texte") {
      el.addEventListener("dblclick", () => editerTexte(bloc, el));
    }
    return el;
  }

  function appliquerGeo(el, bloc) {
    el.style.left = bloc.x + "%";
    el.style.top = bloc.y + "%";
    el.style.width = bloc.w + "%";
    el.style.height = bloc.h + "%";
    el.style.zIndex = bloc.z;
    el.style.transform = bloc.rot ? ("rotate(" + bloc.rot + "deg)") : "";
  }

  function contenuBloc(bloc) {
    if (bloc.type === "carte") {
      const wrap = document.createElement("div");
      const m = document.createElement("div");
      m.className = "impr2-map"; m.id = "impr2-map-" + bloc.id;
      wrap.appendChild(m);
      const nf = document.createElement("div");
      nf.className = "impr2-carte-nofond"; nf.textContent = "Carte du carnet";
      wrap.appendChild(nf);
      wrap.style.width = "100%"; wrap.style.height = "100%";
      return wrap;
    }
    if (bloc.type === "souvenir") return carteSouvenir(bloc.sid);
    if (bloc.type === "texte") return blocTexte(bloc);
    if (bloc.type === "forme") return blocForme(bloc);
    if (bloc.type === "image") return blocImage(bloc);
    return document.createElement("div");
  }

  function carteSouvenir(sid) {
    const wrap = document.createElement("div");
    wrap.className = "impr2-cs";
    const s = souvenirs().find((x) => x.id === sid);
    const num = s ? (souvenirs().indexOf(s) + 1) : "?";
    const cover = coverSrc(s);
    if (cover) {
      const ph = document.createElement("div");
      ph.className = "impr2-cs-photo";
      ph.style.backgroundImage = "url(" + cover + ")";
      wrap.appendChild(ph);
    }
    const corps = document.createElement("div");
    corps.className = "impr2-cs-corps";
    corps.innerHTML = '<div class="impr2-cs-titre">' + num + ". " + echapper((s && s.nom) || "Souvenir") +
      '</div><div class="impr2-cs-texte">' + echapper((s && s.textes) || "") + "</div>";
    wrap.appendChild(corps);
    return wrap;
  }

  function blocTexte(bloc) {
    const t = document.createElement("div");
    t.className = "impr2-txt";
    majTexteStyle(t, bloc);
    t.textContent = bloc.contenu || "";
    return t;
  }
  function majTexteStyle(t, bloc) {
    t.style.setProperty("--taille", bloc.taille || 40);
    t.style.color = bloc.couleur || "#10302c";
    t.style.fontFamily = (POLICES[bloc.police] || POLICES.systeme).css;
    t.style.fontWeight = bloc.gras ? "800" : "500";
    t.style.fontStyle = bloc.italique ? "italic" : "normal";
    t.style.textDecoration = bloc.souligne ? "underline" : "none";
    t.style.textAlign = bloc.align || "left";
    t.style.background = (bloc.fond && bloc.fond !== "none") ? bloc.fond : "transparent";
  }

  function blocForme(bloc) {
    const f = document.createElement("div");
    f.className = "impr2-forme impr2-forme-" + bloc.forme;
    if (bloc.forme === "ligne") {
      f.style.background = bloc.remplissage || "#10302c";
      f.style.height = (bloc.bordure || 3) + "px";
      f.style.top = "50%"; f.style.transform = "translateY(-50%)";
    } else {
      f.style.background = bloc.remplissage || "#2c7da0";
      f.style.borderRadius = bloc.forme === "ellipse" ? "50%" : "6px";
      f.style.border = (bloc.bordure > 0) ? (bloc.bordure + "px solid " + (bloc.bordureCouleur || "#10302c")) : "none";
    }
    f.style.opacity = (typeof bloc.opacite === "number") ? bloc.opacite : 1;
    return f;
  }

  function blocImage(bloc) {
    const wrap = document.createElement("div");
    wrap.className = "impr2-img-wrap";
    if (bloc.src) {
      const img = document.createElement("img");
      img.src = bloc.src;
      img.draggable = false;
      img.style.filter = (FILTRES[bloc.filtre] || FILTRES.aucun).css;
      img.style.opacity = (typeof bloc.opacite === "number") ? bloc.opacite : 1;
      wrap.appendChild(img);
    } else {
      wrap.classList.add("impr2-img-vide");
      wrap.textContent = "Image";
    }
    return wrap;
  }

  /* Met à jour le contenu (sans reconstruire toute la page). */
  function rafraichirBloc(bloc) {
    const el = page().querySelector('.impr2-bloc[data-id="' + bloc.id + '"]');
    if (!el) return;
    appliquerGeo(el, bloc);
    if (bloc.type === "texte") {
      const t = el.querySelector(".impr2-txt");
      if (t) { majTexteStyle(t, bloc); if (!el.classList.contains("edition-texte")) t.textContent = bloc.contenu || ""; }
    } else if (bloc.type === "forme" || bloc.type === "image") {
      const anc = el.querySelector(".impr2-forme, .impr2-img-wrap");
      const neuf = contenuBloc(bloc);
      if (anc) el.replaceChild(neuf, anc);
    }
  }

  /* ============================================================
     Bloc carte : mini-carte Leaflet
     ============================================================ */

  function detruireCarte() { if (carte) { try { carte.remove(); } catch (e) {} carte = null; } }

  function construireCarte(bloc) {
    detruireCarte();
    if (typeof L === "undefined") return;
    const cible = $("impr2-map-" + bloc.id);
    if (!cible) return;
    try {
      carte = L.map(cible, {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
        keyboard: false, tap: false, touchZoom: false,
      });
    } catch (e) { carte = null; return; }

    const st = (typeof etat !== "undefined" && etat.style) || {};
    const f = FONDS[st.fond] ? FONDS[st.fond] : FONDS.clair;
    try { L.tileLayer(f.url, Object.assign({ maxZoom: 19, subdomains: "abc" }, f.opts)).addTo(carte); } catch (e) {}

    const pts = [];
    const tr = (typeof etat !== "undefined") ? etat.trace : null;
    if (tr && Array.isArray(tr.segments)) {
      const ts = st.trace || { couleur: "#c8893d", epaisseur: 4, type: "plein" };
      tr.segments.forEach((seg) => {
        if (!seg || !seg.length) return;
        try {
          L.polyline(seg, { color: ts.couleur || "#c8893d", weight: ts.epaisseur || 4, opacity: 0.95, dashArray: TYPES_LIGNE[ts.type] || null }).addTo(carte);
        } catch (e) {}
        seg.forEach((p) => pts.push(p));
      });
    }
    const ep = st.epingles || { couleur: "#d35438", numero: true };
    souvenirs().forEach((s, i) => {
      const ll = souvenirLatLng(s);
      if (!ll) return;
      pts.push(ll);
      try {
        const ic = L.divIcon({
          className: "impr2-pin",
          html: '<span class="impr2-pin-b" style="background:' + (ep.couleur || "#d35438") + '">' + (ep.numero === false ? "" : (i + 1)) + "</span>",
          iconSize: [26, 26], iconAnchor: [13, 26],
        });
        L.marker(ll, { icon: ic, interactive: false }).addTo(carte);
      } catch (e) {}
    });

    if (pts.length) { try { carte.fitBounds(L.latLngBounds(pts).pad(0.15), { animate: false }); } catch (e) { carte.setView([46.6, 2.5], 5); } }
    else carte.setView([46.6, 2.5], 5);
    setTimeout(() => { if (carte) carte.invalidateSize(); }, 60);
  }
  function souvenirLatLng(s) {
    try {
      if (s && s.marker && s.marker.getLatLng) { const l = s.marker.getLatLng(); return [l.lat, l.lng]; }
      if (s && typeof s.lat === "number" && typeof s.lng === "number") return [s.lat, s.lng];
    } catch (e) {}
    return null;
  }

  /* ============================================================
     Sélection + barre d'outils flottante (façon Canva)
     ============================================================ */

  function blocSel() { return blocs.find((b) => b.id === selId) || null; }

  function select(id) {
    selId = id;
    page().querySelectorAll(".impr2-bloc").forEach((el) =>
      el.classList.toggle("selected", Number(el.dataset.id) === id));
    majSelection();
    rendreBarre();
  }

  /* --- Calque de sélection : cadre + poignées + poignée de rotation
         (dans #impr2-page mais NON rogné par le bloc, façon Canva) --- */
  const ICONE_ROTOR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3"/><polyline points="3 18 4.7 17.3 5.4 19"/></svg>';

  function construireSelection() {
    const ov = document.createElement("div");
    ov.className = "impr2-selection"; ov.id = "impr2-selection"; ov.hidden = true;
    ["nw", "ne", "sw", "se", "n", "e", "s", "w"].forEach((coin) => {
      const p = document.createElement("span");
      p.className = "impr2-poignee " + (coin.length === 2 ? "coin " : "arete ") + coin;
      p.dataset.coin = coin;
      p.addEventListener("pointerdown", (e) => { const b = blocSel(); if (b) commencerResize(e, b, coin); });
      ov.appendChild(p);
    });
    const rot = document.createElement("span");
    rot.className = "impr2-rotor";
    rot.title = "Faire pivoter (maintiens Maj pour aller par pas de 15°)";
    rot.innerHTML = ICONE_ROTOR;
    rot.addEventListener("pointerdown", (e) => { const b = blocSel(); if (b) commencerRotation(e, b); });
    ov.appendChild(rot);
    return ov;
  }

  function majSelection() {
    const ov = $("impr2-selection");
    if (!ov) return;
    const b = blocSel();
    if (!b) { ov.hidden = true; return; }
    ov.hidden = false;
    ov.style.left = b.x + "%"; ov.style.top = b.y + "%";
    ov.style.width = b.w + "%"; ov.style.height = b.h + "%";
    ov.style.transform = b.rot ? ("rotate(" + b.rot + "deg)") : "";
  }

  function commencerRotation(e, bloc) {
    e.preventDefault(); e.stopPropagation();
    select(bloc.id);
    const el = page().querySelector('.impr2-bloc[data-id="' + bloc.id + '"]');
    const ov = $("impr2-selection");
    const r = (el || ov).getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ang0 = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    const rot0 = bloc.rot || 0;
    const bar = $("impr2-barre"); if (bar) bar.hidden = true;
    function move(ev) {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
      let rot = rot0 + (a - ang0);
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      rot = ((Math.round(rot) + 180) % 360 + 360) % 360 - 180;
      bloc.rot = rot;
      if (el) el.style.transform = "rotate(" + rot + "deg)";
      if (ov) ov.style.transform = "rotate(" + rot + "deg)";
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      pushHisto(); sauverLayout();
      rendreBarre();
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  /* --- Petits contrôles compacts pour la barre flottante --- */
  function barSep() { const s = document.createElement("span"); s.className = "impr2-bar-sep"; return s; }
  function barBtn(html, title, fn, actif) {
    const b = document.createElement("button");
    b.className = "impr2-bar-btn" + (actif ? " actif" : "");
    b.innerHTML = html; if (title) b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(e, b); });
    return b;
  }
  function barCouleur(val, title, onInput) {
    const i = document.createElement("input");
    i.type = "color"; i.className = "impr2-bar-couleur"; i.value = val || "#000000";
    if (title) i.title = title;
    i.addEventListener("click", (e) => e.stopPropagation());
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }
  function barSelect(options, cur, title, onChange) {
    const s = document.createElement("select"); s.className = "impr2-bar-select"; if (title) s.title = title;
    options.forEach((o) => { const op = document.createElement("option"); op.value = o.v; op.textContent = o.t; if (o.v === cur) op.selected = true; s.appendChild(op); });
    s.addEventListener("click", (e) => e.stopPropagation());
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }
  function barStepper(val, min, max, step, title, onSet) {
    const w = document.createElement("div"); w.className = "impr2-bar-step"; if (title) w.title = title;
    const moins = document.createElement("button"); moins.className = "impr2-bar-step-b"; moins.textContent = "−";
    const inp = document.createElement("input"); inp.type = "number"; inp.className = "impr2-bar-step-n"; inp.value = val;
    const plus = document.createElement("button"); plus.className = "impr2-bar-step-b"; plus.textContent = "+";
    const applique = (v, commit) => { v = clamp(v, min, max); inp.value = Math.round(v * 100) / 100; onSet(v, commit); };
    moins.addEventListener("click", (e) => { e.stopPropagation(); applique((parseFloat(inp.value) || 0) - step, true); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); applique((parseFloat(inp.value) || 0) + step, true); });
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (!isNaN(v)) onSet(clamp(v, min, max), false); });
    inp.addEventListener("change", () => applique(parseFloat(inp.value) || min, true));
    w.appendChild(moins); w.appendChild(inp); w.appendChild(plus);
    return w;
  }
  function barRange(min, max, step, val, title, onInput) {
    const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = val;
    i.className = "impr2-bar-range"; if (title) i.title = title;
    i.addEventListener("pointerdown", (e) => e.stopPropagation());
    i.addEventListener("input", () => onInput(parseFloat(i.value)));
    return i;
  }
  function barGroupe(ico, titre, ctrl) {
    const w = document.createElement("div"); w.className = "impr2-bar-groupe";
    const s = document.createElement("span"); s.className = "impr2-bar-ico"; s.textContent = ico; if (titre) s.title = titre;
    w.appendChild(s); w.appendChild(ctrl);
    return w;
  }

  /* Construit et affiche la barre flottante pour l'élément sélectionné. */
  function rendreBarre() {
    const bar = $("impr2-barre");
    if (!bar) return;
    const b = blocSel();
    if (!b) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.innerHTML = "";
    if (b.type === "texte") barreTexte(bar, b);
    else if (b.type === "forme") barreForme(bar, b);
    else if (b.type === "image") barreImage(bar, b);
    barreCommun(bar, b);
    bar.hidden = false;
    positionnerBarre();
  }

  function barreTexte(bar, b) {
    bar.appendChild(barSelect(Object.keys(POLICES).map((k) => ({ v: k, t: POLICES[k].label })), b.police || "titre", "Police",
      (v) => { b.police = v; rafraichirBloc(b); pushHisto(); }));
    bar.appendChild(barStepper(b.taille || 40, 8, 240, 1, "Taille du texte",
      (v, commit) => { b.taille = v; rafraichirBloc(b); if (commit) pushHisto(); else positionnerBarre(); }));
    bar.appendChild(barCouleur(b.couleur, "Couleur du texte", (v) => { b.couleur = v; rafraichirBloc(b); pushHisto(); }));
    bar.appendChild(barSep());
    bar.appendChild(barBtn("<b>G</b>", "Gras", () => { b.gras = !b.gras; rafraichirBloc(b); pushHisto(); rendreBarre(); }, b.gras));
    bar.appendChild(barBtn("<i>I</i>", "Italique", () => { b.italique = !b.italique; rafraichirBloc(b); pushHisto(); rendreBarre(); }, b.italique));
    bar.appendChild(barBtn("<u>S</u>", "Souligné", () => { b.souligne = !b.souligne; rafraichirBloc(b); pushHisto(); rendreBarre(); }, b.souligne));
    bar.appendChild(barSep());
    const aligns = [["left", "⯇"], ["center", "≡"], ["right", "⯈"]];
    const idx = Math.max(0, aligns.findIndex((a) => a[0] === (b.align || "left")));
    bar.appendChild(barBtn(aligns[idx][1], "Alignement", () => {
      const n = (aligns.findIndex((a) => a[0] === (b.align || "left")) + 1) % aligns.length;
      b.align = aligns[n][0]; rafraichirBloc(b); pushHisto(); rendreBarre();
    }));
    bar.appendChild(barSep());
    bar.appendChild(barCouleur((b.fond && b.fond !== "none") ? b.fond : "#f1f6f4", "Fond du texte",
      (v) => { b.fond = v; rafraichirBloc(b); pushHisto(); }));
    bar.appendChild(barBtn("⌀", "Retirer le fond", () => { b.fond = "none"; rafraichirBloc(b); pushHisto(); }, b.fond === "none" || !b.fond));
  }

  function barreForme(bar, b) {
    if (b.forme !== "ligne") {
      bar.appendChild(barCouleur(b.remplissage, "Remplissage", (v) => { b.remplissage = v; rafraichirBloc(b); pushHisto(); }));
      bar.appendChild(barCouleur(b.bordureCouleur, "Couleur de bordure", (v) => { b.bordureCouleur = v; rafraichirBloc(b); pushHisto(); }));
      bar.appendChild(barGroupe("▢", "Épaisseur de bordure", barStepper(b.bordure || 0, 0, 30, 1, "Épaisseur de bordure",
        (v, commit) => { b.bordure = v; rafraichirBloc(b); if (commit) pushHisto(); })));
    } else {
      bar.appendChild(barCouleur(b.remplissage, "Couleur", (v) => { b.remplissage = v; rafraichirBloc(b); pushHisto(); }));
      bar.appendChild(barGroupe("▬", "Épaisseur", barStepper(b.bordure || 3, 1, 30, 1, "Épaisseur",
        (v, commit) => { b.bordure = v; rafraichirBloc(b); if (commit) pushHisto(); })));
    }
    bar.appendChild(barSep());
    bar.appendChild(barGroupe("◑", "Transparence", barRange(0.1, 1, 0.05, (typeof b.opacite === "number") ? b.opacite : 1, "Transparence",
      (v) => { b.opacite = v; rafraichirBloc(b); })));
  }

  function barreImage(bar, b) {
    bar.appendChild(barSelect(Object.keys(FILTRES).map((k) => ({ v: k, t: FILTRES[k].label })), b.filtre || "aucun", "Filtre",
      (v) => { b.filtre = v; rafraichirBloc(b); pushHisto(); }));
    bar.appendChild(barSep());
    bar.appendChild(barGroupe("◑", "Transparence", barRange(0.1, 1, 0.05, (typeof b.opacite === "number") ? b.opacite : 1, "Transparence",
      (v) => { b.opacite = v; rafraichirBloc(b); })));
  }

  function barreCommun(bar, b) {
    bar.appendChild(barSep());
    bar.appendChild(barBtn("⤒", "Mettre devant", () => ordonner(true)));
    bar.appendChild(barBtn("⤓", "Mettre derrière", () => ordonner(false)));
    if (b.type !== "carte") bar.appendChild(barBtn("⧉", "Dupliquer (Ctrl+D)", () => dupliquerBloc()));
    bar.appendChild(barBtn("🗑", "Supprimer (Suppr)", () => retirerSel()));
  }

  /* Positionne la barre juste au-dessus (ou en dessous) de l'élément sélectionné. */
  function positionnerBarre() {
    const bar = $("impr2-barre");
    const b = blocSel();
    if (!bar || !b) { if (bar) bar.hidden = true; return; }
    const el = page().querySelector('.impr2-bloc[data-id="' + b.id + '"]');
    const scene = document.querySelector(".impr2-scene");
    if (!el || !scene) { bar.hidden = true; return; }
    const er = el.getBoundingClientRect();
    const sr = scene.getBoundingClientRect();
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const cx = er.left - sr.left + scene.scrollLeft + er.width / 2;
    let left = cx - bw / 2;
    let top = er.top - sr.top + scene.scrollTop - bh - 12;
    if (top < scene.scrollTop + 2) top = er.bottom - sr.top + scene.scrollTop + 12; // bascule en dessous si pas de place
    const maxLeft = scene.scrollLeft + scene.clientWidth - bw - 6;
    left = Math.max(scene.scrollLeft + 6, Math.min(left, Math.max(scene.scrollLeft + 6, maxLeft)));
    bar.style.left = left + "px";
    bar.style.top = top + "px";
  }

  /* ============================================================
     Édition de texte (double-clic)
     ============================================================ */

  function editerTexte(bloc, el) {
    const t = el.querySelector(".impr2-txt");
    if (!t) return;
    el.classList.add("edition-texte");
    t.contentEditable = "true";
    t.focus();
    // Sélectionner tout le contenu.
    try { const r = document.createRange(); r.selectNodeContents(t); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
    const fin = () => {
      t.contentEditable = "false";
      el.classList.remove("edition-texte");
      bloc.contenu = t.textContent;
      t.removeEventListener("blur", fin);
      rendreBarre();
      pushHisto();
    };
    t.addEventListener("blur", fin);
  }

  /* ============================================================
     Ajout / retrait / ordre
     ============================================================ */

  function ajouter(bloc) {
    blocs.push(bloc);
    page().appendChild(construireBlocEl(bloc));
    if (bloc.type === "carte") construireCarte(bloc);
    select(bloc.id);
    pushHisto(); sauverLayout();
  }
  function ajouterCarte() {
    const ex = blocs.find((b) => b.type === "carte");
    if (ex) { if (typeof toast === "function") toast("La carte est déjà sur la page."); select(ex.id); return; }
    ajouter(nouveauBloc("carte", { x: 6, y: 6 }));
  }
  function ajouterTexte() { ajouter(nouveauBloc("texte")); }
  function ajouterForme(forme) { ajouter(nouveauBloc(forme === "ligne" ? "ligne" : "forme", { forme: forme })); }
  function ajouterSouvenir(sid) { ajouter(nouveauBloc("souvenir", { sid: sid })); }
  function ajouterImage(src) { ajouter(nouveauBloc("image", { src: src })); }

  function dupliquerBloc() {
    const b = blocSel();
    if (!b) return;
    if (b.type === "carte") { if (typeof toast === "function") toast("La carte ne peut être présente qu'une fois par page."); return; }
    const c = Object.assign({}, b);
    c.id = seq++; c.z = ++zTop;
    c.x = clamp(b.x + 3, 0, 100 - b.w);
    c.y = clamp(b.y + 3, 0, 100 - b.h);
    blocs.push(c);
    page().appendChild(construireBlocEl(c));
    select(c.id);
    pushHisto(); sauverLayout();
  }

  function retirerSel() {
    const b = blocSel(); if (!b) return;
    if (b.type === "carte") detruireCarte();
    blocs = blocs.filter((x) => x.id !== b.id);
    const el = page().querySelector('.impr2-bloc[data-id="' + b.id + '"]');
    if (el) el.remove();
    select(null); pushHisto(); sauverLayout();
  }
  function ordonner(devant) {
    const b = blocSel(); if (!b) return;
    if (devant) b.z = ++zTop;
    else { const mn = Math.min.apply(null, blocs.map((x) => x.z)); b.z = mn - 1; }
    const el = page().querySelector('.impr2-bloc[data-id="' + b.id + '"]');
    if (el) el.style.zIndex = b.z;
    pushHisto(); sauverLayout();
  }

  /* ============================================================
     Déplacement & redimensionnement
     ============================================================ */

  function commencerDrag(e, bloc, el) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const rect = page().getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = bloc.x, oy = bloc.y;
    const bar = $("impr2-barre");
    let bouge = false;
    function move(ev) {
      const dx = (ev.clientX - sx) / rect.width * 100, dy = (ev.clientY - sy) / rect.height * 100;
      bloc.x = clamp(ox + dx, 0, 100 - bloc.w);
      bloc.y = clamp(oy + dy, 0, 100 - bloc.h);
      el.style.left = bloc.x + "%"; el.style.top = bloc.y + "%";
      if (!bouge && bar) bar.hidden = true;
      bouge = true;
      majSelection();
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (bouge) { pushHisto(); sauverLayout(); }
      rendreBarre();
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function commencerResize(e, bloc, coin) {
    e.preventDefault(); e.stopPropagation();
    select(bloc.id);
    const el = page().querySelector('.impr2-bloc[data-id="' + bloc.id + '"]');
    const rect = page().getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, o = { x: bloc.x, y: bloc.y, w: bloc.w, h: bloc.h };
    const bar = $("impr2-barre");
    if (bar) bar.hidden = true;
    function move(ev) {
      const dx = (ev.clientX - sx) / rect.width * 100, dy = (ev.clientY - sy) / rect.height * 100;
      let x = o.x, y = o.y, w = o.w, h = o.h;
      if (coin.indexOf("e") >= 0) w = o.w + dx;
      if (coin.indexOf("s") >= 0) h = o.h + dy;
      if (coin.indexOf("w") >= 0) { w = o.w - dx; x = o.x + dx; }
      if (coin.indexOf("n") >= 0) { h = o.h - dy; y = o.y + dy; }
      w = Math.max(5, w); h = Math.max(3, h);
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > 100) w = 100 - x;
      if (y + h > 100) h = 100 - y;
      bloc.x = x; bloc.y = y; bloc.w = w; bloc.h = h;
      if (el) { el.style.left = x + "%"; el.style.top = y + "%"; el.style.width = w + "%"; el.style.height = h + "%"; }
      if (bloc.type === "carte" && carte) carte.invalidateSize();
      majSelection();
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (bloc.type === "carte" && carte) carte.invalidateSize();
      pushHisto(); sauverLayout();
      rendreBarre();
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  /* ============================================================
     Ratio / dimensionnement de la page
     ============================================================ */

  function construireBarreRatio() {
    const cont = $("impr2-ratio");
    if (!cont || cont.childElementCount) return;
    RATIOS.forEach((x) => {
      const b = document.createElement("button");
      b.className = "segment-btn"; b.dataset.iratio = x.k; b.textContent = x.k;
      b.addEventListener("click", () => setRatio(x.k));
      cont.appendChild(b);
    });
  }
  function majRatioUI() {
    document.querySelectorAll("#impr2-ratio .segment-btn").forEach((b) =>
      b.classList.toggle("actif", b.dataset.iratio === ratioKey));
  }
  function setRatio(k) {
    ratioKey = k; majRatioUI(); ajusterPage(); rendreBarrePages(); pushHisto(); sauverLayout();
    if (carte) setTimeout(() => carte.invalidateSize(), 50);
  }

  function ajusterPage() {
    const scene = document.querySelector(".impr2-scene");
    const pg = page();
    if (!scene || !pg) return;
    const r = ratioDe(ratioKey);
    const dispoW = scene.clientWidth - 48, dispoH = scene.clientHeight - 48;
    let h = dispoH, w = h * r;
    if (w > dispoW) { w = dispoW; h = w / r; }
    pg.style.width = Math.max(120, w) + "px";
    pg.style.height = Math.max(120, h) + "px";
    pg.style.setProperty("--ech", (pg.clientHeight / 1000).toFixed(4));
    if (carte) carte.invalidateSize();
    if (selId != null) positionnerBarre();
  }

  /* ============================================================
     Souvenirs & pictos du thème (panneau gauche)
     ============================================================ */

  function rendreListeSouvenirs() {
    const cont = $("impr2-souvenirs"), vide = $("impr2-souvenirs-vide");
    if (!cont) return;
    cont.innerHTML = "";
    const liste = souvenirs();
    if (vide) vide.hidden = liste.length > 0;
    liste.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "impr2-souv-item";
      const cover = coverSrc(s);
      b.innerHTML = (cover ? '<span class="impr2-souv-vig" style="background-image:url(' + cover + ')"></span>'
        : '<span class="impr2-souv-vig impr2-souv-vig-vide">📍</span>') +
        '<span class="impr2-souv-nom">' + (i + 1) + ". " + echapper(s.nom || "Souvenir") + "</span>";
      b.addEventListener("click", () => ajouterSouvenir(s.id));
      cont.appendChild(b);
    });
  }

  function rendreThemePictos() {
    const bloc = $("impr2-theme-bloc"), cont = $("impr2-theme");
    if (!bloc || !cont) return;
    cont.innerHTML = "";
    const theme = (typeof etat !== "undefined" && etat.style) ? etat.style.theme : null;
    let cles = [];
    try {
      if (theme && typeof PICTO_THEMES !== "undefined" && PICTO_THEMES[theme]) cles = PICTO_THEMES[theme];
    } catch (e) {}
    if (!theme || !cles.length || typeof PICTO_THEME_SRC === "undefined") { bloc.hidden = true; return; }
    bloc.hidden = false;
    cles.forEach((cle) => {
      const src = PICTO_THEME_SRC[cle];
      if (!src) return;
      const b = document.createElement("button");
      b.className = "impr2-theme-btn";
      b.innerHTML = '<img src="' + src + '" alt="">';
      b.addEventListener("click", () => ajouter(nouveauBloc("image", { src: src, w: 12, h: 12 })));
      cont.appendChild(b);
    });
  }

  /* ============================================================
     Illustrations (SVG originaux, décor coloré façon Canva)
     Équivalent des pictos, mais illustrations plutôt qu'emojis.
     ============================================================ */

  const ILLUSTRATIONS = [
    { cat: "Nature", nom: "Sapin", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="45" y="70" width="10" height="18" rx="2" fill="#7a4a24"/><polygon points="50,10 30,44 70,44" fill="#2e7d4f"/><polygon points="50,28 26,60 74,60" fill="#256b43"/><polygon points="50,46 22,78 78,78" fill="#1e5b3a"/></svg>' },
    { cat: "Nature", nom: "Montagne", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="76" cy="26" r="9" fill="#f4c95d"/><polygon points="8,82 40,28 56,54 70,34 92,82" fill="#3d5a55"/><polygon points="33,42 40,28 48,42" fill="#f1f6f4"/><polygon points="63,47 70,34 78,47" fill="#f1f6f4"/></svg>' },
    { cat: "Nature", nom: "Feuille", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 90 C48 52 58 22 84 14 C86 42 78 82 50 90 Z" fill="#2e7d4f"/><path d="M50 90 C51 60 56 34 80 18" stroke="#1e5b3a" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>' },
    { cat: "Nature", nom: "Fleur", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="47" y="50" width="6" height="40" fill="#2e7d4f"/><g fill="#ff6b35"><circle cx="50" cy="28" r="13"/><circle cx="28" cy="46" r="13"/><circle cx="72" cy="46" r="13"/><circle cx="37" cy="66" r="13"/><circle cx="63" cy="66" r="13"/></g><circle cx="50" cy="50" r="12" fill="#f4c95d"/></svg>' },
    { cat: "Nature", nom: "Vague", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M2 60 Q18 44 34 60 T66 60 T98 60 V98 H2 Z" fill="#2c7da0"/><path d="M2 72 Q18 56 34 72 T66 72 T98 72 V98 H2 Z" fill="#8ecae6"/></svg>' },
    { cat: "Nature", nom: "Cactus", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="30" y="78" width="40" height="12" rx="3" fill="#c98a4b"/><rect x="43" y="26" width="14" height="58" rx="7" fill="#2e7d4f"/><path d="M43 52 h-8 a7 7 0 0 0-7 7 v10" fill="none" stroke="#2e7d4f" stroke-width="9" stroke-linecap="round"/><path d="M57 44 h9 a7 7 0 0 1 7 7 v14" fill="none" stroke="#256b43" stroke-width="9" stroke-linecap="round"/></svg>' },
    { cat: "Voyage", nom: "Boussole", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#f1f6f4" stroke="#10302c" stroke-width="4"/><polygon points="50,18 58,50 50,44 42,50" fill="#ff6b35"/><polygon points="50,82 42,50 50,56 58,50" fill="#3d5a55"/><circle cx="50" cy="50" r="4" fill="#10302c"/></svg>' },
    { cat: "Voyage", nom: "Tente", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,18 92,84 8,84" fill="#256b43"/><polygon points="50,42 66,84 34,84" fill="#f4c95d"/><line x1="50" y1="18" x2="50" y2="84" stroke="#1e5b3a" stroke-width="2"/></svg>' },
    { cat: "Voyage", nom: "Montgolfière", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 10 C30 10 20 28 20 44 C20 60 38 70 50 72 C62 70 80 60 80 44 C80 28 70 10 50 10 Z" fill="#ff6b35"/><path d="M50 10 C44 30 44 54 50 72" stroke="#f4c95d" stroke-width="5" fill="none"/><line x1="43" y1="70" x2="45" y2="80" stroke="#10302c" stroke-width="1.5"/><line x1="57" y1="70" x2="55" y2="80" stroke="#10302c" stroke-width="1.5"/><rect x="43" y="80" width="14" height="11" rx="2" fill="#7a4a24"/></svg>' },
    { cat: "Voyage", nom: "Épingle", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 92 C50 92 24 58 24 40 A26 26 0 1 1 76 40 C76 58 50 92 50 92 Z" fill="#ff6b35"/><circle cx="50" cy="40" r="11" fill="#fff"/></svg>' },
    { cat: "Voyage", nom: "Valise", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="40" y="22" width="20" height="14" rx="3" fill="none" stroke="#10302c" stroke-width="4"/><rect x="20" y="34" width="60" height="48" rx="7" fill="#2c7da0"/><rect x="45" y="34" width="10" height="48" fill="#8ecae6"/><line x1="20" y1="54" x2="80" y2="54" stroke="#1b5e78" stroke-width="3"/></svg>' },
    { cat: "Ciel", nom: "Soleil", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g stroke="#f4a63a" stroke-width="5" stroke-linecap="round"><line x1="50" y1="8" x2="50" y2="22"/><line x1="50" y1="78" x2="50" y2="92"/><line x1="8" y1="50" x2="22" y2="50"/><line x1="78" y1="50" x2="92" y2="50"/><line x1="21" y1="21" x2="31" y2="31"/><line x1="69" y1="69" x2="79" y2="79"/><line x1="79" y1="21" x2="69" y2="31"/><line x1="31" y1="69" x2="21" y2="79"/></g><circle cx="50" cy="50" r="20" fill="#f4c95d"/></svg>' },
    { cat: "Ciel", nom: "Nuage", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="#cfe6f1"><circle cx="36" cy="56" r="18"/><circle cx="58" cy="48" r="22"/><circle cx="74" cy="60" r="14"/><rect x="34" y="60" width="42" height="16" rx="8"/></g></svg>' },
    { cat: "Ciel", nom: "Lune", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M64 20 A32 32 0 1 0 64 84 A26 26 0 1 1 64 20 Z" fill="#f4c95d"/><path d="M28 24 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 Z" fill="#f4c95d"/><path d="M22 52 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5 Z" fill="#f4c95d"/></svg>' },
  ];

  function illusDataUri(svg) { return "data:image/svg+xml;utf8," + encodeURIComponent(svg); }

  function rendreIllustrations() {
    const cont = $("impr2-illus");
    if (!cont) return;
    cont.innerHTML = "";
    let catCourante = null;
    ILLUSTRATIONS.forEach((il) => {
      if (il.cat !== catCourante) {
        catCourante = il.cat;
        const h = document.createElement("div");
        h.className = "impr2-illus-cat";
        h.textContent = il.cat;
        cont.appendChild(h);
      }
      const b = document.createElement("button");
      b.className = "impr2-theme-btn impr2-illus-btn";
      b.title = il.nom;
      b.innerHTML = '<img src="' + illusDataUri(il.svg) + '" alt="' + echapper(il.nom) + '">';
      b.addEventListener("click", () => ajouterIllustration(il.svg));
      cont.appendChild(b);
    });
  }

  function ajouterIllustration(svg) {
    const pg = page();
    const rp = (pg && pg.clientHeight) ? (pg.clientWidth / pg.clientHeight) : 0.75;
    const w = 24;
    const h = clamp(w * rp, 6, 70); // boîte ~carrée en px → l'illustration garde ses proportions
    ajouter(nouveauBloc("image", { src: illusDataUri(svg), w: w, h: h, illus: true }));
  }

  /* ============================================================
     Impression (WYSIWYG, taille papier dérivée du ratio)
     ============================================================ */

  function dimsMm() {
    const r = ratioDe(ratioKey);
    const grand = 297; // plus grand côté ≈ A4
    return r >= 1 ? [grand, grand / r] : [grand * r, grand];
  }

  function imprimer() {
    select(null);
    const [wmm, hmm] = dimsMm();
    let st = $("impr2-print-style");
    if (!st) { st = document.createElement("style"); st.id = "impr2-print-style"; document.head.appendChild(st); }
    st.textContent = "@page { size: " + wmm.toFixed(1) + "mm " + hmm.toFixed(1) + "mm; margin: 0; }";

    const pg = page();
    const wAvant = pg.style.width, hAvant = pg.style.height;
    pg.style.width = wmm + "mm"; pg.style.height = hmm + "mm";
    pg.style.setProperty("--ech", (pg.clientHeight / 1000).toFixed(4));
    document.body.classList.add("impr2-printing");
    if (carte) carte.invalidateSize();

    const restaurer = () => {
      document.body.classList.remove("impr2-printing");
      pg.style.width = wAvant; pg.style.height = hAvant;
      ajusterPage();
      if (carte) carte.invalidateSize();
      window.removeEventListener("afterprint", restaurer);
    };
    window.addEventListener("afterprint", restaurer);
    setTimeout(() => { window.print(); setTimeout(restaurer, 900); }, 400);
  }

  /* ============================================================
     Branchements
     ============================================================ */

  function brancher() {
    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    on("impr2-retour", "click", fermer);
    on("impr2-imprimer", "click", imprimer);
    on("impr2-undo", "click", annuler);
    on("impr2-redo", "click", retablir);
    on("impr2-add-carte", "click", ajouterCarte);
    on("impr2-add-texte", "click", ajouterTexte);
    on("impr2-add-rect", "click", () => ajouterForme("rect"));
    on("impr2-add-ellipse", "click", () => ajouterForme("ellipse"));
    on("impr2-add-ligne", "click", () => ajouterForme("ligne"));
    on("impr2-img-input", "change", (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => ajouterImage(fr.result);
      fr.readAsDataURL(file);
    });
    on("impr2-bg", "input", (e) => { pageBg = e.target.value; page().style.background = pageBg; sauverLayout(); });
    on("impr2-bg", "change", pushHisto);
    on("impr2-bg-blanc", "click", () => { pageBg = "#ffffff"; $("impr2-bg").value = "#ffffff"; page().style.background = pageBg; pushHisto(); sauverLayout(); });

    const pg = page();
    if (pg) pg.addEventListener("pointerdown", (e) => { if (e.target === pg) select(null); });

    const scene = document.querySelector(".impr2-scene");
    if (scene) scene.addEventListener("scroll", () => { if (selId != null) positionnerBarre(); });

    window.addEventListener("resize", () => { if (!$("impression-ecran").hidden) ajusterPage(); });

    document.addEventListener("keydown", (e) => {
      if ($("impression-ecran").hidden) return;
      const ed = document.querySelector(".edition-texte");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); annuler(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); retablir(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selId != null && !ed) { e.preventDefault(); dupliquerBloc(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selId != null && !ed) { e.preventDefault(); retirerSel(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", brancher);
  else brancher();

  return { ouvrir: ouvrir, fermer: fermer };
})();
