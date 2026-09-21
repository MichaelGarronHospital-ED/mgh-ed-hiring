#!/usr/bin/env node
// ============================================================================
//  migrate-candidate.mjs — move a candidate's committee input from one roster
//  entry to another.
//
//  Why this exists: the app has no rename. Fixing a misspelled applicant means
//  removing them and adding them again, which mints a NEW c-<uuid>. Everything
//  reviewers had already entered stays keyed to the OLD id and vanishes from
//  the UI — the old entry is only soft-deleted (removed:true), so it isn't even
//  detectable as an orphan.
//
//  Moves all four places a candidate is referenced:
//    interviews_screening   <member>~<candId>   flags / ratings / reasons
//    interviews_scores      <member>~<candId>   overall + per-question notes
//    interviews_availCand   <lastname>          the times the applicant picked
//    interviews_meta/config panelOverrides[id]  a manually built panel
//
//  DRY RUN BY DEFAULT. Nothing is written without --apply. There is no undo.
//
//  Usage:
//    ED_IV_ADMIN_PASSWORD='…' node migrate-candidate.mjs --from "Rosalind Ashcombe" --to "Rosalind Ashcomb"
//    ED_IV_ADMIN_PASSWORD='…' node migrate-candidate.mjs --from "…" --to "…" --apply
//
//  Flags:
//    --from "<name|id>"  the OLD entry to move input off (usually the removed one)
//    --to   "<name|id>"  the NEW entry to move it onto
//    --apply             perform the writes
//    --overwrite         replace input already present on the target. Default is
//                        to SKIP those and report them, so re-screening done
//                        under the new entry is never clobbered.
//    --keep-source       copy without deleting the old docs (leaves duplicates
//                        that only this script can see; useful for a dress run)
// ============================================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, deleteDoc, updateDoc,
         connectFirestoreEmulator } from "firebase/firestore";
import { firebaseConfig, AUTH } from "../js/config.js";

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has("--apply"), OVERWRITE = has("--overwrite"), KEEP_SOURCE = has("--keep-source");
const FROM = val("--from"), TO = val("--to");

if (!FROM || !TO) {
  console.error('Usage: node migrate-candidate.mjs --from "Old Name" --to "New Name" [--apply]');
  process.exit(1);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Must match the app's key exactly (app.js lastKey) or availability won't line up.
const lastKey = (name) => String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

const PASSWORD = process.env.ED_IV_ADMIN_PASSWORD;
if (!PASSWORD && !process.env.ED_IV_EMULATOR) {
  console.error("ED_IV_ADMIN_PASSWORD is not set.");
  process.exit(1);
}

// ------------------------------------------------------------------ connect
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

// --------------------------------------------------------- resolve the pair
// Exact id wins; otherwise a name match that must be unambiguous. Picking the
// wrong candidate here would move real reviewer input onto the wrong person.
function resolve(spec, what) {
  const byId = candidates.find((c) => c.id === spec);
  if (byId) return byId;
  const hits = candidates.filter((c) => norm(c.name) === norm(spec));
  const loose = hits.length ? hits
    : candidates.filter((c) => norm(c.name).includes(norm(spec)) || norm(spec).includes(norm(c.name)));
  if (loose.length !== 1) {
    console.error(`--${what} "${spec}" matched ${loose.length} roster entries` +
      (loose.length ? `:\n  ${loose.map((h) => `${h.name}  ${h.id}${h.removed ? "  [removed]" : ""}`).join("\n  ")}` : "") +
      `\nRefusing to run — pass the exact c-<uuid> instead.`);
    process.exit(1);
  }
  return loose[0];
}
const src = resolve(FROM, "from"), dst = resolve(TO, "to");
if (src.id === dst.id) { console.error("--from and --to are the same roster entry. Nothing to do."); process.exit(1); }

console.log(`FROM  ${src.name}  ${src.id}${src.removed ? "  [removed]" : ""}`);
console.log(`TO    ${dst.name}  ${dst.id}${dst.removed ? "  [removed]" : ""}`);
if (!src.removed) console.log("\nNote: the source entry is NOT marked removed — check you have these the right way round.");
if (dst.removed) console.log("\nNote: the TARGET is marked removed; input moved onto it stays hidden until you restore them.");

// ------------------------------------------------------------------ plan it
const plan = [], skipped = [];
const isEmptyScreening = (r) => !r || (!r.flag && !r.rating && !String(r.reason || "").trim());
const isEmptyScore = (s) => !s || (!s.overall && !Object.values(s.notes || {}).some((v) => String(v || "").trim()));

function planMove(coll, rows, isEmpty, describe) {
  for (const row of rows.filter((r) => r.candId === src.id)) {
    const targetId = `${row.member}~${dst.id}`;
    const existing = rows.find((r) => r.id === targetId);
    const { id, ...data } = row;
    if (existing && !isEmpty(existing) && !OVERWRITE) {
      skipped.push(`${coll}/${targetId} — ${row.member} already has input on ${dst.name} (${describe(existing)}); ` +
        `source says ${describe(row)}`);
      continue;
    }
    plan.push({ coll, write: targetId, data: { ...data, candId: dst.id }, del: KEEP_SOURCE ? null : id,
      detail: `${row.member}: ${describe(row)}` + (existing ? "  (replacing an empty doc)" : "") });
  }
}

planMove("interviews_screening", screening, isEmptyScreening, (r) =>
  [r.flag ? "FLAGGED" : null, r.rating ? `rating ${r.rating}` : null,
   String(r.reason || "").trim() ? `reason "${r.reason}"` : null].filter(Boolean).join(" · ") || "empty");
planMove("interviews_scores", scores, isEmptyScore, (s) =>
  `overall ${s.overall || "–"}, ${Object.values(s.notes || {}).filter((v) => String(v || "").trim()).length} note(s)`);

// Availability is keyed by last name, so it only needs moving when the surname
// actually changed (Young → Yung). Same surname = same doc = already correct.
const srcKey = lastKey(src.name), dstKey = lastKey(dst.name);
if (srcKey !== dstKey) {
  const from = availCand.find((a) => a.id === srcKey), to = availCand.find((a) => a.id === dstKey);
  const picks = (a) => Object.keys((a && a.slots) || {}).length;
  if (from && picks(from)) {
    if (to && picks(to) && !OVERWRITE)
      skipped.push(`interviews_availCand/${dstKey} — already has ${picks(to)} pick(s); source "${srcKey}" has ${picks(from)}`);
    else
      plan.push({ coll: "interviews_availCand", write: dstKey, data: { slots: from.slots },
        del: KEEP_SOURCE ? null : srcKey, detail: `${picks(from)} time pick(s) moved from "${srcKey}" to "${dstKey}"` });
  } else {
    console.log(`\nNo availability stored under "${srcKey}" — nothing to move there.`);
  }
}

// ---------------------------------------------------------------- report it
console.log(`\n${plan.length} move(s)${APPLY ? "" : " — DRY RUN, nothing written"}:`);
for (const p of plan)
  console.log(`  ${p.coll}/${p.write}${p.del ? `   (removing ${p.coll}/${p.del})` : ""}\n          ${p.detail}`);
if (!plan.length) console.log("  (none)");

if (skipped.length) {
  console.log(`\n${skipped.length} SKIPPED — the target already has real input, so nothing was moved onto it:`);
  for (const s of skipped) console.log(`  ${s}`);
  console.log("  Resolve these by hand, or re-run with --overwrite to let the source win.");
}

if (overrides[src.id])
  console.log(`\npanelOverrides: the old entry has a manually built panel; it will be moved to the new id.` +
    (overrides[dst.id] ? " The new id ALREADY has one — it will be kept, and the old one dropped." : ""));

if (!plan.length && !overrides[src.id]) { console.log("\nNothing to do."); process.exit(0); }
if (!APPLY) { console.log("\nRe-run with --apply to perform these moves. There is no undo."); process.exit(0); }

// ----------------------------------------------------------------- apply it
// Write the copy FIRST and only delete the source once the copy succeeded, so a
// failure mid-run can never lose input — at worst it leaves a duplicate.
let ok = 0, failed = 0;
for (const p of plan) {
  try {
    await setDoc(doc(db, p.coll, p.write), p.data, { merge: true });
    if (p.del) await deleteDoc(doc(db, p.coll, p.del));
    ok++;
  } catch (e) { failed++; console.error(`  FAILED ${p.coll}/${p.write}: ${e.code || e.message}`); }
}

if (overrides[src.id]) {
  try {
    const next = { ...overrides };
    if (!next[dst.id]) next[dst.id] = next[src.id];
    delete next[src.id];
    await updateDoc(doc(db, "interviews_meta", "config"), { panelOverrides: next });
    ok++;
  } catch (e) { failed++; console.error(`  FAILED panelOverrides: ${e.code || e.message}`); }
}

console.log(`\nDone: ${ok} applied, ${failed} failed.`);
console.log(`The old entry "${src.name}" is still on the roster (removed). Delete it in the app only after you've ` +
  `confirmed the ratings show up under "${dst.name}".`);
process.exit(failed ? 1 : 0);
