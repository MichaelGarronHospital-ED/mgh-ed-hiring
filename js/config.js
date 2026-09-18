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
// There is NO code stored here on purpose. The committee code (shared with the
// team out-of-band) is what people type to enter, and it doubles as the key that
// decrypts the (otherwise unreadable) interview questions. Admins use the same
// code + "!" and additionally see the Ranking tab. To change the code you must
// re-encrypt the questions — see README.md → "Changing the committee code".

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED — Physician Hiring";

// ---- 4. Panel chair -------------------------------------------------------
// Must match a COMMITTEE name below. Required on every panel; never shown to
// users as a rule in itself.
export const CHAIR = "Vojdani";

// ---- 5. Committee roster --------------------------------------------------
// Set your real names + each member's self-identified gender ("F"/"M"), used
// only to build balanced panels (never displayed as an M/F rule). The values
// below are PLACEHOLDERS for the public demo — replace them at setup.
export const COMMITTEE = [
  { name: "Vojdani",   gender: "M" }, // chair
  { name: "Rivera",    gender: "F" },
  { name: "Okonkwo",   gender: "M" },
  { name: "Lindqvist", gender: "F" },
  { name: "Barese",    gender: "M" },
  { name: "Nassar",    gender: "F" },
  { name: "Whitfield", gender: "M" },
  { name: "Petrova",   gender: "F" },
];

// ---- 6. Interview time slots ----------------------------------------------
// Only Oct 1 · 10:00 is confirmed so far. Add the rest once Amanda sends the times.
export const SLOTS = [
  "Oct 1 · 10:00",
];

// ---- 7. OneDrive applications folder --------------------------------------
// Committee members open CVs/cover letters from here. Keep the real link OUT of
// a public repo — set it at private deployment. "#" = disabled in the demo.
export const ONEDRIVE = "#";
