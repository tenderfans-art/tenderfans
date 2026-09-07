create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),

  entity_kind text not null
    check (entity_kind in ('bartender', 'venue')),

  bartender_id uuid
    references public.bartenders(id)
    on delete cascade,

  venue_id uuid
    references public.venues(id)
    on delete cascade,

  event_type text not null
    check (
      event_type in (
        'spot.menu_updated',
        'spot.special_updated',
        'spot.photo_updated',
        'spot.tender_added',
        'spot.tender_removed',
        'spot.event_published',
        'tender.profile_updated',
        'tender.photo_updated',
        'tender.spot_added',
        'tender.spot_removed'
      )
    ),

  source_kind text,
  source_id uuid,

  metadata jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),

  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),

  constraint notification_event_entity_check
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
    )
);

alter table public.notification_events enable row level security;

create index if not exists notification_events_pending_idx
  on public.notification_events (status, available_at, created_at);

create index if not exists notification_events_bartender_idx
  on public.notification_events (bartender_id)
  where bartender_id is not null;

create index if not exists notification_events_venue_idx
  on public.notification_events (venue_id)
  where venue_id is not null;

create index if not exists notification_events_type_idx
  on public.notification_events (event_type);


create or replace function public.queue_spot_media_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.media_assets%rowtype;
  notification_type text;
begin
  if tg_op = 'DELETE' then
    row_data := old;
  else
    row_data := new;
  end if;

  if row_data.entity_kind <> 'venue'
     or row_data.venue_id is null
     or row_data.status <> 'published'
     or row_data.media_type not in ('menu', 'special', 'photo') then
    return coalesce(new, old);
  end if;

  notification_type :=
    case row_data.media_type
      when 'menu' then 'spot.menu_updated'
      when 'special' then 'spot.special_updated'
      when 'photo' then 'spot.photo_updated'
    end;

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
    row_data.venue_id,
    notification_type,
    'media_asset',
    row_data.id,
    jsonb_build_object(
      'media_type', row_data.media_type,
      'operation', lower(tg_op)
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists queue_spot_media_notification_trigger
on public.media_assets;

create trigger queue_spot_media_notification_trigger
after insert or delete
on public.media_assets
for each row
execute function public.queue_spot_media_notification();


create or replace function public.queue_tender_profile_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_fields text[] := '{}';
begin
  if new.status <> 'active' then
    return new;
  end if;

  if new.display_name is distinct from old.display_name then
    changed_fields := array_append(changed_fields, 'display_name');
  end if;

  if new.bio is distinct from old.bio then
    changed_fields := array_append(changed_fields, 'bio');
  end if;

  if array_length(changed_fields, 1) is null then
    return new;
  end if;

  insert into public.notification_events (
    entity_kind,
    bartender_id,
    event_type,
    source_kind,
    source_id,
    metadata
  )
  values (
    'bartender',
    new.id,
    'tender.profile_updated',
    'bartender',
    new.id,
    jsonb_build_object(
      'changed_fields',
      to_jsonb(changed_fields)
    )
  );

  return new;
end;
$$;

drop trigger if exists queue_tender_profile_notification_trigger
on public.bartenders;

create trigger queue_tender_profile_notification_trigger
after update of display_name, bio
on public.bartenders
for each row
when (
  old.display_name is distinct from new.display_name
  or old.bio is distinct from new.bio
)
execute function public.queue_tender_profile_notification();


create or replace function public.queue_tender_photo_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.media_assets%rowtype;
begin
  if tg_op = 'DELETE' then
    row_data := old;
  else
    row_data := new;
  end if;

  if row_data.entity_kind <> 'bartender'
     or row_data.bartender_id is null
     or row_data.media_type <> 'photo'
     or row_data.is_hero is not true
     or row_data.status <> 'published' then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1
    from public.notification_events ne
    where ne.entity_kind = 'bartender'
      and ne.bartender_id = row_data.bartender_id
      and ne.event_type = 'tender.photo_updated'
      and ne.status = 'pending'
      and ne.created_at >= now() - interval '2 minutes'
  ) then
    insert into public.notification_events (
      entity_kind,
      bartender_id,
      event_type,
      source_kind,
      source_id,
      metadata
    )
    values (
      'bartender',
      row_data.bartender_id,
      'tender.photo_updated',
      'media_asset',
      row_data.id,
      jsonb_build_object(
        'operation', lower(tg_op)
      )
    );
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists queue_tender_photo_notification_trigger
on public.media_assets;

create trigger queue_tender_photo_notification_trigger
after insert or delete
on public.media_assets
for each row
execute function public.queue_tender_photo_notification();


create or replace function public.review_bartender_venue_request(
  p_request_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.bartender_venue_requests%rowtype;
  existing_relationship_id uuid;
  replacement_primary_id uuid;

  relationship_created boolean := false;
  relationship_ended boolean := false;
  affected_rows integer := 0;
begin
  select *
  into req
  from public.bartender_venue_requests
  where id = p_request_id
  for update;

  if req.id is null then
    raise exception 'Request not found.';
  end if;

  if req.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
  and not exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = req.venue_id
      and vp.user_id = auth.uid()
      and vp.can_edit = true
  ) then
    raise exception 'You do not have permission to review this request.';
  end if;

  if p_approve then

    if req.request_type = 'add' then

      if req.make_primary then
        update public.bartender_venues
        set is_primary = false
        where bartender_id = req.bartender_id
          and is_current = true;
      end if;

      select id
      into existing_relationship_id
      from public.bartender_venues
      where bartender_id = req.bartender_id
        and venue_id = req.venue_id
        and is_current = true
      order by started_at desc nulls last
      limit 1;

      if existing_relationship_id is not null then

        update public.bartender_venues
        set
          relationship_type = req.relationship_type,
          started_at = coalesce(
            req.requested_start_date,
            started_at
          ),
          ended_at = req.requested_end_date,
          is_current = true,
          is_primary =
            case
              when req.make_primary then true
              else is_primary
            end
        where id = existing_relationship_id;

      else

        insert into public.bartender_venues (
          bartender_id,
          venue_id,
          is_current,
          started_at,
          ended_at,
          relationship_type,
          is_primary
        )
        values (
          req.bartender_id,
          req.venue_id,
          true,
          req.requested_start_date,
          req.requested_end_date,
          req.relationship_type,
          req.make_primary
        );

        relationship_created := true;

      end if;

      if not exists (
        select 1
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
          and is_primary = true
      ) then

        update public.bartender_venues
        set is_primary = true
        where id = (
          select id
          from public.bartender_venues
          where bartender_id = req.bartender_id
            and venue_id = req.venue_id
            and is_current = true
          order by started_at desc nulls last
          limit 1
        );

      end if;

    elsif req.request_type = 'end' then

      update public.bartender_venues
      set
        is_current = false,
        is_primary = false,
        ended_at = coalesce(
          req.requested_end_date,
          current_date
        )
      where bartender_id = req.bartender_id
        and venue_id = req.venue_id
        and is_current = true;

      get diagnostics affected_rows = row_count;

      relationship_ended := affected_rows > 0;

      if not exists (
        select 1
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
          and is_primary = true
      ) then

        select id
        into replacement_primary_id
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
        order by started_at desc nulls last, id
        limit 1;

        if replacement_primary_id is not null then
          update public.bartender_venues
          set is_primary = true
          where id = replacement_primary_id;
        end if;

      end if;

    end if;

    update public.bartender_venue_requests
    set
      status = 'approved',
      reviewed_by_user_id = auth.uid(),
      reviewed_at = now()
    where id = req.id;

    if relationship_created then

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
        req.venue_id,
        'spot.tender_added',
        'bartender_venue_request',
        req.id,
        jsonb_build_object(
          'bartender_id', req.bartender_id,
          'relationship_type', req.relationship_type
        )
      );

      insert into public.notification_events (
        entity_kind,
        bartender_id,
        event_type,
        source_kind,
        source_id,
        metadata
      )
      values (
        'bartender',
        req.bartender_id,
        'tender.spot_added',
        'bartender_venue_request',
        req.id,
        jsonb_build_object(
          'venue_id', req.venue_id,
          'relationship_type', req.relationship_type
        )
      );

    end if;

    if relationship_ended then

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
        req.venue_id,
        'spot.tender_removed',
        'bartender_venue_request',
        req.id,
        jsonb_build_object(
          'bartender_id', req.bartender_id
        )
      );

      insert into public.notification_events (
        entity_kind,
        bartender_id,
        event_type,
        source_kind,
        source_id,
        metadata
      )
      values (
        'bartender',
        req.bartender_id,
        'tender.spot_removed',
        'bartender_venue_request',
        req.id,
        jsonb_build_object(
          'venue_id', req.venue_id
        )
      );

    end if;

  else

    update public.bartender_venue_requests
    set
      status = 'denied',
      reviewed_by_user_id = auth.uid(),
      reviewed_at = now()
    where id = req.id;

  end if;
end;
$$;


create or replace function public.admin_review_event(
  p_event_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;
