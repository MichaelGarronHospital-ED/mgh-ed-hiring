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

import { canonicalJson, hashOf } from "./history.js?v=R8b";

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

// ============================================================================
//  R6: the close and restore halves.
// ============================================================================

// What a close may DELETE (review 2 B1): an explicit allow-list, separate from
// what a backup contains. interviews_meta (committee, settings, state, allowed,
// questions, schedule, passwords) and interviews_public are NEVER deleted by a
// close; they are reset field by field in its single finish batch. The clear
// step, the put-back and the "kept" list take their names from here only.
export const CLEAR_COLLECTIONS = Object.freeze([
  "interviews_candidates", "interviews_screening", "interviews_scores", "interviews_availIv",
  "interviews_availCand", "interviews_offers", "interviews_applicant", "interviews_history",
]);

// UTF-8 byte length of one code point
const cpBytes = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
export const utf8Length = (s) => { let n = 0; for (const ch of s) n += cpBytes(ch.codePointAt(0)); return n; };

// Split text into parts of at most `max` UTF-8 BYTES (Firestore's limit is
// bytes; accented names and curly quotes are 2 to 3 bytes each), cutting only
// between characters, never inside one.
export function chunkBytes(text, max = 900000) {
  const parts = [];
  let start = 0, bytes = 0, i = 0;
  for (const ch of text) {
    const b = cpBytes(ch.codePointAt(0));
    if (bytes + b > max) { parts.push(text.slice(start, i)); start = i; bytes = 0; }
    bytes += b; i += ch.length;
  }
  parts.push(text.slice(start));
  return parts;
}
export const unchunk = (parts) => [...parts].sort((a, b) => a.i - b.i).map((p) => p.json).join("");

// Kept items (review 3 m2): documents left in place by a close because they
// changed after the copy. They belong to no round until leadership decides.
// Each kept entry carries the hash of the document as it was kept: some ids
// come back in the next round (availIv/<member>, availCand/<surname>,
// applicant/<surname>), so a document counts as kept only while it is still
// exactly that document; once the new round writes it, it is the new round's.
export const docHash = (d) => hashOf(encodeValue(d));
export const quarantineSet = (kept) => new Map((kept || []).map((k) => [`${k.coll}/${k.id}`, k.hash || null]));
// doc: the raw document now, or undefined when it isn't known (then: kept)
export function isQuarantined(q, coll, id, doc) {
  const k = `${coll}/${id}`;
  if (!q.has(k)) return false;
  const h = q.get(k);
  return !h || doc === undefined || doc === null || docHash(doc) === h;
}

// ---- restore ----------------------------------------------------------------
export const MAX_RESTORE_DOCS = 10000;
const ID_OK = (id) => typeof id === "string" && id.length > 0 && !id.includes("/") && new TextEncoder().encode(id).length <= 1500;
const AV_KEYS = ["slots", "reply", "replyAt"], OFFER_KEYS = ["status", "note", "offeredAt", "respondedAt", "updatedAt"];
const HIST_KEYS = ["at", "by", "action", "text", "cand", "member", "undo", "restored"];
// The shapes the rules check, so the preview can list what would be refused.
export function shapeProblem(coll, d) {
  if (!d || typeof d !== "object") return "not a document";
  if (coll === "interviews_availCand") {
    if (!Object.keys(d).every((k) => AV_KEYS.includes(k))) return "unexpected fields";
    const sl = d.slots || {};
    if (Object.keys(sl).length > 200 || !Object.values(sl).every((v) => ["ip", "zoom", "either"].includes(v))) return "times in an unknown form";
    if (!["", "confirmed", "withdrawn", undefined].includes(d.reply)) return "an unknown reply";
  }
  if (coll === "interviews_offers") {
    if (!Object.keys(d).every((k) => OFFER_KEYS.includes(k))) return "unexpected fields";
    if (!["", "offered", "accepted", "declined", undefined].includes(d.status) || String(d.note || "").length > 4000) return "an unknown status or a note too long";
  }
  if (coll === "interviews_history") {
    if (!Object.keys(d).every((k) => HIST_KEYS.includes(k))) return "unexpected fields";
    if (String(d.action || "").length > 60 || String(d.text || "").length > 600 || String(d.by || "").length > 80) return "too long";
    if (!d.at || !(d.at.__ts || typeof d.at === "string")) return "no time";
  }
  return null;
}

// Checks before any preview. Returns { errors, warnings, total }.
export function checkBackup(b) {
  const errors = [], warnings = [];
  let total = 0;
  for (const coll of ROUND_COLLECTIONS) {
    for (const [id, d] of Object.entries((b.data || {})[coll] || {})) {
      total++;
      if (!ID_OK(id)) errors.push(`A document id in ${coll} isn't valid.`);
      if (new TextEncoder().encode(JSON.stringify(d)).length > 1000000) errors.push(`A document in ${coll} is too big.`);
    }
  }
  if (total > MAX_RESTORE_DOCS) errors.push("This backup is too big to restore in one day on the free plan.");
  return { errors: [...new Set(errors)], warnings, total };
}

export const RESTORE_ROWS = Object.freeze([
  ["interviews_candidates", "Applicants"], ["interviews_screening", "Screening answers"], ["interviews_scores", "Scores and notes"],
  ["interviews_availIv", "Interviewer times"], ["interviews_availCand", "Applicant times"], ["interviews_offers", "Offers"],
  ["interviews_applicant", "Notices"], ["interviews_history", "Change history"],
]);
// The working round counts as empty with no applicants, input, offers or notices.
export const EMPTY_CHECK = Object.freeze(["interviews_candidates", "interviews_screening", "interviews_scores",
  "interviews_availIv", "interviews_availCand", "interviews_offers", "interviews_applicant"]);
export const roundIsEmpty = (live) => EMPTY_CHECK.every((c) => !Object.keys((live || {})[c] || {}).length);

// Plan a restore. `backup` is a parsed file (or an archived round's JSON);
// `live` is ALWAYS a fresh store.snapshotRaw() (never page state), encoded
// with encodeValue for comparison. Pure: returns what would be written.
//   mode "missing": add documents that are in the file but not here now; never
//     change or delete anything; only for a file from the working round.
//   mode "replace": only when the working round is empty; bring the round back
//     open with a new round id.
// opts: { committee (normalized, now), newRoundId, nowIso, defaults (config.js committee) }
export function planRestore(backup, live, mode, opts = {}) {
  const enc = (raw) => Object.fromEntries(ROUND_COLLECTIONS.map((c) => [c, Object.fromEntries(Object.entries((raw || {})[c] || {})
    .map(([id, d]) => [id, encodeValue(d, `${c}/${id}`)]))]));
  const L = enc(live), F = backup.data || {};
  const st = (L.interviews_meta || {}).state || {};
  const plan = { mode, ok: true, why: "", rows: [], writes: [], skipped: [], warnings: [], meta: {}, total: 0 };
  const fileRound = (backup.round || {}).id || null;
  // a file from before rounds existed has no round id: it belongs to the working
  // round only if that round was brought back from such a file
  const fromHere = fileRound === (st.roundId || null) || (fileRound && fileRound === st.broughtBackFrom)
    || (!fileRound && st.broughtBackFrom === "before-rounds");
  if (mode === "missing" && !fromHere) {
    plan.ok = false;
    plan.why = `This file is from '${(backup.round || {}).name || "another round"}', not the round you are working on. To look at it again, use Past rounds, Bring back.`;
  }
  if (mode === "replace" && !roundIsEmpty(live)) { plan.ok = false; plan.why = "Close the current round first, so nothing is lost."; }
  // kept items are hidden from every view, so the round can look empty while
  // they are still there: decide about them first (review)
  if (mode === "replace" && (st.keptFromClose || []).length) {
    plan.ok = false; plan.why = "First decide what to do with the items kept from the last close (Setup, This round).";
  }
  for (const [coll, label] of RESTORE_ROWS) {
    const f = F[coll] || {}, l = L[coll] || {};
    const row = { coll, label, inFile: Object.keys(f).length, now: Object.keys(l).length, add: 0, same: 0, different: 0 };
    for (const [id, d] of Object.entries(f)) {
      const bad = shapeProblem(coll, d);
      if (bad) { plan.skipped.push(`${label}: one entry has ${bad}, so it would be refused.`); continue; }
      if (l[id] !== undefined) { if (canonical(l[id]) === canonical(d)) row.same++; else row.different++; continue; }
      row.add++;
      plan.writes.push({ coll, id, data: coll === "interviews_history" ? { ...d, restored: true } : d });
    }
    plan.rows.push(row);
  }
  // members the file's input refers to who are not on the committee now
  const ids = new Set();
  for (const c of ["interviews_screening", "interviews_scores"]) Object.keys(F[c] || {}).forEach((k) => { const i = k.indexOf("~"); if (i > 0) ids.add(k.slice(0, i)); });
  Object.keys(F.interviews_availIv || {}).forEach((k) => ids.add(k));
  const now = opts.committee || [];
  const fileCommittee = (((F.interviews_meta || {}).config || {}).committee) || [];
  const missing = [...ids].filter((id) => !now.some((m) => m.id === id)).map((id) => {
    const fm = fileCommittee.find((m) => (m.id || m.name) === id) || {};
    return { id, name: fm.name || id, gender: fm.gender || "", active: false };
  });
  if (missing.length) plan.warnings.push(`${missing.length} ${missing.length === 1 ? "person" : "people"} in the file ${missing.length === 1 ? "is" : "are"} not on the committee now. ${missing.length === 1 ? "They" : "They"} will be added as Left the committee.`);
  const curQ = ((L.interviews_meta || {}).questions || {}).questions || [];
  const fileQ = ((F.interviews_meta || {}).questions || {}).questions || [];
  const noteIds = new Set();
  Object.values(F.interviews_scores || {}).forEach((s) => Object.keys((s && s.notes) || {}).forEach((q) => noteIds.add(String(q))));
  const archivedQ = [...noteIds].filter((q) => !curQ.some((x) => x.id === q))
    .map((q) => ({ id: q, text: (fileQ.find((x) => x.id === q) || {}).text || "(question text not in the file)", archived: true }));
  const cfgNow = (L.interviews_meta || {}).config || {};
  const fileCfg = (F.interviews_meta || {}).config || {};
  if (mode === "missing") {
    if (missing.length) plan.meta.configCommittee = [...(cfgNow.committee && cfgNow.committee.length ? cfgNow.committee : (opts.defaults || [])), ...missing];
    if (archivedQ.length) plan.meta.questions = { ...((L.interviews_meta || {}).questions || { version: 1, scale: [], guide: [] }),
      questions: [...curQ, ...archivedQ] };
    const diff = ["config", "questions", "schedule"].filter((k) => (F.interviews_meta || {})[k] && canonical((F.interviews_meta || {})[k]) !== canonical((L.interviews_meta || {})[k] || null));
    if (diff.length) plan.warnings.push(`Setup in the file differs from now (${diff.join(", ")}). Setup is never overwritten by "missing items only".`);
  } else {
    const keepCommittee = cfgNow.committee && cfgNow.committee.length ? cfgNow.committee : (opts.defaults || []);
    const take = ["times", "slots", "panelOverrides", "days", "deadlines", "flagThreshold", "interviewInfo", "retentionMonths", "keptSurnameDocs"];
    const cfg = { ...cfgNow };
    take.forEach((k) => { if (k in fileCfg) cfg[k] = fileCfg[k]; });
    cfg.committee = [...keepCommittee, ...missing];
    if (!("chair" in cfgNow) && fileCfg.chair) cfg.chair = fileCfg.chair;
    plan.meta.config = cfg;
    const fq = (F.interviews_meta || {}).questions;
    if (fq) plan.meta.questions = { ...fq, questions: [...(fq.questions || []), ...archivedQ.filter((q) => !(fq.questions || []).some((x) => x.id === q.id))] };
    plan.meta.replacedQuestions = curQ;
    if ((F.interviews_meta || {}).schedule) plan.meta.schedule = F.interviews_meta.schedule;
    const fst = (F.interviews_meta || {}).state || {};
    plan.meta.state = { interviewsComplete: !!fst.interviewsComplete, stages: fst.stages || {}, roundStatus: "open",
      roundId: opts.newRoundId, roundName: fst.roundName || (backup.round || {}).name || "", roundOpenedAt: { __ts: opts.nowIso || new Date().toISOString() },
      closingAttemptId: null, closingStartedAt: null, closingTab: null, keptFromClose: [], broughtBackFrom: fileRound || "before-rounds" };
    const fpub = (F.interviews_public || {}).slots || {};
    const avClosed = ((fst.stages || {}).availability || {}).closed === true;
    plan.meta.public = { times: Array.isArray(fileCfg.times) ? fileCfg.times : (fpub.times || []), slots: fpub.slots || [], booking: avClosed ? "closed" : "open" };
  }
  plan.total = plan.writes.length;
  return plan;
}
