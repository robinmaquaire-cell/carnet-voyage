-- =========================================================
-- supabase-setup.sql — À coller UNE FOIS dans l'éditeur SQL
-- de Supabase (voir GUIDE-COMPTE-EN-LIGNE.md, étape 3).
-- Crée la table des carnets, le stockage des fichiers, et
-- les règles de sécurité : chacun ne voit QUE ses carnets.
-- =========================================================

-- 1) La table des carnets (la "fiche" de chaque carnet : titre, logo, dates…
--    Le contenu complet, lui, est un fichier JSON dans le stockage.)
create table if not exists public.carnets (
  user_id     uuid not null references auth.users (id) on delete cascade,
  uuid        uuid not null,
  nom         text not null default 'Carnet',
  logo        text not null default '',
  categorie   text not null default '',
  description text not null default '',
  du          text not null default '',
  au          text not null default '',
  modifie_le  timestamptz not null default now(),
  primary key (user_id, uuid)
);

-- 2) Sécurité de la table : chaque utilisateur ne peut lire et modifier
--    que ses propres lignes.
alter table public.carnets enable row level security;

drop policy if exists "chacun ses carnets" on public.carnets;
create policy "chacun ses carnets"
  on public.carnets
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3) Le "bucket" (dossier de stockage) des fichiers de carnets, privé.
insert into storage.buckets (id, name, public)
values ('carnets', 'carnets', false)
on conflict (id) do nothing;

-- 4) Sécurité du stockage : chacun ne touche que son propre dossier
--    (les fichiers sont rangés sous <id utilisateur>/<id carnet>.json).
drop policy if exists "carnets lire" on storage.objects;
create policy "carnets lire"
  on storage.objects for select to authenticated
  using (bucket_id = 'carnets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "carnets ecrire" on storage.objects;
create policy "carnets ecrire"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'carnets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "carnets modifier" on storage.objects;
create policy "carnets modifier"
  on storage.objects for update to authenticated
  using (bucket_id = 'carnets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'carnets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "carnets supprimer" on storage.objects;
create policy "carnets supprimer"
  on storage.objects for delete to authenticated
  using (bucket_id = 'carnets' and (storage.foldername(name))[1] = auth.uid()::text);
