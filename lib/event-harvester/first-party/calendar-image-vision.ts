import type {
  CalendarImageAsset,
} from "./calendar-image-assets";

export type CalendarImageExtractedEvent = {
  title: string;
  localDate: string | null;
  displayedWeekday: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  titleConfidence: number;
  dateConfidence: number | null;
  timeConfidence: number | null;
  dateBasis:
    | "event_explicit"
    | "calendar_explicit"
    | "weekday_explicit"
    | null;
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
            type: ["string", "null"],
          },
          displayedWeekday: {
            type: ["string", "null"],
            enum: [
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
              null,
            ],
          },
          startTime: {
            type: ["string", "null"],
            pattern:
              "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          },
          endTime: {
            type: ["string", "null"],
            pattern:
              "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          },
          allDay: {
            type: "boolean",
          },
          titleConfidence: {
            type: "number",
          },
          dateConfidence: {
            type: ["number", "null"],
          },
          timeConfidence: {
            type: ["number", "null"],
          },
          dateBasis: {
            type: ["string", "null"],
            enum: [
              "event_explicit",
              "calendar_explicit",
              "weekday_explicit",
              null,
            ],
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
          "displayedWeekday",
          "startTime",
          "endTime",
          "allDay",
          "titleConfidence",
          "dateConfidence",
          "timeConfidence",
          "dateBasis",
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
    "Determine whether the image is actually a public event calendar or event schedule.",
    "An event-themed photograph, promotional image, venue photo, or isolated event graphic is NOT by itself an event calendar or schedule.",
    "If the image contains an event calendar or schedule, extract every distinct public event shown.",
    "",
    "Rules:",
    "- Preserve performer/event titles as displayed.",
    "- Extract explicit calendar dates when they are shown or unambiguously supplied by the calendar.",
    "- Use YYYY-MM-DD for localDate when a calendar date is supported.",
    "- If an event explicitly identifies a weekday but no calendar date can be determined without inference, set localDate=null and preserve the explicit weekday in displayedWeekday.",
    "- Normalize displayedWeekday to Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, or Sunday.",
    "- Never convert a weekday-only schedule into calendar dates. Downstream deterministic code handles that mapping.",
    "- Use dateBasis=event_explicit when the event itself displays its date.",
    "- Use dateBasis=calendar_explicit when an explicit calendar structure supplies the event date.",
    "- Use dateBasis=weekday_explicit when only an explicit weekday is available.",
    "- Use dateBasis=null when neither a supported date nor explicit weekday is available.",
    `- The supplied current date is ${currentDate}. Use it only as context when a calendar omits an otherwise necessary year.`,
    "- If the image explicitly supplies a year, use that year.",
    "- If a monthly calendar clearly identifies a month but omits the year, and that month matches the supplied current month, use the supplied current year.",
    "- Do not infer or reject a year by reverse-engineering weekday/date alignment from the calendar grid.",
    "- Do not decide whether extracted dates are stale, historical, current, or future. Downstream deterministic code handles date freshness.",
    "- Extract events even when some or all displayed dates are before the supplied current date.",
    "- Extract start/end times only when supported by the image.",
    "- Normalize non-null startTime and endTime to 24-hour HH:MM format. Example: 6:00 PM becomes 18:00.",
    "- Preserve the time text as visibly displayed in evidence.displayedTime; do not use the normalized HH:MM value there unless that is how the image displays it.",
    "- A time printed directly with an event uses timeBasis=event_explicit.",
    "- A clearly stated global or weekday schedule rule may supply the time for events to which that rule unambiguously applies.",
    "- When applying such a rule, use timeBasis=calendar_global_rule and include the rule in evidence.context.",
    "- Never invent a time.",
    "- If no supported time exists, return null for startTime and endTime.",
    "- Missing time does NOT mean an all-day event.",
    "- Set allDay=true only when the image explicitly establishes that the event is all-day.",
    "- Do not infer weekday names merely from visual column position.",
    "- Do not treat decorative or unrelated poster content as additional events unless it clearly advertises a public event with a supported date.",
    "- If the image is not a public event calendar or event schedule, set isEventCalendar=false and return an empty events array.",
    "- Do not create IDs, UTC timestamps, venue attribution, deduplication decisions, freshness decisions, or unsupported events.",
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
