// The role accounts as the rules know them (R7c, rules v3): by UID, signed in
// with a password. The uids come from js/config.js (tests/uids.test.mjs keeps
// them equal to firestore.rules). `as(role, email)` is the token options for
// @firebase/rules-unit-testing's authenticatedContext(uid, options).
import { AUTH } from "../../js/config.js";

export const UID = { admin: AUTH.uids.admin, committee: AUTH.uids.committee, applicant: AUTH.uids.candidate };
export const OLD_EMAIL = { admin: "admin@ed-hiring.app", committee: "committee@ed-hiring.app", applicant: "applicant@ed-hiring.app" };
export const NEW_EMAIL = { admin: "admin@mgh-ed-hiring.invalid", committee: "committee@mgh-ed-hiring.invalid", applicant: "applicant@mgh-ed-hiring.invalid" };
// a password sign-in with this email
export const pw = (email) => ({ email, firebase: { sign_in_provider: "password" } });
