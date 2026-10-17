// R7c (Phase A window): every sign-in tries the email that last worked on this
// browser, else the old one, then the other once; only the pinned uid counts.
// Before --apply, after --apply with an R7c page, after --undo; a wrong password
// is refused (both tried); another uid behind an email is a refusal; anything
// but a refusal (network, too many attempts) stops at once.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
const { emailOrder, rememberKind, signInPinned } = await import("../js/signin.js");

const ACCT = { emails: { old: "admin@ed-hiring.app", new: "admin@mgh-ed-hiring.invalid" }, uid: "UID-ADMIN", project: "hiring" };
// a fake Firebase: email -> { password, uid }; counts calls
function server(accounts) {
  const calls = [];
  const signIn = async (email, pw) => {
    calls.push(email);
    const a = accounts[email];
    if (!a || a.password !== pw) throw Object.assign(new Error("refused"), { code: "auth/invalid-credential" });
    return { user: { uid: a.uid, email } };
  };
  return { signIn, calls };
}
const login = async (srv, pw) => {
  const r = await signInPinned(srv.signIn, ACCT, pw);
  rememberKind("hiring", r.kind);
  return r;
};

test("before --apply: the old email, one sign-in", async () => {
  store.clear();
  const s = server({ "admin@ed-hiring.app": { password: "lead pw 1", uid: "UID-ADMIN" } });
  const r = await login(s, "lead pw 1");
  assert.equal(r.kind, "old");
  assert.deepEqual(s.calls, ["admin@ed-hiring.app"]);
});

test("after --apply with an R7c page: the old email is refused, the new one works and is tried first next time", async () => {
  store.clear();
  const s = server({ "admin@mgh-ed-hiring.invalid": { password: "lead pw 1", uid: "UID-ADMIN" } });
  const r = await login(s, "lead pw 1");
  assert.equal(r.kind, "new");
  assert.deepEqual(s.calls, ["admin@ed-hiring.app", "admin@mgh-ed-hiring.invalid"]);
  assert.deepEqual(emailOrder("hiring"), ["new", "old"]);
  s.calls.length = 0;
  await login(s, "lead pw 1");
  assert.deepEqual(s.calls, ["admin@mgh-ed-hiring.invalid"], "the second sign-in should need one call");
});

test("after --undo: this browser tries the new email first, then the old one works", async () => {
  store.clear(); rememberKind("hiring", "new");
  const s = server({ "admin@ed-hiring.app": { password: "lead pw 1", uid: "UID-ADMIN" } });
  const r = await login(s, "lead pw 1");
  assert.equal(r.kind, "old");
  assert.deepEqual(s.calls, ["admin@mgh-ed-hiring.invalid", "admin@ed-hiring.app"]);
});

test("a wrong password is refused after both emails; nothing remembered", async () => {
  store.clear();
  const s = server({ "admin@ed-hiring.app": { password: "lead pw 1", uid: "UID-ADMIN" } });
  await assert.rejects(() => signInPinned(s.signIn, ACCT, "wrong"), (e) => e.code === "auth/invalid-credential");
  assert.equal(s.calls.length, 2);
  assert.equal(store.size, 0);
});

test("an account with another uid behind an email is a refusal (a squatter on a freed old email)", async () => {
  store.clear();
  let signedOut = 0;
  const s = server({ "admin@ed-hiring.app": { password: "squat", uid: "SOMEONE-ELSE" }, "admin@mgh-ed-hiring.invalid": { password: "lead pw 1", uid: "UID-ADMIN" } });
  await assert.rejects(() => signInPinned(s.signIn, ACCT, "squat", { onWrongUid: async () => { signedOut++; } }), (e) => e.code === "auth/invalid-credential");
  assert.equal(signedOut, 1);
  // and the real password still reaches the real account under its new email
  assert.equal((await signInPinned(s.signIn, ACCT, "lead pw 1")).kind, "new");
});

test("a network error or a pause stops at once (no second email)", async () => {
  store.clear();
  const calls = [];
  const signIn = async (email) => { calls.push(email); throw Object.assign(new Error("x"), { code: "auth/too-many-requests" }); };
  await assert.rejects(() => signInPinned(signIn, ACCT, "x"), (e) => e.code === "auth/too-many-requests");
  assert.equal(calls.length, 1);
});
