// ============================================================================
//  Copy-ready messages (H8): no email service, no applicant emails stored.
//  Pure; no DOM. Plain words, and never an em or en dash (tests/notify.test.mjs).
//
//  p   = { name, slot: { date, start, end, label }, room, modality, chairName,
//          memberNames: [...] }
//  ctx = { applicantLink, staffLink, location, zoomLink, contact, replyBy,
//          availabilityBy }
// ============================================================================

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dateOf = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return new Date(y, m - 1, d); };
// "Wednesday, March 3"
export function longDate(iso) {
  if (!iso) return "";
  const d = dateOf(iso);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
// "Wed Mar 3"
export const shortDate = (iso) => { const d = dateOf(iso); return `${DAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
// "9:00 am", "1:30 pm"
export function clock(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
// "9:00 to 10:00 am", "11:30 am to 12:30 pm"
export function timeRange(start, end) {
  const a = clock(start), b = clock(end);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}
// "Wednesday, March 3, 9:00 to 10:00 am" (or the legacy label of an undated time)
export function whenText(slot) {
  if (!slot) return "";
  if (slot.date && slot.start && slot.end) return `${longDate(slot.date)}, ${timeRange(slot.start, slot.end)}`;
  return String(slot.label || "");
}
// "Hello Dr Ashcombe," for "Dr Rosalind Ashcombe"; the full name otherwise
export function salutation(name) {
  const n = String(name || "").trim();
  return /^dr\.?\s/i.test(n) ? `Dr ${n.split(/\s+/).pop()}` : n;
}

const whereText = (p, ctx, forPanel) => {
  if (p.modality === "zoom") return ctx.zoomLink ? `By Zoom: ${ctx.zoomLink}` : "By Zoom. We will send the Zoom link before the interview.";
  const place = ctx.location || "the Emergency Department";
  return forPanel ? place + (p.room === 2 ? ", room 2" : "") : `In person: ${place}`;
};

export function applicantInvite(p, ctx) {
  const lines = [
    `Hello ${salutation(p.name)},`, "",
    "Thank you for applying to the Emergency Department at Michael Garron Hospital. Your interview is booked for:", "",
    whenText(p.slot),
    whereText(p, ctx, false), "",
    `${ctx.replyBy ? `Please confirm by ${longDate(ctx.replyBy)}. ` : ""}You can confirm, or tell us you can no longer come, here: `
      + `${ctx.applicantLink}. Sign in with the Guest password we sent you, then your name.`, "",
    "If you have questions, reply to this email.",
  ];
  return { subject: "Your interview with the MGH Emergency Department", body: lines.join("\n") };
}

export function panelInvite(p, ctx) {
  const when = p.slot && p.slot.date ? `${shortDate(p.slot.date)}, ${clock(p.slot.start)}` : String((p.slot || {}).label || "");
  const panel = [p.chairName ? `${p.chairName} (chair)` : null, ...(p.memberNames || []).filter((n) => n !== p.chairName)].filter(Boolean).join(", ");
  const lines = [
    `You are on the interview panel for ${p.name}.`, "",
    `When: ${whenText(p.slot)}${p.room === 2 ? " (room 2)" : ""}`,
    `Where: ${p.modality === "zoom" ? (ctx.zoomLink ? `Zoom, ${ctx.zoomLink}` : "Zoom (the link will follow)") : whereText(p, ctx, true)}`,
    `Panel: ${panel}`, "",
    `Score in Physician Hiring: ${ctx.staffLink}. Use the ED password.`,
  ];
  return { subject: `Interview panel: ${when}`, body: lines.join("\n") };
}

// kind: "interviewers" | "applicants" | "confirm"
export function availabilityReminder(kind, ctx) {
  const by = (iso) => (iso ? ` by ${longDate(iso).replace(/^\w+, /, "")}` : "");
  if (kind === "interviewers") return {
    subject: "Please add your interview availability",
    body: `Hello, we still need your availability for the ED physician interviews. Please open Physician Hiring, choose `
      + `Availability, and tap the times you can do${by(ctx.availabilityBy)}: ${ctx.staffLink}. Thank you.`,
  };
  if (kind === "confirm") return {
    subject: "Please confirm your interview time",
    body: `Please confirm your interview time${by(ctx.replyBy)}, or tell us you can no longer come: ${ctx.applicantLink}. `
      + "Sign in with the Guest password we sent you, then your name.",
  };
  return {
    subject: "Please choose your interview times",
    body: `Please choose the interview times that work for you${by(ctx.availabilityBy)}: ${ctx.applicantLink}. `
      + "Sign in with the Guest password we sent you, then your name.",
  };
}

// A mailto: link, or null when it would pass 1,800 characters (some mail apps
// cut longer ones; the caller offers "copy" instead).
export function mailtoLink({ to = [], bcc = [], subject = "", body = "" }) {
  const q = [bcc.length ? `bcc=${bcc.map(encodeURIComponent).join(",")}` : "",
    `subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`].filter(Boolean).join("&");
  const link = `mailto:${to.map(encodeURIComponent).join(",")}?${q}`;
  return link.length > 1800 ? null : link;
}

// subject + body as one block to paste
export const asText = (m) => `Subject: ${m.subject}\n\n${m.body}`;
