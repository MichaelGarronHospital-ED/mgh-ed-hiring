// R2: the committee editor (H6) and the questions editor (H2), through the real
// UI on LocalStore. Run: node editors.mjs [name]
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
];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: { Abara: { t0: "ip", t1: "ip" }, Bruns: { t0: "ip", t1: "ip" }, Chen: { t0: "ip", t1: "ip" }, Dufour: { t0: "ip", t1: "ip" }, Ekwueme: { t0: "ip", t1: "ip" } },
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "ip" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null,
  questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }, { id: "1", text: "A difficult case" }], scale: ["1", "2", "3", "4", "5"], guide: [] },
  ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);

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
async function confirmYes(page) {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const t = await page.$eval("#confirmMsg", (e) => e.textContent); await page.click("#confirmYes"); await sleep(300); return t;
}
const rowIndex = (page, name) => page.evaluate((name) =>
  [...document.querySelectorAll('[id^="mName-"]')].findIndex((e) => e.value === name), name);
async function saveCommittee(page) {
  await page.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Save").click());
  await sleep(400);
}
async function relogin(page, code) {
  await page.evaluate(() => document.querySelector("#logout").click());
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(300);
  await signIn(page, code);
}

const scenarios = {
  // H6: renaming someone keeps everything they entered (the id does not change).
  async renameKeepsInput(page, url) {
    const problems = [];
    await load(page, url, base({ screening: { "Bruns~c-1": { member: "Bruns", candId: "c-1", flag: true, reason: "Little ED experience", rating: 2 } } }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setCommittee");
    const i = await rowIndex(page, "Bruns");
    await page.$eval(`#mName-${i}`, (e) => { e.value = ""; });
    await page.type(`#mName-${i}`, "Bruns-Okafor");
    await saveCommittee(page); await closeSetup(page);
    const st = await dumpState(page);
    const m = st.settings.committee.find((x) => x.id === "Bruns");
    problems.push(...ok(m && m.name === "Bruns-Okafor", `saved entry: ${JSON.stringify(m)}`));
    problems.push(...ok(st.screening["Bruns~c-1"].flag === true, "the concern moved or vanished"));
    const coll = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(coll.includes("Bruns-Okafor") && coll.includes("Little ED experience"), "the renamed member's concern doesn't show under the new name"));
    await tab(page, "availability");
    const grid = await page.$eval("#availability", (e) => e.textContent);
    problems.push(...ok(grid.includes("Bruns-Okafor"), "availability grid lost the renamed member"));
    problems.push(...ok(Object.values(st.history || {}).some((h) => h.action === "committee.save" && h.text.includes("1 renamed")), "no committee.save history"));
    return problems;
  },

  // H6: someone who left keeps their input, which still counts; they leave the
  // name list, the panels and the waiting-on lines.
  async leftMemberStillCounts(page, url) {
    const problems = [];
    await load(page, url, base({ screening: {
      "Bruns~c-1": { member: "Bruns", candId: "c-1", flag: true, reason: "Concern one" },
      "Chen~c-1": { member: "Chen", candId: "c-1", flag: true, reason: "Concern two" },
    } }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setCommittee");
    const i = await rowIndex(page, "Bruns");
    await page.evaluate((i) => window.IV.mSet(i, "active", "false"), i);
    await saveCommittee(page); await closeSetup(page);
    const coll = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(coll.includes("Bruns (left)"), "the collation doesn't say (left)"));
    problems.push(...ok(/Excluded|Off the list/.test(coll), "the left member's concern stopped counting"));
    await tab(page, "panels");
    const shown = await readPanels(page);
    problems.push(...ok(shown.schedule.every((p) => !p.members.includes("Bruns")), "someone who left is still on a panel"));
    await tab(page, "availability");
    const grid = await page.$eval("#availability", (e) => e.textContent);
    problems.push(...ok(!grid.includes("Bruns"), "someone who left is still in the availability grid"));
    await relogin(page, "staffpw");
    await page.waitForSelector("#memberpick:not(.hidden)");
    const opts = await page.$$eval("#memberSel option", (o) => o.map((x) => x.textContent));
    problems.push(...ok(!opts.includes("Bruns"), "someone who left is still on the name list"));
    return problems;
  },

  // H6: someone who screens only is on the name list and the Screen tab, never
  // on a panel, the availability grid or the Score tab.
  async screensOnlyNotOnPanels(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw");
    await landAsAdmin(page); await openCard(page, "setCommittee");
    await page.type("#commAdd", "Nguyen");
    await saveCommittee(page); await closeSetup(page);
    let st = await dumpState(page);
    const n = st.settings.committee.find((m) => m.name === "Nguyen");
    problems.push(...ok(n && n.role === "screener" && /^m-/.test(n.id), `added entry: ${JSON.stringify(n)}`));
    await tab(page, "panels");
    const shown = await readPanels(page);
    problems.push(...ok(shown.schedule.every((p) => !p.members.includes("Nguyen")), "a screener is on a panel"));
    await relogin(page, "staffpw");
    await pickMember(page, n.id);
    const tabs = await page.$$eval("#tabs button", (b) => b.map((x) => x.textContent));
    problems.push(...ok(tabs.join() === "Screen", `screener's tabs: ${tabs}`));
    await page.evaluate((id) => window.IV.rate("c-1", 3), n.id); await sleep(200);
    st = await dumpState(page);
    problems.push(...ok((st.screening[`${n.id}~c-1`] || {}).rating === 3, "a screener's rating wasn't saved under their id"));
    return problems;
  },

  // H6: the chair can't leave or become screens-only; duplicate names warn.
  async committeeChecks(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw");
    await landAsAdmin(page); await openCard(page, "setCommittee");
    const i = await rowIndex(page, "Abara");
    await page.evaluate((i) => window.IV.mSet(i, "active", "false"), i);
    await saveCommittee(page);
    const toast = await page.$eval("#toast", (e) => e.textContent);
    problems.push(...ok(toast.includes("Pick another chair first"), `toast: ${toast}`));
    let st = await dumpState(page);
    problems.push(...ok(st.settings.committee.every((m) => m.active !== false), "the chair was saved as left"));
    await page.evaluate(() => window.IV.mDiscard());
    await page.type("#commAdd", "Chen, M");
    await page.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Save").click());
    const msg = await confirmYes(page);
    problems.push(...ok(msg.includes("Two people are called Chen"), `warning: ${msg}`));
    st = await dumpState(page);
    problems.push(...ok(st.settings.committee.filter((m) => m.name === "Chen").length === 2, "the second Chen wasn't added after Save anyway"));
    return problems;
  },

  // H2: edit, reorder, save; notes stay with their question. Then the first
  // score locks the list: add, remove and move are hidden; wording still saves.
  async questionsEditAndLock(page, url) {
    const problems = [];
    await load(page, url, base({ scores: {} }), "adminpw");
    await landAsAdmin(page); await openCard(page, "setQuestions");
    await page.evaluate(() => window.IV.qAdd());
    await page.type("#qText-2", "What would you change here?");
    await page.evaluate(() => window.IV.qMove(2, -1));
    await page.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Save questions").click());
    await sleep(400);
    let st = await dumpState(page);
    const ids = st.questions.questions.map((q) => q.id);
    problems.push(...ok(ids.length === 3 && ids[0] === "0" && ids[2] === "1" && /^q/.test(ids[1]), `saved order ${ids}`));
    problems.push(...ok(st.questions.questions[1].text === "What would you change here?", "new question text not saved"));
    // a note under "1" stays with "A difficult case" wherever it moved
    st.scores = { "Chen~c-1": { notes: { 1: "about the case" } } };
    await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), st);
    await relogin(page, "staffpw"); await pickMember(page, "Chen"); await tab(page, "score");
    await page.select("select[aria-label='Candidate to score']", "c-1"); await sleep(150);
    const qs = await page.$$eval("#score .qrow", (rows) => rows.map((r) => [r.querySelector(".q").textContent, r.querySelector("textarea").value]));
    problems.push(...ok(qs[2] && qs[2][0] === "A difficult case" && qs[2][1] === "about the case", `Score tab rows: ${JSON.stringify(qs)}`));
    // scoring has started now: locked
    await relogin(page, "adminpw"); await landAsAdmin(page); await openCard(page, "setQuestions");
    const card = await page.$eval('details[data-sec="setQuestions"]', (e) => e.textContent);
    problems.push(...ok(card.includes("Locked because scoring has started"), "no lock note"));
    problems.push(...ok(!card.includes("Add a question") && !card.includes("Move up") && !card.includes("Remove"), "add, move or remove still offered while locked"));
    await page.$eval("#qText-0", (e) => { e.value = ""; });
    await page.type("#qText-0", "Tell us about yourself, briefly");
    await page.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Save questions").click());
    const msg = await confirmYes(page);
    problems.push(...ok(msg.includes("Only fix spelling or small wording"), `confirm: ${msg}`));
    st = await dumpState(page);
    problems.push(...ok(st.questions.questions[0].text === "Tell us about yourself, briefly" && st.questions.questions[0].id === "0", "wording fix not saved under the same id"));
    // review: an open Score tab redraws when the wording changes (another tab)
    const pB = await page.browser().newPage();
    await pB.goto(url, { waitUntil: "domcontentloaded" }); await pB.waitForFunction("window.__edReady === true");
    await signIn(pB, "staffpw"); await pickMember(pB, "Chen"); await tab(pB, "score");
    await pB.select("select[aria-label='Candidate to score']", "c-1"); await sleep(150);
    await page.bringToFront();   // a background tab doesn't take typing
    await page.$eval("#qText-0", (e) => { e.value = ""; });
    await page.type("#qText-0", "Tell us about yourself");
    await page.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Save questions").click());
    await confirmYes(page); await sleep(600);
    const q0 = await pB.$eval("#score .qrow .q", (e) => e.textContent).catch(() => "");
    problems.push(...ok(q0 === "Tell us about yourself", `the open Score tab still shows "${q0}"`));
    await pB.close();
    // a structural change while locked is refused even if forced through the draft
    await page.evaluate(() => { window.IV.qSet(0, "x"); });
    await page.evaluate(() => window.IV.qAdd());   // ignored while locked
    st = await dumpState(page);
    problems.push(...ok(st.questions.questions.length === 3, "a question was added while locked"));
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
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} editor scenarios pass`);
  process.exit(bad ? 1 : 0);
}
