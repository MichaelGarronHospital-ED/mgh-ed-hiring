// ============================================================================
//  Change history (H12). Pure helpers: no DOM, no store.
//
//  interviews_history/{autoId} = { at: <server time>, by, action, text,
//  cand?, member?, undo?, restored? }. Leadership actions only, append-only,
//  written in the SAME transaction or batch as the change it describes (so there
//  is never "saved but not logged"). No applicant name is ever stored: `text`
//  may hold {cand} and {member}, and names are drawn from the ids when the
//  history is shown. Never put a password in an entry.
//
//  Undo exists only for changes that touch one field with no side effects, so
//  "has it changed since?" is one comparison of a hash:
//    panel.save, panel.reset, panel.resetAll   (the entries of panelOverrides)
//    shortlist.set                             (a leadership on/off decision)
//    screening.toNote                          (one screening document)
//  Everything else is logged only; most have a plain opposite action already.
// ============================================================================

export const ACTIONS = Object.freeze([
  "roster.add", "roster.remove", "roster.restore", "roster.rename", "roster.merge", "roster.delete",
  "shortlist.set", "screening.toNote", "committee.save", "chair.set", "day.set",
  "times.add", "times.edit", "times.remove", "questions.migrate", "questions.save",
  "stage.close", "stage.reopen", "schedule.lock", "schedule.unlock", "schedule.edit",
  "panel.save", "panel.reset", "panel.resetAll", "notices.publish", "offer.set",
  "ranking.reveal", "ranking.hide", "settings.save", "round.close", "round.restore",
  "round.delete", "backup.restore", "passwords.change", "undo",
]);
export const UNDOABLE = new Set(["panel.save", "panel.reset", "panel.resetAll", "shortlist.set", "screening.toNote"]);

const cut = (s, n) => { const t = String(s == null ? "" : s); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// A new entry, without `at` (the store stamps it with the server time).
export function entry(action, text, opts = {}) {
  const e = { by: cut(opts.by || "leadership", 80), action: cut(action, 60), text: cut(text, 600) };
  if (opts.cand) e.cand = String(opts.cand);
  if (opts.member) e.member = String(opts.member);
  if (opts.undo) e.undo = opts.undo;
  if (opts.id) e._id = opts.id;          // the store uses it as the document id, then drops it
  return e;
}
export const newHistoryId = () => "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- a stable hash of any JSON value ---------------------------------------
// Canonical JSON (keys sorted at every level) through FNV-1a, twice with two
// seeds for 64 bits. Synchronous, so it can run inside a transaction.
export function canonicalJson(x) {
  if (x === undefined) return "null";
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(x).filter((k) => x[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(x[k])).join(",") + "}";
}
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
export const hashOf = (x) => { const s = canonicalJson(x); return fnv(s, 2166136261) + fnv(s, 0x811c9dc5 ^ 0x5bd1e995); };

// ---- undo data ---------------------------------------------------------------
// Hand-made panels: the affected candidates' entries before and after.
export function panelUndo(beforeMap, afterMap, cids) {
  const pick = (m) => Object.fromEntries(cids.map((c) => [c, (m || {})[c] || null]));
  return { kind: "panelOverrides", before: pick(beforeMap), afterHash: hashOf(pick(afterMap)) };
}
// A leadership shortlist decision on one candidate.
export function shortlistUndo(beforeCand, afterCand) {
  const pick = (c) => ({ shortlist: (c && c.shortlist) || null, shortlistBy: (c && c.shortlistBy) || null });
  return { kind: "shortlist", before: pick(beforeCand), afterHash: hashOf(pick(afterCand)) };
}
// One screening document.
export function screeningUndo(id, beforeDoc, afterDoc) {
  return { kind: "screening", id, before: beforeDoc || null, afterHash: hashOf(afterDoc || null) };
}

// What the thing an entry changed looks like now, in the same shape its
// afterHash was made from.
function currentFor(e, state) {
  const u = e.undo || {};
  if (u.kind === "panelOverrides") {
    const cur = ((state.settings || {}).panelOverrides) || {};
    return Object.fromEntries(Object.keys(u.before || {}).map((c) => [c, cur[c] || null]));
  }
  if (u.kind === "shortlist") {
    const c = (state.candidates || []).find((x) => x.id === e.cand);
    return { shortlist: (c && c.shortlist) || null, shortlistBy: (c && c.shortlistBy) || null };
  }
  if (u.kind === "screening") return (state.screening || {})[u.id] || null;
  return undefined;
}

// Can this entry still be undone? `undone` is the set of entry ids already undone.
// { ok, why } where why is the text shown instead of the button.
export function canUndo(e, state, undone = new Set()) {
  if (!e || !UNDOABLE.has(e.action) || !e.undo || e.restored) return { ok: false, why: "" };
  if (e.id && undone.has(e.id)) return { ok: false, why: "Undone." };
  const cur = currentFor(e, state);
  if (cur === undefined) return { ok: false, why: "" };
  return hashOf(cur) === e.undo.afterHash ? { ok: true, why: "" } : { ok: false, why: "Can't undo: changed since." };
}

// The entry ids that a later "undo" entry points at.
export function undoneIds(entries) {
  return new Set((entries || []).filter((e) => e.action === "undo" && e.undo && e.undo.of).map((e) => e.undo.of));
}

// ---- display -------------------------------------------------------------
// Names are drawn from ids at display time; an id nobody knows any more shows
// as "an applicant" / the id, never as an error.
export function textFor(e, { candName, memberName } = {}) {
  const c = e.cand ? ((candName && candName(e.cand)) || "an applicant") : "";
  const m = e.member ? ((memberName && memberName(e.member)) || e.member) : "";
  let t = String(e.text || "");
  const hadC = t.includes("{cand}"), hadM = t.includes("{member}");
  t = t.split("{cand}").join(c).split("{member}").join(m);
  if (e.cand && !hadC) t += `: ${c}`;
  return t;
}

export function whoFor(e, memberName) {
  if (!e.by || e.by === "leadership") return "Leadership";
  return `Leadership (${(memberName && memberName(e.by)) || e.by})`;
}

// "Mar 1, 2:14 pm" from a Firestore Timestamp, a { __ts } value, a Date or an ISO string.
export function toDate(at) {
  if (!at) return null;
  if (typeof at.toDate === "function") return at.toDate();
  if (at.__ts) return new Date(at.__ts);
  if (typeof at.seconds === "number") return new Date(at.seconds * 1000);
  const d = new Date(at);
  return isNaN(d) ? null : d;
}
export function whenFor(at) {
  const d = toDate(at);
  if (!d) return "Just now";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" AM", " am").replace(" PM", " pm");
  return `${day}, ${time}`;
}
