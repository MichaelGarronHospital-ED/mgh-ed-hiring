#!/usr/bin/env node
// ============================================================================
//  diagnose-login.mjs: why won't a password sign in?
//
//  Since R7 there is one test, the same one the page makes: which role account
//  accepts the password? The page tries ED (committee@), Guest (applicant@) and
//  Leadership (admin@ed-hiring.app); this script tries all three and says which
//  accepted it, or why none did. With --voting it also tries Motion Voting's
//  two accounts (ed@ and leadership@ed-motion-voting.app), which Setup,
//  the ED tools passwords page (passwords.html) keeps on the same values.
//
//  READ ONLY. It reads no documents and writes nothing; it only attempts
//  sign-ins, with Firebase's REST sign-in call (nothing is kept). The web API
//  keys only answer requests from the live site, so each call says it comes
//  from there (the same Referer the browser sends); if a key still refuses,
//  the script says it can't test from here rather than "wrong password".
//  It never prints the password.
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

import { firebaseConfig, AUTH, PARTNERS } from "../js/config.js";

const REFERER = "https://michaelgarronhospital-ed.github.io/";
// -> "ok" | "refused" | "throttled" | "disabled" | "blocked" (the key won't
//    answer from here) | "network" | "other-account" | the error code
// uid: the role account's pinned uid (R7c: a role is its uid, never its email);
// an answer for another account is not that role.
async function trySignIn(apiKey, email, password, uid) {
  let res, body = {};
  try {
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "content-type": "application/json", Referer: REFERER },
      body: JSON.stringify({ email, password, returnSecureToken: false }), signal: AbortSignal.timeout(10000) });
    body = await res.json().catch(() => ({}));
  } catch { return "network"; }
  if (res.ok) return !uid || body.localId === uid ? "ok" : "other-account";
  const msg = String((body.error && body.error.message) || "");
  if (/^(INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND)/.test(msg)) return "refused";
  if (/^TOO_MANY_ATTEMPTS_TRY_LATER/.test(msg)) return "throttled";
  if (/^USER_DISABLED/.test(msg)) return "disabled";
  if (res.status === 403 || /REFERRER|API_KEY|PERMISSION_DENIED/.test(msg)) return "blocked";
  return msg || `HTTP ${res.status}`;
}

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

// each account under its old email and its new .invalid one (Phase A: they move)
const accounts = [
  ["ED", "hiring", AUTH.committeeEmail, AUTH.uids.committee, AUTH.newEmails.committee],
  ["Guest", "hiring", AUTH.candidateEmail, AUTH.uids.candidate, AUTH.newEmails.candidate],
  ["Leadership", "hiring", AUTH.adminEmail, AUTH.uids.admin, AUTH.newEmails.admin],
  ...(VOTING ? [["ED", "voting", PARTNERS.voting.edEmail, PARTNERS.voting.uids.ed, PARTNERS.voting.newEmails.ed],
    ["Leadership", "voting", PARTNERS.voting.leadershipEmail, PARTNERS.voting.uids.leadership, PARTNERS.voting.newEmails.leadership]] : []),
];
const configs = { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig };
const results = [];
const SAY = { ok: "accepted", refused: "refused (wrong password)", throttled: "Firebase is pausing tries from this computer",
  disabled: "the account is switched off", "other-account": "accepted, but by ANOTHER account than the role account (different uid): not this role", blocked: "can't test from here (the key refused this computer)", network: "couldn't reach Firebase" };
for (const [role, project, oldEmail, uid, newEmail] of accounts) {
  let email = oldEmail;
  let r = await trySignIn(configs[project].apiKey, email, PW, uid);
  if (r === "refused" && newEmail) { email = newEmail; r = await trySignIn(configs[project].apiKey, email, PW, uid); }
  results.push({ role, project, email, r });
  console.log(`  ${email}: ${SAY[r] || `no answer (${r})`}`);
  if (r === "throttled") {
    console.log("\n  STOP. Firebase has throttled this DEVICE, not the account, and every further");
    console.log("  attempt extends the block. Wait about 15 minutes, then run this once.");
    break;
  }
}

console.log(`\n${"-".repeat(64)}\nWhat it means`);
const hiring = results.filter((x) => x.project === "hiring" && x.r === "ok");
const codes = results.map((x) => String(x.r));
if (codes.some((c) => /OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(c))) {
  console.log("  Email/Password sign-in is OFF for this project. Nobody can sign in at all.");
  console.log("  Firebase console, Authentication, Sign-in method: enable Email/Password.");
} else if (codes.some((c) => c === "network")) {
  console.log("  Couldn't reach Firebase from here. Check the network and run it again.");
} else if (codes.every((c) => c === "blocked")) {
  console.log("  The keys wouldn't answer this computer, so nothing was tested. That says nothing about the");
  console.log("  password. Try it on the sign-in page itself instead.");
} else if (hiring.length) {
  const role = hiring[0].role;
  console.log(`  This is the ${role.toUpperCase()} password for Physician Hiring; the page signs in with it.`);
  if (role === "ED") console.log("  The ED password has no Panels, Ranking or Setup: those need the Leadership password.");
  console.log("  If a person still can't get in, the fault is on their side: their network blocks");
  console.log("  www.gstatic.com, or they are throttled from earlier tries (wait 15 minutes).");
  if (VOTING) {
    const v = results.filter((x) => x.project === "voting" && x.role === role);
    if (v.length && v[0].r === "refused") console.log(`  Motion Voting's ${role} account does NOT take it: the tools have drifted apart.\n  Fix it on the ED tools passwords page ("The tools already have different passwords").`);
  }
} else if (codes.some((c) => c === "blocked")) {
  console.log("  Some accounts couldn't be tested from here (the key refused this computer), and none of the");
  console.log("  others accepted it. Try it on the sign-in page itself.");
} else if (codes.some((c) => c === "disabled")) {
  console.log("  An account is disabled. Firebase console, Authentication, Users: enable it.");
} else {
  console.log("  No hiring account accepts this password. It is out of date or mistyped.");
  console.log("  If nobody knows the current one, see README, \"If a password stops working and nobody");
  console.log("  knows the new one\" (Firebase console, department account).");
}
console.log("\nRead-only: nothing was written.");
process.exit(0);
