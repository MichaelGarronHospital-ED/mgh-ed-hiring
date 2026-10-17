# Interviews (ED Physician Hiring)

Three-phase hiring tool: **Screen → Schedule → Score**. Static site + Firebase.
Full design and reference data (committee, candidates, questions, rules) live in
[`DESIGN.md`](DESIGN.md); open confirmations in [`QUESTIONS-FOR-KYLE.md`](QUESTIONS-FOR-KYLE.md).

## This repo

- **Lives in the `MichaelGarronHospital-ED` org as `mgh-ed-hiring`**, served by GitHub
  Pages from `main` (root folder, no build step) at
  `https://michaelgarronhospital-ed.github.io/mgh-ed-hiring/`. The repo name is part of
  every shared link and QR code: renaming it breaks them all, because GitHub
  does not redirect Pages sites.
- **Split out of the old `DrAlvinYang/ED-motion-voting` repo in Oct 2026.**
  That repo now holds only redirect pages pointing here. Its history was
  filtered to this tool, so paths in old commits and in `CHANGES.md` may still
  say `tools/...`; that is history, not a bug.
- **Firebase project id `mgh-ed-hiring` is immutable.** It does not track the repo name;
  don't "fix" it to match.
- **Relative paths only.** Nothing in the code should hardcode the repo name.
- **Org rules:** public repo (free-plan Pages), GitHub-authored Actions only,
  feature branches merge to `main`, merged branches auto-delete.

## Commands, deploy and accounts

- **Local folder:** `MGH-ED-Tools/hiring-tool` (short name; the repo name stays
  `mgh-ed-hiring`). `../README.md` maps every ED tool.
- **Run locally:** `python3 -m http.server 8000`, then open http://localhost:8000.
  This talks to the **live** Firebase project and real applicant data: look, don't edit.
  For a safe copy with Firebase switched off, use `sim/make-site.sh` (builds `sim/site/`).
- **Rules tests:** `cd tests && npm install && npm test` (Firestore emulator; needs Java). 190 tests
  (109 from before rules v2, unchanged, plus `rules-v2.test.mjs`).
- **Real page against the emulators:** `cd sim && npm run emulator` (needs `tests/` installed
  and Java). Runs the real FirestoreStore and Firebase Auth against local emulators with the
  real `firestore.rules` (`sim/emulator.mjs`); the patch that points the copy at the emulators
  lives only in `make-site.sh --emulator`, never in the repo's own files.
- **UI simulations:** `cd sim && npm install && npm test`. Any Chrome works; set `$CHROME`
  to pick one. All pass (15/15 scenarios, e2e, score, auth, fuzz; 2026-10-16). Fixture
  interview dates come from `daysAhead()` in `sim/drive.mjs`: never hard-code a
  date, because once it passes the tool adds a "date is in the past" dialog and the
  time-edit scenarios fail (that, not macOS, was the old 13/15).
- **GitHub Actions:** `.github/workflows/tests.yml` runs `tests/` (emulator) and the full
  `sim/` `npm test` (the runner's Google Chrome) on every push to any branch and every pull
  request. Free on a public repo. Actions are pinned by commit hash; runner image `ubuntu-24.04`.
- **Deploy the site:** push to `main`; GitHub Pages is live about a minute later.
  Firestore rules are separate: see README (run `scripts/sync-allowed.mjs --apply` first).
- **Accounts:** repo owned by the `MichaelGarronHospital-ED` org (department login
  `MGH-ED-Admin`). Firebase project `mgh-ed-hiring` is owned by the Google account on
  MGHEmergencyDepartmentAdministration@tehn.ca (second Owner: dralvinyang@gmail.com,
  until another ED person is added). Free Spark plan. Publish rules with
  `npx firebase-tools deploy --only firestore:rules` (department login); live rules matched
  the repo on 2026-10-14. Applicant files (CVs) are NOT in this
  public repo; they stay in Alvin's "ED Interviews" folder.

## Non-negotiables

- **Members are keyed by `id`, never by display name. Legacy ids are the names; never re-key.**
  Screening and score ids (`<member>~<candId>`), interviewer availability, the chair, hand-made
  panel members and the per-device echo all hold member ids (`js/members.js`). The name is for
  display only (`EFF().nameOf`), so a rename moves nothing.
- **A person is removed from the committee outright only when they have saved nothing.**
  Otherwise mark them "Left the committee" (`active:false`): their input stays and still counts
  (concerns, ratings, scores, exports say "(left)"), and they leave the name list, panels, the
  availability grid and every "waiting on" line. "Screens only" (`role:"screener"`) people get
  the Screen tab alone. The chair must stay an active interviewer.
- **A closed stage is enforced by the rules, and the page disables its inputs too.** Every
  stage change, and the booking flag applicants read, goes through `store.updateState` in one
  commit with its history entry. While the schedule is locked, panels come from
  `interviews_meta/schedule` only; never recompute or silently move a locked panel.
- **The close flow deletes a document only if it equals its archived copy, only in
  `CLEAR_COLLECTIONS` (never `interviews_meta` or `interviews_public`), and only inside a
  transaction that checks this page still holds the close.** Nothing in meta changes until the
  single finish batch. EVERY write the close flow makes (pause, heartbeat, parts, copy saved, step
  changes, delete chunks, put-back, finish, auto-stop, both Stop buttons, Try again, takeover)
  goes through `closeTx` (`js/rounds.js` → `store.closeTx`), which re-reads `state` and the
  attempt and commits only if this page (its id and this load's nonce) holds the lease and the
  attempt has the expected status. Before any timer of the flow acts, and on wake, the page
  re-checks ownership. The flow's transactions run one at a time (one chain in `rounds.js`). Never add a plain write to this flow; `sim/emulator.mjs` "sleeping laptop"
  fails if one comes back.
- **Backup `version` goes up on any stored shape change; restore must still accept every older
  file; `ROUND_COLLECTIONS` must match the rules (test).** A restore plan is always made from a
  fresh `snapshotRaw()`, never page state; the round comes back open with a new `roundId`.
- **Questions lock once scoring starts** (any score with a number or a note): only the wording
  may change. Never add, remove or reorder mid-round; notes are filed under the ids.
- **Score notes are keyed by question id. Legacy ids are `"0"`..`"9"`; never renumber.** The
  questions live in `interviews_meta/questions` only (R1 to R6 copied them out of the old
  encrypted `js/data.js` with exactly those ids; since R7 nothing reads that file).
- **Every module import carries `?v=<release>`** (same as `version.json` and `RELEASE` in
  `app.js`, and both pages' stylesheets and module tags, checked by `tests/versions.test.mjs`;
  a release between two numbered ones is `R7b`). Bump them all together each release. Never
  remove a module or an export in the release that stops using it; remove it one release later.
- **Backups read the server fresh (`store.snapshotRaw`); never build one from page state.**
  The leadership page mixes this browser's echo into its state and fills in defaults. The
  Excel workbook is built from the same fresh read (`toState` + `withState`).
- **Every leadership change writes its history entry in the same batch or transaction**
  (`store.*(…, history)`), with no applicant name in it. Undo is offered only for hand-made
  panels, leadership on/off decisions and "make this a note" (`js/history.js`).

- **Applicant PII never lives in this app.** CVs/cover letters stay in OneDrive;
  the app only links out. Store only names + committee input (flags/ratings/scores).
- **Two audiences, two identity models.** Committee = trust-based name-pick +
  passcode admin (like Motion Voting). Candidates = **one shared Guest password plus
  their own surname** (the rules check the surname against the roster), **no
  per-person links and no public candidate list**.
- **The ED password can save but never delete.** Every ED physician holds it, not
  just the committee, so in `firestore.rules` the committee account may only create
  and update (screening, scores, its own availability) and cannot write the roster;
  every delete and every roster change is admin-only. Nothing in the app needs more:
  un-ticking a time is `deleteField()` under merge (an update), and clearing a rating
  or score saves `0`. Keep it that way; a committee write that needs `deleteDoc` is a
  sign the write is wrong, not the rule. Pinned in `tests/firestore.rules.test.mjs`.
- **Sign-ins last one tab, and Log out signs out of Firebase.** `tabOnly()` sets
  `browserSessionPersistence` (memory only if sessionStorage is blocked) before the first
  attempt; a reload in the same tab resumes from it (`resume()`, `auth.authStateReady()`),
  and a sign-in that ends while the page is open returns to the gate with "You were signed
  out. Please sign in again." Both Log out buttons call `logOut()`, which
  signs out before reloading. Firebase's default kept the sign-in in the browser for good and
  let a second tab switch the first tab's account. Pinned by `sim/auth.mjs`.
- **Admin signs in with no name; `ui.member` can be `null`.** The admin code
  lands as "Admin" (coordinators hold it, not just physicians). Every view that
  files input under `ui.member` — own screening, own availability, the Score
  tab — must be hidden when it's null, or it writes under `"null"`. An admin
  picks a name via "review as a member". Pinned by `sim` → `adminHasNoName`.
- **All asset paths relative** so GitHub Pages serves it at `…/mgh-ed-hiring/`.
- **Panel rules** (Phase 2): 3–5 members, Kyle present if available, ≥1 male +
  ≥1 female. Genders are in DESIGN.md; treat hard-vs-soft as pending Kyle's confirm.
- **`CHAIR` must exactly match a `COMMITTEE` name** (`js/config.js`). `buildPanel`
  requires the chair in the available pool, so a typo or a roster edit that drops
  the chair makes *every* candidate "unschedulable" with no obvious cause. Chair is
  **Kyle Vojdani**, the 13th member (the 12 in DESIGN.md are the others).
- **Rooms and day chairs (H13).** `autoPanels` takes `chair` as a string, `null` (no chair that
  day) or a function `(slotId, room) => id | null`, and `opts.rooms = { slotId: 2 }`. A two-room
  time is two seats; both rooms of a time are built together and never share a person. With a
  string chair and no rooms the result is EXACTLY the old one: `tests/panels.rooms.test.mjs`
  checks it against the frozen `tests/fixtures/panels-v1.mjs` over 400 random rounds. Never edit
  that fixture; the app passes the function only when rooms or day chairs are set.
- **The Score tab never pre-selects an applicant** (H9), and once the schedule is locked it lists
  the reviewer's own interviews first ("Show all applicants" to widen). The five `renderScore`
  rules below still hold; run `npm run stress` after any change there.
- **Applicants learn about booking only from `interviews_public/slots.booking`** and their own time
  only from `interviews_applicant/{their key}` (one `get`, never a listener or a list). The page
  reads `booking` before asking for a name, so a refusal is never reported as an unknown name.
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
  is a *soft* delete, so a re-add strands every rating on the old id. Since Oct 2026
  use the app: Screen tab, More, **Rename** (keeps the id, moves availability when
  the surname key changes) or **Merge into another entry** (the in-app port of
  `scripts/migrate-candidate.mjs`, with a preview). The scripts stay as a fallback.
- **Working-round documents are deleted only by Leadership actions that say so
  (merge, delete permanently) or by the close-round flow, which archives and
  verifies first.** Every in-app move is a plan from `js/candidates.js` applied by
  `store.applyPlan`, which writes copies before deleting their sources.
- **Applicant availability is keyed by `candKey`**: the applicant's own `availKey`
  when they share a surname with another active applicant (H14, `surname-firstname`,
  set by the app, never re-keyed), else the normalized surname (`lastKey`). ONE
  definition (`util.js`), shared by the app, the store, the rules' allowed list and
  `scripts/allowed-list.mjs`. A surname change moves the document; two applicants
  sharing a surname share one document only until leadership separates them (new
  pairs are separated when added; a surname-only document is never guessed, leadership
  is asked whose it is). The rules
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
- **Fairness needs the repair pass, not just the greedy.** `buildPanel` gives
  each seat to whoever has fewest panels *so far*; ties break alphabetically, so
  a round can still end with someone on zero while people later in the alphabet
  never lose a tie. `shareOut()` (run at the end of `autoPanels`) fixes that with
  augmenting-path swaps, and only accepts a chain where **every panel it touches
  is still legal** — chair present, same size, still balanced, everyone still
  available in that modality, and nobody dropped to zero to seat somebody else.
  Don't "simplify" it away: without it a real 13-person round left one
  interviewer off all eight panels while free for four of them.
- **Three different things put an applicant on the unschedulable list**, and they
  need three different actions: they never answered, their times can't carry a
  balanced panel, or their times are taken by someone else. `autoPanels` returns
  `why[cand] = { reason, slots }` for exactly this; the same split is made for
  interviewers on no panel. One message for all three is a bug — it sends the
  coordinator after the wrong fix, which with a one-week runway costs a day.
- **Changing the chair must not shrink a manual panel.** `IV.setChair` swaps the
  old chair out of every saved override — and if the new chair was already on
  that panel, the swap is unpaid: three members become two. The old chair stays
  on as an ordinary member in that case.
- **Quiet by default — the page is the work, not the instructions.** A tab gets
  ONE grey sentence (`hint()`); anything longer goes on the ⓘ beside the thing
  it explains. No instruction panels, no boxed notes above content. A repeated
  item is a row in a ruled `.card.flush.list`, never a card each. A status is
  shown only when it is NOT the expected one: no "✓ balanced panel" on a valid
  panel, no "0 flags" where there are none, no green pill on every row. When a
  message would repeat for N people, group it into one line naming them. This
  is undoing a real complaint ("everything looks so cluttered"), so adding a
  panel, a tint or a per-row tick back needs a reason beyond "it's helpful".
- **Two availability grids, one stylesheet block.** `availGrid()` is the
  interviewers, `candGrid()` the applicants (admin-only, and the only place the
  tool shows *what* an applicant answered rather than *whether* they did).
  Both are `.avgrid`; the applicant one adds `.demand`, which pins the summary
  column, and `.booked`, the ring marking the hour an applicant is actually
  being interviewed. In its **Usable** column red means *actionable* — people
  want that hour and no panel can run — never "nobody has answered yet", which
  is most hours while availability is still coming in and would make the grid
  cry wolf exactly when it is most used.
- **Manual panels bypass most checks.** The auto-matcher gives one candidate per
  slot, so only a **manual override** can double-book a time (now surfaced as
  `doubleBooked`) or seat someone who never said they were free (now warned).
  Overlapping times are only *warned* at creation — accept one and the chair can
  be auto-scheduled into two at once.
- **Every hiring branch after R7 must contain R7c and R7d before it merges** (merge `main` into
  it first). A branch made before them (`hiring-r8` at 689b3f8 was one) signs in with the old
  `ed-hiring.app` emails and decides roles by email; merged after the email switch, it locks
  everyone out. R7d adds `tests/emails.test.mjs`, which fails on any old address in `js/` or a page.
  Until R7d, every sign-in tries both emails of an account (the kind that last worked first,
  `js/signin.js`), accepting only the pinned uid; R7d (weeks after the email switch) drops that.
- **A role is known by its account's uid, never by its email (R7c, rules v3).** `firestore.rules`
  checks `request.auth.uid` and the `password` sign-in provider (`signedIn(uid)`); every page and
  script decides "who is this" by `uid` against `AUTH.uids` (and `PARTNERS.voting.uids`), and uses
  the emails only to sign in (and treats a sign-in that lands on another uid as a refusal).
  `tests/uids.test.mjs` keeps the config uids equal to the rules' and fails on any `.email ===`
  role check in `js/`. This is what lets the account emails move to `.invalid` addresses with no
  rules change and no signed-in page dropping out (`sim/emulator.mjs` `emailChangeKeepsSessions`).
  **Never delete a role account**: a new account has a new uid, refused until the rules and
  `AUTH.uids` are updated; a lost password is set by `set-passwords.py` on the same account.
- **The role is found by signing in, and nothing in any repo may be derived from a password.**
  Since R7 the gate tries the password on the role accounts in `roleOrder()` (Guest first on
  `#apply`, else the role that last worked on this browser, `ls` `ed_iv_lastrole`, else ED,
  Guest, Leadership); a refusal moves on, any other error stops with its own message
  (`signInError`), all refused is "Incorrect password." So a password can change with no
  commit, from the ED tools passwords page (`passwords.html`, `js/pwpage.js`, Leadership only;
  Setup and the ED dashboard link to it; the rules of the change in `js/passwords.js`): tick,
  the CURRENT values and Check (proves every account, changes nothing), and only then the new
  values and Change now. Every message sits at the top of its step (a phone's keyboard covers
  the bottom), and on a touch screen the field to fix is marked, not focused. Never bring back a
  file, hash, wrap or check value made from a password (the old `js/data.js` wraps let anyone
  test guesses offline and forced a commit for every change), and never let a password reach
  the console, storage, Firestore or history: `tests/passwords.test.mjs` spies on all of them.
  The change order is fixed (Motion Voting first, hiring `admin@`, the page's own account,
  last), each account is signed in seconds before its own change (Firebase's 5-minute
  recent-login rule), helpers use `initializeAuth` with `inMemoryPersistence` (never
  `getAuth`, which would store the ED and Guest sign-ins on the Leadership computer), and a
  re-run converges. The three passwords must all differ, or the gate cannot tell roles apart.
  Firebase throttles the **device** after repeated failures, so nothing replays a password:
  it is never stored (an older page's `ed_iv_code` is deleted on load).
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
- **The look comes from `css/ed-ui.css`, an exact copy of the shared master**
  (`../dashboard/shared/ed-ui.css`), loaded before `css/styles.css` in both
  pages. Never edit the copy: change the master and `cp` it. `styles.css` uses
  only its `--ed-*` tokens, so dark mode (follows the device) and light print
  come from there; don't add hex colours.
- **Form controls stay ≥16px on a phone, and that rule must stay LAST in
  `styles.css`.** Some fields are set smaller for density (times form, offer
  notes and dates), and controls are `font:inherit`, so fields fell under the
  threshold at which iOS zooms the page on focus — the access-code box zoomed the Enter button
  off-screen mid-typing. The fixing block is last because `.overlay-box input`
  and `.tform input` have equal specificity, so order decides; anything appended
  after it silently undoes it.
- **Verify the pipeline by playing a round, not by reading the scheduler.**
  `sim/` drives a whole round through the real UI (leadership adds applicants,
  interviewers and applicants submit availability, panels get built) and checks
  what the Panels tab *shows* against the rules restated independently of
  `panels.js`; `npm run fuzz -- 100 1` does it on random rounds, replayable by
  seed. Both defects it found — the idle interviewer and the three-cases-one-
  message diagnosis — were invisible in the code, which was busy being correct.
- **Verify layout by rendering it, not by reading the CSS.** Both phone bugs
  above looked fine on inspection and were obvious the moment the page was drawn
  at 390px. Drive `index.html` in Chromium with `js/config.js` swapped for a double
  (blank `firebaseConfig` → LocalStore, test passwords in `LOCAL_CODES`), so
  the gate opens without a real password and nothing reaches Firebase
  (`sim/make-site.sh`). Check every width for horizontal scroll, escaping elements,
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
- **Leadership is checked first in every rule, so stage gates cost ED and Guest writes
  only.** Rules v2 reads `interviews_meta/state` with `get()` for the stage and round
  gates; `isAdmin() || ...` first means leadership saves never pay for it. Every gate
  reads a missing field as open, so older data and older pages behave as before.
- **Every published rules version is tagged** (`rules-v1-2026-10-16`, `rules-v2-<date>`).
  Roll back the page first, then the rules, never the rules alone under an R1+ page.
- **Changing `firestore.rules` needs a console Publish to take effect.** Editing
  the file in the repo does nothing on its own, and the tool will silently keep
  the old behaviour. Run `scripts/sync-allowed.mjs --apply` first where the
  allowed-name list is involved.
- **Interview scores are typed, 1.0–5.0 to one decimal** (requested Oct 1 2026). Older
  scores are whole numbers and were left as they are — no migration; they
  display as "4.0". `parseScore` refuses anything else rather than rounding it.
  These rules keep a typed box as safe as the buttons were — `sim/score.mjs`
  pins each: (1) **`renderScore` patches in place** while member+candidate are
  unchanged and rebuilds only when they change. A rebuild per save ate taps on
  ‹ ›, dropped focus, and an attempt to carry typing across rebuilds put one
  candidate's note into the next one's box. (2) **The score box carries its own
  `data-me`/`data-cid`** and both handlers use those, never `ui.scoreCand` —
  Chrome fires `change` on a focused box as a rebuild removes it, after the
  candidate has switched, which filed one score under two candidates.
  (3) **A valid score saves after a 600ms pause**, and commits on **blur**, not
  `change` (change doesn't fire when the text is back to what it was at focus,
  so a deleted score stayed saved). (4) **Before a rebuild, `flushPending()`
  saves anything still pausing** — a rebuild draws from saved state, so a note
  typed <0.5s before a switch came back blank and the next keystroke cancelled
  its save. (5) **The tab draws from `myScore()`** (saved + this page's
  unconfirmed writes), never raw `S.scores`, so a lagging snapshot (admin
  reviewing as a member) can't show or compare against an older value; a
  failed note stays on screen and retries, a failed score reverts.
  `sim/score-stress.mjs` (`npm run stress`) found 3–5; run it after any change here.
  Screening priority ratings are still 1–5 buttons; only interview scores changed.
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
