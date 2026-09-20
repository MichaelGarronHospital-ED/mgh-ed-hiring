// ============================================================================
//  CONFIG — edit these, then redeploy. See README.md.
// ============================================================================

// ---- 1. Firebase ----------------------------------------------------------
// Leave EMPTY ({}) to run in local mode (localStorage, single machine). With a
// project config set, the tool is multi-device + real-time via Firestore.
// Project: mgh-ed-hiring (separate from Motion Voting). This web config is public
// by design — security is the Firestore rules + Anonymous auth.
export const firebaseConfig = {
  apiKey: "AIzaSyB_Jju69NtcHGeUobul2GuwfMlZiqY6wKs",
  authDomain: "mgh-ed-hiring.firebaseapp.com",
  projectId: "mgh-ed-hiring",
  storageBucket: "mgh-ed-hiring.firebasestorage.app",
  messagingSenderId: "819333808764",
  appId: "1:819333808764:web:c0c1d6cee501d988c9bff9",
};

// ---- 2. Access ------------------------------------------------------------
// THREE independent codes, none stored here: a STAFF code (ED physicians) and an
// ADMIN code each independently decrypt the questions (wrapped keys in data.js);
// admins additionally see Panels/Ranking/Setup. A separate GUEST code takes
// applicants straight to their own scheduling (they never see the roster,
// questions, scores, or other applicants). To change the staff/admin codes or the
// questions, re-run the re-keying recipe in README → "Re-keying".

// Applicant/guest code for local mode (no Firebase). Low-value tier (guests only
// pick their own interview times and see nothing else). In the real (roles) model
// this same word is the applicant Firebase account password (set in the console).
export const CANDIDATE_CODE_LOCAL = "guest2026";

// ---- 2b. Auth / security model -------------------------------------------
// mode "anon"  → every client signs in anonymously (baseline; matches the
//                original open rules). Keeps working with no console setup.
// mode "roles" → Firebase Auth email/password "role accounts". Rules branch on
//                request.auth.token.email so applicants CANNOT read committee
//                data and reviewers CANNOT read scores/ranking. Activate this
//                only AFTER creating the three accounts + publishing the hardened
//                firestore.rules (exact steps in README → "Real access control").
// The role EMAILS are public identifiers (safe here). The account PASSWORDS are
// the shared secrets and live only in the Firebase console — never in this file.
export const AUTH = {
  mode: "roles",
  adminEmail: "admin@ed-hiring.app",
  committeeEmail: "committee@ed-hiring.app",
  candidateEmail: "applicant@ed-hiring.app",
};

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED — Physician Hiring";

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
