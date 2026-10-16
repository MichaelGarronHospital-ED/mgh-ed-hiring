// Members keyed by a stable id (H6). Legacy entries are { name, gender }: their
// id must be exactly their name, because every saved key already uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommittee, toStoredCommittee, newMemberId, validMemberId, memberName, interviewers, pickable,
  hasInput, idsWithInput, memberStatus, checkCommittee } from "../js/members.js";
import { COMMITTEE } from "../js/config.js";

test("legacy entries get id = name, interviewer, active (the keys live data already uses)", () => {
  const c = normalizeCommittee(COMMITTEE);
  assert.equal(c.length, COMMITTEE.length);
  c.forEach((m, i) => {
    assert.equal(m.id, COMMITTEE[i].name);
    assert.equal(m.name, COMMITTEE[i].name);
    assert.equal(m.role, "interviewer");
    assert.equal(m.active, true);
  });
});

test("order is kept and a repeated id keeps its first entry", () => {
  const c = normalizeCommittee([{ name: "Yang", gender: "M" }, { name: "Jha", gender: "M" }, { name: "Yang", gender: "F" }]);
  assert.deepEqual(c.map((m) => [m.id, m.gender]), [["Yang", "M"], ["Jha", "M"]]);
});

test("new-style entries keep their opaque id, role, active and email; junk is dropped", () => {
  const c = normalizeCommittee([
    { id: "m-k3x9p2", name: "Nguyen", gender: "", role: "screener", active: true, email: "a.b@tehn.ca" },
    { id: "Losier", name: "Losier", gender: "M", role: "interviewer", active: false },
    null, { name: "" }, { id: "bad/id", name: "Slash" },
  ]);
  assert.equal(c.length, 3);
  assert.deepEqual(c[0], { id: "m-k3x9p2", name: "Nguyen", gender: "", role: "screener", active: true, email: "a.b@tehn.ca" });
  assert.equal(c[1].active, false);
  assert.equal(c[2].id, "Slash");             // an unusable id falls back to the name
});

test("ids never contain / or ~", () => {
  for (let i = 0; i < 200; i++) { const id = newMemberId(); assert.ok(validMemberId(id), id); assert.match(id, /^m-[a-z0-9]+$/); }
  assert.equal(validMemberId("a~b"), false);
  assert.equal(validMemberId("a/b"), false);
  assert.equal(validMemberId(""), false);
});

test("stored form stays legacy-looking for legacy people", () => {
  const out = toStoredCommittee([{ name: "Yang", gender: "M" }, { id: "m-1", name: "Kim", gender: "F", role: "screener", active: false }]);
  assert.deepEqual(out, [{ id: "Yang", name: "Yang", gender: "M" }, { id: "m-1", name: "Kim", gender: "F", role: "screener", active: false }]);
});

test("names are for display; ids are the keys", () => {
  const c = normalizeCommittee([{ id: "m-1", name: "Marrocco", gender: "F" }, { id: "Hayre", name: "Hayre", gender: "M", active: false }]);
  assert.equal(memberName(c, "m-1"), "Marrocco");
  assert.equal(memberName(c, "gone"), "gone");
  assert.deepEqual(interviewers(c).map((m) => m.id), ["m-1"]);
  assert.deepEqual(pickable(c).map((m) => m.id), ["m-1"]);
  assert.equal(memberStatus(c, "Hayre"), "Left the committee");
  assert.equal(memberStatus(c, "m-1"), "Interviews and screens");
  assert.equal(memberStatus(c, "gone"), "Not on the list now");
});

test("hasInput and idsWithInput find screening, scores and availability", () => {
  const st = {
    screening: { "m-1~c-1": { rating: 4 }, "Bahar~c-1": { flag: false, rating: 0 } },
    scores: { "Klaiman~c-2": { overall: 0, notes: { 0: "good" } } },
    availIv: { Porfiris: { t1: "ip" }, Empty: {} },
  };
  assert.equal(hasInput(st, "m-1"), true);
  assert.equal(hasInput(st, "Bahar"), false);
  assert.equal(hasInput(st, "Klaiman"), true);
  assert.equal(hasInput(st, "Porfiris"), true);
  assert.equal(hasInput(st, "Empty"), false);
  assert.deepEqual([...idsWithInput(st)].sort(), ["Bahar", "Klaiman", "Porfiris", "m-1"]);
});

test("checkCommittee: duplicate names warn, missing gender warns, chair must stay an active interviewer", () => {
  const base = [{ id: "a", name: "Yang", gender: "M" }, { id: "b", name: "yang", gender: "F" }, { id: "c", name: "Kim", gender: "" }];
  const r = checkCommittee(base, { chair: "a" });
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("Two people are called Yang")));
  assert.ok(r.warnings.some((w) => w.includes("Kim interviews but has no F or M")));
  assert.ok(checkCommittee([{ id: "a", name: "Yang", gender: "M", active: false }], { chair: "a" }).errors[0].includes("Pick another chair first"));
  assert.ok(checkCommittee([{ id: "a", name: "Yang", gender: "M", role: "screener" }], { chair: "a" }).errors.length);
  assert.ok(checkCommittee([], {}).errors.length);
});
