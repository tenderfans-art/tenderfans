import type { SupabaseClient } from "@supabase/supabase-js";

import { eventFingerprint, normalizeTitle } from "../identity";

import { parseIcsEvents } from "./ics";
import { fetchGoogleCalendarEvents } from "./google-calendar-events";
import { fetchBeatGigEvents } from "./beatgig-events";
import { fetchBandzoogleEvents } from "./bandzoogle-events";
import { fetchEventsCalendarEvents } from "./eventscalendar-events";
import { fetchEventbriteOrganizerEvents } from "./eventbrite-organizer";
import { fetchGoDaddyMenuRecurringEvents } from "./godaddy-menu-recurring";
import { fetchCpMultiViewCalendarEvents } from "./cp-multi-view-calendar";
import { fetchNextRscEvents } from "./next-rsc-events";
import { fetchSquarespaceEvents } from "./squarespace-events";
import { fetchTribeRestEvents } from "./tribe-rest";
import { fetchUvTixEvents } from "./uvtix-events";
import { fetchSchemaOrgEvents } from "./schema-org-events";
import { fetchPwpcEventsCalendarEvents } from "./pwpc-events-calendar";
import { fetchShopifyEvents } from "./shopify-events";
import { fetchWordPressEventFeedEvents } from "./wordpress-event-feed";
import { fetchSpotHopperEvents } from "./spothopper-events";
import { fetchFacebookEvents } from "./facebook-events";

export type FirstPartySource = {
  id: string;
  provider: string;
  source_type: string;
  name: string;
  source_url: string | null;
  external_source_id: string | null;
  venue_id: string | null;
  is_enabled: boolean;
  trust_level: string;
  config: Record<string, unknown>;
  bootstrapped_at: string | null;
};

export type FirstPartyEventPreview = {
  sourceId: string;
  sourceType: string;
  venueId: string | null;
  externalEventId: string;
  sourceUrl: string | null;
  title: string;
  normalizedTitle: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  flyerUrl: string | null;
  location: string | null;
  venueName: string | null;
  venueAddress: string | null;
  eventFingerprint: string | null;
  rawPayload: Record<string, unknown>;
};

export async function loadFirstPartySource(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<FirstPartySource> {
  const { data, error } = await supabase
    .from("event_harvest_sources")
    .select(
      `
      id,
      provider,
      source_type,
      name,
      source_url,
      external_source_id,
      venue_id,
      is_enabled,
      trust_level,
      config,
      bootstrapped_at
    `,
    )
    .eq("id", sourceId)
    .eq("provider", "first_party")
    .eq("is_enabled", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load first-party source: ${error.message}`);
  }

  if (!data) {
    throw new Error("Enabled first-party event source was not found.");
  }

  if (!data.venue_id && data.source_type !== "facebook_events") {
    throw new Error("First-party source is not attached to a TenderFans Spot.");
  }

  if (!data.source_url) {
    throw new Error("First-party source has no source URL.");
  }

  return data as FirstPartySource;
}

export async function previewFirstPartySource(
  source: FirstPartySource,
): Promise<FirstPartyEventPreview[]> {
  if (!source.source_url) {
    throw new Error("First-party source has no source URL.");
  }

  let events;

  if (source.source_type === "google_calendar") {
    events = await fetchGoogleCalendarEvents(
      source.source_url,
    );
  } else if (source.source_type === "beatgig_events") {
    events = await fetchBeatGigEvents(source.source_url);
  } else if (source.source_type === "bandzoogle_events") {
    events = await fetchBandzoogleEvents(source.source_url);
  } else if (source.source_type === "eventscalendar_events") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : undefined;

    events = await fetchEventsCalendarEvents(
      source.source_url,
      { timeZone },
    );
  } else if (source.source_type === "ics") {
    const response = await fetch(source.source_url, {
      headers: {
        Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "TenderFans-Event-Harvester/1.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`First-party source returned HTTP ${response.status}.`);
    }

    const rawIcs = await response.text();
    events = parseIcsEvents(rawIcs);
  } else if (source.source_type === "tribe_rest") {
    const categorySlug =
      typeof source.config?.category_slug === "string"
        ? source.config.category_slug
        : null;

    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    events = await fetchTribeRestEvents(source.source_url, {
      categorySlug,
      timeZone,
    });
  } else if (source.source_type === "next_rsc_events") {
    events = await fetchNextRscEvents(source.source_url);
  } else if (source.source_type === "squarespace_events") {
    events = await fetchSquarespaceEvents(source.source_url);
  } else if (source.source_type === "eventbrite_organizer") {
    const organizerId =
      typeof source.config?.organizer_id === "string"
        ? source.config.organizer_id
        : null;

    const venueId =
      typeof source.config?.venue_id === "string"
        ? source.config.venue_id
        : null;

    const sessionHorizonDays =
      typeof source.config?.session_horizon_days === "number"
        ? source.config.session_horizon_days
        : undefined;

    events = await fetchEventbriteOrganizerEvents(source.source_url, {
      organizerId,
      venueId,
      sessionHorizonDays,
    });
  } else if (source.source_type === "godaddy_menu_recurring") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    const weeksForward =
      typeof source.config?.weeks_forward === "number"
        ? source.config.weeks_forward
        : 8;

    events = await fetchGoDaddyMenuRecurringEvents(source.source_url, {
      timeZone,
      weeksForward,
    });
  } else if (source.source_type === "cp_multi_view_calendar") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    const weeksForward =
      typeof source.config?.weeks_forward === "number"
        ? source.config.weeks_forward
        : 8;

    events = await fetchCpMultiViewCalendarEvents(source.source_url, {
      timeZone,
      weeksForward,
    });
  } else if (source.source_type === "shopify_events") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    const weeksForward =
      typeof source.config?.weeks_forward === "number"
        ? source.config.weeks_forward
        : 8;

    events = await fetchShopifyEvents(source.source_url, {
      timeZone,
      weeksForward,
    });
  } else if (source.source_type === "uvtix_events") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    events = await fetchUvTixEvents(source.source_url, {
      timeZone,
    });
  } else if (source.source_type === "schema_org_events") {
    events = await fetchSchemaOrgEvents(source.source_url);
  } else if (source.source_type === "pwpc_events_calendar") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    events = await fetchPwpcEventsCalendarEvents(
      source.source_url,
      { timeZone },
    );
  } else if (source.source_type === "spothopper_events") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    const weeksForward =
      typeof source.config?.weeks_forward === "number"
        ? source.config.weeks_forward
        : 8;

    events = await fetchSpotHopperEvents(source.source_url, {
      timeZone,
      weeksForward,
    });
  } else if (source.source_type === "facebook_events") {
    events = await fetchFacebookEvents(source.source_url);
  } else if (source.source_type === "wordpress_event_feed") {
    const timeZone =
      typeof source.config?.timezone === "string"
        ? source.config.timezone
        : "America/New_York";

    events = await fetchWordPressEventFeedEvents(
      source.source_url,
      { timeZone },
    );
  } else {
    throw new Error(
      `Unsupported first-party source type: ${source.source_type}`,
    );
  }

  return events.map((event) => ({
    sourceId: source.id,
    sourceType: source.source_type,
    venueId: source.venue_id,
    externalEventId: event.externalEventId,
    sourceUrl: event.sourceUrl ?? source.source_url,
    title: event.title,
    normalizedTitle: normalizeTitle(event.title),
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    flyerUrl: event.flyerUrl,
    location: event.location,
    venueName: event.venueName ?? null,
    venueAddress: event.venueAddress ?? null,
    eventFingerprint: source.venue_id
      ? eventFingerprint({
          venueId: source.venue_id,
          title: event.title,
          startsAt: event.startsAt,
        })
      : null,
    rawPayload: event.rawPayload,
  }));
}
