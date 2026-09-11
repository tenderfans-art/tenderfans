-- ============================================================
-- TENDERFANS CONTESTS
-- Admin-managed reusable contest records.
-- No approval workflow.
-- ============================================================

create table if not exists public.contests (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  prize_text text not null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,

  flyer_url text,
  flyer_storage_path text,

  rules_text text,

  is_active boolean not null default false,

  created_by uuid not null
    references public.profiles(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint contests_title_length
    check (
      char_length(trim(title)) >= 2
      and char_length(trim(title)) <= 150
    ),

  constraint contests_valid_dates
    check (ends_at > starts_at)
);

alter table public.contests
enable row level security;


-- Only one contest may be active at a time.
create unique index if not exists contests_one_active_idx
on public.contests ((is_active))
where is_active = true;


-- ------------------------------------------------------------
-- Public may see only the active contest.
-- ------------------------------------------------------------

create policy "public can read active contest"
on public.contests
for select
to anon, authenticated
using (is_active = true);


-- ------------------------------------------------------------
-- Platform Admins may read all contests.
-- ------------------------------------------------------------

create policy "admins can read all contests"
on public.contests
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


-- ------------------------------------------------------------
-- Platform Admins may create contests.
-- ------------------------------------------------------------

create policy "admins can create contests"
on public.contests
for insert
to authenticated
with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


-- ------------------------------------------------------------
-- Platform Admins may update contests.
-- ------------------------------------------------------------

create policy "admins can update contests"
on public.contests
for update
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


-- ------------------------------------------------------------
-- Platform Admins may delete contests.
-- ------------------------------------------------------------

create policy "admins can delete contests"
on public.contests
for delete
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

-- ============================================================
-- CONTEST FLYER STORAGE
-- ============================================================

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'contest-flyers',
  'contest-flyers',
  true,
  10485760,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do nothing;

drop policy if exists "public can read contest flyers" on storage.objects;
create policy "public can read contest flyers"
on storage.objects for select to public
using (bucket_id = 'contest-flyers');

drop policy if exists "admins can upload contest flyers" on storage.objects;
create policy "admins can upload contest flyers"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'contest-flyers'
  and exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can update contest flyers" on storage.objects;
create policy "admins can update contest flyers"
on storage.objects for update to authenticated
using (
  bucket_id = 'contest-flyers'
  and exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  bucket_id = 'contest-flyers'
  and exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can delete contest flyers" on storage.objects;
create policy "admins can delete contest flyers"
on storage.objects for delete to authenticated
using (
  bucket_id = 'contest-flyers'
  and exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);
