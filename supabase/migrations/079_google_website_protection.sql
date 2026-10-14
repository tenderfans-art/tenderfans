-- Preserve existing Spot websites when Google provides no website.
-- Same 11-argument signature and existing function permissions.

create or replace function public.upsert_google_venue(
  p_place_id text,
  p_name text,
  p_street_address text,
  p_city text,
  p_state_region text,
  p_postal_code text,
  p_latitude double precision,
  p_longitude double precision,
  p_public_phone text,
  p_website_url text,
  p_regular_hours jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_venue_id uuid;
begin
  v_venue_id := public.upsert_google_venue(
    p_place_id,
    p_name,
    p_street_address,
    p_city,
    p_state_region,
    p_postal_code,
    p_latitude,
    p_longitude
  );

  update public.venues
  set
    public_phone = nullif(p_public_phone, ''),
    website_url = coalesce(
      nullif(trim(p_website_url), ''),
      website_url
    ),
    regular_hours = coalesce(p_regular_hours, '[]'::jsonb)
  where id = v_venue_id;

  return v_venue_id;
end;
$function$;

-- Merge recovery state without replacing unrelated Google reference metadata.
create or replace function public.record_google_website_recovery(
  p_venue_id uuid,
  p_checked_at timestamptz,
  p_pending_detection boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.venue_external_refs
  set metadata =
    metadata ||
    jsonb_build_object(
      'website_recovery_checked_at', p_checked_at
    ) ||
    case
      when p_pending_detection then
        jsonb_build_object(
          'website_recovery_pending_detection', true
        )
      else '{}'::jsonb
    end
  where venue_id = p_venue_id
    and provider = 'google_places';
end;
$function$;

create or replace function public.clear_google_website_recovery(
  p_venue_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.venue_external_refs
  set metadata = metadata - 'website_recovery_pending_detection'
  where venue_id = p_venue_id
    and provider = 'google_places';
end;
$function$;

revoke all on function public.record_google_website_recovery(
  uuid, timestamptz, boolean
) from public, anon, authenticated;

revoke all on function public.clear_google_website_recovery(
  uuid
) from public, anon, authenticated;

grant execute on function public.record_google_website_recovery(
  uuid, timestamptz, boolean
) to service_role;

grant execute on function public.clear_google_website_recovery(
  uuid
) to service_role;
