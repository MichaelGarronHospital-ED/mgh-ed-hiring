// store.snapshotRaw() reads the server fresh (review M1): never page state. The
// leadership store mixes this browser's echo into its state; the backup must
// not. Stub Firestore, no emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreStore } from "../js/store.js";
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
