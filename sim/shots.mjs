// Screenshots of new screens for review (dev-only). node shots.mjs <outdir> <release>
// Each shot: phone 390px and desktop 1280px, light and dark. LocalStore copy only.
import path from "node:path";
import { serve, browser, signIn, landAsAdmin, pickMember, tab, sleep, daysAhead } from "./drive.mjs";
const [out, rel] = process.argv.slice(2);
const site = await serve(); const b = await browser();
const TIMES = [{ id: "t0", date: daysAhead(30), start: "09:00", end: "10:00" }, { id: "t1", date: daysAhead(30), start: "10:00", end: "11:00" }];
export const STATE = {
  candidates: [{ id: "c-1", name: "Dr Rosalind Ashcombe", removed: false }, { id: "c-2", name: "Dr Jane Kim", removed: false }, { id: "c-3", name: "Dr Min Kim", removed: false }],
  screening: { "Bruns~c-1": { flag: true, reason: "Little ED experience", rating: 2 }, "Chen~c-2": { rating: 4 } },
  scores: {}, meta: { interviewsComplete: false },
  availIv: { Abara: { t0: "ip", t1: "ip" }, Bruns: { t0: "ip", t1: "either" }, Chen: { t0: "ip", t1: "ip" }, Dufour: { t1: "ip" } },
  availCand: { ashcombe: { t0: "ip" } },
  settings: { committee: [{ name: "Abara", gender: "M" }, { name: "Bruns", gender: "F" }, { name: "Chen", gender: "M" }, { name: "Dufour", gender: "F" }],
    chair: "Abara", times: TIMES, oneDrive: "#", panelOverrides: { "c-1": { slot: "t0", members: ["Abara", "Bruns", "Chen"], modality: "ip" } } },
  publicInfo: {}, allowedNames: null,
  history: {
    h1: { at: new Date(Date.now() - 3600e3).toISOString(), by: "leadership", action: "questions.migrate", text: "Copied the interview questions from the old locked file (3 questions)" },
    h2: { at: new Date(Date.now() - 1800e3).toISOString(), by: "Chen", action: "panel.save", text: "Saved a hand-made panel for {cand}", cand: "c-1",
      undo: { kind: "panelOverrides", before: { "c-1": null }, afterHash: "x" } },
    h3: { at: new Date(Date.now() - 600e3).toISOString(), by: "leadership", action: "times.add", text: "Added 2 interview times" },
  },
};
export async function shoot(name, prep, { code = "adminpw", state = STATE } = {}) {
  for (const [w, label] of [[390, "phone"], [1280, "desktop"]]) for (const scheme of ["light", "dark"]) {
    const page = await b.newPage();
    await page.setViewport({ width: w, height: w < 500 ? 844 : 900, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.goto(site.url, { waitUntil: "domcontentloaded" });
    await page.evaluate((s) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); }, state);
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__edReady === true");
    await signIn(page, code);
    await prep(page); await sleep(400);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await page.screenshot({ path: path.join(out, `${rel}-${name}-${label}-${scheme}.png`), fullPage: true });
    if (scroll) console.log(`HORIZONTAL SCROLL: ${name} ${label} ${scheme}`);
    await page.close();
  }
}
export const openCard = async (page, sec) => {
  await page.evaluate(() => document.querySelector("#setupBtn").click()); await sleep(150);
  await page.evaluate((sec) => { const d = document.querySelector(`details[data-sec="${sec}"]`); d.open = true; d.dispatchEvent(new Event("toggle")); }, sec);
  await sleep(300);
};
export async function done() { await b.close(); site.close(); }
const shots = {
  R1: async () => {
    await shoot("setup-history-backup", async (p) => { await landAsAdmin(p); await openCard(p, "setBackup"); await p.evaluate(() => { const d = document.querySelector('details[data-sec="setHistory"]'); d.open = true; d.dispatchEvent(new Event("toggle")); }); });
    await shoot("ranking-backup-card", async (p) => { await landAsAdmin(p); await tab(p, "ranking"); });
    await shoot("update-line", async (p) => { await pickMember(p, "Chen"); await p.evaluate(() => { const el = document.querySelector("#updateLine"); el.innerHTML = '<p>This page was updated. <button class="linky">Reload</button> to get the latest version.</p>'; el.classList.remove("hidden"); }); }, { code: "staffpw" });
    await shoot("reset-panels-toast", async (p) => { await landAsAdmin(p); await tab(p, "panels");
      await p.evaluate(() => [...document.querySelectorAll("#panels button")].find((b) => b.textContent.includes("Reset hand-made panels")).click());
      await p.waitForSelector("#confirmWrap:not(.hidden)"); await p.click("#confirmYes"); await sleep(300); });
  },
};
if (shots[rel]) { await shots[rel](); await done(); }
