export type FirstPartyHarvestEvent = {
  externalEventId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  sourceUrl: string | null;
  flyerUrl: string | null;
  location: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  rawPayload: Record<string, unknown>;
};
