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
- **Interview times are keyed by stable id, never list position** (`js/slots.js`).
  Availability maps and `panelOverrides[].slot` hold time ids. Never re-key or
  renumber; config defaults keep ids `"0"`…`"9"` for data saved before ids existed.
  Write times only via `store.updateTimes` (transactional; also updates the public
  mirror applicants read).
- Timeline is tight: **screening cut Sept 23 2026**, interviews start ~week of Sept 30.
