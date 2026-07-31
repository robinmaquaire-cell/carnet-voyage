-- =========================================================
-- supabase-setup-9-partage-contact.sql — À coller UNE FOIS
-- dans l'éditeur SQL de Supabase (après le fichier 8-contacts).
--
-- Introduit le PARTAGE d'un carnet à un CONTACT (par user_id) —
-- c'est la version qui remplace le partage par e-mail (jamais
-- activé côté app) : plus besoin de connaître le mail exact,
-- on choisit dans sa liste de contacts.
--
-- Sans danger : n'efface rien, ajoute juste une table et des règles.
-- On peut relancer le script plusieurs fois sans risque.
-- =========================================================

-- 1) La table des partages par contact. Une ligne par (carnet, contact invité).
create table if not exists public.carnet_partages_contact (
  id             bigserial primary key,
  proprietaire   uuid not null references auth.users (id) on delete cascade,
  carnet_uuid    uuid not null,
  destinataire   uuid not null references auth.users (id) on delete cascade,
  droit          text not null default 'lecture'
    check (droit in ('lecture', 'edition')),
  cree_le        timestamptz not null default now(),
  unique (proprietaire, carnet_uuid, destinataire),
  check (proprietaire <> destinataire)
);

create index if not exists cpc_carnet on public.carnet_partages_contact (carnet_uuid);
create index if not exists cpc_destinataire on public.carnet_partages_contact (destinataire);

alter table public.carnet_partages_contact enable row level security;

-- Le propriétaire gère sa liste de partages (voir, ajouter, retirer, changer le droit).
drop policy if exists "cpc : proprietaire gere" on public.carnet_partages_contact;
create policy "cpc : proprietaire gere"
  on public.carnet_partages_contact
  for all to authenticated
  using (auth.uid() = proprietaire)
  with check (auth.uid() = proprietaire);

-- L'invité peut voir les partages qui le concernent (pour construire sa liste
-- de carnets partagés avec lui).
drop policy if exists "cpc : invite voit" on public.carnet_partages_contact;
create policy "cpc : invite voit"
  on public.carnet_partages_contact
  for select to authenticated
  using (auth.uid() = destinataire);

-- 2) Table carnets : l'invité peut LIRE la fiche d'un carnet partagé (contact).
drop policy if exists "carnets partages contact lecture" on public.carnets;
create policy "carnets partages contact lecture"
  on public.carnets
  for select to authenticated
  using (
    exists (
      select 1 from public.carnet_partages_contact p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and p.destinataire = auth.uid()
    )
  );

-- …et la MODIFIER si le droit est « édition ».
drop policy if exists "carnets partages contact edition" on public.carnets;
create policy "carnets partages contact edition"
  on public.carnets
  for update to authenticated
  using (
    exists (
      select 1 from public.carnet_partages_contact p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and p.destinataire = auth.uid()
        and p.droit = 'edition'
    )
  )
  with check (
    exists (
      select 1 from public.carnet_partages_contact p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and p.destinataire = auth.uid()
        and p.droit = 'edition'
    )
  );

-- 3) Stockage : l'invité peut TÉLÉCHARGER le fichier d'un carnet partagé…
drop policy if exists "carnets partages contact fichier lecture" on storage.objects;
create policy "carnets partages contact fichier lecture"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages_contact p
      where p.destinataire = auth.uid()
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
    )
  );

-- …et l'ÉCRASER si le droit est « édition » (update + première écriture).
drop policy if exists "carnets partages contact fichier maj" on storage.objects;
create policy "carnets partages contact fichier maj"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages_contact p
      where p.destinataire = auth.uid()
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  )
  with check (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages_contact p
      where p.destinataire = auth.uid()
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  );

drop policy if exists "carnets partages contact fichier ecriture" on storage.objects;
create policy "carnets partages contact fichier ecriture"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages_contact p
      where p.destinataire = auth.uid()
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  );

-- 4) Liens de partage par URL (à venir) : chaque lien est un token unique
-- qui, présenté par un utilisateur connecté, l'ajoute à la table ci-dessus.
create table if not exists public.carnet_liens_partage (
  token          text primary key,
  proprietaire   uuid not null references auth.users (id) on delete cascade,
  carnet_uuid    uuid not null,
  droit          text not null default 'lecture'
    check (droit in ('lecture', 'edition')),
  cree_le        timestamptz not null default now(),
  revoque        boolean not null default false
);

alter table public.carnet_liens_partage enable row level security;

-- Le proprietaire gere ses liens.
drop policy if exists "liens : proprietaire gere" on public.carnet_liens_partage;
create policy "liens : proprietaire gere"
  on public.carnet_liens_partage
  for all to authenticated
  using (auth.uid() = proprietaire)
  with check (auth.uid() = proprietaire);

-- N'importe quel utilisateur connecte peut LIRE un lien par son token (pour
-- le rejoindre). On ne peut pas lister les tokens des autres : select se fait
-- par eq('token', ...).
drop policy if exists "liens : lecture par token" on public.carnet_liens_partage;
create policy "liens : lecture par token"
  on public.carnet_liens_partage
  for select to authenticated
  using (not revoque);
