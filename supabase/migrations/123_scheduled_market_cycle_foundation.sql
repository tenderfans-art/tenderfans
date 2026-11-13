-- 123: Durable scheduled Market-cycle foundation.
--
-- Additive only. Does not activate scheduled processing,
-- replace queue RPCs, modify active work or change capacity.
-- Existing source ownership, retries, reviews, publication,
-- Workflow reservations and Market isolation are preserved.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Scheduling belongs to each Market, not individual Spots.
alter table public.event_processing_markets
  add column schedule_enabled boolean not null default false,
  add column schedule_timezone text not null default 'UTC'
    check (length(schedule_timezone) between 3 and 64),
  add column schedule_local_time time without time zone
    not null default time '09:30:00',
  add column next_scheduled_at timestamptz,
  add column last_scheduled_at timestamptz;

-- A future coordinator can discover due Markets through an
-- indexed schedule rather than scanning all enabled Markets.
create index event_processing_markets_schedule_due_idx
on public.event_processing_markets(next_scheduled_at, id)
where is_enabled = true
  and schedule_enabled = true;

-- One durable record per scheduled Market occurrence.
create table public.event_processing_market_cycles (
  id uuid primary key default gen_random_uuid(),

  market_id uuid not null
    references public.event_processing_markets(id)
    on delete restrict,

  scheduled_for timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,

  status text not null default 'running'
    check (status in (
      'running',
      'completed',
      'completed_with_failures',
      'cancelled'
    )),

  expected_spots integer not null default 0
    check (expected_spots >= 0),

  expected_shared_sources integer not null default 0
    check (expected_shared_sources >= 0),

  expected_archive_checks integer not null default 0
    check (expected_archive_checks >= 0),

  expected_provider_jobs integer not null default 0
    check (expected_provider_jobs >= 0),

  peak_active_sources integer not null default 0
    check (peak_active_sources >= 0),

  peak_active_workflows integer not null default 0
    check (peak_active_workflows >= 0),

  last_observed_at timestamptz,

  created_at timestamptz not null default now(),

  constraint market_cycle_schedule_unique
    unique (market_id, scheduled_for),

  constraint market_cycle_identity_scope_unique
    unique (id, market_id),

  constraint market_cycle_completion_shape check (
    (
      status = 'running'
      and finished_at is null
    )
    or (
      status <> 'running'
      and finished_at is not null
      and finished_at >= started_at
    )
  )
);

-- A Market cannot have two simultaneously running cycles.
create unique index event_processing_one_running_cycle_idx
on public.event_processing_market_cycles(market_id)
where status = 'running';

create index event_processing_market_cycles_history_idx
on public.event_processing_market_cycles(
  market_id, scheduled_for desc
);

-- Existing work remains unassigned to a new cycle.
-- New work will receive a cycle identity at queue creation.
alter table public.event_processing_work
  add column market_cycle_id uuid;

-- Enforce that a cycle's work belongs to the same Market.
-- NOT VALID avoids a historical-table validation scan during
-- this live, additive migration. New writes are enforced.
alter table public.event_processing_work
  add constraint event_processing_work_cycle_scope_fk
  foreign key (market_cycle_id, market_id)
  references public.event_processing_market_cycles(id, market_id)
  on delete restrict
  not valid;

alter table public.event_processing_work
  add constraint event_processing_work_cycle_market_required
  check (
    market_cycle_id is null
    or market_id is not null
  )
  not valid;

create index event_processing_work_cycle_status_idx
on public.event_processing_work(
  market_cycle_id, status, work_type
)
where market_cycle_id is not null;

alter table public.event_processing_market_cycles
  enable row level security;

revoke all on public.event_processing_market_cycles
from public, anon, authenticated;

grant select, insert, update
on public.event_processing_market_cycles
to service_role;

-- Readable cycle metrics. Each query can be restricted to
-- a Market and its latest scheduled occurrence.
create view public.event_processing_market_cycle_progress
with (security_invoker = true)
as
select
  c.id as cycle_id,
  c.market_id,
  m.market_key,
  m.display_name,
  c.scheduled_for,
  c.started_at,
  c.finished_at,
  c.status,

  round(
    extract(
      epoch from (
        coalesce(c.finished_at, clock_timestamp())
        - c.started_at
      )
    )::numeric,
    2
  ) as elapsed_seconds,

  c.expected_spots,
  c.expected_shared_sources,
  c.expected_archive_checks,
  c.expected_provider_jobs,

  progress.total_jobs,
  progress.pending_jobs,
  progress.retry_jobs,
  progress.leased_jobs,
  progress.completed_jobs,
  progress.failed_jobs,
  progress.cancelled_jobs,

  progress.completed_spots,
  progress.failed_spots,
  progress.completed_shared_sources,
  progress.failed_shared_sources,
  progress.harvest_skipped_spots,

  c.peak_active_sources,
  c.peak_active_workflows,
  c.last_observed_at

from public.event_processing_market_cycles c
join public.event_processing_markets m
  on m.id = c.market_id

cross join lateral (
  select
    count(*)::integer as total_jobs,

    count(*) filter (
      where w.status = 'pending'
    )::integer as pending_jobs,

    count(*) filter (
      where w.status = 'retry'
    )::integer as retry_jobs,

    count(*) filter (
      where w.status = 'leased'
    )::integer as leased_jobs,

    count(*) filter (
      where w.status = 'completed'
    )::integer as completed_jobs,

    count(*) filter (
      where w.status = 'failed'
    )::integer as failed_jobs,

    count(*) filter (
      where w.status = 'cancelled'
    )::integer as cancelled_jobs,

    count(*) filter (
      where w.work_type = 'detect_spot'
        and w.status = 'completed'
    )::integer as completed_spots,

    count(*) filter (
      where w.work_type = 'detect_spot'
        and w.status = 'failed'
    )::integer as failed_spots,

    count(*) filter (
      where w.work_type = 'harvest_source'
        and w.status = 'completed'
    )::integer as completed_shared_sources,

    count(*) filter (
      where w.work_type = 'harvest_source'
        and w.status = 'failed'
    )::integer as failed_shared_sources,

    count(*) filter (
      where w.work_type = 'detect_spot'
        and w.status = 'completed'
        and w.result ->> 'harvestSkipped' = 'true'
    )::integer as harvest_skipped_spots

  from public.event_processing_work w
  where w.market_cycle_id = c.id
) progress;

revoke all
on public.event_processing_market_cycle_progress
from public, anon, authenticated;

grant select
on public.event_processing_market_cycle_progress
to service_role;

-- Configure Pinellas's local clock without starting cycles.
-- The isolation-test Market is deliberately untouched.
update public.event_processing_markets
set
  schedule_timezone = 'America/New_York',
  schedule_local_time = time '09:30:00'
where market_key = 'pinellas-county'
  and schedule_enabled = false;

commit;
