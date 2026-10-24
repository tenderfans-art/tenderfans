import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");

const filename = "lib/event-harvester/first-party/ics.ts";
const source = readFileSync(filename, "utf8");

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

const mod = new Module(filename);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled, filename);

const { parseIcsEvents } = mod.exports;

function calendar(...lines) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");
}

test("recurrence expands, excludes dates and preserves moved identity", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:series@example.com",
    "DTSTART:20261026T180000Z",
    "DTEND:20261026T200000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "EXDATE:20261102T180000Z",
    "SUMMARY:Weekly Test",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:series@example.com",
    "RECURRENCE-ID:20261109T180000Z",
    "DTSTART:20261109T190000Z",
    "DTEND:20261109T210000Z",
    "SUMMARY:Modified Weekly Test",
    "END:VEVENT",
  );

  const options = {
    from: new Date("2026-10-25T00:00:00Z"),
    to: new Date("2026-11-30T00:00:00Z"),
  };

  const events = parseIcsEvents(input, options);

  assert.equal(events.length, 3);

  assert.deepEqual(
    events.map(event => event.startsAt),
    [
      "2026-10-26T18:00:00.000Z",
      "2026-11-09T19:00:00.000Z",
      "2026-11-16T18:00:00.000Z",
    ],
  );

  assert.deepEqual(
    events.map(event => event.externalEventId),
    [
      "series@example.com",
      "series@example.com::2026-11-09T18:00:00.000Z",
      "series@example.com::2026-11-16T18:00:00.000Z",
    ],
  );

  assert.equal(events[1].title, "Modified Weekly Test");
  assert.equal(events[1].rawPayload.isOverride, true);

  assert.deepEqual(
    parseIcsEvents(input, options),
    events,
  );
});

test("ordinary single events preserve bare UID and source metadata", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:single@example.com",
    "DTSTART:20261028T180000Z",
    "DTEND:20261028T200000Z",
    "SUMMARY:Single Event",
    "DESCRIPTION:Description",
    "LOCATION:Example Location",
    "URL:https://example.com/event",
    "END:VEVENT",
  );

  const events = parseIcsEvents(input);

  assert.equal(events.length, 1);
  assert.equal(events[0].externalEventId, "single@example.com");
  assert.equal(events[0].title, "Single Event");
  assert.equal(events[0].description, "Description");
  assert.equal(events[0].location, "Example Location");
  assert.equal(events[0].sourceUrl, "https://example.com/event");
});

test("invalid recurrence windows are rejected", () => {
  assert.throws(() => parseIcsEvents(
    calendar(),
    {
      from: new Date("2026-11-30T00:00:00Z"),
      to: new Date("2026-10-25T00:00:00Z"),
    },
  ));
});

test("long-running recurrence produces upcoming occurrences", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:long-running@example.com",
    "DTSTART:20260105T180000Z",
    "DTEND:20260105T200000Z",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Long Running Event",
    "END:VEVENT",
  );

  const events = parseIcsEvents(input, {
    from: new Date("2026-10-24T00:00:00Z"),
    to: new Date("2026-11-14T00:00:00Z"),
  });

  assert.ok(events.length >= 2);
  assert.ok(events.every(event =>
    Date.parse(event.startsAt) >= Date.parse("2026-10-24T00:00:00Z")
  ));

  assert.ok(events.every(event =>
    event.externalEventId.startsWith("long-running@example.com::")
  ));

  assert.equal(
    new Set(events.map(event => event.externalEventId)).size,
    events.length,
  );
});

test("recurring all-day events preserve date-only semantics", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:all-day@example.com",
    "DTSTART;VALUE=DATE:20261026",
    "DTEND;VALUE=DATE:20261027",
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:All Day Event",
    "END:VEVENT",
  );

  const events = parseIcsEvents(input, {
    from: new Date("2026-10-25T00:00:00Z"),
    to: new Date("2026-11-01T00:00:00Z"),
  });

  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.allDay === true));
});

test("weekly recurrence respects local time through DST", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:dst@example.com",
    "DTSTART;TZID=America/New_York:20261026T180000",
    "DTEND;TZID=America/New_York:20261026T200000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:DST Test",
    "END:VEVENT",
  );

  const events = parseIcsEvents(input, {
    from: new Date("2026-10-25T00:00:00Z"),
    to: new Date("2026-11-15T00:00:00Z"),
  });

  assert.equal(events.length, 3);

  assert.deepEqual(
    events.map(event => event.startsAt),
    [
      "2026-10-26T22:00:00.000Z",
      "2026-11-02T23:00:00.000Z",
      "2026-11-09T23:00:00.000Z",
    ],
  );
});

test("partial overrides inherit metadata and cancelled instances are excluded", () => {
  const input = calendar(
    "BEGIN:VEVENT",
    "UID:override-test@example.com",
    "DTSTART:20261026T180000Z",
    "DTEND:20261026T200000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "SUMMARY:Original Event",
    "DESCRIPTION:Original Description",
    "LOCATION:Original Location",
    "URL:https://example.com/original",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:override-test@example.com",
    "RECURRENCE-ID:20261102T180000Z",
    "DTSTART:20261102T190000Z",
    "DTEND:20261102T210000Z",
    "SUMMARY:Original Event",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:override-test@example.com",
    "RECURRENCE-ID:20261109T180000Z",
    "DTSTART:20261109T180000Z",
    "DTEND:20261109T200000Z",
    "STATUS:CANCELLED",
    "SUMMARY:Original Event",
    "END:VEVENT",
  );

  const events = parseIcsEvents(input, {
    from: new Date("2026-10-25T00:00:00Z"),
    to: new Date("2026-11-30T00:00:00Z"),
  });

  assert.equal(events.length, 3);

  assert.deepEqual(
    events.map(event => event.startsAt),
    [
      "2026-10-26T18:00:00.000Z",
      "2026-11-02T19:00:00.000Z",
      "2026-11-16T18:00:00.000Z",
    ],
  );

  const moved = events[1];

  assert.equal(
    moved.externalEventId,
    "override-test@example.com::2026-11-02T18:00:00.000Z",
  );

  assert.equal(moved.description, "Original Description");
  assert.equal(moved.location, "Original Location");
  assert.equal(moved.sourceUrl, "https://example.com/original");

  assert.equal(
    events.some(event =>
      event.externalEventId.includes("2026-11-09T18:00:00.000Z")
    ),
    false,
  );
});
