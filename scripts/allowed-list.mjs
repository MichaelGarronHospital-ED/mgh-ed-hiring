// ============================================================================
//  The roster surname list that firestore.rules checks on every applicant
//  availability write (/interviews_meta/allowed).
//
//  Shared by sync-allowed.mjs and by any script that changes the roster, so a
//  rename or a purge can never leave the gate out of step with reality — an
//  applicant whose surname is missing is told "we can't find you", which is the
//  confusing outcome this whole mechanism exists to prevent.
// ============================================================================

import { doc, getDoc, setDoc } from "firebase/firestore";

// Must match util.js lastKey exactly — the app, the store and this list all key
// an applicant's availability document the same way or answers go missing.
export const lastKey = (name) =>
  String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

export const allowedKeysFrom = (candidates) =>
  [...new Set(candidates.filter((c) => !c.removed).map((c) => lastKey(c.name)).filter(Boolean))].sort();

export async function readAllowed(db) {
  const snap = await getDoc(doc(db, "interviews_meta", "allowed"));
  return snap.exists() && Array.isArray(snap.data().keys) ? [...snap.data().keys].sort() : null;
}

// Recompute from the roster and write if it differs. Returns what changed, so a
// caller can report it. Never writes an empty list: that would refuse every
// applicant, and an empty roster means something else has gone wrong.
export async function refreshAllowed(db, candidates, { apply }) {
  const want = allowedKeysFrom(candidates);
  const have = await readAllowed(db);
  const added = want.filter((k) => !(have || []).includes(k));
  const gone = (have || []).filter((k) => !want.includes(k));
  const changed = have === null || added.length > 0 || gone.length > 0;
  if (changed && apply && want.length)
    await setDoc(doc(db, "interviews_meta", "allowed"), { keys: want }, { mergeFields: ["keys"] });
  return { want, have, added, gone, changed, wrote: !!(changed && apply && want.length) };
}

// One line describing what refreshAllowed did or would do.
export function describeAllowed(r) {
  if (!r.changed) return `Applicant surname list already in step (${r.want.length} name(s)).`;
  if (r.have === null)
    return `Applicant surname list does not exist yet — ${r.wrote ? "created" : "would be created"} with ${r.want.length} name(s).`;
  const bits = [];
  if (r.added.length) bits.push(`+${r.added.join(", ")}`);
  if (r.gone.length) bits.push(`−${r.gone.join(", ")}`);
  return `Applicant surname list ${r.wrote ? "updated" : "would be updated"}: ${bits.join("  ")}`;
}
