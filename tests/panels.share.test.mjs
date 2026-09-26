// ============================================================================
//  Nobody is left off every panel when a seat exists for them, and an applicant
//  with no interview is told WHY. No emulator, no network — panels.js is pure.
//
//  Both of these came out of a full-round simulation (see ../sim/) rather than
//  from reading the code: the greedy fill is fair at every step and could still
//  finish with one interviewer on nothing, and the Panels tab then blamed it on
//  availability they had in fact sent.
// ============================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { autoPanels, shareOut } from "../js/panels.js";

const g = (committee) => Object.fromEntries(committee.map((m) => [m.name, m.gender]));
const loadOf = (panels, committee) => {
  const load = Object.fromEntries(committee.map((m) => [m.name, 0]));
  panels.forEach((p) => p.members.forEach((m) => { load[m]++; }));
  return load;
};

// The round that found this. Vojdani chairs; eight applicants are scheduled and
// Yang is free for four of those eight times — but under the plain greedy every
// seat he could have taken went to someone tied with him on zero and earlier in
// the alphabet, so he finished on no panel at all.
const COMMITTEE = [
  { name: "Vojdani", gender: "M" }, { name: "Rosenstein", gender: "M" }, { name: "Yang", gender: "M" },
  { name: "Jha", gender: "M" }, { name: "Marrocco", gender: "F" }, { name: "Balachandran", gender: "M" },
  { name: "Mohindra", gender: "F" }, { name: "Klaiman", gender: "F" }, { name: "Porfiris", gender: "M" },
  { name: "Hayre", gender: "M" }, { name: "Reynolds", gender: "F" }, { name: "Bahar", gender: "M" },
  { name: "Losier", gender: "M" },
];
const IV_AVAIL = {
  Vojdani: { 0: "ip", 1: "ip", 2: "ip", 3: "either", 4: "ip", 5: "ip", 7: "zoom", 8: "zoom" },
  Rosenstein: { 0: "ip", 1: "ip", 4: "either", 5: "ip", 7: "zoom" },
  Yang: { 1: "either", 2: "either", 3: "either", 5: "zoom", 8: "zoom" },
  Jha: { 0: "zoom", 2: "ip", 4: "ip", 6: "ip" },
  Marrocco: { 0: "ip", 1: "either", 3: "ip", 5: "either", 7: "zoom" },
  Balachandran: { 2: "ip", 3: "ip", 4: "either", 8: "zoom" },
  Mohindra: { 1: "zoom", 2: "either", 4: "ip", 7: "zoom", 8: "either" },
  Klaiman: { 0: "either", 2: "ip", 5: "ip", 8: "zoom" },
  Porfiris: { 1: "ip", 3: "either", 4: "zoom", 6: "ip" },
  Hayre: { 0: "ip", 3: "zoom", 5: "either" },
  Reynolds: { 3: "either", 4: "ip", 5: "zoom", 7: "either" },
  Bahar: { 2: "zoom", 4: "either", 6: "zoom", 9: "ip" },
  Losier: { 1: "ip", 2: "either", 5: "ip", 8: "ip" },
};
const CAND_AVAIL = {
  ashcombe: { 0: "ip", 2: "ip", 5: "either" }, carter: { 1: "either", 4: "zoom" },
  nandakumar: { 2: "zoom", 3: "ip", 8: "either" }, weir: { 0: "either", 1: "ip" },
  okonjo: { 4: "ip", 5: "ip", 7: "zoom" }, ellery: { 3: "either" },
  lindqvist: { 2: "either", 5: "zoom", 8: "zoom" }, fahmy: { 9: "ip" },
  trelawney: { 0: "zoom", 1: "zoom", 4: "either" }, bodine: {},
};
const ids = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const round = () => {
  const iv = {};
  COMMITTEE.forEach((m) => { iv[m.name] = { g: m.gender, avail: IV_AVAIL[m.name] || {} }; });
  const cands = Object.fromEntries(Object.entries(CAND_AVAIL).map(([k, avail]) => [k, { avail }]));
  return { iv, cands, res: autoPanels(cands, iv, ids, "Vojdani") };
};

describe("everyone who can sit on a panel gets one", () => {
  test("the real round that exposed it seats all thirteen", () => {
    const { res } = round();
    const load = loadOf(res.panels, COMMITTEE);
    assert.deepEqual(Object.entries(load).filter(([, v]) => !v).map(([n]) => n), [],
      `left off every panel: ${JSON.stringify(load)}`);
    // and it is still an even share, not one person carrying the round
    const others = Object.entries(load).filter(([n]) => n !== "Vojdani").map(([, v]) => v);
    assert.ok(Math.max(...others) - Math.min(...others) <= 1, `uneven: ${JSON.stringify(load)}`);
  });

  test("the repair never breaks a panel", () => {
    const { iv, res } = round();
    const gm = g(COMMITTEE);
    for (const p of res.panels) {
      assert.ok(p.members.includes("Vojdani"), "chair missing");
      assert.equal(new Set(p.members).size, p.members.length, "duplicate member");
      assert.ok(p.members.length >= 3 && p.members.length <= 5, `size ${p.members.length}`);
      assert.ok(p.members.some((m) => gm[m] === "F") && p.members.some((m) => gm[m] === "M"), "not balanced");
      for (const m of p.members) {
        const av = iv[m].avail[p.slot];
        assert.ok(av !== undefined && (av === "either" || av === p.modality),
          `${m} cannot do ${p.modality} at ${p.slot}`);
      }
    }
  });

  test("it is deterministic — panels are rebuilt on every render", () => {
    assert.deepEqual(round().res.panels, round().res.panels);
  });

  test("a swap that would unbalance a panel is refused", () => {
    // One panel of chair + the only woman + one man. The idle man could sit
    // only by displacing the woman, which would leave no woman at all.
    const iv = {
      Chair: { g: "M", avail: { s0: "either" } },
      Wom: { g: "F", avail: { s0: "either" } },
      Man: { g: "M", avail: { s0: "either" } },
      Idle: { g: "M", avail: { s0: "either" } },
    };
    const panels = [{ cand: "c1", slot: "s0", modality: "ip", members: ["Chair", "Wom", "Man"] }];
    shareOut(panels, iv, "Chair");
    assert.deepEqual(panels[0].members, ["Chair", "Wom", "Man"], "balance was traded away for a seat");
  });

  test("the chair is never swapped out to make room", () => {
    const iv = {
      Chair: { g: "M", avail: { s0: "either" } },
      Wom: { g: "F", avail: { s0: "either" } },
      Man: { g: "M", avail: { s0: "either" } },
      Idle: { g: "F", avail: { s0: "either" } },
    };
    const panels = [{ cand: "c1", slot: "s0", modality: "ip", members: ["Chair", "Wom", "Man"] }];
    shareOut(panels, iv, "Chair");
    assert.ok(panels[0].members.includes("Chair"));
  });

  test("nobody is taken off a panel to seat someone else", () => {
    // Two panels, three helpers, one idle: a chain can seat the idle person
    // only by moving someone who already has two.
    const iv = {
      Chair: { g: "M", avail: { s0: "either", s1: "either" } },
      Ada: { g: "F", avail: { s0: "either", s1: "either" } },
      Bob: { g: "M", avail: { s0: "either", s1: "either" } },
      Cleo: { g: "F", avail: { s1: "either" } },
    };
    const panels = [
      { cand: "c1", slot: "s0", modality: "ip", members: ["Chair", "Ada", "Bob"] },
      { cand: "c2", slot: "s1", modality: "ip", members: ["Chair", "Ada", "Bob"] },
    ];
    shareOut(panels, iv, "Chair");
    const load = {};
    panels.forEach((p) => p.members.forEach((m) => { load[m] = (load[m] || 0) + 1; }));
    assert.equal(load.Cleo, 1, "the idle member still has no panel");
    assert.ok(load.Ada >= 1 && load.Bob >= 1, `someone was left with nothing: ${JSON.stringify(load)}`);
  });
});

describe("an applicant with no interview is told which problem it is", () => {
  test("the three reasons are told apart", () => {
    const { res } = round();
    const why = res.why;
    // Bodine picked nothing at all
    assert.equal(why.bodine.reason, "no-answer");
    // Fahmy is free only at a time where no balanced panel can form
    assert.equal(why.fahmy.reason, "no-panel");
  });

  test("a candidate whose only time is taken is 'contested', not 'no-panel'", () => {
    const iv = {
      Chair: { g: "M", avail: { s0: "either" } },
      Ada: { g: "F", avail: { s0: "either" } },
      Bob: { g: "M", avail: { s0: "either" } },
    };
    // both want the one workable time; only one can have it
    const cands = { c1: { avail: { s0: "ip" } }, c2: { avail: { s0: "ip" } } };
    const res = autoPanels(cands, iv, ["s0"], "Chair");
    assert.equal(res.panels.length, 1);
    assert.equal(res.unschedulable.length, 1);
    const left = res.unschedulable[0];
    assert.equal(res.why[left].reason, "contested");
    assert.deepEqual(res.why[left].slots, ["s0"], "the contested time should be named");
  });

  test("every unscheduled candidate gets a reason", () => {
    const { res } = round();
    for (const id of res.unschedulable) assert.ok(res.why[id], `no reason recorded for ${id}`);
  });
});
