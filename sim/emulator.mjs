// The REAL page (FirestoreStore, Firebase Auth, the real firestore.rules) against
// the local Firebase emulators, never LocalStore (review m8). Every write the
// page makes is judged by the rules that will go live.
//
//   npm run emulator            (builds sim/site-emulator, starts the Auth and
//                                Firestore emulators, runs every case, stops them)
//   npm run emulator -- <case>  (one case)
//
// Needs Java (Firestore emulator) and the firebase-tools already installed in
// ../tests (cd ../tests && npm install). Project id mgh-ed-hiring-test-emu only.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve, browser, signIn, pickMember, landAsAdmin, tab, sleep, daysAhead } from "./drive.mjs";
import * as emu from "./emu.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, "site-emulator");

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [
  { id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" },
  { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" },
];
export const baseDocs = () => ({
  "interviews_meta/config": { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  "interviews_public/slots": { times: TIMES },
  "interviews_candidates/c-1": { name: "Dr Rosalind Ashcombe", removed: false },
  "interviews_candidates/c-2": { name: "Dr Ben Carter", removed: false },
  "interviews_meta/allowed": { keys: ["ashcombe", "carter"] },
});
const ok = (cond, msg) => (cond ? [] : [msg]);
const until = async (fn, ms = 8000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};

let B, SRV;
// A fresh, isolated browser profile per page (its own storage and IndexedDB).
export async function freshPage({ width = 1280, log = [] } = {}) {
  const ctx = await B.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log.push(`console.error: ${m.text()}`); });
  await page.goto(SRV.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 20000 });
  page._ctx = ctx;
  return page;
}
const closePage = async (p) => { try { await p._ctx.close(); } catch { /* gone */ } };
export async function asLeadership(page) { await signIn(page, "adminpw"); await landAsAdmin(page); await sleep(400); }
export async function asED(page, member) { await signIn(page, "staffpw"); await pickMember(page, member); await sleep(300); }
// capture the next file the page downloads (and don't let it really navigate)
export const nextDownload = (page, act) => page.evaluate((act) => new Promise((resolve) => {
  const orig = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = click; };
  URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = orig; return "blob:stub"; };
  eval(act);
}), act);
const history = async () => Object.values(await emu.listCollection("interviews_history"));

export const cases = {
  // R1: the first Leadership sign-in copies the questions, with a history
  // entry stamped by the server; adding an applicant writes the roster and its
  // history in one commit the rules accept.
  async leadershipCopiesQuestions() {
    const problems = [], log = [];
    const p = await freshPage({ log });
    await asLeadership(p);
    const q = await until(() => emu.getDocument("interviews_meta/questions"));
    problems.push(...ok(q && q.migratedFrom === "data.js" && q.questions.length === 3, `questions doc: ${JSON.stringify(q)}`));
    const h = await until(async () => (await history()).find((e) => e.action === "questions.migrate"));
    problems.push(...ok(h && h.at && h.at.__ts, `migrate history: ${JSON.stringify(h)}`));
    await p.evaluate(() => { document.querySelector("#bulkAdd").value = "Dr Jane Kim";
      [...document.querySelectorAll("#screen button")].find((b) => b.textContent.trim() === "Add candidates").click(); });
    const added = await until(async () => Object.values(await emu.listCollection("interviews_candidates")).find((c) => c.name === "Dr Jane Kim"));
    problems.push(...ok(added && added.addedAt && added.addedAt.__ts, "the new applicant wasn't saved with addedAt"));
    const ha = await until(async () => (await history()).find((e) => e.action === "roster.add"));
    problems.push(...ok(ha && !JSON.stringify(ha).includes("Kim"), `roster.add history: ${JSON.stringify(ha)}`));
    const allowed = await until(async () => { const a = await emu.getDocument("interviews_meta/allowed"); return a && a.keys.includes("kim") && a; });
    problems.push(...ok(allowed, "the allowed list didn't pick up the new surname"));
    await closePage(p);
    return [...problems, ...log];
  },

  // R1: an ED rating and a score note save under the real rules; the Score tab
  // shows the questions from the document, keyed by id.
  async edRatesAndScores() {
    const problems = [], log = [];
    await emu.seed({ "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Doc question A" }, { id: "q7", text: "Doc question B" }], scale: ["1", "2", "3", "4", "5"], guide: [] } });
    const p = await freshPage({ log });
    await asED(p, "Chen");
    await p.evaluate(() => window.IV.rate("c-1", 4));
    const s = await until(() => emu.getDocument("interviews_screening/Chen~c-1"));
    problems.push(...ok(s && s.rating === 4 && s.member === "Chen", `screening: ${JSON.stringify(s)}`));
    await tab(p, "score");
    await p.select("select[aria-label='Candidate to score']", "c-1"); await sleep(200);
    const qs = await p.$$eval("#score .q", (e) => e.map((x) => x.textContent));
    problems.push(...ok(qs.join("|") === "Doc question A|Doc question B", `Score tab: ${qs.join("|")}`));
    await p.click("#note-q7"); await p.type("#note-q7", "clear and kind"); await sleep(900);
    const sc = await until(async () => { const d = await emu.getDocument("interviews_scores/Chen~c-1"); return d && d.notes && d.notes.q7 && d; });
    problems.push(...ok(sc && sc.notes.q7 === "clear and kind", `score: ${JSON.stringify(sc)}`));
    // H12: log out clears this browser's copy of the score
    const before = await p.evaluate(() => localStorage.getItem("ed_iv_echo_v1"));
    await Promise.all([p.waitForNavigation({ waitUntil: "domcontentloaded" }), p.click("#logout")]);
    await p.waitForFunction("window.__edReady === true");
    const after = await p.evaluate(() => localStorage.getItem("ed_iv_echo_v1"));
    problems.push(...ok(before && after === null, `echo before ${!!before}, after ${after}`));
    await closePage(p);
    return [...problems, ...log];
  },

  // R1 (review M1): the backup file is a fresh server read. An entry that only
  // exists in this browser's echo is not in it; everything on the server is.
  async backupIsAFreshRead() {
    const problems = [], log = [];
    await emu.seed({
      "interviews_screening/Bruns~c-1": { member: "Bruns", candId: "c-1", rating: 3, flag: false },
      "interviews_availCand/ashcombe": { slots: { t0: "ip" }, reply: "confirmed", replyAt: { __ts: "2027-02-22T18:00:00.000Z" } },
    });
    const p = await freshPage({ log });
    await p.evaluate(() => localStorage.setItem("ed_iv_echo_v1", JSON.stringify({ screening: { "Ghost~c-2": { rating: 5 } }, scores: {} })));
    await asLeadership(p);
    await tab(p, "ranking");
    const text = await nextDownload(p, "window.IV.downloadBackup()");
    const b = JSON.parse(text);
    problems.push(...ok(b.data.interviews_screening["Bruns~c-1"], "the server's screening is missing"));
    problems.push(...ok(!text.includes("Ghost~c-2"), "an echo-only entry got into the backup"));
    problems.push(...ok(b.data.interviews_availCand.ashcombe.reply === "confirmed"
      && b.data.interviews_availCand.ashcombe.replyAt.__ts === "2027-02-22T18:00:00.000Z", "the reply or its time is missing"));
    problems.push(...ok(b.data.interviews_meta.questions, "the questions document is missing"));
    await closePage(p);
    return [...problems, ...log];
  },

  // R3 (H4): a note still waiting out its pause when scoring closes is refused by
  // the rules, says why, and nothing is written. A write an older page would
  // make (no client-side guard) is refused too.
  async stageRefusals() {
    const problems = [], log = [];
    const p = await freshPage({ log });
    await asED(p, "Chen"); await tab(p, "score");
    await p.select("select[aria-label='Candidate to score']", "c-1"); await sleep(200);
    await p.type("#note-0", "typed just before the close");
    await emu.setDocument("interviews_meta/state", { stages: { scoring: { closed: true } } });
    await sleep(2500);
    const toastText = await p.$eval("#toast", (e) => e.textContent);
    problems.push(...ok(toastText.includes("Scoring is closed. This change was not saved."), `toast: ${toastText}`));
    problems.push(...ok(!(await emu.getDocument("interviews_scores/Chen~c-1")), "a score was written after scoring closed"));
    const hint = await p.$eval("#score .hint", (e) => e.textContent);
    problems.push(...ok(hint === "Scoring is closed. Your answers are saved.", `hint: ${hint}`));
    await emu.setDocument("interviews_meta/state", { stages: { screening: { closed: true } } });
    await sleep(500);
    const code = await p.evaluate(() => window.__edStore.setScreening("Chen", "c-2", { rating: 5 }).then(() => "saved", (e) => e.code));
    problems.push(...ok(code === "permission-denied", `old-page screening write: ${code}`));
    await closePage(p);
    return [...problems, ...log];
  },

  // R3 (H4, review M6): closing availability writes booking "closed" to the
  // public times document in the same commit; reopening writes "open".
  async bookingFlag() {
    const problems = [], log = [];
    const p = await freshPage({ log });
    await asLeadership(p);
    await p.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
    await p.evaluate(() => { const d = document.querySelector('details[data-sec="setStages"]'); d.open = true; });
    await p.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Close availability").click());
    await p.waitForSelector("#confirmWrap:not(.hidden)"); await p.click("#confirmYes");
    const pub = await until(async () => { const d = await emu.getDocument("interviews_public/slots"); return d && d.booking === "closed" && d; });
    problems.push(...ok(pub, "booking wasn't set to closed"));
    const st = await emu.getDocument("interviews_meta/state");
    problems.push(...ok(st && st.stages && st.stages.availability.closed === true && st.stages.availability.at.__ts, `state: ${JSON.stringify(st)}`));
    await sleep(300);
    // review: an applicant sees "Booking is closed" before any name step
    const g = await freshPage({ log });
    await signIn(g, "guestpw");
    await g.waitForFunction(() => /Booking is closed/.test(document.querySelector("#candview").textContent), { timeout: 8000 }).catch(() => {});
    const gt = await g.$eval("#candview", (e) => e.textContent);
    problems.push(...ok(gt.includes("Booking is closed") && !(await g.$("#candName")), `applicant sees: ${gt.slice(0, 120)}`));
    await closePage(g);
    await p.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Reopen").click());
    const pub2 = await until(async () => { const d = await emu.getDocument("interviews_public/slots"); return d && d.booking === "open" && d; });
    problems.push(...ok(pub2, "booking wasn't set back to open"));
    const h = (await history()).filter((e) => e.action.startsWith("stage."));
    problems.push(...ok(h.length === 2, `${h.length} stage history entries`));
    await closePage(p);
    return [...problems, ...log];
  },
};

// Extra cases from later releases register here (see the files they live in).
export async function run(only) {
  await emu.loadRules();
  SRV = await serve(SITE);
  B = await browser();
  const results = {};
  try {
    for (const [name, fn] of Object.entries(cases)) {
      if (only && name !== only) continue;
      await emu.clearFirestore(); await emu.clearAuth();
      for (const [e, pw] of emu.ROLE_USERS) await emu.addUser(e, pw);
      await emu.seed(baseDocs());
      try { results[name] = await fn(); } catch (e) { results[name] = [`threw: ${e.stack || e.message}`]; }
    }
  } finally { await B.close(); SRV.close(); }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await run(process.argv[2]);
  let bad = 0;
  for (const [name, problems] of Object.entries(results)) {
    if (!problems.length) { console.log(`PASS  ${name}`); continue; }
    bad++; console.log(`FAIL  ${name}`); problems.forEach((p) => console.log(`        - ${p}`));
  }
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} emulator cases pass`);
  process.exit(bad ? 1 : 0);
}
