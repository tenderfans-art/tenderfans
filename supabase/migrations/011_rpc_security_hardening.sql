-- TenderFans V1 RPC security hardening
-- Remove PostgreSQL's default PUBLIC execute privilege from sensitive
-- Partner/Admin SECURITY DEFINER RPCs.
-- Only authenticated users and service_role may invoke them.
-- Internal authorization checks remain in each function.

revoke execute on function public.admin_pending_events()
from public, anon;

revoke execute on function public.admin_pending_partner_profiles()
from public, anon;

revoke execute on function public.admin_review_event(uuid, boolean)
from public, anon;

revoke execute on function public.admin_review_partner_profile(uuid, boolean)
from public, anon;

revoke execute on function public.delete_my_partner_access()
from public, anon;

revoke execute on function public.partner_delete_approved_event(uuid)
from public, anon;

revoke execute on function public.partner_update_approved_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
from public, anon;

grant execute on function public.admin_pending_events()
to authenticated, service_role;

grant execute on function public.admin_pending_partner_profiles()
to authenticated, service_role;

grant execute on function public.admin_review_event(uuid, boolean)
to authenticated, service_role;

grant execute on function public.admin_review_partner_profile(uuid, boolean)
to authenticated, service_role;

grant execute on function public.delete_my_partner_access()
to authenticated, service_role;

grant execute on function public.partner_delete_approved_event(uuid)
to authenticated, service_role;

grant execute on function public.partner_update_approved_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
to authenticated, service_role;
