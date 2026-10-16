// The JSON backup file (H1): format, checksum, timestamps, refusals, and the
// collection list kept equal to firestore.rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBackup, parseBackup, encodeValue, decodeValue, preCloseState, ROUND_COLLECTIONS, NOT_ROUND_COLLECTIONS,
  FORMAT, VERSION, canonical, sha256Hex, backupFileName, toState } from "../js/backup.js";

// a stand-in for the SDK's Timestamp (same duck type)
class FakeTs {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; this._ms = ms; }
  toDate() { return new Date(this._ms); }
  static fromDate(d) { return new FakeTs(d.getTime()); }
}
const raw = () => ({
  interviews_candidates: { "c-1": { name: "Dr Rosalind Ashcombe", removed: false, addedAt: new FakeTs(Date.UTC(2027, 0, 15, 14)) } },
  interviews_screening: { "Marrocco~c-1": { member: "Marrocco", candId: "c-1", flag: false, rating: 4 } },
  interviews_scores: { "Marrocco~c-1": { overall: 4.3, notes: { 0: "Clear answers", q1k9z: "Strong" } } },
  interviews_availIv: { Marrocco: { slots: { t1: "ip" } } },
  interviews_availCand: { ashcombe: { slots: { t1: "either" }, reply: "confirmed", replyAt: new FakeTs(Date.UTC(2027, 1, 22, 18)) } },
  interviews_offers: { "c-1": { status: "offered", offeredAt: "2027-03-10" } },
  interviews_applicant: {},
  interviews_public: { slots: { times: [], booking: "paused" } },
  interviews_meta: { config: { committee: [{ name: "Marrocco", gender: "F" }] },
    state: { interviewsComplete: false, roundStatus: "closing", closingAttemptId: "a-1", closingTab: "p-1",
      closingStartedAt: new FakeTs(1), lease: { tab: "p-1", at: new FakeTs(2) }, roundId: "r-2027-01-15-a1b2", roundName: "Hiring round 2027",
      roundOpenedAt: new FakeTs(Date.UTC(2027, 0, 15, 14)) },
    questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }] } },
  interviews_history: { h1: { at: new FakeTs(5000), by: "leadership", action: "schedule.lock", text: "Locked the schedule" } },
});

test("the file has the format, round, counts and a checksum of the canonical data", async () => {
  const b = await buildBackup(raw(), { build: "R1", now: new Date("2027-03-20T15:04:05.000Z") });
  assert.equal(b.format, FORMAT); assert.equal(b.version, VERSION); assert.equal(b.build, "R1");
  assert.equal(b.exportedAt, "2027-03-20T15:04:05.000Z");
  assert.deepEqual(b.round, { id: "r-2027-01-15-a1b2", name: "Hiring round 2027", openedAt: "2027-01-15T14:00:00.000Z", closedAt: null });
  assert.equal(b.counts.interviews_candidates, 1);
  assert.equal(b.counts.interviews_history, 1);
  assert.deepEqual(Object.keys(b.data).sort(), [...ROUND_COLLECTIONS].sort());
  assert.equal(b.checksum, "sha256:" + await sha256Hex(canonical(b.data)));
  // question text, reply and every raw field are there
  assert.equal(b.data.interviews_meta.questions.questions[0].text, "Tell us about yourself");
  assert.equal(b.data.interviews_availCand.ashcombe.reply, "confirmed");
  assert.equal(b.data.interviews_scores["Marrocco~c-1"].notes.q1k9z, "Strong");
});

test("timestamps become { __ts } and come back as timestamps", async () => {
  const b = await buildBackup(raw());
  assert.deepEqual(b.data.interviews_availCand.ashcombe.replyAt, { __ts: "2027-02-22T18:00:00.000Z" });
  const back = decodeValue(b.data.interviews_availCand.ashcombe, FakeTs);
  assert.ok(back.replyAt instanceof FakeTs);
  assert.equal(back.replyAt.toDate().toISOString(), "2027-02-22T18:00:00.000Z");
  assert.ok(decodeValue({ __ts: "2027-01-01T00:00:00.000Z" }) instanceof Date);
});

test("a value the format has no place for is refused at export with a clear error", () => {
  class GeoPoint { constructor() { this.latitude = 1; this.longitude = 2; } }
  assert.throws(() => encodeValue({ where: new GeoPoint() }, "interviews_meta/config"), /GeoPoint/);
  assert.throws(() => encodeValue({ n: Infinity }), /finite/);
  assert.throws(() => encodeValue({ x: { __ts: "sneaky" } }), /reserved/);
});

test("the exported state never says closing, and booking is never left paused", async () => {
  const b = await buildBackup(raw());
  const st = b.data.interviews_meta.state;
  assert.equal(st.roundStatus, "open");
  for (const k of ["closingAttemptId", "closingStartedAt", "closingTab", "lease"]) assert.equal(k in st, false, k);
  assert.equal(b.data.interviews_public.slots.booking, "open");
  assert.deepEqual(preCloseState({ roundStatus: "open", x: 1 }), { roundStatus: "open", x: 1 });
});

test("parse: a good file round-trips; tampered, foreign and newer files are refused", async () => {
  const b = await buildBackup(raw());
  const text = JSON.stringify(b, null, 1);
  const back = await parseBackup(text);
  assert.equal(back.checksum, b.checksum);
  const tampered = JSON.parse(text); tampered.data.interviews_screening["Marrocco~c-1"].rating = 5;
  await assert.rejects(parseBackup(JSON.stringify(tampered)), /changed after it was saved/);
  await assert.rejects(parseBackup("not json"), /isn't a backup file/);
  await assert.rejects(parseBackup(JSON.stringify({ format: "something-else", version: 1, data: {} })), /isn't a backup file/);
  const newer = { ...b, version: VERSION + 1 };
  await assert.rejects(parseBackup(JSON.stringify(newer)), /newer version of the tool/);
});

test("2 MB of accented text and curly quotes survives the checksum unchanged", async () => {
  const r = raw();
  const big = "Rosalind Ashcombe’s “answer”: é ü ñ ç ".repeat(52000);   // > 2 MB in UTF-8
  assert.ok(new TextEncoder().encode(big).length > 2_000_000);
  r.interviews_scores["Marrocco~c-1"].notes[0] = big;
  const b = await buildBackup(r);
  const back = await parseBackup(JSON.stringify(b));
  assert.equal(back.data.interviews_scores["Marrocco~c-1"].notes[0], big);
});

test("ROUND_COLLECTIONS plus the explicit not-a-round list match every collection in firestore.rules", () => {
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  const inRules = new Set([...rules.matchAll(/^\s{4}match \/(interviews_[A-Za-z]+)\//gm)].map((m) => m[1]));
  const known = new Set([...ROUND_COLLECTIONS, ...NOT_ROUND_COLLECTIONS]);
  assert.deepEqual([...inRules].sort(), [...known].sort());
  ROUND_COLLECTIONS.forEach((c) => assert.ok(!NOT_ROUND_COLLECTIONS.includes(c)));
});

test("file name: round name slug and date", () => {
  assert.equal(backupFileName("Hiring round 2027 (spring)", new Date(2027, 2, 20)), "ed-hiring-backup-hiring-round-2027-spring-2027-03-20.json");
  assert.equal(backupFileName("", new Date(2027, 2, 20)), "ed-hiring-backup-hiring-round-2027-2027-03-20.json");
});

test("toState builds the store's shape from raw documents", () => {
  const st = toState(raw());
  assert.deepEqual(st.candidates.map((c) => c.id), ["c-1"]);
  assert.deepEqual(st.availCand.ashcombe, { t1: "either" });
  assert.deepEqual(st.availIv.Marrocco, { t1: "ip" });
  assert.equal(st.meta.roundName, "Hiring round 2027");
  assert.equal(st.settings.committee[0].name, "Marrocco");
  assert.equal(st.questions.questions[0].id, "0");
});
