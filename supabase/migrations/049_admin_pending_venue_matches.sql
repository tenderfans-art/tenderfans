create or replace function public.admin_pending_event_harvest_venue_matches()
returns table(
  id uuid,
  venue_id uuid,
  tenderfans_venue_name text,
  tenderfans_address text,
  tenderfans_city text,
  tenderfans_state_region text,
  tenderfans_postal_code text,
  provider text,
  provider_place_id text,
  provider_venue_name text,
  provider_address text,
  provider_city text,
  provider_state_region text,
  provider_postal_code text,
  confidence_score numeric,
  evidence jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'auth'
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    m.id,
    m.venue_id,
    v.name as tenderfans_venue_name,
    v.street_address as tenderfans_address,
    v.city as tenderfans_city,
    v.state_region as tenderfans_state_region,
    v.postal_code as tenderfans_postal_code,
    m.provider,
    m.provider_place_id,
    m.provider_venue_name,
    m.provider_address,
    m.provider_city,
    m.provider_state_region,
    m.provider_postal_code,
    m.confidence_score,
    m.evidence,
    m.first_seen_at,
    m.last_seen_at
  from public.event_harvest_venue_matches m
  join public.venues v
    on v.id = m.venue_id
  where m.status = 'pending'
  order by
    m.confidence_score desc,
    m.first_seen_at asc;
end;
$$;

revoke all on function public.admin_pending_event_harvest_venue_matches() from public;
revoke execute on function public.admin_pending_event_harvest_venue_matches() from anon;
grant execute on function public.admin_pending_event_harvest_venue_matches() to authenticated;
