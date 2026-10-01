// Score tab: the typed 1.0–5.0 overall score, driven through the real UI.
// Each case is a way a typed box goes wrong that the old 1–5 buttons couldn't:
// text following you to the next candidate, a save landing on two candidates
// (Chrome fires `change` on a focused box as a rebuild removes it), a tap on
// ‹ › eaten by the redraw a save causes, a score lost because the box was
// never left. Run: `npm run score` (rebuilds site/ first).
import { serve, browser, openPage, signIn, pickMember, tab, sleep, dumpState } from "./drive.mjs";
const s = await serve(); const b = await browser(); const log = [];
let fails = 0;
const R = (name, ok, extra = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

async function fresh({ width = 1280 } = {}) {
  const page = await openPage(b, s.url, { width, log });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("ed_interviews_v1", JSON.stringify({ candidates: [
      { id: "c-a", name: "Ada Ashcombe", removed: false }, { id: "c-b", name: "Bram Ellery", removed: false }] })); });
  await page.reload(); await page.waitForFunction("window.__edReady === true");
  await signIn(page, "staffpw");
  const me = (await page.$$eval("#memberSel option", (o) => o.map((x) => x.value).filter(Boolean)))[0];
  await pickMember(page, me); await tab(page, "score");
  await page.select("select[aria-label='Candidate to score']", "c-a"); await sleep(80);
  page.me = me; return page;
}
const sc = async (page, c) => ((await dumpState(page)).scores || {})[`${page.me}~${c}`] || {};
const cand = (page) => page.$eval("select[aria-label='Candidate to score']", (e) => e.value);

// 1. note focused, candidate switched programmatically (iOS: tapping a button doesn't move focus)
{ const p = await fresh();
  await p.click("#note-0"); await p.type("#note-0", "A only"); await sleep(600);
  await p.evaluate(() => window.IV.pickScore("c-b")); await sleep(80);
  const shown = await p.$eval("#note-0", (e) => e.value);
  await p.type("#note-0", "!"); await sleep(600);
  const b0 = ((await sc(p, "c-b")).notes || {})[0];
  R("note doesn't follow to next candidate", shown === "" && (b0 === "!" ), `B shows "${shown}", B saved "${b0}"`); await p.close(); }

// 2. score typed (not committed), candidate switched with focus still in box
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.2");
  await p.evaluate(() => window.IV.pickScore("c-b")); await sleep(80);
  const shown = await p.$eval("#overallIn", (e) => e.value);
  await p.evaluate(() => document.activeElement.blur()); await sleep(150);
  const a = (await sc(p, "c-a")).overall, bb = (await sc(p, "c-b")).overall;
  R("uncommitted score lands on the candidate it was typed for", a === 4.2 && !bb && shown === "", `B box "${shown}", A=${a}, B=${bb}`); await p.close(); }

// 3. type score, then click › with a real mouse (desktop)
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "3.9");
  const next = await p.$("button[aria-label^='Next candidate']"); await next.click(); await sleep(200);
  R("click › right after typing: saves AND moves", (await sc(p, "c-a")).overall === 3.9 && (await cand(p)) === "c-b",
    `A=${(await sc(p, "c-a")).overall}, now on ${await cand(p)}`); await p.close(); }

// 4. type score, then click a note box (common: score then add a note)
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.4");
  await p.click("#note-2"); await sleep(150);
  const focus = await p.evaluate(() => document.activeElement.id);
  await p.type("#note-2", "late note"); await sleep(600);
  const r = await sc(p, "c-a");
  R("score then click into note: focus kept, both saved", r.overall === 4.4 && r.notes?.[2] === "late note" && focus === "note-2",
    `focus=${focus}, ${JSON.stringify(r)}`); await p.close(); }

// 5. tab out with Tab key
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "2.1"); await p.keyboard.press("Tab"); await sleep(150);
  R("Tab commits", (await sc(p, "c-a")).overall === 2.1); await p.close(); }

// 6. parse table
{ const p = await fresh();
  const cases = { "4.7": 4.7, "4": 4, "5": 5, "1": 1, "5.0": 5, "1.0": 1, "4,7": 4.7, " 3.3 ": 3.3, "4.": 4,
    "5.1": null, "0.9": null, "6": null, "4.75": null, ".5": null, "abc": null, "-3": null, "1e0": null, "0x4": null, "4.50": 4.5, "5.00": 5, "4.70": 4.7, "4.05": null, "5.01": null };
  for (const [inp, want] of Object.entries(cases)) {
    await p.evaluate(() => { const e = document.querySelector("#overallIn"); e.value = ""; });
    await p.click("#overallIn", { clickCount: 3 }); await p.evaluate(() => { document.querySelector("#overallIn").value = ""; });
    if (inp) await p.type("#overallIn", inp); else { await p.type("#overallIn", "x"); await p.keyboard.press("Backspace"); } await p.keyboard.press("Enter"); await sleep(120);
    const got = (await sc(p, "c-a")).overall;
    const msg = await p.$eval("#overallMsg", (e) => e.textContent);
    const ok = want === null ? msg.startsWith("Not saved") : (got || 0) === want;
    if (!ok) R(`parse "${inp}"`, false, `want ${want}, saved ${got}, msg "${msg}"`);
    // reset to a known saved value so "null" cases are distinguishable
    await p.evaluate(() => { document.querySelector("#overallIn").value = ""; });
  }
  await p.close(); }

// 7. member switch with focus in box (same device, two reviewers sharing)
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.8"); await p.keyboard.press("Enter"); await sleep(120);
  const box = await p.$eval("#overallIn", (e) => e.value);
  R("committed box shows 4.8", box === "4.8", box); await p.close(); }


// 8. pause-save: type, don't leave the box, wait
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.6"); await sleep(900);
  const r = await sc(p, "c-a"); const still = await p.evaluate(() => document.activeElement.id);
  R("score saves after a pause without leaving the box", r.overall === 4.6 && still === "overallIn", `${r.overall}, focus ${still}`); await p.close(); }

// 9. pause-save survives a switch inside the pause window, lands on A
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "3.4");
  await p.select("select[aria-label='Candidate to score']", "c-b"); await sleep(900);
  R("switch inside pause: A gets it, B doesn't", (await sc(p, "c-a")).overall === 3.4 && !(await sc(p, "c-b")).overall,
    `A=${(await sc(p, "c-a")).overall} B=${(await sc(p, "c-b")).overall}`); await p.close(); }

// 10. invalid score then › : stays on A, nothing saved, message shown
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.75");
  await p.evaluate(() => window.IV.pickScore("c-b")); await sleep(150);
  R("invalid then ›: stays, says so", (await cand(p)) === "c-a" && !(await sc(p, "c-a")).overall
    && (await p.$eval("#overallMsg", (e) => e.textContent)).startsWith("Not saved"), await cand(p)); await p.close(); }

// 11. retype: select all, delete, pause, type new value — saved score never cleared in between
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.1"); await p.keyboard.press("Enter"); await sleep(150);
  await p.click("#overallIn", { clickCount: 3 }); await p.keyboard.press("Backspace"); await sleep(900);
  const mid = (await sc(p, "c-a")).overall;
  await p.type("#overallIn", "4.3"); await p.keyboard.press("Enter"); await sleep(150);
  R("emptying mid-retype doesn't clear", mid === 4.1 && (await sc(p, "c-a")).overall === 4.3, `mid=${mid}`); await p.close(); }

// 12. typing a note while a score save lands: note keeps focus and caret
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "2.2");
  await p.click("#note-1"); await p.type("#note-1", "abc", { delay: 30 });
  await sleep(150); await p.type("#note-1", "def", { delay: 300 }); await sleep(700);
  const r = await sc(p, "c-a"); const v = await p.$eval("#note-1", (e) => e.value);
  R("note typing across saves intact", r.overall === 2.2 && r.notes?.[1] === "abcdef" && v === "abcdef", `${JSON.stringify(r)} box=${v}`); await p.close(); }

// 13. remote change while focused elsewhere: other candidate removed → rebuild, no stale ids
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "3.3"); await p.keyboard.press("Enter"); await sleep(150);
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem("ed_interviews_v1")); s.candidates.push({ id: "c-c", name: "Cora Dane", removed: false });
    localStorage.setItem("ed_interviews_v1", JSON.stringify(s)); new BroadcastChannel("ed_interviews").postMessage(1); });
  await sleep(300);
  const opts = await p.$$eval(".scorebar option", (o) => o.map((x) => x.textContent));
  R("roster change rebuilds picker", opts.length === 3 && (await p.$eval("#overallIn", (e) => e.value)) === "3.3", JSON.stringify(opts)); await p.close(); }

// 14. deliberate clear
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.1"); await p.keyboard.press("Enter"); await sleep(150);
  await p.click("#overallIn", { clickCount: 3 }); await p.keyboard.press("Backspace"); await p.keyboard.press("Enter"); await sleep(150);
  R("select-all, delete, Enter clears", !(await sc(p, "c-a")).overall && (await p.$eval("#overallIn", (e) => e.value)) === "", String((await sc(p, "c-a")).overall)); await p.close(); }

// 15. typing on from valid into invalid never leaves "Saving…" stuck
{ const p = await fresh();
  await p.click("#overallIn"); await p.type("#overallIn", "4.7"); await p.type("#overallIn", "5"); await sleep(900);
  const flag = await p.$eval("#saveStatus", (e) => e.textContent).catch(() => "");
  R("no stuck Saving… indicator", !/Saving/i.test(flag) && !(await sc(p, "c-a")).overall, `flag "${flag}"`); await p.close(); }

// 16. a note still waiting out its pause isn't reverted by someone else's save
{ const p = await fresh();
  await p.click("#note-0"); await p.type("#note-0", "first half");
  await p.click("#overallIn"); await p.type("#overallIn", "3.0"); await p.keyboard.press("Enter");   // save → emit
  const shown = await p.$eval("#note-0", (e) => e.value); await sleep(700);
  R("pending note not reverted by another save", shown === "first half" && (await sc(p, "c-a")).notes?.[0] === "first half", `shown "${shown}"`); await p.close(); }

console.log("browser log:", log.length ? log : "(clean)");
await b.close(); s.close();
if (fails || log.length) { console.log(`\n${fails} score check(s) failed`); process.exit(1); }
console.log("\nall score checks pass");
