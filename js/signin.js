// ============================================================================
//  Signing in to a role account: one email, and only the pinned uid.
//
//  R7c tried two emails per account while they moved to .invalid (the one
//  that last worked on this browser first, then the other). R8b (the R7d
//  cleanup, after the switch) drops that: each account has its one .invalid
//  email. An account is still accepted only if its uid is the pinned uid, so
//  an email that ever pointed at another account is refused like a wrong
//  password.
// ============================================================================
import { ls } from "./util.js?v=R10";

// R7c kept which email kind worked last here; nothing reads it any more
ls.del("ed_iv_emailkind"); ls.del("ed_iv_emailkind_voting");

// Kept one more release (removed in the release after R8b): an older page
// still open or cached imports these and calls signInPinned with
// { emails: { old, new } }. They point it at the new email only.
export const emailOrder = () => ["new"];
export const rememberKind = () => {};

export const isRefusal = (e) => /wrong-password|invalid-credential|user-not-found|invalid-login-credentials|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/i
  .test(String((e && (e.code || e.message)) || ""));
export const refusal = (msg = "refused") => Object.assign(new Error(msg), { code: "auth/invalid-credential" });

// signIn(email, password) -> credential (throws {code} on failure).
// acct: { email, uid } (or an older page's { emails: { new }, uid }).
// -> { cred, kind: "new" }. Throws a refusal for a wrong password or another
// uid behind the email, or the error itself (network, too many attempts,
// disabled).
export async function signInPinned(signIn, acct, password, { onWrongUid = async () => {} } = {}) {
  const email = acct.email || (acct.emails && acct.emails.new);
  if (!email) throw refusal("no email");
  const cred = await signIn(email, password);
  if (cred && cred.user && cred.user.uid === acct.uid) return { cred, kind: "new" };
  await onWrongUid(cred);
  throw refusal("not the role account");
}
