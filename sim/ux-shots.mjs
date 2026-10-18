// Dev-only: screenshot every Admin tab, the Setup panel (closed and all open)
// and the member tabs, on the LocalStore copy (run make-site.sh first).
//   node ux-shots.mjs <outdir> [width] [light|dark]
// Also reports what CLAUDE.md asks to check by rendering: sideways scroll,
// fields under 16px on a phone, and visible tap targets under 40px.
// The fixture is a copy of shots.mjs's STATE: importing that file runs its own
// shots, which is why this helper used to hang at the end.
import path from "node:path";
import fs from "node:fs";
import { serve, browser, signIn, landAsAdmin, pickMember, tab, sleep, daysAhead } from "./drive.mjs";

const [out, w = "1280", scheme = "light"] = process.argv.slice(2);
if (!out) { console.error("usage: node ux-shots.mjs <outdir> [width] [light|dark]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const W = Number(w);
const TIMES = [{ id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" }, { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" }];
const STATE = {
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Jane Kim", removed: false }, { id: "c-3", name: "Dr Min Kim", removed: false }],
  screening: { "Bruns~c-1": { flag: true, reason: "Little ED experience", rating: 2 }, "Chen~c-2": { rating: 4 } },
  scores: {}, meta: { interviewsComplete: false },
  availIv: { Abara: { t0: "ip", t1: "ip" }, Bruns: { t0: "ip", t1: "either" }, Chen: { t0: "ip", t1: "ip" }, Dufour: { t1: "ip" } },
  availCand: { ashcombe: { t0: "ip" } },
  settings: { committee: [{ name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" }, { name: "Dufour", gender: "F" }],
    chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: { "c-1": { slot: "t0", members: ["Abara", "Bruns", "Chen"], modality: "ip" } } },
  publicInfo: {}, allowedNames: null,
  history: {
    h3: { at: new Date(Date.now() - 600e3).toISOString(), by: "leadership", action: "times.add", text: "Added 2 interview times" },
  },
};
const tag = `${W}-${scheme}`;
const report = [];
async function audit(page, name) {
  const r = await page.evaluate((phone) => {
    const vis = (e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !e.closest("[hidden], .hidden, details:not([open]) > :not(summary)"); };
    const scroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    const small = phone ? [...document.querySelectorAll("input, select, textarea")].filter(vis)
      .filter((e) => e.type !== "checkbox" && e.type !== "radio" && e.type !== "file" && parseFloat(getComputedStyle(e).fontSize) < 16)
      .map((e) => e.id || e.className || e.tagName) : [];
    // phones only (desktop text links are small on purpose); the (i) badge has a
    // 44px hit area from its ::after, so it is not counted
    const taps = !phone ? [] : [...document.querySelectorAll("button, summary, a, select")].filter(vis)
      .filter((e) => !e.closest(".avgrid") && !e.closest("#tabs")).filter((e) => {
      const b = e.getBoundingClientRect(); return b.height < 36 || (!e.textContent.trim() && b.width < 36);
    }).map((e) => `${e.tagName}.${e.className}:${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24)}`);
    return { scroll, small, taps };
  }, W < 641);
  if (r.scroll) report.push(`${name}: HORIZONTAL SCROLL`);
  if (r.small.length) report.push(`${name}: fields under 16px: ${[...new Set(r.small)].join(", ")}`);
  if (r.taps.length) report.push(`${name}: small targets: ${[...new Set(r.taps)].slice(0, 8).join(" | ")}`);
}
// Chrome's fullPage capture can leave scrolling grids unpainted on a tall phone
// page, so grow the viewport to the page instead, shoot, and put it back.
async function snap(page, name, { keepViewport = false } = {}) {
  await audit(page, name);
  const vp = page.viewport();
  if (!keepViewport) {
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    if (H > vp.height) { await page.setViewport({ ...vp, height: Math.min(H, 16000) }); await sleep(250); }
  }
  await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
  if (!keepViewport) await page.setViewport(vp);
}

const site = await serve(); const b = await browser();
try {
  async function open(code, member) {
    const page = await b.newPage();
    await page.setViewport({ width: W, height: W < 500 ? 844 : 900 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.goto(site.url, { waitUntil: "domcontentloaded" });
    await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, STATE);
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
    await signIn(page, code);
    if (member) await pickMember(page, member); else await landAsAdmin(page);
    await sleep(300);
    return page;
  }
  const page = await open("adminpw");
  const tabs = await page.$$eval("#tabs button", (bs) => bs.map((x) => x.dataset.tab));
  for (const t of tabs) { await tab(page, t); await sleep(300); await snap(page, `admin-${t}`); }
  // the open forms: Add applicants, Interview times, the Panels More menu
  await tab(page, "screen"); await page.evaluate(() => { const d = document.querySelector('details[data-sec="adder"]'); d.open = true; d.dispatchEvent(new Event("toggle")); });
  await sleep(200); await snap(page, "admin-screen-add");
  await tab(page, "availability"); await page.evaluate(() => { const d = document.querySelector('details[data-sec="times"]'); d.open = true; d.dispatchEvent(new Event("toggle")); });
  await sleep(200); await snap(page, "admin-availability-times");
  await tab(page, "panels"); await page.evaluate(() => { document.querySelector("details.panelmore").open = true; });
  await sleep(200); await snap(page, "admin-panels-more");
  await page.evaluate(() => { document.querySelector("details.panelmore").open = false; });
  await page.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(300);
  const secs = await page.$$eval("#settings details[data-sec]", (ds) => ds.map((d) => d.dataset.sec));
  await snap(page, "setup", { keepViewport: true });
  await page.evaluate(() => document.querySelectorAll("#settings details[data-sec]").forEach((d) => { d.open = true; d.dispatchEvent(new Event("toggle")); }));
  await sleep(500);
  // the sheet scrolls inside itself: make the viewport tall enough to show it all
  const h = await page.$eval("#settings", (e) => e.scrollHeight);
  await page.setViewport({ width: W, height: Math.min(Math.ceil((h + 160) / 0.92), 16000) }); await sleep(300);
  await snap(page, "setup-open", { keepViewport: true });
  console.log("tabs", tabs.join(","), "| setup sections", secs.join(","));
  await page.close();
  const m = await open("staffpw", "Chen");
  const mt = await m.$$eval("#tabs button", (bs) => bs.map((x) => x.dataset.tab));
  for (const t of mt) { await tab(m, t); await sleep(300); await snap(m, `member-${t}`); }
  console.log("member tabs", mt.join(","));
  await m.close();
} finally {
  await b.close(); site.close();
}
console.log(report.length ? report.join("\n") : "audit: clean");
process.exit(0);
