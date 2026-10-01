// Stress test for the Score tab's typed overall score, through the real UI.
//
// Random sequences of what a panellist actually does — type a score (valid,
// invalid, in two bursts), type notes, leave the box by Enter/Tab/clicking a
// note, switch candidate by ‹ › (real mouse: focus moves), by the picker or a
// tap that leaves focus in the box (iOS), pause briefly or long enough for the
// save-after-a-pause — interleaved with another tab adding a candidate (forces
// a rebuild mid-typing) or saving something unrelated (forces an in-place
// patch mid-typing).
//
// Every candidate has a fingerprint: its notes are typed only in its own
// letters and its scores only end in its own tenths digit, so anything filed
// under the wrong candidate is unmistakable. After every long pause the saved
// data and the screen are checked against an independent model of what
// should have been saved.
//
//   node score-stress.mjs [seeds=40] [firstSeed=1] [--latency] [--steps=80]
//
// --latency delays every score/notes write by 0–400ms (in order, like
// Firestore), which is harsher than the real app: there a reviewer's own
// write lands in local state synchronously.
import fs from "node:fs";
import path from "node:path";
import { serve, browser, openPage, signIn, pickMember, tab, sleep, dumpState, SITE } from "./drive.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const num = args.filter((a) => !a.startsWith("--")).map(Number);
const SEEDS = num[0] || 40, FIRST = num[1] || 1;
const STEPS = Number((args.find((a) => a.startsWith("--steps=")) || "=80").split("=")[1]);
const FLAKY = flags.has("--flaky");
const LATENCY = flags.has("--latency") || FLAKY;
const WORKERS = 6;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// ---- site under test (optionally with write latency) -----------------------
let dir = SITE;
if (LATENCY) {
  dir = path.join(path.dirname(SITE), "site-latency");
  fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(SITE, dir, { recursive: true });
  const p = path.join(dir, "js/store.js"); let s = fs.readFileSync(p, "utf8");
  const head = "  async setScore(member, candId, patch) {\n    const k = key(member, candId);\n    const prev = this.state.scores[k] || { notes: {} };";
  if (!s.includes(head)) throw new Error("LocalStore.setScore changed shape — update score-stress.mjs latency patch");
  s = s.replace(head, `  async setScore(member, candId, patch) {
    window.__inflight = (window.__inflight || 0) + 1;
    LocalStore._q = (LocalStore._q || Promise.resolve()).then(() => new Promise((r) => setTimeout(r, Math.random() * 400)))
      .then(() => { if (window.__flaky && Math.random() < 0.15) throw new Error("simulated network failure");
        return this._setScoreNow(member, candId, patch); }).finally(() => { window.__inflight--; });
    const mine = LocalStore._q; LocalStore._q = mine.catch(() => {});   // one failure mustn't jam the queue
    return mine;
  }
  _setScoreNow(member, candId, patch) {
    const k = key(member, candId);
    const prev = this.state.scores[k] || { notes: {} };`);
  fs.writeFileSync(p, s);
}

// ---- the model -------------------------------------------------------------
const LETTERS = "abcdefgh";              // candidate i types notes in LETTERS[i] only
const parseScore = (raw) => {            // restated independently of app.js
  const t = String(raw || "").trim().replace(",", ".");
  if (!t) return 0;
  if (!/^\d(\.(\d0*)?)?$/.test(t)) return null;
  const v = Number(t); return v >= 1 && v <= 5 ? v : null;
};
const fmt = (v) => (v ? Number(v).toFixed(1) : "");
const INVALID = ["4.75", "6", "0.5", "abc", "5.5", "-2", ".", "4.7.1", "44"];

async function runSeed(seed, b, srv) {
  const r = rng(seed); const log = []; const trail = [];
  const page = await openPage(b, srv.url, { log });
  if (FLAKY) await page.evaluateOnNewDocument(() => { window.__flaky = true; });
  const cands = [0, 1, 2, 3].map((i) => ({ id: `c-${i}`, name: `Cand ${String.fromCharCode(65 + i)}`, fp: i }));
  await page.evaluate((cands) => { localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("ed_interviews_v1", JSON.stringify({ candidates: cands.map(({ id, name }) => ({ id, name, removed: false })) })); }, cands);
  await page.reload(); await page.waitForFunction("window.__edReady === true");
  await signIn(page, "staffpw");
  const me = (await page.$$eval("#memberSel option", (o) => o.map((x) => x.value).filter(Boolean)))[0];
  await pickMember(page, me); await tab(page, "score");
  const nQ = await page.$$eval("textarea[id^='note-']", (t) => t.length);

  const M = { cur: 0, focus: null, box: "", pending: null, saved: {}, notes: {}, invalidLeft: false };
  cands.forEach((c) => { M.saved[c.id] = 0; M.notes[c.id] = {}; });
  const sorted = () => cands.slice().sort((a, b) => a.name.localeCompare(b.name));
  const curC = () => sorted()[M.cur];
  const idxOf = (id) => sorted().findIndex((c) => c.id === id);
  const fail = (msg) => { throw new Error(`seed ${seed}: ${msg}\n  last steps: ${trail.slice(process.env.FULL ? 0 : -12).join(" → ")}`); };

  // the box lost focus: what IV.score does with its contents, for the candidate it was drawn for
  const commit = (c) => {
    const v = parseScore(M.box);
    M.pending = null;
    if (v === null) { M.invalidLeft = true; return false; }
    M.saved[c.id] = v; M.invalidLeft = false; return true;
  };
  const settle = async (ms) => {
    await sleep(ms);
    if (LATENCY) await page.waitForFunction("!(window.__inflight > 0)", { timeout: 15000 });
    if (M.pending) { M.saved[M.pending.cand] = M.pending.v; M.pending = null; }   // the pause elapsed
  };
  const check = async (where) => {
    const st = await dumpState(page); const sc = st.scores || {};
    for (const c of cands) {
      const rec = sc[`${me}~${c.id}`] || {};
      const got = rec.overall || 0;
      if (got && Math.round(got * 10) % 10 !== c.fp + 1) fail(`${where}: ${c.name} holds ${got} — another candidate's score`);
      if (!FLAKY && got !== M.saved[c.id]) fail(`${where}: ${c.name} saved ${got}, expected ${M.saved[c.id]}`);
      for (let q = 0; q < nQ; q++) {
        const n = (rec.notes || {})[q] || "", want = M.notes[c.id][q] || "";
        if ([...n].some((ch) => ch !== LETTERS[c.fp])) fail(`${where}: ${c.name} note ${q} = "${n}" — contains another candidate's text`);
        if (!FLAKY && n !== want) fail(`${where}: ${c.name} note ${q} = "${n}", expected "${want}"`);
      }
    }
    const ui = await page.evaluate(() => ({
      sel: document.querySelector(".scorebar select")?.value, box: document.querySelector("#overallIn")?.value,
      boxCid: document.querySelector("#overallIn")?.dataset.cid, act: document.activeElement?.id || "",
      notes: [...document.querySelectorAll("textarea[id^='note-']")].map((t) => t.value),
      ticks: [...document.querySelectorAll(".scorebar option")].map((o) => [o.value, o.textContent.endsWith("✓")]) }));
    const c = curC();
    if (ui.sel !== c.id || ui.boxCid !== c.id) fail(`${where}: screen shows ${ui.sel}/${ui.boxCid}, expected ${c.id}`);
    if (!FLAKY && ui.act !== "overallIn" && ui.box !== fmt(M.saved[c.id]) && !(M.invalidLeft && parseScore(ui.box) === null))
      fail(`${where}: box shows "${ui.box}", saved is ${M.saved[c.id]}`);
    if (!FLAKY) ui.notes.forEach((v, q) => { if (ui.act !== `note-${q}` && v !== (M.notes[c.id][q] || "")) fail(`${where}: note ${q} box shows "${v}", saved "${M.notes[c.id][q] || ""}"`); });
    if (!FLAKY) ui.ticks.forEach(([id, t]) => { if (t !== !!M.saved[id]) fail(`${where}: ✓ for ${id} is ${t}, saved ${M.saved[id]}`); });
    if (FLAKY) {   // the screen must show what is actually saved for every field not being typed in
      const rec = sc[`${me}~${c.id}`] || {};
      if (ui.act !== "overallIn" && ui.box !== fmt(rec.overall || 0) && parseScore(ui.box) !== null)
        fail(`${where}: box shows "${ui.box}" but saved is ${rec.overall || 0}`);
      // a note whose save failed stays on screen (it's the only copy) — so the
      // box may hold MORE than is saved, but never less, never anything else
      ui.notes.forEach((v, q) => { const sv = (rec.notes || {})[q] || "";
        if (ui.act !== `note-${q}` && !v.startsWith(sv)) fail(`${where}: note ${q} shows "${v}" — hides saved "${sv}"`);
        if ([...v].some((ch) => ch !== LETTERS[c.fp])) fail(`${where}: note ${q} box shows another candidate's text "${v}"`); });
      ui.ticks.forEach(([id, t]) => { if (t !== !!(sc[`${me}~${id}`] || {}).overall) fail(`${where}: ✓ for ${id} doesn't match saved`); });
    }
    if (log.length) fail(`${where}: browser log ${JSON.stringify(log)}`);
  };

  const ensureBox = async () => {
    if (M.focus !== "box") {
      if (M.focus === "note") M.focus = null;
      await page.click("#overallIn"); M.focus = "box";
      M.box = await page.$eval("#overallIn", (e) => e.value);
    }
  };
  const switchTo = async (how, target) => {
    const from = curC(), boxFocused = M.focus === "box";
    if (how === "click") {                 // real mouse: focus moves to the button first
      if (boxFocused) commit(from);
      const lbl = target > M.cur ? "Next" : "Previous";
      await page.click(`button[aria-label^='${lbl} candidate']`);
      M.cur = target; M.focus = null; M.invalidLeft = false;
    } else {                               // picker / iOS tap: focus stays where it was
      if (how === "select") await page.select(".scorebar select", sorted()[target].id);
      else await page.evaluate((id) => window.IV.pickScore(id), sorted()[target].id);
      if (boxFocused && !commit(from)) return;     // invalid → stays put, box keeps focus
      M.cur = target; M.focus = null; M.invalidLeft = false;
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const c = curC(); const roll = r();
    let act;
    if (roll < 0.22) {
      act = "score";
      await ensureBox();
      await page.click("#overallIn", { clickCount: 3 }); await page.keyboard.press("Backspace");
      M.box = ""; M.pending = null;
      const valid = r() < 0.75;
      const s = valid ? `${int(r, 1, 4)}${r() < 0.2 ? "," : "."}${c.fp + 1}` : pick(r, INVALID);
      if (r() < 0.3 && s.length > 1) { await page.keyboard.type(s.slice(0, 1)); await sleep(int(r, 20, 150)); await page.keyboard.type(s.slice(1)); }
      else await page.keyboard.type(s);
      M.box = s; const v = parseScore(s); M.pending = v ? { cand: c.id, v } : null;
      act += `(${s})`;
    } else if (roll < 0.40) {
      const q = int(r, 0, nQ - 1); act = `note${q}`;
      if (M.focus === "box") commit(c);
      await page.click(`#note-${q}`); await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
      M.focus = "note";
      const s = LETTERS[c.fp].repeat(int(r, 1, 5)); await page.keyboard.type(s);
      M.notes[c.id][q] = (M.notes[c.id][q] || "") + s;
    } else if (roll < 0.47) {
      act = "enter"; if (M.focus !== "box") continue;
      await page.keyboard.press("Enter"); commit(c); M.focus = null;
    } else if (roll < 0.52) {
      act = "tab"; if (M.focus !== "box") continue;
      await page.keyboard.press("Tab"); commit(c); M.focus = null;
    } else if (roll < 0.56) {
      act = "clear"; await ensureBox();
      await page.click("#overallIn", { clickCount: 3 }); await page.keyboard.press("Backspace");
      M.box = ""; M.pending = null; await page.keyboard.press("Enter"); commit(c); M.focus = null;
    } else if (roll < 0.70) {
      const how = pick(r, ["click", "select", "ios"]);
      const n = sorted().length;
      const target = how === "click" ? (M.cur === 0 ? 1 : M.cur === n - 1 ? n - 2 : M.cur + pick(r, [-1, 1])) : int(r, 0, n - 1);
      if (target === M.cur) continue;
      act = `switch:${how}→${sorted()[target].name}`;
      await switchTo(how, target);
    } else if (roll < 0.74 && cands.length < 7) {
      // another device adds a candidate → the list changes → full rebuild, possibly mid-typing
      const i = cands.length; const nc = { id: `c-${i}`, name: `Cand ${pick(r, ["A", "B", "C", "D", "Z"])}${i}`, fp: i };
      act = `remoteAdd(${nc.name})`;
      const curId = curC().id;
      if (M.focus === "box") commit(c);       // Chrome fires change as the box is removed
      M.focus = null;
      cands.push(nc); M.saved[nc.id] = 0; M.notes[nc.id] = {};
      await page.evaluate((nc) => { const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
        s.candidates.push({ id: nc.id, name: nc.name, removed: false });
        localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); new BroadcastChannel("ed_interviews").postMessage(1); }, nc);
      await sleep(60);
      M.cur = idxOf(curId);
      if (M.invalidLeft) M.invalidLeft = false;
    } else if (roll < 0.80) {
      // another device saves something unrelated → in-place patch, possibly mid-typing
      act = "remoteNoise";
      await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("ed_interviews_v1"));
        s.availIv = { ...(s.availIv || {}), Someone: { "0": "either", t: Date.now() } };
        localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); new BroadcastChannel("ed_interviews").postMessage(1); });
      await sleep(40);
    } else if (roll < 0.90) {
      act = "short"; await sleep(int(r, 20, 220));
    } else {
      act = "long"; await settle(int(r, 850, 1100)); trail.push(act); await check(`step ${step}`); continue;
    }
    trail.push(act);
  }
  // finish: leave whatever is focused, let everything land, check once more
  if (M.focus === "box") { await page.keyboard.press("Enter"); commit(curC()); }
  M.focus = null; await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await settle(1200); await check("end");
  await page.close();
  return trail.length;
}

// ---- run seeds across workers (one server each = separate origin = separate storage)
const seeds = Array.from({ length: SEEDS }, (_, i) => FIRST + i);
const failures = []; let steps = 0; const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, async () => {
  const srv = await serve(dir); const b = await browser();
  while (seeds.length) {
    const seed = seeds.shift();
    try { const n = await runSeed(seed, b, srv); steps += n; }
    catch (e) { failures.push(e.message); console.log("FAIL " + e.message.split("\n")[0]); }
  }
  srv.close(); await b.close();
}));
console.log(`\n${SEEDS} seeds from ${FIRST}${FLAKY ? " with write latency + 15% failed writes" : LATENCY ? " with write latency" : ""}: ${steps} actions in ${Math.round((Date.now() - t0) / 1000)}s, ${failures.length} failing`);
failures.forEach((f) => console.log("\n" + f));
process.exit(failures.length ? 1 : 0);
