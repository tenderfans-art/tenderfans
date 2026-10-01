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
