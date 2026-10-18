// R7d: the pages sign in with the .invalid emails only, and no old address is
// left in the page code. The old ones were on domains anyone could buy; a
// branch still carrying them (made before R7c and R7d) would lock everyone out
// after the email switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { AUTH, PARTNERS } from "../js/config.js";

const root = new URL("../", import.meta.url);

test("every sign-in email in js/config.js ends in .invalid (hiring and Motion Voting)", () => {
  const emails = [AUTH.adminEmail, AUTH.committeeEmail, AUTH.candidateEmail, PARTNERS.voting.leadershipEmail, PARTNERS.voting.edEmail];
  for (const e of emails) assert.match(e, /^[a-z]+@[a-z0-9-]+\.invalid$/, e);
  assert.equal(new Set(emails).size, 5);
});

test("no @ed-hiring.app or @ed-motion-voting.app address anywhere in js/ or a page", () => {
  const files = [...readdirSync(new URL("js/", root)).filter((n) => n.endsWith(".js")).map((n) => "js/" + n),
    ...readdirSync(root).filter((n) => n.endsWith(".html"))];
  for (const f of files) {
    const src = readFileSync(new URL(f, root), "utf8");
    assert.doesNotMatch(src, /@ed-hiring\.app|@ed-motion-voting\.app/, f);
  }
});
