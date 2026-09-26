#!/usr/bin/env node
// ============================================================================
//  diagnose-login.mjs — why won't a code sign in?
//
//  A code has to clear TWO independent hurdles, and the app cannot tell you
//  which one it failed:
//
//    1. It must DECRYPT the questions (js/data.js). This is what decides
//       whether you are staff or admin. Nothing else unwraps the content key,
//       so decrypting is proof the code is genuine.
//    2. It must be the PASSWORD of the matching Firebase account
//       (admin@ / committee@ / applicant@ed-hiring.app). That password lives
//       only in the Firebase console — it is not derived from the code and
//       nothing keeps the two in step.
//
//  Clear 1 and fail 2 and the app used to say "Incorrect code.", sending the
//  one person holding a correct code away to retype it. This script tells the
//  two apart in one run.
//
//  READ ONLY. It reads no documents and writes nothing; it only attempts
//  sign-ins. It never prints the code.
//
//  Usage:
//    ED_IV_CODE='…' node diagnose-login.mjs            # decrypt + sign-in
//    ED_IV_CODE='…' node diagnose-login.mjs --offline   # decrypt check only
//    ED_IV_CODE='…' node diagnose-login.mjs --all       # try all three accounts
//
//  The code goes in an ENV VAR, not an argument, so it stays out of shell
//  history and the process list.
//
//  NOTE ON RETRIES: Firebase throttles by DEVICE after repeated failures
//  (auth/too-many-requests), and every attempt extends the block. If you see
//  that, stop, wait ~15 minutes, and run this ONCE.
// ============================================================================

// js/data.js is browser code: it reaches for `window.crypto.subtle`. Node has
// the same WebCrypto at globalThis.crypto, so lend it a window.
if (!globalThis.window) globalThis.window = { crypto: globalThis.crypto };

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { firebaseConfig, AUTH } from "../js/config.js";
import { decryptContent } from "../js/data.js";

const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const ALL = argv.includes("--all");

const CODE = process.env.ED_IV_CODE;
if (!CODE) {
  console.error("ED_IV_CODE is not set.\n" +
    "Run:  ED_IV_CODE='<the code to test>' node diagnose-login.mjs");
  process.exit(1);
}
if (CODE !== CODE.trim()) {
  console.log("⚠  The code has leading or trailing whitespace. The app trims it, so this is");
  console.log("   only a problem if the Firebase password was SET with the spaces included.\n");
}

const ok = (s) => `  ✓ ${s}`;
const no = (s) => `  ✗ ${s}`;

console.log(`Project: ${firebaseConfig.projectId}`);
console.log(`Auth mode: ${AUTH.mode}`);
console.log(`Code length: ${CODE.length} characters` +
  (CODE.length < 6 ? "  ⚠ under 6 — Firebase REFUSES to set a password this short, so the" +
                     "\n                     account password CANNOT equal this code." : ""));

// ------------------------------------------------- 1. does it decrypt?
console.log(`\n1. Does the code decrypt the questions? (js/data.js)`);
let decrypted = null;
try { decrypted = await decryptContent(CODE); } catch { /* not a staff/admin code */ }

let expectRole = null;
if (decrypted) {
  expectRole = decrypted.isAdmin ? "admin" : "committee";
  console.log(ok(`yes — this is the ${decrypted.isAdmin ? "ADMIN" : "STAFF"} code.`));
  console.log(`     (${decrypted.q.length} questions, ${decrypted.s.length} rating levels)`);
  if (!decrypted.isAdmin)
    console.log(`\n  →  If someone expected the leadership view, THIS IS THE ANSWER: the staff code\n` +
                `     signs in fine but has no Panels, Ranking or Setup. They need the admin code.`);
} else {
  console.log(no(`no — it unwraps neither the staff nor the admin key.`));
  console.log(`     It is therefore the APPLICANT code, an out-of-date code, or simply wrong.`);
  console.log(`     If it should be an admin code, the admin wrap in js/data.js was re-keyed`);
  console.log(`     without this code (README → "Re-keying").`);
  expectRole = "candidate";
}

// ------------------------------------------------- 2. does Firebase accept it?
if (OFFLINE) {
  console.log(`\n2. Firebase sign-in — skipped (--offline).`);
  process.exit(0);
}

const EMAILS = { admin: AUTH.adminEmail, committee: AUTH.committeeEmail, candidate: AUTH.candidateEmail };
const roles = ALL ? ["admin", "committee", "candidate"] : [expectRole];

console.log(`\n2. Does Firebase accept it as the password for ${roles.length > 1 ? "each account" : EMAILS[expectRole]}?`);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const results = {};

for (const role of roles) {
  const email = EMAILS[role];
  try {
    await signInWithEmailAndPassword(auth, email, CODE);
    results[role] = "ok";
    console.log(ok(`${email} — accepted.`));
  } catch (e) {
    const code = (e && e.code) || String(e);
    results[role] = code;
    console.log(no(`${email} — rejected (${code})`));
    if (code.includes("too-many-requests")) {
      console.log(`\n     STOP. Firebase has throttled this DEVICE, not the account, and every`);
      console.log(`     further attempt extends the block. Wait ~15 minutes, then run this once.`);
      break;
    }
  }
}

// ------------------------------------------------------------- verdict
console.log(`\n${"─".repeat(64)}\nWhat to do`);
const r = results[expectRole];

if (!decrypted && r === "ok") {
  console.log(`  This is the applicant code and it works. It is not an admin code and never`);
  console.log(`  will be — admins need the separate admin code.`);
} else if (!decrypted) {
  console.log(`  The code decrypts nothing AND no account accepts it. It is simply not a`);
  console.log(`  current code for this deployment. Get the current one, or re-key js/data.js.`);
} else if (r === "ok") {
  console.log(`  Both halves pass. This code signs in as ${expectRole.toUpperCase()} and the app should`);
  console.log(`  let it in. If a person still can't get in, the fault is on their side:`);
  console.log(`    • they are on http:// or a saved copy of the page (WebCrypto needs https)`);
  console.log(`    • their network blocks www.gstatic.com, so the Firebase SDK never loads`);
  console.log(`    • they are throttled from earlier retries (wait 15 minutes)`);
  console.log(`    • they typed the STAFF code and expected the leadership view`);
} else if (String(r).includes("operation-not-allowed")) {
  console.log(`  Email/Password sign-in is OFF for this project. Nobody can sign in at all.`);
  console.log(`  Firebase console → Authentication → Sign-in method → enable Email/Password.`);
} else if (String(r).includes("too-many-requests")) {
  console.log(`  Throttled. Wait ~15 minutes without attempting, then run this once.`);
} else if (String(r).includes("user-disabled")) {
  console.log(`  The ${EMAILS[expectRole]} account is disabled. Re-enable it in the console.`);
} else {
  console.log(`  THIS IS THE FAULT, and it is not the code.`);
  console.log(`  The code is a valid ${expectRole.toUpperCase()} code — it decrypted the questions, which`);
  console.log(`  nothing else can do — but ${EMAILS[expectRole]} rejected it.`);
  console.log(`  So that account either does not exist, or its password is something else.`);
  console.log(``);
  console.log(`  Fix: Firebase console → Authentication → Users`);
  console.log(`       • no ${EMAILS[expectRole]} row? Add user, email above, password = this code.`);
  console.log(`       • row exists? ⋮ → Reset password, and set it to this code.`);
  console.log(``);
  console.log(`  ("${r}" covers both cases: with email-enumeration protection on, Firebase`);
  console.log(`   deliberately will not say which.)`);
}
console.log(`\nRead-only — nothing was written.`);
process.exit(0);
