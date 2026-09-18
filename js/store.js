// ============================================================================
//  Persistence layer. Two interchangeable backends behind one API:
//   • LocalStore  — localStorage + BroadcastChannel (multi-tab). Runs with no
//                   setup; used for demo/testing on a single machine.
//   • FirestoreStore — real-time, multi-device. Used when a Firebase project is
//                   configured in config.js (see isConfigured()).
//  Both expose the same normalized state and the same mutation methods, so the
//  UI never needs to know which one is active.
//
//  Normalized state shape:
//    candidates : [{ id, name, removed }]
//    screening  : { "<member>~<candId>": { flag, reason, rating } }
//    availIv    : { "<member>": { <slotId>: "ip"|"zoom"|"either" } }
//    availCand  : { "<candId>": { <slotId>: "ip"|"zoom"|"either" } }
//    scores     : { "<member>~<candId>": { overall, notes:{<qi>:text} } }
//    meta       : { interviewsComplete }
// ============================================================================

import { effectiveSlots, toStored } from "./slots.js";

export const key = (member, candId) => `${member}~${candId}`;

const EMPTY = () => ({
  candidates: [], screening: {}, availIv: {}, availCand: {}, scores: {},
  meta: { interviewsComplete: false },
  // admin-managed setup, stored in the DB (not in the repo): real committee
  // roster (+self-identified gender), chair, interview slots, OneDrive link,
  // and any manual panel overrides { candId: { slot, members:[...] } }.
  // Interview times live in settings.times (see slots.js) — absent until an
  // admin first edits them, so it is deliberately not defaulted here.
  settings: { committee: [], chair: "", slots: [], oneDrive: "", panelOverrides: {} },
  publicInfo: { orgName: "", note: "" },
});

// ---------------------------------------------------------------- base class
class BaseStore {
  constructor() { this.state = EMPTY(); this._subs = new Set(); }
  getState() { return this.state; }
  subscribe(cb) { this._subs.add(cb); cb(this.state); return () => this._subs.delete(cb); }
  _emit() { for (const cb of this._subs) cb(this.state); }
  async syncPublicSlots() { /* no-op except on Firestore */ }
}

// Apply an edit to the interview times against the LATEST saved list (not the
// caller's possibly-stale copy). `mutate(times, overrides)` returns
// { times, overrides } or throws to abort. Shared by both backends.
function applyTimes(settings, defaults, mutate) {
  const cur = effectiveSlots(settings, defaults);
  const r = mutate(cur, { ...(settings.panelOverrides || {}) });
  return { times: toStored(r.times), panelOverrides: r.overrides };
}

// ---------------------------------------------------------------- local
const LS_KEY = "ed_interviews_v1";

export class LocalStore extends BaseStore {
  constructor() {
    super();
    this._load();
    try {
      this._ch = new BroadcastChannel("ed_interviews");
      this._ch.onmessage = () => { this._load(); this._emit(); };
    } catch { /* BroadcastChannel unsupported — single-tab only */ }
  }
  _load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      this.state = raw ? { ...EMPTY(), ...JSON.parse(raw) } : EMPTY();
    } catch { this.state = EMPTY(); }
  }
  _save() {
    localStorage.setItem(LS_KEY, JSON.stringify(this.state));
    try { this._ch && this._ch.postMessage(1); } catch { /* ignore */ }
    this._emit();
  }
  // -- mutations
  async addCandidate(name) {
    const id = "c-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random());
    this.state.candidates = [...this.state.candidates, { id, name, removed: false }];
    this._save();
  }
  async setCandidateRemoved(id, removed) {
    this.state.candidates = this.state.candidates.map((c) => c.id === id ? { ...c, removed } : c);
    this._save();
  }
  async setScreening(member, candId, patch) {
    const k = key(member, candId);
    this.state.screening = { ...this.state.screening, [k]: { ...(this.state.screening[k] || {}), ...patch } };
    this._save();
  }
  async setAvail(kind, who, slot, mod) {
    const field = kind === "cand" ? "availCand" : "availIv";
    const cur = { ...(this.state[field][who] || {}) };
    if (mod == null) delete cur[slot]; else cur[slot] = mod;
    this.state[field] = { ...this.state[field], [who]: cur };
    this._save();
  }
  async setScore(member, candId, patch) {
    const k = key(member, candId);
    const prev = this.state.scores[k] || { notes: {} };
    const next = { ...prev, ...patch, notes: { ...(prev.notes || {}), ...(patch.notes || {}) } };
    this.state.scores = { ...this.state.scores, [k]: next };
    this._save();
  }
  async setMeta(patch) { this.state.meta = { ...this.state.meta, ...patch }; this._save(); }
  async setSettings(patch) { this.state.settings = { ...this.state.settings, ...patch }; this._save(); }
  async updateConfig(mutate) {
    this._load();
    this.state.settings = { ...this.state.settings, ...mutate(this.state.settings) };
    this._save();
  }
  async updateTimes(defaults, mutate) {
    this._load(); // pick up another tab's edits first
    this.state.settings = { ...this.state.settings, ...applyTimes(this.state.settings, defaults, mutate) };
    this._save();
  }
}

// ---------------------------------------------------------------- firestore
// Faithful mirror of the local API using the Firebase modular SDK, following
// the same patterns as tools/motion-voting/js/db.js.
//
// Role-aware (for the hardened "roles" security model): `opts.scopes` limits
// which collections we subscribe to, because the rules deny reads a role isn't
// allowed to see (e.g. a reviewer cannot read scores/screening → the ranking).
// For those write-only-for-me collections we keep a per-device "echo" mirror in
// localStorage so a reviewer still sees their OWN input without a server read.
//   scopes: subset of ["candidates","screening","availIv","availCand","scores","meta","public"]
//   echo:   true → seed/merge this member's own screening+scores from localStorage
const ALL_SCOPES = ["candidates", "screening", "availIv", "availCand", "scores", "meta"];
const ECHO_KEY = "ed_iv_echo_v1";
const CAND_ECHO_KEY = "ed_iv_cand_echo_v1";

export class FirestoreStore extends BaseStore {
  constructor(fb, opts = {}) {
    super();
    this._fb = fb; // { db, ...firestore fns }
    this._echo = !!opts.echo;
    const scopes = opts.scopes || ALL_SCOPES;
    if (this._echo) this._loadEcho();
    const { db, collection, doc, onSnapshot } = fb;
    const on = (name) => scopes.includes(name);
    this._candEcho = !on("availCand"); // applicants: no read access to availCand
    if (this._candEcho) this._loadCandEcho();
    const watch = (name, ref, apply) =>
      onSnapshot(ref, (snap) => { apply(snap); this._emit(); },
                 (err) => { console.warn("snapshot denied:", name, err && err.code); });

    if (on("candidates")) watch("candidates", collection(db, "interviews_candidates"), (snap) => {
      this.state.candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    });
    if (on("screening")) watch("screening", collection(db, "interviews_screening"), (snap) => {
      this.state.screening = { ...(this._echoScreening || {}), ...Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])) };
    });
    if (on("availIv")) watch("availIv", collection(db, "interviews_availIv"), (snap) => {
      this.state.availIv = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().slots || {}]));
    });
    if (on("availCand")) watch("availCand", collection(db, "interviews_availCand"), (snap) => {
      this.state.availCand = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().slots || {}]));
    });
    if (on("scores")) watch("scores", collection(db, "interviews_scores"), (snap) => {
      this.state.scores = { ...(this._echoScores || {}), ...Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])) };
    });
    if (on("meta")) watch("meta", collection(db, "interviews_meta"), (snap) => {
      const m = snap.docs.find((d) => d.id === "state");
      this.state.meta = { interviewsComplete: false, ...(m ? m.data() : {}) };
      const c = snap.docs.find((d) => d.id === "config");
      this.state.settings = { committee: [], chair: "", slots: [], oneDrive: "", ...(c ? c.data() : {}) };
    });
    // Candidates read the slots from the public, PII-free mirror doc.
    if (on("public")) watch("public", doc(db, "interviews_public", "slots"), (snap) => {
      const d = snap.data() || {};
      this.state.settings = { ...this.state.settings, slots: d.slots || [] };
      if (Array.isArray(d.times)) this.state.settings.times = d.times; else delete this.state.settings.times;
      this.state.publicInfo = { orgName: d.orgName || "", note: d.note || "" };
    });
  }
  // -- echo mirror (reviewer's own screening/scores, per device) ------------
  _loadEcho() {
    try {
      const raw = JSON.parse(localStorage.getItem(ECHO_KEY) || "{}");
      this._echoScreening = raw.screening || {};
      this._echoScores = raw.scores || {};
      this.state.screening = { ...this._echoScreening };
      this.state.scores = { ...this._echoScores };
    } catch { this._echoScreening = {}; this._echoScores = {}; }
  }
  _saveEcho() {
    if (!this._echo) return;
    try { localStorage.setItem(ECHO_KEY, JSON.stringify({ screening: this._echoScreening, scores: this._echoScores })); } catch { /* ignore */ }
  }
  _doc(name, id) { const { db, doc } = this._fb; return doc(db, name, id); }
  async addCandidate(name) {
    const { setDoc } = this._fb;
    const id = "c-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "");
    await setDoc(this._doc("interviews_candidates", id), { name, removed: false });
  }
  async setCandidateRemoved(id, removed) {
    const { updateDoc } = this._fb;
    await updateDoc(this._doc("interviews_candidates", id), { removed });
  }
  async setScreening(member, candId, patch) {
    const { setDoc } = this._fb;
    const k = key(member, candId);
    if (this._echo) { // optimistic local echo so a reviewer sees their own input
      this._echoScreening[k] = { ...(this._echoScreening[k] || {}), member, candId, ...patch };
      this.state.screening = { ...this.state.screening, [k]: this._echoScreening[k] };
      this._saveEcho(); this._emit();
    }
    await setDoc(this._doc("interviews_screening", k), { member, candId, ...patch }, { merge: true });
  }
  async setAvail(kind, who, slot, mod) {
    const { setDoc, deleteField } = this._fb;
    const name = kind === "cand" ? "interviews_availCand" : "interviews_availIv";
    const field = kind === "cand" ? "availCand" : "availIv";
    const prev = this.state[field][who] || {};
    const cur = { ...prev };
    if (mod == null) delete cur[slot]; else cur[slot] = mod;
    const show = (m) => { // optimistic: reflect immediately (candidates don't subscribe to availCand)
      this.state[field] = { ...this.state[field], [who]: m };
      if (kind === "cand" && this._candEcho) this._saveCandEcho(who, m);
      this._emit();
    };
    show(cur);
    // Change ONLY this one time. Applicants can't read their saved doc (write-
    // only under roles), so rewriting the whole map from local state would erase
    // answers from an earlier visit. deleteField() under merge removes one key.
    try {
      await setDoc(this._doc(name, who), { slots: { [slot]: mod == null ? deleteField() : mod } }, { merge: true });
    } catch (e) { show(prev); throw e; } // don't leave an unsaved pick on screen
  }
  // applicant's own answers, remembered on this device so a returning applicant
  // sees what they picked (the server copy is write-only for them)
  _loadCandEcho() {
    try { this.state.availCand = JSON.parse(localStorage.getItem(CAND_ECHO_KEY) || "{}"); } catch { this.state.availCand = {}; }
  }
  _saveCandEcho(who, map) {
    try {
      const all = JSON.parse(localStorage.getItem(CAND_ECHO_KEY) || "{}");
      all[who] = map; localStorage.setItem(CAND_ECHO_KEY, JSON.stringify(all));
    } catch { /* storage blocked — the server copy is still saved */ }
  }
  async setScore(member, candId, patch) {
    const { setDoc } = this._fb;
    const k = key(member, candId);
    if (this._echo) {
      const prev = this._echoScores[k] || { notes: {} };
      this._echoScores[k] = { ...prev, ...patch, member, candId, notes: { ...(prev.notes || {}), ...(patch.notes || {}) } };
      this.state.scores = { ...this.state.scores, [k]: this._echoScores[k] };
      this._saveEcho(); this._emit();
    }
    await setDoc(this._doc("interviews_scores", k), { member, candId, ...patch }, { merge: true });
  }
  async setMeta(patch) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_meta", "state"), patch, { merge: true });
  }
  async setSettings(patch) {
    const { setDoc } = this._fb;
    // mergeFields (not merge:true): replace each written field wholesale. merge
    // deep-merges maps, so a deleted panelOverrides entry would never go away.
    await setDoc(this._doc("interviews_meta", "config"), patch, { mergeFields: Object.keys(patch) });
    // Mirror the PII-free slot list to the public doc so applicants can read it.
    if ("slots" in patch) {
      await setDoc(this._doc("interviews_public", "slots"),
        { slots: patch.slots || this.state.settings.slots || [] }, { merge: true });
    }
  }
  // Read-modify-write of the committee config against the LATEST saved copy.
  // `mutate(config)` returns a patch; each patched field is replaced wholesale.
  async updateConfig(mutate) {
    const { db, runTransaction } = this._fb;
    const ref = this._doc("interviews_meta", "config");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const patch = mutate(snap.exists() ? snap.data() : {});
      tx.set(ref, patch, { mergeFields: Object.keys(patch) });
    });
  }
  // Transactional: re-reads the saved config so two admins editing times at once
  // can't overwrite each other, and writes config + public mirror together.
  async updateTimes(defaults, mutate) {
    const { db, runTransaction } = this._fb;
    const cfgRef = this._doc("interviews_meta", "config"), pubRef = this._doc("interviews_public", "slots");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(cfgRef);
      const next = applyTimes(snap.exists() ? snap.data() : {}, defaults, mutate);
      tx.set(cfgRef, next, { mergeFields: ["times", "panelOverrides"] });
      tx.set(pubRef, { times: next.times }, { mergeFields: ["times"] });
    });
  }
  // push the current list to the PII-free public doc (self-heal for dates
  // that were only ever written to the committee config)
  async syncPublicSlots(pub) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_public", "slots"), pub, { mergeFields: Object.keys(pub) });
  }
}
