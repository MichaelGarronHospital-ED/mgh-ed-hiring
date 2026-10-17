// ============================================================================
//  Rules v3 (R7c): a role is its account's UID with a password sign-in, never
//  its email. These pin what the move of the account emails to .invalid
//  addresses needs: the right uid with the OLD email and with the NEW email
//  is allowed (tokens from before and after the change), the right email with
//  another uid is refused (an account somebody makes with a freed old email),
//  anonymous and custom-token sign-ins with the right uid are refused, and no
//  role's uid can act as another.
//  Its own project id (node --test runs the files in parallel on one emulator).
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { UID, OLD_EMAIL, NEW_EMAIL, pw } from "./helpers/identities.mjs";

const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "mgh-ed-hiring-test-uids", firestore: { rules: RULES, host: "127.0.0.1", port: 8080 } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, "interviews_scores/Abara~c-1"), { member: "Abara", candId: "c-1", overall: 4 });
    await setDoc(doc(db, "interviews_meta/config"), { committee: [] });
    await setDoc(doc(db, "interviews_public/slots"), { times: [] });
    await setDoc(doc(db, "interviews_meta/allowed"), { keys: ["ashcombe"] });
  });
});
const as = (uid, opts) => env.authenticatedContext(uid, opts).firestore();
// what each role, and only that role, can do
const CAN = {
  admin: (db) => getDoc(doc(db, "interviews_scores/Abara~c-1")),                            // Leadership only
  committee: (db) => getDoc(doc(db, "interviews_meta/config")),                             // ED (and Leadership)
  applicant: (db) => setDoc(doc(db, "interviews_availCand/ashcombe"), { slots: { t0: "ip" } }, { merge: true }),   // Guest
};

for (const role of ["admin", "committee", "applicant"]) {
  describe(`${role}: known by uid, not by email`, () => {
    it("the right uid with the OLD email is allowed (a token from before the change)", async () => {
      await assertSucceeds(CAN[role](as(UID[role], pw(OLD_EMAIL[role]))));
    });
    it("the right uid with the NEW .invalid email is allowed (a token from after the change)", async () => {
      await assertSucceeds(CAN[role](as(UID[role], pw(NEW_EMAIL[role]))));
    });
    it("the right email with another uid is refused (an account made with a freed email)", async () => {
      await assertFails(CAN[role](as("u-squatter", pw(OLD_EMAIL[role]))));
      await assertFails(CAN[role](as("u-squatter", pw(NEW_EMAIL[role]))));
    });
    it("the right uid signed in anonymously or with a custom token is refused", async () => {
      await assertFails(CAN[role](as(UID[role], { email: OLD_EMAIL[role], firebase: { sign_in_provider: "anonymous" } })));
      await assertFails(CAN[role](as(UID[role], { email: OLD_EMAIL[role], firebase: { sign_in_provider: "custom" } })));
    });
  });
}

describe("no role's uid acts as another", () => {
  it("the Guest uid can't read what ED reads, and ED can't read scores", async () => {
    await assertFails(CAN.committee(as(UID.applicant, pw(OLD_EMAIL.applicant))));
    await assertFails(CAN.admin(as(UID.committee, pw(OLD_EMAIL.committee))));
    await assertFails(CAN.admin(as(UID.applicant, pw(OLD_EMAIL.applicant))));
  });
  it("ED's uid with the Leadership email is still only ED", async () => {
    await assertFails(CAN.admin(as(UID.committee, pw(OLD_EMAIL.admin))));
    await assertSucceeds(CAN.committee(as(UID.committee, pw(OLD_EMAIL.admin))));
  });
});
