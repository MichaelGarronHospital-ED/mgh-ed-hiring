// Change history (H12): texts never hold names, and undo is offered only when
// the thing changed is exactly as the entry left it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, panelUndo, shortlistUndo, screeningUndo, canUndo, undoneIds, textFor, whoFor, whenFor, hashOf,
  canonicalJson, UNDOABLE, ACTIONS } from "../js/history.js";

test("an entry is cut to the rules' limits and never stamps its own time", () => {
  const e = entry("panel.save", "x".repeat(700), { cand: "c-1", by: "Yang" });
  assert.equal(e.text.length, 600);
  assert.equal(e.by, "Yang");
  assert.equal("at" in e, false);
  assert.ok(entry("a".repeat(80), "t").action.length <= 60);
  assert.equal(entry("x", "y", { id: "h1" })._id, "h1");
});

test("only the five undoable actions are undoable, and every action name is short", () => {
  assert.deepEqual([...UNDOABLE].sort(), ["panel.reset", "panel.resetAll", "panel.save", "screening.toNote", "shortlist.set"]);
  ACTIONS.forEach((a) => assert.ok(a.length <= 60));
});

test("names are drawn from ids at display time", () => {
  const ctx = { candName: (id) => ({ "c-1": "Dr Rosalind Ashcombe" }[id]), memberName: (id) => ({ "m-1": "Marrocco" }[id]) };
  assert.equal(textFor(entry("panel.save", "Saved a hand-made panel for {cand}", { cand: "c-1" }), ctx),
    "Saved a hand-made panel for Dr Rosalind Ashcombe");
  assert.equal(textFor(entry("roster.add", "Added", { cand: "c-1" }), ctx), "Added: Dr Rosalind Ashcombe");
  assert.equal(textFor(entry("chair.set", "Changed the chair to {member}", { member: "m-1" }), ctx), "Changed the chair to Marrocco");
  assert.equal(textFor(entry("roster.delete", "Deleted {cand}", { cand: "c-gone" }), ctx), "Deleted an applicant");
  assert.equal(whoFor({ by: "leadership" }), "Admin");
  assert.equal(whoFor({ by: "m-1" }, ctx.memberName), "Admin (Marrocco)");
  assert.equal(whenFor(null), "Just now");
  assert.match(whenFor({ __ts: "2027-03-01T19:14:00.000Z" }), /^Mar 1, \d+:14 (am|pm)$/);
});

test("hash is order-independent for keys and stable", () => {
  assert.equal(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] }), hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.equal(canonicalJson({ b: 1, a: undefined, c: null }), '{"b":1,"c":null}');
});

test("panel undo: offered while unchanged, refused once changed, and marked once undone", () => {
  const before = { "c-1": { slot: "t1", members: ["A", "B", "C"] }, "c-2": { slot: "t2", members: ["A", "D", "E"] } };
  const after = {};
  const e = { id: "h1", ...entry("panel.resetAll", "Reset 2 hand-made panels", { undo: panelUndo(before, after, ["c-1", "c-2"]) }) };
  assert.deepEqual(canUndo(e, { settings: { panelOverrides: {} } }), { ok: true, why: "" });
  assert.equal(canUndo(e, { settings: { panelOverrides: { "c-1": { slot: "t3", members: [] } } } }).why, "Can't undo: changed since.");
  // an unrelated panel changing does not block it
  assert.equal(canUndo(e, { settings: { panelOverrides: { "c-9": { slot: "t3" } } } }).ok, true);
  const done = undoneIds([{ action: "undo", undo: { of: "h1" } }]);
  assert.equal(canUndo(e, { settings: { panelOverrides: {} } }, done).why, "Undone.");
});

test("shortlist and screening undo compare one thing", () => {
  const e = { action: "shortlist.set", cand: "c-1", undo: shortlistUndo({ shortlist: null }, { shortlist: "in", shortlistBy: "leadership" }) };
  assert.equal(canUndo(e, { candidates: [{ id: "c-1", shortlist: "in", shortlistBy: "leadership" }] }).ok, true);
  assert.equal(canUndo(e, { candidates: [{ id: "c-1", shortlist: "out", shortlistBy: "leadership" }] }).ok, false);
  const s = { action: "screening.toNote", undo: screeningUndo("m~c", { flag: true, reason: "x" }, { flag: false, note: "x" }) };
  assert.equal(canUndo(s, { screening: { "m~c": { flag: false, note: "x" } } }).ok, true);
  assert.equal(canUndo(s, { screening: { "m~c": { flag: false, note: "y" } } }).ok, false);
});

test("logged-only actions and restored entries never offer undo", () => {
  assert.equal(canUndo(entry("schedule.lock", "Locked"), {}).ok, false);
  const e = { ...entry("panel.save", "x", { undo: panelUndo({}, {}, ["c"]) }), restored: true };
  assert.equal(canUndo(e, { settings: {} }).ok, false);
});
