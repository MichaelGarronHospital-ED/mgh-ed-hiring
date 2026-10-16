// ============================================================================
//  Committee members, keyed by a stable id (H6). Pure helpers: no DOM, no store.
//
//  Every key in Firestore that names a person (screening and score documents
//  "<member>~<candId>", interviewer availability "<member>", the chair, the
//  members of a hand-made panel, this browser's echo) holds a member ID. The
//  name is for display only, so renaming someone never moves their input.
//
//  Legacy entries are { name, gender }. Their id IS their name, which is exactly
//  the key every existing document already uses, so nothing is ever re-keyed and
//  live data needs no migration. Never re-key a member.
//
//  A member is { id, name, gender: "F"|"M"|"", role: "interviewer"|"screener",
//  active: true|false, email? }. "screener" = screens only (not on panels, no
//  Score tab, not in the availability grid). active:false = left the committee:
//  their input stays and still counts, but they leave every list of people.
// ============================================================================

export const ROLES = Object.freeze(["interviewer", "screener"]);

// ids never contain "/" (a Firestore path separator) or "~" (the key separator)
export const validMemberId = (id) => typeof id === "string" && id.length >= 1 && id.length <= 80 && !/[/~]/.test(id);

export const newMemberId = () =>
  "m-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);

const gender = (g) => { const v = String(g || "").trim().toUpperCase(); return v === "F" || v === "M" ? v : ""; };

// one stored entry → normalized, or null if unusable
function norm1(x) {
  if (!x || typeof x !== "object") return null;
  const name = String(x.name || "").trim();
  const id = validMemberId(x.id) ? x.id : name;
  if (!name || !validMemberId(id)) return null;
  const m = { id, name, gender: gender(x.gender), role: x.role === "screener" ? "screener" : "interviewer",
              active: x.active !== false };
  if (x.email) m.email = String(x.email).trim();
  return m;
}

// Normalize a stored committee list. Order is kept (the panel builder reads the
// roster in this order); a repeated id keeps its first entry.
export function normalizeCommittee(list) {
  const seen = new Set(), out = [];
  (Array.isArray(list) ? list : []).forEach((x) => {
    const m = norm1(x);
    if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
  });
  return out;
}

// What to write back: plain objects. Legacy-looking entries stay legacy-looking
// (no role/active written when they are the defaults), so an older page that
// reads { name, gender } sees exactly what it always did.
export function toStoredCommittee(list) {
  return normalizeCommittee(list).map((m) => {
    const o = { id: m.id, name: m.name, gender: m.gender };
    if (m.role !== "interviewer") o.role = m.role;
    if (!m.active) o.active = false;
    if (m.email) o.email = m.email;
    return o;
  });
}

export const memberOf = (committee, id) => (committee || []).find((m) => m.id === id) || null;
// The display name for an id. A person no longer on the list at all (removed
// outright by an old page) shows under their id, which for legacy members is
// their name.
export const memberName = (committee, id) => { const m = memberOf(committee, id); return m ? m.name : String(id || ""); };
export const interviewers = (c) => (c || []).filter((m) => m.active && m.role === "interviewer");
export const pickable = (c) => (c || []).filter((m) => m.active);

// Has this person saved anything in the round? (A row can be removed outright
// only when they have not.) `state` is the store's normalized state.
export function hasInput(state, id) {
  const pre = id + "~";
  const any = (map, test) => Object.entries(map || {}).some(([k, v]) => k.startsWith(pre) && test(v));
  const screened = any(state.screening, (v) => v && (v.flag || v.rating || String(v.reason || "").trim() || String(v.note || "").trim()));
  const scored = any(state.scores, (v) => v && (v.overall || Object.values(v.notes || {}).some((t) => String(t || "").trim())));
  const avail = Object.keys((state.availIv || {})[id] || {}).length > 0;
  return screened || scored || avail;
}

// Every member id that appears in the round's input, including people who are
// no longer on the committee list. Used by exports so nobody's input is dropped.
export function idsWithInput(state) {
  const ids = new Set();
  const from = (map) => Object.keys(map || {}).forEach((k) => { const i = k.indexOf("~"); if (i > 0) ids.add(k.slice(0, i)); });
  from(state.screening); from(state.scores);
  Object.entries(state.availIv || {}).forEach(([id, m]) => { if (m && Object.keys(m).length) ids.add(id); });
  return ids;
}

// Status word for exports and the collation.
export function memberStatus(committee, id) {
  const m = memberOf(committee, id);
  if (!m) return "Not on the list now";
  if (!m.active) return "Left the committee";
  return m.role === "screener" ? "Screens only" : "Interviews and screens";
}

// Problems with a committee list before it is saved. errors block the save;
// warnings are shown and the save goes ahead.
export function checkCommittee(list, { chair } = {}) {
  const errors = [], warnings = [];
  const c = normalizeCommittee(list);
  if (!c.length) errors.push("Add at least one person.");
  const active = c.filter((m) => m.active);
  const byName = {};
  active.forEach((m) => { const k = m.name.toLowerCase(); (byName[k] = byName[k] || []).push(m); });
  Object.values(byName).filter((g) => g.length > 1).forEach((g) =>
    warnings.push(`Two people are called ${g[0].name}. Add a first initial to one.`));
  interviewers(c).filter((m) => !m.gender).forEach((m) =>
    warnings.push(`${m.name} interviews but has no F or M, so they can't be placed on a balanced panel.`));
  if (chair) {
    const ch = memberOf(c, chair);
    if (!ch) errors.push("The chair is not on the list. Pick another chair first.");
    else if (!ch.active) errors.push(`${ch.name} is the chair and can't leave the committee. Pick another chair first.`);
    else if (ch.role !== "interviewer") errors.push(`${ch.name} is the chair, so they must interview. Pick another chair first.`);
  }
  return { errors, warnings, committee: c };
}
