// H2: the questions, schedule and passwords documents arrive through the meta
// listener the ED page already has. No new collection is subscribed, and
// nothing for the committee touches a collection holding ratings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreStore } from "../js/store.js";

function stubFb() {
  const live = new Map();
  const fb = {
    db: {}, collection: (_db, name) => ({ __path: name }), doc: (_db, name, id) => ({ __path: `${name}/${id}` }),
    setDoc: async () => {}, updateDoc: async () => {}, runTransaction: async () => {}, deleteField: () => "DEL",
    onSnapshot: (ref, cb, err) => { live.set(ref.__path, { cb, err }); return () => live.delete(ref.__path); },
  };
  return { fb, live };
}
const metaSnap = (docs) => ({ docs: Object.entries(docs).map(([id, d]) => ({ id, data: () => d })) });

test("committee scope receives questions, schedule and passwords from the meta listener", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["candidates", "availIv", "availCand", "meta"], echo: true });
  assert.deepEqual([...live.keys()].sort(), ["interviews_availCand", "interviews_availIv", "interviews_candidates", "interviews_meta"]);
  assert.equal(s.metaLoaded, false);
  live.get("interviews_meta").cb(metaSnap({
    config: { chair: "Vojdani" }, state: { interviewsComplete: false },
    questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }] },
    schedule: { locked: true, panels: {} }, passwords: { ed: { changedAt: "x" } },
  }));
  const st = s.getState();
  assert.equal(st.questions.questions[0].text, "Tell us about yourself");
  assert.equal(st.schedule.locked, true);
  assert.deepEqual(st.passwordsMeta, { ed: { changedAt: "x" } });
  assert.equal(s.metaLoaded, true);
  // still no listener on scores, screening (collection), offers or history
  for (const p of live.keys()) assert.ok(!/scores|offers|history|archive/.test(p), p);
});

test("no questions document reads as null, so the page falls back to the old locked file", () => {
  const { fb, live } = stubFb();
  const s = new FirestoreStore(fb, { scopes: ["meta"] });
  live.get("interviews_meta").cb(metaSnap({ config: {} }));
  assert.equal(s.getState().questions, null);
  assert.equal(s.getState().schedule, null);
});
