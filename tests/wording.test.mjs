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
