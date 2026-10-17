// R6 review M4: twins of one tab. A tab duplicated BEFORE a close shares the
// tab id (sessionStorage is copied); when its twin starts a close, the idle copy
// must stay read-only, never carry the close on as if it had reloaded. And a
// page that really reloaded mid-close must not stand down from its own close
// when one snapshot still shows its claim from before the reload.
// (Each `import("../js/rounds.js?copy=X")` is a separate module instance: a
// separate page load with its own nonce, sharing sessionStorage.)
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  sessionStorage: { getItem: (k) => mem.get("s:" + k) ?? null, setItem: (k, v) => mem.set("s:" + k, String(v)), removeItem: (k) => mem.delete("s:" + k) },
  addEventListener() {} };
globalThis.document = { getElementById: () => null, addEventListener() {}, visibilityState: "visible" };
if (!globalThis.navigator) globalThis.navigator = { userAgent: "node", maxTouchPoints: 0 };

const { FirestoreStore } = await import("../js/store.js");
const { memFirestore } = await import("./helpers/memfirestore.mjs");

function seed(m) {
  m.seed("interviews_meta/config", { committee: [{ name: "Abara" }], times: [] });
  m.seed("interviews_meta/state", { roundId: "r-1", roundName: "Hiring round 2027" });
  m.seed("interviews_public/slots", { times: [], booking: "open" });
  m.seed("interviews_candidates/c-1", { name: "Dr A", removed: false });
}
const deps = (m, store) => ({ store: () => store, state: () => ({ meta: m.read("interviews_meta/state") }), byWho: () => "leadership", release: "t",
  roundName: () => "Hiring round 2027", retentionMonths: () => 24, downloadText() {}, backupName: () => "x", excelFromData() {}, rerender() {}, onActive() {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a twin made before the close stays read-only when the other copy starts closing", async () => {
  mem.clear();
  const m = memFirestore(); seed(m);
  const store = new FirestoreStore(m.fb, {});
  const RA = await import("../js/rounds.js?copy=A");
  const RB = await import("../js/rounds.js?copy=B");
  assert.equal(RA.pageId(), RB.pageId(), "both copies start with the same tab id");
  const A = RA.createRounds(deps(m, store));
  const B = RB.createRounds(deps(m, store));
  A.onState(m.read("interviews_meta/state"));
  B.onState(m.read("interviews_meta/state"));               // B's first state: no close, so it takes its own id
  assert.notEqual(RA.pageId(), RB.pageId(), "the twins still share an id");
  await A._steps.pause();
  const mode = B.onState(m.read("interviews_meta/state"));
  await wait(150);
  assert.equal(mode, "fresh");
  assert.equal(m.read("interviews_meta/state").lease.load, RA.LOAD, "the twin took the close");
  assert.equal(await A._tx(["saved"], () => {}).then(() => "wrote", (e) => e.code), "wrote");
  A._steps.setActive(false); B._steps.setActive(false);        // stop the heartbeats
});

test("a reloaded holder keeps its close when a snapshot still shows its claim from before the reload", async () => {
  mem.clear();
  const m = memFirestore(); seed(m);
  const store = new FirestoreStore(m.fb, {});
  const RC = await import("../js/rounds.js?copy=C");
  const RD = await import("../js/rounds.js?copy=D");        // D = C after a reload (same tab id, new load)
  const C = RC.createRounds(deps(m, store));
  C.onState(m.read("interviews_meta/state"));
  await C._steps.pause();
  const before = m.read("interviews_meta/state");
  const D = RD.createRounds(deps(m, store));
  assert.equal(D.onState(before), "holder");                 // first state after the reload: carry on
  await wait(30);
  assert.equal(D.onState(before), "holder");                 // an older snapshot arrives late
  await wait(150);
  assert.equal(D._C.stoodDown, false);
  assert.equal(m.read("interviews_meta/state").lease.load, RD.LOAD);
  C._steps.setActive(false); D._steps.setActive(false);
});

test("a close with no holder is offered at once; no close resets a stood-down page", async () => {
  mem.clear();
  const m = memFirestore(); seed(m);
  const store = new FirestoreStore(m.fb, {});
  const RE = await import("../js/rounds.js?copy=E");
  const E = RE.createRounds(deps(m, store));
  assert.equal(E.onState({ roundStatus: "closing", closingAttemptId: "a-1" }), "stale");
  E._C.stoodDown = true; E._C.resumed = true;
  assert.equal(E.onState({ roundStatus: "open" }), "none");
  assert.equal(E._C.stoodDown, false);
  assert.equal(E._C.resumed, false);
});
