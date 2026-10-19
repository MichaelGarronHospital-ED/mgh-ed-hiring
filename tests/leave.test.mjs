// R15: closing the tab while a save is still waiting loses it, so the browser
// asks "Leave page?" then, and only then; the page's own reloads never ask.
// And a backup is made from the server or not at all. Pinned here from the
// source; what the page does is played through the real page in
// sim/logout.mjs (leaveAsksOnlyWhileSaving, ownReloadsDontAsk) and
// sim/emulator.mjs (leaveAndBackupOffline: real Firestore, offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = readFileSync(root + "js/app.js", "utf8");
const store = readFileSync(root + "js/store.js", "utf8");
const code = app.replace(/^\s*\/\/.*$/gm, "");   // without comment lines

test("the browser asks only while a save is unconfirmed, and never once the page is leaving by itself", () => {
  const h = app.match(/window\.addEventListener\("beforeunload", \(e\) => \{\n([\s\S]*?)\n\}\);/);
  assert.ok(h, "no beforeunload handler");
  const body = h[1].split("\n").map((l) => l.trim());
  assert.deepEqual(body.slice(0, 5), [
    "if (leaving) return;",
    "flushPending();",            // a note or score still pausing is sent, and counts
    "if (!unconfirmed()) return;",
    "e.preventDefault();",
    'e.returnValue = "";   // older browsers ask only when this is set too',
  ]);
  assert.equal([...app.matchAll(/addEventListener\("beforeunload"/g)].length, 1, "one beforeunload handler");
  // what counts as waiting is what Log out waits for (R13)
  assert.match(app, /const unconfirmed = \(\) => pendingWrites > 0 \|\| Object\.keys\(inflight\)\.length > 0;/);
  // back from the back/forward cache, it asks again
  assert.match(app, /window\.addEventListener\("pageshow", \(e\) => \{ if \(e\.persisted\) leaving = false; \}\);/);
});

test("every reload and navigation the page makes itself goes through leavePage()", () => {
  const leaving = [...code.matchAll(/location\.reload\(\)|location\.href\s*=[^=]|location\.(?:replace|assign)\(/g)];
  const outside = leaving.filter((m) => {
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    if (/leavePage\(\(\) => (?:\{ window\.)?$/.test(before)) return false;
    // the one left to the browser's question: the "Reload" link the person taps
    if (code.slice(m.index - 9, m.index + 18) === 'onclick="location.reload()"') return false;
    return true;
  }).map((m) => code.slice(m.index - 60, m.index + 30));
  assert.deepEqual(outside, [], "a reload or navigation that would ask \"Leave page?\" for the page's own reasons");
  // the four the page makes: a sign-in that ended, Log out, the new-release reload, the email link
  assert.match(app, /ss\.set\("ed_iv_signedout", "1"\);\n\s*leavePage\(\(\) => location\.reload\(\)\);/);
  assert.match(app, /ss\.set\("ed_iv_reloaded_for", ui\.newVersion\); leavePage\(\(\) => location\.reload\(\)\); return;/);
  assert.match(app, /leavePage\(\(\) => \{ window\.location\.href = link; \}, \{ stays: true \}\)/);
  // the email link leaves the page open: the question comes back after it
  assert.match(app, /if \(stays\) setTimeout\(\(\) => \{ leaving = false; \}, 1000\);/);
  // only the person's own Reload tap is left to the browser
  assert.equal([...app.matchAll(/onclick="location\.reload\(\)"/g)].length, 1);
});

test("Log out asks once: its own question, then a reload the browser doesn't question", () => {
  const fn = app.match(/async function logOut\(keys\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /if \(unconfirmed\(\)\) \{\n\s*const ok = await confirmDialog\(/, "Log out still asks first");
  assert.match(fn, /leavePage\(\(\) => location\.reload\(\)\);\n\}\n$/, "Log out's reload is not through leavePage()");
  assert.doesNotMatch(fn.replace(/leavePage\(\(\) => location\.reload\(\)\)/, ""), /location\.reload/);
});

test("a backup and the Excel file are made from the server or not at all, and say so", () => {
  assert.match(app, /getDocsFromServer: f\.getDocsFromServer/, "loadFirestore doesn't hand over getDocsFromServer");
  assert.match(app, /downloadBackup: \(btn\) => withBusy\(btn \|\| null, async \(\) => \{\n\s*const raw = await serverRead\("Backup"\);/);
  assert.match(app, /exportCycle: \(btn\) => withBusy\(btn, async \(\) => \{\n\s*downloadExcel\(toState\(await serverRead\("Excel file"\)\)\);/);
  assert.match(app, /if \(e && e\.code === "offline-read"\) throw new Error\(`\$\{what\} not made: you seem to be offline\. Connect and try again\.`\);/);
  // store: the server read, the browser's own offline flag, and an answer from the cache
  const snap = store.match(/class FirestoreStore[\s\S]*?\n  async snapshotRaw\(\) \{\n([\s\S]*?)\n  \}\n/)[1];
  assert.match(snap, /if \(typeof navigator !== "undefined" && navigator\.onLine === false\) throw offlineRead\(\);/);
  assert.match(snap, /const read = getDocsFromServer \|\| getDocs;/);
  assert.match(snap, /if \(snaps\.some\(\(s\) => s && s\.metadata && s\.metadata\.fromCache\)\) throw offlineRead\(\);/);
  // a cached page from before R1 is filled from 10.12.2 only for what it lacks; getDocsFromServer
  // is NOT on that list (an R1 to R14 page would pull in a second SDK copy); getDocs stands in
  assert.doesNotMatch(store.match(/const NEED = \[[^\]]*\]/)[0], /getDocsFromServer/);
});

test("the new words are plain (no em dash)", () => {
  for (const s of ["not made: you seem to be offline. Connect and try again.", "You seem to be offline. Connect and try again."]) {
    assert.ok(app.includes(s) || store.includes(s), s);
    assert.ok(!s.includes("—"));
  }
});
