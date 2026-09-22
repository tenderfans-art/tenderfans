-- ============================================================
-- TENDER NOTIFICATION PREFERENCES
-- Private contact preferences for claimed Tenders.
-- Email remains authoritative in Supabase Auth.
-- ============================================================

create table public.tender_notification_preferences (
  id uuid primary key default gen_random_uuid(),

  bartender_id uuid not null
    references public.bartenders(id) on delete cascade,

  user_id uuid not null
    references public.profiles(id) on delete cascade,

  wants_email boolean not null default true,
  wants_sms boolean not null default false,

  phone_e164 text,
  phone_verified boolean not null default false,
  phone_verification_sent_at timestamptz,
  phone_verified_at timestamptz,

  sms_consent_at timestamptz,
  sms_consent_source text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (bartender_id, user_id),

  constraint tender_notification_preferences_sms_check
    check (wants_sms = false or phone_e164 is not null)
);

create index tender_notification_preferences_bartender_idx
  on public.tender_notification_preferences(bartender_id);

create index tender_notification_preferences_user_idx
  on public.tender_notification_preferences(user_id);

alter table public.tender_notification_preferences
  enable row level security;

create policy "tender owners can read notification preferences"
on public.tender_notification_preferences
for select
to authenticated
using (
  user_id = auth.uid()
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_notification_preferences.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
);

create policy "tender owners can create notification preferences"
on public.tender_notification_preferences
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_notification_preferences.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
);

create policy "tender owners can update notification preferences"
on public.tender_notification_preferences
for update
to authenticated
using (
  user_id = auth.uid()
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_notification_preferences.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
)
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id =
      tender_notification_preferences.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
);

revoke all on public.tender_notification_preferences from anon;

grant select, insert, update
on public.tender_notification_preferences
to authenticated;
