#!/usr/bin/env node
// ============================================================================
//  purge-candidate.mjs — permanently delete a candidate from the roster.
//
//  The app's "remove" is a SOFT delete: removeCand sets removed:true and the
//  entry keeps rendering on the Screen tab with a "removed" pill and a restore
//  link. That's the right default — it's reversible. This is for the case where
//  an entry should never have existed at all (a misspelling that was re-added
//  correctly, a duplicate), and you want it gone from the tab.
//
//  REFUSES to delete a candidate that anything still references — screening,
//  scores, availability or a manual panel. Run migrate-candidate.mjs first to
//  move real reviewer input onto the entry you're keeping. This is the guard
//  that stops a purge from silently destroying ratings.
//
//  DRY RUN BY DEFAULT. Nothing is written without --apply. There is no undo.
//
//  Usage:
//    ED_IV_ADMIN_PASSWORD='…' node purge-candidate.mjs --name "Dr Rosalind Ashcombe"
//    ED_IV_ADMIN_PASSWORD='…' node purge-candidate.mjs --name "…" --apply
// ============================================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, getDoc, deleteDoc, connectFirestoreEmulator } from "firebase/firestore";
import { firebaseConfig, AUTH } from "../js/config.js";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const NAME = val("--name");

if (!NAME) {
  console.error('Usage: node purge-candidate.mjs --name "Dr Jane Doe" [--apply]');
  process.exit(1);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const lastKey = (name) => String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

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
const cfgSnap = await getDoc(doc(db, "interviews_meta", "config"));
const overrides = (cfgSnap.exists() ? cfgSnap.data().panelOverrides : null) || {};

// ------------------------------------------------------------ resolve, once
const byId = candidates.find((c) => c.id === NAME);
const exact = candidates.filter((c) => norm(c.name) === norm(NAME));
const hits = byId ? [byId] : (exact.length ? exact
  : candidates.filter((c) => norm(c.name).includes(norm(NAME)) || norm(NAME).includes(norm(c.name))));

if (hits.length !== 1) {
  console.error(`"${NAME}" matched ${hits.length} roster entries` +
    (hits.length ? `:\n  ${hits.map((h) => `${h.name}  ${h.id}${h.removed ? "  [removed]" : ""}`).join("\n  ")}` : "") +
    `\nRefusing to run — pass the exact c-<uuid> instead.`);
  process.exit(1);
}
const cand = hits[0];
console.log(`Candidate: ${cand.name}  ${cand.id}${cand.removed ? "  [removed]" : ""}`);

// --------------------------------------------------- refuse if anything refs
const refs = [];
for (const r of screening.filter((r) => r.candId === cand.id))
  refs.push(`interviews_screening/${r.id} — ${r.member}: ` +
    [r.flag ? "FLAGGED" : null, r.rating ? `rating ${r.rating}` : null,
     String(r.reason || "").trim() ? `reason "${r.reason}"` : null].filter(Boolean).join(" · ") || "empty");
for (const s of scores.filter((s) => s.candId === cand.id))
  refs.push(`interviews_scores/${s.id} — ${s.member}: overall ${s.overall || "–"}, ` +
    `${Object.values(s.notes || {}).filter((v) => String(v || "").trim()).length} note(s)`);
const av = availCand.find((a) => a.id === lastKey(cand.name));
if (av && Object.keys(av.slots || {}).length)
  refs.push(`interviews_availCand/${av.id} — ${Object.keys(av.slots).length} time pick(s)`);
if (overrides[cand.id]) refs.push(`interviews_meta/config panelOverrides[${cand.id}] — a manually built panel`);

if (refs.length) {
  console.error(`\nREFUSING TO PURGE — ${refs.length} thing(s) still reference this candidate:`);
  for (const r of refs) console.error(`  ${r}`);
  console.error(`\nDeleting the roster entry would strand these permanently. Move them first:\n` +
    `  node migrate-candidate.mjs --from "${cand.id}" --to "<the entry you're keeping>"`);
  process.exit(1);
}

// Availability is keyed by surname, so a namesake would share the doc. Say so
// rather than implying this candidate had picked no times.
const shared = candidates.filter((c) => c.id !== cand.id && lastKey(c.name) === lastKey(cand.name));
if (shared.length && av)
  console.log(`Note: availability under "${av.id}" is shared with ${shared.map((c) => c.name).join(", ")} — left alone.`);

console.log(`\nNothing references this entry. It is safe to delete.`);
console.log(`\n1 deletion${APPLY ? "" : " — DRY RUN, nothing written"}:`);
console.log(`  DELETE  interviews_candidates/${cand.id}  (${cand.name})`);

if (!APPLY) { console.log(`\nRe-run with --apply to delete. There is no undo.`); process.exit(0); }

try {
  await deleteDoc(doc(db, "interviews_candidates", cand.id));
  console.log(`\nDeleted. "${cand.name}" is gone from the Screen tab.`);
} catch (e) {
  console.error(`\nFAILED: ${e.code || e.message}`);
  process.exit(1);
}
