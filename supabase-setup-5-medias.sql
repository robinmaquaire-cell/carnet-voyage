-- =========================================================
-- supabase-setup-5-medias.sql — À coller UNE FOIS dans
-- l'éditeur SQL de Supabase (après les fichiers précédents).
--
-- Les photos et les sons ne sont plus collés dans le fichier du
-- carnet : chacun devient un fichier séparé, rangé dans
--   <id du propriétaire>/medias/<empreinte>
-- (l'empreinte est une longue signature calculée sur le contenu ;
-- elle ne se devine pas et ne fuit rien).
--
-- Les règles de sécurité EXISTANTES couvrent déjà TES propres
-- médias : le dossier commence par ton identifiant, donc « chacun
-- son dossier » s'applique. Rien à faire pour ton usage personnel.
--
-- Ce script ajoute UNIQUEMENT le nécessaire pour le PARTAGE :
-- qu'un ami à qui tu as partagé un carnet puisse aussi voir ses
-- photos (et en ajouter s'il a le droit « édition »).
--
-- Sans danger : n'efface rien, ajoute seulement des règles.
-- On peut le relancer plusieurs fois sans risque.
-- =========================================================

-- Un invité peut TÉLÉCHARGER les médias d'un propriétaire qui lui a
-- partagé au moins un carnet. (Les noms de fichiers étant des empreintes
-- imprévisibles et non listables, on ne peut pas accéder à un média sans
-- déjà connaître son empreinte, présente uniquement dans un carnet partagé.)
drop policy if exists "medias partages lecture" on storage.objects;
create policy "medias partages lecture"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'carnets'
    and (storage.foldername(name))[2] = 'medias'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
    )
  );

-- Un invité EN ÉDITION peut AJOUTER un média dans le dossier du propriétaire.
drop policy if exists "medias partages ecriture" on storage.objects;
create policy "medias partages ecriture"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'carnets'
    and (storage.foldername(name))[2] = 'medias'
    and exists (
      select 1 from public.carnet_partages p
      where lower(p.email) = lower(auth.jwt() ->> 'email')
        and (storage.foldername(name))[1] = p.proprietaire::text
        and p.droit = 'edition'
    )
  );
