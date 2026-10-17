// Versioned imports (section 2.3): a browser gets a whole old set of modules or
// a whole new set, never a mix. Every relative import, and the page's own
// script tag, carries the same ?v=<release> as version.json and RELEASE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const release = JSON.parse(readFileSync(new URL("version.json", root), "utf8")).release;

test("version.json names a release", () => { assert.match(release, /^R\d+$/); });

test("every relative import in js/ carries ?v=<release>", () => {
  for (const f of readdirSync(new URL("js/", root)).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL("js/" + f, root), "utf8");
    const imports = [...src.matchAll(/(?:import|export)\s[^"']*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)]
      .map((m) => m[1] || m[2]);
    for (const spec of imports) assert.equal(spec.split("?v=")[1], release, `${f}: ${spec}`);
  }
});

test("index.html loads app.js with the same ?v=", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  const m = html.match(/<script type="module" src="js\/app\.js\?v=([^"]+)"/);
  assert.ok(m, "no versioned app.js script tag");
  assert.equal(m[1], release);
});

// review: the stylesheets too, so a new page never runs with last release's CSS
test("index.html loads both stylesheets with the same ?v=", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  const links = [...html.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links.map((l) => l.split("?v=")[0]).sort(), ["css/ed-ui.css", "css/styles.css"]);
  for (const l of links) assert.equal(l.split("?v=")[1], release, l);
});

test("app.js says it is the same release", () => {
  const app = readFileSync(new URL("js/app.js", root), "utf8");
  assert.match(app, new RegExp(`const RELEASE = "${release}";`));
});
