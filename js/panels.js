// ============================================================================
//  Auto-paneling — ported from the Python prototype in /tmp/panels_proto.py
//  (validated against 5 scenarios). Interviews run sequentially: one candidate
//  per slot. A panel = chair + members; 3–5 total; at least one member who
//  identifies as female and one who identifies as male; everyone available for
//  the slot and modality-compatible with the candidate. This is presented to
//  users only as a "balanced panel" — never as an M/F rule.
// ============================================================================

const CHAIR = "Vojdani"; // Kyle — required on every panel (config could override)

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
export function buildPanel(slot, candMod, interviewers, chair = CHAIR) {
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
export function autoPanels(candidates, interviewers, slots, chair = CHAIR) {
  const feas = {}; // feasible slots per candidate (available AND a panel can form)
  for (const c of Object.keys(candidates)) {
    feas[c] = Object.entries(candidates[c].avail)
      .filter(([s, m]) => slots.includes(s) && buildPanel(s, m, interviewers, chair))
      .map(([s]) => s);
  }
  // most-constrained candidate first; one candidate per slot
  const order = Object.keys(candidates).sort((a, b) => feas[a].length - feas[b].length);
  const used = new Set();
  const assign = {};
  for (const c of order) {
    const s = feas[c].find((x) => !used.has(x));
    if (s) { used.add(s); assign[c] = s; }
  }
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

export { CHAIR };
