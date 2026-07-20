-- =========================================================
-- supabase-setup-2-partage.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après le premier fichier).
-- Ajoute le PARTAGE de carnets : une liste « qui peut voir /
-- modifier » par carnet, et les règles de sécurité associées.
-- =========================================================

-- 1) La liste de partage : une ligne par (carnet, personne invitée).
create table if not exists public.carnet_partages (
  proprietaire uuid not null references auth.users (id) on delete cascade,
  carnet_uuid  uuid not null,
  email        text not null,                       -- l'adresse du compte invité
  droit        text not null default 'lecture',     -- 'lecture' ou 'edition'
  cree_le      timestamptz not null default now(),
  primary key (proprietaire, carnet_uuid, email)
);

alter table public.carnet_partages enable row level security;

-- Le propriétaire gère sa liste de partage.
drop policy if exists "proprietaire gere ses partages" on public.carnet_partages;
create policy "proprietaire gere ses partages"
  on public.carnet_partages
  for all to authenticated
  using (auth.uid() = proprietaire)
  with check (auth.uid() = proprietaire);

-- L'invité peut voir les partages qui le concernent.
drop policy if exists "invite voit ses partages" on public.carnet_partages;
create policy "invite voit ses partages"
  on public.carnet_partages
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- 2) Table carnets : l'invité peut LIRE la fiche d'un carnet partagé…
drop policy if exists "carnets partages lecture" on public.carnets;
create policy "carnets partages lecture"
  on public.carnets
  for select to authenticated
  using (
    exists (
      select 1 from public.carnet_partages p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and lower(p.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- …et la MODIFIER si le droit est « édition ».
drop policy if exists "carnets partages edition" on public.carnets;
create policy "carnets partages edition"
  on public.carnets
  for update to authenticated
  using (
    exists (
      select 1 from public.carnet_partages p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and lower(p.email) = lower(auth.jwt() ->> 'email')
        and p.droit = 'edition'
    )
  )
  with check (
    exists (
      select 1 from public.carnet_partages p
      where p.carnet_uuid = carnets.uuid
        and p.proprietaire = carnets.user_id
        and lower(p.email) = lower(auth.jwt() ->> 'email')
        and p.droit = 'edition'
    )
  );

-- 3) Stockage : l'invité peut TÉLÉCHARGER le fichier d'un carnet partagé…
drop policy if exists "carnets partages fichier lecture" on storage.objects;
create policy "carnets partages fichier lecture"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
    )
  );

-- …et l'ÉCRASER si le droit est « édition » (mise à jour + première écriture).
drop policy if exists "carnets partages fichier maj" on storage.objects;
create policy "carnets partages fichier maj"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  )
  with check (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  );

drop policy if exists "carnets partages fichier ecriture" on storage.objects;
create policy "carnets partages fichier ecriture"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'carnets'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
        and storage.filename(name) = p.carnet_uuid::text || '.json'
        and p.droit = 'edition'
    )
  );
