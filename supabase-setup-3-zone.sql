-- =========================================================
-- supabase-setup-3-zone.sql — À coller UNE FOIS dans l'éditeur
-- SQL de Supabase (après les deux premiers fichiers).
--
-- Ajoute la ZONE DE CADRAGE et le FORMAT d'impression à la
-- fiche de chaque carnet, pour qu'ils suivent d'un appareil à
-- l'autre (téléphone, ordinateur…).
--
-- Sans danger : n'efface rien, n'ajoute que des colonnes
-- facultatives. On peut le relancer plusieurs fois sans risque.
-- =========================================================

alter table public.carnets
  add column if not exists zone jsonb,
  add column if not exists format_zone text not null default '',
  add column if not exists orientation_zone text not null default 'portrait';

-- Les règles de sécurité existantes (« chacun ses carnets » et le
-- partage) couvrent automatiquement ces nouvelles colonnes : rien
-- d'autre à faire.
