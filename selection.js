/* =========================================================
   selection.js — Sélection et manipulation façon Miro
   ---------------------------------------------------------
   Tout ce qui entoure l'élément sélectionné sur la carte :
   - le cadre bleu avec quatre poignées d'angle (redimensionner),
   - la poignée de rotation (pictos, textes, photos),
   - les deux poignées d'extrémité des flèches,
   - le déplacement à la souris ou au doigt (formes comprises),
   - la barre d'outils flottante au-dessus de l'élément,
   - le clavier : Suppr (supprimer), flèches (déplacer), Échap,
   - la modification d'un texte directement sur la carte (double-clic).

   Ce fichier s'appuie sur app.js et ui.js (chargés avant lui) :
   l'état global `etat`, la carte Leaflet, les annotations, la
   sauvegarde… restent gérés là-bas.
   ========================================================= */

/* =========================================================
   1. Le cadre de sélection (créé une seule fois, à la demande)
   ========================================================= */

let cadreSelection = null;   // la <div> du cadre, avec ses poignées
let barreDecalee = false;    // vrai quand la barre est passée SOUS l'élément

/** Crée (une seule fois) le cadre et ses poignées, dans la zone de la carte. */
function obtenirCadreSelection() {
  if (cadreSelection) return cadreSelection;
  const zone = document.querySelector(".carte-zone");
  cadreSelection = document.createElement("div");
  cadreSelection.id = "cadre-selection";
  cadreSelection.hidden = true;

  // Les quatre poignées d'angle (nord-ouest, nord-est, sud-est, sud-ouest).
  ["nw", "ne", "se", "sw"].forEach((coin) => {
    const p = document.createElement("div");
    p.className = "cadre-poignee cadre-coin cadre-coin-" + coin;
    p.dataset.poignee = coin;
    p.addEventListener("pointerdown", surPoigneePointerDown);
    cadreSelection.appendChild(p);
  });

  // Les deux extrémités d'une flèche (base et pointe).
  ["p1", "p2"].forEach((bout) => {
    const p = document.createElement("div");
    p.className = "cadre-poignee cadre-bout cadre-bout-" + bout;
    p.dataset.poignee = bout;
    p.addEventListener("pointerdown", surPoigneePointerDown);
    cadreSelection.appendChild(p);
  });

  // La poignée de déplacement (glisser pour déplacer, tous types).
  const dep = document.createElement("div");
  dep.className = "cadre-poignee cadre-deplacer";
  dep.dataset.poignee = "deplacer";
  dep.title = "Déplacer";
  dep.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M8 1.5v13M1.5 8h13M8 1.5 5.8 3.9M8 1.5l2.2 2.4M8 14.5l-2.2-2.4M8 14.5l2.2-2.4' +
    'M1.5 8l2.4-2.2M1.5 8l2.4 2.2M14.5 8l-2.4-2.2M14.5 8l-2.4 2.2" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  dep.addEventListener("pointerdown", surDeplacerPointerDown);
  cadreSelection.appendChild(dep);

  // La poignée de rotation (pictos, textes et photos seulement).
  const rot = document.createElement("div");
  rot.className = "cadre-poignee cadre-rotation";
  rot.dataset.poignee = "rot";
  rot.title = "Faire pivoter";
  rot.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<path d="M13.5 8a5.5 5.5 0 1 1-2-4.24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M13.7 1.6v3h-3" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  rot.addEventListener("pointerdown", surPoigneePointerDown);
  cadreSelection.appendChild(rot);

  zone.appendChild(cadreSelection);
  return cadreSelection;
}

/* =========================================================
   2. Mesures : où est l'élément sélectionné, en pixels ?
   ========================================================= */

/** Échelle d'affichage d'une épingle (picto/texte/photo) au zoom courant. */
function echellePin(a) {
  const ref = typeof a.zoomRef === "number" ? a.zoomRef : 14;
  return Math.min(1.3, Math.pow(2, etat.carte.getZoom() - ref));
}

/**
 * Boîte de l'élément sélectionné, en pixels de la zone carte :
 * { x, y, w, h, rot } — ou { ligne, p1, p2, x, y, w, h } pour une flèche.
 * Renvoie null si l'élément n'est pas mesurable (caché, pas encore posé…).
 */
function bornesSelection(a) {
  const carte = etat.carte;
  if (!a || !a.marker) return null;

  // Flèche : on manipule ses deux extrémités, pas une boîte.
  if (a.type === "forme" && a.forme === "fleche") {
    const p1 = carte.latLngToContainerPoint([a.lat, a.lng]);
    const p2 = carte.latLngToContainerPoint([a.lat2, a.lng2]);
    return {
      ligne: true, p1, p2,
      x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
      w: Math.abs(p1.x - p2.x), h: Math.abs(p1.y - p2.y), rot: 0,
    };
  }

  // Cercle : boîte carrée autour du cercle réellement affiché.
  if (a.type === "forme" && a.forme === "cercle") {
    const centre = [(a.lat + a.lat2) / 2, (a.lng + a.lng2) / 2];
    const c = carte.latLngToContainerPoint(centre);
    const est = carte.latLngToContainerPoint([centre[0], a.lng2]);
    const r = Math.max(Math.abs(est.x - c.x), 6);
    return { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r, rot: 0 };
  }

  // Rectangle : ses deux coins géographiques.
  if (a.type === "forme") {
    const c1 = carte.latLngToContainerPoint([a.lat, a.lng]);
    const c2 = carte.latLngToContainerPoint([a.lat2, a.lng2]);
    return {
      x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y),
      w: Math.abs(c1.x - c2.x), h: Math.abs(c1.y - c2.y), rot: 0,
    };
  }

  // Trait ou dessin : la boîte qui englobe tous ses points (+ marge).
  if (a.type === "trait" || a.type === "dessin") {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    a.points.forEach((p) => {
      const pt = carte.latLngToContainerPoint(p);
      x1 = Math.min(x1, pt.x); y1 = Math.min(y1, pt.y);
      x2 = Math.max(x2, pt.x); y2 = Math.max(y2, pt.y);
    });
    if (!isFinite(x1)) return null;
    const marge = 6;
    return { x: x1 - marge, y: y1 - marge, w: x2 - x1 + 2 * marge, h: y2 - y1 + 2 * marge, rot: 0 };
  }

  // Épingle (picto, texte, photo) : taille réelle à l'écran de son contenu.
  const el = a.marker.getElement && a.marker.getElement();
  const wrap = el && (el.querySelector(".annot-wrap") || el.firstElementChild);
  if (!wrap || el.style.display === "none") return null;
  const echelle = echellePin(a);
  const centre = carte.latLngToContainerPoint([a.lat, a.lng]);
  const w = Math.max(wrap.offsetWidth * echelle, 14);
  const h = Math.max(wrap.offsetHeight * echelle, 14);
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, rot: a.rotation || 0 };
}

/* =========================================================
   3. Affichage : cadre + barre flottante suivent la sélection
   ========================================================= */

/** Vrai quand la sélection façon Miro est utilisable en ce moment. */
function selectionManipulable() {
  return etat.vue === "editeur" && etat.mode === "edition" && !etat.modeOutil;
}

/**
 * Recale (ou cache) le cadre de sélection et la barre flottante.
 * Appelée à chaque sélection, déplacement, zoom, redimensionnement…
 */
function majSelectionUI() {
  const cadre = obtenirCadreSelection();
  const barre = document.getElementById("annot-editeur");
  const a = etat.annotationActive;
  const bornes = (a && selectionManipulable()) ? bornesSelection(a) : null;

  if (!bornes) {
    cadre.hidden = true;
    if (barre) barre.hidden = true;
    return;
  }

  // --- Le cadre ---
  cadre.hidden = false;
  cadre.style.left = bornes.x + "px";
  cadre.style.top = bornes.y + "px";
  cadre.style.width = bornes.w + "px";
  cadre.style.height = bornes.h + "px";
  cadre.style.transform = bornes.rot ? `rotate(${bornes.rot}deg)` : "";

  const estFleche = !!bornes.ligne;
  const estPin = !estAnnotationVecteur(a);
  cadre.classList.toggle("cadre-ligne", estFleche);
  cadre.querySelectorAll(".cadre-coin").forEach((p) => { p.hidden = estFleche; });
  cadre.querySelector(".cadre-rotation").hidden = !estPin;
  // La poignée de déplacement est toujours disponible (tous les types).
  cadre.querySelector(".cadre-deplacer").hidden = false;

  // Les extrémités de la flèche, placées par rapport au coin de la boîte.
  cadre.querySelectorAll(".cadre-bout").forEach((p) => {
    p.hidden = !estFleche;
    if (!estFleche) return;
    const pt = p.dataset.poignee === "p1" ? bornes.p1 : bornes.p2;
    p.style.left = (pt.x - bornes.x) + "px";
    p.style.top = (pt.y - bornes.y) + "px";
  });

  // --- La barre flottante ---
  if (!barre) return;
  barre.hidden = false;
  const zone = document.querySelector(".carte-zone");
  const lw = barre.offsetWidth, lh = barre.offsetHeight;
  // Marge au-dessus du cadre (plus large si la poignée de rotation est là).
  const marge = estPin ? 34 : 12;
  let gauche = bornes.x + bornes.w / 2 - lw / 2;
  gauche = Math.max(8, Math.min(gauche, zone.clientWidth - lw - 8));
  let haut = bornes.y - lh - marge;
  barreDecalee = haut < 8;
  if (barreDecalee) haut = Math.min(bornes.y + bornes.h + marge, zone.clientHeight - lh - 8);
  barre.style.left = gauche + "px";
  barre.style.top = Math.max(8, haut) + "px";
}

/* =========================================================
   4. Poignées : redimensionner et faire pivoter
   ========================================================= */

/** Bornes de taille d'une épingle (reprend ANNOT_TAILLES d'app.js). */
function bornesTaillePin(a) {
  return ANNOT_TAILLES[a.type] || ANNOT_TAILLES.texte;
}

/**
 * Applique tout de suite la nouvelle taille d'une épingle, sans reconstruire
 * son icône (fluide pendant le glissement ; l'icône est refaite au lâcher).
 */
function appliquerTaillePinDirecte(a) {
  const el = a.marker && a.marker.getElement && a.marker.getElement();
  if (!el) return;
  const img = el.querySelector(".annot-picto-img");
  if (img) img.style.height = a.taille + "px";
  const picto = el.querySelector(".annot-picto");
  if (picto) picto.style.fontSize = a.taille + "px";
  if (a.type === "texte") {
    const t = el.querySelector(".annot-texte");
    if (t) t.style.fontSize = a.taille + "px";
  }
  const fig = el.querySelector(".annot-image");
  if (fig) fig.style.width = a.taille + "px";
}

/** Applique tout de suite la rotation d'une épingle (transform du wrap). */
function appliquerRotationPinDirecte(a) {
  const el = a.marker && a.marker.getElement && a.marker.getElement();
  const wrap = el && (el.querySelector(".annot-wrap") || el.firstElementChild);
  if (!wrap) return;
  wrap.style.transform =
    `translate(-50%, -50%) scale(${echellePin(a)}) rotate(${a.rotation || 0}deg)`;
}

/** Recale le curseur « Taille » de la barre pendant un redimensionnement. */
function majCurseurTaille(a) {
  const curseur = document.getElementById("annot-taille");
  const val = document.getElementById("annot-taille-val");
  if (curseur) curseur.value = a.taille;
  if (val) val.textContent = a.taille;
}

/** Repose la géométrie d'un trait / forme / dessin sur son calque Leaflet. */
function majGeometrieVecteur(a) {
  const m = a.marker;
  if (!m) return;
  if (a.type === "trait" || a.type === "dessin") {
    m.setLatLngs(a.points);
  } else if (a.type === "forme" && a.forme === "rect") {
    m.setBounds([[a.lat, a.lng], [a.lat2, a.lng2]]);
  } else if (a.type === "forme" && a.forme === "cercle") {
    const centre = [(a.lat + a.lat2) / 2, (a.lng + a.lng2) / 2];
    m.setLatLng(centre);
    m.setRadius(Math.max(etat.carte.distance(centre, [centre[0], a.lng2]), 1));
  } else if (a.type === "forme" && a.forme === "fleche") {
    m.setLatLngs(pointsFleche(a));
  }
}

/** Début d'un glissement sur une poignée (redimensionner / pivoter). */
function surPoigneePointerDown(e) {
  const a = etat.annotationActive;
  if (!a || !selectionManipulable()) return;
  if (typeof e.button === "number" && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const poignee = e.currentTarget.dataset.poignee;
  const carte = etat.carte;
  const cible = e.currentTarget;
  try { cible.setPointerCapture(e.pointerId); } catch (err) { /* très vieux navigateurs */ }
  carte.dragging.disable();

  // --- État de départ, selon le type de manipulation ---
  const bornes0 = bornesSelection(a);
  const depart = carte.mouseEventToContainerPoint(e);
  const contexte = { bornes0, depart };

  if (poignee === "rot") {
    // Rien d'autre à mémoriser : l'angle se lit sous le pointeur.
  } else if (!estAnnotationVecteur(a)) {
    // Épingle : distance initiale au centre → rapport de taille.
    contexte.centre = carte.latLngToContainerPoint([a.lat, a.lng]);
    contexte.dist0 = Math.max(
      Math.hypot(depart.x - contexte.centre.x, depart.y - contexte.centre.y), 8);
    contexte.taille0 = a.taille;
  } else if (a.type === "trait" || a.type === "dessin") {
    // Les points d'origine, convertis en pixels une fois pour toutes.
    contexte.points0 = a.points.map((p) => carte.latLngToContainerPoint(p));
  }

  const surMove = (ev) => {
    ev.preventDefault();
    const cur = carte.mouseEventToContainerPoint(ev);

    /* --- Rotation d'une épingle --- */
    if (poignee === "rot") {
      const centre = carte.latLngToContainerPoint([a.lat, a.lng]);
      // La poignée vit sous l'élément : à angle nul, elle pointe vers le bas.
      let deg = Math.atan2(cur.y - centre.y, cur.x - centre.x) * 180 / Math.PI - 90;
      // Aimantation douce sur les angles « ronds » (tous les 15°).
      const rond = Math.round(deg / 15) * 15;
      if (Math.abs(deg - rond) < 4) deg = rond;
      deg = ((deg + 180) % 360 + 360) % 360 - 180; // ramené entre -180 et 180
      a.rotation = Math.round(deg);
      appliquerRotationPinDirecte(a);
      majSelectionUI();
      return;
    }

    /* --- Extrémités d'une flèche --- */
    if (poignee === "p1" || poignee === "p2") {
      const ll = carte.containerPointToLatLng(cur);
      if (poignee === "p1") { a.lat = ll.lat; a.lng = ll.lng; }
      else { a.lat2 = ll.lat; a.lng2 = ll.lng; }
      majGeometrieVecteur(a);
      majSelectionUI();
      return;
    }

    /* --- Redimensionnement d'une épingle (rapport au centre) --- */
    if (!estAnnotationVecteur(a)) {
      const d = Math.hypot(cur.x - contexte.centre.x, cur.y - contexte.centre.y);
      const b = bornesTaillePin(a);
      a.taille = Math.max(b.min, Math.min(b.max,
        Math.round(contexte.taille0 * (d / contexte.dist0))));
      appliquerTaillePinDirecte(a);
      majCurseurTaille(a);
      majSelectionUI();
      return;
    }

    /* --- Redimensionnement d'une forme / trait / dessin ---
       Le coin opposé reste fixe ; tout se calcule en pixels. */
    const b0 = contexte.bornes0;
    const fixe = {
      x: poignee.includes("w") ? b0.x + b0.w : b0.x,
      y: poignee.includes("n") ? b0.y + b0.h : b0.y,
    };
    let dx = cur.x - fixe.x;
    let dy = cur.y - fixe.y;
    // Taille minimale : 12 px, en gardant le côté du pointeur.
    if (Math.abs(dx) < 12) dx = (dx < 0 ? -1 : 1) * 12;
    if (Math.abs(dy) < 12) dy = (dy < 0 ? -1 : 1) * 12;

    if (a.type === "forme" && a.forme === "cercle") {
      // Un cercle reste un cercle : on garde la plus grande des deux mesures.
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * d;
      dy = (dy < 0 ? -1 : 1) * d;
    }

    if (a.type === "forme") {
      const c1 = carte.containerPointToLatLng([fixe.x, fixe.y]);
      const c2 = carte.containerPointToLatLng([fixe.x + dx, fixe.y + dy]);
      a.lat = c1.lat; a.lng = c1.lng;
      a.lat2 = c2.lat; a.lng2 = c2.lng;
    } else {
      // Trait / dessin : chaque point suit l'étirement de la boîte.
      const ex = dx / ((poignee.includes("w") ? -1 : 1) * b0.w);
      const ey = dy / ((poignee.includes("n") ? -1 : 1) * b0.h);
      a.points = contexte.points0.map((p) => {
        const px = fixe.x + (p.x - fixe.x) * ex;
        const py = fixe.y + (p.y - fixe.y) * ey;
        const ll = carte.containerPointToLatLng([px, py]);
        return [ll.lat, ll.lng];
      });
    }
    majGeometrieVecteur(a);
    majSelectionUI();
  };

  const surFin = () => {
    cible.removeEventListener("pointermove", surMove);
    cible.removeEventListener("pointerup", surFin);
    cible.removeEventListener("pointercancel", surFin);
    carte.dragging.enable();
    // Épingle : on reconstruit proprement l'icône avec la taille finale.
    if (!estAnnotationVecteur(a)) redessinerAnnotation(a);
    planifierSauvegarde();
    majSelectionUI();
  };

  cible.addEventListener("pointermove", surMove);
  cible.addEventListener("pointerup", surFin);
  cible.addEventListener("pointercancel", surFin);
}

/* =========================================================
   5. Déplacer un trait / une forme / un dessin (glisser)
   ========================================================= */

/** Copie de la géométrie d'un élément dessiné (pour le déplacement). */
function copieGeometrieVecteur(a) {
  return {
    points: Array.isArray(a.points) ? a.points.map((p) => [p[0], p[1]]) : null,
    lat: a.lat, lng: a.lng, lat2: a.lat2, lng2: a.lng2,
  };
}

/**
 * Rend un calque dessiné déplaçable : appuyer dessus le sélectionne,
 * puis le glissement le déplace (appelé par attacherAnnotationVecteur).
 */
function brancherDeplacementVecteur(a) {
  const el = a.marker && a.marker.getElement && a.marker.getElement();
  if (!el) return;
  el.classList.add("vecteur-interactif");
  el.addEventListener("pointerdown", (e) => {
    if (!selectionManipulable()) return;
    if (typeof e.button === "number" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (etat.annotationActive !== a) selectionnerAnnotation(a);

    const carte = etat.carte;
    const depart = carte.mouseEventToLatLng(e);
    const geo0 = copieGeometrieVecteur(a);
    let bouge = false;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    carte.dragging.disable();

    const surMove = (ev) => {
      ev.preventDefault();
      const cur = carte.mouseEventToLatLng(ev);
      const dLat = cur.lat - depart.lat;
      const dLng = cur.lng - depart.lng;
      if (!bouge && Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) return;
      bouge = true;
      if (geo0.points) {
        a.points = geo0.points.map((p) => [p[0] + dLat, p[1] + dLng]);
      } else {
        a.lat = geo0.lat + dLat; a.lng = geo0.lng + dLng;
        a.lat2 = geo0.lat2 + dLat; a.lng2 = geo0.lng2 + dLng;
      }
      majGeometrieVecteur(a);
      majSelectionUI();
    };
    const surFin = () => {
      el.removeEventListener("pointermove", surMove);
      el.removeEventListener("pointerup", surFin);
      el.removeEventListener("pointercancel", surFin);
      carte.dragging.enable();
      if (bouge) planifierSauvegarde();
    };
    el.addEventListener("pointermove", surMove);
    el.addEventListener("pointerup", surFin);
    el.addEventListener("pointercancel", surFin);
  });
}

/**
 * Glissement sur la poignée de déplacement du cadre : déplace l'élément
 * sélectionné, quel que soit son type (épingle, forme, trait, dessin, flèche).
 */
function surDeplacerPointerDown(e) {
  const a = etat.annotationActive;
  if (!a || !selectionManipulable()) return;
  if (typeof e.button === "number" && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const carte = etat.carte;
  const cible = e.currentTarget;
  const depart = carte.mouseEventToLatLng(e);
  const geo0 = copieGeometrieVecteur(a);
  try { cible.setPointerCapture(e.pointerId); } catch (err) {}
  carte.dragging.disable();

  const surMove = (ev) => {
    ev.preventDefault();
    const cur = carte.mouseEventToLatLng(ev);
    const dLat = cur.lat - depart.lat;
    const dLng = cur.lng - depart.lng;
    if (a.points) {
      a.points = geo0.points.map((p) => [p[0] + dLat, p[1] + dLng]);
      majGeometrieVecteur(a);
    } else if (estAnnotationVecteur(a)) {
      a.lat = geo0.lat + dLat; a.lng = geo0.lng + dLng;
      a.lat2 = geo0.lat2 + dLat; a.lng2 = geo0.lng2 + dLng;
      majGeometrieVecteur(a);
    } else {
      a.lat = geo0.lat + dLat; a.lng = geo0.lng + dLng;
      a.marker.setLatLng([a.lat, a.lng]);
    }
    majSelectionUI();
  };
  const surFin = () => {
    cible.removeEventListener("pointermove", surMove);
    cible.removeEventListener("pointerup", surFin);
    cible.removeEventListener("pointercancel", surFin);
    carte.dragging.enable();
    planifierSauvegarde();
    majSelectionUI();
  };
  cible.addEventListener("pointermove", surMove);
  cible.addEventListener("pointerup", surFin);
  cible.addEventListener("pointercancel", surFin);
}

/* =========================================================
   6. Clavier : Suppr, flèches (déplacement fin), copier-coller
   ========================================================= */

// Presse-papier interne : la dernière annotation copiée (sans son marqueur).
let pressePapierAnnotation = null;

/** Copie l'annotation sélectionnée dans le presse-papier interne. */
function copierAnnotationActive() {
  const a = etat.annotationActive;
  if (!a) return;
  const copie = {};
  Object.keys(a).forEach((cle) => {
    if (cle === "marker") return; // le marqueur Leaflet ne se clone pas
    copie[cle] = a[cle];
  });
  // On clone en profondeur ce qui est modifiable (points, etc.).
  pressePapierAnnotation = JSON.parse(JSON.stringify(copie));
  toast("Élément copié — Ctrl+V pour le coller");
}

/** Colle une copie du presse-papier, légèrement décalée, et la sélectionne. */
function collerAnnotation() {
  if (!pressePapierAnnotation) return;
  const carte = etat.carte;
  const a = JSON.parse(JSON.stringify(pressePapierAnnotation));
  a.id = prochainIdSouvenir++;
  a.marker = null;
  // Décalage d'environ 24 px vers le bas-droite, pour voir la copie.
  const decale = (lat, lng) => {
    const p = carte.latLngToContainerPoint([lat, lng]);
    const ll = carte.containerPointToLatLng([p.x + 24, p.y + 24]);
    return [ll.lat, ll.lng];
  };
  if (Array.isArray(a.points)) {
    a.points = a.points.map((p) => decale(p[0], p[1]));
  } else if (estAnnotationVecteur(a)) {
    [a.lat, a.lng] = decale(a.lat, a.lng);
    [a.lat2, a.lng2] = decale(a.lat2, a.lng2);
  } else {
    [a.lat, a.lng] = decale(a.lat, a.lng);
    a.zoomRef = carte.getZoom();
  }
  etat.annotations.push(a);
  attacherAnnotation(a);
  selectionnerAnnotation(a);
  planifierSauvegarde();
  toast("Élément collé");
}

/** Déplace l'élément sélectionné d'un petit pas, en pixels d'écran. */
function deplacerSelectionPixels(dx, dy) {
  const a = etat.annotationActive;
  if (!a || !a.marker) return;
  const carte = etat.carte;
  const bouger = (lat, lng) => {
    const p = carte.latLngToContainerPoint([lat, lng]);
    const ll = carte.containerPointToLatLng([p.x + dx, p.y + dy]);
    return [ll.lat, ll.lng];
  };
  if (a.points) {
    a.points = a.points.map((p) => bouger(p[0], p[1]));
    majGeometrieVecteur(a);
  } else if (estAnnotationVecteur(a)) {
    [a.lat, a.lng] = bouger(a.lat, a.lng);
    [a.lat2, a.lng2] = bouger(a.lat2, a.lng2);
    majGeometrieVecteur(a);
  } else {
    [a.lat, a.lng] = bouger(a.lat, a.lng);
    a.marker.setLatLng([a.lat, a.lng]);
  }
  planifierSauvegarde();
  majSelectionUI();
}

/** Vrai si l'utilisateur est en train d'écrire quelque part. */
function saisieEnCours(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" || t.isContentEditable);
}

/* =========================================================
   7. Modifier un texte directement sur la carte
   ========================================================= */

let editionTexteEnCours = null; // { a, el } pendant la saisie

/** Passe un texte posé sur la carte en édition directe (double-clic). */
function demarrerEditionTexte(a) {
  if (!a || a.type !== "texte" || !a.marker) return;
  if (editionTexteEnCours) terminerEditionTexte();
  const el = a.marker.getElement && a.marker.getElement();
  const champ = el && el.querySelector(".annot-texte");
  if (!champ) return;

  editionTexteEnCours = { a, el: champ };
  champ.contentEditable = "true";
  champ.classList.add("annot-edition");
  if (a.marker.dragging) a.marker.dragging.disable();
  etat.carte.doubleClickZoom.disable();

  champ.addEventListener("input", surSaisieTexteCarte);
  champ.addEventListener("blur", terminerEditionTexte);
  champ.addEventListener("keydown", surToucheEditionTexte);
  champ.addEventListener("pointerdown", stopperPropagation);

  champ.focus();
  // Tout le texte est présélectionné : taper remplace, cliquer place le curseur.
  const sel = window.getSelection();
  if (sel) {
    const plage = document.createRange();
    plage.selectNodeContents(champ);
    sel.removeAllRanges();
    sel.addRange(plage);
  }
}

function stopperPropagation(e) { e.stopPropagation(); }

/** Pendant la saisie : on garde le texte à jour, sans reconstruire l'icône. */
function surSaisieTexteCarte() {
  if (!editionTexteEnCours) return;
  editionTexteEnCours.a.texte = editionTexteEnCours.el.innerText
    .replace(/\u00a0/g, " ").replace(/\n+$/, "");
  planifierSauvegarde();
  majSelectionUI();
}

/** Échap ou Ctrl+Entrée : fin de la saisie (le blur fait le reste). */
function surToucheEditionTexte(e) {
  e.stopPropagation(); // les raccourcis globaux (Suppr…) ne s'appliquent pas
  if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    if (editionTexteEnCours) editionTexteEnCours.el.blur();
  }
}

/** Fin de l'édition directe : on fige le texte et on refait l'icône. */
function terminerEditionTexte() {
  const edition = editionTexteEnCours;
  if (!edition) return;
  editionTexteEnCours = null;
  const { a, el } = edition;
  el.removeEventListener("input", surSaisieTexteCarte);
  el.removeEventListener("blur", terminerEditionTexte);
  el.removeEventListener("keydown", surToucheEditionTexte);
  el.removeEventListener("pointerdown", stopperPropagation);
  el.contentEditable = "false";
  el.classList.remove("annot-edition");
  if (a.marker && a.marker.dragging && etat.mode === "edition") a.marker.dragging.enable();
  etat.carte.doubleClickZoom.enable();

  // Un texte vidé n'aurait plus rien à cliquer : on le supprime (annulable).
  if (!(a.texte || "").trim()) {
    if (etat.annotationActive === a) supprimerAnnotationActive();
    return;
  }
  redessinerAnnotation(a);
  planifierSauvegarde();
  majSelectionUI();
}

/* =========================================================
   8. Branchements (appelé une fois par brancherUI, ui.js)
   ========================================================= */

function brancherSelectionUI() {
  // Le cadre suit la carte quand elle bouge ou zoome.
  etat.carte.on("move zoom zoomend moveend viewreset", () => {
    if (etat.annotationActive) majSelectionUI();
  });
  window.addEventListener("resize", () => {
    if (etat.annotationActive) majSelectionUI();
  });

  // Bouton « ✏️ » de la barre : modifier le texte directement sur la carte.
  const btnTexte = document.getElementById("annot-modifier-texte");
  if (btnTexte) {
    btnTexte.addEventListener("click", () => {
      if (etat.annotationActive) demarrerEditionTexte(etat.annotationActive);
    });
  }

  // Clavier : Suppr supprime, les flèches déplacent, Ctrl+C/V/D copie-colle.
  document.addEventListener("keydown", (e) => {
    if (!selectionManipulable() || saisieEnCours(e)) return;

    // Copier / coller / dupliquer (fonctionne aussi sans sélection pour coller).
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c" && etat.annotationActive) { e.preventDefault(); copierAnnotationActive(); return; }
      if (k === "v" && pressePapierAnnotation) { e.preventDefault(); collerAnnotation(); return; }
      if (k === "d" && etat.annotationActive) {
        e.preventDefault();
        copierAnnotationActive();
        collerAnnotation();
        return;
      }
      return;
    }

    if (!etat.annotationActive) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      supprimerAnnotationActive();
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      const pas = e.shiftKey ? 10 : 2;
      deplacerSelectionPixels(
        e.key === "ArrowLeft" ? -pas : e.key === "ArrowRight" ? pas : 0,
        e.key === "ArrowUp" ? -pas : e.key === "ArrowDown" ? pas : 0
      );
    }
  });
}
