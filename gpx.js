/* =========================================================
   gpx.js — Lecture d'un fichier GPX
   ---------------------------------------------------------
   Un fichier GPX est un fichier texte au format XML qui décrit
   un parcours GPS. On y trouve principalement :
     - <trk>  : une "trace" (le tracé enregistré), composée de
                segments <trkseg> contenant des points <trkpt>.
     - <rte>  : un "itinéraire" planifié, fait de points <rtept>.
     - <wpt>  : des "waypoints", points isolés et nommés
                (un sommet, un parking, un refuge...).

   Cette fonction lit ce fichier et en ressort un objet simple,
   facile à utiliser dans le reste de l'application. Elle est
   tolérante : elle accepte un GPX qui n'a qu'un de ces éléments.
   ========================================================= */

/**
 * Analyse le texte d'un fichier GPX.
 * @param {string} gpxText  Le contenu brut du fichier .gpx
 * @returns {{
 *   name: string,                       // nom de la trace si présent
 *   segments: Array<Array<[number,number]>>, // liste de segments, chaque segment = liste de [lat, lng]
 *   waypoints: Array<{lat:number, lng:number, name:string}>
 * }}
 */
function parseGpx(gpxText) {
  // On transforme le texte en arbre XML manipulable.
  const parser = new DOMParser();
  const xml = parser.parseFromString(gpxText, "application/xml");

  // Si le fichier est invalide, le navigateur insère une balise <parsererror>.
  const erreur = xml.querySelector("parsererror");
  if (erreur) {
    throw new Error("Ce fichier ne semble pas être un GPX valide.");
  }

  // Petit utilitaire : transforme une liste de balises <trkpt>/<rtept>
  // en tableau de coordonnées [lat, lng], en ignorant les points invalides.
  function pointsDepuis(noeuds) {
    const points = [];
    noeuds.forEach((n) => {
      const lat = parseFloat(n.getAttribute("lat"));
      const lng = parseFloat(n.getAttribute("lon"));
      if (estCoordValide(lat, lng)) {
        points.push([lat, lng]);
      }
    });
    return points;
  }

  const segments = [];

  // 1) Les traces <trk>, segment par segment <trkseg>.
  xml.querySelectorAll("trk > trkseg").forEach((seg) => {
    const pts = pointsDepuis(Array.from(seg.querySelectorAll("trkpt")));
    if (pts.length > 0) segments.push(pts);
  });

  // 2) À défaut, les itinéraires <rte>.
  if (segments.length === 0) {
    xml.querySelectorAll("rte").forEach((rte) => {
      const pts = pointsDepuis(Array.from(rte.querySelectorAll("rtept")));
      if (pts.length > 0) segments.push(pts);
    });
  }

  // 3) Les waypoints <wpt> (points nommés isolés).
  const waypoints = [];
  xml.querySelectorAll("wpt").forEach((wpt) => {
    const lat = parseFloat(wpt.getAttribute("lat"));
    const lng = parseFloat(wpt.getAttribute("lon"));
    if (!estCoordValide(lat, lng)) return;
    const nomNoeud = wpt.querySelector("name");
    waypoints.push({
      lat,
      lng,
      name: nomNoeud ? nomNoeud.textContent.trim() : "",
    });
  });

  // 4) En dernier recours : si on n'a ni trace ni itinéraire mais des
  //    waypoints, on en fait un segment pour avoir au moins un tracé.
  if (segments.length === 0 && waypoints.length > 1) {
    segments.push(waypoints.map((w) => [w.lat, w.lng]));
  }

  // Nom de la trace : on prend le premier <name> trouvé (metadata ou trk).
  const nomNoeud =
    xml.querySelector("metadata > name") || xml.querySelector("trk > name");
  const name = nomNoeud ? nomNoeud.textContent.trim() : "Mon parcours";

  if (segments.length === 0 && waypoints.length === 0) {
    throw new Error("Aucun point GPS trouvé dans ce fichier.");
  }

  return { name, segments, waypoints };
}

/** Vérifie qu'une paire (lat, lng) est un nombre dans les bornes terrestres. */
function estCoordValide(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/**
 * Calcule la longueur totale d'une liste de segments, en kilomètres.
 * Utilise la formule de Haversine (distance entre deux points sur le globe).
 */
function longueurKm(segments) {
  const R = 6371; // rayon de la Terre en km
  const rad = (d) => (d * Math.PI) / 180;
  let total = 0;

  segments.forEach((seg) => {
    for (let i = 1; i < seg.length; i++) {
      const [lat1, lng1] = seg[i - 1];
      const [lat2, lng2] = seg[i];
      const dLat = rad(lat2 - lat1);
      const dLng = rad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
      total += 2 * R * Math.asin(Math.sqrt(a));
    }
  });

  return total;
}
