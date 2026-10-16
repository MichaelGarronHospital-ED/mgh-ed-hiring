// What a close may delete (review 2 B1): only the eight working-round
// collections, never interviews_meta, interviews_public or interviews_archive.
// The list is checked, and then a whole close is driven through the real flow
// (rounds.js + FirestoreStore) on an in-memory stand-in, with every delete it
// makes recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLEAR_COLLECTIONS, ROUND_COLLECTIONS } from "../js/backup.js";

// rounds.js touches the page only through these
const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  sessionStorage: { getItem: (k) => mem.get("s:" + k) ?? null, setItem: (k, v) => mem.set("s:" + k, String(v)), removeItem: (k) => mem.delete("s:" + k) },
  addEventListener() {} };
globalThis.document = { getElementById: () => null, addEventListener() {}, visibilityState: "visible" };
if (!globalThis.navigator) globalThis.navigator = { userAgent: "node", maxTouchPoints: 0 };

const { FirestoreStore } = await import("../js/store.js");
const { createRounds } = await import("../js/rounds.js");
const { memFirestore } = await import("./helpers/memfirestore.mjs");

test("CLEAR_COLLECTIONS never contains meta, public or archive, and is part of what a backup holds", () => {
  for (const c of ["interviews_meta", "interviews_public", "interviews_archive"]) assert.ok(!CLEAR_COLLECTIONS.includes(c), c);
  CLEAR_COLLECTIONS.forEach((c) => assert.ok(ROUND_COLLECTIONS.includes(c), c));
  assert.equal(CLEAR_COLLECTIONS.length, 8);
  assert.ok(Object.isFrozen(CLEAR_COLLECTIONS));
});

function seedRound(m) {
  const committee = [{ name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" }];
  m.seed("interviews_meta/config", { committee, chair: "Abara", times: [{ id: "t0", date: "2027-03-03", start: "09:00", end: "10:00" }],
    slots: [], panelOverrides: { "c-1": { slot: "t0", members: ["Abara", "Bruns", "Chen"] } }, oneDrive: "#", flagThreshold: 2, retentionMonths: 24 });
  m.seed("interviews_meta/state", { interviewsComplete: true, roundId: "r-1", roundName: "Hiring round 2027" });
  m.seed("interviews_meta/questions", { version: 1, questions: [{ id: "0", text: "Q" }] });
  m.seed("interviews_meta/passwords", { ed: { changedAt: "x" } });
  m.seed("interviews_meta/allowed", { keys: ["ashcombe"] });
  m.seed("interviews_meta/schedule", { locked: true, panels: {} });
  m.seed("interviews_public/slots", { times: [{ id: "t0" }], slots: [], booking: "open" });
  m.seed("interviews_candidates/c-1", { name: "Dr Rosalind Ashcombe", removed: false });
  m.seed("interviews_screening/Bruns~c-1", { member: "Bruns", candId: "c-1", rating: 4 });
  m.seed("interviews_scores/Abara~c-1", { member: "Abara", candId: "c-1", overall: 4.2 });
  m.seed("interviews_availIv/Abara", { slots: { t0: "ip" } });
  m.seed("interviews_availCand/ashcombe", { slots: { t0: "ip" }, reply: "confirmed" });
  m.seed("interviews_offers/c-1", { status: "offered" });
  m.seed("interviews_applicant/ashcombe", { date: "2027-03-03" });
  m.seed("interviews_history/h1", { at: "x", by: "leadership", action: "schedule.lock", text: "Locked" });
}

test("a whole close deletes only in the eight collections; meta and public are reset field by field, never deleted", async () => {
  const m = memFirestore();
  seedRound(m);
  const store = new FirestoreStore(m.fb, {});
  const before = { config: m.read("interviews_meta/config"), questions: m.read("interviews_meta/questions"), passwords: m.read("interviews_meta/passwords") };
  const r = createRounds({ store: () => store, state: () => ({ meta: m.read("interviews_meta/state") }), byWho: () => "leadership", release: "test",
    roundName: () => "Hiring round 2027", retentionMonths: () => 24, downloadText() {}, backupName: () => "x", excelFromData() {}, rerender() {}, onActive() {} });
  await r._steps.pause();
  assert.equal(m.read("interviews_meta/state").roundStatus, "closing");
  assert.equal(m.read("interviews_public/slots").booking, "paused");
  const att = r._C.attemptId;
  assert.equal(m.read(`interviews_archive/${att}`).status, "saved");
  await r._steps.clear();
  for (const p of m.log.deletes) {
    const coll = p.split("/")[0];
    assert.ok(CLEAR_COLLECTIONS.includes(coll), `the close deleted ${p}`);
  }
  assert.ok(m.log.deletes.length >= 8, `${m.log.deletes.length} deletes`);
  for (const c of CLEAR_COLLECTIONS) assert.equal([...m.docs.keys()].filter((p) => p.startsWith(c + "/") && !p.startsWith("interviews_history/")).length, 0, c);
  // meta and public: present, reset, and the kept settings exactly as before
  const cfg = m.read("interviews_meta/config");
  assert.deepEqual(cfg.times, []); assert.deepEqual(cfg.slots, []); assert.deepEqual(cfg.panelOverrides, {});
  for (const k of ["committee", "chair", "oneDrive", "flagThreshold", "retentionMonths"]) assert.deepEqual(cfg[k], before.config[k], k);
  assert.deepEqual(m.read("interviews_meta/questions"), before.questions);
  assert.deepEqual(m.read("interviews_meta/passwords"), before.passwords);
  assert.deepEqual(m.read("interviews_meta/allowed"), { keys: [] });
  assert.deepEqual(m.read("interviews_public/slots"), { times: [], slots: [], booking: "open" });
  const st = m.read("interviews_meta/state");
  assert.equal(st.roundStatus, "open"); assert.equal(st.closingTab, null); assert.notEqual(st.roundId, "r-1");
  assert.equal(m.read(`interviews_archive/${att}`).status, "closed");
  // only the close's own summary entry is in the new round's history
  const hist = [...m.docs.keys()].filter((p) => p.startsWith("interviews_history/"));
  assert.equal(hist.length, 1);
  assert.equal(m.read(hist[0]).action, "round.close");
});

test("a page that no longer holds the close changes nothing (closeTx refuses before writing)", async () => {
  const m = memFirestore();
  seedRound(m);
  const store = new FirestoreStore(m.fb, {});
  const r = createRounds({ store: () => store, state: () => ({ meta: m.read("interviews_meta/state") }), byWho: () => "leadership", release: "test",
    roundName: () => "Hiring round 2027", retentionMonths: () => null, downloadText() {}, backupName: () => "x", excelFromData() {}, rerender() {}, onActive() {} });
  await r._steps.pause();
  // another page takes over (its own tab id)
  m.seed("interviews_meta/state", { ...m.read("interviews_meta/state"), closingTab: "p-other", lease: { tab: "p-other", load: "l-x", at: "now" } });
  const sets = m.log.sets.length, dels = m.log.deletes.length;
  await r._steps.clear();
  assert.equal(m.log.deletes.length, dels, "a stale page deleted something");
  assert.equal(m.log.sets.length, sets, "a stale page wrote something");
  assert.equal(r.active, false);
});
