import { APP_BASE } from "../lib/base";
/*
 * The daily reminder is a repeating calendar event the person adds to their own calendar.
 * No server and no push: their calendar app does the reminding.
 */

const TITLE = "Engram: a few minutes with your highlights";
const DETAILS = "Review three highlights, or save one thing worth keeping and say why in your own words.";
/**
 * Every download is the same event, so a calendar that already has it updates it in place.
 * Changing the time then moves the one reminder instead of adding a second.
 */
export const REMINDER_UID = "engram-daily-reminder@engram";

export const appUrl = () => `${location.origin}${APP_BASE}/today`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Next occurrence of HH:MM as a floating local time ("20261011T083000"), which calendars read as the device's time zone. */
function startStamp(time: string, now = Date.now()): { date: Date; local: string } {
  const [h, m] = time.split(":").map(Number);
  const date = new Date(now);
  date.setHours(h, m, 0, 0);
  if (date.getTime() < now) date.setDate(date.getDate() + 1);
  const local = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(h)}${pad(m)}00`;
  return { date, local };
}

/** Escape text for an iCalendar property value. */
const ics = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/** The .ics text for a daily event at `time`. A later file has a higher SEQUENCE, so it wins over an earlier one. */
export function reminderIcs(time: string, url: string, now = Date.now()): string {
  const { local } = startStamp(time, now);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  // Minutes since 2026: always growing, and small enough for calendars that read it as a 32-bit number.
  const sequence = Math.max(0, Math.floor((now - Date.UTC(2026, 0, 1)) / 60_000));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Engram//Daily reminder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${REMINDER_UID}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `DTSTART:${local}`,
    "DURATION:PT10M",
    "RRULE:FREQ=DAILY",
    `SUMMARY:${ics(TITLE)}`,
    `DESCRIPTION:${ics(`${DETAILS}\n${url}`)}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${ics(TITLE)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Download a daily repeating event that works in Apple Calendar, Outlook, Google Calendar (import) and others. */
export function downloadIcs(time: string) {
  const blob = new Blob([reminderIcs(time, appUrl())], { type: "text/calendar" });
  const href = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href, download: "engram-reminder.ics" }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Google Calendar's own "add event" page, prefilled. Times without a zone use the calendar's zone. */
export function googleCalendarUrl(time: string): string {
  const { date, local } = startStamp(time);
  const end = new Date(date.getTime() + 10 * 60_000);
  const endLocal = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T${pad(end.getHours())}${pad(end.getMinutes())}00`;
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: TITLE,
    details: `${DETAILS}\n${appUrl()}`,
    dates: `${local}/${endLocal}`,
    recur: "RRULE:FREQ=DAILY",
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
