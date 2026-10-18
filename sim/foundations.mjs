// R1 foundations, through the real UI on LocalStore: members keyed by id, the
// questions document (and the copy from the old locked file), change history
// with undo, the backup file from a fresh read, log out clearing this browser's
// copies, and the reload notice. Run: node foundations.mjs [name]
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, pickMember, landAsAdmin, tab, dumpState, sleep, daysAhead } from "./drive.mjs";

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { id: "m-b1", name: "Bruns-Lee", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [
  { id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" },
  { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" },
];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: { Abara: { t0: "ip", t1: "ip" }, "m-b1": { t0: "ip", t1: "ip" }, Chen: { t0: "ip", t1: "ip" }, Dufour: { t1: "ip" }, Ekwueme: { t0: "ip" } },
  availCand: { ashcombe: { t0: "ip" }, carter: { t1: "ip" } },
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null, ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);

async function load(page, url, state, code) {
  await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, code);
}
async function confirmYes(page) {
  await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 5000 });
  const text = await page.$eval("#confirmMsg", (el) => el.textContent);
  await page.click("#confirmYes"); await sleep(250);
  return text;
}
// capture the next downloaded file's text
const nextDownload = (page, act) => page.evaluate((act) => new Promise((resolve) => {
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => resolve(new TextDecoder("utf-8").decode(b))); URL.createObjectURL = orig; return "blob:stub"; };
  eval(act);
}), act);
async function openSetupCard(page, sec) {
  await page.evaluate(() => { if (document.querySelector("#setupModal").classList.contains("hidden")) document.querySelector("#setupBtn").click(); });
  await sleep(100);
  await page.evaluate((sec) => { const d = document.querySelector(`details[data-sec="${sec}"]`); d.open = true; d.dispatchEvent(new Event("toggle")); }, sec);
  await sleep(300);
}

const scenarios = {
  // review: the applicant's name form is never redrawn under them (a redraw
  // wiped what they had typed, or what the browser filled in)
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
  // R11: the times editor moved from Setup to the Availability tab and the
  // questions editor to the Questions tab. Both tabs redraw on every live
  // update, so what Setup did for them must still hold: a live update never
  // redraws a times form while Admin is typing in it (it catches up once focus
  // leaves), and a question being typed keeps its text, focus and caret.
  async editorsSurviveUpdates(page, url) {
    const problems = [];
    // Ekwueme has not answered yet, so the grid reads 4 of 5 until the update
    const b0 = base(); b0.availIv = { ...b0.availIv, Ekwueme: {} };
    await load(page, url, b0, "adminpw"); await landAsAdmin(page);
    await tab(page, "availability");
    await page.evaluate(() => { const d = document.querySelector('#availability details[data-sec="times"]'); d.open = true; d.dispatchEvent(new Event("toggle")); });
    await sleep(100);
    await page.evaluate(() => { const el = document.querySelector("#tAddFrom"); el.__mark = 1; el.focus(); });
    const other = await page.browser().newPage();
    await other.goto(url, { waitUntil: "domcontentloaded" });
    const bump = (who) => other.evaluate((who) => {
      const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
      s.availIv = { ...s.availIv, [who]: { t0: "ip", t1: "ip" } };
      localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
      new BroadcastChannel("ed_interviews").postMessage(1);
    }, who);
    await bump("Ekwueme"); await sleep(400);
    await page.bringToFront();
    const held = await page.evaluate(() => { const el = document.querySelector("#tAddFrom"); return { same: !!(el && el.__mark), focused: document.activeElement === el,
      grid: (document.querySelector('#availability details[data-sec="avgrid"] .sec-sub') || {}).textContent || "" }; });
    problems.push(...ok(held.same && held.focused, `a live update redrew the times form while it was being typed in: ${JSON.stringify(held)}`));
    // R11 review: only the times card is held; the grids below stay live (they
    // used to freeze while focus sat in the form, even with the window away)
    problems.push(...ok(/5 of 5/.test(held.grid), `the rest of the Availability tab stopped updating while the times form had focus: ${held.grid}`));
    await page.evaluate(() => document.activeElement.blur()); await sleep(500);
    const caught = await page.evaluate(() => { const el = document.querySelector("#tAddFrom"); return { redrawn: !!el && !el.__mark,
      grid: (document.querySelector('#availability details[data-sec="avgrid"] .sec-sub') || {}).textContent || "" }; });
    problems.push(...ok(caught.redrawn && /5 of 5/.test(caught.grid), `the tab didn't catch up once focus left the form: ${JSON.stringify(caught)}`));
    // R11 review: someone else removes the time being edited: the edit closes
    // with the "removed by someone else" message straight away, on the tab
    await page.evaluate(() => window.IV.tEdit("t1")); await sleep(150);
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await sleep(350);
    await other.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
      s.settings = { ...s.settings, times: s.settings.times.filter((t) => t.id !== "t1") };
      localStorage.setItem("ed_interviews_v1", JSON.stringify(s));
      new BroadcastChannel("ed_interviews").postMessage(1);
    });
    await sleep(400); await page.bringToFront();
    const gone = await page.evaluate(() => ({ toast: document.querySelector("#toast").textContent, editing: !!document.querySelector("#tEdStart") }));
    problems.push(...ok(/removed by someone else/.test(gone.toast) && !gone.editing, `editing a time someone else removed: ${JSON.stringify(gone)}`));
    // the Questions tab: typing survives an update
    await tab(page, "questions");
    await page.click("#qText-1"); await page.keyboard.press("End"); await page.keyboard.type(" (typed)");
    await other.bringToFront(); await bump("Dufour"); await sleep(400); await page.bringToFront();
    const q = await page.evaluate(() => ({ v: document.querySelector("#qText-1").value, f: document.activeElement && document.activeElement.id }));
    problems.push(...ok(q.v === "A difficult case (typed)" && q.f === "qText-1", `a live update lost a question being typed: ${JSON.stringify(q)}`));
    await other.close();
    return problems;
  },

  // R11 review: a More menu closes when focus tabs out of it, and after a pick
  // focus goes back to its button instead of the page.
  async moreMenuFocus(page, url) {
    const problems = [];
    await load(page, url, base(), "adminpw"); await landAsAdmin(page); await tab(page, "panels");
    await sleep(600);   // let the sign-in's own writes land (a redraw would close the menu)
    await page.focus("details.panelmore > summary"); await page.keyboard.press("Enter"); await sleep(100);
    const opened = await page.$eval("details.panelmore", (d) => d.open);
    problems.push(...ok(opened, "Enter on More didn't open the menu"));
    const items = await page.$$eval("details.panelmore .moremenu button", (b) => b.length);
    for (let i = 0; i <= items; i++) await page.keyboard.press("Tab");
    await sleep(100);
    const st = await page.evaluate(() => ({ open: document.querySelector("details.panelmore").open,
      inside: document.querySelector("details.panelmore").contains(document.activeElement) }));
    problems.push(...ok(!st.inside && !st.open, `tabbing out left the menu open: ${JSON.stringify(st)}`));
    await page.evaluate(() => { const d = document.querySelector("details.panelmore"); d.open = true; });
    await page.evaluate(() => { window.__dl = 0; URL.createObjectURL = () => { window.__dl++; return "blob:stub"; }; });
    await page.click("details.panelmore .moremenu button"); await sleep(200);   // Export CSV
    const after = await page.evaluate(() => ({ open: document.querySelector("details.panelmore").open,
      focus: document.activeElement && document.activeElement.matches("details.panelmore > summary") }));
    problems.push(...ok(!after.open && after.focus, `after a pick: ${JSON.stringify(after)}`));
    return problems;
  },

  // Members keyed by id: a member whose id is not her name shows by name
  // everywhere, and her input (keyed by id) is found.
  async membersById(page, url) {
    const problems = [];
    await load(page, url, base({ screening: { "m-b1~c-1": { member: "m-b1", candId: "c-1", flag: true, reason: "Not ready", rating: 0 } } }), "adminpw");
    await landAsAdmin(page);
    const coll = await page.$eval("#screen", (e) => e.textContent);
    problems.push(...ok(coll.includes("Bruns-Lee") && coll.includes("Not ready"), "the collation doesn't show Bruns-Lee's concern by name"));
    problems.push(...ok(!coll.includes("m-b1"), "a member id leaked onto the Screen tab"));
    await tab(page, "panels");
    const pan = await page.$eval("#panels", (e) => e.textContent);
    problems.push(...ok(!pan.includes("m-b1"), "a member id leaked onto the Panels tab"));
    // as a reviewer: she picks her name; the value filed under is her id
    await page.evaluate(() => document.querySelector("#logout").click());
    await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(300);
    await signIn(page, "staffpw");
    await page.waitForSelector("#memberpick:not(.hidden)");
    const opts = await page.$$eval("#memberSel option", (o) => o.map((x) => [x.value, x.textContent]));
    problems.push(...ok(opts.some(([v, t]) => v === "m-b1" && t === "Bruns-Lee"), `the name list doesn't offer Bruns-Lee as m-b1: ${JSON.stringify(opts)}`));
    await pickMember(page, "m-b1");
    const who = await page.$eval("#whoLine", (e) => e.textContent);
    problems.push(...ok(who === "Bruns-Lee", `header says ${who}`));
    await page.evaluate(() => window.IV.rate("c-2", 4)); await sleep(200);
    const st = await dumpState(page);
    problems.push(...ok(st.screening["m-b1~c-2"] && st.screening["m-b1~c-2"].rating === 4, "a rating wasn't filed under the member id"));
    return problems;
  },

  // R7: nothing is decrypted or copied any more. With no questions document the
  // Admin sign-in writes nothing, the Questions tab says how to add them,
  // and the Passwords card waits for them (design 5.2).
  async noQuestionCopySinceR7(page, url) {
    const problems = [];
    await load(page, url, base({ questions: null, scores: { "Chen~c-1": { member: "Chen", candId: "c-1", overall: 3, notes: { 1: "about the case" } } } }), "adminpw");
    await landAsAdmin(page); await sleep(400);
    const st = await dumpState(page);
    problems.push(...ok(!st.questions, "a questions document appeared after the Admin sign-in"));
    problems.push(...ok(!Object.values(st.history || {}).some((h) => h.action === "questions.migrate"), "a questions copy was recorded"));
    await tab(page, "questions");   // R11: the questions editor has its own tab
    const q = await page.$eval("#questions", (e) => e.textContent);
    problems.push(...ok(q.includes("Restore them from a backup file") && !q.includes("old locked file") && !q.includes("Locked because scoring"), `Questions card: ${q.slice(0, 200)}`));
    await openSetupCard(page, "setPasswords");
    const pw = await page.$eval('details[data-sec="setPasswords"]', (e) => e.textContent);
    // R9: the passwords are seen and changed on the ED dashboard's passwords
    // page; the card only says so and links there (sim/passwords-moved.mjs has the rest)
    const href = await page.$eval('details[data-sec="setPasswords"] a', (a) => a.getAttribute("href")).catch(() => "");
    problems.push(...ok(href === "https://michaelgarronhospital-ed.github.io/passwords.html" && pw.replace(/\s+/g, " ").includes("seen and changed on the ED tools passwords page")
      && !pw.includes("Change a password") && !pw.includes("didn't finish"), `Passwords card: ${pw.slice(0, 200)}`));
    // review: notes exist but the questions are missing: not locked, and the
    // ids the notes use can be rebuilt ("0", "1")
    await page.evaluate(() => document.querySelector("#setupClose").click());
    await tab(page, "questions");
    await page.evaluate(() => window.IV.qFromNotes()); await sleep(200);
    await page.type("#qText-0", "Tell us about yourself"); await page.type("#qText-1", "A difficult case");
    await page.evaluate(() => [...document.querySelectorAll("#questions button")].find((b) => b.textContent.trim() === "Save questions").click());
    await sleep(500);
    const sq = (await dumpState(page)).questions;
    problems.push(...ok(sq && sq.questions.map((x) => x.id).join() === "0,1", `rebuilt ids: ${JSON.stringify(sq)}`));
    return problems;
  },

  // The Score tab reads the questions DOCUMENT once there is one, keyed by id.
  async questionsFromDocument(page, url) {
    const problems = [];
    const questions = { version: 1, questions: [{ id: "0", text: "Doc question A" }, { id: "q7", text: "Doc question B" }], scale: ["1", "2", "3", "4", "5"], guide: [] };
    await load(page, url, base({ questions, scores: { "Chen~c-1": { notes: { q7: "saved under q7" } } } }), "staffpw");
    await pickMember(page, "Chen"); await tab(page, "score");
    await page.select("select[aria-label='Candidate to score']", "c-1"); await sleep(150);
    const qs = await page.$$eval("#score .q", (e) => e.map((x) => x.textContent));
    problems.push(...ok(qs.join("|") === "Doc question A|Doc question B", `Score tab shows ${qs.join("|")}`));
    const note = await page.$eval("#note-q7", (e) => e.value).catch(() => null);
    problems.push(...ok(note === "saved under q7", `note under q7 shows ${note}`));
    await page.click("#note-0"); await page.type("#note-0", "typed"); await sleep(700);
    const st = await dumpState(page);
    problems.push(...ok((st.scores["Chen~c-1"].notes || {})["0"] === "typed", "a note wasn't saved under its question id"));
    return problems;
  },

  // H12: "Reset hand-made panels" says what it removes and can be undone,
  // from the toast and from Change history.
  async resetPanelsUndo(page, url) {
    const problems = [];
    const ov = { "c-1": { slot: "t0", members: ["Abara", "m-b1", "Chen"], modality: "ip" } };
    await load(page, url, base({ settings: { ...base().settings, panelOverrides: ov } }), "adminpw");
    await landAsAdmin(page); await tab(page, "panels");
    await page.evaluate(() => [...document.querySelectorAll("#panels button")].find((b) => b.textContent.includes("Reset hand-made panels")).click());
    const msg = await confirmYes(page);
    problems.push(...ok(msg.includes("Ashcombe") && msg.includes("You can undo this"), `confirm says: ${msg}`));
    let st = await dumpState(page);
    problems.push(...ok(Object.keys(st.settings.panelOverrides).length === 0, "the hand-made panel is still there"));
    const btn = await page.$(".toast-btn");
    problems.push(...ok(!!btn, "no Undo on the toast"));
    if (btn) { await btn.click(); await sleep(400); }
    st = await dumpState(page);
    problems.push(...ok(JSON.stringify(st.settings.panelOverrides) === JSON.stringify(ov), `after Undo: ${JSON.stringify(st.settings.panelOverrides)}`));
    // and again, undone from Change history this time
    await page.evaluate(() => [...document.querySelectorAll("#panels button")].find((b) => b.textContent.includes("Reset hand-made panels")).click());
    await confirmYes(page);
    await openSetupCard(page, "setHistory");
    const undo = await page.$$('details[data-sec="setHistory"] button');
    const labels = await Promise.all(undo.map((b) => b.evaluate((x) => x.textContent)));
    const i = labels.indexOf("Undo");
    problems.push(...ok(i >= 0, `no Undo in Change history: ${labels}`));
    if (i >= 0) { await undo[i].click(); await sleep(600); }
    st = await dumpState(page);
    problems.push(...ok(JSON.stringify(st.settings.panelOverrides) === JSON.stringify(ov), `after history Undo: ${JSON.stringify(st.settings.panelOverrides)}`));
    const card = await page.$eval('details[data-sec="setHistory"]', (e) => e.textContent);
    problems.push(...ok(card.includes("Undone.") && card.includes("Undid:"), "Change history doesn't show the undo"));
    const hist = Object.values(st.history || {});
    problems.push(...ok(hist.every((h) => !JSON.stringify(h).includes("Ashcombe")), "an applicant name was stored in history"));
    return problems;
  },

  // H1a: the backup file comes from a fresh read and has everything; the Excel
  // has a Questions sheet and the left member's input.
  async backupFile(page, url) {
    const problems = [];
    const committee = COMMITTEE.map((m) => m.name === "Ekwueme" ? { ...m, id: "Ekwueme", active: false } : m);
    await load(page, url, base({
      settings: { ...base().settings, committee },
      scores: { "Ekwueme~c-1": { overall: 4.5, notes: { 0: "left member's note" } } },
      screening: { "Gone~c-2": { flag: true, reason: "from someone off the list" } },
    }), "adminpw");
    await landAsAdmin(page); await sleep(300);
    await tab(page, "ranking");
    const text = await nextDownload(page, "window.IV.downloadBackup()");
    let b = null; try { b = JSON.parse(text); } catch { problems.push("the backup isn't JSON"); }
    if (b) {
      problems.push(...ok(b.format === "mgh-ed-hiring-backup" && b.version === 1 && /^sha256:/.test(b.checksum), "wrong header"));
      problems.push(...ok(b.data.interviews_meta.questions && b.data.interviews_meta.questions.questions.length === 3, "no questions in the backup"));
      problems.push(...ok(b.data.interviews_scores["Ekwueme~c-1"] && b.data.interviews_screening["Gone~c-2"], "a left or removed member's input is missing"));
      problems.push(...ok(b.data.interviews_availCand.ashcombe && b.data.interviews_availCand.ashcombe.slots.t0 === "ip", "applicant times missing"));
    }
    const xlsx = await nextDownload(page, "window.IV.exportCycle()");
    problems.push(...ok(xlsx.includes('<sheet name="Questions"'), "the Excel has no Questions sheet"));
    problems.push(...ok(xlsx.includes("left member&apos;s note") || xlsx.includes("left member's note"), "the Excel is missing the left member's note"));
    problems.push(...ok(xlsx.includes("from someone off the list"), "the Excel is missing input from someone off the list"));
    problems.push(...ok(!xlsx.includes("Interview questions (encrypted)"), "the Excel summary still says the questions are not included"));
    return problems;
  },

  // H12: log out removes this browser's copies of scores and picks.
  async logoutClears(page, url) {
    const problems = [];
    await load(page, url, base(), "staffpw");
    await pickMember(page, "Chen");
    await page.evaluate(() => { localStorage.setItem("ed_iv_echo_v1", "{\"scores\":{}}"); localStorage.setItem("ed_iv_cand_echo_v1", "{}"); });
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#logout")]);
    await page.waitForFunction("window.__edReady === true");
    const left = await page.evaluate(() => [localStorage.getItem("ed_iv_echo_v1"), localStorage.getItem("ed_iv_cand_echo_v1"), !!localStorage.getItem("ed_interviews_v1")]);
    problems.push(...ok(left[0] === null && left[1] === null, `copies left after log out: ${left}`));
    problems.push(...ok(left[2], "log out wiped the (local mode) database itself"));
    return problems;
  },

  // Section 2.3: a new version.json shows ED one line; an Admin page that
  // has nothing to lose reloads itself, once per version.
  async reloadNotice(page, url) {
    const problems = [];
    await page.setRequestInterception(true);
    const handler = (req) => req.url().split("?")[0].endsWith("/version.json")
      ? req.respond({ status: 200, contentType: "application/json", body: '{ "release": "R99" }' }) : req.continue();
    page.on("request", handler);
    try {
      await load(page, url, base(), "staffpw");
      await pickMember(page, "Chen");
      await page.evaluate(() => window.__edCheckVersion()); await sleep(200);
      const line = await page.$eval("#updateLine", (e) => !e.classList.contains("hidden") && e.textContent);
      problems.push(...ok(line && line.includes("This page was updated"), `ED line: ${line}`));
      await page.evaluate(() => { document.querySelector("#logout").click(); });
      await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(300);
      await signIn(page, "adminpw"); await landAsAdmin(page); await sleep(200);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => problems.push("Admin page didn't reload itself")),
        page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__edCheckVersion(); })]);
      await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(800);
      const flag = await page.evaluate(() => sessionStorage.getItem("ed_iv_reloaded_for"));
      problems.push(...ok(flag === "R99", `reload flag ${flag}`));
      // a second notice for the same version shows the line instead of reloading again
      let reloaded = false;
      page.once("framenavigated", () => { reloaded = true; });
      await page.evaluate(() => window.__edCheckVersion()); await sleep(800);
      problems.push(...ok(!reloaded, "reloaded twice for one version"));
    } finally {
      page.off("request", handler);
      await page.setRequestInterception(false);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main(process.argv[2]);
  let bad = 0;
  for (const [name, problems] of Object.entries(results)) {
    if (!problems.length) { console.log(`PASS  ${name}`); continue; }
    bad++;
    console.log(`FAIL  ${name}`);
    problems.forEach((p) => console.log(`        - ${p}`));
  }
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} foundation scenarios pass`);
  process.exit(bad ? 1 : 0);
}
