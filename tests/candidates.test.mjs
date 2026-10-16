// H5: rename, merge and permanent delete, as plans against fixtures. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renamePlan, mergePlan, deletePlan } from "../js/candidates.js";

// The remove-and-re-add fixture from scripts/seed-migration.mjs: "Rosalind
// Ashcombe" was screened, then removed and added again as "Rosalind Ashcomb".
const fixture = () => ({
  candidates: [{ id: "c-old", name: "Rosalind Ashcombe", removed: true }, { id: "c-new", name: "Rosalind Ashcomb", removed: false },
    { id: "c-ana", name: "Ana Brill", removed: false }],
  screening: {
    "Vojdani~c-old": { member: "Vojdani", candId: "c-old", rating: 4 },
    "Rivera~c-old": { member: "Rivera", candId: "c-old", flag: true, reason: "check CV gap" },
    "Nassar~c-old": { member: "Nassar", candId: "c-old", rating: 5 },
    "Nassar~c-new": { member: "Nassar", candId: "c-new", rating: 2 },   // already re-screened: must not be clobbered
    "Vojdani~c-new": { member: "Vojdani", candId: "c-new" },            // empty: safe to replace
    "Rivera~c-ana": { member: "Rivera", candId: "c-ana", rating: 3 },
  },
  scores: { "Vojdani~c-old": { member: "Vojdani", candId: "c-old", overall: 4, notes: { 0: "strong" } } },
  availCand: { ashcombe: { 0: "ip", 2: "either" } },
  availRaw: { ashcombe: { slots: { 0: "ip", 2: "either" }, reply: "confirmed", replyAt: { __ts: "2027-02-22T18:00:00.000Z" } } },
  settings: { panelOverrides: { "c-old": { slot: "0", members: ["Vojdani", "Rivera"] } } },
  offers: {},
});

test("merge: the remove-and-re-add case moves what it should and skips what it must", () => {
  const p = mergePlan(fixture(), "c-old", "c-new");
  const wrote = p.writes.map((w) => `${w.coll}/${w.id}`).sort();
  assert.deepEqual(wrote, ["interviews_availCand/ashcomb", "interviews_scores/Vojdani~c-new", "interviews_screening/Rivera~c-new",
    "interviews_screening/Vojdani~c-new"]);
  assert.ok(p.deletes.some((d) => d.coll === "interviews_screening" && d.id === "Vojdani~c-old"));
  assert.ok(!p.deletes.some((d) => d.id === "Nassar~c-old"), "Nassar's old rating is kept: the new entry has his input");
  assert.deepEqual(p.blocked, ["Nassar"]);
  const av = p.writes.find((w) => w.coll === "interviews_availCand");
  assert.deepEqual(av.data, { slots: { 0: "ip", 2: "either" }, reply: "confirmed", replyAt: { __ts: "2027-02-22T18:00:00.000Z" } },
    "the whole availability document moves, reply included");
  assert.deepEqual(p.overrides, { "c-new": { slot: "0", members: ["Vojdani", "Rivera"] }, "c-old": null });
  assert.deepEqual(p.candidates, { "c-old": { removed: true, mergedInto: "c-new" } });
  assert.equal(p.counts.ratings, 1); assert.equal(p.counts.concerns, 1); assert.equal(p.counts.scores, 1);
  assert.match(p.summary, /^Moves from 'Rosalind Ashcombe' to 'Rosalind Ashcomb': 1 rating, 1 concern, 1 score, their interview times and their hand-made panel\./);
  assert.match(p.summary, /Not moved, because these people already have input on 'Rosalind Ashcomb': Nassar\./);
  // nothing about Ana is touched
  assert.ok(![...p.writes, ...p.deletes].some((x) => x.id.endsWith("c-ana")));
});

test("merge: both have an offer, the target's is kept and the source's reported", () => {
  const st = { ...fixture(), offers: { "c-old": { status: "offered" }, "c-new": { status: "accepted" } } };
  const p = mergePlan(st, "c-old", "c-new");
  assert.ok(!p.writes.some((w) => w.coll === "interviews_offers"));
  assert.ok(p.skipped.some((s) => s.includes("offer")));
});

test("rename: case or spacing only moves nothing; a surname change moves the whole document", () => {
  const st = fixture();
  const same = renamePlan(st, "c-new", "rosalind  ASHCOMB");
  assert.deepEqual(same.writes, []); assert.equal(same.counts.timesMove, false);
  st.availCand = { ashcomb: { 1: "zoom" } }; st.availRaw = { ashcomb: { slots: { 1: "zoom" }, reply: "withdrawn" } };
  const moved = renamePlan(st, "c-new", "Rosalind Ashcombe-Lee");
  assert.deepEqual(moved.writes, [{ coll: "interviews_availCand", id: "ashcombelee", data: { slots: { 1: "zoom" }, reply: "withdrawn" } }]);
  assert.ok(moved.deletes.some((d) => d.coll === "interviews_availCand" && d.id === "ashcomb"));
  assert.equal(moved.candidates["c-new"].name, "Rosalind Ashcombe-Lee");
  assert.match(moved.summary, /Their interview times move with them/);
});

test("rename into a shared surname gives both their own keys and says so", () => {
  const st = { candidates: [{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Dr Min Kym" }], availCand: {} };
  const p = renamePlan(st, "b", "Dr Min Kim");
  assert.deepEqual(p.candidates, { a: { availKey: "kim-jane" }, b: { name: "Dr Min Kim", availKey: "kim-min" } });
  assert.match(p.shared, /Two applicants have the last name Kim/);
  const clash = renamePlan({ candidates: [{ id: "a", name: "Dr Jane Kim" }, { id: "b", name: "Dr Min Kym" }] }, "b", "Jane Kim");
  assert.match(clash.error, /same first and last name/);
});

test("delete: only an entry already removed; counts what goes; a key another applicant uses is kept", () => {
  assert.equal(deletePlan(fixture(), "c-new").error, "Remove them from the list first.");
  const p = deletePlan(fixture(), "c-old");
  assert.equal(p.counts.screening, 3); assert.equal(p.counts.scores, 1);
  assert.ok(p.deletes.some((d) => d.coll === "interviews_candidates" && d.id === "c-old"));
  assert.ok(p.deletes.some((d) => d.coll === "interviews_availCand" && d.id === "ashcombe"));
  assert.deepEqual(p.overrides, { "c-old": null });
  assert.equal(p.confirmWord, "ashcombe");
  assert.match(p.summary, /^Delete Rosalind Ashcombe permanently\? This removes their name and everything saved about them: 3 screening answers, 1 score, their interview times and their panel|their interview times, their panel/);
  const st = { ...fixture(), candidates: [...fixture().candidates, { id: "c-x", name: "Ivy Ashcombe" }] };
  const q = deletePlan(st, "c-old");
  assert.ok(!q.deletes.some((d) => d.coll === "interviews_availCand"), "a document another applicant still uses must stay");
});

test("an entry gone from the roster entirely: its input can still be moved or deleted", () => {
  const st = fixture(); st.candidates = st.candidates.filter((c) => c.id !== "c-old");
  const m = mergePlan(st, "c-old", "c-new");
  assert.ok(m.writes.length >= 3 && !m.candidates["c-old"]);
  const d = deletePlan(st, "c-old");
  assert.equal(d.confirmWord, "delete");
  assert.ok(!d.deletes.some((x) => x.coll === "interviews_candidates"));
});
