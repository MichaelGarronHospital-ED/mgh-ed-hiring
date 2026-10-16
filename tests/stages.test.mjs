// Stages and the interview list (H4, H7). Pure; no emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageOpen, roundOpen, bookingFor, thresholdOf, isOnList, closePlan, reopenPlan, lockEntry, STAGES } from "../js/stages.js";

test("absent means open, like the rules", () => {
  for (const st of [undefined, null, {}, { interviewsComplete: true }, { stages: {} }, { stages: { screening: {} } }])
    for (const n of STAGES) assert.equal(stageOpen(st, n), true, JSON.stringify(st));
  assert.equal(stageOpen({ stages: { screening: { closed: true } } }, "screening"), false);
  assert.equal(stageOpen({ stages: { screening: { closed: true } } }, "scoring"), true);
  assert.equal(stageOpen({ roundStatus: "closing" }, "scoring"), false);
  assert.equal(roundOpen({ roundStatus: "open" }), true);
});

test("the booking flag follows the stages and the round", () => {
  assert.equal(bookingFor({}), "open");
  assert.equal(bookingFor({ stages: { availability: { closed: true } } }), "closed");
  assert.equal(bookingFor({ roundStatus: "closing", stages: { availability: { closed: true } } }), "paused");
});

test("threshold: default 2, 0 allowed, junk ignored", () => {
  assert.equal(thresholdOf({}), 2);
  assert.equal(thresholdOf({ flagThreshold: 0 }), 0);
  assert.equal(thresholdOf({ flagThreshold: 3 }), 3);
  assert.equal(thresholdOf({ flagThreshold: -1 }), 2);
  assert.equal(thresholdOf({ flagThreshold: "4" }), 2);
});

test("isOnList truth table", () => {
  const rows = [
    // candidate, concerns, threshold, expected
    [{ removed: true, shortlist: "in" }, 0, 2, false],
    [{}, 0, 2, true], [{}, 1, 2, true], [{}, 2, 2, false], [{}, 5, 2, false],
    [{}, 5, 0, true],                                  // 0 = never automatically
    [{}, 2, 3, true], [{}, 3, 3, false],
    [{ shortlist: "in", shortlistBy: "leadership" }, 9, 2, true],   // On overrides concerns
    [{ shortlist: "out", shortlistBy: "leadership" }, 0, 2, false], // Off overrides the rule
    [{ shortlist: "in", shortlistBy: "auto" }, 9, 2, true],         // frozen at close
    [{ shortlist: "out", shortlistBy: "auto" }, 0, 2, false],
  ];
  for (const [c, n, t, want] of rows) assert.equal(isOnList(c, n, t), want, `${JSON.stringify(c)} ${n} ${t}`);
});

test("closing screening freezes every applicant without a leadership decision; reopening clears only those", () => {
  const cands = [
    { id: "a" }, { id: "b" }, { id: "c", shortlist: "in", shortlistBy: "leadership" },
    { id: "d", shortlist: "out", shortlistBy: "leadership" }, { id: "e", removed: true },
  ];
  const concerns = { a: 0, b: 3, c: 5, d: 0 };
  const plan = closePlan(cands, (id) => concerns[id] || 0, 2);
  assert.deepEqual(plan.patches, { a: { shortlist: "in", shortlistBy: "auto" }, b: { shortlist: "out", shortlistBy: "auto" } });
  assert.equal(plan.on, 2); assert.equal(plan.off, 2);
  const after = cands.map((c) => ({ ...c, ...(plan.patches[c.id] || {}) }));
  assert.deepEqual(reopenPlan(after).sort(), ["a", "b"]);
});

test("a locked panel keeps what it was built with", () => {
  assert.deepEqual(lockEntry({ slot: 3, members: ["A", "B", "C"], modality: "ip" }, "A"),
    { slot: "3", room: 1, chair: "A", members: ["A", "B", "C"], modality: "ip" });
});
