-- Migration 096
-- First-party execution ownership validation and controlled recovery.
--
-- Does not modify existing ingestion RPC signatures.
-- Does not enable Workflows or automatic lock expiration.
-- Does not automatically recover any execution.
--
-- IMPORTANT:
-- The ownership assertion must be integrated into every protected
-- first-party write path before controlled recovery is enabled
-- operationally. Existing writes are NOT fenced by this migration.

create or replace function
public.assert_first_party_execution_ownership(
  p_source_id uuid,
  p_execution_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_source_id is null
     or p_execution_token is null then
    raise exception
      'First-party execution ownership requires source and token';
  end if;

  -- Lock the execution row until the caller's transaction ends.
  -- Recovery cannot replace this ownership while the protected
  -- transaction is still running.
  perform 1
  from public.first_party_source_executions execution
  where execution.source_id = p_source_id
    and execution.execution_token = p_execution_token
  for update;

  if not found then
    raise exception
      'First-party execution ownership lost for source %',
      p_source_id;
  end if;
end;
$$;

revoke all on function
public.assert_first_party_execution_ownership(uuid, uuid)
from public, anon, authenticated;

grant execute on function
public.assert_first_party_execution_ownership(uuid, uuid)
to service_role;


-- Controlled token-checked recovery.
--
-- The caller must supply the currently recorded execution token.
-- A mismatched token cannot remove a newer execution.
--
-- This is deliberately NOT a scheduled cleanup operation.
--
-- OPERATIONAL WARNING:
-- Do not invoke recovery until every first-party write path
-- has been fenced and recovery authorization has been reviewed.

create table public.first_party_execution_recoveries (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null
    references public.event_harvest_sources(id)
    on delete cascade,
  previous_execution_token uuid not null,
  reason text not null,
  recovered_at timestamptz not null default now()
);

alter table public.first_party_execution_recoveries
  enable row level security;

revoke all on public.first_party_execution_recoveries
from public, anon, authenticated;

create or replace function
public.recover_first_party_source_execution(
  p_source_id uuid,
  p_execution_token uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_source_id is null
     or p_execution_token is null
     or nullif(trim(p_reason), '') is null then
    raise exception
      'Recovery requires source, execution token, and reason';
  end if;

  delete from public.first_party_source_executions
  where source_id = p_source_id
    and execution_token = p_execution_token;

  if not found then
    return false;
  end if;

  insert into public.first_party_execution_recoveries (
    source_id,
    previous_execution_token,
    reason
  )
  values (
    p_source_id,
    p_execution_token,
    trim(p_reason)
  );

  return true;
end;
$$;

revoke all on function
public.recover_first_party_source_execution(uuid, uuid, text)
from public, anon, authenticated;

-- Intentionally NO execute grant to service_role.
-- Recovery remains unavailable to normal application workers.
-- A separate administrative authorization design is required.
