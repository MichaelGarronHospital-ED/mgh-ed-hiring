// R6: close the round, bring it back, restore from a file, kept items, and a
// stale close finished or stopped from another page, through the real UI on
// LocalStore (the local store restates the rules' lease and ownership checks).
// The concurrency cases that need the real rules run in emulator.mjs.
// Run: node rounds.mjs [name]
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, pickMember, landAsAdmin, tab, dumpState, sleep, daysAhead } from "./drive.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [{ id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" }, { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" }];
const QUESTIONS = { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }, { id: "q1", text: "A hard shift" }], scale: ["1", "2", "3", "4", "5"], guide: ["Same questions for all"] };
const full = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false }],
  screening: { "Bruns~c-1": { member: "Bruns", candId: "c-1", rating: 4 }, "Chen~c-2": { member: "Chen", candId: "c-2", flag: true, reason: "Short ED time" } },
  scores: { "Abara~c-1": { member: "Abara", candId: "c-1", overall: 4.2, notes: { 0: "Clear" } } },
  meta: { interviewsComplete: true, roundId: "r-2026", roundName: "Hiring round 2026", stages: { screening: { closed: true } } },
  availIv: Object.fromEntries(COMMITTEE.map((m) => [m.name, { t0: "ip", t1: "ip" }])),
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "either" } },
  offers: { "c-1": { status: "offered", offeredAt: "2026-10-10" } },
  notices: { ashcombe: { date: TIMES[0].date, start: "09:00", end: "10:00", format: "ip" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "https://onedrive.example/x", panelOverrides: { "c-1": { slot: "t0", members: ["Abara", "Bruns", "Chen"], modality: "ip" } },
    flagThreshold: 3, retentionMonths: 24, interviewInfo: { location: "ED admin office" }, deadlines: { reply: daysAhead(20) }, days: {} },
  schedule: { locked: true, panels: { "c-1": { slot: "t0", room: 1, chair: "Abara", members: ["Abara", "Bruns", "Chen"], modality: "ip" } } },
  questions: QUESTIONS, passwordsMeta: { ed: { changedAt: "2026-10-01" } },
  history: { h1: { at: new Date(Date.now() - 864e5).toISOString(), by: "leadership", action: "schedule.lock", text: "Locked the schedule" } },
  publicInfo: {}, allowedNames: ["ashcombe", "carter"],
  ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);

async function load(page, url, state, code = "adminpw") {
  await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, code);
}
const flowTitle = (page) => page.$eval("#flowTitle", (e) => e.textContent).catch(() => "");
const flowClick = (page, label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll("#flowBtns button")].find((x) => x.textContent.trim() === label);
  if (!b) throw new Error(`no dialog button "${label}" (have: ${[...document.querySelectorAll("#flowBtns button")].map((x) => x.textContent).join("|")})`); b.click();
}, label);
const waitTitle = (page, t, timeout = 15000) => page.waitForFunction((t) => (document.querySelector("#flowTitle") || {}).textContent === t, { timeout }, t);
const nextDownload = (page, act) => page.evaluate((act) => new Promise((resolve) => {
  const orig = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = click; };
  URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = orig; return "blob:stub"; };
  eval(act);
}), act);
async function openCard(page, sec) {
  await page.evaluate(() => { if (document.querySelector("#setupModal").classList.contains("hidden")) document.querySelector("#setupBtn").click(); });
  await sleep(100);
  await page.evaluate((sec) => { const d = document.querySelector(`details[data-sec="${sec}"]`); d.open = true; d.dispatchEvent(new Event("toggle")); }, sec);
  await sleep(300);
}
// the whole close through the dialog; returns the downloaded backup text
async function closeRound(page, { stopAt } = {}) {
  await page.evaluate(() => window.IV.closeRound());
  await waitTitle(page, "Close the round?");
  await flowClick(page, "Continue");
  await waitTitle(page, "Now save the backup");
  if (stopAt === "step5") return null;
  const text = await nextDownload(page, "document.getElementById('clBackup').click()");
  await page.click("#clSaved"); await sleep(50);
  await flowClick(page, "Next");
  await waitTitle(page, "Close the round");
  const name = await page.$eval("#flowBody b", (e) => e.textContent);
  await page.type("#clName", name);
  if (stopAt === "step6") return text;
  await flowClick(page, "Close the round");
  await waitTitle(page, "Round closed", 20000);
  return text;
}

const scenarios = {
  // A quiet close finishes in ONE pass with nothing kept; the working round is
  // empty; times and slots are empty arrays; the committee, chair, kept
  // settings, questions and passwords are exactly as before (review 2 B1).
  async quietClose(page, url) {
    const problems = [];
    await load(page, url, full()); await landAsAdmin(page);
    const before = await dumpState(page);
    const text = await closeRound(page);
    const b = JSON.parse(text);
    problems.push(...ok(b.data.interviews_candidates["c-1"] && b.round.name === "Hiring round 2026" && b.data.interviews_meta.state.roundStatus === "open", "backup file is wrong"));
    const st = await dumpState(page);
    problems.push(...ok(!st.candidates.length && !Object.keys(st.screening).length && !Object.keys(st.scores).length && !Object.keys(st.availIv).length
      && !Object.keys(st.availCand).length && !Object.keys(st.offers).length && !Object.keys(st.notices || {}).length, "the working round is not empty"));
    const hist = Object.values(st.history || {});
    problems.push(...ok(hist.length === 1 && hist[0].action === "round.close" && hist[0].text.startsWith("Closed the round 'Hiring round 2026' (2 applicants"), `history: ${JSON.stringify(hist)}`));
    problems.push(...ok(Array.isArray(st.settings.times) && !st.settings.times.length && Array.isArray(st.settings.slots) && !st.settings.slots.length, "times or slots not emptied"));
    for (const k of ["committee", "chair", "oneDrive", "flagThreshold", "retentionMonths", "interviewInfo"])
      problems.push(...ok(JSON.stringify(st.settings[k]) === JSON.stringify(before.settings[k]), `${k} changed`));
    problems.push(...ok(JSON.stringify(st.questions) === JSON.stringify(before.questions), "questions changed"));
    problems.push(...ok(JSON.stringify(st.passwordsMeta) === JSON.stringify(before.passwordsMeta), "passwords changed"));
    problems.push(...ok(st.meta.roundStatus === "open" && st.meta.roundId !== "r-2026" && !st.meta.closingTab && !(st.meta.keptFromClose || []).length, `state: ${JSON.stringify(st.meta)}`));
    const att = Object.values(st.archive || {});
    problems.push(...ok(att.length === 1 && att[0].status === "closed" && att[0].roundId === "r-2026" && Object.keys(att[0]._chunks).length === att[0].parts && att[0].deleteAfter, "archive attempt wrong"));
    problems.push(...ok(st.schedule && st.schedule.locked === false && !Object.keys(st.schedule.panels).length, "schedule not reset"));
    // the next round shows no times
    await page.evaluate(() => document.querySelector("#flowBtns button").click()); await sleep(200);
    await tab(page, "availability");
    const av = await page.$eval("#availability", (e) => e.textContent);
    problems.push(...ok(av.includes("No interview times yet"), "the next round still shows times"));
    return problems;
  },

  // Bring it back (Past rounds): open, new round id, everything there; close it
  // again: a NEW attempt.
  async bringBackAndCloseAgain(page, url) {
    const problems = [];
    await load(page, url, full()); await landAsAdmin(page);
    await closeRound(page);
    await page.evaluate(() => document.querySelector("#flowBtns button").click());
    await openCard(page, "setPast");
    const past = await page.$eval('details[data-sec="setPast"]', (e) => e.textContent);
    problems.push(...ok(past.includes("Hiring round 2026") && past.includes("closed") && past.includes("2 applicants"), `past rounds: ${past.slice(0, 200)}`));
    await page.evaluate(() => [...document.querySelectorAll('details[data-sec="setPast"] button')].find((b) => b.textContent === "Bring back").click());
    await page.waitForSelector("#confirmWrap:not(.hidden)"); await page.click("#confirmYes"); await sleep(800);
    let st = await dumpState(page);
    problems.push(...ok(st.candidates.length === 2 && st.scores["Abara~c-1"] && st.meta.roundStatus === "open" && st.meta.broughtBackFrom === "r-2026"
      && st.meta.roundId !== "r-2026", `after bring back: ${JSON.stringify(st.meta)}`));
    problems.push(...ok(Object.values(st.archive)[0].restoredAt, "archive not marked brought back"));
    problems.push(...ok(Object.values(st.history).some((h) => h.restored) && Object.values(st.history).some((h) => h.action === "round.restore"), "history not restored"));
    await page.evaluate(() => document.querySelector("#setupClose").click());
    await closeRound(page);
    st = await dumpState(page);
    problems.push(...ok(Object.values(st.archive).filter((a) => a.status === "closed").length === 2, "closing again didn't make a second attempt"));
    return problems;
  },

  // Stop before clearing: nothing changes, the copy is marked abandoned.
  async stopBeforeClearing(page, url) {
    const problems = [];
    await load(page, url, full()); await landAsAdmin(page);
    const before = await dumpState(page);
    await closeRound(page, { stopAt: "step5" });
    let st = await dumpState(page);
    problems.push(...ok(st.meta.roundStatus === "closing" && st.booking === "paused", "not paused during the close"));
    await flowClick(page, "Stop closing");
    await waitTitle(page, "Closing stopped");
    st = await dumpState(page);
    problems.push(...ok(st.meta.roundStatus === "open" && !st.meta.closingTab, "round not reopened"));
    problems.push(...ok(JSON.stringify(st.candidates) === JSON.stringify(before.candidates) && JSON.stringify(st.scores) === JSON.stringify(before.scores), "the round changed"));
    problems.push(...ok(Object.values(st.archive)[0].status === "abandoned", "attempt not abandoned"));
    problems.push(...ok(Object.values(st.history).filter((h) => h.action === "round.close").length === 1, "no single stop entry"));
    return problems;
  },

  // A change made after the copy (an older page) is never deleted: it stays,
  // quarantined, until leadership decides; a new close can't start meanwhile.
  async keptItemsQuarantined(page, url) {
    const problems = [];
    await load(page, url, full()); await landAsAdmin(page);
    await closeRound(page, { stopAt: "step6" });
    const st0 = await dumpState(page);
    st0.screening["Bruns~c-1"] = { member: "Bruns", candId: "c-1", rating: 5 };   // an older page changed it after the copy
    await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), st0);
    await flowClick(page, "Close the round");
    await waitTitle(page, "Round closed", 20000);
    let st = await dumpState(page);
    problems.push(...ok(st.screening["Bruns~c-1"] && st.screening["Bruns~c-1"].rating === 5, "the changed item was deleted"));
    problems.push(...ok((st.meta.keptFromClose || []).length === 1 && st.meta.keptFromClose[0].id === "Bruns~c-1", `kept: ${JSON.stringify(st.meta.keptFromClose)}`));
    await page.evaluate(() => document.querySelector("#flowBtns button").click());
    await openCard(page, "setRound");
    const card = await page.$eval('details[data-sec="setRound"]', (e) => e.textContent);
    problems.push(...ok(card.includes("1 item was kept from the closed round"), "kept items not shown"));
    const disabled = await page.evaluate(() => [...document.querySelectorAll('details[data-sec="setRound"] button')].find((b) => b.textContent === "Close this round").disabled);
    problems.push(...ok(disabled, "a new close can start with items kept"));
    // the backup leaves the quarantined item out
    const text = await nextDownload(page, "window.IV.downloadBackup()");
    problems.push(...ok(!JSON.parse(text).data.interviews_screening["Bruns~c-1"], "a quarantined item got into a backup"));
    await page.evaluate(() => [...document.querySelectorAll('details[data-sec="setRound"] button')].find((b) => b.textContent === "Keep them in this round").click());
    await sleep(400);
    st = await dumpState(page);
    problems.push(...ok(!(st.meta.keptFromClose || []).length && st.screening["Bruns~c-1"], "keep didn't clear the list"));
    return problems;
  },

  // Restore "missing items only" after a candidate was deleted by mistake; a
  // file from another round is refused for that; a tampered file is refused.
  async restoreFromFile(page, url) {
    const problems = [];
    await load(page, url, full()); await landAsAdmin(page);
    const text = await nextDownload(page, "window.IV.downloadBackup()");
    const st0 = await dumpState(page);
    st0.candidates = st0.candidates.filter((c) => c.id !== "c-2"); delete st0.screening["Chen~c-2"];
    await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), st0);
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true"); await landAsAdmin(page); await sleep(400);
    const choose = async (t) => {
      await openCard(page, "setRestore");
      const input = await page.$("#rsFile");
      const fs = await import("node:fs");
      const f = `/tmp/hiring-restore-${Date.now()}.json`; fs.writeFileSync(f, t);
      await input.uploadFile(f); await sleep(800);
      return page.$eval('details[data-sec="setRestore"]', (e) => e.textContent);
    };
    let card = await choose(text);
    problems.push(...ok(/Applicants\s*2\s*1\s*1\s*1\s*0/.test(card.replace(/\s+/g, " ").replace(/(\d) (\d)/g, "$1 $2")) || card.includes("Will be added"), `preview: ${card.slice(0, 300)}`));
    await page.evaluate(() => [...document.querySelectorAll('details[data-sec="setRestore"] button')].find((b) => b.textContent === "Restore").click());
    await sleep(800);
    let st = await dumpState(page);
    problems.push(...ok(st.candidates.some((c) => c.id === "c-2") && st.screening["Chen~c-2"], "missing items not brought back"));
    problems.push(...ok(Object.values(st.history).some((h) => h.action === "backup.restore"), "no restore history"));
    // another round's file: missing-only is disabled with the message
    const other = JSON.parse(text); other.round.id = "r-other";
    card = await choose(JSON.stringify(other));
    problems.push(...ok(card.includes("not the round you are working on"), "another round's file was offered for missing items"));
    // a tampered file
    const bad = JSON.parse(text); bad.data.interviews_screening["Bruns~c-1"].rating = 1;
    card = await choose(JSON.stringify(bad));
    problems.push(...ok(card.includes("This file was changed after it was saved"), "a tampered file wasn't refused"));
    return problems;
  },

  // A close left stale after clearing began: another page sees "part of the
  // round has been cleared", takes over, and puts everything back.
  async staleCloseTakenOverAndPutBack(page, url, b) {
    const problems = [];
    await page.evaluateOnNewDocument(() => { globalThis.__edRoundsTiming = { staleMs: 1500, renewMs: 600000 }; });
    await load(page, url, full()); await landAsAdmin(page);
    const before = await dumpState(page);
    await closeRound(page, { stopAt: "step6" });
    // freeze page A: clear one collection by hand as if A died mid-clear
    const st0 = await dumpState(page);
    const att = Object.keys(st0.archive)[0];
    st0.archive[att].status = "clearing";
    st0.candidates = []; st0.screening = {};
    st0.meta.lease = { ...st0.meta.lease, at: new Date(Date.now() - 10 * 60000).toISOString() };
    st0.meta.closingTab = "p-dead";
    // page B: a different tab (new page id)
    const pB = await b.newPage();
    await pB.evaluateOnNewDocument(() => { globalThis.__edRoundsTiming = { staleMs: 1500, renewMs: 600000 }; });
    await pB.goto(url, { waitUntil: "domcontentloaded" });
    await pB.evaluate((s) => { localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); sessionStorage.clear(); }, st0);
    await pB.reload({ waitUntil: "domcontentloaded" }); await pB.waitForFunction("window.__edReady === true");
    await signIn(pB, "adminpw"); await landAsAdmin(pB);
    await sleep(500);
    const fresh = await pB.$eval("#roundLine", (e) => e.textContent);
    problems.push(...ok(fresh.includes("Admin (another page) is closing the round now."), `B fresh view: ${fresh}`));
    await pB.waitForFunction(() => (document.querySelector("#roundLine") || {}).textContent.includes("part of the round has been cleared"), { timeout: 15000 });
    await pB.evaluate(() => window.IV.roundTakeover("stop"));
    await pB.waitForFunction(() => (document.querySelector("#flowTitle") || {}).textContent === "Closing stopped", { timeout: 20000 });
    const st = await dumpState(pB);
    problems.push(...ok(st.meta.roundStatus === "open" && JSON.stringify(st.candidates) === JSON.stringify(before.candidates)
      && JSON.stringify(st.screening) === JSON.stringify(before.screening), "put-back didn't restore the round"));
    problems.push(...ok(JSON.stringify(st.settings.times) === JSON.stringify(before.settings.times) && st.schedule.locked === true, "meta changed during the close"));
    problems.push(...ok(st.archive[att].status === "abandoned", "attempt not abandoned"));
    await pB.close();
    return problems;
  },
};

export async function main(only) {
  const site = await serve();
  const b = await browser();
  const log = [];
  const results = {};
  try {
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only && name !== only) continue;
      const page = await openPage(b, site.url, { log });
      log.length = 0;
      try { results[name] = await fn(page, site.url, b); }
      catch (e) { results[name] = [`threw: ${e.message}`]; }
      const errs = log.filter((l) => l.startsWith("pageerror"));
      if (errs.length) results[name] = [...(results[name] || []), ...errs];
      await page.close();
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
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} round scenarios pass`);
  process.exit(bad ? 1 : 0);
}
