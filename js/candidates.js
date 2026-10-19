// ============================================================================
//  Applicants: shared surnames (H14), rename, merge and permanent delete (H5).
//  Pure plans: no DOM, no store. Each plan says exactly what would be written
//  and deleted, so the preview a person reads IS what will happen.
//
//  A plan = { writes: [{ coll, id, data }], deletes: [{ coll, id }],
//             candidates: { id: patch }, overrides: { id: entry | null },
//             schedulePanels: { id: entry | null }, skipped: [...], counts, summary }
//  store.applyPlan writes copies before deleting their sources.
// ============================================================================

import { lastKey, firstKey, givenKey, candKey, dupKey } from "./util.js?v=R13";

const picks = (doc) => Object.keys((doc && doc.slots) || doc || {}).filter((k) => !["reply", "replyAt"].includes(k)).length;
const realScreening = (r) => !!r && !!(r.flag || r.rating || String(r.reason || "").trim() || String(r.note || "").trim());
const realScore = (s) => !!s && !!(s.overall || Object.values(s.notes || {}).some((v) => String(v || "").trim()));
const surname = (n) => String(n || "").trim().split(/\s+/).pop();
// "a, b and c"
const andList = (xs) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const display = (n) => String(n || "").replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|mx\.?|prof\.?)\s+/i, "");

// ---- H14: keys for applicants who share a surname ---------------------------
// For every group of ACTIVE applicants sharing a surname key, each gets their own
// availKey: surname-firstname, or surname-allgivennames where two first names
// match too. Applicants who already have one keep it (never re-keyed, so their
// answers stay found). Returns { patches, groups, clash }.
//   clash: names in a group that even all their given names can't tell apart.
export function assignKeys(cands) {
  const active = (cands || []).filter((c) => !c.removed);
  const groups = {};
  active.forEach((c) => { const k = lastKey(c.name); if (k) (groups[k] = groups[k] || []).push(c); });
  const patches = {}, out = [], clash = [];
  Object.entries(groups).filter(([, g]) => g.length > 1).forEach(([k, g]) => {
    out.push({ key: k, ids: g.map((c) => c.id), names: g.map((c) => c.name) });
    const first = (c) => `${k}-${firstKey(c.name)}`, all = (c) => `${k}-${givenKey(c.name)}`;
    const taken = new Set(g.filter((c) => c.availKey).map((c) => c.availKey));
    g.filter((c) => !c.availKey).forEach((c) => {
      const f1 = first(c), f2 = all(c);
      const sameFirst = g.filter((x) => x !== c && firstKey(x.name) === firstKey(c.name)).length > 0;
      let key = !firstKey(c.name) ? null : !sameFirst ? f1 : f2;
      if (key && (taken.has(key) || g.some((x) => x !== c && givenKey(x.name) === givenKey(c.name)))) key = null;
      if (!key) { clash.push(c.name); return; }
      taken.add(key); patches[c.id] = { availKey: key };
    });
  });
  return { patches, groups: out, clash };
}

// The H14 add or rename message, or null when nobody shares the surname.
// What an applicant must type as their first name when another applicant has
// the same surname AND the same first name ("Jane B" for Jane B Kim beside Jane
// Kim): typing only "Jane" would find Jane Kim. null when the first name alone
// is enough (review).
export function typeExactly(cands, c) {
  if (!c) return null;
  const same = (cands || []).filter((x) => !x.removed && x.id !== c.id && lastKey(x.name) === lastKey(c.name) && firstKey(x.name) === firstKey(c.name));
  if (!same.length || givenKey(c.name) === firstKey(c.name)) return null;
  const parts = display(c.name).trim().split(/\s+/);
  return parts.slice(0, -1).join(" ");
}
export function sharedSurnameText(cands, key) {
  const g = (cands || []).filter((c) => !c.removed && lastKey(c.name) === key);
  if (g.length < 2) return null;
  const names = g.map((c) => display(c.name));
  const exact = g.map((c) => [c, typeExactly(g, c)]).filter(([, t]) => t)
    .map(([c, t]) => ` ${display(c.name)} must type the first name exactly as "${t}" (with the middle name or initial), or the page will take them for someone else. Tell them when you send the link.`);
  return `${g.length === 2 ? "Two" : g.length} applicants have the last name ${surname(g[0].name)}: ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}. `
    + "When booking, they will be asked for their first name too, so their answers stay separate." + exact.join("");
}

// Surname-only documents that might belong to any of several applicants
// (review m7): Admin is asked whose they are; the page never guesses.
export function sharedDocs(state, kept = []) {
  const out = [];
  const active = (state.candidates || []).filter((c) => !c.removed);
  const groups = {};
  active.forEach((c) => { const k = lastKey(c.name); (groups[k] = groups[k] || []).push(c); });
  Object.entries(groups).forEach(([k, g]) => {
    if (g.length < 2 || kept.includes(k)) return;
    if (g.some((c) => candKey(c) === k)) return;          // someone still uses the plain key
    const doc = (state.availCand || {})[k];
    if (picks(doc) > 0) out.push({ key: k, ids: g.map((c) => c.id), names: g.map((c) => c.name) });
  });
  return out;
}

// Move the surname-only document to the applicant Admin chose: copy the
// whole document, then delete it; never over answers already given (picks guard).
export function claimPlan(state, key, toId) {
  const c = (state.candidates || []).find((x) => x.id === toId);
  const plan = blank();
  if (!c) return plan;
  const to = candKey(c), from = (state.availRaw || {})[key] || toRaw((state.availCand || {})[key]);
  const target = (state.availRaw || {})[to] || toRaw((state.availCand || {})[to]);
  if (picks(from) && !picks(target)) { plan.writes.push({ coll: "interviews_availCand", id: to, data: from }); plan.deletes.push({ coll: "interviews_availCand", id: key }); }
  else if (picks(target)) plan.skipped.push(`${display(c.name)} has already answered again under their own name, so those answers were kept.`);
  plan.summary = plan.writes.length ? `Moves the answers saved under the last name ${key} to ${display(c.name)}.` : plan.skipped[0] || "Nothing to move.";
  return plan;
}
const toRaw = (slots) => (slots ? { slots: { ...slots } } : null);
const blank = () => ({ writes: [], deletes: [], candidates: {}, overrides: {}, schedulePanels: {}, skipped: [], counts: {}, summary: "" });

// ---- H5: rename ------------------------------------------------------------
// Keeps the id, so every rating, score and note stays. When the surname key
// changes and they have saved times, the availability document moves with them.
export function renamePlan(state, id, newName) {
  const plan = blank();
  const cands = state.candidates || [];
  const c = cands.find((x) => x.id === id);
  const name = String(newName || "").replace(/\s+/g, " ").trim();
  if (!c || !name) { plan.error = "Type the name as it should appear."; return plan; }
  if (cands.some((x) => x.id !== id && !x.removed && x.name.trim().toLowerCase() === name.toLowerCase())) {
    plan.error = "Another applicant already has that name."; return plan;
  }
  const oldKey = candKey(c);
  const next = cands.map((x) => (x.id === id ? { ...x, name, availKey: undefined } : x));
  const renamed = next.find((x) => x.id === id);
  // keep their own key if they still share the old surname; otherwise recompute
  if (c.availKey && lastKey(name) === lastKey(c.name)) renamed.availKey = c.availKey;
  const keys = assignKeys(next);
  if (keys.clash.includes(name)) { plan.error = "Two applicants have the same first and last name. Add a middle initial to one of them so we can tell them apart."; return plan; }
  Object.entries(keys.patches).forEach(([cid, p]) => { if (cid !== id) plan.candidates[cid] = p; });
  const newKeyField = keys.patches[id] ? keys.patches[id].availKey : renamed.availKey;
  plan.candidates[id] = { name, ...(newKeyField ? { availKey: newKeyField } : (c.availKey ? { availKey: null } : {})) };
  const newKey = newKeyField || lastKey(name);
  const raw = (k) => (state.availRaw || {})[k] || toRaw((state.availCand || {})[k]);
  plan.counts.timesMove = false;
  if (newKey !== oldKey) {
    const from = raw(oldKey), to = raw(newKey);
    const othersUseOld = cands.some((x) => x.id !== id && !x.removed && candKey(x) === oldKey);
    if (picks(from) && !othersUseOld) {
      if (picks(to)) plan.skipped.push(`Answers are already saved under ${newKey}, so the old ones were left where they are.`);
      else { plan.writes.push({ coll: "interviews_availCand", id: newKey, data: from }); plan.deletes.push({ coll: "interviews_availCand", id: oldKey }); plan.counts.timesMove = true; }
    }
    plan.deletes.push({ coll: "interviews_applicant", id: oldKey });
  }
  plan.newKey = newKey; plan.oldKey = oldKey;
  plan.shared = sharedSurnameText(next.map((x) => (x.id === id ? { ...x, name } : x)), lastKey(name));
  plan.summary = "Their screening, scores and notes stay with them." + (plan.counts.timesMove ? " Their interview times move with them." : "");
  return plan;
}

// ---- H5: merge (a remove-and-re-add mix-up) ---------------------------------
// Port of scripts/migrate-candidate.mjs: per collection copy then delete, never
// over real input already on the target; availability copies the WHOLE document
// (slots, reply, replyAt) with the picks guard; the hand-made panel, the locked
// panel and the offer move unless the target has its own.
export function mergePlan(state, fromId, toId) {
  const plan = blank();
  const cands = state.candidates || [];
  // the source may be gone from the roster entirely (a hard delete by an old
  // script): its saved input can still be moved
  const src = cands.find((c) => c.id === fromId) || { id: fromId, name: "an entry no longer on the list", removed: true, gone: true };
  const dst = cands.find((c) => c.id === toId);
  if (!dst || fromId === toId) { plan.error = "Pick two different entries."; return plan; }
  const n = { ratings: 0, concerns: 0, notes: 0, scores: 0, times: false, panel: false, offer: false };
  const blocked = new Set();
  for (const [coll, field, real] of [["interviews_screening", "screening", realScreening], ["interviews_scores", "scores", realScore]]) {
    Object.entries(state[field] || {}).forEach(([k, v]) => {
      const i = k.indexOf("~"); if (i < 0 || k.slice(i + 1) !== fromId) return;
      const member = k.slice(0, i), target = `${member}~${toId}`;
      if (!real(v)) { plan.deletes.push({ coll, id: k }); return; }
      if (real((state[field] || {})[target])) { blocked.add(member); return; }
      plan.writes.push({ coll, id: target, data: { ...v, member, candId: toId } });
      plan.deletes.push({ coll, id: k });
      if (field === "screening") { if (v.rating) n.ratings++; if (v.flag) n.concerns++; if (String(v.note || "").trim()) n.notes++; }
      else n.scores++;
    });
  }
  const fk = src.gone ? null : candKey(src), tk = candKey(dst);
  const raw = (k) => (state.availRaw || {})[k] || toRaw((state.availCand || {})[k]);
  if (fk && fk !== tk && picks(raw(fk)) && !cands.some((x) => x.id !== fromId && !x.removed && candKey(x) === fk)) {
    if (picks(raw(tk))) plan.skipped.push("interview times (they already have times under the entry you keep)");
    else { plan.writes.push({ coll: "interviews_availCand", id: tk, data: raw(fk) }); plan.deletes.push({ coll: "interviews_availCand", id: fk }); n.times = true; }
  }
  const ov = ((state.settings || {}).panelOverrides) || {};
  if (ov[fromId]) { if (!ov[toId]) { plan.overrides[toId] = ov[fromId]; n.panel = true; } plan.overrides[fromId] = null; }
  const sp = ((state.schedule || {}).panels) || {};
  if (sp[fromId]) { if (!sp[toId]) { plan.schedulePanels[toId] = sp[fromId]; n.panel = true; } plan.schedulePanels[fromId] = null; }
  const offers = state.offers || {};
  if (offers[fromId] && offers[fromId].status) {
    if (offers[toId] && offers[toId].status) plan.skipped.push("the offer record (the entry you keep has its own)");
    else { plan.writes.push({ coll: "interviews_offers", id: toId, data: offers[fromId] }); plan.deletes.push({ coll: "interviews_offers", id: fromId }); n.offer = true; }
  }
  if (!src.gone) {
    if (!cands.some((x) => x.id !== fromId && !x.removed && candKey(x) === fk)) plan.deletes.push({ coll: "interviews_applicant", id: fk });
    plan.candidates[fromId] = { removed: true, mergedInto: toId };
  }
  plan.blocked = [...blocked];
  plan.counts = n;
  const pl = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const bits = [n.ratings && pl(n.ratings, "rating"), n.concerns && pl(n.concerns, "concern"), n.notes && pl(n.notes, "note"),
    n.scores && pl(n.scores, "score"), n.times && "their interview times", n.panel && "their hand-made panel", n.offer && "their offer record"].filter(Boolean);
  plan.summary = `Moves from '${src.name}' to '${dst.name}': ${bits.length ? andList(bits) : "nothing"}.`
    + (blocked.size ? ` Not moved, because these people already have input on '${dst.name}': ${[...blocked].join(", ")}.` : "")
    + (plan.skipped.length ? ` Also not moved: ${plan.skipped.join("; ")}.` : "")
    + " The emptied entry stays on the list as removed.";
  return plan;
}

// ---- H5: delete permanently (only an entry already marked removed) -----------
export function deletePlan(state, id) {
  const plan = blank();
  const cands = state.candidates || [];
  const c = cands.find((x) => x.id === id) || { id, name: "", removed: true, gone: true };
  if (!c.removed) { plan.error = "Remove them from the list first."; return plan; }
  const n = { screening: 0, scores: 0, times: false, offer: false, panel: false };
  for (const [coll, field] of [["interviews_screening", "screening"], ["interviews_scores", "scores"]]) {
    Object.keys(state[field] || {}).forEach((k) => {
      if (k.slice(k.indexOf("~") + 1) !== id) return;
      plan.deletes.push({ coll, id: k }); n[field]++;
    });
  }
  const k = c.gone ? null : candKey(c);
  const shared = !k || cands.some((x) => x.id !== id && !x.removed && candKey(x) === k);
  if (!shared && ((state.availRaw || {})[k] || (state.availCand || {})[k])) { plan.deletes.push({ coll: "interviews_availCand", id: k }); n.times = true; }
  if (!shared) plan.deletes.push({ coll: "interviews_applicant", id: k });
  if ((state.offers || {})[id]) { plan.deletes.push({ coll: "interviews_offers", id }); n.offer = true; }
  if ((((state.settings || {}).panelOverrides) || {})[id]) { plan.overrides[id] = null; n.panel = true; }
  if ((((state.schedule || {}).panels) || {})[id]) { plan.schedulePanels[id] = null; n.panel = true; }
  if (!c.gone) plan.deletes.push({ coll: "interviews_candidates", id });
  plan.counts = n;
  plan.entries = n.screening + n.scores + (n.times ? 1 : 0) + (n.offer ? 1 : 0) + (n.panel ? 1 : 0);
  const bits = [`${n.screening} screening answer${n.screening === 1 ? "" : "s"}`, `${n.scores} score${n.scores === 1 ? "" : "s"}`,
    n.times && "their interview times", n.offer && "their offer record", n.panel && "their panel"].filter(Boolean);
  plan.summary = `Delete ${c.gone ? "these saved entries" : c.name} permanently? This removes ${c.gone ? "" : "their name and "}everything saved about them: ${andList(bits)}. `
    + "It can't be undone, except from a backup file.";
  plan.confirmWord = c.gone ? "delete" : lastKey(c.name);
  return plan;
}
