// End-to-end simulation of one hiring round, driven through the real UI:
// admin adds applicants -> committee sends availability -> applicants submit
// their own availability through the applicant link -> admin builds panels.
//
// Every applicant goes through the real applicant flow (surname check included).
import { serve, browser, openPage, signIn, pickMember, changeMember, tab, setSlot, dumpState, sleep } from "./drive.mjs";
import { readPanels, readLoad } from "./scrape.mjs";
import { checkSchedule, activeCandidates, roster } from "./check.mjs";

const COMMITTEE = [
  { name: "Vojdani", gender: "M" }, { name: "Rosenstein", gender: "M" }, { name: "Yang", gender: "M" },
  { name: "Jha", gender: "M" }, { name: "Marrocco", gender: "F" }, { name: "Balachandran", gender: "M" },
  { name: "Mohindra", gender: "F" }, { name: "Klaiman", gender: "F" }, { name: "Porfiris", gender: "M" },
  { name: "Hayre", gender: "M" }, { name: "Reynolds", gender: "F" }, { name: "Bahar", gender: "M" },
  { name: "Losier", gender: "M" },
];

// invented applicants only — never a real name in the repo
const APPLICANTS = [
  "Dr Rosalind Ashcombe", "Dr Ben Carter", "Dr Priya Nandakumar", "Dr Tomas Weir",
  "Dr Nadia Okonjo", "Dr Sam Ellery", "Dr Grace Lindqvist", "Dr Omar Fahmy",
  "Dr Ivy Trelawney", "Dr Marcus Bodine",
];

// who can do what: time id -> the format they can do it in.
const IV_AVAIL = {
  Vojdani:      { 0: "ip", 1: "ip", 2: "ip", 3: "either", 4: "ip", 5: "ip", 7: "zoom", 8: "zoom" },
  Rosenstein:   { 0: "ip", 1: "ip", 4: "either", 5: "ip", 7: "zoom" },
  Yang:         { 1: "either", 2: "either", 3: "either", 5: "zoom", 8: "zoom" },
  Jha:          { 0: "zoom", 2: "ip", 4: "ip", 6: "ip" },
  Marrocco:     { 0: "ip", 1: "either", 3: "ip", 5: "either", 7: "zoom" },
  Balachandran: { 2: "ip", 3: "ip", 4: "either", 8: "zoom" },
  Mohindra:     { 1: "zoom", 2: "either", 4: "ip", 7: "zoom", 8: "either" },
  Klaiman:      { 0: "either", 2: "ip", 5: "ip", 8: "zoom" },
  Porfiris:     { 1: "ip", 3: "either", 4: "zoom", 6: "ip" },
  Hayre:        { 0: "ip", 3: "zoom", 5: "either" },
  Reynolds:     { 3: "either", 4: "ip", 5: "zoom", 7: "either" },
  Bahar:        { 2: "zoom", 4: "either", 6: "zoom", 9: "ip" },
  Losier:       { 1: "ip", 2: "either", 5: "ip", 8: "ip" },
};

// what each applicant says (by surname key), incl. two awkward cases:
//  - Bodine answers nothing at all
//  - Fahmy is free only at slot 9, where no balanced panel can form
const CAND_AVAIL = {
  ashcombe:   { 0: "ip", 2: "ip", 5: "either" },
  carter:     { 1: "either", 4: "zoom" },
  nandakumar: { 2: "zoom", 3: "ip", 8: "either" },
  weir:       { 0: "either", 1: "ip" },
  okonjo:     { 4: "ip", 5: "ip", 7: "zoom" },
  ellery:     { 3: "either" },
  lindqvist:  { 2: "either", 5: "zoom", 8: "zoom" },
  fahmy:      { 9: "ip" },
  trelawney:  { 0: "zoom", 1: "zoom", 4: "either" },
  bodine:     {},
};

const surname = (n) => n.trim().split(/\s+/).pop().toLowerCase();

async function addApplicants(page, names) {
  await tab(page, "screen");
  await page.evaluate(() => { const d = document.querySelector('details[data-sec="adder"]'); if (d) d.open = true; });
  await page.waitForSelector("#bulkAdd");
  await page.$eval("#bulkAdd", (el, v) => { el.value = v; }, names.join("\n"));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("onclick") || "").includes("IV.addCands"));
    b.click();
  });
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem("ed_interviews_v1") || "{}").candidates?.length >= n,
    { timeout: 10000 }, names.length);
}

async function interviewerAvailability(page, avail) {
  for (const [name, map] of Object.entries(avail)) {
    await changeMember(page, name);
    await tab(page, "availability");
    for (const [slot, mod] of Object.entries(map)) await setSlot(page, "IV.avail", slot, mod);
  }
}

async function applicantsSubmit(page, availByKey, names) {
  // leave the committee app the way a person would, then come back on the
  // applicant link
  await page.evaluate(() => document.querySelector("#logout").click());
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, "guest2026");
  await page.waitForSelector("#candview:not(.hidden)");
  for (const full of names) {
    const key = surname(full);
    await page.waitForSelector("#candName", { timeout: 5000 });
    await page.$eval("#candName", (el) => { el.value = ""; });
    await page.type("#candName", full.split(/\s+/).pop());   // they type their last name
    await page.click("#candGo");
    await sleep(120);
    const err = await page.$eval("#candErr", (el) => el.textContent.trim()).catch(() => "");
    if (err) throw new Error(`applicant ${full} was refused at the name check: ${err}`);
    await page.waitForSelector(".slotgrid", { timeout: 5000 });
    for (const [slot, mod] of Object.entries(availByKey[key] || {})) await setSlot(page, "CAND.set", slot, mod);
    await page.evaluate(() => window.CAND.rename());
    await sleep(60);
  }
}

async function backAsAdmin(page) {
  await page.evaluate(() => window.CAND.logout());
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, "adminpw");
  await pickMember(page, "Vojdani");
}

export async function run({ keepOpen = false } = {}) {
  const log = [];
  const site = await serve();
  const b = await browser();
  const page = await openPage(b, site.url, { log });
  const out = { log, problems: [], notes: [] };
  try {
    await signIn(page, "adminpw");
    await pickMember(page, "Vojdani");
    await addApplicants(page, APPLICANTS);
    await interviewerAvailability(page, IV_AVAIL);
    await applicantsSubmit(page, CAND_AVAIL, APPLICANTS);
    await backAsAdmin(page);

    // --- what the committee sees -------------------------------------------
    await tab(page, "availability");
    const dash = await page.evaluate(() => {
      const sec = [...document.querySelectorAll("details.section")].find((d) => d.dataset.sec === "availdash");
      return sec ? sec.textContent.replace(/\s+/g, " ").trim() : null;
    });
    out.availDash = dash;

    await tab(page, "panels");
    const shown = await readPanels(page);
    const slotIds = await page.evaluate(async () => {
      const { effectiveSlots } = await import("./js/slots.js");
      const { SLOTS } = await import("./js/config.js");
      const st = JSON.parse(localStorage.getItem("ed_interviews_v1") || "{}");
      return effectiveSlots(st.settings || {}, SLOTS).map((t) => t.id);
    });
    out.shown = shown;
    out.load = await readLoad(page);
    const state = await dumpState(page);
    out.state = state;

    const committee = roster(state, COMMITTEE);
    const chair = (state.settings && state.settings.chair) || "Vojdani";
    const res = checkSchedule(state, {
      committee, chair,
      schedule: shown.schedule,
      unschedulable: shown.unschedulable,
      understaffed: shown.understaffed,
      manualIds: new Set(shown.schedule.filter((p) => p.manual).map((p) => p.cand)),
      slotIds,
    });
    out.problems.push(...res.problems);
    out.summary = { scheduled: res.scheduled, active: activeCandidates(state, committee).length,
                    unschedulable: shown.unschedulable.length, understaffed: shown.understaffed.length };

    // availability actually stored for each applicant, under the key the app writes
    out.candAvail = state.availCand;
    if (keepOpen) return { ...out, page, b, site };
  } finally {
    if (!keepOpen) { await b.close(); site.close(); }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run();
  console.log("availability dashboard:", r.availDash);
  console.log("\nstored applicant availability:", JSON.stringify(r.candAvail));
  console.log("\nschedule:");
  r.shown.schedule.forEach((p) => console.log(`  ${p.name.padEnd(22)} ${p.slotLabel.padEnd(34)} ${p.modality}  ${p.members.join(", ")}`));
  console.log("unschedulable:", r.shown.unschedulable, "understaffed:", r.shown.understaffed);
  console.log("load:", JSON.stringify(r.load));
  console.log("summary:", r.summary);
  console.log("\nbrowser log:", r.log.length ? r.log : "(clean)");
  console.log(r.problems.length ? `\nPROBLEMS:\n - ${r.problems.join("\n - ")}` : "\nno invariant violations");
  process.exit(r.problems.length ? 1 : 0);
}
