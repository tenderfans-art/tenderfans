-- TenderFans V1 event flyer storage.
--
-- Event flyers are public assets, but authenticated users may only
-- upload/delete files inside their own UUID folder.
--
-- Eligible uploaders:
--   1. Approved Partners
--   2. Users with Spot management permission
--
-- Authorization to create an event for a specific Spot remains enforced
-- separately by the events table RLS policies.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'event-flyers',
  'event-flyers',
  true,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists
  "approved partners upload event flyers"
on storage.objects;

drop policy if exists
  "approved partners delete own event flyers"
on storage.objects;

drop policy if exists
  "event submitters upload own flyers"
on storage.objects;

drop policy if exists
  "event submitters delete own flyers"
on storage.objects;

drop policy if exists
  "event submitters read own flyers"
on storage.objects;

create policy "event submitters upload own flyers"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'event-flyers'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (
    exists (
      select 1
      from public.partner_profiles pp
      where pp.user_id = auth.uid()
        and pp.status = 'approved'
    )
    or exists (
      select 1
      from public.venue_permissions vp
      where vp.user_id = auth.uid()
    )
  )
);

create policy "event submitters read own flyers"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'event-flyers'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (
    exists (
      select 1
      from public.partner_profiles pp
      where pp.user_id = auth.uid()
        and pp.status = 'approved'
    )
    or exists (
      select 1
      from public.venue_permissions vp
      where vp.user_id = auth.uid()
    )
  )
);

create policy "event submitters delete own flyers"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'event-flyers'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (
    exists (
      select 1
      from public.partner_profiles pp
      where pp.user_id = auth.uid()
        and pp.status = 'approved'
    )
    or exists (
      select 1
      from public.venue_permissions vp
      where vp.user_id = auth.uid()
    )
  )
);
