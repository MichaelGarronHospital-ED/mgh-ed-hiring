// ============================================================================
//  Auto-paneling — ported from the Python prototype in /tmp/panels_proto.py
//  (validated against 5 scenarios). Interviews run sequentially: one candidate
//  per slot. A panel = chair + members; 3–5 total; at least one member who
//  identifies as female and one who identifies as male; everyone available for
//  the slot and modality-compatible with the candidate. This is presented to
//  users only as a "balanced panel" — never as an M/F rule.
// ============================================================================

// `chair` is always passed in by the caller (app.js EFF().chair, which reads the
// admin's Setup value and falls back to config.CHAIR). Deliberately NO default
// here: a stale default would silently build panels around the wrong person if a
// caller ever forgot the argument, so `undefined` throws.
//
// H13 (Oct 2026): `chair` may also be null (no chair that day: no chair
// requirement) or, in autoPanels, a function (slotId, room) → id | null, for a
// day chair or a room-2 lead. opts.rooms = { <slotId>: 2 } makes a time two
// seats with two separate panels. With a string chair and no rooms the result is
// exactly what it always was (tests/panels.rooms.test.mjs pins it against a
// frozen copy of the old file).
const chairAt = (chair, slot, room) => (typeof chair === "function" ? chair(slot, room) : chair);

const modalityOk = (personMod, panelMod) => personMod === "either" || personMod === panelMod;
const resolvePanelModality = (candMod) => (candMod === "either" ? "ip" : candMod);

export const MIN_PANEL = 3, MAX_PANEL = 5;

// ---- fairness --------------------------------------------------------------
// WHO fills the non-chair seats is a fairness question, never a correctness
// one. A panel can form if and only if the eligible pool contains the chair, at
// least one person of each gender, and three people in total — all three
// conditions are properties of the POOL, independent of the order we consider
// people in. So choosing members by workload cannot turn a panel that could run
// into one that can't, and cannot change which candidates get scheduled. That
// is what makes this safe to do greedily.
//
// It used to fill in roster order: stable, and maximally unfair. With a fully
// available 13-person committee every panel came out as chair + the first
// woman + the first man on the list, so ten of the thirteen never interviewed
// anyone and the same three people sat all day.
//
// Order of preference:
//   1. fewest panels so far        — the actual balancing
//   2. least recently used         — so people on equal load rotate, instead of
//                                    the tie always going to the same name
//   3. alphabetical                — panels are rebuilt on every render, so the
//                                    result must be deterministic or the UI
//                                    jitters and the exported schedule stops
//                                    matching what is on screen
const byFairness = (loads, lastUsed) => (a, b) =>
  (loads[a] || 0) - (loads[b] || 0)
  || (lastUsed[a] ?? -1) - (lastUsed[b] ?? -1)
  || (a < b ? -1 : a > b ? 1 : 0);

// How many seats to fill. Three is the minimum a balanced panel allows and the
// lightest load on everyone, so it is the default. But with few interviews and
// a large committee, three-person panels simply don't have enough seats for
// everyone — 4 interviews × 2 non-chair seats can't seat 12 people. In that
// case grow the panel, up to the maximum of five, until there are enough seats
// for every interviewer to sit at least once. Availability still caps it: a
// slot with only three people available yields a panel of three whatever this
// returns.
export function fairSize(nPanels, nOthers) {
  for (let s = MIN_PANEL; s < MAX_PANEL; s++) if (nPanels * (s - 1) >= nOthers) return s;
  return MAX_PANEL;
}

function eligible(interviewers, slot, panelMod) {
  return Object.keys(interviewers).filter((n) => {
    const av = interviewers[n].avail[slot];
    return av !== undefined && modalityOk(av, panelMod);
  });
}

// Build a valid panel for (candidate, slot) or return null. `interviewers` is
// { name: { g:"F"|"M", avail:{ slot: "ip"|"zoom"|"either" } } }.
//
// `opts` is fairness only — omit it and you get a valid panel, just not a
// well-shared one. Callers that ask a yes/no question ("can a panel run here?",
// the availability grid, the understaffed check) pass nothing, because the
// answer does not depend on it.
//   loads    { name: panels so far }
//   lastUsed { name: step number of their last panel }
//   size     seats to aim for, clamped to 3–5
export function buildPanel(slot, candMod, interviewers, chair, opts = {}) {
  if (chair === undefined) throw new Error("buildPanel: chair is required (null means no chair)");
  const { loads = {}, lastUsed = {}, size = MIN_PANEL, exclude = null } = opts;
  const target = Math.max(MIN_PANEL, Math.min(size, MAX_PANEL));
  const wanted = candMod === "either" ? ["ip", "zoom"] : [resolvePanelModality(candMod)];
  for (const pm of wanted) {
    let pool = eligible(interviewers, slot, pm);
    // H13: people already seated in the other room at this time
    if (exclude) pool = pool.filter((n) => !exclude.has(n));
    if (chair !== null && !pool.includes(chair)) continue;
    const g = (n) => interviewers[n].g;
    // The chair is on every panel by rule, so they are never in the running for
    // a shared seat. Fresh array from eligible() → filter → sort mutates only
    // our own copy, never the caller's roster.
    const others = pool.filter((n) => n !== chair).sort(byFairness(loads, lastUsed));
    const members = chair !== null ? [chair] : [];
    const has = (gender) => members.some((m) => g(m) === gender);
    // Satisfy the balance requirement first, taking the least-used person of
    // whichever gender is missing — the constrained seat gets the fair pick,
    // rather than whoever is left after the free seats are handed out.
    for (const need of ["F", "M"]) {
      if (!has(need)) {
        const add = others.find((n) => g(n) === need && !members.includes(n));
        if (add) members.push(add);
      }
    }
    if (!(has("F") && has("M"))) continue; // diversity impossible this modality
    for (const n of others) {
      if (members.length >= target) break;
      if (!members.includes(n)) members.push(n);
    }
    if (members.length < MIN_PANEL) continue;
    return { members: members.slice(0, MAX_PANEL), modality: pm };
  }
  return null;
}

// ---- nobody left out -------------------------------------------------------
// The greedy fill hands each seat to whoever has fewest panels SO FAR, which is
// fair at every step and can still finish with somebody on nothing at all. When
// several people are tied on zero the seat goes to the first alphabetically, and
// by the time the loser is eligible again the seats they could have taken have
// gone to others who are now the only ones who fit. A real 13-person round left
// Yang off all eight panels while free for four of them, and the Panels tab then
// told the coordinator he probably hadn't sent his availability.
//
// The fix is the standard augmenting-path move: seat the unused person, hand the
// seat's current occupant another one, and so on down the chain — accepting the
// chain only if every panel it touches is still a legal panel afterwards. Each
// successful chain adds exactly one person to the schedule and takes nobody off
// it, so the pass can only improve the share, and it is a no-op when the greedy
// already used everyone (the common case, and what the fairness tests pin).
const canSit = (iv, name, panel, panels) => {
  const av = iv[name].avail[panel.slot];
  return av !== undefined && modalityOk(av, panel.modality) && !panel.members.includes(name)
    // H13: never in both rooms at once
    && !panels.some((q) => q !== panel && q.slot === panel.slot && q.members.includes(name));
};
// Would replacing `out` with `inp` leave this a panel we'd have built? Size is
// unchanged and the chair is never the one replaced, so balance is all that's
// left to check.
const swapKeepsPanelLegal = (iv, panel, out, inp, chair) => {
  if (out === chair) return false;
  const next = panel.members.map((m) => (m === out ? inp : m));
  return next.some((m) => iv[m].g === "F") && next.some((m) => iv[m].g === "M");
};
export function shareOut(panels, interviewers, chair) {
  // each panel's own chair (a day chair, a room-2 lead, or none) when it has one
  const chairOfPanel = (p) => (p.chair !== undefined ? p.chair : chair);
  const load = {};
  Object.keys(interviewers).forEach((n) => { load[n] = 0; });
  panels.forEach((p) => p.members.forEach((m) => { load[m] = (load[m] || 0) + 1; }));
  // `seen` locks a panel for the whole chain, so the recursion can't undo a move
  // it is standing on — and guarantees it terminates.
  const seat = (name, seen) => {
    for (const p of panels) {
      if (seen.has(p) || !canSit(interviewers, name, p, panels)) continue;
      seen.add(p);
      for (const m of p.members) {
        if (!swapKeepsPanelLegal(interviewers, p, m, name, chairOfPanel(p))) continue;
        // the person giving up the seat must keep one: either they already have
        // another panel, or this same search finds them one
        if (load[m] > 1 || seat(m, seen)) {
          p.members[p.members.indexOf(m)] = name;
          load[m]--; load[name]++;
          return true;
        }
      }
    }
    return false;
  };
  Object.keys(interviewers)
    .filter((n) => n !== (typeof chair === "string" ? chair : undefined) && !load[n])
    .sort()                                   // deterministic: panels rebuild on every render
    .forEach((n) => seat(n, new Set()));
  return panels;
}

// candidates: { name: { avail: { slot: modality } } }
// interviewers: as above. slots: ordered array of slot ids.
// chair: a string, null (no chair), or (slotId, room) => id | null.
// opts.size: force a panel size instead of letting fairSize() choose.
// opts.rooms: { <slotId>: 2 } for times that run two interviews at once.
export function autoPanels(candidates, interviewers, slots, chair, opts = {}) {
  if (chair === undefined) throw new Error("autoPanels: chair is required");
  const rooms = opts.rooms || {};
  const roomsMode = typeof chair === "function" || Object.values(rooms).some((n) => n === 2);
  const chairFor = (s, r) => chairAt(chair, s, r);
  // A two-room time is two seats: "<slotId>" (room 1) and "<slotId>#2" (room 2).
  // Slot ids never contain "#" (slots.js ID_RE), so the seat key is unambiguous.
  const seatSlot = (k) => (k.endsWith("#2") ? k.slice(0, -2) : k);
  const seatRoom = (k) => (k.endsWith("#2") ? 2 : 1);
  const feas = {}; // feasible seats per candidate (available AND a panel can form)
  for (const c of Object.keys(candidates)) {
    const list = [];
    Object.entries(candidates[c].avail).forEach(([s, m]) => {
      if (!slots.includes(s)) return;
      if (buildPanel(s, m, interviewers, chairFor(s, 1))) list.push(s);
      if (rooms[s] === 2 && buildPanel(s, m, interviewers, chairFor(s, 2))) list.push(s + "#2");
    });
    feas[c] = list;
  }
  // Maximum bipartite matching (Kuhn's augmenting paths): candidates ↔ seats,
  // one candidate per seat. This schedules the most candidates possible — unlike
  // a single greedy pass, it won't falsely mark a candidate unschedulable when a
  // different pairing would fit everyone. Most-constrained-first for efficiency.
  const order = Object.keys(candidates).sort((a, b) => feas[a].length - feas[b].length);
  const slotOwner = {}; // seat -> candidate currently matched
  const assign = {};
  const tryAssign = (c, seen) => {
    for (const s of feas[c]) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (!(s in slotOwner) || tryAssign(slotOwner[s], seen)) {
        slotOwner[s] = c; assign[c] = s; return true;
      }
    }
    return false;
  };
  for (const c of order) tryAssign(c, new Set());

  // ---- now fill the panels, sharing the seats out -------------------------
  // The matching above already decided WHO is interviewed WHEN, and maximally
  // so; this only decides who sits on each panel.
  //
  // Scarcest slot first: a slot where only four people are free has almost no
  // choice about its panel, so it picks before the well-staffed slots take the
  // people it needed. Ties break on slot order, so the result is deterministic.
  const nOthers = typeof chair === "function" ? Math.max(0, Object.keys(interviewers).length - 1)
    : Object.keys(interviewers).filter((n) => n !== chair).length;
  const scheduled = Object.keys(assign);
  const size = opts.size || fairSize(scheduled.length, nOthers);
  const poolAt = (s) => Object.values(interviewers).filter((iv) => iv.avail[s] !== undefined).length;
  const slotOf = (c) => seatSlot(assign[c]);
  const buildOrder = scheduled.slice().sort((a, b) =>
    poolAt(slotOf(a)) - poolAt(slotOf(b)) || slots.indexOf(slotOf(a)) - slots.indexOf(slotOf(b))
    || seatRoom(assign[a]) - seatRoom(assign[b]));

  const loads = {}, lastUsed = {};
  const panels = [];
  const failed = [], twoRooms = [];
  const done = new Set();
  let step = 0;
  const seatOne = (c, s, room, exclude) =>
    buildPanel(s, candidates[c].avail[s], interviewers, chairFor(s, room), { loads, lastUsed, size, exclude });
  const keep = (c, s, room, p) => {
    panels.push(roomsMode ? { cand: c, slot: s, room, chair: chairFor(s, room), members: p.members, modality: p.modality }
      : { cand: c, slot: s, members: p.members, modality: p.modality });
    step++;
    p.members.forEach((m) => { loads[m] = (loads[m] || 0) + 1; lastUsed[m] = step; });
  };
  for (const c of buildOrder) {
    if (done.has(c)) continue;
    const s = slotOf(c);
    const partner = rooms[s] === 2 ? scheduled.find((x) => x !== c && !done.has(x) && slotOf(x) === s) : null;
    if (!partner) {
      done.add(c);
      const room = seatRoom(assign[c]);
      const p = seatOne(c, s, room, null);
      // Cannot happen — the matcher only assigned slots where buildPanel already
      // succeeded, and feasibility does not depend on loads. Handled rather than
      // trusted, because the alternative is a candidate silently vanishing from
      // both the schedule AND the unschedulable list.
      if (!p) { failed.push(c); continue; }
      keep(c, s, room, p);
      continue;
    }
    // H13: both rooms of one time are built together, room 1 first and room 2
    // from the people left; if that fails, room 2 first. If neither order gives
    // two legal panels, the room-2 applicant waits (reason "two-rooms").
    done.add(c); done.add(partner);
    const r1 = seatRoom(assign[c]) === 1 ? c : partner, r2 = r1 === c ? partner : c;
    let p1 = seatOne(r1, s, 1, null), p2 = p1 ? seatOne(r2, s, 2, new Set(p1.members)) : null;
    if (!p1 || !p2) {
      const q2 = seatOne(r2, s, 2, null), q1 = q2 ? seatOne(r1, s, 1, new Set(q2.members)) : null;
      if (q1 && q2) { p1 = q1; p2 = q2; }
    }
    if (p1 && p2) { keep(r1, s, 1, p1); keep(r2, s, 2, p2); }
    else if (p1) { keep(r1, s, 1, p1); twoRooms.push(r2); }
    else { failed.push(r1); twoRooms.push(r2); }
  }
  const unschedulable = Object.keys(candidates).filter((c) => !assign[c]).concat(failed, twoRooms);
  panels.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot) || (a.room || 1) - (b.room || 1));
  // sorted first, so the repair works down the panels in the order they are
  // displayed and the result doesn't depend on the order they were built in
  shareOut(panels, interviewers, chair);

  // WHY each unscheduled candidate is unscheduled. Three very different
  // situations reach this list and they need three different actions from the
  // coordinator — chase the applicant, fix the committee's availability, or add
  // another interview time — so the caller gets the distinction rather than one
  // message that is only right in one of the three cases.
  //   "no-answer"  they have not picked any time that still exists
  //   "no-panel"   the times they picked can't carry a balanced panel
  //   "contested"  their times could, but every one of them went to someone else
  //   "two-rooms"  (H13) their time runs two rooms and there aren't enough
  //                interviewers for two balanced panels at once
  const why = {};
  for (const c of unschedulable) {
    const answered = Object.keys(candidates[c].avail).filter((s) => slots.includes(s));
    const fs = roomsMode ? [...new Set(feas[c].map(seatSlot))] : feas[c];
    why[c] = { reason: twoRooms.includes(c) ? "two-rooms" : !answered.length ? "no-answer" : !feas[c].length ? "no-panel" : "contested",
               slots: twoRooms.includes(c) ? [slotOf(c)] : fs };
  }
  // understaffed = a slot that HAS interviewers but still can't form a balanced
  // panel (actionable). Empty slots are just unused, not flagged.
  const understaffed = slots.filter((s) => {
    const anyone = Object.values(interviewers).some((iv) => iv.avail[s] !== undefined);
    return anyone && !buildPanel(s, "either", interviewers, chairFor(s, 1));
  });
  return { panels, unschedulable, understaffed, panelSize: size, why };
}
