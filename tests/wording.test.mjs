// R12 (Alvin, Oct 19 2026): interviews are "virtual", never "Zoom", in every
// word anyone sees (buttons, grids, Panels, Setup, the applicant page, emails,
// exports). Only visible words changed: the stored value "zoom", the
// zoomLink field, the idZoom box and the CSS classes stay as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [...readdirSync(root + "js").filter((f) => f.endsWith(".js")).map((f) => "js/" + f), "index.html", "passwords.html"];

test("no page or script shows the word Zoom", () => {
  const bad = [];
  for (const f of files) {
    readFileSync(root + f, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;   // comments
      if (/\bZoom\b/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

// Words made at run time from the stored value: every word map says virtual, and
// no message prints the stored modality itself (a Panels warning once read
// "can't do zoom that time", the schedule CSV "zoom").
test("word maps say virtual, and no message prints the stored modality", () => {
  const app = readFileSync(root + "js/app.js", "utf8");
  const maps = [...app.matchAll(/\bzoom:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(maps.length >= 3, "the word maps were not found");
  for (const w of maps) if (w.length > 1) assert.match(w, /^virtual$/i);
  assert.doesNotMatch(app, /can't do \$\{modality\}/);
  assert.doesNotMatch(app, /slotName\(p\.slot\), p\.modality,/);
});
