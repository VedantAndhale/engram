/*
 * The daily reminder is a repeating calendar event the person adds to their own calendar.
 * No server and no push: their calendar app does the reminding.
 */

const TITLE = "Engram: a few minutes for your second brain";
const DETAILS = "Review three highlights, or save one thing worth keeping and say why in your own words.";

export const appUrl = () => `${location.origin}${location.pathname}#/today`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Next occurrence of HH:MM as a floating local time ("20261011T083000"), which calendars read as the device's time zone. */
function startStamp(time: string): { date: Date; local: string } {
  const [h, m] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  if (date.getTime() < Date.now()) date.setDate(date.getDate() + 1);
  const local = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(h)}${pad(m)}00`;
  return { date, local };
}

/** Escape text for an iCalendar property value. */
const ics = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/** Download a daily repeating event that works in Apple Calendar, Outlook, Google Calendar (import) and others. */
export function downloadIcs(time: string) {
  const { local } = startStamp(time);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const url = appUrl();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Engram//Daily reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:engram-daily-${crypto.randomUUID()}`,
    `DTSTAMP:${stamp}`,
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
  const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/calendar" });
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
