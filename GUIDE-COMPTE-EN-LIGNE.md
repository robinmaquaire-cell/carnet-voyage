# Guide : activer le compte et la sauvegarde en ligne

Environ 10 minutes, à faire **une seule fois**. Tout est gratuit pour un usage
personnel (offre gratuite de Supabase : largement suffisante).

## Étape 1 — Créer ton compte Supabase

1. Va sur **https://supabase.com** et clique **Start your project** (ou *Sign up*).
2. Inscris-toi (le plus simple : *Continue with GitHub* puisque tu as déjà un
   compte GitHub pour l'application ; sinon avec ton e-mail).

## Étape 2 — Créer le projet

1. Une fois connecté, clique **New project**.
2. Remplis :
   - **Name** : `carnet-voyage`
   - **Database Password** : clique *Generate a password* et **note-le** quelque
     part (tu n'en auras normalement plus besoin, mais garde-le).
   - **Region** : choisis **West EU (Paris)** ou la région européenne proposée.
3. Clique **Create new project** et attends 1 à 2 minutes que le projet soit prêt.

## Étape 3 — Préparer la base (copier-coller un texte)

1. Dans le menu de gauche, clique l'icône **SQL Editor** (feuille avec `>_`).
2. Ouvre le fichier **`supabase-setup.sql`** (dans le dossier de l'application)
   avec le Bloc-notes, copie **tout** son contenu.
3. Colle-le dans la grande zone de texte de Supabase, puis clique **Run**
   (en bas à droite). Il doit s'afficher « Success. No rows returned ».

## Étape 4 — Régler la connexion par e-mail

1. Menu de gauche → **Authentication** → onglet **Sign In / Providers**.
2. Clique sur **Email** et vérifie :
   - **Enable Sign in with Email** : activé ;
   - **Confirm email** : **désactive-le** (sinon chaque nouvel utilisateur doit
     cliquer un lien reçu par e-mail avant de pouvoir se connecter — tu pourras
     le réactiver plus tard si tu veux).
3. Clique **Save**.
4. Toujours dans **Authentication** → **URL Configuration** :
   - **Site URL** : `https://robinmaquaire-cell.github.io/carnet-voyage/`
   - **Redirect URLs** → *Add URL* : `http://localhost:8754`
   (c'est utilisé par le lien « mot de passe oublié »).

## Étape 5 — Récupérer les deux clés

1. Menu de gauche → **Project Settings** (roue dentée) → **API Keys** (ou *API*).
2. Copie ces deux valeurs et **colle-les-moi dans la conversation** :
   - **Project URL** (ressemble à `https://abcdefgh.supabase.co`) ;
   - la clé **anon public** (longue chaîne de caractères).

C'est tout ! Je les rangerai dans le fichier `config.js` de l'application et la
sauvegarde en ligne s'activera. Ces deux valeurs ne sont **pas secrètes** (elles
sont faites pour être dans l'application) : la sécurité vient des règles posées
à l'étape 3 — chaque compte ne voit que ses propres carnets.

## Comment ça marche ensuite

- Bouton **☁️ Compte** en haut de l'application → **Créer un compte**
  (e-mail + mot de passe), ou **Se connecter** sur un autre appareil.
- Une fois connecté, chaque modification est envoyée en ligne quelques secondes
  après (petit indicateur « ☁️ En ligne »), et à chaque ouverture l'application
  récupère les carnets les plus récents.
- Sans connexion Internet, tout continue de marcher : la synchronisation
  rattrape au retour du réseau (bouton « 🔄 Synchroniser maintenant » dans la
  fenêtre Compte si besoin).
