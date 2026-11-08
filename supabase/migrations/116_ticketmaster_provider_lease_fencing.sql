-- 116: One Ticketmaster execution lease across legacy and Market jobs.
-- All Ticketmaster writes from the harvester are transactionally fenced.
-- Original canonical event RPCs remain unchanged.
-- No cron changes, Market activation, or replacement scheduler.

begin;

create table public.ticketmaster_provider_run_lease (
  provider text primary key
    check (provider = 'ticketmaster'),
  owner_token uuid,
  leased_until timestamptz not null default '-infinity',
  market_work_id uuid,
  market_lease_token uuid,
  acquired_at timestamptz,
  renewed_at timestamptz,
  constraint ticketmaster_provider_market_pair check (
    (market_work_id is null and market_lease_token is null)
    or
    (market_work_id is not null and market_lease_token is not null)
  )
);

insert into public.ticketmaster_provider_run_lease(provider)
values ('ticketmaster');

alter table public.ticketmaster_provider_run_lease
  enable row level security;

revoke all on public.ticketmaster_provider_run_lease
from public, anon, authenticated;

grant select on public.ticketmaster_provider_run_lease
to service_role;

-- Lock order: shared pool -> optional Market work -> provider.
-- A legacy job uses no Market work identity.
create function public.acquire_ticketmaster_provider_run(
  p_market_id uuid default null,
  p_market_work_id uuid default null,
  p_market_lease_token uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $acquire$
declare
  v_previous record;
  v_token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if (p_market_work_id is null)
     <> (p_market_lease_token is null)
     or (p_market_id is null)
     <> (p_market_work_id is null)
  then
    raise exception 'Incomplete Market provider ownership';
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  if p_market_work_id is not null then
    perform 1
    from public.event_processing_work w
    join public.event_processing_markets m
      on m.id = w.market_id
    where w.id = p_market_work_id
      and w.market_id = p_market_id
      and w.work_type = 'harvest_provider'
      and w.status = 'leased'
      and w.lease_token = p_market_lease_token
      and w.leased_until > clock_timestamp()
      and m.is_enabled = true
    for share of w;

    if not found then
      raise exception 'Market provider work lease is invalid';
    end if;
  end if;

  -- A legacy run cannot overtake Market provider work
  -- already admitted by the shared reservation system.
  -- Both paths serialize through the shared pool row.
  if p_market_work_id is null then
    if exists (
      select 1
      from public.event_processing_dispatch_reservations r
      where r.work_type = 'harvest_provider'
        and r.status in ('reserved', 'claimed')
        and r.expires_at > clock_timestamp()
    )
    or exists (
      select 1
      from public.event_processing_work w
      where w.work_type = 'harvest_provider'
        and w.status = 'leased'
        and w.leased_until > clock_timestamp()
    ) then
      return null;
    end if;
  end if;

  select owner_token, leased_until
    into v_previous
  from public.ticketmaster_provider_run_lease
  where provider = 'ticketmaster'
  for update;

  if not found then
    raise exception 'Ticketmaster provider lease row missing';
  end if;

  if v_previous.owner_token is not null
     and v_previous.leased_until > clock_timestamp()
  then
    return null;
  end if;

  update public.ticketmaster_provider_run_lease
  set owner_token = v_token,
      leased_until = clock_timestamp() + interval '4 minutes',
      market_work_id = p_market_work_id,
      market_lease_token = p_market_lease_token,
      acquired_at = clock_timestamp(),
      renewed_at = clock_timestamp()
  where provider = 'ticketmaster';

  return v_token;
end;
$acquire$;

create function public.renew_ticketmaster_provider_run(
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $renew$
declare
  v_owner record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_token is null then
    return false;
  end if;

  -- Read ownership first, then lock Market work before the
  -- provider row, matching guarded-write lock order.
  select market_work_id, market_lease_token
    into v_owner
  from public.ticketmaster_provider_run_lease
  where provider = 'ticketmaster'
    and owner_token = p_token
    and leased_until > clock_timestamp();

  if not found then
    return false;
  end if;

  if v_owner.market_work_id is not null then
    perform 1
    from public.event_processing_work w
    where w.id = v_owner.market_work_id
      and w.work_type = 'harvest_provider'
      and w.status = 'leased'
      and w.lease_token = v_owner.market_lease_token
      and w.leased_until > clock_timestamp()
    for share;

    if not found then
      return false;
    end if;
  end if;

  update public.ticketmaster_provider_run_lease
  set leased_until = clock_timestamp() + interval '4 minutes',
      renewed_at = clock_timestamp()
  where provider = 'ticketmaster'
    and owner_token = p_token
    and leased_until > clock_timestamp();

  return found;
end;
$renew$;

create function public.release_ticketmaster_provider_run(
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $release$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_token is null then
    return false;
  end if;

  update public.ticketmaster_provider_run_lease
  set owner_token = null,
      leased_until = '-infinity',
      market_work_id = null,
      market_lease_token = null,
      renewed_at = clock_timestamp()
  where provider = 'ticketmaster'
    and owner_token = p_token;

  return found;
end;
$release$;

-- Guard and canonical write execute within ONE SQL transaction.
-- Argument metadata comes exclusively from PostgreSQL's own
-- function catalog, never from caller-supplied SQL identifiers.
--
-- Resolves the current Ticketmaster flyer-aware function and
-- its existing backward-compatible overload correctly.
create function public.execute_fenced_ticketmaster_operation(
  p_execution_token uuid,
  p_market_work_id uuid,
  p_market_lease_token uuid,
  p_operation text,
  p_args jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $write$
declare
  v_provider record;
  v_proc record;
  v_index integer;
  v_arg_name text;
  v_arg_type text;
  v_arguments text := '';
  v_sql text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_execution_token is null
     or p_args is null
     or jsonb_typeof(p_args) <> 'object'
     or p_operation is null
     or p_operation not in (
       'record_event_harvest_venue_scan',
       'upsert_event_harvest_venue_match',
       'auto_approve_event_harvest_venue_match',
       'upsert_event_harvest_candidate',
       'link_harvest_candidate_to_existing_event',
       'graduate_harvest_candidate',
       'sync_ticketmaster_event'
     )
  then
    raise exception 'Invalid fenced Ticketmaster operation';
  end if;

  if (p_market_work_id is null)
     <> (p_market_lease_token is null)
  then
    raise exception 'Incomplete Market write ownership';
  end if;

  -- Lock work first. A competing reassignment cannot replace
  -- the owner while this transaction is writing events.
  if p_market_work_id is not null then
    perform 1
    from public.event_processing_work w
    where w.id = p_market_work_id
      and w.work_type = 'harvest_provider'
      and w.status = 'leased'
      and w.lease_token = p_market_lease_token
      and w.leased_until > clock_timestamp()
    for share;

    if not found then
      raise exception 'Ticketmaster Market work lease expired';
    end if;
  end if;

  -- A competing acquisition or release cannot change the
  -- global provider owner during the underlying write.
  select *
    into v_provider
  from public.ticketmaster_provider_run_lease l
  where l.provider = 'ticketmaster'
    and l.owner_token = p_execution_token
    and l.leased_until > clock_timestamp()
    and l.market_work_id is not distinct from p_market_work_id
    and l.market_lease_token is not distinct from p_market_lease_token
  for share;

  if not found then
    raise exception 'Ticketmaster provider lease expired or superseded';
  end if;

  -- Match named arguments, including mandatory parameters.
  -- Prefer the fuller matching signature when overloads exist.
  select p.*
    into v_proc
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n
    on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = p_operation
    and p.prokind = 'f'
    and not exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_args) supplied(arg_name)
      where not (supplied.arg_name = any(p.proargnames))
    )
    and not exists (
      select 1
      from pg_catalog.generate_series(
        1, p.pronargs - p.pronargdefaults
      ) required(arg_index)
      where not (p_args ? p.proargnames[required.arg_index])
    )
  order by p.pronargs desc, p.oid desc
  limit 1;

  if not found then
    raise exception
      'No compatible Ticketmaster RPC signature: %', p_operation;
  end if;

  for v_index in 1..v_proc.pronargs loop
    v_arg_name := v_proc.proargnames[v_index];

    if not (p_args ? v_arg_name) then
      continue;
    end if;

    v_arg_type := pg_catalog.format_type(
      v_proc.proargtypes[v_index - 1],
      null
    );

    if v_arguments <> '' then
      v_arguments := v_arguments || ', ';
    end if;

    if v_arg_type in ('json', 'jsonb') then
      v_arguments := v_arguments || pg_catalog.format(
        '%I => ($1 -> %L)::%s',
        v_arg_name, v_arg_name, v_arg_type
      );
    else
      v_arguments := v_arguments || pg_catalog.format(
        '%I => ($1 ->> %L)::%s',
        v_arg_name, v_arg_name, v_arg_type
      );
    end if;
  end loop;

  if v_proc.prorettype = 'pg_catalog.void'::regtype then
    v_sql := pg_catalog.format(
      'select public.%I(%s)',
      p_operation, v_arguments
    );
    execute v_sql using p_args;
    return 'null'::jsonb;
  end if;

  v_sql := pg_catalog.format(
    'select pg_catalog.to_jsonb(public.%I(%s))',
    p_operation, v_arguments
  );

  execute v_sql into v_result using p_args;
  return v_result;
end;
$write$;

revoke all on function
  public.acquire_ticketmaster_provider_run(uuid,uuid,uuid),
  public.renew_ticketmaster_provider_run(uuid),
  public.release_ticketmaster_provider_run(uuid),
  public.execute_fenced_ticketmaster_operation(
    uuid,uuid,uuid,text,jsonb
  )
from public, anon, authenticated;

grant execute on function
  public.acquire_ticketmaster_provider_run(uuid,uuid,uuid),
  public.renew_ticketmaster_provider_run(uuid),
  public.release_ticketmaster_provider_run(uuid),
  public.execute_fenced_ticketmaster_operation(
    uuid,uuid,uuid,text,jsonb
  )
to service_role;


create or replace function public.shared_market_work_eligible(
  p_market_id uuid,
  p_work_type text,
  p_venue_id uuid,
  p_source_id uuid,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $eligible$
  select case
    when p_work_type = 'harvest_source' then exists (
      select 1
      from public.event_harvest_sources src
      where src.id = p_source_id
        and src.provider = 'first_party'
        and src.is_enabled = true
        and public.event_processing_source_in_market(
          src.id, p_market_id
        )
        and not exists (
          select 1
          from public.first_party_source_executions e
          where e.source_id = src.id
        )
    )

    when p_work_type = 'detect_spot' then exists (
      select 1
      from public.event_processing_market_venues mv
      join public.venues v on v.id = mv.venue_id
      where mv.market_id = p_market_id
        and mv.venue_id = p_venue_id
        and v.status = 'active'
        and nullif(trim(v.website_url), '') is not null
        and not exists (
          select 1
          from public.event_harvest_archive a
          where a.venue_id = v.id
            and a.restored_at is null
        )
    )

    when p_work_type = 'archive_recheck' then exists (
      select 1
      from public.event_harvest_archive a
      join public.venues v on v.id = a.venue_id
      join public.event_processing_market_venues mv
        on mv.venue_id = a.venue_id
      where a.venue_id = p_venue_id
        and mv.market_id = p_market_id
        and a.restored_at is null
        and a.next_check_at <= p_now
        and v.status = 'active'
        and nullif(trim(v.website_url), '') is not null
    )

    when p_work_type = 'harvest_provider' then
      exists (
        select 1
        from public.event_harvest_sources src
        where src.provider = 'ticketmaster'
          and src.external_source_id = 'discovery-v2'
          and src.is_enabled = true
      )
      and exists (
        select 1
        from public.event_processing_market_venues mv
        join public.venues v on v.id = mv.venue_id
        where mv.market_id = p_market_id
          and v.status = 'active'
      )
      -- Legacy and Market Ticketmaster share one provider owner.
      and not exists (
        select 1
        from public.ticketmaster_provider_run_lease l
        where l.provider = 'ticketmaster'
          and l.owner_token is not null
          and l.leased_until > p_now
      )

    else false
  end;
$eligible$;

commit;
