// Targeted scenarios around the scheduling pipeline: the applicant flow, time
// edits after people have answered, manual panels, removals and chair changes.
// Each scenario is a named check that returns a list of problems.
import { serve, browser, openPage, signIn, pickMember, changeMember, tab, setSlot, dumpState, seedState, sleep } from "./drive.mjs";
import { readPanels } from "./scrape.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [
  { id: "t0", date: "2026-10-01", start: "09:00", end: "10:00" },
  { id: "t1", date: "2026-10-01", start: "10:00", end: "11:00" },
  { id: "t2", date: "2026-10-02", start: "09:00", end: "10:00" },
];
const CANDS = [
  { id: "c-1", name: "Dr Rosalind Ashcombe", removed: false },
  { id: "c-2", name: "Dr Ben Carter", removed: false },
  { id: "c-3", name: "Dr Omar Fahmy", removed: false },
];
const base = (over = {}) => ({
  candidates: CANDS.map((c) => ({ ...c })),
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: {
    Abara: { t0: "ip", t1: "ip", t2: "ip" }, Bruns: { t0: "either", t1: "ip", t2: "zoom" },
    Chen: { t0: "ip", t1: "either", t2: "ip" }, Dufour: { t1: "either", t2: "ip" },
    Ekwueme: { t0: "zoom", t2: "either" },
  },
  availCand: { ashcombe: { t0: "ip", t1: "ip" }, carter: { t1: "either" }, fahmy: { t2: "ip" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null, ...over,
});

const ok = (cond, msg) => (cond ? [] : [msg]);

async function asAdmin(page, url, state, { member = "Abara" } = {}) {
  await page.evaluate((s) => {
    localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
    sessionStorage.setItem("ed_iv_code", "adminpw");
    sessionStorage.removeItem("ed_iv_cand"); sessionStorage.removeItem("ed_iv_cand_disp");
  }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await pickMember(page, member);
}

async function asApplicant(page, url, state) {
  await page.evaluate((s) => {
    localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
    sessionStorage.clear();
  }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, "guest2026");
  await page.waitForSelector("#candview:not(.hidden)");
}

async function enterSurname(page, surname) {
  await page.waitForSelector("#candName", { timeout: 5000 });
  await page.$eval("#candName", (el) => { el.value = ""; });
  await page.type("#candName", surname);
  await page.click("#candGo");
  await sleep(150);
  const err = await page.$eval("#candErr", (el) => el.textContent.trim()).catch(() => "");
  return err;
}

// which segment buttons are lit for the applicant, per time id
async function litSlots(page) {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll('button[aria-pressed="true"]').forEach((b) => {
      const m = (b.getAttribute("onclick") || "").match(/CAND\.set\('([^']+)','([^']+)'\)/);
      if (m) out[m[1]] = m[2];
    });
    return out;
  });
}

async function confirm(page, which = "yes") {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const text = await page.$eval("#confirmMsg", (el) => el.textContent);
  await page.click(which === "alt" ? "#confirmAlt" : which === "no" ? "#confirmNo" : "#confirmYes");
  await sleep(200);
  return text;
}

// open Setup → Interview times, edit one time, answer the "already answered"
// dialog ("yes" = ask again, "alt" = keep answers)
async function editTime(page, id, { date, start, end }, answer) {
  await page.evaluate(() => document.querySelector("#setupBtn").click());
  await page.evaluate(() => { const d = document.querySelector('details[data-sec="setSlots"]'); if (d) d.open = true; });
  await sleep(100);
  await page.evaluate((id) => {
    const b = [...document.querySelectorAll("#settings button")]
      .find((x) => (x.getAttribute("onclick") || "") === `IV.tEdit('${id}')`);
    if (!b) throw new Error(`no edit button for ${id}`);
    b.click();
  }, id);
  await page.waitForSelector("#tEdStart");
  await page.evaluate((v) => { if (v.date) window.IV.tEditField("date", v.date);
    if (v.start) window.IV.tEditField("start", v.start);
    if (v.end) window.IV.tEditField("end", v.end); }, { date, start, end });
  await page.evaluate(() => {
    [...document.querySelectorAll("#settings button")]
      .find((x) => (x.getAttribute("onclick") || "").includes("IV.tSave")).click();
  });
  await confirm(page, answer);
  await sleep(300);
  await page.evaluate(() => document.querySelector("#setupClose").click());
}

// ---------------------------------------------------------------- scenarios
const scenarios = {
  // A returning applicant must still see — and still HAVE — what they picked.
  async returningApplicant(page, url) {
    const problems = [];
    await asApplicant(page, url, base());
    let err = await enterSurname(page, "Ashcombe");
    problems.push(...ok(!err, `known applicant refused: ${err}`));
    await page.waitForSelector(".slotgrid");
    await setSlot(page, "CAND.set", "t2", "zoom");          // add a third time
    await page.evaluate(() => window.CAND.rename());         // "not you? change name"
    err = await enterSurname(page, "Ashcombe");              // ...and come straight back
    problems.push(...ok(!err, `returning applicant refused: ${err}`));
    await page.waitForSelector(".slotgrid");
    const lit = await litSlots(page);
    problems.push(...ok(lit.t0 === "ip" && lit.t1 === "ip" && lit.t2 === "zoom",
      `returning applicant sees ${JSON.stringify(lit)} instead of all three picks`));
    const st = await dumpState(page);
    problems.push(...ok(JSON.stringify(st.availCand.ashcombe) === JSON.stringify({ t0: "ip", t1: "ip", t2: "zoom" }),
      `stored availability after the return visit is ${JSON.stringify(st.availCand.ashcombe)}`));
    return problems;
  },

  // Names the roster doesn't hold must be refused, including a removed applicant.
  async unknownSurname(page, url) {
    const problems = [];
    const st = base();
    st.candidates[2].removed = true;                         // Fahmy taken off the list
    await asApplicant(page, url, st);
    let err = await enterSurname(page, "Nobodyhere");
    problems.push(...ok(/can't find/i.test(err), `unknown surname was not refused (got ${JSON.stringify(err)})`));
    err = await enterSurname(page, "Fahmy");
    problems.push(...ok(/can't find/i.test(err), `removed applicant was still let in (got ${JSON.stringify(err)})`));
    return problems;
  },

  // Two applicants with the same surname share one document (known limit) —
  // pin what actually happens so a change is deliberate.
  // KNOWN LIMIT, pinned so a change is deliberate: availability is keyed by
  // surname, so two applicants called Carter write to ONE record and each sees
  // the other's answers. If this scenario ever fails, someone has given
  // applicants their own key — that is an improvement: update ../CLAUDE.md and
  // delete this instead of making it pass again.
  async sharedSurname(page, url) {
    const st = base();
    st.candidates.push({ id: "c-4", name: "Dr Jonah Carter", removed: false });
    await asApplicant(page, url, st);
    await enterSurname(page, "Carter");                 // which Carter? nothing can tell
    await page.waitForSelector(".slotgrid");
    const problems = ok((await litSlots(page)).t1 === "either",
      "the second Carter no longer inherits the first one's answers");
    await setSlot(page, "CAND.set", "t0", "zoom");
    const after = await dumpState(page);
    const shared = Object.entries(after.availCand.carter || {}).sort().map((e) => e.join(":")).join(",");
    problems.push(...ok(shared === "t0:zoom,t1:either",
      `the two Carters no longer share one record (got ${shared})`));
    return problems;
  },

  // Removing a time must take its answers and any panel with it.
  async removeAnsweredTime(page, url) {
    const problems = [];
    await asAdmin(page, url, base());
    await tab(page, "panels");
    const before = await readPanels(page);
    await page.evaluate(() => document.querySelector("#setupBtn").click());
    await page.evaluate(() => { const d = document.querySelector('details[data-sec="setSlots"]'); if (d) d.open = true; });
    await sleep(100);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#settings button")]
        .find((x) => (x.getAttribute("onclick") || "").includes("IV.tRemove(['t1']"));
      if (!b) throw new Error("no remove button for t1");
      b.click();
    });
    const msg = await confirm(page, "yes");
    problems.push(...ok(/already answered/.test(msg), `remove dialog didn't mention existing answers: ${JSON.stringify(msg)}`));
    problems.push(...ok(/Scheduled then/.test(msg), `remove dialog didn't mention the booked panel: ${JSON.stringify(msg)}`));
    await page.evaluate(() => document.querySelector("#setupClose").click());
    await tab(page, "panels");
    const after = await readPanels(page);
    problems.push(...ok(!after.schedule.some((p) => p.slot === "t1"), "a panel is still booked at the removed time"));
    const st = await dumpState(page);
    problems.push(...ok(!(st.settings.times || []).some((t) => t.id === "t1"), "the time was not removed"));
    problems.push(...ok(before.schedule.length >= after.schedule.length, "removing a time increased the schedule"));
    return problems;
  },

  // A manual panel is the only way to double-book a time, or to seat someone
  // who never said they were free. Both must be surfaced.
  async manualPanelWarnings(page, url) {
    const problems = [];
    const st = base();
    // Ashcombe and Carter both put at t1 by hand; Ekwueme never said he can do t1
    st.settings.panelOverrides = {
      "c-1": { slot: "t1", members: ["Abara", "Bruns", "Ekwueme"], modality: "ip" },
      "c-2": { slot: "t1", members: ["Abara", "Bruns", "Chen"], modality: "ip" },
    };
    await asAdmin(page, url, st);
    await tab(page, "panels");
    const shown = await readPanels(page);
    problems.push(...ok(shown.doubleBooked.length === 1, `double booking not reported (${shown.doubleBooked.length} notices)`));
    const ash = shown.schedule.find((p) => p.name.includes("Ashcombe"));
    problems.push(...ok(!!ash && ash.manual, "the manual panel is not marked manual"));
    problems.push(...ok(!!ash && ash.badges.some((b) => /Ekwueme/.test(b) && /hasn't said/.test(b)),
      `no warning that Ekwueme isn't available then: ${JSON.stringify(ash && ash.badges)}`));
    return problems;
  },

  // A manual panel whose time is later removed must not vanish silently.
  async manualPanelLosesTime(page, url) {
    const st = base();
    st.settings.panelOverrides = { "c-1": { slot: "t9", members: ["Abara", "Bruns", "Chen"], modality: "ip" } };
    await asAdmin(page, url, st);
    await tab(page, "panels");
    const shown = await readPanels(page);
    return ok(shown.lostTime.length === 1, `manual panel at a removed time not reported (${JSON.stringify(shown.lostTime)})`);
  },

  // Someone taken off the interview list must not stay on the schedule.
  async removedCandidateLeavesSchedule(page, url) {
    const problems = [];
    await asAdmin(page, url, base());
    await tab(page, "panels");
    const before = await readPanels(page);
    problems.push(...ok(before.schedule.some((p) => p.name.includes("Ashcombe")), "Ashcombe wasn't scheduled to begin with"));
    await tab(page, "screen");
    await page.evaluate(() => { const d = document.querySelector('details[data-sec="collation"]'); if (d) d.open = true; });
    await sleep(80);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("onclick") || "") === "IV.removeCand('c-1',true)");
      if (!b) throw new Error("no remove button for c-1");
      b.click();
    });
    await confirm(page, "yes");
    await tab(page, "panels");
    const after = await readPanels(page);
    problems.push(...ok(!after.schedule.some((p) => p.name.includes("Ashcombe")), "a removed applicant is still on the schedule"));
    problems.push(...ok(!after.unschedulable.includes("c-1"), "a removed applicant is listed as unschedulable"));
    return problems;
  },

  // Two flags take someone off the list — including off the schedule.
  async flaggedOutOfSchedule(page, url) {
    const st = base();
    st.screening = { "Bruns~c-1": { flag: true }, "Chen~c-1": { flag: true } };
    await asAdmin(page, url, st);
    await tab(page, "panels");
    const shown = await readPanels(page);
    return ok(!shown.schedule.some((p) => p.name.includes("Ashcombe")) && !shown.unschedulable.includes("c-1"),
      "an applicant with two flags is still being scheduled");
  },

  // Changing the chair must rebuild every panel around the new one.
  async chairChange(page, url) {
    const problems = [];
    const st = base();
    st.settings.panelOverrides = { "c-1": { slot: "t1", members: ["Abara", "Bruns", "Chen"], modality: "ip" } };
    await asAdmin(page, url, st);
    await page.evaluate(() => document.querySelector("#setupBtn").click());
    await page.evaluate(() => { const d = document.querySelector('details[data-sec="setChair"]'); if (d) d.open = true; });
    await sleep(80);
    await page.select("#settings select", "Chen");
    await sleep(300);
    await page.evaluate(() => document.querySelector("#setupClose").click());
    await tab(page, "panels");
    const shown = await readPanels(page);
    problems.push(...ok(shown.schedule.every((p) => p.members.includes("Chen")),
      `not every panel has the new chair: ${JSON.stringify(shown.schedule.map((p) => p.members))}`));
    problems.push(...ok(shown.schedule.every((p) => p.members.length >= 3 && p.members.length <= 5), "a panel is the wrong size after the chair change"));
    const st2 = await dumpState(page);
    problems.push(...ok((st2.settings.panelOverrides["c-1"].members || []).includes("Chen"),
      "the saved manual panel wasn't moved to the new chair"));
    return problems;
  },

  // Editing a time people already answered for: "keep answers" moves them with
  // the time; "ask again" clears them and asks for a fresh answer.
  async editAnsweredTimeKeep(page, url) {
    const problems = [];
    await asAdmin(page, url, base());
    await editTime(page, "t1", { start: "10:15", end: "11:15" }, "alt");   // keep answers
    const st = await dumpState(page);
    const t1 = (st.settings.times || []).find((t) => t.id === "t1");
    problems.push(...ok(!!t1 && t1.start === "10:15", `the time didn't change: ${JSON.stringify(t1)}`));
    problems.push(...ok(st.availCand.carter && st.availCand.carter.t1 === "either", "the applicant's answer was dropped"));
    problems.push(...ok(st.availIv.Abara.t1 === "ip", "an interviewer's answer was dropped"));
    await tab(page, "panels");
    const shown = await readPanels(page);
    problems.push(...ok(shown.schedule.some((p) => p.name.includes("Carter")), "Carter is no longer scheduled after a kept edit"));
    return problems;
  },
  async editAnsweredTimeReask(page, url) {
    const problems = [];
    await asAdmin(page, url, base());
    await editTime(page, "t1", { start: "14:00", end: "15:00" }, "yes");   // ask again
    const st = await dumpState(page);
    problems.push(...ok(!(st.settings.times || []).some((t) => t.id === "t1"), "the re-asked time kept its old id"));
    problems.push(...ok(!!(st.settings.times || []).find((t) => t.start === "14:00"), "the new time wasn't saved"));
    await tab(page, "panels");
    const shown = await readPanels(page);
    const newId = (st.settings.times || []).find((t) => t.start === "14:00").id;
    problems.push(...ok(!shown.schedule.some((p) => p.slot === newId),
      "someone is still booked at a time everyone was asked to re-answer"));
    return problems;
  },

  // The "needs attention" lines and the load breakdown are prose, and prose is
  // what overflows a phone. Check the tab that carries them at 390px.
  async panelsTabOnAPhone(page, url) {
    const problems = [];
    const st = base();
    // one of each: an applicant who never answered, one whose times can't carry
    // a panel, and one whose only time is taken
    st.candidates.push({ id: "c-4", name: "Dr Marcus Bodine", removed: false });
    st.availCand = { ashcombe: { t0: "ip", t1: "ip" }, carter: { t1: "either" },
                     fahmy: { t0: "ip" }, bodine: {} };
    st.availIv.Dufour = { t1: "either" };                 // t2 now has nobody but Chen/Ekwueme
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    try {
      await asAdmin(page, url, st);
      await tab(page, "panels");
      await page.evaluate(() => { const d = document.querySelector('details[data-sec="panelload"]'); if (d) d.open = true; });
      await sleep(150);
      const m = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth, win: window.innerWidth,
        wide: [...document.querySelectorAll("#panels *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .map((el) => el.className || el.tagName).slice(0, 5),
        attention: (document.querySelector("#panels .card") || {}).textContent || "",
      }));
      problems.push(...ok(m.scroll <= m.win + 1, `the Panels tab scrolls sideways on a phone (${m.scroll} > ${m.win})`));
      problems.push(...ok(!m.wide.length, `content runs off the right edge: ${m.wide.join(", ")}`));
    } finally {
      await page.setViewport({ width: 1280, height: 900, isMobile: false });
    }
    return problems;
  },

  // The CSV the coordinator sends out must match what is on screen.
  async exportMatchesScreen(page, url) {
    const problems = [];
    await asAdmin(page, url, base());
    await tab(page, "panels");
    const shown = await readPanels(page);
    const csv = await page.evaluate(() => new Promise((resolve) => {
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = orig; return "blob:stub"; };
      window.IV.exportSchedule();
    }));
    const lines = csv.trim().split(/\r?\n/).slice(1);
    problems.push(...ok(lines.length === shown.schedule.length + shown.unschedulable.length,
      `CSV has ${lines.length} rows for ${shown.schedule.length} panels + ${shown.unschedulable.length} unscheduled`));
    for (const p of shown.schedule) {
      const row = lines.find((l) => l.includes(p.name));
      problems.push(...ok(!!row && p.members.every((m) => row.includes(m)),
        `CSV row for ${p.name} doesn't match the panel on screen: ${row}`));
    }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await main(process.argv[2]);
  let bad = 0;
  for (const [name, problems] of Object.entries(results)) {
    if (!problems.length) { console.log(`PASS  ${name}`); continue; }
    bad++;
    console.log(`FAIL  ${name}`);
    problems.forEach((p) => console.log(`        - ${p}`));
  }
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} scenarios pass`);
  process.exit(bad ? 1 : 0);
}
