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
//    availIv    : { "<member>": { <slot>: "ip"|"zoom"|"either" } }
//    availCand  : { "<candId>": { <slot>: "ip"|"zoom"|"either" } }
//    scores     : { "<member>~<candId>": { overall, notes:{<qi>:text} } }
//    meta       : { interviewsComplete }
// ============================================================================

export const key = (member, candId) => `${member}~${candId}`;

const EMPTY = () => ({
  candidates: [], screening: {}, availIv: {}, availCand: {}, scores: {},
  meta: { interviewsComplete: false },
});

// ---------------------------------------------------------------- base class
class BaseStore {
  constructor() { this.state = EMPTY(); this._subs = new Set(); }
  getState() { return this.state; }
  subscribe(cb) { this._subs.add(cb); cb(this.state); return () => this._subs.delete(cb); }
  _emit() { for (const cb of this._subs) cb(this.state); }
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
}

// ---------------------------------------------------------------- firestore
// Faithful mirror of the local API using the Firebase modular SDK, following
// the same patterns as tools/motion-voting/js/db.js. Enabled only when a real
// project is configured. (Local mode is the one exercised without a backend.)
export class FirestoreStore extends BaseStore {
  constructor(fb) {
    super();
    this._fb = fb; // { db, ...firestore fns }
    const { db, collection, onSnapshot } = fb;
    const watch = (name, apply) =>
      onSnapshot(collection(db, name), (snap) => {
        apply(snap.docs);
        this._emit();
      });
    watch("interviews_candidates", (docs) => {
      this.state.candidates = docs.map((d) => ({ id: d.id, ...d.data() }));
    });
    watch("interviews_screening", (docs) => {
      this.state.screening = Object.fromEntries(docs.map((d) => [d.id, d.data()]));
    });
    watch("interviews_availIv", (docs) => {
      this.state.availIv = Object.fromEntries(docs.map((d) => [d.id, d.data().slots || {}]));
    });
    watch("interviews_availCand", (docs) => {
      this.state.availCand = Object.fromEntries(docs.map((d) => [d.id, d.data().slots || {}]));
    });
    watch("interviews_scores", (docs) => {
      this.state.scores = Object.fromEntries(docs.map((d) => [d.id, d.data()]));
    });
    watch("interviews_meta", (docs) => {
      const m = docs.find((d) => d.id === "state");
      this.state.meta = { interviewsComplete: false, ...(m ? m.data() : {}) };
    });
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
    await setDoc(this._doc("interviews_screening", key(member, candId)), { member, candId, ...patch }, { merge: true });
  }
  async setAvail(kind, who, slot, mod) {
    const { setDoc } = this._fb;
    const name = kind === "cand" ? "interviews_availCand" : "interviews_availIv";
    const cur = { ...((kind === "cand" ? this.state.availCand : this.state.availIv)[who] || {}) };
    if (mod == null) delete cur[slot]; else cur[slot] = mod;
    // full overwrite (not merge): merge can't delete a cleared slot from the map
    await setDoc(this._doc(name, who), { slots: cur });
  }
  async setScore(member, candId, patch) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_scores", key(member, candId)), { member, candId, ...patch }, { merge: true });
  }
  async setMeta(patch) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_meta", "state"), patch, { merge: true });
  }
}
