-- Shared first-party source execution exclusion.
-- Applies to every caller of ingestFirstPartySource.
-- No automatic lock expiration: an unresponsive execution
-- must not be replaced while it may still write events.

create table public.first_party_source_executions (
  source_id uuid primary key
    references public.event_harvest_sources(id)
    on delete cascade,
  execution_token uuid not null,
  started_at timestamptz not null default now()
);

alter table public.first_party_source_executions
  enable row level security;

revoke all on public.first_party_source_executions
  from public, anon, authenticated;

create function public.claim_first_party_source_execution(
  p_source_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_source_id is null then
    raise exception 'Source ID is required';
  end if;

  insert into public.first_party_source_executions (
    source_id, execution_token
  )
  values (p_source_id, v_token)
  on conflict (source_id) do nothing;

  if found then
    return v_token;
  end if;

  return null;
end;
$$;

create function public.release_first_party_source_execution(
  p_source_id uuid,
  p_execution_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_source_id is null or p_execution_token is null then
    return false;
  end if;

  delete from public.first_party_source_executions
  where source_id = p_source_id
    and execution_token = p_execution_token;

  return found;
end;
$$;

revoke all on function
  public.claim_first_party_source_execution(uuid)
from public, anon, authenticated;

revoke all on function
  public.release_first_party_source_execution(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.claim_first_party_source_execution(uuid)
to service_role;

grant execute on function
  public.release_first_party_source_execution(uuid, uuid)
to service_role;
