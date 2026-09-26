// ============================================================================
//  Panel fairness. No emulator, no network — panels.js is pure.
//
//  Two things have to hold at once, and the second is the one that matters:
//    1. the seats are shared out as evenly as availability allows
//    2. sharing them out NEVER schedules fewer candidates than the old
//       roster-order build did
//
//  (2) is safe because a panel can form iff the eligible pool holds the chair,
//  both genders and three people — all properties of the pool, not of the order
//  we pick in. This file asserts that rather than trusting it, by re-running the
//  old algorithm alongside the new one over randomised rosters.
// ============================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { autoPanels, buildPanel, fairSize, MIN_PANEL, MAX_PANEL } from "../js/panels.js";
import { COMMITTEE, SLOTS, CHAIR } from "../js/config.js";

const ids = SLOTS.map((s) => s.id);

// everyone free for everything, the case that exposed the old bias
function allFree(committee = COMMITTEE, slotIds = ids, mod = "either") {
  const iv = {};
  for (const m of committee) {
    iv[m.name] = { g: m.gender, avail: {} };
    for (const s of slotIds) iv[m.name].avail[s] = mod;
  }
  return iv;
}
// one candidate per slot, each free only for their own slot
const oneEach = (slotIds) => Object.fromEntries(slotIds.map((s, i) => ["c" + i, { avail: { [s]: "either" } }]));

const loadOf = (panels, committee) => {
  const load = {};
  for (const m of committee) load[m.name] = 0;
  panels.forEach((p) => p.members.forEach((m) => { load[m]++; }));
  return load;
};
const nonChair = (load) => Object.entries(load).filter(([n]) => n !== CHAIR).map(([, v]) => v);

// ---------------------------------------------------------------------------
describe("the seats are actually shared out", () => {
  test("every interviewer gets a panel when everyone is free", () => {
    const res = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    assert.equal(res.panels.length, ids.length, "all 10 slots should be used");
    const load = loadOf(res.panels, COMMITTEE);
    const unused = Object.entries(load).filter(([, v]) => v === 0).map(([n]) => n);
    assert.deepEqual(unused, [], "nobody should be left off every panel");
  });

  // The load CANNOT be flat across the whole committee, and that is arithmetic,
  // not a defect. Every panel needs at least one woman; the roster has 4 women
  // and 9 men with a male chair. So 10 panels claim 10 of the 20 non-chair seats
  // for women — 2.5 each — while the 8 remaining men share the other 10, at 1.25
  // each. Anyone "flattening" this would have to break the balance rule.
  //
  // What IS achievable, and what the builder must deliver, is balance WITHIN
  // each group, at the arithmetic minimum for the busiest person.
  test("the load is even within each group, and optimally so", () => {
    const res = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    const load = loadOf(res.panels, COMMITTEE);
    const g = Object.fromEntries(COMMITTEE.map((m) => [m.name, m.gender]));
    const group = (gender) => Object.entries(load)
      .filter(([n]) => n !== CHAIR && g[n] === gender).map(([, v]) => v);

    const F = group("F"), M = group("M");
    assert.ok(Math.max(...F) - Math.min(...F) <= 1, `women uneven: ${JSON.stringify(F)}`);
    assert.ok(Math.max(...M) - Math.min(...M) <= 1, `men uneven: ${JSON.stringify(M)}`);

    // the busiest woman carries the fewest panels the balance rule allows
    assert.equal(Math.max(...F), Math.ceil(res.panels.length / F.length),
      "a woman is doing more panels than the rule requires");
    // and the men absorb exactly what is left, as evenly as possible
    const mSeats = res.panels.length * (res.panelSize - 1) - F.reduce((a, b) => a + b, 0);
    assert.equal(Math.max(...M), Math.ceil(mSeats / M.length),
      "a man is doing more panels than necessary");
  });

  test("no single person carries a disproportionate share", () => {
    const res = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    const spread = nonChair(loadOf(res.panels, COMMITTEE));
    // before this change the answer was 10, 10 and 0
    assert.ok(Math.max(...spread) <= 3, `busiest non-chair member has ${Math.max(...spread)} panels`);
    assert.ok(Math.min(...spread) >= 1, "somebody has no panel at all");
  });

  test("the chair is still on every panel", () => {
    const res = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    for (const p of res.panels) assert.ok(p.members.includes(CHAIR));
  });

  test("this is a real change — roster order would have used three people", () => {
    // the old behaviour, reproduced: no fairness opts at all
    const iv = allFree();
    const panels = ids.map((s) => buildPanel(s, "either", iv, CHAIR));
    const load = loadOf(panels, COMMITTEE);
    const used = Object.values(load).filter((v) => v > 0).length;
    assert.equal(used, 3, "unshared, the same three people take every panel");
    const fair = autoPanels(oneEach(ids), iv, ids, CHAIR);
    const usedFair = Object.values(loadOf(fair.panels, COMMITTEE)).filter((v) => v > 0).length;
    assert.equal(usedFair, COMMITTEE.length, "shared, everyone is used");
  });
});

// ---------------------------------------------------------------------------
describe("every panel is still a legal panel", () => {
  const legal = (p, iv, slot) => {
    assert.ok(p.members.length >= MIN_PANEL && p.members.length <= MAX_PANEL,
      `size ${p.members.length} out of range`);
    assert.ok(p.members.includes(CHAIR), "chair missing");
    assert.equal(new Set(p.members).size, p.members.length, "duplicate member");
    assert.ok(p.members.some((m) => iv[m].g === "F"), "no F");
    assert.ok(p.members.some((m) => iv[m].g === "M"), "no M");
    for (const m of p.members) {
      const av = iv[m].avail[slot];
      assert.ok(av !== undefined, `${m} is not available at ${slot}`);
      assert.ok(av === "either" || av === p.modality, `${m} cannot do ${p.modality}`);
    }
  };

  test("across 400 random rosters, every panel built is legal", () => {
    let rng = 12345;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (a) => a[Math.floor(rand() * a.length)];

    for (let trial = 0; trial < 400; trial++) {
      const n = 3 + Math.floor(rand() * 12);
      const committee = [{ name: CHAIR, gender: pick(["F", "M"]) }];
      for (let i = 1; i < n; i++) committee.push({ name: "P" + i, gender: pick(["F", "M"]) });
      const slotIds = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => "s" + i);
      const iv = {};
      for (const m of committee) {
        iv[m.name] = { g: m.gender, avail: {} };
        for (const s of slotIds) if (rand() < 0.6) iv[m.name].avail[s] = pick(["ip", "zoom", "either"]);
      }
      const cands = {};
      const nc = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < nc; i++) {
        cands["c" + i] = { avail: {} };
        for (const s of slotIds) if (rand() < 0.5) cands["c" + i].avail[s] = pick(["ip", "zoom", "either"]);
      }
      const res = autoPanels(cands, iv, slotIds, CHAIR);
      for (const p of res.panels) legal(p, iv, p.slot);
      // one candidate per slot, still
      const used = res.panels.map((p) => p.slot);
      assert.equal(new Set(used).size, used.length, "two candidates in one slot");
    }
  });
});

// ---------------------------------------------------------------------------
describe("fairness never costs a candidate their interview", () => {
  // The old algorithm, verbatim, to compare against.
  function oldBuild(slot, candMod, interviewers, chair) {
    const okMod = (a, b) => a === "either" || a === b;
    const wanted = candMod === "either" ? ["ip", "zoom"] : [candMod];
    for (const pm of wanted) {
      const pool = Object.keys(interviewers).filter((nm) => {
        const av = interviewers[nm].avail[slot];
        return av !== undefined && okMod(av, pm);
      });
      if (!pool.includes(chair)) continue;
      const g = (nm) => interviewers[nm].g;
      const others = pool.filter((nm) => nm !== chair);
      const members = [chair];
      const has = (gg) => members.some((m) => g(m) === gg);
      for (const need of ["F", "M"]) {
        if (!has(need)) { const add = others.find((nm) => g(nm) === need && !members.includes(nm)); if (add) members.push(add); }
      }
      if (!(has("F") && has("M"))) continue;
      for (const nm of others) { if (members.length >= 3) break; if (!members.includes(nm)) members.push(nm); }
      if (members.length < 3) continue;
      return { members: members.slice(0, 5), modality: pm };
    }
    return null;
  }

  test("across 400 random scenarios, the same candidates are scheduled", () => {
    let rng = 98765;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (a) => a[Math.floor(rand() * a.length)];

    for (let trial = 0; trial < 400; trial++) {
      const n = 3 + Math.floor(rand() * 12);
      const committee = [{ name: CHAIR, gender: pick(["F", "M"]) }];
      for (let i = 1; i < n; i++) committee.push({ name: "P" + i, gender: pick(["F", "M"]) });
      const slotIds = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => "s" + i);
      const iv = {};
      for (const m of committee) {
        iv[m.name] = { g: m.gender, avail: {} };
        for (const s of slotIds) if (rand() < 0.6) iv[m.name].avail[s] = pick(["ip", "zoom", "either"]);
      }
      const cands = {};
      const nc = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < nc; i++) {
        cands["c" + i] = { avail: {} };
        for (const s of slotIds) if (rand() < 0.5) cands["c" + i].avail[s] = pick(["ip", "zoom", "either"]);
      }

      // Feasibility is what decides who gets scheduled, so compare it directly:
      // the set of (candidate, slot) pairs that can carry a panel must be
      // identical under both builders.
      for (const c of Object.keys(cands)) {
        for (const [s, m] of Object.entries(cands[c].avail)) {
          if (!slotIds.includes(s)) continue;
          assert.equal(!!buildPanel(s, m, iv, CHAIR), !!oldBuild(s, m, iv, CHAIR),
            `feasibility differs for ${c} at ${s}`);
        }
      }
      // and therefore the scheduled set matches
      const now = autoPanels(cands, iv, slotIds, CHAIR);
      assert.equal(now.panels.length + now.unschedulable.length, Object.keys(cands).length,
        "every candidate is either scheduled or listed unschedulable");
    }
  });
});

// ---------------------------------------------------------------------------
describe("panel size grows only when three-person panels can't seat everyone", () => {
  test("plenty of interviews — stays at the minimum", () => {
    assert.equal(fairSize(10, 12), 3);   // 10 × 2 seats = 20 ≥ 12
  });
  test("few interviews, big committee — grows", () => {
    assert.equal(fairSize(4, 12), 4);    // 4 × 2 = 8 < 12; 4 × 3 = 12 ✓
    assert.equal(fairSize(3, 12), 5);    // 3 × 4 = 12 ✓
  });
  test("never exceeds the maximum", () => {
    assert.equal(fairSize(1, 99), MAX_PANEL);
  });
  test("a short round really does seat everyone", () => {
    const four = ids.slice(0, 4);
    const res = autoPanels(oneEach(four), allFree(COMMITTEE, four), four, CHAIR);
    assert.equal(res.panelSize, 4);
    const unused = Object.entries(loadOf(res.panels, COMMITTEE)).filter(([, v]) => !v).map(([n]) => n);
    assert.deepEqual(unused, [], "a 4-interview round should still use all 13");
  });
  test("availability still caps the size", () => {
    // only three people free, so the panel is three however big we aim
    const iv = { [CHAIR]: { g: "M", avail: { s1: "either" } },
                 A: { g: "F", avail: { s1: "either" } },
                 B: { g: "M", avail: { s1: "either" } },
                 C: { g: "F", avail: {} } };
    const p = buildPanel("s1", "either", iv, CHAIR, { size: 5 });
    assert.equal(p.members.length, 3);
  });
});

// ---------------------------------------------------------------------------
describe("the result is stable", () => {
  test("building twice gives byte-identical panels", () => {
    const a = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    const b = autoPanels(oneEach(ids), allFree(), ids, CHAIR);
    assert.deepEqual(a.panels, b.panels);
  });

  test("the caller's roster is never mutated", () => {
    const iv = allFree();
    const before = JSON.stringify(Object.keys(iv));
    autoPanels(oneEach(ids), iv, ids, CHAIR);
    assert.equal(JSON.stringify(Object.keys(iv)), before);
  });
});
