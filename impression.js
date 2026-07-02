/* =========================================================
   impression.js — Fenêtre d'impression, entièrement indépendante
   ---------------------------------------------------------
   Cette page lit les données du carnet (trace, souvenirs, style) depuis
   la fenêtre qui l'a ouverte (window.opener), mais construit ENTIÈREMENT
   sa propre carte et ses propres cartes de souvenirs elle-même, dans sa
   propre fenêtre.

   Objectif : quoi qu'il se passe ici (y compris une impression annulée
   par l'utilisateur), l'application principale n'est JAMAIS modifiée et
   reste utilisable — il suffit de fermer cette fenêtre.
   ========================================================= */

(function () {
  const parent = window.opener;
  if (!parent || !parent.etat || !parent.etat.trace) {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:sans-serif;max-width:560px;">' +
      "Impossible de récupérer le carnet depuis l'application. " +
      "Ferme cette fenêtre et réessaie depuis le bouton « Affiche PDF ».</p>";
    return;
  }

  // Lecture seule : on ne modifie jamais rien chez le parent.
  const etatParent = parent.etat;
  const trace = etatParent.trace;
  const souvenirs = etatParent.souvenirs;
  const style = etatParent.style || {};
  const pictosPerso = etatParent.pictosPerso || [];
  const reglages = parent.reglagesAffiche || {
    format: "A4", orientation: "portrait", police: "systeme", couleur: "#2f3b34",
  };

  /* ---------- Constantes (reprises de app.js) ---------- */

  const FORMATS_PAPIER = {
    A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297],
  };
  const TYPES_LIGNE = { plein: null, pointilles: "2 8", tirets: "10 9" };
  const FONDS = {
    topo: {
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 17, attribution: 'Carte : © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · Données : © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    },
    clair: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      options: { maxZoom: 20, subdomains: "abcd", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>' },
    },
    epure: {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: { maxZoom: 20, subdomains: "abcd", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>' },
    },
  };
  const POLICES = {
    systeme: { css: '"Avenir Next", system-ui, sans-serif' },
    serif:   { css: 'Georgia, "Times New Roman", serif' },
    etroite: { css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
    titre:   { css: '"Bricolage Grotesque", "Avenir Next", sans-serif' },
  };
  const PICTOS = [
    { cle: "souvenir", glyph: "" },
    { cle: "depart",   glyph: "🚩" },
    { cle: "arrivee",  glyph: "🏁" },
    { cle: "montagne", glyph: "⛰️" },
    { cle: "foret",    glyph: "🌲" },
    { cle: "lac",      glyph: "🏞️" },
    { cle: "mer",      glyph: "🌊" },
    { cle: "pont",     glyph: "🌉" },
    { cle: "tunnel",   glyph: "🚇" },
    { cle: "ferry",    glyph: "⛴️" },
    { cle: "avion",    glyph: "✈️" },
    { cle: "village",  glyph: "🏘️" },
    { cle: "ville",    glyph: "🏙️" },
  ];
  const PICTO_GLYPH = Object.fromEntries(PICTOS.map((p) => [p.cle, p.glyph]));
  const STYLE_VECTORIEL_URL = "https://tiles.openfreemap.org/styles/liberty";

  const MARGE_MM = 12;
  // Marge de sécurité (mm) retirée de la hauteur de la carte : si le
  // navigateur affiche ses propres en-tête/pied de page à l'impression, ça
  // grignote de la place sur chaque feuille sans qu'on puisse le mesurer.
  const MARGE_SECURITE_ENTETE_MM = 20;
  const ECART_MM = 5;
  const ECART_CARTES_MM = 6;
  const MM_EN_PX = 96 / 25.4; // résolution CSS standard : 96px = 1 pouce = 25,4mm

  /* ---------- Petites fonctions utilitaires (reprises de app.js) ---------- */

  function echapperHtml(texte) {
    const div = document.createElement("div");
    div.textContent = texte;
    return div.innerHTML;
  }

  function obtenirPictoPerso(cle) {
    if (!cle || !cle.startsWith("perso:")) return null;
    const id = Number(cle.slice("perso:".length));
    return pictosPerso.find((p) => p.id === id) || null;
  }

  function creerIconeSouvenir(numero, pictoCle) {
    const perso = obtenirPictoPerso(pictoCle);
    const glyph = perso ? "" : PICTO_GLYPH[pictoCle];
    const pin = `
      <svg class="pin-souvenir" width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
        <path d="M17 1 C8 1 1 8 1 17 C1 29 17 43 17 43 C17 43 33 29 33 17 C33 8 26 1 17 1 Z"
              fill="#d35438" stroke="#ffffff" stroke-width="2"/>
        <circle cx="17" cy="16" r="8.5" fill="#ffffff"/>
      </svg>`;
    const contenu = perso
      ? `<img class="pin-image" src="${perso.src}" alt=""><span class="pin-num">${numero}</span>`
      : glyph
        ? `<span class="pin-glyph">${glyph}</span><span class="pin-num">${numero}</span>`
        : `<span class="pin-chiffre">${numero}</span>`;
    return L.divIcon({
      className: "",
      html: `<div class="pin-wrap">${pin}${contenu}</div>`,
      iconSize: [34, 44],
      iconAnchor: [17, 43],
      popupAnchor: [0, -40],
    });
  }

  function photoCouverture(souvenir) {
    const i = souvenir.couverture;
    if (i === null || i === undefined) return null;
    return souvenir.photos[i] || null;
  }

  /**
   * Largeur d'un souvenir dans la mosaïque, en unités de grille, selon la
   * richesse de son contenu : un souvenir bien rempli occupe un grand
   * rectangle, un souvenir léger un petit — c'est ce qui fait varier la
   * taille des cases.
   */
  function classifierTailleSouvenir(souvenir) {
    const aPhoto = !!(photoCouverture(souvenir) || souvenir.photos[0]);
    const longueurTexte = (souvenir.textes || "").length;
    const nbAutresPhotos = Math.max(0, souvenir.photos.length - 1);
    if (aPhoto && longueurTexte > 150) return 2;   // photo + long récit
    if (longueurTexte > 400) return 2;             // très long récit seul
    if (nbAutresPhotos >= 3) return 2;             // beaucoup de photos
    return 1;
  }

  function classeZone(couche) {
    const id = (couche.id || "").toLowerCase();
    const sl = (couche["source-layer"] || "").toLowerCase();
    if (id === "background") return "fond";
    if (sl === "water" || sl === "waterway" || /water|ocean|sea|lake|river|bay/.test(id)) return "eau";
    if (/wood|forest|park|golf|cemetery|orchard|vineyard/.test(id)) return "foret";
    if (/grass|meadow|scrub|heath|wetland|farmland|landcover|landuse/.test(id)) return "prairie";
    if (sl === "building" || /building/.test(id)) return "bati";
    if (sl === "transportation" || sl === "transportation_name" ||
        /road|highway|street|path|track|bridge|tunnel|rail|ferry/.test(id)) return "route";
    return null;
  }

  function masquerDetail(couche) {
    const id = (couche.id || "").toLowerCase();
    const sl = (couche["source-layer"] || "").toLowerCase();
    if (["building", "housenumber", "poi", "aeroway"].includes(sl)) return true;
    if (/building|housenumber|poi|aeroway|ferry/.test(id)) return true;
    if (sl === "transportation" || sl === "transportation_name" || /road|bridge|tunnel|rail|path|track|service/.test(id)) {
      return !/motorway|trunk|primary/.test(id);
    }
    return false;
  }

  /* ---------- Carte principale ---------- */

  function construireCartePrincipale(largeurMm, hauteurMm) {
    document.getElementById("zone-carte").style.width = largeurMm + "mm";
    document.getElementById("zone-carte").style.height = hauteurMm + "mm";

    const carte = L.map("map", { zoomControl: false, attributionControl: true });
    const attentes = [];

    if (style.fond === "vectoriel" && L.maplibreGL) {
      const coucheGl = L.maplibreGL({
        pane: "tilePane",
        style: STYLE_VECTORIEL_URL,
        attribution:
          '© <a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ' +
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        // Sans ça, le tampon WebGL est effacé juste après chaque image
        // affichée : le fond disparaîtrait à l'impression.
        preserveDrawingBuffer: true,
      }).addTo(carte);

      // Toute cette partie (couleurs des zones, préréglage "ancienne") est du
      // pur embellissement : si elle échoue pour une raison quelconque, la
      // carte doit quand même s'imprimer avec le fond vectoriel standard,
      // plutôt que de faire échouer TOUTE l'affiche (souvenirs compris).
      attentes.push(new Promise((resolve) => {
        let fini = false;
        const terminer = () => { if (!fini) { fini = true; resolve(); } };
        setTimeout(terminer, 6000);

        try {
          const appliquerStyleVecteur = (glMap) => {
            try {
              const zones = (style.vecteur && style.vecteur.zones) || {};
              Object.keys(zones).forEach((cat) => {
                const couleur = zones[cat];
                if (!couleur) return;
                glMap.getStyle().layers.forEach((c) => {
                  if (classeZone(c) !== cat) return;
                  try {
                    if (c.type === "fill") glMap.setPaintProperty(c.id, "fill-color", couleur);
                    else if (c.type === "line") glMap.setPaintProperty(c.id, "line-color", couleur);
                    else if (c.type === "background") glMap.setPaintProperty(c.id, "background-color", couleur);
                    else if (c.type === "fill-extrusion") glMap.setPaintProperty(c.id, "fill-extrusion-color", couleur);
                  } catch (e) { /* couche non colorable */ }
                });
              });
              if (style.vecteur && style.vecteur.preset === "ancienne") {
                glMap.getStyle().layers.forEach((l) => {
                  if (masquerDetail(l)) { try { glMap.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {} }
                });
                glMap.getStyle().layers.forEach((l) => {
                  if (l.type !== "symbol" || !(l.layout && l.layout["text-field"])) return;
                  try { if (glMap.getLayoutProperty(l.id, "visibility") === "none") return; } catch (e) {}
                  try { glMap.setLayoutProperty(l.id, "text-font", ["Noto Sans Italic"]); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-color", "#5a4632"); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-halo-color", "#e9e0c4"); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-halo-width", 1.4); } catch (e) {}
                });
                document.getElementById("map").classList.add("vecteur-ancienne");
              }
            } catch (e) { /* embellissement seulement : on continue quand même */ }
            terminer();
          };

          // getMaplibreMap() peut renvoyer undefined juste après l'ajout du
          // calque (la carte MapLibre sous-jacente n'existe pas encore tout
          // à fait) : on sonde jusqu'à ce qu'elle soit là ET son style chargé,
          // plutôt que de supposer qu'elle est prête immédiatement.
          let appliquee = false;
          const tenter = () => {
            if (appliquee) return;
            const glMap = coucheGl.getMaplibreMap();
            if (!glMap || !glMap.isStyleLoaded()) return;
            appliquee = true;
            clearInterval(sondage);
            appliquerStyleVecteur(glMap);
          };
          const sondage = setInterval(tenter, 200);
          tenter();
        } catch (e) {
          terminer();
        }
      }));
    } else {
      const fond = FONDS[style.fond] || FONDS.topo;
      const coucheFond = L.tileLayer(fond.url, fond.options).addTo(carte);
      attentes.push(new Promise((resolve) => {
        let fini = false;
        const terminer = () => { if (!fini) { fini = true; resolve(); } };
        setTimeout(terminer, 6000);
        coucheFond.once("load", terminer);
      }));
    }

    document.getElementById("map").classList.add("ambiance-" + (style.ambiance || "naturel"));

    const t = style.trace || { couleur: "#c8893d", epaisseur: 4, type: "plein" };
    trace.segments.forEach((seg) => {
      L.polyline(seg, { color: t.couleur, weight: t.epaisseur, opacity: 0.9, dashArray: TYPES_LIGNE[t.type] }).addTo(carte);
    });

    const points = [];
    trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
    souvenirs.forEach((s, i) => {
      L.marker([s.lat, s.lng], { icon: creerIconeSouvenir(i + 1, s.pictogramme) }).addTo(carte);
      points.push([s.lat, s.lng]);
    });

    carte.invalidateSize();
    if (points.length) carte.fitBounds(points, { padding: [20, 20] });

    const titre = (style.titre || "").trim();
    if (titre) {
      const titreEl = document.getElementById("carte-titre");
      titreEl.textContent = titre;
      titreEl.hidden = false;
    }

    return Promise.all(attentes);
  }

  /* ---------- Cartes souvenirs (mosaïque) ---------- */

  function construireCarteImpression(souvenir, numero) {
    const carte = document.createElement("article");
    carte.className = "impression-carte";
    const interieur = document.createElement("div");
    interieur.className = "impression-carte-interieur";
    carte.appendChild(interieur);

    const entete = document.createElement("div");
    entete.className = "impression-carte-entete";

    const pin = document.createElement("span");
    pin.className = "impression-carte-pin";
    pin.textContent = numero;
    entete.appendChild(pin);

    const titre = document.createElement("h3");
    titre.className = "impression-carte-titre";
    titre.textContent = souvenir.nom || "Souvenir";
    entete.appendChild(titre);

    const miniMapEl = document.createElement("div");
    miniMapEl.className = "impression-mini-map";
    entete.appendChild(miniMapEl);

    interieur.appendChild(entete);

    const couv = photoCouverture(souvenir) || souvenir.photos[0] || null;
    if (couv) {
      const img = document.createElement("img");
      img.className = "impression-photo-couverture";
      img.src = couv.src;
      interieur.appendChild(img);
      if (couv.legende) {
        const legende = document.createElement("p");
        legende.className = "impression-legende";
        legende.textContent = couv.legende;
        interieur.appendChild(legende);
      }
    }

    if (souvenir.textes) {
      const h4 = document.createElement("h4");
      h4.className = "impression-recit-titre";
      h4.textContent = "Récit";
      interieur.appendChild(h4);

      const texte = document.createElement("p");
      texte.className = "impression-carte-texte";
      texte.textContent = souvenir.textes;
      interieur.appendChild(texte);
    }

    const autres = souvenir.photos.filter((p) => p !== couv);
    if (autres.length) {
      const galerie = document.createElement("div");
      galerie.className = "impression-galerie";
      autres.forEach((p) => {
        const mini = document.createElement("img");
        mini.className = "impression-photo-mini";
        mini.src = p.src;
        galerie.appendChild(mini);
      });
      interieur.appendChild(galerie);
    }

    return { carte, miniMapEl };
  }

  function creerMiniCarteImpression(conteneur, souvenir) {
    const carte = L.map(conteneur, {
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
    const fond = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { subdomains: "abcd", maxZoom: 20 }
    ).addTo(carte);

    const couche = L.layerGroup().addTo(carte);
    trace.segments.forEach((seg) => {
      L.polyline(seg, { color: "#c8893d", weight: 2, opacity: 0.85 }).addTo(couche);
    });
    L.circleMarker([souvenir.lat, souvenir.lng], {
      radius: 5, weight: 2, color: "#fff", fillColor: "#d35438", fillOpacity: 1,
    }).addTo(couche);

    carte.invalidateSize();
    const points = [];
    trace.segments.forEach((seg) => seg.forEach((p) => points.push(p)));
    points.push([souvenir.lat, souvenir.lng]);
    if (points.length) {
      carte.fitBounds(points, { paddingTopLeft: [8, 8], paddingBottomRight: [8, 8] });
    }

    return new Promise((resolve) => {
      let fini = false;
      const terminer = () => { if (!fini) { fini = true; resolve(); } };
      setTimeout(terminer, 5000);
      fond.once("load", terminer);
    });
  }

  /**
   * Empaquetage "skyline" en mosaïque, optimisé pour l'espace : les grands
   * rectangles se placent d'abord, puis les plus petits viennent boucher
   * les trous — y compris sur les pages déjà entamées (chaque souvenir garde
   * son numéro visible, la lecture ne dépend donc pas de sa position).
   * Renvoie un tableau de pages ; chaque page = { hauteurPx, cartes:
   * [{ info, colDepart, largeurUnites, top }] }.
   */
  function paginerSouvenirsMosaique(cartesInfo, nbUnites, hauteurPageDisponiblePx) {
    const pages = [];
    function creerPage() {
      const p = { cartes: [], hauteursUnites: new Array(nbUnites).fill(0) };
      pages.push(p);
      return p;
    }

    // Larges puis hauts d'abord : les petits combleront les trous restants.
    const ordonnees = [...cartesInfo].sort(
      (a, b) => (b.largeurUnites - a.largeurUnites) || (b.hauteurPx - a.hauteurPx)
    );

    ordonnees.forEach((info) => {
      const largeur = Math.min(info.largeurUnites, nbUnites);

      // Première page où la carte tient, à la position la plus haute possible.
      let place = null;
      for (const page of pages) {
        let meilleureCol = 0;
        let meilleureHauteur = Infinity;
        for (let c = 0; c <= nbUnites - largeur; c++) {
          let h = 0;
          for (let k = c; k < c + largeur; k++) h = Math.max(h, page.hauteursUnites[k]);
          if (h < meilleureHauteur) { meilleureHauteur = h; meilleureCol = c; }
        }
        if (meilleureHauteur + info.hauteurPx <= hauteurPageDisponiblePx) {
          place = { page, col: meilleureCol, top: meilleureHauteur };
          break;
        }
      }
      // Aucune page ne peut l'accueillir : nouvelle page (même si la carte
      // est plus haute qu'une page entière, il faut bien la poser quelque part).
      if (!place) place = { page: creerPage(), col: 0, top: 0 };

      place.page.cartes.push({ info, colDepart: place.col, largeurUnites: largeur, top: place.top });
      const nouvelleHauteur = place.top + info.hauteurPx + ECART_CARTES_MM * MM_EN_PX;
      for (let k = place.col; k < place.col + largeur; k++) {
        place.page.hauteursUnites[k] = nouvelleHauteur;
      }
    });

    pages.forEach((p) => {
      p.hauteurPx = p.cartes.reduce((m, c) => Math.max(m, c.top + c.info.hauteurPx), 0);
      delete p.hauteursUnites;
    });
    return pages;
  }

  /* ---------- Orchestration ---------- */

  async function preparer() {
    const [lPortrait, hPortrait] = FORMATS_PAPIER[reglages.format] || FORMATS_PAPIER.A4;
    const [largeur, hauteur] = reglages.orientation === "paysage" ? [hPortrait, lPortrait] : [lPortrait, hPortrait];

    const styleDyn = document.createElement("style");
    styleDyn.textContent = `@media print { @page { size: ${largeur}mm ${hauteur}mm; margin: ${MARGE_MM}mm; } }`;
    document.head.appendChild(styleDyn);

    document.documentElement.style.setProperty("--impression-police", (POLICES[reglages.police] || POLICES.systeme).css);
    document.documentElement.style.setProperty("--impression-couleur-texte", reglages.couleur || "#2f3b34");

    const largeurUtileMm = largeur - MARGE_MM * 2;
    const hauteurUtileMm = hauteur - MARGE_MM * 2 - MARGE_SECURITE_ENTETE_MM;

    const attenteCarte = construireCartePrincipale(largeurUtileMm, hauteurUtileMm);

    // Sans souvenir, pas de section "Souvenirs du voyage" : la carte seule
    // (et pas de saut de page après elle, qui laisserait une feuille blanche).
    if (souvenirs.length === 0) {
      document.getElementById("impression").hidden = true;
      const zoneCarte = document.getElementById("zone-carte");
      zoneCarte.style.breakAfter = "auto";
      zoneCarte.style.pageBreakAfter = "auto";
    }

    const zoneMesure = document.getElementById("impression-mesure");
    const cartesInfo = [];
    const attentesMini = [];
    souvenirs.forEach((s, i) => {
      const { carte, miniMapEl } = construireCarteImpression(s, i + 1);
      zoneMesure.appendChild(carte);
      cartesInfo.push({ carte, largeurUnites: classifierTailleSouvenir(s) });
      attentesMini.push(creerMiniCarteImpression(miniMapEl, s));
    });

    await Promise.all([attenteCarte, ...attentesMini]);

    const hauteurPageDisponiblePx = hauteurUtileMm * MM_EN_PX;

    /**
     * Pose les largeurs (et le mode "étroit" pour les petites unités) sur
     * chaque carte pour une grille de nbUnites, puis mesure leurs hauteurs
     * réelles. Renvoie la largeur d'unité correspondante.
     */
    function appliquerEtMesurer(nbUnites) {
      const largeurUniteMm = (largeurUtileMm - (nbUnites - 1) * ECART_MM) / nbUnites;
      cartesInfo.forEach((info) => {
        const unites = Math.min(info.largeurUnites, nbUnites);
        const largeurMm = unites * largeurUniteMm + (unites - 1) * ECART_MM;
        info.carte.style.width = largeurMm + "mm";
        // Sur une unité étroite, la mini-carte et les photos se compactent
        // (sinon le titre n'aurait plus de place à côté de la mini-carte).
        info.carte.classList.toggle("impression-carte-etroite", largeurMm < 75);
      });
      cartesInfo.forEach((info) => { info.hauteurPx = info.carte.getBoundingClientRect().height; });
      return largeurUniteMm;
    }

    // Choix de la grille PAR LE CONTENU : on essaie plusieurs tailles de
    // grille (des unités de ~58 mm minimum pour rester lisible), on mesure
    // l'encombrement réel des souvenirs dans chacune, et on garde celle qui
    // remplit le moins de pages — à pages égales, la plus compacte, et à
    // compacité égale, les cartes les plus larges (plus confortables à lire).
    const MIN_UNITE_MM = 58;
    const maxUnites = Math.max(2, Math.floor((largeurUtileMm + ECART_MM) / (MIN_UNITE_MM + ECART_MM)));
    let meilleur = null;
    for (let u = 2; u <= maxUnites; u++) {
      const largeurUniteMm = appliquerEtMesurer(u);
      const pages = paginerSouvenirsMosaique(cartesInfo, u, hauteurPageDisponiblePx);
      const hauteurTotale = pages.reduce((somme, p) => somme + p.hauteurPx, 0);
      const score = pages.length * 1000000 + hauteurTotale / 100 + u; // pages >> compacité >> largeur
      if (!meilleur || score < meilleur.score) {
        meilleur = { nbUnites: u, largeurUniteMm, score };
      }
    }

    // Ré-applique la meilleure grille (les mesures/pages doivent correspondre
    // aux largeurs réellement posées sur les cartes).
    const { nbUnites, largeurUniteMm } = meilleur;
    appliquerEtMesurer(nbUnites);
    const pages = paginerSouvenirsMosaique(cartesInfo, nbUnites, hauteurPageDisponiblePx);

    const zoneFinale = document.getElementById("impression-souvenirs");
    pages.forEach((page) => {
      const pageEl = document.createElement("div");
      pageEl.className = "impression-page";
      pageEl.style.height = (page.hauteurPx / MM_EN_PX) + "mm";
      page.cartes.forEach((c) => {
        const gauche = c.colDepart * (largeurUniteMm + ECART_MM);
        const largeurCarte = c.largeurUnites * largeurUniteMm + (c.largeurUnites - 1) * ECART_MM;
        c.info.carte.style.left = gauche + "mm";
        c.info.carte.style.top = (c.top / MM_EN_PX) + "mm";
        c.info.carte.style.width = largeurCarte + "mm";
        pageEl.appendChild(c.info.carte);
      });
      zoneFinale.appendChild(pageEl);
    });

    document.getElementById("barre-impression").hidden = true;
    window.print();
  }

  preparer().catch((e) => {
    document.getElementById("barre-impression").hidden = true;
    document.body.insertAdjacentHTML(
      "beforeend",
      '<p style="padding:20px;font-family:sans-serif;max-width:560px;background:#fbeeea;color:#b4452f;border-radius:10px;margin:20px;">' +
      "Une erreur est survenue pendant la préparation de l'affiche : " +
      echapperHtml((e && e.message) || String(e)) +
      ". Tu peux fermer cette fenêtre et réessayer depuis l'application.</p>"
    );
  });
})();
