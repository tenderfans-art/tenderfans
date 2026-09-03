-- Admin-only pending claim details, including claimant auth email.

create or replace function public.admin_pending_claim_details()
returns table (
  id uuid,
  entity_kind public.entity_kind,
  status public.claim_status,
  created_at timestamptz,
  bartender_id uuid,
  venue_id uuid,
  claimant_user_id uuid,
  claimant_username text,
  claimant_email text,
  claimed_name text
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    ec.id,
    ec.entity_kind,
    ec.status,
    ec.created_at,
    ec.bartender_id,
    ec.venue_id,
    ec.claimant_user_id,
    p.username as claimant_username,
    u.email::text as claimant_email,
    case
      when ec.entity_kind = 'bartender' then b.display_name
      when ec.entity_kind = 'venue' then v.name
      else null
    end as claimed_name
  from public.entity_claims ec
  join public.profiles p
    on p.id = ec.claimant_user_id
  join auth.users u
    on u.id = ec.claimant_user_id
  left join public.bartenders b
    on b.id = ec.bartender_id
  left join public.venues v
    on v.id = ec.venue_id
  where ec.status = 'pending'
  order by ec.created_at asc;
end;
$$;

revoke all on function public.admin_pending_claim_details() from public;
grant execute on function public.admin_pending_claim_details() to authenticated;
