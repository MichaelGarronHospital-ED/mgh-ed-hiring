// Randomised rounds through the real app: seed a committee, times, interviewer
// availability and applicant availability, then read the Panels tab back and
// check it against the independently-stated rules.
import { serve, browser, openPage, pickMember, tab } from "./drive.mjs";
import { readPanels, readLoad } from "./scrape.mjs";
import { checkSchedule, activeCandidates } from "./check.mjs";

// deterministic RNG so a failing round can be replayed by seed
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

const NAMES = ["Abara", "Bruns", "Chen", "Dufour", "Ekwueme", "Farr", "Gupta", "Halloran", "Iqbal",
  "Janssen", "Kowalski", "Lindgren", "Mbeki", "Novak", "Ortiz", "Pham"];
const APPS = ["Ashcombe", "Blythe", "Cadogan", "Danforth", "Everly", "Fenwick", "Garrow", "Hollings",
  "Inchbold", "Jessop", "Kerrigan", "Lomax"];
const MODS = ["ip", "zoom", "either"];

export function scenario(seed) {
  const r = rng(seed);
  const nMembers = int(r, 3, 13);
  const committee = NAMES.slice(0, nMembers).map((n, i) => ({ name: n, gender: r() < 0.35 ? "F" : "M" }));
  // a roster with nobody of one gender can never make a balanced panel; allow it
  // sometimes on purpose (it is a real misconfiguration), but usually not
  if (r() < 0.8 && !committee.some((m) => m.gender === "F")) committee[int(r, 0, nMembers - 1)].gender = "F";
  if (r() < 0.8 && !committee.some((m) => m.gender === "M")) committee[int(r, 0, nMembers - 1)].gender = "M";
  const chair = r() < 0.08 ? "Nobody" : pick(r, committee).name;   // sometimes a chair off the roster

  const nSlots = int(r, 1, 10);
  const times = Array.from({ length: nSlots }, (_, i) => ({
    id: "t" + i, date: "2026-10-0" + (1 + (i % 3)),
    start: String(8 + (i % 8)).padStart(2, "0") + ":00", end: String(9 + (i % 8)).padStart(2, "0") + ":00",
  }));
  const slotIds = times.map((t) => t.id);

  const availIv = {};
  committee.forEach((m) => {
    const map = {};
    slotIds.forEach((s) => { if (r() < 0.45) map[s] = pick(r, MODS); });
    if (Object.keys(map).length || r() < 0.7) availIv[m.name] = map;   // some never answer
  });

  const nCands = int(r, 1, 10);
  const candidates = APPS.slice(0, nCands).map((n, i) => ({ id: "c-" + i, name: "Dr " + n, removed: r() < 0.08 }));
  const availCand = {};
  candidates.forEach((c) => {
    const map = {};
    slotIds.forEach((s) => { if (r() < 0.4) map[s] = pick(r, MODS); });
    availCand[c.name.split(" ").pop().toLowerCase()] = map;
  });
  // a couple of flags, so the "≥2 flags drops off the list" path is exercised
  const screening = {};
  candidates.forEach((c) => {
    committee.forEach((m) => { if (r() < 0.06) screening[`${m.name}~${c.id}`] = { flag: true, reason: "" }; });
  });

  return { state: { candidates, screening, availIv, availCand, scores: {}, meta: { interviewsComplete: false },
    settings: { committee, chair, times, oneDrive: "#", panelOverrides: {} }, publicInfo: {}, allowedNames: null },
    committee, chair, slotIds };
}

async function round(page, url, sc) {
  await page.evaluate((s) => {
    localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
    sessionStorage.setItem("ed_iv_code", "adminpw");
  }, sc.state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  // auto-unlocked from the saved code; pick a name and go to Panels
  await pickMember(page, sc.committee[0].name);
  await tab(page, "panels");
  const shown = await readPanels(page);
  const load = await readLoad(page);
  const res = checkSchedule(sc.state, {
    committee: sc.committee, chair: sc.chair, schedule: shown.schedule,
    unschedulable: shown.unschedulable, understaffed: shown.understaffed,
    manualIds: new Set(shown.schedule.filter((p) => p.manual).map((p) => p.cand)),
    slotIds: sc.slotIds,
  });

  const active = activeCandidates(sc.state, sc.committee);
  // the UI says one thing about every unscheduled applicant; the truth has three cases
  const says = shown.reasons || {};
  const SHOULD_SAY = {
    "no-answer": /picked any times yet/,
    "infeasible": /no time they can do yields a balanced panel/,
    "contested": /already taken/,
  };
  const misdiagnosed = Object.entries(res.diagnosis)
    .filter(([id, why]) => !SHOULD_SAY[why].test(says[id] || ""))
    .map(([id, why]) => [id, `${why} but shown as: ${(says[id] || "(nothing)").slice(0, 90)}`]);
  // does the tab give the right reason for each idle interviewer?
  const shownIdle = (load && load.idle) || { silent: [], wrongTimes: [], squeezed: [] };
  const sorted = (a) => [...a].sort().join(",");
  // With no panels at all there is no load section to be wrong — the tab says
  // "no panels yet" instead, which is the whole story.
  const idleWrong = !shown.schedule.length ? [] : ["silent", "wrongTimes", "squeezed"]
    .filter((k) => sorted(shownIdle[k]) !== sorted(res.idleGroups[k]))
    .map((k) => `${k}: shown [${sorted(shownIdle[k])}] but really [${sorted(res.idleGroups[k])}]`);

  return { problems: [...res.problems, ...idleWrong], shown, load, active: active.length,
           idleButFree: res.idleButFree, misdiagnosed,
           people: [res.usedPeople, res.bestPeople] };
}

export async function main(n = 40, startSeed = 1) {
  const site = await serve();
  const b = await browser();
  const log = [];
  const page = await openPage(b, site.url, { log });
  const failures = [], idle = [], misdiag = [];
  try {
    for (let i = 0; i < n; i++) {
      const seed = startSeed + i;
      const sc = scenario(seed);
      let r;
      try { r = await round(page, site.url, sc); }
      catch (e) { failures.push({ seed, problems: [`threw: ${e.message}`] }); continue; }
      if (r.problems.length) failures.push({ seed, problems: r.problems, shown: r.shown });
      if (r.idleButFree.length) idle.push({ seed, who: r.idleButFree, panels: r.shown.schedule.length, people: r.people });
      if (r.misdiagnosed.length) misdiag.push({ seed, cases: r.misdiagnosed, panels: r.shown.schedule.length });
      const pageErrs = log.filter((l) => l.startsWith("pageerror"));
      if (pageErrs.length) { failures.push({ seed, problems: pageErrs.slice() }); log.length = 0; }
    }
  } finally { await b.close(); site.close(); }
  return { failures, idle, misdiag, log };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = +(process.argv[2] || 40), start = +(process.argv[3] || 1);
  const { failures, idle, misdiag } = await main(n, start);
  console.log(`${n} rounds from seed ${start}: ${failures.length} with rule violations, ${idle.length} with an idle-but-available interviewer, ${misdiag.length} where the "unschedulable" reason shown is wrong`);
  failures.slice(0, 12).forEach((f) => console.log(`\nseed ${f.seed}:\n - ${f.problems.join("\n - ")}`));
  idle.slice(0, 8).forEach((f) => console.log(`seed ${f.seed}: idle though a better sharing exists — ${f.who.join(", ")} (${f.panels} panels, used ${f.people[0]} of a possible ${f.people[1]})`));
  misdiag.slice(0, 8).forEach((f) => console.log(`seed ${f.seed}: wrong reason shown — ${f.cases.map(([id, w]) => id + ":" + w).join(", ")}`));
  process.exit(failures.length ? 1 : 0);
}
