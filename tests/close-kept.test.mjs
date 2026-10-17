// R6 review: items kept by a close. A kept item is identified by its hash, so
// an id the next round reuses (availability under the same member or surname)
// is the new round's once it changes; history written after the copy goes
// with the closed round; a "Try again" never counts an item twice; Replace
// and Bring back wait for the decision about kept items; a file from before
// rounds can add missing items to a round brought back from such a file.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  sessionStorage: { getItem: (k) => mem.get("s:" + k) ?? null, setItem: (k, v) => mem.set("s:" + k, String(v)), removeItem: (k) => mem.delete("s:" + k) },
  addEventListener() {} };
globalThis.document = { getElementById: () => null, addEventListener() {}, visibilityState: "visible" };
if (!globalThis.navigator) globalThis.navigator = { userAgent: "node", maxTouchPoints: 0 };

const { FirestoreStore } = await import("../js/store.js");
const { createRounds, TIMING } = await import("../js/rounds.js");
const { planRestore, buildBackup } = await import("../js/backup.js");
const { memFirestore } = await import("./helpers/memfirestore.mjs");

function seedRound(m) {
  m.seed("interviews_meta/config", { committee: [{ name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }], chair: "Abara", times: [], slots: [] });
  m.seed("interviews_meta/state", { interviewsComplete: true, roundId: "r-1", roundName: "Hiring round 2027" });
  m.seed("interviews_public/slots", { times: [], slots: [], booking: "open" });
  m.seed("interviews_candidates/c-1", { name: "Dr Rosalind Ashcombe", removed: false });
  m.seed("interviews_availIv/Bruns", { slots: { t0: "ip" } });
  m.seed("interviews_history/h1", { at: "x", by: "leadership", action: "schedule.lock", text: "Locked" });
}
const rounds = (m, store) => createRounds({ store: () => store, state: () => ({ meta: m.read("interviews_meta/state") }), byWho: () => "leadership",
  release: "test", roundName: () => "Hiring round 2027", retentionMonths: () => 24, downloadText() {}, backupName: () => "x", excelFromData() {},
  rerender() {}, onActive() {} });

test("a kept item counts as kept only while it is that document; history after the copy goes with the closed round", async () => {
  const m = memFirestore(); seedRound(m);
  const store = new FirestoreStore(m.fb, {});
  const r = rounds(m, store);
  await r._steps.pause();
  // changed after the copy: Bruns's availability and a history entry
  m.seed("interviews_availIv/Bruns", { slots: { t0: "ip", t1: "zoom" } });
  m.seed("interviews_history/h-late", { at: "y", by: "leadership", action: "settings.save", text: "Late change" });
  await r._steps.clear();
  const st = m.read("interviews_meta/state");
  assert.equal(st.keptFromClose.length, 1);
  assert.equal(st.keptFromClose[0].id, "Bruns");
  assert.ok(st.keptFromClose[0].hash, "no hash on the kept item");
  assert.equal(st.keptFromAttempt, r._C.attemptId);
  // the late history entry left the new round and is on the closed round's copy
  assert.equal(m.read("interviews_history/h-late"), undefined);
  const att = m.read(`interviews_archive/${r._C.attemptId}`);
  assert.deepEqual(att.keptHistory.map((h) => h.id), ["h-late"]);
  // while unchanged it is hidden from the new round
  assert.equal((await store.snapshotRaw()).interviews_availIv.Bruns, undefined);
  // Bruns answers again in the new round (same id): it is the new round's now
  m.seed("interviews_availIv/Bruns", { slots: { n0: "ip" } });
  assert.deepEqual((await store.snapshotRaw()).interviews_availIv.Bruns, { slots: { n0: "ip" } });
});

test("clearing again after a stop part way never lists an item twice", async () => {
  const m = memFirestore(); seedRound(m);
  const store = new FirestoreStore(m.fb, {});
  const r = rounds(m, store);
  await r._steps.pause();
  m.seed("interviews_availIv/Bruns", { slots: { t1: "zoom" } });
  let n = 0;
  r.hooks.beforeChunk = async () => { if (n++ === 0) throw new Error("connection dropped"); };
  await r._steps.clear();                       // stops part way
  assert.equal(m.read("interviews_meta/state").roundStatus, "closing");
  r.hooks.beforeChunk = null;
  await r._steps.clear(true);                   // Try again
  const st = m.read("interviews_meta/state");
  assert.equal(st.roundStatus, "open");
  assert.equal(st.keptFromClose.length, 1);
});

test("Replace and Bring back wait for the decision about kept items", async () => {
  const live = { interviews_meta: { state: { roundId: "r-2", keptFromClose: [{ coll: "interviews_availIv", id: "Bruns", hash: "x" }] } } };
  const file = await buildBackup({ interviews_meta: { state: { roundId: "r-1" } }, interviews_candidates: { "c-1": { name: "Dr A" } } }, {});
  const p = planRestore(file, live, "replace", { newRoundId: "r-3" });
  assert.equal(p.ok, false);
  assert.match(p.why, /kept from the last close/);
});

test("a file from before rounds can add missing items to a round brought back from such a file", async () => {
  const file = await buildBackup({ interviews_meta: { state: {} }, interviews_candidates: { "c-1": { name: "Dr A" } } }, {});
  file.round = { ...(file.round || {}), id: null };
  const live = { interviews_meta: { state: { roundId: "r-9", broughtBackFrom: "before-rounds" } } };
  assert.equal(planRestore(file, live, "missing", {}).ok, true);
  const other = { interviews_meta: { state: { roundId: "r-9" } } };
  assert.equal(planRestore(file, other, "missing", {}).ok, false);
});

test("history kept after the copy is limited by bytes too (the attempt document stays under 1 MiB)", async () => {
  const m = memFirestore(); seedRound(m);
  const store = new FirestoreStore(m.fb, {});
  const r = rounds(m, store);
  const keep = TIMING.keptHistoryBytes;
  TIMING.keptHistoryBytes = 200;
  try {
    await r._steps.pause();
    m.seed("interviews_history/h-late", { at: "y", by: "leadership", action: "settings.save", text: "x".repeat(400) });
    await r._steps.clear();
    assert.equal(m.read("interviews_meta/state").roundStatus, "closing", "closed with too much kept history");
    assert.ok(m.read("interviews_history/h-late"), "late history was deleted");
  } finally { TIMING.keptHistoryBytes = keep; r._steps.setActive(false); }
});
