-- TenderFans Event Harvester: multiple provider venue identities per Spot
--
-- A physical TenderFans Spot may be represented by multiple venue IDs
-- at the same provider. Example:
--
--   Ferg's
--     -> Ticketmaster: Ferg's Pavilion
--     -> Ticketmaster: Concert Courtyard at Ferg's
--
-- Each external provider identity still belongs to only one
-- TenderFans Spot because (provider, provider_place_id) remains
-- the primary key.


-- ============================================================
-- 1. ALLOW MULTIPLE PROVIDER IDENTITIES PER SPOT
-- ============================================================

alter table public.venue_external_refs
  drop constraint if exists
    venue_external_refs_venue_id_provider_key;

create index if not exists
  venue_external_refs_venue_provider_idx
on public.venue_external_refs (
  venue_id,
  provider
);


-- ============================================================
-- 2. ATTACH AN EXTERNAL IDENTITY TO AN EXISTING SPOT
-- ============================================================

create or replace function public.set_venue_external_ref(
  p_venue_id uuid,
  p_provider text,
  p_provider_place_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text;
  normalized_place_id text;
  existing_venue_id uuid;
begin
  normalized_provider :=
    lower(trim(p_provider));

  normalized_place_id :=
    trim(p_provider_place_id);

  if normalized_provider is null
     or normalized_provider = '' then
    raise exception 'Provider is required';
  end if;

  if normalized_provider !~
     '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid provider identifier';
  end if;

  if normalized_place_id is null
     or normalized_place_id = '' then
    raise exception 'Provider place ID is required';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
  ) then
    raise exception 'TenderFans Spot not found';
  end if;

  /*
   * Lock an existing provider identity, if present.
   * An external identity may never be reassigned from one
   * TenderFans Spot to another by this helper.
   */
  select r.venue_id
  into existing_venue_id
  from public.venue_external_refs r
  where r.provider = normalized_provider
    and r.provider_place_id = normalized_place_id
  for update;

  if existing_venue_id is not null
     and existing_venue_id <> p_venue_id then
    raise exception
      'External venue identity is already attached to another TenderFans Spot';
  end if;

  /*
   * Conflict is now the external identity itself, not
   * (venue_id, provider). This permits one TenderFans Spot
   * to own multiple identities from the same provider.
   */
  insert into public.venue_external_refs (
    venue_id,
    provider,
    provider_place_id,
    metadata
  )
  values (
    p_venue_id,
    normalized_provider,
    normalized_place_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider, provider_place_id)
  do update set
    metadata = excluded.metadata;
end;
$$;


-- ============================================================
-- 3. SECURITY
-- ============================================================

revoke all on function public.set_venue_external_ref(
  uuid,
  text,
  text,
  jsonb
) from public;

grant execute on function public.set_venue_external_ref(
  uuid,
  text,
  text,
  jsonb
) to service_role;
