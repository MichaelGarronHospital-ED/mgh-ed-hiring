// The allowed-surname list sync (app.js syncAllowedNames), lifted out of the
// page and driven on a fake clock. Pins the review fixes: a tab held back
// after a fight with an older tab writes again (ordinary snapshots and the
// retry timer are not fights), and a roster edit made while a write is in
// flight is never missed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("const ALLOWED_WINDOW_MS"), src.indexOf("async function loadFirestore"));
const lastKey = (n) => String(n).trim().split(/\s+/).pop().toLowerCase();

function harness(cands, { autoRelease = true, afterRelease = null } = {}) {
  let now = 0; const timers = []; const writes = [];
  const st = (fn, ms = 0) => { const t = { at: now + ms, fn }; timers.push(t); return t; };
  const ct = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const S = { candidates: cands, allowedNames: null, meta: {} };
  let release = null;
  const store = { setAllowedNames: (k) => new Promise((res) => { writes.push(k.join(",")); release = () => { S.allowedNames = [...k]; res(); }; }) };
  const ui = { role: "admin" };
  const make = new Function("S", "ui", "store", "renderUpdateLine", "roundOpen", "lastKey", "candKey", "Date", "setTimeout", "clearTimeout",
    `${body}\nreturn syncAllowedNames;`);
  const sync = make(S, ui, store, () => {}, () => true, lastKey, (c) => c.availKey || lastKey(c.name), { now: () => now }, st, ct);
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  const run = async (until) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at); const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift(); now = t.at; t.fn(); await flush();
      if (autoRelease && release) { const r = release; release = null; r(); await flush(); if (afterRelease) afterRelease(S); }
    }
    now = until;
  };
  return { S, ui, sync, run, writes, get now() { return now; }, hold: () => release, settle: async () => { const r = release; release = null; if (r) r(); await flush(); } };
}

test("held back after a fight, it writes again: ordinary snapshots and the timer are not fights", async () => {
  const h = harness([{ id: "c1", name: "Dr Jane Kim" }, { id: "c3", name: "Dr R Ashcombe" }]);
  h.sync(); await h.run(h.now + 1000);
  assert.deepEqual(h.S.allowedNames, ["ashcombe", "kim"]);
  const OLD = ["ashcombe"];                                   // an older tab keeps writing this
  for (let i = 0; i < 4; i++) { h.S.allowedNames = OLD; h.sync(); await h.run(h.now + 1000); }
  assert.equal(h.ui._allowed.held, true, "a real fight is not held back");
  // the older tab is closed; ordinary snapshots keep coming
  for (let m = 0; m < 14; m += 2) { await h.run(h.now + 120000); h.sync(); await h.run(h.now + 1000); }
  assert.deepEqual(h.S.allowedNames, ["ashcombe", "kim"], "never wrote again after being held");
  assert.equal(h.ui._allowed.held, false);
});

test("held back with no snapshots at all, the retry timer alone writes again", async () => {
  const h = harness([{ id: "c1", name: "Dr Jane Kim" }]);
  h.sync(); await h.run(h.now + 1000);
  for (let i = 0; i < 4; i++) { h.S.allowedNames = ["other"]; h.sync(); await h.run(h.now + 1000); }
  assert.equal(h.ui._allowed.held, true);
  await h.run(h.now + 11 * 60000);
  assert.deepEqual(h.S.allowedNames, ["kim"]);
});

test("a roster edit made while a write is in flight is picked up once it settles", async () => {
  const cands = [{ id: "c1", name: "Dr Jane Kim" }];
  const h = harness(cands, { autoRelease: false });
  h.sync(); await h.run(h.now + 300);                        // the write starts and is held open
  assert.equal(h.writes.length, 1);
  cands.push({ id: "c2", name: "Dr R Ashcombe" }); h.sync(); await h.run(h.now + 300);
  assert.equal(h.writes.length, 1, "a second write started while one was in flight");
  await h.settle(); await h.run(h.now + 1000); await h.settle(); await h.run(h.now + 1000);
  assert.deepEqual(h.S.allowedNames, ["ashcombe", "kim"]);
});

test("a fight is counted even when the other tab's write lands before this tab looks again", async () => {
  // the older tab answers every write of ours at once, before this tab's next look
  const h = harness([{ id: "c1", name: "Dr Jane Kim" }], { afterRelease: (S) => { S.allowedNames = ["other"]; } });
  for (let i = 0; i < 6; i++) { h.sync(); await h.run(h.now + 1000); }
  assert.equal(h.ui._allowed.held, true, "the fight was never noticed");
  assert.ok(h.writes.length <= 4, `${h.writes.length} writes`);
});

test("a steady stream of snapshots can't put the write off for more than 2 seconds", async () => {
  const h = harness([{ id: "c1", name: "Dr Jane Kim" }]);
  for (let i = 0; i < 20; i++) { h.sync(); await h.run(h.now + 200); }   // a call every 200 ms for 4 s
  assert.ok(h.writes.length >= 1, "never wrote");
});

test("held back after fights, an edit to this tab's own roster is still written", async () => {
  const cands = [{ id: "c1", name: "Dr Jane Kim" }];
  const h = harness(cands);
  h.sync(); await h.run(h.now + 1000);
  for (let i = 0; i < 4; i++) { h.S.allowedNames = ["other"]; h.sync(); await h.run(h.now + 1000); }
  assert.equal(h.ui._allowed.held, true);
  cands.push({ id: "c2", name: "Dr R Ashcombe" }); h.sync(); await h.run(h.now + 1000);
  assert.deepEqual(h.S.allowedNames, ["ashcombe", "kim"]);
});
