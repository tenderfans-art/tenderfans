
-- Determine whether an HTML event source requires ownership review.
-- Compare website scope, not just normalized website equality.

create or replace function
public.first_party_html_source_requires_review(
  p_venue_id uuid,
  p_source_url text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_website text;
  v_site_host text;
  v_site_path text;
  v_source_host text;
  v_source_path text;
  v_other_spots integer;
begin
  select website_url
  into v_website
  from public.venues
  where id = p_venue_id
    and status = 'active';

  if v_website is null
     or p_source_url is null then
    return true;
  end if;

  v_site_host := lower(
    regexp_replace(
      split_part(
        regexp_replace(v_website, '^https?://', '', 'i'),
        '/', 1
      ),
      '^www\.', '', 'i'
    )
  );

  v_source_host := lower(
    regexp_replace(
      split_part(
        regexp_replace(p_source_url, '^https?://', '', 'i'),
        '/', 1
      ),
      '^www\.', '', 'i'
    )
  );

  v_site_path := '/' || trim(
    both '/' from
    regexp_replace(v_website, '^https?://[^/]+', '', 'i')
  );

  v_source_path := '/' || trim(
    both '/' from
    regexp_replace(p_source_url, '^https?://[^/]+', '', 'i')
  );

  -- An external HTML source cannot establish publisher ownership
  -- merely by being linked from the Spot website.
  if v_source_host <> v_site_host then
    return true;
  end if;

  -- A location-specific Spot page does not automatically own
  -- unrelated event pages elsewhere on the corporate website.
  if v_site_path <> '/'
     and v_source_path <> v_site_path
     and v_source_path not like v_site_path || '/%' then
    return true;
  end if;

  -- If other active Spots use the same domain, a corporate-root
  -- website alone is insufficient publisher ownership evidence.
  select count(*)
  into v_other_spots
  from public.venues v
  where v.id <> p_venue_id
    and v.status = 'active'
    and v.website_url is not null
    and lower(
      regexp_replace(
        split_part(
          regexp_replace(v.website_url, '^https?://', '', 'i'),
          '/', 1
        ),
        '^www\.', '', 'i'
      )
    ) = v_site_host;

  if v_site_path = '/'
     and v_other_spots > 0 then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function
public.first_party_html_source_requires_review(uuid, text)
from public, anon, authenticated;

grant execute on function
public.first_party_html_source_requires_review(uuid, text)
to service_role;
