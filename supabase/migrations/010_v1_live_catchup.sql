-- TenderFans V1 live catch-up
-- Partners, event workflow, follows and event reminders.
-- Brings a clean 001-009 replay forward to the current production schema.

-- ============================================================
-- PARTNER PROFILES
-- ============================================================

create table if not exists public.partner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  partner_type text not null
    constraint partner_profiles_partner_type_check
    check (partner_type in ('promoter', 'liquor_rep')),
  display_name text not null,
  company_name text,
  status text not null default 'pending'
    constraint partner_profiles_status_check
    check (status in ('pending', 'approved', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verification_method text
    constraint partner_profiles_verification_method_check
    check (
      verification_method is null
      or verification_method in ('public_record', 'supervisor')
    ),
  verification_source text,
  verification_jurisdiction text,
  verification_name text,
  verification_reference text,
  verification_url text,
  supervisor_name text,
  supervisor_title text,
  supervisor_email text,
  supervisor_phone text
);

create index if not exists partner_profiles_status_idx
  on public.partner_profiles(status);

create index if not exists partner_profiles_user_id_idx
  on public.partner_profiles(user_id);

alter table public.partner_profiles enable row level security;


-- ============================================================
-- EVENTS — BRING ORIGINAL 001 TABLE FORWARD
-- ============================================================

alter table public.events
  add column if not exists submitted_by uuid
    references auth.users(id) on delete set null,
  add column if not exists reviewed_by uuid
    references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists flyer_url text,
  add column if not exists venue_approval_status text not null default 'pending',
  add column if not exists admin_approval_status text not null default 'pending',
  add column if not exists flyer_storage_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_venue_approval_status_check'
      and conrelid = 'public.events'::regclass
  ) then
    alter table public.events
      add constraint events_venue_approval_status_check
      check (venue_approval_status in ('pending', 'approved', 'denied'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_admin_approval_status_check'
      and conrelid = 'public.events'::regclass
  ) then
    alter table public.events
      add constraint events_admin_approval_status_check
      check (admin_approval_status in ('pending', 'approved', 'denied'));
  end if;
end
$$;

create index if not exists events_partner_status_idx
  on public.events(submitted_by, admin_approval_status, starts_at);

create index if not exists events_starts_at_idx
  on public.events(starts_at);

create index if not exists events_status_starts_at_idx
  on public.events(status, starts_at);

create index if not exists events_submitted_by_idx
  on public.events(submitted_by);

create index if not exists events_venue_id_idx
  on public.events(venue_id);

create index if not exists events_venue_status_idx
  on public.events(venue_id, status);


-- ============================================================
-- FOLLOW / NOTIFICATION SUBSCRIPTIONS
-- ============================================================

create table if not exists public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),

  entity_kind text not null
    constraint notification_subscriptions_entity_kind_check
    check (entity_kind in ('bartender', 'venue')),

  bartender_id uuid references public.bartenders(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,

  email text,
  phone_e164 text,

  wants_email boolean not null default false,
  wants_sms boolean not null default false,

  email_verified boolean not null default false,
  phone_verified boolean not null default false,

  status text not null default 'pending'
    constraint notification_subscriptions_status_check
    check (status in ('pending', 'active', 'unsubscribed')),

  email_verification_token_hash text,
  phone_verification_code_hash text,
  unsubscribe_token_hash text,

  email_verification_sent_at timestamptz,
  phone_verification_sent_at timestamptz,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,

  sms_consent_at timestamptz,
  sms_consent_source text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_subscription_entity_check
    check (
      (
        entity_kind = 'bartender'
        and bartender_id is not null
        and venue_id is null
      )
      or
      (
        entity_kind = 'venue'
        and venue_id is not null
        and bartender_id is null
      )
    ),

  constraint notification_subscription_channel_check
    check (wants_email = true or wants_sms = true),

  constraint notification_subscription_contact_check
    check (email is not null or phone_e164 is not null),

  constraint notification_subscription_email_check
    check (wants_email = false or email is not null),

  constraint notification_subscription_sms_check
    check (wants_sms = false or phone_e164 is not null)
);

create index if not exists notification_subscriptions_bartender_idx
  on public.notification_subscriptions(bartender_id)
  where bartender_id is not null;

create index if not exists notification_subscriptions_email_idx
  on public.notification_subscriptions(lower(email))
  where email is not null;

create index if not exists notification_subscriptions_phone_idx
  on public.notification_subscriptions(phone_e164)
  where phone_e164 is not null;

create index if not exists notification_subscriptions_status_idx
  on public.notification_subscriptions(status);

create index if not exists notification_subscriptions_venue_idx
  on public.notification_subscriptions(venue_id)
  where venue_id is not null;

alter table public.notification_subscriptions enable row level security;


-- ============================================================
-- EVENT REMINDERS
-- ============================================================

create table if not exists public.event_reminders (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null
    references public.events(id) on delete cascade,

  email text,
  phone_e164 text,

  wants_email boolean not null default false,
  wants_sms boolean not null default false,

  email_verified boolean not null default false,
  phone_verified boolean not null default false,

  reminder_minutes_before integer not null
    constraint event_reminders_reminder_minutes_before_check
    check (reminder_minutes_before in (60, 180, 1440)),

  status text not null default 'pending'
    constraint event_reminders_status_check
    check (status in ('pending', 'active', 'sent', 'cancelled')),

  email_verification_token_hash text,
  phone_verification_code_hash text,
  unsubscribe_token_hash text,

  email_verification_sent_at timestamptz,
  phone_verification_sent_at timestamptz,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,

  sms_consent_at timestamptz,
  sms_consent_source text,

  reminder_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_reminder_channel_check
    check (wants_email = true or wants_sms = true),

  constraint event_reminder_contact_check
    check (email is not null or phone_e164 is not null),

  constraint event_reminder_email_check
    check (wants_email = false or email is not null),

  constraint event_reminder_sms_check
    check (wants_sms = false or phone_e164 is not null)
);

create index if not exists event_reminders_email_idx
  on public.event_reminders(lower(email))
  where email is not null;

create index if not exists event_reminders_event_idx
  on public.event_reminders(event_id);

create index if not exists event_reminders_phone_idx
  on public.event_reminders(phone_e164)
  where phone_e164 is not null;

create index if not exists event_reminders_status_idx
  on public.event_reminders(status);

alter table public.event_reminders enable row level security;


-- ============================================================
-- PARTNER PROFILE RLS POLICIES
-- ============================================================

drop policy if exists "admins can read partner profiles"
  on public.partner_profiles;

create policy "admins can read partner profiles"
on public.partner_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can update partner profiles"
  on public.partner_profiles;

create policy "admins can update partner profiles"
on public.partner_profiles
for update
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "partners can read own profile"
  on public.partner_profiles;

create policy "partners can read own profile"
on public.partner_profiles
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "users can create own pending partner profile"
  on public.partner_profiles;

create policy "users can create own pending partner profile"
on public.partner_profiles
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'
);


-- ============================================================
-- EVENT RLS POLICIES
-- ============================================================

drop policy if exists "admins can delete events"
  on public.events;

create policy "admins can delete events"
on public.events
for delete
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can insert events"
  on public.events;

create policy "admins can insert events"
on public.events
for insert
to authenticated
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can read all events"
  on public.events;

create policy "admins can read all events"
on public.events
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can update events"
  on public.events;

create policy "admins can update events"
on public.events
for update
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "approved partners submit events"
  on public.events;

create policy "approved partners submit events"
on public.events
for insert
to authenticated
with check (
  submitted_by = auth.uid()
  and status = 'draft'
  and venue_approval_status = 'pending'
  and admin_approval_status = 'pending'
  and exists (
    select 1
    from public.partner_profiles pp
    where pp.user_id = auth.uid()
      and pp.status = 'approved'
  )
);

drop policy if exists "partners read own submitted events"
  on public.events;

create policy "partners read own submitted events"
on public.events
for select
to authenticated
using (
  submitted_by = auth.uid()
  and exists (
    select 1
    from public.partner_profiles pp
    where pp.user_id = auth.uid()
      and pp.status = 'approved'
  )
);

drop policy if exists "public can read published events"
  on public.events;

create policy "public can read published events"
on public.events
for select
to public
using (status = 'published');

drop policy if exists "venue reps can read own venue events"
  on public.events;

create policy "venue reps can read own venue events"
on public.events
for select
to authenticated
using (
  exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = events.venue_id
      and vp.user_id = auth.uid()
  )
);

drop policy if exists "venue reps can submit draft events"
  on public.events;

create policy "venue reps can submit draft events"
on public.events
for insert
to authenticated
with check (
  submitted_by = auth.uid()
  and status = 'draft'
  and reviewed_by is null
  and reviewed_at is null
  and exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = events.venue_id
      and vp.user_id = auth.uid()
  )
);


-- ============================================================
-- PARTNER / EVENT RPCS
-- ============================================================

create or replace function public.admin_pending_events()
returns table(
  id uuid,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  flyer_url text,
  venue_id uuid,
  venue_name text,
  submitted_by uuid,
  partner_name text,
  partner_company text,
  venue_approval_status text,
  admin_approval_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    e.id,
    e.title,
    e.starts_at,
    e.ends_at,
    e.flyer_url,
    e.venue_id,
    v.name as venue_name,
    e.submitted_by,
    pp.display_name as partner_name,
    pp.company_name as partner_company,
    e.venue_approval_status,
    e.admin_approval_status,
    e.created_at
  from public.events e
  join public.venues v
    on v.id = e.venue_id
  left join public.partner_profiles pp
    on pp.user_id = e.submitted_by
  where e.admin_approval_status = 'pending'
  order by e.created_at asc;
end;
$function$;


create or replace function public.admin_pending_partner_profiles()
returns table(
  id uuid,
  user_id uuid,
  partner_type text,
  display_name text,
  company_name text,
  verification_method text,
  verification_source text,
  verification_jurisdiction text,
  verification_name text,
  verification_reference text,
  verification_url text,
  supervisor_name text,
  supervisor_title text,
  supervisor_email text,
  supervisor_phone text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  return query
  select
    pp.id,
    pp.user_id,
    pp.partner_type,
    pp.display_name,
    pp.company_name,
    pp.verification_method,
    pp.verification_source,
    pp.verification_jurisdiction,
    pp.verification_name,
    pp.verification_reference,
    pp.verification_url,
    pp.supervisor_name,
    pp.supervisor_title,
    pp.supervisor_email,
    pp.supervisor_phone,
    pp.created_at
  from public.partner_profiles pp
  where pp.status = 'pending'
  order by pp.created_at asc;
end;
$function$;


create or replace function public.admin_review_event(
  p_event_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  event_venue_id uuid;
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  select e.venue_id
  into event_venue_id
  from public.events e
  where e.id = p_event_id
    and e.admin_approval_status = 'pending';

  if event_venue_id is null then
    raise exception 'Pending event not found';
  end if;

  if p_approve then
    update public.events
    set
      venue_approval_status = 'approved',
      admin_approval_status = 'approved',
      status = 'published',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_event_id;

    insert into public.notification_events (
      entity_kind,
      venue_id,
      event_type,
      source_kind,
      source_id,
      metadata
    )
    values (
      'venue',
      event_venue_id,
      'spot.event_published',
      'event',
      p_event_id,
      jsonb_build_object(
        'event_id', p_event_id
      )
    );
  else
    update public.events
    set
      admin_approval_status = 'denied',
      status = 'draft',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_event_id;
  end if;
end;
$function$;


create or replace function public.admin_review_partner_profile(
  p_partner_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  update public.partner_profiles
  set
    status = case
      when p_approve then 'approved'
      else 'suspended'
    end,
    updated_at = now()
  where id = p_partner_id
    and status = 'pending';

  if not found then
    raise exception 'Pending Partner profile not found';
  end if;
end;
$function$;


create or replace function public.delete_my_partner_access()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.partner_profiles
  where user_id = auth.uid();

  if not found then
    raise exception 'Partner access not found';
  end if;
end;
$function$;


create or replace function public.partner_delete_approved_event(
  p_event_id uuid
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flyer_storage_path text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.partner_profiles pp
    where pp.user_id = auth.uid()
      and pp.status = 'approved'
  ) then
    raise exception 'Approved Partner access required';
  end if;

  delete from public.events e
  where e.id = p_event_id
    and e.submitted_by = auth.uid()
    and e.status = 'published'
    and e.venue_approval_status = 'approved'
    and e.admin_approval_status = 'approved'
  returning e.flyer_storage_path
  into v_flyer_storage_path;

  if not found then
    raise exception 'Approved event not found or not owned by this Partner';
  end if;

  return v_flyer_storage_path;
end;
$function$;


create or replace function public.partner_update_approved_event(
  p_event_id uuid,
  p_venue_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_flyer_url text,
  p_flyer_storage_path text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.partner_profiles pp
    where pp.user_id = auth.uid()
      and pp.status = 'approved'
  ) then
    raise exception 'Approved Partner access required';
  end if;

  if trim(coalesce(p_title, '')) = '' then
    raise exception 'Event title is required';
  end if;

  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'End time must be after start time';
  end if;

  if trim(coalesce(p_flyer_url, '')) = ''
     or trim(coalesce(p_flyer_storage_path, '')) = '' then
    raise exception 'Event flyer is required';
  end if;

  update public.events
  set
    venue_id = p_venue_id,
    title = trim(p_title),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    flyer_url = p_flyer_url,
    flyer_storage_path = p_flyer_storage_path,
    status = 'draft',
    venue_approval_status = 'pending',
    admin_approval_status = 'pending',
    reviewed_by = null,
    reviewed_at = null,
    updated_at = now()
  where id = p_event_id
    and submitted_by = auth.uid()
    and venue_approval_status = 'approved'
    and admin_approval_status = 'approved'
    and status = 'published';

  if not found then
    raise exception 'Approved event not found or not owned by this Partner';
  end if;
end;
$function$;


-- ============================================================
-- RPC EXECUTE PERMISSIONS — MATCH CURRENT PRODUCTION
-- ============================================================

grant execute on function public.admin_pending_events()
  to anon, authenticated, service_role;

grant execute on function public.admin_pending_partner_profiles()
  to anon, authenticated, service_role;

grant execute on function public.admin_review_event(uuid, boolean)
  to anon, authenticated, service_role;

grant execute on function public.admin_review_partner_profile(uuid, boolean)
  to anon, authenticated, service_role;

grant execute on function public.delete_my_partner_access()
  to anon, authenticated, service_role;

grant execute on function public.partner_delete_approved_event(uuid)
  to anon, authenticated, service_role;

grant execute on function public.partner_update_approved_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
to anon, authenticated, service_role;
