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
import { autoPanels } from "./panels.js";
import { escapeHtml, toast, avg, confirmDialog, downloadFile, withBusy, daysUntil, csvCell } from "./util.js";

let QUESTIONS = [], SCALE = [], GUIDE = [];
let store = null, S = null;
const ui = { role: "committee", isAdmin: false, member: null, tab: "screen", scoreCand: null,
             candLast: null, editPanel: null, openSections: {} };
const $ = (s) => document.querySelector(s);
const isConfigured = () => firebaseConfig && Object.keys(firebaseConfig).length > 0 && firebaseConfig.apiKey;
const ADMIN_SCOPES = ["candidates", "screening", "availIv", "availCand", "scores", "meta"];

// normalized last-name key (applicants submit availability under this, never
// reading the roster). "Dr Ben Carter" → "carter".
const lastKey = (name) => String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

// Effective config: admin-set settings (DB) if present, else placeholder defaults.
function EFF() {
  const s = (S && S.settings) || {};
  const committee = s.committee && s.committee.length ? s.committee : COMMITTEE;
  const slots = s.slots && s.slots.length ? s.slots : SLOTS;
  return { committee, chair: s.chair || CHAIR, slots, oneDrive: s.oneDrive || ONEDRIVE,
    overrides: s.panelOverrides || {}, slotIds: slots.map((_, i) => String(i)) };
}
// availability for a candidate: support both committee-keyed (candId, legacy) and
// applicant-keyed (last name) documents.
const availForCand = (c) => (S.availCand[c.id]) || (S.availCand[lastKey(c.name)]) || {};

// ------------------------------------------------------------------ gate
async function unlock(typed, silent) {
  const gerr = $("#gerr");
  if (!(window.crypto && window.crypto.subtle)) {
    if (gerr) gerr.textContent = "Open the secure https link (not a local file).";
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
    catch (e) { if (gerr) gerr.textContent = signInError(e); return; }
    sessionStorage.setItem("ed_iv_code", typed);
    $("#gate").classList.add("hidden");
    proceedToMemberPick();
    return;
  }
  // 2) applicant — a different code; goes straight to their own scheduling
  const localCandOk = typed === CANDIDATE_CODE_LOCAL;
  if (AUTH.mode !== "roles" && !localCandOk) {
    if (!silent && gerr) gerr.textContent = "Incorrect code.";
    return;
  }
  try {
    ui.role = "candidate";
    await initStore("candidate", typed);
  } catch (e) {
    if (!silent && gerr) gerr.textContent = signInError(e);
    return;
  }
  sessionStorage.setItem("ed_iv_code", typed);
  $("#gate").classList.add("hidden");
  proceedCandidate();
}

function signInError(e) {
  const c = (e && e.code) || "";
  if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("user-not-found"))
    return "Incorrect code.";
  if (c.includes("network")) return "Network problem — check your connection and try again.";
  return "Couldn't sign in. Please try again.";
}

async function initStore(role, typed) {
  if (isConfigured()) {
    const fb = await loadFirestore();
    await signInFor(fb, role, typed); // may throw → surfaced at the gate
    const scopes = role === "candidate"
        ? (AUTH.mode === "roles" ? ["public"] : ["meta"])  // roles: only the PII-free public slots doc; anon: config

      : (AUTH.mode === "roles" && role === "committee")
        ? ["candidates", "availIv", "availCand", "meta"]   // reviewers can't read scores/screening
        : ADMIN_SCOPES;                                    // admin or anon
    const echo = AUTH.mode === "roles" && role === "committee";
    store = new FirestoreStore(fb, { scopes, echo });
  } else {
    store = new LocalStore();
  }
  store.subscribe((s) => {
    S = s;
    if (ui.role === "candidate") { if ($("#candview") && !$("#candview").classList.contains("hidden")) renderCandidate(); }
    else if ($("#app") && !$("#app").classList.contains("hidden")) { renderBanner(); render(); }
  });
  S = store.getState();
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
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot,
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
  const committee = EFF().committee;
  ui.member = null;
  const sel = $("#memberSel");
  sel.innerHTML = committee.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  $("#memberpick").classList.remove("hidden");
}

function showApp() {
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
  // onclick guard so tapping the badge inside a <summary> doesn't toggle the section
  return text ? ` <span class="info" tabindex="0" role="img" title="${escapeHtml(text)}" aria-label="Info: ${escapeHtml(text)}" onclick="event.preventDefault();event.stopPropagation();">i</span>` : "";
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
  else { txt = `Screening deadline (${date}) has passed.`; cls += " info"; }
  el.className = cls;
  el.innerHTML = `<div class="inner"><span aria-hidden="true">🗓️</span><span>${txt}</span></div>`;
}

function render() {
  ["screen", "availability", "score", "panels", "ranking", "settings"].forEach((t) =>
    $("#" + t).classList.toggle("hidden", t !== ui.tab));
  ({ screen: renderScreen, availability: renderAvailability, score: renderScore,
     panels: renderPanels, ranking: renderRanking, settings: renderSettings }[ui.tab] || (() => {}))();
  wireSections();
}

// ------------------------------------------------------------ 1 · Screen
function renderScreen() {
  const me = ui.member;
  const { committee, oneDrive } = EFF();
  let html = `<div class="note tip"><b>What to do here:</b> open each applicant's CV &amp; cover letter, then
    <b>flag</b> anyone you feel isn't qualified (add a short reason). You can also give an optional
    <b>1–5 priority</b>. Only you and leadership see your input — nobody else sees your flags or ratings.</div>`;

  if (ui.isAdmin) {
    const submitted = new Set();
    Object.keys(S.screening).forEach((k) => { const v = S.screening[k]; if (v && (v.flag || v.rating)) submitted.add(k.split("~")[0]); });
    const notYet = committee.filter((m) => !submitted.has(m.name)).map((m) => m.name);
    const rows = S.candidates.map((c) => {
      const fc = flagsCount(c.id), out = fc >= 2 || c.removed;
      const reasons = committee.map((m) => S.screening[key(m.name, c.id)]).filter((s) => s && s.flag && s.reason)
        .map((s) => escapeHtml(s.reason)).join("; ") || "—";
      const ratings = committee.map((m) => (S.screening[key(m.name, c.id)] || {}).rating).filter((n) => n);
      const ar = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
      // distinguish admin-removed from flag-excluded, so "restore" isn't a confusing no-op
      const statusPill = c.removed ? '<span class="pill out">removed</span>'
        : fc >= 2 ? '<span class="pill out">excluded · flags</span>'
        : '<span class="pill in">interview</span>';
      const action = c.removed
        ? `<button class="linky" onclick="IV.removeCand('${c.id}',false)">restore</button>`
        : `<button class="linky danger" onclick="IV.removeCand('${c.id}',true)">remove</button>`;
      return `<tr><td class="name">${escapeHtml(c.name)}</td><td>${fc >= 2 ? `<b class="bad">${fc}</b>` : fc}</td>
        <td class="muted small">${reasons}</td><td>${ar}</td>
        <td>${statusPill}</td><td>${action}</td></tr>`;
    }).join("");
    const collation = `<div class="note">A candidate drops off the interview list at <b>≥2 flags</b> (last year's rule).
        Flag reasons are visible to leadership only.</div>
      <div class="tablewrap"><table><thead><tr><th>Candidate</th><th>Flags</th><th>Reasons</th><th>Avg rating</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">' + empty("📝", "No candidates yet", "Add applicants below to start screening.") + "</td></tr>"}</tbody></table></div>
      <div class="adminbar"><button class="btn tinted small" onclick="IV.exportShortlist()"><span aria-hidden="true">⬇︎</span> Export shortlist (CSV)</button></div>`;

    const dash = `<div class="note">Chase anyone who hasn't submitted before the deadline.</div>
      <p><b>${submitted.size}/${committee.length}</b> members have submitted screening.</p>
      ${notYet.length ? `<p class="muted small">Waiting on:</p><div>${notYet.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")}</div>`
        : `<p class="ok small">✓ Everyone has submitted.</p>`}`;

    const adder = `<div class="note">Paste applicant names, one per line, then Add. Stored in your database, never in the app's code.</div>
      <textarea id="bulkAdd" rows="4" placeholder="Dr Jane Doe&#10;Dr John Smith" aria-label="New candidate names"></textarea>
      <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.addCands(this)">Add candidates</button></div>`;

    html += section("collation", "Collation & shortlist", `${activeCands().length} of ${S.candidates.length} still in`, collation,
        { open: false, count: S.candidates.length, info: "Everyone's flags and priority ratings, collated. A candidate drops off the interview list at 2 or more flags. Reasons are visible to leadership only. Export the shortlist as a CSV here." })
      + section("dash", "Coordinator dashboard", `${submitted.size}/${committee.length} submitted`, dash,
        { open: false, info: "Track who has and hasn't submitted their screening, so you can chase people before the deadline." })
      + section("adder", "Add candidates", "", adder,
        { open: false, info: "Paste applicant names to add them to the interview list. Stored securely in your database — never in the app's code. You can add or remove people any time." })
      + `<h3>Your review</h3>`;
  }

  const toReview = S.candidates.filter((c) => !c.removed);
  html += toReview.map((c) => {
    const sc = S.screening[key(me, c.id)] || {};
    const flagged = !!sc.flag;
    return `<div class="card">
      <div class="row center"><div class="grow"><div class="name">${escapeHtml(c.name)}</div>
        <a class="doc" href="${escapeHtml(oneDrive)}" ${oneDrive === "#" ? 'onclick="return false" aria-disabled="true"' : 'target="_blank" rel="noopener"'}><span aria-hidden="true">📄</span> View CV &amp; cover letter</a></div>
        <button class="flagbtn ${flagged ? "on" : ""}" aria-pressed="${flagged}" onclick="IV.toggleFlag('${c.id}')">${flagged ? '<span aria-hidden="true">⚑</span> Flagged' : "Flag concern"}</button></div>
      <div class="row center" style="margin-top:.6rem"><div class="muted small" style="width:110px">Optional priority</div>
        <div class="rate" role="group" aria-label="Priority rating">${[1, 2, 3, 4, 5].map((n) => `<button class="${sc.rating === n ? "on" : ""}" aria-pressed="${sc.rating === n}" onclick="IV.rate('${c.id}',${n})">${n}</button>`).join("")}</div></div>
      ${flagged ? `<textarea id="rsn-${c.id}" placeholder="Reason (optional)" aria-label="Reason">${escapeHtml(sc.reason || "")}</textarea>
        <div style="margin-top:.4rem"><button class="savebtn" onclick="IV.saveReason('${c.id}',this)">Save reason</button></div>` : ""}
    </div>`;
  }).join("") || (ui.isAdmin ? "" : empty("📝", "Nothing to screen yet", "Applicants will appear here once leadership adds them."));
  $("#screen").innerHTML = html;
}

// ------------------------------------------------------ shared slot control
function slotRows(map, handler) {
  const seg = (i, v, l, cur) => `<button class="${cur === v ? "on " + v : ""}" aria-pressed="${cur === v}" onclick="${handler}(${i},'${v}')">${l}</button>`;
  return EFF().slots.map((label, i) => {
    const cur = map[String(i)];
    return `<div>${escapeHtml(label)}</div><div><span class="seg" role="group" aria-label="${escapeHtml(label)}">${seg(i, "ip", "In person", cur)}${seg(i, "zoom", "Zoom", cur)}${seg(i, "either", "Either", cur)}</span></div>`;
  }).join("");
}

// ------------------------------------------------------ 2 · Availability
function renderAvailability() {
  const map = S.availIv[ui.member] || {};
  const slots = EFF().slots;
  let html = `<div class="note tip"><b>What to do here:</b> for each interview time, tap whether you <b>can</b> do it
    in person, by Zoom, or either. Leave a time untouched if you're not available. Tap a highlighted option again to clear it.
    <b>Your choices save automatically</b> (watch the “✓ Saved” note at the top).</div>`;
  html += slots.length
    ? `<div class="card"><div class="slotgrid"><div class="h">Interview time</div><div class="h">I can do…</div>${slotRows(map, "IV.avail")}</div></div>`
    : empty("🗓️", "No interview times yet", ui.isAdmin ? "Add interview times in the Setup tab." : "Leadership hasn't published the interview times yet — check back soon.");

  if (ui.isAdmin) {
    const { committee } = EFF();
    const ivSubmitted = committee.filter((m) => Object.keys(S.availIv[m.name] || {}).length);
    const ivNot = committee.filter((m) => !Object.keys(S.availIv[m.name] || {}).length).map((m) => m.name);
    const candWith = activeCands().filter((c) => Object.keys(availForCand(c)).length);
    const candNot = activeCands().filter((c) => !Object.keys(availForCand(c)).length).map((c) => c.name);
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
  const list = activeCands();
  let head = `<div class="note tip"><b>What to do here:</b> after each interview, jot notes per question, then give
    <b>one overall 1–5 rating</b> using the guide at the bottom. Your score is private to you and leadership.
    <b>Notes and ratings save automatically</b> — you'll see “✓ Saved” appear at the top each time.</div>`;
  if (!list.length) { $("#score").innerHTML = head + empty("⭐️", "No candidates to score", "Candidates on the interview list will appear here."); return; }
  if (!ui.scoreCand || !list.some((c) => c.id === ui.scoreCand)) ui.scoreCand = list[0].id;
  const me = ui.member, cid = ui.scoreCand;
  const rec = S.scores[key(me, cid)] || { notes: {} };
  $("#score").innerHTML = head + `
    <div class="card"><div class="row center"><div class="muted small" style="width:80px">Scoring</div>
      <select onchange="IV.pickScore(this.value)" aria-label="Candidate to score">${list.map((c) => `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></div></div>
    ${QUESTIONS.map((q, i) => `<div class="card"><div class="small muted">Question ${i}</div><div>${escapeHtml(q)}</div>
      <textarea oninput="IV.note(${i},this.value)" placeholder="Notes" aria-label="Notes for question ${i}">${escapeHtml((rec.notes || {})[i] || "")}</textarea></div>`).join("")}
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
  // availability sanity for the chosen slot/modality
  if (slot != null) present.forEach((m) => {
    const av = (S.availIv[m] || {})[String(slot)];
    if (av !== undefined && modality && !(av === "either" || av === modality)) warns.push(`${m} can't do ${modality} that time`);
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
  Object.entries(overrides).forEach(([cid, ov]) => {
    if (!activeCands().some((c) => c.id === cid)) return;
    if (!ov || !ov.members || !ov.members.length) return;
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
  return { panels, unschedulable: unsched, understaffed: res.understaffed, interviewers };
}

function renderPanels() {
  const { committee, chair, slots, overrides } = EFF();
  const nameOf = (id) => (cand(id) || {}).name || id;
  const modPill = (m) => `<span class="pill ${m === "ip" ? "ip" : "zoom"}">${m === "ip" ? "In-person" : "Zoom"}</span>`;
  const res = computePanels();

  let html = `<div class="note tip"><b>What to do here:</b> the tool builds a suggested, balanced interview panel for each
    applicant from everyone's availability. Review them, tap <b>Edit</b> to adjust any panel by hand, and fix anything under
    "Needs attention". Panels are one candidate per time slot.</div>`;
  if (!EFF().slots.length) { $("#panels").innerHTML = html + empty("🗓️", "No interview times yet", "Add interview times in Setup, then collect availability."); return; }

  html += `<div class="adminbar">
    <button class="btn tinted small" onclick="IV.exportSchedule()"><span aria-hidden="true">⬇︎</span> Export schedule (CSV)</button>
    <button class="btn ghost small" onclick="IV.printSchedule()"><span aria-hidden="true">🖨</span> Print</button>
    ${Object.keys(overrides).length ? `<button class="btn ghost small" onclick="IV.clearOverrides(this)"><span aria-hidden="true">↺</span> Reset manual edits</button>` : ""}
  </div>`;

  html += res.panels.map((p) => {
    const editing = ui.editPanel === p.cand;
    const v = p.valid || validatePanel(p.members, p.slot, p.modality);
    let card = `<div class="panelbox"><div class="row center"><div class="grow"><b>${escapeHtml(nameOf(p.cand))}</b> · ${escapeHtml(slots[+p.slot] || "?")} ${modPill(p.modality)} ${p.manual ? '<span class="pill neutral">manual</span>' : ""}</div>
      <button class="btn ghost small" onclick="IV.editPanel('${p.cand}')">${editing ? "Close" : "Edit"}</button></div>
      <div class="small" style="margin-top:.4rem">${p.members.map(escapeHtml).join(" · ")}</div>
      <div class="badges"><span class="badge ${v.sizeOk ? "ok" : "bad"}">${v.sizeOk ? "✓" : "✗"} ${v.size} member${v.size === 1 ? "" : "s"}</span>
        <span class="badge ${v.balanced ? "ok" : "bad"}">${v.balanced ? "✓ balanced panel" : "✗ not balanced"}</span>
        ${v.warns.filter((w) => w !== "not a balanced panel" && !w.startsWith("fewer") && !w.startsWith("more")).map((w) => `<span class="badge bad">⚠ ${escapeHtml(w)}</span>`).join("")}</div>`;
    if (editing) card += panelEditor(p);
    return card + `</div>`;
  }).join("") || `<div class="card">${empty("🧩", "No panels yet", "Panels appear once interviewers and applicants submit availability.")}</div>`;

  if (res.unschedulable.length || res.understaffed.length) {
    html += `<div class="card"><b><span aria-hidden="true">⚠</span> Needs attention</b><ul class="small">
      ${res.unschedulable.map((id) => `<li><b>${escapeHtml(nameOf(id))}</b> — no available time yields a balanced panel.
        <button class="linky" onclick="IV.editPanel('${id}')">schedule manually</button></li>`).join("")}
      ${res.understaffed.map((s) => `<li>${escapeHtml(slots[+s])} — not enough available interviewers for a balanced panel.</li>`).join("")}
    </ul>${res.unschedulable.map((id) => ui.editPanel === id ? `<div class="panelbox">${panelEditor({ cand: id, slot: null, members: [] })}</div>` : "").join("")}</div>`;
  }
  $("#panels").innerHTML = html;
}

// inline editor for one panel: choose slot + toggle members (chair locked on)
function panelEditor(p) {
  const { committee, chair } = EFF();
  const c = cand(p.cand);
  const avail = c ? availForCand(c) : {};
  const slotChoices = Object.keys(avail).length ? Object.keys(avail) : EFF().slotIds;
  const members = new Set(p.members && p.members.length ? p.members : [chair]);
  members.add(chair);
  const slotSel = `<select id="ovslot-${p.cand}" aria-label="Slot">
    ${slotChoices.map((s) => `<option value="${s}" ${String(p.slot) === String(s) ? "selected" : ""}>${escapeHtml(EFF().slots[+s] || s)}${avail[s] ? " · " + avail[s] : ""}</option>`).join("")}</select>`;
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
function renderRanking() {
  if (!S.meta.interviewsComplete) {
    $("#ranking").innerHTML = `<div class="note tip"><b>What to do here:</b> the ranking averages everyone's overall scores into a
      shortlist for your final discussion. It stays hidden until interviews are complete so it can't bias anyone mid-process.</div>
      <div class="card">${empty("🏆", "Ranking is hidden", "Reveal it once all interviews are done.")}
      <div style="text-align:center"><button class="btn filled" onclick="IV.setComplete(true,this)">Mark interviews complete &amp; reveal ranking</button></div></div>`;
    return;
  }
  const committee = EFF().committee;
  const ranked = activeCands().map((c) => {
    const scores = committee.map((m) => (S.scores[key(m.name, c.id)] || {}).overall).filter((n) => n);
    return { name: c.name, avg: avg(scores), n: scores.length };
  }).filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  $("#ranking").innerHTML = `<div class="note tip"><b>Admin only.</b> Candidates ordered by average interview score — decision support
    for the committee's discussion, not an automatic decision.</div>
    <div class="adminbar"><button class="btn tinted small" onclick="IV.exportScores()"><span aria-hidden="true">⬇︎</span> Export scores (CSV)</button>
      <button class="btn ghost small" onclick="IV.setComplete(false,this)">Re-hide ranking</button></div>
    <div class="card flush"><div class="tablewrap"><table><thead><tr><th>#</th><th>Candidate</th><th>Avg score</th><th># scored</th></tr></thead>
      <tbody>${ranked.map((r, i) => `<tr><td class="rankn">${i + 1}</td><td class="name">${escapeHtml(r.name)}</td><td><b>${r.avg.toFixed(1)}</b></td><td>${r.n}</td></tr>`).join("")
        || `<tr><td colspan="4">${empty("⭐️", "No scores yet", "Scores will appear as interviewers submit them.")}</td></tr>`}</tbody></table></div></div>`;
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
  const slotsBody = `<div class="note">Add each interview time. These are also what applicants pick from.</div>
    <div class="tablewrap"><table><tbody>${slots.map((s, i) => `<tr><td>${escapeHtml(s)}</td><td style="text-align:right"><button class="linky danger" onclick="IV.removeSlot(${i})">remove</button></td></tr>`).join("") || '<tr><td class="muted small">No times yet.</td></tr>'}</tbody></table></div>
    <div class="row center" style="margin-top:.6rem"><input id="slotIn" type="text" placeholder="e.g. Oct 1 · 10:45" style="flex:1" aria-label="New interview time" onkeydown="if(event.key==='Enter')IV.addSlot(this)"/>
      <button class="btn tinted small" onclick="IV.addSlot(this)">Add time</button></div>`;
  const odBody = `<div class="note">Committee members open CVs from here. Stored privately (not in code).</div>
    <input id="odIn" type="text" placeholder="https://..." value="${escapeHtml(oneDrive === "#" ? "" : oneDrive)}" aria-label="OneDrive link"/>
    <div style="margin-top:.5rem"><button class="btn tinted small" onclick="IV.saveOneDrive(this)">Save link</button></div>`;

  $("#settings").innerHTML = `<div class="note tip"><b>Setup (admin).</b> Everything here is stored privately in your database, never in
      the app's code — so the tool is <b>fully reusable each hiring round</b>: just update the committee, chair, times, and (on the
      Screen tab) the applicant list. Nothing is hard-coded.</div>
    ${section("setChair", "Panel chair", chair, chairBody, { info: "The chair is on every interview panel. Pick from your committee list below." })}
    ${section("setCommittee", "Committee (interviewers)", `${committee.length} members`, committeeBody, { open: true, info: "Your interviewers. One per line as ‘Name, F’ or ‘Name, M’. The F/M is self-identified and used only to build balanced panels — it is never shown as a label. Saving replaces the whole list." })}
    ${section("setSlots", "Interview times", `${slots.length} time${slots.length === 1 ? "" : "s"}`, slotsBody, { open: true, info: "The interview time slots. Interviewers and applicants both choose from these. Add or remove them any time." })}
    ${section("setOneDrive", "Applications folder (OneDrive)", "", odBody, { info: "Link to the access-controlled OneDrive folder holding the CVs/cover letters. Committee members open applicant files from here. Stored privately, never in the app's code." })}
    <div class="note" style="margin-top:1rem">Add or remove <b>applicants (interviewees)</b> on the <b>Screen</b> tab → “Add candidates”.</div>`;
}

// ------------------------------------------------------------ candidate view
function proceedCandidate() {
  const saved = sessionStorage.getItem("ed_iv_cand");
  if (saved) ui.candLast = saved;
  $("#candview").classList.remove("hidden");
  renderCandidate();
}
function renderCandidate() {
  const el = $("#candview");
  const slots = (S.settings.slots && S.settings.slots.length) ? S.settings.slots : SLOTS;
  if (!ui.candLast) {
    el.innerHTML = `<div class="overlay"><div class="overlay-box"><div class="logo" aria-hidden="true">ED</div>
      <h2>Interview availability</h2><p class="muted">Enter your last name to pick the times that work for you.
        You won't see any other applicants or committee information.</p>
      <form id="candForm"><input id="candName" type="text" placeholder="Your last name" autocomplete="family-name" aria-label="Last name" autofocus/>
      <button class="primary" type="submit">Continue</button></form>
      <div id="candErr" class="err" role="alert"></div></div></div>`;
    $("#candForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("#candName").value.trim();
      if (v.length < 2) { $("#candErr").textContent = "Please enter your last name."; return; }
      ui.candLast = lastKey(v);
      ui.candDisplay = v.replace(/\s+/g, " ");
      sessionStorage.setItem("ed_iv_cand", ui.candLast);
      sessionStorage.setItem("ed_iv_cand_disp", ui.candDisplay);
      renderCandidate();
    };
    return;
  }
  const who = ui.candDisplay || sessionStorage.getItem("ed_iv_cand_disp")
    || (ui.candLast ? ui.candLast.charAt(0).toUpperCase() + ui.candLast.slice(1) : "");
  // read by the SAME normalized key we write under (ui.candLast), not the display name
  const map = S.availCand[ui.candLast] || {};
  const seg = (i, v, l) => `<button class="${map[String(i)] === v ? "on " + v : ""}" aria-pressed="${map[String(i)] === v}" onclick="CAND.set(${i},'${v}')">${l}</button>`;
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
          ${slots.map((label, i) => `<div>${escapeHtml(label)}</div><div><span class="seg" role="group" aria-label="${escapeHtml(label)}">${seg(i, "ip", "In person")}${seg(i, "zoom", "Zoom")}${seg(i, "either", "Either")}</span></div>`).join("")}</div>
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
  avail: (i, v) => { const cur = (S.availIv[ui.member] || {})[String(i)]; saved(store.setAvail("iv", ui.member, String(i), cur === v ? null : v)); },
  pickScore: (id) => { ui.scoreCand = id; renderScore(); wireSections(); },
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
    const ov = { ...EFF().overrides, [cid]: { slot: String(slot), members, modality } };
    await withBusy(btn, () => store.setSettings({ panelOverrides: ov }), "Panel saved");
    if (ui._draft) delete ui._draft[cid];
    ui.editPanel = null; renderPanels();
  },
  clearOverride: async (cid) => { const ov = { ...EFF().overrides }; delete ov[cid]; await store.setSettings({ panelOverrides: ov }); toast("Reset to auto", "ok"); ui.editPanel = null; renderPanels(); },
  clearOverrides: (btn) => withBusy(btn, async () => {
    const ok = await confirmDialog("Discard all manual panel edits and go back to the auto-suggested panels?", { title: "Reset manual edits", yes: "Reset" });
    if (!ok) return; await store.setSettings({ panelOverrides: {} }); renderPanels();
  }),
  printSchedule: () => window.print(),
  // exports
  exportShortlist: () => {
    const { committee } = EFF();
    const rows = [["Candidate", "Flags", "Avg rating", "Status"]];
    S.candidates.forEach((c) => {
      const fc = flagsCount(c.id);
      const ratings = committee.map((m) => (S.screening[key(m.name, c.id)] || {}).rating).filter((n) => n);
      const ar = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "";
      rows.push([c.name, fc, ar, (fc >= 2 || c.removed) ? "removed" : "interview"]);
    });
    downloadFile("shortlist.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Shortlist exported", "ok");
  },
  exportSchedule: () => {
    const { slots } = EFF();
    const res = computePanels();
    const rows = [["Candidate", "Time", "Modality", "Panel"]];
    res.panels.forEach((p) => rows.push([(cand(p.cand) || {}).name || p.cand, slots[+p.slot] || "", p.modality, p.members.join(" / ")]));
    res.unschedulable.forEach((id) => rows.push([(cand(id) || {}).name || id, "UNSCHEDULED", "", ""]));
    downloadFile("schedule.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")); toast("Schedule exported", "ok");
  },
  exportScores: () => {
    const { committee } = EFF();
    const rows = [["Candidate", "Avg", "# scored", ...committee.map((m) => m.name)]];
    activeCands().forEach((c) => {
      const per = committee.map((m) => (S.scores[key(m.name, c.id)] || {}).overall || "");
      const nums = per.filter((n) => typeof n === "number");
      rows.push([c.name, nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : "", nums.length, ...per]);
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
    const ov = pruneOverrides(EFF().overrides, (mem) => mem.filter((n) => names.has(n)));
    await store.setSettings({ committee: list, panelOverrides: ov });
  }, "Committee saved"),
  setChair: async (v) => {
    // swap the old chair for the new one in every saved override, keep chair present
    const old = EFF().chair;
    const ov = pruneOverrides(EFF().overrides, (mem) => {
      const set = new Set(mem.filter((n) => n !== old)); set.add(v); return [...set];
    });
    await store.setSettings({ chair: v, panelOverrides: ov });
  },
  addSlot: (btn) => withBusy(btn, async () => { const v = ($("#slotIn").value || "").trim(); if (!v) return; const l = EFF().slots.slice(); l.push(v); await store.setSettings({ slots: l }); }, "Time added"),
  removeSlot: async (i) => { const ok = await confirmDialog("Remove this interview time?", { title: "Remove time", yes: "Remove" }); if (!ok) return; const l = EFF().slots.slice(); l.splice(i, 1); await store.setSettings({ slots: l }); toast("Removed", "ok"); },
  saveOneDrive: (btn) => withBusy(btn, () => store.setSettings({ oneDrive: ($("#odIn").value || "").trim() || "#" }), "Saved"),
};

window.CAND = {
  set: (i, v) => { const cur = (S.availCand[ui.candLast] || {})[String(i)]; store.setAvail("cand", ui.candLast, String(i), cur === v ? null : v); toast("Saved", "ok"); },
  rename: () => { sessionStorage.removeItem("ed_iv_cand"); sessionStorage.removeItem("ed_iv_cand_disp"); ui.candLast = null; ui.candDisplay = null; renderCandidate(); },
  logout: () => { ["ed_iv_cand", "ed_iv_cand_disp", "ed_iv_code"].forEach((k) => sessionStorage.removeItem(k)); location.reload(); },
};

// ------------------------------------------------------------------- boot
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#gbtn"), val = $("#gpw").value.trim();
  if (!val) return;
  $("#gerr").textContent = "";
  await withBusy(btn, () => unlock(val, false)).catch(() => {});
});
$("#memberBtn").onclick = () => { ui.member = $("#memberSel").value; showApp(); };
$("#changeMember").onclick = () => { ui.member = null; ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.add("hidden")); $("#banner").classList.add("hidden"); proceedToMemberPick(); };
$("#setupBtn").onclick = () => {
  ui.tab = "settings";
  $("#tabs").querySelectorAll("button").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-selected", "false"); x.tabIndex = -1; });
  $("#setupBtn").classList.add("active");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
};
$("#logout").onclick = () => { ["ed_iv_code", "ed_iv_member", "ed_iv_cand"].forEach((k) => sessionStorage.removeItem(k)); location.reload(); };
const savedCode = sessionStorage.getItem("ed_iv_code");
if (savedCode) unlock(savedCode, true);
