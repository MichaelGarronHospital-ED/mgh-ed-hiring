// ============================================================================
//  ED tools passwords (passwords.html): the one place to change the three
//  shared passwords (Leadership, ED, Guest) for Physician Hiring, Motion Voting
//  and the Patient Hub statistics page. Leadership only; no hiring screens.
//
//  The order of the change (Check, then the new values, then Change now) and
//  every rule of it live in js/passwords.js. This file is the sign-in, the
//  status card and the dialog. A typed value lives only in the dialog's
//  closure and is wiped when it closes: never storage, Firestore, the console
//  or history.
//
//  The sign-in follows the hiring page's rules: the Leadership account is
//  found by signing in to it, the sign-in lasts this tab only, nothing typed
//  is kept, and 3 wrong tries on a device mean a 30-second wait (the same
//  count as the hiring page).
// ============================================================================
import { firebaseConfig, PARTNERS, AUTH } from "./config.js?v=R7d";
import { ROLES, ROLE_WORD, ACCOUNTS, accountsFor, validateCurrent, validateNew, preflight, applyChange, verify, halfDoneText,
         makeFirebaseAdapter } from "./passwords.js?v=R7d";
import { FirestoreStore } from "./store.js?v=R7d";
import { entry as hEntry, toDate } from "./history.js?v=R7d";
import { escapeHtml, flowDialog, ss, ls, storageWorks } from "./util.js?v=R7d";
import { signInPinned } from "./signin.js?v=R7d";

const $ = (s) => document.querySelector(s);
const isConfigured = () => !!(firebaseConfig && firebaseConfig.apiKey);
const TOOL_OF = { voting: "Motion Voting", hiring: "Physician Hiring" };
const longDay = (at) => { const d = toDate(at); return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; };
let S = null, store = null, _fb = null, loggingOut = false;

// ------------------------------------------------------------------ sign-in
const isRefusal = (e) => /wrong-password|invalid-credential|user-not-found|invalid-login-credentials/.test(String((e && e.code) || ""));
function signInError(e) {
  const c = (e && e.code) || "";
  if (c === "app/sdk-unreachable")
    return "Couldn't load the sign-in service. A hospital network, VPN or content blocker may be blocking www.gstatic.com. Try mobile data.";
  if (c.includes("too-many-requests"))
    return "Too many sign-in attempts. The server has temporarily blocked this device. Wait about 15 minutes, then try ONCE.";
  if (c.includes("network")) return "Network problem. Check your connection and try again.";
  if (c.includes("user-disabled")) return "The Leadership account is switched off. The department account can switch it back on in the Firebase console.";
  if (isRefusal(e)) return "Incorrect password.";
  return "Couldn't sign in. Please try again.";
}
function gateMsg(msg) { const el = $("#gerr"); if (el) el.innerHTML = `<div style="text-align:${msg.length > 40 ? "left" : "center"}">${escapeHtml(msg)}</div>`; }

// 3 wrong passwords on this device, then a 30-second wait (shared with the hiring page)
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
    app, auth, authFns: au, appFns: { initializeApp: a.initializeApp, deleteApp: a.deleteApp },
    db, collection: f.collection, doc: f.doc,
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot, runTransaction: f.runTransaction,
    deleteField: f.deleteField, writeBatch: f.writeBatch, serverTimestamp: f.serverTimestamp,
    getDoc: f.getDoc, getDocs: f.getDocs, deleteDoc: f.deleteDoc, Timestamp: f.Timestamp,
    query: f.query, orderBy: f.orderBy, limit: f.limit, startAfter: f.startAfter,
  };
}
async function firebase() {
  if (_fb) return _fb;
  try { _fb = await loadFirestore(); }
  catch (e) { const err = new Error("could not load the Firebase SDK"); err.code = "app/sdk-unreachable"; err.cause = e; throw err; }
  return _fb;
}

async function unlock(typed) {
  if (!isConfigured()) { gateMsg("Passwords can only be changed on the live site."); return; }
  let fb;
  try { fb = await firebase(); } catch (e) { gateMsg(signInError(e)); return; }
  try {
    const keep = storageWorks("sessionStorage") ? fb.authFns.browserSessionPersistence : fb.authFns.inMemoryPersistence;
    await fb.authFns.setPersistence(fb.auth, keep);
    // only the pinned Leadership account (by uid) opens it
    await signInPinned((email, pw) => fb.authFns.signInWithEmailAndPassword(fb.auth, email, pw),
      { email: AUTH.adminEmail, uid: AUTH.uids.admin }, typed,
      { onWrongUid: async () => { try { await fb.authFns.signOut(fb.auth); } catch { /* local anyway */ } } });
  } catch (e) {
    if (isRefusal(e)) {
      const paused = gateWrong();
      gateMsg("Incorrect password. This page needs the Leadership password." + (paused ? " To protect the accounts, wait 30 seconds before trying again." : ""));
    } else gateMsg(signInError(e));
    return;
  }
  ls.del("ed_iv_gate");
  ss.set("ed_iv_signedin", "1");
  enter();
}

// A reload in the same tab (or coming from Physician Hiring in this tab):
// Firebase kept the tab's sign-in. Only the Leadership account opens the page.
async function resume() {
  if (ss.get("ed_iv_signedout")) { ss.del("ed_iv_signedout"); gateMsg("You were signed out. Please sign in again."); }
  if (!isConfigured()) { gateMsg("Passwords can only be changed on the live site."); return; }
  if (!ss.get("ed_iv_signedin")) return;
  let fb;
  try { fb = await firebase(); await fb.auth.authStateReady(); } catch { return; }
  // who is signed in: by uid, never by email (R7c)
  const u = fb.auth.currentUser;
  if (u && u.uid === AUTH.uids.admin) enter();
  else if (u) gateMsg("This page needs the Leadership password.");
}

function watchSignOut() {
  let had = !!_fb.auth.currentUser;
  _fb.authFns.onAuthStateChanged(_fb.auth, (u) => {
    if (u) { had = true; return; }
    if (!had || loggingOut) return;
    ss.del("ed_iv_signedin"); ss.set("ed_iv_signedout", "1");
    location.reload();
  });
}

function enter() {
  $("#gate").classList.add("hidden");
  $("#appHeader").classList.remove("hidden");
  $("#pwApp").classList.remove("hidden");
  store = new FirestoreStore(_fb, { scopes: ["meta"], echo: false });
  store.subscribe((s) => { S = s; render(); });
  watchSignOut();
}

async function logOut() {
  loggingOut = true;
  ["ed_iv_signedin", "ed_iv_code", "ed_iv_localrole"].forEach((k) => ss.del(k));
  if (_fb) { try { await Promise.race([_fb.authFns.signOut(_fb.auth), new Promise((r) => setTimeout(r, 3000))]); } catch { /* local anyway */ } }
  location.reload();
}

// ------------------------------------------------------------------ the card
let dialogOpen = false;
function render() {
  const el = $("#pwApp"); if (!el) return;
  if (dialogOpen) return;        // the dialog is the page while it is open
  if (!store || !store.metaLoaded) { el.innerHTML = `<div class="card"><p class="muted">Loading...</p></div>`; return; }
  if (!S.questions) {
    el.innerHTML = `<div class="card"><p class="note">This opens once the interview questions are saved in Physician Hiring (Setup, Interview questions).</p></div>`;
    return;
  }
  const pm = S.passwordsMeta || {};
  const rows = ROLES.map((r) => {
    const d = longDay(pm[r] && pm[r].changedAt);
    return `<div class="hrow"><div class="grow small"><b>${ROLE_WORD[r]}</b>: ${d ? `last changed ${escapeHtml(d)}` : "Not changed here yet"}</div></div>`;
  }).join("");
  const pend = pm.pending;
  // while a change is unfinished, the only way in is to finish it
  el.innerHTML = `<div class="card pwcard">
      <h2 class="h3size" style="margin-top:0">Passwords for all ED tools</h2>
      <p class="small muted">The Leadership, ED and Guest passwords open Physician Hiring, Motion Voting and the Patient Hub statistics page.
        Changing one here changes it everywhere it is used.</p>
      ${pend ? `<p class="small bad">A password change didn't finish${longDay(pend.startedAt) ? ` (started ${escapeHtml(longDay(pend.startedAt))})` : ""}.</p>` : ""}
      <div class="hlist">${rows}</div>
      <div class="row backup-actions">${pend
        ? `<button class="btn filled small" onclick="PW.change()">Finish the change</button>`
        : `<button class="btn tinted small" onclick="PW.change()">Change a password</button>`}</div>
    </div>
    <p class="small muted" style="margin-top:12px"><a href="index.html">Physician Hiring</a></p>`;
}

// ------------------------------------------------------------------ the dialog
function pwAdapter() {
  const fb = _fb;
  return makeFirebaseAdapter({ ...fb.authFns, ...fb.appFns },
    { mainAuth: fb.auth, configs: { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig } });
}
const pwTools = (r) => [...new Set(ACCOUNTS.filter((a) => a.role === r).map((a) => TOOL_OF[a.project]))];
const pwWords = (roles) => { const w = roles.map((r) => ROLE_WORD[r]); return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]; };
const pwField = (id, label, auto) => `<label class="ed-label" for="${id}">${escapeHtml(label)}</label>
  <div class="pwfield"><input id="${id}" type="password" autocomplete="${auto}" autocapitalize="off" spellcheck="false"/>
  <button type="button" class="btn ghost small" onclick="PW.show('${id}',this)" aria-label="Show ${escapeHtml(label)}">Show</button></div>`;
const ovId = (a) => "pwOv_" + a.key.replace(":", "_");
// the message line sits FIRST in the step, right under its title: on a phone
// the keyboard covers the lower half of the screen (review)
const msgLine = `<p id="pwErr" class="small pwmsg" role="alert"></p>`;
// a phone or tablet: don't focus the field to fix (that opens the keyboard
// over the message); mark it instead. A desktop keeps the focus.
const touch = () => { try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; } };

async function change() {
  if (!S || !S.questions || !_fb || dialogOpen) return;
  const pend = S.passwordsMeta && S.passwordsMeta.pending;
  // everything typed lives here, and only for as long as the dialog is open
  const v = { roles: pend ? ROLES.filter((r) => (pend.roles || []).includes(r)) : [], cur: {}, next: {}, overrides: {}, checked: null };
  const wipe = () => { v.cur = {}; v.next = {}; v.overrides = {}; v.checked = null; };
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  const setVal = (id, x) => { const el = document.getElementById(id); if (el && x) el.value = x; };
  const ad = pwAdapter();
  const tick = (ok) => (ok ? `<span class="ok">ready</span>` : `<span class="bad">refused</span>`);
  // an error: right above the buttons, in view, and the field to fix focused
  const showErr = (errs, focusId) => {
    const el = document.getElementById("pwErr"); if (!el) return;
    el.className = "small pwmsg bad"; el.setAttribute("role", "alert");
    el.innerHTML = errs.map(escapeHtml).join("<br>");
    document.querySelectorAll('#flowBody input[aria-invalid="true"]').forEach((x) => x.removeAttribute("aria-invalid"));
    const f = focusId && document.getElementById(focusId);
    if (f) f.setAttribute("aria-invalid", "true");
    if (f && !touch()) f.focus({ preventScroll: true });
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // close the keyboard
    el.scrollIntoView({ block: "start" });
  };
  const showBusy = (text) => {
    const el = document.getElementById("pwErr"); if (!el) return;
    el.className = "small pwmsg muted"; el.setAttribute("role", "status");
    el.textContent = text; el.scrollIntoView({ block: "start" });
  };
  dialogOpen = true;

  await flowDialog((ctl) => {
    // ---- step 1: which passwords
    const step1 = () => ctl.step({ title: "Which password?", html: `${msgLine}
      <p class="small">Tick the passwords to change.</p>
      <div class="pwticks">${ROLES.map((r) => `<label class="pwtick"><input type="checkbox" value="${r}" ${v.roles.includes(r) ? "checked" : ""}/> ${ROLE_WORD[r]}</label>`).join("")}</div>`,
      buttons: [{ label: "Cancel", run: () => ctl.close(null) },
        { label: "Next", kind: "filled", run: () => {
          v.roles = ROLES.filter((r) => document.querySelector(`#flowBody .pwtick input[value="${r}"]`).checked);
          if (!v.roles.length) { showErr(["Tick at least one password to change."], null); return; }
          v.checked = null; step2();
        } }] });

    // ---- step 2: the current values, then Check (changes nothing)
    const readCurrent = () => {
      v.cur = Object.fromEntries(ROLES.map((r) => [r, val("pwCur_" + r)]));
      v.overrides = {};
      for (const a of accountsFor(v.roles)) { const x = val(ovId(a)); if (x) v.overrides[a.key] = x; }
    };
    const step2 = () => {
      ctl.step({ title: pend ? "Finish the password change" : "Check the current passwords", html: `${msgLine}
        <p class="small">${pend
          ? "Type the three current passwords again. Check signs in to the accounts not changed yet and changes nothing; the ones already changed are checked with the new password later."
          : "Type the three current passwords. Check signs in to every account with them and changes nothing."}
          All three are needed so the new one can't match a password in use.</p>
        <div class="pwgroup">${ROLES.map((r) => pwField("pwCur_" + r, `Current ${ROLE_WORD[r]} password`, "off")).join("")}</div>
        <details class="pwdrift"${Object.keys(v.overrides).length ? " open" : ""}><summary class="small">The tools already have different passwords</summary>
          <p class="small muted">Only if one account uses a different current value. Leave the rest blank.</p>
          ${accountsFor(v.roles).map((a) => pwField(ovId(a), `Current password for ${a.label}`, "off")).join("")}
        </details>`,
        // finishing an unfinished change: its passwords are fixed, so no Back to the tick boxes
        buttons: [pend ? { label: "Cancel", run: () => ctl.close(null) } : { label: "Back", run: () => { readCurrent(); step1(); } },
          { label: "Check", kind: "filled", id: "pwCheck", run: async (_c, btn) => {
            readCurrent();
            const errs = validateCurrent(v.roles, v.cur);
            if (errs.length) { showErr(errs, "pwCur_" + ROLES.find((r) => !v.cur[r])); return; }
            btn.disabled = true; btn.textContent = "Checking...";
            showBusy("Checking each account. This takes a few seconds; nothing is changed.");
            await check();
          } }] });
      ROLES.forEach((r) => setVal("pwCur_" + r, v.cur[r]));
      accountsFor(v.roles).forEach((a) => setVal(ovId(a), v.overrides[a.key]));
    };

    const check = async () => {
      let r;
      // finishing: the accounts that may already have the new password are not
      // proven with the current one (they are checked with the new one later)
      const skip = pend ? [...(pend.done || []), pend.inProgress, ...(pend.unsure || [])].filter(Boolean) : [];
      try { r = await preflight(ad, v.roles, v.cur, v.overrides, skip); }
      catch { r = { ok: false, results: [{ ok: false, why: "error", label: "", key: "" }] }; }
      const list = r.results.map((x) => `<li>${escapeHtml(x.label)}: ${tick(x.ok)}</li>`).join("");
      if (!r.ok) {
        const bad = r.results[r.results.length - 1];
        const a = ACCOUNTS.find((x) => x.key === bad.key);
        const text = bad.why === "throttled" ? "Firebase has paused sign-ins from this device for about 15 minutes. Nothing was changed. Wait, then try once."
          : bad.why === "disabled" && a ? `${a.label} is switched off in Firebase, so nothing was changed. The department account can switch it back on in the Firebase console (Authentication, Users).`
          : bad.why === "refused" && a ? `${TOOL_OF[a.project]}'s ${ROLE_WORD[a.role]} account didn't accept the current ${ROLE_WORD[a.role]} password, so nothing was changed. Check it was typed right. If that tool already has a different ${ROLE_WORD[a.role]} password, type it under "The tools already have different passwords". If nobody knows it, it can only be reset in the Firebase console by the department account.`
          : "Couldn't reach the sign-in service, so nothing was changed. Check the connection and try again.";
        ctl.step({ title: "Nothing was changed", html: `<ul class="pwlist">${list}</ul><p class="small bad" role="alert">${escapeHtml(text)}</p>`,
          buttons: [{ label: "Cancel", run: () => ctl.close(null) }, { label: "Back", kind: "filled", run: () => step2() }] });
        return;
      }
      v.checked = list;
      step3();
    };

    // ---- step 3: only after a successful Check, the new values and Change now
    const step3 = () => {
      const warn = [];
      if (v.roles.includes("leadership") || v.roles.includes("ed")) warn.push("Everyone signed in with the old password will be asked for the new one within about an hour, including phones signed in to Motion Voting. Don't do this on a voting day.");
      if (v.roles.includes("guest")) warn.push("Applicants who have the old Guest password won't be able to sign in. Send them the new one.");
      if (v.roles.includes("leadership")) warn.push("Patient Hub statistics follow this password automatically.");
      ctl.step({ title: pend ? "Finish the password change" : "Type the new passwords", html: `${msgLine}
        ${pend ? `<p class="small"><b>Use the same new password as the first time.</b> Some accounts already have it.</p>` : ""}
        ${v.checked ? `<p class="small">${pend ? "The accounts not changed yet accepted their current password:" : "Every account accepted its current password:"}</p><ul class="pwlist">${v.checked}</ul>` : ""}
        ${v.roles.map((r) => `<div class="pwgroup">${pwField("pwNew_" + r, `New ${ROLE_WORD[r]} password`, "new-password")}
          ${pwField("pwRep_" + r, `Type the new ${ROLE_WORD[r]} password again`, "new-password")}</div>`).join("")}
        <p class="small muted">At least 10 characters. Three or four words are easy to say and hard to guess. Not a password in use now anywhere, and not containing the word "password". Don't reuse a password from another site.</p>
        ${warn.map((w) => `<p class="small">${escapeHtml(w)}</p>`).join("")}
        <p class="small">Change now changes the accounts one by one; it takes a few seconds. Keep this page open until it says Done.</p>`,
        buttons: [{ label: "Back", run: () => { v.checked = null; step2(); } },
          { label: pend ? "Finish the change" : "Change now", kind: pend ? "filled" : "danger", id: "pwGo", run: async (_c, btn) => {
            v.next = Object.fromEntries(v.roles.map((r) => [r, { value: val("pwNew_" + r), repeat: val("pwRep_" + r) }]));
            const errs = validateNew(v.roles, v.cur, v.next, v.overrides);
            if (errs.length) {
              const r = v.roles.find((x) => errs[0].includes(` ${ROLE_WORD[x]} `)) || v.roles[0];
              showErr(errs, (/don't match/.test(errs[0]) ? "pwRep_" : "pwNew_") + r);
              return;
            }
            btn.disabled = true; btn.textContent = "Changing...";
            await runChange(pend || null);
          } }] });
    };

    // ---- step 4: change, in the fixed order, each account signed in just before
    const runChange = async (progress) => {
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
          // another page may have started a change meanwhile: never overwrite its
          // record with a change of other passwords
          if (d && d.pending && JSON.stringify(d.pending.roles) !== JSON.stringify(v.roles))
            throw Object.assign(new Error("Finish the unfinished change first."), { code: "pending-other" });
          const keep = d && d.pending ? d.pending : null;
          startedAt = keep ? keep.startedAt : store.now();
          return { ...(d || {}), pending: { roles: v.roles, startedAt, done: keep ? keep.done || [] : [], inProgress: keep ? keep.inProgress || null : null } };
        });
      } catch (e) {
        if (e && e.code === "pending-other") {
          ctl.step({ title: "Nothing was changed", html: `<p class="small bad" role="alert">Another page started changing other passwords and hasn't finished. Close this, then use "Finish the change".</p>`,
            buttons: [{ label: "Close", kind: "filled", run: () => ctl.close(null) }] });
          return;
        }
        return failed({ done: [], failedAt: accts[0].key, error: e }, "save");
      }
      const record = async (p) => {
        for (const a of accts) state[a.key] = p.done.includes(a.key) ? "done" : p.inProgress === a.key ? "now" : "waiting";
        paint();
        await store.updatePasswords((d) => ({ ...(d || {}), pending: { roles: v.roles, startedAt: (d && d.pending && d.pending.startedAt) || startedAt, done: p.done, inProgress: p.inProgress } }));
      };
      const r = await applyChange(ad, v.roles, v.cur, v.next, { overrides: v.overrides, progress: progress || {}, record });
      if (r.failedAt) return failed(r);
      ctl.step({ title: "Checking the new passwords", html: `<p class="small">Signing in to each account with its new password.</p>` });
      const bad = await verify(ad, v.roles, v.next);
      if (bad.length) {
        // not confirmed is not the same as wrong: Try again checks those
        // accounts with the new value first
        const keys = bad.map((b) => b.key);
        const why = bad.find((b) => b.why !== "refused") || bad[0];
        const doneNow = r.done.filter((k) => !keys.includes(k));
        try { await store.updatePasswords((d) => ({ ...(d || {}), pending: { ...((d && d.pending) || { roles: v.roles }), done: doneNow, inProgress: null, unsure: keys } })); }
        catch { /* the dialog still has it */ }
        return failed({ done: doneNow, failedAt: keys[0], unsure: keys,
          error: Object.assign(new Error("verify"), { code: why.why === "refused" ? "mismatch" : why.code || why.why }) });
      }
      try {
        const now = store.now();
        await store.updatePasswords((d) => ({ ...(d || {}), ...Object.fromEntries(v.roles.map((x) => [x, { changedAt: now }])), pending: null }),
          hEntry("passwords.change", `Changed the ${pwWords(v.roles)} password${v.roles.length > 1 ? "s" : ""}`, { by: "leadership" }));
      } catch { /* the change itself is done; the dates are only a note */ }
      done();
    };

    const failed = (r, where) => {
      const lines = halfDoneText(v.roles, r.done);
      const code = String((r.error && r.error.code) || "");
      const acct = ACCOUNTS.find((a) => a.key === r.failedAt);
      // finishing with another new password than the first time: Try again
      // would only fail the same way, so say it and go back to the new values
      const firstTry = pend && [...(pend.done || []), pend.inProgress, ...(pend.unsure || [])].includes(r.failedAt);
      if (code === "not-first-value" || (firstTry && code === "refused")) {
        ctl.step({ title: "Not finished", html: `<p class="small bad" role="alert">${escapeHtml(acct ? acct.label : "An account")} already has the new password from the first try,
            and the new password typed now is different${code === "refused" ? " (it took neither the current password nor this one)" : ""}. Nothing more was changed.
            Type the same new password as the first time.</p>`,
          buttons: [{ label: "Close", run: () => ctl.close(null) }, { label: "Back", kind: "filled", run: () => step3() }] });
        return;
      }
      const why = where === "save" ? "Couldn't save the progress note, so nothing was changed. Check the connection and try again."
        : /too-many-requests/.test(code) ? "Firebase has paused sign-ins from this device for about 15 minutes. Wait, then press Try again once."
        : /user-disabled/.test(code) ? `${acct ? acct.label : "An account"} is switched off in Firebase. The department account can switch it back on in the Firebase console (Authentication, Users), then press Try again.`
        : code === "mismatch" ? `${acct ? acct.label : "An account"} didn't take the new password. Press Try again.`
        : code === "refused" ? "An account didn't accept its current password. If nobody knows the current password for this account, it can only be reset in the Firebase console by the department account."
        : /network/.test(code) ? "The connection dropped." : "";
      const body = lines.length
        ? `${lines.join(" ")} Nothing is broken, but the tools now use different passwords. Try again to finish.`
        : r.done.length ? "Try again to finish." : "Nothing was changed yet.";
      ctl.step({ title: "Not finished", html: `<p class="small" role="alert">${escapeHtml(body)}</p>${why ? `<p class="small">${escapeHtml(why)}</p>` : ""}`,
        buttons: [{ label: "Close", run: () => ctl.close(null) },
          { label: "Try again", kind: "filled", run: () => runChange({ done: r.done, inProgress: r.failedAt, unsure: r.unsure || [] }) }] });
    };

    const done = () => {
      const words = pwWords(v.roles), many = v.roles.length > 1;
      const note = `The ${words} password${many ? "s" : ""} for the ED tools changed today. Ask ED leadership for the new one${many ? "s" : ""}.`;
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
  dialogOpen = false;
  render();
}

window.PW = {
  change: () => change(),
  show: (id, btn) => { const el = document.getElementById(id); if (!el) return; const show = el.type === "password"; el.type = show ? "text" : "password"; btn.textContent = show ? "Hide" : "Show"; },
};

// ------------------------------------------------------------------ boot
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#gbtn"), val = $("#gpw").value.trim();
  if (!val || gatePausedFor() || btn.disabled) return;
  $("#gerr").textContent = "";
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Signing in...";
  try { await unlock(val); } finally { btn.disabled = false; btn.textContent = label; }
  if (gatePausedFor()) gateCountdown();
});
$("#logout").onclick = logOut;
window.__edReady = true;
if (gatePausedFor()) gateCountdown();
resume().catch((e) => console.warn("resume failed:", e && e.code));
