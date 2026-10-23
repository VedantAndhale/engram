import { test } from "node:test";
import assert from "node:assert/strict";
import { REMINDER_UID, reminderIcs } from "./calendar";

const url = "https://engram.example/today";
const field = (ics: string, name: string) => ics.split("\r\n").find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

test("every reminder file is the same event, so a new time replaces the old one", () => {
  const first = reminderIcs("08:30", url, Date.UTC(2026, 9, 13, 6));
  const second = reminderIcs("19:00", url, Date.UTC(2026, 9, 14, 6));
  assert.equal(field(first, "UID"), REMINDER_UID);
  assert.equal(field(second, "UID"), REMINDER_UID);
  assert.equal(first.split("\r\n").filter((l) => l.startsWith("UID:")).length, 1);
  // The later file wins: a higher SEQUENCE and a later DTSTAMP.
  assert.ok(Number(field(second, "SEQUENCE")) > Number(field(first, "SEQUENCE")));
  assert.ok(field(second, "DTSTAMP")! > field(first, "DTSTAMP")!);
  assert.match(field(second, "DTSTART")!, /T190000$/);
  assert.equal(field(first, "RRULE"), "FREQ=DAILY");
});

test("text in the file is escaped and lines end in CRLF", () => {
  const ics = reminderIcs("08:30", "https://x.example/a,b;c", Date.UTC(2026, 9, 13, 6));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(field(ics, "DESCRIPTION")!, /\\nhttps:\/\/x\.example\/a\\,b\\;c$/);
});
