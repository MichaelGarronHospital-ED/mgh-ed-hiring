// Talk to the LOCAL Firebase emulators over REST: load the real rules, create the
// role accounts, seed and read documents with the rules bypassed, and clear
// everything between cases. Only ever 127.0.0.1. Used by emulator.mjs (and
// passwords.mjs). Nothing here can reach a real project.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FS = "http://127.0.0.1:8080";
export const AUTH = "http://127.0.0.1:9099";
export const PROJECT = "mgh-ed-hiring-test-emu";
const OWNER = { authorization: "Bearer owner", "content-type": "application/json" };

async function call(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...OWNER, ...(opts.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${url} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function loadRules(project = PROJECT) {
  const content = fs.readFileSync(path.join(HERE, "..", "firestore.rules"), "utf8");
  await call(`${FS}/emulator/v1/projects/${project}:securityRules`, {
    method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }) });
}
export async function clearFirestore(project = PROJECT) {
  await call(`${FS}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
}
export async function clearAuth(project = PROJECT) {
  await call(`${AUTH}/emulator/v1/projects/${project}/accounts`, { method: "DELETE" });
}
export async function addUser(email, password, project = PROJECT) {
  await call(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${project}/accounts`, {
    method: "POST", body: JSON.stringify({ email, password, emailVerified: true }) });
}
export const ROLE_USERS = [["admin@ed-hiring.app", "adminpw"], ["committee@ed-hiring.app", "staffpw"], ["applicant@ed-hiring.app", "guestpw"]];

// ---- Firestore REST values <-> plain JS -------------------------------------
// Timestamps are written from { __ts: ISO } and read back as { __ts: ISO }.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (v.__ts) return { timestampValue: v.__ts };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}
function fromValue(v) {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return { __ts: v.timestampValue };
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromValue(x)]));
  return v;
}
const docsUrl = (project) => `${FS}/v1/projects/${project}/databases/(default)/documents`;

export async function setDocument(pathStr, data, project = PROJECT) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, x]) => [k, toValue(x)]));
  await call(`${docsUrl(project)}/${pathStr}`, { method: "PATCH", body: JSON.stringify({ fields }) });
}
export async function getDocument(pathStr, project = PROJECT) {
  const r = await fetch(`${docsUrl(project)}/${pathStr}`, { headers: OWNER });
  if (r.status === 404) return null;
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, fromValue(x)]));
}
export async function listCollection(coll, project = PROJECT) {
  const out = {};
  let token = "";
  do {
    const d = await call(`${docsUrl(project)}/${coll}?pageSize=300${token ? `&pageToken=${token}` : ""}`);
    for (const doc of d.documents || []) {
      const id = doc.name.split("/").pop();
      out[id] = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, x]) => [k, fromValue(x)]));
    }
    token = d.nextPageToken || "";
  } while (token);
  return out;
}
export async function seed(docs, project = PROJECT) {
  for (const [p, d] of Object.entries(docs)) await setDocument(p, d, project);
}
