// H13: two rooms and day chairs. A normal round (no rooms, one chair) must
// schedule EXACTLY as before: checked against a frozen copy of the old file over
// 400 random rounds. Then two-room panels, no-chair days and the maximum.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPanels, buildPanel, MIN_PANEL, MAX_PANEL } from "../js/panels.js";
import { autoPanels as autoPanelsV1 } from "./fixtures/panels-v1.mjs";

// a small deterministic random generator (mulberry32), so a failure replays by seed
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MODS = ["ip", "zoom", "either"];
function round(seed, { nIv = 4 + Math.floor(rng(seed)() * 10), nSlots = 3 + (seed % 6), nCand = 2 + (seed % 9), pFree = 0.55 } = {}) {
  const r = rng(seed * 7919 + 1);
  const slots = Array.from({ length: nSlots }, (_, i) => `t${i}`);
  const interviewers = {};
  for (let i = 0; i < nIv; i++) {
    const avail = {};
    slots.forEach((s) => { if (r() < pFree) avail[s] = MODS[Math.floor(r() * 3)]; });
    interviewers[`m${i}`] = { g: i === 0 ? "M" : r() < 0.4 ? "F" : "M", avail };
  }
  const candidates = {};
  for (let i = 0; i < nCand; i++) {
    const avail = {};
    slots.forEach((s) => { if (r() < 0.45) avail[s] = MODS[Math.floor(r() * 3)]; });
    candidates[`c${i}`] = { avail };
  }
  return { slots, interviewers, candidates, chair: "m0" };
}

test("(1) no rooms and a string chair: identical to the old panels.js over 400 random rounds", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { slots, interviewers, candidates, chair } = round(seed);
    const now = autoPanels(candidates, interviewers, slots, chair);
    const was = autoPanelsV1(JSON.parse(JSON.stringify(candidates)), JSON.parse(JSON.stringify(interviewers)), slots, chair);
    assert.deepEqual(now, was, `seed ${seed}`);
  }
});

test("chair undefined throws; null means no chair", () => {
  const { slots, interviewers, candidates } = round(3);
  assert.throws(() => autoPanels(candidates, interviewers, slots), /chair is required/);
  assert.throws(() => buildPanel("t0", "ip", interviewers), /chair is required/);
  const iv = { a: { g: "F", avail: { t0: "ip" } }, b: { g: "M", avail: { t0: "ip" } }, c: { g: "M", avail: { t0: "ip" } } };
  assert.deepEqual(buildPanel("t0", "ip", iv, null).members.sort(), ["a", "b", "c"]);
  assert.equal(buildPanel("t0", "ip", iv, "z"), null);
});

// legal: 3 to 5 people, both genders, everyone free then in a compatible way,
// the panel's chair on it (unless none), and two rooms at one time disjoint
function legal(res, interviewers, candidates, chairFor) {
  const bySlot = {};
  for (const p of res.panels) {
    assert.ok(p.members.length >= MIN_PANEL && p.members.length <= MAX_PANEL, `size ${p.members.length}`);
    assert.ok(p.members.some((m) => interviewers[m].g === "F") && p.members.some((m) => interviewers[m].g === "M"), "unbalanced");
    for (const m of p.members) {
      const av = interviewers[m].avail[p.slot];
      assert.ok(av === "either" || av === p.modality, `${m} not free for ${p.modality} at ${p.slot}`);
    }
    const ca = candidates[p.cand].avail[p.slot];
    assert.ok(ca === "either" || ca === p.modality, "applicant not free then");
    const ch = chairFor(p.slot, p.room || 1);
    if (ch !== null) assert.ok(p.members.includes(ch), `chair ${ch} missing at ${p.slot} room ${p.room}`);
    assert.equal(p.chair === undefined ? ch : p.chair, ch);
    (bySlot[p.slot] = bySlot[p.slot] || []).push(p);
  }
  for (const [s, ps] of Object.entries(bySlot)) {
    const seen = new Set();
    ps.forEach((p) => p.members.forEach((m) => { assert.ok(!seen.has(m), `${m} in two rooms at ${s}`); seen.add(m); }));
  }
  return bySlot;
}

test("(2) two-room times give two disjoint, legal panels", () => {
  let twoAtOnce = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { slots, interviewers, candidates } = round(seed, { nIv: 10 + (seed % 5), pFree: 0.8, nCand: 6 + (seed % 6) });
    const rooms = Object.fromEntries(slots.filter((_, i) => i % 2 === 0).map((s) => [s, 2]));
    const chairFor = (s, room) => (room === 1 ? "m0" : null);
    const res = autoPanels(candidates, interviewers, slots, chairFor, { rooms });
    const bySlot = legal(res, interviewers, candidates, chairFor);
    Object.entries(bySlot).forEach(([s, ps]) => {
      assert.ok(ps.length <= (rooms[s] || 1), `${ps.length} applicants at ${s}`);
      if (ps.length === 2) twoAtOnce++;
    });
    res.unschedulable.forEach((c) => assert.ok(res.why[c].reason, "no reason"));
  }
  assert.ok(twoAtOnce > 20, `only ${twoAtOnce} two-room times actually used`);
});

test("(3) a no-chair day gives legal panels without the chair", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { slots, interviewers, candidates } = round(seed, { nIv: 8, pFree: 0.7 });
    const noChair = new Set(slots.filter((_, i) => i < 2));
    const chairFor = (s) => (noChair.has(s) ? null : "m0");
    const res = autoPanels(candidates, interviewers, slots, chairFor);
    legal(res, interviewers, candidates, chairFor);
  }
});

// brute force: the most applicants that could be seated, trying every way of
// giving each applicant one of their feasible seats (or none)
function bruteMax(candidates, interviewers, slots, chairFor, rooms) {
  const seats = [];
  slots.forEach((s) => { seats.push([s, 1]); if (rooms[s] === 2) seats.push([s, 2]); });
  const ids = Object.keys(candidates);
  const feas = ids.map((c) => seats.filter(([s, room]) => {
    const m = candidates[c].avail[s];
    return m !== undefined && buildPanel(s, m, interviewers, chairFor(s, room));
  }).map(([s, room]) => `${s}#${room}`));
  let best = 0;
  const go = (i, used, n) => {
    if (n + (ids.length - i) <= best) return;
    if (i === ids.length) { best = Math.max(best, n); return; }
    go(i + 1, used, n);
    for (const k of feas[i]) if (!used.has(k)) { used.add(k); go(i + 1, used, n + 1); used.delete(k); }
  };
  go(0, new Set(), 0);
  return best;
}

test("(4) with plenty of interviewers, the most applicants are seated (brute force over small rounds with two-room times)", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const { slots, interviewers, candidates } = round(seed, { nIv: 14, nSlots: 3, nCand: 2 + (seed % 5), pFree: 0.95 });
    const rooms = { t0: 2, t2: 2 };
    const chairFor = (s, room) => (room === 1 ? "m0" : null);
    const res = autoPanels(candidates, interviewers, slots, chairFor, { rooms });
    const max = bruteMax(candidates, interviewers, slots, chairFor, rooms);
    const twoRoomMisses = res.unschedulable.filter((c) => res.why[c].reason === "two-rooms").length;
    assert.equal(res.panels.length + twoRoomMisses, max, `seed ${seed}: scheduled ${res.panels.length} (+${twoRoomMisses} two-room) vs best ${max}`);
  }
});
