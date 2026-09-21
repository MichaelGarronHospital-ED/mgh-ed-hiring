// ============================================================================
//  Security-rule tests for the interviews tool.
//
//  These assert the promises the tool makes to real people:
//    • applicants cannot see the roster, the questions, the scores or each other
//    • reviewers cannot see anyone's scores or screening (so no one can peek at
//      the ranking mid-process, which is the anti-bias guarantee)
//    • only the admin account can change setup (roster, chair, times)
//
//  They run against the local Firestore emulator — no real project, no real
//  data, no credentials. Run with:  npm test     (see README.md)
// ============================================================================

import { before, after, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, deleteDoc } from "firebase/firestore";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "mgh-ed-hiring-test",
    firestore: {
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); });

// ---- the four accounts the rules know about, plus two it should not -------
// These emails must match AUTH in js/config.js and the constants in
// firestore.rules. If someone renames a role account in one place and not the
// other, these tests fail — which is the point.
const admin     = () => testEnv.authenticatedContext("u-admin",     { email: "admin@ed-hiring.app" }).firestore();
const committee = () => testEnv.authenticatedContext("u-committee", { email: "committee@ed-hiring.app" }).firestore();
const applicant = () => testEnv.authenticatedContext("u-applicant", { email: "applicant@ed-hiring.app" }).firestore();
// someone with a valid Firebase account that isn't one of the three roles
const stranger  = () => testEnv.authenticatedContext("u-stranger",  { email: "someone@example.com" }).firestore();
// an Anonymous sign-in: authenticated, but the token carries no email at all.
// AUTH.mode used to be "anon", so this is the shape of a stale client.
const anonUser  = () => testEnv.authenticatedContext("u-anon").firestore();
const signedOut = () => testEnv.unauthenticatedContext().firestore();

// Write a document bypassing the rules, so we have something to try to read.
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

const SCORE   = "interviews_scores/Marrocco~c-1";
const SCREEN  = "interviews_screening/Marrocco~c-1";
const CAND    = "interviews_candidates/c-1";
const AVAIL_C = "interviews_availCand/nguyen";
const ALLOWED = "interviews_meta/allowed";
const AVAIL_I = "interviews_availIv/Marrocco";
const CONFIG  = "interviews_meta/config";
const PUBLIC  = "interviews_public/slots";

// ============================================================================
describe("the ranking stays private to the admin", () => {
  // This is the whole reason scores are admin-read-only: if a reviewer could
  // read the scores collection they could compute the ranking mid-process and
  // be anchored by it. DESIGN.md calls this out as an anti-bias requirement.

  it("a reviewer CANNOT read an individual score", async () => {
    await seed(SCORE, { member: "Marrocco", candId: "c-1", overall: 4 });
    await assertFails(getDoc(doc(committee(), SCORE)));
  });

  it("a reviewer CANNOT list the scores collection", async () => {
    // the app subscribes with onSnapshot(collection(...)), which is a list
    await seed(SCORE, { overall: 4 });
    await assertFails(getDocs(collection(committee(), "interviews_scores")));
  });

  it("a reviewer CAN submit a score", async () => {
    await assertSucceeds(setDoc(doc(committee(), SCORE), { member: "Marrocco", candId: "c-1", overall: 4 }));
  });

  it("the admin CAN read scores", async () => {
    await seed(SCORE, { overall: 4 });
    await assertSucceeds(getDoc(doc(admin(), SCORE)));
    await assertSucceeds(getDocs(collection(admin(), "interviews_scores")));
  });
});

describe("screening input stays private to the admin", () => {
  // Same shape as scores: reviewers submit flags but must not see each other's,
  // so one person's concern can't anchor the rest of the committee.

  it("a reviewer CANNOT read screening", async () => {
    await seed(SCREEN, { member: "Marrocco", candId: "c-1", flag: true, reason: "x" });
    await assertFails(getDoc(doc(committee(), SCREEN)));
    await assertFails(getDocs(collection(committee(), "interviews_screening")));
  });

  it("a reviewer CAN submit screening", async () => {
    await assertSucceeds(setDoc(doc(committee(), SCREEN), { member: "Marrocco", candId: "c-1", flag: true }));
  });

  it("the admin CAN read screening", async () => {
    await seed(SCREEN, { flag: true });
    await assertSucceeds(getDoc(doc(admin(), SCREEN)));
  });
});

describe("an applicant cannot reach any committee data", () => {
  // An applicant signs in with a shared code. They must never be able to see
  // who else applied, who is interviewing them, the scores, or the setup.

  it("CANNOT read the candidate roster (other applicants' names)", async () => {
    await seed(CAND, { name: "Dr Jane Doe", removed: false });
    await assertFails(getDoc(doc(applicant(), CAND)));
    await assertFails(getDocs(collection(applicant(), "interviews_candidates")));
  });

  it("CANNOT read scores or screening", async () => {
    await seed(SCORE, { overall: 4 });
    await seed(SCREEN, { flag: true });
    await assertFails(getDoc(doc(applicant(), SCORE)));
    await assertFails(getDoc(doc(applicant(), SCREEN)));
  });

  it("CANNOT read interviewer availability", async () => {
    await seed(AVAIL_I, { slots: { 0: "either" } });
    await assertFails(getDoc(doc(applicant(), AVAIL_I)));
  });

  it("CANNOT read the setup config (roster, chair, panel overrides)", async () => {
    await seed(CONFIG, { committee: [{ name: "Vojdani", gender: "M" }], chair: "Vojdani" });
    await assertFails(getDoc(doc(applicant(), CONFIG)));
  });

  it("CANNOT write anything to the committee's collections", async () => {
    await assertFails(setDoc(doc(applicant(), CAND), { name: "injected" }));
    await assertFails(setDoc(doc(applicant(), SCORE), { overall: 5 }));
    await assertFails(setDoc(doc(applicant(), CONFIG), { chair: "Nobody" }));
  });
});

describe("an applicant can do their own scheduling, and nothing more", () => {
  it("CAN read the PII-free published time list", async () => {
    await seed(PUBLIC, { times: [{ id: "0", date: "2026-10-01", start: "09:00", end: "10:00" }] });
    await assertSucceeds(getDoc(doc(applicant(), PUBLIC)));
  });

  it("CAN submit and update their own availability", async () => {
    await seed(ALLOWED, { keys: ["nguyen"] });
    await assertSucceeds(setDoc(doc(applicant(), AVAIL_C), { slots: { 0: "either" } }));
    await assertSucceeds(setDoc(doc(applicant(), AVAIL_C), { slots: { 1: "zoom" } }, { merge: true }));
  });

  // The silent-loss bug this gate exists to prevent: a typo, a married name, or
  // the wrong half of a double-barrelled surname used to save happily to a
  // document nobody reads. The applicant saw "Saved" and was never scheduled.
  it("CANNOT submit availability under a surname that is not on the roster", async () => {
    await seed(ALLOWED, { keys: ["nguyen"] });
    await assertFails(setDoc(doc(applicant(), "interviews_availCand/nguyeen"), { slots: { 0: "ip" } }));
    await assertFails(setDoc(doc(applicant(), "interviews_availCand/smith"), { slots: { 0: "ip" } }));
  });

  it("CANNOT submit availability when the roster list is missing (fail closed)", async () => {
    // No ALLOWED doc seeded. Publishing the rules before syncing the list must
    // refuse writes rather than wave them through unchecked.
    await assertFails(setDoc(doc(applicant(), AVAIL_C), { slots: { 0: "either" } }));
  });

  it("CANNOT read the roster surname list that gates their own writes", async () => {
    await seed(ALLOWED, { keys: ["nguyen", "okafor"] });
    await assertFails(getDoc(doc(applicant(), ALLOWED)));
  });

  it("CANNOT read back even their own availability (write-without-read)", async () => {
    // Deliberate: reading availCand at all would expose every applicant's
    // answers, since they share one account. This is why the app keeps a
    // localStorage echo so a returning applicant still sees their picks.
    await seed(AVAIL_C, { slots: { 0: "either" } });
    await assertFails(getDoc(doc(applicant(), AVAIL_C)));
  });

  it("CANNOT delete an availability document", async () => {
    await seed(AVAIL_C, { slots: { 0: "either" } });
    await assertFails(deleteDoc(doc(applicant(), AVAIL_C)));
  });

  it("CANNOT publish or tamper with the time list", async () => {
    await assertFails(setDoc(doc(applicant(), PUBLIC), { times: [] }));
  });
});

describe("only the admin can change setup", () => {
  // The roster, the chair and the interview times drive panel building. A
  // reviewer must not be able to rewrite them.

  it("a reviewer CAN read the config but CANNOT write it", async () => {
    await seed(CONFIG, { chair: "Vojdani" });
    await assertSucceeds(getDoc(doc(committee(), CONFIG)));
    await assertFails(setDoc(doc(committee(), CONFIG), { chair: "Someone Else" }));
  });

  it("the admin CAN write the config", async () => {
    await assertSucceeds(setDoc(doc(admin(), CONFIG), { chair: "Vojdani", committee: [] }));
  });

  it("a reviewer CANNOT publish the applicant-facing time list", async () => {
    await assertFails(setDoc(doc(committee(), PUBLIC), { times: [] }));
  });

  it("the admin CAN publish the applicant-facing time list", async () => {
    await assertSucceeds(setDoc(doc(admin(), PUBLIC), { times: [] }));
  });
});

describe("reviewers can do their own job", () => {
  // Guard against over-tightening the rules: these must keep working.

  it("CAN read the candidate roster and add candidates", async () => {
    await seed(CAND, { name: "Dr Jane Doe", removed: false });
    await assertSucceeds(getDocs(collection(committee(), "interviews_candidates")));
    await assertSucceeds(setDoc(doc(committee(), "interviews_candidates/c-2"), { name: "Dr B", removed: false }));
  });

  it("CAN read and write interviewer availability", async () => {
    await assertSucceeds(setDoc(doc(committee(), AVAIL_I), { slots: { 0: "either" } }));
    await assertSucceeds(getDocs(collection(committee(), "interviews_availIv")));
  });

  it("CAN read applicant availability (needed to build panels)", async () => {
    await seed(AVAIL_C, { slots: { 0: "either" } });
    await assertSucceeds(getDocs(collection(committee(), "interviews_availCand")));
  });
});

describe("accounts the rules do not know get nothing", () => {
  const everything = [SCORE, SCREEN, CAND, AVAIL_C, AVAIL_I, CONFIG, PUBLIC];

  it("a signed-out visitor is denied everywhere", async () => {
    for (const path of everything) {
      await seed(path, { x: 1 });
      await assertFails(getDoc(doc(signedOut(), path)));
      await assertFails(setDoc(doc(signedOut(), path), { x: 2 }));
    }
  });

  it("an Anonymous sign-in (no email in the token) is denied everywhere", async () => {
    // AUTH.mode "anon" is the old, UI-only security model. If a stale client
    // ever signs in anonymously against the hardened rules it must get nothing.
    for (const path of everything) {
      await seed(path, { x: 1 });
      await assertFails(getDoc(doc(anonUser(), path)));
      await assertFails(setDoc(doc(anonUser(), path), { x: 2 }));
    }
  });

  it("a valid Firebase account with a different email is denied everywhere", async () => {
    for (const path of everything) {
      await seed(path, { x: 1 });
      await assertFails(getDoc(doc(stranger(), path)));
      await assertFails(setDoc(doc(stranger(), path), { x: 2 }));
    }
  });

  it("no one can touch a collection the rules never mention", async () => {
    await seed("some_other_collection/doc", { x: 1 });
    for (const db of [admin(), committee(), applicant(), signedOut()]) {
      await assertFails(getDoc(doc(db, "some_other_collection/doc")));
      await assertFails(setDoc(doc(db, "some_other_collection/doc"), { x: 2 }));
    }
  });
});

describe("KNOWN LIMITATIONS — asserted so that changing them is deliberate", () => {
  // These are NOT endorsements. They pin down behaviour that is currently
  // accepted and documented, so that if someone tightens or loosens the rules
  // the test tells them which documented tradeoff they just moved.

  it("one applicant CAN still overwrite ANOTHER ROSTERED applicant's availability", async () => {
    // Documented in firestore.rules (“Honest limits”). All applicants share one
    // account and submit under their own typed last name, so nothing stops a
    // person typing someone else's surname. Low impact and admin-auditable; the
    // alternative (per-candidate tokens) breaks the one-link flow.
    //
    // NARROWED, not closed: the surname must now be on the roster, so the target
    // has to be a real applicant — a stranger can no longer write anywhere in
    // this collection (see "CANNOT submit availability under a surname that is
    // not on the roster"). Two applicants who share a surname still share one
    // document; report-data.mjs --issues flags that case.
    // If this ever starts FAILING, someone implemented per-applicant identity —
    // update DESIGN.md and delete this test.
    await seed(ALLOWED, { keys: ["nguyen"] });
    await seed("interviews_availCand/nguyen", { slots: { 0: "either" } });
    await assertSucceeds(
      setDoc(doc(applicant(), "interviews_availCand/nguyen"), { slots: { 3: "zoom" } }, { merge: true }));
  });

  it("reviewers share one account, so rules cannot tell reviewer A from B", async () => {
    // A reviewer submits under whatever name they picked at the "Who are you?"
    // screen; the rules only see committee@ed-hiring.app. So one reviewer can
    // overwrite another's score. Per-member enforcement would need per-member
    // accounts or custom claims. This is the main residual risk in the model.
    await seed("interviews_scores/Marrocco~c-1", { member: "Marrocco", overall: 5 });
    await assertSucceeds(
      setDoc(doc(committee(), "interviews_scores/Marrocco~c-1"), { member: "Marrocco", overall: 1 }));
  });
});
