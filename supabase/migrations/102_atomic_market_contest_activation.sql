-- Atomic, market-owned contest activation.
-- Transitional: preserve the original global active-contest index.
-- Do not enable simultaneous markets until public contest routing
-- and contest Shout submission are market-aware.

create function public.admin_set_market_contest_active(
  p_contest_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  if p_contest_id is null or p_active is null then
    raise exception 'Contest and activation state are required';
  end if;

  select market_id
  into v_market_id
  from public.contests
  where id = p_contest_id;

  if not found then
    raise exception 'Contest not found';
  end if;

  if v_market_id is null then
    raise exception
      'Assign this contest to a Market before activation';
  end if;

  -- Serialize competing activation requests for this Market.
  perform 1
  from public.event_processing_markets
  where id = v_market_id
  for update;

  if not found then
    raise exception 'Owning Market not found';
  end if;

  if p_active then
    update public.contests
    set is_active = false,
        updated_at = now()
    where market_id = v_market_id
      and id <> p_contest_id
      and is_active = true;

    update public.contests
    set is_active = true,
        updated_at = now()
    where id = p_contest_id
      and market_id = v_market_id;
  else
    update public.contests
    set is_active = false,
        updated_at = now()
    where id = p_contest_id
      and market_id = v_market_id;
  end if;

  if not found then
    raise exception 'Contest activation failed';
  end if;
end;
$$;

revoke all on function
  public.admin_set_market_contest_active(uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.admin_set_market_contest_active(uuid, boolean)
to authenticated;
