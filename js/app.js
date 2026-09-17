// ============================================================================
//  Committee app controller. Tabs: Screen · Availability · Score (all members),
//  plus Panels · Ranking (admin only). Wired to the store (local or Firestore).
// ============================================================================
import { firebaseConfig, ORG_NAME, CHAIR, COMMITTEE, SLOTS, ONEDRIVE } from "./config.js";
import { decryptContent } from "./data.js";
import { LocalStore, FirestoreStore, key } from "./store.js";
import { autoPanels } from "./panels.js";
import { escapeHtml, toast, avg } from "./util.js";

let QUESTIONS = [], SCALE = [], GUIDE = [];
let store = null, S = null;
const ui = { isAdmin: false, member: null, tab: "screen", scoreCand: null };
const $ = (s) => document.querySelector(s);
const slotIds = SLOTS.map((_, i) => String(i));
const isConfigured = () => firebaseConfig && Object.keys(firebaseConfig).length > 0 && firebaseConfig.apiKey;

// ------------------------------------------------------------------ gate
async function unlock(typed, silent) {
  const codeKey = typed.endsWith("!") ? typed.slice(0, -1) : typed;
  try {
    const d = await decryptContent(codeKey);
    QUESTIONS = d.q; SCALE = d.s; GUIDE = d.g || [];
    ui.isAdmin = typed.endsWith("!");
    sessionStorage.setItem("ed_iv_code", typed);
    await initStore();
    $("#gate").classList.add("hidden");
    proceedToMemberPick();
  } catch (e) {
    if (!(window.crypto && window.crypto.subtle)) {
      $("#gerr").textContent = "Open the secure https link (not a local file).";
    } else if (!silent) {
      $("#gerr").textContent = "Incorrect code.";
    }
  }
}

async function initStore() {
  if (isConfigured()) {
    const fb = await loadFirestore();
    store = new FirestoreStore(fb);
  } else {
    store = new LocalStore();
  }
  store.subscribe((s) => { S = s; if (!$("#app").classList.contains("hidden")) render(); });
  S = store.getState();
}

async function loadFirestore() {
  const [a, f, au] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
  ]);
  const app = a.initializeApp(firebaseConfig);
  try { await au.signInAnonymously(au.getAuth(app)); } catch { /* open rules */ }
  return {
    db: f.getFirestore(app), collection: f.collection, doc: f.doc,
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot,
  };
}

// ------------------------------------------------------------ member pick
function proceedToMemberPick() {
  const saved = sessionStorage.getItem("ed_iv_member");
  if (saved && COMMITTEE.some((c) => c.name === saved)) { ui.member = saved; showApp(); return; }
  const sel = $("#memberSel");
  sel.innerHTML = COMMITTEE.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  $("#memberpick").classList.remove("hidden");
}

function showApp() {
  $("#memberpick").classList.add("hidden");
  $("#orgName").textContent = ORG_NAME;
  $("#whoLine").textContent = ui.member;
  $("#adminTag").classList.toggle("hidden", !ui.isAdmin);
  ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.remove("hidden"));
  buildTabs();
  render();
}

function buildTabs() {
  const tabs = [["screen", "1 · Screen"], ["availability", "2 · Availability"], ["score", "3 · Score"]];
  if (ui.isAdmin) tabs.push(["panels", "4 · Panels"], ["ranking", "5 · Ranking"]);
  $("#tabs").innerHTML = tabs.map(([t, label]) =>
    `<button data-tab="${t}" class="${t === ui.tab ? "on" : ""}">${label}</button>`).join("");
  $("#tabs").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      ui.tab = b.dataset.tab;
      $("#tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      render();
    };
  });
}

// --------------------------------------------------------------- helpers
const cand = (id) => S.candidates.find((c) => c.id === id);
const flagsCount = (id) => COMMITTEE.filter((c) => (S.screening[key(c.name, id)] || {}).flag).length;
const isIn = (c) => !c.removed && flagsCount(c.id) < 2;
const activeCands = () => S.candidates.filter(isIn);

function render() {
  ["screen", "availability", "score", "panels", "ranking"].forEach((t) =>
    $("#" + t).classList.toggle("hidden", t !== ui.tab));
  ({ screen: renderScreen, availability: renderAvailability, score: renderScore,
     panels: renderPanels, ranking: renderRanking }[ui.tab] || (() => {}))();
}

// ------------------------------------------------------------ 1 · Screen
function renderScreen() {
  const me = ui.member;
  let html = `<div class="note">Review each applicant's CV &amp; cover letter, then <b>flag</b> anyone you
    feel is unqualified (optional reason) and optionally give a <b>1–5 priority rating</b>. Only you and
    leadership see your input.</div>`;

  if (ui.isAdmin) {
    const submitted = new Set();
    Object.keys(S.screening).forEach((k) => { const v = S.screening[k]; if (v.flag || v.rating) submitted.add(k.split("~")[0]); });
    const rows = S.candidates.map((c) => {
      const fc = flagsCount(c.id), out = fc >= 2 || c.removed;
      const reasons = COMMITTEE.map((m) => S.screening[key(m.name, c.id)]).filter((s) => s && s.flag && s.reason)
        .map((s) => escapeHtml(s.reason)).join("; ") || "—";
      const ratings = COMMITTEE.map((m) => (S.screening[key(m.name, c.id)] || {}).rating).filter((n) => n);
      const ar = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
      return `<tr><td>${escapeHtml(c.name)}</td><td>${fc >= 2 ? `<b class="bad">${fc}</b>` : fc}</td>
        <td class="muted small">${reasons}</td><td>${ar}</td>
        <td>${out ? '<span class="pill out">removed</span>' : '<span class="pill in">interview</span>'}</td>
        <td><button class="linky" onclick="IV.removeCand('${c.id}',${!c.removed})">${c.removed ? "restore" : "remove"}</button></td></tr>`;
    }).join("");
    html += `<div class="note"><b>Admin · collation.</b> A candidate drops off at <b>≥2 flags</b>. Reasons are admin-only.</div>
      <div class="adminbar"><span class="muted">${submitted.size}/${COMMITTEE.length} members have submitted</span>
        <button class="flagbtn" onclick="IV.addCand()">+ Add candidate</button></div>
      <table><thead><tr><th>Candidate</th><th>Flags</th><th>Reasons</th><th>Avg rating</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table><h3 class="muted">Your review</h3>`;
  }

  html += S.candidates.filter((c) => !c.removed).map((c) => {
    const sc = S.screening[key(me, c.id)] || {};
    const flagged = !!sc.flag;
    return `<div class="card">
      <div class="row"><div class="grow"><div class="name">${escapeHtml(c.name)}</div>
        <a class="doc" href="${escapeHtml(ONEDRIVE)}" ${ONEDRIVE === "#" ? 'onclick="return false"' : 'target="_blank" rel="noopener"'}>📄 View CV &amp; cover letter</a></div>
        <button class="flagbtn ${flagged ? "on" : ""}" onclick="IV.toggleFlag('${c.id}')">${flagged ? "⚑ Flagged" : "Flag concern"}</button></div>
      <div class="row" style="margin-top:.5rem"><div class="muted small" style="width:110px">Optional priority</div>
        <div class="rate">${[1, 2, 3, 4, 5].map((n) => `<button class="${sc.rating === n ? "on" : ""}" onclick="IV.rate('${c.id}',${n})">${n}</button>`).join("")}</div></div>
      ${flagged ? `<textarea id="rsn-${c.id}" placeholder="Reason (optional)">${escapeHtml(sc.reason || "")}</textarea>
        <div style="margin-top:.4rem"><button class="savebtn" onclick="IV.saveReason('${c.id}')">Save reason</button></div>` : ""}
    </div>`;
  }).join("");
  $("#screen").innerHTML = html;
}

// ------------------------------------------------------ shared slot control
function slotRows(map, handler) {
  return SLOTS.map((label, i) => {
    const cur = map[String(i)];
    const seg = (v, l) => `<button class="${cur === v ? "on" : ""}" onclick="${handler}(${i},'${v}')">${l}</button>`;
    return `<div>${escapeHtml(label)}</div><div><span class="seg">${seg("ip", "In person")}${seg("zoom", "Zoom")}${seg("either", "Either")}</span></div>`;
  }).join("");
}

// ------------------------------------------------------ 2 · Availability
function renderAvailability() {
  const map = S.availIv[ui.member] || {};
  $("#availability").innerHTML = `
    <div class="note">For each interview time, choose whether you <b>can</b> do it in person, by Zoom, or
      either. Leave a slot untouched if you're not available.</div>
    <div class="card"><div class="slotgrid"><div class="h">Slot</div><div class="h">I can do…</div>
      ${slotRows(map, "IV.avail")}</div></div>
    <div class="note small">Tip: tap a highlighted option again to clear it.</div>`;
}

// ------------------------------------------------------------- 3 · Score
function renderScore() {
  const list = activeCands();
  if (!list.length) { $("#score").innerHTML = `<div class="note">No candidates to score yet.</div>`; return; }
  if (!ui.scoreCand || !list.some((c) => c.id === ui.scoreCand)) ui.scoreCand = list[0].id;
  const me = ui.member, cid = ui.scoreCand;
  const rec = S.scores[key(me, cid)] || { notes: {} };
  $("#score").innerHTML = `
    <div class="note">Notes per question, then <b>one overall 1–5 rating</b> using the guide below.
      Your score is private to you and leadership.</div>
    <div class="card"><div class="row" style="align-items:center"><div class="muted small" style="width:90px">Scoring</div>
      <select onchange="IV.pickScore(this.value)">${list.map((c) => `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></div></div>
    ${QUESTIONS.map((q, i) => `<div class="card"><div class="small muted">Q${i}</div><div>${escapeHtml(q)}</div>
      <textarea oninput="IV.note(${i},this.value)" placeholder="Notes">${escapeHtml((rec.notes || {})[i] || "")}</textarea></div>`).join("")}
    <div class="card"><b>Overall rating</b>
      <div class="rate" style="margin:.5rem 0">${[1, 2, 3, 4, 5].map((n) => `<button class="${rec.overall === n ? "on" : ""}" onclick="IV.score(${n})">${n}</button>`).join("")}</div>
      <div class="legend">${SCALE.map((s, i) => `<div style="margin:.3rem 0"><b>${i + 1}</b> — ${escapeHtml(s)}</div>`).join("")}</div></div>
    <div class="card"><b>Guidance for panelists</b>
      <ul class="small">${GUIDE.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul></div>`;
}

// ------------------------------------------------------ 4 · Panels (admin)
function renderPanels() {
  const interviewers = {};
  COMMITTEE.forEach((c) => { interviewers[c.name] = { g: c.gender, avail: S.availIv[c.name] || {} }; });
  const candidates = {};
  activeCands().forEach((c) => { candidates[c.id] = { avail: S.availCand[c.id] || {} }; });
  const res = autoPanels(candidates, interviewers, slotIds, CHAIR);
  const nameOf = (id) => (cand(id) || {}).name || id;
  const modPill = (m) => `<span class="pill ${m === "ip" ? "ip" : "zoom"}">${m === "ip" ? "In-person" : "Zoom"}</span>`;

  let html = `<div class="note"><b>Auto-suggested panels.</b> Built automatically from everyone's availability into
    balanced panels of the right size. Slots needing a manual fix are flagged.</div>`;
  html += res.panels.map((p) => {
    const size = p.members.length, ok = size >= 3 && size <= 5;
    return `<div class="panelbox"><div class="row"><div class="grow"><b>${escapeHtml(nameOf(p.cand))}</b> · ${escapeHtml(SLOTS[+p.slot])} ${modPill(p.modality)}</div></div>
      <div class="small" style="margin-top:.3rem">${p.members.map(escapeHtml).join(" · ")}</div>
      <div class="badges"><span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${size} members</span>
        <span class="badge ok">✓ balanced panel</span></div></div>`;
  }).join("") || `<div class="muted small">No panels yet — waiting on availability.</div>`;

  if (res.unschedulable.length || res.understaffed.length) {
    html += `<div class="card"><b>⚠ Needs attention</b><ul class="small">
      ${res.unschedulable.map((id) => `<li>${escapeHtml(nameOf(id))} — no available slot yields a valid panel; schedule manually.</li>`).join("")}
      ${res.understaffed.map((s) => `<li>${escapeHtml(SLOTS[+s])} — not enough available interviewers for a balanced panel.</li>`).join("")}
    </ul></div>`;
  }
  $("#panels").innerHTML = html;
}

// ----------------------------------------------------- 5 · Ranking (admin)
function renderRanking() {
  if (!S.meta.interviewsComplete) {
    $("#ranking").innerHTML = `<div class="note"><b>Ranking — hidden.</b> To avoid biasing interviewers, the ranking
      stays hidden until all interviews are complete.</div>
      <button class="primary" onclick="IV.setComplete(true)">Mark interviews complete &amp; reveal ranking</button>`;
    return;
  }
  const ranked = activeCands().map((c) => {
    const scores = COMMITTEE.map((m) => (S.scores[key(m.name, c.id)] || {}).overall).filter((n) => n);
    return { name: c.name, avg: avg(scores), n: scores.length };
  }).filter((r) => r.avg != null).sort((a, b) => b.avg - a.avg);
  $("#ranking").innerHTML = `<div class="note"><b>Ranking — admin only.</b> Candidates ordered by average interview score.
    <button class="linky" onclick="IV.setComplete(false)">re-hide</button></div>
    <table><thead><tr><th>#</th><th>Candidate</th><th>Avg score</th><th># scored</th></tr></thead>
      <tbody>${ranked.map((r, i) => `<tr><td class="rankn">${i + 1}</td><td>${escapeHtml(r.name)}</td><td><b>${r.avg.toFixed(1)}</b></td><td>${r.n}</td></tr>`).join("")
        || '<tr><td colspan="4" class="muted small">No scores yet.</td></tr>'}</tbody></table>`;
}

// ---------------------------------------------------------- handlers (window)
// per-(candidate,question) debounce so switching fields never drops an edit
const noteTimers = {};
function saveNoteKeyed(me, cid, qi, val) {
  const k = cid + ":" + qi;
  clearTimeout(noteTimers[k]);
  noteTimers[k] = setTimeout(() => store.setScore(me, cid, { notes: { [qi]: val } }), 500);
}
window.IV = {
  toggleFlag: (id) => { const cur = (S.screening[key(ui.member, id)] || {}).flag; store.setScreening(ui.member, id, { flag: !cur, reason: cur ? "" : (S.screening[key(ui.member, id)] || {}).reason || "" }); },
  saveReason: (id) => { const v = $("#rsn-" + id).value; store.setScreening(ui.member, id, { reason: v }); toast("Saved"); },
  rate: (id, n) => { const cur = (S.screening[key(ui.member, id)] || {}).rating; store.setScreening(ui.member, id, { rating: cur === n ? 0 : n }); },
  addCand: async () => { const n = prompt("Candidate name:"); if (n && n.trim()) await store.addCandidate(n.trim()); },
  removeCand: (id, v) => store.setCandidateRemoved(id, v),
  avail: (i, v) => { const cur = (S.availIv[ui.member] || {})[String(i)]; store.setAvail("iv", ui.member, String(i), cur === v ? null : v); },
  pickScore: (id) => { ui.scoreCand = id; renderScore(); },
  note: (qi, val) => saveNoteKeyed(ui.member, ui.scoreCand, qi, val),
  score: (n) => { const cur = (S.scores[key(ui.member, ui.scoreCand)] || {}).overall; store.setScore(ui.member, ui.scoreCand, { overall: cur === n ? 0 : n }); },
  setComplete: (v) => store.setMeta({ interviewsComplete: v }),
};

// ------------------------------------------------------------------- boot
$("#gbtn").onclick = () => unlock($("#gpw").value.trim(), false);
$("#gpw").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock($("#gpw").value.trim(), false); });
$("#memberBtn").onclick = () => { ui.member = $("#memberSel").value; sessionStorage.setItem("ed_iv_member", ui.member); showApp(); };
$("#changeMember").onclick = () => { sessionStorage.removeItem("ed_iv_member"); ui.member = null; ["#appHeader", "#tabs", "#app"].forEach((s) => $(s).classList.add("hidden")); proceedToMemberPick(); };
$("#logout").onclick = () => { sessionStorage.removeItem("ed_iv_code"); sessionStorage.removeItem("ed_iv_member"); location.reload(); };
const savedCode = sessionStorage.getItem("ed_iv_code");
if (savedCode) unlock(savedCode, true);
