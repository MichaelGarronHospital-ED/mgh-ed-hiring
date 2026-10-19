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
//    offers     : { "<candId>": { status:""|"offered"|"accepted"|"declined", note, offeredAt, respondedAt, updatedAt } }  (admin only)
//    questions  : interviews_meta/questions as stored, or null (H2)
//    schedule   : interviews_meta/schedule, or null (H4)
//    passwordsMeta : interviews_meta/passwords (dates only), or null (H3)
//  "<member>" is a member ID (members.js). Legacy ids are the names.
//
//  History (H12): every Admin change takes an optional `history` entry
//  (history.js entry(), or a function of the saved document before the change
//  that returns one) and writes it in the SAME batch or transaction, stamped
//  with the server time. There is no "saved but not logged".
// ============================================================================

import { effectiveSlots, toStored } from "./slots.js?v=R14";
import { lastKey, candKey, ls } from "./util.js?v=R14";
import { ROUND_COLLECTIONS, quarantineSet, isQuarantined } from "./backup.js?v=R14";

// R6 (review 3 m2): documents kept by a close because they changed after the
// copy belong to no round until leadership decides. Every view leaves them out.
const QUAR_FIELDS = [["screening", "interviews_screening"], ["scores", "interviews_scores"], ["availIv", "interviews_availIv"],
  ["availCand", "interviews_availCand"], ["availRaw", "interviews_availCand"], ["offers", "interviews_offers"], ["notices", "interviews_applicant"]];
// rawDocs: the raw documents as the server has them ({ coll: { id: doc } }), to
// tell a kept document from a new one with the same id; null = unknown (kept).
function quarantineView(state, rawDocs = null) {
  const q = quarantineSet(((state || {}).meta || {}).keptFromClose);
  if (!q.size) return state;
  const raw = rawDocs ? rawDocs() : null;
  const has = (c, id) => isQuarantined(q, c, id, raw ? (raw[c] || {})[id] : undefined);
  const v = { ...state, candidates: (state.candidates || []).filter((c) => !has("interviews_candidates", c.id)) };
  QUAR_FIELDS.forEach(([f, c]) => { if (v[f]) v[f] = Object.fromEntries(Object.entries(v[f]).filter(([id]) => !has(c, id))); });
  return v;
}
function quarantineRaw(raw) {
  const q = quarantineSet((((raw || {}).interviews_meta || {}).state || {}).keptFromClose);
  if (!q.size) return raw;
  const out = { ...raw };
  Object.keys(out).forEach((c) => { out[c] = Object.fromEntries(Object.entries(out[c] || {}).filter(([id, d]) => !isQuarantined(q, c, id, d))); });
  return out;
}
// Thrown when this page no longer holds the close (review 3 M1).
export class TookOver extends Error { constructor() { super("Another Admin page took over closing. Nothing more was changed from this page."); this.code = "took-over"; } }

export const key = (member, candId) => `${member}~${candId}`;

const EMPTY = () => ({
  candidates: [], screening: {}, availIv: {}, availCand: {}, scores: {},
  meta: { interviewsComplete: false },
  offers: {},
  // admin-managed setup, stored in the DB (not in the repo): real committee
  // roster (+self-identified gender), chair, interview slots, OneDrive link,
  // and any manual panel overrides { candId: { slot, members:[...] } }.
  // Interview times live in settings.times (see slots.js) — absent until an
  // admin first edits them, so it is deliberately not defaulted here.
  settings: { committee: [], chair: "", slots: [], oneDrive: "", panelOverrides: {} },
  publicInfo: { orgName: "", note: "" },
  questions: null, schedule: null, passwordsMeta: null,
  // Roster surname keys that firestore.rules lets an applicant write availability
  // under. null = not configured yet (the rules then refuse every applicant
  // write, so the admin session syncs this from the roster — app.js).
  allowedNames: null,
});

// ---------------------------------------------------------------- base class
class BaseStore {
  // `ready` = the first real server snapshot has landed, so the roster on
  // screen is the SAVED one rather than the config.js fallback. The member
  // picker waits for it: someone who commits to a name from the fallback list
  // files their flags, ratings and scores under that spelling, and if the saved
  // roster spells them differently their input lands under a name nothing reads.
  constructor() { this.state = EMPTY(); this._subs = new Set(); this.ready = true; this.metaLoaded = true; }
  // Which committee member is signed in. Only the Firestore backend acts on it
  // (it decides which screening documents to fetch back); local mode already
  // has the whole collection in hand.
  setMember() { /* no-op except on Firestore */ }
  // Can this client actually read a reviewer's own screening back?
  //   true  — confirmed working
  //   false — the server refused (rules not published yet, or tightened again)
  //   null  — not answered yet
  // The UI branches on it rather than promising "on any device" and being wrong
  // for however long it takes someone to paste the rules into the console.
  screeningReadBack = true;
  getState() { return quarantineView(this.state, () => this._rawDocs()); }
  subscribe(cb) { this._subs.add(cb); cb(this.getState()); return () => this._subs.delete(cb); }
  _emit() { const v = this.getState(); for (const cb of this._subs) cb(v); }
  _rawDocs() { return null; }
  async syncPublicSlots() { /* no-op except on Firestore */ }
  // Forget this browser's own copies of scores, screening and an applicant's
  // picks (H12, at log out). The server copy is untouched.
  clearLocalCopies() { ls.del(ECHO_KEY); ls.del(CAND_ECHO_KEY); ls.del(REPLY_ECHO_KEY); }
  // H11: the applicant's own reply as this device last sent it
  replyEcho(key) { try { return JSON.parse(ls.get(REPLY_ECHO_KEY) || "{}")[key] || null; } catch { return null; } }
  _saveReplyEcho(key, r) {
    try { const all = JSON.parse(ls.get(REPLY_ECHO_KEY) || "{}"); all[key] = r; ls.set(REPLY_ECHO_KEY, JSON.stringify(all)); } catch { /* blocked */ }
  }
}

// A field value that removes the field (deleteField() on Firestore).
export const DEL = Object.freeze({ __del: true });
const isDel = (v) => v === DEL || (v && v.__del === true);
const applyPatch = (obj, patch) => {
  const o = { ...(obj || {}) };
  Object.entries(patch || {}).forEach(([k, v]) => { if (isDel(v)) delete o[k]; else o[k] = v; });
  return o;
};

// history may be an entry, or a function (savedBefore, patch) → entry | null
const histOf = (h, before, patch) => (typeof h === "function" ? h(before, patch) : h) || null;
const newLocalId = () => "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
    // The channel message can arrive before another tab's write is visible
    // here; the storage event fires only once it is, so listen to both.
    try {
      window.addEventListener("storage", (e) => { if (e.key === LS_KEY) { this._load(); this._emit(); } });
    } catch { /* no window (tests) */ }
  }
  _load() {
    try {
      const raw = ls.get(LS_KEY);
      this.state = raw ? { ...EMPTY(), ...JSON.parse(raw) } : EMPTY();
    } catch { this.state = EMPTY(); }
  }
  _save() {
    ls.set(LS_KEY, JSON.stringify(this.state));   // a blocked browser just forgets
    try { this._ch && this._ch.postMessage(1); } catch { /* ignore */ }
    this._emit();
  }
  // the local twin of a history document (no server clock here)
  _hist(entry) {
    if (!entry) return;
    const { _id, ...data } = entry;
    const id = _id || newLocalId();
    this.state.history = { ...(this.state.history || {}), [id]: { ...data, at: new Date().toISOString() } };
    return id;
  }
  async addHistory(entry) { this._load(); this._hist(entry); this._save(); }
  async listHistory({ after = 0, limit = 50 } = {}) {
    this._load();
    const all = Object.entries(this.state.history || {}).map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const entries = all.slice(after, after + limit);
    return { entries, next: after + limit < all.length ? after + limit : null };
  }
  // the stored state, re-shaped as the raw documents of every round collection
  async snapshotRaw() {
    this._load();
    return quarantineRaw(this._rawOf(JSON.parse(JSON.stringify(this.state))));
  }
  _rawDocs() { return this._rawOf(this.state); }
  _rawOf(st) {
    const raw = Object.fromEntries(ROUND_COLLECTIONS.map((n) => [n, {}]));
    (st.candidates || []).forEach(({ id, ...d }) => { raw.interviews_candidates[id] = d; });
    raw.interviews_screening = st.screening || {};
    raw.interviews_scores = st.scores || {};
    Object.entries(st.availIv || {}).forEach(([id, slots]) => { raw.interviews_availIv[id] = { slots }; });
    Object.entries(st.availCand || {}).forEach(([id, slots]) => { raw.interviews_availCand[id] = { slots, ...((st.replies || {})[id] || {}) }; });
    raw.interviews_offers = st.offers || {};
    raw.interviews_applicant = st.notices || {};
    const set = st.settings || {};
    const pub = { ...(Array.isArray(set.times) ? { times: set.times } : {}), slots: set.slots || [] };
    if (st.publicInfo && st.publicInfo.orgName) pub.orgName = st.publicInfo.orgName;
    if (st.booking) pub.booking = st.booking;
    raw.interviews_public = { slots: pub };
    const meta = { state: st.meta || {}, config: set };
    if (Array.isArray(st.allowedNames)) meta.allowed = { keys: st.allowedNames };
    if (st.questions) meta.questions = st.questions;
    if (st.schedule) meta.schedule = st.schedule;
    if (st.passwordsMeta) meta.passwords = st.passwordsMeta;
    raw.interviews_meta = meta;
    raw.interviews_history = st.history || {};
    return raw;
  }
  // -- mutations
  async addCandidate(name, history) {
    const id = "c-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random());
    this.state.candidates = [...this.state.candidates, { id, name, removed: false }];
    this._hist(histOf(history, null, { id, name }));
    this._save();
    return id;
  }
  // Local mode has no rules engine, so mirror what the rules enforce on the
  // server: the same answer to "is this surname on the roster?", so the applicant
  // flow can be exercised end-to-end without Firebase.
  async setAllowedNames(keys) { this.state.allowedNames = keys; this._save(); }
  // H14: an applicant's key is their own availKey when they share a surname.
  // Like the rules, the saved allowed list decides once it exists.
  async checkName(key) {
    if (Array.isArray(this.state.allowedNames)) return this.state.allowedNames.includes(key);
    return this.state.candidates.some((c) => !c.removed && candKey(c) === key);
  }
  async setCandidateRemoved(id, removed, history) {
    this.state.candidates = this.state.candidates.map((c) => c.id === id ? { ...c, removed } : c);
    this._hist(histOf(history));
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
  async setMeta(patch, history) { this.state.meta = { ...this.state.meta, ...patch }; this._hist(histOf(history)); this._save(); }
  async setOffer(candId, patch, history) {
    this.state.offers = { ...(this.state.offers || {}), [candId]: { ...((this.state.offers || {})[candId] || {}), ...patch } };
    this._hist(histOf(history));
    this._save();
  }
  async setSettings(patch, history) { this.state.settings = { ...this.state.settings, ...patch }; this._hist(histOf(history)); this._save(); }
  async updateConfig(mutate, history) {
    this._load();
    const before = JSON.parse(JSON.stringify(this.state.settings || {}));
    const patch = mutate(this.state.settings);
    this.state.settings = { ...this.state.settings, ...patch };
    this._hist(histOf(history, before, patch));
    this._save();
  }
  async updateTimes(defaults, mutate, history) {
    this._load(); // pick up another tab's edits first
    const before = JSON.parse(JSON.stringify(this.state.settings || {}));
    const next = applyTimes(this.state.settings, defaults, mutate);
    this.state.settings = { ...this.state.settings, ...next };
    this._hist(histOf(history, before, next));
    this._save();
  }
  async updateQuestions(mutate, history) {
    this._load();
    const before = this.state.questions ? JSON.parse(JSON.stringify(this.state.questions)) : null;
    const next = mutate(before);
    this.state.questions = { ...next, updatedAt: new Date().toISOString() };
    this._hist(histOf(history, before, next));
    this._save();
  }
  now() { return new Date().toISOString(); }
  tsFromMillis(ms) { return new Date(ms).toISOString(); }
  // a backup value back into what this store keeps ({ __ts } becomes an ISO string)
  decode(v) { return JSON.parse(JSON.stringify(v), (k, x) => (x && typeof x === "object" && typeof x.__ts === "string" && Object.keys(x).length === 1 ? x.__ts : x)); }
  // H4: one change to interviews_meta/state (fields replaced whole), with the
  // public booking flag and candidate patches in the same commit.
  async updateState(mutate, history, extra = {}) {
    this._load();
    const before = JSON.parse(JSON.stringify(this.state.meta || {}));
    const patch = mutate(before);
    this.state.meta = applyPatch(this.state.meta, patch);
    if (extra.public && "booking" in extra.public) this.state.booking = extra.public.booking;
    if (extra.candidates) this.state.candidates = this.state.candidates.map((c) => extra.candidates[c.id] ? { id: c.id, ...applyPatch(c, extra.candidates[c.id]) } : c);
    this._hist(histOf(history, before, patch));
    this._save();
  }
  // H4: interviews_meta/schedule, replaced whole by mutate(before).
  async updateSchedule(mutate, history) {
    this._load();
    const before = this.state.schedule ? JSON.parse(JSON.stringify(this.state.schedule)) : null;
    const next = mutate(before);
    this.state.schedule = next;
    this._hist(histOf(history, before, next));
    this._save();
  }
  // H7: patches to candidate documents ({ id: { field: value | DEL } }), one commit.
  async setCandidates(patches, history) {
    this._load();
    this.state.candidates = this.state.candidates.map((c) => patches[c.id] ? { id: c.id, ...applyPatch(c, patches[c.id]) } : c);
    this._hist(histOf(history));
    this._save();
  }
  // A checked change to one document: mutate(before) returns the new document,
  // null to delete it, or throws to refuse (undo uses it to check "changed since").
  async txDoc(coll, id, mutate, history) {
    this._load();
    if (coll === "interviews_screening") {
      const before = this.state.screening[id] ? JSON.parse(JSON.stringify(this.state.screening[id])) : null;
      const next = mutate(before);
      const m = { ...this.state.screening }; if (next == null) delete m[id]; else m[id] = next;
      this.state.screening = m;
    } else if (coll === "interviews_candidates") {
      const cur = this.state.candidates.find((c) => c.id === id);
      const before = cur ? (({ id: _x, ...rest }) => rest)(JSON.parse(JSON.stringify(cur))) : null;
      const next = mutate(before);
      this.state.candidates = next == null ? this.state.candidates.filter((c) => c.id !== id)
        : cur ? this.state.candidates.map((c) => (c.id === id ? { id, ...next } : c)) : [...this.state.candidates, { id, ...next }];
    } else throw new Error("txDoc: " + coll);
    this._hist(histOf(history));
    this._save();
  }
  // ---- R6: the close (local twin of the Firestore version, with the rules'
  // lease and ownership checks restated so the sims exercise the same logic)
  async readCollections(names) { const raw = await this._rawAll(); return Object.fromEntries(names.map((n) => [n, raw[n] || {}])); }
  async _rawAll() {
    const keep = this.state.meta && this.state.meta.keptFromClose;
    if (keep && keep.length) { const m = this.state.meta; this.state.meta = { ...m, keptFromClose: [] }; const r = await this.snapshotRaw(); this.state.meta = m; return r; }
    return this.snapshotRaw();
  }
  async getStateFresh() { this._load(); return JSON.parse(JSON.stringify(this.state.meta || {})); }
  _claim(ctx) { return { tab: ctx.tab, load: ctx.load, at: new Date(this.now2()).toISOString() }; }
  now2() { return Date.now() + (this._skew || 0); }
  async startClose(ctx, attemptId) {
    this._load();
    const st = this.state.meta || {};
    if (st.closingTab || st.roundStatus === "closing") throw new TookOver();
    if ((st.keptFromClose || []).length) throw new Error("Decide about the kept items first.");
    this.state.meta = { ...st, roundStatus: "closing", closingAttemptId: attemptId, closingStartedAt: new Date().toISOString(),
      closingTab: ctx.tab, lease: this._claim(ctx) };
    this.state.booking = "paused";
    this._save();
    return st;
  }
  async reclaim(ctx) {
    this._load();
    const st = this.state.meta || {};
    if (st.closingTab !== ctx.tab) throw new TookOver();
    this.state.meta = { ...st, lease: this._claim(ctx) };
    this._save();
    return this.state.meta;
  }
  async takeover(ctx, attemptId, staleMs = 5 * 60000) {
    this._load();
    const st = this.state.meta || {};
    if (st.roundStatus !== "closing" || (st.closingAttemptId || null) !== (attemptId || null)) throw new TookOver();
    const at = st.lease && Date.parse(st.lease.at);
    if (at && this.now2() - at < staleMs) { const e = new Error("The close is still running on another page."); e.code = "permission-denied"; throw e; }
    this.state.meta = { ...st, closingTab: ctx.tab, lease: this._claim(ctx) };
    this._save();
    return this.state.meta;
  }
  async closeTx(ctx, expect, fn) {
    this._load();
    const st = this.state.meta || {};
    const archive = this.state.archive || {};
    const att = ctx.attemptId ? archive[ctx.attemptId] || null : null;
    if (st.closingTab !== ctx.tab || !st.lease || st.lease.load !== ctx.load || (st.closingAttemptId || null) !== (ctx.attemptId || null)) throw new TookOver();
    if (expect && !expect.includes(att ? att.status : "missing")) throw new TookOver();
    const claim = this._claim(ctx);
    const ops = [];
    let next = { ...st };
    const w = {
      claim, st, att,
      state: (patch) => { next = applyPatch(next, patch); },
      stateReplace: (d) => { next = { ...d }; },
      attempt: (patch, id = ctx.attemptId) => ops.push(() => { const a = (this.state.archive || {})[id]; this.state.archive = { ...(this.state.archive || {}), [id]: { ...(a || {}), ...patch, owner: claim } }; }),
      attemptCreate: (id, d) => ops.push(() => { this.state.archive = { ...(this.state.archive || {}), [id]: { ...d, owner: claim, _chunks: {} } }; }),
      attemptDelete: (id) => ops.push(() => { const a = { ...(this.state.archive || {}) }; delete a[id]; this.state.archive = a; }),
      part: (i, json) => ops.push(() => { const a = this.state.archive[ctx.attemptId]; a._chunks = { ...(a._chunks || {}), [i]: { i, json } }; }),
      partDelete: (id, i) => ops.push(() => { const a = (this.state.archive || {})[id]; if (a && a._chunks) { const c = { ...a._chunks }; delete c[i]; a._chunks = c; } }),
      set: (coll, id, data, opts) => ops.push(() => this._applyOne({ coll, id, data, merge: !!opts })),
      del: (coll, id) => ops.push(() => this._applyOne({ coll, id, del: true })),
      get: async (coll, id) => { const raw = await this._rawAll(); return (raw[coll] || {})[id] || null; },
      history: (e) => ops.push(() => this._hist(e)),
    };
    const r = await fn(w);
    ops.forEach((op) => op());
    this.state.meta = { ...next, lease: claim };
    this._save();
    return r;
  }
  // one write or delete in Firestore terms, on the local state
  _applyOne({ coll, id, data, del, merge }) {
    const st = this.state;
    if (coll === "interviews_meta") {
      const key = { config: "settings", state: "meta", schedule: "schedule", questions: "questions", passwords: "passwordsMeta" }[id];
      if (id === "allowed") { st.allowedNames = del ? null : (data.keys || []); return; }
      if (key) { st[key] = del ? (key === "settings" ? {} : null) : merge ? { ...(st[key] || {}), ...data } : data; return; }
      return;
    }
    if (coll === "interviews_public") { if (!del) { st.booking = data.booking; if ("times" in data) st.settings = { ...st.settings, times: data.times }; } return; }
    if (del) return this.applyPlanSync({ deletes: [{ coll, id }] });
    return this.applyPlanSync({ writes: [{ coll, id, data }] });
  }
  applyPlanSync(plan) {
    const keepHist = this._hist; this._hist = () => {};
    const save = this._save, load = this._load; this._save = () => {}; this._load = () => {};
    try { this.applyPlan(plan); } finally { this._save = save; this._load = load; this._hist = keepHist; }
  }
  // (the parts of a saved copy live under _chunks here; a subcollection in Firestore)
  async listArchive() { this._load(); return Object.entries(this.state.archive || {}).map(([id, a]) => { const { _chunks, ...rest } = a; return { id, ...rest }; }); }
  async readAttempt(id) { this._load(); const a = (this.state.archive || {})[id]; if (!a) return null; const { _chunks, ...rest } = a; return rest; }
  async readParts(id) { this._load(); const a = (this.state.archive || {})[id]; return a ? Object.values(a._chunks || {}) : []; }
  async deleteArchive(id) { this._load(); const a = { ...(this.state.archive || {}) }; delete a[id]; this.state.archive = a; this._save(); }
  async updateArchive(id, patch, history) {
    this._load();
    const a = (this.state.archive || {})[id]; if (!a) return;
    this.state.archive = { ...this.state.archive, [id]: applyPatch(a, patch) };
    this._hist(histOf(history));
    this._save();
  }
  async keptDecision(deleteThem, list, history) {
    this._load();
    if (deleteThem) this.applyPlanSync({ deletes: list.filter((k) => k.coll !== "interviews_history") });
    this.state.meta = { ...(this.state.meta || {}), keptFromClose: [], keptFromAttempt: null };
    this._hist(histOf(history));
    this._save();
  }
  // ---- H11 (local twins of the applicant notice and reply)
  async getMyNotice(key) { this._load(); return (this.state.notices || {})[key] || null; }
  async setReply(key, reply) {
    this._load();
    const at = new Date().toISOString();
    this.state.replies = { ...(this.state.replies || {}), [key]: { reply, replyAt: at } };
    this._saveReplyEcho(key, { reply, at });
    this._save();
  }
  async refreshPublic() { const was = this.state.booking; this._load(); if (this.state.booking !== was) this._emit(); return this.state.booking || "open"; }
  async publishNotices(desired, history) {
    this._load();
    const cur = this.state.notices || {}, next = {}, res = { sent: 0, updated: 0, removed: 0 };
    const same = (a, b) => JSON.stringify({ ...a, publishedAt: 0 }) === JSON.stringify({ ...b, publishedAt: 0 });
    Object.entries(desired).forEach(([k, n]) => {
      if (!cur[k]) res.sent++; else if (!same(cur[k], n)) res.updated++;
      next[k] = cur[k] && same(cur[k], n) ? cur[k] : { ...n, publishedAt: new Date().toISOString() };
    });
    res.removed = Object.keys(cur).filter((k) => !desired[k]).length;
    this.state.notices = next;
    this.state.schedule = { ...(this.state.schedule || {}), publishedAt: new Date().toISOString() };
    this._hist(histOf(history, null, res));
    this._save();
    return res;
  }
  // H5/H14/H1: apply a plan (candidates.js / backup.js). Copies before deletes.
  async applyPlan(plan, history) {
    this._load();
    const st = this.state;
    const MAP = { interviews_screening: "screening", interviews_scores: "scores", interviews_offers: "offers", interviews_applicant: "notices" };
    for (const w of plan.writes || []) {
      if (w.coll === "interviews_meta" || w.coll === "interviews_public") { this._applyOne({ ...w, merge: !!w.mergeFields }); continue; }
      if (MAP[w.coll]) st[MAP[w.coll]] = { ...(st[MAP[w.coll]] || {}), [w.id]: w.data };
      else if (w.coll === "interviews_availCand") {
        const { slots, ...rest } = w.data || {};
        st.availCand = { ...st.availCand, [w.id]: { ...(slots || {}) } };
        if (Object.keys(rest).length) st.replies = { ...(st.replies || {}), [w.id]: rest };
      } else if (w.coll === "interviews_availIv") st.availIv = { ...st.availIv, [w.id]: { ...((w.data || {}).slots || {}) } };
      else if (w.coll === "interviews_candidates") {
        st.candidates = st.candidates.some((c) => c.id === w.id) ? st.candidates.map((c) => (c.id === w.id ? { id: w.id, ...w.data } : c))
          : [...st.candidates, { id: w.id, ...w.data }];
      } else if (w.coll === "interviews_history") st.history = { ...(st.history || {}), [w.id]: w.data };
      else throw new Error("applyPlan write: " + w.coll);
    }
    const nullDel = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === null ? DEL : v]));
    st.candidates = st.candidates.map((c) => (plan.candidates && plan.candidates[c.id] ? { id: c.id, ...applyPatch(c, nullDel(plan.candidates[c.id])) } : c));
    if (plan.overrides && Object.keys(plan.overrides).length) {
      const ov = { ...((st.settings || {}).panelOverrides || {}) };
      Object.entries(plan.overrides).forEach(([k, v]) => { if (v) ov[k] = v; else delete ov[k]; });
      st.settings = { ...st.settings, panelOverrides: ov };
    }
    if (plan.schedulePanels && Object.keys(plan.schedulePanels).length && st.schedule) {
      const sp = { ...(st.schedule.panels || {}) };
      Object.entries(plan.schedulePanels).forEach(([k, v]) => { if (v) sp[k] = v; else delete sp[k]; });
      st.schedule = { ...st.schedule, panels: sp };
    }
    for (const d of plan.deletes || []) {
      if (MAP[d.coll]) { const m = { ...(st[MAP[d.coll]] || {}) }; delete m[d.id]; st[MAP[d.coll]] = m; }
      else if (d.coll === "interviews_availCand") { const m = { ...st.availCand }; delete m[d.id]; st.availCand = m; if (st.replies) { const r = { ...st.replies }; delete r[d.id]; st.replies = r; } }
      else if (d.coll === "interviews_availIv") { const m = { ...st.availIv }; delete m[d.id]; st.availIv = m; }
      else if (d.coll === "interviews_candidates") st.candidates = st.candidates.filter((c) => c.id !== d.id);
      else if (d.coll === "interviews_history") { const m = { ...(st.history || {}) }; delete m[d.id]; st.history = m; }
      else throw new Error("applyPlan delete: " + d.coll);
    }
    this._hist(histOf(history));
    this._save();
  }
}

// ---------------------------------------------------------------- firestore
// Faithful mirror of the local API using the Firebase modular SDK, following
// the same patterns as js/db.js in the mgh-ed-motion-voting repo.
//
// Role-aware (for the hardened "roles" security model): `opts.scopes` limits
// which collections we subscribe to, because the rules deny reads a role isn't
// allowed to see (e.g. a reviewer cannot read scores/screening → the ranking).
// For those write-only-for-me collections we keep a per-device "echo" mirror in
// localStorage so a reviewer still sees their OWN input without a server read.
//   scopes: subset of ["candidates","screening","availIv","availCand","scores","meta","offers","public"]
//   echo:   true → seed/merge this member's own screening+scores from localStorage
const ALL_SCOPES = ["candidates", "screening", "availIv", "availCand", "scores", "meta", "offers"];
const ECHO_KEY = "ed_iv_echo_v1";
const CAND_ECHO_KEY = "ed_iv_cand_echo_v1";
// H11: an applicant's own reply, remembered on this device (they can't read it back)
export const REPLY_ECHO_KEY = "ed_iv_cand_reply_v1";

export class FirestoreStore extends BaseStore {
  _rawDocs() { return this._raw || null; }
  constructor(fb, opts = {}) {
    super();
    this._fb = fb; // { db, ...firestore fns }
    // A cached app.js from before R1 hands over fewer SDK functions than this
    // store needs (no writeBatch, serverTimestamp, getDocs...), so an Admin
    // save would fail in the minutes before that page reloads. Take the missing
    // ones from the same SDK module it loaded: already in memory, so at once.
    // Every app.js before R1 loaded 10.12.2, so this stays 10.12.2 when app.js
    // moves on (R13: 12.19.0): functions from another SDK copy refuse its db.
    // A current app.js hands over every function, so this never runs for it.
    const NEED = ["writeBatch", "serverTimestamp", "getDoc", "getDocs", "deleteDoc", "Timestamp", "query", "orderBy", "limit", "startAfter",
      "deleteField", "runTransaction", "setDoc", "updateDoc"];
    if (NEED.some((k) => !fb[k])) {
      this._sdkFill = import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
        .then((f) => { NEED.forEach((k) => { if (!fb[k]) fb[k] = f[k]; }); }, () => {});
    }
    this._echo = !!opts.echo;
    const scopes = opts.scopes || ALL_SCOPES;
    if (this._echo) this._loadEcho();
    const { db, collection, doc, onSnapshot } = fb;
    const on = (name) => scopes.includes(name);
    // Not ready until the saved roster/config arrives (see BaseStore). Capped so
    // a denied or hanging read can never leave the app stuck behind the picker —
    // it falls back to the config roster, which is what it did before.
    this.ready = false;
    this.metaLoaded = false;   // the first real interviews_meta snapshot (not the 5 s fallback)
    const arrive = () => { this.ready = true; };
    setTimeout(() => { if (!this.ready) { arrive(); this._emit(); } }, 5000);
    this._candEcho = !on("availCand"); // applicants: no read access to availCand
    if (this._candEcho) this._loadCandEcho();
    // the raw documents of each watched collection, as the server sent them, so
    // a kept item can be told from a new document with the same id
    const RAWC = { candidates: "interviews_candidates", screening: "interviews_screening", availIv: "interviews_availIv",
      availCand: "interviews_availCand", scores: "interviews_scores", offers: "interviews_offers" };
    this._raw = {};
    const watch = (name, ref, apply) =>
      onSnapshot(ref, (snap) => { if (RAWC[name] && snap.docs) this._raw[RAWC[name]] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])); apply(snap); this._emit(); },
                 (err) => { console.warn("snapshot denied:", name, err && err.code); });

    // A reviewer may `get` a screening document but not `list` the collection
    // (firestore.rules), so when the collection isn't in scope we instead watch
    // this member's own documents one by one. Re-run whenever the roster
    // changes, because the set of ids we want changes with it.
    this._ownScreening = on("candidates") && !on("screening");
    this._own = new Map();
    // unknown until the first per-document listener answers; admins read the
    // whole collection, so for them it is settled from the start
    this.screeningReadBack = this._ownScreening ? null : true;

    if (on("candidates")) watch("candidates", collection(db, "interviews_candidates"), (snap) => {
      this.state.candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      this._syncOwnScreening();
    });
    if (on("screening")) watch("screening", collection(db, "interviews_screening"), (snap) => {
      this.state.screening = { ...(this._echoScreening || {}), ...Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])) };
    });
    if (on("availIv")) watch("availIv", collection(db, "interviews_availIv"), (snap) => {
      this.state.availIv = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().slots || {}]));
    });
    if (on("availCand")) watch("availCand", collection(db, "interviews_availCand"), (snap) => {
      this.state.availCand = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().slots || {}]));
      // the whole documents too (reply, replyAt), so a move copies everything
      this.state.availRaw = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    });
    if (on("scores")) watch("scores", collection(db, "interviews_scores"), (snap) => {
      this.state.scores = { ...(this._echoScores || {}), ...Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])) };
    });
    // Offer outcomes (admin only; firestore.rules refuses everyone else).
    if (on("offers")) watch("offers", collection(db, "interviews_offers"), (snap) => {
      this.state.offers = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    });
    if (on("meta")) watch("meta", collection(db, "interviews_meta"), (snap) => {
      const m = snap.docs.find((d) => d.id === "state");
      this.state.meta = { interviewsComplete: false, ...(m ? m.data() : {}) };
      const c = snap.docs.find((d) => d.id === "config");
      this.state.settings = { committee: [], chair: "", slots: [], oneDrive: "", ...(c ? c.data() : {}) };
      const a = snap.docs.find((d) => d.id === "allowed");
      this.state.allowedNames = a && Array.isArray(a.data().keys) ? a.data().keys : null;
      // H2/H4/H3: read by the same listener, so no new collection is subscribed
      const one = (id) => { const d = snap.docs.find((x) => x.id === id); return d ? d.data() : null; };
      this.state.questions = one("questions");
      this.state.schedule = one("schedule");
      this.state.passwordsMeta = one("passwords");
      this.metaLoaded = true;
      arrive();
    });
    // Candidates read the slots from the public, PII-free mirror doc.
    if (on("public")) watch("public", doc(db, "interviews_public", "slots"), (snap) => {
      const d = snap.data() || {};
      this.state.settings = { ...this.state.settings, slots: d.slots || [] };
      if (Array.isArray(d.times)) this.state.settings.times = d.times; else delete this.state.settings.times;
      this.state.publicInfo = { orgName: d.orgName || "", note: d.note || "", booking: d.booking || "open" };
      arrive();
    });
  }
  // -- the signed-in reviewer's own screening, read back from the server ----
  // Their flags and ratings used to be visible only in the browser they were
  // typed in, because reviewers had no read access at all: sign out, sign in
  // anywhere else, and their own review looked blank. The rules now allow a
  // `get` by exact id, so we subscribe to precisely "<member>~<candidateId>"
  // for each candidate and nothing else — the app never requests a colleague's
  // document. `list` is still admin-only, so the collation stays private.
  setMember(name) {
    if (this._member === name) return;
    this._member = name || null;
    this._syncOwnScreening();
  }
  _syncOwnScreening() {
    if (!this._ownScreening) return;               // admin/local: whole collection already watched
    const { onSnapshot } = this._fb;
    const want = new Set();
    if (this._member) for (const c of this.state.candidates) want.add(key(this._member, c.id));
    for (const [k, off] of this._own) if (!want.has(k)) { off(); this._own.delete(k); }
    for (const k of want) {
      if (this._own.has(k)) continue;
      const off = onSnapshot(this._doc("interviews_screening", k), (snap) => {
        if (this.screeningReadBack !== true) { this.screeningReadBack = true; }
        // A doc that doesn't exist yet means "not reviewed" — but don't wipe an
        // echo entry from before reviewers could read anything back.
        if (!snap.exists()) { this._emit(); return; }
        this.state.screening = { ...this.state.screening, [k]: snap.data() };
        if (this._echo) { this._echoScreening[k] = snap.data(); this._saveEcho(); }
        this._emit();
      }, (err) => {
        // Almost always "permission-denied" because firestore.rules hasn't been
        // published yet. Not fatal: the device mirror still shows their own
        // input, and the UI drops the "on any device" claim.
        //
        // Firestore tears the listener down on error and never retries, so drop
        // it from the map — otherwise a reviewer who had the tab open when the
        // rules were published stays stuck on the refused state until they
        // reload, and _syncOwnScreening would skip the key as already-watched.
        console.warn("own screening denied:", err && err.code);
        const off2 = this._own.get(k);
        if (off2) { try { off2(); } catch { /* already torn down */ } this._own.delete(k); }
        this.screeningReadBack = false;
        this._emit();
      });
      this._own.set(k, off);
    }
  }

  // -- echo mirror (reviewer's own screening/scores, per device) ------------
  _loadEcho() {
    try {
      const raw = JSON.parse(ls.get(ECHO_KEY) || "{}");
      this._echoScreening = raw.screening || {};
      this._echoScores = raw.scores || {};
      this.state.screening = { ...this._echoScreening };
      this.state.scores = { ...this._echoScores };
    } catch { this._echoScreening = {}; this._echoScores = {}; }
  }
  _saveEcho() {
    if (!this._echo) return;
    ls.set(ECHO_KEY, JSON.stringify({ screening: this._echoScreening, scores: this._echoScores }));
  }
  _doc(name, id) { const { db, doc } = this._fb; return doc(db, name, id); }
  // A new history document for a batch or transaction, stamped by the server.
  _histDoc(entry) {
    const { db, doc, collection, serverTimestamp } = this._fb;
    const { _id, ...data } = entry;
    return [_id ? doc(db, "interviews_history", _id) : doc(collection(db, "interviews_history")), { ...data, at: serverTimestamp() }];
  }
  // One write plus its history entry, together or not at all.
  async _withHistory(apply, history) {
    if (this._sdkFill) await this._sdkFill;
    const { db, writeBatch } = this._fb;
    const b = writeBatch(db);
    apply(b);
    const h = histOf(history);
    if (h) b.set(...this._histDoc(h));
    await b.commit();
  }
  async addHistory(entry) { await this._withHistory(() => {}, entry); }
  // One page of the history, newest first (a one-shot read, never a listener).
  async listHistory({ after = null, limit: n = 50 } = {}) {
    const { db, collection, query, orderBy, limit, startAfter, getDocs } = this._fb;
    const parts = [collection(db, "interviews_history"), orderBy("at", "desc")];
    if (after) parts.push(startAfter(after));
    parts.push(limit(n));
    const snap = await getDocs(query(...parts));
    const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return { entries, next: snap.docs.length === n ? snap.docs[snap.docs.length - 1] : null };
  }
  // Every document of every round collection, exactly as the server returns it
  // (backups, the restore preview and the close: never page state, which mixes
  // in this browser's echo and defaults). One-shot reads.
  async snapshotRaw() {
    const { db, collection, getDocs } = this._fb;
    const snaps = await Promise.all(ROUND_COLLECTIONS.map((n) => getDocs(collection(db, n))));
    const raw = {};
    ROUND_COLLECTIONS.forEach((n, i) => { raw[n] = Object.fromEntries(snaps[i].docs.map((d) => [d.id, d.data()])); });
    return quarantineRaw(raw);
  }
  // Some collections, fresh and unfiltered (the close's clear and put-back steps).
  async readCollections(names) {
    const { db, collection, getDocs } = this._fb;
    const snaps = await Promise.all(names.map((n) => getDocs(collection(db, n))));
    return Object.fromEntries(names.map((n, i) => [n, Object.fromEntries(snaps[i].docs.map((d) => [d.id, d.data()]))]));
  }
  clearLocalCopies() {
    super.clearLocalCopies();
    this._echoScreening = {}; this._echoScores = {};
  }
  async addCandidate(name, history) {
    const id = "c-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "");
    await this._withHistory((b) => b.set(this._doc("interviews_candidates", id), { name, removed: false, addedAt: this._fb.serverTimestamp() }),
      histOf(history, null, { id, name }));
    return id;
  }
  async setCandidateRemoved(id, removed, history) {
    await this._withHistory((b) => b.update(this._doc("interviews_candidates", id), { removed }), history);
  }
  // The echo is written optimistically so input appears instantly — but it MUST
  // be rolled back if the write fails, exactly as setAvail does. Without that, a
  // refused or dropped write leaves a rating on screen and in localStorage for
  // good while the server has nothing: a phantom that looks saved on this device
  // and is simply absent everywhere else. That is not hypothetical — it is how a
  // reviewer's screening came to "disappear" between sessions.
  async setScreening(member, candId, patch) {
    const { setDoc } = this._fb;
    const k = key(member, candId);
    const prevEcho = this._echo ? this._echoScreening[k] : undefined;
    const prevState = this.state.screening[k];
    if (this._echo) { // optimistic local echo so a reviewer sees their own input
      this._echoScreening[k] = { ...(this._echoScreening[k] || {}), member, candId, ...patch };
      this.state.screening = { ...this.state.screening, [k]: this._echoScreening[k] };
      this._saveEcho(); this._emit();
    }
    try {
      await setDoc(this._doc("interviews_screening", k), { member, candId, ...patch }, { merge: true });
    } catch (e) {
      this._rollback("screening", "_echoScreening", k, prevEcho, prevState);
      throw e;                       // the caller toasts; never claim it saved
    }
  }
  // put back exactly what was there before the optimistic write
  _rollback(field, echoField, k, prevEcho, prevState) {
    if (this._echo) {
      if (prevEcho === undefined) delete this[echoField][k]; else this[echoField][k] = prevEcho;
      this._saveEcho();
    }
    const next = { ...this.state[field] };
    if (prevState === undefined) delete next[k]; else next[k] = prevState;
    this.state[field] = next;
    this._emit();
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
    try { this.state.availCand = JSON.parse(ls.get(CAND_ECHO_KEY) || "{}"); } catch { this.state.availCand = {}; }
  }
  _saveCandEcho(who, map) {
    try {
      const all = JSON.parse(ls.get(CAND_ECHO_KEY) || "{}");
      all[who] = map; ls.set(CAND_ECHO_KEY, JSON.stringify(all));
    } catch { /* storage blocked — the server copy is still saved */ }
  }
  // Same rollback as setScreening, and it matters MORE here: scores are never
  // read back from the server for a reviewer, so this mirror is the only thing
  // that ever shows them their own answer. A phantom score would survive
  // unchallenged until leadership noticed the gap.
  async setScore(member, candId, patch) {
    const { setDoc } = this._fb;
    const k = key(member, candId);
    const prevEcho = this._echo ? this._echoScores[k] : undefined;
    const prevState = this.state.scores[k];
    if (this._echo) {
      const prev = this._echoScores[k] || { notes: {} };
      this._echoScores[k] = { ...prev, ...patch, member, candId, notes: { ...(prev.notes || {}), ...(patch.notes || {}) } };
      this.state.scores = { ...this.state.scores, [k]: this._echoScores[k] };
      this._saveEcho(); this._emit();
    }
    try {
      await setDoc(this._doc("interviews_scores", k), { member, candId, ...patch }, { merge: true });
    } catch (e) {
      this._rollback("scores", "_echoScores", k, prevEcho, prevState);
      throw e;
    }
  }
  async setMeta(patch, history) {
    await this._withHistory((b) => b.set(this._doc("interviews_meta", "state"), patch, { merge: true }), history);
  }
  // Admin only. One document per candidate; merge so changing the status never
  // drops the note (and vice versa). Shown optimistically, rolled back on a
  // refusal so the screen never claims an outcome the server did not keep.
  async setOffer(candId, patch, history) {
    const prev = this.state.offers[candId];
    this.state.offers = { ...this.state.offers, [candId]: { ...(prev || {}), ...patch } };
    this._emit();
    try {
      await this._withHistory((b) => b.set(this._doc("interviews_offers", candId), patch, { merge: true }), history);
    } catch (e) {
      const next = { ...this.state.offers };
      if (prev === undefined) delete next[candId]; else next[candId] = prev;
      this.state.offers = next; this._emit();
      throw e;
    }
  }
  // Admin only. The surname keys applicants may submit availability under; the
  // rules get() this document on every applicant write, so a name missing here
  // is refused rather than silently saved somewhere nobody reads.
  async setAllowedNames(keys) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_meta", "allowed"), { keys }, { mergeFields: ["keys"] });
  }
  // Applicant only. Applicants cannot READ the roster, so the only way to tell
  // them their name is unknown is to try a write and see if the rules allow it.
  //
  // The probe writes NOTHING — `{}` with merge carries no field paths, so the
  // rules still evaluate it (an unknown surname is refused, which is the whole
  // point) while an existing document is left exactly as it was.
  //
  // It used to send `{ slots: {} }`. That is NOT a no-op: an empty map has no
  // leaf paths of its own, so merge treats `slots` itself as the leaf and
  // REPLACES it — wiping every time the applicant had already picked. And this
  // fires on the way IN, every time they type their surname, which is every
  // visit after the browser tab has closed (the name lives in sessionStorage).
  // Worse, it was invisible: the applicant's own screen replays from the
  // per-device echo, so they still saw their old picks ticked while the server
  // held an empty map and the committee saw "waiting on" them.
  // Pinned by tests/applicant-availability.test.mjs.
  async checkName(key) {
    const { setDoc } = this._fb;
    try {
      await setDoc(this._doc("interviews_availCand", key), {}, { merge: true });
      return true;
    } catch (e) {
      if (e && e.code === "permission-denied") return false;
      throw e; // offline or misconfigured — the caller must not read that as "unknown name"
    }
  }
  async setSettings(patch, history) {
    // mergeFields (not merge:true): replace each written field wholesale. merge
    // deep-merges maps, so a deleted panelOverrides entry would never go away.
    // The PII-free slot list is mirrored to the public doc in the same batch.
    await this._withHistory((b) => {
      b.set(this._doc("interviews_meta", "config"), patch, { mergeFields: Object.keys(patch) });
      if ("slots" in patch) b.set(this._doc("interviews_public", "slots"),
        { slots: patch.slots || this.state.settings.slots || [] }, { merge: true });
    }, history);
  }
  // Read-modify-write of the committee config against the LATEST saved copy.
  // `mutate(config)` returns a patch; each patched field is replaced wholesale.
  // `history` may be a function of (saved config, patch), for undo data.
  async updateConfig(mutate, history) {
    const { db, runTransaction } = this._fb;
    const ref = this._doc("interviews_meta", "config");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const before = snap.exists() ? snap.data() : {};
      const patch = mutate(before);
      tx.set(ref, patch, { mergeFields: Object.keys(patch) });
      const h = histOf(history, before, patch);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  // Transactional: re-reads the saved config so two admins editing times at once
  // can't overwrite each other, and writes config + public mirror together.
  async updateTimes(defaults, mutate, history) {
    const { db, runTransaction } = this._fb;
    const cfgRef = this._doc("interviews_meta", "config"), pubRef = this._doc("interviews_public", "slots");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(cfgRef);
      const before = snap.exists() ? snap.data() : {};
      const next = applyTimes(before, defaults, mutate);
      tx.set(cfgRef, next, { mergeFields: ["times", "panelOverrides"] });
      tx.set(pubRef, { times: next.times }, { mergeFields: ["times"] });
      const h = histOf(history, before, next);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  async updateQuestions(mutate, history) {
    const { db, runTransaction, serverTimestamp } = this._fb;
    const ref = this._doc("interviews_meta", "questions");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const before = snap.exists() ? snap.data() : null;
      const next = mutate(before);
      tx.set(ref, { ...next, updatedAt: serverTimestamp() });
      const h = histOf(history, before, next);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  now() { return this._fb.serverTimestamp(); }
  tsFromMillis(ms) { return this._fb.Timestamp.fromMillis(ms); }
  decode(v) {
    const T = this._fb.Timestamp;
    const walk = (x) => (x === null || typeof x !== "object" ? x : Array.isArray(x) ? x.map(walk)
      : typeof x.__ts === "string" && Object.keys(x).length === 1 ? T.fromDate(new Date(x.__ts))
      : Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])));
    return walk(v);
  }
  _fsPatch(patch) {
    const { deleteField } = this._fb;
    return Object.fromEntries(Object.entries(patch || {}).map(([k, v]) => [k, isDel(v) ? deleteField() : v]));
  }
  // H4: one transaction on interviews_meta/state (each returned field replaced
  // whole), plus the public booking flag and candidate patches, plus history.
  async updateState(mutate, history, extra = {}) {
    const { db, runTransaction } = this._fb;
    const ref = this._doc("interviews_meta", "state");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const before = snap.exists() ? snap.data() : {};
      const patch = mutate(before);
      if (Object.keys(patch).length) tx.set(ref, this._fsPatch(patch), { mergeFields: Object.keys(patch) });
      if (extra.public) tx.set(this._doc("interviews_public", "slots"), extra.public, { mergeFields: Object.keys(extra.public) });
      Object.entries(extra.candidates || {}).forEach(([id, p]) => tx.update(this._doc("interviews_candidates", id), this._fsPatch(p)));
      const h = histOf(history, before, patch);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  async updateSchedule(mutate, history) {
    const { db, runTransaction } = this._fb;
    const ref = this._doc("interviews_meta", "schedule");
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const before = snap.exists() ? snap.data() : null;
      const next = mutate(before);
      tx.set(ref, next);
      const h = histOf(history, before, next);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  async setCandidates(patches, history) {
    await this._withHistory((b) => Object.entries(patches || {}).forEach(([id, p]) =>
      b.update(this._doc("interviews_candidates", id), this._fsPatch(p))), history);
  }
  // H5/H14/H1: apply a plan. One batch when it fits in 450 operations; otherwise
  // chunks in order, and every copy comes before the delete of its source, so a
  // failure part way can leave a duplicate but never lose anything.
  async applyPlan(plan, history, { onProgress } = {}) {
    const { db, writeBatch } = this._fb;
    const ops = [];
    (plan.writes || []).forEach((w) => ops.push((b) => (w.mergeFields ? b.set(this._doc(w.coll, w.id), w.data, { mergeFields: w.mergeFields })
      : b.set(this._doc(w.coll, w.id), w.data))));
    Object.entries(plan.candidates || {}).forEach(([id, p]) => {
      const patch = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === null ? DEL : v]));
      ops.push((b) => b.update(this._doc("interviews_candidates", id), this._fsPatch(patch)));
    });
    if (plan.overrides && Object.keys(plan.overrides).length) {
      const ov = { ...((this.state.settings || {}).panelOverrides || {}) };
      Object.entries(plan.overrides).forEach(([k, v]) => { if (v) ov[k] = v; else delete ov[k]; });
      ops.push((b) => b.set(this._doc("interviews_meta", "config"), { panelOverrides: ov }, { mergeFields: ["panelOverrides"] }));
    }
    if (plan.schedulePanels && Object.keys(plan.schedulePanels).length && this.state.schedule) {
      const sp = { ...(this.state.schedule.panels || {}) };
      Object.entries(plan.schedulePanels).forEach(([k, v]) => { if (v) sp[k] = v; else delete sp[k]; });
      ops.push((b) => b.set(this._doc("interviews_meta", "schedule"), { panels: sp }, { mergeFields: ["panels"] }));
    }
    (plan.deletes || []).forEach((d) => ops.push((b) => b.delete(this._doc(d.coll, d.id))));
    const h = histOf(history);
    if (h) ops.push((b) => b.set(...this._histDoc(h)));
    const CHUNK = 450;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const b = writeBatch(db);
      ops.slice(i, i + CHUNK).forEach((op) => op(b));
      await b.commit();
      if (onProgress) onProgress(Math.min(i + CHUNK, ops.length), ops.length);
    }
  }
  // ---- R6: the close-round flow. EVERY write it makes goes through closeTx
  // (review 3 M1): a transaction that re-reads state and the attempt and goes
  // on only if this page (tab AND load) holds the close and the attempt has the
  // status this step expects; every state write carries a fresh lease claim
  // and every attempt write a fresh owner claim (the rules check both).
  async getStateFresh() {
    const { getDoc } = this._fb;
    const snap = await getDoc(this._doc("interviews_meta", "state"));
    return snap.exists() ? snap.data() : {};
  }
  _claim(ctx) { return { tab: ctx.tab, load: ctx.load, at: this._fb.serverTimestamp() }; }
  async startClose(ctx, attemptId) {
    const { db, runTransaction, serverTimestamp } = this._fb;
    const stRef = this._doc("interviews_meta", "state");
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(stRef);
      const st = snap.exists() ? snap.data() : {};
      if (st.closingTab || st.roundStatus === "closing") throw new TookOver();
      if ((st.keptFromClose || []).length) throw new Error("Decide about the kept items first.");
      tx.set(stRef, { roundStatus: "closing", closingAttemptId: attemptId, closingStartedAt: serverTimestamp(), closingTab: ctx.tab, lease: this._claim(ctx) },
        { mergeFields: ["roundStatus", "closingAttemptId", "closingStartedAt", "closingTab", "lease"] });
      tx.set(this._doc("interviews_public", "slots"), { booking: "paused" }, { mergeFields: ["booking"] });
      return st;
    });
  }
  // After a reload (same page id, new load nonce): a holder write with the new claim.
  async reclaim(ctx) {
    const { db, runTransaction } = this._fb;
    const stRef = this._doc("interviews_meta", "state");
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(stRef);
      const st = snap.exists() ? snap.data() : {};
      if (st.closingTab !== ctx.tab) throw new TookOver();
      tx.set(stRef, { lease: this._claim(ctx) }, { mergeFields: ["lease"] });
      return st;
    });
  }
  // Take over a stale close. The rules refuse it while the lease is under 5
  // minutes old by the server's clock (permission-denied).
  async takeover(ctx, attemptId) {
    const { db, runTransaction } = this._fb;
    const stRef = this._doc("interviews_meta", "state");
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(stRef);
      const st = snap.exists() ? snap.data() : {};
      if (st.roundStatus !== "closing" || (st.closingAttemptId || null) !== (attemptId || null)) throw new TookOver();
      tx.set(stRef, { closingTab: ctx.tab, lease: this._claim(ctx) }, { mergeFields: ["closingTab", "lease"] });
      return st;
    });
  }
  async closeTx(ctx, expect, fn) {
    const { db, runTransaction, doc } = this._fb;
    const stRef = this._doc("interviews_meta", "state");
    const attRef = ctx.attemptId ? this._doc("interviews_archive", ctx.attemptId) : null;
    return runTransaction(db, async (tx) => {
      const [ss, as] = await Promise.all([tx.get(stRef), attRef ? tx.get(attRef) : Promise.resolve(null)]);
      const st = ss.exists() ? ss.data() : {};
      const att = as && as.exists() ? as.data() : null;
      const lease = st.lease && typeof st.lease === "object" ? st.lease : {};
      if (st.closingTab !== ctx.tab || lease.load !== ctx.load || (st.closingAttemptId || null) !== (ctx.attemptId || null)) throw new TookOver();
      if (expect && !expect.includes(att ? att.status : "missing")) throw new TookOver();
      const claim = this._claim(ctx);
      let wroteState = false;
      const w = {
        claim, st, att,
        state: (patch) => { wroteState = true; tx.set(stRef, { ...this._fsPatch(patch), lease: claim }, { mergeFields: [...Object.keys(patch), "lease"] }); },
        stateReplace: (d) => { wroteState = true; tx.set(stRef, { ...d, lease: claim }); },
        attempt: (patch, id = ctx.attemptId) => tx.set(this._doc("interviews_archive", id), { ...patch, owner: claim }, { mergeFields: [...Object.keys(patch), "owner"] }),
        attemptCreate: (id, d) => tx.set(this._doc("interviews_archive", id), { ...d, owner: claim }),
        attemptDelete: (id) => tx.delete(this._doc("interviews_archive", id)),
        part: (i, json) => tx.set(doc(db, "interviews_archive", ctx.attemptId, "parts", String(i)), { i, json }),
        partDelete: (id, i) => tx.delete(doc(db, "interviews_archive", id, "parts", String(i))),
        set: (coll, id, data, opts) => (opts ? tx.set(this._doc(coll, id), data, opts) : tx.set(this._doc(coll, id), data)),
        del: (coll, id) => tx.delete(this._doc(coll, id)),
        get: async (coll, id) => { const x = await tx.get(this._doc(coll, id)); return x.exists() ? x.data() : null; },
        history: (e) => tx.set(...this._histDoc(e)),
      };
      const r = await fn(w);
      if (!wroteState) tx.set(stRef, { lease: claim }, { mergeFields: ["lease"] });
      return r;
    });
  }
  async listArchive() {
    const { db, collection, getDocs } = this._fb;
    return (await getDocs(collection(db, "interviews_archive"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  async readAttempt(id) {
    const { getDoc } = this._fb;
    const s = await getDoc(this._doc("interviews_archive", id));
    return s.exists() ? s.data() : null;
  }
  async readParts(id) {
    const { db, collection, getDocs } = this._fb;
    return (await getDocs(collection(db, "interviews_archive", id, "parts"))).docs.map((d) => d.data());
  }
  // Parts first, then the attempt (the rules allow it only for copies, or a
  // closed round past its keep-until date).
  async deleteArchive(id) {
    const { db, collection, getDocs, writeBatch, deleteDoc } = this._fb;
    const parts = await getDocs(collection(db, "interviews_archive", id, "parts"));
    if (parts.docs.length) { const b = writeBatch(db); parts.docs.forEach((d) => b.delete(d.ref)); await b.commit(); }
    await deleteDoc(this._doc("interviews_archive", id));
  }
  async updateArchive(id, patch, history) {
    await this._withHistory((b) => b.update(this._doc("interviews_archive", id), patch), history);
  }
  // "Download and delete them" / "Keep them in this round" for kept items.
  async keptDecision(deleteThem, list, history) {
    await this._withHistory((b) => {
      if (deleteThem) list.filter((k) => k.coll !== "interviews_history").forEach((k) => b.delete(this._doc(k.coll, k.id)));
      b.set(this._doc("interviews_meta", "state"), { keptFromClose: [], keptFromAttempt: null }, { mergeFields: ["keptFromClose", "keptFromAttempt"] });
    }, history);
  }

  // ---- H11: applicant notices and replies
  // The applicant's own notice: ONE get by their own key (never a listener,
  // never a list; the rules allow nothing else).
  async getMyNotice(key) {
    const { getDoc } = this._fb;
    const snap = await getDoc(this._doc("interviews_applicant", key));
    return snap.exists() ? snap.data() : null;
  }
  async setReply(key, reply) {
    const { setDoc, serverTimestamp } = this._fb;
    await setDoc(this._doc("interviews_availCand", key), { reply, replyAt: serverTimestamp() }, { merge: true });
    this._saveReplyEcho(key, { reply, at: new Date().toISOString() });
  }
  // Re-read the public times document once (the booking flag can be a moment
  // behind the listener when a write is refused).
  async refreshPublic() {
    const { getDoc } = this._fb;
    const snap = await getDoc(this._doc("interviews_public", "slots"));
    const b = ((snap.exists() && snap.data()) || {}).booking || "open";
    const was = (this.state.publicInfo || {}).booking;
    this.state.publicInfo = { ...(this.state.publicInfo || {}), booking: b };
    if (b !== was) this._emit();
    return b;
  }
  // Admin: write the notices that changed, delete the ones nobody should
  // see any more, stamp schedule.publishedAt, and log it, in one batch.
  async publishNotices(desired, history) {
    const { db, collection, getDocs, writeBatch, serverTimestamp } = this._fb;
    const snap = await getDocs(collection(db, "interviews_applicant"));
    const cur = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    const strip = (x) => { const { publishedAt, ...rest } = x || {}; return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])); };
    const b = writeBatch(db), res = { sent: 0, updated: 0, removed: 0 };
    Object.entries(desired).forEach(([k, n]) => {
      if (cur[k] && strip(cur[k]) === strip(n)) return;
      if (cur[k]) res.updated++; else res.sent++;
      b.set(this._doc("interviews_applicant", k), { ...n, publishedAt: serverTimestamp() });
    });
    Object.keys(cur).filter((k) => !desired[k]).forEach((k) => { res.removed++; b.delete(this._doc("interviews_applicant", k)); });
    b.set(this._doc("interviews_meta", "schedule"), { publishedAt: serverTimestamp() }, { mergeFields: ["publishedAt"] });
    const h = histOf(history, null, res);
    if (h) b.set(...this._histDoc(h));
    await b.commit();
    return res;
  }
  async txDoc(coll, id, mutate, history) {
    const { db, runTransaction } = this._fb;
    const ref = this._doc(coll, id);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const next = mutate(snap.exists() ? snap.data() : null);
      if (next == null) tx.delete(ref); else tx.set(ref, next);
      const h = histOf(history);
      if (h) tx.set(...this._histDoc(h));
    });
  }
  // push the current list to the PII-free public doc (self-heal for dates
  // that were only ever written to the committee config)
  async syncPublicSlots(pub) {
    const { setDoc } = this._fb;
    await setDoc(this._doc("interviews_public", "slots"), pub, { mergeFields: Object.keys(pub) });
  }
}
