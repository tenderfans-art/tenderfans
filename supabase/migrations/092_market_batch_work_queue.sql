-- TenderFans market-based event processing foundation.
-- Additive only: no existing event or source lifecycle changes.

create table public.event_processing_markets (
  id uuid primary key default gen_random_uuid(),
  market_key text not null unique,
  display_name text not null,
  is_enabled boolean not null default false,
  detector_batch_size integer not null default 10
    check (detector_batch_size between 1 and 100),
  harvester_batch_size integer not null default 10
    check (harvester_batch_size between 1 and 100),
  max_concurrent_batches integer not null default 2
    check (max_concurrent_batches between 1 and 20),
  detector_interval_minutes integer not null default 1440
    check (detector_interval_minutes >= 15),
  harvester_interval_minutes integer not null default 1440
    check (harvester_interval_minutes >= 15),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_key_format check (
    market_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )
);

create table public.event_processing_market_venues (
  venue_id uuid primary key
    references public.venues(id) on delete cascade,
  market_id uuid not null
    references public.event_processing_markets(id)
    on delete restrict,
  assigned_at timestamptz not null default now()
);

create index event_processing_market_venues_market_idx
  on public.event_processing_market_venues(market_id, venue_id);

create table public.event_processing_work (
  id uuid primary key default gen_random_uuid(),

  market_id uuid
    references public.event_processing_markets(id)
    on delete restrict,

  work_type text not null
    check (work_type in (
      'detect_spot',
      'harvest_source',
      'archive_recheck',
      'harvest_provider'
    )),

  venue_id uuid
    references public.venues(id) on delete cascade,

  source_id uuid
    references public.event_harvest_sources(id)
    on delete cascade,

  status text not null default 'pending'
    check (status in (
      'pending', 'leased', 'completed',
      'retry', 'failed', 'cancelled'
    )),

  priority integer not null default 100,
  due_at timestamptz not null default now(),

  attempts integer not null default 0
    check (attempts >= 0),

  max_attempts integer not null default 5
    check (max_attempts between 1 and 100),

  lease_token uuid,
  leased_until timestamptz,

  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error text,

  batch_id uuid,
  result jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_target_shape check (
    (
      work_type in ('detect_spot', 'archive_recheck')
      and venue_id is not null
      and source_id is null
    )
    or (
      work_type = 'harvest_source'
      and source_id is not null
      and venue_id is null
    )
    or (
      work_type = 'harvest_provider'
      and source_id is null
      and venue_id is null
    )
  ),

  constraint work_lease_shape check (
    (
      status = 'leased'
      and lease_token is not null
      and leased_until is not null
    )
    or (
      status <> 'leased'
      and lease_token is null
      and leased_until is null
    )
  )
);

create index event_processing_work_due_idx
  on public.event_processing_work (
    market_id, work_type, priority, due_at, id
  )
  where status in ('pending', 'retry');

create index event_processing_work_expired_idx
  on public.event_processing_work (leased_until, id)
  where status = 'leased';

create index event_processing_work_batch_idx
  on public.event_processing_work (batch_id)
  where batch_id is not null;

-- Prevent simultaneous active work records for one target.
-- Completed records remain available as execution history.

create unique index event_processing_active_venue_idx
  on public.event_processing_work (work_type, venue_id)
  where venue_id is not null
    and status in ('pending', 'leased', 'retry');

create unique index event_processing_active_source_idx
  on public.event_processing_work (work_type, source_id)
  where source_id is not null
    and status in ('pending', 'leased', 'retry');

create unique index event_processing_active_provider_idx
  on public.event_processing_work (
    work_type, coalesce(market_id::text, 'global')
  )
  where work_type = 'harvest_provider'
    and status in ('pending', 'leased', 'retry');

alter table public.event_processing_markets
  enable row level security;

alter table public.event_processing_market_venues
  enable row level security;

alter table public.event_processing_work
  enable row level security;

-- Service-role access only for now.
-- No public or authenticated policies are introduced.

revoke all on public.event_processing_markets
  from anon, authenticated;

revoke all on public.event_processing_market_venues
  from anon, authenticated;

revoke all on public.event_processing_work
  from anon, authenticated;

-- Configuration only. Disabled until migration rollout.
insert into public.event_processing_markets (
  market_key, display_name
)
values ('tampa-bay', 'Tampa Bay')
on conflict (market_key) do nothing;
