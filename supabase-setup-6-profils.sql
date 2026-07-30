-- =========================================================
-- supabase-setup-6-profils.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après les fichiers précédents).
--
-- Introduit la NOTION DE PROFIL PUBLIC : chaque utilisateur a
-- un pseudo unique, une photo et une description que les autres
-- utilisateurs peuvent voir pour le retrouver et l'ajouter en
-- contact. C'est la première pierre du réseau social prévu :
-- - jalon A (ce script)   : la table publique des profils.
-- - jalon B (côté app)    : l'espace Compte visuel.
-- - jalon C (côté app)    : contacts + demandes.
-- - jalon D (côté app)    : liens d'invitation.
--
-- Sans danger : n'efface rien, ajoute juste une table et des
-- règles. On peut le relancer plusieurs fois sans risque.
-- =========================================================

-- 1) La table des profils. Un profil par utilisateur, `id` = son
--    identifiant de compte. `est_public` = true : n'importe qui peut
--    te suivre sans que tu valides ; false (par défaut) : chaque
--    demande doit être acceptée. Le PROFIL lui-même (pseudo, photo,
--    description) reste toujours visible pour permettre la recherche
--    — c'est le CONTENU (les carnets) qui sera protégé au jalon suivant.
create table if not exists public.profils (
  id           uuid primary key references auth.users (id) on delete cascade,
  pseudo       text not null unique,
  photo        text not null default '',   -- image encodée (data:image/…)
  description  text not null default '',
  est_public   boolean not null default false,
  cree_le      timestamptz not null default now(),
  modifie_le   timestamptz not null default now(),
  -- Format du pseudo : lettres, chiffres, tiret, tiret-bas ; 3 à 30
  -- caractères. Simple, mémorisable, cherchable comme un @identifiant.
  constraint pseudo_valide check (pseudo ~ '^[A-Za-z0-9_-]{3,30}$')
);

-- Recherche rapide et INSENSIBLE À LA CASSE : « @Robin » retrouve « robin ».
create index if not exists profils_pseudo_min on public.profils (lower(pseudo));

-- 2) Sécurité : chaque utilisateur ne peut modifier QUE son propre profil,
--    mais peut LIRE ceux des autres (nécessaire pour la recherche par
--    pseudo). C'est le fonctionnement standard des annuaires d'utilisateurs
--    (Instagram, Twitter, etc. : le profil est public par nature).
alter table public.profils enable row level security;

drop policy if exists "profils lecture publique" on public.profils;
create policy "profils lecture publique"
  on public.profils
  for select
  to authenticated
  using (true);

drop policy if exists "profils chacun le sien : insertion" on public.profils;
create policy "profils chacun le sien : insertion"
  on public.profils
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profils chacun le sien : mise a jour" on public.profils;
create policy "profils chacun le sien : mise a jour"
  on public.profils
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "profils chacun le sien : suppression" on public.profils;
create policy "profils chacun le sien : suppression"
  on public.profils
  for delete
  to authenticated
  using (auth.uid() = id);

-- 3) Le champ modifie_le s'ajuste tout seul à chaque mise à jour, pour
--    savoir quand la photo ou le pseudo ont changé.
create or replace function public.profils_touche_modifie_le()
  returns trigger language plpgsql as $$
begin
  new.modifie_le := now();
  return new;
end;
$$;

drop trigger if exists profils_maj_modifie_le on public.profils;
create trigger profils_maj_modifie_le
  before update on public.profils
  for each row execute function public.profils_touche_modifie_le();
