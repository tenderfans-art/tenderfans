-- ============================================================
-- FIRST-PARTY SOURCE BOOTSTRAP STATE
--
-- Initial source inventory is published silently via the
-- bootstrap graduation path. Once that initial inventory has
-- completed successfully, bootstrapped_at permanently marks the
-- source so future discoveries use normal publication behavior.
-- ============================================================

alter table public.event_harvest_sources
  add column if not exists bootstrapped_at timestamptz;


create or replace function public.mark_first_party_source_bootstrapped(
  p_source_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  marked_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  update public.event_harvest_sources
  set
    bootstrapped_at = coalesce(bootstrapped_at, now()),
    updated_at = now()
  where id = p_source_id
    and provider = 'first_party'
    and is_enabled = true
  returning bootstrapped_at
  into marked_at;

  if marked_at is null then
    raise exception 'Enabled first-party source not found';
  end if;

  return marked_at;
end;
$$;


revoke all
on function public.mark_first_party_source_bootstrapped(uuid)
from public;

grant execute
on function public.mark_first_party_source_bootstrapped(uuid)
to service_role;
