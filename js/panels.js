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
// caller ever forgot the argument.

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
  const { loads = {}, lastUsed = {}, size = MIN_PANEL } = opts;
  const target = Math.max(MIN_PANEL, Math.min(size, MAX_PANEL));
  const wanted = candMod === "either" ? ["ip", "zoom"] : [resolvePanelModality(candMod)];
  for (const pm of wanted) {
    const pool = eligible(interviewers, slot, pm);
    if (!pool.includes(chair)) continue;
    const g = (n) => interviewers[n].g;
    // The chair is on every panel by rule, so they are never in the running for
    // a shared seat. Fresh array from eligible() → filter → sort mutates only
    // our own copy, never the caller's roster.
    const others = pool.filter((n) => n !== chair).sort(byFairness(loads, lastUsed));
    const members = [chair];
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
const canSit = (iv, name, panel) => {
  const av = iv[name].avail[panel.slot];
  return av !== undefined && modalityOk(av, panel.modality) && !panel.members.includes(name);
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
  const load = {};
  Object.keys(interviewers).forEach((n) => { load[n] = 0; });
  panels.forEach((p) => p.members.forEach((m) => { load[m] = (load[m] || 0) + 1; }));
  // `seen` locks a panel for the whole chain, so the recursion can't undo a move
  // it is standing on — and guarantees it terminates.
  const seat = (name, seen) => {
    for (const p of panels) {
      if (seen.has(p) || !canSit(interviewers, name, p)) continue;
      seen.add(p);
      for (const m of p.members) {
        if (!swapKeepsPanelLegal(interviewers, p, m, name, chair)) continue;
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
    .filter((n) => n !== chair && !load[n])
    .sort()                                   // deterministic: panels rebuild on every render
    .forEach((n) => seat(n, new Set()));
  return panels;
}

// candidates: { name: { avail: { slot: modality } } }
// interviewers: as above. slots: ordered array of slot ids.
// opts.size: force a panel size instead of letting fairSize() choose.
export function autoPanels(candidates, interviewers, slots, chair, opts = {}) {
  const feas = {}; // feasible slots per candidate (available AND a panel can form)
  for (const c of Object.keys(candidates)) {
    feas[c] = Object.entries(candidates[c].avail)
      .filter(([s, m]) => slots.includes(s) && buildPanel(s, m, interviewers, chair))
      .map(([s]) => s);
  }
  // Maximum bipartite matching (Kuhn's augmenting paths): candidates ↔ slots,
  // one candidate per slot. This schedules the most candidates possible — unlike
  // a single greedy pass, it won't falsely mark a candidate unschedulable when a
  // different pairing would fit everyone. Most-constrained-first for efficiency.
  const order = Object.keys(candidates).sort((a, b) => feas[a].length - feas[b].length);
  const slotOwner = {}; // slot -> candidate currently matched
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
  const nOthers = Object.keys(interviewers).filter((n) => n !== chair).length;
  const scheduled = Object.keys(assign);
  const size = opts.size || fairSize(scheduled.length, nOthers);
  const poolAt = (s) => Object.values(interviewers).filter((iv) => iv.avail[s] !== undefined).length;
  const buildOrder = scheduled.slice().sort((a, b) =>
    poolAt(assign[a]) - poolAt(assign[b]) || slots.indexOf(assign[a]) - slots.indexOf(assign[b]));

  const loads = {}, lastUsed = {};
  const panels = [];
  const failed = [];
  let step = 0;
  for (const c of buildOrder) {
    const s = assign[c];
    const p = buildPanel(s, candidates[c].avail[s], interviewers, chair, { loads, lastUsed, size });
    // Cannot happen — the matcher only assigned slots where buildPanel already
    // succeeded, and feasibility does not depend on loads. Handled rather than
    // trusted, because the alternative is a candidate silently vanishing from
    // both the schedule AND the unschedulable list.
    if (!p) { failed.push(c); continue; }
    panels.push({ cand: c, slot: s, members: p.members, modality: p.modality });
    step++;
    p.members.forEach((m) => { loads[m] = (loads[m] || 0) + 1; lastUsed[m] = step; });
  }
  const unschedulable = Object.keys(candidates).filter((c) => !assign[c]).concat(failed);
  panels.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
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
  const why = {};
  for (const c of unschedulable) {
    const answered = Object.keys(candidates[c].avail).filter((s) => slots.includes(s));
    why[c] = { reason: !answered.length ? "no-answer" : !feas[c].length ? "no-panel" : "contested",
               slots: feas[c] };
  }
  // understaffed = a slot that HAS interviewers but still can't form a balanced
  // panel (actionable). Empty slots are just unused, not flagged.
  const understaffed = slots.filter((s) => {
    const anyone = Object.values(interviewers).some((iv) => iv.avail[s] !== undefined);
    return anyone && !buildPanel(s, "either", interviewers, chair);
  });
  return { panels, unschedulable, understaffed, panelSize: size, why };
}
