// Alvin's phone check (Oct 2026): on an iPhone, tapping Check "didn't show
// anything" because the message landed below the fold of a long dialog. This
// drives the passwords page in WebKit (Safari's engine) at iPhone size against
// the local emulators and checks that, after tapping Check with a current
// password missing, the message is in the top half of the screen (the iPhone
// keyboard covers the bottom half) and the field to fix is marked, not focused.
// Run inside the emulators by `npm run passwords` (after passwords.mjs).
//   node passwords-webkit.mjs [outdir]   (outdir: also save a screenshot)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit, devices } from "playwright-core";
import { serve } from "./drive.mjs";
import * as emu from "./emu.mjs";
import { baseDocs } from "./emulator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || "";
const LEAD = "lead-old-test-1";
const problems = [];
const ok = (c, m) => { if (!c) problems.push(m); };

await emu.loadRules();
await emu.clearFirestore(); await emu.clearAuth();
await emu.addUser("admin@ed-hiring.app", LEAD);
await emu.seed({ ...baseDocs(),
  "interviews_meta/questions": { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }], scale: ["1", "2", "3", "4", "5"], guide: [] } });

const srv = await serve(path.join(HERE, "site-emulator"));
const b = await webkit.launch();
try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await b.newContext({ ...devices["iPhone 13"], colorScheme: scheme });
    const p = await ctx.newPage();
    await p.goto(srv.url.replace(/index\.html$/, "passwords.html"));
    await p.waitForFunction(() => window.__edReady === true);
    await p.fill("#gpw", LEAD);
    await p.tap("#gbtn");
    await p.waitForSelector("#pwApp .pwcard");
    await p.evaluate(() => { window.PW.change(); });
    await p.waitForFunction(() => document.querySelector("#flowTitle").textContent === "Which password?");
    await p.tap('#flowBody .pwtick input[value="ed"]');
    await p.tap("#flowBtns button:has-text('Next')");
    await p.waitForFunction(() => document.querySelector("#flowTitle").textContent === "Check the current passwords");
    await p.fill("#pwCur_leadership", LEAD);
    await p.tap("#pwCheck");
    await p.waitForTimeout(400);
    const m = await p.evaluate(() => {
      const e = document.querySelector("#pwErr"); const r = e.getBoundingClientRect();
      return { text: e.textContent, top: r.top, bottom: r.bottom, h: window.innerHeight, focus: (document.activeElement || {}).id,
        invalid: [...document.querySelectorAll('#flowBody [aria-invalid="true"]')].map((x) => x.id), coarse: matchMedia("(pointer: coarse)").matches };
    });
    ok(m.text.includes("Type the current ED password."), `${scheme}: no message after Check: ${JSON.stringify(m)}`);
    // in the TOP half: the iPhone keyboard covers the bottom half
    ok(m.top >= 0 && m.bottom > m.top && m.bottom <= m.h / 2, `${scheme}: the message is not in the top half of the screen: ${JSON.stringify(m)}`);
    // on a phone the field is marked, not focused (focus would open the keyboard over the message)
    ok(m.coarse && m.invalid.join() === "pwCur_ed" && m.focus !== "pwCur_ed", `${scheme}: field to fix not marked, or focused on a phone: ${JSON.stringify(m)}`);
    if (OUT) await p.screenshot({ path: path.join(OUT, `pwpage-webkit-check-error-phone-${scheme}.png`) });
    await ctx.close();
  }
} finally { await b.close(); srv.close(); }

console.log(problems.length ? `FAIL  webkitCheckErrorInView\n  ${problems.join("\n  ")}` : "pass  webkitCheckErrorInView (WebKit, iPhone 13)");
process.exit(problems.length ? 1 : 0);
