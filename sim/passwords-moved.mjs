// R9: the ED tools passwords page moved to the ED dashboard (the gear on the ED
// tools front page). This tool's passwords.html is now a plain redirect there,
// js/pwpage.js a stub that sends cached older pages on, and Setup's Passwords
// card only says where the passwords are and links there. Checked here on the
// LocalStore copy (sim/site), in `npm test`:
//   - the redirect works with scripts on, with the script alone (meta refresh
//     removed) and with scripts off (meta refresh alone), loads no module and
//     reaches nothing but this copy and the new page
//   - when the redirect can't happen, the page shows "The passwords page has
//     moved. Open it." in the ED look, light and dark, at 390 and 1280 px,
//     and the link works
//   - a cached older passwords.html (it loads js/pwpage.js as a module) ends up
//     on the new page too
//   - the Setup card shows the line and the link, with no way to change a
//     password in it; the "didn't finish" line shows only when
//     interviews_meta/passwords has a pending change
// The new page itself is never fetched: every request to it gets a stand-in
// answer from the browser's request interception.
//   node passwords-moved.mjs [name]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve, browser, signIn, landAsAdmin, sleep, SITE } from "./drive.mjs";

const NEW_PAGE = "https://michaelgarronhospital-ed.github.io/passwords.html";
const ok = (cond, msg) => (cond ? [] : [msg]);
const base = (over = {}) => ({
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }],
  screening: {}, scores: {}, meta: { interviewsComplete: false },
  availIv: {}, availCand: {},
  settings: { committee: [{ name: "Abara", gender: "M" }, { name: "Dufour", gender: "F" }, { name: "Chen", gender: "M" }], chair: "Abara", times: [], oneDrive: "#", panelOverrides: {} },
  publicInfo: {}, allowedNames: null, ...over,
});
// an older passwords.html as a browser may still have it cached (R7 to R8b): its module tag
const OLD_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>ED tools passwords</title>
<link rel="stylesheet" href="css/ed-ui.css?v=R8" /><link rel="stylesheet" href="css/styles.css?v=R8" /></head>
<body><div id="gate" class="overlay"><div class="overlay-box"><h2>ED tools passwords</h2><div id="gerr"></div></div></div>
<script type="module" src="js/pwpage.js?v=R8"></script></body></html>`;

// The page as a browser that follows neither the refresh nor the script sees it
// (refresh switched off, the script blocked): the same file without those two.
const REFRESH = '<meta http-equiv="refresh" content="0; url=https://michaelgarronhospital-ed.github.io/passwords.html" />\n';
function stayingPage() {
  const html = fs.readFileSync(path.join(SITE, "passwords.html"), "utf8");
  if (!html.includes(REFRESH)) throw new Error("passwords.html has no meta refresh to switch off");
  return html.replace(REFRESH, "");
}

// A page whose requests are watched: the new page answers with a stand-in, an
// "old cached page" address answers with OLD_PAGE, anything else not on this
// copy is refused and noted. With `noRefresh`, passwords.html comes without its
// meta refresh; with `stay`, its script is blocked as well.
async function watched(b, { width = 1280, scheme = "light", js = true, stay = false, noRefresh = stay } = {}) {
  const ctx = await b.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: width < 500 ? 844 : 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.setJavaScriptEnabled(js);
  const seen = [], outside = [], log = [];
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log.push(`console.error: ${m.text()}`); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    seen.push(u);
    if (u.startsWith("data:")) { req.continue(); return; }
    // the new page's site: the page itself gets the stand-in, anything else (its favicon) nothing
    if (u.startsWith("https://michaelgarronhospital-ed.github.io/") && !u.startsWith(NEW_PAGE)) { req.respond({ status: 204, body: "" }); return; }
    if (u.startsWith(NEW_PAGE)) { req.respond({ status: 200, contentType: "text/html", body: "<!DOCTYPE html><title>new passwords page</title><p>stand-in</p>" }); return; }
    if (noRefresh && new URL(u).pathname === "/passwords.html") { req.respond({ status: 200, contentType: "text/html", body: stayingPage() }); return; }
    if (stay && new URL(u).pathname === "/js/pwmoved.js") { req.respond({ status: 200, contentType: "text/javascript", body: "// blocked" }); return; }
    if (new URL(u).pathname === "/old-cached-passwords.html") { req.respond({ status: 200, contentType: "text/html", body: OLD_PAGE }); return; }
    if (u.startsWith("http://127.0.0.1:")) { req.continue(); return; }
    outside.push(u); req.abort();
  });
  return { page, ctx, seen, outside, log };
}
const arrived = (page) => page.waitForFunction((u) => location.href === u && document.title === "new passwords page", { timeout: 10000 }, NEW_PAGE);
async function goto(page, url) {
  // the page starts leaving while it loads; the navigation it starts is the one we wait for
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 }); } catch (e) { if (!/ERR_ABORTED|frame was detached|Navigating frame/.test(e.message)) throw e; }
}
const pageOf = (url, name) => url.replace(/index\.html$/, name);

const cases = {
  // scripts on: js/pwmoved.js sends people on at once; no module, no Firebase
  async redirectWithScripts(b, url) {
    const problems = [];
    const w = await watched(b);
    try {
      await goto(w.page, pageOf(url, "passwords.html"));
      await arrived(w.page);
      problems.push(...ok(w.seen.some((u) => /\/js\/pwmoved\.js\?v=R\d+[a-z]?$/.test(u)), `js/pwmoved.js was not loaded: ${w.seen.join(" ")}`));
      problems.push(...ok(!w.seen.some((u) => /pwpage\.js|app\.js|config\.js|gstatic|googleapis/.test(u)), `the redirect loaded a module or Firebase: ${w.seen.join(" ")}`));
      problems.push(...ok(!w.outside.length, `requests outside this copy: ${w.outside.join(" ")}`));
      problems.push(...w.log);
    } finally { await w.ctx.close(); }
    return problems;
  },

  // the meta refresh switched off: js/pwmoved.js alone gets there
  async redirectByScriptAlone(b, url) {
    const problems = [];
    const w = await watched(b, { noRefresh: true });
    try {
      await goto(w.page, pageOf(url, "passwords.html"));
      await arrived(w.page).catch(() => problems.push(`with the refresh off, the script didn't move the page (${w.page.url()})`));
      problems.push(...ok(w.seen.some((u) => /\/js\/pwmoved\.js\?v=R\d+[a-z]?$/.test(u)), `js/pwmoved.js was not loaded: ${w.seen.join(" ")}`));
      problems.push(...ok(!w.outside.length, `requests outside this copy: ${w.outside.join(" ")}`));
      problems.push(...w.log);
    } finally { await w.ctx.close(); }
    return problems;
  },

  // scripts off: the meta refresh alone gets there
  async redirectWithoutScripts(b, url) {
    const problems = [];
    const w = await watched(b, { js: false });
    try {
      await goto(w.page, pageOf(url, "passwords.html"));
      await w.page.waitForFunction((u) => location.href === u, { timeout: 10000 }, NEW_PAGE).catch(() => {});
      problems.push(...ok(w.page.url() === NEW_PAGE, `with scripts off, still on ${w.page.url()}`));
      problems.push(...ok(!w.outside.length, `requests outside this copy: ${w.outside.join(" ")}`));
    } finally { await w.ctx.close(); }
    return problems;
  },

  // a browser that doesn't move on by itself: the moved line and the link show
  // in the ED look, phone and desktop, light and dark; the link works
  async movedLineAndLink(b, url) {
    const problems = [], looks = {};
    for (const [width, scheme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]]) {
      const w = await watched(b, { width, scheme, stay: true });
      try {
        await goto(w.page, pageOf(url, "passwords.html"));
        await sleep(300);
        const m = await w.page.evaluate(() => {
          const p = document.querySelector("#moved"), a = p && p.querySelector("a");
          const box = document.querySelector(".overlay-box");
          const r = a ? a.getBoundingClientRect() : { width: 0, height: 0 };
          const cs = (e) => (e ? getComputedStyle(e) : {});
          return { href: location.href, text: p ? p.textContent.trim() : "", link: a ? a.getAttribute("href") : "", linkText: a ? a.textContent.trim() : "",
            linkW: r.width, linkH: r.height, sideways: document.documentElement.scrollWidth > window.innerWidth,
            boxBg: cs(box).backgroundColor, bodyBg: cs(document.body).backgroundColor, logoBg: cs(document.querySelector(".logo")).backgroundColor,
            ink: cs(p).color, main: !!document.querySelector('[role="main"]'), h: (document.querySelector("h2") || {}).textContent,
            modules: document.querySelectorAll('script[type="module"]').length, inline: [...document.scripts].filter((s) => !s.src).length };
        });
        const tag = `${width} px ${scheme}`;
        problems.push(...ok(m.href.endsWith("/passwords.html"), `${tag}: left the page although nothing sends it on: ${m.href}`));
        problems.push(...ok(m.text === "The passwords page has moved. Open it.", `${tag}: the line reads "${m.text}"`));
        problems.push(...ok(m.link === NEW_PAGE && m.linkText === "Open it." && m.linkW > 0 && m.linkH > 0, `${tag}: link: ${JSON.stringify(m)}`));
        problems.push(...ok(!m.sideways, `${tag}: the page scrolls sideways`));
        problems.push(...ok(m.main && m.h === "ED tools passwords", `${tag}: no main region or heading`));
        problems.push(...ok(m.modules === 0 && m.inline === 0, `${tag}: a module or an inline script on the page`));
        problems.push(...ok(Math.round(m.linkH) >= 44 && Math.round(m.linkW) >= 44, `${tag}: the link is too small to tap: ${m.linkW} x ${m.linkH} px`));
        // the ED look: the shared stylesheet's surface and accent, and the two schemes differ
        problems.push(...ok(m.boxBg && m.boxBg !== "rgba(0, 0, 0, 0)" && m.logoBg && m.logoBg !== "rgba(0, 0, 0, 0)", `${tag}: not in the ED look: ${JSON.stringify(m)}`));
        looks[`${width} ${scheme}`] = m.boxBg + " " + m.ink;
        // the link goes to the new page
        await w.page.click("#moved a");
        await arrived(w.page).catch(() => problems.push(`${tag}: Open it. didn't reach the new page (${w.page.url()})`));
        problems.push(...ok(!w.outside.length, `${tag}: requests outside this copy: ${w.outside.join(" ")}`));
        problems.push(...w.log);
      } finally { await w.ctx.close(); }
    }
    // dark mode follows the device (the shared stylesheet's tokens)
    for (const width of [390, 1280]) problems.push(...ok(looks[`${width} light`] !== looks[`${width} dark`], `${width} px: light and dark look the same: ${looks[`${width} light`]}`));
    return problems;
  },

  // a cached older passwords.html still loads js/pwpage.js as a module: the stub sends it on
  async cachedOlderPage(b, url) {
    const problems = [];
    const w = await watched(b);
    try {
      await goto(w.page, pageOf(url, "old-cached-passwords.html"));
      await arrived(w.page).catch(() => problems.push(`the older page stayed on ${w.page.url()}`));
      problems.push(...ok(w.seen.some((u) => /\/js\/pwpage\.js\?v=R8$/.test(u)), "the older page didn't load js/pwpage.js"));
      problems.push(...ok(!w.seen.some((u) => /passwords\.js|store\.js|signin\.js|gstatic|googleapis/.test(u)), `the stub loaded the old page's modules or Firebase: ${w.seen.join(" ")}`));
      problems.push(...ok(!w.outside.length, `requests outside this copy: ${w.outside.join(" ")}`));
      problems.push(...w.log);
    } finally { await w.ctx.close(); }
    return problems;
  },

  // Setup's card: the line and the link, nothing to change a password with;
  // the "didn't finish" line only with a pending change (both ways round)
  async setupCard(b, url) {
    const problems = [];
    const LINE = "The Admin, ED and Guest passwords are seen and changed on the ED tools passwords page (the gear on the ED tools front page).";
    const PENDING = "An older password change started here didn't finish. Open the passwords page; it finds which tools still have the old password.";
    const runs = [
      ["no record", null, false],
      ["finished change", { ed: { changedAt: "2026-10-01" }, pending: null }, false],
      ["unfinished change", { ed: { changedAt: "2026-10-01" }, pending: { roles: ["ed"], startedAt: "2026-10-16", done: ["voting:ed"], inProgress: null } }, true],
    ];
    for (const [label, passwordsMeta, pending] of runs) {
      const w = await watched(b, { width: 390 });
      try {
        const p = w.page;
        await goto(p, url);
        await p.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, base({ passwordsMeta }));
        await p.reload({ waitUntil: "domcontentloaded" });
        await p.waitForFunction("window.__edReady === true", { timeout: 15000 });
        await signIn(p, "adminpw"); await landAsAdmin(p);
        await p.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
        await p.evaluate(() => { const d = document.querySelector('details[data-sec="setPasswords"]'); d.open = true; d.dispatchEvent(new Event("toggle")); }); await sleep(200);
        const c = await p.$eval('details[data-sec="setPasswords"]', (d) => {
          const body = d.querySelector(".sec-body"), norm = (t) => t.replace(/\s+/g, " ").trim();
          return { body: norm(body.textContent), sub: norm((() => { const x = d.querySelector(".sec-sub"); if (!x) return ""; const c = x.cloneNode(true); c.querySelectorAll(".info").forEach((i) => i.remove()); return c.textContent; })()),
            links: [...body.querySelectorAll("a")].map((a) => [a.getAttribute("href"), norm(a.textContent)]),
            controls: body.querySelectorAll("input, button, select, textarea").length,
            sideways: document.documentElement.scrollWidth > window.innerWidth };
        });
        problems.push(...ok(c.body.includes(LINE), `${label}: the card doesn't say where the passwords are: ${c.body}`));
        problems.push(...ok(c.links.length === 1 && c.links[0][0] === NEW_PAGE, `${label}: the card's link: ${JSON.stringify(c.links)}`));
        problems.push(...ok(c.controls === 0 && !/Change a password|Change now|Check/.test(c.body), `${label}: the card still offers a change: ${c.body}`));
        problems.push(...ok(c.body.includes(PENDING) === pending, `${label}: the didn't-finish line ${pending ? "is missing" : "shows"}: ${c.body}`));
        problems.push(...ok(c.sub === (pending ? "· An older change didn't finish" : "· Admin, ED and Guest"), `${label}: the card's summary: ${c.sub}`));
        problems.push(...ok(!c.sideways, `${label}: Setup scrolls sideways at 390 px`));
        // the link reaches the new page (intercepted)
        await p.click('details[data-sec="setPasswords"] .sec-body a');
        await arrived(p).catch(() => problems.push(`${label}: the card's link didn't reach the new page (${p.url()})`));
        problems.push(...ok(!w.outside.length, `${label}: requests outside this copy: ${w.outside.join(" ")}`));
        problems.push(...w.log);
      } finally { await w.ctx.close(); }
    }
    return problems;
  },
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv[2];
  const srv = await serve();
  const b = await browser();
  let fails = 0, ran = 0;
  try {
    for (const [name, fn] of Object.entries(cases)) {
      if (only && name !== only) continue;
      ran++;
      let problems;
      try { problems = await fn(b, srv.url); } catch (e) { problems = [`threw: ${e.stack || e.message}`]; }
      if (problems.length) fails++;
      console.log(`${problems.length ? "FAIL" : "pass"}  ${name}${problems.length ? "\n  " + problems.join("\n  ") : ""}`);
    }
  } finally { await b.close(); srv.close(); }
  console.log(fails ? `\n${fails} passwords-moved case(s) failed` : `\n${ran}/${ran} passwords-moved cases pass`);
  process.exit(fails ? 1 : 0);
}
