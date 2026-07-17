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
  const annotations = etatParent.annotations || []; // pictogrammes/textes libres
  const style = etatParent.style || {};
  const pictosPerso = etatParent.pictosPerso || [];
  const reglages = parent.reglagesAffiche || {
    format: "A4", orientation: "portrait", police: "systeme", couleur: "#2f3b34",
  };

  // Disposition choisie dans la fenêtre « Livre photo » : ordre des pages et
  // souvenirs décochés. La CARTE, elle, garde toutes les épingles avec leur
  // numéro d'origine — seules les pages de souvenirs suivent la disposition.
  const exclusions = Array.isArray(reglages.exclusions) ? reglages.exclusions : [];
  const ordre = Array.isArray(reglages.ordre) ? reglages.ordre : null;
  let souvenirsImprimes = souvenirs.map((s, i) => ({ s, numero: i + 1 }));
  if (ordre) {
    souvenirsImprimes.sort((a, b) => {
      const ia = ordre.indexOf(a.s.id), ib = ordre.indexOf(b.s.id);
      return (ia === -1 ? 999999 : ia) - (ib === -1 ? 999999 : ib);
    });
  }
  souvenirsImprimes = souvenirsImprimes.filter((x) => !exclusions.includes(x.s.id));

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
    medievale: { css: '"UnifrakturMaguntia", "Luminari", fantasy' },
    pirate:    { css: '"Pirata One", "Luminari", fantasy' },
  };

  // Polices importées dans l'application : on les déclare aussi ici pour
  // que l'affiche puisse les utiliser.
  (etatParent.policesPerso || []).forEach((p) => {
    try {
      const face = new FontFace("PolicePerso" + p.id, `url(${p.data})`);
      face.load().then((f) => document.fonts.add(f)).catch(() => {});
    } catch (e) { /* la police restera en repli système */ }
  });

  // Familles Google déjà demandées dans CETTE fenêtre.
  const famillesDemandees = new Set();

  /** Traduit une clé de police (catalogue du parent, importée, ou repli). */
  function cssPolice(cle) {
    try {
      if (typeof cle === "string" && cle.startsWith("fontperso:")) {
        return `"PolicePerso${cle.slice("fontperso:".length)}", sans-serif`;
      }
      const catalogue = parent.CATALOGUE_POLICES || [];
      const entree = catalogue.find((p) => p.cle === cle);
      if (entree) {
        if (entree.famille && !famillesDemandees.has(entree.famille)) {
          famillesDemandees.add(entree.famille);
          const lien = document.createElement("link");
          lien.rel = "stylesheet";
          lien.crossOrigin = "anonymous";
          lien.href = "https://fonts.googleapis.com/css2?family=" +
            encodeURIComponent(entree.famille).replace(/%20/g, "+") + "&display=swap";
          document.head.appendChild(lien);
        }
        return entree.css;
      }
    } catch (e) { /* catalogue inaccessible : repli */ }
    return (POLICES[cle] || POLICES.systeme).css;
  }
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

  // "emoji:🦄" = émoji librement choisi ; sinon clé prédéfinie (ou rien).
  function glyphDePicto(cle) {
    if (typeof cle === "string" && cle.startsWith("emoji:")) return cle.slice("emoji:".length);
    return PICTO_GLYPH[cle] || "";
  }
  const STYLE_VECTORIEL_URL = "https://tiles.openfreemap.org/styles/liberty";

  // Marge de page réduite au minimum : la carte doit occuper la feuille
  // presque bord à bord (rendu poster). Les en-têtes/pieds de page du
  // navigateur doivent être désactivés pour un résultat vraiment propre.
  const MARGE_MM = 5;
  // Petite réserve (mm) sur la hauteur des pages de SOUVENIRS uniquement,
  // pour absorber les arrondis d'impression sans déborder sur 2 pages.
  const MARGE_SECURITE_MM = 6;
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
    // L'application fabrique les épingles (avec le style choisi : forme,
    // couleur, taille, numéro) — on lui demande le même rendu pour le papier.
    try {
      if (parent.fabriquerEpingle) {
        const ep = parent.fabriquerEpingle(numero, pictoCle, pictosPerso, style.epingles);
        return L.divIcon({
          className: "",
          html: ep.html,
          iconSize: ep.iconSize,
          iconAnchor: ep.iconAnchor,
          popupAnchor: ep.popupAnchor,
        });
      }
    } catch (e) { /* repli : l'épingle classique ci-dessous */ }
    const perso = obtenirPictoPerso(pictoCle);
    const glyph = perso ? "" : glyphDePicto(pictoCle);
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
    if (sl === "waterway" || /waterway|stream|canal/.test(id)) return "riviere";
    if (/ice|glacier|snow/.test(id)) return "glacier";
    if (sl === "water" || /water|ocean|sea|lake|river|bay/.test(id)) return "eau";
    if (sl === "park" || /national_park|nature_reserve|protected|park/.test(id)) return "reserve";
    if (/wood|forest|golf|cemetery|orchard|vineyard/.test(id)) return "foret";
    if (/grass|meadow|scrub|heath|wetland|farmland|landcover|landuse/.test(id)) return "prairie";
    if (sl === "building" || /building/.test(id)) return "bati";
    if (sl === "boundary" || /boundary|admin/.test(id)) return "frontiere";
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

  // Teinte d'ambiance + arrondi des contours : mêmes filtres que dans app.js,
  // composés en une seule variable CSS posée sur la carte.
  const AMBIANCE_FILTRES = {
    naturel: "",
    ancien: "sepia(0.35) saturate(0.8) brightness(1.03)",
    doux: "saturate(0.55) brightness(1.06)",
    medieval: "sepia(0.78) saturate(0.6) contrast(1.08) brightness(1.07)",
  };

  /** Nombre de passes d'arrondi des formes (0 à 4), comme dans app.js. */
  function lireArrondi(valeur) {
    const n = Number(valeur);
    return (Number.isFinite(n) && n >= 0 && n <= 4) ? Math.round(n) : 0;
  }

  /** Les points d'une flèche : la ligne + les deux branches (comme ui.js). */
  function pointsFleche(a) {
    const k = Math.cos(((a.lat + a.lat2) / 2) * Math.PI / 180) || 1;
    const dx = (a.lng2 - a.lng) * k;
    const dy = a.lat2 - a.lat;
    const longueur = Math.hypot(dx, dy) || 1e-9;
    const ux = dx / longueur;
    const uy = dy / longueur;
    const t = longueur * 0.22;
    const branche = (angle) => {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const bx = -ux * cos + uy * sin;
      const by = -ux * sin - uy * cos;
      return [a.lat2 + t * by, a.lng2 + (t * bx) / k];
    };
    return [[a.lat, a.lng], [a.lat2, a.lng2], branche(0.45), [a.lat2, a.lng2], branche(-0.45)];
  }

  /** Calque Leaflet d'un trait / forme / dessin, identique à l'application. */
  function coucheVecteurImpression(a, carte) {
    const style = {
      color: a.couleur || "#b4452f",
      weight: a.epaisseur || 4,
      opacity: 0.9,
      interactive: false,
    };
    if (a.type === "trait" || a.type === "dessin") {
      if (!Array.isArray(a.points) || a.points.length < 2) return null;
      return L.polyline(a.points, style);
    }
    if ([a.lat, a.lng, a.lat2, a.lng2].some((v) => typeof v !== "number")) return null;
    if (a.forme === "rect") {
      return L.rectangle([[a.lat, a.lng], [a.lat2, a.lng2]], {
        ...style, fill: !!a.remplir, fillColor: style.color, fillOpacity: a.remplir ? 0.25 : 0,
      });
    }
    if (a.forme === "cercle") {
      const centre = [(a.lat + a.lat2) / 2, (a.lng + a.lng2) / 2];
      const rayon = carte.distance(centre, [centre[0], a.lng2]);
      return L.circle(centre, {
        radius: Math.max(rayon, 1),
        ...style, fill: !!a.remplir, fillColor: style.color, fillOpacity: a.remplir ? 0.25 : 0,
      });
    }
    if (a.forme === "fleche") return L.polyline(pointsFleche(a), style);
    return null;
  }

  // La carte principale, gardée accessible pour recaler ses tuiles juste
  // avant l'impression (sinon Firefox peut imprimer une vue décalée).
  let cartePrincipale = null;

  function construireCartePrincipale(largeurMm, hauteurMm) {
    document.getElementById("zone-carte").style.width = largeurMm + "mm";
    document.getElementById("zone-carte").style.height = hauteurMm + "mm";

    // Carte INTERACTIVE : l'utilisateur ajuste le cadrage (déplacement à la
    // souris, zoom précis via le champ de la barre ou la molette — zoomSnap:0
    // autorise les niveaux de zoom intermédiaires). Pas de boutons +/- ni
    // d'attribution : rien qui puisse finir sur le papier.
    const carte = L.map("map", {
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0,
      zoomDelta: 0.25,
    });
    cartePrincipale = carte;
    const attentes = [];

    if (style.fond === "vectoriel" && L.maplibreGL) {
      // Simplification des tracés (même logique que dans app.js) : on
      // plafonne le zoom des DONNÉES vectorielles pour afficher des
      // contours généralisés. Si le téléchargement du style échoue, on
      // retombe simplement sur le fond vectoriel standard.
      const ANCIENS_NIVEAUX = { aucune: 14, legere: 12, moyenne: 10, forte: 8 };
      let maxzoomSimplification = (style.vecteur && style.vecteur.simplification);
      if (typeof maxzoomSimplification === "string") {
        maxzoomSimplification = ANCIENS_NIVEAUX[maxzoomSimplification] || 14;
      }
      maxzoomSimplification = Number(maxzoomSimplification) || 14;
      const passesArrondi = lireArrondi(style.arrondi);

      // Arrondi des formes : mêmes outils que dans app.js (tuiles décodées,
      // lissées par l'algorithme de Chaikin, ré-encodées via un protocole).
      let modulesMvt = null;
      const chargerModulesMvt = async () => {
        if (modulesMvt) return modulesMvt;
        const [vt, pbf, vtpbf] = await Promise.all([
          import("https://esm.sh/@mapbox/vector-tile@1.3.1"),
          import("https://esm.sh/pbf@3.2.1"),
          import("https://esm.sh/vt-pbf@3.1.3"),
        ]);
        modulesMvt = { VectorTile: vt.VectorTile, Pbf: pbf.default || pbf, vtpbf: vtpbf.default || vtpbf };
        return modulesMvt;
      };
      const lisserChaikin = (points, passes, fermee) => {
        for (let p = 0; p < passes; p++) {
          const n = points.length;
          if (n < 3) break;
          const res = [];
          if (!fermee) res.push(points[0]);
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
      };
      const tuileArrondie = (brut, passes) => {
        const { VectorTile, Pbf, vtpbf } = modulesMvt;
        const tuile = new VectorTile(new Pbf(new Uint8Array(brut)));
        const couches = {};
        Object.keys(tuile.layers).forEach((nom) => {
          const src = tuile.layers[nom];
          couches[nom] = {
            version: src.version || 2, name: nom, extent: src.extent, length: src.length,
            feature: (i) => {
              const f = src.feature(i);
              const geometrie = f.loadGeometry().map((ligne) => {
                if (f.type === 1) return ligne;
                if (f.type === 3) {
                  const ouvert = ligne.slice(0, ligne.length - 1);
                  const lisse = lisserChaikin(ouvert, passes, true);
                  lisse.push({ x: lisse[0].x, y: lisse[0].y });
                  return lisse;
                }
                return lisserChaikin(ligne, passes, false);
              });
              return { id: f.id, type: f.type, properties: f.properties, loadGeometry: () => geometrie };
            },
          };
        });
        return vtpbf.fromVectorTileJs({ layers: couches });
      };
      if (passesArrondi > 0 && typeof maplibregl !== "undefined" && maplibregl.addProtocol) {
        maplibregl.addProtocol("lisse", async (params) => {
          const m = params.url.match(/^lisse:\/\/(\d+)\/(.+)$/);
          if (!m) throw new Error("adresse invalide");
          const reponse = await fetch("https://" + m[2]);
          if (!reponse.ok) throw new Error("tuile indisponible");
          const brut = await reponse.arrayBuffer();
          try {
            await chargerModulesMvt();
            const d = tuileArrondie(brut, Number(m[1]));
            return { data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) };
          } catch (e) {
            return { data: brut };
          }
        });
      }

      const obtenirStyleGl = async () => {
        if (maxzoomSimplification >= 14 && passesArrondi === 0) return STYLE_VECTORIEL_URL;
        try {
          const reponse = await fetch(STYLE_VECTORIEL_URL);
          const json = await reponse.json();
          for (const src of Object.values(json.sources || {})) {
            if (src.type !== "vector") continue;
            if (maxzoomSimplification < 14) src.maxzoom = Math.min(src.maxzoom || 14, maxzoomSimplification);
            if (passesArrondi > 0) {
              let tuiles = src.tiles;
              if (!tuiles && src.url) {
                const infos = await (await fetch(src.url)).json();
                tuiles = infos.tiles;
                if (!src.maxzoom && infos.maxzoom) {
                  src.maxzoom = maxzoomSimplification < 14
                    ? Math.min(infos.maxzoom, maxzoomSimplification) : infos.maxzoom;
                }
                if (infos.minzoom !== undefined) src.minzoom = infos.minzoom;
              }
              if (Array.isArray(tuiles)) {
                src.tiles = tuiles.map((u) => "lisse://" + passesArrondi + "/" + u.replace(/^https?:\/\//, ""));
                delete src.url;
              }
            }
          }
          return json;
        } catch (e) {
          return STYLE_VECTORIEL_URL;
        }
      };

      // Toute cette partie (couleurs des zones, préréglage "ancienne") est du
      // pur embellissement : si elle échoue pour une raison quelconque, la
      // carte doit quand même s'imprimer avec le fond vectoriel standard,
      // plutôt que de faire échouer TOUTE l'affiche (souvenirs compris).
      attentes.push(obtenirStyleGl().then((styleGl) => {
        const coucheGl = L.maplibreGL({
          pane: "tilePane",
          style: styleGl,
          attribution:
            '© <a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ' +
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          // Sans ça, le tampon WebGL est effacé juste après chaque image
          // affichée : le fond disparaîtrait à l'impression.
          preserveDrawingBuffer: true,
        }).addTo(carte);

        return new Promise((resolve) => {
        let fini = false;
        const terminer = () => { if (!fini) { fini = true; resolve(); } };
        // Avec l'arrondi des formes, les tuiles mettent plus de temps :
        // on laisse jusqu'à 20 s avant d'abandonner la mise en beauté.
        setTimeout(terminer, 20000);

        try {
          const appliquerStyleVecteur = (glMap) => {
            try {
              const zones = (style.vecteur && style.vecteur.zones) || {};
              Object.keys(zones).forEach((cat) => {
                const couleur = zones[cat];
                if (!couleur) return;
                // Catégorie spéciale "noms" : couleur du texte des lieux.
                if (cat === "noms") {
                  glMap.getStyle().layers.forEach((c) => {
                    if (c.type !== "symbol") return;
                    try { glMap.setPaintProperty(c.id, "text-color", couleur); } catch (e) {}
                  });
                  return;
                }
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
              // Niveau de détail "épuré" : masque petites routes, bâtiments, POI.
              if (style.vecteur && style.vecteur.detail === "epure") {
                glMap.getStyle().layers.forEach((l) => {
                  if (masquerDetail(l)) { try { glMap.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {} }
                });
              }
              // Préréglages médiévaux (carte ancienne, parchemins, pirate) :
              // grosse maille + noms de lieux stylisés + grain de parchemin,
              // aux couleurs propres au préréglage choisi (mêmes valeurs
              // que PRESETS_FOND dans app.js).
              const PRESETS_IMPRESSION = {
                ancienne: { noms: "#5a4632", halo: "#e9e0c4", teinte: "ancienne" },
                clair:    { noms: "#6b5233", halo: "#f4ecd6", teinte: "claire" },
                sombre:   { noms: "#4a3620", halo: "#d8c49a", teinte: "sombre" },
                pirate:   { noms: "#5a3a22", halo: "#e7d7b1", teinte: "pirate" },
              };
              const preset = style.vecteur && PRESETS_IMPRESSION[style.vecteur.preset];
              if (preset) {
                glMap.getStyle().layers.forEach((l) => {
                  if (masquerDetail(l)) { try { glMap.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {} }
                });
                glMap.getStyle().layers.forEach((l) => {
                  if (l.type !== "symbol" || !(l.layout && l.layout["text-field"])) return;
                  try { if (glMap.getLayoutProperty(l.id, "visibility") === "none") return; } catch (e) {}
                  try { glMap.setLayoutProperty(l.id, "text-font", ["Noto Sans Italic"]); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-color", preset.noms); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-halo-color", preset.halo); } catch (e) {}
                  try { glMap.setPaintProperty(l.id, "text-halo-width", 1.4); } catch (e) {}
                });
                document.getElementById("map").classList.add("vecteur-ancienne");
                document.getElementById("parchemin").classList.add("teinte-" + preset.teinte);
              }
              // Couches décochées dans l'application (noms, frontières…).
              const couchesMasquees = (style.vecteur && style.vecteur.couches) || {};
              glMap.getStyle().layers.forEach((l) => {
                let cat = classeZone(l);
                if (l.type === "symbol") cat = "noms";
                if (!cat || couchesMasquees[cat] !== false) return;
                try { glMap.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {}
              });
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
            if (!glMap) return;
            // isStyleLoaded() peut rester faux longtemps (tuiles en cours,
            // surtout avec l'arrondi) : il suffit que la LISTE des couches
            // soit disponible pour pouvoir repeindre les couleurs.
            let pret = false;
            try {
              const st = glMap.getStyle();
              pret = !!(st && st.layers && st.layers.length > 0);
            } catch (e) { pret = false; }
            if (!pret) return;
            appliquee = true;
            clearInterval(sondage);
            appliquerStyleVecteur(glMap);
          };
          const sondage = setInterval(tenter, 200);
          tenter();
        } catch (e) {
          terminer();
        }
        });
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

    // Ambiance : classe (pour le parchemin) + teinte posée en variable CSS.
    // (L'arrondi des formes est géré en amont, dans les tuiles vectorielles.)
    const mapEl = document.getElementById("map");
    mapEl.classList.add("ambiance-" + (style.ambiance || "naturel"));
    const fa = AMBIANCE_FILTRES[style.ambiance] || "";
    mapEl.style.setProperty("--filtre-fond", fa || "none");

    // Décor choisi dans l'application : on recopie tel quel la bordure et la
    // rose des vents affichées dans la fenêtre principale (même variante,
    // même image importée), en lisant leur rendu chez window.opener.
    try {
      if (style.decor && style.decor.bordure) {
        const source = parent.document.getElementById("bordure-carte");
        const cible = document.getElementById("bordure-carte");
        cible.className = source.className;
        cible.style.borderImageSource = source.style.borderImageSource;
        cible.hidden = false;
      }
      if (style.decor && style.decor.rose) {
        const roseSource = parent.document.getElementById("rose-carte");
        const roseCible = document.getElementById("rose-vents");
        if (roseSource && roseSource.innerHTML.trim()) roseCible.innerHTML = roseSource.innerHTML;
        roseCible.hidden = false;
      }
    } catch (e) { /* décor inaccessibles : l'affiche reste imprimable */ }

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

    // Éléments posés librement sur le fond de carte : pictogrammes, textes,
    // photos, traits, formes et dessins (même rendu que dans l'application).
    const ALIGN_CSS = { gauche: "left", centre: "center", droite: "right" };
    annotations.forEach((a) => {
      // Traits, formes et dessins : des calques dessinés.
      if (a.type === "trait" || a.type === "dessin" || a.type === "forme") {
        const calque = coucheVecteurImpression(a, carte);
        if (calque) {
          calque.addTo(carte);
          if (Array.isArray(a.points)) a.points.forEach((p) => points.push(p));
          else if (typeof a.lat === "number") {
            points.push([a.lat, a.lng]);
            points.push([a.lat2, a.lng2]);
          }
        }
        return;
      }
      if (typeof a.lat !== "number" || typeof a.lng !== "number") return;
      let contenu;
      if (a.type === "picto") {
        const perso = obtenirPictoPerso(a.picto);
        contenu = perso
          ? `<img class="annot-picto-img" src="${perso.src}" style="height:${a.taille}px" alt="">`
          : `<span class="annot-picto" style="font-size:${a.taille}px">${glyphDePicto(a.picto) || "⛰️"}</span>`;
      } else if (a.type === "image") {
        // Photo posée sur la carte (façon polaroid, avec sa légende).
        if (typeof a.src !== "string" || !a.src) return;
        const legende = a.legende
          ? `<figcaption>${echapperHtml(a.legende)}</figcaption>` : "";
        contenu = `<figure class="annot-image" style="width:${a.taille || 170}px">` +
          `<img src="${a.src}" alt="">${legende}</figure>`;
      } else {
        const deco = [a.souligne ? "underline" : "", a.barre ? "line-through" : ""]
          .filter(Boolean).join(" ") || "none";
        const css = [
          `font-family:${cssPolice(a.police)}`,
          `color:${a.couleur}`,
          `font-size:${a.taille}px`,
          `text-align:${ALIGN_CSS[a.align] || "center"}`,
          `font-weight:${a.gras ? "800" : "400"}`,
          `font-style:${a.italique ? "italic" : "normal"}`,
          `text-decoration:${deco}`,
        ].join(";");
        const html = echapperHtml(a.texte || "").replace(/\n/g, "<br>");
        // Les noms de polices contiennent des guillemets : on les échappe.
        contenu = `<div class="annot-texte" style="${css.replace(/"/g, "&quot;")}">${html}</div>`;
      }
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="annot-wrap">${contenu}</div>`,
          iconSize: [0, 0],
        }),
        interactive: false,
      }).addTo(carte);
      points.push([a.lat, a.lng]);
    });

    carte.invalidateSize();
    if (points.length) carte.fitBounds(points, { padding: [20, 20], animate: false });

    const titre = (style.titre || "").trim();
    if (titre) {
      const titreEl = document.getElementById("carte-titre");
      titreEl.textContent = titre;
      titreEl.style.fontFamily = cssPolice(style.titrePolice || "titre");
      // Même habillage du cartouche que dans l'application (classes CSS partagées).
      const fondsTitre = ["classique", "parchemin", "pirate", "sombre"];
      const fondTitre = fondsTitre.includes(style.titreFond) ? style.titreFond : "classique";
      titreEl.className = "carte-titre" + (fondTitre === "classique" ? "" : " titre-" + fondTitre);
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

    document.documentElement.style.setProperty("--impression-police", cssPolice(reglages.police));
    document.documentElement.style.setProperty("--impression-couleur-texte", reglages.couleur || "#2f3b34");

    const largeurUtileMm = largeur - MARGE_MM * 2;
    // La carte occupe TOUTE la hauteur imprimable (rendu poster, sans bande) ;
    // seules les pages de souvenirs gardent une petite réserve de sécurité.
    const hauteurPageMm = hauteur - MARGE_MM * 2;
    const hauteurUtileMm = hauteurPageMm - MARGE_SECURITE_MM;

    const attenteCarte = construireCartePrincipale(largeurUtileMm, hauteurPageMm);

    // Sans souvenir, pas de section "Souvenirs du voyage" : la carte seule
    // (et pas de saut de page après elle, qui laisserait une feuille blanche).
    if (souvenirsImprimes.length === 0) {
      document.getElementById("impression").hidden = true;
      const zoneCarte = document.getElementById("zone-carte");
      zoneCarte.style.breakAfter = "auto";
      zoneCarte.style.pageBreakAfter = "auto";
    }

    const zoneMesure = document.getElementById("impression-mesure");
    const cartesInfo = [];
    const attentesMini = [];
    souvenirsImprimes.forEach(({ s, numero }) => {
      const { carte, miniMapEl } = construireCarteImpression(s, numero);
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

    // Crédit discret POSÉ SUR LA CARTE, en bas : la licence OpenStreetMap
    // demande de créditer les données, même sur un poster.
    const credit = document.createElement("p");
    credit.className = "impression-credit";
    credit.textContent = "Fond de carte © OpenStreetMap";
    document.getElementById("zone-carte").appendChild(credit);

    // Tout est prêt : l'utilisateur ajuste le cadrage (déplacement à la
    // souris, zoom précis en %, rotation en degrés) puis lance lui-même
    // l'impression. On recale les tuiles juste avant, pour que le papier
    // corresponde exactement à l'écran.
    document.getElementById("barre-texte").textContent = "Cadrage :";
    document.getElementById("barre-reglages").hidden = false;

    const champZoom = document.getElementById("champ-zoom");
    const champRotation = document.getElementById("champ-rotation");
    const rose = document.getElementById("rose-vents");

    // Le zoom au moment du cadrage automatique initial vaut 100 %.
    const zoomReference = cartePrincipale.getZoom();

    champZoom.addEventListener("change", () => {
      const pct = parseFloat(String(champZoom.value).replace(",", "."));
      if (!isFinite(pct) || pct <= 0) return;
      // 100 % = zoom initial ; doubler le pourcentage double l'échelle.
      cartePrincipale.setZoom(zoomReference + Math.log2(pct / 100), { animate: false });
    });
    // La molette et le champ restent synchronisés (au centième de %).
    cartePrincipale.on("zoomend", () => {
      champZoom.value = (Math.pow(2, cartePrincipale.getZoom() - zoomReference) * 100).toFixed(2);
    });

    function appliquerRotation() {
      const deg = parseFloat(String(champRotation.value).replace(",", ".")) || 0;
      const mapEl = document.getElementById("map");
      const centre = cartePrincipale.getCenter();
      const zoom = cartePrincipale.getZoom();

      if (deg === 0) {
        mapEl.style.width = "";
        mapEl.style.height = "";
        mapEl.style.marginLeft = "";
        mapEl.style.marginTop = "";
        mapEl.style.transform = "";
        mapEl.style.setProperty("--contre-rotation", "0deg");
        // La rose reste affichée si le décor l'a demandée dans l'application.
        rose.hidden = !(style.decor && style.decor.rose);
        rose.style.transform = "";
      } else {
        // Pour tourner sans coins vides : la carte devient un carré plus
        // grand que la page (sa diagonale), centré puis tourné — la page
        // (overflow hidden) n'en montre que la découpe.
        const diagMm = Math.ceil(Math.hypot(largeurUtileMm, hauteurPageMm));
        mapEl.style.width = diagMm + "mm";
        mapEl.style.height = diagMm + "mm";
        mapEl.style.marginLeft = ((largeurUtileMm - diagMm) / 2) + "mm";
        mapEl.style.marginTop = ((hauteurPageMm - diagMm) / 2) + "mm";
        mapEl.style.transform = "rotate(" + deg + "deg)";
        // Les épingles restent droites (contre-rotation autour de leur pointe).
        mapEl.style.setProperty("--contre-rotation", (-deg) + "deg");
        // La rose des vents tourne avec la carte : elle pointe le nord réel.
        rose.hidden = false;
        rose.style.transform = "rotate(" + deg + "deg)";
      }
      cartePrincipale.invalidateSize({ animate: false });
      cartePrincipale.setView(centre, zoom, { animate: false });
    }
    champRotation.addEventListener("change", appliquerRotation);

    const btn = document.getElementById("btn-imprimer");
    btn.hidden = false;
    btn.addEventListener("click", () => {
      if (cartePrincipale) cartePrincipale.invalidateSize();
      setTimeout(() => window.print(), 250);
    });
    window.addEventListener("beforeprint", () => {
      if (cartePrincipale) cartePrincipale.invalidateSize();
    });

    // --- Enregistrer la page carte en image PNG (au lieu d'un PDF) ---
    // On utilise dom-to-image-more (fidèle avec Leaflet/MapLibre), et le
    // canvas WebGL du fond vectoriel est d'abord figé en image.
    const btnImage = document.getElementById("btn-image");
    btnImage.hidden = false;
    btnImage.addEventListener("click", async () => {
      btnImage.disabled = true;
      btnImage.textContent = "⏳ Capture…";
      const zone = document.getElementById("zone-carte");
      let liberer = () => {};
      try {
        if (!window.domtoimage) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://unpkg.com/dom-to-image-more@3.5.0/dist/dom-to-image-more.min.js";
            s.onload = resolve;
            s.onerror = () => reject(new Error("bibliothèque indisponible"));
            document.head.appendChild(s);
          });
        }
        // La composition couche par couche vit dans l'application principale
        // (fond, trace, épingles, décor) : on la réutilise sur NOTRE page.
        const canvas = await parent.composerImageCarte(zone, 2, window.domtoimage);
        const dataUrl = canvas.toDataURL("image/png");
        liberer();
        const lien = document.createElement("a");
        let nomCarnet = "carte";
        try {
          const c = (etatParent.carnets || []).find((x) => x.id === etatParent.carnetActifId);
          nomCarnet = (c && c.nom) || trace.name || "carte";
        } catch (e) {}
        lien.download = "affiche-" + nomCarnet.replace(/[^\w\-]+/g, "_") + ".png";
        lien.href = dataUrl;
        lien.click();
        btnImage.textContent = "✓ Image enregistrée";
        setTimeout(() => { btnImage.textContent = "🖼️ Image PNG"; btnImage.disabled = false; }, 2500);
      } catch (e) {
        liberer();
        btnImage.textContent = "🖼️ Image PNG";
        btnImage.disabled = false;
        alert("Capture impossible ici. Utilise plutôt 🖨️ Imprimer (choisis « Enregistrer en PDF »).");
      }
    });
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
