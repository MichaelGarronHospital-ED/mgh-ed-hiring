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

function eligible(interviewers, slot, panelMod) {
  return Object.keys(interviewers).filter((n) => {
    const av = interviewers[n].avail[slot];
    return av !== undefined && modalityOk(av, panelMod);
  });
}

// Build a valid panel for (candidate, slot) or return null. `interviewers` is
// { name: { g:"F"|"M", avail:{ slot: "ip"|"zoom"|"either" } } }.
export function buildPanel(slot, candMod, interviewers, chair) {
  const wanted = candMod === "either" ? ["ip", "zoom"] : [resolvePanelModality(candMod)];
  for (const pm of wanted) {
    const pool = eligible(interviewers, slot, pm);
    if (!pool.includes(chair)) continue;
    const g = (n) => interviewers[n].g;
    const others = pool.filter((n) => n !== chair);
    const members = [chair];
    const has = (gender) => members.some((m) => g(m) === gender);
    for (const need of ["F", "M"]) {
      if (!has(need)) {
        const add = others.find((n) => g(n) === need && !members.includes(n));
        if (add) members.push(add);
      }
    }
    if (!(has("F") && has("M"))) continue; // diversity impossible this modality
    for (const n of others) {
      if (members.length >= 3) break;
      if (!members.includes(n)) members.push(n);
    }
    if (members.length < 3) continue;
    return { members: members.slice(0, 5), modality: pm };
  }
  return null;
}

// candidates: { name: { avail: { slot: modality } } }
// interviewers: as above. slots: ordered array of slot ids.
export function autoPanels(candidates, interviewers, slots, chair) {
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
  const panels = [];
  const unschedulable = [];
  for (const c of Object.keys(candidates)) {
    if (assign[c]) {
      const s = assign[c];
      const p = buildPanel(s, candidates[c].avail[s], interviewers, chair);
      panels.push({ cand: c, slot: s, members: p.members, modality: p.modality });
    } else {
      unschedulable.push(c);
    }
  }
  panels.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
  // understaffed = a slot that HAS interviewers but still can't form a balanced
  // panel (actionable). Empty slots are just unused, not flagged.
  const understaffed = slots.filter((s) => {
    const anyone = Object.values(interviewers).some((iv) => iv.avail[s] !== undefined);
    return anyone && !buildPanel(s, "either", interviewers, chair);
  });
  return { panels, unschedulable, understaffed };
}
