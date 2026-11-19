-- One-time operator transaction. Does not invoke the scheduler or queue work.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $transfer$
declare
  pinellas uuid;
  old_market uuid;
  moved integer;
  pinellas_before integer;
  spots constant uuid[]:=array[
    'fe9075bc-4cff-4056-a8f0-85132c604f32'::uuid,
    '9974146e-8e4d-4264-a342-3ae48e00937f'::uuid,
    '5b19d0a9-8e3c-4ff7-946d-0c511e46a1d7'::uuid
  ];
begin
  -- Same global-pool -> Market lock order as shared admission/activation.
  perform 1 from public.event_processing_pool_config where singleton=true for update;
  if not found then raise exception 'Shared pool configuration missing'; end if;
  perform 1 from public.event_processing_markets
  where market_key in ('pinellas-county','workflow-isolation-test') order by id for update;
  select id into pinellas from public.event_processing_markets
  where market_key='pinellas-county' and id='1a390bfd-96dc-4c83-bb45-d21662b3804d';
  select id into old_market from public.event_processing_markets
  where market_key='workflow-isolation-test';
  if pinellas is null or old_market is null then
    raise exception 'Expected Pinellas and Workflow Isolation Test Markets not found';
  end if;

  if exists(select 1 from public.event_processing_market_cycles
            where market_id in (pinellas,old_market) and status='running')
     or exists(select 1 from public.event_processing_work
               where market_id in (pinellas,old_market) and status in ('pending','retry','leased'))
     or exists(select 1 from public.event_processing_dispatch_reservations
               where market_id in (pinellas,old_market) and status in ('reserved','claimed')) then
    raise exception 'A Market has active work; nothing moved';
  end if;
  if exists(select 1 from public.event_processing_market_cycles where market_id=old_market)
     or exists(select 1 from public.event_processing_work where market_id=old_market)
     or exists(select 1 from public.event_processing_dispatch_reservations where market_id=old_market)
     or exists(select 1 from public.contests where market_id=old_market)
     or exists(select 1 from public.event_processing_shared_source_markets where market_id=old_market)
     or exists(select 1 from public.event_processing_market_counties where market_id=old_market) then
    raise exception 'Test Market has history or additional configuration; review before repurposing';
  end if;
  if exists(select 1 from public.event_processing_markets where market_key='hillsborough-county')
     or exists(select 1 from public.event_processing_market_counties
               where country_code='US' and state_region='FL' and county_key='hillsborough county') then
    raise exception 'Hillsborough already exists; nothing moved';
  end if;

  perform 1 from public.venues where id=any(spots) order by id for update;
  perform 1 from public.event_processing_market_venues
  where market_id=old_market or venue_id=any(spots) order by venue_id for update;
  if (select count(*) from public.event_processing_market_venues where market_id=old_market)<>3
     or (select count(*) from public.event_processing_market_venues
         where market_id=old_market and venue_id=any(spots))<>3 then
    raise exception 'Test Market does not contain exactly the three expected Spots';
  end if;

  -- Block new standalone source executions briefly, without clearing any lock.
  lock table public.first_party_source_executions in share mode;
  if exists(select 1 from public.first_party_source_executions e
            join public.event_harvest_sources s on s.id=e.source_id where s.venue_id=any(spots)) then
    raise exception 'A transferred Spot has an active source execution; nothing moved';
  end if;
  if exists(select 1 from public.event_google_spot_market_requests r
            where r.market_id=old_market and not (
              exists(select 1 from public.event_harvest_google_spot_reviews g
                     where g.place_id=r.place_id and g.venue_id=any(spots))
              or exists(select 1 from public.venue_external_refs x
                        where x.provider='google_places' and x.provider_place_id=r.place_id and x.venue_id=any(spots))
            )) then raise exception 'Test Market has unrelated Google intake; nothing moved'; end if;

  select count(*) into pinellas_before from public.event_processing_market_venues where market_id=pinellas;
  update public.event_processing_markets
  set is_enabled=false,schedule_enabled=false,next_scheduled_at=null,updated_at=clock_timestamp()
  where id=old_market;
  update public.event_processing_market_venues
  set market_id=pinellas,assigned_at=clock_timestamp()
  where market_id=old_market and venue_id=any(spots);
  get diagnostics moved=row_count;
  if moved<>3 then raise exception 'Expected to move three Spots'; end if;
  update public.event_google_spot_market_requests set market_id=pinellas where market_id=old_market;
  update public.event_processing_markets
  set market_key='hillsborough-county',display_name='Hillsborough County',
      schedule_timezone='America/New_York',schedule_local_time=time '09:30:00',
      max_concurrent_batches=2,max_concurrent_sources=16,updated_at=clock_timestamp()
  where id=old_market;
  insert into public.event_processing_market_counties(country_code,state_region,county_key,market_id)
  values('US','FL','hillsborough county',old_market);
  if exists(select 1 from public.event_processing_market_venues where market_id=old_market)
     or (select count(*) from public.event_processing_market_venues where market_id=pinellas)<>pinellas_before+3 then
    raise exception 'Transfer verification failed';
  end if;
end;
$transfer$;

select m.display_name,m.market_key,m.is_enabled,m.schedule_enabled,
       m.schedule_timezone,m.max_concurrent_batches as workflows,
       m.max_concurrent_sources as workers,count(v.venue_id) as assigned_spots
from public.event_processing_markets m
left join public.event_processing_market_venues v on v.market_id=m.id
where m.market_key in ('pinellas-county','hillsborough-county')
group by m.id order by m.display_name;
commit;
