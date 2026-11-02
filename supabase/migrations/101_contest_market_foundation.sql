-- 101: Contest market ownership foundation.
--
-- Additive only. Do not alter the current contest activation
-- behavior, existing records, public Shout flow, or cooldowns.
--
-- Existing contests remain unassigned until their intended
-- market is verified and backfilled explicitly.

alter table public.contests
  add column market_id uuid
  references public.event_processing_markets(id)
  on delete restrict;

comment on column public.contests.market_id is
  'Owning TenderFans market. Existing contests require '
  'explicit assignment before multi-market activation.';

create index contests_market_history_idx
  on public.contests (market_id, starts_at desc);

-- Enforce at most one active contest per assigned market.
-- The original global unique index remains in place until
-- all contest creation, activation, public Shout selection,
-- and leaderboard paths are market-aware.
create unique index contests_one_active_per_market_idx
  on public.contests (market_id)
  where is_active = true
    and market_id is not null;
