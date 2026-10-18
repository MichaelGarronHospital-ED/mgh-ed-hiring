// H14: keys for applicants who share a surname. Pure; no emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastKey, firstKey, givenKey, typedFirstKeys, candKey, dupKey } from "../js/util.js";
import { assignKeys, sharedDocs, sharedSurnameText, claimPlan, typeExactly } from "../js/candidates.js";

test("firstKey and givenKey drop titles and use the same normalising as lastKey", () => {
  assert.equal(firstKey("Dr Jane Kim"), "jane");
  assert.equal(firstKey("Dr. Jane Kim"), "jane");
  assert.equal(firstKey("Prof Ana-Lucía Brill"), "analuca");
  assert.equal(firstKey("Kim"), "");
  assert.equal(firstKey("Dr Kim"), "");
  assert.equal(givenKey("Dr Jane A. Kim"), "janea");
  assert.equal(lastKey("Dr Jane A. Kim"), "kim");
  assert.deepEqual(typedFirstKeys("Jane"), ["jane"]);
  assert.deepEqual(typedFirstKeys(" Dr  Jane A. "), ["janea", "jane"]);
  assert.deepEqual(typedFirstKeys(""), []);
});

test("candKey: their own key when set, else today's surname key", () => {
  assert.equal(candKey({ name: "Dr Jane Kim" }), "kim");
  assert.equal(candKey({ name: "Dr Jane Kim", availKey: "kim-jane" }), "kim-jane");
  assert.equal(dupKey({ name: "Dr Jane Kim" }), "kim-jane");
});

test("assignKeys: a unique surname needs nothing; two Kims each get their own", () => {
  assert.deepEqual(assignKeys([{ id: "a", name: "Dr Rosalind Ashcombe" }]).patches, {});
  const r = assignKeys([{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Dr Min Kim" }, { id: "c", name: "Dr Ana Brill" }]);
  assert.deepEqual(r.patches, { a: { availKey: "kim-jane" }, b: { availKey: "kim-min" } });
  assert.deepEqual(r.groups.map((g) => g.key), ["kim"]);
  assert.deepEqual(r.clash, []);
});

test("assignKeys: matching first names use every given name; identical names clash", () => {
  const r = assignKeys([{ id: "a", name: "Dr Jane A Kim" }, { id: "b", name: "Dr Jane B Kim" }]);
  assert.deepEqual(r.patches, { a: { availKey: "kim-janea" }, b: { availKey: "kim-janeb" } });
  const c = assignKeys([{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Jane Kim" }]);
  assert.deepEqual(c.patches, {});
  assert.equal(c.clash.length, 2);
});

test("assignKeys: never re-keys someone who has a key; a removed Kim doesn't count", () => {
  const r = assignKeys([{ id: "a", name: "Dr Jane Kim", availKey: "kim-jane" }, { id: "b", name: "Dr Min Kim" }]);
  assert.deepEqual(r.patches, { b: { availKey: "kim-min" } });
  const gone = assignKeys([{ id: "a", name: "Dr Jane Kim", availKey: "kim-jane", removed: true }, { id: "b", name: "Dr Min Kim" }]);
  assert.deepEqual(gone.patches, {});
});

test("sharedDocs: answers under the plain surname are a question for Admin, not a guess", () => {
  const st = { candidates: [{ id: "a", name: "Dr Jane Kim", availKey: "kim-jane" }, { id: "b", name: "Dr Min Kim", availKey: "kim-min" }],
    availCand: { kim: { t1: "ip" } } };
  assert.deepEqual(sharedDocs(st).map((d) => [d.key, d.ids]), [["kim", ["a", "b"]]]);
  assert.deepEqual(sharedDocs(st, ["kim"]), [], "kept for reference: no longer asked");
  assert.deepEqual(sharedDocs({ ...st, availCand: { kim: {} } }), [], "no picks: nothing to ask");
  assert.match(sharedSurnameText(st.candidates, "kim"), /^Two applicants have the last name Kim: Jane Kim and Min Kim\./);
});

test("claimPlan moves the whole document to the chosen applicant, never over their new answers", () => {
  const st = { candidates: [{ id: "a", name: "Dr Jane Kim", availKey: "kim-jane" }, { id: "b", name: "Dr Min Kim", availKey: "kim-min" }],
    availRaw: { kim: { slots: { t1: "ip" }, reply: "confirmed" } }, availCand: { kim: { t1: "ip" } } };
  const p = claimPlan(st, "kim", "b");
  assert.deepEqual(p.writes, [{ coll: "interviews_availCand", id: "kim-min", data: { slots: { t1: "ip" }, reply: "confirmed" } }]);
  assert.deepEqual(p.deletes, [{ coll: "interviews_availCand", id: "kim" }]);
  const q = claimPlan({ ...st, availRaw: { ...st.availRaw, "kim-min": { slots: { t2: "zoom" } } } }, "kim", "b");
  assert.deepEqual(q.writes, []);
  assert.ok(q.skipped[0].includes("already answered again"));
});

// review M6: two applicants "Jane Kim" and "Jane B Kim". The page tries the
// surname, then each typed key in order; the most specific one must win.
test("Jane B Kim is found as herself, never as Jane Kim", () => {
  const keys = assignKeys([{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Dr Jane B Kim" }]).patches;
  const allowed = new Set([keys.a.availKey, keys.b.availKey]);
  const find = (first, last) => [lastKey(last), ...typedFirstKeys(first).map((f) => `${lastKey(last)}-${f}`)].find((k) => allowed.has(k));
  assert.equal(find("Jane B", "Kim"), "kim-janeb");
  assert.equal(find("Dr Jane B.", "Kim"), "kim-janeb");
  assert.equal(find("Jane", "Kim"), "kim-jane");
});

test("Jane B Kim beside Jane Kim must type \"Jane B\"; Admin is told so", () => {
  const g = [{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Dr Jane B Kim" }, { id: "c", name: "Dr Min Kim" }];
  assert.equal(typeExactly(g, g[1]), "Jane B");
  assert.equal(typeExactly(g, g[0]), null);
  assert.equal(typeExactly(g, g[2]), null);
  assert.match(sharedSurnameText(g, "kim"), /Jane B Kim must type the first name exactly as "Jane B"/);
  assert.doesNotMatch(sharedSurnameText([g[0], g[2]], "kim"), /exactly/);
});
