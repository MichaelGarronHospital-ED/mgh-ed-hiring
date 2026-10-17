// H3: changing the shared passwords. A fake auth enforces Firebase's
// "recent sign-in" rule on a fake clock (the Auth emulator does not), so this
// is the test that pins it: a 6-minute pause between Check and Change now
// must still change all five accounts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNew, validateCurrent, preflight, applyChange, converge, verify, accountsFor, ACCOUNTS, halfDoneText, makeFirebaseAdapter } from "../js/passwords.js";

const CUR = { leadership: "lead-old-pass-1", ed: "ed-old-pass-22", guest: "guest-old-pass-3" };
const NEXT = { leadership: { value: "lead-new-pass-1", repeat: "lead-new-pass-1" }, ed: { value: "ed-new-pass-22", repeat: "ed-new-pass-22" },
  guest: { value: "guest-new-pass-3", repeat: "guest-new-pass-3" } };

function fakeAuth({ passwords, clock, failUpdateOn = null, refuse = new Set() }) {
  const log = [];
  return {
    log,
    async open(a, pw) {
      log.push(`open ${a.key}`);
      if (refuse.has(a.key) || passwords[a.key] !== pw) { const e = new Error("refused"); e.code = "auth/invalid-credential"; throw e; }
      return { key: a.key, at: clock.now };
    },
    async update(s, v) {
      if (clock.now - s.at > 5 * 60000) { const e = new Error("old"); e.code = "auth/requires-recent-login"; throw e; }
      if (failUpdateOn === s.key) { const e = new Error("network"); e.code = "auth/network-request-failed"; throw e; }
      log.push(`update ${s.key}`); passwords[s.key] = v;
    },
    async close() {},
  };
}
const all = () => Object.fromEntries(ACCOUNTS.map((a) => [a.key, CUR[a.role]]));

test("validation", () => {
  assert.deepEqual(validateNew(["ed"], CUR, { ed: NEXT.ed }), []);
  assert.ok(validateNew([], CUR, {}).includes("Tick at least one password to change."));
  assert.ok(validateNew(["ed"], CUR, { ed: { value: "ed-new-pass-22", repeat: "nope" } })[0].includes("don't match"));
  assert.ok(validateNew(["ed"], CUR, { ed: { value: "short", repeat: "short" } }).some((e) => e.includes("at least 10")));
  assert.ok(validateNew(["ed"], CUR, { ed: { value: " leading-space", repeat: " leading-space" } }).some((e) => e.includes("space")));
  assert.ok(validateNew(["ed"], CUR, { ed: { value: "MyPassword12", repeat: "MyPassword12" } }).some((e) => e.includes('"password"')));
  assert.ok(validateNew(["ed"], CUR, { ed: { value: CUR.ed, repeat: CUR.ed } }).some((e) => e.includes("same as the current")));
  // a value in use now: ONE line that says both things (review)
  const inUse = validateNew(["ed"], CUR, { ed: { value: CUR.guest, repeat: CUR.guest } });
  assert.deepEqual(inUse, ["The new ED password is already in use. The Leadership, ED and Guest passwords must all be different, and none can be one in use now."]);
  assert.ok(validateNew(["ed", "guest"], CUR, { ed: NEXT.ed, guest: { value: NEXT.ed.value, repeat: NEXT.ed.value } }).includes("The Leadership, ED and Guest passwords must all be different."));
  assert.ok(validateNew(["ed"], { ...CUR, guest: "" }, { ed: NEXT.ed }).some((e) => e.includes("current Guest password")));
});

test("Check stops at the first refusal and changes nothing", async () => {
  const clock = { now: 0 }, passwords = all();
  const auth = fakeAuth({ passwords, clock, refuse: new Set(["hiring:committee"]) });
  const r = await preflight(auth, ["ed"], CUR);
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => [x.key, x.ok]), [["voting:ed", true], ["hiring:committee", false]]);
  assert.ok(!auth.log.some((l) => l.startsWith("update")));
});

test("order: voting first, hiring admin@ last; each signed in just before its own change; a 6-minute pause is fine", async () => {
  const clock = { now: 0 }, passwords = all();
  const auth = fakeAuth({ passwords, clock });
  assert.equal((await preflight(auth, ["leadership", "ed", "guest"], CUR)).ok, true);
  clock.now += 6 * 60000;                                   // someone read the warnings slowly
  const r = await applyChange(auth, ["leadership", "ed", "guest"], CUR, NEXT);
  assert.equal(r.failedAt, null, r.error && r.error.message);
  assert.deepEqual(r.changed, ["voting:ed", "voting:leadership", "hiring:committee", "hiring:applicant", "hiring:admin"]);
  const updates = auth.log.filter((l) => l.startsWith("update")).map((l) => l.split(" ")[1]);
  assert.deepEqual(updates, r.changed);
  const after = auth.log.slice(auth.log.indexOf("open voting:ed", 5));
  for (const k of r.changed) {
    const i = after.indexOf(`update ${k}`);
    assert.equal(after[i - 1], `open ${k}`, `${k} was not signed in right before its change`);
  }
  assert.deepEqual(await verify(auth, ["leadership", "ed", "guest"], NEXT), []);
});

test("a change that fails half way is reported plainly and finished by running it again (converge)", async () => {
  const clock = { now: 0 }, passwords = all();
  const auth = fakeAuth({ passwords, clock, failUpdateOn: "hiring:committee" });
  const saved = [];
  const r = await applyChange(auth, ["ed"], CUR, { ed: NEXT.ed }, { record: async (p) => saved.push(p) });
  assert.equal(r.failedAt, "hiring:committee");
  assert.deepEqual(r.done, ["voting:ed"]);
  assert.deepEqual(halfDoneText(["ed"], r.done), ["The ED password is new in Motion Voting but still old in Physician Hiring."]);
  // the page was closed; next visit: done from the record, the in-progress one maybe changed
  const auth2 = fakeAuth({ passwords, clock });
  const last = saved[saved.length - 1];
  const r2 = await applyChange(auth2, ["ed"], CUR, { ed: NEXT.ed }, { progress: last });
  assert.equal(r2.failedAt, null);
  assert.equal(passwords["hiring:committee"], NEXT.ed.value);
  assert.equal(passwords["voting:ed"], NEXT.ed.value);
});

test("converge from every half state, the in-progress account changed or not", async () => {
  const order = accountsFor(["leadership", "ed", "guest"]).map((a) => a.key);
  for (let k = 0; k <= order.length; k++) {
    for (const inProgressChanged of [false, true]) {
      const passwords = all();
      for (let i = 0; i < k; i++) passwords[order[i]] = NEXT[ACCOUNTS.find((a) => a.key === order[i]).role].value;
      const inProgress = order[k] || null;
      if (inProgress && inProgressChanged) passwords[inProgress] = NEXT[ACCOUNTS.find((a) => a.key === inProgress).role].value;
      const auth = fakeAuth({ passwords, clock: { now: 0 } });
      const r = await applyChange(auth, ["leadership", "ed", "guest"], CUR, NEXT, { progress: { done: order.slice(0, k), inProgress } });
      assert.equal(r.failedAt, null, `k=${k} changed=${inProgressChanged}: ${r.error && r.error.message}`);
      for (const key of order) assert.equal(passwords[key], NEXT[ACCOUNTS.find((a) => a.key === key).role].value, `${key} at k=${k}`);
    }
  }
});

test("a requires-recent-login answer is retried once after signing in again", async () => {
  let first = true;
  const passwords = all();
  const auth = { log: [], async open(a, pw) { if (passwords[a.key] !== pw) { const e = new Error(); e.code = "auth/invalid-credential"; throw e; } return { key: a.key }; },
    async update(s, v) { if (first) { first = false; const e = new Error(); e.code = "auth/requires-recent-login"; throw e; } passwords[s.key] = v; }, async close() {} };
  assert.equal(await converge(auth, ACCOUNTS[0], CUR.ed, NEXT.ed.value), "changed");
  assert.equal(passwords["voting:ed"], NEXT.ed.value);
});

test("helpers keep their sign-in in memory only; the page's own account is re-authenticated", async () => {
  const asked = [];
  const sdk = {
    initializeApp: (c, name) => ({ name, c }), deleteApp: async () => {}, inMemoryPersistence: { type: "NONE" },
    initializeAuth: (app, opts) => { asked.push(opts.persistence.type); return { app }; },
    signInWithEmailAndPassword: async (auth, email) => ({ user: { email, uid: ACCOUNTS.find((a) => a.email === email).uid } }), updatePassword: async () => {}, signOut: async () => {},
    reauthenticateWithCredential: async (u, c) => { asked.push("reauth:" + c.e); }, EmailAuthProvider: { credential: (e, p) => ({ e, p }) },
  };
  // the page's own account is recognised by its uid (R7c), whatever its email says now
  const ad = makeFirebaseAdapter(sdk, { mainAuth: { currentUser: { email: "admin@mgh-ed-hiring.invalid", uid: ACCOUNTS.find((a) => a.main).uid } }, configs: { hiring: {}, voting: {} } });
  for (const a of ACCOUNTS) await ad.close(await ad.open(a, "x"));
  assert.deepEqual(asked, ["NONE", "NONE", "NONE", "NONE", "reauth:admin@mgh-ed-hiring.invalid"]);   // the account's email now
});

test("no password value ever reaches the console, storage, or what is recorded", async () => {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.map(String).join(" "));
  const store = []; const stor = { setItem: (k, v) => store.push(String(v)), getItem: () => null, removeItem() {} };
  globalThis.localStorage = stor; globalThis.sessionStorage = stor;
  try {
    const passwords = all();
    const auth = fakeAuth({ passwords, clock: { now: 0 }, failUpdateOn: "hiring:applicant" });
    const recorded = [];
    await preflight(auth, ["leadership", "ed", "guest"], CUR);
    await applyChange(auth, ["leadership", "ed", "guest"], CUR, NEXT, { record: async (p) => recorded.push(JSON.stringify(p)) });
    const everything = [...seen, ...store, ...recorded].join("\n");
    for (const v of [...Object.values(CUR), ...Object.values(NEXT).map((x) => x.value)]) assert.ok(!everything.includes(v), "a password leaked");
  } finally { Object.assign(console, orig); delete globalThis.localStorage; delete globalThis.sessionStorage; }
});

// review M1: a new value already in use somewhere would let that role's holders
// in as the wrong role if the change stopped part way
test("a new value may not be any password in use now, nor a value one tool already has", () => {
  const errs = validateNew(["ed"], CUR, { ed: { value: CUR.guest, repeat: CUR.guest } });
  assert.ok(errs.some((e) => e.includes("is already in use")), errs.join("|"));
  const errs2 = validateNew(["ed"], CUR, { ed: { value: CUR.leadership, repeat: CUR.leadership } });
  assert.ok(errs2.some((e) => e.includes("is already in use")));
  const errs3 = validateNew(["ed"], CUR, { ed: NEXT.ed }, { "voting:leadership": NEXT.ed.value });
  assert.ok(errs3.some((e) => e.includes("is already in use")));
  assert.deepEqual(validateNew(["ed"], CUR, { ed: NEXT.ed }, { "voting:ed": "some-old-voting-ed" }), []);
});

test("Check also proves the Physician Hiring account of each unticked password", async () => {
  const passwords = all();
  const auth = fakeAuth({ passwords, clock: { now: 0 } });
  const r = await preflight(auth, ["ed"], CUR);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.key), ["voting:ed", "hiring:committee", "hiring:applicant", "hiring:admin"]);
  // the typed current Guest value is wrong: Check says so, so "all different" never rests on it
  const bad = await preflight(fakeAuth({ passwords, clock: { now: 0 } }), ["ed"], { ...CUR, guest: "not-the-guest-value" });
  assert.equal(bad.ok, false);
  assert.equal(bad.results[bad.results.length - 1].key, "hiring:applicant");
  assert.ok(!auth.log.some((l) => l.startsWith("update")));
});

test("a check after the change that couldn't connect is not a mismatch; Try again finishes from the new value", async () => {
  const passwords = all();
  const auth = fakeAuth({ passwords, clock: { now: 0 } });
  const r = await applyChange(auth, ["ed"], CUR, { ed: NEXT.ed });
  assert.equal(r.failedAt, null);
  const flaky = { ...auth, async open(a, pw) { if (a.key === "hiring:committee") { const e = new Error("net"); e.code = "auth/network-request-failed"; throw e; } return auth.open(a, pw); } };
  const bad = await verify(flaky, ["ed"], { ed: NEXT.ed });
  assert.deepEqual(bad.map((b) => [b.key, b.why]), [["hiring:committee", "error"]]);
  // Try again with the unconfirmed account marked unsure: checked with the new value, nothing changed twice
  const again = await applyChange(auth, ["ed"], CUR, { ed: NEXT.ed }, { progress: { done: ["voting:ed"], unsure: ["hiring:committee"] } });
  assert.equal(again.failedAt, null, again.error && again.error.message);
  assert.equal(passwords["hiring:committee"], NEXT.ed.value);
});

// The page asks for the current values first (Check), and the new ones only
// after Check passed (Alvin's phone check: Check showed nothing because it
// wanted the new values too).
test("Check needs only the current values", () => {
  assert.deepEqual(validateCurrent(["ed"], CUR), []);
  assert.deepEqual(validateCurrent(["ed"], { ...CUR, guest: "" }), ["Type the current Guest password."]);
  assert.deepEqual(validateCurrent([], CUR), ["Tick at least one password to change."]);
});

test("finishing: Check skips the accounts that may already have the new value", async () => {
  const passwords = all();
  passwords["voting:ed"] = NEXT.ed.value;              // changed the first time
  const auth = fakeAuth({ passwords, clock: { now: 0 } });
  const r = await preflight(auth, ["ed"], CUR, {}, ["voting:ed"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.key), ["hiring:committee", "hiring:applicant", "hiring:admin"]);
});

test("finishing with a different new value than the first time says so (not a loop of Try again)", async () => {
  const passwords = all();
  passwords["voting:ed"] = NEXT.ed.value;
  const auth = fakeAuth({ passwords, clock: { now: 0 } });
  const r = await applyChange(auth, ["ed"], CUR, { ed: { value: "another new value", repeat: "another new value" } }, { progress: { done: ["voting:ed"], inProgress: null } });
  assert.equal(r.failedAt, "voting:ed");
  assert.equal(r.error.code, "not-first-value");
  assert.equal(passwords["hiring:committee"], CUR.ed, "went on to change the others with a different value");
});

test("a helper sign-in that lands on another uid than the role account's is a refusal", async () => {
  const sdk = {
    initializeApp: (c, name) => ({ name }), deleteApp: async () => {}, inMemoryPersistence: { type: "NONE" },
    initializeAuth: (app) => ({ app }), signOut: async () => {},
    signInWithEmailAndPassword: async (auth, email) => ({ user: { email, uid: "someone-else" } }),
    updatePassword: async () => {}, reauthenticateWithCredential: async () => {}, EmailAuthProvider: { credential: () => ({}) },
  };
  const ad = makeFirebaseAdapter(sdk, { mainAuth: null, configs: { hiring: {}, voting: {} } });
  await assert.rejects(() => ad.open(ACCOUNTS[0], "x"), (e) => e.code === "auth/invalid-credential");
});
