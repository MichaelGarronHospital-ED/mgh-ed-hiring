// ============================================================================
//  Rules v2 (Oct 2026): round and stage gates, the applicant reply, change
//  history, applicant notices, the close-round archive and its lease.
//
//  The 109 tests in firestore.rules.test.mjs and applicant-availability.test.mjs
//  run UNCHANGED against the same rules file: that is the proof the page that is
//  live today keeps working. This file pins everything v2 adds, including every
//  probe the design reviews asked for (review rounds 4 and 5: how a close
//  starts, expired and malformed stored claims, takeover timing by the server's
//  clock, and the "sleeping laptop" writes).
//
//  Its own project id, so its clearFirestore() never wipes another file's seed
//  data (node --test runs each file in parallel against one emulator).
// ============================================================================

import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
  writeBatch, runTransaction, deleteField,
} from "firebase/firestore";
import { UID, pw } from "./helpers/identities.mjs";

const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "mgh-ed-hiring-test-v2",
    firestore: { rules: RULES, host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const admin = () => env.authenticatedContext(UID.admin, pw("admin@mgh-ed-hiring.invalid")).firestore();
const committee = () => env.authenticatedContext(UID.committee, pw("committee@mgh-ed-hiring.invalid")).firestore();
const applicant = () => env.authenticatedContext(UID.applicant, pw("applicant@mgh-ed-hiring.invalid")).firestore();
const stranger = () => env.authenticatedContext("u-stranger", { email: "someone@example.com" }).firestore();

const seed = (path, data) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));
const raw = async (path) => {
  let snap;
  await env.withSecurityRulesDisabled(async (ctx) => { snap = await getDoc(doc(ctx.firestore(), path)); });
  return snap;
};
const ago = (min) => Timestamp.fromMillis(Date.now() - min * 60000);
const ahead = (min) => Timestamp.fromMillis(Date.now() + min * 60000);
const days = (n) => Timestamp.fromMillis(Date.now() + n * 86400000);

const STATE = "interviews_meta/state";
const ALLOWED = "interviews_meta/allowed";
const PUBLIC = "interviews_public/slots";
const claim = (tab, load = "l-1") => ({ tab, load, at: serverTimestamp() });
const owner = claim;

// ============================================================================
describe("stage gates (H4)", () => {
  const writes = {
    screening: (db) => setDoc(doc(db, "interviews_screening/Marrocco~c-1"), { member: "Marrocco", candId: "c-1", rating: 4 }, { merge: true }),
    scoring: (db) => setDoc(doc(db, "interviews_scores/Marrocco~c-1"), { member: "Marrocco", candId: "c-1", overall: 4.2 }, { merge: true }),
    availability: (db) => setDoc(doc(db, "interviews_availIv/Marrocco"), { slots: { t1: "ip" } }, { merge: true }),
  };

  it("ED can write screening, scores and interviewer times while every stage is open", async () => {
    await seed(STATE, { stages: { screening: { closed: false }, availability: { closed: false }, scoring: { closed: false } } });
    for (const w of Object.values(writes)) await assertSucceeds(w(committee()));
  });

  it("a missing state document means open", async () => {
    for (const w of Object.values(writes)) await assertSucceeds(w(committee()));
  });

  it("an old-shaped state document ({ interviewsComplete: true }) means open", async () => {
    await seed(STATE, { interviewsComplete: true });
    for (const w of Object.values(writes)) await assertSucceeds(w(committee()));
  });

  for (const stage of ["screening", "scoring", "availability"]) {
    it(`ED is refused once ${stage} is closed; the other stages still save; Admin still can`, async () => {
      await seed(STATE, { stages: { [stage]: { closed: true, at: ago(1) } } });
      await assertFails(writes[stage](committee()));
      for (const [other, w] of Object.entries(writes)) if (other !== stage) await assertSucceeds(w(committee()));
      await assertSucceeds(writes[stage](admin()));
    });
  }

  it("ED is refused writing applicant availability once availability closes", async () => {
    await seed(STATE, { stages: { availability: { closed: true } } });
    await assertFails(setDoc(doc(committee(), "interviews_availCand/kim"), { slots: { t1: "ip" } }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), "interviews_availCand/kim"), { slots: { t1: "ip" } }, { merge: true }));
  });
});

// ============================================================================
describe("round closing (H1)", () => {
  it("ED and Guest writes are refused while the round is closing; Admin is not", async () => {
    await seed(ALLOWED, { keys: ["kim"] });
    await seed(STATE, { roundStatus: "closing", closingTab: "p-A", lease: { tab: "p-A", at: ago(1) } });
    await assertFails(setDoc(doc(committee(), "interviews_screening/Marrocco~c-1"), { rating: 3 }, { merge: true }));
    await assertFails(setDoc(doc(committee(), "interviews_scores/Marrocco~c-1"), { overall: 3 }, { merge: true }));
    await assertFails(setDoc(doc(committee(), "interviews_availIv/Marrocco"), { slots: { t1: "ip" } }, { merge: true }));
    await assertFails(setDoc(doc(applicant(), "interviews_availCand/kim"), { slots: { t1: "ip" } }, { merge: true }));
    await assertFails(setDoc(doc(applicant(), "interviews_availCand/kim"), {}, { merge: true }));   // even the probe
    await assertSucceeds(setDoc(doc(admin(), "interviews_screening/Marrocco~c-1"), { rating: 3 }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), "interviews_availCand/kim"), { slots: { t1: "ip" } }, { merge: true }));
  });

  it("roundStatus 'open' explicitly is open", async () => {
    await seed(STATE, { roundStatus: "open" });
    await assertSucceeds(setDoc(doc(committee(), "interviews_screening/Marrocco~c-1"), { rating: 3 }, { merge: true }));
  });
});

// ============================================================================
describe("applicant reply (H11)", () => {
  const AV = "interviews_availCand/kim";
  beforeEach(async () => { await seed(ALLOWED, { keys: ["kim"] }); });

  it("confirmed with a server time is accepted", async () => {
    await assertSucceeds(setDoc(doc(applicant(), AV), { reply: "confirmed", replyAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(setDoc(doc(applicant(), AV), { reply: "withdrawn", replyAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(setDoc(doc(applicant(), AV), { reply: "", replyAt: serverTimestamp() }, { merge: true }));
  });

  it("reply 'maybe', a non-timestamp replyAt and an extra key are refused", async () => {
    await assertFails(setDoc(doc(applicant(), AV), { reply: "maybe" }, { merge: true }));
    await assertFails(setDoc(doc(applicant(), AV), { reply: "confirmed", replyAt: "today" }, { merge: true }));
    await assertFails(setDoc(doc(applicant(), AV), { reply: "confirmed", note: "hi" }, { merge: true }));
  });

  it("after availability closes a slot change is refused but a reply change is accepted", async () => {
    await seed(AV, { slots: { t1: "ip" } });
    await seed(STATE, { stages: { availability: { closed: true } } });
    await assertFails(setDoc(doc(applicant(), AV), { slots: { t2: "zoom" } }, { merge: true }));
    await assertFails(setDoc(doc(applicant(), AV), { slots: { t1: deleteField() } }, { merge: true }));
    await assertSucceeds(setDoc(doc(applicant(), AV), { reply: "confirmed", replyAt: serverTimestamp() }, { merge: true }));
    assert.deepEqual((await raw(AV)).data().slots, { t1: "ip" });
  });

  it("after availability closes, a reply from an applicant who never picked a time is accepted, picks are not", async () => {
    await seed(STATE, { stages: { availability: { closed: true } } });
    await assertFails(setDoc(doc(applicant(), AV), { slots: { t2: "zoom" } }, { merge: true }));
    await assertSucceeds(setDoc(doc(applicant(), AV), { reply: "withdrawn", replyAt: serverTimestamp() }, { merge: true }));
  });

  it("the {} name probe still passes with availability open and closed", async () => {
    await assertSucceeds(setDoc(doc(applicant(), AV), {}, { merge: true }));
    await seed(STATE, { stages: { availability: { closed: true } } });
    await assertSucceeds(setDoc(doc(applicant(), AV), {}, { merge: true }));
    await seed(AV, { slots: { t1: "ip" }, reply: "confirmed", replyAt: ago(10) });
    await assertSucceeds(setDoc(doc(applicant(), AV), {}, { merge: true }));
  });

  it("a reply under a surname not on the roster is refused", async () => {
    await assertFails(setDoc(doc(applicant(), "interviews_availCand/nobody"), { reply: "confirmed", replyAt: serverTimestamp() }, { merge: true }));
  });
});

// ============================================================================
describe("interviews_applicant: one confirmed time per applicant (H11)", () => {
  const N = "interviews_applicant/kim";
  beforeEach(async () => { await seed(N, { date: "2027-03-03", start: "09:00", end: "10:00", format: "ip" }); });

  it("Guest can get one notice by id, but cannot list or write", async () => {
    await assertSucceeds(getDoc(doc(applicant(), N)));
    await assertSucceeds(getDoc(doc(applicant(), "interviews_applicant/missing")));   // a missing one reads as absent
    await assertFails(getDocs(collection(applicant(), "interviews_applicant")));
    await assertFails(setDoc(doc(applicant(), N), { date: "2027-03-04" }));
    await assertFails(deleteDoc(doc(applicant(), N)));
  });

  it("ED can neither get nor list notices", async () => {
    await assertFails(getDoc(doc(committee(), N)));
    await assertFails(getDocs(collection(committee(), "interviews_applicant")));
    await assertFails(setDoc(doc(committee(), N), { date: "2027-03-04" }));
  });

  it("Admin can do everything; strangers nothing", async () => {
    await assertSucceeds(getDoc(doc(admin(), N)));
    await assertSucceeds(getDocs(collection(admin(), "interviews_applicant")));
    await assertSucceeds(setDoc(doc(admin(), N), { date: "2027-03-04" }));
    await assertSucceeds(deleteDoc(doc(admin(), N)));
    await assertFails(getDoc(doc(stranger(), N)));
  });
});

// ============================================================================
describe("interviews_history: append-only, server time (H12)", () => {
  const H = "interviews_history/h1";
  const entry = (over = {}) => ({ at: serverTimestamp(), by: "leadership", action: "schedule.lock", text: "Locked the schedule", ...over });

  it("Admin can create an entry stamped with the server time", async () => {
    await assertSucceeds(setDoc(doc(admin(), H), entry()));
    await assertSucceeds(setDoc(doc(admin(), "interviews_history/h2"),
      entry({ cand: "c-1", member: "Marrocco", undo: { kind: "panelOverrides", before: { "c-1": { slot: "t1" } }, afterHash: "ab" } })));
    await assertSucceeds(getDoc(doc(admin(), H)));
    await assertSucceeds(getDocs(collection(admin(), "interviews_history")));
  });

  it("an old 'at' is refused unless the entry is marked restored", async () => {
    await assertFails(setDoc(doc(admin(), H), entry({ at: ago(60) })));
    await assertFails(setDoc(doc(admin(), H), entry({ at: ago(60), restored: false })));
    await assertSucceeds(setDoc(doc(admin(), H), entry({ at: ago(60 * 24 * 90), restored: true })));
    await assertFails(setDoc(doc(admin(), "interviews_history/h3"), entry({ at: "2027-01-01", restored: true })));
  });

  it("text over 600 characters, an action over 60, a missing field or an extra key is refused", async () => {
    await assertFails(setDoc(doc(admin(), H), entry({ text: "x".repeat(601) })));
    await assertSucceeds(setDoc(doc(admin(), H), entry({ text: "x".repeat(600) })));
    await assertFails(setDoc(doc(admin(), "interviews_history/h4"), entry({ action: "a".repeat(61) })));
    await assertFails(setDoc(doc(admin(), "interviews_history/h5"), entry({ name: "Dr Rosalind Ashcombe" })));
    const { by, ...noBy } = entry();
    await assertFails(setDoc(doc(admin(), "interviews_history/h6"), noBy));
  });

  it("nobody can update an entry", async () => {
    await seed(H, { at: ago(1), by: "leadership", action: "x", text: "y" });
    await assertFails(updateDoc(doc(admin(), H), { text: "changed" }));
    await assertFails(setDoc(doc(admin(), H), entry()));
    await assertFails(updateDoc(doc(committee(), H), { text: "changed" }));
  });

  it("delete is refused while the round is open and allowed while it is closing", async () => {
    await seed(H, { at: ago(1), by: "leadership", action: "x", text: "y" });
    await assertFails(deleteDoc(doc(admin(), H)));
    await seed(STATE, { roundStatus: "open" });
    await assertFails(deleteDoc(doc(admin(), H)));
    await seed(STATE, { roundStatus: "closing", closingTab: "p-A", lease: { tab: "p-A", at: ago(1) } });
    await assertSucceeds(deleteDoc(doc(admin(), H)));
  });

  it("ED and Guest can neither read nor write history", async () => {
    await seed(H, { at: ago(1), by: "leadership", action: "x", text: "y" });
    for (const db of [committee(), applicant(), stranger()]) {
      await assertFails(getDoc(doc(db, H)));
      await assertFails(getDocs(collection(db, "interviews_history")));
      await assertFails(setDoc(doc(db, "interviews_history/hx"), entry()));
    }
    await seed(STATE, { roundStatus: "closing", closingTab: "p-A", lease: { tab: "p-A", at: ago(1) } });
    await assertFails(deleteDoc(doc(committee(), H)));
  });
});

// ============================================================================
describe("public booking flag (H11, review M6)", () => {
  it("Guest and ED can read the public times with booking; neither can write it", async () => {
    await seed(PUBLIC, { times: [{ id: "t1", date: "2027-03-03", start: "09:00", end: "10:00" }], booking: "closed" });
    const g = await getDoc(doc(applicant(), PUBLIC));
    assert.equal(g.data().booking, "closed");
    await assertSucceeds(getDoc(doc(committee(), PUBLIC)));
    await assertFails(setDoc(doc(applicant(), PUBLIC), { booking: "open" }, { merge: true }));
    await assertFails(setDoc(doc(committee(), PUBLIC), { booking: "open" }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), PUBLIC), { booking: "open" }, { merge: true }));
  });
});

// ============================================================================
describe("close lease on interviews_meta/state: everyday writes (review 3 M1)", () => {
  it("with no close running or starting, every Admin write passes (reveal, stages, questions)", async () => {
    await assertSucceeds(setDoc(doc(admin(), STATE), { interviewsComplete: true }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { stages: { screening: { closed: true, at: serverTimestamp() } } }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), "interviews_meta/questions"), { version: 1, questions: [] }));
    await assertSucceeds(setDoc(doc(admin(), "interviews_meta/config"), { flagThreshold: 2 }, { merge: true }));
  });

  it("a previous close's lease left in the document does not block ordinary writes", async () => {
    await seed(STATE, { roundStatus: "open", closingTab: null, lease: { tab: "p-OLD", load: "l", at: ago(1) } });
    await assertSucceeds(setDoc(doc(admin(), STATE), { interviewsComplete: true }, { merge: true }));
  });

  it("ED cannot write state at all", async () => {
    await assertFails(setDoc(doc(committee(), STATE), { roundStatus: "open" }, { merge: true }));
  });
});

// ============================================================================
describe("close lease: how a close starts (review 4)", () => {
  it("starting a close without a lease claim is refused", async () => {
    await seed(STATE, { interviewsComplete: false });
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "closing", closingTab: "p-A", closingAttemptId: "a-1" }, { merge: true }));
  });

  it("starting a close with a client-time claim (a day ahead) is refused", async () => {
    await seed(STATE, { interviewsComplete: false });
    await assertFails(setDoc(doc(admin(), STATE),
      { roundStatus: "closing", closingTab: "p-A", lease: { tab: "p-A", load: "l", at: ahead(24 * 60) } }, { merge: true }));
  });

  it("starting a close with a claim naming a different page is refused", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "closing", closingTab: "p-A", lease: claim("p-B") }, { merge: true }));
  });

  it("starting a close with a fresh claim for the new closingTab is accepted", async () => {
    await seed(STATE, { interviewsComplete: false });
    await assertSucceeds(setDoc(doc(admin(), STATE),
      { roundStatus: "closing", closingTab: "p-A", closingAttemptId: "a-1", lease: claim("p-A") }, { merge: true }));
  });

  it("a close started over a previous close's old lease gets its own claim and cannot be taken over in its first 5 minutes", async () => {
    await seed(STATE, { roundStatus: "open", closingTab: null, lease: { tab: "p-OLD", load: "l", at: ago(200 * 24 * 60) } });
    await assertSucceeds(setDoc(doc(admin(), STATE),
      { roundStatus: "closing", closingTab: "p-A", closingAttemptId: "a-1", lease: claim("p-A") }, { merge: true }));
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
    // and a merge that forgets the lease cannot inherit the old one
    await seed(STATE, { roundStatus: "open", closingTab: null, lease: { tab: "p-A", load: "l", at: ago(1) } });
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "closing", closingTab: "p-A" }, { merge: true }));
  });
});

// ============================================================================
describe("close lease: expired, missing and malformed stored claims (reviews 4 and 5)", () => {
  const closingWith = (lease) => ({ roundStatus: "closing", closingTab: "p-A", closingAttemptId: "a-1", ...(lease === undefined ? {} : { lease }) });

  it("a stored claim more than 5 minutes old is expired: a takeover with a fresh claim succeeds at once", async () => {
    await seed(STATE, closingWith({ tab: "p-A", load: "l", at: ago(30) }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
  });

  for (const [label, lease] of [["missing", undefined], ["null", null], ["a string", "p-A"], ["a number", 7],
    ["a map without at", { tab: "p-A", load: "l" }], ["a map whose at is a string", { tab: "p-A", at: "2026-10-16" }],
    ["a map whose at is null", { tab: "p-A", at: null }]]) {
    it(`stored lease ${label}: no close running, an ordinary Admin write passes`, async () => {
      await seed(STATE, { interviewsComplete: false, ...(lease === undefined ? {} : { lease }) });
      await assertSucceeds(setDoc(doc(admin(), STATE), { interviewsComplete: true }, { merge: true }));
    });
    it(`stored lease ${label}: during a close, a takeover with a fresh claim passes at once`, async () => {
      await seed(STATE, closingWith(lease));
      await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
    });
  }

  it("a lease-less close crashed 10 hours ago can be taken over, and then stopped by the new holder", async () => {
    await seed(STATE, { roundStatus: "closing", closingTab: "p-A", closingAttemptId: "a-1", closingStartedAt: ago(600) });
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null, closingAttemptId: null, lease: claim("p-C") }, { merge: true }));
  });
});

// ============================================================================
describe("close lease: takeover timing by the server clock", () => {
  it("a takeover 4 minutes after the last renewal is refused; 6 minutes after is accepted", async () => {
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", load: "l", at: ago(4) } });
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", load: "l", at: ago(6) } });
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
  });

  it("a stored claim stamped in the future by a fast clock cannot block a takeover forever (it is never accepted in the first place)", async () => {
    await seed(STATE, { interviewsComplete: false });
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "closing", closingTab: "p-A", lease: { tab: "p-A", at: ahead(60) } }, { merge: true }));
  });
});

// ============================================================================
describe("close lease: the holder, plain writes and stale pages (review 3 M1, m1)", () => {
  beforeEach(async () => {
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", load: "l-b", at: ago(1) } });
  });

  it("the holder can renew, edit, finish and stop", async () => {
    await assertSucceeds(setDoc(doc(admin(), STATE), { lease: claim("p-B", "l-b") }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingAttemptId: "a-2", lease: claim("p-B", "l-b") }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null, closingAttemptId: null, lease: claim("p-B", "l-b") }, { merge: true }));
  });

  it("the holder reloading writes a fresh claim with its new load nonce", async () => {
    await assertSucceeds(setDoc(doc(admin(), STATE), { lease: claim("p-B", "l-new") }, { merge: true }));
  });

  it("a plain write without a fresh lease claim is refused (the probe: reopen while another page holds the lease)", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null }, { merge: true }));
    await assertFails(updateDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null }));
    await assertFails(setDoc(doc(admin(), STATE), { interviewsComplete: true }, { merge: true }));
  });

  it("a claim copying the holder's tab id but with an old lease.at is refused", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { lease: { tab: "p-B", load: "l-b", at: ago(0.5) } }, { merge: true }));
  });

  it("another page's stop with its own fresh claim is refused", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null, lease: claim("p-A") }, { merge: true }));
  });

  it("another page's takeover is refused while the lease is under 5 minutes old (stale page re-claiming over a live holder)", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: "p-A", lease: claim("p-A") }, { merge: true }));
  });

  // review: a close must never be left with no holder, or a holder with no close
  it("roundStatus is \"closing\" exactly when closingTab is set, on every write", async () => {
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "open", lease: claim("p-B", "l-b") }, { merge: true }));
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: null, lease: claim("p-B", "l-b") }, { merge: true }));
    await seed(STATE, { roundStatus: "open", closingTab: null });
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: "p-A", lease: claim("p-A") }, { merge: true }));
    await assertFails(setDoc(doc(admin(), STATE), { roundStatus: "closing", lease: claim("p-A") }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { roundStatus: "closing", closingTab: "p-A", lease: claim("p-A") }, { merge: true }));
  });

  it("a close left with no holder (closing, no closingTab) can be finished or stopped at once by any page", async () => {
    await seed(STATE, { roundStatus: "closing", closingAttemptId: "a-1" });
    await assertFails(setDoc(doc(admin(), STATE), { interviewsComplete: true }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
    await seed(STATE, { roundStatus: "closing", closingAttemptId: "a-1" });
    await assertSucceeds(setDoc(doc(admin(), STATE), { roundStatus: "open", closingTab: null, lease: claim("p-C") }, { merge: true }));
  });

  it("a takeover must name itself in its claim", async () => {
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", at: ago(10) } });
    await assertFails(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-B") }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), STATE), { closingTab: "p-C", lease: claim("p-C") }, { merge: true }));
  });
});

// ============================================================================
describe("close attempts: interviews_archive status machine (H1)", () => {
  const A = "interviews_archive/a-1";
  const holder = { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", load: "l", at: ago(1) } };
  const attempt = (status, over = {}) => ({ roundId: "r-1", name: "Hiring round 2026", status, format: "mgh-ed-hiring-backup", version: 1, ...over });
  const upd = (status, over = {}) => updateDoc(doc(admin(), A), { status, owner: owner("p-B"), ...over });
  beforeEach(async () => { await seed(STATE, holder); });

  it("ED, Guest and strangers can do nothing with attempts or parts", async () => {
    await seed(A, attempt("closed", { closedAt: ago(60 * 24 * 400) }));
    await seed(A + "/parts/0", { i: 0, json: "{}" });
    for (const db of [committee(), applicant(), stranger()]) {
      await assertFails(getDoc(doc(db, A)));
      await assertFails(getDocs(collection(db, "interviews_archive")));
      await assertFails(getDoc(doc(db, A + "/parts/0")));
      await assertFails(setDoc(doc(db, "interviews_archive/a-9"), attempt("saving", { owner: owner("p-B") })));
      await assertFails(deleteDoc(doc(db, A)));
    }
  });

  it("create is accepted only as saving, by the holder, for the current attempt", async () => {
    await assertFails(setDoc(doc(admin(), A), attempt("saved", { owner: owner("p-B") })));
    await assertFails(setDoc(doc(admin(), A), attempt("closed", { owner: owner("p-B"), closedAt: serverTimestamp() })));
    await assertFails(setDoc(doc(admin(), A), attempt("saving", { owner: owner("p-X") })));             // not the holder
    await assertFails(setDoc(doc(admin(), A), attempt("saving", { owner: { tab: "p-B", at: ago(1) } })));  // not fresh
    await assertFails(setDoc(doc(admin(), "interviews_archive/a-OTHER"), attempt("saving", { owner: owner("p-B") })));  // not closingAttemptId
    await assertFails(setDoc(doc(admin(), A), attempt("saving", { owner: owner("p-B"), deleteAfter: days(400) })));
    await assertSucceeds(setDoc(doc(admin(), A), attempt("saving", { owner: owner("p-B") })));
  });

  it("Try again: the new attempt is created in the same transaction that moves closingAttemptId", async () => {
    const db = admin();
    await assertSucceeds(runTransaction(db, async (tx) => {
      await tx.get(doc(db, STATE));
      tx.set(doc(db, STATE), { closingAttemptId: "a-2", lease: claim("p-B") }, { merge: true });
      tx.set(doc(db, "interviews_archive/a-2"), attempt("saving", { owner: owner("p-B") }));
    }));
  });

  it("every allowed step is accepted", async () => {
    for (const [from, to, extra] of [["saving", "saved"], ["saving", "abandoned"], ["saved", "abandoned"],
      ["saved", "clearing"], ["clearing", "abandoned"], ["clearing", "closed", { closedAt: serverTimestamp() }],
      ["clearing", "closed", { closedAt: serverTimestamp(), deleteAfter: days(731) }]]) {
      await seed(A, attempt(from));
      await assertSucceeds(upd(to, extra || {}), `${from} -> ${to}`);
    }
    // same-status updates while saving or saved (counts, checksum)
    for (const s of ["saving", "saved"]) {
      await seed(A, attempt(s));
      await assertSucceeds(upd(s, { parts: 2, bytes: 1312345 }));
    }
  });

  it("every other step is refused", async () => {
    for (const [from, to] of [["saved", "closed"], ["saving", "clearing"], ["saving", "closed"], ["closed", "saving"],
      ["closed", "clearing"], ["closed", "abandoned"], ["abandoned", "saving"], ["abandoned", "saved"],
      ["abandoned", "clearing"], ["clearing", "saved"], ["clearing", "saving"], ["saved", "saving"]]) {
      await seed(A, attempt(from, from === "closed" ? { closedAt: ago(10) } : {}));
      await assertFails(upd(to, to === "closed" ? { closedAt: serverTimestamp() } : {}), `${from} -> ${to}`);
    }
    for (const s of ["clearing", "abandoned"]) {   // no same-status edits there
      await seed(A, attempt(s));
      await assertFails(upd(s, { parts: 3 }));
    }
  });

  it("a deleteAfter is refused on every step except into closed (review 2 m1)", async () => {
    await seed(A, attempt("saving"));
    await assertFails(upd("saving", { deleteAfter: ago(1) }));
    await assertFails(upd("saved", { deleteAfter: ago(1) }));
    await seed(A, attempt("saved"));
    await assertFails(upd("saved", { deleteAfter: ago(1) }));
    await assertFails(upd("clearing", { deleteAfter: ago(1) }));
    await seed(A, attempt("clearing"));
    await assertFails(upd("abandoned", { deleteAfter: ago(1) }));
  });

  it("a backdated closedAt (2020-01-01) is refused; deleteAfter under 30 days is refused", async () => {
    await seed(A, attempt("clearing"));
    await assertFails(upd("closed", { closedAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")) }));
    await assertFails(upd("closed", { closedAt: serverTimestamp(), deleteAfter: days(29) }));
    await assertFails(upd("closed", { closedAt: serverTimestamp(), deleteAfter: ago(1) }));
    await assertSucceeds(upd("closed", { closedAt: serverTimestamp(), deleteAfter: days(31) }));
  });

  it("after closing: closedAt never changes; rename, restoredAt and retention need no lease; retention never under 30 days from closedAt", async () => {
    await seed(STATE, { roundStatus: "open", closingTab: null });   // no close running at all
    const closedAt = ago(60 * 24 * 10);   // closed 10 days ago
    await seed(A, attempt("closed", { closedAt, deleteAfter: null }));
    await assertFails(updateDoc(doc(admin(), A), { closedAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")) }));
    await assertFails(updateDoc(doc(admin(), A), { closedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(admin(), A), { name: "Hiring round 2026 (spring)" }));
    await assertSucceeds(updateDoc(doc(admin(), A), { restoredAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(admin(), A), { deleteAfter: days(10) }));     // only 20 days after closedAt
    await assertSucceeds(updateDoc(doc(admin(), A), { deleteAfter: days(25) }));  // 35 days after closedAt
    await assertSucceeds(updateDoc(doc(admin(), A), { deleteAfter: null }));
    await assertFails(updateDoc(doc(admin(), A), { status: "abandoned" }));
    await assertFails(updateDoc(doc(admin(), A), { counts: { candidates: 0 } }));
  });

  it("deletes: saving, saved and abandoned at once; clearing never; closed only after deleteAfter", async () => {
    for (const s of ["saving", "saved", "abandoned"]) {
      await seed(A, attempt(s));
      await assertSucceeds(deleteDoc(doc(admin(), A)), s);
    }
    await seed(A, attempt("clearing"));
    await assertFails(deleteDoc(doc(admin(), A)));
    await seed(A, attempt("clearing", { deleteAfter: ago(60) }));    // carried into clearing by a bug: still refused
    await assertFails(deleteDoc(doc(admin(), A)));
    await seed(A, attempt("closed", { closedAt: ago(60 * 24 * 40), deleteAfter: days(5) }));
    await assertFails(deleteDoc(doc(admin(), A)));
    await seed(A, attempt("closed", { closedAt: ago(60 * 24 * 40), deleteAfter: null }));
    await assertFails(deleteDoc(doc(admin(), A)));                   // no retention set: never
    await seed(A, attempt("closed", { closedAt: ago(60 * 24 * 40), deleteAfter: ago(60) }));
    await assertSucceeds(deleteDoc(doc(admin(), A)));
  });

  it("a second attempt for the same roundId (close, bring back, close again) is accepted", async () => {
    await seed("interviews_archive/a-0", attempt("closed", { roundId: "r-1", closedAt: ago(60 * 24 * 40) }));
    await assertSucceeds(setDoc(doc(admin(), A), attempt("saving", { roundId: "r-1", owner: owner("p-B") })));
  });
});

// ============================================================================
describe("close ownership on interviews_archive (review 3 M1): the sleeping laptop", () => {
  const A = "interviews_archive/a-1";
  beforeEach(async () => {
    // page B took over from page A, which is asleep; the attempt is clearing
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", load: "l-b", at: ago(1) } });
    await seed(A, { status: "clearing", roundId: "r-1", owner: { tab: "p-A", load: "l-a", at: ago(9) } });
  });

  it("stale page A cannot renew, stop, reopen or abandon B's clearing attempt", async () => {
    const db = admin();
    await assertFails(setDoc(doc(db, STATE), { lease: claim("p-A", "l-a") }, { merge: true }));                 // heartbeat
    await assertFails(setDoc(doc(db, STATE), { roundStatus: "open", closingTab: null, lease: claim("p-A") }, { merge: true }));  // idle auto-stop
    await assertFails(updateDoc(doc(db, A), { status: "abandoned", owner: owner("p-A", "l-a") }));               // "Stop closing"
    const b = writeBatch(db);                                                                                  // stop as one batch
    b.set(doc(db, STATE), { roundStatus: "open", closingTab: null, lease: claim("p-A") }, { merge: true });
    b.update(doc(db, A), { status: "abandoned", owner: owner("p-A") });
    await assertFails(b.commit());
  });

  it("an owner claim that is not fresh, names the wrong tab, or is for another attempt is refused", async () => {
    await assertFails(updateDoc(doc(admin(), A), { status: "abandoned", owner: { tab: "p-B", at: ago(0.2) } }));
    await assertFails(updateDoc(doc(admin(), A), { status: "abandoned", owner: owner("p-X") }));
    await seed("interviews_archive/a-OLD", { status: "saved", roundId: "r-1" });
    await assertFails(updateDoc(doc(admin(), "interviews_archive/a-OLD"), { status: "clearing", owner: owner("p-B") }));
  });

  it("B can finish in one batch: state reopened, attempt closed, history entry", async () => {
    const db = admin();
    const b = writeBatch(db);
    b.set(doc(db, STATE), { roundStatus: "open", closingTab: null, closingAttemptId: null, roundId: "r-2", lease: claim("p-B", "l-b") }, { merge: true });
    b.update(doc(db, A), { status: "closed", closedAt: serverTimestamp(), deleteAfter: days(731), owner: owner("p-B", "l-b") });
    b.set(doc(db, "interviews_history/h-close"), { at: serverTimestamp(), by: "leadership", action: "round.close", text: "Closed the round" });
    await assertSucceeds(b.commit());
    assert.equal((await raw(STATE)).data().closingTab, null);
  });

  it("stored owner null or a string on an attempt: the holder's fresh-claim status change still passes", async () => {
    await seed(A, { status: "clearing", roundId: "r-1", owner: null });
    await assertSucceeds(updateDoc(doc(admin(), A), { status: "abandoned", owner: owner("p-B") }));
    await seed(A, { status: "clearing", roundId: "r-1", owner: "p-A" });
    await assertSucceeds(updateDoc(doc(admin(), A), { status: "abandoned", owner: owner("p-B") }));
    await seed(A, { status: "saved", roundId: "r-1", owner: 7 });
    await assertSucceeds(updateDoc(doc(admin(), A), { status: "clearing", owner: owner("p-B") }));
  });

  it("an attempt write with a non-map owner claim is refused, not an error", async () => {
    await assertFails(updateDoc(doc(admin(), A), { status: "abandoned", owner: "p-B" }));
    await assertFails(updateDoc(doc(admin(), A), { status: "abandoned", owner: null }));
  });

  it("the holder can delete working-round documents while clearing (history only while closing)", async () => {
    await seed("interviews_history/h1", { at: ago(5), by: "leadership", action: "x", text: "y" });
    await seed("interviews_screening/Marrocco~c-1", { rating: 4 });
    const db = admin();
    await assertSucceeds(runTransaction(db, async (tx) => {
      await tx.get(doc(db, STATE)); await tx.get(doc(db, A));
      tx.set(doc(db, STATE), { lease: claim("p-B", "l-b") }, { merge: true });
      tx.delete(doc(db, "interviews_history/h1"));
      tx.delete(doc(db, "interviews_screening/Marrocco~c-1"));
    }));
  });
});

// ============================================================================
describe("archive parts", () => {
  const A = "interviews_archive/a-1";
  beforeEach(async () => {
    await seed(STATE, { roundStatus: "closing", closingTab: "p-B", closingAttemptId: "a-1", lease: { tab: "p-B", at: ago(1) } });
  });

  it("parts can be created only while their attempt is saving and is the current attempt", async () => {
    await seed(A, { status: "saving" });
    await assertSucceeds(setDoc(doc(admin(), A + "/parts/0"), { i: 0, json: "{}" }));
    await seed(A, { status: "saved" });
    await assertFails(setDoc(doc(admin(), A + "/parts/1"), { i: 1, json: "{}" }));
    await seed("interviews_archive/a-OLD", { status: "saving" });
    await assertFails(setDoc(doc(admin(), "interviews_archive/a-OLD/parts/0"), { i: 0, json: "{}" }));
    await assertFails(setDoc(doc(admin(), "interviews_archive/a-NONE/parts/0"), { i: 0, json: "{}" }));
  });

  it("a part is never updated, even while saving", async () => {
    await seed(A, { status: "saving" });
    await seed(A + "/parts/0", { i: 0, json: "{}" });
    await assertFails(setDoc(doc(admin(), A + "/parts/0"), { i: 0, json: "{\"x\":1}" }));
    await assertFails(updateDoc(doc(admin(), A + "/parts/0"), { json: "[]" }));
  });

  it("a part of 900,000 bytes of multibyte text is accepted", async () => {
    await seed(A, { status: "saving" });
    const text = "€é’".repeat(112500);           // 3 + 2 + 3 bytes = 8 bytes x 112,500 = 900,000 bytes
    assert.equal(new TextEncoder().encode(text).length, 900000);
    await assertSucceeds(setDoc(doc(admin(), A + "/parts/0"), { i: 0, json: text }));
    assert.equal((await raw(A + "/parts/0")).data().json.length, text.length);
  });

  it("parts of saving, saved and abandoned attempts can be deleted at once; of clearing never; of closed only when due", async () => {
    for (const s of ["saving", "saved", "abandoned"]) {
      await seed(A, { status: s });
      await seed(A + "/parts/0", { i: 0, json: "{}" });
      await assertSucceeds(deleteDoc(doc(admin(), A + "/parts/0")), s);
    }
    await seed(A, { status: "clearing" });
    await seed(A + "/parts/0", { i: 0, json: "{}" });
    await assertFails(deleteDoc(doc(admin(), A + "/parts/0")));
    await seed(A, { status: "closed", closedAt: ago(60 * 24 * 40), deleteAfter: days(3) });
    await assertFails(deleteDoc(doc(admin(), A + "/parts/0")));
    await seed(A, { status: "closed", closedAt: ago(60 * 24 * 40), deleteAfter: ago(1) });
    await assertSucceeds(deleteDoc(doc(admin(), A + "/parts/0")));
  });

  it("a part whose parent attempt is gone can be deleted", async () => {
    await seed("interviews_archive/a-GONE/parts/0", { i: 0, json: "{}" });
    await assertSucceeds(deleteDoc(doc(admin(), "interviews_archive/a-GONE/parts/0")));
  });

  it("ED and Guest cannot touch parts", async () => {
    await seed(A, { status: "saving" });
    for (const db of [committee(), applicant()]) {
      await assertFails(setDoc(doc(db, A + "/parts/0"), { i: 0, json: "{}" }));
    }
  });
});

// ============================================================================
//  Load-bearing check: with stageOpen() forced to true, the stage refusals
//  above would pass. Loaded into its own project id so it cannot leak into
//  the real suite.
// ============================================================================
describe("load-bearing: the stage gates are what refuse", () => {
  let broken;
  before(async () => {
    const forced = RULES.replace(/function stageOpen\(s\) \{[\s\S]*?\n    \}/, "function stageOpen(s) { return true; }");
    assert.notEqual(forced, RULES, "could not find stageOpen() to break");
    broken = await initializeTestEnvironment({ projectId: "mgh-ed-hiring-test-v2-broken", firestore: { rules: forced, host: "127.0.0.1", port: 8080 } });
  });
  after(async () => { if (broken) await broken.cleanup(); });

  it("with stageOpen() forced true, ED writes during closed stages and a closing round go through", async () => {
    await broken.clearFirestore();
    await broken.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), STATE),
      { roundStatus: "closing", stages: { screening: { closed: true }, scoring: { closed: true }, availability: { closed: true } } }));
    const ed = broken.authenticatedContext(UID.committee, pw("committee@mgh-ed-hiring.invalid")).firestore();
    await assertSucceeds(setDoc(doc(ed, "interviews_screening/Marrocco~c-1"), { rating: 3 }, { merge: true }));
    await assertSucceeds(setDoc(doc(ed, "interviews_scores/Marrocco~c-1"), { overall: 3 }, { merge: true }));
    await assertSucceeds(setDoc(doc(ed, "interviews_availIv/Marrocco"), { slots: { t1: "ip" } }, { merge: true }));
  });
});
