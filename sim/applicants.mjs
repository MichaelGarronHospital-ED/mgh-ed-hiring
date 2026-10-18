// R4: applicants who share a surname (H14) and rename, merge, delete in the
// app (H5), through the real UI on LocalStore. Run: node applicants.mjs [name]
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, landAsAdmin, tab, dumpState, setSlot, sleep, daysAhead } from "./drive.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [
  { id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" },
  { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" },
];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false },
    { id: "c-j", name: "Dr Jane Kim", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: Object.fromEntries(COMMITTEE.map((m) => [m.name, { t0: "ip", t1: "ip" }])),
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "either" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null,
  questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] },
  ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);

async function load(page, url, state, code) {
  await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, code);
}
async function confirm(page, which = "yes") {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const t = await page.$eval("#confirmMsg", (e) => e.textContent);
  await page.click(which === "no" ? "#confirmNo" : "#confirmYes"); await sleep(300); return t;
}
const flowText = (page) => page.$eval("#flowWrap", (e) => (e.classList.contains("hidden") ? "" : e.textContent));
const flowClick = (page, label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll("#flowBtns button")].find((x) => x.textContent.trim() === label);
  if (!b) throw new Error(`no dialog button "${label}"`); b.click();
}, label);
async function applicantSignIn(page, url, state, first, last) {
  await page.evaluate((s) => { localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); sessionStorage.clear(); }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
  await signIn(page, "guestpw"); await page.waitForSelector("#candName");
  await page.type("#candFirst", first); await page.type("#candName", last);
  await page.click("#candGo"); await sleep(250);
  return page.$eval("#candErr", (e) => e.textContent.trim()).catch(() => "");
}

const scenarios = {
  // H14: a second Kim is added while answers exist under "kim". Both get their
  // own key; Admin is asked whose the answers are; they move only there.
  async secondKimPrompt(page, url) {
    const problems = [];
    await load(page, url, base({ availCand: { ashcombe: { t0: "ip" }, kim: { t0: "zoom", t1: "ip" } } }), "adminpw");
    await landAsAdmin(page);
    await page.evaluate(() => { document.querySelector("#bulkAdd").value = "Dr Min Kim";
      [...document.querySelectorAll("#screen button")].find((b) => b.textContent.trim() === "Add candidates").click(); });
    const msg = await confirm(page);
    problems.push(...ok(msg.includes("Two applicants have the last name Kim: Jane Kim and Min Kim") && msg.includes("asked for their first name too"), `dialog: ${msg}`));
    let st = await dumpState(page);
    const keys = st.candidates.filter((c) => /Kim/.test(c.name)).map((c) => c.availKey).sort();
    problems.push(...ok(keys.join() === "kim-jane,kim-min", `keys: ${keys}`));
    problems.push(...ok(st.availCand.kim && !st.availCand["kim-jane"], "the page guessed whose answers they were"));
    await tab(page, "panels");
    const att = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(att.includes("Answers saved under the last name Kim could be from Dr Jane Kim or Dr Min Kim"), "no question in Needs attention"));
    await page.evaluate(() => [...document.querySelectorAll("#panels button")].find((b) => b.textContent.trim() === "Dr Min Kim").click());
    await confirm(page);
    st = await dumpState(page);
    problems.push(...ok(!st.availCand.kim && JSON.stringify(st.availCand["kim-min"]) === JSON.stringify({ t0: "zoom", t1: "ip" }) && !st.availCand["kim-jane"],
      `after: ${JSON.stringify(st.availCand)}`));
    return problems;
  },

  // H14: each Kim books under their own key; the plain surname alone is refused
  // for them; a unique surname still books with the last name only.
  async kimsBookSeparately(page, url) {
    const problems = [];
    const st = base({ candidates: [...base().candidates, { id: "c-m", name: "Dr Min Kim", removed: false }]
      .map((c) => (c.id === "c-j" ? { ...c, availKey: "kim-jane" } : c.id === "c-m" ? { ...c, availKey: "kim-min" } : c)) });
    let err = await applicantSignIn(page, url, st, "", "Ashcombe");
    problems.push(...ok(!err, `unique surname without a first name was refused: ${err}`));
    err = await applicantSignIn(page, url, st, "", "Kim");
    problems.push(...ok(/can't find/.test(err) && /exactly as on your application/.test(err), `plain Kim: ${err}`));
    err = await applicantSignIn(page, url, st, "Jane", "Kim");
    problems.push(...ok(!err, `Jane Kim refused: ${err}`));
    await page.waitForSelector(".slotgrid");
    await setSlot(page, "CAND.set", "t1", "zoom");
    const after = await dumpState(page);
    problems.push(...ok(after.availCand["kim-jane"] && after.availCand["kim-jane"].t1 === "zoom" && !after.availCand.kim, `stored: ${JSON.stringify(after.availCand)}`));
    return problems;
  },

  // H5: rename keeps every rating and moves availability when the surname changes.
  async renameMovesAvailability(page, url) {
    const problems = [];
    await load(page, url, base({ screening: { "Bruns~c-2": { member: "Bruns", candId: "c-2", rating: 4 } } }), "adminpw");
    await landAsAdmin(page);
    await page.evaluate(() => window.IV.renameCand("c-2")); await sleep(200);
    await page.$eval("#rnIn", (e) => { e.value = ""; });
    await page.type("#rnIn", "Dr Ben Carteret"); await sleep(150);
    const msg = await page.$eval("#rnMsg", (e) => e.textContent);
    problems.push(...ok(msg.includes("Their interview times move with them"), `preview: ${msg}`));
    await flowClick(page, "Rename"); await sleep(400);
    const st = await dumpState(page);
    const c = st.candidates.find((x) => x.id === "c-2");
    problems.push(...ok(c.name === "Dr Ben Carteret", "not renamed"));
    problems.push(...ok(st.screening["Bruns~c-2"].rating === 4, "rating lost"));
    problems.push(...ok(st.availCand.carteret && st.availCand.carteret.t1 === "either" && !st.availCand.carter, `availability: ${JSON.stringify(st.availCand)}`));
    problems.push(...ok(Object.values(st.history).some((h) => h.action === "roster.rename" && !h.text.includes("Carter")), "history missing or has a name"));
    return problems;
  },

  // H5: the merge preview's counts match what actually moves.
  async mergePreviewMatches(page, url) {
    const problems = [];
    const st0 = base({
      candidates: [{ id: "c-old", name: "Dr Rosalind Ashcombe", removed: true }, { id: "c-new", name: "Dr Rosalind Ashcomb", removed: false },
        { id: "c-2", name: "Dr Ben Carter", removed: false }],
      screening: { "Abara~c-old": { member: "Abara", candId: "c-old", rating: 4 }, "Bruns~c-old": { member: "Bruns", candId: "c-old", flag: true, reason: "gap" },
        "Chen~c-old": { member: "Chen", candId: "c-old", rating: 5 }, "Chen~c-new": { member: "Chen", candId: "c-new", rating: 2 } },
      scores: { "Abara~c-old": { member: "Abara", candId: "c-old", overall: 4.1 } },
      availCand: { ashcombe: { t0: "ip" } },
      settings: { ...base().settings, panelOverrides: { "c-old": { slot: "t0", members: ["Abara", "Bruns", "Chen"], modality: "ip" } } },
    });
    await load(page, url, st0, "adminpw"); await landAsAdmin(page);
    const box = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(box.includes("Move these to Dr Rosalind Ashcomb") && !box.includes("migrate-candidate"), "the hidden-input box still points at a terminal"));
    await page.evaluate(() => window.IV.mergeCand("c-old", "c-new")); await sleep(200);
    const pv = await flowText(page);
    problems.push(...ok(pv.includes("1 rating, 1 concern, 1 score, their interview times and their hand-made panel")
      && pv.includes("already have input on 'Dr Rosalind Ashcomb': Chen"), `preview: ${pv}`));
    await flowClick(page, "Merge without a backup"); await sleep(400);
    const st = await dumpState(page);
    problems.push(...ok(st.screening["Abara~c-new"].rating === 4 && st.screening["Bruns~c-new"].flag && st.scores["Abara~c-new"].overall === 4.1, "moved input missing"));
    problems.push(...ok(st.screening["Chen~c-new"].rating === 2 && st.screening["Chen~c-old"].rating === 5, "Chen's input was overwritten or lost"));
    problems.push(...ok(st.availCand.ashcomb && !st.availCand.ashcombe, `availability: ${JSON.stringify(st.availCand)}`));
    problems.push(...ok(st.settings.panelOverrides["c-new"] && !st.settings.panelOverrides["c-old"], "panel not moved"));
    problems.push(...ok(st.candidates.find((c) => c.id === "c-old").mergedInto === "c-new", "emptied entry not marked"));
    return problems;
  },

  // H5: delete needs the typed surname and leaves nothing behind.
  async deleteLeavesNothing(page, url) {
    const problems = [];
    const st0 = base({
      candidates: [...base().candidates, { id: "c-x", name: "Dr Omar Fahmy", removed: true }],
      screening: { "Abara~c-x": { member: "Abara", candId: "c-x", rating: 3 } }, scores: { "Bruns~c-x": { overall: 3.5 } },
      availCand: { ...base().availCand, fahmy: { t0: "ip" } }, offers: { "c-x": { status: "declined" } },
    });
    await load(page, url, st0, "adminpw"); await landAsAdmin(page);
    await page.evaluate(() => window.IV.deleteCand("c-x")); await sleep(200);
    const text = await flowText(page);
    problems.push(...ok(text.includes("1 screening answer, 1 score, their interview times and their offer record"), `dialog: ${text}`));
    const dis0 = await page.$eval("#delGo", (b) => b.disabled);
    await page.type("#delIn", "Fahm");
    const dis1 = await page.$eval("#delGo", (b) => b.disabled);
    await page.type("#delIn", "y");
    const dis2 = await page.$eval("#delGo", (b) => b.disabled);
    problems.push(...ok(dis0 && dis1 && !dis2, `button disabled states: ${dis0} ${dis1} ${dis2}`));
    await flowClick(page, "Delete permanently"); await sleep(400);
    const st = await dumpState(page);
    const left = JSON.stringify({ ...st, history: {} });
    problems.push(...ok(!left.includes("c-x") && !left.includes("Fahmy") && !st.availCand.fahmy, "something of the deleted applicant is left"));
    problems.push(...ok(Object.values(st.history).some((h) => h.action === "roster.delete" && !h.text.includes("Fahmy")), "history missing or has a name"));
    return problems;
  },

  // H14 (review m4): four roster edits in quick succession: every allowed-list
  // write goes out at once and the fourth applicant can book right away.
  async fourRosterEdits(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page);
    for (const nm of ["Dr Ivy Trelawney", "Dr Sam Ellery", "Dr Tomas Weir", "Dr Grace Lindqvist"]) {
      await page.evaluate((nm) => { document.querySelector("#bulkAdd").value = nm;
        [...document.querySelectorAll("#screen button")].find((b) => b.textContent.trim() === "Add candidates").click(); }, nm);
      await sleep(250);
    }
    // the list is written within a couple of seconds (gathered, at most 2 s): poll for it
    let st = await dumpState(page);
    for (let i = 0; i < 20 && !(st.allowedNames && st.allowedNames.includes("lindqvist") && st.allowedNames.includes("trelawney")); i++) { await sleep(250); st = await dumpState(page); }
    problems.push(...ok(st.allowedNames && st.allowedNames.includes("lindqvist") && st.allowedNames.includes("trelawney"), `allowed: ${st.allowedNames}`));
    const line = await page.$eval("#updateLine", (e) => (e.classList.contains("hidden") ? "" : e.textContent));
    problems.push(...ok(!line, `a held-back message appeared for normal edits: ${line}`));
    const err = await applicantSignIn(page, url, st, "Grace", "Lindqvist");
    problems.push(...ok(!err, `the fourth applicant can't book: ${err}`));
    return problems;
  },

  // H14 (review M4): an older open tab keeps rewriting the allowed list with the
  // old rule. The newer tab writes at most 3 times in 10 minutes, then holds and
  // says to reload the other tab.
  async twoTabsDifferentRules(page, url, b) {
    const problems = [];
    const st0 = base({ candidates: [...base().candidates, { id: "c-m", name: "Dr Min Kim", removed: false }]
      .map((c) => (c.id === "c-j" ? { ...c, availKey: "kim-jane" } : c.id === "c-m" ? { ...c, availKey: "kim-min" } : c)) });
    await load(page, url, st0, "adminpw"); await landAsAdmin(page);
    await page.evaluate(() => {
      window.__allowedWrites = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "ed_interviews_v1") { try { if ((JSON.parse(v).allowedNames || []).includes("kim-jane")) window.__allowedWrites++; } catch {} }
        return set.call(this, k, v);
      };
    });
    const old = await b.newPage();
    await old.goto(url, { waitUntil: "domcontentloaded" });
    await old.evaluate(() => {   // the "older page": plain surname keys only
      const ch = new BroadcastChannel("ed_interviews");
      const fight = () => {
        const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
        const want = [...new Set(s.candidates.filter((c) => !c.removed).map((c) => c.name.trim().split(/\s+/).pop().toLowerCase()))].sort();
        if (JSON.stringify(s.allowedNames) === JSON.stringify(want)) return;
        s.allowedNames = want; localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); ch.postMessage(1);
      };
      // answer when the newer tab's write is visible here (the storage event), not
      // on its message, which can arrive first; no timers (this tab is in the background)
      window.addEventListener("storage", (e) => { if (e.key === "ed_interviews_v1") fight(); });
      fight();
    });
    // this tab gathers changes for 250 ms; keep it in front so its timers aren't slowed
    await page.bringToFront();
    await sleep(6000);
    const writes = await page.evaluate(() => window.__allowedWrites);
    problems.push(...ok(writes <= 3, `the newer tab wrote ${writes} times`));
    const line = await page.$eval("#updateLine", (e) => e.textContent);
    problems.push(...ok(line.includes("Another open Physician Hiring tab is using an older version"), `message: ${line}`));
    await old.close();
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
      try { results[name] = await fn(page, site.url, b); }
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
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} applicant scenarios pass`);
  process.exit(bad ? 1 : 0);
}
