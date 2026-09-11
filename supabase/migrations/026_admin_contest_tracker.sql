-- ============================================================
-- 026 ADMIN CONTEST TRACKER
-- Allow Platform Admins to read private Tender social-tag
-- permissions for contest promotion management.
-- ============================================================

drop policy if exists
  "platform admins read tender social permissions"
on public.tender_social_permissions;

create policy
  "platform admins read tender social permissions"
on public.tender_social_permissions
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

-- ------------------------------------------------------------
-- Platform Admins may read qualifying contest Shout entries.
-- ------------------------------------------------------------

drop policy if exists
  "platform admins read contest shout entries"
on public.contest_shout_entries;

create policy
  "platform admins read contest shout entries"
on public.contest_shout_entries
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

-- Table-level SELECT privilege required before the Admin RLS policy
-- can authorize individual rows.
grant select on table public.contest_shout_entries to authenticated;

-- Table-level privileges required before Admin RLS policies can
-- authorize reads from the private contest tracker tables.
grant select on table public.marketing_sms_subscribers to authenticated;
grant select on table public.tender_social_permissions to authenticated;
