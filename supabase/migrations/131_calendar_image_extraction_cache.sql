begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Raw, content-addressed vision output only. Source ownership, date mapping,
-- review, publication and work acknowledgement remain with their callers.
create table public.calendar_image_extractions (
  cache_key text primary key check (cache_key ~ '^[a-f0-9]{64}$'),
  extraction jsonb,
  claim_token uuid,
  claim_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  parsed_at timestamptz,
  check (
    (extraction is null and claim_token is not null and claim_until is not null and parsed_at is null)
    or
    (extraction is not null and claim_token is null and claim_until is null and parsed_at is not null)
  )
);

alter table public.calendar_image_extractions enable row level security;
revoke all on public.calendar_image_extractions from public, anon, authenticated, service_role;

create function public.calendar_image_extraction_cache(
  p_cache_key text,
  p_claim_token uuid,
  p_action text default 'claim',
  p_extraction jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '5s'
as $cache$
declare
  v_row public.calendar_image_extractions%rowtype;
  v_now timestamptz;
begin
  if p_cache_key is null or p_cache_key !~ '^[a-f0-9]{64}$'
     or p_claim_token is null or p_action is null
     or p_action not in ('claim', 'renew', 'save', 'release') then
    raise exception 'Invalid calendar extraction cache request' using errcode = '22023';
  end if;

  if p_action = 'claim' then
    insert into public.calendar_image_extractions(cache_key, claim_token, claim_until)
    values (p_cache_key, p_claim_token, clock_timestamp() + interval '2 minutes')
    on conflict (cache_key) do nothing;
  end if;

  select * into v_row from public.calendar_image_extractions
  where cache_key = p_cache_key for update;
  if not found then return jsonb_build_object('state', 'missing'); end if;
  v_now := clock_timestamp();

  -- Completed output is immutable. Save replay after a lost HTTP response
  -- returns the same result and cannot overwrite another producer's output.
  if v_row.extraction is not null then
    return jsonb_build_object('state', 'ready', 'extraction', v_row.extraction);
  end if;

  if p_action = 'claim' then
    if v_row.claim_token <> p_claim_token and v_row.claim_until > v_now then
      return jsonb_build_object('state', 'busy');
    end if;
    if v_row.claim_until <= v_now then
      update public.calendar_image_extractions
      set claim_token = p_claim_token, claim_until = v_now + interval '2 minutes'
      where cache_key = p_cache_key;
    end if;
    return jsonb_build_object('state', 'claimed');
  end if;

  if v_row.claim_token <> p_claim_token then
    return jsonb_build_object('state', 'lost');
  end if;
  if p_action = 'release' then
    delete from public.calendar_image_extractions where cache_key = p_cache_key;
    return jsonb_build_object('state', 'released');
  end if;
  if v_row.claim_until <= v_now then
    return jsonb_build_object('state', 'lost');
  end if;
  if p_action = 'renew' then
    update public.calendar_image_extractions
    set claim_until = v_now + interval '2 minutes'
    where cache_key = p_cache_key;
    return jsonb_build_object('state', 'renewed');
  end if;

  if p_extraction is null or jsonb_typeof(p_extraction) is distinct from 'object'
     or jsonb_typeof(p_extraction->'isEventCalendar') is distinct from 'boolean'
     or jsonb_typeof(p_extraction->'qualificationReason') is distinct from 'string'
     or jsonb_typeof(p_extraction->'events') is distinct from 'array'
     or not (p_extraction ? 'weekStart')
     or p_extraction->'weekStart' not in ('null'::jsonb, '"Monday"'::jsonb, '"Sunday"'::jsonb)
     or octet_length(p_extraction::text) > 4194304
     or (p_extraction->'isEventCalendar' = 'false'::jsonb and p_extraction->'events' <> '[]'::jsonb) then
    raise exception 'Invalid calendar extraction cache payload' using errcode = '22023';
  end if;

  update public.calendar_image_extractions
  set extraction = p_extraction, claim_token = null, claim_until = null, parsed_at = v_now
  where cache_key = p_cache_key;
  return jsonb_build_object('state', 'ready', 'extraction', p_extraction);
end;
$cache$;

revoke all on function public.calendar_image_extraction_cache(text,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.calendar_image_extraction_cache(text,uuid,text,jsonb)
  to service_role;
commit;
