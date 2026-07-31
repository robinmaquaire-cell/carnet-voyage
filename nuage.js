/* =========================================================
   nuage.js — Compte et sauvegarde en ligne (Supabase)
   ---------------------------------------------------------
   - Connexion SANS mot de passe : on reçoit un « lien magique »
     par e-mail ; le compte se crée tout seul à la première fois.
   - « Rester connecté » : la session est mémorisée sur l'appareil
     (on ne se reconnecte pas à chaque visite). Si la case est
     décochée, la session est oubliée à la fermeture du navigateur.
   - Chaque carnet est sauvegardé en ligne : une ligne (fiche) dans
     la table `carnets` + son contenu complet en JSON dans le
     stockage. La version la plus récente gagne, dans les deux sens.
   - Partage : la table `carnet_partages` liste qui peut voir ou
     modifier un carnet ; les carnets partagés avec moi apparaissent
     sur ma carte globale (lecture seule ou édition selon le droit).
   ========================================================= */

let sbClient = null;        // le client Supabase (null si non configuré)
let sessionNuage = null;    // la session de l'utilisateur connecté (ou null)
let syncEnCours = false;
let droitsPartages = new Map(); // carnet_uuid → "lecture" | "edition" (partagés avec moi)
// Mon profil public (pseudo, photo, description, est_public) une fois chargé
// depuis la table `profils`. Reste null tant que je ne suis pas connecté ou
// que je n'ai pas encore choisi de pseudo.
let monProfil = null;

const CLE_EPHEMERE = "nuage-ephemere";      // "1" = ne pas rester connecté
const CLE_SESSION_VUE = "nuage-session-vue"; // marqueur de session d'onglet
const CLE_PSEUDO = "carnet-pseudo";
// Marqueur : « cet appareil a déjà été connecté à un compte ». Sert à masquer
// les carnets locaux au chargement quand aucune session n'est retrouvée
// (le compte est censé être la source de vérité). Un utilisateur qui n'a
// jamais créé de compte n'a jamais ce marqueur → ses carnets locaux restent
// visibles hors ligne.
const CLE_ETAIT_CONNECTE = "nuage-etait-connecte";

// Format d'un pseudo valide (identique à la contrainte SQL) : 3-30 caractères
// pris parmi lettres, chiffres, tiret et tiret-bas.
const PSEUDO_MOTIF = /^[A-Za-z0-9_-]{3,30}$/;

/** Le nuage est-il configuré (clés présentes) ? */
function nuageConfigure() {
  const c = window.CONFIG_NUAGE || {};
  return !!(c.url && c.cle && window.supabase);
}

/** Est-on connecté à un compte ? */
function nuageConnecte() {
  return !!(sbClient && sessionNuage && sessionNuage.user);
}

/**
 * Pseudo de l'utilisateur. Priorité :
 *   1. le profil public (table `profils`) si connecté et déjà choisi ;
 *   2. l'ancien pseudo enregistré dans `user_metadata` (rétrocompat) ;
 *   3. celui noté sur l'appareil (hors ligne).
 */
function lirePseudo() {
  if (monProfil && monProfil.pseudo) return monProfil.pseudo;
  if (nuageConnecte()) {
    const p = sessionNuage.user.user_metadata && sessionNuage.user.user_metadata.pseudo;
    if (p) return p;
  }
  try { return localStorage.getItem(CLE_PSEUDO) || ""; } catch (e) { return ""; }
}

/**
 * Enregistre le pseudo local (utilisé hors ligne pour signer les cartes du
 * monde). Le vrai pseudo public passe par enregistrerMonProfil().
 */
async function enregistrerPseudo(pseudo) {
  pseudo = (pseudo || "").trim().slice(0, 30);
  try { localStorage.setItem(CLE_PSEUDO, pseudo); } catch (e) {}
  if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();
}

/* =========================================================
   Profil public (jalon A — table `profils`)
   ========================================================= */

/**
 * Nettoie un pseudo pour tenter de le rendre valide sans intervention :
 * enlève espaces et accents, garde uniquement [A-Za-z0-9_-], tronque à 30.
 * Utile pour la MIGRATION du pseudo actuel de l'utilisateur (stocké dans
 * user_metadata sans contrainte de format) vers le nouveau format public.
 */
function nettoyerPseudo(brut) {
  if (typeof brut !== "string") return "";
  const sansAccents = brut.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const nettoye = sansAccents.replace(/[^A-Za-z0-9_-]/g, "");
  return nettoye.slice(0, 30);
}

/** Charge mon profil depuis la table `profils` (ou null s'il n'existe pas). */
async function chargerMonProfil() {
  if (!nuageConnecte()) { monProfil = null; return null; }
  const essayer = async (colonnes) => {
    return sbClient.from("profils")
      .select(colonnes)
      .eq("id", sessionNuage.user.id)
      .maybeSingle();
  };
  try {
    // La colonne `ville` a été ajoutée après coup (voir supabase-setup-7-ville.sql).
    // Si le SQL n'a pas encore été joué, on retente sans `ville` pour ne rien casser.
    let res = await essayer("id, pseudo, photo, description, ville, est_public");
    if (res.error && /column .*ville/i.test(res.error.message || "")) {
      res = await essayer("id, pseudo, photo, description, est_public");
    }
    if (res.error && res.error.code !== "PGRST116") throw res.error;
    monProfil = res.data || null;
    return monProfil;
  } catch (e) {
    // Table absente (SQL pas encore joué) : on n'a pas de profil, on continue
    // comme avant. La modal ne s'ouvrira pas.
    monProfil = null;
    return null;
  }
}

/**
 * Crée ou met à jour mon profil. Renvoie { ok:true, profil } ou
 * { ok:false, raison } — la raison est un message français court prêt à
 * afficher à l'utilisateur.
 */
async function enregistrerMonProfil(champs) {
  if (!nuageConnecte()) return { ok: false, raison: "Connecte-toi d'abord." };
  // Le pseudo peut être omis quand on met à jour photo / description / ville :
  // on garde alors celui déjà enregistré.
  const pseudo = (champs.pseudo != null ? champs.pseudo
                  : (monProfil && monProfil.pseudo) || "").trim();
  if (!PSEUDO_MOTIF.test(pseudo)) {
    return { ok: false, raison: "Il faut d'abord choisir un pseudo." };
  }
  const val = (champ, defaut) => champs[champ] != null ? champs[champ]
    : (monProfil && monProfil[champ]) || defaut;
  const ligne = {
    id: sessionNuage.user.id,
    pseudo,
    photo: val("photo", ""),
    description: val("description", ""),
    ville: val("ville", ""),
    est_public: champs.est_public != null ? !!champs.est_public
      : (monProfil ? !!monProfil.est_public : false),
  };
  // Tente d'abord avec `ville` ; si la colonne n'existe pas encore (SQL 7 non
  // joué), on retente sans, pour ne pas bloquer l'utilisateur.
  let res = await sbClient.from("profils").upsert(ligne).select().maybeSingle();
  if (res.error && /column .*ville/i.test(res.error.message || "")) {
    const sansVille = { ...ligne }; delete sansVille.ville;
    res = await sbClient.from("profils").upsert(sansVille).select().maybeSingle();
  }
  const { data, error } = res;
  if (error) {
    if (error.code === "23505") {
      return { ok: false, raison: `Le pseudo « ${pseudo} » est déjà pris — essaie une variante.` };
    }
    if (/pseudo_valide/.test(error.message || "")) {
      return { ok: false, raison: "Ce pseudo n'a pas le bon format." };
    }
    return { ok: false, raison: (error.message || "Impossible d'enregistrer le profil.") };
  }
  monProfil = data;
  try { localStorage.setItem(CLE_PSEUDO, pseudo); } catch (e) {}
  if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();
  majCompteUI();
  return { ok: true, profil: data };
}

/**
 * Au retour du lien magique (et à la reprise d'une session existante), on
 * charge le profil. S'il n'y en a pas encore, on invite l'utilisateur à en
 * choisir un, en pré-remplissant avec son ancien pseudo user_metadata
 * (nettoyé au format) pour que la migration soit un simple clic.
 */
async function assurerProfil() {
  await chargerMonProfil();
  if (monProfil) return;
  const ancien = (sessionNuage.user.user_metadata && sessionNuage.user.user_metadata.pseudo) ||
                 (function () { try { return localStorage.getItem(CLE_PSEUDO); } catch (e) { return ""; } })();
  ouvrirModalProfil(nettoyerPseudo(ancien));
}

/** Point d'entrée : appelé par demarrerUI() une fois les carnets chargés. */
function demarrerNuage() {
  brancherCompteUI();
  if (!nuageConfigure()) {
    majCompteUI();
    if (typeof majPopupsAccueil === "function") majPopupsAccueil();
    return;
  }
  sbClient = window.supabase.createClient(window.CONFIG_NUAGE.url, window.CONFIG_NUAGE.cle);

  // « Rester connecté » décoché la dernière fois + navigateur rouvert
  // depuis → on oublie la session.
  let ephemere = false, sessionVue = false;
  try {
    ephemere = localStorage.getItem(CLE_EPHEMERE) === "1";
    sessionVue = sessionStorage.getItem(CLE_SESSION_VUE) === "1";
  } catch (e) {}
  if (ephemere && !sessionVue) {
    sbClient.auth.signOut().catch(() => {});
  }

  sbClient.auth.onAuthStateChange((evenement, session) => {
    sessionNuage = session;
    try {
      if (session) {
        sessionStorage.setItem(CLE_SESSION_VUE, "1");
        // Ce navigateur a désormais un compte connu : on s'en souvient pour
        // masquer les carnets locaux à la prochaine ouverture sans session.
        localStorage.setItem(CLE_ETAIT_CONNECTE, "1");
      }
    } catch (e) {}
    majCompteUI();
    majEtatSyncUI();
    if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();

    if (evenement === "SIGNED_IN" && session) {
      // Retour du lien magique : on ferme la fenêtre Compte et on synchronise.
      fermerModalCompte();
      toast("☁️ Connecté ! Synchronisation de tes carnets…");
      assurerProfil();
      synchroniserNuage();
    } else if (evenement === "INITIAL_SESSION") {
      if (session) { assurerProfil(); synchroniserNuage(); }
      else {
        // Pas de session au démarrage. Si on avait déjà été connecté depuis
        // ce navigateur, on cache les carnets locaux : le compte est la
        // source de vérité, il faut se reconnecter pour les revoir.
        let dejaConnecte = false;
        try { dejaConnecte = localStorage.getItem(CLE_ETAIT_CONNECTE) === "1"; } catch (e) {}
        if (dejaConnecte) viderCarnetsDeVue();
        else if (typeof majPopupsAccueil === "function") majPopupsAccueil();
      }
    } else if (evenement === "SIGNED_OUT") {
      monProfil = null;
      viderCarnetsDeVue();
    }
  });
}

/* =========================================================
   Synchronisation
   ========================================================= */

/**
 * Filet de sécurité : avant qu'une synchro remplace ou efface le contenu
 * local d'un carnet (parce que le nuage semble plus récent), on garde une
 * copie de secours (un seul niveau, écrasé à chaque fois) sous une clé
 * séparée. Si la comparaison de dates s'est trompée, rien n'est perdu
 * définitivement — récupérable via dbChargerCle("carnet-<id>-secours").
 */
async function sauvegarderCopieSecours(id) {
  try {
    const ancien = await dbChargerCle("carnet-" + id);
    if (ancien) await dbSauverCle("carnet-" + id + "-secours", ancien);
  } catch (e) {}
}

/** Le propriétaire d'un carnet (moi, ou l'ami qui l'a partagé avec moi). */
function proprietaireNuage(c) {
  return (c.partage && c.partage.proprietaire) || sessionNuage.user.id;
}

/** Chemin du fichier JSON d'un carnet (dans le dossier de son propriétaire). */
function cheminNuage(c) {
  return `${proprietaireNuage(c)}/${c.uuid}.json`;
}

/** Chemin d'un média (photo/son) dans le dossier du propriétaire du carnet. */
function cheminMedia(c, empreinte) {
  return `${proprietaireNuage(c)}/medias/${empreinte}`;
}

// Empreintes des médias déjà présents en ligne pendant CETTE session : évite
// de re-téléverser une photo qu'on vient d'envoyer (dédoublonnage).
const empreintesEnLigne = new Set();

/** Téléverse un média (une seule fois) sous son empreinte. */
async function televerserMedia(c, empreinte, media) {
  if (empreintesEnLigne.has(empreinte)) return;
  const blob = new Blob([media.octets], { type: media.type });
  // upsert:false → si le fichier existe déjà (même contenu = même nom), l'appel
  // échoue avec « déjà présent » : c'est le comportement voulu, on ne renvoie
  // pas les octets pour rien.
  const { error } = await sbClient.storage.from("carnets")
    .upload(cheminMedia(c, empreinte), blob, { upsert: false, contentType: media.type });
  if (error && !/exist|duplicate|resource already/i.test(error.message || "")) throw error;
  empreintesEnLigne.add(empreinte);
}

/** Télécharge les octets d'un média du carnet (ou null s'il est absent). */
async function telechargerMediaNuage(c, empreinte) {
  const { data, error } = await sbClient.storage.from("carnets").download(cheminMedia(c, empreinte));
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Télécharge le fichier d'un carnet. Renvoie le JSON BRUT : les photos/sons y
 * sont encore sous forme de renvois « #media:… » (léger, suffisant pour
 * compter les souvenirs et comparer les versions). Pour l'enregistrer sur
 * l'appareil, il faut d'abord résoudre les médias (voir telechargerCarnetResolu).
 */
async function telechargerCarnetNuage(c) {
  const { data, error } = await sbClient.storage.from("carnets").download(cheminNuage(c));
  if (error) throw error;
  return JSON.parse(await data.text());
}

/** Télécharge un carnet ET rétablit ses photos/sons (prêt à stocker localement). */
async function telechargerCarnetResolu(c) {
  const donnees = await telechargerCarnetNuage(c);
  if (typeof resoudreMediasNuage !== "function") return donnees; // module médias absent
  return resoudreMediasNuage(donnees, (empreinte) => telechargerMediaNuage(c, empreinte));
}

/** Peut-on écrire ce carnet en ligne ? (le mien, ou partagé en édition) */
function peutEcrireNuage(c) {
  return !c.partage || c.partage.droit === "edition";
}

/* ---------- État de synchronisation d'un carnet ---------- */

/** Petit raccourci : une date ISO en nombre comparable (0 si vide/illisible). */
function tempsDe(dateIso) {
  return Date.parse(dateIso || 0) || 0;
}

/**
 * Ce carnet a-t-il des modifications pas encore envoyées en ligne ?
 * (Faux si on n'est pas connecté : sans compte, la question n'a pas de sens.)
 */
function carnetEnAttenteNuage(c) {
  if (!c || !nuageConnecte() || !peutEcrireNuage(c)) return false;
  return tempsDe(c.modifieLe) > tempsDe(c.syncLe);
}

/** Combien de carnets attendent d'être envoyés en ligne ? */
function nbCarnetsEnAttente() {
  if (!nuageConnecte()) return 0;
  return etat.carnets.filter((c) => c.statut !== "archive" && carnetEnAttenteNuage(c)).length;
}

/**
 * Note qu'un carnet est désormais identique à la version en ligne. On aligne
 * `syncLe` sur `modifieLe` : tant que le carnet n'est pas retouché, il compte
 * comme « à jour en ligne ».
 */
function marquerCarnetSynchronise(c, horodatage) {
  if (!c) return;
  c.syncLe = horodatage || c.modifieLe || new Date().toISOString();
}

/** Envoie un carnet en ligne (contenu + fiche pour la liste). */
async function pousserCarnet(c) {
  if (!nuageConnecte() || !c || !c.uuid || !peutEcrireNuage(c)) return;

  // L'horodatage exact qu'on met en ligne. On le fige AVANT l'envoi pour
  // pouvoir marquer le carnet « à jour » avec la même valeur ensuite.
  const horodatage = c.modifieLe || new Date().toISOString();

  // Le contenu complet : celui en mémoire pour le carnet ouvert, sinon la
  // sauvegarde locale. Un carnet encore vide n'a pas de fichier à envoyer.
  const donnees = c.id === etat.carnetActifId
    ? serialiserCarnet()
    : await dbChargerCle("carnet-" + c.id).catch(() => null);
  if (carnetADuContenu(donnees)) {
    // Les photos/sons partent d'abord, comme fichiers séparés ; le fichier du
    // carnet ne garde que de petits renvois vers eux. C'est ce qui empêche le
    // carnet de dépasser la taille maximale du stockage en ligne.
    let aEnvoyer = donnees;
    if (typeof extraireMediasPourNuage === "function") {
      const { allege, medias } = await extraireMediasPourNuage(donnees);
      for (const [empreinte, media] of medias) {
        await televerserMedia(c, empreinte, media);
      }
      aEnvoyer = allege;
    }
    const blob = new Blob([JSON.stringify(aEnvoyer)], { type: "application/json" });
    const { error } = await sbClient.storage.from("carnets")
      .upload(cheminNuage(c), blob, { upsert: true, contentType: "application/json" });
    if (error) throw error;
  }

  const fiche = {
    nom: c.nom,
    logo: c.logo || "",
    categorie: c.categorie || "",
    description: c.description || "",
    du: c.du || "",
    au: c.au || "",
    modifie_le: horodatage,
    // Zone de cadrage + format d'impression : suivent le carnet d'un appareil
    // à l'autre (nécessite les colonnes ajoutées par supabase-setup-3-zone.sql).
    zone: (typeof normaliserZone === "function" ? normaliserZone(c.zone) : (c.zone || null)),
    format_zone: c.formatZone || "",
    orientation_zone: c.orientationZone === "paysage" ? "paysage" : "portrait",
    // Statut synchronise : 'actif' ou 'archive'. ('supprime' = pierre tombale,
    // ecrite seulement par supprimerCarnetNuage.)
    statut: c.statut === "archive" ? "archive" : "actif",
  };
  if (c.partage) {
    // Carnet partagé en édition : on met à jour la fiche du propriétaire, MAIS
    // pas le statut (archiver de mon côté ne doit pas archiver chez lui).
    const { statut, ...ficheSansStatut } = fiche;
    await ecrireFiche(ficheSansStatut, (donnees) =>
      sbClient.from("carnets").update(donnees)
        .eq("uuid", c.uuid).eq("user_id", c.partage.proprietaire));
  } else {
    await ecrireFiche({ user_id: sessionNuage.user.id, uuid: c.uuid, ...fiche },
      (donnees) => sbClient.from("carnets").upsert(donnees));
  }

  // Envoi réussi : cette version est maintenant celle qui est en ligne.
  c.modifieLe = horodatage;
  marquerCarnetSynchronise(c, horodatage);
}

/* ---------- Résistance aux colonnes manquantes ---------- */
// Chaque nouveauté (zone, format, statut…) ajoute une colonne à la table
// `carnets`, via un script .sql à coller dans Supabase. Si ce script n'a pas
// encore été joué, l'ancienne version du code plantait sur CHAQUE envoi et la
// synchronisation entière échouait sans dire pourquoi. Désormais on retire la
// colonne inconnue et on réessaie : la synchro fonctionne quand même (sans
// cette information-là), et on le signale une fois à l'utilisateur.

const colonnesAbsentes = new Set();

/** Nom de la colonne inconnue mentionnée par une erreur Supabase, ou null. */
function colonneManquante(error) {
  const m = (error && error.message) || "";
  const trouve = m.match(/'([a-z_]+)' column/i) || m.match(/column "?([a-z_]+)"? .* does not exist/i);
  return trouve ? trouve[1] : null;
}

/** Écrit la fiche, en retirant au besoin les colonnes que la base ignore. */
async function ecrireFiche(fiche, envoyer) {
  const donnees = { ...fiche };
  // On enlève d'emblée celles déjà repérées comme absentes.
  colonnesAbsentes.forEach((col) => { delete donnees[col]; });
  for (let essai = 0; essai < 6; essai++) {
    const { error } = await envoyer(donnees);
    if (!error) return;
    const col = colonneManquante(error);
    if (!col || !(col in donnees)) throw error;
    colonnesAbsentes.add(col);
    delete donnees[col];
  }
  throw new Error("Trop de colonnes manquantes dans la table des carnets.");
}

/** Message à afficher si la base en ligne n'est pas à jour (ou "" si tout va bien). */
function messageColonnesAbsentes() {
  if (!colonnesAbsentes.size) return "";
  const scripts = new Set();
  colonnesAbsentes.forEach((col) => {
    if (["zone", "format_zone", "orientation_zone"].includes(col)) scripts.add("supabase-setup-3-zone.sql");
    if (col === "statut") scripts.add("supabase-setup-4-statut.sql");
  });
  return "Ta base en ligne n'a pas encore tout : la synchronisation marche, mais " +
    `« ${[...colonnesAbsentes].join(", ")} » ne suit pas d'un appareil à l'autre. ` +
    (scripts.size ? `Colle ${[...scripts].join(" puis ")} dans Supabase pour compléter.` : "");
}

/** Supprime définitivement un carnet en ligne (seulement s'il est à moi). */
async function supprimerCarnetNuage(carnet) {
  if (!nuageConnecte() || !carnet || !carnet.uuid) return;
  // Un carnet PARTAGÉ avec moi ne se supprime que de mon appareil.
  if (carnet.partage) return;
  try {
    // On libère le fichier de contenu et les partages…
    await sbClient.storage.from("carnets").remove([cheminNuage(carnet)]);
    await sbClient.from("carnet_partages").delete().eq("carnet_uuid", carnet.uuid);
    // …mais on GARDE la ligne, marquée 'supprime' (pierre tombale) : c'est ce
    // qui empêche les autres appareils de recréer le carnet à la synchro.
    await sbClient.from("carnets")
      .update({ statut: "supprime", modifie_le: new Date().toISOString() })
      .eq("uuid", carnet.uuid).eq("user_id", sessionNuage.user.id);
  } catch (e) {
    toast("Suppression en ligne impossible pour l'instant (elle sera à refaire).", true);
  }
}

/** Recharge la table des droits des carnets partagés AVEC MOI. */
async function chargerDroitsPartages() {
  droitsPartages = new Map();
  if (!nuageConnecte()) return;
  try {
    const mail = (sessionNuage.user.email || "").toLowerCase();
    const { data } = await sbClient.from("carnet_partages").select("carnet_uuid, email, droit");
    (data || []).forEach((p) => {
      if ((p.email || "").toLowerCase() === mail) {
        droitsPartages.set(p.carnet_uuid, p.droit === "edition" ? "edition" : "lecture");
      }
    });
  } catch (e) { /* table absente (SQL pas encore joué) : pas de partages */ }
}

/**
 * Recopie dans le carnet local les informations de sa fiche en ligne
 * (nom, dates, zone, statut…). Ne touche pas au contenu (souvenirs, tracé).
 */
function appliquerFicheDistante(local, r, partage) {
  Object.assign(local, {
    nom: r.nom || local.nom, logo: r.logo || "", categorie: r.categorie || "",
    description: r.description || "", du: r.du || "", au: r.au || "",
    modifieLe: r.modifie_le || "",
    zone: (typeof normaliserZone === "function" ? normaliserZone(r.zone) : (r.zone || null)),
    formatZone: r.format_zone || "",
    orientationZone: r.orientation_zone === "paysage" ? "paysage" : "portrait",
    statut: r.statut === "archive" ? "archive" : "actif",
    partage,
  });
}

/** Nombre de souvenirs d'une version de carnet (posés + en réserve). */
function compterSouvenirs(donnees) {
  if (!donnees) return 0;
  return (donnees.souvenirs || []).length + (donnees.stock || []).length;
}

/**
 * Remplacer le contenu local par celui du nuage ferait-il PERDRE des
 * souvenirs ? Garde-fou utile quand on n'a pas d'historique de synchro fiable
 * (carnets d'avant cette version) : plutôt que d'écraser sur la foi d'une
 * date, on préfère demander.
 */
function risqueDePerte(contenuLocal, contenuDistant) {
  return compterSouvenirs(contenuLocal) > compterSouvenirs(contenuDistant);
}

/**
 * Descend la version en ligne d'un carnet déjà présent sur l'appareil, en
 * gardant une copie de secours de l'ancienne version locale.
 */
async function descendreCarnetDepuisNuage(local, r, partage) {
  await sauvegarderCopieSecours(local.id);
  appliquerFicheDistante(local, r, partage);
  const donnees = await telechargerCarnetResolu(local).catch(() => null);
  if (carnetADuContenu(donnees)) {
    await dbSauverCle("carnet-" + local.id, donnees);
    if (local.id === etat.carnetActifId) restaurerCarnet(donnees);
  }
  marquerCarnetSynchronise(local);
  // Le carnet ouvert vient d'etre archive ailleurs : on bascule ailleurs.
  if (local.statut !== "actif" && local.id === etat.carnetActifId &&
      typeof basculerVersAutreCarnetActif === "function") {
    await basculerVersAutreCarnetActif();
  } else if (local.id === etat.carnetActifId) {
    // La zone/format viennent peut-etre de changer : on rafraichit.
    if (typeof appliquerZoneCarnet === "function" && etat.vue === "editeur") appliquerZoneCarnet(true);
    if (typeof majBoutonsZone === "function") majBoutonsZone();
  }
}

/** Synchronise UN seul carnet (bouton « Synchroniser ce carnet »). */
async function synchroniserCarnet(c) {
  if (!c) return;
  if (!nuageConnecte()) {
    toast("Connecte-toi à ton compte (bouton ☁️ en haut) pour synchroniser.", true);
    return;
  }
  await synchroniserNuage(c);
}

/**
 * Synchronisation dans les deux sens :
 * - les carnets en ligne (les miens + partagés avec moi) absents ou plus
 *   récents sont téléchargés ;
 * - les carnets locaux absents ou plus récents sont envoyés ;
 * - un carnet modifié DES DEUX CÔTÉS depuis la dernière synchronisation
 *   confirmée n'est jamais écrasé en silence : il est mis de côté et
 *   l'utilisateur choisit quoi garder (voir ouvrirConflitsNuage).
 *
 * `cible` = un carnet précis à synchroniser seul ; sans elle, tout le compte.
 * Synchroniser carnet par carnet évite qu'un carnet en panne (ou un gros
 * carnet lent) bloque tous les autres.
 */
async function synchroniserNuage(cible) {
  if (!nuageConnecte() || syncEnCours) return;
  const uuidCible = (cible && cible.uuid) ? cible.uuid : null;
  const nomCible = cible ? cible.nom : "";
  syncEnCours = true;
  const enCours = uuidCible ? `Synchronisation de « ${nomCible} »…` : "Synchronisation en cours…";
  statutCompte(enCours);
  if (uuidCible) toast("🔄 " + enCours);
  let recus = 0, envoyes = 0, erreurs = 0;
  const conflits = [];
  const noms = [];
  let detailErreur = "";

  try {
    await chargerDroitsPartages();
    let requete = sbClient.from("carnets").select("*");
    if (uuidCible) requete = requete.eq("uuid", uuidCible);
    const { data: lignes, error } = await requete;
    if (error) throw error;
    const distants = lignes || [];
    const monId = sessionNuage.user.id;
    const parUuid = new Map(etat.carnets.map((c) => [c.uuid, c]));

    // 1) Du nuage vers l'appareil.
    for (const r of distants) {
      const local = parUuid.get(r.uuid);
      const dateDistante = Date.parse(r.modifie_le || 0) || 0;
      const partage = r.user_id !== monId
        ? { proprietaire: r.user_id, droit: droitsPartages.get(r.uuid) || "lecture" }
        : null;
      try {
        // Pierre tombale : ce carnet a ete supprime definitivement ailleurs.
        // On l'enleve de cet appareil et on ne le recree JAMAIS (fin des
        // carnets supprimes qui reapparaissent a la synchro).
        if (r.statut === "supprime") {
          if (local) {
            await sauvegarderCopieSecours(local.id);
            try { await dbEffacerCle("carnet-" + local.id); } catch (e) {}
            if (typeof retirerFantome === "function") retirerFantome(local.id);
            const etaitActif = local.id === etat.carnetActifId;
            etat.carnets = etat.carnets.filter((c) => c.id !== local.id);
            parUuid.delete(r.uuid);
            if (etaitActif && typeof basculerVersAutreCarnetActif === "function") {
              await basculerVersAutreCarnetActif();
            }
            recus++;
          }
          continue;
        }
        if (!local) {
          const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
          const entree = {
            id, uuid: r.uuid, visible: true,
            nom: r.nom || "Carnet", logo: r.logo || "", categorie: r.categorie || "",
            description: r.description || "", du: r.du || "", au: r.au || "",
            modifieLe: r.modifie_le || "",
            zone: (typeof normaliserZone === "function" ? normaliserZone(r.zone) : (r.zone || null)),
            formatZone: r.format_zone || "",
            orientationZone: r.orientation_zone === "paysage" ? "paysage" : "portrait",
            statut: r.statut === "archive" ? "archive" : "actif",
            partage,
          };
          etat.carnets.push(entree);
          const donnees = await telechargerCarnetResolu(entree).catch(() => null);
          if (carnetADuContenu(donnees)) await dbSauverCle("carnet-" + id, donnees);
          marquerCarnetSynchronise(entree);
          recus++;
          continue;
        }

        const dateLocale = tempsDe(local.modifieLe);
        const dateSync = tempsDe(local.syncLe);
        // Modifié depuis la dernière synchronisation confirmée ? Sans `syncLe`
        // (carnet d'avant cette version), on ne peut pas savoir : on s'en tient
        // alors à l'ancienne règle « le plus récent gagne », sans conflit.
        const historiqueConnu = !!local.syncLe;
        const bougeEnLigne = dateDistante > dateSync;
        const bougeIci = dateLocale > dateSync;

        if (dateDistante === dateLocale) {
          // Les deux côtés portent la même version : rien à faire.
          local.partage = partage;
          marquerCarnetSynchronise(local);
        } else if (historiqueConnu && bougeEnLigne && bougeIci && peutEcrireNuage(local)) {
          // VRAI CONFLIT : modifié ici ET en ligne depuis la dernière fois.
          // On ne touche à rien, l'utilisateur tranchera.
          conflits.push({ uuid: r.uuid, id: local.id, r, partage });
        } else if (dateDistante > dateLocale) {
          // Le nuage est plus récent. Dernier garde-fou avant d'écraser : si la
          // version locale contient PLUS de souvenirs, la date ment
          // probablement (c'est le bug des souvenirs disparus) — on demande.
          const avant = await lireContenuLocal(local.id);
          const apres = await telechargerCarnetNuage(local).catch(() => null);
          if (peutEcrireNuage(local) && risqueDePerte(avant, apres)) {
            conflits.push({ uuid: r.uuid, id: local.id, r, partage });
          } else {
            await descendreCarnetDepuisNuage(local, r, partage);
            recus++;
          }
        } else {
          // Plus récent ici : la phase 2 l'enverra.
          local.partage = partage;
        }
      } catch (e) {
        erreurs++; noms.push(r.nom || "carnet");
        detailErreur = detailErreur || (e && e.message) || "";
      }
    }

    // 2) De l'appareil vers le nuage (jamais les partages en lecture seule).
    const enConflit = new Set(conflits.map((x) => x.uuid));
    for (const c of etat.carnets) {
      if (uuidCible && c.uuid !== uuidCible) continue;
      if (!peutEcrireNuage(c) || enConflit.has(c.uuid)) continue;
      const r = distants.find((x) => x.uuid === c.uuid);
      const dateLocale = tempsDe(c.modifieLe);
      const dateDistante = r ? tempsDe(r.modifie_le) : -1;
      if (!r || dateLocale > dateDistante) {
        try { await pousserCarnet(c); envoyes++; }
        catch (e) {
          erreurs++; noms.push(c.nom || "carnet");
          detailErreur = detailErreur || (e && e.message) || "";
        }
      } else if (dateLocale === dateDistante) {
        marquerCarnetSynchronise(c);
      }
    }

    await sauverIndexCarnets();
    renderCarnets();

    // L'accueil réaffiche tous les carnets (dont les nouveaux téléchargés).
    if (etat.vue === "accueil") {
      retirerTousFantomes();
      await afficherTousLesCarnets();
      appliquerFiltresAccueil();
      majEcranVide();
      ajusterVueMonde();
    }

    const avertissement = messageColonnesAbsentes();
    if (erreurs > 0) {
      // On nomme les carnets qui ont coincé ET la raison technique : sans elle,
      // impossible de savoir s'il faut compléter la base, se reconnecter, etc.
      const liste = [...new Set(noms)].map((n) => `« ${n} »`).join(", ");
      const message = `Synchronisation partielle : ${liste || erreurs + " carnet(s)"} ` +
        `n'a pas pu être synchronisé.` + (detailErreur ? ` Raison : ${detailErreur}` : "");
      statutCompte(message, true);
      toast(message, true);
    } else if (conflits.length) {
      statutCompte(`${conflits.length} carnet(s) modifié(s) ici ET en ligne : ` +
        `à toi de choisir quoi garder.`);
    } else {
      const bilan = uuidCible
        ? `✓ « ${nomCible} » synchronisé`
        : "✓ Carnets synchronisés" +
          (recus || envoyes ? ` (${recus} reçu(s), ${envoyes} envoyé(s))` : "");
      statutCompte(bilan + (avertissement ? " — " + avertissement : ""));
      if (uuidCible) toast(bilan);
      if (avertissement) toast(avertissement, true);
      indiquerNuage();
    }
  } catch (e) {
    const message = "Synchronisation impossible : " +
      ((e && e.message) || "vérifie ta connexion Internet.");
    statutCompte(message, true);
    toast(message, true);
  } finally {
    syncEnCours = false;
    majCompteUI();
    majEtatSyncUI();
    if (typeof majPopupsAccueil === "function") majPopupsAccueil();
  }

  // Les conflits se règlent une fois la synchronisation terminée (la fenêtre
  // de choix peut relancer un envoi).
  if (conflits.length) await ouvrirConflitsNuage(conflits);
}

/* =========================================================
   Conflits : « modifié ici ET en ligne »
   ---------------------------------------------------------
   Plutôt que d'écraser une des deux versions en silence (ce qui faisait
   disparaître des souvenirs), on montre les deux et on laisse choisir.
   ========================================================= */

/** Résumé lisible d'une version de carnet : « 26 souvenirs · 3 photos posées ». */
function resumerVersionCarnet(donnees) {
  if (!donnees) return "contenu introuvable";
  const bouts = [];
  const nbSouvenirs = (donnees.souvenirs || []).length + (donnees.stock || []).length;
  bouts.push(nbSouvenirs + (nbSouvenirs > 1 ? " souvenirs" : " souvenir"));
  const nbAnnot = (donnees.annotations || []).length;
  if (nbAnnot) bouts.push(nbAnnot + (nbAnnot > 1 ? " éléments posés" : " élément posé"));
  const nbGpx = (donnees.gpx || []).length;
  if (nbGpx) bouts.push(nbGpx + (nbGpx > 1 ? " tracés" : " tracé"));
  return bouts.join(" · ");
}

/** « le 29/07/2026 à 07:55 » à partir d'une date ISO. */
function dateLisible(dateIso) {
  const t = Date.parse(dateIso || 0);
  if (!t) return "date inconnue";
  const d = new Date(t);
  return d.toLocaleDateString("fr-FR") + " à " +
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Contenu local d'un carnet (celui en mémoire s'il est ouvert). */
async function lireContenuLocal(id) {
  if (id === etat.carnetActifId) return serialiserCarnet();
  return await dbChargerCle("carnet-" + id).catch(() => null);
}

/** Traite les conflits l'un après l'autre. */
async function ouvrirConflitsNuage(conflits) {
  for (const conflit of conflits) {
    const local = etat.carnets.find((c) => c.uuid === conflit.uuid);
    if (!local) continue;
    try { await reglerUnConflit(local, conflit.r, conflit.partage); }
    catch (e) { toast("Ce conflit n'a pas pu être réglé — il te sera reproposé.", true); }
  }
  await sauverIndexCarnets();
  renderCarnets();
  majEtatSyncUI();
}

/** Affiche la fenêtre de choix pour UN carnet, et applique la décision. */
async function reglerUnConflit(local, r, partage) {
  const contenuLocal = await lireContenuLocal(local.id);
  const contenuDistant = await telechargerCarnetNuage(local).catch(() => null);

  const choix = await demanderChoixConflit({
    nom: local.nom,
    resumeIci: resumerVersionCarnet(contenuLocal),
    dateIci: dateLisible(local.modifieLe),
    resumeLigne: resumerVersionCarnet(contenuDistant),
    dateLigne: dateLisible(r.modifie_le),
  });

  if (choix === "ligne") {
    await descendreCarnetDepuisNuage(local, r, partage);
    toast(`« ${local.nom} » : version en ligne conservée.`);
    return;
  }

  if (choix === "deux") {
    // On met la version de CET APPAREIL à l'abri dans un nouveau carnet, puis
    // on aligne l'original sur la version en ligne.
    const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
    const copie = {
      id, uuid: genUuid(), visible: true,
      nom: (local.nom + " (version de cet appareil)").slice(0, 80),
      logo: local.logo || "", categorie: local.categorie || "",
      description: local.description || "", du: local.du || "", au: local.au || "",
      modifieLe: new Date().toISOString(), syncLe: "",
      zone: local.zone || null, formatZone: local.formatZone || "",
      orientationZone: local.orientationZone === "paysage" ? "paysage" : "portrait",
      statut: "actif", partage: null,
    };
    etat.carnets.push(copie);
    if (carnetADuContenu(contenuLocal)) await dbSauverCle("carnet-" + id, contenuLocal);
    await descendreCarnetDepuisNuage(local, r, partage);
    try { await pousserCarnet(copie); } catch (e) { /* partira à la prochaine synchro */ }
    toast(`Les deux versions de « ${local.nom} » sont gardées.`);
    return;
  }

  // « ici » : ma version devient la version officielle en ligne.
  local.modifieLe = new Date().toISOString();
  await pousserCarnet(local);
  toast(`« ${local.nom} » : ta version a été envoyée en ligne.`);
}

/** Ouvre la fenêtre et renvoie « ici » | « ligne » | « deux ». */
function demanderChoixConflit(infos) {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-conflit");
    document.getElementById("conflit-nom").textContent = infos.nom;
    document.getElementById("conflit-ici-resume").textContent = infos.resumeIci;
    document.getElementById("conflit-ici-date").textContent = "Modifié le " + infos.dateIci;
    document.getElementById("conflit-ligne-resume").textContent = infos.resumeLigne;
    document.getElementById("conflit-ligne-date").textContent = "Modifié le " + infos.dateLigne;
    modal.hidden = false;

    const boutons = [
      ["conflit-garder-ici", "ici"],
      ["conflit-garder-ligne", "ligne"],
      ["conflit-garder-deux", "deux"],
    ];
    const nettoyer = [];
    boutons.forEach(([id, valeur]) => {
      const el = document.getElementById(id);
      const gestionnaire = () => {
        nettoyer.forEach((f) => f());
        modal.hidden = true;
        resolve(valeur);
      };
      el.addEventListener("click", gestionnaire);
      nettoyer.push(() => el.removeEventListener("click", gestionnaire));
    });
  });
}

/* ---------- Poussée automatique après chaque modification ---------- */

let timerNuage = null;

/** Replanifie l'envoi du carnet ouvert (appelé après chaque sauvegarde). */
function planifierPousseeNuage() {
  if (!nuageConnecte()) return;
  majEtatSyncUI(); // il y a maintenant des modifications en attente
  clearTimeout(timerNuage);
  timerNuage = setTimeout(async () => {
    try {
      await pousserCarnet(carnetActif());
      await sauverIndexCarnets();
      indiquerNuage();
    } catch (e) { /* hors ligne : la prochaine synchronisation rattrapera */ }
    majEtatSyncUI();
  }, 6000);
}

/**
 * Met à jour partout l'indication « ce qui n'est pas encore en ligne » :
 * la pastille de la barre du haut (carnet ouvert) et les cartes de l'accueil.
 */
function majEtatSyncUI() {
  const pastille = document.getElementById("statut-attente");
  if (pastille) {
    const c = typeof carnetActif === "function" ? carnetActif() : null;
    const attente = carnetEnAttenteNuage(c);
    pastille.hidden = !attente;
    pastille.title = attente
      ? "Des modifications de ce carnet ne sont pas encore enregistrées en ligne."
      : "";
  }
  // Onglet Carnet : où en est le carnet ouvert vis-à-vis du compte en ligne ?
  const etatCarnet = document.getElementById("carnet-sync-etat");
  if (etatCarnet) {
    const c = typeof carnetActif === "function" ? carnetActif() : null;
    if (!nuageConfigure()) {
      etatCarnet.textContent = "Le service en ligne n'est pas configuré sur cette version.";
    } else if (!nuageConnecte()) {
      etatCarnet.textContent = "Pas connecté : ce carnet n'existe que sur cet appareil. " +
        "Connecte-toi avec le bouton ☁️ en haut.";
    } else if (!c) {
      etatCarnet.textContent = "—";
    } else if (c.partage && c.partage.droit !== "edition") {
      etatCarnet.textContent = "🤝 Carnet partagé avec toi en lecture : tes modifications " +
        "restent sur cet appareil.";
    } else if (!c.syncLe) {
      // Cas le plus parlant en premier : jamais envoyé du tout.
      etatCarnet.textContent = "● Ce carnet n'a encore jamais été envoyé en ligne.";
    } else if (carnetEnAttenteNuage(c)) {
      etatCarnet.textContent = "● Des modifications ne sont pas encore en ligne " +
        "(dernier envoi le " + dateLisible(c.syncLe) + ").";
    } else {
      etatCarnet.textContent = "☁️ À jour en ligne (dernier envoi le " + dateLisible(c.syncLe) + ").";
    }
  }

  const compteur = document.getElementById("accueil-attente");
  if (compteur) {
    const n = nbCarnetsEnAttente();
    compteur.hidden = n === 0;
    compteur.textContent = n === 1
      ? "1 carnet n'est pas encore en ligne"
      : `${n} carnets ne sont pas encore en ligne`;
  }
  if (typeof rafraichirBadgesSyncAccueil === "function") rafraichirBadgesSyncAccueil();
}

/** Affiche brièvement « ☁️ En ligne » à côté de « ✓ Enregistré ». */
let timerStatutNuage = null;
function indiquerNuage() {
  const el = document.getElementById("statut-nuage");
  if (!el) return;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("visible"));
  clearTimeout(timerStatutNuage);
  timerStatutNuage = setTimeout(() => el.classList.remove("visible"), 1800);
}

/* =========================================================
   Partage d'un carnet (côté propriétaire)
   ========================================================= */

/** La liste de partage d'un carnet (qui peut le voir / le modifier). */
async function listerPartages(uuid) {
  if (!nuageConnecte()) return [];
  try {
    const { data, error } = await sbClient.from("carnet_partages")
      .select("email, droit")
      .eq("carnet_uuid", uuid)
      .eq("proprietaire", sessionNuage.user.id);
    if (error) throw error;
    return data || [];
  } catch (e) { return []; }
}

/** Partage un carnet avec une adresse e-mail (lecture ou édition). */
async function ajouterPartage(uuid, email, droit) {
  const { error } = await sbClient.from("carnet_partages").upsert({
    proprietaire: sessionNuage.user.id,
    carnet_uuid: uuid,
    email: email.toLowerCase(),
    droit: droit === "edition" ? "edition" : "lecture",
  });
  if (error) throw error;
  // On s'assure que le carnet est bien en ligne (sinon l'invité ne verra rien).
  const c = etat.carnets.find((x) => x.uuid === uuid);
  if (c) await pousserCarnet(c).catch(() => {});
}

/** Retire une personne de la liste de partage. */
async function retirerPartage(uuid, email) {
  const { error } = await sbClient.from("carnet_partages").delete()
    .eq("proprietaire", sessionNuage.user.id)
    .eq("carnet_uuid", uuid)
    .eq("email", email.toLowerCase());
  if (error) throw error;
}

/* =========================================================
   Fenêtre « Compte »
   ========================================================= */

/** Message d'état dans la fenêtre Compte. */
function statutCompte(message, erreur) {
  const el = document.getElementById("compte-statut");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
}

/** Ouvre la fenêtre Compte. */
function ouvrirModalCompte() {
  statutCompte("");
  // Les carnets archivés se consultent d'ici : on rafraîchit la liste.
  if (typeof renderAccueilArchives === "function") renderAccueilArchives();
  document.getElementById("compte-bloc-connexion").hidden = nuageConnecte();
  document.getElementById("compte-bloc-connecte").hidden = !nuageConnecte();
  document.getElementById("compte-non-configure").hidden = nuageConfigure();
  if (nuageConnecte()) {
    document.getElementById("compte-email-affiche").textContent = sessionNuage.user.email;
    const p = monProfil && monProfil.pseudo;
    document.getElementById("compte-pseudo-affiche").textContent = p ? "@" + p : "(pas encore choisi)";
    document.getElementById("compte-pseudo-modifier").textContent = p ? "Modifier" : "Choisir";
    // On revient toujours sur l'onglet Profil à l'ouverture, et on vide les
    // champs mot de passe pour ne rien y laisser traîner.
    activerOngletCompte("profil");
    const mdp = document.getElementById("compte-mdp");
    const mdpc = document.getElementById("compte-mdp-confirm");
    if (mdp) mdp.value = "";
    if (mdpc) mdpc.value = "";
    remplirOngletProfil();
  } else {
    const mdpConn = document.getElementById("compte-mdp-connexion");
    if (mdpConn) mdpConn.value = "";
  }
  try {
    document.getElementById("compte-rester").checked =
      localStorage.getItem(CLE_EPHEMERE) !== "1";
  } catch (e) {}
  document.getElementById("modal-compte").hidden = false;
}

function fermerModalCompte() {
  document.getElementById("modal-compte").hidden = true;
}

/** Nom affiché sur le bouton Compte (pseudo, sinon début d'e-mail). */
function nomAfficheCompte() {
  const p = lirePseudo();
  if (p) return p;
  if (nuageConnecte()) {
    const mail = sessionNuage.user.email || "";
    return mail.split("@")[0] || "Connecté";
  }
  return "Se connecter";
}

/** Dessine un avatar : photo si dispo, sinon la 1re lettre du nom. */
function dessinerAvatar(el, source, nom) {
  if (!el) return;
  const photo = (source && source.photo) || (monProfil && monProfil.photo) || "";
  if (photo) {
    el.textContent = "";
    el.style.backgroundImage = `url("${photo.replace(/"/g, '\\"')}")`;
    el.style.background = `url("${photo.replace(/"/g, '\\"')}") center/cover no-repeat`;
  } else {
    el.style.backgroundImage = "";
    el.style.background = "";
    const lettre = (nom || "").trim().charAt(0).toUpperCase() || "?";
    el.textContent = lettre;
  }
}

/** Met à jour le bouton « Compte » de la barre du haut. */
function majCompteUI() {
  const btn = document.getElementById("compte-btn");
  if (!btn) return;
  const nomEl = document.getElementById("compte-btn-nom");
  const avatarEl = document.getElementById("compte-btn-avatar");
  if (!nuageConfigure()) {
    if (nomEl) nomEl.textContent = "Compte";
    if (avatarEl) { avatarEl.textContent = "☁"; avatarEl.style.background = ""; }
    return;
  }
  if (!nuageConnecte()) {
    if (nomEl) nomEl.textContent = "Se connecter";
    if (avatarEl) { avatarEl.textContent = "☁"; avatarEl.style.background = ""; }
    return;
  }
  const nom = nomAfficheCompte();
  if (nomEl) nomEl.textContent = nom;
  dessinerAvatar(avatarEl, null, nom);
}

/* ---------- Indicateur « chargement en cours » sur un bouton ---------- */
/**
 * Passe un bouton en mode « chargement » : il devient inactif, montre un
 * petit spinner et (facultatif) un libellé. Le bouton retrouve son état
 * initial dès qu'on rappelle la fonction avec `actif = false`.
 * Utiliser via `avecChargement(bouton, texte, promesse)` de préférence.
 */
function setBoutonChargement(bouton, actif, texte) {
  if (!bouton) return;
  if (actif) {
    if (bouton.dataset.libelleOrigine == null) {
      bouton.dataset.libelleOrigine = bouton.innerHTML;
    }
    bouton.disabled = true;
    bouton.classList.add("btn-chargement");
    bouton.setAttribute("aria-busy", "true");
    const lib = texte || bouton.dataset.libelleChargement || "Chargement…";
    bouton.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${lib}`;
  } else {
    bouton.disabled = false;
    bouton.classList.remove("btn-chargement");
    bouton.removeAttribute("aria-busy");
    if (bouton.dataset.libelleOrigine != null) {
      bouton.innerHTML = bouton.dataset.libelleOrigine;
      delete bouton.dataset.libelleOrigine;
    }
  }
}

/** Enrobe une promesse : montre l'état « chargement » sur le bouton pendant. */
async function avecChargement(bouton, texte, promesse) {
  setBoutonChargement(bouton, true, texte);
  try { return await promesse; }
  finally { setBoutonChargement(bouton, false); }
}

// Exposées pour ui.js et impression.js (autres boutons async).
window.setBoutonChargement = setBoutonChargement;
window.avecChargement = avecChargement;

/** Envoie le lien magique de connexion. */
async function envoyerLienMagique() {
  const email = document.getElementById("compte-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    statutCompte("Écris une adresse e-mail valide.", true);
    return;
  }
  // Mémorise le choix « rester connecté » (appliqué au retour du lien).
  const rester = document.getElementById("compte-rester").checked;
  try { localStorage.setItem(CLE_EPHEMERE, rester ? "0" : "1"); } catch (e) {}

  const bouton = document.getElementById("compte-lien");
  await avecChargement(bouton, "Envoi du lien…", (async () => {
    statutCompte("Envoi du lien de connexion…");
    const { error } = await sbClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) { statutCompte(traduireErreurAuth(error), true); return; }
    statutCompte("✓ C'est envoyé ! Ouvre ta boîte mail et clique sur le lien de " +
      "connexion (regarde aussi les indésirables). Tu peux fermer cette fenêtre.");
  })());
}

/** Connexion directe avec mot de passe (si l'utilisateur en a défini un). */
async function connecterAvecMotDePasse() {
  const email = document.getElementById("compte-email").value.trim();
  const mdp = document.getElementById("compte-mdp-connexion").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    statutCompte("Écris une adresse e-mail valide.", true);
    return;
  }
  if (!mdp) {
    statutCompte("Saisis ton mot de passe (ou utilise le bouton « Recevoir un lien »).", true);
    return;
  }
  const rester = document.getElementById("compte-rester").checked;
  try { localStorage.setItem(CLE_EPHEMERE, rester ? "0" : "1"); } catch (e) {}

  const bouton = document.getElementById("compte-connexion-mdp");
  await avecChargement(bouton, "Connexion…", (async () => {
    statutCompte("Connexion…");
    const { error } = await sbClient.auth.signInWithPassword({ email, password: mdp });
    if (error) { statutCompte(traduireErreurAuth(error), true); return; }
    // La session est captée par onAuthStateChange qui referme la fenêtre.
    statutCompte("✓ Connecté.");
  })());
}

/** Définit (ou change) le mot de passe du compte connecté. */
async function enregistrerMotDePasse() {
  if (!nuageConnecte()) {
    statutCompte("Il faut être connecté pour définir un mot de passe.", true);
    return;
  }
  const mdp = document.getElementById("compte-mdp").value;
  const confirm = document.getElementById("compte-mdp-confirm").value;
  if (mdp.length < 8) {
    statutCompte("Le mot de passe doit faire au moins 8 caractères.", true);
    return;
  }
  if (mdp !== confirm) {
    statutCompte("Les deux mots de passe ne sont pas identiques.", true);
    return;
  }
  const bouton = document.getElementById("compte-mdp-enregistrer");
  await avecChargement(bouton, "Enregistrement…", (async () => {
    statutCompte("Enregistrement du mot de passe…");
    const { error } = await sbClient.auth.updateUser({ password: mdp });
    if (error) { statutCompte(traduireErreurAuth(error), true); return; }
    document.getElementById("compte-mdp").value = "";
    document.getElementById("compte-mdp-confirm").value = "";
    statutCompte("✓ Mot de passe enregistré. Tu peux maintenant l'utiliser pour te connecter.");
  })());
}

/* ---------- Onglet Profil : photo / description / ville ---------- */

// Photo choisie mais pas encore enregistrée (data:image/...).
let photoProfilEnAttente = null;

/** Redimensionne une image à 256 px max côté long et renvoie une data-URL JPEG. */
function redimensionnerImage(fichier, cote = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture impossible"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image invalide"));
      img.onload = () => {
        const ratio = Math.min(cote / img.width, cote / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(fichier);
  });
}

/** Pré-remplit l'onglet Profil avec les valeurs actuelles. */
function remplirOngletProfil() {
  photoProfilEnAttente = null;
  const p = monProfil || {};
  const desc = document.getElementById("compte-description");
  const ville = document.getElementById("compte-ville");
  if (desc) desc.value = p.description || "";
  if (ville) ville.value = p.ville || "";
  const apercu = document.getElementById("compte-photo-apercu");
  dessinerAvatar(apercu, p, nomAfficheCompte());
  const retirer = document.getElementById("compte-photo-retirer");
  if (retirer) retirer.hidden = !p.photo;
}

/** L'utilisateur choisit une nouvelle photo. */
async function choisirPhotoProfil(evt) {
  const fichier = evt.target.files && evt.target.files[0];
  evt.target.value = "";
  if (!fichier) return;
  if (!/^image\//.test(fichier.type)) {
    statutCompte("Choisis un fichier image (jpg, png…).", true);
    return;
  }
  try {
    photoProfilEnAttente = await redimensionnerImage(fichier, 256);
    const apercu = document.getElementById("compte-photo-apercu");
    if (apercu) {
      apercu.textContent = "";
      apercu.style.background = `url("${photoProfilEnAttente}") center/cover no-repeat`;
    }
    const retirer = document.getElementById("compte-photo-retirer");
    if (retirer) retirer.hidden = false;
    statutCompte("Photo prête — clique sur « Enregistrer les modifications ».");
  } catch (e) {
    statutCompte("Impossible de lire cette image.", true);
  }
}

/** Retire la photo actuelle (elle sera vidée à la sauvegarde). */
function retirerPhotoProfil() {
  photoProfilEnAttente = "";
  const apercu = document.getElementById("compte-photo-apercu");
  if (apercu) {
    apercu.style.background = "";
    apercu.textContent = (nomAfficheCompte() || "?").charAt(0).toUpperCase();
  }
  const retirer = document.getElementById("compte-photo-retirer");
  if (retirer) retirer.hidden = true;
  statutCompte("Photo retirée — clique sur « Enregistrer les modifications ».");
}

/** Enregistre description / ville / photo (le pseudo change dans sa propre fenêtre). */
async function enregistrerProfilInfos() {
  if (!nuageConnecte()) { statutCompte("Connecte-toi d'abord.", true); return; }
  if (!(monProfil && monProfil.pseudo)) {
    statutCompte("Choisis d'abord un pseudo (bouton « Modifier » à côté du pseudo).", true);
    return;
  }
  const description = document.getElementById("compte-description").value.trim();
  const ville = document.getElementById("compte-ville").value.trim();
  const champs = { description, ville };
  if (photoProfilEnAttente !== null) champs.photo = photoProfilEnAttente;

  const bouton = document.getElementById("compte-profil-enregistrer");
  await avecChargement(bouton, "Enregistrement…", (async () => {
    const res = await enregistrerMonProfil(champs);
    if (!res.ok) { statutCompte(res.raison, true); return; }
    photoProfilEnAttente = null;
    remplirOngletProfil();
    statutCompte("✓ Profil enregistré.");
  })());
}

/** Bascule l'onglet actif dans la fenêtre Compte (« Profil » / « Compte »). */
function activerOngletCompte(nom) {
  document.querySelectorAll(".modal-compte-onglet").forEach((b) => {
    const actif = b.dataset.compteOnglet === nom;
    b.classList.toggle("actif", actif);
    b.setAttribute("aria-selected", actif ? "true" : "false");
  });
  document.querySelectorAll(".modal-compte-panneau").forEach((s) => {
    s.hidden = s.dataset.comptePanneau !== nom;
  });
  const contenu = document.querySelector(".modal-compte-contenu");
  if (contenu) contenu.scrollTop = 0;
}

/**
 * Vide de l'écran tous les carnets (liste, carte, éditeur). Les données
 * IndexedDB ne sont PAS effacées : elles réapparaîtront à la prochaine
 * connexion. On utilise ça à la déconnexion et au chargement quand la
 * session n'a pas pu être retrouvée alors qu'on avait déjà un compte.
 */
function viderCarnetsDeVue() {
  try {
    if (typeof retirerTousFantomes === "function") retirerTousFantomes();
    if (typeof viderCarnetCourant === "function") viderCarnetCourant();
  } catch (e) {}
  etat.carnets = [];
  etat.carnetActifId = 0;
  etat.carnetFocalise = null;
  document.body.classList.remove("carnet-focalise");
  // On force le retour à l'accueil (au cas où on était dans l'éditeur).
  etat.vue = "accueil";
  document.body.classList.add("vue-accueil");
  document.body.classList.remove("vue-editeur");
  if (typeof renderCarnets === "function") renderCarnets();
  if (typeof appliquerFiltresAccueil === "function") appliquerFiltresAccueil();
  if (typeof ajusterVueMonde === "function") ajusterVueMonde();
  if (typeof majPopupsAccueil === "function") majPopupsAccueil();
}

/** Se déconnecte : les carnets disparaissent de l'écran (data locale intacte). */
async function deconnecterNuage() {
  await sbClient.auth.signOut();
  sessionNuage = null;
  monProfil = null;
  majCompteUI();
  // On vide immédiatement l'écran (l'événement SIGNED_OUT le referait sinon,
  // mais avec un temps de latence visible).
  viderCarnetsDeVue();
  ouvrirModalCompte();
  statutCompte("Déconnecté. Reconnecte-toi pour retrouver tes carnets.");
}

/** Messages d'erreur Supabase → français simple. */
function traduireErreurAuth(error) {
  const m = (error && error.message) || "";
  if (/rate limit|too many|after \d+ seconds/i.test(m)) {
    return "Trop de liens demandés d'affilée — attends une minute et réessaie.";
  }
  if (/network|fetch/i.test(m)) return "Pas de connexion Internet pour l'instant.";
  return "Ça n'a pas marché : " + (m || "erreur inconnue.");
}

/* =========================================================
   Fenêtre « Choisis ton pseudo » (jalon A)
   ========================================================= */

/** Message d'état dans la fenêtre Profil. */
function statutProfil(message, erreur) {
  const el = document.getElementById("profil-statut");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
}

/** Ouvre la fenêtre de choix du pseudo, pré-remplie avec `suggestion`. */
function ouvrirModalProfil(suggestion) {
  const modal = document.getElementById("modal-profil");
  if (!modal) return;
  const champ = document.getElementById("profil-pseudo");
  champ.value = suggestion || "";
  statutProfil("");
  majAideProfil();
  modal.hidden = false;
  // Focus après affichage, pour que le clavier apparaisse sur mobile.
  setTimeout(() => champ.focus(), 50);
}

function fermerModalProfil() {
  const modal = document.getElementById("modal-profil");
  if (modal) modal.hidden = true;
}

/**
 * Aide sous le champ pseudo : vert si le format est bon, orange sinon.
 * On ne teste PAS la disponibilité en direct (coûteux + reveal de comptes
 * existants) : la collision se voit au moment d'enregistrer.
 */
function majAideProfil() {
  const champ = document.getElementById("profil-pseudo");
  const aide = document.getElementById("profil-aide");
  if (!champ || !aide) return;
  const v = champ.value.trim();
  if (!v) {
    aide.textContent = "Ton pseudo apparaîtra tel quel aux autres.";
    aide.className = "style-aide";
  } else if (PSEUDO_MOTIF.test(v)) {
    aide.textContent = "✓ Format correct.";
    aide.className = "style-aide profil-aide-ok";
  } else if (v.length < 3) {
    aide.textContent = "Il faut au moins 3 caractères.";
    aide.className = "style-aide profil-aide-non";
  } else {
    aide.textContent = "Seuls lettres, chiffres, tiret et tiret-bas sont autorisés (pas d'espace ni d'accent).";
    aide.className = "style-aide profil-aide-non";
  }
}

/** Valide le champ et tente d'enregistrer le profil. */
async function validerModalProfil() {
  const champ = document.getElementById("profil-pseudo");
  const pseudo = champ.value.trim();
  if (!PSEUDO_MOTIF.test(pseudo)) {
    statutProfil("Le pseudo doit faire 3 à 30 caractères (lettres, chiffres, - ou _).", true);
    return;
  }
  const bouton = document.getElementById("profil-enregistrer");
  bouton.disabled = true;
  statutProfil("Enregistrement…");
  const res = await enregistrerMonProfil({ pseudo });
  bouton.disabled = false;
  if (!res.ok) { statutProfil(res.raison, true); return; }
  fermerModalProfil();
  toast(`👤 Pseudo enregistré : @${pseudo}`);
}

/* =========================================================
   Branchements
   ========================================================= */

function brancherProfilUI() {
  const modal = document.getElementById("modal-profil");
  if (!modal) return;
  document.getElementById("profil-enregistrer").addEventListener("click", validerModalProfil);
  document.getElementById("profil-plus-tard").addEventListener("click", fermerModalProfil);
  const champ = document.getElementById("profil-pseudo");
  champ.addEventListener("input", majAideProfil);
  champ.addEventListener("keydown", (e) => { if (e.key === "Enter") validerModalProfil(); });
}

function brancherCompteUI() {
  brancherProfilUI();
  document.getElementById("compte-btn")
    .addEventListener("click", () => ouvrirModalCompte());
  document.getElementById("compte-fermer")
    .addEventListener("click", fermerModalCompte);
  document.getElementById("compte-lien")
    .addEventListener("click", envoyerLienMagique);
  document.getElementById("compte-email")
    .addEventListener("keydown", (e) => {
      // Entrée envoie le lien si aucun mot de passe n'est saisi, sinon connecte.
      if (e.key !== "Enter") return;
      const champMdp = document.getElementById("compte-mdp-connexion");
      if (champMdp && champMdp.value) connecterAvecMotDePasse();
      else envoyerLienMagique();
    });
  document.getElementById("compte-mdp-connexion")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") connecterAvecMotDePasse(); });
  document.getElementById("compte-connexion-mdp")
    .addEventListener("click", connecterAvecMotDePasse);
  document.getElementById("compte-mdp-enregistrer")
    .addEventListener("click", enregistrerMotDePasse);
  document.getElementById("compte-mdp-confirm")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") enregistrerMotDePasse(); });
  // Bascule d'onglet Profil / Compte.
  document.querySelectorAll(".modal-compte-onglet").forEach((b) => {
    b.addEventListener("click", () => activerOngletCompte(b.dataset.compteOnglet));
  });
  document.getElementById("compte-rester")
    .addEventListener("change", (e) => {
      try { localStorage.setItem(CLE_EPHEMERE, e.target.checked ? "0" : "1"); } catch (err) {}
    });
  document.getElementById("compte-deconnecter")
    .addEventListener("click", deconnecterNuage);
  // Attention : surtout pas `addEventListener("click", synchroniserNuage)` —
  // l'événement serait passé comme carnet cible.
  document.getElementById("compte-synchroniser")
    .addEventListener("click", (e) => {
      avecChargement(e.currentTarget, "Synchronisation…", synchroniserNuage());
    });
  // Le bandeau « N carnets ne sont pas encore en ligne » lance la synchro.
  const attente = document.getElementById("accueil-attente");
  if (attente) attente.addEventListener("click", (e) => {
    avecChargement(e.currentTarget, "Synchronisation…", synchroniserNuage());
  });

  // Onglet Profil : photo / description / ville.
  document.getElementById("compte-photo-input")
    .addEventListener("change", choisirPhotoProfil);
  document.getElementById("compte-photo-retirer")
    .addEventListener("click", retirerPhotoProfil);
  document.getElementById("compte-profil-enregistrer")
    .addEventListener("click", enregistrerProfilInfos);
  document.getElementById("compte-profil-annuler")
    .addEventListener("click", () => { remplirOngletProfil(); statutCompte(""); });
  // Le pseudo est modifié par la fenêtre dédiée (validation + unicité).
  document.getElementById("compte-pseudo-modifier")
    .addEventListener("click", () => {
      fermerModalCompte();
      ouvrirModalProfil((monProfil && monProfil.pseudo) || nettoyerPseudo(lirePseudo()));
    });

  // Échap ferme la fenêtre Compte OU la fenêtre Profil (avant les autres raccourcis).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const profil = document.getElementById("modal-profil");
    if (profil && !profil.hidden) { fermerModalProfil(); e.stopPropagation(); return; }
    if (!document.getElementById("modal-compte").hidden) {
      fermerModalCompte();
      e.stopPropagation();
    }
  }, true);
}
