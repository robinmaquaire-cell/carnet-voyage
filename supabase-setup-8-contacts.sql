-- =========================================================
-- supabase-setup-8-contacts.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après supabase-setup-6-profils.sql).
--
-- Introduit les CONTACTS : Alice envoie une demande à Bob ;
-- Bob accepte ou refuse. Une fois acceptée, ils sont amis.
-- Prérequis du prochain jalon (partage de carnets à un contact).
--
-- Sans danger : n'efface rien, ajoute juste une table et des règles.
-- On peut relancer le script plusieurs fois sans risque.
-- =========================================================

-- 1) La table des relations. Une ligne = UNE demande ou UNE amitié.
--    - statut='en_attente' : demande envoyée, en attente de réponse.
--    - statut='accepte'    : amitié en cours.
--    (Un refus est modélisé par une suppression de la ligne : pas de trace
--     conservée, l'expéditeur peut retenter plus tard s'il veut.)
create table if not exists public.contacts (
  id           bigserial primary key,
  expediteur   uuid not null references auth.users (id) on delete cascade,
  destinataire uuid not null references auth.users (id) on delete cascade,
  statut       text not null default 'en_attente'
    check (statut in ('en_attente', 'accepte')),
  cree_le      timestamptz not null default now(),
  modifie_le   timestamptz not null default now(),
  -- Empêche les doublons dans le SENS expediteur→destinataire.
  unique (expediteur, destinataire),
  -- On ne peut pas être son propre contact.
  check (expediteur <> destinataire)
);

-- Index pour aller vite quand on cherche « mes demandes reçues » ou
-- « mes contacts » (les deux colonnes servent d'ancres).
create index if not exists contacts_expediteur   on public.contacts (expediteur);
create index if not exists contacts_destinataire on public.contacts (destinataire);

-- 2) Sécurité (Row Level Security) : chacun ne voit et ne modifie que
--    les lignes où il apparaît, expéditeur OU destinataire.
alter table public.contacts enable row level security;

drop policy if exists "contacts : voir les miens" on public.contacts;
create policy "contacts : voir les miens"
  on public.contacts
  for select
  to authenticated
  using (auth.uid() = expediteur or auth.uid() = destinataire);

-- Seul l'expéditeur peut CRÉER une demande (et seulement de lui-même).
-- Elle démarre forcément « en attente » (garantie côté serveur).
drop policy if exists "contacts : envoyer une demande" on public.contacts;
create policy "contacts : envoyer une demande"
  on public.contacts
  for insert
  to authenticated
  with check (
    auth.uid() = expediteur
    and statut = 'en_attente'
  );

-- Seul le destinataire peut ACCEPTER une demande (statut → 'accepte').
-- Il ne peut pas re-mettre 'en_attente' ni changer les autres colonnes.
drop policy if exists "contacts : accepter une demande" on public.contacts;
create policy "contacts : accepter une demande"
  on public.contacts
  for update
  to authenticated
  using (auth.uid() = destinataire and statut = 'en_attente')
  with check (auth.uid() = destinataire and statut = 'accepte');

-- Suppression : les deux peuvent (refuser une demande reçue, annuler une
-- demande envoyée, retirer un contact). Ne laisse pas de trace.
drop policy if exists "contacts : supprimer la relation" on public.contacts;
create policy "contacts : supprimer la relation"
  on public.contacts
  for delete
  to authenticated
  using (auth.uid() = expediteur or auth.uid() = destinataire);

-- 3) `modifie_le` s'ajuste tout seul (sert à trier les activités récentes).
create or replace function public.contacts_touche_modifie_le()
  returns trigger language plpgsql as $$
begin
  new.modifie_le := now();
  return new;
end;
$$;

drop trigger if exists contacts_maj_modifie_le on public.contacts;
create trigger contacts_maj_modifie_le
  before update on public.contacts
  for each row execute function public.contacts_touche_modifie_le();
