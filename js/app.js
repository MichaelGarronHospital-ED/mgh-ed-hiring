// ============================================================================
//  Committee app controller. One link, three audiences:
//    • committee reviewer  — code           → Screen · Availability · Score
//    • admin               — code + "!"      → + Panels · Ranking · Setup
//    • applicant           — applicant code  → own scheduling only (candidate view)
//  Wired to the store (local or Firestore). Security model is enforced by
//  Firestore rules when AUTH.mode === "roles" (see config.js + firestore.rules).
// ============================================================================
import { firebaseConfig, ORG_NAME, CHAIR, COMMITTEE, SLOTS, ONEDRIVE,
         CANDIDATE_CODE_LOCAL, AUTH, SCREENING_DEADLINE } from "./config.js";
import { decryptContent } from "./data.js";
import { LocalStore, FirestoreStore, key } from "./store.js";
import { autoPanels, buildPanel } from "./panels.js";
import { escapeHtml, toast, avg, confirmDialog, downloadFile, withBusy, daysUntil, csvCell, lastKey,
         ss, ls, storageWorks } from "./util.js";
import { effectiveSlots, slotLabel, slotTimeLabel, groupByDate, checkSlot, splitRange, responseCounts,
         newSlotId, isStructured, fmtDate } from "./slots.js";

let QUESTIONS = [], SCALE = [], GUIDE = [];
let store = null, S = null;
const ui = { role: "committee", isAdmin: false, member: null, tab: "screen", scoreCand: null,
             candLast: null, editPanel: null, openSections: {} };
const $ = (s) => document.querySelector(s);
const isConfigured = () => firebaseConfig && Object.keys(firebaseConfig).length > 0 && firebaseConfig.apiKey;
const ADMIN_SCOPES = ["candidates", "screening", "availIv", "availCand", "scores", "meta"];

// lastKey (the applicant's availability document id) now lives in util.js, so
// store.js and the rules' allowed-name list share one definition with this file.

// Effective config: admin-set settings (DB) if present, else placeholder defaults.
// `slots` = interview times [{id,date,start,end}] in date order; everything that
// references a time (availability, panels) uses its stable `id`, never a position.
function EFF() {
  const s = (S && S.settings) || {};
  const committee = s.committee && s.committee.length ? s.committee : COMMITTEE;
  const slots = effectiveSlots(s, SLOTS);
  return { committee, chair: s.chair || CHAIR, slots, oneDrive: s.oneDrive || ONEDRIVE,
    overrides: s.panelOverrides || {}, slotIds: slots.map((t) => t.id) };
}
const slotName = (id) => slotLabel(EFF().slots.find((t) => t.id === String(id)));
// only answers for times that still exist count (edited/removed times leave stale keys)
const liveAnswers = (map) => { const ids = new Set(EFF().slotIds); return Object.keys(map || {}).filter((k) => ids.has(k)); };
// availability for a candidate: support both committee-keyed (candId, legacy) and
// applicant-keyed (last name) documents.
const availForCand = (c) => (S.availCand[c.id]) || (S.availCand[lastKey(c.name)]) || {};

// ------------------------------------------------------------------ gate
async function unlock(typed, silent) {
  if (!(window.crypto && window.crypto.subtle)) {
    gateFail("Open the secure https link (not a local file).");
    return;
  }
  // 1) admin OR committee — the code independently decrypts the questions and
  //    tells us which role it is (admin vs staff wrap). No trailing-"!" needed.
  let decrypted = null;
  try { decrypted = await decryptContent(typed); } catch { /* not a staff/admin code */ }
  if (decrypted) {
    QUESTIONS = decrypted.q; SCALE = decrypted.s; GUIDE = decrypted.g || [];
    ui.isAdmin = decrypted.isAdmin;
    ui.role = ui.isAdmin ? "admin" : "committee";
    try { await initStore(ui.role, typed); }
    catch (e) {
      // A stored code that fails must not be replayed on every page load:
      // Firebase throttles the DEVICE after repeated failures, so a stale code
      // in sessionStorage can lock someone out all by itself — and each reload
      // makes the block longer while looking like the code is the problem.
      ss.del("ed_iv_code");
      gateFail(signInError(e, { codeVerified: true, isAdmin: ui.isAdmin,
        email: ui.isAdmin ? AUTH.adminEmail : AUTH.committeeEmail }));
      return;
    }
    ss.set("ed_iv_code", typed);
    $("#gate").classList.add("hidden");
    proceedToMemberPick();
    return;
  }
  // 2) applicant — a different code; goes straight to their own scheduling
  const localCandOk = typed === CANDIDATE_CODE_LOCAL;
  if (AUTH.mode !== "roles" && !localCandOk) {
    if (!silent) gateFail("Incorrect code.");
    return;
  }
  try {
    ui.role = "candidate";
    await initStore("candidate", typed);
  } catch (e) {
    ss.del("ed_iv_code");
    // The code decrypted nothing, so it is either the applicant code or simply
    // wrong — we genuinely cannot tell which, and must not imply otherwise.
    if (!silent) gateFail(signInError(e, { email: AUTH.candidateEmail }));
    return;
  }
  ss.set("ed_iv_code", typed);
  $("#gate").classList.add("hidden");
  proceedCandidate();
}

// Why the sign-in failed, in words that point at the actual fault.
//
// `codeVerified` is the load-bearing distinction. A code that DECRYPTED is
// cryptographically proven to be a real staff or admin code — nothing else
// unwraps the content key. So if Firebase then rejects it, the code is right
// and the ACCOUNT is wrong: its password was never set to this code, or it
// doesn't exist, or the provider is off. Reporting that as "Incorrect code."
// sends the one person who holds a valid code away to retype it, which is the
// one thing that cannot help — and it is indistinguishable from a typo, so
// nobody thinks to look in the Firebase console.
//
// The detailed messages are safe to show: they appear ONLY after a valid code
// has decrypted, so the reader already has staff or admin access.
function signInError(e, opts = {}) {
  const c = (e && e.code) || "";
  const known = !!opts.codeVerified;
  const who = opts.email || "the role account";
  const console_ = "Leadership: Firebase console → Authentication";

  // The SDK itself never arrived — nothing was even attempted.
  if (c === "app/sdk-unreachable")
    return "Couldn't load the sign-in service. A hospital network, VPN or content blocker may be "
      + "blocking www.gstatic.com. Try another network (mobile data is the quickest test).";
  // Firebase throttles the DEVICE, not the account, and every retry extends it.
  // Saying "try again" here is actively harmful, so say the opposite.
  if (c.includes("too-many-requests"))
    return "Too many sign-in attempts — the server has temporarily blocked this device. "
      + "Wait about 15 minutes, then try ONCE. Retrying now makes the block last longer.";
  if (c.includes("network-request-failed") || c.includes("network"))
    return "Network problem — check your connection and try again.";
  if (c.includes("operation-not-allowed"))
    return `Email/Password sign-in is switched off for this project. ${console_} → Sign-in method.`;
  if (c.includes("user-disabled"))
    return `The ${who} account is disabled. ${console_} → Users.`;
  // "invalid-credential" is what a modern project returns for BOTH a wrong
  // password and a missing account once email-enumeration protection is on, so
  // these three cannot be told apart from here — the message covers both.
  if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("user-not-found")) {
    if (!known) return "Incorrect code.";
    return `This is a valid ${opts.isAdmin ? "admin" : "staff"} code — it unlocked the questions — but `
      + `${who} rejected it. That account either doesn't exist or its password isn't this code. `
      + `${console_} → Users → ${who}, and set its password to this exact code.`;
  }
  if (!known) return "Couldn't sign in. Please try again.";
  return `The code is recognised but sign-in failed${c ? ` (${c})` : ""}. ${console_} → Users, and check ${who}.`;
}

// One place that paints a gate failure, so every path gets the same treatment
// (and the hint below counts attempts across all of them).
let gateAttempts = 0;
function gateFail(msg) {
  gateAttempts++;
  const gerr = $("#gerr"); if (!gerr) return;
  // .overlay-box centres its text, which is fine for "Incorrect code." and
  // unreadable for the several-sentence diagnoses below.
  gerr.innerHTML = `<div style="text-align:${msg.length > 40 ? "left" : "center"}">${escapeHtml(msg)}</div>`
    + gateHint(gateAttempts);
}

// Three separate codes reach this one box, so "it doesn't work" is ambiguous by
// construction. After a couple of failures, say what the three are.
function gateHint(n) {
  if (n < 2) return "";
  return `<div class="note tip" style="text-align:left; margin-top:.7rem">There are three different codes:
    the <b>staff</b> code (reviewers), the <b>admin</b> code (leadership — Panels, Ranking and Setup)
    and the <b>applicant</b> code. They are not interchangeable: the staff code will sign you in, but
    without the leadership view. If you are sure you have the right one, leadership should check the
    matching account in the Firebase console.</div>`;
}

async function initStore(role, typed) {
  if (isConfigured()) {
    // Separate "the SDK never arrived" from "the server said no". They are the
    // same thrown error to the gate otherwise, and a blocked CDN then reads as
    // a bad code — a hospital network or content blocker is a real cause here.
    let fb;
    try { fb = await loadFirestore(); }
    catch (e) {
      const err = new Error("could not load the Firebase SDK");
      err.code = "app/sdk-unreachable"; err.cause = e;
      throw err;
    }
    await signInFor(fb, role, typed); // may throw → surfaced at the gate
    const scopes = role === "candidate"
        ? (AUTH.mode === "roles" ? ["public"] : ["meta"])  // roles: only the PII-free public slots doc; anon: config

      : (AUTH.mode === "roles" && role === "committee")
        ? ["candidates", "availIv", "availCand", "meta"]   // reviewers can't read scores/screening
        : ADMIN_SCOPES;                                    // admin or anon
    // Mirror your own input locally for EVERY committee role, admin included.
    // It used to be committee-only, which meant rating something as admin and
    // coming back with the staff code showed a blank review on the same
    // machine — the likeliest cause of the "my ratings vanished" report.
    // Screening now also comes back from the server; scores never do, so for
    // those this mirror is still the only replay a reviewer gets.
    const echo = AUTH.mode === "roles" && role !== "candidate";
    ui.echoOnly = AUTH.mode === "roles" && role === "committee";
    store = new FirestoreStore(fb, { scopes, echo });
  } else {
    store = new LocalStore();
  }
  store.subscribe((s) => {
    S = s;
    if (ui.role === "candidate") { if ($("#candview") && !$("#candview").classList.contains("hidden")) renderCandidate(); }
    else if ($("#app") && !$("#app").classList.contains("hidden")) {
      // The roster changed out from under this session and no longer has the
      // name we're filing input under — everything typed from here would be
      // saved to a name nobody reads. Send them back to the picker instead.
      if (ui.member && !EFF().committee.some((m) => m.name === ui.member)) {
        toast(`“${ui.member}” is no longer on the committee list — please pick your name again`, "err");
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
    if (ui.role === "admin" && isConfigured()) syncAllowedNames();
  });
  S = store.getState();
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
function syncAllowedNames() {
  const want = [...new Set(S.candidates.filter((c) => !c.removed).map((c) => lastKey(c.name)).filter(Boolean))].sort();
  if (!want.length) return;                 // never publish an empty list: that would lock every applicant out
  const have = S.allowedNames;
  if (have && have.length === want.length && want.every((k, i) => have[i] === k)) return;
  if (ui._syncingNames) return;
  ui._syncingNames = true;
  store.setAllowedNames(want)
    .catch((e) => console.warn("allowed-name sync failed:", e && e.code))
    .finally(() => { ui._syncingNames = false; });
}

async function loadFirestore() {
  const [a, f, au] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
  ]);
  const app = a.initializeApp(firebaseConfig);
  return {
    app, auth: au.getAuth(app), authFns: au,
    db: f.getFirestore(app), collection: f.collection, doc: f.doc,
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot, runTransaction: f.runTransaction,
    deleteField: f.deleteField,
  };
}

async function signInFor(fb, role, typed) {
  const { auth, authFns } = fb;
  if (AUTH.mode === "roles") {
    const email = role === "candidate" ? AUTH.candidateEmail
      : role === "admin" ? AUTH.adminEmail : AUTH.committeeEmail;
    await authFns.signInWithEmailAndPassword(auth, email, typed);
  } else {
    // let a real failure (e.g. Anonymous auth disabled) surface at the gate
    // rather than proceed unauthenticated into a blank app
    if (!auth.currentUser) await authFns.signInAnonymously(auth);
    console.warn("[ED Hiring] AUTH.mode is 'anon': access control is UI-only and " +
      "any signed-in client can read all data via the Firestore API. Before real " +
      "applicant data, activate the 'roles' model (README → Real access control).");
  }
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
      ? `<b>Leadership access</b> — you'll have Panels, Ranking and Setup.`
      : `<b>Committee access</b> — Screen, Availability and Score. Expecting Panels, Ranking and Setup?
         That's the separate <b>admin</b> code, not this one.`;
  }
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
  const names = [...EFF().committee].sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = `<option value="" disabled selected>— Select your name —</option>`
    + names.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
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
  $("#whoLine").textContent = ui.member;
  $("#adminTag").classList.toggle("hidden", !ui.isAdmin);
  $("#setupBtn").classList.toggle("hidden", !ui.isAdmin);
  if (!ui.isAdmin && ui.tab === "settings") ui.tab = "screen";
  ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.remove("hidden"));
  buildTabs();
  renderBanner();
  render();
}

function buildTabs() {
  // Natural progression; Panels(3) before Score(4). Setup lives on the gear icon,
  // not the tab row, so the tabs read as one clean sequence.
  const tabs = [["screen", "Screen"], ["availability", "Availability"]];
  if (ui.isAdmin) tabs.push(["panels", "Panels"]);
  tabs.push(["score", "Score"]);
  if (ui.isAdmin) tabs.push(["ranking", "Ranking"]);
  $("#tabs").innerHTML = tabs.map(([t, label], i) =>
    `<button id="tab-${t}" data-tab="${t}" role="tab" aria-controls="${t}" aria-selected="${t === ui.tab}"
       tabindex="${t === ui.tab ? "0" : "-1"}" class="${t === ui.tab ? "on" : ""}">${i + 1} · ${label}</button>`).join("");
  tabs.forEach(([t]) => { const s = $("#" + t); if (s) s.setAttribute("aria-labelledby", "tab-" + t); });
  const btns = [...$("#tabs").querySelectorAll("button")];
  const select = (b, focus) => {
    ui.tab = b.dataset.tab;
    $("#setupBtn").classList.remove("active");
    btns.forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; });
    if (focus) b.focus();
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
const flagsCount = (id) => EFF().committee.filter((c) => (S.screening[key(c.name, id)] || {}).flag).length;
const isIn = (c) => !c.removed && flagsCount(c.id) < 2;
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
    d.addEventListener("toggle", () => { ui.openSections[d.dataset.sec] = d.open; });
  });
  document.querySelectorAll("details.howto").forEach((d) => {
    d.addEventListener("toggle", () => setHowto(d.dataset.howto, d.open));
  });
}

// ---- "What to do here" ----------------------------------------------------
// The guidance a first-time reviewer needs is a paragraph; the fifth time it is
// noise above every tab. So it collapses to one line and REMEMBERS that choice
// across sessions (localStorage, per tab) — unlike the section state, which is
// deliberately per-render only. Open by default: someone who has never used the
// tab should never have to go looking for the instructions.
const HOWTO_KEY = "ed_iv_howto_v1";
let howtoState = null;
function howtoAll() {
  if (howtoState) return howtoState;
  try { howtoState = JSON.parse(ls.get(HOWTO_KEY) || "{}") || {}; }
  catch { howtoState = {}; }
  return howtoState;
}
function setHowto(id, open) {
  howtoAll()[id] = open;
  ls.set(HOWTO_KEY, JSON.stringify(howtoState));
}
function howto(id, bodyHtml, label = "What to do here") {
  const open = howtoAll()[id] !== false;
  const chev = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  return `<details class="howto" data-howto="${id}" ${open ? "open" : ""}>
    <summary>${chev}${escapeHtml(label)}</summary><div class="howto-body">${bodyHtml}</div></details>`;
}
const empty = (ico, title, msg) =>
  `<div class="empty"><div class="ico" aria-hidden="true">${ico}</div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(msg)}</p></div>`;

function renderBanner() {
  const el = $("#banner"); if (!el) return;
  const d = daysUntil(SCREENING_DEADLINE);
  if (d == null || S.meta.interviewsComplete) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  let cls = "banner", txt;
  const date = new Date(SCREENING_DEADLINE + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (d > 0) { txt = `<b>Screening closes in ${d} day${d === 1 ? "" : "s"}</b> — due ${date}.`; if (d <= 3) cls += " urgent"; }
  else if (d === 0) { txt = `<b>Screening closes today</b> (${date}).`; cls += " urgent"; }
  // "past", never "info": `.info` is the 16px round badge, and this line sets
  // the banner's whole className (see the note in styles.css).
  else { txt = `Screening deadline (${date}) has passed.`; cls += " past"; }
  el.className = cls;
  el.innerHTML = `<div class="inner"><span aria-hidden="true">🗓️</span><span>${txt}</span></div>`;
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
  ["setChair", "setCommittee", "setSlots", "setOneDrive"].forEach((k) => delete ui.openSections[k]);
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
  const flags = [], ratings = [], by = [];
  committee.forEach((m) => {
    const s = S.screening[key(m.name, candId)] || {};
    if (s.flag) flags.push({ who: m.name, reason: String(s.reason || "").trim() });
    if (s.rating) { ratings.push(s.rating); by.push({ who: m.name, rating: s.rating }); }
  });
  by.sort((a, b) => b.rating - a.rating || a.who.localeCompare(b.who));
  // reasons first: a bare flag is the least informative line on the card and
  // shouldn't split two people's sentences apart.
  flags.sort((a, b) => (b.reason ? 1 : 0) - (a.reason ? 1 : 0));
  return { flags, ratings, by, avg: avg(ratings), n: ratings.length, of: committee.length };
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
  const firstTok = (n) => String(n || "").trim().toLowerCase().split(/\s+/)[0] || "";
  for (const e of found.values()) {
    e.likely = e.name
      ? live.filter((c) => (firstTok(c.name) && firstTok(c.name) === firstTok(e.name))
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
function myInputNotice(list, get, deviceOnly) {
  if (!list.length || (deviceOnly && !ui.echoOnly)) return "";
  const has = (r) => !!r && !!(r.flag || r.rating || r.overall ||
    (r.notes && Object.values(r.notes).some((t) => String(t || "").trim())));
  const done = list.filter((c) => has(get(c))).length;
  if (!deviceOnly) {
    // Only claim "any device" once the server has actually answered. Until the
    // hardened rules are published the read is refused, and promising something
    // the app can't do is worse than saying nothing.
    const anywhere = !store || store.screeningReadBack !== false;
    return `<div class="note local"><b>${done} of ${list.length}</b> reviewed by you.
      ${anywhere
        ? `Your flags and ratings follow you — sign in on any device, pick your name, and they'll be here.`
        : `Saved to leadership the moment you tap. This browser remembers your own answers; on another
           device they'll look blank until leadership finishes the setup.`}
      Only leadership can see everyone's together.</div>`;
  }
  return `<div class="note local"><b>${done} of ${list.length}</b> scored on this device.
    Everything you tap is saved to leadership immediately. Scores are deliberately write-only —
    nobody on the committee can read anyone's back, which is what stops the ranking leaking
    mid-process — so this page replays <b>your</b> answers from <b>this browser</b>. On another
    device they'll look blank; that is the privacy model, not lost work.${done ? "" :
      " If you know you scored somewhere else, check with leadership before re-entering it."}</div>`;
}

// ------------------------------------------------------------ 1 · Screen
function renderScreen() {
  const me = ui.member;
  const { committee, oneDrive } = EFF();
  let html = howto("screen", `Open the applications folder to read each applicant's CV &amp; cover letter, then
    <b>flag</b> anyone you feel isn't qualified (add a short reason). You can also give an optional
    <b>1–5 priority</b>. Your input goes to leadership, who see everyone's side by side; the app never
    shows one reviewer another's flags or ratings.`);

  if (ui.isAdmin) {
    const submitted = new Set();
    Object.keys(S.screening).forEach((k) => { const v = S.screening[k]; if (v && (v.flag || v.rating)) submitted.add(k.split("~")[0]); });
    const notYet = committee.filter((m) => !submitted.has(m.name)).map((m) => m.name);

    // Still-in first, then excluded/removed — that split is the decision, so it
    // holds whichever sort is chosen and excluded people never drift back up
    // into the list you're working. Within each group, your pick.
    //   name   — alphabetical, the order you can predict and scan
    //   rating — highest average priority first; unrated last, because "no
    //            rating" is not a low rating and must not sort as one
    //   flags  — most-flagged first, for working through the exclusions
    const SORTS = { name: "Name", rating: "Avg priority", flags: "Flags" };
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
      const statusPill = c.removed ? '<span class="pill out">removed</span>'
        : fc >= 2 ? '<span class="pill out">excluded · flags</span>'
        : '<span class="pill in">interview</span>';
      const action = c.removed
        ? `<button class="linky" onclick="IV.removeCand('${c.id}',false)">restore</button>`
        : `<button class="linky danger" onclick="IV.removeCand('${c.id}',true)">remove</button>`;
      // One line per flagger, attributed and quoted in full. Several people
      // flagging one applicant is the normal case, and each sentence is the
      // thing leadership actually has to weigh.
      const reasons = fc ? `<ul class="reasons">` + st.flags.map((f) => f.reason
          ? `<li><span class="rwho">${escapeHtml(f.who)}</span><span>${escapeHtml(f.reason)}</span></li>`
          : `<li class="noreason"><span class="rwho">${escapeHtml(f.who)}</span><span>flagged without a reason</span></li>`).join("")
        + `</ul>` : "";
      const rateTip = st.n
        ? `Mean of the ${st.n} priority rating${st.n === 1 ? "" : "s"} actually submitted. `
          + `${st.of - st.n} member${st.of - st.n === 1 ? "" : "s"} didn't rate — non-answers are left out, not counted as a middling score.`
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
      return `<div class="collrow ${fc >= 2 || c.removed ? "out" : ""}">
        <div class="collhead"><span class="name">${escapeHtml(c.name)}</span>${statusPill}<span class="spacer"></span>${action}</div>
        <div class="collmeta">
          <span class="metric ${fc >= 2 ? "flagged" : ""}" data-tip="${fc ? escapeHtml(st.flags.map((f) => f.who).join(", ")) + " flagged this applicant." : "Nobody has flagged this applicant."} Two or more flags take them off the interview list.">
            <b>${fc}</b> flag${fc === 1 ? "" : "s"}</span>
          <span class="metric" data-tip="${escapeHtml(rateTip)}"><span aria-hidden="true">★</span>
            <b>${st.avg == null ? "—" : st.avg.toFixed(1)}</b> avg priority
            <span class="denom ${thin ? "thin" : ""}">${st.n} of ${st.of} rated</span></span>
          ${raters}
        </div>${reasons}</div>`;
    }).join("");

    const collation = `<div class="note">A candidate drops off the interview list at <b>≥2 flags</b> (last year's rule).
        Flag reasons are attributed here and visible to <b>leadership only</b>.
        <b>Avg priority</b> is the plain mean of the ratings that were submitted — hover it to see how many.</div>
      ${S.candidates.length > 1 ? sortBar : ""}
      <div class="collist">${rows || empty("📝", "No candidates yet", "Add applicants below to start screening.")}</div>
      <div class="adminbar"><button class="btn tinted small" onclick="IV.exportShortlist()"><span aria-hidden="true">⬇︎</span> Export shortlist (CSV)</button></div>`;

    const hidden = hiddenInput();
    const part = (n, w) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");
    const hiddenBlock = !hidden.entries.length ? "" : `<div class="note warnbox" style="margin-top:.8rem">
      <b class="warn">⚠ ${hidden.total} saved entr${hidden.total === 1 ? "y is" : "ies are"} attached to
      ${hidden.entries.length} applicant${hidden.entries.length === 1 ? "" : "s"} nobody can see.</b>
      That is the footprint of a remove-and-re-add: the new entry gets a new id, and the flags, ratings and
      scores already given stay on the old one. <b>Nothing is lost</b> — it is in the database, just attached
      to an entry the Screen tab doesn't show reviewers.
      ${hidden.entries.map((e) => {
        const bits = [part(e.flags, "flag"), part(e.ratings, "rating"), part(e.scores, "interview score")].filter(Boolean).join(", ");
        const who = [...e.members].sort().map((m) => `<span class="chip">${escapeHtml(m)}</span>`).join("");
        const target = e.likely && e.likely.length === 1 ? e.likely[0] : null;
        const cmd = e.name && target
          ? `node migrate-candidate.mjs --from ${JSON.stringify(e.name)} --to ${JSON.stringify(target.name)} --apply`
          : null;
        return `<div class="hidrow">
          <div><b>${escapeHtml(e.name || e.id)}</b>
            <span class="pill out">${e.kind === "removed" ? "removed" : "no longer on the roster"}</span></div>
          <div class="muted small">${escapeHtml(bits)} — from ${who}</div>
          ${target ? `<div class="small">Looks like the same person as <b>${escapeHtml(target.name)}</b>, who is still on the list.</div>` : ""}
          ${cmd ? `<pre class="cmd">${escapeHtml(cmd)}</pre>` : ""}
        </div>`;
      }).join("")}
      <div class="small" style="margin-top:.5rem">Run that from <code>tools/interviews/scripts/</code> on a
      computer (it needs the admin password, is a dry run without <code>--apply</code>, and never overwrites
      input already given under the new entry). To fix a spelling in future use
      <code>scripts/rename-candidate.mjs</code>, which keeps the id, instead of removing and re-adding.</div>
    </div>`;
    const dash = `<div class="note">Chase anyone who hasn't submitted before the deadline.</div>
      <p><b>${submitted.size}/${committee.length}</b> members have submitted screening.</p>
      ${notYet.length ? `<p class="muted small">Waiting on:</p><div>${notYet.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")}</div>`
        : `<p class="ok small">✓ Everyone has submitted.</p>`}
      ${hiddenBlock}`;

    const adder = `<div class="note">Paste applicant names, one per line, then Add. Stored in your database, never in the app's code.
      To fix a spelling, use <code>scripts/rename-candidate.mjs</code> — removing and re-adding strands every rating.</div>
      <textarea id="bulkAdd" rows="4" placeholder="Dr Jane Doe&#10;Dr John Smith" aria-label="New candidate names"></textarea>
      <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.addCands(this)">Add candidates</button></div>`;

    html += section("collation", "Collation & shortlist", `${activeCands().length} of ${S.candidates.length} still in`, collation,
        { open: false, count: S.candidates.length, info: "Everyone's flags and priority ratings, collated. A candidate drops off the interview list at 2 or more flags. Reasons are visible to leadership only. Export the shortlist as a CSV here." })
      + section("dash", "Coordinator dashboard", `${submitted.size}/${committee.length} submitted`, dash,
        { open: false, info: "Track who has and hasn't submitted their screening, so you can chase people before the deadline.", count: hidden.entries.length ? "⚠" : null })
      + section("adder", "Add candidates", "", adder,
        { open: false, info: "Paste applicant names to add them to the interview list. Stored securely in your database — never in the app's code. You can add or remove people any time." })
      + `<h3>Your review</h3>`;
  }

  // Alphabetical, like the "Who are you?" list: with a dozen-plus names the
  // only ordering a reviewer can navigate is the one they can predict.
  const toReview = S.candidates.filter((c) => !c.removed).sort((a, b) => a.name.localeCompare(b.name));
  html += myInputNotice(toReview, (c) => S.screening[key(me, c.id)]);

  // One OneDrive folder holds every applicant's files, so the link is the same
  // on every candidate. It sits once above the list rather than repeating
  // identically down the page.
  const docsBar = !toReview.length ? ""
    : oneDrive === "#"
      ? `<div class="docsbar"><span class="muted small"><span aria-hidden="true">📄</span>
          Applications folder isn't set up yet — leadership adds it in Setup.</span></div>`
      : `<div class="docsbar">
          <a class="doc" href="${escapeHtml(oneDrive)}" target="_blank" rel="noopener"><span aria-hidden="true">📄</span> View CVs &amp; cover letters</a>
          <span class="muted small">Same folder for every applicant below.</span>
          <span class="spacer" style="flex:1"></span>
          <span class="muted small">priority 1 (low) – 5 (high), optional</span></div>`;

  html += docsBar + toReview.map((c) => {
    const sc = S.screening[key(me, c.id)] || {};
    const flagged = !!sc.flag;
    // Name, priority and flag on one line. The repeated "Optional priority"
    // label is carried by the column hint above the list instead of being
    // restated on every card — with twenty applicants that was most of the page.
    return `<div class="card revcard">
      <div class="row center"><div class="grow"><div class="name">${escapeHtml(c.name)}</div></div>
        <div class="rate" role="group" aria-label="Priority rating for ${escapeHtml(c.name)}">${[1, 2, 3, 4, 5].map((n) => `<button class="${sc.rating === n ? "on" : ""}" aria-pressed="${sc.rating === n}" onclick="IV.rate('${c.id}',${n})">${n}</button>`).join("")}</div>
        <button class="flagbtn ${flagged ? "on" : ""}" aria-pressed="${flagged}" onclick="IV.toggleFlag('${c.id}')">${flagged ? '<span aria-hidden="true">⚑</span> Flagged' : "Flag concern"}</button></div>
      ${flagged ? `<textarea id="rsn-${c.id}" placeholder="Why? (optional, seen by leadership only)" aria-label="Reason">${escapeHtml(sc.reason || "")}</textarea>
        <div style="margin-top:.4rem"><button class="savebtn" onclick="IV.saveReason('${c.id}',this)">Save reason</button></div>` : ""}
    </div>`;
  }).join("") || (ui.isAdmin ? "" : empty("📝", "Nothing to screen yet", "Applicants will appear here once leadership adds them."));
  $("#screen").innerHTML = html;
}

// ------------------------------------------------------ shared slot control
// one row per time, grouped under a date heading; buttons carry the time's id
function slotRows(slots, map, handler) {
  const seg = (id, v, l, cur) => `<button class="${cur === v ? "on " + v : ""}" aria-pressed="${cur === v}" onclick="${handler}('${id}','${v}')">${l}</button>`;
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
  const { committee, slots, chair } = EFF();
  if (!slots.length || !committee.length) return "";

  // Chair first (every panel needs them), then alphabetical.
  const people = [...committee].sort((a, b) =>
    a.name === chair ? -1 : b.name === chair ? 1 : a.name.localeCompare(b.name));

  // buildPanel wants { g, avail }; the roster stores the field as `gender`
  // (same mapping as renderPanels — see the interviewers object there).
  const ivMap = {};
  for (const m of committee) ivMap[m.name] = { g: m.gender, avail: S.availIv[m.name] || {} };

  const GLYPH = { ip: "P", zoom: "Z", either: "E" };
  const WORD = { ip: "in person", zoom: "Zoom", either: "either" };

  const head = `<tr><th class="tlab">Time</th>` +
    people.map((m) => `<th class="ivcol"><span data-tip="${escapeHtml(m.name)}${m.name === chair ? " (chair)" : ""}">` +
      `${escapeHtml(m.name)}${m.name === chair ? " ★" : ""}</span></th>`).join("") +
    `<th class="sum" data-tip="Whether a balanced panel can be formed at this time">Panel</th>` +
    `<th class="pad" aria-hidden="true"></th></tr>`;

  const body = groupByDate(slots).map((g) =>
    `<tr class="dayrow"><td colspan="${people.length + 3}">${escapeHtml(g.title)}</td></tr>` +
    g.items.map((t) => {
      const cells = people.map((m) => {
        const v = (S.availIv[m.name] || {})[t.id];
        return v
          ? `<td class="av ${v}" data-tip="${escapeHtml(m.name)} · ${WORD[v]}">${GLYPH[v]}</td>`
          : `<td class="av no" data-tip="${escapeHtml(m.name)} · not available"></td>`;
      }).join("");
      const n = people.filter((m) => (S.availIv[m.name] || {})[t.id]).length;
      // A panel needs the chair, 3–5 people and a gender mix; ask buildPanel
      // rather than guessing from the count, which would be wrong and look right.
      const ok = buildPanel(t.id, "ip", ivMap, chair) || buildPanel(t.id, "zoom", ivMap, chair);
      const why = ok ? `A panel can run at this time (${n} available)`
        : n === 0 ? "Nobody has said they can do this time"
        : !(S.availIv[chair] || {})[t.id] ? `${chair} (chair) isn't available, so no panel can run`
        : `${n} available, but not a combination that makes a balanced panel`;
      return `<tr><th class="tlab">${escapeHtml(slotTimeLabel(t))}</th>${cells}` +
        `<td class="sum ${ok ? "yes" : "nope"}" data-tip="${escapeHtml(why)}">${n}${ok ? " ✓" : " ✗"}</td>` +
        `<td class="pad"></td></tr>`;
    }).join("")).join("");

  const legend = `<div class="glegend">
    <span><i class="sw ip">P</i> in person</span><span><i class="sw zoom">Z</i> Zoom</span>
    <span><i class="sw either">E</i> either</span><span><i class="sw no"></i> not available</span>
    <span class="muted small">★ chair · hover any square for the name</span></div>`;

  return `<div class="note tip" style="margin-bottom:.6rem">Every interviewer against every time.
      The <b>Panel</b> column says whether a balanced panel could actually run then — it uses the same
      rules as the Panels tab, so a ✓ here means a panel really is possible.</div>
    <div class="gridwrap"><table class="avgrid"><thead>${head}</thead><tbody>${body}</tbody></table></div>${legend}`;
}

// ------------------------------------------------------ 2 · Availability
function renderAvailability() {
  const map = S.availIv[ui.member] || {};
  const slots = EFF().slots;
  let html = howto("availability", `For each interview time, tap whether you <b>can</b> do it
    in person, by Zoom, or either. Leave a time untouched if you're not available. Tap a highlighted option again to clear it.
    <b>Your choices save automatically</b> (watch the “✓ Saved” note at the top).`);
  html += slots.length
    ? `<div class="card"><div class="slotgrid"><div class="h">Interview time</div><div class="h">I can do…</div>${slotRows(slots, map, "IV.avail")}</div></div>`
    : empty("🗓️", "No interview times yet", ui.isAdmin ? "Add interview times in Setup (the gear icon)." : "Leadership hasn't published the interview times yet — check back soon.");

  // Everyone on the committee sees the grid — an interviewer choosing times is
  // far better informed knowing which times are thin.
  const grid = availGrid();
  if (grid) html += section("avgrid", "Who's available when", "at a glance", grid, { open: true });

  if (ui.isAdmin) {
    const { committee } = EFF();
    const ivSubmitted = committee.filter((m) => liveAnswers(S.availIv[m.name]).length);
    const ivNot = committee.filter((m) => !liveAnswers(S.availIv[m.name]).length).map((m) => m.name);
    const candWith = activeCands().filter((c) => liveAnswers(availForCand(c)).length);
    const candNot = activeCands().filter((c) => !liveAnswers(availForCand(c)).length).map((c) => c.name);
    const dash = `<div class="note">Who still needs to send their availability. Chase before you build panels.</div>
      <p><b>Interviewers:</b> ${ivSubmitted.length}/${committee.length} submitted.
        ${ivNot.length ? `<br><span class="muted small">Waiting on:</span> ${ivNot.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")}` : '<span class="ok small">✓ all in</span>'}</p>
      <p style="margin-top:.6rem"><b>Applicants:</b> ${candWith.length}/${activeCands().length} submitted.
        ${candNot.length ? `<br><span class="muted small">Waiting on:</span> ${candNot.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")}` : '<span class="ok small">✓ all in</span>'}</p>`;
    html += section("availdash", "Availability dashboard", `interviewers & applicants`, dash, { open: true });
  }
  $("#availability").innerHTML = html;
}

// ------------------------------------------------------------- 3 · Score
function renderScore() {
  const list = activeCands().slice().sort((a, b) => a.name.localeCompare(b.name));
  const head = howto("score", `After each interview, jot notes per question, then give
    <b>one overall 1–5 rating</b> using the guide at the bottom. Your score is private to you and leadership.
    <b>Notes and ratings save automatically</b> — you'll see “✓ Saved” appear at the top each time.`);
  if (!list.length) { $("#score").innerHTML = head + empty("⭐️", "No candidates to score", "Candidates on the interview list will appear here."); return; }
  if (!ui.scoreCand || !list.some((c) => c.id === ui.scoreCand)) ui.scoreCand = list[0].id;
  const me = ui.member, cid = ui.scoreCand;
  const rec = S.scores[key(me, cid)] || { notes: {} };
  const scored = (c) => !!(S.scores[key(me, c.id)] || {}).overall;
  const at = list.findIndex((c) => c.id === cid);
  const jump = (d) => { const t = list[at + d]; return t
    ? `<button class="btn ghost small" onclick="IV.pickScore('${t.id}')" aria-label="${d < 0 ? "Previous" : "Next"} candidate: ${escapeHtml(t.name)}">${d < 0 ? "‹" : "›"}</button>`
    : `<button class="btn ghost small" disabled aria-hidden="true">${d < 0 ? "‹" : "›"}</button>`; };
  // A "scored" tick in the picker turns thirteen identical names into a
  // progress list — the reviewer can see at a glance who they still owe.
  $("#score").innerHTML = head
    + myInputNotice(list, (c) => S.scores[key(me, c.id)], true)
    + `<div class="card scorebar"><div class="row center"><div class="muted small">Scoring</div>
      <select class="grow" onchange="IV.pickScore(this.value)" aria-label="Candidate to score">${list.map((c) =>
        `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${escapeHtml(c.name)}${scored(c) ? " ✓" : ""}</option>`).join("")}</select>
      <span class="scorenav">${jump(-1)}${jump(1)}</span></div>
      <div class="muted small" style="margin-top:.4rem">${list.filter(scored).length} of ${list.length} scored by you${
        rec.overall ? "" : " · this one isn't yet"}</div></div>
    ${QUESTIONS.map((q, i) => { const filled = String((rec.notes || {})[i] || "").trim();
      // numbered from 1 for the human reading it; the note itself is still
      // keyed by the array index, so nothing saved moves.
      return `<div class="card qcard ${filled ? "done" : ""}"><div class="small muted">Question ${i + 1} of ${QUESTIONS.length}</div><div>${escapeHtml(q)}</div>
      <textarea oninput="IV.note(${i},this.value)" placeholder="Notes" aria-label="Notes for question ${i + 1}">${escapeHtml((rec.notes || {})[i] || "")}</textarea></div>`; }).join("")}
    <div class="card"><b>Overall rating</b>
      <div class="rate" role="group" aria-label="Overall rating" style="margin:.6rem 0">${[1, 2, 3, 4, 5].map((n) => `<button class="${rec.overall === n ? "on" : ""}" aria-pressed="${rec.overall === n}" onclick="IV.score(${n})">${n}</button>`).join("")}</div>
      <div class="legend">${SCALE.map((s, i) => `<div style="margin:.35rem 0"><b>${i + 1}</b> — ${escapeHtml(s)}</div>`).join("")}</div></div>
    ${GUIDE.length ? section("guide", "Guidance for panelists", "", `<ul class="small">${GUIDE.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`) : ""}`;
}

// ------------------------------------------------------ 4 · Panels (admin)
// validate a panel's members against the current committee (size, chair present,
// balanced = ≥1 who identifies female + ≥1 male). Returns flags + warnings.
function validatePanel(members, slot, modality) {
  const { committee, chair } = EFF();
  const gmap = {}; committee.forEach((m) => { gmap[m.name] = m.gender; });
  const present = members.filter((m) => gmap[m]);            // still on the committee
  const size = present.length, sizeOk = size >= 3 && size <= 5;
  const chairOk = present.includes(chair);
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
    if (av === undefined) warns.push(`${m} hasn't said they can do that time`);
    else if (modality && !(av === "either" || av === modality)) warns.push(`${m} can't do ${modality} that time`);
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
  const { committee, chair, slotIds, overrides } = EFF();
  const interviewers = {};
  committee.forEach((c) => { interviewers[c.name] = { g: c.gender, avail: S.availIv[c.name] || {} }; });
  const candidates = {};
  activeCands().forEach((c) => { candidates[c.id] = { avail: availForCand(c) }; });
  const res = autoPanels(candidates, interviewers, slotIds, chair);
  // apply overrides: {candId:{slot,members,modality}}. An override may schedule an
  // otherwise-unschedulable candidate, or replace an auto panel. Overrides are
  // re-validated (never trusted blindly) and stale members are dropped.
  const byCand = {};
  res.panels.forEach((p) => { byCand[p.cand] = { ...p, valid: validatePanel(p.members, p.slot, p.modality) }; });
  let unsched = res.unschedulable.slice();
  const lostTime = []; // manual panels whose time was removed → fall back to auto
  Object.entries(overrides).forEach(([cid, ov]) => {
    if (!activeCands().some((c) => c.id === cid)) return;
    if (!ov || !ov.members || !ov.members.length) return;
    if (!slotIds.includes(String(ov.slot))) { lostTime.push(cid); return; }
    const avail = candidates[cid] ? candidates[cid].avail : {};
    // always include the current chair; keep only current committee members
    const names = new Set(committee.map((m) => m.name));
    let members = ov.members.filter((m) => names.has(m));
    if (names.has(chair) && !members.includes(chair)) members = [chair, ...members];
    const modality = ov.modality || (avail[ov.slot] === "zoom" ? "zoom" : avail[ov.slot] === "ip" ? "ip" : "ip");
    byCand[cid] = { cand: cid, slot: ov.slot, members, modality, manual: true, valid: validatePanel(members, ov.slot, modality) };
    unsched = unsched.filter((x) => x !== cid);
  });
  const panels = Object.values(byCand).sort((a, b) => slotIds.indexOf(a.slot) - slotIds.indexOf(b.slot));
  // Two candidates at one time. The auto-matcher cannot produce this — it
  // matches one candidate per slot by construction — but a manual override can,
  // and nothing else notices: validatePanel only ever sees one panel. Left
  // unsaid, it surfaces as two applicants turning up for the same hour.
  const bySlot = {};
  panels.forEach((p) => { (bySlot[String(p.slot)] = bySlot[String(p.slot)] || []).push(p.cand); });
  const doubleBooked = Object.entries(bySlot).filter(([, cs]) => cs.length > 1)
    .map(([slot, cands]) => ({ slot, cands }));
  return { panels, unschedulable: unsched, understaffed: res.understaffed, interviewers, lostTime,
           doubleBooked, panelSize: res.panelSize, why: res.why || {} };
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
  const chips = (list) => list.map((x) => `<span class="chip">${escapeHtml(x)}</span>`).join("");
  const line = (list, tail) => list.length
    ? `<p class="small" style="margin-top:.45rem">${chips(list)} — ${tail}</p>` : "";
  return `<p class="small" style="margin-top:.55rem"><b class="warn">⚠ Not on any panel:</b></p>
    ${line(group.silent, "no availability sent yet.")}
    ${line(group.wrongTimes, `free only at times nobody is being interviewed in, or only in a format
      (in person / Zoom) the interviews booked then aren't running in.`)}
    ${line(group.squeezed, `free while interviews are running, but every panel they could have joined
      is full — and taking a seat there would either unbalance that panel or leave somebody else with
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
    return `${who} — hasn't picked any interview times yet. Chase them, or set a time by hand.`;
  if (w.reason === "contested") {
    // name the applicants holding those times: the admin can only fix this by
    // moving one of them or adding a time, and both need to know which.
    const holders = [...new Set(res.panels.filter((p) => w.slots.includes(String(p.slot)))
      .map((p) => nameOf(p.cand)))];
    const times = w.slots.map((s) => escapeHtml(slotName(s))).join(", ");
    return `${who} — ${w.slots.length === 1 ? "the one time" : "every time"} that could host their
      interview (${times}) is already taken${holders.length ? ` by ${holders.map(escapeHtml).join(", ")}` : ""}.
      Add another interview time, or move someone.`;
  }
  return `${who} — no time they can do yields a balanced panel.`;
}

function renderPanels() {
  const { committee, chair, slots, overrides } = EFF();
  const nameOf = (id) => (cand(id) || {}).name || id;
  const modPill = (m) => `<span class="pill ${m === "ip" ? "ip" : "zoom"}">${m === "ip" ? "In-person" : "Zoom"}</span>`;
  const res = computePanels();

  let html = howto("panels", `The tool builds a suggested, balanced interview panel for each
    applicant from everyone's availability. Review them, tap <b>Edit</b> to adjust any panel by hand, and fix anything under
    “Needs attention”. Panels are one candidate per time slot.`);
  if (!EFF().slots.length) { $("#panels").innerHTML = html + empty("🗓️", "No interview times yet", "Add interview times in Setup, then collect availability."); return; }

  html += `<div class="adminbar">
    <button class="btn tinted small" onclick="IV.exportSchedule()"><span aria-hidden="true">⬇︎</span> Export schedule (CSV)</button>
    <button class="btn ghost small" onclick="IV.printSchedule()"><span aria-hidden="true">🖨</span> Print</button>
    ${Object.keys(overrides).length ? `<button class="btn ghost small" onclick="IV.clearOverrides(this)"><span aria-hidden="true">↺</span> Reset manual edits</button>` : ""}
  </div>`;

  // Who is actually doing the interviews. Counted from the panels ON SCREEN —
  // auto and manual together — rather than from the builder's own tally, because
  // a hand-edited panel skews the share and that is exactly what this should
  // show. The builder shares the non-chair seats out by load; this is the proof.
  if (res.panels.length) {
    const load = {}; committee.forEach((m) => { load[m.name] = 0; });
    res.panels.forEach((p) => p.members.forEach((m) => { if (m in load) load[m]++; }));
    const others = Object.entries(load).filter(([n]) => n !== chair);
    const counts = others.map(([, v]) => v);
    const unused = others.filter(([, v]) => !v).map(([n]) => n);
    const lo = counts.length ? Math.min(...counts) : 0, hi = counts.length ? Math.max(...counts) : 0;
    const chips = others.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([n, v]) => `<span class="chip">${escapeHtml(n)} <b>${v ? "×" + v : "—"}</b></span>`).join("");
    const n = res.panels.length;
    const loadBody = `<div class="note">${escapeHtml(chair)} chairs every panel, so the share that can be
        spread is the <b>other</b> ${res.panelSize > 1 ? res.panelSize - 1 : 0} seat${res.panelSize === 2 ? "" : "s"} on each one.
        They go to whoever has done fewest interviews so far${res.panelSize > 3
          ? `, and panels are set to <b>${res.panelSize}</b> rather than the minimum 3 precisely so there are enough seats for everyone`
          : ""}.
        Availability wins over fairness where they conflict: someone free for only one time can only ever
        sit on that one panel, and every panel still has to stay balanced.</div>
      <p class="small"><b>${escapeHtml(chair)}</b> — all ${n} panel${n === 1 ? "" : "s"} (chair).</p>
      <div>${chips}</div>
      ${unused.length ? idleInterviewers(unused, res)
        : `<p class="ok small" style="margin-top:.55rem">✓ Every interviewer is on at least one panel.</p>`}`;
    html += section("panelload", "Interviewer load",
      unused.length ? `${unused.length} not used` : `${lo}–${hi} each`, loadBody,
      { open: false, count: unused.length ? "⚠" : null,
        info: "How the interviewing is shared out. The chair is on every panel by rule; the remaining seats go to whoever has done fewest so far, subject to who is actually available and keeping every panel balanced." });
  }

  html += res.panels.map((p) => {
    const editing = ui.editPanel === p.cand;
    const v = p.valid || validatePanel(p.members, p.slot, p.modality);
    let card = `<div class="panelbox"><div class="row center"><div class="grow"><b>${escapeHtml(nameOf(p.cand))}</b> · ${escapeHtml(slotName(p.slot))} ${modPill(p.modality)} ${p.manual ? '<span class="pill neutral">manual</span>' : ""}</div>
      <button class="btn ghost small" onclick="IV.editPanel('${p.cand}')">${editing ? "Close" : "Edit"}</button></div>
      <div class="small" style="margin-top:.4rem">${p.members.map(escapeHtml).join(" · ")}</div>
      <div class="badges"><span class="badge ${v.sizeOk ? "ok" : "bad"}">${v.sizeOk ? "✓" : "✗"} ${v.size} member${v.size === 1 ? "" : "s"}</span>
        <span class="badge ${v.balanced ? "ok" : "bad"}">${v.balanced ? "✓ balanced panel" : "✗ not balanced"}</span>
        ${v.warns.filter((w) => w !== "not a balanced panel" && !w.startsWith("fewer") && !w.startsWith("more")).map((w) => `<span class="badge bad">⚠ ${escapeHtml(w)}</span>`).join("")}</div>`;
    if (editing) card += panelEditor(p);
    return card + `</div>`;
  }).join("") || `<div class="card">${empty("🧩", "No panels yet", "Panels appear once interviewers and applicants submit availability.")}</div>`;

  if (res.unschedulable.length || res.understaffed.length || res.lostTime.length || res.doubleBooked.length) {
    html += `<div class="card"><b><span aria-hidden="true">⚠</span> Needs attention</b><ul class="small">
      ${res.doubleBooked.map((d) => `<li><b>${escapeHtml(slotName(d.slot))}</b> has ${d.cands.length} applicants booked at the same time —
        ${d.cands.map((id) => `<b>${escapeHtml(nameOf(id))}</b>`).join(", ")}. A manual panel put them together; move one to another time.
        ${d.cands.map((id) => `<button class="linky" onclick="IV.editPanel('${id}')">edit ${escapeHtml(nameOf(id))}</button>`).join(" ")}</li>`).join("")}
      ${res.lostTime.map((id) => `<li><b>${escapeHtml(nameOf(id))}</b> — their manual panel was at a time that has since been removed or changed; showing the auto-suggestion instead.
        <button class="linky" onclick="IV.clearOverride('${id}')">dismiss</button></li>`).join("")}
      ${res.unschedulable.map((id) => `<li>${unschedulableLine(id, res)}
        <button class="linky" onclick="IV.editPanel('${id}')">schedule manually</button></li>`).join("")}
      ${res.understaffed.map((s) => `<li>${escapeHtml(slotName(s))} — not enough available interviewers for a balanced panel.</li>`).join("")}
    </ul>${res.unschedulable.map((id) => ui.editPanel === id ? `<div class="panelbox">${panelEditor({ cand: id, slot: null, members: [] })}</div>` : "").join("")}</div>`;
  }
  $("#panels").innerHTML = html;
}

// inline editor for one panel: choose slot + toggle members (chair locked on)
function panelEditor(p) {
  const { committee, chair } = EFF();
  const c = cand(p.cand);
  const avail = c ? availForCand(c) : {};
  // their available times (in date order), else every time; always keep the current one
  const live = liveAnswers(avail);
  const slotChoices = EFF().slotIds.filter((id) => !live.length || live.includes(id) || id === String(p.slot));
  const members = new Set(p.members && p.members.length ? p.members : [chair]);
  members.add(chair);
  const slotSel = `<select id="ovslot-${p.cand}" aria-label="Slot">
    ${slotChoices.map((s) => `<option value="${s}" ${String(p.slot) === String(s) ? "selected" : ""}>${escapeHtml(slotName(s))}${avail[s] ? " · " + avail[s] : ""}</option>`).join("")}</select>`;
  const curMod = p.modality || (avail[p.slot] === "zoom" ? "zoom" : "ip");
  const modSel = `<span class="seg" id="ovmod-${p.cand}" role="group" aria-label="Modality">
    ${["ip", "zoom"].map((mv) => `<button type="button" class="${curMod === mv ? "on" : ""}" onclick="IV.setOvMod('${p.cand}','${mv}',this)">${mv === "ip" ? "In person" : "Zoom"}</button>`).join("")}</span>`;
  // pass the committee INDEX (not the name) so names with quotes/apostrophes
  // (e.g. O'Brien) can't break the inline handler.
  const memToggles = committee.map((m, idx) => {
    const on = members.has(m.name), isChair = m.name === chair;
    return `<label class="chip" style="cursor:${isChair ? "default" : "pointer"}"><input type="checkbox" ${on ? "checked" : ""} ${isChair ? "disabled" : ""}
      onchange="IV.toggleMember('${p.cand}',${idx},this.checked)" style="margin-right:.35rem"/>${escapeHtml(m.name)}${isChair ? " (chair)" : ""}</label>`;
  }).join("");
  return `<div style="margin-top:.7rem; border-top:1px solid var(--line-2); padding-top:.7rem">
    <div class="row center" style="gap:.5rem; flex-wrap:wrap"><span class="muted small">Time</span>${slotSel}<span class="muted small">Modality</span>${modSel}</div>
    <div class="muted small" style="margin:.6rem 0 .3rem">Members (chair always included)</div>
    <div>${memToggles}</div>
    <div class="adminbar"><button class="btn tinted small" onclick="IV.savePanel('${p.cand}',this)">Save panel</button>
      ${EFF().overrides[p.cand] ? `<button class="btn ghost small" onclick="IV.clearOverride('${p.cand}')">Reset to auto</button>` : ""}</div></div>`;
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
    const v = (S.scores[key(m.name, c.id)] || {}).overall;
    if (v) obs.push({ m: m.name, c: c.id, v });
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
      raters: mine.map((o) => o.m) };
  }).filter(Boolean);

  const byAdj = [...rows].sort((a, b) => b.adj - a.adj).map((r) => r.id);
  rows.sort((a, b) => b.raw - a.raw || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.shift = i - byAdj.indexOf(r.id); }); // + = adjustment moves them up
  const adjusted = Object.values(offset).some((v) => Math.abs(v) > 0.001);
  return { rows, adjusted };
}

function renderRanking() {
  if (!S.meta.interviewsComplete) {
    $("#ranking").innerHTML = howto("ranking", `The ranking averages everyone's overall scores into a
      shortlist for your final discussion. It stays hidden until interviews are complete so it can't bias anyone mid-process.`)
      + `<div class="card">${empty("🏆", "Ranking is hidden", "Reveal it once all interviews are done.")}
      <div style="text-align:center"><button class="btn filled" onclick="IV.setComplete(true,this)">Mark interviews complete &amp; reveal ranking</button></div></div>`;
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
    return `<tr><td class="rankn">${i + 1}</td><td class="name">${escapeHtml(r.name)}</td>
      <td data-tip="${escapeHtml(`Mean of ${r.n} submitted score${r.n === 1 ? "" : "s"}: ${r.raters.join(", ")}`)}"><b>${r.raw.toFixed(1)}</b></td>
      <td class="adj" data-tip="${escapeHtml(adjInfo)}">${r.adj.toFixed(1)}${shift}</td>
      <td class="${thin ? "thinscore" : ""}" data-tip="${thin ? escapeHtml(`Only ${r.n} of the ${r.expected} panellists have scored this candidate.`) : "Every panellist on record has scored this candidate."}">${r.n}${r.expected ? ` of ${r.expected}` : ""}</td></tr>`;
  }).join("");
  $("#ranking").innerHTML = howto("ranking", `<b>Admin only.</b> Candidates ordered by their average interview score —
      decision support for the committee's discussion, not an automatic decision.
      Averages are taken over the scores that were <b>actually submitted</b>; a missing score is never counted as a zero
      or a middling 3.${adjusted ? ` <b>Adj</b> additionally removes each rater's tendency to score high or low,
      because every candidate faced a different panel.` : ""}`)
    + `<div class="adminbar"><button class="btn tinted small" onclick="IV.exportScores()"><span aria-hidden="true">⬇︎</span> Export scores (CSV)</button>
      <button class="btn ghost small" onclick="IV.setComplete(false,this)">Re-hide ranking</button></div>
    <div class="card flush"><div class="tablewrap"><table><thead><tr><th>#</th><th>Candidate</th><th>Avg</th>
      <th>Adj${infoIcon(adjInfo)}</th><th>Scored by</th></tr></thead>
      <tbody>${body || `<tr><td colspan="5">${empty("⭐️", "No scores yet", "Scores will appear as interviewers submit them.")}</td></tr>`}</tbody></table></div></div>`;
}

// ------------------------------------------------------------ 6 · Setup (admin)
function renderSettings() {
  const { committee, chair, slots, oneDrive } = EFF();
  const committeeBody = `<div class="note">One per line as <b>Name, F</b> or <b>Name, M</b> (self-identified gender, used only to
      build balanced panels — never shown as an M/F label). Saving replaces the whole list.</div>
    <textarea id="commBulk" rows="6" placeholder="Vojdani, M&#10;Marrocco, F">${committee.map((m) => escapeHtml(m.name + ", " + m.gender)).join("\n")}</textarea>
    <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.setCommittee(this)">Save committee</button></div>`;
  const chairBody = `<div class="note">The chair is on every panel.</div>
    <select onchange="IV.setChair(this.value)" aria-label="Panel chair">${committee.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === chair ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</select>`;
  const slotsBody = timesEditor(slots);
  const odBody = `<div class="note">Committee members open CVs from here. Stored privately (not in code).</div>
    <input id="odIn" type="text" placeholder="https://..." value="${escapeHtml(oneDrive === "#" ? "" : oneDrive)}" aria-label="OneDrive link"/>
    <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.saveOneDrive(this)">Save link</button></div>`;

  $("#settings").innerHTML = howto("setup", `Everything here is stored privately in your database, never in
      the app's code — so the tool is <b>fully reusable each hiring round</b>: just update the committee, chair, times, and (on the
      Screen tab) the applicant list. Nothing is hard-coded.`, "Setup (admin)")
    + `${section("setChair", "Panel chair", chair, chairBody, { open: false, info: "The chair is on every interview panel. Pick from your committee list below." })}
    ${section("setCommittee", "Committee (interviewers)", `${committee.length} members`, committeeBody, { open: false, info: "Your interviewers. One per line as ‘Name, F’ or ‘Name, M’. The F/M is self-identified and used only to build balanced panels — it is never shown as a label. Saving replaces the whole list." })}
    ${section("setSlots", "Interview times", `${slots.length} time${slots.length === 1 ? "" : "s"}`, slotsBody, { open: false, info: "The interview times interviewers and applicants choose from. Add a single time or a block of back-to-back times; edit or remove any time. If people already answered for a time you change, you choose whether to keep their answers or ask them again." })}
    ${section("setOneDrive", "Applications folder (OneDrive)", "", odBody, { open: false, info: "Link to the access-controlled OneDrive folder holding the CVs/cover letters. Committee members open applicant files from here. Stored privately, never in the app's code." })}
    <div class="note" style="margin-top:1rem">Add or remove <b>applicants (interviewees)</b> on the <b>Screen</b> tab → “Add candidates”.</div>`;
}

// ---------------------------------------------- Setup → Interview times editor
// Draft form values live in `ui` so a live re-render (someone else saving) never
// wipes what the admin is typing.
const tAdd = () => (ui.tAdd = ui.tAdd || { date: "", from: "", to: "", len: "60" });
const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hhmmOf = (v) => String(v || "").slice(0, 5); // some browsers report "09:00:00"
// answers per time, counting only people who matter (same basis as the dashboard)
const answerCounts = () => responseCounts(EFF().committee.map((m) => S.availIv[m.name]), activeCands().map(availForCand));
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
    const b = booked[t.id] ? `<span class="pill neutral">panel booked</span>` : "";
    return `<div class="trow"><div class="grow"><span class="ttime">${escapeHtml(slotTimeLabel(t))}</span>
        <span class="muted small">${c ? escapeHtml(c) + " answered" : "no answers yet"}</span> ${b}</div>
      <button class="linky" onclick="IV.tEdit('${t.id}')" aria-label="Edit ${escapeHtml(slotLabel(t))}">edit</button>
      <button class="linky danger" onclick="IV.tRemove(['${t.id}'])" aria-label="Remove ${escapeHtml(slotLabel(t))}">remove</button></div>`;
  };
  const list = groupByDate(slots).map((g) => `<div class="tgroup">
      <div class="tgroup-h"><b>${escapeHtml(g.title)}</b> <span class="muted small">· ${pl(g.items.length, "time")}</span>
        <button class="linky danger small" onclick="IV.tRemoveDay('${g.date}')">remove day</button></div>
      ${g.items.map(row).join("")}</div>`).join("")
    || `<div class="muted small" style="padding:.4rem 0">No interview times yet — add some below. Interviewers and applicants will see “times not posted yet” until you do.</div>`;
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
  const keep = {}; ["commBulk", "odIn"].forEach((k) => { const el = document.getElementById(k); if (el && el.value !== el.defaultValue) keep[k] = el.value; });
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
function renderCandidate() {
  const el = $("#candview");
  const slots = effectiveSlots(S.settings, SLOTS);
  if (!ui.candLast) {
    el.innerHTML = `<div class="overlay"><div class="overlay-box"><div class="logo" aria-hidden="true">ED</div>
      <h2>Interview availability</h2><p class="muted">Enter your last name to pick the times that work for you.
        You won't see any other applicants or committee information.</p>
      <form id="candForm"><input id="candName" type="text" placeholder="Your last name" autocomplete="family-name" aria-label="Last name" autofocus/>
      <button class="primary" type="submit" id="candGo">Continue</button></form>
      <div id="candErr" class="err" role="alert"></div></div></div>`;
    $("#candForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#candName").value.trim();
      const err = $("#candErr"), btn = $("#candGo");
      if (v.length < 2) { err.textContent = "Please enter your last name."; return; }
      const k = lastKey(v);
      // Check the name against the roster BEFORE letting them fill anything in.
      // Applicants can't read the roster, so the rules answer this for us: an
      // unknown surname is refused. Without this, a typo or a name we hold
      // differently saved to a document nobody reads — the applicant saw
      // "Saved" and was never scheduled, which is the failure we're closing.
      err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
      let ok;
      try { ok = await store.checkName(k); }
      catch { // offline or misconfigured: don't accuse them of a wrong name
        err.textContent = "Couldn't reach the server. Check your connection and try again.";
        btn.disabled = false; btn.textContent = "Continue"; return;
      }
      btn.disabled = false; btn.textContent = "Continue";
      if (!ok) {
        err.innerHTML = `We can't find <b>${escapeHtml(v)}</b> in our applicant list. ` +
          `Please check the spelling, or try the last name exactly as it appears on your application. ` +
          `If it still doesn't work, reply to the email that sent you this link and we'll sort it out.`;
        return;
      }
      ui.candLast = k;
      ui.candDisplay = v.replace(/\s+/g, " ");
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
  el.innerHTML = `<header class="page"><div class="brandrow"><div class="brandmark" aria-hidden="true">ED</div>
      <div class="grow"><h1>${escapeHtml(ORG_NAME)}</h1><p class="muted">Interview availability</p></div>
      <button class="linky" onclick="CAND.logout()">Log out</button></div></header>
    <main style="max-width:600px">
      <div class="card"><div class="muted small">Signed in as</div><div class="name">${escapeHtml(who)}</div>
        <button class="linky" onclick="CAND.rename()" style="font-size:.82rem">not you? change name</button></div>
      ${slots.length ? `<div class="card"><b>Select the interview times you can attend</b>
        <div class="note tip" style="margin:.5rem 0">For each time you can make, choose <b>in person</b>, <b>Zoom</b>, or <b>either</b>.
          In-person interviews are encouraged where possible. Your choices save automatically — you can come back and update them.</div>
        <div class="slotgrid"><div class="h">Interview time</div><div class="h">I can attend…</div>
          ${slotRows(slots, map, "CAND.set")}</div>
        <div class="muted small" style="margin-top:.9rem">Saved automatically. You'll be contacted with your final interview time.</div></div>`
        : `<div class="card">${empty("🗓️", "Times not posted yet", "The interview times haven't been published yet. Please check back soon.")}</div>`}
    </main>`;
}

// ---------------------------------------------------------- handlers (window)
const noteTimers = {};
function saveNoteKeyed(me, cid, qi, val) {
  const k = cid + ":" + qi;
  clearTimeout(noteTimers[k]);
  markSaving();
  noteTimers[k] = setTimeout(async () => { await store.setScore(me, cid, { notes: { [qi]: val } }); markSaved(); }, 500);
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
async function saved(promise) { markSaving(); try { await promise; markSaved(); } catch (e) { toast("Couldn't save — check your connection", "err"); } }
window.IV = {
  toggleFlag: (id) => { const cur = (S.screening[key(ui.member, id)] || {}).flag; saved(store.setScreening(ui.member, id, { flag: !cur, reason: cur ? "" : (S.screening[key(ui.member, id)] || {}).reason || "" })); },
  saveReason: (id, btn) => withBusy(btn, () => store.setScreening(ui.member, id, { reason: $("#rsn-" + id).value }), "Saved"),
  rate: (id, n) => { const cur = (S.screening[key(ui.member, id)] || {}).rating; saved(store.setScreening(ui.member, id, { rating: cur === n ? 0 : n })); },
  addCands: (btn) => withBusy(btn, async () => {
    const t = $("#bulkAdd"); if (!t) return;
    const existing = new Set(S.candidates.map((c) => c.name.trim().toLowerCase()));
    const names = t.value.split("\n").map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (const nm of names) { if (!existing.has(nm.toLowerCase())) { existing.add(nm.toLowerCase()); await store.addCandidate(nm); n++; } }
    t.value = ""; toast(n ? `Added ${n} candidate${n === 1 ? "" : "s"}` : "No new names", n ? "ok" : "err");
  }),
  removeCand: async (id, v) => {
    const c = cand(id);
    if (v) { const ok = await confirmDialog(`Remove ${c ? c.name : "this candidate"} from the interview list? You can restore them later.`, { title: "Remove candidate", yes: "Remove" }); if (!ok) return; }
    await store.setCandidateRemoved(id, v); toast(v ? "Removed" : "Restored", "ok");
  },
  avail: (id, v) => { const cur = (S.availIv[ui.member] || {})[id]; saved(store.setAvail("iv", ui.member, id, cur === v ? null : v)); },
  pickScore: (id) => { ui.scoreCand = id; renderScore(); wireSections(); window.scrollTo({ top: 0, behavior: "smooth" }); },
  sortColl: (k) => {
    ui.collSort = k;
    ls.set(COLL_SORT_KEY, k);
    renderScreen(); wireSections();
  },
  note: (qi, val) => saveNoteKeyed(ui.member, ui.scoreCand, qi, val),
  score: (n) => { const cur = (S.scores[key(ui.member, ui.scoreCand)] || {}).overall; saved(store.setScore(ui.member, ui.scoreCand, { overall: cur === n ? 0 : n })); },
  setComplete: async (v, btn) => {
    if (v) { const ok = await confirmDialog("Mark all interviews complete and reveal the ranking to admins?", { title: "Reveal ranking", yes: "Reveal", danger: false }); if (!ok) return; }
    return withBusy(btn, () => store.setMeta({ interviewsComplete: v }));
  },
  // panels
  editPanel: (cid) => { ui.editPanel = ui.editPanel === cid ? null : cid; renderPanels(); },
  toggleMember: (cid, idx, on) => {
    const name = (EFF().committee[idx] || {}).name; if (!name) return;
    ui._draft = ui._draft || {};
    const p = computePanels().panels.find((x) => x.cand === cid);
    const base = (ui._draft[cid] && ui._draft[cid].members) || (EFF().overrides[cid] && EFF().overrides[cid].members) || (p && p.members) || [EFF().chair];
    const set = new Set(base); if (on) set.add(name); else set.delete(name); set.add(EFF().chair);
    ui._draft[cid] = { ...(ui._draft[cid] || {}), members: [...set] };
  },
  setOvMod: (cid, mv, btn) => {
    ui._draft = ui._draft || {}; ui._draft[cid] = { ...(ui._draft[cid] || {}), modality: mv };
    const seg = document.getElementById("ovmod-" + cid);
    if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
  },
  savePanel: async (cid, btn) => {
    const slotSel = $("#ovslot-" + cid);
    const p = computePanels().panels.find((x) => x.cand === cid);
    const draft = (ui._draft && ui._draft[cid]) || {};
    const members = draft.members || (EFF().overrides[cid] && EFF().overrides[cid].members) || (p && p.members) || [EFF().chair];
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
    const entry = { slot: String(slot), members, modality };
    try {
      await withBusy(btn, () => store.updateConfig((c) => ({ panelOverrides: { ...(c.panelOverrides || {}), [cid]: entry } })), "Panel saved");
    } catch { return; }
    if (ui._draft) delete ui._draft[cid];
    ui.editPanel = null; renderPanels();
  },
  clearOverride: async (cid) => {
    try {
      await store.updateConfig((c) => { const ov = { ...(c.panelOverrides || {}) }; delete ov[cid]; return { panelOverrides: ov }; });
    } catch { toast("Couldn't save — check your connection", "err"); return; }
    toast("Reset to auto", "ok"); ui.editPanel = null; renderPanels();
  },
  clearOverrides: (btn) => withBusy(btn, async () => {
    const ok = await confirmDialog("Discard all manual panel edits and go back to the auto-suggested panels?", { title: "Reset manual edits", yes: "Reset" });
    if (!ok) return; await store.setSettings({ panelOverrides: {} }); renderPanels();
  }),
  printSchedule: () => window.print(),
  // exports
  exportShortlist: () => {
    // "Rated by / of" travels with the average so the spreadsheet can't be read
    // as though a 5.0 from one person and a 5.0 from twelve were the same thing.
    const rows = [["Candidate", "Status", "Flags", "Flagged by", "Reasons", "Avg priority", "Rated by", "Committee size"]];
    [...S.candidates].sort((a, b) => (isIn(a) === isIn(b) ? 0 : isIn(a) ? -1 : 1) || a.name.localeCompare(b.name))
      .forEach((c) => {
        const st = screenStats(c.id);
        rows.push([c.name, c.removed ? "removed" : st.flags.length >= 2 ? "excluded (flags)" : "interview",
          st.flags.length, st.flags.map((f) => f.who).join("; "),
          st.flags.filter((f) => f.reason).map((f) => `${f.who}: ${f.reason}`).join(" | "),
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
    const { committee } = EFF();
    const adj = {}; rankingRows().rows.forEach((r) => { adj[r.id] = r; });
    const rows = [["Candidate", "Avg", "Rater-adjusted", "Scored by", "Panel size", ...committee.map((m) => m.name)]];
    activeCands().forEach((c) => {
      const per = committee.map((m) => (S.scores[key(m.name, c.id)] || {}).overall || "");
      const r = adj[c.id];
      rows.push([c.name, r ? r.raw.toFixed(2) : "", r ? r.adj.toFixed(2) : "", r ? r.n : 0, (r && r.expected) || "", ...per]);
    });
    downloadFile("scores.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Scores exported", "ok");
  },
  // setup
  setCommittee: (btn) => withBusy(btn, async () => {
    const lines = ($("#commBulk").value || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const list = [];
    for (const l of lines) {
      const parts = l.split(","); const name = parts[0].trim();
      const gender = (parts[1] || "").trim().toUpperCase().startsWith("F") ? "F" : "M";
      if (name) list.push({ name, gender });
    }
    if (!list.length) { toast("Add at least one member", "err"); return; }
    // drop members that no longer exist from any saved panel override
    const names = new Set(list.map((m) => m.name));
    await store.updateConfig((c) => ({ committee: list,
      panelOverrides: pruneOverrides(c.panelOverrides, (mem) => mem.filter((n) => names.has(n))) }));
  }, "Committee saved"),
  setChair: async (v) => {
    // swap the old chair for the new one in every saved override, keep chair present
    try {
      await store.updateConfig((c) => {
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
      });
    } catch { toast("Couldn't save — check your connection", "err"); rerenderSettings(); } // reset the picker
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
      await timesBusy(() => withBusy(btn, () => store.updateTimes(SLOTS, (times, overrides) => {
        added = 0; // re-run safe: a transaction may retry this function
        const out = times.slice();
        fresh.forEach((t) => { if (!checkSlot(t, out).errors.length) { out.push(t); added++; } });
        return { times: out, overrides };
      })));
    } catch { return; } // withBusy already showed the error
    if (!added) { toast("Nothing added — someone else just added those times", "err"); return; }
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
        `• Keep answers — for small corrections; everyone's answers${booked.length ? " and the booked panel" : ""} move to ${now}.\n` +
        `• Ask again — if the time really changed; their answers for this time are cleared${booked.length ? ", the panel is re-planned," : ""} and they'll need to re-answer (they'll show as “waiting on” again).`,
        { title: "Change an answered time", yes: "Ask again", alt: "Keep answers", danger: true });
      if (!choice) return;
      reask = choice === true;
    }
    // timesBusy holds live re-renders until ui.tEdit is cleared below, so our own
    // "Ask again" (which retires this id) isn't mistaken for someone else's removal
    await timesBusy(() => withBusy(btn, () => store.updateTimes(SLOTS, (times, overrides) => {
      const i = times.findIndex((x) => x.id === d.id);
      if (i < 0) throw new Error("That time was just removed by someone else");
      const next = { ...t, id: reask ? newSlotId() : d.id };
      const others = times.filter((x) => x.id !== d.id);
      const chk = checkSlot(next, others);
      if (chk.errors.length) throw new Error(chk.errors[0]);
      const out = others.concat(next);
      if (reask) Object.keys(overrides).forEach((c) => { if (String(overrides[c].slot) === d.id) delete overrides[c]; });
      return { times: out, overrides };
    }), reask ? "Time changed — answers cleared" : "Time updated").then(() => { ui.tEdit = null; ui.setupStale = true; }, () => {}));
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
    if (who) msg += `\n\n${who} already answered for ${cur.length === 1 ? "it" : "these"} — those answers will be discarded.`;
    if (booked.length) msg += `\n\nScheduled then: ${booked.map((b) => b.name + (b.manual ? " (manual panel — will be removed)" : "")).join(", ")}. They'll be re-planned into other times if possible.`;
    const left = EFF().slots.length - cur.length;
    if (!left) msg += "\n\nThis leaves no interview times — people will see “times not posted yet”.";
    if (!(await confirmDialog(msg, { title: cur.length === 1 ? "Remove time" : "Remove day", yes: "Remove" }))) return;
    const gone = new Set(cur.map((t) => t.id));
    try {
      await timesBusy(async () => {
        await store.updateTimes(SLOTS, (times, overrides) => {
          Object.keys(overrides).forEach((c) => { if (gone.has(String(overrides[c].slot))) delete overrides[c]; });
          return { times: times.filter((t) => !gone.has(t.id)), overrides };
        });
        if (ui.tEdit && gone.has(ui.tEdit.id)) ui.tEdit = null; // our own removal — no "someone else" notice
        ui.setupStale = true;
      });
      toast(cur.length === 1 ? "Time removed" : `${cur.length} times removed`, "ok");
    } catch (e) { toast((e && e.message) || "Couldn't remove — check your connection", "err"); }
  },
  tRemoveDay: (date) => IV.tRemove(EFF().slots.filter((t) => (isStructured(t) ? t.date : "") === date).map((t) => t.id)),
  saveOneDrive: (btn) => withBusy(btn, () => store.setSettings({ oneDrive: ($("#odIn").value || "").trim() || "#" }), "Saved"),
};

window.CAND = {
  set: (id, v) => {
    const cur = (S.availCand[ui.candLast] || {})[id];
    store.setAvail("cand", ui.candLast, id, cur === v ? null : v)
      .then(() => toast("Saved", "ok"), (e) => toast(
        // The name passed at the gate, so a refusal here means the roster
        // changed underneath them (removed, or renamed). Saying "check your
        // connection" would send them away thinking they were scheduled.
        e && e.code === "permission-denied"
          ? "We can no longer find your name in the applicant list — please contact us"
          : "Couldn't save — check your connection", "err"));
  },
  rename: () => { ss.del("ed_iv_cand"); ss.del("ed_iv_cand_disp"); ui.candLast = null; ui.candDisplay = null; renderCandidate(); },
  logout: () => { ["ed_iv_cand", "ed_iv_cand_disp", "ed_iv_code"].forEach((k) => ss.del(k)); location.reload(); },
};

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
  if (!val) return;
  $("#gerr").textContent = "";
  await withBusy(btn, () => unlock(val, false)).catch(() => {});
});
$("#memberBtn").onclick = () => {
  const v = $("#memberSel").value;
  if (!v) { toast("Pick your name from the list first", "err"); return; }
  ui.member = v; showApp();
};
$("#changeMember").onclick = backToMemberPick;
$("#setupBtn").onclick = () => (setupOpen() ? closeSetup() : openSetup());
$("#setupClose").onclick = closeSetup;
$("#settings").addEventListener("focusout", flushSetup); // catch up on held live updates
$("#setupModal").onclick = (e) => { if (e.target === $("#setupModal")) closeSetup(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented && setupOpen()) closeSetup(); });
$("#logout").onclick = () => { ["ed_iv_code", "ed_iv_member", "ed_iv_cand"].forEach((k) => ss.del(k)); location.reload(); };
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
    everything you submit is saved — this device just won’t remember your own answers between visits.</div>`;
}

const savedCode = ss.get("ed_iv_code");
if (savedCode) unlock(savedCode, true);
