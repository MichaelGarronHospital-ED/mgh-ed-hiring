#!/usr/bin/env node
// ============================================================================
//  sync-allowed.mjs — publish the roster's surname keys to
//  /interviews_meta/allowed, which firestore.rules checks on every applicant
//  availability write.
//
//  ROLLOUT ORDER MATTERS. The rule is fail-closed: with that document missing,
//  every applicant write is refused. So:
//     1. run this (against the CURRENT rules — this is an admin write, which
//        the old rules already allow)
//     2. publish the new firestore.rules
//     3. deploy the app
//  Doing 2 before 1 locks applicants out until you catch up.
//
//  After rollout the admin session keeps this in sync by itself
//  (app.js syncAllowedNames), so this script is for the initial publish and for
//  checking afterwards. --check exits non-zero if the list has drifted, which
//  makes it usable as a pre-interview sanity check.
//
//  Usage:
//    ED_IV_ADMIN_PASSWORD='…' node sync-allowed.mjs            # dry run
//    ED_IV_ADMIN_PASSWORD='…' node sync-allowed.mjs --apply
//    ED_IV_ADMIN_PASSWORD='…' node sync-allowed.mjs --check    # CI-style check
// ============================================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, connectFirestoreEmulator } from "firebase/firestore";
import { firebaseConfig, AUTH } from "../js/config.js";
import { lastKey } from "./allowed-list.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply"), CHECK = argv.includes("--check");

const PASSWORD = process.env.ED_IV_ADMIN_PASSWORD;
if (!PASSWORD && !process.env.ED_IV_EMULATOR) { console.error("ED_IV_ADMIN_PASSWORD is not set."); process.exit(1); }

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
if (process.env.ED_IV_EMULATOR) {
  const [host, port] = process.env.ED_IV_EMULATOR.split(":");
  connectFirestoreEmulator(db, host, Number(port));
  if (process.env.ED_IV_AUTH_EMULATOR) connectAuthEmulator(auth, `http://${process.env.ED_IV_AUTH_EMULATOR}`, { disableWarnings: true });
  console.log(`*** EMULATOR MODE (${process.env.ED_IV_EMULATOR}) ***`);
} else {
  try { await signInWithEmailAndPassword(auth, AUTH.adminEmail, PASSWORD); }
  catch (e) { console.error(`Sign-in failed (${e.code || e.message}).`); process.exit(1); }
}

const candidates = (await getDocs(collection(db, "interviews_candidates"))).docs.map((d) => ({ id: d.id, ...d.data() }));
const live = candidates.filter((c) => !c.removed);
const want = [...new Set(live.map((c) => lastKey(c.name)).filter(Boolean))].sort();

const snap = await getDoc(doc(db, "interviews_meta", "allowed"));
const have = snap.exists() && Array.isArray(snap.data().keys) ? [...snap.data().keys].sort() : null;

console.log(`\nRoster: ${live.length} active candidate(s) → ${want.length} distinct surname key(s)`);

// Two candidates sharing a surname share ONE availability document, so the
// second to submit overwrites the first. The allowed list cannot express that;
// it has to be caught by a human.
const counts = new Map();
for (const c of live) { const k = lastKey(c.name); counts.set(k, [...(counts.get(k) || []), c.name]); }
const dupes = [...counts].filter(([, n]) => n.length > 1);
if (dupes.length) {
  console.log(`\n⚠  Duplicate surname key(s) — these applicants SHARE one availability document:`);
  for (const [k, names] of dupes) console.log(`     "${k}": ${names.join(", ")}`);
  console.log(`   Whoever submits last overwrites the other. Fix before sending the applicant link.`);
}

if (have === null) {
  console.log(`\nNo /interviews_meta/allowed document exists yet.`);
  console.log(`Until it does, the new rules refuse EVERY applicant availability write.`);
} else {
  const added = want.filter((k) => !have.includes(k));
  const gone = have.filter((k) => !want.includes(k));
  if (!added.length && !gone.length) {
    console.log(`\nAllowed list is already in sync (${have.length} key(s)). Nothing to do.`);
    process.exit(0);
  }
  if (added.length) console.log(`\n  + ${added.join(", ")}   (can now submit)`);
  if (gone.length) console.log(`  − ${gone.join(", ")}   (can no longer submit)`);
}

if (CHECK) {
  console.error(`\nOUT OF SYNC — re-run with --apply.`);
  process.exit(1);
}
if (!APPLY) {
  console.log(`\nWould publish ${want.length} key(s). Re-run with --apply. (DRY RUN — nothing written)`);
  process.exit(0);
}

await setDoc(doc(db, "interviews_meta", "allowed"), { keys: want }, { mergeFields: ["keys"] });
console.log(`\nPublished ${want.length} surname key(s) to /interviews_meta/allowed.`);
process.exit(0);
