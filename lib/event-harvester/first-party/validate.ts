import {
  previewFirstPartySource,
  type FirstPartyEventPreview,
  type FirstPartySource,
} from "./preview";

export type SourceValidationStatus =
  | "validated"
  | "rejected"
  | "validation_failed";

export type SourceInventoryStatus =
  | "available"
  | "empty"
  | "unsafe"
  | "unknown";

export type FirstPartySourceValidation = {
  status: SourceValidationStatus;
  inventory: SourceInventoryStatus;
  eventCount: number;
  events: FirstPartyEventPreview[];
  evidence: string[];
  error: string | null;
};

/**
 * Validate that an implemented adapter can actually exercise a
 * particular ratified source.
 *
 * Important:
 * - zero events does NOT mean unsupported;
 * - validation does NOT register or ingest the source;
 * - Spot/source attribution belongs to ratification, not here.
 */
export async function validateFirstPartySource(
  source: FirstPartySource
): Promise<FirstPartySourceValidation> {
  try {
    const events =
      await previewFirstPartySource(source);

    if (events.length > 0) {
      /*
       * Schema.org Event markup is sometimes left behind after a
       * site's visible calendar has moved on. Do not validate a
       * Schema.org source merely because stale Event objects parse.
       *
       * Keep this safeguard adapter-specific so existing first-party
       * adapters retain their established validation semantics.
       */
      if (source.source_type === "schema_org_events") {
        const now = Date.now();

        const hasCurrentOrFutureEvent = events.some((event) => {
          const effectiveEnd =
            event.endsAt ?? event.startsAt;

          const timestamp = Date.parse(effectiveEnd);

          return (
            !Number.isNaN(timestamp) &&
            timestamp >= now
          );
        });

        if (!hasCurrentOrFutureEvent) {
          return {
            status: "validation_failed",
            inventory: "unsafe",
            eventCount: events.length,
            events,
            evidence: [
              "Implemented adapter successfully exercised source",
              "Schema.org source returned only expired event inventory",
            ],
            error:
              "Schema.org Event inventory contains no current or future events.",
          };
        }
      }

      return {
        status: "validated",
        inventory: "available",
        eventCount: events.length,
        events,
        evidence: [
          "Implemented adapter successfully exercised source",
          "Source returned normalized event inventory",
        ],
        error: null,
      };
    }

    return {
      status: "validated",
      inventory: "empty",
      eventCount: 0,
      events: [],
      evidence: [
        "Implemented adapter successfully exercised source",
        "Source currently returned no publishable event inventory",
      ],
      error: null,
    };
  } catch (error) {
    return {
      status: "validation_failed",
      inventory: "unknown",
      eventCount: 0,
      events: [],
      evidence: [
        "Implemented adapter could not successfully exercise source",
      ],
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}
