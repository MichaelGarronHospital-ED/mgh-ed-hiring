// Calendar files (H8): folding, CRLF, escaping, the Toronto time zone, and a
// small parser that reads every event back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { icsEscape, foldLine, icsEvent, icsCalendar, CRLF } from "../js/ics.js";

// unfold (RFC 5545 3.1) and read VEVENTs back
function parse(text) {
  const lines = text.split(CRLF).reduce((acc, l) => { if (l.startsWith(" ")) acc[acc.length - 1] += l.slice(1); else if (l) acc.push(l); return acc; }, []);
  const events = []; let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") cur = {};
    else if (l === "END:VEVENT") { events.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(":"); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  return { lines, events };
}
const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1");

test("escaping: backslash, semicolon, comma, newline", () => {
  assert.equal(icsEscape("O'Brien, Dr; a\\b\nnext"), "O'Brien\\, Dr\; a\\\\b\\nnext");
});

test("every physical line is at most 75 octets, ends in CRLF, and folding never splits a character", () => {
  const long = "Panel: " + "Abara, Bruns-Okafor, Côté, Ñúñez, ".repeat(10);
  const folded = foldLine("DESCRIPTION:" + long);
  for (const l of folded.split(CRLF)) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.equal(folded.split(CRLF).map((l, i) => (i ? l.slice(1) : l)).join(""), "DESCRIPTION:" + long);
  const cal = icsCalendar([icsEvent({ uid: "t1-1-c-1@mgh-ed-hiring", date: "2027-03-03", start: "09:00", end: "10:00", summary: "x", description: long })]);
  assert.ok(cal.endsWith(CRLF));
  assert.ok(!/[^\r]\n/.test(cal), "a bare LF");
});

test("Toronto time with a VTIMEZONE, DTSTAMP in UTC, METHOD:PUBLISH, and every event reads back", () => {
  const now = new Date(Date.UTC(2027, 1, 20, 15, 4, 5));
  const cal = icsCalendar([
    icsEvent({ uid: "t1-1-c-1@mgh-ed-hiring", date: "2027-03-03", start: "09:00", end: "10:00", summary: "ED physician interview: Dr Ashcombe",
      description: "Panel: Vojdani (chair), Marrocco, Hayre", location: "ED admin office, 2nd floor", now }),
    icsEvent({ uid: "t2-2-c-2@mgh-ed-hiring", date: "2027-03-03", start: "13:30", end: "14:30", summary: "ED physician interview: Dr O'Brien", now }),
  ]);
  const { lines, events } = parse(cal);
  assert.ok(lines.includes("METHOD:PUBLISH") && lines.includes("TZID:America/Toronto"));
  assert.equal(events.length, 2);
  assert.equal(events[0]["DTSTART;TZID=America/Toronto"], "20270303T090000");
  assert.equal(events[0]["DTEND;TZID=America/Toronto"], "20270303T100000");
  assert.equal(events[0].DTSTAMP, "20270220T150405Z");
  assert.equal(unescape(events[0].LOCATION), "ED admin office, 2nd floor");
  assert.equal(unescape(events[0].DESCRIPTION), "Panel: Vojdani (chair), Marrocco, Hayre");
  assert.equal(events[1].UID, "t2-2-c-2@mgh-ed-hiring");
  assert.equal(unescape(events[1].SUMMARY), "ED physician interview: Dr O'Brien");
});
