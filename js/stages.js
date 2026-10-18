// ============================================================================
//  Round stages and the shortlist (H4, H7). Pure helpers: no DOM, no store.
//
//  interviews_meta/state.stages = { screening: { closed, at }, availability: {...},
//  scoring: {...} }. Absent means open (the same reading as firestore.rules).
//  state.roundStatus "closing" pauses every stage (H1).
//
//  The interview list (H7): an applicant is on it unless removed, or taken off
//  by Admin (shortlist "out"), or, with no decision, has reached the
//  concern threshold. shortlistBy says who decided: "leadership", or "auto"
//  when closing screening froze the rule's answer. 0 = never take anyone off
//  automatically.
// ============================================================================

export const STAGES = Object.freeze(["screening", "availability", "scoring"]);
export const STAGE_WORD = Object.freeze({ screening: "Screening", availability: "Availability", scoring: "Scoring" });
export const DEFAULT_THRESHOLD = 2;

export const roundOpen = (state) => ((state || {}).roundStatus || "open") !== "closing";
export function stageOpen(state, name) {
  const s = state || {};
  return roundOpen(s) && !(((s.stages || {})[name] || {}).closed === true);
}
export const stageClosedAt = (state, name) => (((state || {}).stages || {})[name] || {}).at || null;

// What the public times document says about booking (review M6): paused while
// a round is closing, closed when availability is closed, open otherwise.
export function bookingFor(state) {
  if (!roundOpen(state)) return "paused";
  return stageOpen(state, "availability") ? "open" : "closed";
}

export function thresholdOf(config) {
  const t = (config || {}).flagThreshold;
  return Number.isInteger(t) && t >= 0 ? t : DEFAULT_THRESHOLD;
}

// Is this applicant on the interview list?
//   c          the candidate document ({ removed, shortlist, shortlistBy })
//   concerns   how many concerns count against them
//   threshold  0 = never off automatically
export function isOnList(c, concerns, threshold) {
  if (!c || c.removed) return false;
  if (c.shortlist === "in") return true;
  if (c.shortlist === "out") return false;
  return threshold === 0 || concerns < threshold;
}

// Closing screening freezes the rule's answer for every applicant without a
// Admin decision. Returns { patches: { id: { shortlist, shortlistBy } }, on, off }.
export function closePlan(cands, concernsOf, threshold) {
  const patches = {}; let on = 0, off = 0;
  (cands || []).filter((c) => !c.removed).forEach((c) => {
    const decided = c.shortlistBy === "leadership" && (c.shortlist === "in" || c.shortlist === "out");
    const inList = decided ? c.shortlist === "in" : isOnList({ removed: false }, concernsOf(c.id), threshold);
    if (inList) on++; else off++;
    if (!decided) patches[c.id] = { shortlist: inList ? "in" : "out", shortlistBy: "auto" };
  });
  return { patches, on, off };
}
// Reopening screening clears the frozen answers; Admin decisions stay.
export function reopenPlan(cands) {
  return (cands || []).filter((c) => c.shortlistBy === "auto").map((c) => c.id);
}

// The locked schedule (H4): a panel as stored in interviews_meta/schedule.
export const lockEntry = (p, chair) => ({ slot: String(p.slot), room: p.room || 1, chair: p.chair || chair,
  members: [...p.members], modality: p.modality });
