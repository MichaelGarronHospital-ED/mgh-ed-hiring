// Exercises FirestoreStore's per-document screening subscription with a stub
// Firestore: the path that makes a reviewer's own flags/ratings follow them
// between devices. No emulator, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreStore, key } from "../js/store.js";

function stubFb() {
  const live = new Map();          // path -> { cb, err }
  const fb = {
    db: {}, app: {},
    collection: (_db, name) => ({ __path: name }),
    doc: (_db, name, id) => ({ __path: `${name}/${id}` }),
    setDoc: async () => {}, updateDoc: async () => {},
    runTransaction: async () => {}, deleteField: () => "DELETE",
    onSnapshot: (ref, cb, err) => {
      live.set(ref.__path, { cb, err });
      return () => live.delete(ref.__path);
    },
  };
  return { fb, live };
}
const paths = (live, prefix) => [...live.keys()].filter((p) => p.startsWith(prefix)).sort();
const candSnap = (ids) => ({ docs: ids.map((id) => ({ id, data: () => ({ name: id, removed: false }) })) });
const docSnap = (data) => ({ exists: () => data != null, data: () => data });

test("a reviewer subscribes to their own screening docs and nobody else's", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });

  live.get("interviews_candidates").cb(candSnap(["c-1", "c-2"]));
  assert.deepEqual(paths(live, "interviews_screening/"), [], "no member picked yet → no screening reads");

  s.setMember("Yang");
  assert.deepEqual(paths(live, "interviews_screening/"),
    ["interviews_screening/Yang~c-1", "interviews_screening/Yang~c-2"]);

  // a colleague's document is never requested
  assert.ok(![...live.keys()].some((p) => p.includes("Jha")));

  // an incoming document lands in state under the same key the UI reads
  live.get("interviews_screening/Yang~c-1").cb(docSnap({ member: "Yang", candId: "c-1", rating: 4, flag: false }));
  assert.equal(s.getState().screening[key("Yang", "c-1")].rating, 4);

  // a doc that doesn't exist must not clobber an echo entry from before read-back
  s._echoScreening[key("Yang", "c-2")] = { rating: 2 };
  s.state.screening[key("Yang", "c-2")] = { rating: 2 };
  live.get("interviews_screening/Yang~c-2").cb(docSnap(null));
  assert.equal(s.getState().screening[key("Yang", "c-2")].rating, 2);
});

test("the subscription follows the roster and the signed-in member", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  s.setMember("Yang");
  assert.deepEqual(paths(live, "interviews_screening/"), ["interviews_screening/Yang~c-1"]);

  live.get("interviews_candidates").cb(candSnap(["c-1", "c-2"]));   // admin adds an applicant
  assert.deepEqual(paths(live, "interviews_screening/"),
    ["interviews_screening/Yang~c-1", "interviews_screening/Yang~c-2"]);

  s.setMember("Jha");                                               // "change" at the top of the page
  assert.deepEqual(paths(live, "interviews_screening/"),
    ["interviews_screening/Jha~c-1", "interviews_screening/Jha~c-2"], "old listeners are dropped");

  s.setMember(null);                                                // back to the picker
  assert.deepEqual(paths(live, "interviews_screening/"), []);
});

test("a reviewer's client never asks for the screening or scores collections", () => {
  // The rules let the shared committee account GET a screening document, so the
  // only thing standing between a reviewer and a colleague's rating is that the
  // app never requests one. This pins that: a committee-scoped store subscribes
  // to no collection that carries anyone's ratings, which is also why there is
  // nothing in a reviewer's state for the UI to render by accident.
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1", "c-2"]));
  s.setMember("Yang");

  assert.ok(!live.has("interviews_screening"), "no collection-wide screening subscription");
  assert.ok(!live.has("interviews_scores"), "no scores subscription at all");
  assert.deepEqual(Object.keys(s.getState().scores), [], "a reviewer's state holds nobody's scores");
  for (const p of live.keys()) {
    if (p.startsWith("interviews_screening/")) assert.ok(p.startsWith("interviews_screening/Yang~"), p);
  }
});

test("an admin already lists the collection, so takes no per-document path", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "screening", "availIv", "availCand", "scores", "meta"] });
  live.get("interviews_candidates").cb(candSnap(["c-1", "c-2"]));
  s.setMember("Vojdani");
  assert.deepEqual(paths(live, "interviews_screening/"), [],
    "no extra reads: interviews_screening is watched as a whole collection");
});

// ---------------------------------------------------------------------------
// A refused write must not leave a "phantom" rating behind. setAvail has always
// rolled back ("don't leave an unsaved pick on screen"); setScreening and
// setScore did not, so a failed write left the value on screen AND in
// localStorage while the server had nothing. It looked saved on that device and
// was simply absent everywhere else — which is how a reviewer's screening came
// to vanish between sessions.
function failingFb() {
  const { fb, live } = stubFb();
  fb.setDoc = async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); };
  return { fb, live };
}

test("a refused screening write leaves no phantom rating", async () => {
  const { fb, live } = failingFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  s.setMember("Yang");
  const k = key("Yang", "c-1");

  await assert.rejects(() => s.setScreening("Yang", "c-1", { rating: 4 }), /denied/);
  assert.equal(s.getState().screening[k], undefined, "nothing left on screen");
  assert.equal(s._echoScreening[k], undefined, "nothing left in the device mirror");
});

test("a refused write restores the PREVIOUS value, it does not just clear", async () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  s.setMember("Yang");
  const k = key("Yang", "c-1");

  await s.setScreening("Yang", "c-1", { rating: 3 });          // succeeds
  assert.equal(s.getState().screening[k].rating, 3);

  fb.setDoc = async () => { throw Object.assign(new Error("offline"), { code: "unavailable" }); };
  await assert.rejects(() => s.setScreening("Yang", "c-1", { rating: 5 }), /offline/);
  assert.equal(s.getState().screening[k].rating, 3, "the earlier saved 3 survives a failed change to 5");
  assert.equal(s._echoScreening[k].rating, 3, "and so does the device mirror");
});

test("a refused score write leaves no phantom score", async () => {
  const { fb, live } = failingFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  const k = key("Yang", "c-1");
  await assert.rejects(() => s.setScore("Yang", "c-1", { overall: 5 }), /denied/);
  assert.equal(s.getState().scores[k], undefined, "nothing left on screen");
  assert.equal(s._echoScores[k], undefined, "nothing left in the device mirror");
});

test("a denied read-back listener is dropped so it can retry after the rules are published", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  s.setMember("Yang");
  const p = "interviews_screening/Yang~c-1";
  assert.ok(live.has(p));

  live.get(p).err(Object.assign(new Error("nope"), { code: "permission-denied" }));
  assert.equal(s.screeningReadBack, false, "UI drops the 'any device' claim");
  assert.ok(!live.has(p), "the dead listener is removed, not left occupying the slot");

  // rules get published; the next roster snapshot re-subscribes without a reload
  live.get("interviews_candidates").cb(candSnap(["c-1"]));
  assert.ok(live.has(p), "re-subscribed by itself");
});
