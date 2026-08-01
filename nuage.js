/* =========================================================
   nuage.js — Compte et sauvegarde en ligne (Supabase)
   ---------------------------------------------------------
   - Connexion par « lien magique » e-mail (le compte se crée tout
     seul à la première fois) ou par mot de passe, avec parcours
     « Mot de passe oublié » standard (e-mail de réinitialisation).
   - « Rester connecté » : coché, la session vit dans localStorage
     et survit à la fermeture du navigateur. Décoché, elle vit dans
     sessionStorage : elle disparaît à la fermeture, comme sur
     n'importe quel site avec une case « Se souvenir de moi ».
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

// Le démarrage de l'authentification est-il tranché (connecté OU déconnecté,
// de façon sûre) ? Tant que non, on ne montre NI la page de connexion NI le
// pop-up de bienvenue : uniquement l'écran de chargement. Sans ce verrou,
// l'interface « non connecté » apparaissait ~30 s pendant que Supabase
// rafraîchissait un jeton expiré en arrière-plan.
let demarrageResolu = false;

/** Exposé à ui.js : l'état de connexion est-il connu de façon sûre ? */
function demarrageAuthResolu() { return demarrageResolu; }

const CLE_RESTER = "nuage-rester";           // "0" = ne pas rester connecté (défaut : "1")
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

/* =========================================================
   « Rester connecté » — stockage de la session
   ---------------------------------------------------------
   Le choix est noté dans localStorage (clé CLE_RESTER) pour être
   partagé entre les onglets — y compris l'onglet qu'ouvre le lien
   magique reçu par e-mail. Selon ce choix, les jetons de session
   Supabase sont rangés :
   - dans localStorage  → session durable, commune aux onglets ;
   - dans sessionStorage → session limitée à l'onglet, oubliée à la
     fermeture du navigateur (comportement standard du web quand la
     case « Se souvenir de moi » est décochée).
   ========================================================= */

/** L'utilisateur veut-il rester connecté ? (défaut : oui) */
function choixResterConnecte() {
  try { return localStorage.getItem(CLE_RESTER) !== "0"; } catch (e) { return true; }
}

/** Mémorise le choix de la case « Rester connecté ». */
function enregistrerChoixRester(rester) {
  try { localStorage.setItem(CLE_RESTER, rester ? "1" : "0"); } catch (e) {}
}

/**
 * Adaptateur de stockage passé au client Supabase : il range les jetons au
 * bon endroit selon le choix « Rester connecté », et sait les retrouver où
 * qu'ils soient (une session éphémère d'un côté, une durable de l'autre).
 */
const stockageAuth = {
  getItem: (cle) => {
    try {
      const ephemere = sessionStorage.getItem(cle);
      if (ephemere != null) return ephemere;
    } catch (e) {}
    try { return localStorage.getItem(cle); } catch (e) { return null; }
  },
  setItem: (cle, valeur) => {
    const durable = choixResterConnecte();
    try { (durable ? localStorage : sessionStorage).setItem(cle, valeur); } catch (e) {}
    // On nettoie l'autre emplacement pour ne jamais avoir deux sessions
    // divergentes (l'ancienne ressurgirait au mauvais moment).
    try { (durable ? sessionStorage : localStorage).removeItem(cle); } catch (e) {}
  },
  removeItem: (cle) => {
    try { localStorage.removeItem(cle); } catch (e) {}
    try { sessionStorage.removeItem(cle); } catch (e) {}
  },
};

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

/* ---------- Écran de chargement (démarrage de l'app) ---------- */

let chargementAppMasque = false;
let chargementAppTimer = null;

/** Affiche/relibelle l'écran de chargement plein cadre. */
function montrerChargementApp(message) {
  const overlay = document.getElementById("chargement-app");
  if (!overlay) return;
  chargementAppMasque = false;
  overlay.hidden = false;
  overlay.classList.remove("fondu-sortie");
  document.body.classList.add("chargement-en-cours");
  if (message) {
    const el = document.getElementById("chargement-app-message");
    if (el) el.textContent = message;
  }
}

/** Masque l'écran de chargement, avec un petit fondu. */
function masquerChargementApp() {
  if (chargementAppMasque) return;
  chargementAppMasque = true;
  clearTimeout(chargementAppTimer);
  const overlay = document.getElementById("chargement-app");
  document.body.classList.remove("chargement-en-cours");
  if (!overlay) return;
  overlay.classList.add("fondu-sortie");
  setTimeout(() => { overlay.hidden = true; }, 280);
}

// Filet de sécurité à 8 s : l'écran de chargement ne doit jamais rester
// bloqué. S'il n'y a aucun jeton en stock et que rien n'est tranché (Supabase
// injoignable, JS d'auth planté…), on montre la page de connexion avec un
// message ; sinon on retire simplement l'écran (l'app est utilisable, la
// restauration continue en arrière-plan).
if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    chargementAppTimer = setTimeout(() => {
      if (!demarrageResolu && nuageConfigure() && !tokenSessionPresent()) {
        resoudreDemarrageDeconnecte("Le service en ligne ne répond pas — " +
          "vérifie ta connexion Internet, puis recharge la page.");
      } else {
        masquerChargementApp();
      }
    }, 8000);
  });
}

/** Point d'entrée : appelé par demarrerUI() une fois les carnets chargés. */
function demarrerNuage() {
  brancherCompteUI();
  brancherPageConnexion();
  if (!nuageConfigure()) {
    // Pas de compte en ligne : l'état est trivialement connu (déconnecté),
    // l'app fonctionne en local.
    demarrageResolu = true;
    majCompteUI();
    if (typeof majPopupsAccueil === "function") majPopupsAccueil();
    // Pas de compte en ligne configuré → on quitte tout de suite l'écran de
    // chargement (l'app fonctionne en local dans ce cas particulier).
    masquerChargementApp();
    return;
  }
  // Options d'auth explicites : session persistée et rafraîchie
  // automatiquement. L'emplacement des jetons (localStorage ou
  // sessionStorage) dépend du choix « Rester connecté » — voir stockageAuth.
  sbClient = window.supabase.createClient(window.CONFIG_NUAGE.url, window.CONFIG_NUAGE.cle, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: stockageAuth,
    },
  });

  // Nettoyage d'une clé d'une ancienne version (« nuage-ephemere ») devenue
  // sans objet — le choix vit désormais sous CLE_RESTER.
  try { localStorage.removeItem("nuage-ephemere"); } catch (e) {}

  // Écran de chargement : UNIQUEMENT pour les cas où la réponse est
  // instantanée (session encore valide en stock : aucun appel réseau ; ou
  // aucun jeton : page de connexion immédiate). Si le jeton doit être
  // rafraîchi EN LIGNE, on ne bloque pas l'écran sur le réseau : l'app
  // s'affiche tout de suite avec les carnets de l'appareil, et la session
  // se restaure en arrière-plan (bouton du compte : « Connexion… »).
  const jeton = jetonLocalInfos();
  if (jeton.present && jeton.expire) masquerChargementApp();
  else if (jeton.present) montrerChargementApp("Connexion à ton compte…");
  try {
    console.info("[LogBookMap] Demarrage auth — jeton :",
      jeton.present ? (jeton.expire ? "present (expire)" : "present (valide)") : "absent");
  } catch (e) {}

  sbClient.auth.onAuthStateChange((evenement, session) => {
    try {
      console.info("[LogBookMap] onAuthStateChange :", evenement, "session ?", !!session);
    } catch (e) {}
    dernierEvenementAuth = evenement + (session ? " (avec session)" : " (sans session)");
    const etaitConnecte = nuageConnecte();
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
    majPageConnexion();
    majDiagnosticConnexion();
    if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();

    if (evenement === "PASSWORD_RECOVERY") {
      // Retour du lien « Mot de passe oublié » : l'utilisateur est connecté ;
      // on branche l'app puis on demande le nouveau mot de passe par-dessus.
      if (session) resoudreDemarrageConnecte(session);
      fermerModalCompte();
      ouvrirModalNouveauMdp();
    } else if (evenement === "SIGNED_OUT") {
      // Déconnexion sûre et définitive (clic sur « Se déconnecter », ou jeton
      // révoqué côté serveur) : la page de connexion peut s'afficher.
      demarrageResolu = true;
      monProfil = null;
      majPageConnexion();
      viderCarnetsDeVue();
      masquerChargementApp();
    } else if (session && !demarrageResolu) {
      // Première session vue au démarrage (INITIAL_SESSION, retour de lien
      // magique…) : on branche l'app connectée.
      resoudreDemarrageConnecte(session);
    } else if (session && !etaitConnecte) {
      // (Re)connexion pendant que l'app tourne : depuis la page de connexion,
      // la fenêtre Compte, ou au retour du réseau.
      fermerModalCompte();
      toast("☁️ Connecté ! Synchronisation de tes carnets…");
      assurerProfil();
      synchroniserNuage();
      // Si un token de partage attendait dans l'URL, on le consomme maintenant.
      rejoindrePartageDepuisUrl();
    } else if (evenement === "INITIAL_SESSION" && !session && !demarrageResolu &&
               !tokenSessionPresent()) {
      // Aucune session ET aucun jeton en stock : réellement déconnecté — la
      // page de connexion s'affiche sans attendre. (S'il reste un jeton, on
      // laisse resoudreSessionAuDemarrage tenter le rafraîchissement.)
      resoudreDemarrageDeconnecte();
    }
  });

  // Résolution EXPLICITE de la session, sans attendre les cycles internes de
  // Supabase : un jeton expiré est rafraîchi immédiatement (avant ce correctif,
  // l'app pouvait rester « non connectée » ~30 s en attendant le prochain
  // cycle automatique).
  resoudreSessionAuDemarrage();

  // Si le réseau revient alors que la session n'a pas pu être restaurée, on
  // retente aussitôt.
  window.addEventListener("online", () => {
    if (!nuageConnecte() && tokenSessionPresent()) {
      essaiSessionIndex = 0;
      retenterRestaurationSession();
    }
  });
}

/* ---------- Résolution de la session au démarrage ---------- */

/** Branche l'app « connectée » (une seule fois) : profil, carnets, synchro. */
function resoudreDemarrageConnecte(session) {
  if (demarrageResolu) return;
  demarrageResolu = true;
  clearTimeout(essaiSessionTimer);
  sessionNuage = session;
  majCompteUI();
  majEtatSyncUI();
  majPageConnexion();
  if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();
  assurerProfil();
  // Premier appareil vide (rien en local) : un écran « Récupération… » évite
  // l'accueil vide pendant le premier téléchargement. Sinon, les carnets
  // locaux sont déjà affichés : la synchro se fait discrètement en fond.
  if (!etat.carnets || etat.carnets.length === 0) {
    montrerChargementApp("Récupération de tes carnets…");
    synchroniserNuage().finally(masquerChargementApp);
  } else {
    masquerChargementApp();
    synchroniserNuage();
  }
  // Consomme un eventuel token ?rejoindrepartage=... dans l'URL.
  rejoindrePartageDepuisUrl();
}

/** Tranche « pas de session » (une seule fois) : page de connexion. */
function resoudreDemarrageDeconnecte(message) {
  if (demarrageResolu) return;
  demarrageResolu = true;
  clearTimeout(essaiSessionTimer);
  sessionNuage = null;
  monProfil = null;
  majCompteUI();
  majEtatSyncUI();
  majPageConnexion();
  viderCarnetsDeVue();
  masquerChargementApp();
  if (message) statutConnexion(message, true);
  majDiagnosticConnexion();
}

// Re-essais de restauration en arrière-plan (réseau lent, coupé, VPN…) :
// 5 s, 15 s, 30 s, puis toutes les 60 s. L'app reste utilisable pendant ce
// temps — seul le bouton du compte indique « Connexion… ».
let essaiSessionTimer = null;
let essaiSessionIndex = 0;
const ESSAIS_SESSION_DELAIS = [5000, 15000, 30000, 60000];

function planifierNouvelEssaiSession() {
  if (demarrageResolu) return;
  clearTimeout(essaiSessionTimer);
  const delai = ESSAIS_SESSION_DELAIS[Math.min(essaiSessionIndex, ESSAIS_SESSION_DELAIS.length - 1)];
  essaiSessionIndex++;
  essaiSessionTimer = setTimeout(retenterRestaurationSession, delai);
}

/** Tente de rafraîchir la session en fond. Ne bloque jamais l'interface. */
async function retenterRestaurationSession() {
  if (demarrageResolu || !sbClient || !tokenSessionPresent()) return;
  try {
    const r = await sbClient.auth.refreshSession();
    if (demarrageResolu) return;
    if (r && r.data && r.data.session) { resoudreDemarrageConnecte(r.data.session); return; }
    const m = (r && r.error && r.error.message) || "";
    if (/network|fetch|failed|abort|timeout/i.test(m)) {
      // Problème de réseau : on garde l'app utilisable et on réessaiera.
      planifierNouvelEssaiSession();
      return;
    }
    // Refus du serveur (jeton révoqué/expiré définitivement) : déconnecté.
    resoudreDemarrageDeconnecte("Ta session a expiré — reconnecte-toi.");
  } catch (e) {
    planifierNouvelEssaiSession();
  }
}

/**
 * Restaure la session au démarrage, de façon active :
 *   - session valide en stock → app connectée tout de suite ;
 *   - jeton présent mais expiré → rafraîchissement immédiat, en arrière-plan
 *     (l'app est déjà affichée, on ne fait pas attendre l'utilisateur) ;
 *   - rien du tout → page de connexion.
 * Les événements onAuthStateChange restent branchés en parallèle : le premier
 * chemin qui aboutit gagne (verrou demarrageResolu).
 */
async function resoudreSessionAuDemarrage() {
  try {
    const { data } = await sbClient.auth.getSession();
    if (demarrageResolu) return;
    if (data && data.session) { resoudreDemarrageConnecte(data.session); return; }
    if (!tokenSessionPresent()) { resoudreDemarrageDeconnecte(); return; }
    try { console.info("[LogBookMap] Jeton expire — rafraichissement en arriere-plan…"); } catch (e) {}
    retenterRestaurationSession();
  } catch (e) {
    if (demarrageResolu) return;
    if (tokenSessionPresent()) planifierNouvelEssaiSession();
    else resoudreDemarrageDeconnecte();
  }
}

/* =========================================================
   Page de connexion plein écran
   ---------------------------------------------------------
   Quand aucun compte n'est connecté (et que le service en ligne est
   configuré), on affiche une page dédiée qui masque tout le reste de
   l'application : impossible d'utiliser l'app sans s'authentifier. La
   fenêtre « Compte » reste utilisée pour les paramètres une fois connecté.
   ========================================================= */

/** Message d'état dans la page de connexion. */
function statutConnexion(message, erreur) {
  const el = document.getElementById("connexion-statut");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
}

// Etat courant du dernier evenement auth pour l'affichage diagnostique.
let dernierEvenementAuth = "aucun encore";

/** Remplit le panneau de diagnostic de la page de connexion. */
function majDiagnosticConnexion() {
  const el = document.getElementById("connexion-diagnostic-contenu");
  if (!el) return;
  const infos = {
    version_sw: "v102",
    heure: new Date().toISOString(),
    token_present: tokenSessionPresent(),
    demarrage_resolu: demarrageResolu,
    rester_connecte: choixResterConnecte(),
    session_active: !!(sessionNuage && sessionNuage.user),
    dernier_evenement_supabase: dernierEvenementAuth,
    nuage_configure: nuageConfigure(),
    url: window.location.href.split("#")[0],
    localStorage_keys: Object.keys(localStorage).filter((k) => k.startsWith("sb-") || k.startsWith("nuage-")),
    sessionStorage_keys: (function () {
      try { return Object.keys(sessionStorage).filter((k) => k.startsWith("sb-") || k.startsWith("nuage-")); }
      catch (e) { return []; }
    })(),
  };
  el.textContent = JSON.stringify(infos, null, 2);
}

/**
 * Y a-t-il un token de session Supabase encore stocke sur cet appareil ?
 * Sert de filet de securite : si oui, on ne va PAS afficher la page de
 * connexion tant que Supabase n'a pas explicitement confirme qu'il n'y a
 * plus de session (evenement SIGNED_OUT). Cela evite l'affichage furtif
 * de la page de connexion pendant que le client se re-hydrate.
 */
function tokenSessionPresent() {
  return jetonLocalInfos().present;
}

/**
 * Lit le jeton de session stocké sur l'appareil, SANS passer par Supabase.
 * Renvoie { present, expire } :
 *   - present : un jeton est en stock (localStorage ou sessionStorage) ;
 *   - expire  : son ticket d'accès est périmé → le restaurer demandera un
 *               appel réseau (rafraîchissement). Sert à décider si on peut
 *               attendre la restauration à l'écran (instantanée) ou s'il faut
 *               afficher l'app sans attendre (réseau = durée imprévisible).
 */
function jetonLocalInfos() {
  try {
    const ref = (window.CONFIG_NUAGE && window.CONFIG_NUAGE.url || "")
      .replace(/^https?:\/\//, "").split(".")[0];
    if (!ref) return { present: false, expire: false };
    // La session peut vivre dans sessionStorage (« Rester connecté » décoché)
    // ou localStorage (coché) : on regarde aux deux endroits.
    const brut = stockageAuth.getItem("sb-" + ref + "-auth-token");
    if (!brut) return { present: false, expire: false };
    const parse = JSON.parse(brut);
    const session = (parse && parse.currentSession) || parse;
    if (!session || !session.access_token) return { present: false, expire: false };
    // Marge de 30 s : un ticket qui expire dans quelques secondes sera
    // rafraîchi de toute façon, autant le traiter comme périmé.
    const expire = !session.expires_at ||
      (session.expires_at * 1000) < Date.now() + 30000;
    return { present: true, expire };
  } catch (e) { return { present: false, expire: false }; }
}

/** Affiche ou masque la page de connexion selon l'état d'authentification. */
function majPageConnexion() {
  const page = document.getElementById("page-connexion");
  if (!page) return;
  // On affiche uniquement si (a) le nuage est configuré, (b) l'état de
  // connexion a été TRANCHÉ au démarrage (verrou demarrageResolu — tant que
  // la session est en cours de restauration, on reste sur l'écran de
  // chargement) et (c) on est réellement non connecté.
  const doitAfficher = nuageConfigure() && demarrageResolu && !nuageConnecte();
  page.hidden = !doitAfficher;
  document.body.classList.toggle("pas-connecte", doitAfficher);
  if (doitAfficher) {
    statutConnexion("");
    majDiagnosticConnexion();
    // Petit focus sur le champ e-mail pour aller vite au clavier.
    setTimeout(() => {
      const champ = document.getElementById("connexion-email");
      if (champ && !page.hidden) champ.focus();
    }, 100);
  }
}

/** Applique le choix de la case « Rester connecté » du formulaire visible. */
function noterChoixResterDepuis(idCase) {
  const c = document.getElementById(idCase);
  if (c) enregistrerChoixRester(c.checked);
}

/** L'e-mail saisi est-il plausible ? (validation simple côté client) */
function emailValide(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Mode courant de la page de connexion : lien magique (défaut) ou mot de passe.
let connexionAvecMdp = false;

/** Bascule la page de connexion entre « lien magique » et « mot de passe ». */
function basculerModeConnexion(avecMdp) {
  connexionAvecMdp = !!avecMdp;
  const zoneMdp = document.getElementById("connexion-zone-mdp");
  const envoyer = document.getElementById("connexion-envoyer");
  const bascule = document.getElementById("connexion-bascule-mdp");
  const intro = document.getElementById("connexion-intro");
  if (zoneMdp) zoneMdp.hidden = !connexionAvecMdp;
  if (envoyer) envoyer.textContent = connexionAvecMdp
    ? "🔑 Se connecter"
    : "✉️ Recevoir un lien de connexion";
  if (bascule) bascule.textContent = connexionAvecMdp
    ? "Recevoir un lien par e-mail à la place"
    : "Se connecter avec un mot de passe";
  if (intro) intro.textContent = connexionAvecMdp
    ? "Connecte-toi avec l'adresse e-mail et le mot de passe de ton compte."
    : "Connecte-toi pour retrouver tes carnets sur tous tes appareils. " +
      "On t'envoie un lien à cliquer par e-mail — le compte se crée tout " +
      "seul à la première connexion.";
  statutConnexion("");
  if (connexionAvecMdp) {
    const champMdp = document.getElementById("connexion-mdp");
    if (champMdp) setTimeout(() => champMdp.focus(), 30);
  }
}

/** Envoie un lien magique depuis la page de connexion plein écran. */
async function envoyerLienDepuisConnexion() {
  if (!sbClient) return;
  const email = document.getElementById("connexion-email").value.trim();
  if (!emailValide(email)) {
    statutConnexion("Écris une adresse e-mail valide.", true);
    return;
  }
  noterChoixResterDepuis("connexion-rester");
  const bouton = document.getElementById("connexion-envoyer");
  await avecChargement(bouton, "Envoi du lien…", (async () => {
    statutConnexion("Envoi du lien de connexion…");
    const { error } = await sbClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) { statutConnexion(traduireErreurAuth(error), true); return; }
    statutConnexion("✓ C'est envoyé ! Ouvre ta boîte mail et clique sur le lien " +
      "de connexion (regarde aussi les indésirables).");
  })());
}

/** Connexion avec mot de passe depuis la page de connexion plein écran. */
async function connecterMdpDepuisConnexion() {
  if (!sbClient) return;
  const email = document.getElementById("connexion-email").value.trim();
  const mdp = document.getElementById("connexion-mdp").value;
  if (!emailValide(email)) {
    statutConnexion("Écris une adresse e-mail valide.", true);
    return;
  }
  if (!mdp) {
    statutConnexion("Saisis ton mot de passe — ou repasse par le lien e-mail.", true);
    return;
  }
  noterChoixResterDepuis("connexion-rester");
  const bouton = document.getElementById("connexion-envoyer");
  await avecChargement(bouton, "Connexion…", (async () => {
    statutConnexion("Connexion…");
    const { error } = await sbClient.auth.signInWithPassword({ email, password: mdp });
    if (error) { statutConnexion(traduireErreurAuth(error), true); return; }
    statutConnexion("✓ Connecté.");
  })());
}

/**
 * « Mot de passe oublié ? » : envoie l'e-mail de réinitialisation standard.
 * Au clic sur le lien reçu, l'utilisateur revient connecté et l'événement
 * PASSWORD_RECOVERY ouvre la fenêtre « Nouveau mot de passe ».
 */
async function envoyerReinitialisationMdp() {
  if (!sbClient) return;
  const email = document.getElementById("connexion-email").value.trim();
  if (!emailValide(email)) {
    statutConnexion("Écris d'abord ton adresse e-mail ci-dessus, puis reclique " +
      "sur « Mot de passe oublié ? ».", true);
    return;
  }
  statutConnexion("Envoi de l'e-mail de réinitialisation…");
  const { error } = await sbClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) { statutConnexion(traduireErreurAuth(error), true); return; }
  statutConnexion("✓ E-mail envoyé ! Clique sur le lien reçu : tu seras " +
    "connecté et invité à choisir un nouveau mot de passe.");
}

/** Branche les événements de la page de connexion (une seule fois au démarrage). */
function brancherPageConnexion() {
  const page = document.getElementById("page-connexion");
  if (!page) return;
  const form = document.getElementById("connexion-form");
  const bascule = document.getElementById("connexion-bascule-mdp");
  const oubli = document.getElementById("connexion-oubli");
  const rester = document.getElementById("connexion-rester");
  // Reflète le choix mémorisé (par défaut : coché = rester connecté), et
  // l'enregistre dès que la case change — l'onglet ouvert par le lien
  // magique lira ce choix pour ranger la session au bon endroit.
  if (rester) {
    rester.checked = choixResterConnecte();
    rester.addEventListener("change", () => enregistrerChoixRester(rester.checked));
  }
  // Un seul point d'entrée : la soumission du formulaire (clic sur le bouton
  // ou touche Entrée), routée selon le mode courant.
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (connexionAvecMdp) connecterMdpDepuisConnexion();
    else envoyerLienDepuisConnexion();
  });
  if (bascule) bascule.addEventListener("click", () => basculerModeConnexion(!connexionAvecMdp));
  if (oubli) oubli.addEventListener("click", envoyerReinitialisationMdp);
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

/* ---------- Modèle « Sur cet appareil » / « En ligne » (jalon S1) ---------
 * Jusqu'ici, un carnet local et sa version en ligne étaient fusionnés en un
 * seul objet, avec choix forcé en cas de divergence. Le nouveau modèle
 * représente les deux univers séparément, sans jamais écraser en silence :
 * l'onglet « En ligne » lit `etat.enLigne` (miroir de la table SQL, rafraîchi
 * à chaque synchro), l'onglet « Sur cet appareil » lit `etat.carnets`.
 *
 * S1 (ici) : construire ce miroir et la fonction de comparaison, sans rien
 * changer à l'UI actuelle.
 * S2 : accueil à deux onglets utilisant ces fonctions.
 * S3 : bouton « Envoyer vers... » (fusion additive).
 * S4 : suppression de l'ancien modal de conflit.
 * -------------------------------------------------------------------------- */

/** Fiches distantes reçues à la dernière synchro, indexées par uuid. */
function ficheDistantes() {
  if (!etat.enLigne) etat.enLigne = new Map();
  return etat.enLigne;
}

/**
 * Note ce qu'on vient de recevoir du serveur pour un uuid donné.
 * `fiche = null` retire l'entrée (utile si on découvre qu'elle n'existe plus).
 */
function noterFicheDistante(uuid, fiche) {
  const carte = ficheDistantes();
  if (fiche == null) carte.delete(uuid);
  else carte.set(uuid, fiche);
}

/** Remplace TOUTES les fiches connues (après un SELECT sans filtre). */
function remplacerFichesDistantes(lignes) {
  const carte = ficheDistantes();
  carte.clear();
  (lignes || []).forEach((r) => { if (r && r.uuid) carte.set(r.uuid, r); });
}

/**
 * État de synchronisation d'un carnet LOCAL vis-à-vis de sa version en ligne.
 * Renvoie l'un de :
 *   - "pas-connecte"       : pas de compte configuré/connecté, on ne sait rien.
 *   - "jamais-envoye"      : ce carnet n'a aucune fiche en ligne.
 *   - "synchronise"        : les deux dates coïncident, rien à faire.
 *   - "modifs-locales"     : modifié ici depuis la dernière synchro (à envoyer).
 *   - "distant-plus-recent": la version en ligne a évolué (à télécharger).
 *   - "divergent"          : modifié DES DEUX côtés depuis la dernière synchro.
 * Le pilotage de l'UI (pastilles, onglets) se base sur cette fonction.
 */
function statutSync(c) {
  if (!c || !nuageConfigure() || !nuageConnecte()) return "pas-connecte";
  const distant = ficheDistantes().get(c.uuid);
  if (!distant || distant.statut === "supprime") return "jamais-envoye";
  const dateLoc = tempsDe(c.modifieLe);
  const dateDis = tempsDe(distant.modifie_le);
  if (dateLoc === dateDis) return "synchronise";
  const dateSync = tempsDe(c.syncLe);
  const bougeLoc = dateLoc > dateSync;
  const bougeDis = dateDis > dateSync;
  // Sans syncLe (carnet d'avant ce mécanisme), on se rabat sur le simple
  // « le plus récent gagne » — pas de divergence spéculée sur l'inconnu.
  if (!c.syncLe) return dateLoc > dateDis ? "modifs-locales" : "distant-plus-recent";
  if (bougeLoc && bougeDis) return "divergent";
  if (bougeLoc) return "modifs-locales";
  return "distant-plus-recent";
}

/* ---------- Fusion « Envoyer vers un carnet en ligne » (jalon S3) ---------
 * Cas d'usage : « Lofoten (copie) » a été créé hors ligne pendant qu'on ne
 * pouvait pas envoyer, il a plus de souvenirs que sa version en ligne. On
 * veut verser son contenu dans « Lofoten » en ligne, sans en faire un
 * deuxième carnet en ligne.
 *
 * Stratégie : fusion ADDITIVE par id de souvenir. Ce qui existe seulement
 * dans le carnet local est ajouté ; ce qui existe déjà en ligne n'est jamais
 * modifié (on ne peut pas savoir si c'est plus récent). Un bilan clair
 * explique ce qui n'a pas été propagé.
 * -------------------------------------------------------------------------- */

/** Fusionne le contenu « source » (local) dans « base » (en ligne). Additif. */
function fusionAdditive(base, source) {
  const bilan = { ajoutesSouv: 0, ajoutesStock: 0, ajoutesAnnot: 0,
                  modifsIgnorees: 0, ajoutesGpx: 0 };
  const clone = JSON.parse(JSON.stringify(base));
  // Souvenirs (posés) — par id numérique. Deux souvenirs avec le même id des
  // deux côtés = c'est le même souvenir : on garde celui de la version en
  // ligne (on ne sait pas si sa version locale est plus récente ou pas).
  const idsSouv = new Set((clone.souvenirs || []).map((s) => s.id));
  (source.souvenirs || []).forEach((s) => {
    if (idsSouv.has(s.id)) {
      const enLigne = clone.souvenirs.find((x) => x.id === s.id);
      if (JSON.stringify(enLigne) !== JSON.stringify(s)) bilan.modifsIgnorees++;
    } else {
      clone.souvenirs = clone.souvenirs || [];
      clone.souvenirs.push(s);
      bilan.ajoutesSouv++;
    }
  });
  // Réserve (souvenirs sans position).
  const idsStock = new Set((clone.stock || []).map((s) => s.id));
  (source.stock || []).forEach((s) => {
    if (idsStock.has(s.id)) {
      const enLigne = clone.stock.find((x) => x.id === s.id);
      if (JSON.stringify(enLigne) !== JSON.stringify(s)) bilan.modifsIgnorees++;
    } else {
      clone.stock = clone.stock || [];
      clone.stock.push(s);
      bilan.ajoutesStock++;
    }
  });
  // Éléments posés (annotations, textes, pictos, dessins). Même règle.
  const idsAnn = new Set((clone.annotations || []).map((a) => a.id));
  (source.annotations || []).forEach((a) => {
    if (idsAnn.has(a.id)) {
      const enLigne = clone.annotations.find((x) => x.id === a.id);
      if (JSON.stringify(enLigne) !== JSON.stringify(a)) bilan.modifsIgnorees++;
    } else {
      clone.annotations = clone.annotations || [];
      clone.annotations.push(a);
      bilan.ajoutesAnnot++;
    }
  });
  // GPX supplémentaires (par id).
  const idsGpx = new Set((clone.gpx || []).map((g) => g.id));
  (source.gpx || []).forEach((g) => {
    if (!idsGpx.has(g.id)) {
      clone.gpx = clone.gpx || [];
      clone.gpx.push(g);
      bilan.ajoutesGpx++;
    }
  });
  // Le compteur d'id ne doit jamais reculer, sinon on risque de re-attribuer
  // un id déjà utilisé et de casser la fusion suivante.
  clone.prochainId = Math.max(base.prochainId || 1, source.prochainId || 1);
  return { fusionne: clone, bilan };
}

/** Bilan lisible d'une fusion pour l'affiche en toast. */
function decrireBilanFusion(bilan) {
  const total = bilan.ajoutesSouv + bilan.ajoutesStock + bilan.ajoutesAnnot + bilan.ajoutesGpx;
  const parts = [];
  if (bilan.ajoutesSouv)  parts.push(`${bilan.ajoutesSouv} souvenir(s) ajouté(s)`);
  if (bilan.ajoutesStock) parts.push(`${bilan.ajoutesStock} en réserve`);
  if (bilan.ajoutesAnnot) parts.push(`${bilan.ajoutesAnnot} élément(s) posé(s)`);
  if (bilan.ajoutesGpx)   parts.push(`${bilan.ajoutesGpx} tracé(s) GPX`);
  const debut = total === 0 ? "Aucun ajout" : parts.join(", ");
  const suite = bilan.modifsIgnorees
    ? ` — ${bilan.modifsIgnorees} modification(s) locale(s) NON envoyée(s) (déjà présente(s) en ligne, ligne préservée).`
    : "";
  return debut + suite;
}

/**
 * Récupère le contenu ACTUEL d'un carnet en ligne : depuis IndexedDB s'il est
 * disponible hors ligne, sinon en le téléchargeant du serveur.
 */
async function chargerContenuCible(c) {
  if (c.horsLigne) {
    const local = await dbChargerCle("carnet-" + c.id).catch(() => null);
    if (local) return local;
  }
  return telechargerCarnetResolu(c);
}

/**
 * Envoie le contenu d'un carnet LOCAL (jamais synchronisé) DANS un carnet
 * EN LIGNE existant. Fusion additive. Après succès, le carnet local prend
 * l'uuid du carnet cible et est retiré de la liste (il devient LA copie
 * locale de la cible).
 */
async function envoyerVersCarnetEnLigne(carnetLocal, cible) {
  if (!nuageConnecte()) { toast("Connecte-toi d'abord.", true); return false; }
  if (!carnetLocal || !cible || carnetLocal.uuid === cible.uuid) return false;
  if (cible.partage && cible.partage.droit !== "edition") {
    toast("Ce carnet cible est en lecture seule — impossible d'y envoyer.", true);
    return false;
  }
  toast(`Envoi du contenu de « ${carnetLocal.nom} » vers « ${cible.nom} »…`);

  try {
    const source = await dbChargerCle("carnet-" + carnetLocal.id);
    if (!carnetADuContenu(source)) {
      toast("Ce carnet n'a rien à envoyer.", true); return false;
    }
    const base = await chargerContenuCible(cible);
    if (!base) { toast("Impossible de récupérer la cible.", true); return false; }
    const { fusionne, bilan } = fusionAdditive(base, source);

    // On stocke le résultat en local sous l'id de la CIBLE (l'utilisateur
    // gardera « Lofoten » disponible hors ligne enrichi), puis on pousse.
    await dbSauverCle("carnet-" + cible.id, fusionne);
    cible.horsLigne = true;
    cible.modifieLe = new Date().toISOString();

    // Rattacher le carnet local à la cible en mémoire, pour que la synchro
    // qui suit voie « Lofoten » et pas « Lofoten (copie) ».
    const ancienId = carnetLocal.id;
    // Sauvegarde de secours de l'ancien contenu local, au cas où (jamais perdu).
    try { await sauvegarderCopieSecours(ancienId); } catch (e) {}
    try { await dbEffacerCle("carnet-" + ancienId); } catch (e) {}
    etat.carnets = etat.carnets.filter((c) => c.id !== ancienId);
    if (etat.carnetActifId === ancienId) etat.carnetActifId = cible.id;

    // On envoie la cible enrichie.
    if (cible.id === etat.carnetActifId && typeof restaurerCarnet === "function") {
      restaurerCarnet(fusionne);
    }
    await pousserCarnet(cible);
    await sauverIndexCarnets();
    if (typeof renderCarnets === "function") renderCarnets();

    toast(`✓ Envoyé vers « ${cible.nom} ». ${decrireBilanFusion(bilan)}`);
    return true;
  } catch (e) {
    toast("L'envoi a échoué : " + ((e && e.message) || "réessaie plus tard."), true);
    return false;
  }
}

/** Liste des carnets EN LIGNE (à moi) où on peut envoyer le contenu d'un local. */
function ciblesEnvoiPossibles() {
  return (etat.carnets || []).filter((c) =>
    c.syncLe && !c.partage && (c.statut || "actif") !== "archive"
  );
}

/** Ouvre la fenêtre « Envoyer vers... » pour un carnet local jamais synchronisé. */
function ouvrirModalEnvoi(carnetLocal) {
  const modal = document.getElementById("modal-envoi");
  if (!modal || !carnetLocal) return;
  document.getElementById("envoi-source-nom").textContent = `« ${carnetLocal.nom} »`;
  const cibles = ciblesEnvoiPossibles();
  const select = document.getElementById("envoi-cible");
  const vide = document.getElementById("envoi-vide");
  const valider = document.getElementById("envoi-valider");
  select.innerHTML = "";
  cibles.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    opt.textContent = (c.logo ? c.logo + " " : "") + c.nom;
    select.appendChild(opt);
  });
  const aucune = cibles.length === 0;
  select.hidden = aucune;
  vide.hidden = !aucune;
  valider.disabled = aucune;
  modal.hidden = false;

  // Un seul brancheur par ouverture pour éviter les doublons.
  valider.onclick = async () => {
    const cible = cibles.find((c) => String(c.id) === select.value);
    if (!cible) return;
    valider.disabled = true;
    const ok = await envoyerVersCarnetEnLigne(carnetLocal, cible);
    valider.disabled = false;
    if (ok) modal.hidden = true;
  };
}

function fermerModalEnvoi() {
  const modal = document.getElementById("modal-envoi");
  if (modal) modal.hidden = true;
}

/** Fiches distantes n'ayant PAS de carnet local correspondant (à télécharger). */
function fichesDistantesSeules() {
  if (!nuageConnecte()) return [];
  const carte = ficheDistantes();
  const uuidsLocaux = new Set((etat.carnets || []).map((c) => c.uuid));
  const seules = [];
  for (const [uuid, fiche] of carte) {
    if (!fiche || fiche.statut === "supprime") continue;
    if (!uuidsLocaux.has(uuid)) seules.push(fiche);
  }
  return seules;
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

/** Recharge la table des droits des carnets partagés AVEC MOI (par e-mail
 *  ET par contact — on garde le plus permissif si les deux tables donnent
 *  un droit sur le même carnet). */
async function chargerDroitsPartages() {
  droitsPartages = new Map();
  if (!nuageConnecte()) return;
  const noterDroit = (uuid, droit) => {
    const d = droit === "edition" ? "edition" : "lecture";
    const actuel = droitsPartages.get(uuid);
    if (actuel !== "edition") droitsPartages.set(uuid, d);
  };
  // 1) Ancienne table (partage par e-mail) — encore lue pour compatibilité.
  try {
    const mail = (sessionNuage.user.email || "").toLowerCase();
    const { data } = await sbClient.from("carnet_partages").select("carnet_uuid, email, droit");
    (data || []).forEach((p) => {
      if ((p.email || "").toLowerCase() === mail) noterDroit(p.carnet_uuid, p.droit);
    });
  } catch (e) { /* table absente (SQL pas encore joué) : pas de partages */ }
  // 2) Nouvelle table (partage par contact / user_id) — source principale.
  try {
    const monId = sessionNuage.user.id;
    const { data } = await sbClient.from("carnet_partages_contact")
      .select("carnet_uuid, droit").eq("destinataire", monId);
    (data || []).forEach((p) => noterDroit(p.carnet_uuid, p.droit));
  } catch (e) { /* table absente (SQL 9 pas encore joué) : pas de partages contact */ }
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

/**
 * Bascule un carnet en "sauvegarde hors ligne" : télécharge son contenu et
 * marque le flag horsLigne=true. Ou retire cette sauvegarde : efface le
 * contenu local et remet horsLigne=false (le carnet reste visible : il vit
 * en ligne, il faudra juste une connexion pour l'ouvrir à nouveau).
 */
async function basculerHorsLigne(c) {
  if (!c) return;
  if (!nuageConnecte()) {
    toast("Connecte-toi pour changer la sauvegarde hors ligne.", true);
    return;
  }
  // Interdit pour les carnets partages en LECTURE : on ne veut pas qu'un
  // destinataire garde une copie apres retrait du partage.
  if (c.partage && c.partage.droit !== "edition") {
    toast("Ce carnet t'a ete partage en lecture seule : pas de sauvegarde hors ligne.", true);
    return;
  }
  if (c.horsLigne) {
    // Retirer de l'appareil. On ne touche pas au carnet ouvert : sinon on
    // perdrait la version en mémoire (potentiellement modifiée non poussée).
    if (c.id === etat.carnetActifId) {
      toast("Ferme d'abord ce carnet (retour à la carte globale) pour retirer sa sauvegarde hors ligne.", true);
      return;
    }
    try { await dbEffacerCle("carnet-" + c.id); } catch (e) {}
    c.horsLigne = false;
    await sauverIndexCarnets();
    if (typeof renderCarnets === "function") renderCarnets();
    toast(`« ${c.nom} » : sauvegarde hors ligne retirée.`);
    return;
  }
  // Ajouter : on télécharge maintenant.
  toast(`Téléchargement de « ${c.nom} »…`);
  try {
    const donnees = await telechargerCarnetResolu(c);
    if (!carnetADuContenu(donnees)) {
      // Rien de significatif en ligne : on marque quand même hors ligne
      // (l'utilisateur pourra le modifier hors connexion à son ouverture).
    } else {
      await dbSauverCle("carnet-" + c.id, donnees);
    }
    c.horsLigne = true;
    marquerCarnetSynchronise(c);
    await sauverIndexCarnets();
    if (typeof renderCarnets === "function") renderCarnets();
    toast(`✓ « ${c.nom} » est maintenant disponible hors ligne.`);
  } catch (e) {
    toast("Le téléchargement a échoué — réessaie plus tard.", true);
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
  const noms = [];
  let detailErreur = "";

  try {
    await chargerDroitsPartages();
    let requete = sbClient.from("carnets").select("*");
    if (uuidCible) requete = requete.eq("uuid", uuidCible);
    const { data: lignes, error } = await requete;
    if (error) throw error;
    const distants = lignes || [];
    // Miroir en mémoire des fiches distantes — utilisé par statutSync() pour
    // savoir où en est chaque carnet local par rapport au serveur (jalon S1).
    // Sur une synchro ciblée, on met à jour seulement cette entrée-là ; sur
    // une synchro complète, on remplace tout d'un coup.
    if (uuidCible) {
      const trouvee = distants.find((r) => r.uuid === uuidCible);
      noterFicheDistante(uuidCible, trouvee || null);
    } else {
      remplacerFichesDistantes(distants);
    }
    const monId = sessionNuage.user.id;
    const parUuid = new Map(etat.carnets.map((c) => [c.uuid, c]));

    // 0) Retrait de partage : un carnet qui m'etait partage mais qui n'est
    // plus dans les distants (le proprietaire a supprime la ligne
    // carnet_partages_contact) doit disparaitre chez moi. Sans ce nettoyage,
    // la fiche restait dans etat.carnets et le contenu hors ligne persistait.
    if (!uuidCible) {
      const uuidsDistants = new Set(distants.map((r) => r.uuid));
      const partagesRetires = etat.carnets.filter(
        (c) => c.partage && c.uuid && !uuidsDistants.has(c.uuid)
      );
      for (const c of partagesRetires) {
        try { await dbEffacerCle("carnet-" + c.id); } catch (e) {}
        if (typeof retirerFantome === "function") retirerFantome(c.id);
        const etaitActif = c.id === etat.carnetActifId;
        etat.carnets = etat.carnets.filter((x) => x.id !== c.id);
        parUuid.delete(c.uuid);
        if (etaitActif && typeof basculerVersAutreCarnetActif === "function") {
          await basculerVersAutreCarnetActif();
        }
      }
      if (partagesRetires.length) {
        toast(partagesRetires.length === 1
          ? `« ${partagesRetires[0].nom} » ne t'est plus partage.`
          : `${partagesRetires.length} carnets partages retires.`);
      }
    }

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
            // Nouveau modele : les carnets cloud ne sont plus telecharges
            // automatiquement. Ils apparaissent dans la liste, le contenu
            // arrivera a l'ouverture (ou via « Sauvegarder hors ligne »).
            horsLigne: false,
            partage,
          };
          etat.carnets.push(entree);
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
          // Plutôt que d'interrompre l'utilisateur avec un modal (destructeur
          // dans les deux sens), on met la version LOCALE de côté comme un
          // carnet séparé « (conflit du JJ/MM) » — l'utilisateur peut ensuite
          // « Envoyer vers... » pour la fusionner à l'original s'il le souhaite.
          // Puis la version en ligne s'installe normalement.
          await preserverVersionLocaleEnConflit(local);
          await descendreCarnetDepuisNuage(local, r, partage);
          recus++;
        } else if (dateDistante > dateLocale) {
          // Le nuage est plus récent. Deux cas :
          // - Carnet marqué « hors ligne » : on télécharge la nouvelle version
          //   dans IndexedDB pour rester utilisable sans réseau, comme avant.
          // - Sinon : on met juste les métadonnées à jour et on efface tout
          //   contenu local qui traînerait (il sera retéléchargé à l'ouverture).
          if (local.horsLigne || local.id === etat.carnetActifId) {
            // Même règle qu'au-dessus : si le local semble plus riche, on
            // le préserve avant d'appliquer la version en ligne. Silencieux.
            const avant = await lireContenuLocal(local.id);
            const apres = await telechargerCarnetNuage(local).catch(() => null);
            if (peutEcrireNuage(local) && risqueDePerte(avant, apres)) {
              await preserverVersionLocaleEnConflit(local);
            }
            await descendreCarnetDepuisNuage(local, r, partage);
            recus++;
          } else {
            appliquerFicheDistante(local, r, partage);
            try { await dbEffacerCle("carnet-" + local.id); } catch (e) {}
            marquerCarnetSynchronise(local);
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
    // Plus besoin d'exclure des uuid en conflit : la phase 1 résout tout
    // silencieusement (keep-both), donc quand on arrive ici, chaque carnet
    // local est soit synchronisé, soit à envoyer.
    for (const c of etat.carnets) {
      if (uuidCible && c.uuid !== uuidCible) continue;
      if (!peutEcrireNuage(c)) continue;
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

  // Les vrais conflits ont déjà été résolus silencieusement pendant la phase 1
  // (voir preserverVersionLocaleEnConflit) : un toast rappelle où retrouver
  // les copies « (conflit du ...) » gardées côté « Créés hors ligne ».
  if (conflitsResolus.length) {
    toast(`${conflitsResolus.length} carnet(s) présent(s) ici ET en ligne avec ` +
          `des modifs différentes : ta version locale a été gardée sous « ` +
          `${conflitsResolus[0]} (conflit du ${new Date().toLocaleDateString("fr-FR")}) ` +
          `», visible dans « Créés hors ligne ». À toi de la fusionner via ` +
          `« 📤 Envoyer vers un carnet en ligne » si tu veux.`);
    conflitsResolus.length = 0;
  }
}

/* =========================================================
   Résolution automatique des conflits (jalon S4)
   ---------------------------------------------------------
   Ancienne approche : un modal interrompait l'utilisateur pour choisir quelle
   version garder (ici / en ligne / les deux). Trop agressif, et un mauvais
   clic pouvait faire disparaître des souvenirs.

   Nouvelle approche : keep-both silencieux. Quand un carnet a été modifié
   des deux côtés depuis la dernière synchro, la VERSION LOCALE est mise à
   l'abri dans un nouveau carnet « <nom> (conflit du JJ/MM) » (jamais
   synchronisé, visible dans « Créés hors ligne »), puis la version en ligne
   s'installe normalement. L'utilisateur peut ensuite « Envoyer vers... »
   pour fusionner (jalon S3) — ou juste garder les deux séparément.

   Zéro interruption, zéro perte.
   ========================================================= */

// Noms des carnets pour lesquels un keep-both vient d'être fait pendant cette
// synchro (pour le toast récapitulatif à la fin).
const conflitsResolus = [];

/**
 * Copie la version LOCALE actuelle d'un carnet dans un NOUVEAU carnet
 * « (conflit du JJ/MM) », gardé hors ligne et non synchronisé. Le carnet
 * original garde son uuid — la version en ligne pourra donc l'écraser sans
 * qu'on perde le travail local.
 */
async function preserverVersionLocaleEnConflit(local) {
  try {
    const contenuLocal = await lireContenuLocal(local.id);
    if (!carnetADuContenu(contenuLocal)) return; // rien à sauver
    const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
    const jour = new Date().toLocaleDateString("fr-FR");
    const nomCopie = (local.nom + ` (conflit du ${jour})`).slice(0, 80);
    const copie = {
      id, uuid: genUuid(), visible: true,
      nom: nomCopie,
      logo: local.logo || "", categorie: local.categorie || "",
      description: local.description || "", du: local.du || "", au: local.au || "",
      modifieLe: new Date().toISOString(), syncLe: "",
      zone: local.zone || null, formatZone: local.formatZone || "",
      orientationZone: local.orientationZone === "paysage" ? "paysage" : "portrait",
      statut: "actif", partage: null,
      horsLigne: true, // dispo hors ligne : c'est le contenu qui compte
    };
    etat.carnets.push(copie);
    await dbSauverCle("carnet-" + id, contenuLocal);
    conflitsResolus.push(local.nom);
  } catch (e) {
    // Si la copie de secours échoue, on préfère se rétracter plutôt que
    // d'écraser sans filet — on laisse tomber la synchro de ce carnet.
    throw e;
  }
}

/** Contenu local d'un carnet (celui en mémoire s'il est ouvert). */
async function lireContenuLocal(id) {
  if (id === etat.carnetActifId) return serialiserCarnet();
  return await dbChargerCle("carnet-" + id).catch(() => null);
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
    // Charge la liste des contacts en arriere-plan pour l'onglet dedie.
    chargerContacts().then(renderContacts).catch(() => {});
  } else {
    const mdpConn = document.getElementById("compte-mdp-connexion");
    if (mdpConn) mdpConn.value = "";
  }
  const rester = document.getElementById("compte-rester");
  if (rester) rester.checked = choixResterConnecte();
  document.getElementById("modal-compte").hidden = false;
}

function fermerModalCompte() {
  document.getElementById("modal-compte").hidden = true;
}

/* =========================================================
   Fenêtre « Partager ce carnet »
   ---------------------------------------------------------
   Deux façons de partager :
   - avec un contact accepté (ajout instantané dans carnet_partages_contact) ;
   - via un lien à copier (un token dans carnet_liens_partage ; la personne
     rejoint en visitant ?rejoindrepartage=TOKEN une fois connectée).
   ========================================================= */

let partageCarnetOuvert = null;   // le carnet actuellement partagé (fiche)
let partagesActuels = [];         // rows de carnet_partages_contact pour ce carnet
let filtrePartageContacts = "";   // filtre de la liste de contacts

/** Ouvre la fenêtre de partage pour le carnet donné (par défaut : le carnet actif). */
async function ouvrirModalPartage(carnet) {
  const c = carnet || (typeof carnetActif === "function" ? carnetActif() : null);
  if (!c) { toast("Ouvre d'abord un carnet.", true); return; }
  if (!nuageConnecte()) { toast("Connecte-toi pour partager un carnet.", true); return; }
  if (c.partage) {
    toast("Ce carnet t'a été partagé — seul son propriétaire peut le partager.", true);
    return;
  }
  partageCarnetOuvert = c;
  document.getElementById("partage-nom-carnet").textContent = "« " + (c.nom || "carnet") + " »";
  document.getElementById("partage-recherche").value = "";
  document.getElementById("partage-lien-affiche").hidden = true;
  document.getElementById("partage-lien-url").value = "";
  statutPartage("");
  filtrePartageContacts = "";
  document.getElementById("modal-partage").hidden = false;

  // On charge en parallèle : contacts (pour la liste) + partages actuels.
  await Promise.all([chargerContacts(), chargerPartagesActuels(c)]);
  renderPartageContacts();
  renderPartageActuels();
}

function fermerModalPartage() {
  document.getElementById("modal-partage").hidden = true;
  partageCarnetOuvert = null;
  partagesActuels = [];
}

function statutPartage(message, erreur) {
  const el = document.getElementById("partage-statut");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
}

/** Charge la liste des personnes qui ont déjà accès à ce carnet. */
async function chargerPartagesActuels(carnet) {
  if (!nuageConnecte() || !carnet || !carnet.uuid) { partagesActuels = []; return; }
  const { data, error } = await sbClient.from("carnet_partages_contact")
    .select("id, destinataire, droit, cree_le")
    .eq("carnet_uuid", carnet.uuid)
    .eq("proprietaire", sessionNuage.user.id);
  if (error) { partagesActuels = []; return; }
  partagesActuels = data || [];
  // Assurer que les profils des destinataires sont dans le cache contacts.
  const idsAAjouter = partagesActuels
    .map((p) => p.destinataire)
    .filter((id) => !contactsCache.profils.has(id));
  if (idsAAjouter.length) {
    const { data: pdata } = await sbClient.from("profils")
      .select("id, pseudo, photo, description, ville")
      .in("id", idsAAjouter);
    (pdata || []).forEach((p) => contactsCache.profils.set(p.id, p));
  }
}

/** Rend la liste des contacts partageables (mes contacts acceptés, filtrés). */
function renderPartageContacts() {
  const cont = document.getElementById("partage-contacts");
  if (!cont) return;
  cont.innerHTML = "";
  const monId = sessionNuage.user.id;
  const contactsIds = contactsCache.relations
    .filter((r) => r.statut === "accepte")
    .map((r) => r.expediteur === monId ? r.destinataire : r.expediteur);
  if (contactsIds.length === 0) {
    cont.innerHTML = '<p class="style-aide contacts-vide">Ajoute d\'abord des contacts (fenêtre Paramètres → Contacts) pour pouvoir leur partager un carnet.</p>';
    return;
  }
  const dejaLies = new Set(partagesActuels.map((p) => p.destinataire));
  const filtre = (filtrePartageContacts || "").trim().toLowerCase();
  let affiche = 0;
  contactsIds.forEach((id) => {
    const profil = contactsCache.profils.get(id);
    const pseudo = (profil && profil.pseudo) || "";
    if (filtre && !pseudo.toLowerCase().includes(filtre)) return;
    affiche++;
    const dejaPartage = dejaLies.has(id);
    const action = dejaPartage
      ? { label: "Déjà partagé", classe: "btn btn-ghost btn-petit", handler: () => {} }
      : { label: "Partager", classe: "btn btn-accent btn-petit", handler: async () => {
          await ajouterPartageContact(id, "lecture");
        }};
    cont.appendChild(construireLigneContact(profil || { id, pseudo: "?" }, [action]));
  });
  if (affiche === 0) {
    cont.innerHTML = '<p class="style-aide contacts-vide">Personne ne correspond au filtre.</p>';
  }
}

/** Rend la liste des personnes qui ont déjà accès à ce carnet. */
function renderPartageActuels() {
  const cont = document.getElementById("partage-actuels");
  if (!cont) return;
  cont.innerHTML = "";
  if (partagesActuels.length === 0) {
    cont.innerHTML = '<p class="style-aide contacts-vide">Personne d\'autre n\'a accès à ce carnet pour le moment.</p>';
    return;
  }
  partagesActuels.forEach((p) => {
    const profil = contactsCache.profils.get(p.destinataire) || { pseudo: "?" };
    const droitAlt = p.droit === "edition" ? "lecture" : "edition";
    const actions = [
      { label: p.droit === "edition" ? "✏️ Édition" : "👁 Lecture",
        classe: "btn btn-ghost btn-petit",
        handler: async () => { await changerDroitPartage(p, droitAlt); }},
      { label: "Retirer", classe: "btn btn-ghost btn-petit",
        handler: async () => {
          if (!confirm(`Retirer @${profil.pseudo} de ce partage ?`)) return;
          await retirerPartageContact(p);
        }},
    ];
    cont.appendChild(construireLigneContact(profil, actions));
  });
}

async function ajouterPartageContact(contactId, droit) {
  if (!partageCarnetOuvert) return;
  const { error } = await sbClient.from("carnet_partages_contact").insert({
    proprietaire: sessionNuage.user.id,
    carnet_uuid: partageCarnetOuvert.uuid,
    destinataire: contactId,
    droit,
  });
  if (error) {
    statutPartage("Impossible d'ajouter : " + (error.message || "erreur"), true);
    return;
  }
  await chargerPartagesActuels(partageCarnetOuvert);
  renderPartageContacts();
  renderPartageActuels();
  toast("✓ Carnet partagé.");
}

async function retirerPartageContact(row) {
  const { error } = await sbClient.from("carnet_partages_contact").delete().eq("id", row.id);
  if (error) { statutPartage("Impossible de retirer : " + (error.message || ""), true); return; }
  await chargerPartagesActuels(partageCarnetOuvert);
  renderPartageContacts();
  renderPartageActuels();
  toast("Partage retiré.");
}

async function changerDroitPartage(row, nouveauDroit) {
  const { error } = await sbClient.from("carnet_partages_contact")
    .update({ droit: nouveauDroit }).eq("id", row.id);
  if (error) { statutPartage("Impossible de changer le droit : " + (error.message || ""), true); return; }
  await chargerPartagesActuels(partageCarnetOuvert);
  renderPartageActuels();
}

/** Génère un lien de partage (token) et l'affiche dans un champ à copier. */
async function genererLienPartage() {
  if (!partageCarnetOuvert) return;
  const droit = document.getElementById("partage-lien-droit").value;
  const bouton = document.getElementById("partage-lien-generer");
  await avecChargement(bouton, "Génération…", (async () => {
    const token = genererToken(24);
    const { error } = await sbClient.from("carnet_liens_partage").insert({
      token,
      proprietaire: sessionNuage.user.id,
      carnet_uuid: partageCarnetOuvert.uuid,
      droit,
    });
    if (error) { statutPartage("Impossible de créer le lien : " + (error.message || ""), true); return; }
    const url = window.location.origin + window.location.pathname + "?rejoindrepartage=" + token;
    document.getElementById("partage-lien-url").value = url;
    document.getElementById("partage-lien-affiche").hidden = false;
    statutPartage("✓ Lien créé. Copie-le et envoie-le à qui tu veux.");
  })());
}

function genererToken(nbCaracteres) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const arr = new Uint8Array(nbCaracteres);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => alphabet[b % alphabet.length]).join("");
}

/** Au démarrage : si l'URL contient ?rejoindrepartage=TOKEN, on le consomme. */
async function rejoindrePartageDepuisUrl() {
  const params = new URLSearchParams(window.location.search);
  let token = params.get("rejoindrepartage");
  // Sinon on tente le token mis de cote lors d'une precedente ouverture non connectee.
  if (!token) {
    try { token = sessionStorage.getItem("partage-token-en-attente"); } catch (e) {}
  }
  if (!token) return;
  if (!nuageConnecte()) {
    try { sessionStorage.setItem("partage-token-en-attente", token); } catch (e) {}
    toast("Connecte-toi pour rejoindre le partage.");
    return;
  }
  // Nettoie l'URL pour ne pas re-consommer au refresh.
  history.replaceState({}, "", window.location.pathname);
  try { sessionStorage.removeItem("partage-token-en-attente"); } catch (e) {}
  try {
    const { data: lien, error } = await sbClient.from("carnet_liens_partage")
      .select("token, proprietaire, carnet_uuid, droit, revoque")
      .eq("token", token).maybeSingle();
    if (error || !lien || lien.revoque) { toast("Ce lien n'est plus valide.", true); return; }
    if (lien.proprietaire === sessionNuage.user.id) {
      toast("C'est ton propre carnet — rien à rejoindre."); return;
    }
    const { error: err2 } = await sbClient.from("carnet_partages_contact").insert({
      proprietaire: lien.proprietaire,
      carnet_uuid: lien.carnet_uuid,
      destinataire: sessionNuage.user.id,
      droit: lien.droit,
    });
    if (err2 && err2.code !== "23505") { toast("Impossible de rejoindre : " + (err2.message || ""), true); return; }
    toast("✓ Tu as maintenant accès à ce carnet — synchro en cours…");
    synchroniserNuage();
  } catch (e) {
    toast("Ce lien n'a pas pu être consommé.", true);
  }
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
    // Restauration de session en cours (jeton en stock, pas encore tranché) :
    // on ne montre pas « Se connecter », qui serait trompeur.
    const enCours = !demarrageResolu && tokenSessionPresent();
    if (nomEl) nomEl.textContent = enCours ? "Connexion…" : "Se connecter";
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
  noterChoixResterDepuis("compte-rester");
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
  noterChoixResterDepuis("compte-rester");
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

/* =========================================================
   Onglet Contacts (jalon C)
   ---------------------------------------------------------
   Une demande = une ligne dans `public.contacts` (statut = 'en_attente').
   Une amitié  = la même ligne, statut = 'accepte'.
   Un refus / une annulation / un retrait = suppression de la ligne.
   Les profils (photo, pseudo, ville) sont joints depuis `profils`.
   ========================================================= */

// Cache mémoire des relations et des profils joints (rechargé à l'ouverture).
let contactsCache = { relations: [], profils: new Map() };

/** Cherche des profils dont le pseudo commence par `q` (insensible à la casse). */
async function chercherProfils(q) {
  if (!nuageConnecte()) return [];
  const requete = (q || "").trim().toLowerCase();
  if (requete.length < 2) return [];
  const { data, error } = await sbClient
    .from("profils")
    .select("id, pseudo, photo, description, ville")
    .ilike("pseudo", requete + "%")
    .neq("id", sessionNuage.user.id)  // pas moi-même
    .limit(20);
  if (error) return [];
  return data || [];
}

/** Charge toutes mes relations (envoyées, reçues, acceptées) et les profils liés. */
async function chargerContacts() {
  if (!nuageConnecte()) {
    contactsCache = { relations: [], profils: new Map() };
    return contactsCache;
  }
  const monId = sessionNuage.user.id;
  const { data: rels, error } = await sbClient
    .from("contacts")
    .select("id, expediteur, destinataire, statut, cree_le, modifie_le")
    .or(`expediteur.eq.${monId},destinataire.eq.${monId}`);
  if (error) {
    contactsCache = { relations: [], profils: new Map() };
    return contactsCache;
  }
  const relations = rels || [];
  // Récupère les profils de tous les autres membres, en un seul appel.
  const autresIds = [...new Set(relations.map((r) =>
    r.expediteur === monId ? r.destinataire : r.expediteur))];
  const profils = new Map();
  if (autresIds.length) {
    const { data: pdata } = await sbClient
      .from("profils")
      .select("id, pseudo, photo, description, ville")
      .in("id", autresIds);
    (pdata || []).forEach((p) => profils.set(p.id, p));
  }
  contactsCache = { relations, profils };
  return contactsCache;
}

/** Envoie une demande de contact à l'utilisateur `destinataireId`. */
async function envoyerDemandeContact(destinataireId) {
  if (!nuageConnecte()) { toast("Connecte-toi d'abord.", true); return false; }
  const { error } = await sbClient.from("contacts").insert({
    expediteur: sessionNuage.user.id,
    destinataire: destinataireId,
    statut: "en_attente",
  });
  if (error) {
    // 23505 = unique violation : la demande existe déjà (dans un sens).
    if (error.code === "23505") { toast("Demande déjà envoyée à ce contact.", true); return false; }
    toast("Impossible d'envoyer la demande : " + (error.message || ""), true);
    return false;
  }
  toast("✓ Demande envoyée.");
  return true;
}

/** Accepte une demande reçue (id de la ligne contacts). */
async function accepterDemandeContact(idDemande) {
  const { error } = await sbClient.from("contacts")
    .update({ statut: "accepte" })
    .eq("id", idDemande);
  if (error) { toast("Impossible d'accepter : " + (error.message || ""), true); return false; }
  toast("✓ Contact ajouté.");
  return true;
}

/** Supprime une relation : refuser, annuler ou retirer selon le contexte. */
async function supprimerContact(idDemande) {
  const { error } = await sbClient.from("contacts").delete().eq("id", idDemande);
  if (error) { toast("Impossible : " + (error.message || ""), true); return false; }
  return true;
}

/** Reconstruit les trois listes (reçues, envoyées, contacts) + résultats de recherche. */
function renderContacts() {
  if (!nuageConnecte()) return;
  const monId = sessionNuage.user.id;
  const { relations, profils } = contactsCache;

  const recues = relations.filter((r) => r.destinataire === monId && r.statut === "en_attente");
  const envoyees = relations.filter((r) => r.expediteur === monId && r.statut === "en_attente");
  const contacts = relations.filter((r) => r.statut === "accepte");

  const badgeRecues = document.getElementById("contacts-recues-nb");
  if (badgeRecues) {
    badgeRecues.textContent = recues.length;
    badgeRecues.hidden = recues.length === 0;
  }
  const badgeAmis = document.getElementById("contacts-nb");
  if (badgeAmis) {
    badgeAmis.textContent = contacts.length;
    badgeAmis.hidden = contacts.length === 0;
  }

  remplirBlocContacts("contacts-recues", recues, (r) => {
    const autre = profils.get(r.expediteur);
    return {
      profil: autre,
      actions: [
        { label: "Accepter", classe: "btn btn-accent btn-petit", handler: async () => {
          if (await accepterDemandeContact(r.id)) { await chargerContacts(); renderContacts(); }
        }},
        { label: "Refuser", classe: "btn btn-ghost btn-petit", handler: async () => {
          if (await supprimerContact(r.id)) { await chargerContacts(); renderContacts(); }
        }},
      ],
    };
  }, "Aucune demande reçue.");

  remplirBlocContacts("contacts-envoyees", envoyees, (r) => {
    const autre = profils.get(r.destinataire);
    return {
      profil: autre,
      actions: [
        { label: "Annuler", classe: "btn btn-ghost btn-petit", handler: async () => {
          if (await supprimerContact(r.id)) { await chargerContacts(); renderContacts(); }
        }},
      ],
      detail: "Demande envoyée",
    };
  }, "Aucune demande en attente.");

  remplirBlocContacts("contacts-liste", contacts, (r) => {
    const autreId = r.expediteur === monId ? r.destinataire : r.expediteur;
    const autre = profils.get(autreId);
    return {
      profil: autre,
      actions: [
        { label: "Retirer", classe: "btn btn-ghost btn-petit", handler: async () => {
          if (!confirm(`Retirer @${(autre && autre.pseudo) || "ce contact"} de tes contacts ?`)) return;
          if (await supprimerContact(r.id)) { await chargerContacts(); renderContacts(); }
        }},
      ],
    };
  }, "Tu n'as pas encore de contacts.");
}

/** Construit une ligne « profil + actions » et remplit le conteneur. */
function remplirBlocContacts(idContainer, lignes, faconneur, videTexte) {
  const cont = document.getElementById(idContainer);
  if (!cont) return;
  cont.innerHTML = "";
  if (lignes.length === 0) {
    const p = document.createElement("p");
    p.className = "style-aide contacts-vide";
    p.textContent = videTexte;
    cont.appendChild(p);
    return;
  }
  lignes.forEach((ligne) => {
    const { profil, actions, detail } = faconneur(ligne);
    cont.appendChild(construireLigneContact(profil, actions, detail));
  });
}

function construireLigneContact(profil, actions, detail) {
  const ligne = document.createElement("div");
  ligne.className = "contacts-ligne";
  const avatar = document.createElement("span");
  avatar.className = "compte-avatar";
  dessinerAvatar(avatar, profil || {}, (profil && profil.pseudo) || "?");
  ligne.appendChild(avatar);
  const corps = document.createElement("div");
  corps.className = "contacts-ligne-corps";
  const nom = document.createElement("span");
  nom.className = "contacts-ligne-nom";
  nom.textContent = profil ? "@" + profil.pseudo : "(profil introuvable)";
  corps.appendChild(nom);
  const det = document.createElement("span");
  det.className = "contacts-ligne-detail";
  det.textContent = detail || (profil && (profil.ville || profil.description)) || "";
  corps.appendChild(det);
  ligne.appendChild(corps);
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "contacts-ligne-actions";
  (actions || []).forEach((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = a.classe || "btn btn-ghost btn-petit";
    b.textContent = a.label;
    b.addEventListener("click", a.handler);
    actionsDiv.appendChild(b);
  });
  ligne.appendChild(actionsDiv);
  return ligne;
}

/** Résultats de recherche : profils trouvés → bouton « Ajouter ». */
async function lancerRechercheContact() {
  const input = document.getElementById("contacts-recherche");
  const bouton = document.getElementById("contacts-chercher");
  const cont = document.getElementById("contacts-resultats");
  if (!cont) return;
  const q = (input && input.value || "").trim();
  if (q.length < 2) {
    cont.innerHTML = '<p class="style-aide contacts-vide">Tape au moins 2 caractères.</p>';
    return;
  }
  await avecChargement(bouton, "Recherche…", (async () => {
    const trouves = await chercherProfils(q);
    // On enlève ceux avec qui on a déjà une relation (évite le doublon 23505).
    const monId = sessionNuage.user.id;
    const dejaLies = new Set(contactsCache.relations.map((r) =>
      r.expediteur === monId ? r.destinataire : r.expediteur));
    cont.innerHTML = "";
    if (trouves.length === 0) {
      cont.innerHTML = '<p class="style-aide contacts-vide">Aucun profil trouvé pour « ' +
        q.replace(/[<>&]/g, "") + ' ».</p>';
      return;
    }
    trouves.forEach((p) => {
      const dejaLie = dejaLies.has(p.id);
      const action = dejaLie
        ? { label: "Déjà lié", classe: "btn btn-ghost btn-petit", handler: () => {} }
        : { label: "Ajouter", classe: "btn btn-accent btn-petit", handler: async () => {
          if (await envoyerDemandeContact(p.id)) {
            await chargerContacts();
            renderContacts();
            lancerRechercheContact();
          }
        }};
      cont.appendChild(construireLigneContact(p, [action]));
    });
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

/**
 * Purge TOUS mes carnets (ici + en ligne : fiches, fichiers, photos, sons).
 * Ne touche PAS au compte, au profil (pseudo), aux contacts. Utile pour
 * repartir d'une base propre avant de réimporter des .json.
 *
 * L'utilisateur confirme deux fois avant que l'opération démarre — c'est
 * irréversible, aucun retour possible.
 */
async function purgerTousLesCarnets() {
  if (!nuageConnecte()) {
    toast("Connecte-toi d'abord (bouton ☁️ en haut).", true);
    return;
  }
  const ok1 = await demanderConfirmation(
    "Tout supprimer ?",
    "Cette action va effacer TOUS tes carnets — sur cet appareil ET sur ton " +
    "compte en ligne : fiches, tracés, souvenirs, photos et sons. Ton compte, " +
    "ton pseudo et tes contacts sont préservés. C'est irréversible.",
    { okLibelle: "Continuer" }
  );
  if (!ok1) return;
  const ok2 = await demanderConfirmation(
    "Vraiment tout supprimer ?",
    "Dernière confirmation. Tu as bien tes exports .json sur ton ordinateur ? " +
    "Une fois lancée, la purge ne peut pas être annulée.",
    { okLibelle: "Oui, tout supprimer" }
  );
  if (!ok2) return;

  toast("🧹 Purge en cours…");
  const monId = sessionNuage.user.id;
  let erreurs = 0;

  // 1) Storage : lister puis supprimer tous mes fichiers (carnet + médias).
  try {
    const chemins = [];
    // Racine de mon dossier (les .json des carnets sont ici).
    const { data: racine } = await sbClient.storage.from("carnets").list(monId);
    (racine || []).forEach((f) => { if (f && f.name) chemins.push(`${monId}/${f.name}`); });
    // Sous-dossier medias/.
    const { data: medias } = await sbClient.storage.from("carnets").list(`${monId}/medias`);
    (medias || []).forEach((f) => { if (f && f.name) chemins.push(`${monId}/medias/${f.name}`); });
    // Supprimer par lots de 100 (limite habituelle des APIs de storage).
    for (let i = 0; i < chemins.length; i += 100) {
      const lot = chemins.slice(i, i + 100);
      const { error } = await sbClient.storage.from("carnets").remove(lot);
      if (error) erreurs++;
    }
  } catch (e) { erreurs++; }

  // 2) Table `carnets` : je supprime toutes mes lignes (RLS m'y autorise déjà).
  try {
    const { error } = await sbClient.from("carnets").delete().eq("user_id", monId);
    if (error) erreurs++;
  } catch (e) { erreurs++; }

  // 3) Mes partages sortants (les carnets que J'AI partagés). Les tables
  //    du contact-graph — carnet_partages_contact — peuvent ne pas exister
  //    partout : on tolère l'erreur.
  try { await sbClient.from("carnet_partages").delete().eq("proprietaire", monId); } catch (e) {}
  try { await sbClient.from("carnet_partages_contact").delete().eq("proprietaire", monId); } catch (e) {}

  // 4) IndexedDB : effacer chaque carnet-<id>, ses secours, et l'index.
  try {
    for (const c of etat.carnets || []) {
      try { await dbEffacerCle("carnet-" + c.id); } catch (e) {}
      try { await dbEffacerCle("carnet-" + c.id + "-secours"); } catch (e) {}
    }
    try { await dbEffacerCle("index"); } catch (e) {}
  } catch (e) { erreurs++; }

  // 5) État en mémoire : vider les listes, le miroir en ligne, les fantômes.
  if (typeof retirerTousFantomes === "function") retirerTousFantomes();
  etat.carnets = [];
  etat.carnetActifId = 0;
  etat.carnetFocalise = null;
  if (etat.enLigne && typeof etat.enLigne.clear === "function") etat.enLigne.clear();
  if (typeof viderCarnetCourant === "function") viderCarnetCourant();

  // 6) Rafraîchir l'accueil.
  if (typeof renderCarnets === "function") renderCarnets();
  if (typeof majEtatSyncUI === "function") majEtatSyncUI();

  if (erreurs > 0) {
    toast(`Purge terminée avec ${erreurs} avertissement(s). Tu peux réimporter tes carnets.`, true);
  } else {
    toast("✓ Purge terminée. Tu peux réimporter tes carnets (📥 Importer sur la carte globale).");
  }
  fermerModalCompte();
}

/** Messages d'erreur Supabase → français simple. */
function traduireErreurAuth(error) {
  const m = (error && error.message) || "";
  if (/invalid login credentials|invalid_credentials/i.test(m)) {
    return "E-mail ou mot de passe incorrect. Vérifie ta saisie — ou utilise " +
      "« Mot de passe oublié ? » pour en choisir un nouveau.";
  }
  if (/rate limit|too many|after \d+ seconds/i.test(m)) {
    return "Trop de tentatives d'affilée — attends une minute et réessaie.";
  }
  if (/email not confirmed/i.test(m)) {
    return "Cette adresse n'a pas encore été confirmée : connecte-toi une " +
      "première fois via le lien reçu par e-mail.";
  }
  if (/should be different from the old password/i.test(m)) {
    return "Ce mot de passe est identique à l'ancien — choisis-en un différent.";
  }
  if (/password should be at least/i.test(m)) {
    return "Le mot de passe est trop court.";
  }
  if (/network|fetch/i.test(m)) return "Pas de connexion Internet pour l'instant.";
  return "Ça n'a pas marché : " + (m || "erreur inconnue.");
}

/* =========================================================
   Fenêtre « Nouveau mot de passe » (retour du lien de
   réinitialisation — événement PASSWORD_RECOVERY)
   ========================================================= */

function statutNouveauMdp(message, erreur) {
  const el = document.getElementById("nouveau-mdp-statut");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.className = "gen-statut " + (erreur ? "erreur" : "info");
}

function ouvrirModalNouveauMdp() {
  const modal = document.getElementById("modal-nouveau-mdp");
  if (!modal) return;
  document.getElementById("nouveau-mdp").value = "";
  document.getElementById("nouveau-mdp-confirm").value = "";
  statutNouveauMdp("");
  modal.hidden = false;
  setTimeout(() => document.getElementById("nouveau-mdp").focus(), 50);
}

function fermerModalNouveauMdp() {
  const modal = document.getElementById("modal-nouveau-mdp");
  if (modal) modal.hidden = true;
}

async function validerNouveauMdp() {
  const mdp = document.getElementById("nouveau-mdp").value;
  const confirm = document.getElementById("nouveau-mdp-confirm").value;
  if (mdp.length < 8) {
    statutNouveauMdp("Le mot de passe doit faire au moins 8 caractères.", true);
    return;
  }
  if (mdp !== confirm) {
    statutNouveauMdp("Les deux mots de passe ne sont pas identiques.", true);
    return;
  }
  const bouton = document.getElementById("nouveau-mdp-valider");
  await avecChargement(bouton, "Enregistrement…", (async () => {
    const { error } = await sbClient.auth.updateUser({ password: mdp });
    if (error) { statutNouveauMdp(traduireErreurAuth(error), true); return; }
    fermerModalNouveauMdp();
    toast("🔑 Nouveau mot de passe enregistré.");
  })());
}

function brancherNouveauMdpUI() {
  const modal = document.getElementById("modal-nouveau-mdp");
  if (!modal) return;
  document.getElementById("nouveau-mdp-valider").addEventListener("click", validerNouveauMdp);
  document.getElementById("nouveau-mdp-plus-tard").addEventListener("click", fermerModalNouveauMdp);
  document.getElementById("nouveau-mdp-confirm")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") validerNouveauMdp(); });
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

function brancherEnvoiUI() {
  const modal = document.getElementById("modal-envoi");
  if (!modal) return;
  document.getElementById("envoi-annuler").addEventListener("click", fermerModalEnvoi);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) { fermerModalEnvoi(); e.stopPropagation(); }
  }, true);
}

function brancherCompteUI() {
  brancherProfilUI();
  brancherEnvoiUI();
  brancherNouveauMdpUI();
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
  // Case « Rester connecté » de la fenêtre Compte : même choix partagé que
  // celle de la page de connexion.
  const compteRester = document.getElementById("compte-rester");
  if (compteRester) compteRester.addEventListener("change",
    () => enregistrerChoixRester(compteRester.checked));
  document.getElementById("compte-deconnecter")
    .addEventListener("click", deconnecterNuage);
  // Zone dangereuse : purge totale des carnets. Deux confirmations en amont
  // dans purgerTousLesCarnets, donc pas de garde supplémentaire ici.
  const btnPurger = document.getElementById("compte-purger-carnets");
  if (btnPurger) btnPurger.addEventListener("click", purgerTousLesCarnets);
  // Plus de bouton « Synchroniser maintenant » ni de clic sur le bandeau :
  // la synchro se fait automatiquement après chaque sauvegarde (voir
  // planifierPousseeNuage) et au démarrage (INITIAL_SESSION avec session).

  // Onglet Contacts.
  document.getElementById("contacts-chercher")
    .addEventListener("click", lancerRechercheContact);
  document.getElementById("contacts-recherche")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") lancerRechercheContact(); });

  // Fenetre Partager.
  document.getElementById("partage-fermer")
    .addEventListener("click", fermerModalPartage);
  document.getElementById("partage-recherche")
    .addEventListener("input", (e) => {
      filtrePartageContacts = e.target.value || "";
      renderPartageContacts();
    });
  document.getElementById("partage-lien-generer")
    .addEventListener("click", genererLienPartage);
  document.getElementById("partage-lien-copier")
    .addEventListener("click", async () => {
      const champ = document.getElementById("partage-lien-url");
      champ.select();
      try {
        await navigator.clipboard.writeText(champ.value);
        toast("✓ Lien copie dans le presse-papiers.");
      } catch (e) {
        // Fallback : la selection reste, l'utilisateur peut faire Ctrl+C.
        toast("Copie manuellement (Ctrl+C).");
      }
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

  // Échap ferme la fenêtre Compte / Profil / Partage (avant les autres raccourcis).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const partage = document.getElementById("modal-partage");
    if (partage && !partage.hidden) { fermerModalPartage(); e.stopPropagation(); return; }
    const profil = document.getElementById("modal-profil");
    if (profil && !profil.hidden) { fermerModalProfil(); e.stopPropagation(); return; }
    if (!document.getElementById("modal-compte").hidden) {
      fermerModalCompte();
      e.stopPropagation();
    }
  }, true);
}
