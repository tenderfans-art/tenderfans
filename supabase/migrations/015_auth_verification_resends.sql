create table if not exists public.auth_verification_resends (
  email text primary key,
  resend_count integer not null default 0,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint auth_verification_resends_count_check
    check (resend_count >= 0 and resend_count <= 3)
);

alter table public.auth_verification_resends enable row level security;

revoke all on table public.auth_verification_resends
from anon, authenticated;

grant all on table public.auth_verification_resends
to service_role;
