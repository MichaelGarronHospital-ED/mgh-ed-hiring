#!/usr/bin/env node
// ============================================================================
//  diagnose-login.mjs: why won't a password sign in?
//
//  Since R7 there is one test, the same one the page makes: which role account
//  accepts the password? The page tries ED (committee@), Guest (applicant@) and
//  Leadership (admin@ed-hiring.app); this script tries all three and says which
//  accepted it, or why none did. With --voting it also tries Motion Voting's
//  two accounts (ed@ and leadership@ed-motion-voting.app), which Setup,
//  "Passwords for all ED tools" keeps on the same values.
//
//  READ ONLY. It reads no documents and writes nothing; it only attempts
//  sign-ins (each in its own memory-only Firebase app). It never prints the
//  password.
//
//  Usage:
//    ED_PASSWORD='...' node diagnose-login.mjs            # the three hiring accounts
//    ED_PASSWORD='...' node diagnose-login.mjs --voting   # and Motion Voting's two
//
//  The password goes in an ENV VAR, not an argument, so it stays out of shell
//  history and the process list. (ED_IV_CODE, the old name, still works.)
//
//  NOTE ON RETRIES: Firebase throttles by DEVICE after repeated failures
//  (auth/too-many-requests), and every attempt extends the block. If you see
//  that, stop, wait about 15 minutes, and run this ONCE.
// ============================================================================

import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, inMemoryPersistence, signInWithEmailAndPassword } from "firebase/auth";
import { firebaseConfig, AUTH, PARTNERS } from "../js/config.js";

const VOTING = process.argv.slice(2).includes("--voting");
const PW = process.env.ED_PASSWORD || process.env.ED_IV_CODE;
if (!PW) {
  console.error("ED_PASSWORD is not set.\nRun:  ED_PASSWORD='<the password to test>' node diagnose-login.mjs");
  process.exit(1);
}
if (PW !== PW.trim()) {
  console.log("Note: the password has a space at the start or end. The page trims it, so this");
  console.log("only matters if the account's password was SET with the spaces included.\n");
}
console.log(`Project: ${firebaseConfig.projectId}`);
console.log(`Password length: ${PW.length} characters` +
  (PW.length < 6 ? " (under 6: Firebase refuses to set a password this short, so no account can have it)" : ""));

const accounts = [
  ["ED", "hiring", AUTH.committeeEmail], ["Guest", "hiring", AUTH.candidateEmail], ["Leadership", "hiring", AUTH.adminEmail],
  ...(VOTING ? [["ED", "voting", PARTNERS.voting.edEmail], ["Leadership", "voting", PARTNERS.voting.leadershipEmail]] : []),
];
const configs = { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig };
const results = [];
let n = 0;
for (const [role, project, email] of accounts) {
  const app = initializeApp(configs[project], `diag-${n++}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  let r;
  try { await signInWithEmailAndPassword(auth, email, PW); r = "ok"; }
  catch (e) { r = (e && e.code) || String(e); }
  try { await deleteApp(app); } catch { /* gone */ }
  results.push({ role, project, email, r });
  console.log(`  ${email}: ${r === "ok" ? "accepted" : `refused (${r})`}`);
  if (String(r).includes("too-many-requests")) {
    console.log("\n  STOP. Firebase has throttled this DEVICE, not the account, and every further");
    console.log("  attempt extends the block. Wait about 15 minutes, then run this once.");
    break;
  }
}

console.log(`\n${"-".repeat(64)}\nWhat it means`);
const hiring = results.filter((x) => x.project === "hiring" && x.r === "ok");
const codes = results.map((x) => String(x.r));
if (codes.some((c) => c.includes("operation-not-allowed"))) {
  console.log("  Email/Password sign-in is OFF for this project. Nobody can sign in at all.");
  console.log("  Firebase console, Authentication, Sign-in method: enable Email/Password.");
} else if (codes.some((c) => c.includes("network"))) {
  console.log("  Couldn't reach Firebase from here. Check the network and run it again.");
} else if (hiring.length) {
  const role = hiring[0].role;
  console.log(`  This is the ${role.toUpperCase()} password for Physician Hiring; the page signs in with it.`);
  if (role === "ED") console.log("  The ED password has no Panels, Ranking or Setup: those need the Leadership password.");
  console.log("  If a person still can't get in, the fault is on their side: their network blocks");
  console.log("  www.gstatic.com, or they are throttled from earlier tries (wait 15 minutes).");
  if (VOTING) {
    const v = results.filter((x) => x.project === "voting" && x.role === role);
    if (v.length && v[0].r !== "ok") console.log(`  Motion Voting's ${role} account does NOT take it: the tools have drifted apart.\n  Fix it in Physician Hiring, Setup, Passwords ("The tools already have different passwords").`);
  }
} else if (codes.some((c) => c.includes("user-disabled"))) {
  console.log("  An account is disabled. Firebase console, Authentication, Users: enable it.");
} else {
  console.log("  No hiring account accepts this password. It is out of date or mistyped.");
  console.log("  If nobody knows the current one, see README, \"If a password stops working and nobody");
  console.log("  knows the new one\" (Firebase console, department account).");
}
console.log("\nRead-only: nothing was written.");
process.exit(0);
