// Browser driver: serve the test copy of the tool and drive it like a person.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE = path.join(HERE, "site");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// Any Chrome will do. $CHROME wins; otherwise take whatever `npx puppeteer
// browsers install chrome` left in the cache, then the usual system paths.
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || "", ".cache/puppeteer/chrome");
  if (fs.existsSync(cache)) {
    for (const build of fs.readdirSync(cache).sort().reverse()) {
      const dir = path.join(cache, build);
      for (const sub of fs.readdirSync(dir)) {
        const exe = path.join(dir, sub, "chrome");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
                   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome found. Run `npx puppeteer browsers install chrome`, or set $CHROME.");
}

export async function serve(dir = SITE) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    if (rel === "favicon.ico") { res.writeHead(204); res.end(); return; }  // keep the console log meaningful
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nope"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/index.html`, close: () => srv.close() };
}

export async function browser() {
  return puppeteer.launch({
    executablePath: chromePath(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
}

// ---- one page, wired for diagnostics ---------------------------------------
export async function openPage(b, url, { width = 1280, height = 900, log = [] } = {}) {
  const page = await b.newPage();
  await page.setViewport({ width, height });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__edReady === true", { timeout: 15000 });
  page._log = log;
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---- app-level actions ------------------------------------------------------
export async function signIn(page, code) {
  await page.waitForSelector("#gate:not(.hidden)");
  await page.$eval("#gpw", (el) => { el.value = ""; });
  await page.type("#gpw", code);
  await page.click("#gbtn");
  await sleep(120);
}

export async function pickMember(page, name) {
  await page.waitForSelector("#memberpick:not(.hidden)");
  await page.waitForFunction(() => !document.querySelector("#memberBtn").disabled, { timeout: 10000 });
  await page.select("#memberSel", name);
  await page.click("#memberBtn");
  await page.waitForSelector("#app:not(.hidden)");
}

export async function changeMember(page, name) {
  await page.click("#changeMember");
  await pickMember(page, name);
}

export async function tab(page, t) {
  await page.click(`#tab-${t}`);
  await sleep(60);
}

// Click one segment button ("In person" / "Zoom" / "Either") for a time id.
// Matches the inline handler the app actually renders, so a rename of the
// handler breaks the sim loudly instead of silently clicking nothing.
export async function setSlot(page, handler, id, value) {
  const hit = await page.evaluate((handler, id, value) => {
    const want = `${handler}('${id}','${value}')`;
    const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("onclick") || "") === want);
    if (!b) return false;
    b.click(); return true;
  }, handler, id, value);
  if (!hit) throw new Error(`no ${handler} button for slot ${id} / ${value}`);
  await sleep(25);
}

// The whole LocalStore state, as the app itself stored it.
export async function dumpState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("ed_interviews_v1") || "{}"));
}

export async function seedState(page, state) {
  await page.evaluate((s) => localStorage.setItem("ed_interviews_v1", JSON.stringify(s)), state);
}
