-- 111: Establish 16 concurrent source slots as the
-- standard Market admission ceiling.
--
-- This is an intentional capacity-policy upgrade, not
-- a correction to migration 110.
--
-- The existing shared pool remains the actual global
-- execution authority. This migration does not increase
-- global compute, transport limits, or Workflow counts.
--
-- Existing custom per-Market limits other than the
-- original default of 8 remain unchanged.
--
-- No Market is enabled or disabled, and no historical
-- work, source, reservation or execution record changes.

begin;

alter table public.event_processing_markets
  alter column max_concurrent_sources set default 16;

update public.event_processing_markets
set
  max_concurrent_sources = 16,
  updated_at = now()
where max_concurrent_sources = 8;

comment on column
  public.event_processing_markets.max_concurrent_sources
is
  'Per-Market hard concurrent source admission limit. '
  'Standard baseline is 16. Execution also requires '
  'available shared global and transport capacity. '
  'Future overflow policy may allow higher configured limits.';

commit;
