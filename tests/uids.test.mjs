// R7c: the role uids in js/config.js (the pages) equal the ones in
// firestore.rules (the server), and no page decides a role by email.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { AUTH, PARTNERS } from "../js/config.js";

const root = new URL("../", import.meta.url);
const rules = readFileSync(new URL("firestore.rules", root), "utf8");
const ruleUid = (fn) => { const m = rules.match(new RegExp(`function ${fn}\\(\\)\\s*\\{\\s*return signedIn\\('([^']+)'\\)`)); return m && m[1]; };

test("config uids equal the rules' uids", () => {
  assert.equal(AUTH.uids.admin, ruleUid("isAdmin"));
  assert.equal(AUTH.uids.committee, ruleUid("isCommittee"));
  assert.equal(AUTH.uids.candidate, ruleUid("isApplicant"));
  for (const u of [...Object.values(AUTH.uids), ...Object.values(PARTNERS.voting.uids)]) assert.match(u, /^[A-Za-z0-9]{20,}$/);
  assert.equal(new Set([...Object.values(AUTH.uids), ...Object.values(PARTNERS.voting.uids)]).size, 5);
});

test("the rules know a role only by uid and a password sign-in", () => {
  assert.match(rules, /request\.auth\.uid == uid\s*\n?\s*&& request\.auth\.token\.firebase\.sign_in_provider == 'password'/);
  assert.doesNotMatch(rules, /token\.email\s*==/);
  assert.doesNotMatch(rules, /function em\(\)/);
});

test("no page decides a role by email", () => {
  for (const f of readdirSync(new URL("js/", root)).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL("js/" + f, root), "utf8");
    assert.doesNotMatch(src, /\.email\s*===|===\s*[\w.]*\.email\b|roleOfEmail/, f);
  }
});
