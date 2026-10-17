// Sign-in and Log out against a STUB Firebase. Every other sim runs on
// LocalStore, so none of them ever reaches the Firebase half of the gate. This
// one serves the test copy of the tool with a dummy firebaseConfig and answers
// the three gstatic imports with tiny fakes that write down what the app asked
// of them. Nothing here can reach Firebase or real data.
//
// What it pins (Oct 2026 security pass):
//   - the sign-in is kept for this tab only (browserSessionPersistence), set
//     BEFORE signing in;
//   - a reload in the same tab still signs straight back in;
//   - Log out (committee header and applicant page) calls Firebase signOut
//     before reloading, and nothing signs in again afterwards;
//   - a browser that blocks sessionStorage falls back to memory only and can
//     still sign in.
import fs from "node:fs";
import path from "node:path";
import { serve, browser, signIn, pickMember, landAsAdmin, sleep, SITE } from "./drive.mjs";

const GS = "https://www.gstatic.com/firebasejs/10.12.2/";
const STUB = {
  "firebase-app.js": `export function initializeApp(c) { return { options: c }; }`,
  "firebase-auth.js": `
    const log = (e) => { const a = JSON.parse(localStorage.getItem("__authlog") || "[]"); a.push(e); localStorage.setItem("__authlog", JSON.stringify(a)); };
    export const browserSessionPersistence = { type: "SESSION" };
    export const browserLocalPersistence = { type: "LOCAL" };
    export const inMemoryPersistence = { type: "NONE" };
    export function getAuth() { return { currentUser: null }; }
    export async function setPersistence(auth, p) { log("persist:" + p.type); }
    export async function signInWithEmailAndPassword(auth, email) { log("signIn:" + email); auth.currentUser = { email }; return { user: auth.currentUser }; }
    export async function signInAnonymously(auth) { log("signIn:anon"); auth.currentUser = {}; }
    export async function signOut(auth) { log("signOut"); auth.currentUser = null; }`,
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

async function page({ blockSession = false } = {}) {
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
  await p.goto(site.url, { waitUntil: "domcontentloaded" });
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
    R("ED: session-only persistence set before signing in",
      a.join() === "persist:SESSION,signIn:committee@ed-hiring.app", a.join());

    await reloaded(p, () => p.reload());
    a = await authLog(p);
    R("ED: a reload in the same tab signs straight back in",
      !(await gateShown(p)) && a.slice(2).join() === "persist:SESSION,signIn:committee@ed-hiring.app", a.join());
    await pickMember(p, "Vojdani");

    await reloaded(p, () => p.click("#logout"));
    a = await authLog(p);
    R("ED: Log out signs out of Firebase, then shows the gate",
      a[a.length - 1] === "signOut" && (await gateShown(p)), a.join());
    R("ED: Log out forgets the saved password", (await p.evaluate(() => sessionStorage.getItem("ed_iv_code"))) === null);
    await p.close(); }

  // ---- Leadership password -------------------------------------------------
  { const p = await page();
    await signIn(p, "adminpw");
    await landAsAdmin(p);
    await reloaded(p, () => p.click("#logout"));
    const a = await authLog(p);
    R("Leadership: signs in session-only and signs out on Log out",
      a.join() === "persist:SESSION,signIn:admin@ed-hiring.app,signOut" && (await gateShown(p)), a.join());
    await p.close(); }

  // ---- Guest password (applicant) -----------------------------------------
  { const p = await page();
    await signIn(p, "guestpw");
    await p.waitForSelector("#candview:not(.hidden)");
    await reloaded(p, () => p.evaluate(() => window.CAND.logout()));
    const a = await authLog(p);
    R("Guest: signs in session-only and Log out signs out",
      a.join() === "persist:SESSION,signIn:applicant@ed-hiring.app,signOut" && (await gateShown(p)), a.join());
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
