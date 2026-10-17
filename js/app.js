// ============================================================================
//  Committee app controller. One link, three audiences, told apart by which
//  role account accepts the password (R7):
//    - committee reviewer: the ED password -> Screen, Availability, Score
//    - admin: the Leadership password -> also Panels, Ranking, Setup
//    - applicant: the Guest password -> own scheduling only (candidate view)
//  Wired to the store (local or Firestore). What each account may do is
//  enforced by the Firestore rules (see config.js and firestore.rules).
// ============================================================================
import { firebaseConfig, ORG_NAME, CHAIR, COMMITTEE, SLOTS, ONEDRIVE,
         LOCAL_CODES, PARTNERS, AUTH, SCREENING_DEADLINE } from "./config.js?v=R7";
import { ROLES, ROLE_WORD, ACCOUNTS, accountsFor, validateNew, preflight, applyChange, verify, halfDoneText,
         makeFirebaseAdapter } from "./passwords.js?v=R7";
import { buildXlsx, XLSX_MIME } from "./xlsx.js?v=R7";
import { LocalStore, FirestoreStore, key, DEL } from "./store.js?v=R7";
import { autoPanels, buildPanel } from "./panels.js?v=R7";
import { escapeHtml, toast, avg, confirmDialog, downloadFile, withBusy, daysUntil, csvCell, lastKey,
         ss, ls, storageWorks, dialogOpen, flowDialog, copyText, candKey, typedFirstKeys, firstKey } from "./util.js?v=R7";
import { assignKeys, sharedSurnameText, sharedDocs, claimPlan, renamePlan, mergePlan, deletePlan, typeExactly } from "./candidates.js?v=R7";
import { effectiveSlots, slotLabel, slotTimeLabel, groupByDate, checkSlot, splitRange, responseCounts,
         newSlotId, isStructured, fmtDate } from "./slots.js?v=R7";
import { normalizeCommittee, interviewers as interviewersOf, pickable as pickableOf, memberName, memberStatus,
         idsWithInput, validMemberId, newMemberId, toStoredCommittee, hasInput, checkCommittee } from "./members.js?v=R7";
import { fromLegacy, normalizeQuestions, liveQuestions, idsWithNotes, scoringStarted, checkEdit, newQuestionId,
         toStoredQuestions, SCALE_SIZE } from "./questions.js?v=R7";
import { entry as hEntry, newHistoryId, panelUndo, shortlistUndo, screeningUndo, canUndo, undoneIds, textFor, whoFor, whenFor,
         hashOf, toDate } from "./history.js?v=R7";
import { buildBackup, backupFileName, toState, parseBackup, checkBackup, planRestore, unchunk, RESTORE_ROWS, docHash } from "./backup.js?v=R7";
import { createRounds, pageId } from "./rounds.js?v=R7";
import { icsEvent, icsCalendar } from "./ics.js?v=R7";
import { applicantInvite, panelInvite, availabilityReminder, mailtoLink, asText, longDate, salutation, whenText } from "./notify.js?v=R7";
import { STAGES, STAGE_WORD, stageOpen, stageClosedAt, roundOpen, bookingFor, thresholdOf, isOnList, closePlan, reopenPlan,
         lockEntry } from "./stages.js?v=R7";

// The release this page is. Must equal version.json and every "?v=" in every
// import (tests/versions.test.mjs). A page that sees a different version.json
// was updated underneath it (section "Reload notice" below).
const RELEASE = "R7";

// Interview questions (H2): the saved document (interviews_meta/questions).
// Since R7 there is no other source: the old encrypted js/data.js is no longer
// read (it stays in the repo, unused, until R8, for cached older pages).
const LEGACY_DOC = null;   // kept so maybeMigrateQuestions stays inert until R8 removes it
const Q = () => normalizeQuestions(S && S.questions);
let store = null, S = null;
let fbAuth = null;   // { auth, authFns } once Firebase has loaded, so Log out can sign out
const ui = { role: "committee", isAdmin: false, member: null, tab: "screen", scoreCand: null,
             candLast: null, editPanel: null, openSections: {} };
const $ = (s) => document.querySelector(s);
const isConfigured = () => firebaseConfig && Object.keys(firebaseConfig).length > 0 && firebaseConfig.apiKey;
const ADMIN_SCOPES = ["candidates", "screening", "availIv", "availCand", "scores", "meta", "offers"];

// lastKey (the applicant's availability document id) now lives in util.js, so
// store.js and the rules' allowed-name list share one definition with this file.

// Effective config: admin-set settings (DB) if present, else placeholder defaults.
// `slots` = interview times [{id,date,start,end}] in date order; everything that
// references a time (availability, panels) uses its stable `id`, never a position.
// Members (H6): `committee` is everyone on the list, normalized with a stable
// `id` (legacy id = name); `interviewers` the active ones who interview (panels,
// the availability grid); `pickable` the active ones (the name list). Every key
// is an id; `nameOf(id)` is for display only.
let _effMemo = { src: undefined, c: null };
function EFF() {
  const s = (S && S.settings) || {};
  const src = s.committee && s.committee.length ? s.committee : COMMITTEE;
  if (_effMemo.src !== src) _effMemo = { src, c: normalizeCommittee(src) };
  const committee = _effMemo.c;
  const slots = effectiveSlots(s, SLOTS);
  return { committee, interviewers: interviewersOf(committee), pickable: pickableOf(committee),
    nameOf: (id) => memberName(committee, id),
    chair: s.chair || CHAIR, slots, oneDrive: s.oneDrive || ONEDRIVE,
    overrides: s.panelOverrides || {}, slotIds: slots.map((t) => t.id),
    deadlines: s.deadlines || {}, threshold: thresholdOf(s),
    // H13: two-room times and per-day chairs. chairFor(slotId, room) is the
    // chair that panel needs: the day's chair (or none), or the room-2 lead.
    days: s.days || {}, rooms: Object.fromEntries(slots.filter((t) => t.rooms === 2).map((t) => [t.id, 2])),
    chairFor: (slotId, room = 1) => {
      const t = slots.find((x) => x.id === String(slotId));
      const day = ((s.days || {})[(t && t.date) || ""]) || {};
      if (room === 2) return day.room2Chair && day.room2Chair !== "none" ? day.room2Chair : null;
      return day.chair === "none" ? null : day.chair || s.chair || CHAIR;
    },
    interviewInfo: s.interviewInfo || {} };
}
// Rooms or day chairs in use? Without them panels are built exactly as before.
const roomsInUse = () => { const e = EFF(); return Object.keys(e.rooms).length > 0 || Object.values(e.days).some((d) => d && (d.chair || d.room2Chair)); };
// H4: is this stage open (and the round not closing)? Reads the state document.
const isOpen = (name) => stageOpen(S && S.meta, name);
const locked = () => !!(S && S.schedule && S.schedule.locked);
const dayOf = (at) => { const d = toDate(at); return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""; };
const mname = (id) => EFF().nameOf(id);
const isInterviewer = (id) => !!id && EFF().interviewers.some((m) => m.id === id);
// Who a Leadership history entry says did it: the name Leadership picked to
// review as, else just "leadership".
const byWho = () => ui.member || "leadership";
const slotName = (id) => slotLabel(EFF().slots.find((t) => t.id === String(id)));
// only answers for times that still exist count (edited/removed times leave stale keys)
const liveAnswers = (map) => { const ids = new Set(EFF().slotIds); return Object.keys(map || {}).filter((k) => ids.has(k)); };
// availability for a candidate: support both committee-keyed (candId, legacy) and
// applicant-keyed (last name) documents.
// H14: an applicant's document is their own availKey when they share a surname.
const availForCand = (c) => (S.availCand[c.id]) || (S.availCand[candKey(c)]) || {};
// The state the H5/H14 plans read: page state plus the whole availability documents.
const planState = () => ({ ...S, availRaw: S.availRaw || Object.fromEntries(Object.entries(S.availCand || {})
  .map(([k, v]) => [k, { slots: v, ...((S.replies || {})[k] || {}) }])) });

// ------------------------------------------------------------------ gate
// R7 (H3): the role is found by SIGNING IN, never by decrypting a file. One
// password box, three role accounts: the page tries them in roleOrder() until
// one accepts. Nothing in the repo is derived from a password any more, so a
// password can change without a commit. The password itself is never kept: a
// reload in the same tab resumes from Firebase's own tab-only sign-in.
const ROLE_EMAIL = { admin: AUTH.adminEmail, committee: AUTH.committeeEmail, candidate: AUTH.candidateEmail };
const roleOfEmail = (email) => Object.keys(ROLE_EMAIL).find((r) => ROLE_EMAIL[r] === email) || null;
const isRefusal = (e) => /wrong-password|invalid-credential|user-not-found|invalid-login-credentials/.test(String((e && e.code) || ""));
const SIGNED_OUT_MSG = "You were signed out, probably because a password changed. Enter the current password.";
// Guest first on an applicant link (every applicant-facing link is
// index.html#apply); else the role that last worked on this browser (not
// secret); else ED, then Guest, then Leadership. So nearly every sign-in costs
// no refused attempt, and the worst case two.
function roleOrder() {
  const order = ["committee", "candidate", "admin"];
  const first = /^#apply/.test(location.hash) ? "candidate" : ls.get("ed_iv_lastrole");
  return order.includes(first) ? [first, ...order.filter((r) => r !== first)] : order;
}
async function unlock(typed) {
  if (!isConfigured()) {
    // local mode (sim/make-site.sh fills LOCAL_CODES in its copy; blank in the repo)
    const role = Object.keys(LOCAL_CODES).find((r) => LOCAL_CODES[r] && LOCAL_CODES[r] === typed);
    if (!role) { gateFail("Incorrect password."); return; }
    await enter(role);
    ss.set("ed_iv_localrole", role);
    return;
  }
  let fb;
  try { fb = await firebase(); } catch (e) { gateFail(signInError(e)); return; }
  try { await tabOnly(fb); } catch (e) { gateFail(signInError(e)); return; }
  let disabled = null;
  for (const role of roleOrder()) {
    try { await fb.authFns.signInWithEmailAndPassword(fb.auth, ROLE_EMAIL[role], typed); }
    catch (e) {
      if (isRefusal(e)) continue;
      // a disabled account says so whatever was typed: try the others first
      if (String(e && e.code).includes("user-disabled")) { disabled = disabled || { e, role }; continue; }
      gateFail(signInError(e, { email: ROLE_EMAIL[role] }));
      return;
    }
    ls.set("ed_iv_lastrole", role);
    ls.del("ed_iv_gate");
    ss.set("ed_iv_signedin", "1");
    await enter(role);
    return;
  }
  // every account refused: the password is wrong. A disabled account answers
  // the same whatever was typed, so it is named only when it is Leadership's
  // (the one account nobody else could have meant)
  const paused = gateWrong();
  gateFail((disabled && disabled.role === "admin"
    ? `Incorrect password. (Also: ${signInError(disabled.e, { email: ROLE_EMAIL.admin })})` : "Incorrect password.")
    + (paused ? " To protect the accounts, wait 30 seconds before trying again." : ""));
}

// Each wrong password costs a refused sign-in on all three accounts, and
// Firebase pauses a device that keeps failing. After 3 wrong passwords on this
// device, the page itself waits 30 seconds first (review). Not secret: only a
// count and a time, in this browser.
const GATE_PAUSE_MS = 30000;
function gateState() { try { return JSON.parse(ls.get("ed_iv_gate") || "{}") || {}; } catch { return {}; } }
const gatePausedFor = () => Math.max(0, (gateState().until || 0) - Date.now());
function gateWrong() {
  const g = gateState();
  g.n = (g.n || 0) + 1;
  if (g.n >= 3) { g.n = 0; g.until = Date.now() + GATE_PAUSE_MS; }
  ls.set("ed_iv_gate", JSON.stringify(g));
  return !!g.until && g.until > Date.now();
}
function gateCountdown() {
  const btn = $("#gbtn"); if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  const left = gatePausedFor();
  if (!left) { btn.disabled = false; btn.textContent = btn.dataset.label; return; }
  btn.disabled = true; btn.textContent = `Wait ${Math.ceil(left / 1000)} s`;
  setTimeout(gateCountdown, 500);
}

// Signed in (or resumed) as this role: open the store and the right view.
async function enter(role) {
  ui.role = role; ui.isAdmin = role === "admin";
  await initStore(role);
  $("#gate").classList.add("hidden");
  watchSignOut();
  // Admin goes straight in as "Admin", with no name: the Leadership password is
  // held by coordinators as well as committee members. An admin who also
  // reviews picks their name from the header ("review as a member").
  if (role === "candidate") proceedCandidate();
  else if (ui.isAdmin) { ui.member = null; showApp(); }
  else proceedToMemberPick();
}

// A reload in the same tab: Firebase kept this tab's sign-in (tab-only), so map
// its account back to the role. Older pages saved the raw password in
// sessionStorage ("ed_iv_code"); it is deleted here and never written again.
async function resume() {
  const older = ss.get("ed_iv_code");
  ss.del("ed_iv_code");
  if (ss.get("ed_iv_signedout")) { ss.del("ed_iv_signedout"); gateMsg(SIGNED_OUT_MSG); }
  if (!isConfigured()) {
    const r = ss.get("ed_iv_localrole");
    if (r && LOCAL_CODES[r]) await enter(r);
    return;
  }
  if (!ss.get("ed_iv_signedin") && !older) return;   // nothing to resume: don't load the SDK yet
  let fb;
  try { fb = await firebase(); await fb.auth.authStateReady(); } catch { return; }
  const role = fb.auth.currentUser && roleOfEmail(fb.auth.currentUser.email);
  if (!role) { ss.del("ed_iv_signedin"); return; }
  ss.set("ed_iv_signedin", "1");
  await enter(role);
}

// If the sign-in ends while the page is open (a password changed elsewhere
// revokes every other session within about an hour), go back to the gate and
// say why, rather than let saves fail one by one.
function watchSignOut() {
  if (!fbAuth || ui._watching) return;
  ui._watching = true;
  let had = !!fbAuth.auth.currentUser;
  fbAuth.authFns.onAuthStateChanged(fbAuth.auth, (u) => {
    if (u) { had = true; return; }
    if (!had || ui.loggingOut) return;
    ss.del("ed_iv_signedin");
    ss.set("ed_iv_signedout", "1");
    location.reload();
  });
}

// Why the sign-in failed, in words that point at the actual fault. Since R7
// there is one source of truth (the account that accepts the password), so a
// refusal by every account is simply "Incorrect password."
function signInError(e, opts = {}) {
  const c = (e && e.code) || "";
  const who = opts.email || "the role account";
  const console_ = "Leadership: Firebase console, Authentication";
  // The SDK itself never arrived: nothing was even attempted.
  if (c === "app/sdk-unreachable")
    return "Couldn't load the sign-in service. A hospital network, VPN or content blocker may be "
      + "blocking www.gstatic.com. Try another network (mobile data is the quickest test).";
  // Firebase throttles the DEVICE, not the account, and every retry extends it.
  // Saying "try again" here is actively harmful, so say the opposite.
  if (c.includes("too-many-requests"))
    return "Too many sign-in attempts. The server has temporarily blocked this device. "
      + "Wait about 15 minutes, then try ONCE. Retrying now makes the block last longer.";
  if (c.includes("network-request-failed") || c.includes("network"))
    return "Network problem. Check your connection and try again.";
  if (c.includes("operation-not-allowed"))
    return `Email/Password sign-in is switched off for this project. ${console_}, Sign-in method.`;
  if (c.includes("user-disabled"))
    return `The ${who} account is disabled. ${console_}, Users.`;
  if (isRefusal(e)) return "Incorrect password.";
  return "Couldn't sign in. Please try again.";
}

// One place that paints a gate failure, so every path gets the same treatment
// (and the hint below counts attempts across all of them).
let gateAttempts = 0;
function gateFail(msg) {
  gateAttempts++;
  gateMsg(msg);
}
function gateMsg(msg) {
  const gerr = $("#gerr"); if (!gerr) return;
  // .overlay-box centres its text, which is fine for "Incorrect password." and
  // unreadable for the several-sentence messages.
  gerr.innerHTML = `<div style="text-align:${msg.length > 40 ? "left" : "center"}">${escapeHtml(msg)}</div>`
    + gateHint(gateAttempts);
}

// Three separate passwords reach this one box, so "it doesn't work" is ambiguous
// by construction. After a couple of failures, say what the three are.
function gateHint(n) {
  if (n < 2) return "";
  return `<div class="note tip" style="text-align:left; margin-top:.7rem">The ED tools use three passwords:
    the <b>ED</b> password (committee: Screen, Availability, Score), the <b>Leadership</b> password
    (adds Panels, Ranking, Offers and Setup) and the <b>Guest</b> password (applicants booking times).
    The ED password signs you in without the leadership view. If you are sure you have the right one,
    leadership should check the matching account in the Firebase console.</div>`;
}

// Firebase, loaded once per page. Separate "the SDK never arrived" from "the
// server said no": a blocked CDN must not read as a wrong password.
let _fb = null;
async function firebase() {
  if (_fb) return _fb;
  try { _fb = await loadFirestore(); }
  catch (e) {
    const err = new Error("could not load the Firebase SDK");
    err.code = "app/sdk-unreachable"; err.cause = e;
    throw err;
  }
  fbAuth = { auth: _fb.auth, authFns: _fb.authFns };
  return _fb;
}

async function initStore(role) {
  if (isConfigured()) {
    const fb = await firebase();
    const scopes = role === "candidate"
      ? ["public"]                                         // only the PII-free public slots doc
      : role === "committee"
        ? ["candidates", "availIv", "availCand", "meta"]   // reviewers can't read scores/screening
        : ADMIN_SCOPES;
    // Mirror your own input locally for EVERY committee role, admin included.
    // It used to be committee-only, which meant rating something as admin and
    // coming back with the staff code showed a blank review on the same
    // machine, the likeliest cause of the "my ratings vanished" report.
    // Screening now also comes back from the server; scores never do, so for
    // those this mirror is still the only replay a reviewer gets.
    const echo = role !== "candidate";
    ui.echoOnly = role === "committee";
    store = new FirestoreStore(fb, { scopes, echo });
  } else {
    store = new LocalStore();
  }
  store.subscribe((s) => {
    S = s;
    if (ui.role === "candidate") {
      // on the name step, redraw only when booking changed: a redraw wipes a
      // name being typed or filled in by the browser (review)
      const cv = $("#candview");
      if (cv && !cv.classList.contains("hidden") && (ui.candLast || !$("#candForm") || ui._candBooking !== bookingNow())) renderCandidate();
    }
    else if ($("#app") && !$("#app").classList.contains("hidden")) {
      // The roster changed out from under this session and no longer has the
      // name we're filing input under — everything typed from here would be
      // saved to a name nobody reads. Send them back to the picker instead.
      if (ui.member && !EFF().pickable.some((m) => m.id === ui.member)) {
        toast("You are no longer on the list. Please pick your name again", "err");
        backToMemberPick();
        return;
      }
      renderBanner(); render();
      refreshSetup();   // keep the open Setup modal live
    }
    // The "Who are you?" list is built before the first Firestore snapshot can
    // arrive, so it always paints from the config defaults. Repaint it on every
    // snapshot while it's open — that covers both the first one (swapping in the
    // admin's saved roster) and a later roster change made from another device.
    else if ($("#memberpick") && !$("#memberpick").classList.contains("hidden")) {
      refreshMemberPick();
    }
    // self-heal: mirror the committee's time list to the PII-free public doc so
    // applicants always see the same times. Runs once per admin session.
    if (ui.role === "admin" && !ui._syncedSlots && isConfigured()) {
      const st = S.settings;
      const pub = Array.isArray(st.times) ? { times: st.times } : (st.slots && st.slots.length ? { slots: st.slots } : null);
      if (pub) { ui._syncedSlots = true; store.syncPublicSlots(pub).catch(() => { ui._syncedSlots = false; }); }
    }
    if (ui.role === "admin") syncAllowedNames();
    if (ui.role === "admin") maybeMigrateQuestions();
    if (ui.role === "admin" && rounds) renderRoundLine();
  });
  S = store.getState();
}

// H2 (R1 to R6): the first Leadership sign-in copied the questions out of
// the old encrypted js/data.js into interviews_meta/questions. Inert since R7
// (nothing is decrypted any more); removed in R8. It copied them (ids "0".."n-1",
// exactly the keys every saved note uses). Create-only, in a transaction with
// its history entry, so two tabs doing it at once write it once.
function maybeMigrateQuestions() {
  if (!store || !store.metaLoaded || S.questions || !LEGACY_DOC || ui._migrating || ui._migrated) return;
  ui._migrating = true;
  const n = LEGACY_DOC.questions.length;
  store.createQuestions(LEGACY_DOC, hEntry("questions.migrate",
    `Copied the interview questions from the old locked file (${n} question${n === 1 ? "" : "s"})`, { by: byWho() }))
    .then(() => { ui._migrated = true; })
    .catch((e) => console.warn("questions copy failed:", e && e.code))
    .finally(() => { ui._migrating = false; });
}

// Keep the rules' allowed-surname list in step with the roster. firestore.rules
// refuses an applicant's availability write unless their surname key is in
// /interviews_meta/allowed, so this is what makes a newly added candidate able
// to answer at all — and what stops a removed one from still submitting.
//
// Runs on every admin snapshot but writes only when the set actually differs,
// so it is a no-op in the normal case. Self-healing on purpose: any roster edit,
// from any device or from scripts/, is reconciled the next time an admin has the
// app open, with no separate step for someone to forget.
//
// Guard against a write loop between page versions (review M4, m4). Two open
// Leadership tabs that build the list differently (an older and a newer page)
// would otherwise rewrite it back and forth all day. So:
//   - a write made because THIS tab's roster changed since its last write is
//     never counted and never held back;
//   - only a "fight" counts: the saved list CHANGED since this tab last looked,
//     to something this tab did not write, while this tab's roster stayed the
//     same. An ordinary snapshot (the list unchanged) never counts, and neither
//     does the retry timer. After 3 fights in 10 minutes this tab stops
//     rewriting and tells Leadership to reload the other tab, and a timer
//     writes again once the 10 minutes are up.
//   - calls are gathered for 250 ms, and once a write settles the page looks
//     again, so a roster edit made while a write was in flight is never missed.
const ALLOWED_WINDOW_MS = 10 * 60 * 1000;
const rosterSig = () => S.candidates.map((c) => `${c.id}:${c.name}:${c.removed ? 1 : 0}`).sort().join("|");
// gathered for 250 ms, but never put off for more than 2 seconds in all, so a
// steady stream of snapshots can't keep the list from being written (review)
function syncAllowedNames(fromTimer = false) {
  clearTimeout(syncAllowedNames._t);
  const now = Date.now();
  if (!syncAllowedNames._since) syncAllowedNames._since = now;
  const wait = Math.max(0, Math.min(250, syncAllowedNames._since + 2000 - now));
  syncAllowedNames._t = setTimeout(() => { syncAllowedNames._since = 0; if (S && ui.role === "admin") syncAllowedNow(fromTimer); }, wait);
}
function syncAllowedNow(fromTimer) {
  if (!roundOpen(S.meta)) return;          // paused while a round is closing
  const want = [...new Set(S.candidates.filter((c) => !c.removed).map(candKey).filter(Boolean))].sort();
  if (!want.length) return;                 // never publish an empty list: that would lock every applicant out
  const g = ui._allowed = ui._allowed || { last: null, lastSeen: undefined, fights: [], held: false, timer: null };
  const have = S.allowedNames, haveSig = have ? have.join("|") : null;
  const seenChanged = g.lastSeen !== undefined && haveSig !== g.lastSeen;
  g.lastSeen = haveSig;
  if (have && have.length === want.length && want.every((k, i) => have[i] === k)) {
    if (g.held) { g.held = false; renderUpdateLine(); }
    return;
  }
  if (ui._syncingNames) return;
  const roster = rosterSig(), now = Date.now();
  g.fights = g.fights.filter((t) => now - t < ALLOWED_WINDOW_MS);
  if (!fromTimer && seenChanged && g.last && g.last.roster === roster && haveSig !== g.last.list) g.fights.push(now);
  // held back only while this tab's own roster is unchanged: an edit here is always written
  if (!fromTimer && g.fights.length >= 3 && !(g.last && g.last.roster !== roster)) {
    if (!g.held) { g.held = true; renderUpdateLine(); }
    clearTimeout(g.timer);
    g.timer = setTimeout(() => syncAllowedNames(true), g.fights[0] + ALLOWED_WINDOW_MS - now + 50);
    return;
  }
  if (g.held) { g.held = false; renderUpdateLine(); }
  ui._syncingNames = true;
  g.last = { roster, list: want.join("|") };
  store.setAllowedNames(want)
    // the list was ours when the write landed: a different list seen later was
    // written by someone else, even if no snapshot showed ours in between
    .then(() => { g.lastSeen = g.last.list; })
    .catch((e) => console.warn("allowed-name sync failed:", e && e.code))
    .finally(() => { ui._syncingNames = false; syncAllowedNames(); });
}

async function loadFirestore() {
  const [a, f, au] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
  ]);
  const app = a.initializeApp(firebaseConfig);
  const auth = au.getAuth(app);
  const db = f.getFirestore(app);
  return {
    // the Firebase app functions too: the Passwords card (H3) opens short-lived
    // helper apps (initializeApp, deleteApp) for the other accounts
    app, auth, authFns: au, appFns: { initializeApp: a.initializeApp, deleteApp: a.deleteApp },
    db, collection: f.collection, doc: f.doc,
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot, runTransaction: f.runTransaction,
    deleteField: f.deleteField, writeBatch: f.writeBatch, serverTimestamp: f.serverTimestamp,
    getDoc: f.getDoc, getDocs: f.getDocs, deleteDoc: f.deleteDoc, Timestamp: f.Timestamp,
    query: f.query, orderBy: f.orderBy, limit: f.limit, startAfter: f.startAfter,
  };
}

// Keep the Firebase sign-in for this tab only. Firebase's default keeps it in
// the browser for good, so closing the tab or pressing Log out left a shared
// computer still signed in, and signing in on a second tab with another
// password quietly switched the first tab's account too. A reload in the same
// tab resumes from it (resume()). A browser that blocks sessionStorage gets
// memory only (this page load), never a sign-in that fails because the SDK
// could not save it. Set once, before the first attempt.
async function tabOnly(fb) {
  const keep = storageWorks("sessionStorage") ? fb.authFns.browserSessionPersistence : fb.authFns.inMemoryPersistence;
  await fb.authFns.setPersistence(fb.auth, keep);
}

// ------------------------------------------------------------ member pick
function proceedToMemberPick() {
  // always ask who you are on each sign-in (never auto-restore)
  ui.member = null;
  fillMemberSel();
  // Say which of the two codes was used. The staff code signs you in perfectly
  // well — just without Panels, Ranking and Setup — so someone who reaches for
  // the wrong one gets in and then finds the leadership view missing, which
  // they report as "I can't log in as admin". Nothing on screen told them.
  const rl = $("#roleLine");
  if (rl) {
    rl.className = ui.isAdmin ? "note tip" : "note";
    rl.innerHTML = ui.isAdmin
      ? `<b>Leadership access.</b> Pick your name to screen, give availability and score as yourself.`
      : `<b>Committee access:</b> Screen, Availability and Score. Expecting Panels, Ranking and Setup?
         Those need the <b>Leadership</b> password, not the ED password.`;
  }
  $("#adminOnlyBtn").classList.toggle("hidden", !ui.isAdmin);
  $("#memberpick").classList.remove("hidden");
}

// Build the name list from the CURRENT effective roster (admin's Setup value if
// it has loaded, else the config defaults).
function fillMemberSel() {
  const sel = $("#memberSel"); if (!sel) return;
  // Placeholder first, so nobody can click straight through and silently file
  // their flags/ratings/scores under whoever happens to be alphabetically or
  // positionally first (the chair). Picking your name must be deliberate.
  // Alphabetical, so people can find themselves. Sorted on a COPY — `committee`
  // is the live settings array (or the COMMITTEE config constant), and panel
  // building reads that order, so sorting it in place would reorder the roster
  // everywhere.
  // Active people only; the value is the member id (legacy id = the name).
  const names = [...EFF().pickable].sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = `<option value="" disabled selected>Select your name</option>`
    + names.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  // Don't let anyone commit to a name off the config fallback list before the
  // saved roster lands — input filed under the wrong spelling is invisible
  // afterwards, and it looks exactly like the app having lost it.
  const btn = $("#memberBtn"), ready = !store || store.ready;
  if (btn) { btn.disabled = !ready; btn.textContent = ready ? "Continue" : "Loading the roster…"; }
  sel.disabled = !ready;
}

function backToMemberPick() {
  ui.member = null;
  if (store) store.setMember(null);
  ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.add("hidden"));
  $("#banner").classList.add("hidden");
  proceedToMemberPick();
}

// Repaint the list in place without losing a selection the user already made.
function refreshMemberPick() {
  const sel = $("#memberSel"); if (!sel) return;
  const prev = sel.value;
  fillMemberSel();
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function showApp() {
  // Tell the store who we are, so it can fetch this member's own screening
  // documents back from the server (see FirestoreStore.setMember).
  if (store) store.setMember(ui.member);
  $("#memberpick").classList.add("hidden");
  $("#orgName").textContent = ORG_NAME;
  $("#whoLine").textContent = ui.member ? mname(ui.member) : "Admin";
  $("#changeMember").textContent = ui.member ? "Change" : "Review as a member";
  $("#adminTag").classList.toggle("hidden", !ui.isAdmin || !ui.member);
  $("#setupBtn").classList.toggle("hidden", !ui.isAdmin);
  if (!ui.isAdmin && ui.tab === "settings") ui.tab = "screen";
  if (!isInterviewer(ui.member) && ui.tab === "score") ui.tab = "screen";
  if (!ui.isAdmin && !isInterviewer(ui.member) && ui.tab === "availability") ui.tab = "screen";
  ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.remove("hidden"));
  buildTabs();
  renderBanner();
  render();
}

function buildTabs() {
  // Natural progression; Panels(3) before Score(4). Setup lives on the gear icon,
  // not the tab row, so the tabs read as one clean sequence.
  // Someone who screens only (H6) gives no interview times and scores nobody,
  // so they get the Screen tab alone.
  const meIv = isInterviewer(ui.member);
  const tabs = [["screen", "Screen"]];
  if (ui.isAdmin || meIv) tabs.push(["availability", "Availability"]);
  if (ui.isAdmin) tabs.push(["panels", "Panels"]);
  // Score is nothing but your own notes and rating, so without a name it has
  // nothing to show and nowhere to file anything.
  if (meIv) tabs.push(["score", "Score"]);
  if (ui.isAdmin) tabs.push(["ranking", "Ranking"]);
  $("#tabs").innerHTML = tabs.map(([t, label]) =>
    `<button id="tab-${t}" data-tab="${t}" role="tab" aria-controls="${t}" aria-selected="${t === ui.tab}"
       tabindex="${t === ui.tab ? "0" : "-1"}" class="${t === ui.tab ? "on" : ""}">${label}</button>`).join("");
  tabs.forEach(([t]) => { const s = $("#" + t); if (s) s.setAttribute("aria-labelledby", "tab-" + t); });
  // On a phone the track can be wider than the screen and scrolls sideways.
  // Fade whichever edge has a tab hidden past it, so the last tab never just
  // looks cut off, and keep the chosen tab in view.
  const nav = $("#tabs");
  const edges = () => {
    const max = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle("more-left", max > 1 && nav.scrollLeft > 1);
    nav.classList.toggle("more-right", max > 1 && nav.scrollLeft < max - 1);
  };
  nav.onscroll = edges;
  if (!buildTabs.wired) { buildTabs.wired = true; window.addEventListener("resize", () => { const n = $("#tabs"); if (n && n.onscroll) n.onscroll(); }); }
  const reveal = () => {
    const on = nav.querySelector("button.on");
    if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2);
    edges();
  };
  requestAnimationFrame(reveal);
  const btns = [...$("#tabs").querySelectorAll("button")];
  const select = (b, focus) => {
    ui.tab = b.dataset.tab;
    $("#setupBtn").classList.remove("active");
    btns.forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; });
    if (focus) b.focus();
    reveal();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  btns.forEach((b, i) => {
    b.onclick = () => select(b);
    b.onkeydown = (e) => {
      let j = null;
      if (e.key === "ArrowRight") j = (i + 1) % btns.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + btns.length) % btns.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = btns.length - 1;
      if (j != null) { e.preventDefault(); select(btns[j], true); }
    };
  });
}

// --------------------------------------------------------------- helpers
const cand = (id) => S.candidates.find((c) => c.id === id);
// everyone on the list counts, including people who have left (their input stays)
const flagsCount = (id) => EFF().committee.filter((c) => (S.screening[key(c.id, id)] || {}).flag).length;
// H7: on the interview list unless removed, taken off by leadership, or (with
// no decision) at the concern threshold from Setup (0 = never automatically).
const isIn = (c) => isOnList(c, flagsCount(c.id), EFF().threshold);
const activeCands = () => S.candidates.filter(isIn);

// small hoverable "i" info badge (native tooltip on desktop hover; tap on mobile)
function infoIcon(text) {
  // data-tip drives an instant custom tooltip (native title lags ~1s). onclick
  // guard so tapping the badge inside a <summary> doesn't toggle the section.
  return text ? ` <span class="info" tabindex="0" role="img" data-tip="${escapeHtml(text)}" aria-label="Info: ${escapeHtml(text)}" onclick="event.preventDefault();event.stopPropagation();">i</span>` : "";
}
// collapsible section that remembers its open/closed state across renders
function section(id, title, sub, bodyHtml, opts = {}) {
  const open = ui.openSections[id] ?? (opts.open ?? false);
  const count = opts.count != null ? `<span class="count">${opts.count}</span>` : "";
  const chev = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  return `<details class="section" data-sec="${id}" ${open ? "open" : ""}>
    <summary>${chev}<span class="sec-title">${escapeHtml(title)}${sub ? ` <span class="sec-sub">· ${escapeHtml(sub)}</span>` : ""}${infoIcon(opts.info)}</span>${count}</summary>
    <div class="sec-body">${bodyHtml}</div></details>`;
}
// wire <details> toggles → persist open state (called after each render)
function wireSections() {
  document.querySelectorAll("details.section").forEach((d) => {
    d.addEventListener("toggle", () => {
      ui.openSections[d.dataset.sec] = d.open;
      if (d.dataset.sec === "setHistory" && d.open && !ui.hist) IV.loadHistory();
      if (d.dataset.sec === "setPast" && d.open && !ui.past) IV.loadPast();
    });
  });
}

// ---- the one line of guidance a tab gets ----------------------------------
// Every tab used to open with a blue "What to do here" panel of three or four
// sentences, on top of a notice, on top of the content. Three paragraphs of
// instructions above a list of names is not a page anyone reads twice, and it
// pushed the actual work below the fold on a phone.
//
// What survives is one quiet sentence under the tab bar: enough for a first
// visit, invisible enough for the fiftieth. Anything longer belongs on the ⓘ
// beside the thing it explains, where it is asked for rather than announced.
const hint = (text) => `<p class="hint">${text}</p>`;
const empty = (icon, title, msg) =>
  `<div class="empty">${icon}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(msg)}</p></div>`;

// Line icons drawn in the text colour. House rule for every ED tool: no emoji
// as icons (they render differently on every phone and ignore dark mode). The
// 40px ones head an empty state; the 16px ones sit inline in a line of text.
const svgIcon = (body, { size = 16, vb = 16, sw = 1.6, cls = "ico" } = {}) =>
  `<svg class="${cls}" viewBox="0 0 ${vb} ${vb}" width="${size}" height="${size}" fill="none" stroke="currentColor" `
  + `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const bigIcon = (body) => svgIcon(body, { size: 40, vb: 40, sw: 2, cls: "empty-ico" });
const ICON = {
  list: bigIcon('<rect x="9" y="7" width="22" height="27" rx="4"/><path d="M15 15h10M15 21h10M15 27h6"/>'),
  calendar: bigIcon('<rect x="7" y="9" width="26" height="24" rx="4"/><path d="M7 16h26M14 6v6M26 6v6"/>'),
  star: bigIcon('<path d="M20 7.5l3.8 7.7 8.5 1.2-6.2 6 1.5 8.4L20 26.8l-7.6 4 1.5-8.4-6.2-6 8.5-1.2z"/>'),
  lock: bigIcon('<rect x="10" y="18" width="20" height="15" rx="3"/><path d="M14 18v-4a6 6 0 0 1 12 0v4M20 24v3"/>'),
  people: bigIcon('<circle cx="20" cy="14" r="5"/><path d="M11 32c1-5 4.6-8 9-8s8 3 9 8"/><circle cx="9.5" cy="17" r="3.5"/>'
    + '<path d="M3.5 29c.6-3 2.8-5 5.6-5.3"/><circle cx="30.5" cy="17" r="3.5"/><path d="M36.5 29c-.6-3-2.8-5-5.6-5.3"/>'),
  mail: bigIcon('<rect x="7" y="10" width="26" height="20" rx="3"/><path d="M8 12l12 9 12-9"/>'),
  warn: svgIcon('<path d="M8 2.3L14.6 13.6H1.4z"/><path d="M8 6.6v3.2M8 11.7v.1"/>'),
  flag: svgIcon('<path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3.25 2 3.25H3.5"/>'),
  cal: svgIcon('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>'),
  prev: svgIcon('<path d="M10 3L5 8l5 5"/>', { size: 20, sw: 2 }),
  next: svgIcon('<path d="M6 3l5 5-5 5"/>', { size: 20, sw: 2 }),
};

// The deadline bar is a countdown, so it belongs on screen while there is
// something to count down to. It used to stay up afterwards — "Screening
// deadline (Sep 23) has passed" on every tab, every day, for the rest of the
// round — which is a fact nobody can act on sitting above work everybody has
// to. It now shows from a fortnight out until the day itself, and then stops.
//
// The `past` class stays defined and pinned by tests/css-collisions: it is one
// `if` away from coming back, and the next person to want it must not have to
// rediscover why a banner modifier can never be a utility class.
const BANNER_LEAD_DAYS = 14;
function renderBanner() {
  const el = $("#banner"); if (!el) return;
  // H4: the date comes from Setup, Deadlines (config.js is only the fallback), and
  // the countdown stops once screening is closed.
  const due = EFF().deadlines.screening || SCREENING_DEADLINE;
  const d = daysUntil(due);
  const hide = d == null || d < 0 || d > BANNER_LEAD_DAYS || S.meta.interviewsComplete || !isOpen("screening");
  if (hide) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  let cls = "banner", txt;
  const date = new Date(due + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (d > 0) { txt = `<b>Screening closes in ${d} day${d === 1 ? "" : "s"}</b>, due ${date}.`; if (d <= 3) cls += " urgent"; }
  else { txt = `<b>Screening closes today</b> (${date}).`; cls += " urgent"; }
  el.className = cls;
  el.innerHTML = `<div class="inner">${ICON.cal}<span>${txt}</span></div>`;
}

function render() {
  ["screen", "availability", "score", "panels", "ranking"].forEach((t) =>
    $("#" + t).classList.toggle("hidden", t !== ui.tab));
  ({ screen: renderScreen, availability: renderAvailability, score: renderScore,
     panels: renderPanels, ranking: renderRanking }[ui.tab] || (() => {}))();
  wireSections();
}

// Setup lives in a modal over the current page (so it's clear you're editing
// settings, not navigating away).
function openSetup() {
  // always open with every card collapsed
  ["setChair", "setCommittee", "setQuestions", "setStages", "setDeadlines", "setRule", "setInfo", "setSlots", "setOneDrive", "setRound", "setPast",
   "setRetention", "setRestore", "setBackup", "setPasswords", "setHistory"].forEach((k) => delete ui.openSections[k]);
  ui.past = null;
  ui.hist = null;   // the history card reads fresh each time Setup opens
  renderSettings(); wireSections();
  $("#setupModal").classList.remove("hidden");
  $("#setupBtn").classList.add("active");
  $("#setupClose").focus();
}
function closeSetup() {
  $("#setupModal").classList.add("hidden");
  $("#setupBtn").classList.remove("active");
  $("#setupBtn").focus();
}
const setupOpen = () => !$("#setupModal").classList.contains("hidden");

// Collation sort order. A per-device UI preference, not data — remembered so a
// coordinator who works by rating doesn't re-pick it every time they open the
// tab. Falls back to "name" whenever storage is unavailable or holds junk.
const COLL_SORT_KEY = "ed_iv_collsort_v1";
function collSort() {
  if (ui.collSort == null) {
    ui.collSort = ls.get(COLL_SORT_KEY) || "name";
  }
  return ui.collSort;
}

// ------------------------------------------------------- screening figures
// Everyone on the committee screens every applicant, so the denominator for a
// priority rating is the whole committee. A missing rating is NOT imputed (a
// non-answer is not a 3) — the mean is over whoever answered, which is why the
// count is always printed next to it: "4.5 from 2 people" and "4.5 from 12" are
// very different facts and the number alone can't tell them apart.
function screenStats(candId) {
  const { committee } = EFF();
  const flags = [], ratings = [], by = [], notes = [];
  committee.forEach((m) => {
    const s = S.screening[key(m.id, candId)] || {};
    const who = m.active ? m.name : `${m.name} (left)`;
    if (s.flag) flags.push({ who, id: m.id, reason: String(s.reason || "").trim() });
    if (s.rating) { ratings.push(s.rating); by.push({ who, rating: s.rating }); }
    if (String(s.note || "").trim()) notes.push({ who, id: m.id, note: String(s.note).trim(), conflict: !!s.conflict });
  });
  by.sort((a, b) => b.rating - a.rating || a.who.localeCompare(b.who));
  // reasons first: a bare flag is the least informative line on the card and
  // shouldn't split two people's sentences apart.
  flags.sort((a, b) => (b.reason ? 1 : 0) - (a.reason ? 1 : 0));
  const leftRaters = committee.filter((m) => !m.active && (S.screening[key(m.id, candId)] || {}).rating).length;
  return { flags, ratings, by, notes, avg: avg(ratings), n: ratings.length, of: committee.filter((m) => m.active).length + leftRaters };
}

// Input the committee can no longer see, in the two shapes it actually takes.
//
//   orphan   the roster entry is gone entirely (a hard delete via scripts/)
//   removed  the entry is still there but soft-deleted — which is exactly what
//            a remove-and-re-add leaves behind, and what the orphan check alone
//            MISSES. migrate-candidate.mjs says so in its own header: "the old
//            entry is only soft-deleted (removed:true), so it isn't even
//            detectable as an orphan." That is the case that has really
//            happened here, so it is the case this has to catch.
//
// Admin-only: a reviewer's screening map holds only their own documents, where
// none of this means anything.
function hiddenInput() {
  const byId = new Map(S.candidates.map((c) => [c.id, c]));
  const found = new Map();
  const add = (id, member, what) => {
    const c = byId.get(id);
    if (c && !c.removed) return;                       // visible: nothing hidden
    if (!found.has(id)) {
      found.set(id, { id, name: c ? c.name : "", kind: c ? "removed" : "orphan",
                      members: new Set(), flags: 0, ratings: 0, scores: 0 });
    }
    const e = found.get(id);
    e.members.add(member);
    e[what]++;
  };
  Object.entries(S.screening || {}).forEach(([k, v]) => {
    const i = k.indexOf("~"); if (i < 0 || !v) return;
    if (v.flag) add(k.slice(i + 1), k.slice(0, i), "flags");
    if (v.rating) add(k.slice(i + 1), k.slice(0, i), "ratings");
  });
  Object.entries(S.scores || {}).forEach(([k, v]) => {
    const i = k.indexOf("~"); if (i < 0 || !v || !v.overall) return;
    add(k.slice(i + 1), k.slice(0, i), "scores");
  });

  // Who is this probably now? A remove-and-re-add keeps most of the name, so a
  // live entry sharing the first name or the surname key is the likely target.
  const live = S.candidates.filter((c) => !c.removed);
  // first names with titles dropped ("Dr" matched every applicant before)
  for (const e of found.values()) {
    e.likely = e.name
      ? live.filter((c) => (firstKey(c.name) && firstKey(c.name) === firstKey(e.name))
                        || (lastKey(c.name) && lastKey(c.name) === lastKey(e.name)))
      : [];
  }
  const entries = [...found.values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return { entries, total: entries.reduce((n, e) => n + e.flags + e.ratings + e.scores, 0) };
}

// A reviewer's progress line. Screening now comes back from the server on any
// device (the rules allow a `get` of your own documents), so it is a plain
// count. Scores are different on purpose: a reviewer who could read scores back
// could reconstruct the ranking mid-process, so those stay write-only and are
// replayed from this browser's mirror — which looks blank on a second device
// even though every answer is safely recorded. Say so, rather than let it read
// as lost work.
// It used to be a boxed paragraph at the top of the tab. It is a count — the
// only part anyone reads — with the explanation moved onto the ⓘ, which is
// where a reader asks for it instead of being handed it every visit. Nothing is
// dropped: the write-only story below is the same text, and it still appears in
// full for the one case that could look like lost work.
function myInputNotice(list, get, deviceOnly) {
  if (!list.length || (deviceOnly && !ui.echoOnly)) return "";
  const has = (r) => !!r && !!(r.flag || r.rating || r.overall || String(r.note || "").trim() ||
    (r.notes && Object.values(r.notes).some((t) => String(t || "").trim())));
  const done = list.filter((c) => has(get(c))).length;
  // Only claim "any device" once the server has actually answered. Until the
  // hardened rules are published the read is refused, and promising something
  // the app can't do is worse than saying nothing.
  const anywhere = !store || store.screeningReadBack !== false;
  const why = deviceOnly
    ? "Everything you type is saved to leadership. Scores are deliberately write-only: nobody on the "
      + "committee can read anyone's back, which is what stops the ranking leaking mid-process. This "
      + "browser keeps a copy of your scores so you can see them again here. Logging out clears it. "
      + "On another device they look blank; that is the privacy model, not lost work."
    : anywhere
      ? "Saved to leadership as you tap. Your own flags and ratings follow you: sign in on any device, "
        + "pick your name, and they are here. Only leadership sees everyone's together."
      : "Saved to leadership as you tap. This browser remembers your own answers; on another device "
        + "they will look blank until leadership finishes the setup.";
  return `<p class="progress"><b>${done} of ${list.length}</b> ${deviceOnly ? "scored" : "reviewed"}${infoIcon(why)}</p>`;
}

// ------------------------------------------------------------ 1 · Screen
function renderScreen() {
  const me = ui.member;
  const { pickable: committee, oneDrive } = EFF();   // waiting on = active people only
  const scrOpen = isOpen("screening");
  let html = me ? hint(scrOpen ? "Raise a concern if you feel someone isn't qualified. A note never counts against them. Priority is optional."
    : roundOpen(S.meta) ? "Screening is closed. Your answers are saved." : "Leadership is closing this round. Changes are paused.") : "";

  if (ui.isAdmin) {
    const submitted = new Set();
    Object.keys(S.screening).forEach((k) => { const v = S.screening[k]; if (v && (v.flag || v.rating)) submitted.add(k.split("~")[0]); });
    const notYet = committee.filter((m) => !submitted.has(m.id)).map((m) => m.name);

    // Still-in first, then excluded/removed — that split is the decision, so it
    // holds whichever sort is chosen and excluded people never drift back up
    // into the list you're working. Within each group, your pick.
    //   name   — alphabetical, the order you can predict and scan
    //   rating — highest average priority first; unrated last, because "no
    //            rating" is not a low rating and must not sort as one
    //   flags  — most-flagged first, for working through the exclusions
    const SORTS = { name: "Name", rating: "Avg priority", flags: "Concerns" };
    const sortKey = SORTS[collSort()] ? collSort() : "name";
    const byName = (a, b) => a.name.localeCompare(b.name);
    const cmp = {
      name: byName,
      rating: (a, b) => {
        const x = screenStats(a.id).avg, y = screenStats(b.id).avg;
        if (x == null && y == null) return byName(a, b);
        if (x == null) return 1;
        if (y == null) return -1;
        return y - x || byName(a, b);
      },
      flags: (a, b) => screenStats(b.id).flags.length - screenStats(a.id).flags.length || byName(a, b),
    }[sortKey];
    const ordered = [...S.candidates].sort((a, b) =>
      (isIn(a) === isIn(b) ? 0 : isIn(a) ? -1 : 1) || cmp(a, b));
    const sortBar = `<div class="sortbar"><span class="muted small">Sort by</span>
      <span class="seg" role="group" aria-label="Sort candidates">${Object.entries(SORTS).map(([k, label]) =>
        `<button type="button" class="${k === sortKey ? "on" : ""}" aria-pressed="${k === sortKey}"
          onclick="IV.sortColl('${k}')">${label}</button>`).join("")}</span></div>`;

    const rows = ordered.map((c) => {
      const st = screenStats(c.id);
      const fc = st.flags.length;
      // distinguish admin-removed from flag-excluded, so "restore" isn't a confusing no-op
      // A pill only where the status is NOT the expected one. Seventeen green
      // "interview" pills say nothing and bury the two that matter.
      const th = EFF().threshold, byLead = c.shortlistBy === "leadership";
      const ruleOff = th > 0 && fc >= th;
      const statusPill = c.removed ? '<span class="pill out">Removed</span>'
        : byLead && c.shortlist === "out" ? '<span class="pill out">Taken off by leadership</span>'
        : byLead && c.shortlist === "in" ? (ruleOff ? '<span class="pill neutral">Kept on by leadership</span>' : "")
        : !isIn(c) ? `<span class="pill out">Off the list: ${fc} concern${fc === 1 ? "" : "s"}</span>` : "";
      const listVal = byLead && (c.shortlist === "in" || c.shortlist === "out") ? c.shortlist : "auto";
      const listSeg = c.removed ? "" : `<div class="listseg"><span class="muted small">Interview list</span>
        <span class="seg" role="group" aria-label="Interview list for ${escapeHtml(c.name)}">${[["auto", "Auto"], ["in", "On"], ["out", "Off"]].map(([v, l]) =>
          `<button type="button" class="${listVal === v ? "on" : ""}" aria-pressed="${listVal === v}" onclick="IV.setShortlist('${c.id}','${v}')">${l}</button>`).join("")}</span>
        ${infoIcon(th ? `Auto follows your rule: off the list at ${th} concern${th === 1 ? "" : "s"}. On or Off is your decision and overrides the rule.`
          : "Auto keeps everyone on (your rule is set to 0). On or Off is your decision.")}</div>`;
      const action = (c.removed
        ? `<button class="linky" onclick="IV.removeCand('${c.id}',false)">Restore</button>`
        : `<button class="linky danger" onclick="IV.removeCand('${c.id}',true)">Remove</button>`)
        // H5: rename, merge and permanent delete live behind "More"
        + `<details class="more"><summary class="linky">More</summary><div class="moremenu">
            <button class="linky" onclick="IV.renameCand('${c.id}')">Rename</button>
            <button class="linky" onclick="IV.mergeCand('${c.id}')">Merge into another entry</button>
            ${c.removed ? `<button class="linky danger" onclick="IV.deleteCand('${c.id}')">Delete permanently</button>`
              : `<span class="muted small">Delete permanently: remove them from the list first</span>`}</div></details>`;
      // One line per flagger, attributed and quoted in full. Several people
      // flagging one applicant is the normal case, and each sentence is the
      // thing leadership actually has to weigh.
      const toNote = (f) => `<button type="button" class="linky small" data-m="${escapeHtml(f.id)}" data-c="${c.id}"
          onclick="IV.concernToNote(this.dataset.m,this.dataset.c)">Make this a note</button>`;
      const reasons = fc ? `<ul class="reasons">` + st.flags.map((f) => f.reason
          ? `<li><span class="rwho">${escapeHtml(f.who)}</span><span>${escapeHtml(f.reason)} ${toNote(f)}</span></li>`
          : `<li class="noreason"><span class="rwho">${escapeHtml(f.who)}</span><span>raised a concern without a reason ${toNote(f)}</span></li>`).join("")
        + `</ul>` : "";
      // H7: notes never count; shown under the concerns, attributed
      const notes = st.notes.length ? `<div class="notesh small muted">Notes (don't count)</div><ul class="reasons notes">` + st.notes.map((n) =>
          `<li><span class="rwho">${escapeHtml(n.who)}</span><span>${escapeHtml(n.note)}${n.conflict ? ' <span class="pill neutral">knows them</span>' : ""}</span></li>`).join("") + `</ul>` : "";
      const rateTip = st.n
        ? `Mean of the ${st.n} priority rating${st.n === 1 ? "" : "s"} actually submitted. `
          + `${st.of - st.n} member${st.of - st.n === 1 ? "" : "s"} didn't rate. Non-answers are left out, not counted as a middling score.`
        : "Nobody has given this applicant a priority rating yet.";
      const thin = st.n > 0 && st.n < 3;
      // Who rated, and what. Flags have always been attributed here; ratings
      // were not, so there was no way for a reviewer to ask leadership "is mine
      // recorded?" and get a straight answer. Folded away by default because
      // thirteen names is a lot of line, and a <details> opens on a tap —
      // unlike the hover tooltips, which a phone can never reach.
      const raters = st.n ? `<details class="raters"><summary>${st.n} rating${st.n === 1 ? "" : "s"}</summary>
        <div class="raterlist">${st.by.map((r) =>
          `<span class="ratechip"><span class="rw">${escapeHtml(r.who)}</span><b>${r.rating}</b></span>`).join("")}</div>
        </details>` : "";
      return `<div class="collrow ${!isIn(c) ? "out" : ""}">
        <div class="collhead"><span class="name">${escapeHtml(c.name)}</span>${statusPill}<span class="spacer"></span>${action}</div>
        ${fc || st.n ? `<div class="collmeta">
          ${fc ? `<span class="metric ${ruleOff ? "flagged" : ""}" data-tip="${escapeHtml(st.flags.map((f) => f.who).join(", "))} raised a concern about this applicant.${th ? ` ${th} or more concerns take them off the interview list unless you decide otherwise.` : ""}">
            <b>${fc}</b> concern${fc === 1 ? "" : "s"}</span>` : ""}
          ${st.n ? `<span class="metric" data-tip="${escapeHtml(rateTip)}"><span aria-hidden="true">★</span>
            <b>${st.avg.toFixed(1)}</b>
            <span class="denom ${thin ? "thin" : ""}">from ${st.n} of ${st.of}</span></span>` : ""}
          ${raters}
        </div>` : ""}${reasons}${notes}${listSeg}</div>`;
    }).join("");

    const collation = `${S.candidates.length > 1 ? sortBar : ""}
      <div class="collist">${rows || empty(ICON.list, "No candidates yet", "Add applicants below to start screening.")}</div>
      <p class="toolline"><button class="linky" onclick="IV.exportShortlist()">Export shortlist (CSV)</button></p>`;

    const hidden = hiddenInput();
    const part = (n, w) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");
    const hiddenBlock = !hidden.entries.length ? "" : `<div class="note warnbox" style="margin-top:.8rem">
      <b class="warn">${ICON.warn} ${hidden.total} saved entr${hidden.total === 1 ? "y is" : "ies are"} attached to
      ${hidden.entries.length} applicant${hidden.entries.length === 1 ? "" : "s"} nobody can see.</b>
      That is the footprint of a remove-and-re-add: the new entry gets a new id, and the flags, ratings and
      scores already given stay on the old one. <b>Nothing is lost</b>: it is in the database, just attached
      to an entry the Screen tab doesn't show reviewers.
      ${hidden.entries.map((e) => {
        const bits = [part(e.flags, "concern"), part(e.ratings, "rating"), part(e.scores, "interview score")].filter(Boolean).join(", ");
        const who = [...e.members].map(mname).sort().map((m) => `<span class="chip">${escapeHtml(m)}</span>`).join("");
        const target = e.likely && e.likely.length === 1 ? e.likely[0] : null;
        return `<div class="hidrow">
          <div><b>${escapeHtml(e.name || e.id)}</b>
            <span class="pill out">${e.kind === "removed" ? "Removed" : "No longer on the roster"}</span></div>
          <div class="muted small">${escapeHtml(bits)}, from ${who}</div>
          ${target ? `<div class="small">Looks like the same person as <b>${escapeHtml(target.name)}</b>, who is still on the list.</div>` : ""}
          <div class="row backup-actions" style="margin-top:.4rem">
            ${target ? `<button class="btn tinted small" onclick="IV.mergeCand('${e.id}','${target.id}')">Move these to ${escapeHtml(target.name)}</button>`
              : `<button class="btn tinted small" onclick="IV.mergeCand('${e.id}')">Move these to another entry</button>`}
            <button class="btn ghost small danger" onclick="IV.deleteCand('${e.id}')">Delete permanently</button></div>
        </div>`;
      }).join("")}
      <div class="small" style="margin-top:.5rem">To fix a spelling, use Rename (under More); it keeps everything attached.</div>
    </div>`;
    const nSub = committee.filter((m) => submitted.has(m.id)).length;
    const dash = `<p><b>${nSub}/${committee.length}</b> members have submitted screening.</p>
      ${notYet.length ? `<p class="muted small">Waiting on:</p><div>${notYet.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")}</div>`
        : `<p class="ok small">✓ Everyone has submitted.</p>`}
      ${hiddenBlock}`;

    const adder = `<div class="note">Paste applicant names, one per line, then Add. Stored in your database, never in the app's code.
      To fix a spelling, use Rename. Removing and adding again separates their ratings.</div>
      <textarea id="bulkAdd" rows="4" placeholder="Dr Jane Doe&#10;Dr John Smith" aria-label="New candidate names"></textarea>
      <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.addCands(this)">Add candidates</button></div>`;

    html += section("collation", "Collation & shortlist", `${activeCands().length} of ${S.candidates.length} still in`, collation,
        { open: !me, info: "Everyone's concerns, notes and priority ratings, collated. An applicant drops off the interview list at the number of concerns set in Setup, Screening rule, unless you set them On or Off. Concerns and notes are visible to leadership only. Export the shortlist as a CSV here." })
      + section("dash", "Coordinator dashboard", `${nSub}/${committee.length} submitted`, dash,
        { open: false, info: "Track who has and hasn't submitted their screening, so you can chase people before the deadline.", count: hidden.entries.length ? ICON.warn : null })
      + section("adder", "Add candidates", "", adder,
        { open: false, info: "Paste applicant names to add them to the interview list. Stored securely in your database, never in the app's code. You can add or remove people any time." })
      + (me ? `<h3>Your review</h3>` : "");
  }
  // Signed in as plain admin: there is no "your" review to show or file.
  if (!me) { $("#screen").innerHTML = html; return; }

  // Alphabetical, like the "Who are you?" list: with a dozen-plus names the
  // only ordering a reviewer can navigate is the one they can predict.
  const toReview = S.candidates.filter((c) => !c.removed).sort((a, b) => a.name.localeCompare(b.name));
  html += myInputNotice(toReview, (c) => S.screening[key(me, c.id)]);

  // The link to the applications folder, once, as a line of text. When it isn't
  // set there is nothing here at all: a grey box telling a reviewer that
  // leadership hasn't done something they cannot do themselves is pure noise.
  const docsBar = toReview.length && oneDrive !== "#"
    ? `<p class="docline"><a href="${escapeHtml(oneDrive)}" target="_blank" rel="noopener">CVs &amp; cover letters</a></p>` : "";

  // Seventeen applicants used to be seventeen bordered cards. One list, ruled
  // between rows: the same information, a quarter of the ink, and the eye can
  // follow a column of names instead of hopping between boxes.
  // H4: a closed stage disables every input (disabled + aria-disabled), so no
  // write is even attempted. H7: "Concern" counts; "Note" never does.
  const dis = scrOpen ? "" : ' disabled aria-disabled="true"';
  const rows = toReview.map((c) => {
    const sc = S.screening[key(me, c.id)] || {};
    const flagged = !!sc.flag;
    const noteOpen = !!(ui.noteOpen && ui.noteOpen[c.id]) || !!String(sc.note || "").trim();
    return `<div class="rrow${flagged ? " flagged" : ""}">
      <div class="row center"><div class="grow name">${escapeHtml(c.name)}</div>
        <div class="rate" role="group" aria-label="Priority rating for ${escapeHtml(c.name)}">${[1, 2, 3, 4, 5].map((n) => `<button class="${sc.rating === n ? "on" : ""}" aria-pressed="${sc.rating === n}" onclick="IV.rate('${c.id}',${n})"${dis}>${n}</button>`).join("")}</div>
        <button class="flagbtn ${flagged ? "on" : ""}" aria-pressed="${flagged}" aria-label="Concern about ${escapeHtml(c.name)}" onclick="IV.toggleFlag('${c.id}')"${dis}>${flagged ? `${ICON.flag} Concern` : "Concern"}</button>
        <button class="flagbtn notebtn ${noteOpen ? "on" : ""}" aria-pressed="${noteOpen}" aria-label="Note about ${escapeHtml(c.name)}" onclick="IV.toggleNote('${c.id}')"${dis}>Note</button></div>
      ${flagged ? `<textarea id="rsn-${c.id}" placeholder="What is the concern? (leadership only)" aria-label="What is the concern?"${dis}>${escapeHtml(sc.reason || "")}</textarea>
        ${scrOpen ? `<div style="margin-top:.4rem"><button class="savebtn" onclick="IV.saveReason('${c.id}',this)">Save concern</button></div>` : ""}` : ""}
      ${noteOpen ? `<textarea id="note-s-${c.id}" maxlength="2000" placeholder="Your note (leadership only). It never counts against the applicant." aria-label="Your note"${dis}>${escapeHtml(sc.note || "")}</textarea>
        <label class="small knows"><input type="checkbox" id="knows-${c.id}" ${sc.conflict ? "checked" : ""}${dis}/> I know this applicant personally</label>
        ${scrOpen ? `<div style="margin-top:.4rem"><button class="savebtn" onclick="IV.saveNote('${c.id}',this)">Save note</button></div>` : ""}` : ""}
    </div>`;
  }).join("");

  html += docsBar + (rows ? `<div class="card flush list">${rows}</div>`
    : ui.isAdmin ? "" : empty(ICON.list, "Nothing to screen yet", "Applicants will appear here once leadership adds them."));
  $("#screen").innerHTML = html;
}

// ------------------------------------------------------ shared slot control
// one row per time, grouped under a date heading; buttons carry the time's id
function slotRows(slots, map, handler, disabled = false) {
  const dis = disabled ? ' disabled aria-disabled="true"' : "";
  const seg = (id, v, l, cur) => `<button class="${cur === v ? "on " + v : ""}" aria-pressed="${cur === v}" onclick="${handler}('${id}','${v}')"${dis}>${l}</button>`;
  return groupByDate(slots).map((g) => `<div class="slotday">${escapeHtml(g.title)}</div>` + g.items.map((t) => {
    const cur = map[t.id], label = slotTimeLabel(t);
    return `<div class="slabel">${escapeHtml(label)}</div><div><span class="seg" role="group" aria-label="${escapeHtml(slotLabel(t))}">${seg(t.id, "ip", "In person", cur)}${seg(t.id, "zoom", "Zoom", cur)}${seg(t.id, "either", "Either", cur)}</span></div>`;
  }).join("")).join("");
}

// ------------------------------------------- availability at a glance (grid)
// One row per interview time, one column per interviewer, so "who can do when"
// is a single look instead of thirteen separate lists.
//
// Three things are encoded per cell, deliberately not by colour alone (a letter
// carries the same information for anyone who can't separate the hues):
//   P in person · Z Zoom · E either · blank not available
//
// The right-hand column answers the question the grid is actually for: can a
// panel run at this time? That is computed with buildPanel — the same function
// the Panels tab uses — so the two can never disagree about the rules.
function availGrid() {
  const { interviewers: committee, slots, chair, nameOf } = EFF();
  if (!slots.length || !committee.length) return "";

  // Chair first (every panel needs them), then alphabetical.
  const people = [...committee].sort((a, b) =>
    a.id === chair ? -1 : b.id === chair ? 1 : a.name.localeCompare(b.name));

  // buildPanel wants { g, avail }; the roster stores the field as `gender`
  // (same mapping as renderPanels, see the interviewers object there).
  const ivMap = {};
  for (const m of committee) ivMap[m.id] = { g: m.gender, avail: S.availIv[m.id] || {} };

  const GLYPH = { ip: "P", zoom: "Z", either: "E" };
  const WORD = { ip: "in person", zoom: "Zoom", either: "either" };

  const head = `<tr><th class="tlab">Time</th>` +
    people.map((m) => `<th class="ivcol"><span data-tip="${escapeHtml(m.name)}${m.id === chair ? " (chair)" : ""}">` +
      `${escapeHtml(m.name)}${m.id === chair ? " ★" : ""}</span></th>`).join("") +
    `<th class="sum" data-tip="Whether a balanced panel can be formed at this time">Panel</th>` +
    `<th class="pad" aria-hidden="true"></th></tr>`;

  const body = groupByDate(slots).map((g) =>
    `<tr class="dayrow"><td colspan="${people.length + 3}">${escapeHtml(g.title)}</td></tr>` +
    g.items.map((t) => {
      const cells = people.map((m) => {
        const v = (S.availIv[m.id] || {})[t.id];
        return v
          ? `<td class="av ${v}" data-tip="${escapeHtml(m.name)} · ${WORD[v]}">${GLYPH[v]}</td>`
          : `<td class="av no" data-tip="${escapeHtml(m.name)} · not available"></td>`;
      }).join("");
      const n = people.filter((m) => (S.availIv[m.id] || {})[t.id]).length;
      // A panel needs the chair, 3–5 people and a gender mix; ask buildPanel
      // rather than guessing from the count, which would be wrong and look right.
      const ok = buildPanel(t.id, "ip", ivMap, chair) || buildPanel(t.id, "zoom", ivMap, chair);
      const why = ok ? `A panel can run at this time (${n} available)`
        : n === 0 ? "Nobody has said they can do this time"
        : !(S.availIv[chair] || {})[t.id] ? `${nameOf(chair)} (chair) isn't available, so no panel can run`
        : `${n} available, but not a combination that makes a balanced panel`;
      return `<tr><th class="tlab">${escapeHtml(slotTimeLabel(t))}</th>${cells}` +
        `<td class="sum ${ok ? "yes" : "nope"}" data-tip="${escapeHtml(why)}">${n}${ok ? " ✓" : " ✗"}</td>` +
        `<td class="pad"></td></tr>`;
    }).join("")).join("");

  const legend = `<div class="glegend">
    <span><i class="sw ip">P</i> in person</span><span><i class="sw zoom">Z</i> Zoom</span>
    <span><i class="sw either">E</i> either</span><span><i class="sw no"></i> not available</span>
    <span class="muted small">★ chair · hover any square for the name</span></div>`;

  return `<div class="gridwrap"><table class="avgrid"><thead>${head}</thead><tbody>${body}</tbody></table></div>${legend}`;
}

// ------------------------------------- applicant availability at a glance
// The mirror of availGrid() for the other side of the room, admin only.
//
// Until this existed the only thing the tool said about applicant availability
// was a count — "3 of 17 submitted" — and the only way to see WHICH times
// somebody had offered was to open the panel editor for that one person. So
// the question every coordinator actually has ("where should I add a time?")
// could not be answered from the screen at all.
//
// Rows are times and columns are applicants, so a row reads as demand for that
// hour. The schedule is drawn on top of it: the one applicant who gets each
// hour has a ringed cell, which makes the crowding visible — five letters in a
// row and one ring is exactly why the other four are under "needs attention".
// Letters carry the meaning, never colour alone, and the ring is a shape, so
// the grid still reads without colour vision.
function candGrid() {
  const { slots, interviewers: committee, chair } = EFF();
  const surnameOf = (n) => String(n || "").trim().split(/\s+/).pop();
  const people = activeCands().slice()
    .sort((a, b) => surnameOf(a.name).localeCompare(surnameOf(b.name)) || a.name.localeCompare(b.name));
  if (!slots.length || !people.length) return "";

  const ivMap = {};
  for (const m of committee) ivMap[m.id] = { g: m.gender, avail: S.availIv[m.id] || {} };
  const canRun = (id) => !!(buildPanel(id, "ip", ivMap, chair) || buildPanel(id, "zoom", ivMap, chair));
  // where each applicant currently sits — auto or hand-built. Wrapped because
  // this grid must still draw if panel building throws for any reason.
  let bookedAt = {}, scheduled = 0, why = {};
  try {
    const res = computePanels();
    res.panels.forEach((p) => { bookedAt[p.cand] = String(p.slot); });
    scheduled = res.panels.length;
    why = res.why || {};
  } catch { bookedAt = {}; scheduled = 0; why = {}; }

  const GLYPH = { ip: "P", zoom: "Z", either: "E" };
  const WORD = { ip: "in person", zoom: "Zoom", either: "either" };
  const answers = (c) => liveAnswers(availForCand(c)).length;

  const head = `<tr><th class="tlab">Time</th>` +
    people.map((c) => {
      const n = answers(c);
      return `<th class="ivcol"><span data-tip="${escapeHtml(c.name)}${n ? ` · free for ${n} time${n === 1 ? "" : "s"}` : " · hasn't sent availability"}">` +
        `${escapeHtml(surnameOf(c.name))}</span></th>`;
    }).join("") +
    `<th class="sum" data-tip="How many applicants can do this time, and whether a balanced panel could run then. Green means both: an hour that can actually hold an interview.">Usable</th>` +
    `<th class="pad" aria-hidden="true"></th></tr>`;

  const body = groupByDate(slots).map((g) =>
    `<tr class="dayrow"><td colspan="${people.length + 3}">${escapeHtml(g.title)}</td></tr>` +
    g.items.map((t) => {
      const cells = people.map((c) => {
        const v = availForCand(c)[t.id];
        const booked = bookedAt[c.id] === t.id;
        const tip = `${escapeHtml(c.name)} · ${v ? WORD[v] : "not available"}${booked ? " · interviewing at this time" : ""}`;
        return v
          ? `<td class="av ${v}${booked ? " booked" : ""}" data-tip="${tip}">${GLYPH[v]}</td>`
          : `<td class="av no" data-tip="${tip}"></td>`;
      }).join("");
      const n = people.filter((c) => availForCand(c)[t.id]).length;
      const panelOk = canRun(t.id);
      // Red is reserved for what the coordinator can act on: an hour applicants
      // WANT that no panel can staff. An hour nobody has asked for yet is not a
      // problem — during collection most hours look like that, and painting
      // them red would make the whole grid cry wolf.
      const tone = n === 0 ? "idle" : panelOk ? "yes" : "nope";
      const note = n === 0
        ? `Nobody has offered this time yet${panelOk ? ", but a panel could run here if someone does" : ", and no balanced panel could run here as things stand"}`
        : !panelOk ? `${n} applicant${n === 1 ? "" : "s"} could come, but no balanced panel can run then, so this hour is unusable until more interviewers are free`
        : `${n} applicant${n === 1 ? "" : "s"} could come and a panel can run. One of them gets it`;
      return `<tr><th class="tlab">${escapeHtml(slotTimeLabel(t))}</th>${cells}` +
        `<td class="sum ${tone}" data-tip="${escapeHtml(note)}">${n}${panelOk ? " ✓" : " ✗"}</td>` +
        `<td class="pad"></td></tr>`;
    }).join("")).join("");

  // one number per applicant: how many times they offered. A dash is the
  // fastest way to see who still has to be chased.
  const foot = `<tr class="footrow"><th class="tlab">Times offered</th>` +
    people.map((c) => { const n = answers(c);
      return `<td class="tot ${n ? "" : "none"}" data-tip="${escapeHtml(c.name)}">${n || "-"}</td>`; }).join("") +
    `<td class="sum idle"></td><td class="pad"></td></tr>`;

  // Who can't be scheduled, and why — one line per cause, because the three
  // causes take three different actions and a bare shortfall number implies the
  // wrong one (add times) for two of them.
  const usable = slots.filter((t) => canRun(t.id)).length;
  const missed = people.filter((c) => !bookedAt[c.id]);
  const count = (r) => missed.filter((c) => (why[c.id] || {}).reason === r).length;
  const nAnswer = count("no-answer"), nPanel = count("no-panel"), nTaken = count("contested");
  const causes = [
    nAnswer && `<li><b>${nAnswer}</b> ${nAnswer === 1 ? "hasn't" : "haven't"} sent any availability yet. Chase ${nAnswer === 1 ? "them" : "those"} first (they're the dashes below).</li>`,
    nPanel && `<li><b>${nPanel}</b> offered only times where no balanced panel can run (the ✗ rows). More interviewers free at those hours is what fixes it.</li>`,
    nTaken && `<li><b>${nTaken}</b> want times that are already taken. <b>This is the one more interview times would fix.</b></li>`,
  ].filter(Boolean).join("");
  const capacity = missed.length && causes     // no causes at all = panel building failed; say nothing
    ? `<div class="note warnbox"><b class="warn">${ICON.warn} ${scheduled} of ${people.length} applicants can be
        interviewed in the ${usable} usable time${usable === 1 ? "" : "s"} you have.</b>
        <ul class="small" style="margin:.4rem 0 0">${causes}</ul></div>`
    : "";

  const legend = `<div class="glegend">
    <span><i class="sw ip">P</i> in person</span><span><i class="sw zoom">Z</i> Zoom</span>
    <span><i class="sw either">E</i> either</span><span><i class="sw no"></i> not available</span>
    <span><i class="sw either booked">E</i> interviewing then</span>
    <span class="muted small">hover any square for the name</span></div>`;

  return `${capacity}
    <div class="gridwrap"><table class="avgrid demand"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>${legend}`;
}

// ------------------------------------------------------ 2 · Availability
function renderAvailability() {
  const map = S.availIv[ui.member] || {};
  const slots = EFF().slots;
  const mine = isInterviewer(ui.member), avOpen = isOpen("availability");
  let html = mine ? hint(avOpen ? "Tap how you can do each time you're free. Tap again to clear."
    : roundOpen(S.meta) ? "Availability is closed. Your answers are saved." : "Leadership is closing this round. Changes are paused.") : "";
  html += slots.length
    ? (mine ? `<div class="card"><div class="slotgrid">${slotRows(slots, map, "IV.avail", !avOpen)}</div></div>` : "")
    : empty(ICON.calendar, "No interview times yet", ui.isAdmin ? "Add interview times in Setup (the gear icon)." : "Leadership hasn't published the interview times yet. Check back soon.");

  // There used to be three sections here — both grids and a separate
  // "Availability dashboard" whose whole content was who hadn't answered. That
  // is one line per grid, so it lives in the grid it is about, and the section
  // is gone. Each header carries its own count, so a closed section still
  // answers "how far along is this?" without being opened.
  const { interviewers: committee } = EFF();
  const ivIn = committee.filter((m) => liveAnswers(S.availIv[m.id]).length).length;
  const waiting = (names, kind) => names.length
    ? `<p class="small muted" style="margin-top:.7rem">Waiting on ${names.map((n) => escapeHtml(n)).join(", ")}</p>`
      + (ui.isAdmin && kind ? `<p class="toolline"><button class="linky small" onclick="IV.emailWaiting('${kind}')">Email who we're waiting on</button></p>` : "")
    : `<p class="small ok" style="margin-top:.7rem">✓ Everyone has answered</p>`;

  const grid = availGrid();
  if (grid) {
    const ivNot = committee.filter((m) => !liveAnswers(S.availIv[m.id]).length).map((m) => m.name);
    html += section("avgrid", "Who's available when", `${ivIn} of ${committee.length} interviewers`,
      grid + waiting(ivNot, "iv"),
      { open: !ui.isAdmin || !ui.member,
        info: "Every interviewer against every interview time. The Panel column says whether a balanced panel could actually run then. It uses the same rules as the Panels tab, so a ✓ there means a panel really is possible." });
  }

  if (ui.isAdmin) {
    const cands = activeCands();
    const candIn = cands.filter((c) => liveAnswers(availForCand(c)).length).length;
    const candNot = cands.filter((c) => !liveAnswers(availForCand(c)).length).map((c) => c.name);
    const cg = candGrid();
    const confirmLine = S.schedule && S.schedule.publishedAt
      ? `<p class="toolline"><button class="linky small" onclick="IV.emailWaiting('confirm')">Applicants who haven't confirmed</button></p>` : "";
    if (cg) html += section("candgrid", "When can the applicants come", `${candIn} of ${cands.length} applicants`,
      cg + waiting(candNot, "apps") + confirmLine,
      { open: true,
        info: "Every applicant against every interview time, with the interview each one is currently scheduled for ringed. The Usable column shows how many applicants offered that hour and whether a balanced panel could run then, which shows where to add times." });
  }
  $("#availability").innerHTML = html;
}

// ------------------------------------------------------------- 3 · Score
function renderScore() {
  // H9: once the schedule is locked, "Your interviews" only (applicants whose
  // locked panel includes you), with a quiet link to show everyone. Before
  // that, everyone on the interview list. Nobody is ever pre-selected.
  const all = activeCands().slice().sort((a, b) => a.name.localeCompare(b.name));
  const lockedNow = locked();
  const mine = lockedNow ? all.filter((c) => { const p = (S.schedule.panels || {})[c.id]; return p && (p.members || []).includes(ui.member); }) : all;
  const list = !lockedNow || ui.scoreAll ? all : mine;
  const scOpen = isOpen("scoring");
  const toggle = lockedNow ? `<p class="toolline scoretoggle"><button class="linky" onclick="IV.scoreShowAll(${ui.scoreAll ? "false" : "true"})">${ui.scoreAll ? "Show only my interviews" : "Show all applicants"}</button></p>` : "";
  const head = hint(!scOpen ? (roundOpen(S.meta) ? "Scoring is closed. Your answers are saved." : "Leadership is closing this round. Changes are paused.")
    : lockedNow ? "Notes per question, then one overall rating." : "Notes per question, then one overall rating. The schedule isn't final yet, so everyone is listed.");
  const dis = scOpen ? "" : ' disabled aria-disabled="true"';
  // Questions by id, in the saved order (H2). Notes are keyed by question id;
  // legacy ids are "0".."9", exactly the keys every older note already has.
  const QQ = Q(), QUESTIONS = liveQuestions(QQ), SCALE = QQ ? QQ.scale : [], GUIDE = QQ ? QQ.guide : [];
  if (!QUESTIONS.length) { delete $("#score").dataset.sig; $("#score").innerHTML = head + empty(ICON.star, "No questions yet", "The interview questions aren't set up yet."); return; }
  if (!list.length) {
    delete $("#score").dataset.sig;
    $("#score").innerHTML = head + (lockedNow && !ui.scoreAll && all.length
      ? `<div class="card">${empty(ICON.star, "No interviews for you", "You have no interviews on the schedule.")}</div>${toggle}`
      : empty(ICON.star, "No candidates to score", "Candidates on the interview list will appear here."));
    return;
  }
  if (ui.scoreCand && !list.some((c) => c.id === ui.scoreCand)) ui.scoreCand = null;
  const me = ui.member, cid = ui.scoreCand;
  const rec = cid ? myScore(me, cid) : { notes: {} };
  const scored = (c) => !!myScore(me, c.id).overall;
  const at = cid ? list.findIndex((c) => c.id === cid) : -1;
  // with nothing chosen, › picks the first and ‹ does nothing
  const jump = (d) => { const t = at < 0 ? (d > 0 ? list[0] : null) : list[at + d]; return t
    ? `<button class="btn ghost small" onclick="IV.pickScore('${t.id}')" aria-label="${d < 0 ? "Previous" : "Next"} candidate: ${escapeHtml(t.name)}">${d < 0 ? ICON.prev : ICON.next}</button>`
    : `<button class="btn ghost small" disabled aria-hidden="true">${d < 0 ? ICON.prev : ICON.next}</button>`; };
  // A "scored" tick in the picker turns thirteen identical names into a
  // progress list — the reviewer can see at a glance who they still owe.
  // One card for the whole interview — picker, questions, rating — ruled
  // between the parts instead of five separate boxes with five borders. The
  // full 1–5 scale is on the ⓘ; the label for the score you actually gave is
  // printed under the buttons, which is the only one that matters at the time.
  const scaleText = SCALE.map((s, i) => `${i + 1}: ${s}`).join(" · ");
  const ov = rec.overall ? fmtScore(rec.overall) : "";
  const label = ov && Number.isInteger(rec.overall) ? `${ov}: ${SCALE[rec.overall - 1] || ""}` : "";
  // Every store emit (a note's own save, any snapshot) lands here. While it's
  // still the same person scoring the same candidate, UPDATE the page in place
  // instead of rebuilding it: a rebuild throws away the field being typed in,
  // eats the tap on ‹ › that triggered a save (the button is replaced between
  // press and release), and — when it tried to carry typing across — carried a
  // note into the NEXT candidate's box. A change of candidate or person always
  // rebuilds, so nothing typed for one can ever appear under another.
  const root = $("#score");
  // the wording, scale and guidance count too: an edit in Setup redraws the tab
  // (flushing anything still pausing first), never leaves the old text up
  const sig = [me, cid || "", list.map((c) => c.id).join(","), QUESTIONS.map((q) => q.id).join(","), SCALE.length, scOpen, !!ui.scoreAll,
    hashOf({ t: QUESTIONS.map((q) => q.text), s: SCALE, g: GUIDE })].join("|");
  // About to rebuild: land anything still pausing first, then start over so
  // `rec` is read after it (the saves may already have re-entered here).
  if (root.dataset.sig !== sig && flushPending()) return renderScore();
  if (root.dataset.sig === sig && !cid && $("#scorePick")) {
    $("#scoreNotice").innerHTML = myInputNotice(list, (c) => myScore(me, c.id), true);
    return;
  }
  if (root.dataset.sig === sig && $("#overallIn")) {
    const act = document.activeElement;
    $("#scoreNotice").innerHTML = myInputNotice(list, (c) => myScore(me, c.id), true);
    root.querySelectorAll(".scorebar option").forEach((o) => {
      const c = list.find((x) => x.id === o.value);
      if (c) o.textContent = c.name + (scored(c) ? " ✓" : "");
    });
    QUESTIONS.forEach((q) => {
      const t = $("#note-" + q.id), saved = (rec.notes || {})[q.id] || "";
      // not one whose save is still waiting out its pause: its box is NEWER
      // than the saved copy, and typing into a reverted box would save it short
      if (t !== act && !noteTimers[cid + ":" + q.id] && t.value !== saved) t.value = saved;
      t.closest(".qrow").classList.toggle("done", !!String(t.value).trim());
    });
    const box = $("#overallIn");
    if (box !== act) { box.value = ov; $("#overallMsg").textContent = label; }
    return;
  }
  root.dataset.sig = sig;
  const picker = `<div class="prow scorebar"><div class="row center">
        <select id="scorePick" class="grow" onchange="IV.pickScore(this.value)" aria-label="Candidate to score">
          <option value="" disabled ${cid ? "" : "selected"}>Choose an applicant</option>${list.map((c) =>
          `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${escapeHtml(c.name)}${scored(c) ? " ✓" : ""}</option>`).join("")}</select>
        <span class="scorenav">${jump(-1)}${jump(1)}</span></div></div>`;
  if (!cid) {
    root.innerHTML = head + `<div id="scoreNotice">${myInputNotice(list, (c) => myScore(me, c.id), true)}</div>`
      + `<div class="card flush list">${picker}</div>${toggle}`;
    return;
  }
  const cname = (cand(cid) || {}).name || "";
  root.innerHTML = head
    + `<div id="scoreNotice">${myInputNotice(list, (c) => myScore(me, c.id), true)}</div>`
    + `<div class="card flush list">
      ${picker}
      ${QUESTIONS.map((q, i) => {
        const filled = String((rec.notes || {})[q.id] || "").trim();
        // numbered from 1 for the human reading it; the note itself is keyed by
        // the question's id, so reordering or adding questions moves nothing.
        return `<div class="prow qrow ${filled ? "done" : ""}"><div class="q">${escapeHtml(q.text)}</div>
          <textarea id="note-${q.id}" oninput="IV.note('${q.id}',this.value)" placeholder="Notes" aria-label="Notes for question ${i + 1}"${dis}>${escapeHtml((rec.notes || {})[q.id] || "")}</textarea></div>`;
      }).join("")}
      <div class="prow"><div class="row center"><label class="grow name" for="overallIn">Overall rating for ${escapeHtml(cname)}${infoIcon(scaleText)}</label>
        <span class="overall"><input id="overallIn" type="text" inputmode="decimal" autocomplete="off" placeholder="1.0–5.0" value="${ov}"
          data-me="${escapeHtml(me)}" data-cid="${escapeHtml(cid)}" aria-describedby="overallMsg"
          oninput="IV.scoreTyped(this.value,this.dataset)" onblur="IV.score(this.value,this.dataset)" onkeydown="if(event.key==='Enter')this.blur()"${dis}/><span class="muted">/ 5</span></span></div>
        <div id="overallMsg" class="small muted" style="margin-top:.45rem">${escapeHtml(label)}</div></div>
    </div>
    ${toggle}
    ${GUIDE.length ? section("guide", "Guidance for panelists", "", `<ul class="small">${GUIDE.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`) : ""}`;
}

// Interview scores are 1–5 to one decimal (4.7). Older scores are whole numbers
// and stay valid as they are — no migration; they just print as "4.0".
function fmtScore(v) { return Number(v).toFixed(1); }
// "" → 0 (clears, same as un-tapping the old buttons); null → not a valid score.
function parseScore(raw) {
  const t = String(raw || "").trim().replace(",", ".");
  if (!t) return 0;
  if (!/^\d(\.(\d0*)?)?$/.test(t)) return null;   // "4." is 4, "4.50" is 4.5; "4.75" is refused
  const v = Number(t);
  return v >= 1 && v <= 5 ? v : null;
}

// ------------------------------------------------------ 4 · Panels (admin)
// validate a panel's members against the current committee (size, chair present,
// balanced = ≥1 who identifies female + ≥1 male). Returns flags + warnings.
function validatePanel(members, slot, modality, room = 1) {
  const { interviewers: committee, nameOf } = EFF();
  // H13: the chair this panel needs (the day's chair, the room-2 lead, or none)
  const chair = slot == null ? EFF().chair : EFF().chairFor(slot, room);
  const gmap = {}; committee.forEach((m) => { gmap[m.id] = m.gender; });
  const present = members.filter((m) => gmap[m]);            // still on the committee
  const size = present.length, sizeOk = size >= 3 && size <= 5;
  const chairOk = chair === null || present.includes(chair);
  const balanced = present.some((m) => gmap[m] === "F") && present.some((m) => gmap[m] === "M");
  const warns = [];
  if (!chairOk) warns.push("chair not on panel");
  if (!balanced) warns.push("not a balanced panel");
  if (!sizeOk) warns.push(size < 3 ? "fewer than 3 members" : "more than 5 members");
  if (members.length !== present.length) warns.push("has members no longer on the committee");
  // availability sanity for the chosen slot/modality.
  // "Hasn't answered at all" is the more serious case and used to pass in
  // silence: the check only fired when someone had answered with the WRONG
  // modality, so `av === undefined` — a panellist who never said they could
  // make that time — produced no warning on a hand-built panel. The auto
  // builder can't do this (buildPanel only picks from people who answered),
  // so it only ever hid a manual mistake, which is exactly the one nothing
  // else catches.
  if (slot != null) present.forEach((m) => {
    const av = (S.availIv[m] || {})[String(slot)];
    if (av === undefined) warns.push(`${nameOf(m)} hasn't said they can do that time`);
    else if (modality && !(av === "either" || av === modality)) warns.push(`${nameOf(m)} can't do ${modality} that time`);
  });
  return { ok: sizeOk && chairOk && balanced && members.length === present.length && !warns.length, sizeOk, chairOk, balanced, size, warns };
}

// remap saved overrides' member lists (e.g. after chair/committee change)
function pruneOverrides(overrides, mapMembers) {
  const out = {};
  Object.entries(overrides || {}).forEach(([cid, ov]) => {
    if (!ov || !ov.members) return;
    out[cid] = { ...ov, members: mapMembers(ov.members) };
  });
  return out;
}

// merge the auto-proposal with any manual overrides the admin has saved
function computePanels() {
  const { interviewers: committee, chair, slotIds, overrides } = EFF();
  const interviewers = {};
  committee.forEach((c) => { interviewers[c.id] = { g: c.gender, avail: S.availIv[c.id] || {} }; });
  if (locked()) return lockedPanels(interviewers);
  const candidates = {};
  activeCands().forEach((c) => { candidates[c.id] = { avail: availForCand(c) }; });
  const eff = EFF();
  const res = roomsInUse() ? autoPanels(candidates, interviewers, slotIds, eff.chairFor, { rooms: eff.rooms })
    : autoPanels(candidates, interviewers, slotIds, chair);
  // apply overrides: {candId:{slot,members,modality}}. An override may schedule an
  // otherwise-unschedulable candidate, or replace an auto panel. Overrides are
  // re-validated (never trusted blindly) and stale members are dropped.
  const byCand = {};
  res.panels.forEach((p) => { byCand[p.cand] = { room: 1, chair: eff.chairFor(p.slot, 1), ...p, valid: validatePanel(p.members, p.slot, p.modality, p.room || 1) }; });
  let unsched = res.unschedulable.slice();
  const lostTime = []; // manual panels whose time was removed → fall back to auto
  Object.entries(overrides).forEach(([cid, ov]) => {
    if (!activeCands().some((c) => c.id === cid)) return;
    if (!ov || !ov.members || !ov.members.length) return;
    if (!slotIds.includes(String(ov.slot))) { lostTime.push(cid); return; }
    const avail = candidates[cid] ? candidates[cid].avail : {};
    // always include the chair this panel needs; keep only current committee members
    const names = new Set(committee.map((m) => m.id));
    const room = ov.room === 2 && eff.rooms[String(ov.slot)] === 2 ? 2 : 1;
    const ch = eff.chairFor(ov.slot, room);
    let members = ov.members.filter((m) => names.has(m));
    if (ch !== null && names.has(ch) && !members.includes(ch)) members = [ch, ...members];
    const modality = ov.modality || (avail[ov.slot] === "zoom" ? "zoom" : avail[ov.slot] === "ip" ? "ip" : "ip");
    byCand[cid] = { cand: cid, slot: ov.slot, room, chair: ch, members, modality, manual: true, valid: validatePanel(members, ov.slot, modality, room) };
    unsched = unsched.filter((x) => x !== cid);
  });
  const panels = Object.values(byCand).sort((a, b) => slotIds.indexOf(a.slot) - slotIds.indexOf(b.slot) || (a.room || 1) - (b.room || 1));
  // Two candidates at one time. The auto-matcher cannot produce this — it
  // matches one candidate per slot by construction — but a manual override can,
  // and nothing else notices: validatePanel only ever sees one panel. Left
  // unsaid, it surfaces as two applicants turning up for the same hour.
  const bySlot = {};
  panels.forEach((p) => { (bySlot[String(p.slot)] = bySlot[String(p.slot)] || []).push(p); });
  // H13: more applicants than rooms at a time, or two panels in the same room
  const doubleBooked = Object.entries(bySlot).filter(([slot, ps]) => ps.length > (eff.rooms[slot] || 1)
      || new Set(ps.map((p) => p.room || 1)).size < ps.length)
    .map(([slot, ps]) => ({ slot, cands: ps.map((p) => p.cand) }));
  // H13: one person on both rooms' panels at once
  const bothRooms = Object.entries(bySlot).filter(([, ps]) => ps.length > 1).map(([slot, ps]) => {
    const seen = new Set(), twice = new Set();
    ps.forEach((p) => p.members.forEach((m) => { if (seen.has(m)) twice.add(m); seen.add(m); }));
    return { slot, members: [...twice] };
  }).filter((x) => x.members.length);
  return { panels, unschedulable: unsched, understaffed: res.understaffed, interviewers, lostTime,
           doubleBooked, bothRooms, panelSize: res.panelSize, why: res.why || {} };
}

// H4: once the schedule is locked, panels come from interviews_meta/schedule
// (re-validated, never trusted), nothing is computed automatically, and the
// changes that would have moved a panel are named instead.
function lockedPanels(interviewers) {
  const { slotIds, committee, nameOf } = EFF();
  const active = new Set(activeCands().map((c) => c.id));
  const panels = [], lostTime = [], notFree = [], leftOn = {};
  Object.entries((S.schedule && S.schedule.panels) || {}).forEach(([cid, p]) => {
    if (!active.has(cid) || !p || !p.members) return;
    if (!slotIds.includes(String(p.slot))) { lostTime.push(cid); return; }
    panels.push({ cand: cid, slot: String(p.slot), room: p.room || 1, chair: p.chair, members: p.members.slice(),
      modality: p.modality, locked: true, valid: validatePanel(p.members, p.slot, p.modality, p.room || 1) });
    p.members.forEach((m) => {
      const who = committee.find((x) => x.id === m);
      if (!who || !who.active || who.role !== "interviewer") { leftOn[m] = (leftOn[m] || 0) + 1; return; }
      const av = (S.availIv[m] || {})[String(p.slot)];
      if (av === undefined || !(av === "either" || av === p.modality)) notFree.push({ member: m, cand: cid });
    });
  });
  panels.sort((a, b) => slotIds.indexOf(a.slot) - slotIds.indexOf(b.slot));
  const unschedulable = activeCands().filter((c) => !panels.some((p) => p.cand === c.id)).map((c) => c.id);
  const why = Object.fromEntries(unschedulable.map((id) => [id, { reason: "locked", slots: [] }]));
  const bySlot = {};
  panels.forEach((p) => { (bySlot[p.slot] = bySlot[p.slot] || []).push(p); });
  const rooms = EFF().rooms;
  const doubleBooked = Object.entries(bySlot).filter(([slot, ps]) => ps.length > (rooms[slot] || 1) || new Set(ps.map((p) => p.room || 1)).size < ps.length)
    .map(([slot, ps]) => ({ slot, cands: ps.map((p) => p.cand) }));
  const bothRooms = Object.entries(bySlot).filter(([, ps]) => ps.length > 1).map(([slot, ps]) => {
    const seen = new Set(), twice = new Set();
    ps.forEach((p) => p.members.forEach((m) => { if (seen.has(m)) twice.add(m); seen.add(m); }));
    return { slot, members: [...twice] };
  }).filter((x) => x.members.length);
  return { panels, unschedulable, understaffed: [], interviewers, lostTime, doubleBooked, bothRooms,
    panelSize: Math.max(3, ...panels.map((p) => p.members.length)), why,
    lockIssues: { notFree, left: Object.entries(leftOn).map(([member, n]) => ({ member, n, name: nameOf(member) })) } };
}

// Why an interviewer is on no panel — again three cases with three different
// fixes. The line used to guess ("almost always because they haven't sent their
// availability"), which sends the coordinator to chase someone who answered
// days ago: the real reason can just as easily be that every panel they could
// have joined was full by the time their turn came.
function idleInterviewers(unused, res) {
  const group = { silent: [], wrongTimes: [], squeezed: [] };
  unused.forEach((name) => {
    const mine = S.availIv[name] || {};
    // Could they have sat on a panel that was actually booked? Saying "free at
    // that time" is not enough: someone who can only do 10am by Zoom cannot sit
    // on the in-person panel booked then, and telling them otherwise is how
    // this line got it wrong before.
    const couldHaveSat = res.panels.some((p) => {
      const av = mine[String(p.slot)];
      return av !== undefined && (av === "either" || av === p.modality);
    });
    if (!liveAnswers(mine).length) group.silent.push(name);
    else if (!couldHaveSat) group.wrongTimes.push(name);
    else group.squeezed.push(name);
  });
  // The lines have to read for one name as well as five, so each tail is a
  // clause with no subject and no number of its own.
  const chips = (list) => list.map((x) => `<span class="chip">${escapeHtml(mname(x))}</span>`).join("");
  const line = (list, tail) => list.length
    ? `<p class="small" style="margin-top:.45rem">${chips(list)}: ${tail}</p>` : "";
  return `<p class="small" style="margin-top:.55rem"><b class="warn">${ICON.warn} Not on any panel:</b></p>
    ${line(group.silent, "no availability sent yet.")}
    ${line(group.wrongTimes, `free only at times nobody is being interviewed in, or only in a format
      (in person / Zoom) the interviews booked then aren't running in.`)}
    ${line(group.squeezed, `free while interviews are running, but every panel they could have joined
      is full, and taking a seat there would either unbalance that panel or leave somebody else with
      nothing. Another interview time at a time they are free is what fixes this.`)}`;
}

// Why this applicant has no interview, in the words that point at the fix.
//
// Three situations end up on the same list and they need three different
// actions: chase the applicant, look at the committee's availability, or add
// another interview time. The tab used to say "no available time yields a
// balanced panel" to all three, which is plainly wrong for an applicant who has
// not answered at all, and actively misleading for one whose times are simply
// taken — that one reads as "their availability doesn't work for us" when the
// truth is "we have run out of slots".
function unschedulableLine(id, res) {
  const nameOf = (cid) => (cand(cid) || {}).name || cid;
  const who = `<b>${escapeHtml(nameOf(id))}</b>`;
  const w = res.why[id] || { reason: "no-panel", slots: [] };
  if (w.reason === "no-answer")
    return `${who} hasn't picked any interview times yet. Chase them, or set a time by hand.`;
  if (w.reason === "two-rooms") {
    const t = EFF().slots.find((x) => x.id === String((w.slots || [])[0]));
    return `${who}: ${t ? `at ${escapeHtml(slotTimeLabel(t))} on ${escapeHtml(fmtDate(t.date))} ` : ""}there aren't enough interviewers for two balanced panels at once.`;
  }
  if (w.reason === "locked")
    return `${who} has no interview in the locked schedule. Set one by hand, or unlock the schedule.`;
  if (w.reason === "contested") {
    // name the applicants holding those times: the admin can only fix this by
    // moving one of them or adding a time, and both need to know which.
    const holders = [...new Set(res.panels.filter((p) => w.slots.includes(String(p.slot)))
      .map((p) => nameOf(p.cand)))];
    const times = w.slots.map((s) => escapeHtml(slotName(s))).join(", ");
    return `${who}: ${w.slots.length === 1 ? "the one time" : "every time"} that could host their
      interview (${times}) is already taken${holders.length ? ` by ${holders.map(escapeHtml).join(", ")}` : ""}.
      Add another interview time, or move someone.`;
  }
  return `${who}: no time they can do yields a balanced panel.`;
}

// Everything that still needs a decision, in as few lines as it takes.
//
// It used to be one bullet per applicant, and with fourteen people still to
// answer that was fourteen copies of the same sentence — a wall that reads as
// "lots is broken" when the truth is "one thing is, thirteen times". Identical
// causes are now one line with the names in it, and a cause with nothing in it
// prints nothing at all.
function needsAttention(res) {
  const nameOf = (id) => (cand(id) || {}).name || id;
  const shortName = (id) => String(nameOf(id)).replace(/^Dr\.?\s+/i, "");
  const editLink = (id, label) => `<button class="linky" onclick="IV.editPanel('${id}')">${escapeHtml(label)}</button>`;
  const by = (r) => res.unschedulable.filter((id) => ((res.why[id] || {}).reason || "no-panel") === r);

  const items = [];
  res.doubleBooked.forEach((d) => items.push(
    `<b>${escapeHtml(slotName(d.slot))}</b> has ${d.cands.length} applicants at once:
     ${d.cands.map((id) => editLink(id, shortName(id))).join(", ")}. Move one.`));
  res.lostTime.forEach((id) => items.push(
    `<b>${escapeHtml(nameOf(id))}</b>'s hand-picked time no longer exists, so the suggestion is shown instead.
     <button class="linky" onclick="IV.clearOverride('${id}')">Dismiss</button>`));

  // the common bulk case: people who simply haven't answered yet
  const silent = by("no-answer");
  if (silent.length) items.push(
    `<b>${silent.length} applicant${silent.length === 1 ? " hasn't" : "s haven't"} picked any times yet:</b>
     ${silent.map((id) => editLink(id, shortName(id))).join(", ")}`);

  // the two specific cases keep their own line, because the fix differs per person
  by("no-panel").forEach((id) => items.push(`${unschedulableLine(id, res)} ${editLink(id, "Set a time")}`));
  by("contested").forEach((id) => items.push(`${unschedulableLine(id, res)} ${editLink(id, "Set a time")}`));
  by("locked").forEach((id) => items.push(`${unschedulableLine(id, res)} ${editLink(id, "Set a time")}`));
  by("two-rooms").forEach((id) => items.push(`${unschedulableLine(id, res)} ${editLink(id, "Set a time")}`));
  const withdrew = res.panels.filter((p) => { const c = cand(p.cand); return c && replyOf(c).reply === "withdrawn"; });
  if (withdrew.length) items.push(`${withdrew.map((p) => `<b>${escapeHtml(shortName(p.cand))}</b>`).join(", ")} `
    + `${withdrew.length === 1 ? "has" : "have"} withdrawn. Decide whether to offer the time to someone else.`);
  if (replyLate() && S.schedule && S.schedule.publishedAt) {
    const late = res.panels.filter((p) => { const c = cand(p.cand); return c && !replyOf(c).reply; });
    if (late.length) items.push(`${late.map((p) => `<b>${escapeHtml(shortName(p.cand))}</b>`).join(", ")} `
      + `${late.length === 1 ? "hasn't" : "haven't"} confirmed, and the date to confirm has passed.`);
  }
  (res.bothRooms || []).forEach((x) => items.push(`${x.members.map((m) => `<b>${escapeHtml(mname(m))}</b>`).join(", ")} `
    + `${x.members.length === 1 ? "is" : "are"} on both rooms' panels at ${escapeHtml(slotName(x.slot))}.`));
  // H14: answers saved under a surname two applicants now share: ask whose they
  // are (never guess). And a pair found in live data that has no keys yet.
  sharedDocs(planState(), (S.settings || {}).keptSurnameDocs || []).forEach((d) => items.push(
    `Answers saved under the last name <b>${escapeHtml(d.key.charAt(0).toUpperCase() + d.key.slice(1))}</b> could be from `
    + `${d.names.map(escapeHtml).join(" or ")}. Whose are they? `
    + d.ids.map((id, i) => `<button class="linky" onclick="IV.claimShared('${escapeHtml(d.key)}','${id}')">${escapeHtml(d.names[i])}</button>`).join(" · ")
    + ` · <button class="linky" onclick="IV.claimShared('${escapeHtml(d.key)}','')">Not sure: ask both again</button>`));
  const unkeyed = assignKeys(S.candidates);
  if (Object.keys(unkeyed.patches).length) items.push(`${unkeyed.groups.map((g) => `${g.names.map(escapeHtml).join(" and ")}`).join("; ")} share a last name, `
    + `so their answers would land in one place. <button class="linky" onclick="IV.separateKeys()">Give them separate answers</button>`);
  if (res.lockIssues) {
    res.lockIssues.notFree.forEach((x) => items.push(`<b>${escapeHtml(mname(x.member))}</b> is on ${escapeHtml(shortName(x.cand))}'s panel but no longer says they are free then. ${editLink(x.cand, "Edit the panel")}`));
    res.lockIssues.left.forEach((x) => items.push(`<b>${escapeHtml(x.name)}</b> has left the committee but is on ${x.n} panel${x.n === 1 ? "" : "s"}.`));
  }

  if (res.understaffed.length) items.push(
    `<b>${res.understaffed.length} time${res.understaffed.length === 1 ? "" : "s"}</b> nobody can staff a balanced panel for:
     ${res.understaffed.map((s) => `<span class="tm">${escapeHtml(slotName(s))}</span>`).join(", ")}`);

  if (!items.length) return "";
  const openEditor = res.unschedulable.filter((id) => ui.editPanel === id)
    .map((id) => `<div class="prow open">${panelEditor({ cand: id, slot: null, members: [] })}</div>`).join("");
  return `<div class="card attention"><b class="ahead">${ICON.warn} Needs attention</b>
    <ul class="small">${items.map((t) => `<li>${t}</li>`).join("")}</ul>${openEditor}</div>`;
}

// H11: the quiet rule: no badge for "Confirmed"; "Withdrew Feb 22" always;
// "No reply yet" only once the reply date has passed (and times were sent).
function replyBadge(cid) {
  const c = cand(cid); if (!c) return "";
  const r = replyOf(c);
  if (r.reply === "withdrawn") return `<div class="badges"><span class="badge bad">${ICON.warn}Withdrew${r.at ? " " + escapeHtml(dayOf(r.at)) : ""}</span></div>`;
  if (!r.reply && replyLate() && S.schedule && S.schedule.publishedAt) return `<div class="badges"><span class="badge">No reply yet</span></div>`;
  return "";
}

function renderPanels() {
  const { interviewers: committee, chair, slots, overrides, nameOf: memName } = EFF();
  const nameOf = (id) => (cand(id) || {}).name || id;
  const modPill = (m) => `<span class="pill ${m === "ip" ? "ip" : "zoom"}">${m === "ip" ? "In-person" : "Zoom"}</span>`;
  const res = computePanels();

  let html = hint(locked() ? "The locked schedule. Edit any panel by hand." : "Suggested panels, one applicant per time. Edit any of them by hand.");
  if (!EFF().slots.length) { $("#panels").innerHTML = html + empty(ICON.calendar, "No interview times yet", "Add interview times in Setup, then collect availability."); return; }

  // H4: lock the schedule (one filled button), or the one grey line saying it is.
  html += locked()
    ? `<p class="lockline">Schedule locked ${escapeHtml(dayOf(S.schedule.lockedAt))}. <button class="linky" onclick="IV.unlockSchedule(this)">Unlock</button></p>`
    : `<div class="lockbar"><button class="btn filled small" onclick="IV.lockSchedule(this)">Lock the schedule</button>${infoIcon("Freezes every panel as it is now. Later changes to anyone's availability will not move an interview. You can still edit any panel by hand.")}</div>`;
  html += `<p class="toolline">
    <button class="linky" onclick="IV.exportSchedule()">Export CSV</button>
    <button class="linky" onclick="IV.printSchedule()">Print</button>
    ${!locked() && Object.keys(overrides).length ? `<button class="linky" onclick="IV.resetPanels(this)">Reset hand-made panels</button>` : ""}
  </p>`;
  // H8/H11: messages and calendar files for everyone at once; sending times to
  // applicants only once the schedule is locked.
  if (res.panels.length) html += `<p class="toolline">
      <button class="linky" onclick="IV.downloadIcs('all')">Calendar file for all interviews</button>
      <button class="linky" onclick="IV.copyAllInvites()">Copy all applicant emails</button>
      ${locked() ? `<button class="linky" onclick="IV.publishNotices(this)">Send times to applicants</button>` : ""}
    </p>${locked() ? "" : `<p class="hint">These follow the suggested panels, which can still change. Lock the schedule first.</p>`}`;

  // Who is actually doing the interviews. Counted from the panels ON SCREEN —
  // auto and manual together — rather than from the builder's own tally, because
  // a hand-edited panel skews the share and that is exactly what this should
  // show. The builder shares the non-chair seats out by load; this is the proof.
  if (res.panels.length) {
    const load = {}; committee.forEach((m) => { load[m.id] = 0; });
    res.panels.forEach((p) => p.members.forEach((m) => { if (m in load) load[m]++; }));
    const others = Object.entries(load).filter(([n]) => n !== chair);
    const counts = others.map(([, v]) => v);
    const unused = others.filter(([, v]) => !v).map(([n]) => n);
    const lo = counts.length ? Math.min(...counts) : 0, hi = counts.length ? Math.max(...counts) : 0;
    const chips = others.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([n, v]) => `<span class="chip">${escapeHtml(memName(n))} <b>${v ? "×" + v : "×0"}</b></span>`).join("");
    const n = res.panels.length;
    const loadBody = `<div class="note">${escapeHtml(memName(chair))} chairs every panel, so the share that can be
        spread is the <b>other</b> ${res.panelSize > 1 ? res.panelSize - 1 : 0} seat${res.panelSize === 2 ? "" : "s"} on each one.
        They go to whoever has done fewest interviews so far${res.panelSize > 3
          ? `, and panels are set to <b>${res.panelSize}</b> rather than the minimum 3 precisely so there are enough seats for everyone`
          : ""}.
        Availability wins over fairness where they conflict: someone free for only one time can only ever
        sit on that one panel, and every panel still has to stay balanced.</div>
      ${chairLine(res.panels, memName)}
      <div>${chips}</div>
      ${unused.length ? idleInterviewers(unused, res)
        : `<p class="ok small" style="margin-top:.55rem">✓ Every interviewer is on at least one panel.</p>`}`;
    html += section("panelload", "Interviewer load",
      unused.length ? `${unused.length} not used` : `${lo}–${hi} each`, loadBody,
      { open: false, count: unused.length ? ICON.warn : null,
        info: "How the interviewing is shared out. The chair is on every panel by rule; the remaining seats go to whoever has done fewest so far, subject to who is actually available and keeping every panel balanced." });
  }

  // A valid panel says nothing about itself. Every one of them used to carry
  // "✓ 3 members" and "✓ balanced panel", so the page was a column of green
  // ticks confirming that nothing was wrong — which is exactly the reading that
  // makes a real ✗ invisible. Badges now appear only when something IS wrong.
  const panelRows = res.panels.map((p) => {
    const editing = ui.editPanel === p.cand;
    const v = p.valid || validatePanel(p.members, p.slot, p.modality);
    const faults = [
      ...(v.sizeOk ? [] : [`${v.size} member${v.size === 1 ? "" : "s"}`]),
      ...(v.balanced ? [] : ["not balanced"]),
      ...v.warns.filter((w) => w !== "not a balanced panel" && !w.startsWith("fewer") && !w.startsWith("more")),
    ];
    let row = `<div class="prow${editing ? " open" : ""}">
      <div class="row center"><div class="grow">
          <div class="name">${escapeHtml(nameOf(p.cand))}</div>
          <div class="small muted">${escapeHtml(slotName(p.slot))}${p.room === 2 ? " · Room 2" : ""} · ${p.modality === "ip" ? "in person" : "Zoom"}${p.manual && !p.locked ? " · edited" : ""}</div>
        </div>
        <button class="btn ghost small" onclick="IV.editPanel('${p.cand}')">${editing ? "Done" : "Edit"}</button></div>
      <div class="small members">${p.members.map((m) => escapeHtml(memName(m))).join(" · ")}</div>
      ${faults.length ? `<div class="badges">${faults.map((w) => `<span class="badge bad">${ICON.warn}${escapeHtml(w)}</span>`).join("")}</div>` : ""}
      ${replyBadge(p.cand)}
      <div class="panelacts">
        <button class="linky small" onclick="IV.copyInvite('${p.cand}','applicant')">Copy email to applicant</button>
        <button class="linky small" onclick="IV.copyInvite('${p.cand}','panel')">Copy email to panel</button>
        <button class="linky small" onclick="IV.downloadIcs('${p.cand}')">Calendar file</button>
        <button class="linky small" onclick="IV.downloadIcs('${p.cand}',true)">Calendar file for the applicant</button></div>`;
    if (editing) row += panelEditor(p);
    return row + `</div>`;
  }).join("");
  html += panelRows ? `<div class="card flush list">${panelRows}</div>`
    : `<div class="card">${empty(ICON.people, "No panels yet", "Panels appear once interviewers and applicants submit availability.")}</div>`;

  html += needsAttention(res);
  $("#panels").innerHTML = html;
}

// H13: "Vojdani chairs 8 panels. Rosenstein chairs 2, on Mar 3."
function chairLine(panels, memName) {
  const by = {};
  panels.forEach((p) => {
    const ch = p.chair === undefined ? EFF().chair : p.chair;
    const t = EFF().slots.find((x) => x.id === String(p.slot));
    const k = ch === null ? "" : ch;
    (by[k] = by[k] || { n: 0, days: new Set() }).n++;
    if (t && t.date) by[k].days.add(t.date);
  });
  const main = EFF().chair;
  const parts = Object.entries(by).sort(([a], [b]) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b))).map(([id, v]) =>
    id === "" ? `${v.n} panel${v.n === 1 ? " has" : "s have"} no chair`
      : `${escapeHtml(memName(id))} chairs ${v.n} panel${v.n === 1 ? "" : "s"}${id !== main && v.days.size ? `, on ${[...v.days].map((d) => escapeHtml(fmtDate(d))).join(", ")}` : ""}`);
  if (parts.length === 1 && by[main]) return `<p class="small"><b>${escapeHtml(memName(main))}</b>: all ${panels.length} panel${panels.length === 1 ? "" : "s"} (chair).</p>`;
  return `<p class="small">${parts.join(". ")}.</p>`;
}

// H11: an applicant's reply to their published time ({ reply, replyAt }), read
// from the availability documents leadership already listens to.
const replyOf = (c) => { const k = candKey(c); const r = (S.availRaw ? S.availRaw[k] : (S.replies || {})[k]) || {}; return { reply: r.reply || "", at: r.replyAt || null }; };
const replyLate = () => { const d = EFF().deadlines.reply; return !!d && daysUntil(d) < 0; };

// inline editor for one panel: choose slot + toggle members (chair locked on)
function panelEditor(p) {
  const { interviewers: committee } = EFF();
  // H13: the chair this panel needs (the day's chair, the room-2 lead, or none)
  const edRoom = (ui._draft && ui._draft[p.cand] && ui._draft[p.cand].room) || p.room || 1;
  const chair = p.slot != null ? EFF().chairFor(p.slot, edRoom) : EFF().chair;
  const c = cand(p.cand);
  const avail = c ? availForCand(c) : {};
  // their available times (in date order), else every time; always keep the current one
  const live = liveAnswers(avail);
  const slotChoices = EFF().slotIds.filter((id) => !live.length || live.includes(id) || id === String(p.slot));
  const members = new Set(p.members && p.members.length ? p.members : (chair ? [chair] : []));
  if (chair) members.add(chair);
  const slotSel = `<select id="ovslot-${p.cand}" aria-label="Slot">
    ${slotChoices.map((s) => `<option value="${s}" ${String(p.slot) === String(s) ? "selected" : ""}>${escapeHtml(slotName(s))}${avail[s] ? " · " + avail[s] : ""}</option>`).join("")}</select>`;
  const curMod = p.modality || (avail[p.slot] === "zoom" ? "zoom" : "ip");
  // H13: which room, when this time runs two
  const curRoom = (ui._draft && ui._draft[p.cand] && ui._draft[p.cand].room) || p.room || 1;
  const roomSel = EFF().rooms[String(p.slot)] === 2 ? `<span class="muted small">Room</span><span class="seg" role="group" aria-label="Room">
    ${[1, 2].map((r) => `<button type="button" class="${curRoom === r ? "on" : ""}" aria-pressed="${curRoom === r}" onclick="IV.setOvRoom('${p.cand}',${r},this)">Room ${r}</button>`).join("")}</span>` : "";
  const modSel = `<span class="seg" id="ovmod-${p.cand}" role="group" aria-label="Modality">
    ${["ip", "zoom"].map((mv) => `<button type="button" class="${curMod === mv ? "on" : ""}" aria-pressed="${curMod === mv}" onclick="IV.setOvMod('${p.cand}','${mv}',this)">${mv === "ip" ? "In person" : "Zoom"}</button>`).join("")}</span>`;
  // pass the committee INDEX (not the name) so names with quotes/apostrophes
  // (e.g. O'Brien) can't break the inline handler.
  const memToggles = committee.map((m, idx) => {
    const on = members.has(m.id), isChair = m.id === chair;
    return `<label class="chip" style="cursor:${isChair ? "default" : "pointer"}"><input type="checkbox" ${on ? "checked" : ""} ${isChair ? "disabled" : ""}
      onchange="IV.toggleMember('${p.cand}',${idx},this.checked)" style="margin-right:.35rem"/>${escapeHtml(m.name)}${isChair ? " (chair)" : ""}</label>`;
  }).join("");
  return `<div class="peditor">
    <div class="row center" style="gap:.5rem; flex-wrap:wrap"><span class="muted small">Time</span>${slotSel}<span class="muted small">Modality</span>${modSel}${roomSel}</div>
    <div class="muted small" style="margin:.6rem 0 .3rem">Members (chair always included)</div>
    <div>${memToggles}</div>
    <div class="adminbar"><button class="btn tinted small" onclick="IV.savePanel('${p.cand}',this)">Save panel</button>
      ${!locked() && EFF().overrides[p.cand] ? `<button class="btn ghost small" onclick="IV.clearOverride('${p.cand}')">Reset to auto</button>` : ""}</div></div>`;
}

// ----------------------------------------------------- 5 · Ranking (admin)
// How the averages are (and are not) normalized
// --------------------------------------------
// "Avg" is the plain mean of the overall scores that were submitted for that
// candidate. A missing score is left out, never imputed — scoring one candidate
// 4 and skipping another is not the same as giving the second a 0 or a 3, and
// pretending otherwise would invent data.
//
// What that mean does NOT correct for is WHO did the scoring. Each candidate
// faces a different 3–5 person panel, so two candidates' means come from
// different raters, and raters differ in generosity. "Adj" is the standard
// rater-centred correction for exactly that: each rater's own mean is compared
// with the overall mean and their personal offset is subtracted from every
// score they gave. A rater who has scored only one candidate has no measurable
// offset, so they are left alone (offset 0) rather than guessed at.
//
// The table shows both, because the adjustment is a model and the raw mean is
// the fact. Where the two disagree about the order, the row says so — that is
// the signal worth discussing, not a number to defer to.
function rankingRows() {
  const committee = EFF().committee;
  const obs = [];
  activeCands().forEach((c) => committee.forEach((m) => {
    const v = (S.scores[key(m.id, c.id)] || {}).overall;
    if (v) obs.push({ m: m.id, c: c.id, v });
  }));
  const grand = obs.length ? obs.reduce((a, o) => a + o.v, 0) / obs.length : 0;
  const byRater = {};
  obs.forEach((o) => { (byRater[o.m] = byRater[o.m] || []).push(o.v); });
  const offset = {};
  Object.entries(byRater).forEach(([m, vs]) => {
    offset[m] = vs.length >= 2 ? vs.reduce((a, b) => a + b, 0) / vs.length - grand : 0;
  });
  // how many people were meant to score this candidate (their panel), so a
  // missing score reads as "chase Marrocco", not as a quieter average
  let panelSize = {};
  try { computePanels().panels.forEach((p) => { panelSize[p.cand] = p.members.length; }); } catch { panelSize = {}; }

  const rows = activeCands().map((c) => {
    const mine = obs.filter((o) => o.c === c.id);
    if (!mine.length) return null;
    // "of N" only where N is the panel that was actually meant to score them;
    // a stale or hand-edited panel can be smaller than the scores on record,
    // and "8 of 3" would just look broken.
    const expected = (panelSize[c.id] || 0) >= mine.length ? panelSize[c.id] : 0;
    return { id: c.id, name: c.name, n: mine.length, expected,
      raw: mine.reduce((a, o) => a + o.v, 0) / mine.length,
      adj: mine.reduce((a, o) => a + (o.v - offset[o.m]), 0) / mine.length,
      raters: mine.map((o) => mname(o.m)) };
  }).filter(Boolean);

  const byAdj = [...rows].sort((a, b) => b.adj - a.adj).map((r) => r.id);
  rows.sort((a, b) => b.raw - a.raw || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.shift = i - byAdj.indexOf(r.id); }); // + = adjustment moves them up
  const adjusted = Object.values(offset).some((v) => Math.abs(v) > 0.001);
  return { rows, adjusted };
}

// Live snapshots re-render the whole tab; put focus, caret and note heights back
// so an admin typing an offer note is never interrupted (the draft itself is kept
// in ui.offerNotes and rendered back by offersSection).
function keepFocus(scopeSel) {
  const act = document.activeElement, id = act && act.id;
  const scope = document.querySelector(scopeSel);
  const inScope = !!(id && scope && scope.contains(act));
  const sel = inScope && typeof act.selectionStart === "number" ? [act.selectionStart, act.selectionEnd] : null;
  return () => {
    document.querySelectorAll(`${scopeSel} .ofnote textarea`).forEach((t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; });
    if (!inScope) return;
    const el = document.getElementById(id);
    if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* date inputs */ } }
  };
}

function renderRanking() {
  const restore = keepFocus("#ranking");
  try { renderRankingInner(); } finally { restore(); }
}
function renderRankingInner() {
  if (!S.meta.interviewsComplete) {
    $("#ranking").innerHTML = `<div class="card">${empty(ICON.lock, "Ranking is hidden", "Reveal it once all interviews are done.")}
      <div style="text-align:center"><button class="btn filled" onclick="IV.setComplete(true,this)">Mark interviews complete &amp; reveal ranking</button></div></div>` + backupCard();
    return;
  }
  const { rows, adjusted } = rankingRows();
  const adjInfo = "Each candidate is scored by a different panel, so a plain average also measures who happened to be in the room. "
    + "Adj subtracts each rater's own tendency to score high or low (their mean minus the overall mean) before averaging. "
    + "Raters who scored only one candidate have no measurable tendency and are left unadjusted. It is decision support, not a verdict.";
  const body = rows.map((r, i) => {
    const thin = r.expected && r.n < r.expected;
    const shift = r.shift > 0 ? `<span class="shift up" data-tip="Ranks ${r.shift} place${r.shift === 1 ? "" : "s"} higher once rater tendency is taken out">▲${r.shift}</span>`
      : r.shift < 0 ? `<span class="shift down" data-tip="Ranks ${-r.shift} place${r.shift === -1 ? "" : "s"} lower once rater tendency is taken out">▼${-r.shift}</span>` : "";
    const count = `${r.n}${r.expected ? ` of ${r.expected}` : ""}`;
    // On a phone Adj and Scored by fold into a second line under the name
    // (.rk-sub), so the table fits 390px and the count still sits by the mean.
    return `<tr><td class="rankn num">${i + 1}</td><td class="name">${escapeHtml(r.name)}
        <div class="rk-sub">Adj ${r.adj.toFixed(2)}${shift} · <span class="${thin ? "thinscore" : ""}">scored by ${count}</span></div></td>
      <td class="num" data-tip="${escapeHtml(`Mean of ${r.n} submitted score${r.n === 1 ? "" : "s"}: ${r.raters.join(", ")}`)}"><b>${r.raw.toFixed(2)}</b></td>
      <td class="adj num rk-opt" data-tip="${escapeHtml(adjInfo)}">${r.adj.toFixed(2)}${shift}</td>
      <td class="num rk-opt${thin ? " thinscore" : ""}" data-tip="${thin ? escapeHtml(`Only ${r.n} of the ${r.expected} panellists have scored this candidate.`) : "Every panellist on record has scored this candidate."}">${count}</td></tr>`;
  }).join("");
  $("#ranking").innerHTML = hint("Average interview scores. Decision support, not a decision.")
    + `<p class="toolline"><button class="linky" onclick="IV.exportScores()">Export scores (CSV)</button>
      <button class="linky" onclick="IV.setComplete(false,this)">Re-hide ranking</button></p>
    <div class="card flush"><div class="tablewrap"><table class="ranktable"><thead><tr><th class="num">#</th><th>Candidate</th><th class="num">Avg</th>
      <th class="num rk-opt">Adj${infoIcon(adjInfo)}</th><th class="num rk-opt">Scored by</th></tr></thead>
      <tbody>${body || `<tr><td colspan="5">${empty(ICON.star, "No scores yet", "Scores will appear as interviewers submit them.")}</td></tr>`}</tbody></table></div></div>`
    + offersSection(rows) + backupCard();
}

// ------------------------------------------------ 5b · Offers (admin, Ranking)
// After the ranking: who was made an offer, who accepted, who declined, when,
// and a note (DESIGN.md "Offer outcomes", Kyle, Oct 7 2026). One row per
// candidate in ranking order, then anyone not yet scored, then anyone who has an
// outcome on record but has since left the list, so nothing recorded vanishes.
const OFFER_STATES = [["", "Not offered"], ["offered", "Offered"], ["accepted", "Accepted"], ["declined", "Declined"]];
const OFFER_WORD = { offered: "Offered", accepted: "Accepted", declined: "Declined" };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const offerOf = (id) => (S.offers || {})[id] || {};

function offerRows(rows) {
  const seen = new Set(), out = [];
  (rows || rankingRows().rows).forEach((r, i) => { seen.add(r.id); out.push({ id: r.id, name: r.name, rank: i + 1, avg: r.raw }); });
  activeCands().filter((c) => !seen.has(c.id)).sort((a, b) => a.name.localeCompare(b.name))
    .forEach((c) => { seen.add(c.id); out.push({ id: c.id, name: c.name, rank: null, avg: null }); });
  S.candidates.filter((c) => !seen.has(c.id) && offerOf(c.id).status)
    .forEach((c) => out.push({ id: c.id, name: c.name, rank: null, avg: null, gone: true }));
  return out;
}

function offerCounts() {
  const n = { offered: 0, accepted: 0, declined: 0 };
  Object.values(S.offers || {}).forEach((o) => { if (n[o.status] != null) n[o.status]++; });
  return { ...n, made: n.offered + n.accepted + n.declined };
}

function offersSection(rows) {
  const list = offerRows(rows);
  const n = offerCounts();
  const summary = n.made
    ? `<span class="pill neutral">${n.made} offer${n.made === 1 ? "" : "s"} made</span>
       ${n.accepted ? `<span class="pill in">${n.accepted} accepted</span>` : ""}
       ${n.declined ? `<span class="pill out">${n.declined} declined</span>` : ""}
       ${n.offered ? `<span class="pill zoom">${n.offered} awaiting reply</span>` : ""}`
    : `<span class="muted">No offers recorded yet. Choose <b>Offered</b> when you make one.</span>`;
  const body = list.map((r) => {
    const o = offerOf(r.id), st = o.status || "";
    const seg = OFFER_STATES.map(([v, label]) =>
      `<button type="button" class="${st === v ? `on ${v || "none"}` : ""}" aria-pressed="${st === v}"
        onclick="IV.offerStatus('${r.id}','${v}',this)">${label}</button>`).join("");
    const draft = (ui.offerNotes || {})[r.id];
    const note = draft != null ? draft : (o.note || "");
    const dirty = draft != null && draft !== (o.note || "");
    const dates = st ? `<div class="ofdates">
        <label>Offered <input type="date" id="ofo-${r.id}" value="${escapeHtml(o.offeredAt || "")}" max="${todayIso()}"
          onchange="IV.offerDate('${r.id}','offeredAt',this.value)"></label>
        ${st === "accepted" || st === "declined" ? `<label>${OFFER_WORD[st]} <input type="date" id="ofr-${r.id}" value="${escapeHtml(o.respondedAt || "")}" max="${todayIso()}"
          onchange="IV.offerDate('${r.id}','respondedAt',this.value)"></label>` : ""}
      </div>` : "";
    return `<div class="rrow offer ${st || "none"}" id="ofrow-${r.id}">
      <div class="row center">
        <span class="rankn">${r.rank ? r.rank : "–"}</span>
        <div class="grow"><div class="name">${escapeHtml(r.name)}</div>
          <div class="small muted">${r.gone ? "No longer on the interview list" : r.avg != null ? `Avg ${r.avg.toFixed(2)}` : "Not scored yet"}</div></div>
        <div class="seg ofseg" role="group" aria-label="Offer status for ${escapeHtml(r.name)}">${seg}</div>
      </div>
      ${dates}
      <div class="ofnote">
        <textarea id="ofn-${r.id}" rows="1" maxlength="4000" placeholder="Add a note"
          aria-label="Offer note for ${escapeHtml(r.name)}" oninput="IV.offerNoteInput('${r.id}',this)">${escapeHtml(note)}</textarea>
        <button type="button" class="savebtn" id="ofs-${r.id}" ${dirty ? "" : "hidden"} onclick="IV.offerNoteSave('${r.id}',this)">Save note</button>
      </div>
    </div>`;
  }).join("");
  return `<h3 class="sechead">Offers</h3>
    <p class="hint">Record each offer as you make it, then the answer. Only admins can see this.</p>
    <div class="ofsummary">${summary}</div>
    <div class="card flush list">${body || empty(ICON.mail, "No candidates yet", "Candidates appear here once they are on the list.")}</div>`;
}

// ------------------------------------------------ 5c · Back up the cycle
// Firestore keeps no history and the site is the working copy, not the record
// (DESIGN.md #5/#7): after each cycle an admin downloads everything as one Excel
// workbook and files it with the CVs. Print gives the same summary on paper, or
// as a PDF through the browser's "Save as PDF".
function backupCard() {
  return `<div class="card backup">
    <div class="row center">
      <div class="grow"><h3 style="margin:0 0 .2rem">Back up this hiring cycle</h3>
        <p class="small muted" style="margin:0">Everything in this round, read fresh from the database. The backup file can be
          loaded back into the tool; the Excel file is for reading. Save both with the CVs on OneDrive; the site is the
          working copy, not the record.</p></div>
    </div>
    <div class="row backup-actions">
      <button class="btn filled" onclick="IV.downloadBackup(this)">Download backup file (for restoring)</button>
      <button class="btn tinted" onclick="IV.exportCycle(this)">Download Excel</button>
      <button class="btn ghost" onclick="IV.printCycle()">Print or save as PDF</button>
    </div>
    <p class="small muted" style="margin:.7rem 0 0">This file has applicant names and the committee's comments. Save it with the
      CVs on OneDrive. Don't email it.</p>
  </div>`;
}

// The interview-list status in words, for exports.
function listStatus(c) {
  if (c.removed) return "Removed";
  const fc = flagsCount(c.id), th = EFF().threshold;
  if (c.shortlistBy === "leadership") return c.shortlist === "out" ? "Off (leadership decision)" : "Interview list (leadership decision)";
  return isIn(c) ? "Interview list" : `Off (${fc} concern${fc === 1 ? "" : "s"}${th ? `, rule ${th}` : ""})`;
}

// One place builds every table, so the workbook and the printout cannot drift.
const MOD_WORD = { ip: "In person", zoom: "Zoom", either: "Either" };
function cycleTables() {
  const { committee, chair, slots, nameOf } = EFF();
  // Everyone on the list plus anyone else whose input is saved (people who left
  // or were taken off the list), so no one's input is missing from the record.
  const memberIds = committee.map((m) => m.id);
  idsWithInput(S).forEach((id) => { if (!memberIds.includes(id)) memberIds.push(id); });
  const mStatus = (id) => memberStatus(committee, id);
  const status = listStatus;
  const rank = rankingRows();
  const rankPos = {}; rank.rows.forEach((r, i) => { rankPos[r.id] = i + 1; });
  const sortedCands = [...S.candidates].sort((a, b) => a.name.localeCompare(b.name));
  const t = {};
  t.candidates = [["Candidate", "Status", "Concerns", "Avg priority", "Rated by", "Rank", "Offer"]];
  sortedCands.forEach((c) => {
    const st = screenStats(c.id), o = offerOf(c.id);
    t.candidates.push([c.name, status(c), st.flags.length, st.avg == null ? null : Number(st.avg.toFixed(1)), st.n,
      rankPos[c.id] || null, OFFER_WORD[o.status] || ""]);
  });
  t.screening = [["Reviewer", "Reviewer status", "Candidate", "Priority rating (1-5)", "Concern", "Concern reason", "Note", "Knows them"]];
  memberIds.forEach((id) => sortedCands.forEach((c) => {
    const s = S.screening[key(id, c.id)];
    if (s && (s.rating || s.flag || s.reason || s.note)) t.screening.push([nameOf(id), mStatus(id), c.name, s.rating || null, s.flag ? "Yes" : "",
      String(s.reason || "").trim(), String(s.note || "").trim(), s.conflict ? "Yes" : ""]);
  }));
  const slotCols = slots.map((x) => slotLabel(x));
  t.availCommittee = [["Committee member", ...slotCols]];
  memberIds.filter((id) => { const m = committee.find((x) => x.id === id); return (m && m.role === "interviewer") || Object.keys(S.availIv[id] || {}).length; })
    .forEach((id) => { const a = S.availIv[id] || {}; t.availCommittee.push([nameOf(id), ...slots.map((x) => MOD_WORD[a[x.id]] || "")]); });
  t.availApplicants = [["Candidate", ...slotCols]];
  sortedCands.filter((c) => !c.removed).forEach((c) => { const a = availForCand(c); t.availApplicants.push([c.name, ...slots.map((x) => MOD_WORD[a[x.id]] || "")]); });
  let res = { panels: [], unschedulable: [] };
  try { res = computePanels(); } catch { /* no times yet */ }
  t.panels = [["Candidate", "Time", "Format", "Panel", "Set by hand"]];
  res.panels.forEach((p) => t.panels.push([(cand(p.cand) || {}).name || p.cand, slotName(p.slot), MOD_WORD[p.modality] || p.modality, p.members.map(nameOf).join(", "), EFF().overrides[p.cand] ? "Yes" : ""]));
  (res.unschedulable || []).forEach((id) => t.panels.push([(cand(id) || {}).name || id, "Not scheduled", "", "", ""]));
  // Score columns per question id, in the saved order, headed by the question's
  // text; then any id found in notes that the list no longer has.
  const QQ = Q();
  const noted = idsWithNotes(S.scores);
  const listed = (QQ ? QQ.questions : []).filter((q) => !q.archived || noted.includes(q.id));
  const extra = noted.filter((id) => !listed.some((q) => q.id === id));
  const qCols = [...listed.map((q) => ({ id: q.id, head: q.text })),
    ...extra.map((id) => ({ id, head: `Question no longer on the list (id ${id})` }))];
  t.scores = [["Reviewer", "Reviewer status", "Candidate", "Overall score", ...qCols.map((q) => q.head)]];
  memberIds.forEach((id) => sortedCands.forEach((c) => {
    const s = S.scores[key(id, c.id)];
    if (s && (s.overall || Object.values(s.notes || {}).some(Boolean))) t.scores.push([nameOf(id), mStatus(id), c.name, s.overall || null, ...qCols.map((q) => (s.notes || {})[q.id] || "")]);
  }));
  t.questions = [["Question id", "Question", "Shown on the Score tab"]];
  (QQ ? QQ.questions : []).forEach((q) => t.questions.push([q.id, q.text, q.archived ? "No" : "Yes"]));
  extra.forEach((id) => t.questions.push([id, "(not on the list now; notes are kept)", "No"]));
  t.ranking = [["Rank", "Candidate", "Average score", "Rater-adjusted", "Scored by", "Panel size"]];
  rank.rows.forEach((r, i) => t.ranking.push([i + 1, r.name, Number(r.raw.toFixed(2)), Number(r.adj.toFixed(2)), r.n, r.expected || null]));
  t.offers = [["Candidate", "Rank", "Status", "Offered on", "Answered on", "Note"]];
  offerRows(rank.rows).forEach((r) => { const o = offerOf(r.id); t.offers.push([r.name, r.rank, OFFER_WORD[o.status] || "Not offered", o.offeredAt || "", o.respondedAt || "", o.note || ""]); });
  t.committee = [["Committee member", "Status", "Role"]];
  memberIds.forEach((id) => t.committee.push([nameOf(id), mStatus(id), id === chair ? "Chair" : "Member"]));
  t.times = [["Interview time"]]; slots.forEach((x) => t.times.push([slotLabel(x)]));
  const n = offerCounts();
  t.summary = [["Item", "Value"],
    ["Exported", new Date().toLocaleString()],
    ["Tool", ORG_NAME],
    ["Candidates", S.candidates.length],
    ["On the interview list", activeCands().length],
    ["Committee members", committee.filter((m) => m.active).length],
    ["Interview times", slots.length],
    ["Panels scheduled", res.panels.length],
    ["Scores submitted", t.scores.length - 1],
    ["Ranking revealed", S.meta.interviewsComplete ? "Yes" : "No"],
    ["Offers made", n.made], ["Accepted", n.accepted], ["Declined", n.declined], ["Awaiting reply", n.offered],
    ["Not included", "Committee members' gender (used only to balance panels)."]];
  return t;
}


// ------------------------------------------------------------ 6 · Setup (admin)
function renderSettings() {
  const { committee, interviewers, chair, slots, oneDrive, nameOf } = EFF();
  const stagesBody = STAGES.map((n) => {
    const open = isOpen(n), at = stageClosedAt(S.meta, n);
    return `<div class="stagerow"><span class="grow"><b>${STAGE_WORD[n]}:</b> ${open ? "open" : `closed${at ? " " + escapeHtml(dayOf(at)) : ""}`}</span>
      ${open ? `<button class="btn tinted small" onclick="IV.closeStage('${n}',this)">Close ${n}</button>`
        : `<button class="btn ghost small" onclick="IV.reopenStage('${n}',this)">Reopen</button>`}</div>`;
  }).join("");
  const dl = EFF().deadlines;
  const deadlinesBody = `<div class="tform dlform">
      <label>Screening due<input type="date" id="dlScreening" value="${escapeHtml(dl.screening || "")}"/></label>
      <label>Availability due<input type="date" id="dlAvailability" value="${escapeHtml(dl.availability || "")}"/></label>
      <label>Applicants confirm by<input type="date" id="dlReply" value="${escapeHtml(dl.reply || "")}"/></label></div>
    <div style="margin-top:.6rem"><button class="btn tinted small" onclick="IV.saveDeadlines(this)">Save dates</button></div>`;
  const th = EFF().threshold;
  const ruleBody = `<p class="small" style="margin-top:0">Take an applicant off the interview list automatically at
      <input type="number" id="thIn" min="0" max="20" step="1" value="${th}" class="numin" aria-label="Number of concerns"/> concerns.
      Set 0 to decide each applicant yourself.</p>
    ${isOpen("screening") ? "" : `<p class="note">Screening is closed, so this has no effect on the list that was saved when it closed.</p>`}
    <button class="btn tinted small" onclick="IV.saveThreshold(this)">Save rule</button>`;
  const ii = EFF().interviewInfo;
  const infoBody = `<label class="ed-label" for="idLoc">In-person location</label><input id="idLoc" type="text" value="${escapeHtml(ii.location || "")}" placeholder="ED admin office, 2nd floor"/>
    <label class="ed-label" for="idZoom" style="margin-top:10px">Zoom link</label><input id="idZoom" type="text" value="${escapeHtml(ii.zoomLink || "")}" placeholder="https://..."/>
    <label class="ed-label" for="idContact" style="margin-top:10px">Contact for applicants</label><input id="idContact" type="text" value="${escapeHtml(ii.contact || "")}" placeholder="MGHEmergencyDepartmentAdministration@tehn.ca"/>
    <div style="margin-top:.6rem"><button class="btn tinted small" onclick="IV.saveInfo(this)">Save details</button></div>`;
  const committeeBody = committeeEditor();
  const questionsBody = questionsEditor();
  const nQ = liveQuestions(Q()).length;
  const chairBody = `<div class="note">The chair is on every panel.</div>
    <select onchange="IV.setChair(this.value)" aria-label="Panel chair">${interviewers.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === chair ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</select>`;
  const slotsBody = timesEditor(slots);
  const odBody = `<div class="note">Committee members open CVs from here. Stored privately (not in code).</div>
    <input id="odIn" type="text" placeholder="https://..." value="${escapeHtml(oneDrive === "#" ? "" : oneDrive)}" aria-label="OneDrive link"/>
    <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.saveOneDrive(this)">Save link</button></div>`;

  const backupBody = `<p class="small" style="margin-top:0">A full copy of the round, read fresh from the database. The backup file
      can be loaded back into the tool; the Excel file is for reading.</p>
    <div class="row backup-actions" style="margin-top:.4rem">
      <button class="btn tinted small" onclick="IV.downloadBackup(this)">Download backup file (for restoring)</button>
      <button class="btn ghost small" onclick="IV.exportCycle(this)">Download Excel</button></div>
    <p class="small muted">This file has applicant names and the committee's comments. Save it with the CVs on OneDrive. Don't email it.</p>`;
  $("#settings").innerHTML = `${section("setChair", "Panel chair", nameOf(chair), chairBody, { open: false, info: "The chair is on every interview panel. Pick from your committee list below." })}
    ${section("setCommittee", "Committee and screeners", `${committee.filter((m) => m.active).length} people`, committeeBody, { open: false, info: "Everyone who screens applicants, and which of them also interview. Renaming someone keeps everything they entered. Someone who has left keeps their input, which still counts, but leaves every list of people." })}
    ${section("setQuestions", "Interview questions", `${nQ} question${nQ === 1 ? "" : "s"}`, questionsBody, { open: false, info: "Interviewers see these on the Score tab. Applicants never see them." })}
    ${section("setStages", "Round stages", STAGES.filter((n) => !isOpen(n)).map((n) => STAGE_WORD[n] + " closed").join(", "), stagesBody, { open: false, info: "Close each stage when its deadline passes. A closed stage can't be changed with the ED password (the server refuses it). You can reopen a stage." })}
    ${section("setDeadlines", "Deadlines", "", deadlinesBody, { open: false, info: "The screening date drives the countdown everyone sees. The others are used in reminders and in what applicants see." })}
    ${section("setRule", "Screening rule", `off at ${th || "no"} concern${th === 1 ? "" : "s"}`, ruleBody, { open: false, info: "How many concerns take an applicant off the interview list automatically. Your On or Off decision on the Screen tab always wins." })}
    ${section("setInfo", "Interview details", "", infoBody, { open: false, info: "Used in every email and calendar file the tool writes for you, and in what applicants see." })}
    ${section("setSlots", "Interview times", `${slots.length} time${slots.length === 1 ? "" : "s"}`, slotsBody, { open: false, info: "The interview times interviewers and applicants choose from. Add a single time or a block of back-to-back times; edit or remove any time. If people already answered for a time you change, you choose whether to keep their answers or ask them again." })}
    ${section("setOneDrive", "Applications folder (OneDrive)", "", odBody, { open: false, info: "Link to the access-controlled OneDrive folder holding the CVs/cover letters. Committee members open applicant files from here. Stored privately, never in the app's code." })}
    ${section("setRound", "This round", (S.meta && S.meta.roundName) || "", roundBody(), { open: false, info: "Name the round, and close it when hiring is done. Closing moves everything to Past rounds, which only Leadership can see." })}
    ${section("setPast", "Past rounds", ui.past && ui.past.due ? `${ui.past.due} can now be deleted` : "", pastBody(), { open: false, info: "Closed rounds. Download them again, bring one back, or delete one for good after the keep-until date." })}
    ${section("setRetention", "Keep closed rounds for", retentionLabel(), retentionBody(), { open: false, info: "Set by the department. Check with leadership before changing." })}
    ${section("setRestore", "Restore from a backup file", "", restoreBody(), { open: false, info: "Load a backup file back in. You see exactly what would be added before anything is written." })}
    ${section("setBackup", "Backup", "", backupBody, { open: false, info: "Download everything in the working round. Do this before every release of the tool and before any big change." })}
    ${section("setPasswords", "Passwords for all ED tools", "Leadership, ED and Guest", passwordsBody(), { open: false, info: "The three shared passwords. Changing one here changes it in Physician Hiring and Motion Voting together; the Patient Hub statistics page follows the Leadership password." })}
    ${section("setHistory", "Change history", "", historyBody(), { open: false, info: "Changes made with the Leadership password, newest first. Undo is offered where the change can still be undone." })}
    ${hint("Applicants are added on the Screen tab, under “Add candidates”.")}`;
}


// ------------------------------------------- Setup → Committee and screeners (H6)
// One row per person. The draft lives in ui.commDraft from the first edit, so a
// live re-render (anyone saving anything) never wipes what is being typed; a
// saved list is merged by id inside the transaction, so a person added from
// another device meanwhile is kept.
const commRows = () => (ui.commDraft ? ui.commDraft.rows : EFF().committee.map((m) => ({ ...m, email: m.email || "" })));
function commDraft() {
  if (!ui.commDraft) ui.commDraft = { rows: commRows().map((r) => ({ ...r })), removed: [], add: "" };
  return ui.commDraft;
}
function committeeEditor() {
  const rows = commRows(), chair = EFF().chair;
  const seg = (i, field, opts, cur, label) => `<span class="seg" role="group" aria-label="${escapeHtml(label)}">${opts.map(([v, l]) =>
    `<button type="button" class="${cur === v ? "on" : ""}" aria-pressed="${cur === v}" onclick="IV.mSet(${i},'${field}','${v}')">${escapeHtml(l)}</button>`).join("")}</span>`;
  const body = rows.map((m, i) => {
    const saved = hasInput(S, m.id), isChair = m.id === chair;
    return `<div class="mrow${m.active ? "" : " left"}">
      <input id="mName-${i}" type="text" value="${escapeHtml(m.name)}" aria-label="Name" oninput="IV.mSet(${i},'name',this.value,true)"/>
      <div class="mopts">
        ${seg(i, "role", [["interviewer", "Interviews and screens"], ["screener", "Screens only"]], m.role, "Does")}
        ${m.role === "interviewer" ? `<span class="mg">${seg(i, "gender", [["F", "F"], ["M", "M"]], m.gender, "Gender")}${infoIcon("Self-identified. Used only to build balanced panels. Never shown as a label.")}</span>` : ""}
        ${seg(i, "active", [["true", "Active"], ["false", "Left the committee"]], String(m.active), "Status")}
      </div>
      <input id="mEmail-${i}" type="email" value="${escapeHtml(m.email || "")}" placeholder="Work email (optional, for reminders)"
        aria-label="Work email for ${escapeHtml(m.name)}" autocomplete="off" oninput="IV.mSet(${i},'email',this.value,true)"/>
      ${!saved && !isChair ? `<button type="button" class="linky danger small" onclick="IV.mRemove(${i})">Remove (nothing saved yet)</button>` : ""}
    </div>`;
  }).join("");
  const d = ui.commDraft;
  return `<div class="mlist">${body}</div>
    <label class="ed-label" for="commAdd" style="margin-top:14px">Add people</label>
    <textarea id="commAdd" rows="3" placeholder="Nguyen&#10;Marrocco, F" oninput="IV.mAdd(this.value)">${escapeHtml(d ? d.add : "")}</textarea>
    <p class="small muted" style="margin:.3rem 0 0">One per line. For interviewers: Name, F or Name, M. For screeners: just the name.</p>
    <div class="adminbar" style="margin-top:.6rem"><button class="btn tinted small" onclick="IV.saveCommittee(this)">Save</button>
      ${d ? `<button class="btn ghost small" onclick="IV.mDiscard()">Discard changes</button>` : ""}</div>`;
}
// "Name, F" → an interviewer; a bare name → someone who screens only.
function parseAddLines(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(","); const name = parts[0].trim(); const g = (parts[1] || "").trim().toUpperCase();
    return g.startsWith("F") || g.startsWith("M")
      ? { name, gender: g[0], role: "interviewer", active: true }
      : { name, gender: "", role: "screener", active: true };
  }).filter((m) => m.name);
}

// ------------------------------------------------ Setup → Interview questions (H2)
// Locked once scoring has started (any score with a number or a note): only
// the wording may change then. The draft lives in ui.qDraft from the first edit.
// Locked once scoring started, but only when there is a questions document to
// keep: with none (lost, or never copied) nothing could be added at all, and
// the notes would point at questions nobody can see (review)
const qLocked = () => !!Q() && scoringStarted(S.scores);
// "0".."n-1" for the highest numbered note, then any other id a note uses
function idsFromNotes() {
  const ids = idsWithNotes(S.scores);
  const n = ids.filter((x) => /^\d+$/.test(x)).reduce((m, x) => Math.max(m, Number(x) + 1), 0);
  return [...Array.from({ length: n }, (_, i) => String(i)), ...ids.filter((x) => !/^\d+$/.test(x))];
}
function qRows() {
  if (ui.qDraft) return ui.qDraft;
  const QQ = Q();
  return { questions: liveQuestions(QQ).map((q) => ({ id: q.id, text: q.text })),
    scale: QQ && QQ.scale.length ? QQ.scale.slice(0, SCALE_SIZE) : Array(SCALE_SIZE).fill(""),
    guide: QQ ? QQ.guide.join("\n") : "" };
}
function qDraft() { if (!ui.qDraft) ui.qDraft = JSON.parse(JSON.stringify(qRows())); return ui.qDraft; }
function questionsEditor() {
  const d = qRows(), locked = qLocked(), none = !Q();
  const rows = d.questions.map((q, i) => `<div class="qedrow">
      <textarea id="qText-${i}" rows="2" aria-label="Question ${i + 1}" oninput="IV.qSet(${i},this.value)">${escapeHtml(q.text)}</textarea>
      ${locked ? "" : `<div class="qedbtns">
        <button type="button" class="btn ghost small" onclick="IV.qMove(${i},-1)" ${i === 0 ? "disabled" : ""}>Move up</button>
        <button type="button" class="btn ghost small" onclick="IV.qMove(${i},1)" ${i === d.questions.length - 1 ? "disabled" : ""}>Move down</button>
        <button type="button" class="btn ghost small danger" onclick="IV.qRemove(${i})">Remove</button></div>`}
    </div>`).join("");
  const scale = d.scale.map((t, i) => `<label class="qscale"><span>${i + 1}</span>
      <input id="qScale-${i}" type="text" value="${escapeHtml(t)}" aria-label="Rating ${i + 1} means" oninput="IV.qScale(${i},this.value)"/></label>`).join("");
  return `${locked ? `<p class="note">Locked because scoring has started. You can fix spelling, but not add, remove or reorder questions.</p>` : ""}
    ${none && !d.questions.length && idsWithNotes(S.scores).length ? `<p class="note">Scores already have notes filed under ${idsFromNotes().length} question${idsFromNotes().length === 1 ? "" : "s"},
        but the questions themselves are missing. Restore them from a backup file (below), or start from those questions and type
        each one again, so the notes stay with them. <button class="linky" onclick="IV.qFromNotes()">Start from the noted questions</button></p>`
      : none && !d.questions.length ? `<p class="note">No interview questions yet. Add them below, or restore them from a backup file (Restore from a backup file, below).</p>` : ""}
    <div class="qedlist">${rows}</div>
    ${locked ? "" : `<button type="button" class="btn ghost small" onclick="IV.qAdd()">Add a question</button>`}
    <div class="ed-label" style="margin-top:14px">Rating scale</div>
    <div class="qscales">${scale}</div>
    <label class="ed-label" for="qGuide" style="margin-top:14px">Guidance for panelists</label>
    <textarea id="qGuide" rows="3" oninput="IV.qGuide(this.value)">${escapeHtml(d.guide)}</textarea>
    <p class="small muted" style="margin:.3rem 0 0">One per line.</p>
    <div class="adminbar" style="margin-top:.6rem"><button class="btn tinted small" onclick="IV.saveQuestions(this)">Save questions</button>
      ${ui.qDraft ? `<button class="btn ghost small" onclick="IV.qDiscard()">Discard changes</button>` : ""}</div>`;
}


// ------------------------------------------------ Setup → rounds (H1, R6)
const RETENTION = [[12, "1 year"], [24, "2 years"], [36, "3 years"], [60, "5 years"], [84, "7 years"], [0, "Until we delete them by hand"]];
const retentionNow = () => { const m = (S.settings || {}).retentionMonths; return Number.isInteger(m) && m > 0 ? m : 0; };
const retentionLabel = () => (RETENTION.find(([m]) => m === retentionNow()) || [0, ""])[1];
const longDay = (at) => { const d = toDate(at); return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
function roundBody() {
  const st = S.meta || {};
  const kept = st.keptFromClose || [];
  const keptBlock = kept.length ? `<div class="note warnbox"><b class="warn">${ICON.warn} ${kept.length} item${kept.length === 1 ? " was" : "s were"} kept from the closed round
      because someone changed ${kept.length === 1 ? "it" : "them"} after the copy was saved.</b>
      <div class="row backup-actions" style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.keptDelete(this)">Download and delete them</button>
      <button class="btn ghost small" onclick="IV.keptKeep(this)">Keep them in this round</button></div></div>` : "";
  return `<label class="ed-label" for="rnName">Round name</label>
    <input id="rnName" type="text" value="${escapeHtml(st.roundName || "")}" placeholder="Hiring round ${new Date().getFullYear()}"/>
    <div class="row backup-actions" style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.saveRoundName(this)">Save name</button>
      <button class="btn ghost small danger" onclick="IV.closeRound()" ${kept.length ? "disabled" : ""}>Close this round</button></div>
    ${kept.length ? `<p class="small muted">First decide what to do with the ${kept.length} item${kept.length === 1 ? "" : "s"} kept from the last close.</p>` : ""}
    ${keptBlock}`;
}
function pastBody() {
  const p = ui.past;
  if (!p) return `<p class="muted small">Loading…</p>`;
  if (p.error) return `<p class="small bad">Couldn't load past rounds. ${escapeHtml(p.error)}</p>`;
  const now = Date.now();
  const closed = p.list.filter((a) => a.status === "closed").sort((a, b) => (toDate(b.closedAt) || 0) - (toDate(a.closedAt) || 0));
  const copies = p.list.filter((a) => a.status !== "closed" && a.id !== (S.meta || {}).closingAttemptId);
  const rows = closed.map((a) => {
    const until = a.deleteAfter ? toDate(a.deleteAfter) : null, due = until && until.getTime() <= now;
    const n = (a.counts || {}).interviews_candidates;
    return `<div class="hrow"><div class="grow"><div><b>${escapeHtml(a.name || "Hiring round")}</b></div>
        <div class="small muted">closed ${escapeHtml(longDay(a.closedAt))}${n != null ? ` · ${n} applicant${n === 1 ? "" : "s"}` : ""} · ${until ? `kept until ${escapeHtml(longDay(a.deleteAfter))}` : "kept until deleted by hand"}${a.restoredAt ? " · brought back once" : ""}</div>
        <div class="panelacts" style="display:flex">
          <button class="linky small" onclick="IV.pastDownload('${a.id}')">Download backup file</button>
          <button class="linky small" onclick="IV.pastExcel('${a.id}')">Download Excel</button>
          <button class="linky small" onclick="IV.pastPrint('${a.id}')">Print summary</button>
          <button class="linky small" onclick="IV.pastBringBack('${a.id}')">Bring back</button>
          ${due ? `<button class="linky small danger" onclick="IV.pastDelete('${a.id}')">Delete permanently</button>`
            : `<span class="small muted">${until ? `Can be deleted after ${escapeHtml(longDay(a.deleteAfter))}` : "Set how long to keep closed rounds to allow deleting"}</span>`}</div></div></div>`;
  }).join("");
  return `${rows ? `<div class="hlist">${rows}</div>` : `<p class="muted small">No closed rounds yet.</p>`}
    ${copies.length ? `<details class="raters"><summary>Unfinished copies (safe to delete): ${copies.length}</summary>
      <div class="hlist">${copies.map((a) => `<div class="hrow"><div class="grow small">${escapeHtml(a.name || "Copy")} · ${escapeHtml(a.status)}${a.startedAt ? " · " + escapeHtml(longDay(a.startedAt)) : ""}</div>
        <button class="linky small danger" onclick="IV.pastDeleteCopy('${a.id}')">Delete</button></div>`).join("")}</div></details>` : ""}`;
}
function retentionBody() {
  const cur = retentionNow();
  return `<select id="retSel" onchange="IV.setRetention(this.value)" aria-label="Keep closed rounds for">${RETENTION.map(([m, l]) =>
    `<option value="${m}" ${m === cur ? "selected" : ""}>${l}</option>`).join("")}</select>
    <p class="small muted">Nothing is ever deleted automatically. After this time, Past rounds offers "Delete permanently".</p>`;
}
function restoreBody() {
  const r = ui.restore;
  const pick = `<label class="btn tinted small filepick">${r ? "Choose another file" : "Choose file"}<input type="file" id="rsFile" accept=".json,application/json" onchange="IV.restoreFile(this)" hidden/></label>`;
  if (!r) return `<p class="small" style="margin-top:0">Choose a backup file saved from this tool. Nothing is written until you press Restore.</p>${pick}`;
  if (r.error) return `<p class="small bad">${escapeHtml(r.error)}</p>${pick}`;
  const p = r.plans[r.mode];
  const radio = (m, label, plan) => `<label class="small rsmode"><input type="radio" name="rsMode" value="${m}" ${r.mode === m ? "checked" : ""} ${plan.ok ? "" : "disabled"}
      onchange="IV.restoreMode('${m}')"/> ${label}${plan.ok ? "" : ` <span class="muted">(${escapeHtml(plan.why)})</span>`}</label>`;
  const rows = p.rows.map((x) => `<tr><th>${escapeHtml(x.label)}</th><td>${x.inFile}</td><td>${x.now}</td><td>${x.add}</td><td>${x.same}</td><td>${x.different}</td></tr>`).join("");
  return `<p class="small" style="margin-top:0">${escapeHtml(r.fileName)} · ${escapeHtml((r.backup.round || {}).name || "a round")} · saved ${escapeHtml(longDay(r.backup.exportedAt))}</p>
    ${radio("missing", "Bring back missing items only", r.plans.missing)}
    ${radio("replace", "Replace the working round with this backup", r.plans.replace)}
    <div class="tablewrap"><table class="rstable"><thead><tr><th></th><th>In the file</th><th>Here now</th><th>Will be added</th><th>Same</th><th>Different (left as is)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${[...p.warnings, ...p.skipped].map((w) => `<p class="small">${escapeHtml(w)}</p>`).join("")}
    <p id="rsProgress" class="small muted"></p>
    <div class="row backup-actions"><button class="btn filled small" onclick="IV.restoreGo(this)" ${p.ok && (p.total || Object.keys(p.meta).length) ? "" : "disabled"}>Restore</button>
      <button class="btn ghost small" onclick="IV.restoreCancel()">Cancel</button>${pick}</div>`;
}
// Apply a restore plan: documents (decoded for this store), then the meta
// documents it carries, with one history entry.
async function applyRestore(plan, backup, label) {
  const writes = plan.writes.map((w) => ({ coll: w.coll, id: w.id, data: store.decode(w.data) }));
  const meta = plan.meta;
  if (meta.configCommittee) writes.push({ coll: "interviews_meta", id: "config", data: { committee: store.decode(meta.configCommittee) }, mergeFields: ["committee"] });
  if (meta.config) writes.push({ coll: "interviews_meta", id: "config", data: store.decode(meta.config) });
  if (meta.questions) writes.push({ coll: "interviews_meta", id: "questions", data: store.decode(meta.questions) });
  if (meta.schedule) writes.push({ coll: "interviews_meta", id: "schedule", data: store.decode(meta.schedule) });
  if (meta.state) writes.push({ coll: "interviews_meta", id: "state", data: store.decode(meta.state) });
  if (meta.public) writes.push({ coll: "interviews_public", id: "slots", data: meta.public, mergeFields: ["times", "slots", "booking"] });
  const n = plan.writes.length;
  const el = () => $("#rsProgress");
  await track(store.applyPlan({ writes }, hEntry(plan.mode === "replace" ? "round.restore" : "backup.restore",
    `${label} (${n} item${n === 1 ? "" : "s"})`, { by: byWho(), ...(meta.replacedQuestions && meta.replacedQuestions.length ? { undo: { kind: "reference", questions: meta.replacedQuestions } } : {}) }),
    { onProgress: (done, all) => { if (el()) el().textContent = `Restoring... ${done} of ${all}`; } }));
  return n;
}

// ------------------------------------- Setup → Passwords for all ED tools (H3)
// The logic (order, sign in just before each change, converge) is in
// js/passwords.js; this is the card and the dialog. Values typed here live only
// in this dialog's closure and are wiped when it closes: never storage,
// Firestore, the console or history.
const TOOL_OF = { voting: "Motion Voting", hiring: "Physician Hiring" };
function passwordsBody() {
  // R7: the card waits until the questions live in the database, so nothing
  // the page needs can depend on a password (design 5.2).
  if (!S.questions) return `<p class="note">This opens once the interview questions are saved in the database (Interview questions, above).</p>`;
  if (!isConfigured() || !_fb) return `<p class="small muted">Passwords can only be changed on the live site.</p>`;
  const pm = S.passwordsMeta || {};
  const rows = ROLES.map((r) => {
    const d = longDay(pm[r] && pm[r].changedAt);
    return `<div class="hrow"><div class="grow small"><b>${ROLE_WORD[r]}</b>: ${d ? `last changed ${escapeHtml(d)}` : "Not changed in this app yet"}</div></div>`;
  }).join("");
  const pend = pm.pending;
  // while a change is unfinished, the only way in is to finish it (a new
  // change would lose the record of where the old one stopped)
  return `${pend ? `<p class="small bad">A password change didn't finish${longDay(pend.startedAt) ? ` (started ${escapeHtml(longDay(pend.startedAt))})` : ""}.
      <button class="linky" onclick="IV.changePasswords(true)">Open it to finish</button></p>` : ""}
    <div class="hlist">${rows}</div>
    <p class="small muted">These open Physician Hiring, Motion Voting and the Patient Hub statistics page.</p>
    ${pend ? "" : `<div class="row backup-actions"><button class="btn tinted small" onclick="IV.changePasswords(false)">Change a password</button></div>`}`;
}
function pwAdapter() {
  const fb = _fb;
  return makeFirebaseAdapter({ ...fb.authFns, ...fb.appFns },
    { mainAuth: fb.auth, configs: { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig } });
}
const pwTools = (r) => [...new Set(ACCOUNTS.filter((a) => a.role === r).map((a) => TOOL_OF[a.project]))];
const pwWords = (roles) => { const w = roles.map((r) => ROLE_WORD[r]); return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]; };
const pwField = (id, label, auto) => `<label class="ed-label" for="${id}">${escapeHtml(label)}</label>
  <div class="pwfield"><input id="${id}" type="password" autocomplete="${auto}" autocapitalize="off" spellcheck="false"/>
  <button type="button" class="btn ghost small" onclick="IV.pwShow('${id}',this)" aria-label="Show ${escapeHtml(label)}">Show</button></div>`;

async function changePasswords(resuming) {
  if (!S || !S.questions || !isConfigured() || !_fb || ui.role !== "admin") return;
  // an unfinished change is always finished first, whatever button was used
  const pend = S.passwordsMeta && S.passwordsMeta.pending;
  // everything typed lives here, and only for as long as the dialog is open
  const v = { roles: pend ? ROLES.filter((r) => (pend.roles || []).includes(r)) : [], cur: {}, next: {}, overrides: {} };
  const wipe = () => { v.cur = {}; v.next = {}; v.overrides = {}; };
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  const msg = (t) => { const el = document.getElementById("pwErr"); if (el) el.innerHTML = t; };
  const ad = pwAdapter();
  const tick = (ok) => (ok ? `<span class="ok">ready</span>` : `<span class="bad">refused</span>`);

  await flowDialog((ctl) => {
    const step1 = () => ctl.step({ title: "Which password?", html: `
      <p class="small">Tick the passwords to change.</p>
      <div class="pwticks">${ROLES.map((r) => `<label class="pwtick"><input type="checkbox" value="${r}" ${v.roles.includes(r) ? "checked" : ""}/> ${ROLE_WORD[r]}</label>`).join("")}</div>
      <p id="pwErr" class="small bad"></p>`,
      buttons: [{ label: "Cancel", run: () => ctl.close(null) },
        { label: "Next", kind: "filled", run: () => {
          v.roles = ROLES.filter((r) => document.querySelector(`#flowBody .pwtick input[value="${r}"]`).checked);
          if (!v.roles.length) { msg("Tick at least one password to change."); return; }
          step2();
        } }] });

    const read = () => {
      v.cur = Object.fromEntries(ROLES.map((r) => [r, val("pwCur_" + r)]));
      v.next = Object.fromEntries(v.roles.map((r) => [r, { value: val("pwNew_" + r), repeat: val("pwRep_" + r) }]));
      v.overrides = {};
      for (const a of accountsFor(v.roles)) { const x = val("pwOv_" + a.key.replace(":", "_")); if (x) v.overrides[a.key] = x; }
    };
    const step2 = () => {
      const warn = [];
      if (v.roles.includes("leadership") || v.roles.includes("ed")) warn.push("Everyone signed in with the old password will be asked for the new one within about an hour, including phones signed in to Motion Voting. Don't do this on a voting day.");
      if (v.roles.includes("guest")) warn.push("Applicants who have the old Guest password won't be able to sign in. Send them the new one.");
      if (v.roles.includes("leadership")) warn.push("Patient Hub statistics follow this password automatically.");
      ctl.step({ title: pend ? "Finish the password change" : "Type the passwords", html: `
        ${pend ? `<p class="small">Type the current and new values again. Accounts already changed are only checked with the new value.</p>` : ""}
        <div class="pwgroup">${ROLES.map((r) => pwField("pwCur_" + r, `Current ${ROLE_WORD[r]} password`, "off")).join("")}</div>
        ${v.roles.map((r) => `<div class="pwgroup">${pwField("pwNew_" + r, `New ${ROLE_WORD[r]} password`, "new-password")}
          ${pwField("pwRep_" + r, `Type the new ${ROLE_WORD[r]} password again`, "new-password")}</div>`).join("")}
        <p class="small muted">At least 10 characters. Three or four words are easy to say and hard to guess. Don't reuse a password from another site.</p>
        ${warn.map((w) => `<p class="small">${escapeHtml(w)}</p>`).join("")}
        <details class="pwdrift"><summary class="small">The tools already have different passwords</summary>
          <p class="small muted">Only if one account uses a different current value. Leave the rest blank.</p>
          ${accountsFor(v.roles).map((a) => pwField("pwOv_" + a.key.replace(":", "_"), `Current password for ${a.label}`, "off")).join("")}
        </details>
        <p id="pwErr" class="small bad" role="alert"></p>`,
        buttons: [{ label: "Back", run: () => { read(); step1(); } },
          { label: pend ? "Finish the change" : "Check", kind: "filled", run: async (_c, btn) => {
            read();
            const errs = validateNew(v.roles, v.cur, v.next, v.overrides);
            if (errs.length) { msg(errs.map(escapeHtml).join("<br>")); return; }
            btn.disabled = true;
            if (pend) { await change(pend); return; }
            msg(""); btn.textContent = "Checking...";
            await check();
          } }] });
    };

    // Step 3: prove every account with its current value. Changes nothing.
    const check = async () => {
      ctl.step({ title: "Checking", html: `<p class="small">Signing in to each account with its current password. Nothing is changed.</p>` });
      let r;
      try { r = await preflight(ad, v.roles, v.cur, v.overrides); }
      catch (e) { r = { ok: false, results: [{ ok: false, why: "error", label: "" }] }; }
      const list = r.results.map((x) => `<li>${escapeHtml(x.label)}: ${tick(x.ok)}</li>`).join("");
      if (!r.ok) {
        const bad = r.results[r.results.length - 1];
        const a = ACCOUNTS.find((x) => x.key === bad.key);
        const text = bad.why === "throttled" ? "Firebase has paused sign-ins from this device for about 15 minutes. Nothing was changed. Wait, then try once."
          : bad.why === "disabled" ? `${a.label} is switched off in Firebase, so nothing was changed. The department account can switch it back on in the Firebase console (Authentication, Users).`
          : bad.why === "refused" ? `${TOOL_OF[a.project]}'s ${ROLE_WORD[a.role]} account didn't accept the current ${ROLE_WORD[a.role]} password, so nothing was changed. The tools may already have different ${ROLE_WORD[a.role]} passwords; open "The tools already have different passwords". If nobody knows the current password for this account, it can only be reset in the Firebase console by the department account.`
          : "Couldn't reach the sign-in service, so nothing was changed. Check the connection and try again.";
        ctl.step({ title: "Nothing was changed", html: `<ul class="pwlist">${list}</ul><p class="small">${escapeHtml(text)}</p>`,
          buttons: [{ label: "Close", run: () => ctl.close(null) }, { label: "Back", kind: "filled", run: () => step2() }] });
        return;
      }
      ctl.step({ title: "Ready to change", html: `<ul class="pwlist">${list}</ul>
        <p class="small">Every account accepted its current password. Change now changes them one by one; it takes a few seconds. Keep this page open until it says Done.</p>`,
        buttons: [{ label: "Cancel", run: () => ctl.close(null) }, { label: "Change now", kind: "danger", run: () => change(null) }] });
    };

    // Step 4: change, in the fixed order, each account signed in just before.
    const change = async (progress) => {
      const accts = accountsFor(v.roles);
      const state = Object.fromEntries(accts.map((a) => [a.key, (progress && (progress.done || []).includes(a.key)) ? "done" : "waiting"]));
      const paint = () => ctl.step({ title: "Changing", html: `<ul class="pwlist">${accts.map((a) => `<li>${escapeHtml(a.label)}: ${
        state[a.key] === "done" ? `<span class="ok">changed</span>` : state[a.key] === "now" ? "changing..." : `<span class="muted">waiting</span>`}</li>`).join("")}</ul>
        <p class="small">Keep this page open.</p>` });
      paint();
      // closing or reloading the page now would leave the tools half changed
      const leaving = (e) => { e.preventDefault(); e.returnValue = ""; };
      window.addEventListener("beforeunload", leaving);
      try { await changeSteps(progress, accts, state, paint); }
      finally { window.removeEventListener("beforeunload", leaving); }
    };
    const changeSteps = async (progress, accts, state, paint) => {
      let startedAt = null;
      try {
        await store.updatePasswords((d) => {
          const keep = d && d.pending && JSON.stringify(d.pending.roles) === JSON.stringify(v.roles) ? d.pending : null;
          startedAt = keep ? keep.startedAt : store.now();
          return { ...(d || {}), pending: { roles: v.roles, startedAt, done: keep ? keep.done || [] : [], inProgress: keep ? keep.inProgress || null : null } };
        });
      } catch (e) { return failed({ done: [], failedAt: accts[0].key, error: e }, "save"); }
      const record = async (p) => {
        for (const a of accts) state[a.key] = p.done.includes(a.key) ? "done" : p.inProgress === a.key ? "now" : "waiting";
        paint();
        await store.updatePasswords((d) => ({ ...(d || {}), pending: { roles: v.roles, startedAt: (d && d.pending && d.pending.startedAt) || startedAt, done: p.done, inProgress: p.inProgress } }));
      };
      const r = await applyChange(ad, v.roles, v.cur, v.next, { overrides: v.overrides, progress: progress || {}, record });
      if (r.failedAt) return failed(r);
      // verify with the new values, in fresh memory-only helpers
      ctl.step({ title: "Checking the new passwords", html: `<p class="small">Signing in to each account with its new password.</p>` });
      const bad = await verify(ad, v.roles, v.next);
      if (bad.length) {
        // not confirmed is not the same as wrong: Try again checks those
        // accounts with the new value first, and a lost connection or a pause
        // is reported as that
        const keys = bad.map((b) => b.key);
        const why = bad.find((b) => b.why !== "refused") || bad[0];
        const doneNow = r.done.filter((k) => !keys.includes(k));
        // kept in the record too, so a visit after the page closed checks them first
        try { await store.updatePasswords((d) => ({ ...(d || {}), pending: { ...((d && d.pending) || { roles: v.roles }), done: doneNow, inProgress: null, unsure: keys } })); }
        catch { /* the dialog still has it */ }
        return failed({ done: doneNow, failedAt: keys[0], unsure: keys,
          error: Object.assign(new Error("verify"), { code: why.why === "refused" ? "mismatch" : why.code || why.why }) });
      }
      try {
        const now = store.now();
        await store.updatePasswords((d) => ({ ...(d || {}), ...Object.fromEntries(v.roles.map((x) => [x, { changedAt: now }])), pending: null }),
          hEntry("passwords.change", `Changed the ${pwWords(v.roles)} password${v.roles.length > 1 ? "s" : ""}`, { by: byWho() }));
      } catch { /* the change itself is done; the dates are only a note */ }
      done();
    };

    const failed = (r, where) => {
      const lines = halfDoneText(v.roles, r.done);
      const code = String((r.error && r.error.code) || "");
      const acct = ACCOUNTS.find((a) => a.key === r.failedAt);
      const why = where === "save" ? "Couldn't save the progress note, so nothing was changed. Check the connection and try again."
        : /too-many-requests/.test(code) ? "Firebase has paused sign-ins from this device for about 15 minutes. Wait, then press Try again once."
        : /user-disabled/.test(code) ? `${acct ? acct.label : "An account"} is switched off in Firebase. The department account can switch it back on in the Firebase console (Authentication, Users), then press Try again.`
        : code === "mismatch" ? `${acct ? acct.label : "An account"} didn't take the new password. Press Try again.`
        : code === "refused" ? "An account didn't accept its current password. If nobody knows the current password for this account, it can only be reset in the Firebase console by the department account."
        : /network/.test(code) ? "The connection dropped." : "";
      const body = lines.length
        ? `${lines.join(" ")} Nothing is broken, but the tools now use different passwords. Try again to finish.`
        : r.done.length ? "Try again to finish." : "Nothing was changed yet.";
      ctl.step({ title: "Not finished", html: `<p class="small">${escapeHtml(body)}</p>${why ? `<p class="small">${escapeHtml(why)}</p>` : ""}`,
        buttons: [{ label: "Close", run: () => ctl.close(null) },
          { label: "Try again", kind: "filled", run: () => change({ done: r.done, inProgress: r.failedAt, unsure: r.unsure || [] }) }] });
    };

    const done = () => {
      const who = ui.member ? mname(ui.member) : "ED leadership";
      const words = pwWords(v.roles), many = v.roles.length > 1;
      const note = `The ${words} password${many ? "s" : ""} for the ED tools changed today. Ask ${who} for the new one${many ? "s" : ""}.`;
      const works = v.roles.map((r) => {
        const t = pwTools(r); if (r === "leadership") t.push("the Patient Hub statistics page");
        return `The new ${ROLE_WORD[r]} password works in ${t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}` : t[0]}.`;
      });
      wipe();
      ctl.step({ title: "Done", html: `${works.map((w) => `<p class="small">${escapeHtml(w)}</p>`).join("")}
        <p class="small"><b>Next: tell people in person or by phone. Never email a password.</b></p>
        <label class="ed-label" for="pwNote">A message without the password</label>
        <textarea id="pwNote" rows="3" readonly>${escapeHtml(note)}</textarea>`,
        buttons: [{ label: "Copy the message", run: async (_c, btn) => {
          const t = document.getElementById("pwNote");
          try { await navigator.clipboard.writeText(note); btn.textContent = "Copied"; }
          catch { t.focus(); t.select(); btn.textContent = "Selected: copy it"; }
        } }, { label: "Close", kind: "filled", run: () => ctl.close(null) }] });
    };

    if (pend) step2(); else step1();
  }, { sticky: true, onClose: wipe });
  wipe();
  rerenderSettings();
}

// ------------------------------------------------ Setup → Change history (H12)
// One-shot reads, 50 at a time; never a listener. Names come from ids now.
function historyBody() {
  const h = ui.hist;
  if (!h) return `<p class="muted small">Loading…</p>`;
  if (h.error) return `<p class="small bad">Couldn't load the change history. ${escapeHtml(h.error)}</p>`;
  if (!h.entries.length) return `<p class="muted small">No changes recorded yet.</p>`;
  const done = undoneIds(h.entries);
  const ctx = { candName: (id) => (cand(id) || {}).name, memberName: mname };
  const rows = h.entries.map((e) => {
    const u = canUndo(e, S, done);
    const act = u.ok ? `<button class="linky" onclick="IV.undoHistory('${escapeHtml(e.id)}',this)">Undo</button>`
      : u.why ? `<span class="muted small">${escapeHtml(u.why)}</span>` : "";
    return `<div class="hrow"><div class="grow"><div class="muted small">${escapeHtml(whenFor(e.at))} · ${escapeHtml(whoFor(e, mname))}</div>
      <div class="small">${escapeHtml(textFor(e, ctx))}</div></div>${act}</div>`;
  }).join("");
  return `<div class="hlist">${rows}</div>${h.next ? `<p class="toolline"><button class="linky" onclick="IV.moreHistory(this)">Show more</button></p>` : ""}`;
}
function refreshHistoryCard() {
  const d = document.querySelector('details[data-sec="setHistory"] .sec-body');
  if (d) d.innerHTML = historyBody();
}
// H8: what the messages need, from Setup and the current page address.
function msgCtx() {
  const info = EFF().interviewInfo, dl = EFF().deadlines;
  return { applicantLink: new URL("index.html#apply", location.href).href, staffLink: new URL("index.html", location.href).href,
    location: info.location || "", zoomLink: info.zoomLink || "", contact: info.contact || "", replyBy: dl.reply || "", availabilityBy: dl.availability || "" };
}
function panelMsg(p) {
  const c = cand(p.cand) || { name: "the applicant" };
  const t = EFF().slots.find((x) => x.id === String(p.slot));
  return { name: c.name, slot: t || { label: slotName(p.slot) }, room: p.room || 1, modality: p.modality,
    chairName: p.chair ? mname(p.chair) : null, memberNames: p.members.map(mname),
    typeFirst: c.id ? typeExactly(S.candidates, c) : null };
}
function icsFor(p, forApplicant) {
  const t = EFF().slots.find((x) => x.id === String(p.slot));
  if (!t || !isStructured(t)) return null;
  const m = panelMsg(p), ctx = msgCtx();
  const where = p.modality === "zoom" ? (ctx.zoomLink || "Zoom") : [ctx.location, p.room === 2 ? "room 2" : ""].filter(Boolean).join(", ");
  return icsEvent({ uid: `${p.slot}-${p.room || 1}-${p.cand}@mgh-ed-hiring`, date: t.date, start: t.start, end: t.end,
    summary: forApplicant ? "Interview with the MGH Emergency Department" : `ED physician interview: ${salutation(m.name)}`,
    description: forApplicant ? "" : `Panel: ${[m.chairName ? `${m.chairName} (chair)` : null, ...m.memberNames.filter((x) => x !== m.chairName)].filter(Boolean).join(", ")}`,
    location: where });
}

// H14: give every active applicant who shares a surname their own key (and say
// so). Never moves an existing surname-only document: Needs attention asks whose.
async function separateShared(announce) {
  const keys = assignKeys(S.candidates);
  if (!Object.keys(keys.patches).length) { if (announce) toast("Nothing to separate", "ok"); return; }
  try {
    await track(store.setCandidates(keys.patches, hEntry("roster.rename", "Gave applicants who share a last name their own answers", { by: byWho() })));
  } catch { toast("Couldn't save. Check your connection", "err"); return; }
  const texts = keys.groups.map((g) => sharedSurnameText(S.candidates, g.key)).filter(Boolean);
  if (texts.length) await confirmDialog(texts.join("\n\n"), { title: "Shared last name", yes: "OK", danger: false });
}

// Undo one entry: only if the thing it changed is exactly as the entry left it.
// The undo is itself logged, pointing back at the entry (so the card can say
// "Undone." instead of offering it again).
async function applyUndo(e) {
  const u = e.undo || {};
  const mark = hEntry("undo", `Undid: ${e.text}`, { by: byWho(), cand: e.cand, undo: { of: e.id || null } });
  if (u.kind === "panelOverrides") {
    const ids = Object.keys(u.before || {});
    await store.updateConfig((c) => {
      const cur = { ...(c.panelOverrides || {}) };
      if (hashOf(Object.fromEntries(ids.map((k) => [k, cur[k] || null]))) !== u.afterHash) throw new Error("Can't undo: changed since.");
      ids.forEach((k) => { if (u.before[k]) cur[k] = u.before[k]; else delete cur[k]; });
      return { panelOverrides: cur };
    }, mark);
    return;
  }
  if (u.kind === "shortlist") {
    await store.txDoc("interviews_candidates", e.cand, (before) => {
      if (!before) throw new Error("That applicant is gone.");
      const cur = { shortlist: before.shortlist || null, shortlistBy: before.shortlistBy || null };
      if (hashOf(cur) !== u.afterHash) throw new Error("Can't undo: changed since.");
      const next = { ...before };
      if (u.before.shortlist) { next.shortlist = u.before.shortlist; next.shortlistBy = u.before.shortlistBy; }
      else { delete next.shortlist; delete next.shortlistBy; delete next.shortlistAt; }
      return next;
    }, mark);
    return;
  }
  if (u.kind === "screening") {
    await store.txDoc("interviews_screening", u.id, (before) => {
      if (hashOf(before || null) !== u.afterHash) throw new Error("Can't undo: changed since.");
      return u.before;
    }, mark);
    return;
  }
  throw new Error("This change can't be undone here.");
}

// ---------------------------------------------- Setup → Interview times editor
// Draft form values live in `ui` so a live re-render (someone else saving) never
// wipes what the admin is typing.
const tAdd = () => (ui.tAdd = ui.tAdd || { date: "", from: "", to: "", len: "60" });
const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hhmmOf = (v) => String(v || "").slice(0, 5); // some browsers report "09:00:00"
// answers per time, counting only people who matter (same basis as the dashboard)
const answerCounts = () => responseCounts(EFF().interviewers.map((m) => S.availIv[m.id]), activeCands().map(availForCand));
// Setup re-renders on every live update. Hold it while the admin is typing in a
// times form or a save is in flight (a re-render would close pickers, drop a
// half-typed date, or swap the busy button), then catch up shortly after.
const setupBusy = () => ui.tBusy || !!(document.activeElement && document.activeElement.closest && document.activeElement.closest("#settings .tform"));
function refreshSetup() {
  if (!setupOpen()) return;
  if (setupBusy()) { ui.setupStale = true; return; }
  ui.setupStale = false; rerenderSettings();
}
function flushSetup() {
  clearTimeout(flushSetup._t);
  // delay so a click that moved focus (e.g. onto Save) completes on the old DOM first
  flushSetup._t = setTimeout(() => { if (ui.setupStale) refreshSetup(); }, 250);
}
// after our own save, always show the result (Safari leaves focus in the form)
// A counter, not a flag, so overlapping saves don't release each other early.
async function timesBusy(fn) {
  // iOS leaves focus in the input when a button is tapped; drop it so the
  // confirmed change (which lands after the save resolves) isn't held back
  const a = document.activeElement;
  if (a && a.closest && a.closest("#settings .tform")) a.blur();
  ui.tBusy = (ui.tBusy || 0) + 1;
  try { return await fn(); }
  finally { ui.tBusy--; if (!ui.tBusy && ui.setupStale && setupOpen()) { ui.setupStale = false; rerenderSettings(); } }
}
function answersText(c) {
  if (!c || (!c.iv && !c.cand)) return "";
  return [c.iv ? pl(c.iv, "interviewer") : "", c.cand ? pl(c.cand, "applicant") : ""].filter(Boolean).join(" and ");
}
// who is currently scheduled (auto or manual) at the given time ids
function panelsAt(ids) {
  const set = new Set(ids);
  let res; try { res = computePanels(); } catch { return []; }
  return res.panels.filter((p) => set.has(String(p.slot)))
    .map((p) => ({ name: (cand(p.cand) || {}).name || p.cand, manual: !!p.manual, time: p.slot }));
}
function addPreview() {
  const a = tAdd();
  const items = a.date ? splitRange(a.date, a.from, a.to, +a.len) : [];
  if (!a.date || !a.from || !a.to) return `<span class="muted">Pick a date, a start and an end.</span>`;
  if (!items.length) return +a.len && a.to > a.from
    ? `<span class="bad">That range is shorter than one ${a.len}-minute interview.</span>`
    : `<span class="bad">The end must be after the start.</span>`;
  return `Adds <b>${pl(items.length, "time")}</b> on ${escapeHtml(fmtDate(a.date))}: ${items.map((t) => escapeHtml(slotTimeLabel(t))).join(", ")}`;
}
function timesEditor(slots) {
  const counts = answerCounts();
  const booked = {}; panelsAt(slots.map((t) => t.id)).forEach((p) => { booked[p.time] = (booked[p.time] || 0) + 1; });
  const ed = ui.tEdit;
  const row = (t) => {
    if (ed && ed.id === t.id) return `<div class="trow editing">
      <div class="tform">
        <label>Date<input type="date" id="tEdDate" value="${escapeHtml(ed.date)}" oninput="IV.tEditField('date',this.value)"/></label>
        <label>Start<input type="time" id="tEdStart" value="${escapeHtml(ed.start)}" oninput="IV.tEditField('start',this.value)"/></label>
        <label>End<input type="time" id="tEdEnd" value="${escapeHtml(ed.end)}" oninput="IV.tEditField('end',this.value)"/></label>
      </div>
      <div class="adminbar" style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.tSave(this)">Save</button>
        <button class="btn ghost small" onclick="IV.tEditCancel()">Cancel</button></div></div>`;
    const c = answersText(counts[t.id]);
    const b = booked[t.id] ? `<span class="pill neutral">Panel booked</span>` : "";
    const two = t.rooms === 2;
    const roomSeg = isStructured(t) ? `<span class="seg roomseg" role="group" aria-label="Rooms for ${escapeHtml(slotLabel(t))}">
        <button type="button" class="${two ? "" : "on"}" aria-pressed="${!two}" onclick="IV.setRooms('${t.id}',1)">1 room</button>
        <button type="button" class="${two ? "on" : ""}" aria-pressed="${two}" onclick="IV.setRooms('${t.id}',2)">2 rooms</button></span>` : "";
    return `<div class="trow"><div class="grow"><span class="ttime">${escapeHtml(slotTimeLabel(t))}</span>
        <span class="muted small">${c ? escapeHtml(c) + " answered" : "no answers yet"}</span> ${b} ${roomSeg}</div>
      <button class="linky" onclick="IV.tEdit('${t.id}')" aria-label="Edit ${escapeHtml(slotLabel(t))}">Edit</button>
      <button class="linky danger" onclick="IV.tRemove(['${t.id}'])" aria-label="Remove ${escapeHtml(slotLabel(t))}">Remove</button></div>`;
  };
  // H13: who chairs each day, and who leads room 2 on a day with two-room times
  const { interviewers: ivs, chair: usual, days } = EFF();
  const dayCtl = (g) => {
    if (!g.date) return "";
    const d = days[g.date] || {};
    const cur = d.chair === "none" ? "none" : d.chair || "";
    const sel = `<label class="small daychair">Chair this day:
      <select onchange="IV.setDayChair('${g.date}',this.value)" aria-label="Chair on ${escapeHtml(g.title)}">
        <option value="" ${cur === "" ? "selected" : ""}>${escapeHtml(mname(usual))} (usual chair)</option>
        ${ivs.filter((m) => m.id !== usual).map((m) => `<option value="${escapeHtml(m.id)}" ${cur === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
        <option value="none" ${cur === "none" ? "selected" : ""}>No chair this day</option></select></label>${infoIcon("If the chair can't come on a day, pick who leads that day's panels, or choose no chair.")}`;
    const lead = g.items.some((t) => t.rooms === 2) ? `<label class="small daychair">Room 2 led by:
      <select onchange="IV.setDayLead('${g.date}',this.value)" aria-label="Room 2 lead on ${escapeHtml(g.title)}">
        <option value="none" ${!d.room2Chair || d.room2Chair === "none" ? "selected" : ""}>No lead</option>
        ${ivs.map((m) => `<option value="${escapeHtml(m.id)}" ${d.room2Chair === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</select></label>` : "";
    return `<div class="dayctl">${sel}${lead}</div>`;
  };
  const list = groupByDate(slots).map((g) => `<div class="tgroup">
      <div class="tgroup-h"><b>${escapeHtml(g.title)}</b> <span class="muted small">· ${pl(g.items.length, "time")}</span>
        <button class="linky danger small" onclick="IV.tRemoveDay('${g.date}')">Remove day</button></div>
      ${dayCtl(g)}
      ${g.items.map(row).join("")}</div>`).join("")
    || `<div class="muted small" style="padding:.4rem 0">No interview times yet. Add some below. Interviewers and applicants will see “times not posted yet” until you do.</div>`;
  const a = tAdd();
  const lens = [["0", "One time (whole range)"], ["30", "30-min interviews"], ["45", "45-min interviews"], ["60", "1-hour interviews"], ["90", "90-min interviews"]];
  return `<div class="note">Everyone picks their availability from these. Changes save immediately and update everyone's screen live.
      Answers stay attached to a time even if you edit it or add others.</div>
    ${list}
    <div class="tadd">
      <div class="tadd-h"><b>Add times</b></div>
      <div class="tform">
        <label>Date<input type="date" id="tAddDate" value="${escapeHtml(a.date)}" oninput="IV.tAddField('date',this.value)"/></label>
        <label>From<input type="time" id="tAddFrom" value="${escapeHtml(a.from)}" oninput="IV.tAddField('from',this.value)"/></label>
        <label>To<input type="time" id="tAddTo" value="${escapeHtml(a.to)}" oninput="IV.tAddField('to',this.value)"/></label>
        <label>Split into<select id="tAddLen" onchange="IV.tAddField('len',this.value)">${lens.map(([v, l]) => `<option value="${v}" ${a.len === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div id="tAddPreview" class="small" style="margin:.55rem 0">${addPreview()}</div>
      <button class="btn tinted small" onclick="IV.tAdd(this)">Add</button>
    </div>`;
}
// Re-render Setup while it's open without losing focus/typing in plain fields.
function rerenderSettings() {
  const act = document.activeElement, id = act && act.id;
  const keep = {}; ["odIn", "dlScreening", "dlAvailability", "dlReply", "thIn", "idLoc", "idZoom", "idContact", "rnName"].forEach((k) => { const el = document.getElementById(k); if (el && el.value !== el.defaultValue) keep[k] = el.value; });
  const sel = act && typeof act.selectionStart === "number" ? [act.selectionStart, act.selectionEnd] : null;
  if (ui.tEdit && !EFF().slotIds.includes(ui.tEdit.id)) { ui.tEdit = null; toast("The time you were editing was just removed by someone else", "err"); }
  renderSettings(); wireSections();
  Object.entries(keep).forEach(([k, v]) => { const el = document.getElementById(k); if (el) el.value = v; });
  const el = id && document.getElementById(id);
  if (el && $("#settings").contains(el)) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* date/time inputs */ } }
}

// ------------------------------------------------------------ candidate view
function proceedCandidate() {
  const saved = ss.get("ed_iv_cand");
  if (saved) ui.candLast = saved;
  $("#candview").classList.remove("hidden");
  renderCandidate();
}
// H11 (review M6): what the public times document says about booking. The
// applicant page reads it BEFORE asking for a name or probing, so a refusal is
// never mistaken for an unknown name.
const bookingNow = () => (S && S.publicInfo && S.publicInfo.booking) || (S && S.booking) || "open";
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthDay = (at) => { const d = toDate(at); return d ? `${MONTH[d.getMonth()]} ${d.getDate()}` : ""; };

function renderCandidate() {
  ui._candBooking = bookingNow();
  const el = $("#candview");
  const slots = effectiveSlots(S.settings, SLOTS);
  const booking = bookingNow();
  if (booking === "paused") {
    el.innerHTML = `<div class="overlay"><div class="overlay-box"><div class="logo" aria-hidden="true">ED</div>
      <h2>Interview availability</h2><p class="muted">Booking is paused. Please try again later.</p>
      <p style="margin-top:16px"><button class="linky" onclick="CAND.logout()">Log out</button></p></div></div>`;
    return;
  }
  if (!ui.candLast) {
    el.innerHTML = `<div class="overlay"><div class="overlay-box"><div class="logo" aria-hidden="true">ED</div>
      <h2>Interview availability</h2><p class="muted">${booking === "closed"
        ? "Booking is closed. If you need to change your times, reply to our email. If you have an interview time, enter your name to see it."
        : "Enter your name to pick the times that work for you. You won't see any other applicants or committee information."}</p>
      <form id="candForm">
        <label class="ed-label candlabel" for="candFirst">First name<input id="candFirst" type="text" autocomplete="given-name" autofocus/></label>
        <label class="ed-label candlabel" for="candName">Last name<input id="candName" type="text" autocomplete="family-name"/></label>
      <button class="primary" type="submit" id="candGo">Continue</button></form>
      <div id="candErr" class="err" role="alert"></div></div></div>`;
    $("#candForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#candName").value.trim(), first = ($("#candFirst") || {}).value ? $("#candFirst").value.trim() : "";
      const err = $("#candErr"), btn = $("#candGo");
      if (v.length < 2) { err.textContent = "Please enter your last name."; return; }
      // H14: the last name alone first (most applicants), then last name plus
      // first name, which is what applicants who share a surname are filed under.
      const tries = [lastKey(v), ...typedFirstKeys(first).map((f) => `${lastKey(v)}-${f}`)];
      // Check the name against the roster BEFORE letting them fill anything in.
      // Applicants can't read the roster, so the rules answer this for us: an
      // unknown surname is refused. Without this, a typo or a name we hold
      // differently saved to a document nobody reads — the applicant saw
      // "Saved" and was never scheduled, which is the failure we're closing.
      err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
      let k = null;
      try {
        for (const t of tries) { if (await store.checkName(t)) { k = t; break; } }
      } catch { // offline or misconfigured: don't accuse them of a wrong name
        err.textContent = "Couldn't reach the server. Check your connection and try again.";
        btn.disabled = false; btn.textContent = "Continue"; return;
      }
      btn.disabled = false; btn.textContent = "Continue";
      // the flag can be a moment behind: re-read it once before saying "can't find"
      if (!k && booking === "open") {
        let b = "open"; try { b = await store.refreshPublic(); } catch { /* keep open */ }
        if (b !== "open") { renderCandidate(); return; }
      }
      if (!k) {
        const err = $("#candErr") || { set innerHTML(v) {} };   // the form may have been redrawn meanwhile
        err.innerHTML = `We can't find <b>${escapeHtml((first ? first + " " : "") + v)}</b> in our applicant list. ` +
          `Please check the spelling, or try the last name exactly as it appears on your application. ` +
          `Use your names exactly as on your application. ` +
          `If it still doesn't work, reply to the email that sent you this link and we'll sort it out.`;
        return;
      }
      ui.candLast = k;
      ui.candDisplay = ((first ? first + " " : "") + v).replace(/\s+/g, " ");
      ss.set("ed_iv_cand", ui.candLast);
      ss.set("ed_iv_cand_disp", ui.candDisplay);
      renderCandidate();
    };
    return;
  }
  const who = ui.candDisplay || ss.get("ed_iv_cand_disp")
    || (ui.candLast ? ui.candLast.charAt(0).toUpperCase() + ui.candLast.slice(1) : "");
  // read by the SAME normalized key we write under (ui.candLast), not the display name
  const map = S.availCand[ui.candLast] || {};
  // H11: their published interview time, fetched ONCE per name (a get by their
  // own key; never a listener, never a list)
  if (ui.noticeKey !== ui.candLast) {
    ui.noticeKey = ui.candLast; ui.notice = undefined;
    const k = ui.candLast;
    store.getMyNotice(k).then((n) => { if (ui.noticeKey === k) { ui.notice = n; renderCandidate(); } },
      () => { if (ui.noticeKey === k) { ui.notice = null; renderCandidate(); } });
  }
  const notice = ui.notice;
  // The only page anyone outside the department sees. It asks for one thing, so
  // it shows one thing: who we think you are, the times, and a line saying it
  // saves itself. The identity card and the boxed instructions that used to sit
  // above the times are now a subtitle and a single sentence.
  el.innerHTML = `<header class="page"><div class="brandrow"><div class="brandmark" aria-hidden="true">ED</div>
      <div class="grow"><h1>${escapeHtml(ORG_NAME)}</h1>
        <p class="muted">${escapeHtml(who)} · <button class="linky" onclick="CAND.rename()">Not you?</button></p></div>
      <button class="linky" onclick="CAND.logout()">Log out</button></div></header>
    <main style="max-width:600px">
      ${notice === undefined ? `<p class="hint">Loading…</p>` : notice ? noticeCard(notice)
        : booking === "closed" ? `<div class="card">${empty(ICON.calendar, "Booking is closed", "If you need to change your times, reply to our email.")}</div>`
        : slots.length ? `<h2 class="pagetitle">When can you interview?</h2>
        ${hint("Choose in person, Zoom or either for every time you can make. In person is preferred.")}
        <div class="card"><div class="slotgrid">${slotRows(slots, map, "CAND.set")}</div></div>
        <p class="hint">Saved as you tap. Come back and change it any time. We'll confirm your final time by email.</p>`
        : `<div class="card">${empty(ICON.calendar, "Times not posted yet", "The interview times haven't been published yet. Please check back soon.")}</div>`}
    </main>`;
}

// H11: the applicant's published time, and their reply. They can't read their
// reply back from the server (write-only), so this device remembers it.
function noticeCard(n) {
  const when = whenText({ date: n.date, start: n.start, end: n.end, label: n.label });
  const where = n.format === "zoom"
    ? (n.zoomLink ? `By Zoom. Link: <a href="${escapeHtml(n.zoomLink)}" target="_blank" rel="noopener">${escapeHtml(n.zoomLink)}</a>` : "By Zoom. We will send the Zoom link before the interview.")
    : `In person at ${escapeHtml(n.location || "the Emergency Department")}.`;
  const r = store.replyEcho(ui.candLast) || {};
  const past = n.replyBy && daysUntil(n.replyBy) < 0;
  const status = r.reply === "confirmed" ? `<p class="ok">Thank you. You confirmed on ${escapeHtml(monthDay(r.at))}.</p>`
    : r.reply === "withdrawn" ? `<p>You have withdrawn. If this was a mistake, tap Undo.</p>
        <button class="btn ghost replybtn" onclick="CAND.reply('')">Undo</button>` : "";
  const ask = past ? `<p>The date to confirm has passed. Please reply to our email.</p>`
    : n.replyBy && r.reply !== "withdrawn" && r.reply !== "confirmed" ? `<p>Please confirm by ${escapeHtml(longDate(n.replyBy))}.</p>` : "";
  return `<h2 class="pagetitle">Your interview</h2>
    <div class="card noticecard">
      <p><b>${escapeHtml(when)}.</b> ${where}</p>
      ${ask}${status}
      ${r.reply === "withdrawn" ? "" : `<div class="replybtns">
        <button class="btn filled replybtn" onclick="CAND.reply('confirmed')">I'll be there</button>
        <button class="btn ghost replybtn" onclick="CAND.reply('withdrawn')">I can't come</button></div>`}
    </div>
    <p class="hint">Need a different time? Reply to our email.</p>`;
}

// ---------------------------------------------------------- handlers (window)
// Saves waiting out their pause: "<cid>:<qi>" → { t, run } for notes, and the
// overall score's one slot. `run` saves now and is safe to call once only.
const noteTimers = {};
let scoreTimer = null;
function saveNoteKeyed(me, cid, qi, val) {
  const k = cid + ":" + qi;
  clearTimeout((noteTimers[k] || {}).t);
  markSaving();
  const run = () => { delete noteTimers[k]; return writeScore(me, cid, { notes: { [qi]: val } }); };
  noteTimers[k] = { t: setTimeout(run, 500), run };
}
// What this page has asked the store to save and the store hasn't confirmed:
// "<me>~<cid>" → { overall?, notes: {qi: text} }. The Score tab draws from
// this over S.scores, so it never shows (or compares against) a value older
// than what was just typed. A reviewer's own write reaches S synchronously, so
// for them this is empty almost always; an admin reviewing as a member reads
// scores back through a snapshot, which lags a write by a moment — in that
// moment a redraw showed the old note (and the next keystroke saved it short),
// and retyping the score you'd had before was skipped as "already saved".
const inflight = {};
function myScore(me, cid) {
  const rec = S.scores[key(me, cid)] || {}, f = inflight[key(me, cid)];
  if (!f) return { ...rec, notes: rec.notes || {} };
  return { ...rec, ...("overall" in f ? { overall: f.overall } : {}), notes: { ...(rec.notes || {}), ...f.notes } };
}
function writeScore(me, cid, patch, tries = 0) {
  const k = key(me, cid), f = inflight[k] = inflight[k] || { notes: {} };
  if ("overall" in patch) f.overall = patch.overall;
  Object.assign(f.notes, patch.notes || {});
  // Settled: drop what THIS write put there (unless a later write has replaced
  // it), then redraw from the store.
  const drop = (keepNotes) => {
    if ("overall" in patch && f.overall === patch.overall) delete f.overall;
    if (!keepNotes) Object.entries(patch.notes || {}).forEach(([q, t]) => { if (f.notes[q] === t) delete f.notes[q]; });
    if (!("overall" in f) && !Object.keys(f.notes).length && inflight[k] === f) delete inflight[k];
    if (ui.tab === "score" && ui.member) renderScore();
  };
  return saved(store.setScore(me, cid, patch).then(() => drop(false), (e) => {
    // A failed NOTE stays on screen — the box is the only copy of what was
    // typed, and redrawing from the store wiped it — and is tried again with
    // a growing gap; typing in it again also retries. A failed SCORE goes back
    // to the saved one: quick to retype, and showing it would claim it counted.
    drop(true);
    const notes = patch.notes || {};
    if (Object.keys(notes).length && tries < 3) setTimeout(() => {
      const still = Object.fromEntries(Object.entries(notes).filter(([q, t]) => f.notes[q] === t));
      if (Object.keys(still).length) writeScore(me, cid, { notes: still }, tries + 1);
    }, 2000 * (tries + 1));
    throw e;   // saved() shows "Couldn't save"
  }), "scoring");
}
// Save everything still waiting out its pause, NOW. Called before the Score tab
// is rebuilt for another candidate: a rebuild draws from what's saved, so a
// note typed under half a second before the switch came back blank, and the
// next keystroke there cancelled its pending save — losing that text for good.
// Returns whether anything was waiting.
function flushPending() {
  let any = false;
  Object.keys(noteTimers).forEach((k) => { const n = noteTimers[k]; if (n) { clearTimeout(n.t); n.run(); any = true; } });
  if (scoreTimer) { const n = scoreTimer; clearTimeout(n.t); n.run(); any = true; }
  return any;
}
// header auto-save indicator so people can SEE their input is saved
function markSaving() {
  const el = $("#saveStatus"); if (!el) return;
  clearTimeout(markSaved._t);
  el.className = "saveflag saving";
  el.innerHTML = `<span class="spinner dark" style="width:11px;height:11px"></span> Saving…`;
}
function markSaved() {
  const el = $("#saveStatus"); if (!el) return;
  el.className = "saveflag saved";
  el.textContent = "✓ Saved";
  clearTimeout(markSaved._t);
  markSaved._t = setTimeout(() => el.classList.add("hidden"), 2200);
}
// wrap a store write so it always shows Saving… → ✓ Saved
async function saved(promise, stage) {
  markSaving();
  try { await track(promise); markSaved(); }
  catch (e) {
    // H4: a refusal because the stage closed (or the round is closing) says so,
    // instead of sending people to check a connection that is fine
    const closed = e && e.code === "permission-denied" && stage && !isOpen(stage);
    toast(closed ? (roundOpen(S.meta) ? `${STAGE_WORD[stage]} is closed. This change was not saved.` : "Leadership is closing this round. This change was not saved.")
      : "Couldn't save. Check your connection", "err");
    const el = $("#saveStatus"); if (el) el.classList.add("hidden");
  }
}
// Writes this page has sent and the server hasn't confirmed (log out waits for
// them; the self-reload after a new release never happens while any are open).
let pendingWrites = 0;
function track(promise) { pendingWrites++; return Promise.resolve(promise).finally(() => { pendingWrites--; }); }
const unconfirmed = () => pendingWrites > 0 || Object.keys(inflight).length > 0;
window.IV = {
  changePasswords: (resuming) => changePasswords(!!resuming),
  pwShow: (id, btn) => { const el = document.getElementById(id); if (!el) return; const show = el.type === "password"; el.type = show ? "text" : "password"; btn.textContent = show ? "Hide" : "Show"; },
  toggleFlag: (id) => { if (!isOpen("screening")) return; const cur = (S.screening[key(ui.member, id)] || {}).flag; saved(store.setScreening(ui.member, id, { flag: !cur, reason: cur ? "" : (S.screening[key(ui.member, id)] || {}).reason || "" }), "screening"); },
  toggleNote: (id) => { ui.noteOpen = ui.noteOpen || {}; ui.noteOpen[id] = !ui.noteOpen[id]; renderScreen(); wireSections(); },
  saveNote: (id, btn) => withBusy(btn, async () => {
    let note = String(($("#note-s-" + id) || {}).value || "");
    if (note.length > 2000) { note = note.slice(0, 2000); toast("Your note was cut to 2,000 characters.", "err"); }
    const conflict = !!($("#knows-" + id) || {}).checked;
    await track(store.setScreening(ui.member, id, { note, conflict }));
  }, "Note saved").catch(() => {}),
  saveReason: (id, btn) => withBusy(btn, () => track(store.setScreening(ui.member, id, { reason: $("#rsn-" + id).value })), "Saved"),
  rate: (id, n) => { if (!isOpen("screening")) return; const cur = (S.screening[key(ui.member, id)] || {}).rating; saved(store.setScreening(ui.member, id, { rating: cur === n ? 0 : n }), "screening"); },
  addCands: (btn) => withBusy(btn, async () => {
    const t = $("#bulkAdd"); if (!t) return;
    const existing = new Set(S.candidates.map((c) => c.name.trim().toLowerCase()));
    const names = t.value.split("\n").map((s) => s.trim()).filter(Boolean);
    // H14: two applicants with the same first AND last name can't be told apart
    const fresh = [];
    names.forEach((nm) => { if (!existing.has(nm.toLowerCase())) { existing.add(nm.toLowerCase()); fresh.push(nm); } });
    const trial = assignKeys([...S.candidates, ...fresh.map((nm, i) => ({ id: `new-${i}`, name: nm }))]);
    const refused = fresh.filter((nm) => trial.clash.includes(nm));
    let n = 0;
    for (const nm of fresh) {
      if (refused.includes(nm)) continue;
      await track(store.addCandidate(nm, (_b, p) => hEntry("roster.add", "Added {cand}", { by: byWho(), cand: p.id })));
      n++;
    }
    t.value = refused.join("\n");
    await separateShared();
    if (refused.length) await confirmDialog(`Two applicants have the same first and last name (${refused.join(", ")}). Add a middle initial to one of them so we can tell them apart.`,
      { title: "Not added", yes: "OK", danger: false });
    toast(n ? `Added ${n} candidate${n === 1 ? "" : "s"}` : "No new names", n ? "ok" : "err");
  }),
  removeCand: async (id, v) => {
    const c = cand(id);
    if (v) { const ok = await confirmDialog(`Remove ${c ? c.name : "this candidate"} from the interview list? You can restore them later.`, { title: "Remove candidate", yes: "Remove" }); if (!ok) return; }
    try {
      await track(store.setCandidateRemoved(id, v, hEntry(v ? "roster.remove" : "roster.restore",
        v ? "Took {cand} off the list" : "Put {cand} back on the list", { by: byWho(), cand: id })));
    } catch { toast("Couldn't save. Check your connection", "err"); return; }
    toast(v ? "Removed" : "Restored", "ok");
  },
  avail: (id, v) => { if (!isOpen("availability")) return; const cur = (S.availIv[ui.member] || {})[id]; saved(store.setAvail("iv", ui.member, id, cur === v ? null : v), "availability"); },
  pickScore: (id) => {
    // A tap on ‹ › doesn't always take focus off the score box (iOS), so its
    // change event would never fire once the page is rebuilt. Settle it for
    // THIS candidate first; if it's not a valid score, stay put and say so.
    const box = $("#overallIn");
    if (box && document.activeElement === box && !IV.score(box.value, box.dataset)) {
      const sel = $(".scorebar select"); if (sel) sel.value = ui.scoreCand;
      box.focus(); return;
    }
    ui.scoreCand = id; renderScore(); wireSections(); window.scrollTo({ top: 0, behavior: "smooth" }); },
  sortColl: (k) => {
    ui.collSort = k;
    ls.set(COLL_SORT_KEY, k);
    renderScreen(); wireSections();
  },
  note: (qid, val) => saveNoteKeyed(ui.member, ui.scoreCand, String(qid), val),
  // H9: "Show all applicants" / "Show only my interviews" (per session, not stored)
  scoreShowAll: (v) => { ui.scoreAll = !!v; renderScore(); wireSections(); },
  // Typing saves a valid score after a pause, like notes do — the old buttons
  // saved on tap, and a box that only saved on blur would lose a score typed
  // just before the phone was locked. Who/which candidate is captured NOW, so
  // a switch during the pause still files it under the one it was typed for.
  // A half-typed or invalid value is never saved and never nagged about here;
  // emptying the box mid-retype doesn't clear the saved score either.
  //
  // Both handlers take the person+candidate the box was DRAWN for (its data-
  // attributes), never ui.scoreCand: Chrome fires blur/change on a focused box
  // as a rebuild removes it — after ui.scoreCand has already moved on — which
  // filed one score under two candidates.
  scoreTyped: (raw, { me, cid } = {}) => {
    clearTimeout((scoreTimer || {}).t); scoreTimer = null;
    const m = $("#overallMsg"); if (m) m.textContent = "";
    const v = parseScore(raw);
    if (!v) return;
    const run = () => {   // saved() shows Saving…/✓ itself — not shown earlier, or
      scoreTimer = null;  // typing on into "4.75" would leave "Saving…" stuck
      if (v === (myScore(me, cid).overall || 0)) return;
      writeScore(me, cid, { overall: v });
    };
    scoreTimer = { t: setTimeout(run, 600), run };
  },
  // On leaving the box (blur/Enter/Tab/app switch): the final word. Blur, not
  // `change`: change only fires if the text differs from when the box was
  // focused, so focus an empty box, type 4.2, let it save, delete it, leave —
  // no change event, and 4.2 stayed saved under an empty box. Invalid → said so, not
  // saved. Empty → clears, like un-tapping the old button. Returns false only
  // when the value was refused.
  score: (raw, { me, cid } = {}) => {
    clearTimeout((scoreTimer || {}).t); scoreTimer = null;
    if (!me || !cid) return false;
    const here = me === ui.member && cid === ui.scoreCand;   // box still on screen
    const v = parseScore(raw);
    if (v === null) {
      const m = $("#overallMsg"); if (m && here) m.textContent = "Not saved. Enter 1 to 5 with at most one decimal, e.g. 4.7";
      toast("Score not saved. Use 1 to 5, e.g. 4.7", "err");
      return false;
    }
    const cur = myScore(me, cid).overall || 0;
    if (v === cur) { if (here) renderScore(); return true; }   // "4.50" → tidy back to "4.5"
    writeScore(me, cid, { overall: v });
    return true;
  },
  setComplete: async (v, btn) => {
    let alsoClose = false;
    if (v) {
      if (isOpen("scoring")) {
        // H4: offer to close scoring in the same step, so scores can't change after you look
        const ok = await confirmDialog("Mark all interviews complete and reveal the ranking to admins?\n\nScoring is still open. "
          + "Close it too, so scores can't change after you look?", { title: "Reveal ranking", yes: "Reveal and close scoring", alt: "Reveal only", danger: false });
        if (!ok) return;
        alsoClose = ok === true;
      } else {
        const ok = await confirmDialog("Mark all interviews complete and reveal the ranking to admins?", { title: "Reveal ranking", yes: "Reveal", danger: false });
        if (!ok) return;
      }
    }
    return withBusy(btn, () => track(store.updateState((st) => ({ interviewsComplete: v,
      ...(alsoClose ? { stages: { ...(st.stages || {}), scoring: { closed: true, at: store.now() } } } : {}) }),
      hEntry(v ? "ranking.reveal" : "ranking.hide", v ? (alsoClose ? "Revealed the ranking and closed scoring" : "Revealed the ranking") : "Hid the ranking again", { by: byWho() }))));
  },
  // ---- stages (H4)
  closeStage: async (name, btn) => {
    if (!isOpen(name)) return;
    const extra = {};
    let msg;
    if (name === "screening") {
      const plan = closePlan(S.candidates, flagsCount, EFF().threshold);
      msg = `Close screening? Reviewers can still see their answers but can't change them. The interview list is saved as it is now: `
        + `${plan.on} on the list, ${plan.off} off. You can reopen screening later.`;
      extra.candidates = Object.fromEntries(Object.entries(plan.patches).map(([id, p]) => [id, { ...p, shortlistAt: store.now() }]));
    } else if (name === "availability") {
      msg = "Close availability? Interviewers and applicants can no longer change their times. Applicants can still confirm or withdraw.";
      extra.public = { booking: "closed" };
    } else msg = "Close scoring? Interviewers can no longer change scores or notes.";
    if (!(await confirmDialog(msg, { title: `Close ${name}`, yes: `Close ${name}`, danger: false }))) return;
    await withBusy(btn, () => track(store.updateState((st) => ({ stages: { ...(st.stages || {}), [name]: { closed: true, at: store.now() } } }),
      hEntry("stage.close", `Closed ${name}`, { by: byWho() }), extra)), `${STAGE_WORD[name]} closed`).catch(() => {});
    rerenderSettings();
  },
  reopenStage: async (name, btn) => {
    if (isOpen(name)) return;
    const extra = {};
    if (name === "availability") extra.public = { booking: bookingFor({ ...S.meta, stages: { ...(S.meta.stages || {}), availability: { closed: false } } }) };
    if (name === "screening") extra.candidates = Object.fromEntries(reopenPlan(S.candidates).map((id) => [id, { shortlist: DEL, shortlistBy: DEL, shortlistAt: DEL }]));
    await withBusy(btn, () => track(store.updateState((st) => ({ stages: { ...(st.stages || {}), [name]: { closed: false } } }),
      hEntry("stage.reopen", `Reopened ${name}`, { by: byWho() }), extra)), `${STAGE_WORD[name]} reopened`).catch(() => {});
    rerenderSettings();
  },
  saveDeadlines: (btn) => withBusy(btn, async () => {
    const v = (id) => (($("#" + id) || {}).value || "").trim();
    const deadlines = { screening: v("dlScreening"), availability: v("dlAvailability"), reply: v("dlReply") };
    Object.keys(deadlines).forEach((k) => { if (!deadlines[k]) delete deadlines[k]; });
    await track(store.updateConfig(() => ({ deadlines }), hEntry("settings.save", "Changed the deadlines", { by: byWho() })));
    renderBanner();
  }, "Dates saved").catch(() => {}),
  saveThreshold: (btn) => withBusy(btn, async () => {
    const n = Number(($("#thIn") || {}).value);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error("Use a whole number from 0 to 20");
    await track(store.updateConfig(() => ({ flagThreshold: n }),
      hEntry("settings.save", n ? `Set the screening rule to ${n} concern${n === 1 ? "" : "s"}` : "Set the screening rule to decide each applicant by hand", { by: byWho() })));
  }, "Rule saved").catch(() => {}),
  // ---- H7: leadership decides the shortlist
  setShortlist: async (id, v) => {
    const c = cand(id); if (!c) return;
    const cur = c.shortlistBy === "leadership" && (c.shortlist === "in" || c.shortlist === "out") ? c.shortlist : "auto";
    if (cur === v) return;
    let patch, after;
    if (v === "auto") {
      // with screening closed, "Auto" means the rule's answer, frozen again
      if (!isOpen("screening")) {
        const on = isOnList({ removed: false }, flagsCount(id), EFF().threshold);
        patch = { shortlist: on ? "in" : "out", shortlistBy: "auto", shortlistAt: store.now() }; after = { shortlist: on ? "in" : "out", shortlistBy: "auto" };
      } else { patch = { shortlist: DEL, shortlistBy: DEL, shortlistAt: DEL }; after = {}; }
    } else { patch = { shortlist: v, shortlistBy: "leadership", shortlistAt: store.now() }; after = { shortlist: v, shortlistBy: "leadership" }; }
    const text = v === "in" ? "Kept {cand} on the interview list" : v === "out" ? "Took {cand} off the interview list" : "Let the screening rule decide for {cand}";
    try {
      await track(store.setCandidates({ [id]: patch }, hEntry("shortlist.set", text, { by: byWho(), cand: id, undo: shortlistUndo(c, after) })));
    } catch { toast("Couldn't save. Check your connection", "err"); }
  },
  concernToNote: async (memberId, cid) => {
    const k = key(memberId, cid), cur = S.screening[k];
    if (!cur || !cur.flag) return;
    const nm = mname(memberId);
    if (!(await confirmDialog(`Move ${nm}'s concern to a note? It will stop counting against the applicant. ${nm}'s words stay the same.`,
      { title: "Make this a note", yes: "Make it a note", danger: false }))) return;
    const toNote = (d) => ({ ...d, flag: false, reason: "",
      note: [d.note, d.reason].map((x) => String(x || "").trim()).filter(Boolean).join("\n\n") });
    const after = toNote(cur);
    try {
      await track(store.txDoc("interviews_screening", k, (before) => {
        if (!before || hashOf(before) !== hashOf(cur)) throw new Error("That concern just changed. Look again.");
        return toNote(before);
      }, hEntry("screening.toNote", `Moved ${nm}'s concern about {cand} to a note`, { by: byWho(), cand: cid, member: memberId,
        undo: screeningUndo(k, cur, after) })));
      toast("Moved to a note", "ok");
    } catch (e) { toast((e && e.message) || "Couldn't save. Check your connection", "err"); }
  },
  // ---- H13: day chairs and two-room times
  setDayChair: async (date, v) => {
    try {
      await track(store.updateConfig((c) => {
        const days = { ...(c.days || {}) }, d = { ...(days[date] || {}) };
        const usual = c.chair || CHAIR;
        const old = d.chair === "none" ? null : d.chair || usual;
        if (!v) delete d.chair; else d.chair = v;
        const now = v === "none" ? null : v || usual;
        days[date] = d;
        if (!Object.keys(d).length) delete days[date];
        // hand-made panels that day: the same swap as changing the chair, and
        // never shrink a panel (the old chair stays as a member if needed)
        const onDay = new Set(effectiveSlots(c, SLOTS).filter((t) => t.date === date).map((t) => t.id));
        const ov = {};
        Object.entries(c.panelOverrides || {}).forEach(([cid, o]) => {
          if (!o || !o.members || !onDay.has(String(o.slot)) || o.room === 2 || now === null || now === old) { ov[cid] = o; return; }
          const set = new Set(o.members.filter((n) => n !== old)); set.add(now);
          if (set.size < o.members.length && old) set.add(old);
          ov[cid] = { ...o, members: [...set] };
        });
        return { days, panelOverrides: ov };
      }, hEntry("day.set", `Changed who chairs on ${fmtDate(date)}`, { by: byWho(), ...(v && v !== "none" ? { member: v } : {}) })));
    } catch { toast("Couldn't save. Check your connection", "err"); }
    rerenderSettings();
  },
  setDayLead: async (date, v) => {
    try {
      await track(store.updateConfig((c) => {
        const days = { ...(c.days || {}) }, d = { ...(days[date] || {}) };
        if (!v || v === "none") delete d.room2Chair; else d.room2Chair = v;
        days[date] = d; if (!Object.keys(d).length) delete days[date];
        return { days };
      }, hEntry("day.set", `Changed who leads room 2 on ${fmtDate(date)}`, { by: byWho() })));
    } catch { toast("Couldn't save. Check your connection", "err"); }
    rerenderSettings();
  },
  setRooms: async (id, n) => {
    const t = EFF().slots.find((x) => x.id === id); if (!t || (t.rooms === 2) === (n === 2)) return;
    try {
      await timesBusy(() => track(store.updateTimes(SLOTS, (times, overrides) => {
        const out = times.map((x) => { if (x.id !== id) return x; const y = { ...x }; if (n === 2) y.rooms = 2; else delete y.rooms; return y; });
        if (n !== 2) Object.keys(overrides).forEach((c) => { if (String(overrides[c].slot) === id && overrides[c].room === 2) { const o = { ...overrides[c] }; delete o.room; overrides[c] = o; } });
        return { times: out, overrides };
      }, hEntry("times.edit", `Set ${slotLabel(t)} to ${n === 2 ? "2 rooms" : "1 room"}`, { by: byWho() }))));
    } catch { toast("Couldn't save. Check your connection", "err"); }
  },
  saveInfo: (btn) => withBusy(btn, async () => {
    const v = (id) => (($("#" + id) || {}).value || "").trim();
    const info = { location: v("idLoc"), zoomLink: v("idZoom"), contact: v("idContact") };
    await track(store.updateConfig(() => ({ interviewInfo: info }), hEntry("settings.save", "Changed the interview details", { by: byWho() })));
  }, "Details saved").catch(() => {}),
  // ---- H8: messages and calendar files (no email service; nothing stored)
  copyInvite: async (cid, kind) => {
    const p = computePanels().panels.find((x) => x.cand === cid); if (!p) return;
    const m = kind === "panel" ? panelInvite(panelMsg(p), msgCtx()) : applicantInvite(panelMsg(p), msgCtx());
    const r = await copyText(asText(m), { title: kind === "panel" ? "Email to the panel" : "Email to the applicant" });
    if (r === "copied") toast(kind === "panel" ? "Copied. Paste it into a new email to the panel."
      : `Copied. Paste it into a new email to ${panelMsg(p).name}.`, "ok");
  },
  copyAllInvites: async () => {
    const ps = computePanels().panels;
    if (!ps.length) return;
    const text = ps.map((p) => { const m = applicantInvite(panelMsg(p), msgCtx()); return `To: ${panelMsg(p).name}\n${asText(m)}`; }).join("\n\n\n");
    const r = await copyText(text, { title: "All applicant emails" });
    if (r === "copied") toast(`Copied ${ps.length} email${ps.length === 1 ? "" : "s"}. Paste each into its own email.`, "ok");
  },
  downloadIcs: (which, forApplicant) => {
    const ps = computePanels().panels.filter((p) => which === "all" || p.cand === which);
    const events = ps.map((p) => icsFor(p, !!forApplicant)).filter(Boolean);
    if (!events.length) { toast("This time has no date, so there is no calendar file.", "err"); return; }
    const one = which !== "all" ? cand(which) : null;
    downloadFile(one ? `interview-${lastKey(one.name) || "applicant"}${forApplicant ? "-applicant" : ""}.ics` : "interviews.ics",
      icsCalendar(events), "text/calendar;charset=utf-8");
  },
  emailWaiting: (kind) => {
    const ctx = msgCtx();
    if (kind === "iv") {
      const people = EFF().interviewers.filter((m) => !liveAnswers(S.availIv[m.id]).length);
      const msg = availabilityReminder("interviewers", ctx);
      const withEmail = people.filter((m) => m.email), without = people.filter((m) => !m.email);
      const link = mailtoLink({ bcc: withEmail.map((m) => m.email), subject: msg.subject, body: msg.body });
      flowDialog((ctl) => ctl.step({ title: "Email who we're waiting on",
        html: `<p>${people.length ? `Waiting on ${people.map((m) => escapeHtml(m.name)).join(", ")}.` : "Everyone has answered."}</p>
          ${without.length ? `<p class="small">No email saved for ${without.map((m) => escapeHtml(m.name)).join(", ")}. Copy the message instead.</p>` : ""}
          ${withEmail.length && !link ? `<p class="small">Too many people for one email link. Copy the message and the addresses instead.</p>` : ""}`,
        buttons: [{ label: "Close", kind: "ghost", run: (k) => k.close() },
          { label: "Copy the message", kind: "tinted", run: async (k) => { if (await copyText(asText(msg) + (withEmail.length ? `\n\nBcc: ${withEmail.map((m) => m.email).join(", ")}` : "")) === "copied") toast("Copied", "ok"); } },
          ...(withEmail.length && link ? [{ label: "Open email", kind: "filled", run: (k) => { window.location.href = link; k.close(); } }] : [])] }));
      return;
    }
    const list = kind === "confirm"
      ? computePanels().panels.map((p) => cand(p.cand)).filter((c) => c && !replyOf(c).reply)
      : activeCands().filter((c) => !liveAnswers(availForCand(c)).length);
    const msg = availabilityReminder(kind === "confirm" ? "confirm" : "applicants", ctx);
    flowDialog((ctl) => ctl.step({ title: kind === "confirm" ? "Applicants who haven't confirmed" : "Email who we're waiting on",
      html: `<p>${list.length ? `${list.map((c) => escapeHtml(c.name)).join(", ")}.` : "Nobody."}</p>
        <p class="small muted">We never store applicant emails. Copy the reminder and send it from your own email.</p>`,
      buttons: [{ label: "Close", kind: "ghost", run: (k) => k.close() },
        { label: "Copy reminder", kind: "filled", run: async () => { if (await copyText(asText(msg)) === "copied") toast("Copied", "ok"); } }] }));
  },
  // ---- H11: show each scheduled applicant their time when they sign in
  publishNotices: async (btn) => {
    if (!locked()) return;
    const ps = computePanels().panels;
    const ctx = msgCtx();
    const desired = {};
    ps.forEach((p) => {
      const c = cand(p.cand), t = EFF().slots.find((x) => x.id === String(p.slot));
      if (!c || !t) return;
      desired[candKey(c)] = { date: t.date || "", start: t.start || "", end: t.end || "", label: t.label || "", format: p.modality,
        room: p.room || 1, location: ctx.location, zoomLink: ctx.zoomLink, replyBy: ctx.replyBy };
    });
    const n = Object.keys(desired).length;
    if (!(await confirmDialog(`Show each scheduled applicant their interview time when they sign in? ${n} applicant${n === 1 ? "" : "s"}. `
      + "You still need to email them; use Copy all applicant emails.", { title: "Send times to applicants", yes: "Send times", danger: false }))) return;
    await withBusy(btn, async () => {
      const r = await track(store.publishNotices(desired, (_before, res) => hEntry("notices.publish",
        `Sent interview times to applicants (${res.sent} new, ${res.updated} changed, ${res.removed} removed)`, { by: byWho() })));
      toast(`Sent: ${r.sent} new, ${r.updated} changed, ${r.removed} removed`, "ok");
    }).catch(() => {});
  },
  // ---- the schedule lock (H4)
  lockSchedule: async (btn) => {
    const res = computePanels(), n = res.panels.length, un = res.unschedulable.length;
    const msg = `Lock the schedule? The ${n} panel${n === 1 ? "" : "s"} stay exactly as they are now, even if someone changes their `
      + `availability. You can still edit a panel by hand, and unlock later.`
      + (un ? `\n\n${un} applicant${un === 1 ? " has" : "s have"} no interview yet and will not be scheduled while locked.` : "");
    if (!(await confirmDialog(msg, { title: "Lock the schedule", yes: "Lock the schedule", danger: false }))) return;
    const panels = Object.fromEntries(res.panels.map((p) => [p.cand, lockEntry(p, EFF().chair)]));
    await withBusy(btn, () => track(store.updateSchedule((sch) => ({ ...(sch || {}), locked: true, lockedAt: store.now(), panels }),
      hEntry("schedule.lock", `Locked the schedule (${n} interview${n === 1 ? "" : "s"})`, { by: byWho() }))), "Schedule locked").catch(() => {});
  },
  unlockSchedule: async (btn) => {
    if (!(await confirmDialog("Unlock the schedule? Panels go back to following everyone's availability. Panels you set by hand before locking stay.",
      { title: "Unlock the schedule", yes: "Unlock", danger: false }))) return;
    await withBusy(btn, () => track(store.updateSchedule((sch) => { const o = { ...(sch || {}), locked: false, panels: {} }; delete o.lockedAt; return o; },
      hEntry("schedule.unlock", "Unlocked the schedule", { by: byWho() }))), "Schedule unlocked").catch(() => {});
  },
  // panels
  editPanel: (cid) => { ui.editPanel = ui.editPanel === cid ? null : cid; renderPanels(); },
  toggleMember: (cid, idx, on) => {
    const name = (EFF().interviewers[idx] || {}).id; if (!name) return;
    ui._draft = ui._draft || {};
    const p = computePanels().panels.find((x) => x.cand === cid);
    const room = (ui._draft[cid] && ui._draft[cid].room) || (p && p.room) || 1;
    const ch = p ? EFF().chairFor(p.slot, room) : EFF().chair;
    const base = (ui._draft[cid] && ui._draft[cid].members) || (EFF().overrides[cid] && EFF().overrides[cid].members) || (p && p.members) || (ch ? [ch] : []);
    const set = new Set(base); if (on) set.add(name); else set.delete(name); if (ch) set.add(ch);
    ui._draft[cid] = { ...(ui._draft[cid] || {}), members: [...set] };
  },
  setOvRoom: (cid, r, btn) => {
    ui._draft = ui._draft || {}; ui._draft[cid] = { ...(ui._draft[cid] || {}), room: r };
    renderPanels();
  },
  setOvMod: (cid, mv, btn) => {
    ui._draft = ui._draft || {}; ui._draft[cid] = { ...(ui._draft[cid] || {}), modality: mv };
    const seg = document.getElementById("ovmod-" + cid);
    if (seg) seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b === btn); b.setAttribute("aria-pressed", b === btn); });
  },
  savePanel: async (cid, btn) => {
    const slotSel = $("#ovslot-" + cid);
    const p = computePanels().panels.find((x) => x.cand === cid);
    const draft = (ui._draft && ui._draft[cid]) || {};
    const members = draft.members || (EFF().overrides[cid] && EFF().overrides[cid].members) || (p && p.members) || [EFF().chair].filter(Boolean);
    const slot = slotSel ? slotSel.value : (p ? p.slot : EFF().slotIds[0]);
    const modality = draft.modality || (p && p.modality) || (EFF().overrides[cid] && EFF().overrides[cid].modality) || "ip";
    if (!slot) { toast("Pick a time first", "err"); return; }
    const v = validatePanel(members, slot, modality);
    if (!v.sizeOk) { toast("A panel needs 3–5 members", "err"); return; }
    if (!v.balanced) {
      const ok = await confirmDialog("This panel isn't balanced (needs at least one member who identifies as female and one as male). Save it anyway?", { title: "Unbalanced panel", yes: "Save anyway", danger: false });
      if (!ok) return;
    }
    // write just this entry onto the latest saved map (never a stale copy of the rest)
    const room = EFF().rooms[String(slot)] === 2 ? (draft.room || (p && p.room) || 1) : 1;
    const v2 = validatePanel(members, slot, modality, room);
    if (!v2.chairOk && !(await confirmDialog("This panel doesn't include the chair for that time and room. Save it anyway?",
      { title: "No chair", yes: "Save anyway", danger: false }))) return;
    const entry = { slot: String(slot), members, modality, ...(room === 2 ? { room: 2 } : {}) };
    if (locked()) {
      // H4: while locked, Edit edits the locked panel itself
      try {
        await withBusy(btn, () => track(store.updateSchedule((sch) => ({ ...(sch || {}), panels: { ...((sch || {}).panels || {}),
          [cid]: { ...entry, room, chair: EFF().chairFor(slot, room) } } }),
          hEntry("schedule.edit", "Changed the locked panel for {cand}", { by: byWho(), cand: cid }))), "Panel saved");
      } catch { return; }
      if (ui._draft) delete ui._draft[cid];
      ui.editPanel = null; renderPanels();
      return;
    }
    try {
      await withBusy(btn, () => track(store.updateConfig((c) => ({ panelOverrides: { ...(c.panelOverrides || {}), [cid]: entry } }),
        (before, patch) => hEntry("panel.save", "Saved a hand-made panel for {cand}",
          { by: byWho(), cand: cid, undo: panelUndo(before.panelOverrides, patch.panelOverrides, [cid]) }))), "Panel saved");
    } catch { return; }
    if (ui._draft) delete ui._draft[cid];
    ui.editPanel = null; renderPanels();
  },
  clearOverride: async (cid) => {
    try {
      await track(store.updateConfig((c) => { const ov = { ...(c.panelOverrides || {}) }; delete ov[cid]; return { panelOverrides: ov }; },
        (before, patch) => hEntry("panel.reset", "Went back to the suggested panel for {cand}",
          { by: byWho(), cand: cid, undo: panelUndo(before.panelOverrides, patch.panelOverrides, [cid]) })));
    } catch { toast("Couldn't save. Check your connection", "err"); return; }
    toast("Reset to auto", "ok"); ui.editPanel = null; renderPanels();
  },
  // H12: "Undo my edits" reset EVERYONE's hand-made panels without saying so.
  // It now says so, names them, and can be undone (toast for 10 s, or Change
  // history).
  resetPanels: async (btn) => {
    const ov = EFF().overrides, ids = Object.keys(ov);
    if (!ids.length) return;
    const names = ids.map((id) => String((cand(id) || {}).name || "an applicant").replace(/^Dr\.?\s+/i, ""));
    const ok = await confirmDialog(`Go back to the suggested panels? This removes ${ids.length} panel${ids.length === 1 ? "" : "s"} `
      + `that ${ids.length === 1 ? "was" : "were"} set by hand: ${names.join(", ")}. You can undo this.`,
      { title: "Reset hand-made panels", yes: "Reset" });
    if (!ok) return;
    const hid = newHistoryId();
    let made = null;
    try {
      await withBusy(btn, () => track(store.updateConfig((c) => ({ panelOverrides: {} }), (before, patch) => {
        const keys = Object.keys(before.panelOverrides || {});
        made = hEntry("panel.resetAll", `Reset ${keys.length} hand-made panel${keys.length === 1 ? "" : "s"}`,
          { by: byWho(), id: hid, undo: panelUndo(before.panelOverrides, patch.panelOverrides, keys) });
        return made;
      })));
    } catch { return; }
    renderPanels();
    toast("Hand-made panels reset.", "ok", { label: "Undo", run: async () => {
      try { await track(applyUndo({ ...made, id: hid })); toast("Hand-made panels are back.", "ok"); renderPanels(); }
      catch (e) { toast((e && e.message) || "Couldn't undo. Check your connection", "err"); }
    } });
  },
  clearOverrides: (btn) => IV.resetPanels(btn),   // the old name, kept for one release
  // ---- applicants: shared surnames (H14), rename, merge, delete (H5)
  separateKeys: () => separateShared(true),
  claimShared: async (key, id) => {
    if (id) {
      const plan = claimPlan(planState(), key, id);
      if (!(await confirmDialog(plan.summary, { title: "Whose answers are these?", yes: "Move them", danger: false }))) return;
      try { await track(store.applyPlan(plan, hEntry("roster.merge", "Moved answers saved under a shared last name to {cand}", { by: byWho(), cand: id }))); }
      catch { toast("Couldn't save. Check your connection", "err"); return; }
      toast("Answers moved", "ok");
    } else {
      if (!(await confirmDialog("Keep these answers for reference and ask both applicants to choose their times again? They will each answer under their own name.",
        { title: "Ask both again", yes: "Ask both again", danger: false }))) return;
      try { await track(store.updateConfig((c) => ({ keptSurnameDocs: [...new Set([...(c.keptSurnameDocs || []), key])] }),
        hEntry("roster.rename", "Kept answers under a shared last name for reference; both applicants asked again", { by: byWho() }))); }
      catch { toast("Couldn't save. Check your connection", "err"); }
    }
  },
  renameCand: (id) => {
    const c = cand(id); if (!c) return;
    flowDialog((ctl) => {
      ctl.step({ title: "Rename applicant",
        html: `<label class="ed-label" for="rnIn">Name as it should appear</label>
          <input id="rnIn" type="text" value="${escapeHtml(c.name)}" autocomplete="off"/>
          <p class="small muted">Their screening, scores and notes stay with them.</p>
          <p id="rnMsg" class="small" role="status"></p>`,
        buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close(null) },
          { label: "Rename", kind: "filled", id: "rnGo", run: async (k, btn) => {
            const plan = renamePlan(planState(), id, $("#rnIn").value);
            if (plan.error) { $("#rnMsg").textContent = plan.error; return; }
            await withBusy(btn, () => track(store.applyPlan(plan, hEntry("roster.rename", "Renamed {cand}", { by: byWho(), cand: id }))), "Renamed")
              .then(() => k.close(true), () => {});
          } }] });
      const input = $("#rnIn");
      const msg = () => {
        const plan = renamePlan(planState(), id, input.value);
        $("#rnMsg").textContent = plan.error || [plan.counts.timesMove ? "Their interview times move with them." : "", plan.shared || ""].filter(Boolean).join(" ");
      };
      input.addEventListener("input", msg); input.select();
    });
  },
  mergeCand: (fromId, toId) => {
    const src = cand(fromId);
    const options = S.candidates.filter((c) => c.id !== fromId).sort((a, b) => (a.removed - b.removed) || a.name.localeCompare(b.name));
    if (!options.length) { toast("There is no other entry to merge into", "err"); return; }
    flowDialog((ctl) => {
      const preview = (to) => {
        const plan = mergePlan(planState(), fromId, to);
        const go = async (k, btn, backup) => {
          await withBusy(btn, async () => {
            if (backup) await IV.downloadBackup(null);
            await track(store.applyPlan(plan, hEntry("roster.merge", "Merged a duplicate entry into {cand}", { by: byWho(), cand: to })));
          }, "Merged").then(() => k.close(true), () => {});
        };
        ctl.step({ title: "Merge into another entry", html: `<p>${escapeHtml(plan.error || plan.summary)}</p>`,
          buttons: plan.error ? [{ label: "Close", kind: "ghost", run: (k) => k.close(null) }] : [
            { label: "Cancel", kind: "ghost", run: (k) => k.close(null) },
            { label: "Merge without a backup", kind: "tinted", run: (k, b) => go(k, b, false) },
            { label: "Download backup and merge", kind: "filled", run: (k, b) => go(k, b, true) }] });
      };
      if (toId) { preview(toId); return; }
      ctl.step({ title: "Merge into another entry",
        html: `<p class="small muted">For a remove-and-add-again mix-up: everything saved under '${escapeHtml(src ? src.name : "this entry")}' moves to the entry you pick.</p>
          <label class="ed-label" for="mgTo">The entry to keep</label>
          <select id="mgTo">${options.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.removed ? " (removed)" : ""}</option>`).join("")}</select>`,
        buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close(null) },
          { label: "Next", kind: "filled", run: () => preview($("#mgTo").value) }] });
    });
  },
  deleteCand: (id) => {
    const plan = deletePlan(planState(), id);
    if (plan.error) { toast(plan.error, "err"); return; }
    flowDialog((ctl) => {
      ctl.step({ title: "Delete permanently",
        html: `<p>${escapeHtml(plan.summary)}</p>
          <label class="ed-label" for="delIn">${plan.confirmWord === "delete" ? "Type delete to confirm." : "Type their last name to confirm."}</label>
          <input id="delIn" type="text" autocomplete="off"/>`,
        buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close(null) },
          { label: "Delete permanently", kind: "danger", id: "delGo", disabled: true, run: async (k, btn) => {
            if (lastKey($("#delIn").value) !== plan.confirmWord) return;
            await withBusy(btn, () => track(store.applyPlan(plan, hEntry("roster.delete",
              `Deleted an applicant and ${plan.entries} saved entr${plan.entries === 1 ? "y" : "ies"}`, { by: byWho() }))), "Deleted")
              .then(() => k.close(true), () => {});
          } }] });
      $("#delIn").addEventListener("input", (e) => { $("#delGo").disabled = lastKey(e.target.value) !== plan.confirmWord; });
    });
  },
  // ---- R6: this round, past rounds, retention, restore
  saveRoundName: (btn) => withBusy(btn, async () => {
    const v = (($("#rnName") || {}).value || "").trim().slice(0, 120);
    await track(store.updateState(() => ({ roundName: v }), hEntry("settings.save", "Changed the round name", { by: byWho() })));
  }, "Name saved").catch(() => {}),
  closeRound: () => { closeSetup(); rounds.begin(); },
  roundTakeover: (action) => rounds.takeoverAnd(action, S.meta || {}),
  keptDelete: async (btn) => {
    const kept = (S.meta || {}).keptFromClose || [];
    if (!kept.length) return;
    const raw = await store.readCollections([...new Set(kept.map((k) => k.coll))]);
    const docs = kept.map((k) => ({ ...k, data: (raw[k.coll] || {})[k.id] || null }));
    // history written after the copy went with the closed round (on its saved copy)
    let history = [];
    const from = (S.meta || {}).keptFromAttempt;
    if (from) { try { history = ((await store.readAttempt(from)) || {}).keptHistory || []; } catch { /* still download the rest */ } }
    downloadFile(`ed-hiring-kept-items-${todayIso()}.json`, JSON.stringify({ items: docs, history }, null, 1), "application/json");
    // delete only what is still exactly the kept document: an id the new round
    // has written since (availability under the same name) is the new round's
    const stillKept = docs.filter((d) => d.data && (!d.hash || docHash(d.data) === d.hash));
    const name = (S.meta || {}).keptFromRound || "delete";
    const ok = await flowDialog((ctl) => {
      ctl.step({ title: "Delete the kept items", html: `<p>The file with these ${kept.length} items was downloaded. Delete them from the tool now?
          Type the round name to confirm: <b>${escapeHtml(name)}</b></p><input id="kdIn" type="text" autocomplete="off"/>`,
        buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close(false) },
          { label: "Delete them", kind: "danger", id: "kdGo", disabled: true, run: (k) => k.close(true) }] });
      $("#kdIn").addEventListener("input", (e) => { $("#kdGo").disabled = e.target.value.trim().toLowerCase() !== name.toLowerCase(); });
    });
    if (!ok) return;
    await withBusy(btn, () => track(store.keptDecision(true, stillKept, hEntry("round.delete", `Deleted ${stillKept.length} items kept from the last close`, { by: byWho() }))),
      "Deleted").catch(() => {});
  },
  keptKeep: (btn) => withBusy(btn, () => track(store.keptDecision(false, [], hEntry("settings.save", "Kept the items from the last close in this round", { by: byWho() }))),
    "Kept in this round").catch(() => {}),
  loadPast: async () => {
    ui.past = null;
    try {
      const list = await store.listArchive();
      const due = list.filter((a) => a.status === "closed" && a.deleteAfter && (toDate(a.deleteAfter) || 0) <= Date.now()).length;
      ui.past = { list, due: due ? `${due} past round${due === 1 ? "" : "s"}` : "" };
    } catch (e) { ui.past = { list: [], error: (e && e.code) || "Check your connection." }; }
    const d = document.querySelector('details[data-sec="setPast"] .sec-body'); if (d) d.innerHTML = pastBody();
  },
  pastJson: async (id) => {
    const text = unchunk(await store.readParts(id));
    return parseBackup(text);
  },
  pastDownload: async (id) => {
    try { const b = await IV.pastJson(id); downloadFile(backupFileName(b.round.name), JSON.stringify(b, null, 1), "application/json"); }
    catch (e) { toast((e && e.message) || "Couldn't read that round", "err"); }
  },
  pastExcel: async (id) => { try { downloadExcel(toState((await IV.pastJson(id)).data)); } catch (e) { toast((e && e.message) || "Couldn't read that round", "err"); } },
  pastPrint: async (id) => { try { IV.printCycle(toState((await IV.pastJson(id)).data)); } catch (e) { toast((e && e.message) || "Couldn't read that round", "err"); } },
  pastBringBack: async (id) => {
    let b, live;
    try { b = await IV.pastJson(id); live = await store.snapshotRaw(); } catch (e) { toast((e && e.message) || "Couldn't read that round", "err"); return; }
    const plan = planRestore(b, live, "replace", { committee: EFF().committee, newRoundId: `r-${todayIso().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`,
      nowIso: new Date().toISOString(), defaults: COMMITTEE });
    if (!plan.ok) { await confirmDialog(plan.why, { title: "Bring back", yes: "OK", danger: false }); return; }
    if (!(await confirmDialog(`Bring back '${b.round.name}'? It comes back open, as the working round, with ${plan.writes.length} items. The saved copy is kept.`,
      { title: "Bring back", yes: "Bring it back", danger: false }))) return;
    try {
      await applyRestore(plan, b, `Brought back the past round '${b.round.name}'`);
      await track(store.updateArchive(id, { restoredAt: store.now() }));
      toast(`Brought back ${plan.writes.length} items.`, "ok");
    } catch (e) { toast((e && e.message) || "Couldn't bring it back. Check your connection", "err"); }
    IV.loadPast();
  },
  pastDelete: async (id) => {
    const a = ((ui.past || {}).list || []).find((x) => x.id === id); if (!a) return;
    const name = a.name || "Hiring round";
    const ok = await flowDialog((ctl) => {
      ctl.step({ title: "Delete permanently", html: `<p>Delete '${escapeHtml(name)}' permanently? This removes it from the tool for good. Only backup files you saved
          elsewhere will remain. Type the round name to confirm.</p><input id="pdIn" type="text" autocomplete="off"/>`,
        buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close(false) }, { label: "Delete permanently", kind: "danger", id: "pdGo", disabled: true, run: (k) => k.close(true) }] });
      $("#pdIn").addEventListener("input", (e) => { $("#pdGo").disabled = e.target.value.trim().toLowerCase() !== name.trim().toLowerCase(); });
    });
    if (!ok) return;
    try {
      await track(store.deleteArchive(id));
      await track(store.addHistory(hEntry("round.delete", `Deleted the past round '${name}' permanently.`, { by: byWho() })));
      toast("Deleted", "ok");
    } catch (e) { toast((e && e.code) === "permission-denied" ? "It can't be deleted yet." : "Couldn't delete. Check your connection", "err"); }
    IV.loadPast();
  },
  pastDeleteCopy: async (id) => {
    try { await track(store.deleteArchive(id)); toast("Deleted", "ok"); } catch { toast("Couldn't delete. Check your connection", "err"); }
    IV.loadPast();
  },
  setRetention: async (v) => {
    const months = Number(v) || 0;
    try {
      await track(store.updateConfig(() => ({ retentionMonths: months || null }),
        hEntry("settings.save", `Set how long to keep closed rounds: ${(RETENTION.find(([m]) => m === months) || [0, ""])[1].toLowerCase()}`, { by: byWho() })));
    } catch { toast("Couldn't save. Check your connection", "err"); return; }
    let list = []; try { list = (await store.listArchive()).filter((a) => a.status === "closed"); } catch { /* offline */ }
    if (list.length && await confirmDialog(`Also apply to the ${list.length} past round${list.length === 1 ? "" : "s"} already closed?`,
      { title: "Keep closed rounds for", yes: "Apply to them too", danger: false })) {
      for (const a of list) {
        const closed = toDate(a.closedAt); if (!closed) continue;
        const after = months ? Math.max(closed.getTime() + months * 30.44 * 864e5, closed.getTime() + 31 * 864e5) : null;
        try { await track(store.updateArchive(a.id, { deleteAfter: after ? store.tsFromMillis(after) : null })); } catch { /* refused: leave it */ }
      }
      toast("Applied", "ok");
    }
    rerenderSettings();
  },
  restoreFile: async (input) => {
    const f = input.files && input.files[0]; if (!f) return;
    ui.restore = null;
    try {
      const text = await f.text();
      const backup = await parseBackup(text);
      const chk = checkBackup(backup);
      if (chk.errors.length) throw new Error(chk.errors[0]);
      const live = await store.snapshotRaw();
      const opts = { committee: EFF().committee, newRoundId: `r-${todayIso().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`,
        nowIso: new Date().toISOString(), defaults: COMMITTEE };
      const plans = { missing: planRestore(backup, live, "missing", opts), replace: planRestore(backup, live, "replace", opts) };
      ui.restore = { fileName: f.name, backup, plans, mode: plans.missing.ok ? "missing" : "replace" };
    } catch (e) { ui.restore = { error: (e && e.message) || "That file can't be read." }; }
    rerenderSettings();
  },
  restoreMode: (m) => { if (ui.restore) { ui.restore.mode = m; rerenderSettings(); } },
  restoreCancel: () => { ui.restore = null; rerenderSettings(); },
  restoreGo: (btn) => withBusy(btn, async () => {
    const r = ui.restore; if (!r) return;
    // re-plan against a FRESH read, never the one from when the file was chosen
    const live = await store.snapshotRaw();
    const plan = planRestore(r.backup, live, r.mode, { committee: EFF().committee, newRoundId: r.plans.replace.meta.state ? r.plans.replace.meta.state.roundId : "",
      nowIso: new Date().toISOString(), defaults: COMMITTEE });
    if (!plan.ok) throw new Error(plan.why);
    const n = await applyRestore(plan, r.backup, r.mode === "replace" ? "Replaced the working round from a backup file" : "Brought back missing items from a backup file");
    ui.restore = null; rerenderSettings();
    toast(`Restored ${n} item${n === 1 ? "" : "s"}.`, "ok");
  }).catch(() => {}),
  // ---- change history
  loadHistory: async () => {
    ui.hist = { entries: [], next: null, loading: true };
    try {
      const r = await store.listHistory({ limit: 50 });
      ui.hist = { entries: r.entries, next: r.next };
    } catch (e) { ui.hist = { entries: [], next: null, error: (e && e.code) || "Check your connection." }; }
    refreshHistoryCard();
  },
  moreHistory: (btn) => withBusy(btn, async () => {
    const h = ui.hist; if (!h || !h.next) return;
    const r = await store.listHistory({ after: h.next, limit: 50 });
    ui.hist = { entries: [...h.entries, ...r.entries], next: r.next };
    refreshHistoryCard();
  }),
  undoHistory: (id, btn) => withBusy(btn, async () => {
    const e = ((ui.hist || {}).entries || []).find((x) => x.id === id);
    if (!e) return;
    if (!canUndo(e, S, undoneIds(ui.hist.entries)).ok) throw new Error("Can't undo: changed since.");
    await track(applyUndo(e));
    await IV.loadHistory();
  }, "Undone"),
  printSchedule: () => window.print(),
  // offers
  offerStatus: (id, status, btn) => {
    const o = offerOf(id), today = todayIso();
    if ((o.status || "") === status) return;
    const patch = { status, updatedAt: new Date().toISOString() };
    if (!status) { patch.offeredAt = ""; patch.respondedAt = ""; }
    else {
      if (!o.offeredAt) patch.offeredAt = today;
      if (status === "offered") patch.respondedAt = "";
      else if (!o.respondedAt || !(o.status === "accepted" || o.status === "declined")) patch.respondedAt = today;
    }
    const name = (cand(id) || {}).name || "Candidate";
    track(store.setOffer(id, patch, hEntry("offer.set", status ? `Recorded {cand} as ${OFFER_WORD[status].toLowerCase()}` : "Cleared the offer for {cand}",
      { by: byWho(), cand: id })))
      .then(() => toast(status ? `${name}: ${OFFER_WORD[status].toLowerCase()}` : `${name}: offer cleared`, "ok"))
      .catch(() => toast("Couldn't save. Check your connection", "err"));
  },
  offerDate: (id, field, value) => {
    track(store.setOffer(id, { [field]: value || "", updatedAt: new Date().toISOString() },
      hEntry("offer.set", "Changed an offer date for {cand}", { by: byWho(), cand: id })))
      .then(() => toast("Date saved", "ok")).catch(() => toast("Couldn't save. Check your connection", "err"));
  },
  offerNoteInput: (id, el) => {
    ui.offerNotes = ui.offerNotes || {}; ui.offerNotes[id] = el.value;
    el.style.height = "auto"; el.style.height = el.scrollHeight + "px";
    const b = document.getElementById("ofs-" + id);
    const dirty = el.value !== (offerOf(id).note || "");
    if (b) b.hidden = !dirty;
  },
  offerNoteSave: (id, btn) => withBusy(btn, async () => {
    const v = ((ui.offerNotes || {})[id] ?? offerOf(id).note ?? "").slice(0, 4000);
    await track(store.setOffer(id, { note: v, updatedAt: new Date().toISOString() },
      hEntry("offer.set", "Changed the offer note for {cand}", { by: byWho(), cand: id })));
    if (ui.offerNotes) delete ui.offerNotes[id];
    renderRanking();
  }, "Note saved"),
  // back up the whole cycle
  // The Excel workbook is built from a FRESH server read too (not page state,
  // which mixes in this browser's echo), so it matches the backup file.
  exportCycle: (btn) => withBusy(btn, async () => {
    downloadExcel(toState(await store.snapshotRaw()));
  }, "Excel downloaded"),
  // H1a: the restorable backup, from a fresh one-shot read of every round
  // collection (store.snapshotRaw), never from page memory.
  downloadBackup: (btn) => withBusy(btn || null, async () => {
    const raw = await store.snapshotRaw();
    const b = await buildBackup(raw, { exportedBy: "leadership", build: RELEASE });
    const name = backupFileName(b.round.name || `Hiring round ${new Date().getFullYear()}`);
    downloadFile(name, JSON.stringify(b, null, 1), "application/json");
  }, "Backup downloaded"),
  printCycle: (st) => {
    const t = st ? withState(st, cycleTables) : cycleTables();
    const tbl = (rows, opts = {}) => rows.length < 2 ? `<p class="pr-empty">None recorded.</p>`
      : `<table><thead><tr>${rows[0].map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1)
        .map((r) => `<tr>${r.map((v, i) => `<td${opts.wrap && opts.wrap.includes(i) ? ' class="wrap"' : ""}>${escapeHtml(v == null ? "" : String(v))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    let el = document.getElementById("printReport");
    if (!el) { el = document.createElement("div"); el.id = "printReport"; document.body.appendChild(el); }
    el.innerHTML = `<h1>${escapeHtml(ORG_NAME)}</h1><p class="pr-sub">Hiring cycle summary · printed ${escapeHtml(new Date().toLocaleString())}</p>
      <h2>Summary</h2>${tbl(t.summary)}
      <h2>Ranking</h2>${tbl(t.ranking)}
      <h2>Offers</h2>${tbl(t.offers.map((r, i) => i ? [r[0], r[1], r[2], fmtDay(r[3]), fmtDay(r[4]), r[5]] : r), { wrap: [5] })}
      <h2>Candidates</h2>${tbl(t.candidates)}
      <h2>Panels</h2>${tbl(t.panels)}
      <p class="pr-foot">Screening detail, availability and individual scores are in the Excel backup.</p>`;
    document.body.classList.add("printing-report");
    const done = () => { document.body.classList.remove("printing-report"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  },
  // exports
  exportShortlist: () => {
    // "Rated by / of" travels with the average so the spreadsheet can't be read
    // as though a 5.0 from one person and a 5.0 from twelve were the same thing.
    const rows = [["Candidate", "Status", "Concerns", "Concerns from", "Reasons", "Notes", "Knows them", "Avg priority", "Rated by", "Committee size"]];
    [...S.candidates].sort((a, b) => (isIn(a) === isIn(b) ? 0 : isIn(a) ? -1 : 1) || a.name.localeCompare(b.name))
      .forEach((c) => {
        const st = screenStats(c.id);
        rows.push([c.name, listStatus(c),
          st.flags.length, st.flags.map((f) => f.who).join("; "),
          st.flags.filter((f) => f.reason).map((f) => `${f.who}: ${f.reason}`).join(" | "),
          st.notes.map((n) => `${n.who}: ${n.note}`).join(" | "), st.notes.filter((n) => n.conflict).map((n) => n.who).join("; "),
          st.avg == null ? "" : st.avg.toFixed(1), st.n, st.of]);
      });
    downloadFile("shortlist.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Shortlist exported", "ok");
  },
  exportSchedule: () => {
    const res = computePanels();
    const rows = [["Candidate", "Time", "Modality", "Panel"]];
    res.panels.forEach((p) => rows.push([(cand(p.cand) || {}).name || p.cand, slotName(p.slot), p.modality, p.members.join(" / ")]));
    res.unschedulable.forEach((id) => rows.push([(cand(id) || {}).name || id, "UNSCHEDULED", "", ""]));
    downloadFile("schedule.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Schedule exported", "ok");
  },
  exportScores: () => {
    const { committee, nameOf } = EFF();
    // every member who has scores, including people who left or are off the list
    const ids = committee.map((m) => m.id);
    idsWithInput(S).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    const head = (id) => { const st = memberStatus(committee, id); return nameOf(id) + (st === "Left the committee" ? " (left)" : st === "Not on the list now" ? " (not on the list now)" : ""); };
    const adj = {}; rankingRows().rows.forEach((r) => { adj[r.id] = r; });
    const rows = [["Candidate", "Avg", "Rater-adjusted", "Scored by", "Panel size", ...ids.map(head)]];
    activeCands().forEach((c) => {
      const per = ids.map((id) => (S.scores[key(id, c.id)] || {}).overall || "");
      const r = adj[c.id];
      rows.push([c.name, r ? r.raw.toFixed(2) : "", r ? r.adj.toFixed(2) : "", r ? r.n : 0, (r && r.expected) || "", ...per]);
    });
    downloadFile("scores.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Scores exported", "ok");
  },
  // setup
  // ---- committee editor (H6)
  mSet: (i, field, v, typing) => {
    const d = commDraft(), r = d.rows[i]; if (!r) return;
    r[field] = field === "active" ? v === "true" : v;
    if (field === "role" && v === "screener") r.gender = r.gender || "";
    if (!typing) rerenderSettings();
  },
  mRemove: (i) => { const d = commDraft(), r = d.rows[i]; if (!r) return; d.removed.push(r.id); d.rows.splice(i, 1); rerenderSettings(); },
  mAdd: (v) => { commDraft().add = v; },
  mDiscard: () => { ui.commDraft = null; rerenderSettings(); },
  saveCommittee: (btn) => withBusy(btn, async () => {
    const d = ui.commDraft;
    if (!d) { toast("Nothing changed", "ok"); return; }
    const rows = d.rows.map((r) => ({ ...r, name: String(r.name || "").trim(), email: String(r.email || "").trim() }));
    const blank = rows.find((r) => !r.name);
    if (blank) { toast("Every person needs a name", "err"); return; }
    const used = new Set(rows.map((r) => r.id));
    const added = parseAddLines(d.add).map((m) => { let id = newMemberId(); while (used.has(id)) id = newMemberId(); used.add(id); return { ...m, id }; });
    const list = [...rows, ...added];
    const chk = checkCommittee(list, { chair: EFF().chair });
    if (chk.errors.length) { toast(chk.errors[0], "err"); return; }
    if (chk.warnings.length && !(await confirmDialog(chk.warnings.join("\n\n") + "\n\nSave anyway?",
      { title: "Check the list", yes: "Save anyway", danger: false }))) return;
    const removed = new Set(d.removed);
    // what changed, for the history line (counts only; names are not needed)
    const was = new Map(EFF().committee.map((m) => [m.id, m]));
    const n = { added: added.length, removed: removed.size, renamed: 0, left: 0, back: 0, role: 0 };
    rows.forEach((r) => { const w = was.get(r.id); if (!w) return;
      if (w.name !== r.name) n.renamed++;
      if (w.active && !r.active) n.left++; if (!w.active && r.active) n.back++;
      if (w.role !== r.role) n.role++; });
    const bits = [n.added && `${n.added} added`, n.renamed && `${n.renamed} renamed`, n.left && `${n.left} left`,
      n.back && `${n.back} back`, n.role && `${n.role} changed role`, n.removed && `${n.removed} removed`].filter(Boolean);
    await track(store.updateConfig((c) => {
      // merge by id onto the LATEST saved list: edits win for the people in this
      // draft, anyone added elsewhere meanwhile is kept, removals are explicit
      const saved = normalizeCommittee(c.committee && c.committee.length ? c.committee : COMMITTEE);
      const mine = new Map(list.map((m) => [m.id, m]));
      const out = saved.filter((m) => !removed.has(m.id)).map((m) => (mine.has(m.id) ? { ...m, ...mine.get(m.id) } : m));
      list.forEach((m) => { if (!out.some((x) => x.id === m.id)) out.push(m); });
      return { committee: toStoredCommittee(out),
        panelOverrides: pruneOverrides(c.panelOverrides, (mem) => mem.filter((x) => !removed.has(x))) };
    }, hEntry("committee.save", `Saved the committee list${bits.length ? ` (${bits.join(", ")})` : ""}`, { by: byWho() })));
    ui.commDraft = null; rerenderSettings();
    toast("Committee saved", "ok");
  }).catch(() => {}),
  // ---- questions editor (H2)
  qSet: (i, v) => { const d = qDraft(); if (d.questions[i]) d.questions[i].text = v; },
  qScale: (i, v) => { qDraft().scale[i] = v; },
  qGuide: (v) => { qDraft().guide = v; },
  qMove: (i, dir) => {
    if (qLocked()) return;
    const q = qDraft().questions, j = i + dir;
    if (j < 0 || j >= q.length) return;
    [q[i], q[j]] = [q[j], q[i]]; rerenderSettings();
  },
  qRemove: (i) => { if (qLocked()) return; qDraft().questions.splice(i, 1); rerenderSettings(); },
  qFromNotes: () => {
    if (Q()) return;
    const d = qDraft();
    d.questions = idsFromNotes().map((id) => ({ id, text: "" }));
    rerenderSettings();
  },
  qAdd: () => {
    if (qLocked()) return;
    const q = qDraft().questions; let id = newQuestionId();
    while (q.some((x) => x.id === id)) id = newQuestionId();
    q.push({ id, text: "" }); rerenderSettings();
    const el = document.getElementById(`qText-${q.length - 1}`); if (el) el.focus();
  },
  qDiscard: () => { ui.qDraft = null; rerenderSettings(); },
  saveQuestions: (btn) => withBusy(btn, async () => {
    const d = ui.qDraft;
    if (!d) { toast("Nothing changed", "ok"); return; }
    const locked = qLocked();
    const before = Q() || { questions: [] };
    const after = { questions: d.questions.map((q) => ({ id: q.id, text: q.text })), scale: d.scale,
      guide: String(d.guide || "").split("\n") };
    const errs = checkEdit(before, after, locked);
    if (errs.length) { toast(errs[0], "err"); return; }
    if (locked && !(await confirmDialog("Interviewers have already written notes under these questions. Only fix spelling or small wording. "
      + "To ask something different, wait for the next round.", { title: "Change the wording?", yes: "Save questions", danger: false }))) return;
    const n = after.questions.length;
    await track(store.updateQuestions((cur) => {
      // keep archived questions (they hold the text for notes the list no longer shows)
      const curN = normalizeQuestions(cur);
      const archived = curN ? curN.questions.filter((q) => q.archived && !after.questions.some((x) => x.id === q.id)) : [];
      return toStoredQuestions({ questions: [...after.questions, ...archived], scale: after.scale, guide: after.guide });
    }, hEntry("questions.save", locked ? "Fixed the wording of the interview questions"
      : `Saved the interview questions (${n} question${n === 1 ? "" : "s"})`, { by: byWho() })));
    ui.qDraft = null; rerenderSettings();
    toast("Questions saved", "ok");
  }).catch(() => {}),
  setChair: async (v) => {
    // swap the old chair for the new one in every saved override, keep chair present
    try {
      await track(store.updateConfig((c) => {
        const old = c.chair || CHAIR;
        return { chair: v, panelOverrides: pruneOverrides(c.panelOverrides, (mem) => {
          const set = new Set(mem.filter((n) => n !== old)); set.add(v);
          // The new chair may already have been on a hand-built panel. Dropping
          // the old chair then leaves it a member SHORT — a 3-person panel comes
          // back as 2, which isn't a panel at all, and the only sign is a red
          // "✗ 2 members" badge on the Panels tab. The old chair is still an
          // ordinary committee member, so keep them in that seat.
          if (set.size < mem.length) set.add(old);
          return [...set];
        }) };
      }, hEntry("chair.set", "Changed the chair to {member}", { by: byWho(), member: v })));
    } catch { toast("Couldn't save. Check your connection", "err"); rerenderSettings(); } // reset the picker
  },
  // ---- interview times (see timesEditor). Every write goes through
  // store.updateTimes, which applies the change to the LATEST saved list, so a
  // concurrent edit by another admin is merged rather than overwritten.
  tAddField: (k, v) => { tAdd()[k] = k === "from" || k === "to" ? hhmmOf(v) : v; const el = $("#tAddPreview"); if (el) el.innerHTML = addPreview(); },
  tAdd: async (btn) => {
    const a = tAdd();
    const items = a.date ? splitRange(a.date, a.from, a.to, +a.len) : [];
    if (!items.length) { toast(!a.date || !a.from || !a.to ? "Pick a date, a start and an end" : "Check the start, end and length", "err"); return; }
    const cur = EFF().slots, fresh = [], warns = new Set();
    let dupes = 0;
    for (const t of items) {
      const r = checkSlot(t, [...cur, ...fresh]);
      if (r.errors.some((e) => e.endsWith("already exists."))) { dupes++; continue; }
      if (r.errors.length) { toast(r.errors[0], "err"); return; }
      r.warnings.forEach((w) => warns.add(w));
      fresh.push({ ...t, id: newSlotId() });
    }
    if (!fresh.length) { toast(dupes === 1 ? "That time already exists" : "Those times already exist", "err"); return; }
    if (warns.size && !(await confirmDialog([...warns].join("\n\n") + "\n\nAdd anyway?", { title: "Check these times", yes: "Add anyway", danger: false }))) return;
    let added = 0;
    try {
      await timesBusy(() => withBusy(btn, () => track(store.updateTimes(SLOTS, (times, overrides) => {
        added = 0; // re-run safe: a transaction may retry this function
        const out = times.slice();
        fresh.forEach((t) => { if (!checkSlot(t, out).errors.length) { out.push(t); added++; } });
        return { times: out, overrides };
      }, () => added ? hEntry("times.add", `Added ${pl(added, "interview time")}`, { by: byWho() }) : null))));
    } catch { return; } // withBusy already showed the error
    if (!added) { toast("Nothing added. Someone else just added those times", "err"); return; }
    const skipped = items.length - added;
    toast(`Added ${pl(added, "time")}${skipped ? ` (${skipped} already existed)` : ""}`, "ok");
  },
  tEdit: (id) => { const t = EFF().slots.find((x) => x.id === id); if (!t) return; ui.tEdit = { id, date: t.date, start: t.start, end: t.end }; rerenderSettings(); const el = $("#tEdDate"); if (el) el.focus(); },
  tEditField: (k, v) => { if (ui.tEdit) ui.tEdit[k] = k === "date" ? v : hhmmOf(v); },
  tEditCancel: () => { ui.tEdit = null; rerenderSettings(); },
  tSave: async (btn) => {
    const d = ui.tEdit; if (!d) return;
    const orig = EFF().slots.find((x) => x.id === d.id);
    if (!orig) { ui.tEdit = null; rerenderSettings(); toast("That time was just removed by someone else", "err"); return; }
    if (isStructured(orig) && orig.date === d.date && orig.start === d.start && orig.end === d.end) { ui.tEdit = null; rerenderSettings(); return; }
    const t = { id: d.id, date: d.date, start: d.start, end: d.end };
    const r = checkSlot(t, EFF().slots);
    if (r.errors.length) { toast(r.errors[0], "err"); return; }
    if (r.warnings.length && !(await confirmDialog(r.warnings.join("\n\n") + "\n\nSave anyway?", { title: "Check this time", yes: "Save anyway", danger: false }))) return;
    // people already answered for the old time: keep (typo fix) or ask again (real move)
    let reask = false;
    const who = answersText(answerCounts()[d.id]);
    const booked = panelsAt([d.id]);
    if (who || booked.length) {
      const was = slotLabel(orig), now = slotLabel(t);
      const choice = await confirmDialog(
        `${who ? `${who} already answered for ${was}.` : `A panel is booked for ${was}.`}\n\n` +
        `• Keep answers: for small corrections; everyone's answers${booked.length ? " and the booked panel" : ""} move to ${now}.\n` +
        `• Ask again: if the time really changed; their answers for this time are cleared${booked.length ? ", the panel is re-planned," : ""} and they'll need to re-answer (they'll show as “waiting on” again).`,
        { title: "Change an answered time", yes: "Ask again", alt: "Keep answers", danger: true });
      if (!choice) return;
      reask = choice === true;
    }
    // timesBusy holds live re-renders until ui.tEdit is cleared below, so our own
    // "Ask again" (which retires this id) isn't mistaken for someone else's removal
    await timesBusy(() => withBusy(btn, () => track(store.updateTimes(SLOTS, (times, overrides) => {
      const i = times.findIndex((x) => x.id === d.id);
      if (i < 0) throw new Error("That time was just removed by someone else");
      const next = { ...t, id: reask ? newSlotId() : d.id };
      const others = times.filter((x) => x.id !== d.id);
      const chk = checkSlot(next, others);
      if (chk.errors.length) throw new Error(chk.errors[0]);
      const out = others.concat(next);
      if (reask) Object.keys(overrides).forEach((c) => { if (String(overrides[c].slot) === d.id) delete overrides[c]; });
      return { times: out, overrides };
    }, hEntry("times.edit", reask ? `Moved ${slotLabel(orig)} to ${slotLabel(t)} and asked people again` : `Changed ${slotLabel(orig)} to ${slotLabel(t)}`,
      { by: byWho() }))), reask ? "Time changed, answers cleared" : "Time updated").then(() => { ui.tEdit = null; ui.setupStale = true; }, () => {}));
  },
  tRemove: async (ids) => {
    const cur = EFF().slots.filter((t) => ids.includes(t.id));
    if (!cur.length) return;
    const counts = answerCounts();
    const tot = cur.reduce((a, t) => { const c = counts[t.id] || {}; a.iv += c.iv || 0; a.cand += c.cand || 0; return a; }, { iv: 0, cand: 0 });
    const booked = panelsAt(ids);
    const what = cur.length === 1 ? slotLabel(cur[0])
      : isStructured(cur[0]) ? `all ${cur.length} times on ${fmtDate(cur[0].date, true)}` : `all ${cur.length} undated times`;
    let msg = `Remove ${what}?`;
    const who = answersText(tot);
    if (who) msg += `\n\n${who} already answered for ${cur.length === 1 ? "it" : "these"}. Those answers will be discarded.`;
    if (booked.length) msg += `\n\nScheduled then: ${booked.map((b) => b.name + (b.manual ? " (manual panel, will be removed)" : "")).join(", ")}. They'll be re-planned into other times if possible.`;
    const left = EFF().slots.length - cur.length;
    if (!left) msg += "\n\nThis leaves no interview times. People will see “times not posted yet”.";
    if (!(await confirmDialog(msg, { title: cur.length === 1 ? "Remove time" : "Remove day", yes: "Remove" }))) return;
    const gone = new Set(cur.map((t) => t.id));
    try {
      await timesBusy(async () => {
        await track(store.updateTimes(SLOTS, (times, overrides) => {
          Object.keys(overrides).forEach((c) => { if (gone.has(String(overrides[c].slot))) delete overrides[c]; });
          return { times: times.filter((t) => !gone.has(t.id)), overrides };
        }, hEntry("times.remove", `Removed ${what}`, { by: byWho() })));
        if (ui.tEdit && gone.has(ui.tEdit.id)) ui.tEdit = null; // our own removal — no "someone else" notice
        ui.setupStale = true;
      });
      toast(cur.length === 1 ? "Time removed" : `${cur.length} times removed`, "ok");
    } catch (e) { toast((e && e.message) || "Couldn't remove. Check your connection", "err"); }
  },
  tRemoveDay: (date) => IV.tRemove(EFF().slots.filter((t) => (isStructured(t) ? t.date : "") === date).map((t) => t.id)),
  saveOneDrive: (btn) => withBusy(btn, () => track(store.setSettings({ oneDrive: ($("#odIn").value || "").trim() || "#" },
    hEntry("settings.save", "Changed the applications folder link", { by: byWho() }))), "Saved"),
};

window.CAND = {
  set: (id, v) => {
    const cur = (S.availCand[ui.candLast] || {})[id];
    store.setAvail("cand", ui.candLast, id, cur === v ? null : v)
      .then(() => toast("Saved", "ok"), async (e) => {
        if (e && e.code === "permission-denied") {
          // booking may have closed or paused since the page was drawn: ask the
          // public document once, and show that rather than "not found"
          let b = "open"; try { b = await store.refreshPublic(); } catch { /* keep */ }
          if (b !== "open") { renderCandidate(); return; }
          // The name passed at the gate, so a refusal here means the roster
          // changed underneath them (removed, or renamed). Saying "check your
          // connection" would send them away thinking they were scheduled.
          toast("We can no longer find your name in the applicant list. Please contact us", "err"); return;
        }
        toast("Couldn't save. Check your connection", "err");
      });
  },
  rename: () => { ss.del("ed_iv_cand"); ss.del("ed_iv_cand_disp"); ui.candLast = null; ui.candDisplay = null; ui.noticeKey = null; ui.notice = undefined; renderCandidate(); },
  reply: async (v) => {
    if (v === "withdrawn") {
      const go = await flowDialog((ctl) => ctl.step({ title: "Withdraw from the interview?",
        html: "<p>We will tell the hiring team. If you only need a different time, reply to our email instead.</p>",
        buttons: [{ label: "Keep my interview", kind: "ghost", run: (k) => k.close(false) },
          { label: "Withdraw", kind: "danger", run: (k) => k.close(true) }] }));
      if (!go) return;
    }
    try { await store.setReply(ui.candLast, v); }
    catch (e) {
      if (e && e.code === "permission-denied") {
        let b = "open"; try { b = await store.refreshPublic(); } catch { /* keep */ }
        if (b !== "open") { renderCandidate(); return; }
        toast("We can no longer find your name in the applicant list. Please contact us", "err"); return;
      }
      toast("Couldn't save. Check your connection", "err"); return;
    }
    toast(v === "confirmed" ? "Thank you. See you then." : v === "withdrawn" ? "You have withdrawn." : "Your interview is back.", "ok");
    renderCandidate();
  },
  logout: () => logOut(["ed_iv_cand", "ed_iv_cand_disp"]),
};

// Log out = forget this tab's password AND sign out of Firebase, then reload.
// It used to do only the first half, so the Firebase sign-in outlived the
// "logged out" page. signOut is local (no network), but it is capped at 3s so
// a stuck SDK can never leave someone unable to log out.
async function logOut(keys) {
  // H12: save anything still pausing, give unconfirmed saves up to 5 seconds,
  // and ask before throwing any away. Then forget this browser's own copies of
  // your scores and screening (and an applicant's picks).
  flushPending();
  const t0 = Date.now();
  while (unconfirmed() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
  if (unconfirmed()) {
    const ok = await confirmDialog("Some changes haven't reached the server yet. Log out anyway? They will be lost.",
      { title: "Log out", yes: "Log out anyway" });
    if (!ok) return;
  }
  [...keys, "ed_iv_code", "ed_iv_signedin", "ed_iv_localrole"].forEach((k) => ss.del(k));
  // say once, after the reload, that scores are saved but won't show here again
  try { const e = JSON.parse(ls.get("ed_iv_echo_v1") || "{}"); if (Object.keys(e.scores || {}).length) ss.set("ed_iv_bye", "1"); } catch { /* nothing to say */ }
  ui.loggingOut = true;     // this sign-out is wanted: not "you were signed out"
  if (store) store.clearLocalCopies(); else { ls.del("ed_iv_echo_v1"); ls.del("ed_iv_cand_echo_v1"); }
  if (fbAuth) {
    try {
      await Promise.race([fbAuth.authFns.signOut(fbAuth.auth), new Promise((r) => setTimeout(r, 3000))]);
    } catch (e) { console.warn("sign-out failed:", e && e.code); }
  }
  location.reload();
}

// ------------------------------------------------- close the round (H1, R6)
// The flow itself lives in rounds.js; this wires it to the page.
const rounds = createRounds({
  store: () => store, state: () => S, byWho, release: RELEASE,
  roundName: () => (S.meta && S.meta.roundName) || `Hiring round ${new Date().getFullYear()}`,
  retentionMonths: () => { const m = (S.settings || {}).retentionMonths; return Number.isInteger(m) && m > 0 ? m : null; },
  downloadText: (name, text, mime) => downloadFile(name, text, mime),
  backupName: (name) => backupFileName(name),
  excelFromData: (data) => downloadExcel(toState(data)),
  rerender: () => { render(); refreshSetup(); },
  onActive: (on) => { ui.closing = on; },
});
// Every page other than the one closing: read-only while the close is alive;
// once its lease has not changed for 5 minutes (on this page's clock), offer to
// finish or stop it (a takeover first, which the server refuses if it is fresh).
function renderRoundLine() {
  const el = $("#roundLine"); if (!el) return;
  if (!store || !store.metaLoaded) return;        // the first state decides reload vs twin (rounds.js)
  const st = S.meta || {};
  const mode = rounds.onState(st);
  ui.roundMode = mode;
  const ro = mode === "fresh" || mode === "stale";
  document.body.classList.toggle("closing-elsewhere", ro);
  // read-only for real: no click, key or focus reaches the page or Setup
  ["#app", "#settings"].forEach((q) => { const e = $(q); if (e) e.inert = ro; });
  if (mode !== "fresh" && mode !== "stale") { el.classList.add("hidden"); el.innerHTML = ""; return; }
  if (mode === "fresh") { el.innerHTML = `<p>Leadership (another page) is closing the round now.</p>`; el.classList.remove("hidden"); return; }
  const started = dayOf(st.closingStartedAt);
  const paint = (status) => {
    el.innerHTML = status === "clearing"
      ? `<p>Closing was started${started ? ` on ${escapeHtml(started)}` : ""} and part of the round has been cleared. Nothing is lost: everything is in the saved copy.
          <button class="linky" onclick="IV.roundTakeover('finish')">Finish closing</button> · <button class="linky" onclick="IV.roundTakeover('stop')">Stop closing and put everything back</button></p>`
      : `<p>Closing was started${started ? ` on ${escapeHtml(started)}` : ""} and didn't finish. Nothing has been cleared.
          <button class="linky" onclick="IV.roundTakeover('finish')">Finish closing</button> · <button class="linky" onclick="IV.roundTakeover('stop')">Stop closing</button></p>`;
    el.classList.remove("hidden");
  };
  if (ui._staleAttempt && ui._staleAttempt.id === st.closingAttemptId) { paint(ui._staleAttempt.status); return; }
  paint("");
  const id = st.closingAttemptId;
  (id ? store.readAttempt(id) : Promise.resolve(null)).then((a) => { ui._staleAttempt = { id, status: a ? a.status : "missing" }; paint(ui._staleAttempt.status); }, () => {});
}
// the stale view needs re-checking even when no snapshot arrives
setInterval(() => { if (ui.role === "admin" && S && S.meta && S.meta.roundStatus === "closing") renderRoundLine(); }, 10000);

// The Excel workbook from any state (a fresh read, or an archived round).
function downloadExcel(st) {
  const t = withState(st, cycleTables);
  const bytes = buildXlsx([
    { name: "Summary", rows: t.summary, widths: [26, 70] },
    { name: "Candidates", rows: t.candidates }, { name: "Screening", rows: t.screening },
    { name: "Availability - committee", rows: t.availCommittee }, { name: "Availability - applicants", rows: t.availApplicants },
    { name: "Panels", rows: t.panels }, { name: "Scores", rows: t.scores }, { name: "Questions", rows: t.questions, widths: [12, 80, 12] },
    { name: "Ranking", rows: t.ranking },
    { name: "Offers", rows: t.offers }, { name: "Committee", rows: t.committee }, { name: "Interview times", rows: t.times },
  ]);
  downloadFile(`ed-hiring-backup-${todayIso()}.xlsx`, bytes, XLSX_MIME);
}

// Run a render or table builder against another state (a fresh server read, or
// an archived round) instead of the live one. Synchronous only.
function withState(st, fn) { const keep = S; S = st; try { return fn(); } finally { S = keep; } }

// ------------------------------------------------- reload notice (section 2.3)
// version.json is fetched every 10 minutes (and when the tab comes back after
// that long), never cached. When it names another release, ED and Guest pages
// show one line; a Leadership page reloads itself, but only when nothing could
// be lost: nothing pausing or unconfirmed, no dialog open, no field focused, no
// panel editor or draft open, and session storage working (where it is
// blocked the sign-in lives in memory and a reload would drop it). At most
// once per version per tab, so a stale cached page can't reload in a loop.
const VERSION_EVERY_MS = 10 * 60 * 1000;
let lastVersionCheck = Date.now();
async function checkVersion() {
  lastVersionCheck = Date.now();
  try {
    const r = await fetch("version.json", { cache: "no-store" });
    if (!r.ok) return;
    const v = String((await r.json()).release || "");
    if (v && v !== RELEASE) { ui.newVersion = v; renderUpdateLine(); if (ui.role === "admin") tryReload(); }
  } catch { /* offline: try again next time */ }
}
function nothingToLose() {
  if (flushPending() || unconfirmed()) return false;
  if (dialogOpen() || setupOpen()) return false;
  const a = document.activeElement;
  if (a && a !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
  if (ui.editPanel || (ui._draft && Object.keys(ui._draft).length) || ui.qDraft || ui.commDraft
      || (ui.offerNotes && Object.keys(ui.offerNotes).length) || ui.tEdit) return false;
  const t = ui.tAdd; if (t && (t.date || t.from || t.to)) return false;
  if (ui.closing) return false;
  return storageWorks("sessionStorage");
}
function tryReload() {
  clearTimeout(tryReload._t);
  if (!ui.newVersion || ss.get("ed_iv_reloaded_for") === ui.newVersion) return;
  if (nothingToLose()) { ss.set("ed_iv_reloaded_for", ui.newVersion); location.reload(); return; }
  tryReload._t = setTimeout(tryReload, 30000);
}
// One line under the header for page-level news: a new release, and the
// allowed-list fight (H14) that only an older open tab can cause.
function renderUpdateLine() {
  const el = $("#updateLine"); if (!el) return;
  const lines = [];
  if (ui.newVersion) lines.push(`This page was updated. <button class="linky" onclick="location.reload()">Reload</button> to get the latest version.`);
  if (ui.role === "admin" && ui._allowed && ui._allowed.held)
    lines.push("Another open Physician Hiring tab is using an older version and keeps changing the applicant list. Reload or close the other tab.");
  el.innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
  el.classList.toggle("hidden", !lines.length);
}
setInterval(checkVersion, VERSION_EVERY_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastVersionCheck >= VERSION_EVERY_MS) checkVersion();
});
window.__edCheckVersion = checkVersion;   // lets the sims ask now instead of in 10 minutes

// ------------------------------------------------- instant info tooltips
let tipEl = null;
function showTip(target) {
  const text = target.getAttribute("data-tip"); if (!text) return;
  hideTip();
  tipEl = document.createElement("div");
  tipEl.className = "tooltip"; tipEl.textContent = text;
  document.body.appendChild(tipEl);
  const r = target.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2 + window.scrollX;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = r.bottom + 8 + window.scrollY;
  if (r.bottom + 8 + tr.height > window.innerHeight) top = r.top - tr.height - 8 + window.scrollY;
  tipEl.style.left = left + "px"; tipEl.style.top = top + "px";
  requestAnimationFrame(() => tipEl && tipEl.classList.add("show"));
}
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }
// Anything carrying data-tip, not just the "i" badge — the availability grid
// puts a name on every square and its legend promises that hovering works.
const tipTarget = (e) => e.target.closest && e.target.closest("[data-tip]");
document.addEventListener("mouseover", (e) => { const t = tipTarget(e); if (t) showTip(t); });
document.addEventListener("mouseout", (e) => { if (tipTarget(e)) hideTip(); });
document.addEventListener("focusin", (e) => { const t = tipTarget(e); if (t) showTip(t); });
document.addEventListener("focusout", hideTip);
document.addEventListener("scroll", hideTip, true);

// ------------------------------------------------------------------- boot
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#gbtn"), val = $("#gpw").value.trim();
  if (!val || gatePausedFor()) return;
  $("#gerr").textContent = "";
  await withBusy(btn, () => unlock(val)).catch(() => {});
  if (gatePausedFor()) gateCountdown();
});
$("#memberBtn").onclick = () => {
  const v = $("#memberSel").value;
  if (!v) { toast("Pick your name from the list first", "err"); return; }
  ui.member = v; showApp();
};
$("#adminOnlyBtn").onclick = () => { if (ui.isAdmin) { ui.member = null; showApp(); } };
$("#changeMember").onclick = backToMemberPick;
$("#setupBtn").onclick = () => (setupOpen() ? closeSetup() : openSetup());
$("#setupClose").onclick = closeSetup;
$("#settings").addEventListener("focusout", flushSetup); // catch up on held live updates
$("#setupModal").onclick = (e) => { if (e.target === $("#setupModal")) closeSetup(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented && setupOpen()) closeSetup(); });
$("#logout").onclick = () => logOut(["ed_iv_member", "ed_iv_cand"]);
// Tells the net in index.html that the module really did load and run. Without
// this it shows "the page didn't finish loading" after 8 seconds.
window.__edReady = true;

// A browser that blocks site storage can still do everything that matters —
// every answer goes to the server — but it cannot replay your own input on a
// later visit. Say so once, plainly, rather than let it look like lost work.
if (!storageWorks()) {
  const el = $("#gerr");
  if (el) el.innerHTML = `<div style="text-align:left" class="muted">Your browser is blocking site storage
    (often Settings → Safari → “Block All Cookies”, or Private Browsing). You can still sign in and
    everything you submit is saved. This device just won’t remember your own answers between visits.</div>`;
}

// H12: after Log out, the one line about scores (they are on the server, but
// reviewers can't read scores back, so this device won't show them again)
if (ss.get("ed_iv_bye")) {
  ss.del("ed_iv_bye");
  const el = $("#gerr");
  if (el) el.innerHTML = `<div style="text-align:left" class="muted">You are logged out. Your scores are saved, but this device won't show them to you again after you sign in.</div>`;
}

if (gatePausedFor()) gateCountdown();
resume().catch((e) => console.warn("resume failed:", e && e.code));
