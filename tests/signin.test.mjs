// R8b (the R7d cleanup): a sign-in uses the account's one .invalid email
// (R7c's two-email fallback is gone); only the pinned uid counts; a wrong password is one
// refused call; another uid behind the email is a refusal; anything but a
// refusal (network, too many attempts) is passed on as it is.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map([["ed_iv_emailkind", "new"], ["ed_iv_emailkind_voting", "old"], ["ed_iv_lastrole", "admin"]]);
globalThis.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
const signin = await import("../js/signin.js");
const { signInPinned } = signin;

const ACCT = { email: "admin@mgh-ed-hiring.invalid", uid: "UID-ADMIN" };
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

test("R7c's remembered email kinds are deleted on load; nothing else is touched", () => {
  assert.equal(store.has("ed_iv_emailkind"), false);
  assert.equal(store.has("ed_iv_emailkind_voting"), false);
  assert.equal(store.get("ed_iv_lastrole"), "admin");
});

// kept one more release (CLAUDE.md: never remove an export in the release that
// stops using it): an older page, still open or cached, imports these and
// passes { emails: { old, new } }. It now signs in with the new email only.
test("an older page's imports still work and reach the new email only", async () => {
  assert.deepEqual(signin.emailOrder("hiring"), ["new"]);
  assert.deepEqual(signin.emailOrder("voting"), ["new"]);
  signin.rememberKind("hiring", "old");
  assert.equal(store.has("ed_iv_emailkind"), false);
  const s = server({ "admin@mgh-ed-hiring.invalid": { password: "lead pw 1", uid: "UID-ADMIN" } });
  const old = { emails: { old: "admin@old-domain.example", new: "admin@mgh-ed-hiring.invalid" }, uid: "UID-ADMIN", project: "hiring" };
  const r = await signInPinned(s.signIn, old, "lead pw 1", { order: signin.emailOrder("hiring") });
  assert.equal(r.kind, "new");
  assert.deepEqual(s.calls, ["admin@mgh-ed-hiring.invalid"]);
});

test("the right password: one sign-in with the .invalid email", async () => {
  const s = server({ "admin@mgh-ed-hiring.invalid": { password: "lead pw 1", uid: "UID-ADMIN" } });
  const r = await signInPinned(s.signIn, ACCT, "lead pw 1");
  assert.equal(r.cred.user.uid, "UID-ADMIN");
  assert.deepEqual(s.calls, ["admin@mgh-ed-hiring.invalid"]);
});

test("a wrong password is one refused call; no other email is tried", async () => {
  const s = server({ "admin@mgh-ed-hiring.invalid": { password: "lead pw 1", uid: "UID-ADMIN" } });
  await assert.rejects(() => signInPinned(s.signIn, ACCT, "wrong"), (e) => e.code === "auth/invalid-credential");
  assert.deepEqual(s.calls, ["admin@mgh-ed-hiring.invalid"]);
});

test("another uid behind the email is a refusal, and is signed out", async () => {
  let signedOut = 0;
  const s = server({ "admin@mgh-ed-hiring.invalid": { password: "squat", uid: "SOMEONE-ELSE" } });
  await assert.rejects(() => signInPinned(s.signIn, ACCT, "squat", { onWrongUid: async () => { signedOut++; } }), (e) => e.code === "auth/invalid-credential");
  assert.equal(signedOut, 1);
});

test("a network error or a pause is passed on as it is", async () => {
  const calls = [];
  const signIn = async (email) => { calls.push(email); throw Object.assign(new Error("x"), { code: "auth/too-many-requests" }); };
  await assert.rejects(() => signInPinned(signIn, ACCT, "x"), (e) => e.code === "auth/too-many-requests");
  assert.equal(calls.length, 1);
});
