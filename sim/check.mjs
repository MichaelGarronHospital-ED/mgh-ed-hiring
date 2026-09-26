// Independent invariant checker for the scheduling pipeline.
//
// Deliberately does NOT import panels.js: it re-states the rules from DESIGN.md
// /CLAUDE.md (chair on every panel, 3-5 members, one of each gender, everyone
// available and modality-compatible, one candidate per time) and checks the
// schedule the APP produced against them. Feasibility/maximality is checked
// with a separately written matching, plus brute force on small instances.

export const lastKey = (name) =>
  String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

export function effSlotIds(state) {
  const s = state.settings || {};
  const list = Array.isArray(s.times) ? s.times : (s.slots || []);
  return list.map((t, i) => (typeof t === "string" ? String(i) : String(t.id ?? i)));
}

export function roster(state, fallback) {
  const c = (state.settings && state.settings.committee) || [];
  return c.length ? c : fallback;
}

// candidate is on the interview list: not removed and fewer than 2 flags
export function activeCandidates(state, committee) {
  const flags = (id) => committee.filter((m) => ((state.screening || {})[`${m.name}~${id}`] || {}).flag).length;
  return (state.candidates || []).filter((c) => !c.removed && flags(c.id) < 2);
}

export const candAvail = (state, c) =>
  (state.availCand || {})[c.id] || (state.availCand || {})[lastKey(c.name)] || {};

const compat = (personMod, panelMod) => personMod === "either" || personMod === panelMod;

// Can a balanced panel run at this slot for a candidate with this modality?
export function feasible(slot, candMod, committee, availIv, chair) {
  const mods = candMod === "either" ? ["ip", "zoom"] : [candMod];
  return mods.some((pm) => {
    const pool = committee.filter((m) => {
      const av = (availIv[m.name] || {})[slot];
      return av !== undefined && compat(av, pm);
    });
    return pool.length >= 3
      && pool.some((m) => m.name === chair)
      && pool.some((m) => m.gender === "F")
      && pool.some((m) => m.gender === "M");
  });
}

// max bipartite matching, written independently of panels.js (Kuhn)
function maxMatching(feas) {
  const owner = {};
  let n = 0;
  const walk = (c, seen) => {
    for (const s of feas[c] || []) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (owner[s] === undefined || walk(owner[s], seen)) { owner[s] = c; return true; }
    }
    return false;
  };
  for (const c of Object.keys(feas)) if (walk(c, new Set())) n++;
  return n;
}

// brute force for small instances: the most candidates placeable at distinct slots
function bruteMatching(feas, cands) {
  let best = 0;
  const used = new Set();
  const rec = (i, n) => {
    if (n + (cands.length - i) <= best) return;
    if (i === cands.length) { best = Math.max(best, n); return; }
    for (const s of feas[cands[i]] || []) {
      if (used.has(s)) continue;
      used.add(s); rec(i + 1, n + 1); used.delete(s);
    }
    rec(i + 1, n);
  };
  rec(0, 0);
  return best;
}

// The most interviewers any legal set of panels for these bookings could use.
// Brute force over every membership of every panel, so it owes nothing to the
// builder's own idea of fairness. Returns null when the instance is too big to
// enumerate (then the round simply isn't judged on this).
function mostPeopleUsable(schedule, committee, availIv, chair) {
  const choices = [];
  for (const p of schedule) {
    const pool = committee.filter((m) => {
      const av = (availIv[m.name] || {})[p.slot];
      return av !== undefined && compat(av, p.modality) && m.name !== chair;
    });
    const k = p.members.length - 1;                 // seats besides the chair
    const sets = [];
    const rec = (i, acc) => {
      if (acc.length === k) {
        const names = [chair, ...acc.map((m) => m.name)];
        const gs = [...acc.map((m) => m.gender), (committee.find((m) => m.name === chair) || {}).gender];
        if (gs.includes("F") && gs.includes("M")) sets.push(names);
        return;
      }
      for (let j = i; j < pool.length; j++) rec(j + 1, [...acc, pool[j]]);
    };
    rec(0, []);
    if (!sets.length) return null;                  // the app built something we can't reproduce
    choices.push(sets);
  }
  if (choices.reduce((n, s) => n * s.length, 1) > 400000) return null;
  let best = 0;
  const walk = (i, used) => {
    if (i === choices.length) { best = Math.max(best, used.size); return; }
    if (used.size + choices.slice(i).reduce((n, s) => n + s[0].length, 0) <= best) return;
    for (const set of choices[i]) walk(i + 1, new Set([...used, ...set]));
  };
  walk(0, new Set());
  return best;
}

// `schedule` is what the UI showed: [{ cand (id), slot, modality, members:[names] }]
// `attention` is { unschedulable:[id], understaffed:[slotId], doubleBooked:[...] }
export function checkSchedule(state, { committee, chair, schedule, unschedulable = [], understaffed = [], manualIds = new Set(), slotIds = null }) {
  const problems = [];
  const bad = (m) => problems.push(m);
  slotIds = slotIds || effSlotIds(state);
  const availIv = state.availIv || {};
  const byName = new Map(committee.map((m) => [m.name, m]));
  const active = activeCandidates(state, committee);
  const activeIds = new Set(active.map((c) => c.id));
  const nameOf = (id) => ((state.candidates || []).find((c) => c.id === id) || {}).name || id;

  const seenCand = new Set(), bySlot = {};
  for (const p of schedule) {
    const who = nameOf(p.cand);
    const manual = manualIds.has(p.cand);
    if (!activeIds.has(p.cand)) bad(`${who}: scheduled but not on the interview list`);
    if (seenCand.has(p.cand)) bad(`${who}: scheduled twice`);
    seenCand.add(p.cand);
    (bySlot[p.slot] = bySlot[p.slot] || []).push(who);
    if (!slotIds.includes(String(p.slot))) bad(`${who}: scheduled at a time that no longer exists (${p.slot})`);

    const cm = candAvail(state, { id: p.cand, name: who })[p.slot];
    if (!manual) {
      if (cm === undefined) bad(`${who}: auto-scheduled at ${p.slot}, which they did not say they could do`);
      else if (!compat(cm, p.modality)) bad(`${who}: said ${cm} for ${p.slot} but the panel is ${p.modality}`);
    }

    const members = p.members;
    if (new Set(members).size !== members.length) bad(`${who}: duplicate panellist`);
    if (members.length < 3 || members.length > 5) bad(`${who}: panel of ${members.length}`);
    if (!members.includes(chair)) bad(`${who}: chair (${chair}) not on the panel`);
    const gs = members.map((m) => (byName.get(m) || {}).gender);
    if (gs.some((g) => !g)) bad(`${who}: panellist not on the committee (${members.filter((m) => !byName.has(m)).join(", ")})`);
    if (!gs.includes("F") || !gs.includes("M")) bad(`${who}: panel is not balanced (${members.join(", ")})`);
    if (!manual) {
      for (const m of members) {
        const av = (availIv[m] || {})[p.slot];
        if (av === undefined) bad(`${who}: ${m} is on the panel but never said they could do ${p.slot}`);
        else if (!compat(av, p.modality)) bad(`${who}: ${m} said ${av} but the panel is ${p.modality}`);
      }
    }
  }
  for (const [s, cs] of Object.entries(bySlot)) if (cs.length > 1) bad(`double-booked ${s}: ${cs.join(", ")}`);

  // every active candidate is either scheduled or listed as unschedulable
  for (const c of active) {
    if (!seenCand.has(c.id) && !unschedulable.includes(c.id)) bad(`${c.name}: neither scheduled nor flagged as unschedulable`);
  }
  for (const id of unschedulable) {
    if (seenCand.has(id)) bad(`${nameOf(id)}: both scheduled and listed as unschedulable`);
    if (!activeIds.has(id)) bad(`${nameOf(id)}: listed as unschedulable but not on the interview list`);
  }

  // maximality: could a different pairing have interviewed more people?
  const feas = {};
  for (const c of active) {
    feas[c.id] = Object.entries(candAvail(state, c))
      .filter(([s, m]) => slotIds.includes(s) && feasible(s, m, committee, availIv, chair))
      .map(([s]) => s);
  }
  const autoOnly = schedule.filter((p) => !manualIds.has(p.cand));
  if (!manualIds.size) {
    const best = maxMatching(feas);
    if (schedule.length < best) bad(`only ${schedule.length} scheduled, but ${best} could have been`);
    if (active.length <= 9) {
      const bf = bruteMatching(feas, active.map((c) => c.id));
      if (bf !== best) bad(`checker disagreement: kuhn ${best} vs brute force ${bf}`);
      if (schedule.length < bf) bad(`only ${schedule.length} scheduled, brute force finds ${bf}`);
    }
  }

  // WHY each unscheduled candidate is unscheduled — the three cases need three
  // different actions from the coordinator, so the tool showing one message for
  // all three is itself a defect.
  const diagnosis = {};
  for (const id of unschedulable) {
    const c = active.find((x) => x.id === id) || { id, name: nameOf(id) };
    const answered = Object.keys(candAvail(state, c)).filter((s) => slotIds.includes(s));
    diagnosis[id] = !answered.length ? "no-answer"
      : !(feas[id] || []).length ? "infeasible"
      : "contested";          // their times could host a panel — someone else has them
  }

  // understaffed = a time somebody is available for, where no balanced panel can form
  const expectUnder = slotIds.filter((s) =>
    committee.some((m) => (availIv[m.name] || {})[s] !== undefined)
    && !feasible(s, "either", committee, availIv, chair));
  const gotU = [...understaffed].sort(), wantU = expectUnder.sort();
  if (gotU.join("|") !== wantU.join("|")) bad(`understaffed list is [${gotU}] but should be [${wantU}]`);

  // who never gets to interview although they were free at a time being used
  const usedSlots = new Set(schedule.map((p) => String(p.slot)));
  const seated = new Set(schedule.flatMap((p) => p.members));
  // "free" means free in a modality the panel actually runs in — someone who
  // can only do a slot by Zoom cannot sit on the in-person panel booked there.
  const usedPanels = schedule.map((p) => ({ slot: String(p.slot), modality: p.modality }));
  const idleButFree = committee.filter((m) => m.name !== chair && !seated.has(m.name)
    && usedPanels.some(({ slot, modality }) => {
      const av = (availIv[m.name] || {})[slot];
      return av !== undefined && compat(av, modality);
    }));
  // With fewer non-chair seats than interviewers, somebody HAS to sit out; that
  // is arithmetic, not unfairness. Only count idleness against the builder when
  // there were enough seats to go round.
  const seats = schedule.reduce((n, p) => n + p.members.length - 1, 0);
  const others = committee.filter((m) => m.name !== chair).length;

  // Could the seats actually have been shared better? Enumerate every legal
  // membership for each panel it booked (same times, same sizes) and take the
  // arrangement that uses the most people. If the app matches that, an idle
  // interviewer is arithmetic — the balance rule or their own availability —
  // and not the builder giving seats away to people who already had one.
  let bestPeople = null;
  if (idleButFree.length) bestPeople = mostPeopleUsable(schedule, committee, availIv, chair);
  const usedPeople = seated.size;
  const shortfall = bestPeople != null && usedPeople < bestPeople;

  // ...and WHY each of them is idle, to compare with what the tab says
  const idleGroups = { silent: [], wrongTimes: [], squeezed: [] };
  committee.filter((m) => m.name !== chair && !seated.has(m.name)).forEach((m) => {
    const mine = availIv[m.name] || {};
    const answered = Object.keys(mine).filter((s) => slotIds.includes(s));
    const couldHaveSat = usedPanels.some(({ slot, modality }) => {
      const av = mine[slot];
      return av !== undefined && compat(av, modality);
    });
    idleGroups[!answered.length ? "silent" : !couldHaveSat ? "wrongTimes" : "squeezed"].push(m.name);
  });

  return { problems, diagnosis, seats, others, usedPeople, bestPeople, idleGroups,
           idleButFree: shortfall ? idleButFree.map((m) => m.name) : [],
           scheduled: schedule.length, feasibleCount: Object.values(feas).filter((f) => f.length).length,
           autoOnly: autoOnly.length };
}
