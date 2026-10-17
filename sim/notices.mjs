// R5: two rooms and day chairs (H13), my panels on the Score tab (H9), copy-ready
// messages and calendar files (H8), and the applicant's confirmed time with
// confirm and withdraw (H11), through the real UI on LocalStore.
// Run: node notices.mjs [name]
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, pickMember, landAsAdmin, tab, dumpState, sleep, daysAhead } from "./drive.mjs";
import { readPanels } from "./scrape.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" }, { name: "Farr", gender: "F" }, { name: "Gupta", gender: "M" },
];
const D1 = daysAhead(30), D2 = daysAhead(31);
const TIMES = [
  { id: "t0", date: D1, start: "09:00", end: "10:00" }, { id: "t1", date: D1, start: "10:00", end: "11:00" },
  { id: "t2", date: D2, start: "09:00", end: "10:00" },
];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false },
    { id: "c-3", name: "Dr Omar Fahmy", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: Object.fromEntries(COMMITTEE.map((m) => [m.name, { t0: "ip", t1: "ip", t2: "ip" }])),
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "either" }, fahmy: { t2: "zoom" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {},
    interviewInfo: { location: "ED admin office, 2nd floor", zoomLink: "https://zoom.example/j/1", contact: "" },
    deadlines: { reply: daysAhead(20) } },
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
async function reloadAs(page, url, code) {
  await page.evaluate(() => { sessionStorage.clear(); });
  await page.goto(url, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
  await signIn(page, code);
}
async function confirm(page) {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const t = await page.$eval("#confirmMsg", (e) => e.textContent); await page.click("#confirmYes"); await sleep(300); return t;
}
const clickText = (page, scope, text) => page.evaluate((scope, text) => {
  const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === text);
  if (!b) throw new Error(`no button "${text}" in ${scope}`); b.click();
}, scope, text);
const nextDownload = (page, act) => page.evaluate((act) => new Promise((resolve) => {
  const orig = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = click; };
  URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = orig; return "blob:stub"; };
  eval(act);
}), act);
async function lockAndPublish(page) {
  await tab(page, "panels");
  await clickText(page, "#panels", "Lock the schedule"); await confirm(page);
  await clickText(page, "#panels", "Send times to applicants"); const m = await confirm(page); await sleep(300);
  if (process.env.DBG) console.log("DBG publish", m, await page.$eval("#toast", (e) => e.textContent), JSON.stringify((await dumpState(page)).schedule).slice(0, 200));
}
async function asApplicant(page, url, first, last) {
  await reloadAs(page, url, "guestpw");
  const hasForm = await page.$("#candName");
  if (!hasForm) return "";
  await page.type("#candFirst", first); await page.type("#candName", last);
  await page.click("#candGo"); await sleep(400);
  return page.$eval("#candErr", (e) => e.textContent.trim()).catch(() => "");
}
const candText = (page) => page.$eval("#candview", (e) => e.textContent.replace(/\s+/g, " "));

const scenarios = {
  // H9: locked schedule: only my panels listed; Show all; switching keeps an
  // unsaved note (it is saved first).
  async myPanelsOnly(page, url) {
    const problems = [];
    const sch = { locked: true, lockedAt: new Date().toISOString(), panels: {
      "c-1": { slot: "t0", room: 1, chair: "Abara", members: ["Abara", "Bruns", "Chen"], modality: "ip" },
      "c-2": { slot: "t1", room: 1, chair: "Abara", members: ["Abara", "Dufour", "Ekwueme"], modality: "ip" } } };
    await load(page, url, base({ schedule: sch }), "staffpw");
    await pickMember(page, "Chen"); await tab(page, "score");
    let opts = await page.$$eval("#scorePick option", (o) => o.filter((x) => x.value).map((x) => x.value));
    problems.push(...ok(opts.join() === "c-1", `my list: ${opts}`));
    await page.select("#scorePick", "c-1"); await sleep(150);
    await page.type("#note-0", "half a thought");
    await clickText(page, "#score", "Show all applicants"); await sleep(300);
    opts = await page.$$eval("#scorePick option", (o) => o.filter((x) => x.value).map((x) => x.value));
    problems.push(...ok(opts.length === 3, `all list: ${opts}`));
    const st = await dumpState(page);
    problems.push(...ok(((st.scores["Chen~c-1"] || {}).notes || {})["0"] === "half a thought", "the note typed before switching was lost"));
    await clickText(page, "#score", "Show only my interviews"); await sleep(200);
    await page.select("#scorePick", "c-1"); await sleep(150);
    const v = await page.$eval("#note-0", (e) => e.value);
    problems.push(...ok(v === "half a thought", `note after switching back: ${v}`));
    // someone on no panel: the empty line and the link
    await reloadAs(page, url, "staffpw"); await pickMember(page, "Gupta"); await tab(page, "score");
    const t = await page.$eval("#score", (e) => e.textContent);
    problems.push(...ok(t.includes("You have no interviews on the schedule.") && t.includes("Show all applicants"), "empty state missing"));
    return problems;
  },

  // H11: the applicant sees the published time and confirms; leadership sees no badge.
  async applicantConfirms(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page);
    await lockAndPublish(page);
    let st = await dumpState(page);
    problems.push(...ok(st.notices && st.notices.ashcombe && st.notices.ashcombe.location === "ED admin office, 2nd floor" && !JSON.stringify(st.notices).includes("Ashcombe"),
      `notices: ${JSON.stringify(st.notices)}`));
    const err = await asApplicant(page, url, "Rosalind", "Ashcombe");
    problems.push(...ok(!err, `sign-in: ${err}`));
    await page.waitForSelector(".noticecard", { timeout: 5000 });
    let t = await candText(page);
    problems.push(...ok(t.includes("Your interview") && t.includes("9:00 to 10:00 am") && t.includes("In person at ED admin office, 2nd floor")
      && t.includes("Please confirm by") && t.includes("Need a different time? Reply to our email."), `card: ${t.slice(0, 300)}`));
    problems.push(...ok(!(await page.$(".slotgrid")), "the time picker still shows"));
    await clickText(page, "#candview", "I'll be there"); await sleep(300);
    t = await candText(page);
    problems.push(...ok(/Thank you\. You confirmed on \w+ \d+\./.test(t), `after confirm: ${t.slice(0, 200)}`));
    st = await dumpState(page);
    problems.push(...ok(st.replies && st.replies.ashcombe.reply === "confirmed", "reply not saved"));
    await reloadAs(page, url, "adminpw"); await landAsAdmin(page); await tab(page, "panels");
    const row = await page.evaluate(() => [...document.querySelectorAll("#panels .prow")].find((r) => r.textContent.includes("Ashcombe")).textContent);
    problems.push(...ok(!/Confirmed|Withdrew|No reply/.test(row), `badge on a confirmed row: ${row}`));
    return problems;
  },

  // H11: withdraw, then Undo; leadership sees "Withdrew" and Needs attention meanwhile.
  async withdrawThenUndo(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page);
    await lockAndPublish(page);
    await asApplicant(page, url, "Ben", "Carter");
    await page.waitForSelector(".noticecard");
    await clickText(page, "#candview", "I can't come");
    await page.waitForSelector("#flowWrap:not(.hidden)");
    const ft = await page.$eval("#flowWrap", (e) => e.textContent);
    problems.push(...ok(ft.includes("We will tell the hiring team. If you only need a different time, reply to our email instead.") && ft.includes("Keep my interview"), `dialog: ${ft}`));
    await clickText(page, "#flowBtns", "Withdraw"); await sleep(300);
    let t = await candText(page);
    problems.push(...ok(t.includes("You have withdrawn. If this was a mistake, tap Undo."), `after withdraw: ${t.slice(0, 200)}`));
    let st = await dumpState(page);
    const saved = st;
    await reloadAs(page, url, "adminpw"); await landAsAdmin(page); await tab(page, "panels");
    let p = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(/Withdrew \w+ \d+/.test(p) && p.includes("has withdrawn"), "leadership doesn't see the withdrawal"));
    await asApplicant(page, url, "Ben", "Carter");
    await page.waitForSelector(".noticecard");
    await clickText(page, "#candview", "Undo"); await sleep(300);
    st = await dumpState(page);
    problems.push(...ok(st.replies.carter.reply === "" && saved.replies.carter.reply === "withdrawn", `replies: ${JSON.stringify(st.replies)}`));
    t = await candText(page);
    problems.push(...ok(t.includes("I'll be there"), "buttons not back after Undo"));
    return problems;
  },

  // H11 (review M6): booking closed shows the message (no picker), and a reply still saves.
  async bookingClosedReplySaves(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page);
    await lockAndPublish(page);
    await page.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
    await page.evaluate(() => { document.querySelector('details[data-sec="setStages"]').open = true; });
    await clickText(page, "#settings", "Close availability"); await confirm(page);
    await reloadAs(page, url, "guestpw");
    let t = await candText(page);
    problems.push(...ok(t.includes("Booking is closed."), `name step: ${t.slice(0, 200)}`));
    await page.type("#candFirst", "Ben"); await page.type("#candName", "Carter"); await page.click("#candGo"); await sleep(400);
    await page.waitForSelector(".noticecard");
    await clickText(page, "#candview", "I'll be there"); await sleep(300);
    const st = await dumpState(page);
    problems.push(...ok(st.replies && st.replies.carter && st.replies.carter.reply === "confirmed", "reply didn't save with booking closed"));
    // an applicant with no notice gets the closed message and no picker
    st.notices = {}; await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), st);
    await asApplicant(page, url, "Omar", "Fahmy");
    t = await candText(page);
    problems.push(...ok(t.includes("Booking is closed") && !(await page.$(".slotgrid")), "no-notice applicant still gets a picker"));
    return problems;
  },

  // H11: while a round is closing, booking is paused: no name step at all.
  async bookingPaused(page, url) {
    const problems = [];
    await load(page, url, base({ booking: "paused", meta: { roundStatus: "closing" } }), "guestpw");
    await sleep(300);
    const t = await candText(page);
    problems.push(...ok(t.includes("Booking is paused. Please try again later.") && !(await page.$("#candName")), `page: ${t.slice(0, 200)}`));
    return problems;
  },

  // H11: after the reply date, "No reply yet" shows for leadership only, and the
  // applicant is told the date has passed (buttons stay).
  async lateReplyLeadershipOnly(page, url) {
    const problems = [];
    const st0 = base(); st0.settings.deadlines = { reply: daysAhead(-2) };
    await load(page, url, st0, "adminpw"); await landAsAdmin(page);
    await lockAndPublish(page);
    const p = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(p.includes("No reply yet") && p.includes("the date to confirm has passed"), "no late line for leadership"));
    await asApplicant(page, url, "Rosalind", "Ashcombe");
    await page.waitForSelector(".noticecard");
    const t = await candText(page);
    problems.push(...ok(t.includes("The date to confirm has passed. Please reply to our email.") && t.includes("I'll be there") && !t.includes("No reply yet"), `applicant: ${t.slice(0, 250)}`));
    return problems;
  },

  // H8: copy email (clipboard stubbed) and the calendar files.
  async copyAndCalendar(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page); await tab(page, "panels");
    await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (t) => { window.__copied.push(t); } } }); });
    await page.evaluate(() => window.IV.copyInvite("c-1", "applicant")); await sleep(200);
    const [mail] = await page.evaluate(() => window.__copied);
    problems.push(...ok(mail && mail.startsWith("Subject: Your interview with the MGH Emergency Department") && mail.includes("Hello Dr Ashcombe,")
      && mail.includes("9:00 to 10:00 am") && mail.includes("index.html#apply"), `email: ${mail}`));
    problems.push(...ok(!/[–—]/.test(mail || ""), "a dash in the email"));
    const toastText = await page.$eval("#toast", (e) => e.textContent);
    problems.push(...ok(toastText.includes("Copied. Paste it into a new email to Dr Rosalind Ashcombe."), `toast: ${toastText}`));
    await page.evaluate(() => window.IV.copyInvite("c-1", "panel")); await sleep(200);
    const panelMail = (await page.evaluate(() => window.__copied))[1];
    problems.push(...ok(panelMail && panelMail.includes("Panel: Abara (chair),") && panelMail.includes("Use the ED password."), `panel email: ${panelMail}`));
    const ics = await nextDownload(page, "window.IV.downloadIcs('all')");
    const shown = await readPanels(page);
    problems.push(...ok((ics.match(/BEGIN:VEVENT/g) || []).length === shown.schedule.length && ics.includes("DTSTART;TZID=America/Toronto:"), "calendar file doesn't match the panels"));
    return problems;
  },

  // H13: Setup sets a time to two rooms and a day with no chair; Panels shows
  // Room 2, and two panels at once are disjoint.
  async twoRoomsAndNoChairDay(page, url) {
    const problems = [];
    const st0 = base({ availCand: { ashcombe: { t0: "ip" }, carter: { t0: "ip" }, fahmy: { t2: "ip" } } });
    await load(page, url, st0, "adminpw"); await landAsAdmin(page);
    await page.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
    await page.evaluate(() => { const d = document.querySelector('details[data-sec="setSlots"]'); d.open = true; });
    await page.evaluate(() => window.IV.setRooms("t0", 2)); await sleep(300);
    await page.evaluate((d) => window.IV.setDayChair(d, "none"), D2); await sleep(300);
    await page.evaluate(() => document.querySelector("#setupClose").click());
    await tab(page, "panels");
    const shown = await readPanels(page);
    const at0 = shown.schedule.filter((p) => p.slot === "t0");
    problems.push(...ok(at0.length === 2 && at0.some((p) => p.room === 2), `two rooms at t0: ${JSON.stringify(at0)}`));
    if (at0.length === 2) problems.push(...ok(!at0[0].members.some((m) => at0[1].members.includes(m)), "someone is in both rooms"));
    const d2 = shown.schedule.find((p) => p.slot === "t2");
    problems.push(...ok(d2 && d2.members.length >= 3, "no panel on the no-chair day"));
    const st = await dumpState(page);
    problems.push(...ok(st.settings.times.find((t) => t.id === "t0").rooms === 2 && st.settings.days[D2].chair === "none", "settings not saved"));
    const panelsText = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(/no chair/.test(panelsText), "the load line doesn't say a panel has no chair"));
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
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} notice scenarios pass`);
  process.exit(bad ? 1 : 0);
}
