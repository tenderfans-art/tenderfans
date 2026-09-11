-- ============================================================
-- 022 CONTEST PHONE VERIFICATION
-- Provider-independent contest verification / eligibility.
-- Raw phone numbers are NOT stored in these contest tables.
-- ============================================================


-- ------------------------------------------------------------
-- VERIFIED PHONE IDENTITIES
-- phone_hash is a server-generated HMAC of normalized E.164.
-- ------------------------------------------------------------

create table if not exists public.contest_phone_identities (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null unique,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.contest_phone_identities
  enable row level security;


-- ------------------------------------------------------------
-- VERIFICATION CHALLENGES
--
-- Development provider:
-- code_hash stores only the hash of the temporary code.
--
-- Twilio provider later:
-- provider_reference can hold the Verify SID/reference and
-- code_hash can remain null.
-- ------------------------------------------------------------

create table if not exists public.contest_phone_challenges (
  id uuid primary key default gen_random_uuid(),

  phone_hash text not null,

  provider text not null
    check (provider in ('development', 'twilio')),

  provider_reference text,

  code_hash text,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'verified',
        'expired',
        'failed'
      )
    ),

  attempt_count integer not null default 0
    check (attempt_count >= 0),

  resend_count integer not null default 0
    check (resend_count >= 0),

  expires_at timestamptz not null,

  verified_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists
  contest_phone_challenges_phone_hash_idx
on public.contest_phone_challenges(phone_hash);

create index if not exists
  contest_phone_challenges_expires_at_idx
on public.contest_phone_challenges(expires_at);

alter table public.contest_phone_challenges
  enable row level security;


-- ------------------------------------------------------------
-- CONTEST SHOUT ELIGIBILITY
--
-- One row = one verified phone participating in one qualifying
-- Shout for one Tender in one contest.
--
-- Historical rows are intentionally retained.
-- ------------------------------------------------------------

create table if not exists public.contest_shout_entries (
  id uuid primary key default gen_random_uuid(),

  contest_id uuid not null
    references public.contests(id)
    on delete cascade,

  phone_identity_id uuid not null
    references public.contest_phone_identities(id)
    on delete restrict,

  bartender_id uuid not null
    references public.bartenders(id)
    on delete restrict,

  shoutout_id uuid not null unique
    references public.shoutouts(id)
    on delete restrict,

  created_at timestamptz not null default now()
);

create index if not exists
  contest_shout_entries_eligibility_idx
on public.contest_shout_entries(
  contest_id,
  phone_identity_id,
  bartender_id,
  created_at desc
);

create index if not exists
  contest_shout_entries_bartender_idx
on public.contest_shout_entries(
  contest_id,
  bartender_id,
  created_at desc
);

alter table public.contest_shout_entries
  enable row level security;


-- ------------------------------------------------------------
-- No anonymous/client writes.
--
-- Contest verification and entry creation will occur only
-- through server routes using the Supabase secret key.
-- ------------------------------------------------------------

revoke all
on public.contest_phone_identities
from anon, authenticated;

revoke all
on public.contest_phone_challenges
from anon, authenticated;

revoke all
on public.contest_shout_entries
from anon, authenticated;


-- ------------------------------------------------------------
-- Admin read access for future contest auditing/dashboard.
-- ------------------------------------------------------------

drop policy if exists
  "platform admins read contest phone identities"
on public.contest_phone_identities;

create policy
  "platform admins read contest phone identities"
on public.contest_phone_identities
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


drop policy if exists
  "platform admins read contest challenges"
on public.contest_phone_challenges;

create policy
  "platform admins read contest challenges"
on public.contest_phone_challenges
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


drop policy if exists
  "platform admins read contest entries"
on public.contest_shout_entries;

create policy
  "platform admins read contest entries"
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
