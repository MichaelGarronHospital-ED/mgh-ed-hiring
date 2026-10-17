// ============================================================================
//  The applicant-availability pipeline, end to end.
//
//  This drives the REAL FirestoreStore against the emulator with the REAL
//  firestore.rules — only `onSnapshot` is stubbed out, because these tests are
//  about what gets WRITTEN, not about listeners. That combination is the point:
//  the bug this file exists for was invisible to both halves on their own.
//
//  The story it pins, in order:
//    applicant types their surname  → store.checkName
//    picks times                    → store.setAvail
//    comes back later / elsewhere   → checkName AGAIN, then setAvail again
//    the committee reads it back    → admin get
//  Every answer given must still be there at the end.
// ============================================================================
import { readFileSync } from "node:fs";
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, setDoc, updateDoc, deleteField, deleteDoc } from "firebase/firestore";
import { FirestoreStore } from "../js/store.js";
import { UID, pw } from "./helpers/identities.mjs";

let env;
const applicantDb = () => env.authenticatedContext(UID.applicant, pw("applicant@ed-hiring.app")).firestore();
const adminDb = () => env.authenticatedContext(UID.admin, pw("admin@ed-hiring.app")).firestore();
const committeeDb = () => env.authenticatedContext(UID.committee, pw("committee@ed-hiring.app")).firestore();
const AV = "interviews_availCand/ashcombe";

// The store as the applicant page builds it, minus the listeners: applicants
// are write-only on availCand anyway (scopes: ["public"]), so nothing real is
// lost and the test stays synchronous.
const noListeners = () => () => {};
function applicantStore() {
  const db = applicantDb();
  return new FirestoreStore(
    { db, collection, doc, setDoc, updateDoc, deleteField, onSnapshot: noListeners },
    { scopes: ["public"], echo: false });
}

async function readRaw(path) {
  let snap;
  await env.withSecurityRulesDisabled(async (c) => { snap = await getDoc(doc(c.firestore(), path)); });
  return snap;
}
const slotsOf = async (path = AV) => ((await readRaw(path)).data() || {}).slots;

before(async () => {
  env = await initializeTestEnvironment({
    // Its OWN project id, deliberately. `node --test` runs each file in its own
    // process, in parallel, against the one emulator — so sharing a project id
    // with firestore.rules.test.mjs means each file's clearFirestore() wipes
    // the other's seed data mid-test. Same emulator, separate namespaces.
    projectId: "mgh-ed-hiring-test-avail",
    firestore: {
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1", port: 8080,
    },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    // Rosalind Ashcombe is the invented applicant used throughout the repo.
    await setDoc(doc(db, "interviews_meta/allowed"), { keys: ["ashcombe", "belanger"] });
    await setDoc(doc(db, "interviews_candidates/c-1"), { name: "Rosalind Ashcombe", removed: false });
  });
});

// ============================================================================
describe("an applicant's answers survive every return visit", () => {
  // THE regression. checkName ran `setDoc({ slots: {} }, { merge: true })` to
  // ask the rules "is this surname on the roster?". An empty map has no leaf
  // field paths, so merge takes `slots` itself as the leaf and REPLACES it —
  // the probe wiped every time they had picked.
  //
  // It fired on the way IN, and the applicant's surname lives in
  // sessionStorage, so it fired on every visit after the tab had been closed.
  // And it was silent twice over: the applicant's own screen replays from the
  // per-device localStorage echo, so they still saw their old picks ticked,
  // while the server held an empty map and the committee saw them as never
  // having replied. That is indistinguishable from an applicant who ignored
  // the email — right up until nobody schedules them.
  test("the name check does not erase answers from an earlier visit", async () => {
    const store = applicantStore();
    assert.equal(await store.checkName("ashcombe"), true);
    await store.setAvail("cand", "ashcombe", "t1", "ip");
    await store.setAvail("cand", "ashcombe", "t2", "zoom");

    // they close the tab and come back: the surname form runs checkName again
    assert.equal(await applicantStore().checkName("ashcombe"), true);

    assert.deepEqual(await slotsOf(), { t1: "ip", t2: "zoom" },
      "the name check wiped answers from an earlier visit");
  });

  test("a second device does not overwrite what the first one saved", async () => {
    const phone = applicantStore();
    await phone.checkName("ashcombe");
    await phone.setAvail("cand", "ashcombe", "t1", "ip");

    // The laptop has no echo and cannot read the doc, so its local state is
    // empty. It must still only ever write the one time they tap.
    const laptop = applicantStore();
    await laptop.checkName("ashcombe");
    await laptop.setAvail("cand", "ashcombe", "t3", "either");

    assert.deepEqual(await slotsOf(), { t1: "ip", t3: "either" });
  });

  test("clearing one time clears only that one", async () => {
    const store = applicantStore();
    await store.setAvail("cand", "ashcombe", "t1", "ip");
    await store.setAvail("cand", "ashcombe", "t2", "zoom");
    await store.setAvail("cand", "ashcombe", "t1", null);
    assert.deepEqual(await slotsOf(), { t2: "zoom" });
  });

  test("changing a time's modality replaces only that time", async () => {
    const store = applicantStore();
    await store.setAvail("cand", "ashcombe", "t1", "ip");
    await store.setAvail("cand", "ashcombe", "t2", "zoom");
    await store.setAvail("cand", "ashcombe", "t1", "either");
    assert.deepEqual(await slotsOf(), { t1: "either", t2: "zoom" });
  });

  test("the committee reads back exactly what was submitted", async () => {
    const store = applicantStore();
    await store.setAvail("cand", "ashcombe", "t1", "ip");
    const snap = await assertSucceeds(getDoc(doc(adminDb(), AV)));
    assert.deepEqual(snap.data().slots, { t1: "ip" });
  });
});

// ============================================================================
describe("the name check still does its job", () => {
  test("a surname on the roster is accepted", async () => {
    assert.equal(await applicantStore().checkName("ashcombe"), true);
  });

  test("a surname that is NOT on the roster is refused", async () => {
    assert.equal(await applicantStore().checkName("cruz"), false);
  });

  test("it creates the document for a first-time applicant", async () => {
    await applicantStore().checkName("belanger");
    assert.equal((await readRaw("interviews_availCand/belanger")).exists(), true);
  });

  test("a refused name writes nothing at all", async () => {
    await applicantStore().checkName("cruz");
    assert.equal((await readRaw("interviews_availCand/cruz")).exists(), false);
  });

  test("a missing allowed list locks everyone out rather than saving quietly", async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      deleteDoc(doc(c.firestore(), "interviews_meta/allowed")));
    assert.equal(await applicantStore().checkName("ashcombe"), false);
  });

  test("a roster addition that has not been synced to the allowed list is refused", async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(c.firestore(), "interviews_candidates/c-2"), { name: "Ana Cruz", removed: false }));
    assert.equal(await applicantStore().checkName("cruz"), false);
  });
});

// ============================================================================
// Not bugs to fix here — the boundary of what the rules can promise, written
// down so a later change that narrows it is visibly a change.
describe("what the rules deliberately do NOT stop", () => {
  test("two applicants sharing a surname share one document, last writer wins", async () => {
    await applicantStore().setAvail("cand", "ashcombe", "t1", "ip");
    await applicantStore().setAvail("cand", "ashcombe", "t1", "zoom");
    assert.equal((await slotsOf()).t1, "zoom");
  });

  test("a raw client can still replace the whole document", async () => {
    await applicantStore().setAvail("cand", "ashcombe", "t1", "ip");
    await assertSucceeds(setDoc(doc(applicantDb(), AV), { slots: { t9: "ip" } }));
    assert.deepEqual(await slotsOf(), { t9: "ip" });
  });

  test("an applicant cannot read their own answers back", async () => {
    await applicantStore().setAvail("cand", "ashcombe", "t1", "ip");
    await assertFails(getDoc(doc(applicantDb(), AV)));
  });
});

// ============================================================================
// The document's shape. Until Oct 2026 the rules accepted any fields here, so
// a raw client holding the Guest password could park anything in the
// applicant's document (and a modality like "banana" was pinned above as a
// known limitation). The rules now allow only { slots: { <id>: ip|zoom|either } }
// with at most 200 times. That limitation was flipped on purpose.
describe("only a real availability map can be saved", () => {
  test("a modality other than in person, Zoom or either is refused", async () => {
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: { t1: "banana" } }, { merge: true }));
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: { t1: true } }, { merge: true }));
    assert.equal(await slotsOf(), undefined);
  });

  test("any field other than slots is refused", async () => {
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: { t1: "ip" }, note: "hi" }));
    await assertFails(setDoc(doc(applicantDb(), AV), { email: "x@example.com" }, { merge: true }));
  });

  test("slots must be a map", async () => {
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: "ip" }));
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: ["t1"] }));
  });

  test("more than 200 times is refused, 200 is fine", async () => {
    const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["t" + i, "ip"]));
    await assertSucceeds(setDoc(doc(applicantDb(), AV), { slots: many(200) }));
    await assertFails(setDoc(doc(applicantDb(), AV), { slots: { t999: "zoom" } }, { merge: true }));
    assert.equal(Object.keys(await slotsOf()).length, 200);
  });

  test("the name check probe ({}) still passes on a new and on an existing document", async () => {
    assert.equal(await applicantStore().checkName("belanger"), true);   // creates {}
    await applicantStore().setAvail("cand", "ashcombe", "t1", "ip");
    assert.equal(await applicantStore().checkName("ashcombe"), true);   // existing, untouched
    assert.deepEqual(await slotsOf(), { t1: "ip" });
  });

  test("the same shape applies to the committee and leadership", async () => {
    await assertFails(setDoc(doc(committeeDb(), AV), { slots: { t1: "banana" } }, { merge: true }));
    await assertFails(setDoc(doc(adminDb(), AV), { slots: { t1: "ip" }, extra: 1 }));
    await assertSucceeds(setDoc(doc(adminDb(), AV), { slots: { t1: "ip" } }, { merge: true }));
  });

  test("the committee cannot delete an applicant's availability; leadership can", async () => {
    await applicantStore().setAvail("cand", "ashcombe", "t1", "ip");
    await assertFails(deleteDoc(doc(committeeDb(), AV)));
    await assertFails(deleteDoc(doc(applicantDb(), AV)));
    await assertSucceeds(deleteDoc(doc(adminDb(), AV)));
  });
});

// ============================================================================
describe("applicants who share a surname (H14)", () => {
  // Once leadership has two Kims, each has their own key (kim-jane, kim-min) and
  // the allowed list holds those, not plain "kim". Each writes their own
  // document, and nobody can write under the plain surname any more.
  test("two Kims each write their own document; neither can write under plain kim", async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), "interviews_meta/allowed"), { keys: ["ashcombe", "kim-jane", "kim-min"] });
    });
    const s = applicantStore();
    assert.equal(await s.checkName("kim"), false, "plain kim is still accepted");
    assert.equal(await s.checkName("kim-jane"), true);
    await s.setAvail("cand", "kim-jane", "t1", "ip");
    assert.equal(await applicantStore().checkName("kim-min"), true);
    await applicantStore().setAvail("cand", "kim-min", "t2", "zoom");
    assert.deepEqual(await slotsOf("interviews_availCand/kim-jane"), { t1: "ip" });
    assert.deepEqual(await slotsOf("interviews_availCand/kim-min"), { t2: "zoom" });
    await assertFails(setDoc(doc(applicantDb(), "interviews_availCand/kim"), { slots: { t1: "ip" } }, { merge: true }));
  });
});
