# Interviews (ED Physician Hiring)

Three-phase hiring tool: **Screen → Schedule → Score**. Static site + Firebase.
Full design and reference data (committee, candidates, questions, rules) live in
[`DESIGN.md`](DESIGN.md); open confirmations in [`QUESTIONS-FOR-KYLE.md`](QUESTIONS-FOR-KYLE.md).

## Non-negotiables

- **Applicant PII never lives in this app.** CVs/cover letters stay in OneDrive;
  the app only links out. Store only names + committee input (flags/ratings/scores).
- **Two audiences, two identity models.** Committee = trust-based name-pick +
  passcode admin (like Motion Voting). Candidates = **private tokenized links**,
  **no public candidate list**.
- **All asset paths relative** so GitHub Pages serves it at `…/tools/interviews/`.
- **Panel rules** (Phase 2): 3–5 members, Kyle present if available, ≥1 male +
  ≥1 female. Genders are in DESIGN.md; treat hard-vs-soft as pending Kyle's confirm.
- **`CHAIR` must exactly match a `COMMITTEE` name** (`js/config.js`). `buildPanel`
  requires the chair in the available pool, so a typo or a roster edit that drops
  the chair makes *every* candidate "unschedulable" with no obvious cause. Chair is
  **Kyle Vojdani**, the 13th member (the 12 in DESIGN.md are the others).
- **`panels.js` takes `chair` as a required argument** — no default. It previously
  had its own hardcoded `"Vojdani"`, a second source of truth that would silently
  outvote config. Don't reintroduce one.
- **Interview times are keyed by stable id, never list position** (`js/slots.js`).
  Availability maps and `panelOverrides[].slot` hold time ids. Never re-key or
  renumber; config defaults keep ids `"0"`…`"9"` for data saved before ids existed.
  Write times only via `store.updateTimes` (transactional; also updates the public
  mirror applicants read).
- **Never fix a candidate's name by removing and re-adding them.** Screening,
  scores and notes are keyed to the candidate's `c-<uuid>`, and the app's remove
  is a *soft* delete — so a re-add strands every rating on the old id, invisible
  in the UI, while the old entry still shows on the Screen tab. Use
  `scripts/rename-candidate.mjs`, which renames in place and keeps the id. This
  has already cost one applicant's ratings; `scripts/migrate-candidate.mjs`
  exists to clean that up.
- **Applicant availability is keyed by normalized surname** (`lastKey` in
  `util.js` — ONE definition, shared by the app, the store and the rules'
  allowed list). Two consequences that keep biting: a surname change moves the
  document, and two applicants sharing a surname share one document. The rules
  refuse a write under a surname not on the roster (`/interviews_meta/allowed`,
  fail-closed) so nothing is silently lost — **sync that list before publishing
  rules**, or applicants are locked out. `report-data.mjs --issues` flags both.
- Timeline is tight: **screening cut Sept 23 2026**, interviews start ~week of Sept 30.
