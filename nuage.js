/* =========================================================
   nuage.js — Compte et sauvegarde en ligne (Supabase)
   ---------------------------------------------------------
   Principe : l'application reste « locale d'abord » (tout est
   enregistré sur l'appareil, elle marche hors ligne). Quand on
   est connecté à son compte, chaque carnet est EN PLUS envoyé
   en ligne :
   - une ligne par carnet dans la table `carnets` (titre, logo,
     catégorie, dates… pour la liste) ;
   - le contenu complet (souvenirs, photos, audios, style) dans
     un fichier JSON du bucket de stockage `carnets`.

   La synchronisation compare les dates de modification : la
   version la plus récente gagne, dans les deux sens. Chacun ne
   voit que ses propres carnets (règles de sécurité serveur).
   ========================================================= */

let sbClient = null;        // le client Supabase (null si non configuré)
let sessionNuage = null;    // la session de l'utilisateur connecté (ou null)
let syncEnCours = false;

/** Le nuage est-il configuré (clés présentes) ? */
function nuageConfigure() {
  const c = window.CONFIG_NUAGE || {};
  return !!(c.url && c.cle && window.supabase);
}

/** Est-on connecté à un compte ? */
function nuageConnecte() {
  return !!(sbClient && sessionNuage && sessionNuage.user);
}

/** Point d'entrée : appelé par demarrerUI() une fois les carnets chargés. */
function demarrerNuage() {
  brancherCompteUI();
  if (!nuageConfigure()) {
    majCompteUI();
    return;
  }
  sbClient = window.supabase.createClient(window.CONFIG_NUAGE.url, window.CONFIG_NUAGE.cle);

  // Suit l'état de connexion : session retrouvée au démarrage, connexion,
  // déconnexion, retour d'un e-mail de réinitialisation de mot de passe.
  sbClient.auth.onAuthStateChange((evenement, session) => {
    sessionNuage = session;
    majCompteUI();
    if (evenement === "PASSWORD_RECOVERY") {
      ouvrirModalCompte("recovery");
      return;
    }
    if ((evenement === "SIGNED_IN" || evenement === "INITIAL_SESSION") && session) {
      synchroniserNuage();
    }
  });
}

/* =========================================================
   Synchronisation
   ========================================================= */

/** Chemin du fichier JSON d'un carnet dans le stockage. */
function cheminNuage(uuid) {
  return `${sessionNuage.user.id}/${uuid}.json`;
}

/** Télécharge le contenu complet d'un carnet depuis le stockage. */
async function telechargerCarnetNuage(uuid) {
  const { data, error } = await sbClient.storage.from("carnets").download(cheminNuage(uuid));
  if (error) throw error;
  return JSON.parse(await data.text());
}

/** Envoie un carnet en ligne (contenu + fiche pour la liste). */
async function pousserCarnet(c) {
  if (!nuageConnecte() || !c || !c.uuid) return;
  const uid = sessionNuage.user.id;

  // Le contenu complet : celui en mémoire pour le carnet ouvert, sinon la
  // sauvegarde locale. Un carnet encore vide n'a pas de fichier à envoyer.
  const donnees = c.id === etat.carnetActifId
    ? serialiserCarnet()
    : await dbChargerCle("carnet-" + c.id).catch(() => null);
  if (donnees && donnees.trace) {
    const blob = new Blob([JSON.stringify(donnees)], { type: "application/json" });
    const { error } = await sbClient.storage.from("carnets")
      .upload(cheminNuage(c.uuid), blob, { upsert: true, contentType: "application/json" });
    if (error) throw error;
  }

  const { error: erreurLigne } = await sbClient.from("carnets").upsert({
    user_id: uid,
    uuid: c.uuid,
    nom: c.nom,
    logo: c.logo || "",
    categorie: c.categorie || "",
    description: c.description || "",
    du: c.du || "",
    au: c.au || "",
    modifie_le: c.modifieLe || new Date().toISOString(),
  });
  if (erreurLigne) throw erreurLigne;
}

/** Supprime un carnet en ligne (appelé par app.js après la confirmation). */
async function supprimerCarnetNuage(carnet) {
  if (!nuageConnecte() || !carnet || !carnet.uuid) return;
  try {
    await sbClient.storage.from("carnets").remove([cheminNuage(carnet.uuid)]);
    await sbClient.from("carnets").delete().eq("uuid", carnet.uuid);
  } catch (e) {
    toast("Suppression en ligne impossible pour l'instant (elle sera à refaire).", true);
  }
}

/**
 * Synchronisation complète, dans les deux sens :
 * - les carnets en ligne absents (ou plus récents) sont téléchargés ;
 * - les carnets locaux absents (ou plus récents) sont envoyés.
 */
async function synchroniserNuage() {
  if (!nuageConnecte() || syncEnCours) return;
  syncEnCours = true;
  statutCompte("Synchronisation en cours…");
  let recus = 0, envoyes = 0, erreurs = 0;

  try {
    const { data: lignes, error } = await sbClient.from("carnets").select("*");
    if (error) throw error;
    const distants = lignes || [];
    const parUuid = new Map(etat.carnets.map((c) => [c.uuid, c]));

    // 1) Du nuage vers l'appareil.
    for (const r of distants) {
      const local = parUuid.get(r.uuid);
      const dateDistante = Date.parse(r.modifie_le || 0) || 0;
      try {
        if (!local) {
          const donnees = await telechargerCarnetNuage(r.uuid).catch(() => null);
          const id = Math.max(0, ...etat.carnets.map((c) => c.id)) + 1;
          etat.carnets.push({
            id, uuid: r.uuid, visible: true,
            nom: r.nom || "Carnet", logo: r.logo || "", categorie: r.categorie || "",
            description: r.description || "", du: r.du || "", au: r.au || "",
            modifieLe: r.modifie_le || "",
          });
          if (donnees && donnees.trace) await dbSauverCle("carnet-" + id, donnees);
          recus++;
        } else if (dateDistante > (Date.parse(local.modifieLe || 0) || 0)) {
          const donnees = await telechargerCarnetNuage(r.uuid).catch(() => null);
          Object.assign(local, {
            nom: r.nom || local.nom, logo: r.logo || "", categorie: r.categorie || "",
            description: r.description || "", du: r.du || "", au: r.au || "",
            modifieLe: r.modifie_le || "",
          });
          if (donnees && donnees.trace) {
            await dbSauverCle("carnet-" + local.id, donnees);
            if (local.id === etat.carnetActifId) restaurerCarnet(donnees);
          }
          recus++;
        }
      } catch (e) { erreurs++; }
    }

    // 2) De l'appareil vers le nuage.
    for (const c of etat.carnets) {
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

/** Ouvre la fenêtre Compte ("normal" ou "recovery" = nouveau mot de passe). */
function ouvrirModalCompte(mode) {
  statutCompte("");
  document.getElementById("compte-bloc-recovery").hidden = mode !== "recovery";
  document.getElementById("compte-bloc-connexion").hidden =
    mode === "recovery" || nuageConnecte();
  document.getElementById("compte-bloc-connecte").hidden =
    mode === "recovery" || !nuageConnecte();
  document.getElementById("compte-non-configure").hidden = nuageConfigure();
  if (nuageConnecte()) {
    document.getElementById("compte-email-affiche").textContent = sessionNuage.user.email;
  }
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
    ? "☁️ " + (sessionNuage.user.email || "Connecté")
    : "☁️ Se connecter";
}

/** Lit e-mail + mot de passe saisis (avec de petites vérifications). */
function lireIdentifiants() {
  const email = document.getElementById("compte-email").value.trim();
  const mdp = document.getElementById("compte-mdp").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    statutCompte("Écris une adresse e-mail valide.", true);
    return null;
  }
  if (mdp.length < 8) {
    statutCompte("Le mot de passe doit faire au moins 8 caractères.", true);
    return null;
  }
  return { email, mdp };
}

/** Crée un compte (e-mail + mot de passe). */
async function creerCompteNuage() {
  const ids = lireIdentifiants();
  if (!ids) return;
  statutCompte("Création du compte…");
  const { data, error } = await sbClient.auth.signUp({ email: ids.email, password: ids.mdp });
  if (error) {
    statutCompte(traduireErreurAuth(error), true);
    return;
  }
  if (data.session) {
    statutCompte("✓ Compte créé, te voilà connecté !");
    ouvrirModalCompte();
  } else {
    // La confirmation par e-mail est activée côté Supabase.
    statutCompte("Presque fini : ouvre l'e-mail de confirmation qui vient de t'être envoyé, puis reviens te connecter.");
  }
}

/** Se connecte à un compte existant. */
async function connecterNuage() {
  const ids = lireIdentifiants();
  if (!ids) return;
  statutCompte("Connexion…");
  const { error } = await sbClient.auth.signInWithPassword({
    email: ids.email, password: ids.mdp,
  });
  if (error) {
    statutCompte(traduireErreurAuth(error), true);
    return;
  }
  ouvrirModalCompte();
  statutCompte("✓ Connecté !");
}

/** Envoie l'e-mail « mot de passe oublié ». */
async function motDePasseOublie() {
  const email = document.getElementById("compte-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    statutCompte("Écris d'abord ton adresse e-mail au-dessus, puis reclique.", true);
    return;
  }
  statutCompte("Envoi de l'e-mail…");
  const { error } = await sbClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) statutCompte(traduireErreurAuth(error), true);
  else statutCompte("✓ E-mail envoyé : ouvre-le et suis le lien pour choisir un nouveau mot de passe.");
}

/** Enregistre le nouveau mot de passe (après le lien reçu par e-mail). */
async function validerNouveauMdp() {
  const mdp = document.getElementById("compte-nouveau-mdp").value;
  if (mdp.length < 8) {
    statutCompte("Le mot de passe doit faire au moins 8 caractères.", true);
    return;
  }
  const { error } = await sbClient.auth.updateUser({ password: mdp });
  if (error) {
    statutCompte(traduireErreurAuth(error), true);
    return;
  }
  statutCompte("✓ Nouveau mot de passe enregistré !");
  ouvrirModalCompte();
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
  if (/invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
  if (/user already registered/i.test(m)) return "Un compte existe déjà avec cet e-mail : clique sur « Se connecter ».";
  if (/email not confirmed/i.test(m)) return "Confirme d'abord ton adresse : ouvre l'e-mail reçu à l'inscription.";
  if (/rate limit|too many/i.test(m)) return "Trop d'essais d'affilée — attends une minute et réessaie.";
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
  document.getElementById("compte-creer")
    .addEventListener("click", creerCompteNuage);
  document.getElementById("compte-connecter")
    .addEventListener("click", connecterNuage);
  document.getElementById("compte-oubli")
    .addEventListener("click", motDePasseOublie);
  document.getElementById("compte-deconnecter")
    .addEventListener("click", deconnecterNuage);
  document.getElementById("compte-synchroniser")
    .addEventListener("click", synchroniserNuage);
  document.getElementById("compte-nouveau-mdp-ok")
    .addEventListener("click", validerNouveauMdp);
  document.getElementById("compte-mdp")
    .addEventListener("keydown", (e) => { if (e.key === "Enter") connecterNuage(); });

  // Échap ferme la fenêtre Compte (avant les autres raccourcis).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("modal-compte").hidden) {
      fermerModalCompte();
      e.stopPropagation();
    }
  }, true);
}
