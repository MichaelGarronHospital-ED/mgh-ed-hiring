// store.snapshotRaw() reads the server fresh (review M1): never page state. The
// Admin store mixes this browser's echo into its state; the backup must
// not. Stub Firestore, no emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreStore, OFFLINE_READ } from "../js/store.js";
import { buildBackup, ROUND_COLLECTIONS } from "../js/backup.js";

// a localStorage for the store's echo (util.js reads window.localStorage)
const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };

function stub(server) {
  const asked = [];
  const fb = {
    db: {},
    collection: (_db, name) => ({ __coll: name }),
    doc: (_db, name, id) => ({ __path: `${name}/${id}` }),
    onSnapshot: () => () => {},
    getDocs: async (ref) => {
      asked.push(ref.__coll);
      const docs = Object.entries(server[ref.__coll] || {}).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) }));
      return { docs };
    },
    setDoc: async () => {}, updateDoc: async () => {}, runTransaction: async () => {}, deleteField: () => "DEL",
  };
  return { fb, asked };
}

test("an entry that exists only in this browser's echo is absent from the backup", async () => {
  mem.set("ed_iv_echo_v1", JSON.stringify({ screening: { "Yang~c-9": { rating: 5 } }, scores: { "Yang~c-9": { overall: 4.9 } } }));
  const server = {
    interviews_screening: { "Marrocco~c-1": { member: "Marrocco", candId: "c-1", rating: 3, flag: false } },
    interviews_scores: { "Marrocco~c-1": { member: "Marrocco", candId: "c-1", overall: 4.1, notes: { 0: "x" } } },
    interviews_availCand: { ashcombe: { slots: { t1: "ip" }, reply: "withdrawn" } },
    interviews_meta: { config: { flagThreshold: 2 } },
  };
  const { fb, asked } = stub(server);
  const s = new FirestoreStore(fb, { echo: true });
  assert.ok(s.getState().screening["Yang~c-9"], "the echo IS in page state (that is the trap)");
  const r = await s.snapshotRaw();
  assert.deepEqual([...asked].sort(), [...ROUND_COLLECTIONS].sort(), "one one-shot read per round collection");
  assert.equal(r.interviews_screening["Yang~c-9"], undefined);
  assert.equal(r.interviews_scores["Yang~c-9"], undefined);
  const b = await buildBackup(r);
  assert.equal(JSON.stringify(b).includes("Yang~c-9"), false);
});

test("every raw field survives, reply included, and no defaults are added", async () => {
  const server = {
    interviews_availCand: { ashcombe: { slots: { t1: "ip" }, reply: "confirmed", futureField: 7 } },
    interviews_meta: { config: { flagThreshold: 2 }, state: { interviewsComplete: true } },
  };
  const { fb } = stub(server);
  const s = new FirestoreStore(fb, {});
  const r = await s.snapshotRaw();
  assert.deepEqual(r.interviews_availCand.ashcombe, { slots: { t1: "ip" }, reply: "confirmed", futureField: 7 });
  assert.deepEqual(r.interviews_meta.config, { flagThreshold: 2 });   // no committee/chair/slots defaults
  assert.deepEqual(r.interviews_meta.state, { interviewsComplete: true });
  assert.deepEqual(r.interviews_offers, {});
});

// R15: a backup must reflect the server. Offline, plain getDocs answers from
// what this page's listeners hold in memory, so snapshotRaw reads with
// getDocsFromServer, refuses an answer from the cache, and never reads at all
// while the browser says it is offline. The refusal is an "offline-read" with
// plain words, never a quiet cache copy.
const withOnline = async (onLine, fn) => {
  const keep = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine }, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(globalThis, "navigator", keep); }
};
const refused = (e) => e && e.code === "offline-read" && e.message === OFFLINE_READ;

test("OFFLINE_READ is plain words (no em dash)", () => {
  assert.equal(OFFLINE_READ, "You seem to be offline. Connect and try again.");
  assert.ok(!OFFLINE_READ.includes("—"));
});

test("snapshotRaw reads from the server when it can (getDocsFromServer, never getDocs)", async () => {
  const server = { interviews_candidates: { "c-1": { name: "Dr Rosalind Ashcombe", removed: false } } };
  const { fb, asked } = stub(server);
  const fromServer = [], server_ = fb.getDocs;
  fb.getDocsFromServer = async (ref) => { fromServer.push(ref.__coll); return server_(ref); };
  const s = new FirestoreStore(fb, {});
  fb.getDocs = async () => { throw new Error("getDocs used for a backup"); };
  const r = await withOnline(true, () => s.snapshotRaw());
  assert.deepEqual([...fromServer].sort(), [...ROUND_COLLECTIONS].sort());
  assert.equal(asked.length, ROUND_COLLECTIONS.length, "each collection read once, through the server read");
  assert.equal(r.interviews_candidates["c-1"].name, "Dr Rosalind Ashcombe");
});

test("offline: the server read fails, so the backup is refused, not made from memory", async () => {
  const { fb } = stub({ interviews_candidates: { "c-1": { name: "x", removed: false } } });
  fb.getDocsFromServer = async () => { const e = new Error("Failed to get documents from server."); e.code = "unavailable"; throw e; };
  const s = new FirestoreStore(fb, {});
  await assert.rejects(withOnline(true, () => s.snapshotRaw()), refused);
});

test("the browser says it is offline: refused before any read", async () => {
  const { fb, asked } = stub({});
  let tried = 0;
  fb.getDocsFromServer = async (ref) => { tried++; return fb.getDocs(ref); };
  const s = new FirestoreStore(fb, {});
  await assert.rejects(withOnline(false, () => s.snapshotRaw()), refused);
  assert.equal(tried + asked.length, 0, "it read anyway");
});

test("an older page that hands over only getDocs: an answer from the cache is refused", async () => {
  const { fb } = stub({});
  fb.getDocs = async () => ({ docs: [], metadata: { fromCache: true } });
  const s = new FirestoreStore(fb, {});
  await assert.rejects(withOnline(true, () => s.snapshotRaw()), refused);
  // and the same answer from the server is fine
  fb.getDocs = async () => ({ docs: [], metadata: { fromCache: false } });
  const r = await withOnline(true, () => s.snapshotRaw());
  assert.deepEqual(r.interviews_candidates, {});
});

test("any other failure is passed on as it is (not called offline)", async () => {
  const { fb } = stub({});
  fb.getDocsFromServer = async () => { const e = new Error("Missing or insufficient permissions."); e.code = "permission-denied"; throw e; };
  const s = new FirestoreStore(fb, {});
  await assert.rejects(withOnline(true, () => s.snapshotRaw()), (e) => e.code === "permission-denied");
});
