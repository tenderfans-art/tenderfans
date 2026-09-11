-- ============================================================
-- 025 CONTEST SMS MARKETING CONSENT
--
-- Contest verification remains separate from marketing.
-- Raw phone numbers are stored ONLY when the verified user
-- explicitly opts in to TenderFans promotional SMS.
-- ============================================================


-- ------------------------------------------------------------
-- Add auditable consent fields to verification challenges.
-- ------------------------------------------------------------

alter table public.contest_phone_challenges
  add column if not exists contest_terms_accepted_at timestamptz,
  add column if not exists contest_terms_version text,
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists marketing_consent_version text;


-- ------------------------------------------------------------
-- PRIVATE SMS MARKETING SUBSCRIBERS
-- ------------------------------------------------------------

create table if not exists public.marketing_sms_subscribers (
  id uuid primary key default gen_random_uuid(),

  phone_e164 text not null unique,

  status text not null default 'active'
    check (
      status in (
        'active',
        'unsubscribed'
      )
    ),

  consented_at timestamptz not null,
  consent_source text not null,
  consent_version text not null,

  verified_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marketing_sms_subscribers
  enable row level security;


-- No browser/client access.
revoke all
on public.marketing_sms_subscribers
from anon, authenticated;


-- Platform Admin may read marketing subscribers.
drop policy if exists
  "platform admins read sms marketing subscribers"
on public.marketing_sms_subscribers;

create policy
  "platform admins read sms marketing subscribers"
on public.marketing_sms_subscribers
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);
