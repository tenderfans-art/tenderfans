create extension if not exists pg_trgm;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.role() returns text language sql as $$select 'service_role'::text$$;
create function auth.uid() returns uuid language sql as $$select null::uuid$$;
create table public.venues(id uuid primary key, name text, status text default 'active',
  latitude double precision, longitude double precision);
create table public.platform_admins(user_id uuid);
create table public.venue_external_refs(
  venue_id uuid references public.venues(id), provider text, provider_place_id text,
  metadata jsonb default '{}'::jsonb, primary key(provider,provider_place_id), unique(venue_id,provider)
);
create table public.events(
  id uuid primary key default gen_random_uuid(), venue_id uuid references public.venues(id),
  title text not null, description text, starts_at timestamptz not null, ends_at timestamptz,
  status text not null default 'draft' check(status in ('draft','published','cancelled')),
  submitted_by uuid, reviewed_by uuid, reviewed_at timestamptz,
  venue_approval_status text default 'pending', admin_approval_status text default 'pending',
  flyer_url text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.notification_events(
  id uuid primary key default gen_random_uuid(), entity_kind text, venue_id uuid,
  event_type text, source_kind text, source_id uuid, metadata jsonb default '{}'::jsonb,
  status text default 'pending', processed_at timestamptz
);
create unique index notification_events_event_unique
  on public.notification_events(event_type,source_kind,source_id);
create table public.event_reminders(
  id uuid primary key default gen_random_uuid(), event_id uuid references public.events(id),
  email text, phone_e164 text, wants_email boolean default false, wants_sms boolean default false,
  email_verified boolean default false, phone_verified boolean default false,
  reminder_minutes_before integer default 60, status text default 'active',
  reminder_sent_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
);
create unique index event_reminders_unique_email_event_time
  on public.event_reminders(event_id,reminder_minutes_before,lower(email)) where email is not null;
create table public.notification_outbox(
  id uuid primary key default gen_random_uuid(), event_id uuid references public.events(id),
  processed_at timestamptz, url_path text
);
create table public.notification_deliveries(
  id uuid primary key default gen_random_uuid(), reminder_id uuid references public.event_reminders(id),
  notification_event_id uuid references public.notification_events(id),
  outbox_id uuid references public.notification_outbox(id), status text
);
