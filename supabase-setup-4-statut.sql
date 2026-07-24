-- =========================================================
-- supabase-setup-4-statut.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après les fichiers précédents).
--
-- Ajoute l'ARCHIVAGE des carnets et corrige la « réapparition »
-- des carnets supprimés :
--   - 'actif'    : carnet normal
--   - 'archive'  : masqué des listes, restaurable
--   - 'supprime' : pierre tombale (le carnet a été supprimé
--                  définitivement ; la ligne reste pour que les
--                  autres appareils l'enlèvent aussi et ne le
--                  recréent jamais).
--
-- Sans danger : n'efface rien, ajoute juste une colonne.
-- On peut le relancer plusieurs fois sans risque.
-- =========================================================

alter table public.carnets
  add column if not exists statut text not null default 'actif';

-- Les règles de sécurité existantes couvrent déjà cette colonne : rien
-- d'autre à faire.
