// Nothing generated is ever tracked: the sim's site copies (sim/site,
// sim/site-emulator, sim/site-latency) are builds, and anything tracked here is
// published by GitHub Pages under /mgh-ed-hiring/ (review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let tracked = null;
try { tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); } catch { /* not a git checkout */ }

test("no generated sim site, log or debug file is tracked", { skip: tracked === null && "not a git checkout" }, () => {
  const bad = tracked.filter((f) => /^sim\/site[^/]*\//.test(f) || /(^|\/)firestore-debug\.log$|\.log$/.test(f) || /(^|\/)node_modules\//.test(f));
  assert.deepEqual(bad, []);
});
