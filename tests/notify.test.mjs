// Copy-ready messages (H8): the texts the design gives, no em or en dashes
// anywhere, plain words, and the mailto length fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applicantInvite, panelInvite, availabilityReminder, mailtoLink, timeRange, whenText, salutation, asText } from "../js/notify.js";

const ctx = { applicantLink: "https://example.org/mgh-ed-hiring/index.html#apply", staffLink: "https://example.org/mgh-ed-hiring/index.html",
  location: "ED admin office, 2nd floor", zoomLink: "", contact: "", replyBy: "2027-02-27", availabilityBy: "2027-02-20" };
const p = { name: "Dr Rosalind Ashcombe", slot: { date: "2027-03-03", start: "09:00", end: "10:00" }, room: 1, modality: "ip",
  chairName: "Vojdani", memberNames: ["Vojdani", "Marrocco", "Hayre"] };

test("the applicant email", () => {
  const m = applicantInvite(p, ctx);
  assert.equal(m.subject, "Your interview with the MGH Emergency Department");
  assert.ok(m.body.startsWith("Hello Dr Ashcombe,\n\nThank you for applying to the Emergency Department at Michael Garron Hospital."));
  assert.ok(m.body.includes("Wednesday, March 3, 9:00 to 10:00 am\nIn person: ED admin office, 2nd floor"));
  assert.ok(m.body.includes("Please confirm by Saturday, February 27. You can confirm, or tell us you can no longer come, here: " + ctx.applicantLink));
  const z = applicantInvite({ ...p, modality: "zoom" }, ctx);
  assert.ok(z.body.includes("Virtual. We will send the link before the interview."));
  assert.ok(!/zoom/i.test(z.body), "the applicant email says virtual, never Zoom");
});

test("the panel email", () => {
  const m = panelInvite({ ...p, room: 2 }, ctx);
  assert.equal(m.subject, "Interview panel: Wed Mar 3, 9:00 am");
  assert.ok(m.body.includes("You are on the interview panel for Dr Rosalind Ashcombe."));
  assert.ok(m.body.includes("When: Wednesday, March 3, 9:00 to 10:00 am (room 2)"));
  assert.ok(m.body.includes("Panel: Vojdani (chair), Marrocco, Hayre"));
  assert.ok(m.body.includes("Use the ED password."));
});

test("reminders", () => {
  assert.ok(availabilityReminder("interviewers", ctx).body.includes("tap the times you can do by February 20:"));
  assert.ok(availabilityReminder("applicants", ctx).body.startsWith("Please choose the interview times that work for you by February 20:"));
  assert.ok(availabilityReminder("confirm", ctx).body.includes("Please confirm your interview time by February 27"));
});

test("times read with 'to', never a dash", () => {
  assert.equal(timeRange("09:00", "10:00"), "9:00 to 10:00 am");
  assert.equal(timeRange("11:30", "12:30"), "11:30 am to 12:30 pm");
  assert.equal(whenText({ label: "Oct 1 · 10:00" }), "Oct 1 · 10:00");
  assert.equal(salutation("Jane Kim"), "Jane Kim");
});

test("no em or en dash and no officialese in any generated text", () => {
  const all = [applicantInvite(p, ctx), applicantInvite({ ...p, modality: "zoom" }, { ...ctx, zoomLink: "https://zoom.example/1" }),
    panelInvite(p, ctx), panelInvite({ ...p, modality: "zoom" }, ctx),
    ...["interviewers", "applicants", "confirm"].map((k) => availabilityReminder(k, ctx))].map(asText).join("\n");
  assert.ok(!/[–—]/.test(all), "an em or en dash");
  for (const w of ["utilize", "commence", "prior to", "pursuant", "herein", "kindly", "hereby"]) assert.ok(!all.toLowerCase().includes(w), w);
});

test("mailto falls back to copy when the link would pass 1,800 characters", () => {
  const ok = mailtoLink({ bcc: ["a.b@tehn.ca", "c.d@tehn.ca"], subject: "Hi", body: "Short" });
  assert.match(ok, /^mailto:\?bcc=a\.b%40tehn\.ca,c\.d%40tehn\.ca&subject=Hi&body=Short$/);
  assert.equal(mailtoLink({ bcc: Array.from({ length: 120 }, (_, i) => `person${i}@tehn.ca`), subject: "x", body: "y".repeat(100) }), null);
});

test("an applicant who shares first and last name with another is told exactly what to type", () => {
  const m = applicantInvite({ name: "Dr Jane B Kim", slot: { date: "2027-03-03", start: "09:00", end: "10:00" }, modality: "ip", typeFirst: "Jane B" },
    { applicantLink: "https://x/index.html#apply" });
  assert.match(m.body, /For your first name, type exactly: Jane B/);
  const n = applicantInvite({ name: "Dr Min Kim", slot: { date: "2027-03-03", start: "09:00", end: "10:00" }, modality: "ip", typeFirst: null },
    { applicantLink: "https://x/index.html#apply" });
  assert.doesNotMatch(n.body, /type exactly/);
});
