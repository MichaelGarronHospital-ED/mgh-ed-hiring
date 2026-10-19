// R14: Log out to the ED tools standard (Oct 19 2026). The words, the look and
// where it sits are pinned here from the source; what it does (Logging out…,
// the question, Stay, every signed-in screen at 320, 390 and 1280 px) is played
// through the real page in sim/logout.mjs and sim/auth.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (f) => readFileSync(root + f, "utf8");
const app = read("js/app.js"), html = read("index.html"), util = read("js/util.js"), css = read("css/styles.css");
const files = [...readdirSync(root + "js").filter((f) => f.endsWith(".js")).map((f) => "js/" + f), "index.html", "passwords.html"];

test("every Log out in the page is the shared plain text button, type=button, marked data-logout", () => {
  const buttons = [...html.matchAll(/<button\b([^>]*)>\s*Log out\s*<\/button>/g)].map((m) => m[1]);
  assert.equal(buttons.length, 2, "index.html should have the header's and \"Who are you?\"'s Log out");
  for (const attrs of buttons) {
    assert.match(attrs, /class="ed-btn ed-btn-plain"/);
    assert.match(attrs, /type="button"/);
    assert.match(attrs, /\bdata-logout\b/);
    assert.doesNotMatch(attrs, /\b(title|aria-label)=/, "the words are its name: no tooltip, no aria-label");
  }
  // app.js draws the applicant's through logoutBtn() only
  assert.doesNotMatch(app, />Log out<\/button>/, "a Log out button drawn by hand in app.js");
  assert.match(app, /function logoutBtn\(onclick\) \{\n\s*return `<button type="button" class="ed-btn ed-btn-plain" data-logout onclick="\$\{onclick\}"`/);
  assert.doesNotMatch(app + html, /class="linky"[^>]*>Log out/);
});

test("the header's Log out is its last item; \"Who are you?\" has one at the top right", () => {
  const row = html.match(/<header id="appHeader"[\s\S]*?<div class="brandrow">([\s\S]*?)\n  <\/div>/)[1].trim();
  assert.match(row, /<button id="logout"[^>]*>Log out<\/button>$/, "Log out is not the header row's last item");
  const pick = html.match(/<div id="memberpick"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<header class="gatebar">(<button id="pickLogout"[^>]*>Log out<\/button>)<\/header>/);
  assert.ok(pick, "\"Who are you?\" has no Log out bar before its card");
  assert.match(html, /<div id="memberpick" class="overlay withbar hidden">/);
  assert.match(app, /\$\("#pickLogout"\)\.onclick = \(\) => logOut\(/);
});

test("the applicant's name and paused screens have Log out at the top right, not in the card", () => {
  const paused = app.match(/if \(booking === "paused"\) \{\n\s*el\.innerHTML = `([^`]*)`/)[1];
  assert.match(paused, /^<div class="overlay withbar">\$\{logoutBar\("CAND\.logout\(\)"\)\}<div class="overlay-box"/);
  assert.doesNotMatch(paused.replace(/\$\{logoutBar\([^}]*\)\}/, ""), /logout/i, "the paused card still has its own Log out");
  assert.match(app, /if \(!ui\.candLast\) \{\n\s*el\.innerHTML = `<div class="overlay withbar">\$\{logoutBar\("CAND\.logout\(\)"\)\}<div class="overlay-box"/);
  assert.match(app, /\$\{logoutBtn\("CAND\.logout\(\)"\)\}<\/div><\/header>/, "the applicant's times page header");
});

test("while it waits it reads Logging out…, and the question is the standard one", () => {
  assert.match(app, /function logoutLabel\(\) \{ return ui\.logoutBusy \? "Logging out…" : "Log out"; \}/);
  const fn = app.match(/async function logOut\(keys\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /ui\.logoutBusy = true; paintLogout\(\);[\s\S]*flushPending\(\)/, "the button changes before the wait starts");
  assert.match(fn, /confirmDialog\("Some changes haven't been saved yet\. If you log out now they will be lost\.",\s*(?:\/\/[^\n]*\n\s*)?\{ title: "Log out\?", yes: "Log out anyway", no: "Stay", focus: "no" \}\)/,
    "the question, with the first focus on Stay (Enter must never throw away unsaved work)");
  assert.match(fn, /if \(!ok\) \{\s*\/\/[^\n]*\n\s*ui\.logoutBusy = false; paintLogout\(\);/, "Stay gives the button back");
  // the safety logic stays as it was (H12, R13): the 5 s wait, the 3 s cap on signOut, the reload
  assert.match(fn, /while \(unconfirmed\(\) && Date\.now\(\) - t0 < 5000\)/);
  assert.match(fn, /Promise\.race\(\[fbAuth\.authFns\.signOut\(fbAuth\.auth\), new Promise\(\(r\) => setTimeout\(r, 3000\)\)\]\)/);
  assert.match(fn, /location\.reload\(\);\n\}/);
  // the confirm dialog takes the cancel button's label, and puts "Cancel" back for every other dialog
  assert.match(util, /no\.textContent = opts\.no \|\| "Cancel";/);
  // focus on the cancel button only when asked: every other dialog keeps its focus on yes (or alt)
  assert.match(util, /\(opts\.focus === "no" \? no : opts\.alt && alt \? alt : yes\)\.focus\(\);/);
  assert.equal([...app.matchAll(/focus: "no"/g)].length, 1, "only Log out's question focuses its cancel button");
});

test("the gate says \"You are logged out.\" after Log out", () => {
  assert.match(app, /You are logged out\.\$\{more\}/);
  assert.match(app, /Your scores are saved, but this device won't show them to you again when you log back in\./);
  assert.match(app, /const SIGNED_OUT_MSG = "You were logged out\. Please log in again\.";/);
});

test("Log out never shrinks or wraps, and on a 320 px phone the decoration goes first", () => {
  assert.match(css, /\[data-logout\] \{ flex:none; white-space:nowrap;/);
  assert.match(css, /@media \(max-width:360px\) \{ #appHeader \.brandmark \{ display:none; \} \}/);
});

test("the header says \"Logged in as\", not \"Signed in as\"", () => {
  assert.match(html, /<span>Logged in as <b id="whoLine"><\/b><\/span>/);
  for (const f of files) assert.doesNotMatch(read(f).replace(/<!--[\s\S]*?-->/g, ""), />\s*Signed in as\b|"Signed in as\b/, f);
});

test("no visible words say Sign out, Signed out or Logout", () => {
  const bad = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--")) return;   // comments
      const code = line.replace(/\s\/\/\s.*$/, "");                                                        // a comment after code
      // words, not code names: signOut, SIGNED_OUT_MSG, logOut, #logout have no space
      if (/\b[Ss]ign(ed)?[ -][Oo]ut\b|\bLog-?out\b|\bLogOut\b/.test(code)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
