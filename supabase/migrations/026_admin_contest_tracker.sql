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
