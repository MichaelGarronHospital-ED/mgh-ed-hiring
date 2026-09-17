// ============================================================================
//  Candidate booking page. One shared link; the applicant types their name
//  (matched to the roster — no list is shown) and picks the slots they can do.
// ============================================================================
import { firebaseConfig, ORG_NAME, SLOTS } from "./config.js";
import { LocalStore, FirestoreStore } from "./store.js";
import { matchName, escapeHtml, toast } from "./util.js";

let store = null, S = null, candId = null;
const $ = (s) => document.querySelector(s);
const isConfigured = () => firebaseConfig && Object.keys(firebaseConfig).length > 0 && firebaseConfig.apiKey;

async function loadFirestore() {
  const [a, f, au] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
  ]);
  const app = a.initializeApp(firebaseConfig);
  try { await au.signInAnonymously(au.getAuth(app)); } catch { /* open rules */ }
  return { db: f.getFirestore(app), collection: f.collection, doc: f.doc,
    setDoc: f.setDoc, updateDoc: f.updateDoc, onSnapshot: f.onSnapshot };
}

async function init() {
  $("#orgName").textContent = ORG_NAME;
  if (isConfigured()) store = new FirestoreStore(await loadFirestore());
  else store = new LocalStore();
  store.subscribe((s) => { S = s; if (candId) renderBooking(); });
  S = store.getState();
  const saved = sessionStorage.getItem("ed_iv_cand");
  if (saved && S.candidates.some((c) => c.id === saved && !c.removed)) { candId = saved; renderBooking(); }
}

function signIn() {
  const names = S.candidates.filter((c) => !c.removed).map((c) => c.name);
  const hit = matchName($("#nameIn").value, names);
  if (!hit) { $("#nameErr").textContent = "We couldn't find that name — please check the spelling or contact the coordinator."; return; }
  candId = S.candidates.find((c) => c.name === hit).id;
  sessionStorage.setItem("ed_iv_cand", candId);
  renderBooking();
}

function renderBooking() {
  $("#signin").classList.add("hidden");
  const el = $("#booking");
  el.classList.remove("hidden");
  const c = S.candidates.find((x) => x.id === candId);
  const map = S.availCand[candId] || {};
  const seg = (i, v, l) => `<button class="${map[String(i)] === v ? "on" : ""}" onclick="BOOK.set(${i},'${v}')">${l}</button>`;
  el.innerHTML = `
    <div class="card"><div class="muted small">Signed in as</div><div class="name">${escapeHtml(c ? c.name : "")}</div></div>
    <div class="card"><b>Select the interview times you can attend</b>
      <div class="muted small" style="margin:.2rem 0 .7rem">For each time you can make, choose whether you
        <b>can</b> attend in person, by Zoom, or either. <b>In-person interviews are encouraged where possible.</b>
        Leave the rest untouched — you can come back and update.</div>
      <div class="slotgrid"><div class="h">Slot</div><div class="h">I can attend…</div>
        ${SLOTS.map((label, i) => `<div>${escapeHtml(label)}</div><div><span class="seg">${seg(i, "ip", "In person")}${seg(i, "zoom", "Zoom")}${seg(i, "either", "Either")}</span></div>`).join("")}
      </div>
      <div class="muted small" style="margin-top:.8rem">Your times are saved automatically. You'll be contacted with your interview time.</div>
    </div>`;
}

window.BOOK = {
  set: (i, v) => { const cur = (S.availCand[candId] || {})[String(i)]; store.setAvail("cand", candId, String(i), cur === v ? null : v); toast("Saved"); },
};
$("#nameBtn").onclick = signIn;
$("#nameIn").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
init();
