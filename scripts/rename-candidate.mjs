#!/usr/bin/env node
// ============================================================================
//  rename-candidate.mjs — fix a candidate's name IN PLACE.
//
//  THIS IS THE RIGHT WAY TO FIX A MISSPELLED NAME. The app has no rename, so
//  the temptation is to remove the candidate and add them again — but that
//  mints a new c-<uuid>, and every rating, score and note stays keyed to the
//  old one and disappears from the UI (that is what happened to Rosalind).
//
//  Updating the `name` field keeps the document id, so screening, scores,
//  notes and manual panels stay attached with nothing to migrate. The only
//  thing keyed by NAME rather than id is applicant availability
//  (interviews_availCand is keyed by normalized surname), so this moves that
//  doc too when the surname changes.
//
//  DRY RUN BY DEFAULT. Nothing is written without --apply.
//
//  Usage:
//    ED_IV_ADMIN_PASSWORD='…' node rename-candidate.mjs --who "Dr Rowan Beaufort" --to "Dr Rowan Beaufort Kim"
//    ED_IV_ADMIN_PASSWORD='…' node rename-candidate.mjs --who "…" --to "…" --apply
//
//  Flags:
//    --who "<name|id>"  the candidate to rename (a c-<uuid> is unambiguous)
//    --to  "<new name>" the corrected name, exactly as it should appear
//    --apply            perform the writes
//    --force            proceed even when the new surname collides with
//                       another candidate's (they would share one availability
//                       doc and overwrite each other — see the warning)
// ============================================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, setDoc, updateDoc, deleteDoc,
         connectFirestoreEmulator } from "firebase/firestore";
import { firebaseConfig, AUTH } from "../js/config.js";
import { refreshAllowed, describeAllowed, lastKey } from "./allowed-list.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply"), FORCE = argv.includes("--force");
const WHO = val("--who"), TO = val("--to");

if (!WHO || !TO) {
  console.error('Usage: node rename-candidate.mjs --who "Current Name" --to "Corrected Name" [--apply]');
  process.exit(1);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NEW_NAME = TO.trim().replace(/\s+/g, " ");

const PASSWORD = process.env.ED_IV_ADMIN_PASSWORD;
if (!PASSWORD && !process.env.ED_IV_EMULATOR) { console.error("ED_IV_ADMIN_PASSWORD is not set."); process.exit(1); }

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
if (process.env.ED_IV_EMULATOR) {
  const [host, port] = process.env.ED_IV_EMULATOR.split(":");
  connectFirestoreEmulator(db, host, Number(port));
  if (process.env.ED_IV_AUTH_EMULATOR) connectAuthEmulator(auth, `http://${process.env.ED_IV_AUTH_EMULATOR}`, { disableWarnings: true });
  console.log(`*** EMULATOR MODE (${process.env.ED_IV_EMULATOR}) — the live project is NOT being touched ***`);
} else {
  try { await signInWithEmailAndPassword(auth, AUTH.adminEmail, PASSWORD); }
  catch (e) { console.error(`Sign-in failed (${e.code || e.message}).`); process.exit(1); }
}
console.log(`Project: ${firebaseConfig.projectId}\n`);

const readAll = async (name) =>
  (await getDocs(collection(db, name))).docs.map((d) => ({ id: d.id, ...d.data() }));
const [candidates, screening, scores, availCand] = await Promise.all([
  readAll("interviews_candidates"), readAll("interviews_screening"),
  readAll("interviews_scores"), readAll("interviews_availCand"),
]);

// ------------------------------------------------------------- resolve them
const byId = candidates.find((c) => c.id === WHO);
const exact = candidates.filter((c) => norm(c.name) === norm(WHO));
const hits = byId ? [byId] : (exact.length ? exact
  : candidates.filter((c) => norm(c.name).includes(norm(WHO)) || norm(WHO).includes(norm(c.name))));
if (hits.length !== 1) {
  console.error(`--who "${WHO}" matched ${hits.length} roster entries` +
    (hits.length ? `:\n  ${hits.map((h) => `${h.name}  ${h.id}${h.removed ? "  [removed]" : ""}`).join("\n  ")}` : "") +
    `\nRefusing to run — pass the exact c-<uuid> instead.`);
  process.exit(1);
}
const cand = hits[0];
if (cand.name === NEW_NAME) { console.log(`Already named "${NEW_NAME}". Nothing to do.`); process.exit(0); }

const oldKey = lastKey(cand.name), newKey = lastKey(NEW_NAME);
const attached = screening.filter((r) => r.candId === cand.id).length + scores.filter((s) => s.candId === cand.id).length;

console.log(`  ${cand.name}   ${cand.id}${cand.removed ? "  [removed]" : ""}`);
console.log(`→ ${NEW_NAME}\n`);
console.log(`Document id is unchanged, so ${attached} doc(s) of reviewer input stay attached — nothing to migrate.`);

// ----------------------------------------------------------- surname change
const plan = [{ what: `interviews_candidates/${cand.id}`, detail: `name: "${cand.name}" → "${NEW_NAME}"` }];
let availMove = null;

if (oldKey !== newKey) {
  console.log(`\nSurname key changes: "${oldKey}" → "${newKey}".`);
  // A namesake already using the new key would have their times overwritten.
  const clash = candidates.filter((c) => c.id !== cand.id && !c.removed && lastKey(c.name) === newKey);
  if (clash.length) {
    console.log(`\n⚠  "${newKey}" is ALSO the surname key of: ${clash.map((c) => c.name).join(", ")}`);
    console.log(`   Availability is keyed by surname alone, so after this rename they would share ONE`);
    console.log(`   document and whoever submits last would silently overwrite the other.`);
    if (!FORCE) { console.log(`\nRefusing to run. Re-run with --force if you accept that.`); process.exit(1); }
    console.log(`   --force given: proceeding anyway.`);
  }
  const from = availCand.find((a) => a.id === oldKey), to = availCand.find((a) => a.id === newKey);
  const picks = (a) => Object.keys((a && a.slots) || {}).length;
  if (picks(from)) {
    if (picks(to)) {
      console.log(`\n⚠  Both "${oldKey}" (${picks(from)} pick(s)) and "${newKey}" (${picks(to)} pick(s)) hold times.`);
      console.log(`   Not merging automatically — resolve by hand so nobody's answers are lost.`);
    } else {
      availMove = { from: oldKey, to: newKey, slots: from.slots };
      plan.push({ what: `interviews_availCand/${newKey}`, detail: `${picks(from)} time pick(s) moved from "${oldKey}" (which is then deleted)` });
    }
  } else {
    console.log(`   No availability stored under "${oldKey}" — nothing to move.`);
  }
} else {
  console.log(`\nSurname key "${oldKey}" is unchanged, so availability needs no move.`);
}

// The surname gate must move with the name, or the applicant is refused at the
// gate ("we can't find you") until an admin next opens the app and it self-heals.
const nextRoster = candidates.map((c) => (c.id === cand.id ? { ...c, name: NEW_NAME } : c));
const gate = await refreshAllowed(db, nextRoster, { apply: false });
if (gate.changed) console.log(`\n${describeAllowed(gate)}`);

console.log(`\n${plan.length} change(s)${APPLY ? "" : " — DRY RUN, nothing written"}:`);
for (const p of plan) console.log(`  ${p.what}\n          ${p.detail}`);
if (!APPLY) { console.log(`\nRe-run with --apply to perform the rename.`); process.exit(0); }

// ----------------------------------------------------------------- apply it
let failed = 0;
try {
  await updateDoc(doc(db, "interviews_candidates", cand.id), { name: NEW_NAME });
  console.log(`\nRenamed to "${NEW_NAME}".`);
} catch (e) { failed++; console.error(`FAILED rename: ${e.code || e.message}`); }

if (availMove && !failed) {
  try { // copy first, delete only once the copy landed
    await setDoc(doc(db, "interviews_availCand", availMove.to), { slots: availMove.slots }, { merge: true });
    await deleteDoc(doc(db, "interviews_availCand", availMove.from));
    console.log(`Availability moved "${availMove.from}" → "${availMove.to}".`);
  } catch (e) { failed++; console.error(`FAILED availability move: ${e.code || e.message}`); }
}

if (!failed) {
  try {
    const r = await refreshAllowed(db, nextRoster, { apply: true });
    if (r.changed) console.log(describeAllowed(r));
  } catch (e) { failed++; console.error(`FAILED updating the applicant surname list: ${e.code || e.message}`); }
}

if (!failed) console.log(`\nDone. Reviewer input was never touched — it was keyed to the id, which did not change.`);
process.exit(failed ? 1 : 0);
