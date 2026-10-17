// ============================================================================
//  Signing in to a role account while its email moves (Phase A, R7c).
//
//  Each role account has two emails for a while: the old one (ed-hiring.app,
//  ed-motion-voting.app) and the new .invalid one. migrate-emails.py switches
//  them in one go (and --undo switches them back), but a page can't know when:
//  the page is pushed a minute later, an open page or a cached one (up to 10
//  minutes) still holds the old constants. So every sign-in tries the email
//  that last worked on this browser first (only the KIND, "old" or "new", is
//  kept, per project; never a password), else the old one; if that answer is a
//  wrong-password or no-such-account refusal, it tries the other one once. An
//  account is accepted only if its uid is the pinned uid. R7d (a few weeks after
//  the window) drops the old emails and this fallback.
// ============================================================================
import { ls } from "./util.js?v=R8";

const KIND_KEY = { hiring: "ed_iv_emailkind", voting: "ed_iv_emailkind_voting" };
// "old" first unless "new" worked last on this browser
export const emailOrder = (project) => (ls.get(KIND_KEY[project]) === "new" ? ["new", "old"] : ["old", "new"]);
export const rememberKind = (project, kind) => { if (kind === "new" || kind === "old") ls.set(KIND_KEY[project], kind); };
export const isRefusal = (e) => /wrong-password|invalid-credential|user-not-found|invalid-login-credentials|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/i
  .test(String((e && (e.code || e.message)) || ""));
export const refusal = (msg = "refused") => Object.assign(new Error(msg), { code: "auth/invalid-credential" });

// signIn(email, password) -> credential (throws {code} on failure).
// acct: { emails: { old, new }, uid, project }. order: the kinds to try.
// -> { cred, kind }. Throws a refusal when every email refused, or another
// error (network, too many attempts, disabled) as soon as one happens.
export async function signInPinned(signIn, acct, password, { order = emailOrder(acct.project), onWrongUid = async () => {} } = {}) {
  let last = null;
  for (const kind of order) {
    const email = acct.emails[kind];
    if (!email) continue;
    try {
      const cred = await signIn(email, password);
      // only the pinned account: another uid behind the email is a refusal
      if (cred && cred.user && cred.user.uid === acct.uid) return { cred, kind };
      await onWrongUid(cred);
      last = refusal("not the role account");
    } catch (e) {
      if (!isRefusal(e)) throw e;
      last = e;
    }
  }
  throw last || refusal();
}
