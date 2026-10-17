// Interview questions in Firestore (H2). The legacy ids must be exactly the
// keys every saved note already uses: "0".."n-1", the old list positions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromLegacy, normalizeQuestions, liveQuestions, scoringStarted, checkEdit, newQuestionId, QID_RE,
  idsWithNotes, toStoredQuestions } from "../js/questions.js";

const legacy = { q: ["Tell us about yourself", "A difficult case", "Why this ED?"], s: ["1", "2", "3", "4", "5"], g: ["Same questions for all"] };

test("legacy ids match today's note keys ('0'..'n-1')", () => {
  const d = fromLegacy(legacy);
  assert.deepEqual(d.questions.map((q) => q.id), ["0", "1", "2"]);
  assert.equal(d.migratedFrom, "data.js");
  // a note saved before migration, keyed by position, is found under the id
  const savedNotes = { 0: "a", 2: "c" };
  const Q = normalizeQuestions(d);
  assert.equal(savedNotes[Q.questions[0].id], "a");
  assert.equal(savedNotes[Q.questions[2].id], "c");
  assert.deepEqual(Q.scale, legacy.s);
  assert.deepEqual(Q.guide, legacy.g);
});

test("ids stay with their question through a reorder", () => {
  const Q = normalizeQuestions(fromLegacy(legacy));
  const moved = { ...Q, questions: [Q.questions[2], Q.questions[0], Q.questions[1]] };
  const notes = { 0: "about you", 1: "the case", 2: "why us" };
  assert.deepEqual(liveQuestions(moved).map((q) => notes[q.id]), ["why us", "about you", "the case"]);
});

test("new ids match the id pattern and never collide with legacy ones", () => {
  for (let i = 0; i < 200; i++) { const id = newQuestionId(); assert.match(id, QID_RE); assert.ok(!/^\d+$/.test(id)); }
});

test("normalize: no document means none; archived kept but not shown", () => {
  assert.equal(normalizeQuestions(null), null);
  assert.equal(normalizeQuestions({}), null);
  const Q = normalizeQuestions({ questions: [{ id: "0", text: "a" }, { id: "q1", text: "b", archived: true }, { id: "0", text: "dup" }] });
  assert.equal(Q.questions.length, 2);
  assert.deepEqual(liveQuestions(Q).map((q) => q.id), ["0"]);
});

test("scoring has started once any score has a number or a note", () => {
  assert.equal(scoringStarted({}), false);
  assert.equal(scoringStarted({ "a~c": { overall: 0, notes: { 0: "  " } } }), false);
  assert.equal(scoringStarted({ "a~c": { overall: 4.2 } }), true);
  assert.equal(scoringStarted({ "a~c": { notes: { q1: "ok" } } }), true);
  assert.deepEqual(idsWithNotes({ "a~c": { notes: { 0: "x", 5: "" } }, "b~c": { notes: { q9: "y", 0: "z" } } }), ["0", "q9"]);
});

test("lock rules: while locked only the wording may change", () => {
  const before = normalizeQuestions(fromLegacy(legacy));
  const reword = { ...before, questions: before.questions.map((q, i) => i === 1 ? { ...q, text: "A hard case" } : q) };
  assert.deepEqual(checkEdit(before, reword, true), []);
  const added = { ...before, questions: [...before.questions, { id: "q1", text: "New one" }] };
  assert.equal(checkEdit(before, added, false).length, 0);
  assert.ok(checkEdit(before, added, true).some((e) => e.includes("can't be added, removed or reordered")));
  const removed = { ...before, questions: before.questions.slice(1) };
  assert.ok(checkEdit(before, removed, true).length);
  const reordered = { ...before, questions: [before.questions[1], before.questions[0], before.questions[2]] };
  assert.ok(checkEdit(before, reordered, true).length);
});

test("edits: empty, duplicate, too long, too many are refused", () => {
  const b = normalizeQuestions(fromLegacy(legacy));
  assert.ok(checkEdit(b, { questions: [{ id: "0", text: "" }] }, false)[0].includes("empty"));
  assert.ok(checkEdit(b, { questions: [{ id: "0", text: "A" }, { id: "1", text: "a" }] }, false)[0].includes("same as an earlier"));
  assert.ok(checkEdit(b, { questions: [{ id: "0", text: "x".repeat(1001) }] }, false)[0].includes("longer than"));
  assert.ok(checkEdit(b, { questions: Array.from({ length: 31 }, (_, i) => ({ id: "q" + i, text: "Q" + i })) }, false)[0].includes("At most 30"));
  assert.ok(checkEdit(b, { questions: [{ id: "0", text: "x" }], scale: ["a", "b"] }, false)[0].includes("5 labels"));
  assert.deepEqual(toStoredQuestions({ questions: [{ id: "0", text: "  hi  there " }], scale: [" a "], guide: ["", " g "] }),
    { version: 1, questions: [{ id: "0", text: "hi there" }], scale: ["a"], guide: ["g"] });
});
