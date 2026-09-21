# Changes — overnight polish pass

Running log of what changed and why, newest first. Companion to DESIGN.md
(decisions) and README.md (how to run). Written during the autonomous polish
pass so the morning review has a paper trail.

Verification note (updated Sept 21 2026): the Firestore **rules** have since been
exercised for real — the emulator suite in [`tests/`](tests/) runs green here,
**30/30**, and was confirmed load-bearing by breaking `isAdmin()` and watching 16
of the 30 fail (see the Sept 21 entry below). What remains untested is only the
**roles auth path**: creating the three Firebase Auth accounts and flipping
`AUTH.mode`, which needs the live project. Everything else
was verified by driving the app headlessly with Playwright in **forced local mode**
(config's firebaseConfig blanked via request interception) with fictitious seed
data — **never** real applicant PII, **never** the live Firestore. Verified across
**Chromium, Firefox, and WebKit** at mobile (400/430px) and desktop (1000px):
all three roles (committee/admin/applicant), every tab, the gate (old code
rejected / new accepted / applicant code), question decryption, candidate slot
selection, the panel editor + validation, and tab keyboard navigation — no console
errors. The paneling algorithm was re-ported to Python and checked against 300
randomized trials (optimal matching + every panel invariant). What still needs
the operator's live testing: Firestore reads/writes under the hardened rules and
the three role-account sign-ins (see the console steps in README).

---

## Firestore rules actually verified (Sept 21 2026)
- **Why:** the rules suite was written on Sept 18 but had never been *run* — this
  environment had neither Node nor Java, so every claim about the rules rested on
  reading them. Two days out from the screening cut, that was the biggest
  unverified thing in the tool.
- Installed the toolchain (`nodejs npm default-jre-headless`) and ran it:
  **30 tests, 30 pass**, emulator and all. The guarantees in
  [`tests/README.md`](tests/README.md) now hold as tested facts: the ranking and
  screening stay admin-only, an applicant reaches no committee data, an applicant
  can write availability but not read it back, only the admin can change setup,
  reviewers can still do their job, and unknown/anonymous accounts get nothing.
- Confirmed the suite is load-bearing, not vacuously green: replacing
  `isAdmin()` with `return true` fails **16 of the 30** — including every
  anti-bias guarantee. Rules file restored byte-for-byte afterwards.
- **Still needs the operator:** the three Auth accounts + `AUTH.mode` flip
  against the live project. The rules they will run under are now tested; the
  accounts themselves cannot be exercised without Firebase.

---

## Interview-times editor + stable time ids (Sept 18 2026)
- **Why:** availability and manual panels were keyed by a time's *position* in the
  list, so removing or inserting a time silently moved people's answers onto a
  different time. Times now have permanent ids (`js/slots.js`); legacy lists and the
  config defaults keep their index as id, so nothing already saved moves.
- **Setup → Interview times:** grouped by day, per-time answer counts and "panel
  booked" markers; add a single time or a split block (preview before adding); edit
  (with **Keep answers** / **Ask again** when people have answered) and remove a
  time or a whole day (confirmation lists answers and panels affected).
- **Edge cases:** duplicates blocked; overlap and past-date warnings; end-before-start
  and too-short ranges caught in the preview; removing the last time now really
  leaves none (it used to snap back to the config defaults); stale answers for
  removed times don't count as "submitted"; manual panels at a removed time are
  dropped and flagged; an admin editing a time that someone else removes is told so.
- **Concurrency:** writes go through `store.updateTimes`, a Firestore transaction
  that re-reads the latest list (and writes the applicant mirror in the same commit).
- **Bug fix:** settings writes used `setDoc(…, {merge:true})`, which deep-merges maps,
  so deleting a manual panel ("Reset to auto") never removed it in Firestore. Now
  `mergeFields`, which replaces each written field.
- **Bug fix (applicants):** saving availability rewrote the whole record from what
  the page knew. Applicants can't read their saved record (write-only), so tapping one
  time on a return visit erased everything they had picked before. Now each tap
  changes only that time, and the applicant's own picks are remembered on their device
  so they can see them when they come back.
- Setup no longer loses what you're typing when someone else saves in the meantime.
  Other people's live changes are held while you're typing and applied when you leave the field.
- Manual panel saves, chair and committee changes also read the latest saved copy
  first, so an admin working from an out-of-date screen can't bring back a deleted panel.
- Verified headlessly (local mode, fictitious data) in Chromium, Firefox and WebKit at
  1000px and 400px. The Firestore transaction path needs a live check by the operator.

---

## Unified 3-code login (admin / physicians / guest)
Replaced the single committee code + "!" convention with **three independent codes**
shared across the ED tools:
- **Admin** (leadership), **ED physicians** (staff/committee/voters), **guest**
  (applicants) — chosen by the user; kept out of the repo (only the low-value guest
  local-fallback appears, in `config.js`).
- **Crypto:** the questions are now encrypted with a random content key `K` that is
  wrapped separately under the staff and admin codes (`data.js`/`mock.html`), so the
  two codes are **fully independent** yet both decrypt — which also **closes the
  self-elevation gap** the audit flagged (a reviewer can no longer become admin).
  `decryptContent` returns `{q,s,g,isAdmin}`; `unlock` no longer strips a trailing "!".
- **Motion Voting:** `ADMIN_PASSCODE` updated to the shared admin code (if the locked
  Firebase backend is used, update the `LEADER_EMAIL` Auth user's password to match).
- Updated README (three-code scheme + re-keying recipe), `firestore.rules` header,
  and the roles table. Verified in Chromium/Firefox/WebKit: staff→committee,
  admin→admin (+admin tabs), guest→applicant, wrong/old codes rejected.

## Audit round 1 — fixes from a 6-dimension adversarial review
Ran a multi-agent audit (security, persistence, logic, edge cases, paneling,
a11y/CSS) with per-finding verification. Fixes applied, worst first:

- **CRITICAL (functional):** candidate availability was *read* by display name but
  *written* by normalized last-name key, so tapped times never highlighted and a
  second tap silently cleared them. Now reads by the same `ui.candLast` key. Verified.
- **CRITICAL (cross-browser):** Firefox rejects large PBKDF2 `deriveBits`, so the
  questions wouldn't decrypt in Firefox → switched to PBKDF2→HKDF keystream
  (previous commit). Verified in Chromium/Firefox/WebKit.
- **Panel overrides no longer trusted blindly:** `computePanels` re-validates every
  override (force chair, drop members no longer on the committee, check size +
  balance + per-slot modality availability); the editor now has an explicit
  modality control; unbalanced saves ask for confirmation; the "balanced panel"
  badge is now conditional (✓/✗) with warnings; and changing the chair/committee
  migrates or prunes saved overrides.
- **Paneling:** replaced the greedy most-constrained-first assignment with maximum
  bipartite matching (Kuhn's) — never falsely marks a candidate unschedulable when
  a full assignment exists. Re-validated in Python (300 random trials optimal).
- **A11y:** tabs now have `aria-controls`/`aria-labelledby`, roving tabindex, and
  arrow/Home/End keyboard nav; confirm/gate dialogs are `role="dialog"` with focus
  restore + Tab trap; decorative emoji wrapped in `aria-hidden`; WCAG-AA contrast
  fixes (faint text, amber, tinted-button label); backdrop-filter opaque fallback.
- **Robustness:** anon sign-in errors now surface at the gate (no silent blank app)
  + a console warning when running `anon` with a real project; Score "Guidance"
  section keeps its open/closed state; Screen status pill distinguishes
  "removed" (admin) from "excluded · flags"; panel-editor member handler passes a
  committee index so names with apostrophes can't break it; dropped a dead
  settings-mirror guard. Documented the admin-vs-reviewer shared-code limit honestly.

## v2 — Apple redesign, unified candidate login, real security model
Large cohesive pass. Everything verified headlessly in local mode (committee,
admin, applicant flows; mobile + desktop; no console errors).

**DESIGN** — rewrote [`css/styles.css`](css/styles.css) as one Apple-style sheet:
hairline cards with soft depth, SF-style type + spacing, iOS segmented controls &
toggles, translucent sticky segmented tabs, spinner, refined toast, deadline
banner, empty states, smooth transitions, `prefers-reduced-motion` + `@media print`
support, and a proper mobile layout (larger touch targets, single-column slots).

**UX** — [`js/app.js`](js/app.js) rewrite:
- Collapsible `<details>` sections (remember open/closed) for the dense admin
  areas (Screen collation/dashboard/add, Setup, guidance) to cut overwhelm.
- Short plain-English "What to do here" instructions on **every** section.
- Real empty states everywhere (no candidates, no slots, no scores, nothing to score).

**QOL** — loading spinner + disabled state on the gate and on every awaited action
(login, save, add, exports, reveal); optimistic UI (writes reflect immediately);
`saving → saved` toasts and error toasts; styled confirm dialog.

**FEAT**
- CSV exports: shortlist, schedule, scores.
- Coordinator dashboards: who has/hasn't submitted screening & availability.
- **Manual panel override**: inline editor per panel (change slot, add/remove
  members with the chair locked in, 3–5 validation) + "schedule manually" for
  unschedulable candidates + "reset to auto"/"reset all".
- Deadline banner (screening due Sept 23, turns urgent ≤3 days).
- Confirmation dialogs for destructive actions (remove candidate/time, reveal ranking).
- Print-friendly schedule (`window.print()` + print stylesheet).
- Accessibility: ARIA roles/labels, `aria-pressed`/`aria-selected`, focus-visible
  rings, keyboard-submit forms, contrast.

**C1 — unified applicant login (same link).** The gate now accepts either the
committee code (→ committee/admin) or a **different applicant code** (→ candidate
view: enter last name → pick your own times only; never sees roster/questions/
scores). `book.html` forwards to `index.html`; `js/book.js` removed. Applicants
submit availability keyed by their typed **last name** (so they never read the roster).

**SEC — real access control.** Added a role-based auth model:
- [`firestore.rules`](firestore.rules) rewritten to branch on
  `request.auth.token.email` for three role accounts (admin / committee /
  applicant). Applicants can read only public slots + write their own availability;
  reviewers cannot read scores/screening (ranking is admin-only *for real*).
- [`js/config.js`](js/config.js) `AUTH` block (mode + role emails). Default
  `mode:"anon"` so the **live app keeps working unchanged** until you activate
  roles — exact console steps in README → "Real access control".
- [`js/store.js`](js/store.js) is now role-aware: subscribes only to collections a
  role may read, and keeps a per-device "echo" of a reviewer's own screening/scores
  so they still see their own input without a server read. Slots are mirrored to a
  PII-free `interviews_public/slots` doc for applicants.
- **Not runtime-tested** here (no live Firebase in this env): the roles path,
  rules, and the account setup need you to apply the console steps + flip
  `AUTH.mode`. Called out honestly in README and the rules header.

Schema: additive only (`settings.panelOverrides`, `interviews_public/slots`);
existing collections/keys unchanged. `availCand` now read by candidate-id (legacy)
**or** last-name key, so existing data keeps working.

## S1 — Committee code rotated + questions re-encrypted
- The old code `edleadership` (public — it is also Motion Voting's passcode) no
  longer decrypts the interview questions. Re-encrypted `{q,s,g}` under a new
  strong private code (same PBKDF2-SHA256 keystream + XOR scheme, same salt/iters).
- Updated `ENC_CIPHER` in [`js/data.js`](js/data.js) and [`mock.html`](mock.html).
- The new code appears **nowhere** in the repo. It is delivered in the morning
  summary (chat only).
- Verified end-to-end in a headless browser: old code → "Incorrect code"; new
  code → accepted; new code + `!` → admin accepted.
