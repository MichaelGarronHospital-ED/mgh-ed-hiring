// R3: round stages, deadlines, the schedule lock (H4) and the shortlist (H7),
// through the real UI on LocalStore. Run: node stages.mjs [name]
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, pickMember, landAsAdmin, tab, dumpState, sleep, daysAhead } from "./drive.mjs";
import { readPanels } from "./scrape.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [
  { id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" },
  { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" },
  { id: "t2", date: daysAhead(31), start: "09:00", end: "10:00" },
];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false },
    { id: "c-3", name: "Dr Omar Fahmy", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: { Abara: { t0: "ip", t1: "ip", t2: "ip" }, Bruns: { t0: "ip", t1: "ip", t2: "ip" }, Chen: { t0: "ip", t1: "ip", t2: "ip" },
    Dufour: { t0: "ip", t1: "ip", t2: "ip" }, Ekwueme: { t0: "ip", t1: "ip" } },
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "ip" }, fahmy: { t2: "ip" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null,
  questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] },
  ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);
const concerns = (ids, cid) => Object.fromEntries(ids.map((m) => [`${m}~${cid}`, { member: m, candId: cid, flag: true, reason: `${m} is worried` }]));

async function load(page, url, state, code) {
  await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, code);
}
async function openCard(page, sec) {
  await page.evaluate(() => { if (document.querySelector("#setupModal").classList.contains("hidden")) document.querySelector("#setupBtn").click(); });
  await sleep(100);
  await page.evaluate((sec) => { const d = document.querySelector(`details[data-sec="${sec}"]`); d.open = true; d.dispatchEvent(new Event("toggle")); }, sec);
  await sleep(200);
}
const closeSetup = (page) => page.evaluate(() => document.querySelector("#setupClose").click());
const clickText = (page, scope, text) => page.evaluate((scope, text) => {
  const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === text);
  if (!b) throw new Error(`no button "${text}" in ${scope}`); b.click();
}, scope, text);
async function confirm(page, which = "yes") {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const t = await page.$eval("#confirmMsg", (e) => e.textContent);
  await page.click(which === "alt" ? "#confirmAlt" : which === "no" ? "#confirmNo" : "#confirmYes"); await sleep(300); return t;
}
async function relogin(page, code) {
  await page.evaluate(() => document.querySelector("#logout").click());
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(300);
  await signIn(page, code);
}
const onList = async (page) => (await dumpState(page));

const scenarios = {
  // review: the applicant's name form is not redrawn by unrelated updates (a
  // redraw wiped what they had typed, or what the browser filled in)
  async nameFormSurvivesUpdates(page, url) {
    const problems = [];
    await load(page, url, base(), "guestpw");
    await page.waitForSelector("#candName");
    await page.type("#candName", "Ashc");
    const other = await page.browser().newPage();
    await other.goto(url, { waitUntil: "domcontentloaded" });
    await other.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
      s.screening = { ...(s.screening || {}), "Bruns~c-1": { member: "Bruns", candId: "c-1", rating: 3 } };
      localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
      new BroadcastChannel("ed_interviews").postMessage(1);
    });
    await sleep(500);
    await page.bringToFront();
    const v = await page.$eval("#candName", (e) => e.value).catch(() => "(gone)");
    problems.push(...ok(v === "Ashc", `the typed name became "${v}" after an update`));
    await other.close();
    return problems;
  },
  // H4: close screening; the list is frozen; a reviewer's buttons are disabled
  // and nothing is written.
  async closeScreeningReviewerCannotRate(page, url) {
    const problems = [];
    await load(page, url, base({ screening: concerns(["Bruns", "Chen"], "c-3") }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setStages");
    await clickText(page, "#settings", "Close screening");
    const msg = await confirm(page);
    problems.push(...ok(msg.includes("2 on the list, 1 off"), `confirm: ${msg}`));
    let st = await dumpState(page);
    problems.push(...ok(st.meta.stages && st.meta.stages.screening.closed === true, "screening not closed"));
    problems.push(...ok(st.candidates.find((c) => c.id === "c-3").shortlist === "out" && st.candidates.find((c) => c.id === "c-1").shortlistBy === "auto", "the list wasn't frozen"));
    problems.push(...ok(Object.values(st.history).some((h) => h.action === "stage.close"), "no stage.close history"));
    const card = await page.$eval('details[data-sec="setStages"]', (e) => e.textContent);
    problems.push(...ok(/Screening:\s*closed/.test(card) && card.includes("Reopen"), "the card doesn't say closed"));
    await closeSetup(page);
    await relogin(page, "staffpw"); await pickMember(page, "Dufour");
    const hint = await page.$eval("#screen .hint", (e) => e.textContent);
    problems.push(...ok(hint === "Screening is closed. Your answers are saved.", `hint: ${hint}`));
    const enabled = await page.$$eval("#screen .rate button, #screen .flagbtn", (b) => b.filter((x) => !x.disabled).length);
    problems.push(...ok(enabled === 0, `${enabled} screening buttons still enabled`));
    const aria = await page.$$eval("#screen .rate button", (b) => b.every((x) => x.getAttribute("aria-disabled") === "true"));
    problems.push(...ok(aria, "buttons lack aria-disabled"));
    await page.evaluate(() => { window.IV.rate("c-1", 4); window.IV.toggleFlag("c-1"); }); await sleep(200);
    st = await dumpState(page);
    problems.push(...ok(!st.screening["Dufour~c-1"], "a closed-stage rating was written"));
    return problems;
  },

  // H4: reopening clears the frozen (auto) answers and keeps leadership's.
  async reopenScreeningClearsAuto(page, url) {
    const problems = [];
    const cands = base().candidates.map((c) => c.id === "c-2" ? { ...c, shortlist: "out", shortlistBy: "leadership" } : c);
    await load(page, url, base({ candidates: cands }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setStages");
    await clickText(page, "#settings", "Close screening"); await confirm(page);
    await clickText(page, "#settings", "Reopen"); await sleep(300);
    const st = await dumpState(page);
    problems.push(...ok(st.candidates.find((c) => c.id === "c-1").shortlistBy === undefined, "auto answer kept after reopen"));
    problems.push(...ok(st.candidates.find((c) => c.id === "c-2").shortlist === "out", "leadership decision lost on reopen"));
    problems.push(...ok(st.meta.stages.screening.closed === false, "not reopened"));
    return problems;
  },

  // H4: lock; an interviewer clears a time; the panel does not move and Needs
  // attention names them. Unlock restores the auto panels.
  async lockScheduleHolds(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw");
    await landAsAdmin(page); await tab(page, "panels");
    const before = await readPanels(page);
    await clickText(page, "#panels", "Lock the schedule");
    const msg = await confirm(page);
    problems.push(...ok(msg.includes(`The ${before.schedule.length} panels stay exactly as they are now`), `confirm: ${msg}`));
    let st = await dumpState(page);
    problems.push(...ok(st.schedule && st.schedule.locked && Object.keys(st.schedule.panels).length === before.schedule.length, "schedule not saved"));
    const line = await page.$eval("#panels .lockline", (e) => e.textContent).catch(() => "");
    problems.push(...ok(line.startsWith("Schedule locked"), `lock line: ${line}`));
    // someone on c-1's panel says they can no longer do t0
    const p1 = st.schedule.panels["c-1"];
    const who = p1.members.find((m) => m !== "Abara");
    st.availIv[who] = { ...st.availIv[who] }; delete st.availIv[who].t0;
    await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), st);
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true"); await sleep(400);
    await tab(page, "panels");
    const after = await readPanels(page);
    const was = before.schedule.find((p) => p.name.includes("Ashcombe")), now = after.schedule.find((p) => p.name.includes("Ashcombe"));
    problems.push(...ok(now && was && now.members.join() === was.members.join() && now.slot === was.slot, `panel moved: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`));
    const att = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(att.includes(`${who} is on`) && att.includes("no longer says they are free then"), "Needs attention doesn't name them"));
    // unlock: back to following availability
    await clickText(page, "#panels", "Unlock"); await confirm(page);
    const free = await readPanels(page);
    const a2 = free.schedule.find((p) => p.name.includes("Ashcombe"));
    problems.push(...ok(a2 && !a2.members.includes(who), `after unlock ${who} is still on the panel: ${JSON.stringify(a2)}`));
    st = await dumpState(page);
    problems.push(...ok(st.schedule.locked === false, "not unlocked"));
    return problems;
  },

  // H4: the countdown reads the date from Setup.
  async deadlineBannerReadsSetup(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw");
    await landAsAdmin(page); await openCard(page, "setDeadlines");
    await page.$eval("#dlScreening", (e, v) => { e.value = v; }, daysAhead(5));
    await clickText(page, "#settings", "Save dates"); await sleep(300); await closeSetup(page);
    const banner = await page.$eval("#banner", (e) => !e.classList.contains("hidden") && e.textContent);
    problems.push(...ok(banner && banner.includes("Screening closes in 5 days"), `banner: ${banner}`));
    await openCard(page, "setStages");
    await clickText(page, "#settings", "Close screening"); await confirm(page);
    const gone = await page.$eval("#banner", (e) => e.classList.contains("hidden"));
    problems.push(...ok(gone, "the banner stays after screening closed"));
    return problems;
  },

  // H7: notes never count; "Make this a note" keeps the words; On overrides concerns.
  async notesAndDecisions(page, url) {
    const problems = [];
    const screening = { ...concerns(["Bruns", "Chen", "Dufour"], "c-1"),
      "Ekwueme~c-2": { member: "Ekwueme", candId: "c-2", note: "I supervised her elective.", conflict: true },
      "Abara~c-2": { member: "Abara", candId: "c-2", note: "Strong letters." }, "Chen~c-2": { member: "Chen", candId: "c-2", note: "Good." } };
    await load(page, url, base({ screening }), "adminpw");
    await landAsAdmin(page);
    let text = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(text.includes("Off the list: 3 concerns"), "no off-the-list pill"));
    problems.push(...ok(text.includes("Notes (don't count)") && text.includes("I supervised her elective.") && text.includes("knows them"), "notes not shown"));
    let st = await dumpState(page);
    // three notes, no concerns: still on
    await tab(page, "panels");
    let panels = await readPanels(page);
    problems.push(...ok(panels.schedule.some((p) => p.name.includes("Carter")), "a note took someone off the schedule"));
    await tab(page, "screen");
    // On overrides 3 concerns
    await page.evaluate(() => window.IV.setShortlist("c-1", "in")); await sleep(300);
    text = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(text.includes("Kept on by leadership"), "no kept-on pill"));
    await tab(page, "panels");
    panels = await readPanels(page);
    problems.push(...ok(panels.schedule.some((p) => p.name.includes("Ashcombe")), "On didn't put Ashcombe back on the schedule"));
    await tab(page, "screen");
    // make Bruns's concern a note
    await page.evaluate(() => { const b = [...document.querySelectorAll("#screen button")].find((x) => x.dataset.m === "Bruns" && x.dataset.c === "c-1"); b.click(); });
    const msg = await confirm(page);
    problems.push(...ok(msg.includes("Move Bruns's concern to a note") && msg.includes("Bruns's words stay the same"), `confirm: ${msg}`));
    st = await dumpState(page);
    const d = st.screening["Bruns~c-1"];
    problems.push(...ok(d.flag === false && d.reason === "" && d.note === "Bruns is worried", `after: ${JSON.stringify(d)}`));
    const hist = Object.entries(st.history).map(([id, h]) => ({ id, ...h }));
    problems.push(...ok(hist.some((h) => h.action === "screening.toNote") && hist.some((h) => h.action === "shortlist.set"), "history missing"));
    // undo "make this a note" from Change history
    await openCard(page, "setHistory"); await sleep(300);
    await page.evaluate(() => { const rows = [...document.querySelectorAll(".hrow")];
      const r = rows.find((x) => x.textContent.includes("Moved Bruns's concern")); r.querySelector("button").click(); });
    await sleep(500);
    st = await dumpState(page);
    problems.push(...ok(st.screening["Bruns~c-1"].flag === true && st.screening["Bruns~c-1"].reason === "Bruns is worried", "undo didn't restore the concern"));
    return problems;
  },

  // H7: threshold 0 keeps everyone on; closing screening freezes the list so a
  // later threshold change has no effect.
  async thresholdAndFreeze(page, url) {
    const problems = [];
    await load(page, url, base({ screening: concerns(["Bruns", "Chen"], "c-1") }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setRule");
    await page.$eval("#thIn", (e) => { e.value = "0"; });
    await clickText(page, "#settings", "Save rule"); await sleep(300); await closeSetup(page);
    let text = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(!text.includes("Off the list"), "threshold 0 still takes someone off"));
    await openCard(page, "setStages");
    await clickText(page, "#settings", "Close screening"); await confirm(page);
    await openCard(page, "setRule");
    await page.$eval("#thIn", (e) => { e.value = "1"; });
    await clickText(page, "#settings", "Save rule"); await sleep(300); await closeSetup(page);
    const st = await dumpState(page);
    problems.push(...ok(st.candidates.find((c) => c.id === "c-1").shortlist === "in", "the frozen list changed with the rule"));
    text = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(!text.includes("Off the list"), "threshold change moved a frozen applicant"));
    return problems;
  },

  // H4: reveal the ranking and close scoring in one step.
  async revealClosesScoring(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw");
    await landAsAdmin(page); await tab(page, "ranking");
    await clickText(page, "#ranking", "Mark interviews complete & reveal ranking");
    const msg = await confirm(page, "yes");
    problems.push(...ok(msg.includes("Scoring is still open"), `confirm: ${msg}`));
    await sleep(300);
    const st = await dumpState(page);
    problems.push(...ok(st.meta.interviewsComplete === true && st.meta.stages.scoring.closed === true, `state: ${JSON.stringify(st.meta)}`));
    await relogin(page, "staffpw"); await pickMember(page, "Chen"); await tab(page, "score");
    const hint = await page.$eval("#score .hint", (e) => e.textContent);
    problems.push(...ok(hint === "Scoring is closed. Your answers are saved.", `score hint: ${hint}`));
    const dis = await page.$$eval("#score textarea, #overallIn", (els) => els.every((e) => e.disabled));
    problems.push(...ok(dis, "score inputs still enabled"));
    return problems;
  },
};

export async function main(only) {
  const site = await serve();
  const b = await browser();
  const log = [];
  const page = await openPage(b, site.url, { log });
  const results = {};
  try {
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only && name !== only) continue;
      log.length = 0;
      try { results[name] = await fn(page, site.url); }
      catch (e) { results[name] = [`threw: ${e.message}`]; }
      const errs = log.filter((l) => l.startsWith("pageerror"));
      if (errs.length) results[name] = [...(results[name] || []), ...errs];
    }
  } finally { await b.close(); site.close(); }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main(process.argv[2]);
  let bad = 0;
  for (const [name, problems] of Object.entries(results)) {
    if (!problems.length) { console.log(`PASS  ${name}`); continue; }
    bad++; console.log(`FAIL  ${name}`); problems.forEach((p) => console.log(`        - ${p}`));
  }
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} stage scenarios pass`);
  process.exit(bad ? 1 : 0);
}
