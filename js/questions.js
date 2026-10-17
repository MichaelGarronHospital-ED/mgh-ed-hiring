// ============================================================================
//  Interview questions, kept in Firestore (H2). Pure helpers.
//
//  interviews_meta/questions = { version: 1, questions: [{ id, text, archived? }],
//  scale: [5 labels], guide: [lines], migratedFrom?, updatedAt }.
//
//  Score notes are keyed by question id. The questions first came from the
//  encrypted js/data.js, where they were a plain list and notes were keyed by
//  position ("0".."9"). fromLegacy() therefore gives them ids "0".."n-1", which is
//  exactly what every saved note already uses: nothing is ever renumbered.
// ============================================================================

export const QID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_QUESTIONS = 30;
export const MAX_TEXT = 1000;
export const SCALE_SIZE = 5;

export const newQuestionId = () =>
  "q" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);

const clean = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

// The decrypted legacy content { q, s, g } → a questions document.
export function fromLegacy(dec) {
  if (!dec || !Array.isArray(dec.q)) return null;
  return {
    version: 1,
    questions: dec.q.map((t, i) => ({ id: String(i), text: String(t) })),
    scale: Array.isArray(dec.s) ? dec.s.map(String) : [],
    guide: Array.isArray(dec.g) ? dec.g.map(String) : [],
    migratedFrom: "data.js",
  };
}

// A stored document → { questions, scale, guide } or null if there is none.
// Unknown or broken entries are dropped; a repeated id keeps its first entry.
export function normalizeQuestions(doc) {
  if (!doc || !Array.isArray(doc.questions)) return null;
  const seen = new Set(), questions = [];
  doc.questions.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const id = QID_RE.test(String(q.id || "")) ? String(q.id) : String(i);
    if (seen.has(id)) return;
    seen.add(id);
    const o = { id, text: String(q.text || "") };
    if (q.archived) o.archived = true;
    questions.push(o);
  });
  return {
    questions,
    scale: Array.isArray(doc.scale) ? doc.scale.map(String) : [],
    guide: Array.isArray(doc.guide) ? doc.guide.map(String) : [],
  };
}

// The questions an interviewer sees, in the saved order.
export const liveQuestions = (Q) => (Q ? Q.questions.filter((q) => !q.archived) : []);

// Scoring has started once any score has a number or a note, for anyone.
export function scoringStarted(scores) {
  return Object.values(scores || {}).some((s) => s && (Number(s.overall) > 0
    || Object.values(s.notes || {}).some((t) => clean(t))));
}

// Every question id that has a note under it, in the order first seen.
export function idsWithNotes(scores) {
  const out = [];
  Object.values(scores || {}).forEach((s) => Object.entries((s && s.notes) || {}).forEach(([id, t]) => {
    if (clean(t) && !out.includes(String(id))) out.push(String(id));
  }));
  return out;
}

// Problems with an edit before it is saved. `locked` = scoring has started:
// only the wording may change (no add, remove or reorder).
export function checkEdit(before, after, locked) {
  const errors = [];
  const b = (before && before.questions ? before.questions : []).filter((q) => !q.archived);
  const a = (after && after.questions ? after.questions : []).filter((q) => !q.archived);
  if (!a.length) errors.push("Add at least one question.");
  if (a.length > MAX_QUESTIONS) errors.push(`At most ${MAX_QUESTIONS} questions.`);
  const seen = new Set();
  a.forEach((q, i) => {
    const t = clean(q.text);
    if (!t) errors.push(`Question ${i + 1} is empty.`);
    else if (t.length > MAX_TEXT) errors.push(`Question ${i + 1} is longer than ${MAX_TEXT} characters.`);
    else if (seen.has(t.toLowerCase())) errors.push(`Question ${i + 1} is the same as an earlier one.`);
    seen.add(t.toLowerCase());
    if (!QID_RE.test(String(q.id || ""))) errors.push(`Question ${i + 1} has no id.`);
  });
  if (locked) {
    const ids = (l) => l.map((q) => q.id).join("|");
    if (ids(a) !== ids(b)) errors.push("Scoring has started, so questions can't be added, removed or reordered. Only fix the wording.");
  }
  const scale = (after && after.scale) || [];
  if (scale.length && scale.length !== SCALE_SIZE) errors.push(`The rating scale needs ${SCALE_SIZE} labels.`);
  return errors;
}

// The document to store after an edit: keeps archived entries (they hold the text
// for notes the list no longer shows) and trims everything.
export function toStoredQuestions(q) {
  return {
    version: 1,
    questions: (q.questions || []).map((x) => {
      const o = { id: String(x.id), text: clean(x.text).slice(0, MAX_TEXT) };
      if (x.archived) o.archived = true;
      return o;
    }),
    scale: (q.scale || []).map((t) => clean(t)),
    guide: (q.guide || []).map((t) => clean(t)).filter(Boolean),
  };
}
