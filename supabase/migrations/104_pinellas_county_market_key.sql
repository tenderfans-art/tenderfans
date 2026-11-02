-- 104: Rename the existing first Market to its county-based key.
--
-- Preserve Market UUID, Spot memberships, workflows, contest ownership,
-- configuration and historical records.
-- Do not alter the Workflow Isolation Test Market.
-- Safe to rerun after successful application.

begin;

do $$
declare
  v_old_id uuid;
  v_new_id uuid;
  v_market_id uuid;
  v_display_name text;
begin
  select id
  into v_old_id
  from public.event_processing_markets
  where market_key = 'tampa-bay'
  for update;

  select id
  into v_new_id
  from public.event_processing_markets
  where market_key = 'pinellas-county'
  for update;

  if v_old_id is not null and v_new_id is not null then
    raise exception
      'Both old and new Market keys exist; manual review required';
  end if;

  v_market_id := coalesce(v_old_id, v_new_id);

  if v_market_id is null then
    raise exception 'Existing Pinellas County Market not found';
  end if;

  select display_name
  into v_display_name
  from public.event_processing_markets
  where id = v_market_id;

  if v_display_name is distinct from 'Pinellas County' then
    raise exception
      'Unexpected Market display name: %', v_display_name;
  end if;

  if not exists (
    select 1
    from public.contests
    where id = 'f3062c04-2b5c-4d4b-8534-3de8342e334a'
      and market_id = v_market_id
  ) then
    raise exception
      'Inaugural contest Market ownership mismatch';
  end if;

  update public.event_processing_markets
  set market_key = 'pinellas-county',
      updated_at = now()
  where id = v_market_id
    and market_key = 'tampa-bay';

  if not exists (
    select 1
    from public.event_processing_markets
    where id = v_market_id
      and market_key = 'pinellas-county'
      and display_name = 'Pinellas County'
  ) then
    raise exception 'Pinellas County key update failed';
  end if;
end;
$$;

commit;
