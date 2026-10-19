// R14: Log out, to the ED tools standard, through the real UI on LocalStore.
//   - every signed-in screen has exactly one Log out: the shared plain text
//     button (`ed-btn ed-btn-plain`, type="button", the words "Log out"), the
//     last item at the top right, on one line, nothing overlapping it, no
//     sideways scroll, the title beside it on one line, at 320, 390 and 1280 px.
//     That includes the two screens that had none: "Who are you?" and the
//     applicant's name screen (and the paused screen, whose Log out moved out
//     of the card to the top right);
//   - while it waits for saves the button is disabled and reads "Logging out…",
//     also after the applicant's page redraws underneath it;
//   - saves still unconfirmed after 5 seconds ask "Log out?" with "Stay" and
//     "Log out anyway"; Stay gives the button back and logs nothing out;
//   - saves that land in time log out with no question;
//   - the gate then says "You are logged out." (plus the scores line when this
//     device held scores).
// Saves are held back by a patch to the COPY's LocalStore (site-logout/), never
// the repo's files: setScreening and setAvail wait while window.__hold is set.
// Run: node logout.mjs [name]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve, browser, openPage, signIn, pickMember, landAsAdmin, sleep, daysAhead, SITE } from "./drive.mjs";

const DIR = path.join(path.dirname(SITE), "site-logout");
function makeSite() {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.cpSync(SITE, DIR, { recursive: true });
  const p = path.join(DIR, "js/store.js"); let s = fs.readFileSync(p, "utf8");
  const local = s.indexOf("export class LocalStore"), fire = s.indexOf("export class FirestoreStore");
  for (const head of ["  async setScreening(member, candId, patch) {\n", "  async setAvail(kind, who, slot, mod) {\n"]) {
    const at = s.indexOf(head, local);
    if (at < 0 || at > fire) throw new Error(`LocalStore changed shape (${head.trim()}): update logout.mjs`);
    s = s.slice(0, at) + head + "    if (globalThis.__hold) await globalThis.__hold;\n" + s.slice(at + head.length);
  }
  fs.writeFileSync(p, s);
}

const COMMITTEE = [
  { name: "Abara", gender: "M" }, { name: "Bruns-Lee", gender: "F" }, { name: "Chen", gender: "M" },
  { name: "Dufour", gender: "F" }, { name: "Ekwueme", gender: "M" },
];
const TIMES = [{ id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" }, { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" }];
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Ben Carter", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: {}, availCand: {},
  settings: { committee: COMMITTEE, chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null, ...over,
});
const ok = (cond, msg) => (cond ? [] : [msg]);
const LOST = "Some changes haven't been saved yet. If you log out now they will be lost.";

async function load(page, url, state, code) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
  await page.goto("about:blank");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await signIn(page, code);
}
async function applicantIn(page, url, state) {
  await load(page, url, state, "guestpw");
  await page.waitForSelector("#candName");
  await page.type("#candFirst", "Rosalind"); await page.type("#candName", "Ashcombe");
  await page.click("#candGo");
  await page.waitForSelector("#candview header.page"); await sleep(300);
}
// the visible Log out buttons, and how the one there sits
const logoutAt = (page) => page.evaluate(() => {
  const vis = [...document.querySelectorAll("[data-logout]")].filter((b) => b.offsetParent !== null);
  if (vis.length !== 1) return { count: vis.length };
  const b = vis[0], r = b.getBoundingClientRect(), row = b.parentElement;
  const others = [...row.children].filter((x) => x !== b && x.offsetParent !== null);
  const overlap = others.some((x) => { const q = x.getBoundingClientRect(); return q.right > r.left + 0.5 && q.left < r.right && q.bottom > r.top && q.top < r.bottom; });
  const h1 = row.querySelector("h1"), lh = h1 ? parseFloat(getComputedStyle(h1).lineHeight) : 0;
  return { count: 1, text: b.textContent, cls: b.className, type: b.getAttribute("type"), disabled: b.disabled,
    last: row.lastElementChild === b, right: r.right, top: r.top, height: r.height, vw: innerWidth,
    scrollW: document.documentElement.scrollWidth, overlap, h1Lines: h1 ? Math.round(h1.getBoundingClientRect().height / lh) : 0 };
});
function placed(m, where) {
  if (m.count !== 1) return [`${where}: ${m.count} visible Log out buttons`];
  const p = [];
  if (m.text !== "Log out" || m.cls !== "ed-btn ed-btn-plain" || m.type !== "button" || m.disabled)
    p.push(`${where}: "${m.text}" class "${m.cls}" type ${m.type}${m.disabled ? " disabled" : ""}`);
  if (!m.last) p.push(`${where}: Log out is not the last item in its row`);
  // in the header's first row (the applicant's header centres it beside the title and name lines)
  if (m.top > 60) p.push(`${where}: Log out is not at the top (${Math.round(m.top)} px down)`);
  // at the header's right edge: the page edge on a phone, the 1040 px column on a wide screen
  if (m.right > m.vw || m.right < Math.min(m.vw, (m.vw + 1040) / 2) - 16) p.push(`${where}: Log out is not at the right (${Math.round(m.right)} of ${m.vw})`);
  if (m.height < 44 || m.height > 46) p.push(`${where}: Log out is ${Math.round(m.height)} px tall (one line, 44 px tap)`);
  if (m.scrollW > m.vw) p.push(`${where}: the page scrolls sideways (${m.scrollW} > ${m.vw})`);
  if (m.overlap) p.push(`${where}: something overlaps Log out`);
  // With the phones' own fonts (San Francisco, Roboto) the title stays on one line at 320 px
  // (checked in Chromium and WebKit for R14); the Linux runner's fallback font is wider and
  // puts "Physician Hiring" on two at 320 px, which is fine. Three lines would be squeezed.
  if (m.h1Lines > 2) p.push(`${where}: the title beside Log out is on ${m.h1Lines} lines`);
  return p;
}
const dialog = (page) => page.evaluate(() => ({ shown: !document.querySelector("#confirmWrap").classList.contains("hidden"),
  title: document.querySelector("#confirmTitle").textContent, msg: document.querySelector("#confirmMsg").textContent,
  no: document.querySelector("#confirmNo").textContent, yes: document.querySelector("#confirmYes").textContent }));
const hold = (page) => page.evaluate(() => { globalThis.__hold = new Promise((r) => { globalThis.__release = r; }); });
const release = (page) => page.evaluate(() => { globalThis.__hold = null; if (globalThis.__release) globalThis.__release(); });
const gateText = (page) => page.$eval("#gerr", (e) => e.textContent.trim());
const gateShown = (page) => page.$eval("#gate", (e) => !e.classList.contains("hidden"));
async function reloaded(page, act) {
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }), act()]);
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 }); await sleep(200);
}

const scenarios = {
  // Every signed-in screen, at a small phone, a large phone and a desktop.
  async everyScreen(page, url) {
    const problems = [];
    // not logged in yet: the gate has no Log out
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
    const onGate = await page.$$eval("[data-logout]", (bs) => bs.filter((b) => b.offsetParent !== null).length);
    problems.push(...ok((await gateShown(page)) && onGate === 0, `the gate shows ${onGate} Log out`));
    for (const w of [320, 390, 1280]) {
      await page.setViewport({ width: w, height: 800 });
      await load(page, url, base(), "staffpw");
      await page.waitForSelector("#memberpick:not(.hidden)"); await sleep(400);
      problems.push(...placed(await logoutAt(page), `${w} ED "Who are you?"`));
      await pickMember(page, "Chen");
      problems.push(...placed(await logoutAt(page), `${w} ED header`));
      await load(page, url, base(), "adminpw");
      await landAsAdmin(page);
      problems.push(...placed(await logoutAt(page), `${w} Admin header`));
      await page.click("#changeMember"); await page.waitForSelector("#memberpick:not(.hidden)"); await sleep(400);
      problems.push(...placed(await logoutAt(page), `${w} Admin "Who are you?"`));
      await page.select("#memberSel", "Chen"); await page.click("#memberBtn"); await page.waitForSelector("#app:not(.hidden)");
      problems.push(...placed(await logoutAt(page), `${w} Admin reviewing as a member`));
      await load(page, url, base(), "guestpw");
      await page.waitForSelector("#candName"); await sleep(400);
      problems.push(...placed(await logoutAt(page), `${w} applicant name screen`));
      await page.type("#candFirst", "Rosalind"); await page.type("#candName", "Ashcombe"); await page.click("#candGo");
      await page.waitForSelector("#candview header.page"); await sleep(300);
      problems.push(...placed(await logoutAt(page), `${w} applicant times`));
      await load(page, url, base({ booking: "paused", publicInfo: { booking: "paused" } }), "guestpw");
      await page.waitForFunction(() => /Booking is paused/.test(document.querySelector("#candview").textContent)); await sleep(400);
      problems.push(...placed(await logoutAt(page), `${w} applicant booking paused`));
      problems.push(...ok(!(await page.$("#candview .overlay-box [data-logout]")), `${w}: the paused card still has its own Log out`));
    }
    await page.setViewport({ width: 1280, height: 900 });
    return problems;
  },

  // A save still waiting: "Logging out…", then after 5 seconds the question.
  // Stay gives the button back; Log out anyway logs out.
  async waitsAndAsks(page, url) {
    const problems = [];
    await load(page, url, base(), "staffpw");
    await pickMember(page, "Chen");
    await hold(page);
    await page.evaluate(() => window.IV.rate("c-1", 3)); await sleep(100);
    await page.click("#logout"); await sleep(150);
    let m = await logoutAt(page);
    problems.push(...ok(m.text === "Logging out…" && m.disabled, `while waiting: "${m.text}", disabled ${m.disabled}`));
    // a second tap while it waits does nothing more
    await page.evaluate(() => document.querySelector("#logout").click());
    await sleep(4000);
    let d = await dialog(page);
    problems.push(...ok(!d.shown, "asked before the 5 seconds were up"));
    await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 3000 }).catch(() => {});
    d = await dialog(page);
    problems.push(...ok(d.shown && d.title === "Log out?" && d.msg === LOST && d.no === "Stay" && d.yes === "Log out anyway",
      `the question: ${JSON.stringify(d)}`));
    await page.click("#confirmNo"); await sleep(200);
    m = await logoutAt(page);
    problems.push(...ok(m.text === "Log out" && !m.disabled, `after Stay: "${m.text}", disabled ${m.disabled}`));
    problems.push(...ok(await page.$eval("#app", (e) => !e.classList.contains("hidden")), "Stay left the page"));
    problems.push(...ok(await page.evaluate(() => !!sessionStorage.getItem("ed_iv_localrole")), "Stay logged out anyway"));
    problems.push(...ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "logout"), "after Stay, focus is not back on Log out"));
    // the next dialog has its usual Cancel again
    const rel = await page.evaluate(() => fetch("version.json").then((r) => r.json()).then((j) => j.release));
    await page.evaluate((rel) => { import(`./js/util.js?v=${rel}`).then((u) => { u.confirmDialog("x"); }); }, rel); await sleep(200);
    d = await dialog(page);
    problems.push(...ok(d.shown && d.no === "Cancel", `the next dialog's cancel button says "${d.no}"`));
    await page.keyboard.press("Escape"); await sleep(100);
    // again, and this time log out anyway
    await page.click("#logout");
    await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 8000 });
    await reloaded(page, () => page.click("#confirmYes"));
    problems.push(...ok((await gateShown(page)) && (await gateText(page)) === "You are logged out.", `after Log out anyway: ${await gateText(page)}`));
    return problems;
  },

  // The save lands while it waits: logged out, no question.
  async savesLandNoQuestion(page, url) {
    const problems = [];
    await load(page, url, base(), "staffpw");
    await pickMember(page, "Chen");
    await hold(page);
    await page.evaluate(() => window.IV.rate("c-1", 4)); await sleep(100);
    // logged out by itself once the save lands (a question would stop the reload)
    await reloaded(page, async () => {
      await page.click("#logout"); await sleep(1000);
      const m = await logoutAt(page);
      problems.push(...ok(m.text === "Logging out…" && m.disabled, `while waiting: "${m.text}"`));
      await release(page);
    });
    problems.push(...ok((await gateShown(page)) && (await gateText(page)) === "You are logged out.", `gate: ${await gateText(page)}`));
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("ed_interviews_v1")).screening);
    problems.push(...ok(st["Chen~c-1"] && st["Chen~c-1"].rating === 4, "the rating made before Log out was not saved"));
    return problems;
  },

  // The applicant's page is redrawn while Log out waits (here: a change saved
  // from another tab): the button still says "Logging out…".
  async applicantRedraw(page, url, b) {
    const problems = [];
    await applicantIn(page, url, base());
    await hold(page);
    await page.evaluate(() => window.CAND.set("t0", "ip")); await sleep(100);
    await page.click("#candview [data-logout]"); await sleep(150);
    const other = await b.newPage();
    try {
      await other.goto(url.replace("index.html", "css/styles.css"));   // same origin, and not the app
      await other.evaluate(() => { const s = JSON.parse(localStorage.getItem("ed_interviews_v1")); s.settings.times[1].end = "10:30"; localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); });
      await sleep(300);
    } finally { await other.close(); }
    const m = await logoutAt(page);
    const redrawn = await page.evaluate(() => /10:30/.test(document.querySelector("#candview").textContent));
    problems.push(...ok(redrawn, "the page was not redrawn (the test did not test anything)"));
    problems.push(...ok(m.text === "Logging out…" && m.disabled, `after a redraw while waiting: "${m.text}", disabled ${m.disabled}`));
    await page.waitForSelector("#confirmWrap:not(.hidden)", { timeout: 8000 });
    await page.click("#confirmNo"); await sleep(200);
    const back = await logoutAt(page);
    problems.push(...ok(back.text === "Log out" && !back.disabled, `after Stay: "${back.text}"`));
    await release(page); await sleep(200);
    await reloaded(page, () => page.click("#candview [data-logout]"));
    problems.push(...ok((await gateShown(page)) && (await gateText(page)) === "You are logged out.", `gate: ${await gateText(page)}`));
    return problems;
  },

  // This device held scores: the gate adds that they are saved but won't show
  // here again; the line is said once.
  async scoresLine(page, url) {
    const problems = [];
    await load(page, url, base(), "staffpw");
    await pickMember(page, "Chen");
    await page.evaluate(() => localStorage.setItem("ed_iv_echo_v1", JSON.stringify({ scores: { "Chen~c-1": { overall: 4, notes: {} } } })));
    await reloaded(page, () => page.click("#logout"));
    const t = await gateText(page);
    problems.push(...ok(t === "You are logged out. Your scores are saved, but this device won't show them to you again when you log back in.", `gate: ${t}`));
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
    problems.push(...ok((await gateText(page)) === "", "the logged-out line came back after a reload"));
    return problems;
  },
};

export async function main(only) {
  makeSite();
  const site = await serve(DIR);
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
      await page.evaluate(() => { globalThis.__hold = null; if (globalThis.__release) globalThis.__release(); }).catch(() => {});
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
  console.log(`\n${Object.keys(results).length - bad}/${Object.keys(results).length} log out scenarios pass`);
  process.exit(bad ? 1 : 0);
}
