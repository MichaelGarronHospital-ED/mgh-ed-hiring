// ============================================================================
//  CONFIG — edit these, then redeploy. See README.md.
// ============================================================================

// ---- 1. Firebase ----------------------------------------------------------
// Leave EMPTY ({}) to run in local mode (localStorage, single machine). With a
// project config set, the tool is multi-device + real-time via Firestore.
// Project: mgh-ed-hiring (separate from Motion Voting). This web config is public
// by design. Security is the Firestore rules plus the three email/password role
// accounts in AUTH below (the passwords live only in the Firebase console).
export const firebaseConfig = {
  apiKey: "AIzaSyB_Jju69NtcHGeUobul2GuwfMlZiqY6wKs",
  authDomain: "mgh-ed-hiring.firebaseapp.com",
  projectId: "mgh-ed-hiring",
  storageBucket: "mgh-ed-hiring.firebasestorage.app",
  messagingSenderId: "819333808764",
  appId: "1:819333808764:web:c0c1d6cee501d988c9bff9",
};

// ---- 2. Access ------------------------------------------------------------
// THREE shared passwords, none stored here or anywhere in the repo: ED (the
// committee), Leadership (adds Panels, Ranking and Setup) and Guest (applicants,
// straight to their own scheduling; they never see the roster, questions, scores
// or other applicants). Each is only the password of a Firebase role account
// (AUTH below); the page finds the role by which account accepts it. Since R7 no
// file is derived from a password, so changing one needs no commit: Setup,
// "Passwords for all ED tools" (README, "Passwords").

// Guest password for LOCAL mode only (no Firebase; the sim copy sets its own).
// Deliberately blank here: this repo is public, and in the live (roles) model the
// Guest password is only the applicant Firebase account's password, checked by
// Firebase at sign-in. Never write a real password into this file.
export const CANDIDATE_CODE_LOCAL = "";   // unused since R7; kept one release for cached older pages

// The three passwords for LOCAL mode only (no Firebase; sim/make-site.sh fills
// them in its own copy). Blank here, always: this repo is public, and in the
// live model a password is only ever the password of a Firebase account.
export const LOCAL_CODES = { admin: "", committee: "", candidate: "" };

// ---- 2c. The other tools that share these passwords (H3) -----------------
// Motion Voting's public web config and its two role accounts (public values,
// already in the voting repo). The ED tools passwords page changes them with ours.
export const PARTNERS = {
  voting: {
    firebaseConfig: {
      apiKey: "AIzaSyD1IvlP16tceVfwMUHEvrMrxKf5BVZIok0",
      authDomain: "ed-motion-voting-99b96.firebaseapp.com",
      projectId: "ed-motion-voting-99b96",
      storageBucket: "ed-motion-voting-99b96.firebasestorage.app",
      messagingSenderId: "121642121257",
      appId: "1:121642121257:web:5ef04d3e13f0b84983c438",
    },
    leadershipEmail: "leadership@ed-motion-voting.app",
    edEmail: "ed@ed-motion-voting.app",
    // the .invalid emails these accounts move to (Phase A); the pages try both
    // until R7d (js/signin.js)
    newEmails: { leadership: "leadership@mgh-ed-voting.invalid", ed: "ed@mgh-ed-voting.invalid" },
    // the same accounts by uid (Motion Voting's rules know them by these)
    uids: { leadership: "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2", ed: "CXyo7yciWpc78J1TQYRzrPpu77C3" },
  },
};

// ---- 2b. Auth / security model -------------------------------------------
// Firebase Auth email/password "role accounts" (the only model since R7). `mode`
// is no longer read; it stays for one release because cached older pages read
// it (removed in R8).
// A ROLE IS KNOWN BY ITS ACCOUNT'S UID, NEVER BY ITS EMAIL (R7c): the rules and
// every page check `uid` (the same values as firestore.rules; tests/uids.test.mjs
// keeps them equal). The emails are used only to sign in, so they can move to
// .invalid addresses without the rules or a signed-in page noticing; until R7d
// a sign-in tries both (js/signin.js).
// Never delete a role account: a new one has a new uid, refused until the rules
// and these uids are updated. Uids and emails are public identifiers; the
// PASSWORDS are the shared secrets and live only in Firebase, never in a file.
export const AUTH = {
  mode: "roles",
  adminEmail: "admin@ed-hiring.app",
  committeeEmail: "committee@ed-hiring.app",
  candidateEmail: "applicant@ed-hiring.app",
  // the .invalid emails these accounts move to (Phase A). Until R7d every
  // sign-in tries the kind that last worked here, then the other (js/signin.js)
  newEmails: { admin: "admin@mgh-ed-hiring.invalid", committee: "committee@mgh-ed-hiring.invalid", candidate: "applicant@mgh-ed-hiring.invalid" },
  uids: { admin: "ULgtfRrkAVPS2aT69Tc4CjMqbsx1", committee: "36FXvbR8ExgU7p4cmwuCNfkgFgD2", candidate: "jvmQYhgYlRMf3f2J3uw8XXos8yD3" },
};

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "Physician Hiring";

// Screening deadline — shown as a countdown banner. Set to "" to hide.
export const SCREENING_DEADLINE = "2026-09-23";

// ---- 4. Panel chair -------------------------------------------------------
// Kyle Vojdani. MUST exactly match a name in COMMITTEE below — if it doesn't,
// no panel can ever form (buildPanel requires the chair in the available pool),
// so every candidate comes out "unschedulable". Required on every panel; never
// shown to users as a rule in itself.
export const CHAIR = "Vojdani";

// ---- 5. Committee roster --------------------------------------------------
// Names + each member's self-identified gender ("F"/"M"), used ONLY to build
// balanced panels — never displayed as an M/F label anywhere in the UI.
//
// This is the STARTING DEFAULT. Once an admin saves a roster in Setup →
// Committee, the database list takes over (see EFF() in app.js), so the tool
// stays reusable each hiring round without a code change.
//
// 13 members: the 12 confirmed interviewers + Kyle Vojdani as chair (9 M / 4 F).
// Source: DESIGN.md → Reference data.
export const COMMITTEE = [
  { name: "Vojdani",      gender: "M" }, // Kyle — chair, on every panel
  { name: "Rosenstein",   gender: "M" },
  { name: "Yang",         gender: "M" },
  { name: "Jha",          gender: "M" },
  { name: "Marrocco",     gender: "F" },
  { name: "Balachandran", gender: "M" },
  { name: "Mohindra",     gender: "F" },
  { name: "Klaiman",      gender: "F" },
  { name: "Porfiris",     gender: "M" },
  { name: "Hayre",        gender: "M" },
  { name: "Reynolds",     gender: "F" },
  { name: "Bahar",        gender: "M" },
  { name: "Losier",       gender: "M" },
];

// ---- 6. Interview time slots ----------------------------------------------
// Starting defaults only — once an admin edits times in Setup → Interview times,
// the database list takes over. From Amanda (Sept 2026): 7 one-hour slots on
// Oct 1 + 3 on Oct 7 = 10 interviews (Oct 8 available if more are needed).
// ids "0"…"9" match how these were keyed when they were a plain list — keep them.
export const SLOTS = [
  { id: "0", date: "2026-10-01", start: "09:00", end: "10:00" },
  { id: "1", date: "2026-10-01", start: "10:00", end: "11:00" },
  { id: "2", date: "2026-10-01", start: "11:00", end: "12:00" },
  { id: "3", date: "2026-10-01", start: "12:00", end: "13:00" },
  { id: "4", date: "2026-10-01", start: "13:30", end: "14:30" },
  { id: "5", date: "2026-10-01", start: "14:30", end: "15:30" },
  { id: "6", date: "2026-10-01", start: "15:30", end: "16:30" },
  { id: "7", date: "2026-10-07", start: "09:00", end: "10:00" },
  { id: "8", date: "2026-10-07", start: "10:00", end: "11:00" },
  { id: "9", date: "2026-10-07", start: "11:00", end: "12:00" },
];

// ---- 7. OneDrive applications folder --------------------------------------
// Committee members open CVs/cover letters from here. Keep the real link OUT of
// a public repo — set it at private deployment. "#" = disabled in the demo.
export const ONEDRIVE = "#";
