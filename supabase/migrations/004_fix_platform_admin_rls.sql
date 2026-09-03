-- Fix recursive RLS policy on platform_admins

drop policy if exists "admins can read platform admins"
on public.platform_admins;

create policy "admins can read platform admins"
on public.platform_admins
for select
to authenticated
using (
  user_id = auth.uid()
);
