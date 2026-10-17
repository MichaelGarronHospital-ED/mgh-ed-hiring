// H3: the ED tools passwords page (passwords.html) end to end, on the REAL page
// (FirestoreStore, Firebase Auth, the real firestore.rules) against the local
// emulators. The order on the page: tick the passwords, type the CURRENT ones
// and Check (changes nothing), then, only after Check passed, the new ones and
// Change now.
//
//   npm run passwords                 (builds sim/site-emulator, starts the Auth and
//                                      Firestore emulators, runs every case, stops them)
//   npm run passwords -- <outdir>     (also saves screenshots of each step there)
//
// Two Firebase apps: the page's own (hiring) and a helper per account, the voting
// ones built from Motion Voting's config (project id switched to
// ed-motion-voting-test in the copy). The Auth emulator maps every API key to its
// default project, so the two voting accounts are created there; they are still
// reached through separate, memory-only helper apps, as live.
//
// The emulator does not enforce Firebase's 5-minute "recent sign-in" rule; that
// is pinned by tests/passwords.test.mjs with a fake clock.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { serve, browser, signIn, landAsAdmin, sleep } from "./drive.mjs";
import * as emu from "./emu.mjs";
import { baseDocs } from "./emulator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, "site-emulator");
const OUT = process.argv[2] || "";
if (OUT) fs.mkdirSync(OUT, { recursive: true });

// test values only (the emulator's; nothing real)
const OLD = { leadership: "lead-old-test-1", ed: "ed-old-test-22", guest: "guest-old-test-3" };   // long enough for the leak check to mean something
const NEW = { leadership: "harbour lantern violet", ed: "river stone lamp forty", guest: "maple window seven" };
const ACCTS = [
  ["voting:ed", "ed@ed-motion-voting.app", "ed"], ["voting:leadership", "leadership@ed-motion-voting.app", "leadership"],
  ["hiring:committee", "committee@ed-hiring.app", "ed"], ["hiring:applicant", "applicant@ed-hiring.app", "guest"],
  ["hiring:admin", "admin@ed-hiring.app", "leadership"],
];
const ok = (cond, msg) => (cond ? [] : [msg]);

async function signInWorks(email, password) {
  const r = await fetch(`${emu.AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return r.ok;
}
async function reset() {
  await emu.clearFirestore(); await emu.clearAuth();
  for (const [, email, role] of ACCTS) await emu.addUser(email, OLD[role]);
  await emu.seed({ ...baseDocs(),
    "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] } });
}

let B, SRV, PAGE;
async function freshPage(width, log, scheme = "light", url = null) {
  const ctx = await B.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: width < 500 ? 844 : 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  // refused sign-ins show as failed requests to the Auth emulator: expected
  const refusal = (m) => /status of 400/.test(m.text()) && String((m.location() || {}).url || "").includes(":9099/");
  page.on("console", (m) => { if (!refusal(m)) log.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(url || PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 20000 });
  page._ctx = ctx; page._scheme = scheme;
  return page;
}
const closePage = async (p) => { try { await p._ctx.close(); } catch { /* gone */ } };
const waitFlow = (p, t, timeout = 20000) => p.waitForFunction((t) => (document.querySelector("#flowTitle") || {}).textContent === t, { timeout }, t);
const flowClick = (p, label) => p.evaluate((label) => {
  const b = [...document.querySelectorAll("#flowBtns button")].find((x) => x.textContent.trim() === label);
  if (!b) throw new Error(`no dialog button "${label}" (have: ${[...document.querySelectorAll("#flowBtns button")].map((x) => x.textContent).join("|")})`); b.click();
}, label);
async function onPage(p) { await p.waitForSelector("#pwApp:not(.hidden) .pwcard", { timeout: 15000 }); await sleep(200); }
const cardText = (p) => p.$eval("#pwApp", (e) => e.textContent);
async function shot(p, name) {
  if (!OUT) return;
  const w = p.viewport().width;
  await p.screenshot({ path: path.join(OUT, `pwpage-${name}-${w < 500 ? "phone" : "desktop"}-${p._scheme || "light"}.png`), fullPage: false });
  const scroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (scroll) console.log(`HORIZONTAL SCROLL: ${name} ${w}`);
}
async function type(p, id, v) { await p.$eval("#" + id, (e) => { e.value = ""; }); await p.type("#" + id, v); }
async function fillCurrent(p) { for (const r of ["leadership", "ed", "guest"]) await type(p, "pwCur_" + r, OLD[r]); }
async function fillNew(p, roles) { for (const r of roles) { await type(p, "pwNew_" + r, NEW[r]); await type(p, "pwRep_" + r, NEW[r]); } }
async function tick(p, roles) {
  await p.evaluate((roles) => document.querySelectorAll("#flowBody .pwtick input").forEach((i) => { i.checked = roles.includes(i.value); }), roles);
}
// the message line: its text, whether it is in the viewport, and what has focus
const msgState = (p) => p.evaluate(() => {
  const e = document.querySelector("#pwErr"); if (!e) return { text: "", inView: false, focus: "" };
  const r = e.getBoundingClientRect();
  return { text: e.textContent, inView: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight, focus: (document.activeElement || {}).id || "", role: e.getAttribute("role") };
});
// tick, type the current values, Check: lands on the new-values step
async function toNewValues(p, roles) {
  await p.evaluate(() => { window.PW.change(); });
  await waitFlow(p, "Which password?"); await tick(p, roles);
  await flowClick(p, "Next"); await waitFlow(p, "Check the current passwords");
  await fillCurrent(p);
  await flowClick(p, "Check"); await waitFlow(p, "Type the new passwords", 30000);
}
// no password value anywhere the page could have written it
async function noLeaks(p, log, values) {
  const problems = [];
  const stor = await p.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
  const docs = [];
  for (const c of ["interviews_meta", "interviews_history", "interviews_public"]) docs.push(JSON.stringify(await emu.listCollection(c)));
  for (const v of values) {
    problems.push(...ok(!stor.includes(v), `a password value is in browser storage`));
    problems.push(...ok(!docs.join().includes(v), `a password value is in Firestore`));
    problems.push(...ok(!log.join("\n").includes(v), `a password value reached the console`));
  }
  return problems;
}

const cases = {
  // Leadership only: the ED password doesn't open the page; coming from
  // Physician Hiring signed in as Leadership in the same tab needs no new sign-in.
  async signInRules() {
    const problems = [], log = [];
    await reset();
    if (OUT) { const d = await freshPage(390, log, "dark"); await sleep(400); await shot(d, "gate"); await closePage(d); }
    const p = await freshPage(390, log);
    await sleep(400); await shot(p, "gate");
    await signIn(p, OLD.ed); await sleep(1200);
    const msg = await p.$eval("#gerr", (e) => e.textContent);
    problems.push(...ok(msg.includes("Incorrect password.") && msg.includes("Leadership"), `ED password: ${msg}`));
    await signIn(p, OLD.leadership); await onPage(p);
    await closePage(p);
    const h = await freshPage(1280, log, "light", SRV.url);
    await signIn(h, OLD.leadership); await landAsAdmin(h); await sleep(300);
    await h.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
    const link = await h.$eval('details[data-sec="setPasswords"] a', (a) => a.getAttribute("href")).catch(() => "");
    problems.push(...ok(link === "passwords.html", `the Setup card doesn't link to the page: ${link}`));
    await h.goto(PAGE, { waitUntil: "domcontentloaded" }); await onPage(h);
    await closePage(h);
    return [...problems, ...log.filter((l) => /^pageerror/.test(l))];
  },

  // Change the ED password, at 390 px (light and dark when shooting) and 1280 px.
  // Check needs only the current values and says so where it can be seen;
  // the new values come after Check passed.
  async changeEd() {
    const problems = [], log = [];
    const runs = OUT ? [[390, "light"], [390, "dark"], [1280, "light"]] : [[390, "light"], [1280, "light"]];
    for (const [w, scheme] of runs) {
      await reset();
      const p = await freshPage(w, log, scheme);
      await signIn(p, OLD.leadership); await onPage(p);
      const card = await cardText(p);
      problems.push(...ok(card.includes("Not changed here yet") && card.includes("Change a password"), `card: ${card.slice(0, 200)}`));
      await shot(p, "card");
      await p.evaluate(() => { window.PW.change(); });
      await waitFlow(p, "Which password?"); await tick(p, ["ed"]); await shot(p, "step1");
      await flowClick(p, "Next"); await waitFlow(p, "Check the current passwords");
      problems.push(...ok(!(await p.$("#pwNew_ed")), "the new-password fields are asked for before Check"));
      await shot(p, "step2");
      // Check with a current value missing: the message is in view, right above the buttons
      await type(p, "pwCur_leadership", OLD.leadership);
      await flowClick(p, "Check"); await sleep(300);
      let m = await msgState(p);
      problems.push(...ok(m.text.includes("Type the current ED password.") && m.inView && m.focus === "pwCur_ed" && m.role === "alert", `error after Check: ${JSON.stringify(m)}`));
      await shot(p, "step2-error");
      await fillCurrent(p);
      await p.evaluate(() => document.querySelector("#flowBody .pwfield button").click());   // Show
      problems.push(...ok((await p.$eval("#pwCur_leadership", (e) => e.type)) === "text", "Show didn't show"));
      await p.evaluate(() => document.querySelector("#flowBody .pwfield button").click());
      // Checking... shows at once
      const busy = await p.evaluate(() => { const b = document.querySelector("#pwCheck"); b.click(); return [b.textContent, b.disabled, (document.querySelector("#pwErr") || {}).textContent]; });
      problems.push(...ok(busy[0] === "Checking..." && busy[1] && /Checking each account/.test(busy[2]), `no Checking state: ${busy}`));
      if (OUT) { await sleep(60); await shot(p, "checking"); }
      await waitFlow(p, "Type the new passwords", 30000);
      const ready = await p.$eval("#flowBody", (e) => e.textContent);
      // both ED accounts, then Physician Hiring's Guest and Leadership accounts (unticked, proven too)
      problems.push(...ok((ready.match(/: ready/g) || []).length === 4 && ready.includes("Motion Voting, ED account") && ready.includes("Physician Hiring, Guest account")
        && !ready.includes("Motion Voting, Leadership account"), `ready: ${ready}`));
      problems.push(...ok(await signInWorks("committee@ed-hiring.app", OLD.ed), "Check changed something"));
      await shot(p, "step3");
      await type(p, "pwNew_ed", NEW.ed); await type(p, "pwRep_ed", NEW.ed + "x");
      await flowClick(p, "Change now"); await sleep(300);
      m = await msgState(p);
      problems.push(...ok(m.text.includes("don't match") && m.inView && m.focus === "pwRep_ed", `mismatch: ${JSON.stringify(m)}`));
      await shot(p, "step3-error");
      await type(p, "pwRep_ed", NEW.ed);
      await flowClick(p, "Change now"); await waitFlow(p, "Done", 30000);
      const done = await p.$eval("#flowBody", (e) => e.textContent);
      problems.push(...ok(done.includes("The new ED password works in Motion Voting and Physician Hiring.") && done.includes("Never email a password"), `done: ${done}`));
      problems.push(...ok(!(await p.$eval("#pwNote", (e) => e.value)).includes(NEW.ed), "the copy-ready message carries the password"));
      await shot(p, "done");
      for (const [, email, role] of ACCTS) {
        const want = role === "ed" ? NEW.ed : OLD[role];
        problems.push(...ok(await signInWorks(email, want), `${email} doesn't take ${role === "ed" ? "the new" : "its old"} password`));
      }
      const meta = await emu.getDocument("interviews_meta/passwords");
      problems.push(...ok(meta && meta.ed && meta.ed.changedAt && meta.pending === null && !meta.leadership, `passwords doc: ${JSON.stringify(meta)}`));
      const h = Object.values(await emu.listCollection("interviews_history")).filter((e) => e.action === "passwords.change");
      problems.push(...ok(h.length === 1 && h[0].text === "Changed the ED password", `history: ${JSON.stringify(h)}`));
      await flowClick(p, "Close"); await sleep(500);
      const after = await cardText(p);
      problems.push(...ok(/ED: last changed \w{3} \d+, \d{4}/.test(after), `card after: ${after.slice(0, 200)}`));
      problems.push(...await noLeaks(p, log, [...Object.values(OLD), ...Object.values(NEW)]));
      await closePage(p);
    }
    return [...problems, ...log.filter((l) => /^pageerror|console\.error/.test(l))];
  },

  // Phone: change all three; the network drops before the third account
  // changes; the dialog says exactly what is half done; the tab is closed; a
  // new tab (old Leadership password still works, admin@ is changed last)
  // sees the unfinished change and finishes it.
  async networkCutThenFinishInNewTab() {
    const problems = [], log = [];
    for (const scheme of ["light", "dark"]) {
      if (scheme === "dark" && !OUT) break;
      await reset();
      const p = await freshPage(390, log, scheme);
      await signIn(p, OLD.leadership); await onPage(p);
      await toNewValues(p, ["leadership", "ed", "guest"]);
      await fillNew(p, ["leadership", "ed", "guest"]);
      // let two password updates through, then cut the connection to Auth
      let updates = 0;
      await p.setRequestInterception(true);
      p.on("request", (req) => {
        const u = req.url();
        if (u.startsWith(emu.AUTH) && u.includes("accounts:update") && req.method() === "POST") {
          updates++; if (updates > 2) return req.abort("internetdisconnected");
        }
        if (updates > 2 && u.startsWith(emu.AUTH)) return req.abort("internetdisconnected");
        req.continue();
      });
      await flowClick(p, "Change now"); await waitFlow(p, "Not finished", 30000);
      const half = await p.$eval("#flowBody", (e) => e.textContent);
      problems.push(...ok(half.includes("The Leadership password is new in Motion Voting but still old in Physician Hiring.")
        && half.includes("The ED password is new in Motion Voting but still old in Physician Hiring.") && half.includes("Try again to finish"), `half: ${half}`));
      await shot(p, "not-finished");
      const pend = await emu.getDocument("interviews_meta/passwords");
      problems.push(...ok(pend && pend.pending && pend.pending.done.join() === "voting:ed,voting:leadership" && pend.pending.inProgress === "hiring:committee",
        `pending: ${JSON.stringify(pend)}`));
      problems.push(...ok(!(await signInWorks("committee@ed-hiring.app", NEW.ed)), "the cut update went through anyway"));
      await closePage(p);

      // a new tab, a new browser even
      const q = await freshPage(390, log, scheme);
      await signIn(q, OLD.leadership); await onPage(q);
      const card = await cardText(q);
      problems.push(...ok(/A password change didn't finish \(started \w{3} \d+, \d{4}\)/.test(card) && card.includes("Finish the change"), `card: ${card.slice(0, 200)}`));
      problems.push(...ok(!card.includes("Change a password"), "a new change can still be started over the unfinished one"));
      await shot(q, "pending-card");
      await q.evaluate(() => { window.PW.change(); });
      await waitFlow(q, "Finish the password change");
      const btns = await q.$$eval("#flowBtns button", (b) => b.map((x) => x.textContent.trim()));
      problems.push(...ok(!btns.includes("Back") && !(await q.$("#pwNew_ed")), `finishing: Back offered or new fields early: ${btns}`));
      await fillCurrent(q);
      await shot(q, "finish-current");
      await flowClick(q, "Next"); await waitFlow(q, "Finish the password change");
      await q.waitForSelector("#pwNew_ed");
      await fillNew(q, ["leadership", "ed", "guest"]);
      await shot(q, "finish-new");
      await flowClick(q, "Finish the change"); await waitFlow(q, "Done", 30000);
      for (const [, email, role] of ACCTS) problems.push(...ok(await signInWorks(email, NEW[role]), `${email} doesn't take the new ${role} password`));
      const meta = await emu.getDocument("interviews_meta/passwords");
      problems.push(...ok(meta && meta.pending === null && meta.leadership && meta.ed && meta.guest, `passwords doc: ${JSON.stringify(meta)}`));
      const h = Object.values(await emu.listCollection("interviews_history")).filter((e) => e.action === "passwords.change");
      problems.push(...ok(h.length === 1 && h[0].text === "Changed the Leadership, ED and Guest passwords", `history: ${JSON.stringify(h)}`));
      problems.push(...await noLeaks(q, log, [...Object.values(OLD), ...Object.values(NEW)]));
      await flowClick(q, "Close");
      await closePage(q);
      // the old Leadership password no longer opens the page; the new one does
      const r = await freshPage(390, log);
      await signIn(r, OLD.leadership); await sleep(1500);
      problems.push(...ok((await r.$eval("#gerr", (e) => e.textContent)).includes("Incorrect password."), "the old Leadership password still signs in"));
      await signIn(r, NEW.leadership); await onPage(r);
      await closePage(r);
    }
    return [...problems, ...log.filter((l) => /^pageerror/.test(l))];
  },

  // Another page starts a change of other passwords while this dialog is open:
  // Change now refuses rather than overwrite that page's record.
  async secondPageCantOverwrite() {
    const problems = [], log = [];
    await reset();
    const p = await freshPage(1280, log);
    await signIn(p, OLD.leadership); await onPage(p);
    await toNewValues(p, ["ed"]);
    await fillNew(p, ["ed"]);
    await emu.setDocument("interviews_meta/passwords", { pending: { roles: ["guest"], startedAt: { __ts: new Date().toISOString() }, done: ["hiring:applicant"], inProgress: null } });
    await flowClick(p, "Change now"); await waitFlow(p, "Nothing was changed");
    problems.push(...ok(await signInWorks("committee@ed-hiring.app", OLD.ed) && await signInWorks("ed@ed-motion-voting.app", OLD.ed), "an ED account changed anyway"));
    const meta = await emu.getDocument("interviews_meta/passwords");
    problems.push(...ok(meta.pending && meta.pending.roles.join() === "guest" && meta.pending.done.join() === "hiring:applicant", `the other record was overwritten: ${JSON.stringify(meta)}`));
    await closePage(p);
    return [...problems, ...log.filter((l) => /^pageerror/.test(l))];
  },

  // Check refuses when one tool already has a different password, and says
  // where; Back keeps what was typed; the expander takes that account's value.
  async driftIsCaughtByCheck() {
    const problems = [], log = [];
    for (const scheme of ["light", "dark"]) {
      if (scheme === "dark" && !OUT) break;
      await reset();
      await emu.clearAuth();
      for (const [, email, role] of ACCTS) await emu.addUser(email, email === "ed@ed-motion-voting.app" ? "an older ed value" : OLD[role]);
      const p = await freshPage(390, log, scheme);
      await signIn(p, OLD.leadership); await onPage(p);
      await p.evaluate(() => { window.PW.change(); });
      await waitFlow(p, "Which password?"); await tick(p, ["ed"]);
      await flowClick(p, "Next"); await waitFlow(p, "Check the current passwords");
      await fillCurrent(p);
      await flowClick(p, "Check"); await waitFlow(p, "Nothing was changed", 30000);
      const t = await p.$eval("#flowBody", (e) => e.textContent);
      problems.push(...ok(t.includes("Motion Voting's ED account didn't accept the current ED password, so nothing was changed.") && t.includes("refused"), `check: ${t}`));
      await shot(p, "drift");
      await flowClick(p, "Back"); await waitFlow(p, "Check the current passwords");
      problems.push(...ok((await p.$eval("#pwCur_ed", (e) => e.value)) === OLD.ed, "Back lost what was typed"));
      await p.evaluate(() => { document.querySelector(".pwdrift").open = true; });
      await type(p, "pwOv_voting_ed", "an older ed value");
      await shot(p, "step2-drift-open");
      await flowClick(p, "Check"); await waitFlow(p, "Type the new passwords", 30000);
      await fillNew(p, ["ed"]);
      await flowClick(p, "Change now"); await waitFlow(p, "Done", 30000);
      problems.push(...ok(await signInWorks("ed@ed-motion-voting.app", NEW.ed) && await signInWorks("committee@ed-hiring.app", NEW.ed), "drifted account not brought in line"));
      await closePage(p);
    }
    return [...problems, ...log.filter((l) => /^pageerror/.test(l))];
  },
};

await emu.loadRules();
SRV = await serve(SITE);
PAGE = SRV.url.replace(/index\.html$/, "passwords.html");
B = await browser();
let fails = 0;
try {
  for (const [name, fn] of Object.entries(cases)) {
    let problems;
    try { problems = await fn(); } catch (e) { problems = [`threw: ${e.stack || e.message}`]; }
    if (problems.length) fails++;
    console.log(`${problems.length ? "FAIL" : "pass"}  ${name}${problems.length ? "\n  " + problems.join("\n  ") : ""}`);
  }
} finally { await B.close(); SRV.close(); }
console.log(fails ? `\n${fails} password case(s) failed` : `\n${Object.keys(cases).length}/${Object.keys(cases).length} password cases pass`);
process.exit(fails ? 1 : 0);
