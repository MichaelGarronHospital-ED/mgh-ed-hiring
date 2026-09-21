# Changes — overnight polish pass

Running log of what changed and why, newest first. Companion to DESIGN.md
(decisions) and README.md (how to run). Written during the autonomous polish
pass so the morning review has a paper trail.

Verification note (updated Sept 21 2026): the Firestore **rules** have since been
exercised for real — the emulator suite in [`tests/`](tests/) runs green here,
**40/40**, and was confirmed load-bearing by breaking `isAdmin()` and watching 20
of the 39 fail (see the Sept 21 entries below). What remains untested is only the
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

## Finding input stranded on a removed applicant (Sept 21 2026)

A reviewer reported a rating they had given that no longer appeared. It was not
the read-back path at all: the applicant had been removed and re-added under a
corrected surname, so the rating sits on the soft-deleted entry. The
orphan check added earlier the same day could not see it — `migrate-candidate.mjs`
says why in its own header: *"the old entry is only soft-deleted
(removed:true), so it isn't even detectable as an orphan."* That is the one
shape this failure has actually taken here, so it is the one the check has to
find.

- **`hiddenInput()` replaces the orphan-only check** and catches both shapes:
  a roster entry that is gone, and one that is only `removed:true`. The
  coordinator dashboard now names the entry, breaks down what is stranded
  (flags / ratings / interview scores), lists the members affected, guesses the
  live entry it belongs to by matching first name or surname key, and prints a
  runnable `migrate-candidate.mjs --from … --to … --apply`. It also says
  plainly that nothing is lost.
- **Ratings are attributed in the collation**, like flags always were, behind a
  tap-to-open "*n* ratings". Without it there was no way to answer a reviewer
  asking "is mine recorded?". A `<details>`, not a tooltip, on purpose: a phone
  has no hover, so anything parked in `title`/`data-tip` is unreachable on the
  device most of this committee uses.
- **A real applicant's name was in the public repo** — the worked example in
  `scripts/` used the actual applicant whose name was mangled, together with
  the story of it. Replaced throughout with an invented one. Note this only
  scrubs the working tree; **git history still contains it**, and removing that
  needs a history rewrite and a force push.

Reviewer isolation was re-checked against the same data: with input stranded on
a removed duplicate and other people's flags and ratings present, an ordinary
reviewer's DOM contains no collation row, no rating chip, no hidden-input row,
no flag reason, and no mention of the removed entry — while the live applicant
stays reviewable. An applicant's isolation is asserted in the rules suite by
both verbs (`get` and `list`) on screening and scores, so the Sept 21 loosening
for reviewers did not reach them; and the guest code was run through
`decryptContent` in a real browser, with near-miss guesses, to confirm it
unwraps no interview questions.

---

## Legible grid, honest averages, readable collation, screening read-back (Sept 21 2026)

Prompted by four questions from Alvin after using the tool: the grid's vertical
names were hard to read, it wasn't clear how averages handle people who didn't
vote, his own ratings looked missing after a re-login, and nobody knew what the
collation card does when several people flag one applicant. Answering them
turned up a shipped CSS bug that had been hiding every instruction in the app.

- **`.tip` collided with `.note.tip` — every "What to do here" box was
  invisible.** The instant-tooltip class added in *Instant info tooltips* (Sept
  18) was called `.tip`, and `.note.tip` — the blue guidance box on every tab —
  had been using that name since the first build. `.note.tip` only overrode
  `background`/`border-color`/`color`, so it inherited `position:absolute`,
  `opacity:0` and `pointer-events:none` from the tooltip and rendered nothing.
  The worst case was the **applicant** view, whose only on-screen explanation of
  in-person/Zoom/either is one of these boxes: applicants have been picking
  times with no instructions at all. The tooltip is now `.tooltip`; don't rename
  it back. Delegated tooltip binding was also widened from `.info` to
  `[data-tip]`, so the availability grid's per-square names work as its legend
  has been promising.
- **Interviewer names in the availability grid are slanted 45°**, not vertical.
  Each label is absolutely positioned and rotated about its bottom-left corner,
  so it starts at its own column and rises to the right; a `pad` spacer column
  keeps the last name from being clipped, since rotated text is out of flow and
  can't widen the table. Grid cells gained `min-width` — without it the table
  shrank to fit a phone and squashed the squares into slivers instead of
  scrolling.
- **The averages now show their denominator, and the ranking corrects for who
  did the scoring.** Nothing was ever normalized: both averages are plain means
  over whoever answered, and a missing answer is (correctly) left out rather
  than imputed — but the figure alone can't distinguish 4.5-from-two from
  4.5-from-twelve. Screening now prints "*n* of 13 rated" next to every average.
  Ranking adds an **Adj** column: each candidate faces a different 3–5 person
  panel, so a plain mean also measures panel generosity. Adj subtracts each
  rater's own offset (their mean minus the overall mean) before averaging;
  raters with a single score have no measurable offset and are left alone, so
  with disjoint panels Adj degrades gracefully to the raw mean. Rows whose rank
  changes under the adjustment say so with a ▲/▼. Both columns are shown
  because the adjustment is a model and the raw mean is the fact.
- **The collation card is a list, not a six-column table.** Several people
  flagging one applicant is the normal case, and `"; "`-joining their sentences
  into one table cell produced an unreadable run-on that also hid who said what.
  Each reason is now its own attributed line (leadership-only, as before), with
  bare flags shown as "flagged without a reason" and sorted last. Applicants
  still in the running sort first. The CSV gained *Flagged by*, *Rated by* and
  *Committee size* columns for the same reason.
- **A reviewer's own screening now follows them to any device.** This was the
  "I rated people, logged out, and my ratings were gone" report, and it had
  three causes, all real: under the roles model a reviewer could write screening
  but not read it back, so the app replayed their answers from a per-device
  localStorage echo — which is not written when you are signed in as *admin*
  (rate as admin, return as a reviewer, blank), was not written at all before
  `AUTH.mode` flipped to `roles` on Sept 18, and never crosses to a second
  device. Plus a remove-and-re-add strands everything on the old `c-<uuid>`.

  **Fix (Alvin's call, Sept 21):** `interviews_screening` now allows `get` to
  the committee and `list` to admin only. The app subscribes to precisely
  `<member>~<candidateId>` for the signed-in member — `store.setMember()` →
  `_syncOwnScreening()`, re-run whenever the roster changes — and never requests
  a colleague's document. The collation still needs `list`, so it stays
  leadership-only.

  **Scores were deliberately NOT loosened.** A reviewer who could `get` a score
  could reconstruct the ranking mid-process, which is the one thing this model
  exists to prevent; the Score tab still replays from the device mirror and now
  says so in as many words. The asymmetry is asserted in the test suite so
  nobody later "tidies" it into symmetry.

  **Honest limit, written down rather than glossed:** all reviewers share one
  Firebase account, so the `get` is not scoped to the person doing it — a
  reviewer at a browser console could fetch a colleague's screening document.
  That is the same trust boundary the *write* side has always had (anyone with
  the staff code can already submit screening as someone else), so it widens an
  existing limit rather than introducing a new kind. Closing it properly means
  per-member accounts; README → "Real access control" spells out the cost. The
  Screen tab's copy changed accordingly, from the promise "nobody else sees your
  flags or ratings" to the true statement that the app never shows one reviewer
  another's.

  Alongside: the coordinator dashboard **counts entries attached to applicants
  no longer on the list** and points at `scripts/migrate-candidate.mjs`; and the
  member picker waits for the saved roster (`store.ready`) instead of letting
  someone commit to a config-default spelling, with a live guard that returns
  them to the picker if the roster stops containing their name mid-session.

  **Ratings are shown in admin view only** — confirmed as an explicit
  requirement after the above landed. The front end may be *able* to fetch; what
  matters is that nothing renders a rating outside admin view. Every path that
  carries someone else's figure (the collation card, both CSV exports, the
  Ranking table) is behind `ui.isAdmin`, and Panels/Ranking aren't in a
  reviewer's tab row. Belt and braces: a committee-scoped store subscribes to no
  collection holding ratings, so a reviewer's state has nothing to leak even if
  a gate were missed. Checked end to end by signing in as an ordinary reviewer
  against seed data where *other* people had flagged, rated and scored, then
  forcing every `<details>` open and scanning the full DOM — not just the
  visible text — for their reasons, ratings, the collation, the exports and the
  Adj column. None present; the reviewer's own controls still work and show
  unset.

  **The local mirror is now written for admins too.** It used to be
  committee-only, so rating something while signed in as *admin* and returning
  with the staff code showed a blank review **on the same machine** — the
  likeliest cause of the original report, and unaffected by any rules change.
  Scores still never come back from the server, so for those this mirror
  remains the only replay a reviewer gets.

  **⚠ Deploy step:** none of the read-back works until the updated
  `firestore.rules` is pasted into **Firebase console → Firestore → Rules →
  Publish**. Until then the app behaves exactly as before — the per-document
  reads are simply denied and logged, and the app **says so rather than
  promising otherwise**: `store.screeningReadBack` starts `null`, flips to
  `true` on the first per-document snapshot and `false` on a refusal, and the
  Screen tab's wording follows it. The front end can ship ahead of the rules
  without telling reviewers something untrue.

- **The collation can be sorted by name, average priority or flags.** Whichever
  is chosen, the still-in / excluded split holds first, so someone already off
  the list never drifts back up into the list you are working. Unrated
  applicants sort **last** under average priority rather than as a low score —
  "nobody rated them" is not "everybody rated them badly", and the two must not
  look alike. The choice is remembered per device (it is a UI preference, not
  data). Checked by driving the real order for each key, including the unrated
  and excluded cases, and across a reload.
- **Declutter.** "What to do here" is now a `<details>` that remembers being
  collapsed across sessions (localStorage, per tab) — full guidance on a first
  visit, one line thereafter. Screening review cards are one row each (name ·
  priority · flag) instead of three, which took ~600px off that page. The Score
  tab gained a sticky candidate picker with ‹ › and a "*n* of *m* scored by you"
  count, ticks beside candidates already scored, and 1-based question numbers
  (they read "Question 0" before; the stored key is still the array index).
  Applicant lists are alphabetical everywhere.

Verified by driving the real app headlessly (Chromium, forced local mode, the
`data.js` content module stubbed, fictitious names only) at 400px and 1000px
across all five tabs plus the applicant view — no console errors. The rules
suite is **40/40** against the emulator, up from 33: the new screening
`get`/`list` split is covered both ways, and `tests/store.own-screening.test.mjs`
drives `FirestoreStore` against a stub Firestore to assert the client only ever
subscribes to the signed-in member's own documents.

---

## Availability grid, applicant surname gate, rename tooling (Sept 21 2026)

Three changes prompted by a real incident: an applicant's name was misspelled,
someone fixed it by removing and re-adding her, and two physicians' screening
ratings silently disappeared from the Screen tab.

- **"Who's available when" grid** on the Availability tab, visible to reviewers
  and admin. One row per interview time, one column per interviewer. Each cell
  carries a letter (`P` in person, `Z` Zoom, `E` either, blank not available) as
  well as a colour, so it reads correctly without colour vision; hover any square
  for the name. The right-hand **Panel** column answers the question the grid
  exists for — whether a balanced panel could actually run at that time — and it
  calls `buildPanel`, the same function the Panels tab uses, so the two can never
  disagree about the rules. A non-viable row says *why* on hover (no chair, too
  few, no mix). Scrolls horizontally inside its own wrapper on a phone with the
  time column pinned; the page itself never overflows.
- **Applicants can no longer submit under a surname that isn't on the roster.**
  This was a silent-loss bug: `interviews_availCand` is keyed by normalized
  surname and applicants have write-without-read, so a typo or a name we hold
  differently saved happily to a document nobody reads. The applicant saw
  "Saved" and would simply never have been scheduled. `firestore.rules` now
  `get()`s `/interviews_meta/allowed` on every applicant write — server-side, so
  the roster stays unreadable to applicants — and the app checks the name at the
  gate and says so plainly instead of accepting it. The list is kept in step with
  the roster by the admin session (`syncAllowedNames`) and by
  `scripts/sync-allowed.mjs`. **Fail-closed: run `sync-allowed.mjs --apply`
  BEFORE publishing the rules**, or applicants are locked out.
- **`scripts/` — maintenance tooling**, chiefly `rename-candidate.mjs`, which
  fixes a name **in place**. The app has no rename, so the obvious move is to
  remove and re-add — which mints a new `c-<uuid>` and strands every rating,
  score and note on the old id, with the old entry still listed as removed. That
  is precisely how the ratings went missing. Renaming keeps the document id, so
  nothing needs migrating. Also `report-data.mjs` (read-only inventory, with an
  `--issues` mode that flags stale entries, duplicate surnames and availability
  matching no candidate), `migrate-candidate.mjs` (clean up after a
  remove-and-re-add) and `purge-candidate.mjs` (hard-delete an entry, refusing
  while anything still references it). Every writing script is dry-run by default.

`lastKey` moved from `app.js` into `util.js`: the rules' allowed list, the store
and the app must agree on exactly one definition of an availability document id,
and there were about to be two.

Rules suite extended to **33 tests, all passing**, including the refusal of an
unrostered surname and the fail-closed behaviour when the list is missing. The
"one applicant can overwrite another's availability" limitation test was updated
rather than deleted — it is narrowed (the target must now be a real applicant),
not closed. App changes verified headlessly in Chromium at 1100px and 390px in
local mode with fictitious data: grid geometry, the viability column against
four hand-built scenarios, the applicant gate accepting and refusing, and no
console errors in any role.

One bug caught during that verification worth recording: the grid's column
headers used `class="who"`, colliding with the existing global `.who`
(`display:flex`), which stopped the `<th>` laying out as table cells — the
columns stacked into a single unreadable strip. Every element-counting assertion
still passed. The suite now asserts the headers' **geometry**, not just that they
exist.

---

## Screen tab: alphabetical names, one applications link (Sept 21 2026)
- **"Who are you?" is now alphabetical.** It followed the roster's stored order,
  which puts the chair first — fine for panel building, useless for finding
  yourself in a list of 13. Sorted on a *copy*: `EFF().committee` is the live
  settings array (or the `COMMITTEE` constant), and panel building reads that
  order, so sorting in place would have quietly reordered the roster everywhere.
  The `— Select your name —` placeholder still comes first, so the existing
  safeguard against clicking straight through onto someone else's name holds.
- **The CV & cover-letter link appears once, above the first candidate.** Every
  applicant's files live in the same OneDrive folder, so the identical link was
  repeating on all ~20 candidate cards. Now a single bar above the list.
- If **no** folder has been saved, the bar now says so instead of showing the
  old per-card dead link that looked clickable and explained nothing. Note the
  precedence: `EFF()` is `s.oneDrive || ONEDRIVE`, so the link saved in
  Setup → Applications folder wins and `ONEDRIVE = "#"` in `js/config.js` is only
  the fallback for a fresh deployment. A configured tool is unaffected — the
  consolidated link uses the saved folder exactly as the per-card links did.
- Verified headlessly (Chromium, local mode, fictitious candidates) as both
  reviewer and admin, at 1000px and 400px: list sorted, exactly one link, zero
  per-card links, link sits above the first card, candidate names unaffected,
  no console errors, no horizontal overflow.

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
