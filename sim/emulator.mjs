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
export async function freshPage({ width = 1280, log = [], timing = null, skewMs = 0 } = {}) {
  const ctx = await B.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  if (timing) await page.evaluateOnNewDocument((t) => { globalThis.__edRoundsTiming = t; }, timing);
  if (skewMs) await page.evaluateOnNewDocument((ms) => { const now = Date.now; Date.now = () => now() + ms; }, skewMs);
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  // a refused sign-in is how the gate finds the role (R7): the browser logs
  // each refusal as a failed request, which is expected, not an error
  const refusal = (m) => /status of 400/.test(m.text()) && String((m.location() || {}).url || "").includes(":9099/");
  page.on("console", (m) => { if (m.type() === "error" && !refusal(m)) log.push(`console.error: ${m.text()}`); });
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

// R7c: the emails the accounts move FROM and TO in emailChangeKeepsSessions (R7d swaps them: a rollback)
const FROM = { admin: "admin@ed-hiring.app", committee: "committee@ed-hiring.app", applicant: "applicant@ed-hiring.app" };
const TO = { admin: "admin@mgh-ed-hiring.invalid", committee: "committee@mgh-ed-hiring.invalid", applicant: "applicant@mgh-ed-hiring.invalid" };
export const cases = {
  // R7c (Phase A): a role is known by uid, never by email.
  // (1) Signed in as each role, the account's email is changed by the admin API
  //     (as migrate-emails.py will do live) and the page reloads. The Auth
  //     emulator, like Firebase, ends sessions on an email change: an ID token
  //     issued a second or more before the change is refused (TOKEN_EXPIRED) and
  //     the SDK clears the user on reload. So the page either carries on as the
  //     SAME role or is back at the sign-in box; never another role, never stuck.
  // (2) "An old cached page after the change": this page still has the OLD emails
  //     in its config while the session is the account under its NEW email (signed
  //     in again in the same tab after the change). Reload: still in, same role.
  //     A page that decided the role by email would put each one at the sign-in box.
  // (3) A fresh sign-in with the old emails is refused and says Incorrect password
  //     (the minute between the change and R7d going live).
  async emailChangeKeepsSessions() {
    const problems = [], log = [];
    const roles = [
      ["admin", "adminpw", FROM.admin, TO.admin, async (p) => { await p.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
        return (await p.$eval("#whoLine", (e) => e.textContent.trim())) === "Admin"; }],
      ["committee", "staffpw", FROM.committee, TO.committee, async (p) => { await p.waitForSelector("#memberpick:not(.hidden)", { timeout: 15000 }); return true; }],
      ["applicant", "guestpw", FROM.applicant, TO.applicant, async (p) => { await p.waitForSelector("#candview:not(.hidden)", { timeout: 15000 }); return true; }],
    ];
    const gateUp = (p) => p.$eval("#gate", (e) => !e.classList.contains("hidden"));
    const reload = async (p) => { await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForFunction("window.__edReady === true"); await sleep(1500); };
    const pages = [];
    for (const [role, pw, , , landed] of roles) {
      const p = await freshPage({ log });
      await signIn(p, pw);
      problems.push(...ok(await landed(p), `${role}: didn't land before the change`));
      pages.push(p);
    }
    await sleep(1200);   // so the change comes at least a second after the sign-ins (Firebase counts whole seconds)
    for (const [role, , , to] of roles) await emu.setEmail(emu.UIDS[role], to);
    for (let i = 0; i < roles.length; i++) {
      const [role, pw, , to, landed] = roles[i], p = pages[i];
      // (1) a plain reload: same role, or the sign-in box
      await reload(p);
      let same = false; try { same = !(await gateUp(p)) && await landed(p); } catch { same = false; }
      problems.push(...ok(same || await gateUp(p), `${role}: after the change the page is neither in as the same role nor at the sign-in box`));
      // (2) the account under its new email signs in again in this tab (as the
      // live page will after R7d); this page's config still has the old email
      await p.evaluate(async (to, pw) => {
        const fbm = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
        const appm = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
        const auth = fbm.getAuth(appm.getApp());
        await fbm.setPersistence(auth, fbm.browserSessionPersistence);
        await fbm.signInWithEmailAndPassword(auth, to, pw);
        sessionStorage.setItem("ed_iv_signedin", "1");
      }, to, pw);
      await reload(p);
      let still = false; try { still = !(await gateUp(p)) && await landed(p); } catch { still = false; }
      problems.push(...ok(still, `${role}: an old page signed in as the account under its new email doesn't recognise the role after a reload`));
    }
    for (const p of pages) await closePage(p);
    // (3) the old emails no longer sign in
    const fresh = await freshPage({ log });
    await signIn(fresh, "adminpw"); await sleep(1500);
    const msg = await fresh.$eval("#gerr", (e) => e.textContent);
    problems.push(...ok(msg.includes("Incorrect password."), `a fresh sign-in with an email the accounts no longer have: ${msg}`));
    await closePage(fresh);
    return [...problems, ...log.filter((l) => !/console\.error/.test(l) || !/400/.test(l))];
  },

  // R1: adding an applicant writes the roster and its history in one commit
  // the rules accept. R7: the Leadership sign-in found by order (ED and Guest
  // refuse first on a new browser), and nothing is copied into a questions
  // document any more (the page no longer reads js/data.js).
  async leadershipAddsApplicant() {
    const problems = [], log = [];
    const p = await freshPage({ log });
    await asLeadership(p);
    await sleep(500);
    problems.push(...ok(!(await emu.getDocument("interviews_meta/questions")), "a questions document was written at sign-in"));
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
      "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] },
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
    // since R7 the questions come only from the document (R1 copied them live)
    await emu.seed({ "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] } });
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
    // (from R5 the closed page still asks for a name, to show a confirmed time)
    problems.push(...ok(gt.includes("Booking is closed"), `applicant sees: ${gt.slice(0, 120)}`));
    await closePage(g);
    await p.evaluate(() => [...document.querySelectorAll("#settings button")].find((b) => b.textContent.trim() === "Reopen").click());
    const pub2 = await until(async () => { const d = await emu.getDocument("interviews_public/slots"); return d && d.booking === "open" && d; });
    problems.push(...ok(pub2, "booking wasn't set back to open"));
    const h = (await history()).filter((e) => e.action.startsWith("stage."));
    problems.push(...ok(h.length === 2, `${h.length} stage history entries`));
    await closePage(p);
    return [...problems, ...log];
  },

  // R4 (H14): leadership adds a second Kim; both get their own key, the allowed
  // list follows, and each Kim books under their own document through the real
  // rules (plain "kim" is refused).
  async sameSurnameBooking() {
    const problems = [], log = [];
    await emu.seed({ "interviews_candidates/c-j": { name: "Dr Jane Kim", removed: false } });
    const lead = await freshPage({ log });
    await asLeadership(lead);
    await lead.evaluate(() => { document.querySelector("#bulkAdd").value = "Dr Min Kim";
      [...document.querySelectorAll("#screen button")].find((b) => b.textContent.trim() === "Add candidates").click(); });
    await lead.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 8000 }); await lead.click("#confirmYes");
    const allowed = await until(async () => { const a = await emu.getDocument("interviews_meta/allowed");
      return a && a.keys.includes("kim-jane") && a.keys.includes("kim-min") && !a.keys.includes("kim") && a; });
    problems.push(...ok(allowed, "the allowed list didn't move to the two keys"));
    await closePage(lead);
    const app = await freshPage({ log });
    await signIn(app, "guestpw"); await app.waitForSelector("#candName");
    await app.type("#candFirst", "Jane"); await app.type("#candName", "Kim"); await app.click("#candGo");
    await app.waitForSelector(".slotgrid", { timeout: 8000 });
    await app.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("onclick") || "") === "CAND.set('t0','ip')"); b.click(); });
    const d = await until(async () => { const x = await emu.getDocument("interviews_availCand/kim-jane"); return x && x.slots && x.slots.t0 === "ip" && x; });
    problems.push(...ok(d, "Jane's pick didn't land under kim-jane"));
    const plain = await emu.getDocument("interviews_availCand/kim");
    problems.push(...ok(!plain, "something was written under plain kim"));
    await closePage(app);
    return [...problems, ...log.filter((l) => !l.includes("permission"))];
  },

  // R5 (H11): leadership locks the schedule and sends the times; the applicant
  // sees their time, confirms and withdraws through the real rules; with
  // availability closed a reply still saves.
  async applicantNotice() {
    const problems = [], log = [];
    await emu.seed({ "interviews_availCand/ashcombe": { slots: { t0: "ip" } },
      "interviews_meta/config": { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {},
        interviewInfo: { location: "ED admin office, 2nd floor" }, deadlines: { reply: daysAhead(20) } } });
    for (const m of COMMITTEE) await emu.setDocument(`interviews_availIv/${m.name}`, { slots: { t0: "ip", t1: "ip" } });
    const lead = await freshPage({ log });
    await asLeadership(lead); await tab(lead, "panels");
    const click = (p, t) => p.evaluate((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t).click(), t);
    await click(lead, "Lock the schedule"); await lead.waitForSelector("#confirmWrap:not(.hidden)"); await lead.click("#confirmYes");
    await lead.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Send times to applicants"), { timeout: 8000 });
    await click(lead, "Send times to applicants"); await lead.waitForSelector("#confirmWrap:not(.hidden)"); await lead.click("#confirmYes");
    const n = await until(() => emu.getDocument("interviews_applicant/ashcombe"));
    problems.push(...ok(n && n.date && n.publishedAt && n.publishedAt.__ts && !JSON.stringify(n).includes("Ashcombe"), `notice: ${JSON.stringify(n)}`));
    await closePage(lead);
    const app = await freshPage({ log });
    await signIn(app, "guestpw"); await app.waitForSelector("#candName");
    await app.type("#candFirst", "Rosalind"); await app.type("#candName", "Ashcombe"); await app.click("#candGo");
    await app.waitForSelector(".noticecard", { timeout: 8000 });
    await click(app, "I'll be there");
    let d = await until(async () => { const x = await emu.getDocument("interviews_availCand/ashcombe"); return x && x.reply === "confirmed" && x; });
    problems.push(...ok(d && d.replyAt && d.replyAt.__ts && d.slots.t0 === "ip", `after confirm: ${JSON.stringify(d)}`));
    // availability closes: a withdrawal still saves (reply only)
    await emu.setDocument("interviews_meta/state", { stages: { availability: { closed: true } } });
    await emu.setDocument("interviews_public/slots", { times: TIMES, booking: "closed" });
    await sleep(500);
    await click(app, "I can't come"); await app.waitForSelector("#flowWrap:not(.hidden)");
    await app.evaluate(() => [...document.querySelectorAll("#flowBtns button")].find((b) => b.textContent.trim() === "Withdraw").click());
    d = await until(async () => { const x = await emu.getDocument("interviews_availCand/ashcombe"); return x && x.reply === "withdrawn" && x; });
    problems.push(...ok(d, "a withdrawal with availability closed didn't save"));
    await closePage(app);
    return [...problems, ...log];
  },

  // R5 (H11, review M6): while a round is closing, booking is paused: the
  // applicant page shows so and sends no name probe at all.
  async bookingPausedNoProbe() {
    const problems = [], log = [];
    await emu.setDocument("interviews_public/slots", { times: TIMES, booking: "paused" });
    await emu.setDocument("interviews_meta/state", { roundStatus: "closing", closingTab: "p-X", lease: { tab: "p-X", at: { __ts: new Date().toISOString() } } });
    const app = await freshPage({ log });
    const writes = [];
    app.on("request", (r) => { if (/Firestore\/Write/.test(r.url()) || (r.method() === "POST" && /documents:commit/.test(r.url()))) writes.push(r.url()); });
    await signIn(app, "guestpw");
    await app.waitForSelector("#candview:not(.hidden)"); await sleep(1500);
    const t = await app.$eval("#candview", (e) => e.textContent);
    problems.push(...ok(t.includes("Booking is paused. Please try again later.") && !(await app.$("#candName")), `page: ${t.slice(0, 160)}`));
    problems.push(...ok(!writes.length, `writes were sent: ${writes.length}`));
    problems.push(...ok(!(await emu.getDocument("interviews_availCand/ashcombe")), "something was written"));
    await closePage(app);
    return [...problems, ...log];
  },

  // ---- R6: close the round, under the real rules --------------------------------
  // A quiet close finishes in one pass; committee, settings, questions and
  // passwords are untouched; the next round shows no times; bring it back and an
  // ED rating saves at once; close again makes a new attempt.
  async closeQuietThenBringBack() {
    const problems = [], log = [];
    await seedRound();
    const before = await metaNow();
    const a = await freshPage({ log });
    await asLeadership(a);
    await closeViaDialog(a);
    const after = await metaNow();
    for (const k of ["committee", "chair", "oneDrive", "flagThreshold", "retentionMonths"]) problems.push(...ok(JSON.stringify(after.config[k]) === JSON.stringify(before.config[k]), `${k} changed`));
    problems.push(...ok(JSON.stringify(after.questions) === JSON.stringify(before.questions) && JSON.stringify(after.passwords) === JSON.stringify(before.passwords), "questions or passwords changed"));
    problems.push(...ok(Array.isArray(after.config.times) && !after.config.times.length && Array.isArray(after.config.slots) && !after.config.slots.length, "times not emptied"));
    for (const c of CLEAR) problems.push(...ok(Object.keys(await emu.listCollection(c)).filter((id) => c !== "interviews_history").length === 0 || c === "interviews_history", `${c} not empty`));
    const st = after.state;
    problems.push(...ok(st.roundStatus === "open" && !st.closingTab && st.roundId !== "r-2026" && !(st.keptFromClose || []).length, `state: ${JSON.stringify(st)}`));
    const arch = Object.values(await emu.listCollection("interviews_archive"));
    problems.push(...ok(arch.length === 1 && arch[0].status === "closed" && arch[0].closedAt.__ts && arch[0].deleteAfter && arch[0].deleteAfter.__ts, `archive: ${JSON.stringify(arch)}`));
    // bring it back (Past rounds), then an ED rating saves at once
    await a.evaluate(() => { document.querySelector("#flowBtns button").click(); window.IV.loadPast(); }); await sleep(800);
    const id = Object.keys(await emu.listCollection("interviews_archive"))[0];
    await a.evaluate((id) => { window.IV.pastBringBack(id); }, id);   // don't wait: it waits for the confirm below
    await a.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 8000 }); await a.click("#confirmYes");
    const back = await until(async () => { const s2 = await emu.getDocument("interviews_meta/state"); return s2 && s2.broughtBackFrom === "r-2026" && s2; }, 10000);
    problems.push(...ok(back && back.roundStatus === "open", "not brought back open"));
    problems.push(...ok(Object.keys(await emu.listCollection("interviews_candidates")).length === 2, "candidates not back"));
    const ed = await freshPage({ log });
    await asED(ed, "Chen");
    await ed.evaluate(() => window.IV.rate("c-2", 3));
    const r = await until(async () => { const d = await emu.getDocument("interviews_screening/Chen~c-2"); return d && d.rating === 3 && d; });
    problems.push(...ok(r && r.rating === 3, "an ED rating didn't save after bringing the round back"));
    await closePage(ed);
    await closeViaDialog(a);
    problems.push(...ok(Object.values(await emu.listCollection("interviews_archive")).filter((x) => x.status === "closed").length === 2, "closing again didn't make a new attempt"));
    await closePage(a);
    return [...problems, ...log];
  },

  // Kill the page in the middle of the parts; finish from a new tab after the
  // lease goes stale (by the server clock: lease.at moved 6 minutes back).
  async killMidPartsFinishElsewhere() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { partBytes: 1500, renewMs: 600000 } });
    await asLeadership(a);
    await a.evaluate(() => { window.__edRounds.hooks.beforePart = (i) => (i === 1 ? new Promise(() => {}) : null); window.IV.closeRound(); });
    await waitFlow(a, "Close the round?"); await flowClick(a, "Continue");
    await until(async () => { const x = Object.values(await emu.listCollection("interviews_archive"))[0]; return x && x.status === "saving"; });
    await sleep(500);
    await closePage(a);                                          // the laptop lid closes for good
    await staleLease();
    const b = await freshPage({ log, timing: { staleMs: 800, renewMs: 600000 } });
    await asLeadership(b);
    await b.waitForFunction(() => (document.querySelector("#roundLine") || {}).textContent.includes("Nothing has been cleared"), { timeout: 15000 });
    await b.evaluate(() => window.IV.roundTakeover("finish"));
    await waitFlow(b, "Now save the backup", 30000);
    await finishFromStep5(b);
    const arch = Object.values(await emu.listCollection("interviews_archive"));
    problems.push(...ok(arch.some((x) => x.status === "closed"), `archive: ${JSON.stringify(arch.map((x) => x.status))}`));
    problems.push(...ok((await emu.getDocument("interviews_meta/state")).roundStatus === "open", "round not open after finishing"));
    await closePage(b);
    return [...problems, ...log];
  },

  // Kill it in the middle of clearing; from a new tab, "Stop closing and put
  // everything back" restores CLEAR_COLLECTIONS to the copy and meta is untouched.
  async killMidClearPutBack() {
    const problems = [], log = [];
    await seedRound();
    const metaBefore = await metaNow();
    const a = await freshPage({ log, timing: { renewMs: 600000 } });
    await asLeadership(a);
    await a.evaluate(() => { window.__edRounds.hooks.beforeChunk = (coll) => (coll === "interviews_scores" ? new Promise(() => {}) : null); });
    const copyText = await closeViaDialog(a, { stopBeforeDone: true });
    await until(async () => !Object.keys(await emu.listCollection("interviews_screening")).length);
    await closePage(a);
    await staleLease();
    const b = await freshPage({ log, timing: { staleMs: 800, renewMs: 600000 } });
    await asLeadership(b);
    await b.waitForFunction(() => (document.querySelector("#roundLine") || {}).textContent.includes("part of the round has been cleared"), { timeout: 15000 });
    await b.evaluate(() => window.IV.roundTakeover("stop"));
    await waitFlow(b, "Closing stopped", 30000);
    const copy = JSON.parse(copyText).data;
    for (const c of CLEAR) {
      if (c === "interviews_history") continue;
      const live = await emu.listCollection(c);
      problems.push(...ok(JSON.stringify(sorted(live)) === JSON.stringify(sorted(copy[c])), `${c} not back as in the copy`));
    }
    const metaAfter = await metaNow();
    for (const k of ["config", "schedule", "questions", "passwords"]) problems.push(...ok(JSON.stringify(metaAfter[k]) === JSON.stringify(metaBefore[k]), `meta ${k} changed`));
    const st = metaAfter.state;
    problems.push(...ok(st.roundStatus === "open" && !st.closingTab, "round not open"));
    problems.push(...ok(Object.values(await emu.listCollection("interviews_archive"))[0].status === "abandoned", "attempt not abandoned"));
    await closePage(b);
    return [...problems, ...log];
  },

  // Take over while page A is frozen with a delete chunk built but not
  // committed; release it: the chunk is refused and the reopened round
  // deep-equals the copy (review 2 M1).
  async frozenChunkRefusedAfterTakeover() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { renewMs: 600000 } });
    await asLeadership(a);
    await a.evaluate(() => { window.__edRounds.hooks.beforeChunk = (coll) => (coll === "interviews_screening" ? new Promise((r) => { window.__release = r; }) : null); });
    const copyText = await closeViaDialog(a, { stopBeforeDone: true });
    await a.waitForFunction(() => !!window.__release, { timeout: 15000 });
    await staleLease();
    const b = await freshPage({ log, timing: { staleMs: 800, renewMs: 600000 } });
    await asLeadership(b);
    await b.waitForFunction(() => (document.querySelector("#roundLine") || {}).textContent.includes("part of the round has been cleared"), { timeout: 15000 });
    await b.evaluate(() => window.IV.roundTakeover("stop"));
    await waitFlow(b, "Closing stopped", 30000);
    await a.evaluate(() => window.__release());
    await sleep(2500);
    const t = await a.$eval("#flowBody", (e) => e.textContent).catch(() => "");
    problems.push(...ok(t.includes("Another Leadership page took over closing."), `page A says: ${t}`));
    const copy = JSON.parse(copyText).data;
    problems.push(...ok(JSON.stringify(sorted(await emu.listCollection("interviews_screening"))) === JSON.stringify(sorted(copy.interviews_screening)), "the frozen chunk deleted something"));
    problems.push(...ok((await emu.getDocument("interviews_meta/state")).roundStatus === "open", "round not open"));
    await closePage(a); await closePage(b);
    return [...problems, ...log];
  },

  // The sleeping laptop (review 3 M1): A is frozen at step 6 with its timers
  // held; B takes over, carries on and clears one chunk; A wakes. A's heartbeat,
  // idle auto-stop and "Stop closing" all fail, each guard on its own (the wake
  // check, closeTx's own check, and the rules); B then finishes normally.
  async sleepingLaptop() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { renewMs: 600000, idleMs: 1 } });
    await asLeadership(a);
    await closeViaDialog(a, { stopAtStep6: true });
    await staleLease();
    const b = await freshPage({ log, timing: { staleMs: 800, renewMs: 600000 } });
    await asLeadership(b);
    await b.evaluate(() => { window.__edRounds.hooks.beforeChunk = (coll) => (coll === "interviews_scores" ? new Promise((r) => { window.__releaseB = r; }) : null); });
    await b.waitForFunction(() => (document.querySelector("#roundLine") || {}).textContent.includes("Nothing has been cleared"), { timeout: 15000 });
    await b.evaluate(() => window.IV.roundTakeover("finish"));
    await waitFlow(b, "Now save the backup", 30000);
    await finishFromStep5(b, { noWait: true });
    await b.waitForFunction(() => !!window.__releaseB, { timeout: 20000 });     // B cleared candidates and screening
    // (1) the wake check: A's heartbeat and idle auto-stop (idleMs 1 ms) stand down
    await a.evaluate(() => window.__edRounds.tick());
    const t1 = await a.$eval("#flowBody", (e) => e.textContent).catch(() => "");
    problems.push(...ok(t1.includes("Another Leadership page took over closing."), `A after waking: ${t1}`));
    // (2) closeTx's own check, without the wake check: A's "Stop closing" write
    const r2 = await a.evaluate(() => window.__edRounds._tx(["saved", "clearing"], (w) => w.attempt({ status: "abandoned" })).then(() => "wrote", (e) => e.code));
    problems.push(...ok(r2 === "took-over", `closeTx let a stale page write: ${r2}`));
    // (3) the rules, without either: a direct write with A's own claim
    const r3 = await a.evaluate(async () => {
      const s = window.__edStore, f = s._fb;
      try { await f.setDoc(f.doc(f.db, "interviews_meta", "state"), { roundStatus: "open", closingTab: null, lease: { tab: sessionStorage.getItem("ed_iv_tab"), load: "x", at: f.serverTimestamp() } }, { merge: true }); return "wrote"; }
      catch (e) { return e.code; }
    });
    problems.push(...ok(r3 === "permission-denied", `the rules let a stale page reopen the round: ${r3}`));
    const r4 = await a.evaluate(async () => { const f = window.__edStore._fb;
      try { await f.updateDoc(f.doc(f.db, "interviews_meta", "state"), { roundStatus: "open", closingTab: null }); return "wrote"; } catch (e) { return e.code; } });
    problems.push(...ok(r4 === "permission-denied", `a plain state write during a close was accepted: ${r4}`));
    const st = await emu.getDocument("interviews_meta/state");
    const att = (await emu.listCollection("interviews_archive"))[st.closingAttemptId];
    problems.push(...ok(st.roundStatus === "closing" && att && att.status === "clearing", `after A woke: ${st.roundStatus} / ${att && att.status}`));
    await b.evaluate(() => window.__releaseB());
    await waitFlow(b, "Round closed", 30000);
    problems.push(...ok((await emu.getDocument("interviews_meta/state")).roundStatus === "open", "B didn't finish"));
    await closePage(a); await closePage(b);
    return [...problems, ...log];
  },

  // Reload the closing page at step 5 and in step 8: still the holder, it carries
  // on with no takeover. Duplicate the tab: the newer copy continues; the older
  // says so and none of its writes land.
  async reloadAndDuplicate() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { renewMs: 600000 } });
    await asLeadership(a);
    await closeViaDialog(a, { stopAtStep5: true });
    await a.reload({ waitUntil: "domcontentloaded" }); await a.waitForFunction("window.__edReady === true");
    await waitFlow(a, "Now save the backup", 20000);
    problems.push(...ok(true, ""));
    // duplicate: a second page in the SAME browser profile with the same tab id
    const dup = await a._ctx.newPage();
    // a browser's Duplicate copies the whole sessionStorage: the tab id and
    // Firebase's tab-only sign-in, so the copy resumes signed in (R7)
    const copied = await a.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))));
    await dup.evaluateOnNewDocument((all) => {
      if (!sessionStorage.getItem("ed_iv_tab")) for (const [k, v] of Object.entries(JSON.parse(all))) sessionStorage.setItem(k, v);
      globalThis.__edRoundsTiming = { renewMs: 600000 };
    }, copied);
    await dup.goto(SRV.url, { waitUntil: "domcontentloaded" }); await dup.waitForFunction("window.__edReady === true");
    await waitFlow(dup, "Now save the backup", 20000);
    await sleep(1000);
    const t = await a.$eval("#flowBody", (e) => e.textContent).catch(() => "");
    problems.push(...ok(t.includes("This close is continuing in another copy of this page."), `older copy says: ${t}`));
    const r = await a.evaluate(() => window.__edRounds._tx(null, () => {}).then(() => "wrote", (e) => e.code));
    problems.push(...ok(r === "took-over", `the older copy could still write: ${r}`));
    await finishFromStep5(dup);
    problems.push(...ok((await emu.getDocument("interviews_meta/state")).roundStatus === "open", "the newer copy didn't finish"));
    await closePage(dup); await closePage(a);
    return [...problems.filter(Boolean), ...log];
  },

  // Two pages whose clocks differ by 6 minutes: the viewer never offers a
  // takeover while the holder is renewing (staleness is "unchanged for 5
  // minutes on MY clock", never a comparison of two clocks).
  async clockSkew() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { renewMs: 400 } });
    await asLeadership(a);
    await closeViaDialog(a, { stopAtStep5: true });
    const v = await freshPage({ log, timing: { staleMs: 3000 }, skewMs: 6 * 60000 });
    await asLeadership(v);
    await sleep(6000);
    const t = await v.$eval("#roundLine", (e) => e.textContent);
    problems.push(...ok(t.includes("Leadership (another page) is closing the round now.") && !t.includes("Finish closing"), `viewer: ${t}`));
    await a.evaluate(() => [...document.querySelectorAll("#flowBtns button")].find((x) => x.textContent === "Stop closing").click());
    await waitFlow(a, "Closing stopped", 15000);
    await closePage(a); await closePage(v);
    return [...problems, ...log];
  },

  // A write from an older (pre-R6) leadership page during clearing is kept,
  // listed, quarantined, and removable only by "Delete them" with the name typed.
  async keptItemDuringClear() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log, timing: { renewMs: 600000 } });
    await asLeadership(a);
    await a.evaluate(() => { window.__edRounds.hooks.beforeChunk = (coll) => (coll === "interviews_screening" ? new Promise((r) => { window.__go = r; }) : null); });
    await closeViaDialog(a, { stopBeforeDone: true });
    await a.waitForFunction(() => !!window.__go, { timeout: 15000 });
    await emu.setDocument("interviews_screening/Bruns~c-1", { member: "Bruns", candId: "c-1", rating: 5 });   // the older page's write
    await a.evaluate(() => window.__go());
    await waitFlow(a, "Round closed", 30000);
    const st = await emu.getDocument("interviews_meta/state");
    problems.push(...ok((st.keptFromClose || []).length === 1 && st.keptFromClose[0].id === "Bruns~c-1", `kept: ${JSON.stringify(st.keptFromClose)}`));
    problems.push(...ok(!!(await emu.getDocument("interviews_screening/Bruns~c-1")), "the changed item was deleted"));
    await a.evaluate(() => document.querySelector("#flowBtns button").click());
    await a.evaluate(() => { document.querySelector("#setupBtn").click(); });
    await sleep(300);
    await a.evaluate(() => { const d = document.querySelector('details[data-sec="setRound"]'); d.open = true; });
    await a.evaluate(() => { const orig = URL.createObjectURL; URL.createObjectURL = () => "blob:stub"; HTMLAnchorElement.prototype.click = function () {};
      [...document.querySelectorAll('details[data-sec="setRound"] button')].find((b) => b.textContent === "Download and delete them").click(); });
    await waitFlow(a, "Delete the kept items", 10000);
    const go = await a.$eval("#kdGo", (b) => b.disabled);
    await a.type("#kdIn", "Hiring round 2026");
    await flowClick(a, "Delete them");
    await until(async () => !(await emu.getDocument("interviews_screening/Bruns~c-1")));
    problems.push(...ok(go, "Delete them was enabled before the name was typed"));
    problems.push(...ok(!(await emu.getDocument("interviews_screening/Bruns~c-1")) && !((await emu.getDocument("interviews_meta/state")).keptFromClose || []).length, "kept item not deleted"));
    await closePage(a);
    return [...problems, ...log];
  },

  // Restore "missing items only" after a candidate was deleted by mistake, under
  // the real rules (history comes back marked restored); another round's file is
  // refused for that mode.
  async restoreMissingItems() {
    const problems = [], log = [];
    await seedRound();
    const a = await freshPage({ log });
    await asLeadership(a);
    const text = await nextDownload(a, "window.IV.downloadBackup()");
    const fs = await import("node:fs");
    await fetch(`${emu.FS}/v1/projects/${emu.PROJECT}/databases/(default)/documents/interviews_candidates/c-2`, { method: "DELETE", headers: { authorization: "Bearer owner" } });
    await fetch(`${emu.FS}/v1/projects/${emu.PROJECT}/databases/(default)/documents/interviews_history/h1`, { method: "DELETE", headers: { authorization: "Bearer owner" } });
    const pick = async (t) => {
      const f = `/tmp/hiring-emu-restore-${Date.now()}.json`; fs.writeFileSync(f, t);
      await a.evaluate(() => { if (document.querySelector("#setupModal").classList.contains("hidden")) document.querySelector("#setupBtn").click(); });
      await sleep(200);
      await a.evaluate(() => { const d = document.querySelector('details[data-sec="setRestore"]'); d.open = true; });
      await (await a.$("#rsFile")).uploadFile(f);
      await a.waitForFunction(() => /In the file|isn't|changed after/.test((document.querySelector('details[data-sec="setRestore"]') || {}).textContent || ""), { timeout: 10000 });
      return a.$eval('details[data-sec="setRestore"]', (e) => e.textContent);
    };
    await pick(text);
    await a.evaluate(() => [...document.querySelectorAll('details[data-sec="setRestore"] button')].find((b) => b.textContent === "Restore").click());
    const back = await until(() => emu.getDocument("interviews_candidates/c-2"));
    problems.push(...ok(back && back.name === "Dr Ben Carter", "the candidate didn't come back"));
    const h = await until(() => emu.getDocument("interviews_history/h1"));
    problems.push(...ok(h && h.restored === true && h.at.__ts.startsWith("2026-10-10"), `history: ${JSON.stringify(h)}`));
    const other = JSON.parse(text); other.round.id = "r-other";
    const card = await pick(JSON.stringify(other));
    problems.push(...ok(card.includes("not the round you are working on"), "another round's file was offered for missing items"));
    await closePage(a);
    return [...problems, ...log];
  },
};

// ---- R6 helpers -------------------------------------------------------------------
const CLEAR = ["interviews_candidates", "interviews_screening", "interviews_scores", "interviews_availIv",
  "interviews_availCand", "interviews_offers", "interviews_applicant", "interviews_history"];
// documents in a stable order, with every timestamp written the same way
const normTs = (x) => (x === null || typeof x !== "object" ? x : Array.isArray(x) ? x.map(normTs)
  : typeof x.__ts === "string" ? { __ts: new Date(x.__ts).toISOString() } : Object.fromEntries(Object.keys(x).sort().map((k) => [k, normTs(x[k])])));
const sorted = (o) => normTs(Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b))));
async function seedRound() {
  await emu.seed({
    "interviews_meta/config": { committee: COMMITTEE, chair: "Abara", times: TIMES, slots: [], oneDrive: "https://onedrive.example/x", panelOverrides: {},
      flagThreshold: 2, retentionMonths: 24 },
    "interviews_meta/state": { interviewsComplete: true, roundId: "r-2026", roundName: "Hiring round 2026" },
    "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] },
    "interviews_meta/passwords": { ed: { changedAt: { __ts: "2026-10-01T00:00:00.000Z" } } },
    "interviews_meta/schedule": { locked: true, lockedAt: { __ts: "2026-10-10T00:00:00.000Z" }, panels: {} },
    "interviews_screening/Bruns~c-1": { member: "Bruns", candId: "c-1", rating: 4 },
    "interviews_screening/Chen~c-2": { member: "Chen", candId: "c-2", flag: true, reason: "Short ED time" },
    "interviews_scores/Abara~c-1": { member: "Abara", candId: "c-1", overall: 4.2, notes: { 0: "Clear" } },
    "interviews_availIv/Abara": { slots: { t0: "ip" } },
    "interviews_availCand/ashcombe": { slots: { t0: "ip" }, reply: "confirmed", replyAt: { __ts: "2026-10-12T10:00:00.000Z" } },
    "interviews_offers/c-1": { status: "offered", offeredAt: "2026-10-10" },
    "interviews_applicant/ashcombe": { date: TIMES[0].date, start: "09:00", end: "10:00", format: "ip" },
    "interviews_history/h1": { at: { __ts: "2026-10-10T00:00:00.000Z" }, by: "leadership", action: "schedule.lock", text: "Locked the schedule" },
  });
}
async function metaNow() {
  const m = await emu.listCollection("interviews_meta");
  return { config: m.config, state: m.state, questions: m.questions, passwords: m.passwords, schedule: m.schedule };
}
async function staleLease() {
  const st = await emu.getDocument("interviews_meta/state");
  st.lease = { ...st.lease, at: { __ts: new Date(Date.now() - 6 * 60000).toISOString() } };
  await emu.setDocument("interviews_meta/state", st);
}
const waitFlow = (p, title, timeout = 15000) => p.waitForFunction((t) => (document.querySelector("#flowTitle") || {}).textContent === t, { timeout }, title);
const flowClick = (p, label) => p.evaluate((label) => {
  const b = [...document.querySelectorAll("#flowBtns button")].find((x) => x.textContent.trim() === label);
  if (!b) throw new Error(`no dialog button "${label}"`); b.click();
}, label);
async function finishFromStep5(p, { noWait } = {}) {
  await p.evaluate(() => { const o = URL.createObjectURL; URL.createObjectURL = () => "blob:stub"; HTMLAnchorElement.prototype.click = function () {}; });
  await p.click("#clSaved"); await flowClick(p, "Next");
  await waitFlow(p, "Close the round");
  const name = await p.$eval("#flowBody b", (e) => e.textContent);
  await p.type("#clName", name);
  await flowClick(p, "Close the round");
  if (!noWait) await waitFlow(p, "Round closed", 30000);
}
// Drives the dialog; returns the backup file's text.
async function closeViaDialog(p, { stopAtStep5, stopAtStep6, stopBeforeDone } = {}) {
  await p.evaluate(() => window.IV.closeRound());
  await waitFlow(p, "Close the round?"); await flowClick(p, "Continue");
  await waitFlow(p, "Now save the backup", 30000);
  if (stopAtStep5) return null;
  const text = await nextDownload(p, "document.getElementById('clBackup').click()");
  await p.click("#clSaved"); await flowClick(p, "Next");
  await waitFlow(p, "Close the round");
  const name = await p.$eval("#flowBody b", (e) => e.textContent);
  await p.type("#clName", name);
  if (stopAtStep6) return text;
  await flowClick(p, "Close the round");
  if (!stopBeforeDone) await waitFlow(p, "Round closed", 30000);
  return text;
}

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
