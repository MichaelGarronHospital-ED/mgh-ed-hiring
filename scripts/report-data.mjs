#!/usr/bin/env node
// ============================================================================
//  report-data.mjs — read-only inventory of everything stored for the hiring
//  round, grouped by candidate.
//
//  READ ONLY. This script has no write path at all: it opens no write handle,
//  and the only Firestore verbs it imports are getDocs/getDoc. Run it freely.
//
//  Shows, per candidate: each reviewer's screening flag/rating/reason, each
//  reviewer's overall score and per-question notes, availability, and whether
//  a manual panel exists. Entries the app has soft-removed are tagged
//  [removed] — they still render on the Screen tab until purged.
//
//  Usage:
//    ED_IV_ADMIN_PASSWORD='…' node report-data.mjs
//    ED_IV_ADMIN_PASSWORD='…' node report-data.mjs --issues
//
//  Flags:
//    --issues   only the things that need attention: stale entries, duplicate
//               surnames, availability that matches no candidate, empty docs.
//
//  Admin is required: firestore.rules lets only admin@ed-hiring.app READ
//  screening and scores (that is what keeps the ranking private from
//  reviewers), so the committee code will not work here.
// ============================================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, getDoc, connectFirestoreEmulator } from "firebase/firestore";
import { firebaseConfig, AUTH } from "../js/config.js";

const argv = process.argv.slice(2);
const ISSUES_ONLY = argv.includes("--issues");

// Must match the app's key exactly (app.js lastKey) or availability won't line up.
const lastKey = (name) => String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

const PASSWORD = process.env.ED_IV_ADMIN_PASSWORD;
if (!PASSWORD && !process.env.ED_IV_EMULATOR) {
  console.error("ED_IV_ADMIN_PASSWORD is not set.\n" +
    "Run:  ED_IV_ADMIN_PASSWORD='<the admin code>' node report-data.mjs");
  process.exit(1);
}

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
  catch (e) { console.error(`Sign-in failed (${e.code || e.message}). Check the admin password.`); process.exit(1); }
}
console.log(`Project: ${firebaseConfig.projectId}`);

const readAll = async (name) =>
  (await getDocs(collection(db, name))).docs.map((d) => ({ id: d.id, ...d.data() }));
const [candidates, screening, scores, availCand] = await Promise.all([
  readAll("interviews_candidates"), readAll("interviews_screening"),
  readAll("interviews_scores"), readAll("interviews_availCand"),
]);
const cfgSnap = await getDoc(doc(db, "interviews_meta", "config"));
const overrides = (cfgSnap.exists() ? cfgSnap.data().panelOverrides : null) || {};

const nameById = new Map(candidates.map((c) => [c.id, c.name]));
const removedById = new Map(candidates.map((c) => [c.id, !!c.removed]));
const label = (id) => !nameById.has(id) ? `⚠ ORPHAN (${id})`
  : nameById.get(id) + (removedById.get(id) ? " [removed]" : "");

const screenBits = (r) =>
  [r.flag ? "FLAGGED" : null, r.rating ? `rating ${r.rating}` : null,
   String(r.reason || "").trim() ? `reason: "${r.reason}"` : null].filter(Boolean).join(" · ") || "(empty doc)";
const noteEntries = (s) => Object.entries(s.notes || {}).filter(([, v]) => String(v || "").trim());

// ------------------------------------------------------------ per candidate
if (!ISSUES_ONLY) {
  const byCand = new Map();
  const bucket = (id) => { if (!byCand.has(id)) byCand.set(id, { scr: [], sc: [] }); return byCand.get(id); };
  for (const r of screening) bucket(r.candId).scr.push(r);
  for (const s of scores) bucket(s.candId).sc.push(s);

  const order = [...candidates].sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.id)
    .concat([...byCand.keys()].filter((id) => !nameById.has(id)));

  for (const id of order) {
    const b = byCand.get(id) || { scr: [], sc: [] };
    const av = availCand.find((a) => a.id === lastKey(nameById.get(id) || ""));
    const picks = Object.keys((av && av.slots) || {}).length;
    console.log(`\n${label(id)}`);
    if (!b.scr.length && !b.sc.length && !picks) { console.log("  (no input)"); continue; }
    for (const r of b.scr.sort((x, y) => String(x.member).localeCompare(String(y.member))))
      console.log(`  screening  ${String(r.member).padEnd(14)} ${screenBits(r)}`);
    for (const s of b.sc.sort((x, y) => String(x.member).localeCompare(String(y.member)))) {
      console.log(`  score      ${String(s.member).padEnd(14)} overall ${s.overall || "–"} · ${noteEntries(s).length} note(s)`);
      for (const [qi, text] of noteEntries(s)) console.log(`                 q${qi}: ${text}`);
    }
    if (picks) console.log(`  availability  ${picks} time(s) picked`);
    if (overrides[id]) console.log(`  panel      manually built`);
  }
}

// ----------------------------------------------------------------- issues
// The checks worth acting on. Every one of these has bitten this round.
const issues = [];

for (const c of candidates.filter((c) => c.removed)) {
  const refs = screening.filter((r) => r.candId === c.id).length + scores.filter((s) => s.candId === c.id).length;
  issues.push(refs
    ? `"${c.name}" is removed but still holds ${refs} doc(s) of reviewer input — migrate it: ` +
      `node migrate-candidate.mjs --from "${c.id}" --to "<the entry you're keeping>"`
    : `"${c.name}" is removed and empty — it still shows on the Screen tab. Purge it: ` +
      `node purge-candidate.mjs --name "${c.id}"`);
}

// Availability is keyed by surname, so namesakes overwrite each other. This is
// the failure that loses an applicant's times without anyone noticing.
const bySurname = new Map();
for (const c of candidates.filter((c) => !c.removed)) {
  const k = lastKey(c.name);
  if (!bySurname.has(k)) bySurname.set(k, []);
  bySurname.get(k).push(c.name);
}
for (const [k, names] of bySurname)
  if (names.length > 1)
    issues.push(`Duplicate surname "${k}": ${names.join(", ")} — they SHARE one availability doc, ` +
      `so whoever submits last overwrites the other. Disambiguate before sending the applicant link.`);

// Availability submitted under a name nobody on the roster matches: the exact
// silent-loss case — the applicant saw "Saved" and nobody will ever read it.
const liveKeys = new Set([...bySurname.keys()]);
const allKeys = new Set(candidates.map((c) => lastKey(c.name)));
for (const a of availCand) {
  const picks = Object.keys(a.slots || {}).length;
  // A document with NO times is still evidence: it is only created when someone
  // typed that surname at the applicant gate and was let through. So it means
  // "they showed up and nothing is recorded", which is not the same fact as an
  // applicant who never opened the link — and it is the fingerprint the
  // checkName wipe left behind (store.js: the probe used to send `{slots:{}}`,
  // which replaced the map on every return visit). Chase these by hand; the
  // data cannot say whether they picked times and lost them or picked none.
  if (!picks) {
    if (liveKeys.has(a.id))
      issues.push(`"${a.id}" reached the applicant page but has NO times saved — they got past the ` +
        `name check, so they did open the link. Ask them directly rather than assuming no reply.`);
    continue;
  }
  if (!allKeys.has(a.id))
    issues.push(`Availability under "${a.id}" (${picks} time(s)) matches NO candidate — ` +
      `someone submitted under a name that isn't on the roster, and nobody is reading it.`);
  else if (!liveKeys.has(a.id))
    issues.push(`Availability under "${a.id}" (${picks} time(s)) belongs only to a REMOVED candidate.`);
}

for (const id of Object.keys(overrides))
  if (!nameById.has(id)) issues.push(`panelOverrides has an entry for ${id}, which is not on the roster.`);

const emptyScr = screening.filter((r) => !r.flag && !r.rating && !String(r.reason || "").trim()).length;

console.log(`\n${"─".repeat(60)}`);
console.log(`${candidates.length} candidates (${candidates.filter((c) => c.removed).length} removed) · ` +
  `${screening.length} screening docs (${emptyScr} empty) · ${scores.length} score docs · ` +
  `${availCand.length} availability docs`);

if (issues.length) {
  console.log(`\n${issues.length} issue(s) to look at:`);
  for (const i of issues) console.log(`  • ${i}`);
} else {
  console.log(`\nNo issues found.`);
}
console.log(`\nRead-only — nothing was written.`);
// The Firestore client keeps a connection open, which would hold the process
// open for ~60s after the report is printed. Nothing is pending, so just exit.
process.exit(0);
