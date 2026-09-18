// ============================================================================
//  Interview times ("slots"). Pure helpers — no DOM, no store.
//
//  A time is { id, date:"YYYY-MM-DD", start:"HH:MM", end:"HH:MM" } (24 h, local
//  ED time). Availability and panel overrides are keyed by `id`, which never
//  changes when a time is edited or others are added/removed — so answers can't
//  silently shift onto a different time.
//
//  Storage: settings.times (committee config) + interviews_public/slots.times
//  (applicant mirror). When `times` is an array it is authoritative, even empty.
//  Older data (settings.slots = ["Oct 1 · 10:00", …], keyed by list index) and
//  the config.js defaults are read through the same normalizer; legacy entries
//  keep their index as id so earlier answers still line up.
// ============================================================================

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const newSlotId = () =>
  "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export const isStructured = (t) => !!(t && DATE_RE.test(t.date || "") && TIME_RE.test(t.start || "") && TIME_RE.test(t.end || ""));

// one entry → normalized object (or null if unusable)
function norm1(x, i) {
  if (typeof x === "string") return x.trim() ? { id: String(i), date: "", start: "", end: "", label: x.trim() } : null;
  if (!x || typeof x !== "object") return null;
  const id = ID_RE.test(String(x.id || "")) ? String(x.id) : String(i);
  return { id, date: x.date || "", start: x.start || "", end: x.end || "", label: x.label || "" };
}

// normalize + de-duplicate ids (first wins) + chronological order; undated
// legacy labels keep their relative order at the end.
export function normalizeSlots(list) {
  const seen = new Set(), out = [];
  (Array.isArray(list) ? list : []).forEach((x, i) => {
    const t = norm1(x, i);
    if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
  });
  return sortSlots(out);
}
export function sortSlots(list) {
  return list.map((t, i) => [t, i]).sort(([a, i], [b, j]) => {
    const sa = isStructured(a), sb = isStructured(b);
    if (sa !== sb) return sa ? -1 : 1;
    if (!sa) return i - j;
    return a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
  }).map(([t]) => t);
}

// The list everyone sees. `settings.times` (array) wins; else legacy strings;
// else the config.js defaults.
export function effectiveSlots(settings, defaults) {
  const s = settings || {};
  if (Array.isArray(s.times)) return normalizeSlots(s.times);
  return normalizeSlots(s.slots && s.slots.length ? s.slots : defaults);
}
// what to write back: plain objects, no derived fields
export const toStored = (list) => list.map(({ id, date, start, end, label }) =>
  isStructured({ date, start, end }) ? { id, date, start, end } : { id, label: label || "" });

// ---- formatting -----------------------------------------------------------
export function fmtTime(t) {
  const n = mins(t), h = Math.floor(n / 60), m = n % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
}
const ampm = (t) => (mins(t) < 720 ? "am" : "pm");
export function fmtRange(start, end) {
  return ampm(start) === ampm(end)
    ? `${fmtTime(start)}–${fmtTime(end)} ${ampm(end)}`
    : `${fmtTime(start)} ${ampm(start)}–${fmtTime(end)} ${ampm(end)}`;
}
export function fmtDate(iso, long) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US",
    long ? { weekday: "long", month: "long", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
}
export const slotLabel = (t) => !t ? "(removed time)"
  : isStructured(t) ? `${fmtDate(t.date)} · ${fmtRange(t.start, t.end)}` : (t.label || "(untitled time)");
export const slotTimeLabel = (t) => isStructured(t) ? fmtRange(t.start, t.end) : (t.label || "(untitled time)");

// group for display: [{ date, title, items }] — undated legacy entries last
export function groupByDate(list) {
  const groups = [];
  list.forEach((t) => {
    const k = isStructured(t) ? t.date : "";
    let g = groups.find((x) => x.date === k);
    if (!g) groups.push(g = { date: k, title: k ? fmtDate(k, true) : "Other times", items: [] });
    g.items.push(t);
  });
  return groups;
}

// ---- validation -----------------------------------------------------------
// errors block saving; warnings ask for confirmation.
export function checkSlot(t, others, today = new Date()) {
  const errors = [], warnings = [];
  if (!DATE_RE.test(t.date || "")) errors.push("Pick a date.");
  if (!TIME_RE.test(t.start || "")) errors.push("Pick a start time.");
  if (!TIME_RE.test(t.end || "")) errors.push("Pick an end time.");
  if (errors.length) return { errors, warnings };
  if (mins(t.end) <= mins(t.start)) errors.push("The end time must be after the start time.");
  const same = others.filter((o) => o.id !== t.id && isStructured(o) && o.date === t.date);
  if (same.some((o) => o.start === t.start && o.end === t.end)) errors.push(`${slotLabel(t)} already exists.`);
  if (errors.length) return { errors, warnings };
  const clash = same.filter((o) => mins(o.start) < mins(t.end) && mins(t.start) < mins(o.end));
  if (clash.length) warnings.push(`It overlaps ${clash.map(slotTimeLabel).join(", ")} on the same day — the chair can't be on two panels at once.`);
  const d0 = new Date(today); d0.setHours(0, 0, 0, 0);
  const [y, m, d] = t.date.split("-").map(Number);
  if (new Date(y, m - 1, d) < d0) warnings.push(`${fmtDate(t.date, true)} is in the past.`);
  return { errors, warnings };
}

// Back-to-back times from `from` to `to` of `len` minutes each (len 0 = one
// time covering the whole range). A leftover shorter than `len` is dropped.
export function splitRange(date, from, to, len) {
  if (!TIME_RE.test(from || "") || !TIME_RE.test(to || "")) return [];
  const a = mins(from), b = mins(to);
  if (b <= a) return [];
  if (!len) return [{ date, start: from, end: to }];
  const out = [];
  for (let s = a; s + len <= b; s += len) out.push({ date, start: hhmm(s), end: hhmm(s + len) });
  return out;
}

// how many people have answered for each time id. Pass one availability map per
// person who counts (current committee, active candidates) — not raw collections,
// which also hold removed members and stray applicant docs.
export function responseCounts(ivMaps, candMaps) {
  const c = {};
  const add = (maps, kind) => maps.forEach((m) =>
    Object.keys(m || {}).forEach((id) => { (c[id] = c[id] || { iv: 0, cand: 0 })[kind]++; }));
  add(ivMaps, "iv"); add(candMaps, "cand");
  return c;
}
