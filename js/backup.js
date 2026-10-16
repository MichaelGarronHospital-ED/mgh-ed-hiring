// ============================================================================
//  The JSON backup file (H1). Pure helpers: no DOM, no store.
//
//  One file format serves the backup download, the copy a close saves into
//  interviews_archive, and every restore. It is ALWAYS built from a fresh server
//  read (store.snapshotRaw), never from page state: the leadership page mixes
//  this browser's own echo of screening and scores into its state, keeps only
//  the slots of availability documents and fills in defaults, so a file built
//  from it would hold things the server never had and miss things it does.
//
//  {
//    format: "mgh-ed-hiring-backup", version: 1, exportedAt, exportedBy, build,
//    round: { id, name, openedAt, closedAt }, counts: { <collection>: n },
//    data: { <collection>: { <docId>: <raw document> } },
//    checksum: "sha256:<hex of canonical JSON of data>"
//  }
//  Timestamps become { "__ts": ISO }; any other non-JSON Firestore type is
//  refused (none exist today). Canonical JSON = keys sorted at every level, no
//  spaces. `version` goes up whenever a stored shape changes; restore accepts
//  every older version (upgrading in memory) and refuses newer ones.
// ============================================================================

import { canonicalJson } from "./history.js?v=R2";

export const FORMAT = "mgh-ed-hiring-backup";
export const VERSION = 1;

// What a backup CONTAINS: every collection of the working round. Kept equal to
// the `match /interviews_*` collections in firestore.rules by a test, apart
// from the explicit not-a-round list below.
export const ROUND_COLLECTIONS = Object.freeze([
  "interviews_candidates", "interviews_screening", "interviews_scores", "interviews_availIv",
  "interviews_availCand", "interviews_offers", "interviews_applicant", "interviews_public",
  "interviews_meta", "interviews_history",
]);
export const NOT_ROUND_COLLECTIONS = Object.freeze(["interviews_archive"]);

// ---- values ----------------------------------------------------------------
const isTimestamp = (v) => v && typeof v === "object" && typeof v.toDate === "function"
  && typeof v.seconds === "number" && typeof v.nanoseconds === "number";

// Firestore value → JSON value. Throws on a type the format has no place for.
export function encodeValue(v, path = "") {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Can't back up ${path}: not a finite number.`);
    return v;
  }
  if (isTimestamp(v)) return { __ts: v.toDate().toISOString() };
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (Array.isArray(v)) return v.map((x, i) => encodeValue(x, `${path}[${i}]`));
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
      throw new Error(`Can't back up ${path}: it holds a ${(v.constructor && v.constructor.name) || "special"} value.`);
    if ("__ts" in v) throw new Error(`Can't back up ${path}: "__ts" is reserved.`);
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = encodeValue(x, path ? `${path}.${k}` : k);
    return o;
  }
  throw new Error(`Can't back up ${path}: unsupported value.`);
}

// JSON value → Firestore value. `Timestamp` is the SDK class (optional: without
// it timestamps come back as Date objects).
export function decodeValue(v, Timestamp) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, Timestamp));
  if (typeof v.__ts === "string" && Object.keys(v).length === 1) {
    const d = new Date(v.__ts);
    return Timestamp ? Timestamp.fromDate(d) : d;
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeValue(x, Timestamp)]));
}

export const canonical = canonicalJson;

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const h = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the file --------------------------------------------------------------
// The state document as it was before any close began (review M2): a backup
// never says "closing", so a restore can never bring a round back paused.
export function preCloseState(state) {
  const s = { ...(state || {}) };
  if (s.roundStatus === "closing") s.roundStatus = "open";
  delete s.closingAttemptId; delete s.closingStartedAt; delete s.closingTab; delete s.lease;
  return s;
}

const tsIso = (v) => (v && v.__ts) || null;

// raw = { <collection>: { <docId>: <Firestore data> } } from store.snapshotRaw().
export async function buildBackup(raw, { exportedBy = "leadership", build = "", now = new Date() } = {}) {
  const data = {};
  for (const name of ROUND_COLLECTIONS) {
    const docs = (raw && raw[name]) || {};
    data[name] = {};
    for (const id of Object.keys(docs).sort()) data[name][id] = encodeValue(docs[id], `${name}/${id}`);
  }
  const meta = data.interviews_meta;
  if (meta.state) meta.state = preCloseState(meta.state);
  const pub = data.interviews_public.slots;
  if (pub && pub.booking === "paused") pub.booking = "open";
  const st = meta.state || {};
  const counts = Object.fromEntries(ROUND_COLLECTIONS.map((n) => [n, Object.keys(data[n]).length]));
  return {
    format: FORMAT, version: VERSION, exportedAt: now.toISOString(), exportedBy, build,
    round: { id: st.roundId || null, name: st.roundName || "", openedAt: tsIso(st.roundOpenedAt), closedAt: null },
    counts, data,
    checksum: "sha256:" + await sha256Hex(canonical(data)),
  };
}

// Older versions upgrade in memory, one step at a time. (None yet.)
const UPGRADE = {};

// Read and check a backup file's text. Throws an Error with a plain message.
export async function parseBackup(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error("This isn't a backup file from Physician Hiring (it can't be read)."); }
  if (!b || b.format !== FORMAT || typeof b.version !== "number" || !b.data || typeof b.data !== "object")
    throw new Error("This isn't a backup file from Physician Hiring.");
  if (b.version > VERSION) throw new Error("This backup was made by a newer version of the tool. Reload the page and try again.");
  const sum = "sha256:" + await sha256Hex(canonical(b.data));
  if (b.checksum !== sum) throw new Error("This file was changed after it was saved, so it can't be restored safely.");
  for (let v = b.version; v < VERSION; v++) b = UPGRADE[v](b);
  return b;
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export function backupFileName(roundName, date = new Date()) {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `ed-hiring-backup-${slug(roundName) || `hiring-round-${date.getFullYear()}`}-${d}.json`;
}

// ---- raw documents → the store's normalized state ------------------------
// The same shape FirestoreStore builds from its listeners, from a raw snapshot
// or a backup's data (decoded or not). Used to make the Excel workbook from a
// fresh read, and later from an archived round.
export function toState(raw) {
  const c = (n) => (raw && raw[n]) || {};
  const meta = c("interviews_meta");
  const pub = c("interviews_public").slots || {};
  const config = meta.config || {};
  const settings = { committee: [], chair: "", slots: [], oneDrive: "", ...config };
  if (!("times" in config) && Array.isArray(pub.times)) settings.times = pub.times;
  return {
    candidates: Object.entries(c("interviews_candidates")).map(([id, d]) => ({ id, ...d })),
    screening: { ...c("interviews_screening") },
    scores: { ...c("interviews_scores") },
    availIv: Object.fromEntries(Object.entries(c("interviews_availIv")).map(([id, d]) => [id, (d && d.slots) || {}])),
    availCand: Object.fromEntries(Object.entries(c("interviews_availCand")).map(([id, d]) => [id, (d && d.slots) || {}])),
    offers: { ...c("interviews_offers") },
    meta: { interviewsComplete: false, ...(meta.state || {}) },
    settings,
    allowedNames: meta.allowed && Array.isArray(meta.allowed.keys) ? meta.allowed.keys : null,
    questions: meta.questions || null,
    schedule: meta.schedule || null,
    passwordsMeta: meta.passwords || null,
    publicInfo: { orgName: pub.orgName || "", note: pub.note || "" },
    history: { ...c("interviews_history") },
    applicant: { ...c("interviews_applicant") },
  };
}
