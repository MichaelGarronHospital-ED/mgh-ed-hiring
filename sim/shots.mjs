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
  R2: async () => {
    const st = { ...STATE, scores: {} };
    await shoot("setup-committee", async (p) => { await landAsAdmin(p); await openCard(p, "setCommittee");
      await p.evaluate(() => window.IV.mSet(3, "active", "false")); }, { state: st });
    await shoot("setup-questions", async (p) => { await landAsAdmin(p); await sleep(300); await openCard(p, "setQuestions"); }, { state: st });
    await shoot("setup-questions-locked", async (p) => { await landAsAdmin(p); await sleep(300); await openCard(p, "setQuestions"); },
      { state: { ...STATE, scores: { "Chen~c-1": { overall: 4.2 } } } });
    await shoot("name-list", async (p) => { await p.waitForSelector("#memberpick:not(.hidden)"); }, { code: "staffpw" });
  },
  R3: async () => {
    const scr = { ...STATE.screening, "Chen~c-1": { flag: true, reason: "Short ED time" }, "Dufour~c-2": { note: "I supervised her elective.", conflict: true } };
    await shoot("setup-stages-rule", async (p) => { await landAsAdmin(p); await openCard(p, "setStages");
      await p.evaluate(() => { for (const s of ["setDeadlines", "setRule"]) { const d = document.querySelector(`details[data-sec="${s}"]`); d.open = true; } }); },
      { state: { ...STATE, meta: { stages: { screening: { closed: true, at: new Date().toISOString() } } } } });
    await shoot("collation-decisions", async (p) => { await landAsAdmin(p); }, { state: { ...STATE, screening: scr,
      candidates: STATE.candidates.map((c) => c.id === "c-3" ? { ...c, shortlist: "out", shortlistBy: "leadership" } : c) } });
    await shoot("reviewer-concern-note", async (p) => { await pickMember(p, "Dufour"); }, { code: "staffpw", state: { ...STATE, screening: scr } });
    await shoot("reviewer-closed", async (p) => { await pickMember(p, "Dufour"); }, { code: "staffpw",
      state: { ...STATE, screening: scr, meta: { stages: { screening: { closed: true } } } } });
    await shoot("panels-locked", async (p) => { await landAsAdmin(p); await tab(p, "panels"); }, { state: { ...STATE,
      schedule: { locked: true, lockedAt: new Date().toISOString(), panels: { "c-1": { slot: "t0", room: 1, chair: "Abara", members: ["Abara", "Bruns", "Chen"], modality: "ip" } } },
      availIv: { ...STATE.availIv, Chen: { t1: "ip" } } } });
    await shoot("panels-unlocked", async (p) => { await landAsAdmin(p); await tab(p, "panels"); });
  },
  R4: async () => {
    const kims = { ...STATE, candidates: STATE.candidates.map((c) => c.id === "c-2" ? { ...c, availKey: "kim-jane" } : c.id === "c-3" ? { ...c, availKey: "kim-min" } : c),
      availCand: { ...STATE.availCand, kim: { t0: "ip" } } };
    await shoot("applicant-names", async (p) => { await p.waitForSelector("#candName"); }, { code: "guestpw" });
    await shoot("more-menu", async (p) => { await landAsAdmin(p); await p.evaluate(() => { document.querySelector("details.more").open = true; }); });
    await shoot("merge-preview", async (p) => { await landAsAdmin(p); await p.evaluate(() => window.IV.mergeCand("c-3", "c-2")); await sleep(200); });
    await shoot("delete-dialog", async (p) => { await landAsAdmin(p); await p.evaluate(() => window.IV.deleteCand("c-3")); await sleep(200); await p.type("#delIn", "Ki"); },
      { state: { ...STATE, candidates: STATE.candidates.map((c) => c.id === "c-3" ? { ...c, removed: true } : c) } });
    await shoot("shared-surname-attention", async (p) => { await landAsAdmin(p); await tab(p, "panels"); }, { state: kims });
  },
};
if (shots[rel]) { await shots[rel](); await done(); }
