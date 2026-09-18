# Changes — overnight polish pass

Running log of what changed and why, newest first. Companion to DESIGN.md
(decisions) and README.md (how to run). Written during the autonomous polish
pass so the morning review has a paper trail.

Verification note: the build environment has no live Firebase, so Firestore
**rules** and the **roles** auth path could not be exercised here. Everything else
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
