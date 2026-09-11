-- ============================================================
-- TENDER PRIVATE SOCIAL TAG PERMISSIONS
-- ============================================================
-- Private operational data only.
-- Never exposed on the public Tender profile.

create table if not exists public.tender_social_permissions (
  id uuid primary key default gen_random_uuid(),

  bartender_id uuid not null
    references public.bartenders(id)
    on delete cascade,

  platform text not null,
  social_handle text not null,

  tag_permission boolean not null default false,
  consented_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tender_social_permissions_platform_check
    check (platform in ('instagram', 'facebook', 'tiktok')),

  constraint tender_social_permissions_unique_platform
    unique (bartender_id, platform)
);

alter table public.tender_social_permissions
enable row level security;


create policy "tenders can read own social permissions"
on public.tender_social_permissions
for select
to authenticated
using (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_social_permissions.bartender_id
      and bp.user_id = auth.uid()
  )
);


create policy "tenders can create own social permissions"
on public.tender_social_permissions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_social_permissions.bartender_id
      and bp.user_id = auth.uid()
  )
);


create policy "tenders can update own social permissions"
on public.tender_social_permissions
for update
to authenticated
using (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_social_permissions.bartender_id
      and bp.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_social_permissions.bartender_id
      and bp.user_id = auth.uid()
  )
);


create policy "tenders can delete own social permissions"
on public.tender_social_permissions
for delete
to authenticated
using (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_social_permissions.bartender_id
      and bp.user_id = auth.uid()
  )
);
