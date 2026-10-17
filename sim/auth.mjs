// Sign-in and Log out against a STUB Firebase. Every other sim runs on
// LocalStore, so none of them ever reaches the Firebase half of the gate. This
// one serves the test copy of the tool with a dummy firebaseConfig and answers
// the three gstatic imports with tiny fakes that write down what the app asked
// of them. Nothing here can reach Firebase or real data.
//
// What it pins (Oct 2026 security pass; R7 sign-in by order):
//   - the sign-in is kept for this tab only (browserSessionPersistence), set
//     BEFORE signing in;
//   - the role is found by signing in, in order: ED, Guest, Leadership; the
//     role that last worked on this browser first; Guest first on #apply;
//     all refused is "Incorrect password.";
//   - the password is never kept in sessionStorage (an older page's
//     "ed_iv_code" is deleted on load), and a reload in the same tab resumes
//     from Firebase's own tab-only sign-in without signing in again;
//   - a sign-in that ends while the page is open (a password changed
//     elsewhere) returns to the gate and says why;
//   - Log out (committee header and applicant page) calls Firebase signOut
//     before reloading, and nothing signs in again afterwards;
//   - a browser that blocks sessionStorage falls back to memory only and can
//     still sign in.
import fs from "node:fs";
import path from "node:path";
import { serve, browser, signIn, pickMember, landAsAdmin, sleep, SITE } from "./drive.mjs";

const GS = "https://www.gstatic.com/firebasejs/10.12.2/";
const { AUTH } = await import(new URL("../js/config.js", import.meta.url));
const UID_BY_EMAIL = { [AUTH.adminEmail]: AUTH.uids.admin, [AUTH.committeeEmail]: AUTH.uids.committee, [AUTH.candidateEmail]: AUTH.uids.candidate };
const STUB = {
  "firebase-app.js": `export function initializeApp(c) { return { options: c }; } export async function deleteApp() {}`,
  // The fake keeps the tab-only sign-in in sessionStorage ("__stubuser"), like
  // the real SDK, so a reload can resume from it; passwords are the sim's three.
  "firebase-auth.js": `
    const log = (e) => { const a = JSON.parse(localStorage.getItem("__authlog") || "[]"); a.push(e); localStorage.setItem("__authlog", JSON.stringify(a)); };
    const PW = { "admin@ed-hiring.app": "adminpw", "committee@ed-hiring.app": "staffpw", "applicant@ed-hiring.app": "guestpw" };
    // the accounts' uids (the same as js/config.js): a role is known by uid (R7c)
    const UID = ${JSON.stringify(UID_BY_EMAIL)};
    export const browserSessionPersistence = { type: "SESSION" };
    export const browserLocalPersistence = { type: "LOCAL" };
    export const inMemoryPersistence = { type: "NONE" };
    const subs = new Set();
    let kept = null; try { kept = JSON.parse(sessionStorage.getItem("__stubuser") || "null"); } catch {}
    const theAuth = { currentUser: kept, persistence: "SESSION", async authStateReady() {} };
    const fire = () => subs.forEach((f) => f(theAuth.currentUser));
    window.__stubRevoke = () => { theAuth.currentUser = null; try { sessionStorage.removeItem("__stubuser"); } catch {} log("revoked"); fire(); };
    // what the admin API's email change does to a signed-in tab: same uid, new email
    window.__stubChangeEmail = (email) => { const u = { ...theAuth.currentUser, email }; theAuth.currentUser = u;
      try { sessionStorage.setItem("__stubuser", JSON.stringify(u)); } catch {} PW[email] = PW[Object.keys(UID).find((e) => UID[e] === u.uid)]; };
    export function getAuth() { return theAuth; }
    export function initializeAuth() { return { currentUser: null }; }
    export async function setPersistence(auth, p) { auth.persistence = p.type; log("persist:" + p.type); }
    export async function signInWithEmailAndPassword(auth, email, pw) {
      if (PW[email] !== pw) { log("refused:" + email); const e = new Error("refused"); e.code = "auth/invalid-credential"; throw e; }
      log("signIn:" + email); auth.currentUser = { email, uid: UID[email] };
      if (auth.persistence === "SESSION") try { sessionStorage.setItem("__stubuser", JSON.stringify(auth.currentUser)); } catch {}
      fire(); return { user: auth.currentUser };
    }
    export function onAuthStateChanged(auth, f) { subs.add(f); setTimeout(() => f(auth.currentUser), 0); return () => subs.delete(f); }
    export async function signOut(auth) { log("signOut"); auth.currentUser = null; try { sessionStorage.removeItem("__stubuser"); } catch {} fire(); }`,
  "firebase-firestore.js": `
    const snap = { docs: [], data: () => undefined, exists: () => false };
    export function getFirestore() { return {}; }
    export function collection(db, name) { return { name }; }
    export function doc(db, name, id) { return { name, id }; }
    export async function setDoc() {}
    export async function updateDoc() {}
    export function deleteField() { return { __delete: true }; }
    export function serverTimestamp() { return { __ts: true }; }
    export const Timestamp = { fromDate: (d) => d };
    export function writeBatch() { return { set() {}, update() {}, delete() {}, async commit() {} }; }
    export async function getDoc() { return snap; }
    export async function getDocs() { return snap; }
    export async function deleteDoc() {}
    export function query(...a) { return a; }
    export function orderBy() { return {}; }
    export function limit() { return {}; }
    export function startAfter() { return {}; }
    export async function runTransaction(db, fn) { return fn({ get: async () => snap, set() {}, update() {}, delete() {} }); }
    export function onSnapshot(ref, next) { setTimeout(() => next(snap), 0); return () => {}; }`,
};

const config = fs.readFileSync(path.join(SITE, "js/config.js"), "utf8")
  .replace("export const firebaseConfig = {};", 'export const firebaseConfig = { apiKey: "stub", projectId: "stub" };');
if (!config.includes('apiKey: "stub"')) throw new Error("could not switch the test copy's config to the stub Firebase");

let fails = 0;
const R = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`); };

const site = await serve();
const b = await browser();
const log = [];

async function page({ blockSession = false, hash = "" } = {}) {
  const p = await b.newPage();
  p.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  await p.setRequestInterception(true);
  p.on("request", (req) => {
    const u = req.url();
    if (u.startsWith(GS)) {
      const body = STUB[u.slice(GS.length)];
      if (!body) return req.respond({ status: 404, body: "" });
      return req.respond({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body });
    }
    if (u.split("?")[0].endsWith("/js/config.js")) return req.respond({ status: 200, contentType: "text/javascript", body: config });
    req.continue();
  });
  if (blockSession) {
    // what iOS "Block All Cookies" does: the getter itself throws
    await p.evaluateOnNewDocument(() => {
      Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
    });
  }
  await p.goto(site.url + hash, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => { localStorage.clear(); try { sessionStorage.clear(); } catch {} });
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForFunction("window.__edReady === true", { timeout: 15000 });
  return p;
}
const authLog = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("__authlog") || "[]"));
const gateShown = (p) => p.$eval("#gate", (e) => !e.classList.contains("hidden"));
async function reloaded(p, act) {
  await Promise.all([p.waitForNavigation({ waitUntil: "domcontentloaded" }), act()]);
  await p.waitForFunction("window.__edReady === true", { timeout: 15000 });
  await sleep(300);
}

try {
  // ---- ED password (committee) -------------------------------------------
  { const p = await page();
    await signIn(p, "staffpw");
    await pickMember(p, "Vojdani");
    let a = await authLog(p);
    R("ED: session-only persistence set before signing in, ED tried first",
      a.join() === "persist:SESSION,signIn:committee@ed-hiring.app", a.join());
    R("ED: the password is not kept in sessionStorage", !(await p.evaluate(() => JSON.stringify(sessionStorage)).then((t) => t.includes("staffpw"))));

    await reloaded(p, () => p.reload());
    a = await authLog(p);
    R("ED: a reload in the same tab resumes without signing in again",
      !(await gateShown(p)) && a.length === 2, a.join());
    await pickMember(p, "Vojdani");

    await reloaded(p, () => p.click("#logout"));
    a = await authLog(p);
    R("ED: Log out signs out of Firebase, then shows the gate",
      a[a.length - 1] === "signOut" && (await gateShown(p)), a.join());
    await p.close(); }

  // ---- Leadership password -------------------------------------------------
  { const p = await page();
    await signIn(p, "adminpw");
    await landAsAdmin(p);
    let a = await authLog(p);
    R("Leadership on a new browser: ED and Guest refuse, then Leadership",
      a.join() === "persist:SESSION,refused:committee@ed-hiring.app,refused:applicant@ed-hiring.app,signIn:admin@ed-hiring.app", a.join());
    await reloaded(p, () => p.click("#logout"));
    a = await authLog(p);
    R("Leadership: signs out on Log out", a[a.length - 1] === "signOut" && (await gateShown(p)), a.join());
    await p.evaluate(() => localStorage.setItem("__authlog", "[]"));
    await signIn(p, "adminpw");
    await landAsAdmin(p);
    a = await authLog(p);
    R("Leadership again on the same browser: the remembered role first, nothing refused",
      a.join() === "persist:SESSION,signIn:admin@ed-hiring.app", a.join());
    await p.close(); }

  // ---- Guest password (applicant) -----------------------------------------
  { const p = await page({ hash: "#apply" });
    await signIn(p, "guestpw");
    await p.waitForSelector("#candview:not(.hidden)");
    let a = await authLog(p);
    R("Guest on an applicant link: Guest tried first", a.join() === "persist:SESSION,signIn:applicant@ed-hiring.app", a.join());
    await reloaded(p, () => p.evaluate(() => window.CAND.logout()));
    a = await authLog(p);
    R("Guest: Log out signs out", a[a.length - 1] === "signOut" && (await gateShown(p)), a.join());
    await p.close(); }

  // ---- a wrong password ---------------------------------------------------
  { const p = await page();
    await signIn(p, "not-a-password");
    await p.waitForFunction(() => /Incorrect password/.test(document.querySelector("#gerr").textContent), { timeout: 5000 }).catch(() => {});
    const a = await authLog(p);
    R("wrong password: every role refused once, then \"Incorrect password.\"",
      a.filter((x) => x.startsWith("refused:")).length === 3 && (await p.$eval("#gerr", (e) => e.textContent)).includes("Incorrect password."), a.join());
    await p.close(); }

  // ---- three wrong passwords: the device waits 30 seconds ---------------------
  { const p = await page();
    for (let i = 0; i < 3; i++) { await signIn(p, "wrong-" + i); await sleep(300); }
    const btn = await p.$eval("#gbtn", (b) => [b.disabled, b.textContent]);
    const before = (await authLog(p)).filter((x) => x.startsWith("refused:")).length;
    await p.click("#gbtn"); await sleep(300);
    const after = (await authLog(p)).filter((x) => x.startsWith("refused:")).length;
    const msg = await p.$eval("#gerr", (e) => e.textContent);
    R("three wrong passwords: the page waits 30 seconds before another try",
      btn[0] === true && /^Wait \d+ s$/.test(btn[1]) && before === 9 && after === 9 && msg.includes("wait 30 seconds"), `${btn} ${before} ${after} ${msg}`);
    await p.close(); }

  // ---- an older page's saved password is deleted -----------------------------
  { const p = await page();
    await p.evaluate(() => sessionStorage.setItem("ed_iv_code", "staffpw"));
    await reloaded(p, () => p.reload());
    const a = await authLog(p);
    R("an older page's saved password is deleted on load and never replayed",
      (await p.evaluate(() => sessionStorage.getItem("ed_iv_code"))) === null && !a.some((x) => x.startsWith("signIn")) && (await gateShown(p)), a.join());
    await p.close(); }

  // ---- R7c: the account's email changes while signed in -----------------------
  { const p = await page();
    await signIn(p, "adminpw");
    await landAsAdmin(p);
    await p.evaluate(() => window.__stubChangeEmail("admin@mgh-ed-hiring.invalid"));
    await reloaded(p, () => p.reload());
    const a = await authLog(p);
    R("signed in, email changed, reload: still in, same role (known by uid)",
      !(await gateShown(p)) && (await p.$eval("#whoLine", (e) => e.textContent.trim())) === "Admin" && a.filter((x) => x.startsWith("signIn")).length === 1, a.join());
    await p.close(); }

  // ---- signed out while the page is open ------------------------------------
  { const p = await page();
    await signIn(p, "staffpw");
    await pickMember(p, "Vojdani");
    await reloaded(p, () => p.evaluate(() => window.__stubRevoke()));
    const msg = await p.$eval("#gerr", (e) => e.textContent);
    R("a revoked sign-in returns to the gate and says why",
      (await gateShown(p)) && msg.includes("You were signed out, probably because a password changed."), msg);
    await p.close(); }

  // ---- storage blocked ----------------------------------------------------
  { const p = await page({ blockSession: true });
    await signIn(p, "staffpw");
    await pickMember(p, "Vojdani");
    const a = await authLog(p);
    R("sessionStorage blocked: memory-only persistence, still signs in",
      a.join() === "persist:NONE,signIn:committee@ed-hiring.app", a.join());
    await p.close(); }
} finally {
  await b.close(); site.close();
}

console.log("browser log:", log.length ? log : "(clean)");
if (fails || log.length) { console.log(`\n${fails} auth check(s) failed`); process.exit(1); }
console.log("\nall auth checks pass");
