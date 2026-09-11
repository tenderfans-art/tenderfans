-- ============================================================
-- 027 PUBLIC CONTEST LEADERBOARD
--
-- Safely expose aggregate contest entry counts without exposing
-- phone identities, shoutout IDs, or private contest-entry rows.
-- ============================================================

create or replace function public.public_active_contest_leaderboard()
returns table (
  contest_id uuid,
  bartender_id uuid,
  entry_count bigint
)
language sql
security definer
stable
set search_path = public
as $$
  select
    c.id as contest_id,
    e.bartender_id,
    count(e.id)::bigint as entry_count
  from public.contests c
  join public.contest_shout_entries e
    on e.contest_id = c.id
  where c.is_active = true
    and c.starts_at <= now()
    and c.ends_at >= now()
  group by
    c.id,
    e.bartender_id;
$$;

revoke all
on function public.public_active_contest_leaderboard()
from public;

grant execute
on function public.public_active_contest_leaderboard()
to anon, authenticated;
