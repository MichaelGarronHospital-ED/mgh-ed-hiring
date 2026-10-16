// H3: changing the shared passwords. A fake auth enforces Firebase's
// "recent sign-in" rule on a fake clock (the Auth emulator does not), so this
// is the test that pins it: a 6-minute pause between Check and Change now
// must still change all five accounts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNew, preflight, applyChange, converge, verify, accountsFor, ACCOUNTS, halfDoneText, makeFirebaseAdapter } from "../js/passwords.js";

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
  assert.ok(validateNew(["ed"], CUR, { ed: { value: CUR.guest, repeat: CUR.guest } }).some((e) => e.includes("must all be different")));
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
    signInWithEmailAndPassword: async (auth, email) => ({ user: { email } }), updatePassword: async () => {}, signOut: async () => {},
    reauthenticateWithCredential: async (u) => { asked.push("reauth:" + u.email); }, EmailAuthProvider: { credential: (e, p) => ({ e, p }) },
  };
  const ad = makeFirebaseAdapter(sdk, { mainAuth: { currentUser: { email: "admin@ed-hiring.app" } }, configs: { hiring: {}, voting: {} } });
  for (const a of ACCOUNTS) await ad.close(await ad.open(a, "x"));
  assert.deepEqual(asked, ["NONE", "NONE", "NONE", "NONE", "reauth:admin@ed-hiring.app"]);
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
