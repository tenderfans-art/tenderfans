import type {
  CalendarImageAsset,
} from "./calendar-image-assets";

export type CalendarImageExtractedEvent = {
  title: string;
  localDate: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  titleConfidence: number;
  dateConfidence: number;
  timeConfidence: number | null;
  timeBasis:
    | "event_explicit"
    | "calendar_global_rule"
    | null;
  evidence: {
    displayedTitle: string;
    displayedDate: string;
    displayedTime: string | null;
    context: string[];
  };
};

export type CalendarImageExtraction = {
  isEventCalendar: boolean;
  qualificationReason: string;
  events: CalendarImageExtractedEvent[];
};

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    isEventCalendar: {
      type: "boolean",
    },
    qualificationReason: {
      type: "string",
    },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
          },
          localDate: {
            type: "string",
          },
          startTime: {
            type: ["string", "null"],
          },
          endTime: {
            type: ["string", "null"],
          },
          allDay: {
            type: "boolean",
          },
          titleConfidence: {
            type: "number",
          },
          dateConfidence: {
            type: "number",
          },
          timeConfidence: {
            type: ["number", "null"],
          },
          timeBasis: {
            type: ["string", "null"],
            enum: [
              "event_explicit",
              "calendar_global_rule",
              null,
            ],
          },
          evidence: {
            type: "object",
            additionalProperties: false,
            properties: {
              displayedTitle: {
                type: "string",
              },
              displayedDate: {
                type: "string",
              },
              displayedTime: {
                type: [
                  "string",
                  "null",
                ],
              },
              context: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: [
              "displayedTitle",
              "displayedDate",
              "displayedTime",
              "context",
            ],
          },
        },
        required: [
          "title",
          "localDate",
          "startTime",
          "endTime",
          "allDay",
          "titleConfidence",
          "dateConfidence",
          "timeConfidence",
          "timeBasis",
          "evidence",
        ],
      },
    },
  },
  required: [
    "isEventCalendar",
    "qualificationReason",
    "events",
  ],
} as const;

function extractionPrompt(
  currentDate: string,
): string {
  return [
    "You are reading an image discovered on a public venue website.",
    "",
    "Determine whether the image is actually a current public event calendar or event schedule.",
    "An event-themed photograph, promotional image, historical event image, venue photo, or isolated old event graphic is NOT by itself an event calendar.",
    "If the image does contain a current event calendar or schedule, extract every distinct public event shown.",
    "",
    "Rules:",
    "- Preserve performer/event titles as displayed.",
    "- Associate each event with the correct calendar date.",
    "- Use YYYY-MM-DD for localDate.",
    `- The current date is ${currentDate}.`,
    "- A schedule whose dated events are wholly before the current date is historical, not current.",
    "- If every event date shown is before the current date, set isEventCalendar=false and return an empty events array.",
    "- A current monthly calendar may contain earlier dates in the same month as long as it also contains the current date or future event dates.",
    "- Extract start/end times only when supported by the image.",
    "- A time printed directly with an event uses timeBasis=event_explicit.",
    "- A clearly stated global or weekday schedule rule may supply the time for events to which that rule unambiguously applies.",
    "- When applying such a rule, use timeBasis=calendar_global_rule and include the rule in evidence.context.",
    "- Never invent a time.",
    "- If no supported time exists, return null for startTime and endTime.",
    "- Missing time does NOT mean an all-day event.",
    "- Set allDay=true only when the image explicitly establishes that the event is all-day.",
    "- Do not infer weekday names merely from visual column position.",
    "- Do not treat decorative or unrelated poster content as additional events unless it clearly advertises a public event with a supported date.",
    "- If the image is not a current public event calendar or schedule, set isEventCalendar=false and return an empty events array.",
    "- Do not create IDs, UTC timestamps, venue attribution, deduplication decisions, or unsupported events.",
  ].join("\n");
}

function outputText(
  response: Record<string, unknown>,
): string | null {
  const output = response.output;

  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (
      !item ||
      typeof item !== "object"
    ) {
      continue;
    }

    const content = (
      item as {
        content?: unknown;
      }
    ).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (
          part as {
            type?: unknown;
          }
        ).type === "output_text" &&
        typeof (
          part as {
            text?: unknown;
          }
        ).text === "string"
      ) {
        return (
          part as {
            text: string;
          }
        ).text;
      }
    }
  }

  return null;
}

export async function extractCalendarImage(
  asset: CalendarImageAsset,
  options?: {
    currentDate?: string;
  },
): Promise<CalendarImageExtraction> {
  const apiKey =
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured.",
    );
  }

  const currentDate =
    options?.currentDate ??
    new Date()
      .toISOString()
      .slice(0, 10);

  const base64 =
    Buffer.from(
      asset.bytes,
    ).toString("base64");

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${apiKey}`,
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  extractionPrompt(
                    currentDate,
                  ),
              },
              {
                type: "input_image",
                image_url:
                  `data:${asset.contentType};base64,${base64}`,
                detail: "original",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name:
              "calendar_image_extraction",
            strict: true,
            schema:
              EXTRACTION_SCHEMA,
          },
        },
      }),
      cache: "no-store",
    },
  );

  const raw =
    await response.text();

  let parsed:
    Record<string, unknown>;

  try {
    parsed =
      JSON.parse(raw) as
        Record<string, unknown>;
  } catch {
    throw new Error(
      `OpenAI calendar-image response was not JSON (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    const error =
      parsed.error &&
      typeof parsed.error === "object"
        ? (
            parsed.error as {
              message?: unknown;
            }
          ).message
        : null;

    throw new Error(
      typeof error === "string"
        ? `OpenAI calendar-image extraction failed: ${error}`
        : `OpenAI calendar-image extraction failed with HTTP ${response.status}.`,
    );
  }

  const text =
    outputText(parsed);

  if (!text) {
    throw new Error(
      "OpenAI calendar-image extraction returned no output text.",
    );
  }

  let extraction: unknown;

  try {
    extraction =
      JSON.parse(text);
  } catch {
    throw new Error(
      "OpenAI calendar-image structured output was not valid JSON.",
    );
  }

  if (
    !extraction ||
    typeof extraction !== "object"
  ) {
    throw new Error(
      "OpenAI calendar-image extraction returned an invalid payload.",
    );
  }

  const result =
    extraction as Partial<
      CalendarImageExtraction
    >;

  if (
    typeof result.isEventCalendar !==
      "boolean" ||
    typeof result.qualificationReason !==
      "string" ||
    !Array.isArray(result.events)
  ) {
    throw new Error(
      "OpenAI calendar-image extraction did not match the expected contract.",
    );
  }

  return result as CalendarImageExtraction;
}
