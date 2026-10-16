// ============================================================================
//  Change the three shared passwords inside the app (H3, design section 5).
//
//  One password opens several accounts (Leadership: hiring admin@ and voting
//  leadership@; ED: hiring committee@ and voting ed@; Guest: hiring
//  applicant@). Patient Hub statistics check the Leadership password against
//  hiring's admin@, so they follow it with nothing to paste.
//
//  The rules this file keeps:
//   - Check proves every account with its CURRENT value and changes nothing.
//   - Change now goes in a FIXED order (voting first, hiring admin@ last, so the
//     page's own session gets fresh tokens and stays signed in), and signs each
//     account in seconds BEFORE its own change: Firebase's "recent sign-in"
//     rule (about 5 minutes) can then never stop the last one after the first
//     ones changed, however long someone spent reading.
//   - Helpers keep their sign-in in memory only, never in the browser's storage.
//   - Running it again is always safe (converge): an account already changed
//     is only checked with the new value.
//   - A password value never reaches the console, storage, Firestore or history.
//
//  `auth` is an adapter (the app builds the Firebase one; the tests a fake):
//    auth.open(account, password)   -> session  (signed in; throws on refusal)
//    auth.update(session, newValue) -> void     (throws {code} on failure)
//    auth.close(session)            -> void
// ============================================================================

import { AUTH, PARTNERS } from "./config.js?v=R8";

export const ROLES = Object.freeze(["leadership", "ed", "guest"]);
export const ROLE_WORD = Object.freeze({ leadership: "Leadership", ed: "ED", guest: "Guest" });
export const ACCOUNTS = Object.freeze([
  { key: "voting:ed", project: "voting", role: "ed", email: PARTNERS.voting.edEmail, label: "Motion Voting, ED account" },
  { key: "voting:leadership", project: "voting", role: "leadership", email: PARTNERS.voting.leadershipEmail, label: "Motion Voting, Leadership account" },
  { key: "hiring:committee", project: "hiring", role: "ed", email: AUTH.committeeEmail, label: "Physician Hiring, ED account" },
  { key: "hiring:applicant", project: "hiring", role: "guest", email: AUTH.candidateEmail, label: "Physician Hiring, Guest account" },
  { key: "hiring:admin", project: "hiring", role: "leadership", email: AUTH.adminEmail, label: "Physician Hiring, Leadership account", main: true },
]);
// in the order they are changed
export const accountsFor = (roles) => ACCOUNTS.filter((a) => roles.includes(a.role));

// ---- validation (before anything is sent) -------------------------------------
// current:   { leadership, ed, guest } (the values in use now)
// next:      { <role>: { value, repeat } } for each ticked role
// overrides: { <account key>: value } where a tool already has another value
export function validateNew(roles, current, next, overrides = {}) {
  const errors = [];
  if (!roles.length) errors.push("Tick at least one password to change.");
  for (const r of ROLES) if (!String(current[r] || "")) errors.push(`Type the current ${ROLE_WORD[r]} password.`);
  for (const r of roles) {
    const n = next[r] || {}, v = String(n.value || "");
    const w = ROLE_WORD[r];
    if (v !== String(n.repeat || "")) errors.push(`The two new ${w} passwords don't match.`);
    if (v.length < 10) errors.push(`The new ${w} password needs at least 10 characters.`);
    if (v !== v.trim()) errors.push(`The new ${w} password can't start or end with a space.`);
    if (v.toLowerCase().includes("password")) errors.push(`The new ${w} password can't contain the word "password".`);
    if (v && v === current[r]) errors.push(`The new ${w} password is the same as the current one.`);
    // never a value any account accepts today: if the change stopped part way,
    // that account would let its holders in as the wrong role (review M1)
    else if (v && ROLES.some((o) => o !== r && v === String(current[o] || "")))
      errors.push(`The new ${w} password is one of the passwords in use now. Pick one that isn't used anywhere.`);
    if (v && Object.values(overrides).some((x) => x && v === x))
      errors.push(`The new ${w} password is one of the passwords in use now. Pick one that isn't used anywhere.`);
  }
  // the three in use afterwards must all differ (the sign-in page tells the
  // roles apart only by which account accepts the password)
  const after = Object.fromEntries(ROLES.map((r) => [r, roles.includes(r) ? String((next[r] || {}).value || "") : String(current[r] || "")]));
  if (after.leadership && (after.leadership === after.ed || after.leadership === after.guest) || (after.ed && after.ed === after.guest))
    errors.push("The Leadership, ED and Guest passwords must all be different.");
  return [...new Set(errors)];
}

// Which current value to try for an account: its own override if the tools
// already disagree (the "different passwords" expander), else the role's.
export const currentFor = (acct, current, overrides = {}) => (overrides[acct.key] ? overrides[acct.key] : current[acct.role]);

const isRefusal = (e) => !!e && /wrong-password|invalid-credential|user-not-found|invalid-login-credentials|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/i.test(String(e.code || e.message || ""));
const isThrottle = (e) => !!e && /too-many-requests|TOO_MANY_ATTEMPTS/i.test(String(e.code || e.message || ""));
const isRecent = (e) => !!e && /requires-recent-login/i.test(String(e.code || ""));
const isDisabled = (e) => !!e && /user-disabled|USER_DISABLED/i.test(String(e.code || e.message || ""));
const whyOf = (e) => (isThrottle(e) ? "throttled" : isRefusal(e) ? "refused" : isDisabled(e) ? "disabled" : "error");
// what Check proves: every account of a ticked password, then the Physician
// Hiring account of each unticked one, so "all different" rests on values an
// account actually accepted (review M1)
export const checkAccountsFor = (roles) => [...accountsFor(roles),
  ...ACCOUNTS.filter((a) => a.project === "hiring" && !roles.includes(a.role))];

// Step 3, "Check": prove every account with its current value; change nothing,
// keep nothing. Stops at the first refusal. -> { ok, results: [{ key, ok, why }] }
export async function preflight(auth, roles, current, overrides = {}) {
  const results = [];
  for (const a of checkAccountsFor(roles)) {
    let s = null;
    try { s = await auth.open(a, currentFor(a, current, overrides)); results.push({ key: a.key, label: a.label, ok: true }); }
    catch (e) {
      results.push({ key: a.key, label: a.label, ok: false, why: whyOf(e), code: e && e.code });
      return { ok: false, results };
    } finally { if (s) await auth.close(s); }
  }
  return { ok: true, results };
}

// Make one account have the new value. Safe to repeat.
//   state: "done" (already changed: only check the new value), "inProgress" (it
//   may have changed before that was recorded: new first, then old), or "todo".
export async function converge(auth, a, oldValue, newValue, state = "todo") {
  const tryOpen = async (v) => { try { return await auth.open(a, v); } catch (e) { if (isRefusal(e)) return null; throw e; } };
  if (state === "done" || state === "inProgress") {
    const s = await tryOpen(newValue);
    if (s) { await auth.close(s); return "already"; }
    if (state === "done") { const e = new Error(`${a.label} doesn't accept the new password.`); e.code = "mismatch"; throw e; }
  }
  // sign in seconds before the change; one retry if Firebase still asks for a
  // recent sign-in
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await tryOpen(oldValue);
    if (!s) { const e = new Error(`${a.label} didn't accept the current password.`); e.code = "refused"; e.account = a.key; throw e; }
    try { await auth.update(s, newValue); return "changed"; }
    catch (e) { if (!(isRecent(e) && attempt === 0)) throw e; }
    finally { await auth.close(s); }
  }
  return "changed";
}

// Step 4, "Change now". progress: { done: [keys], inProgress: key|null,
// unsure: [keys] } as recorded (from interviews_meta/passwords.pending, or
// empty); "unsure" accounts (the check after a change didn't confirm them) are
// tried with the new value first, like the one in progress. record(p) saves
// progress (dates and account keys only, never a value) before and after each
// account. -> { changed: [keys], failedAt: key|null, error }
export async function applyChange(auth, roles, current, next, { overrides = {}, progress = {}, record = async () => {} } = {}) {
  const done = new Set(progress.done || []), unsure = new Set(progress.unsure || []);
  const changed = [];
  for (const a of accountsFor(roles)) {
    const state = done.has(a.key) ? "done" : progress.inProgress === a.key || unsure.has(a.key) ? "inProgress" : "todo";
    try {
      await record({ done: [...done], inProgress: a.key });
      await converge(auth, a, currentFor(a, current, overrides), next[a.role].value, state);
      done.add(a.key); changed.push(a.key);
      await record({ done: [...done], inProgress: null });
    } catch (e) {
      return { changed, done: [...done], failedAt: a.key, error: e };
    }
  }
  return { changed, done: [...done], failedAt: null, error: null };
}

// Step 3 of the change: sign in to every changed account with the new value.
// -> [{ key, why }] for each account that didn't confirm it ("refused",
// "throttled", "disabled" or "error": a network problem is not a mismatch)
export async function verify(auth, roles, next) {
  const bad = [];
  for (const a of accountsFor(roles)) {
    let s = null;
    try { s = await auth.open(a, next[a.role].value); } catch (e) { bad.push({ key: a.key, why: whyOf(e), code: e && e.code }); } finally { if (s) await auth.close(s); }
  }
  return bad;
}

// "The ED password is new in Motion Voting but still old in Physician Hiring."
export function halfDoneText(roles, done) {
  const lines = [];
  for (const r of roles) {
    const accts = ACCOUNTS.filter((a) => a.role === r);
    const newIn = [...new Set(accts.filter((a) => done.includes(a.key)).map((a) => (a.project === "voting" ? "Motion Voting" : "Physician Hiring")))];
    const oldIn = [...new Set(accts.filter((a) => !done.includes(a.key)).map((a) => (a.project === "voting" ? "Motion Voting" : "Physician Hiring")))];
    if (newIn.length && oldIn.length) lines.push(`The ${ROLE_WORD[r]} password is new in ${newIn.join(" and ")} but still old in ${oldIn.join(" and ")}.`);
  }
  return lines;
}

// The Firebase adapter. Helpers are separate Firebase apps whose sign-in lives
// in MEMORY only (initializeAuth with inMemoryPersistence, never getAuth, which
// would store the ED and Guest sign-ins on the Leadership computer; review M5),
// closed and deleted at once. The page's own Leadership account is checked by
// re-authenticating the signed-in user.
//   sdk: { initializeApp, deleteApp, initializeAuth, inMemoryPersistence,
//          signInWithEmailAndPassword, updatePassword, signOut,
//          reauthenticateWithCredential, EmailAuthProvider }
export function makeFirebaseAdapter(sdk, { mainAuth, configs, connect = null }) {
  let n = 0;
  return {
    async open(a, password) {
      if (a.main && mainAuth && mainAuth.currentUser && mainAuth.currentUser.email === a.email) {
        const user = mainAuth.currentUser;
        await sdk.reauthenticateWithCredential(user, sdk.EmailAuthProvider.credential(a.email, password));
        return { main: true, user };
      }
      const app = sdk.initializeApp(configs[a.project], `pw-${Date.now().toString(36)}-${n++}`);
      const auth = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence });
      if (connect) connect(auth, a.project);
      try { const cred = await sdk.signInWithEmailAndPassword(auth, a.email, password); return { app, auth, user: cred.user }; }
      catch (e) { try { await sdk.deleteApp(app); } catch { /* gone */ } throw e; }
    },
    async update(s, value) { await sdk.updatePassword(s.user, value); },
    async close(s) {
      if (!s || s.main) return;
      try { await sdk.signOut(s.auth); } catch { /* already */ }
      try { await sdk.deleteApp(s.app); } catch { /* already */ }
    },
  };
}
