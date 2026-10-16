// ============================================================================
//  Calendar files (.ics, RFC 5545) for interviews (H8). Pure; no DOM.
//  Times are Toronto local time (TZID=America/Toronto with a VTIMEZONE block);
//  DTSTAMP is UTC. Lines are folded at 75 octets with CRLF line ends.
// ============================================================================

export const CRLF = "\r\n";

// Text values: backslash, semicolon, comma and newlines are escaped.
export const icsEscape = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Fold one content line so no physical line passes 75 octets (UTF-8), never
// splitting a character; continuation lines start with one space.
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join(CRLF);
}

// Eastern time as Toronto has used it since 2007 (second Sunday of March to the
// first Sunday of November).
export const VTIMEZONE_TORONTO = [
  "BEGIN:VTIMEZONE", "TZID:America/Toronto",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

const local = (date, hhmm) => `${date.replace(/-/g, "")}T${hhmm.replace(":", "")}00`;
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// One event. date "YYYY-MM-DD", start/end "HH:MM" (Toronto time).
export function icsEvent({ uid, date, start, end, summary, description = "", location = "", now = new Date() }) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART;TZID=America/Toronto:${local(date, start)}`,
    `DTEND;TZID=America/Toronto:${local(date, end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    "END:VEVENT",
  ];
}

export function icsCalendar(events) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MGH ED//Physician Hiring//EN", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", ...VTIMEZONE_TORONTO, ...events.flat(), "END:VCALENDAR"];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
