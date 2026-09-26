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
- **Never `merge` an empty map into Firestore — it REPLACES, it doesn't merge.**
  `setDoc(ref, { slots: {} }, { merge: true })` deletes the whole `slots` map:
  merge builds its field mask from the data's *leaf* paths, and an empty map has
  none of its own, so the map itself is the leaf. This is how `store.checkName`
  — the probe that asks the rules whether a surname is on the roster — wiped an
  applicant's availability on every return visit, invisibly (they saw their
  picks replayed from the per-device echo; the committee saw "waiting on"). The
  probe now sends `{}`, which carries no paths at all and still gets refused for
  an unknown name. `setAvail` writes exactly one key and `rename-`/
  `migrate-candidate.mjs` guard on `picks(from) > 0`; keep it that way, and pin
  any new applicant write in `tests/applicant-availability.test.mjs`.
- **Panel membership is load-balanced; don't reintroduce roster order.**
  `buildPanel` takes `{ loads, lastUsed, size }` and picks fewest-panels-first,
  then least-recently-used, then alphabetical (determinism — panels rebuild on
  every render). It used to fill in roster order, which made *every* panel chair
  + first F + first M, leaving 10 of 13 members with no interviews. This is safe
  to do greedily because feasibility is a property of the eligible **pool**
  (chair present, both genders present, ≥3 people), so ordering can never change
  *which candidates* get scheduled — `tests/panels.fairness.test.mjs` pins that
  against a copy of the old algorithm over 400 random rosters. Load cannot be
  flat across the whole roster and that is arithmetic, not a bug: every panel
  needs ≥1 woman, so 4 women covering 10 panels average 2.5 each while 8 men
  average 1.25. The tests assert balance *within* each group at the arithmetic
  minimum. `fairSize()` grows panels past 3 (up to 5) only when 3-person panels
  have too few seats to give everyone one interview.
- **Manual panels bypass most checks.** The auto-matcher gives one candidate per
  slot, so only a **manual override** can double-book a time (now surfaced as
  `doubleBooked`) or seat someone who never said they were free (now warned).
  Overlapping times are only *warned* at creation — accept one and the chair can
  be auto-scheduled into two at once.
- **A sign-in failure is not a wrong code.** A code that decrypts is *proof* it
  is a real staff/admin code (nothing else unwraps the content key), so a
  Firebase rejection after that means the **account** is wrong — its password was
  never set to that code, or it doesn't exist. `signInError(e, {codeVerified})`
  keeps those apart; never collapse them back to "Incorrect code.", which sends
  the one person holding a valid code away to retype it. The two halves are
  independent by design and nothing keeps them in step: `data.js` decides
  staff-vs-admin, the Firebase console decides whether the password matches.
  `scripts/diagnose-login.mjs` tests both halves for a given code and names the
  fault. Note Firebase throttles the **device** after repeated failures, so a
  stale code in `sessionStorage` used to lock people out by replaying on every
  reload — it is now cleared on failure.
- **Storage must never be touched directly — use `ss`/`ls` from `util.js`.**
  iOS Safari with "Block All Cookies", Private Browsing and some in-app browsers
  make `localStorage`/`sessionStorage` throw, *including the property getter*,
  so `"localStorage" in window` throws too and feature-detection is useless. An
  unguarded `sessionStorage.setItem` right after a successful sign-in meant the
  right code signed in, the write threw, and the gate never closed — "works on
  desktop, not on my phone". A blocked browser must degrade to forgetting
  between visits, never to being locked out. No raw storage calls remain; keep
  it that way.
- **A class used as a state modifier must not also be a utility class.** Third
  time now: `.tip` (tooltip vs `.note.tip`) and then `.info` — `renderBanner`
  sets the banner's *whole* className, so `"banner info"` gave the deadline bar
  the 16px round badge's `display:inline-flex; width:16px`, collapsing it to a
  circle with its text off the left edge of the screen. It needed no code change
  to appear: the modifier is only added once the deadline has passed, so it
  broke by itself the next morning. Modifiers are now `urgent`/`past`, `.banner`
  pins its own box, and `tests/css-collisions.test.mjs` fails if any banner
  modifier is also a standalone rule.
- **Form controls stay ≥16px on a phone, and that rule must stay LAST in
  `styles.css`.** `body` drops to 15.5px under `max-width:640px` and controls
  are `font:inherit`, so every field fell under the threshold at which iOS
  zooms the page on focus — the access-code box zoomed the Enter button
  off-screen mid-typing. The fixing block is last because `.overlay-box input`
  and `.tform input` have equal specificity and appear later; anything appended
  after it silently undoes it.
- **Verify layout by rendering it, not by reading the CSS.** Both phone bugs
  above looked fine on inspection and were obvious the moment the page was drawn
  at 390px. Drive `index.html` in Chromium with `js/config.js` (blank
  `firebaseConfig` → LocalStore) and `js/data.js` (stub `decryptContent`)
  swapped for doubles, so the gate opens without the real code and nothing
  reaches Firebase. Check every width for horizontal scroll, escaping elements,
  sub-16px fields and tap targets under ~40px.
- **The tooltip class is `.tooltip`, never `.tip`.** `.note.tip` is the blue
  guidance box and has been since the first build; when the instant tooltip was
  briefly also called `.tip` it silently gave every one of those boxes
  `position:absolute; opacity:0`, so the instructions on every tab — including
  the applicant's only explanation of in-person/Zoom/either — rendered nothing.
- **Screening and scores are read back differently, on purpose.** Screening
  allows `get` to the committee and `list` to admin only: the app subscribes to
  exactly `<member>~<candId>` for the signed-in member (`store.setMember` →
  `_syncOwnScreening`), so a reviewer's own flags and ratings follow them to any
  device while the collation stays leadership-only. **Scores allow neither** —
  a reviewer who could `get` a score could rebuild the ranking mid-process — so
  the Score tab still replays from the per-device `localStorage` echo and says
  so on screen. Don't make scores symmetric with screening, and don't widen
  screening to `list`; both are pinned by tests that fail on either change.
  Because all reviewers share one account the `get` is not scoped to the person
  — the honest limit is written up in `firestore.rules` and README; the real fix
  is per-member accounts.
- **Nobody but admin is ever SHOWN another person's rating.** Decided explicitly
  (Alvin, Sept 21): the front end may be *able* to fetch, but ratings render
  only in admin view. Every render path that carries someone else's figure —
  the collation card, both CSV exports, the Ranking table — sits behind
  `ui.isAdmin`, and Panels/Ranking aren't in a reviewer's tab row. Belt and
  braces: a committee-scoped store subscribes to no collection holding ratings,
  so a reviewer's state has nothing to leak even if a gate were missed. Both
  halves are pinned in `tests/store.own-screening.test.mjs`. Don't add a rating,
  average or flag count to a view that isn't admin-gated.
- **Changing `firestore.rules` needs a console Publish to take effect.** Editing
  the file in the repo does nothing on its own, and the tool will silently keep
  the old behaviour. Run `scripts/sync-allowed.mjs --apply` first where the
  allowed-name list is involved.
- **No average is normalized, deliberately.** Screening and ranking means are
  over whoever answered; a non-answer is never imputed. Always print the count
  beside the mean. Ranking's `Adj` column is the only adjustment — rater-centred
  (each rater's mean minus the grand mean, subtracted from their scores),
  skipped for raters with a single score — and it is shown *alongside* the raw
  mean, never instead of it.
- **Never put a real applicant's name in the repo.** Names belong in Firestore
  only. A worked example in `scripts/` once carried a real applicant's name in
  a public repo, alongside the story of her name being mangled — use invented
  names (`Rosalind Ashcombe`) in docs, comments and seed scripts.
- Timeline is tight: **screening cut Sept 23 2026**, interviews start ~week of Sept 30.
