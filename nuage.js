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

const CLE_EPHEMERE = "nuage-ephemere";      // "1" = ne pas rester connecté
const CLE_SESSION_VUE = "nuage-session-vue"; // marqueur de session d'onglet
const CLE_PSEUDO = "carnet-pseudo";

/** Le nuage est-il configuré (clés présentes) ? */
function nuageConfigure() {
  const c = window.CONFIG_NUAGE || {};
  return !!(c.url && c.cle && window.supabase);
}

/** Est-on connecté à un compte ? */
function nuageConnecte() {
  return !!(sbClient && sessionNuage && sessionNuage.user);
}

/** Pseudo de l'utilisateur (compte, sinon celui noté sur l'appareil). */
function lirePseudo() {
  if (nuageConnecte()) {
    const p = sessionNuage.user.user_metadata && sessionNuage.user.user_metadata.pseudo;
    if (p) return p;
  }
  try { return localStorage.getItem(CLE_PSEUDO) || ""; } catch (e) { return ""; }
}

/** Enregistre le pseudo (sur l'appareil, et sur le compte si connecté). */
async function enregistrerPseudo(pseudo) {
  pseudo = (pseudo || "").trim().slice(0, 30);
  try { localStorage.setItem(CLE_PSEUDO, pseudo); } catch (e) {}
  if (nuageConnecte()) {
    try { await sbClient.auth.updateUser({ data: { pseudo } }); } catch (e) {}
  }
  if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();
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
    try { if (session) sessionStorage.setItem(CLE_SESSION_VUE, "1"); } catch (e) {}
    majCompteUI();
    if (typeof majTitreCarteGlobale === "function") majTitreCarteGlobale();

    if (evenement === "SIGNED_IN" && session) {
      // Retour du lien magique : on ferme la fenêtre Compte et on synchronise.
      fermerModalCompte();
      toast("☁️ Connecté ! Synchronisation de tes carnets…");
      synchroniserNuage();
    } else if (evenement === "INITIAL_SESSION") {
      if (session) synchroniserNuage();
      else if (typeof majPopupsAccueil === "function") majPopupsAccueil();
    }
  });
}

/* =========================================================
   Synchronisation
   ========================================================= */

/** Chemin du fichier JSON d'un carnet (dans le dossier de son propriétaire). */
function cheminNuage(c) {
  const proprietaire = (c.partage && c.partage.proprietaire) || sessionNuage.user.id;
  return `${proprietaire}/${c.uuid}.json`;
}

/** Télécharge le contenu complet d'un carnet depuis le stockage. */
async function telechargerCarnetNuage(c) {
  const { data, error } = await sbClient.storage.from("carnets").download(cheminNuage(c));
  if (error) throw error;
  return JSON.parse(await data.text());
}

/** Peut-on écrire ce carnet en ligne ? (le mien, ou partagé en édition) */
function peutEcrireNuage(c) {
  return !c.partage || c.partage.droit === "edition";
}

/** Envoie un carnet en ligne (contenu + fiche pour la liste). */
async function pousserCarnet(c) {
  if (!nuageConnecte() || !c || !c.uuid || !peutEcrireNuage(c)) return;

  // Le contenu complet : celui en mémoire pour le carnet ouvert, sinon la
  // sauvegarde locale. Un carnet encore vide n'a pas de fichier à envoyer.
  const donnees = c.id === etat.carnetActifId
    ? serialiserCarnet()
    : await dbChargerCle("carnet-" + c.id).catch(() => null);
  if (donnees && donnees.trace) {
    const blob = new Blob([JSON.stringify(donnees)], { type: "application/json" });
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
    modifie_le: c.modifieLe || new Date().toISOString(),
  };
  if (c.partage) {
    // Carnet partagé en édition : on met à jour la fiche du propriétaire.
    const { error } = await sbClient.from("carnets").update(fiche)
      .eq("uuid", c.uuid).eq("user_id", c.partage.proprietaire);
    if (error) throw error;
  } else {
    const { error } = await sbClient.from("carnets").upsert({
      user_id: sessionNuage.user.id, uuid: c.uuid, ...fiche,
    });
    if (error) throw error;
  }
}

/** Supprime un carnet en ligne (seulement s'il est à moi). */
async function supprimerCarnetNuage(carnet) {
  if (!nuageConnecte() || !carnet || !carnet.uuid) return;
  // Un carnet PARTAGÉ avec moi ne se supprime que de mon appareil.
  if (carnet.partage) return;
  try {
    await sbClient.storage.from("carnets").remove([cheminNuage(carnet)]);
    await sbClient.from("carnet_partages").delete().eq("carnet_uuid", carnet.uuid);
    await sbClient.from("carnets").delete().eq("uuid", carnet.uuid);
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
 * Synchronisation complète, dans les deux sens :
 * - les carnets en ligne (les miens + partagés avec moi) absents ou plus
 *   récents sont téléchargés ;
 * - les carnets locaux absents ou plus récents sont envoyés.
 */
async function synchroniserNuage() {
  if (!nuageConnecte() || syncEnCours) return;
  syncEnCours = true;
  statutCompte("Synchronisation en cours…");
  let recus = 0, envoyes = 0, erreurs = 0;

  try {
    await chargerDroitsPartages();
    const { data: lignes, error } = await sbClient.from("carnets").select("*");
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
        if (!local) {
          const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
          const entree = {
            id, uuid: r.uuid, visible: true,
            nom: r.nom || "Carnet", logo: r.logo || "", categorie: r.categorie || "",
            description: r.description || "", du: r.du || "", au: r.au || "",
            modifieLe: r.modifie_le || "",
            partage,
          };
          etat.carnets.push(entree);
          const donnees = await telechargerCarnetNuage(entree).catch(() => null);
          if (donnees && donnees.trace) await dbSauverCle("carnet-" + id, donnees);
          recus++;
        } else if (dateDistante > (Date.parse(local.modifieLe || 0) || 0)) {
          Object.assign(local, {
            nom: r.nom || local.nom, logo: r.logo || "", categorie: r.categorie || "",
            description: r.description || "", du: r.du || "", au: r.au || "",
            modifieLe: r.modifie_le || "",
            partage,
          });
          const donnees = await telechargerCarnetNuage(local).catch(() => null);
          if (donnees && donnees.trace) {
            await dbSauverCle("carnet-" + local.id, donnees);
            if (local.id === etat.carnetActifId) restaurerCarnet(donnees);
          }
          recus++;
        } else if (local) {
          local.partage = partage; // les droits peuvent avoir changé
        }
      } catch (e) { erreurs++; }
    }

    // 2) De l'appareil vers le nuage (jamais les partages en lecture seule).
    for (const c of etat.carnets) {
      if (!peutEcrireNuage(c)) continue;
      const r = distants.find((x) => x.uuid === c.uuid);
      const dateLocale = Date.parse(c.modifieLe || 0) || 0;
      const dateDistante = r ? (Date.parse(r.modifie_le || 0) || 0) : -1;
      if (!r || dateLocale > dateDistante) {
        try { await pousserCarnet(c); envoyes++; } catch (e) { erreurs++; }
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

    if (erreurs > 0) {
      statutCompte(`Synchronisation partielle (${erreurs} erreur(s)) — réessaie plus tard.`, true);
    } else {
      statutCompte("✓ Carnets synchronisés" +
        (recus || envoyes ? ` (${recus} reçu(s), ${envoyes} envoyé(s))` : ""));
      indiquerNuage();
    }
  } catch (e) {
    statutCompte("Synchronisation impossible (connexion ?).", true);
  } finally {
    syncEnCours = false;
    majCompteUI();
    if (typeof majPopupsAccueil === "function") majPopupsAccueil();
  }
}

/* ---------- Poussée automatique après chaque modification ---------- */

let timerNuage = null;

/** Replanifie l'envoi du carnet ouvert (appelé après chaque sauvegarde). */
function planifierPousseeNuage() {
  if (!nuageConnecte()) return;
  clearTimeout(timerNuage);
  timerNuage = setTimeout(async () => {
    try {
      await pousserCarnet(carnetActif());
      indiquerNuage();
    } catch (e) { /* hors ligne : la prochaine synchronisation rattrapera */ }
  }, 6000);
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
  document.getElementById("compte-bloc-connexion").hidden = nuageConnecte();
  document.getElementById("compte-bloc-connecte").hidden = !nuageConnecte();
  document.getElementById("compte-non-configure").hidden = nuageConfigure();
  if (nuageConnecte()) {
    document.getElementById("compte-email-affiche").textContent = sessionNuage.user.email;
    document.getElementById("compte-pseudo").value = lirePseudo();
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

/** Met à jour le bouton « Compte » de la barre du haut. */
function majCompteUI() {
  const btn = document.getElementById("compte-btn");
  if (!btn) return;
  if (!nuageConfigure()) {
    btn.textContent = "☁️ Compte";
    return;
  }
  btn.textContent = nuageConnecte()
    ? "☁️ " + (lirePseudo() || sessionNuage.user.email || "Connecté")
    : "☁️ Se connecter";
}

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

  statutCompte("Envoi du lien de connexion…");
  const { error } = await sbClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) {
    statutCompte(traduireErreurAuth(error), true);
    return;
  }
  statutCompte("✓ C'est envoyé ! Ouvre ta boîte mail et clique sur le lien de " +
    "connexion (regarde aussi les indésirables). Tu peux fermer cette fenêtre.");
}

/** Se déconnecte (les carnets restent sur l'appareil). */
async function deconnecterNuage() {
  await sbClient.auth.signOut();
  sessionNuage = null;
  majCompteUI();
  ouvrirModalCompte();
  statutCompte("Déconnecté. Tes carnets restent sur cet appareil.");
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
   Branchements
   ========================================================= */

function brancherCompteUI() {
  document.getElementById("compte-btn")
    .addEventListener("click", () => ouvrirModalCompte());
  document.getElementById("compte-fermer")
    .addEventListener("click", fermerModalCompte);
  document.getElementById("compte-lien")
    .addEventListener("click", envoyerLienMagique);
  document.getElementById("compte-email")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") envoyerLienMagique(); });
  document.getElementById("compte-rester")
    .addEventListener("change", (e) => {
      try { localStorage.setItem(CLE_EPHEMERE, e.target.checked ? "0" : "1"); } catch (err) {}
    });
  document.getElementById("compte-deconnecter")
    .addEventListener("click", deconnecterNuage);
  document.getElementById("compte-synchroniser")
    .addEventListener("click", synchroniserNuage);
  document.getElementById("compte-pseudo")
    .addEventListener("change", (e) => enregistrerPseudo(e.target.value));

  // Échap ferme la fenêtre Compte (avant les autres raccourcis).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("modal-compte").hidden) {
      fermerModalCompte();
      e.stopPropagation();
    }
  }, true);
}
