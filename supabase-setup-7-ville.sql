-- =========================================================
-- supabase-setup-7-ville.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après supabase-setup-6-profils.sql).
--
-- Ajoute la colonne "ville" au profil public : simple texte libre
-- affiché à côté du pseudo dans la fenêtre Paramètres.
--
-- Sans danger : n'efface rien, ajoute juste une colonne (idempotent).
-- L'application fonctionne quand même si le script n'est pas encore
-- joué (elle bascule sur un enregistrement sans la colonne).
-- =========================================================

alter table public.profils
  add column if not exists ville text not null default '';
