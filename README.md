# ED Physician Hiring — Interviews Tool

A five-stage hiring tool: **Screen → Availability → Panels → Score → Ranking**.
Static frontend (no build step). Runs in **local mode** out of the box; add a
Firebase project to go multi-device and real-time.

- **Committee:** [`index.html`](index.html): enter the ED password, pick your name.
- **Applicants:** `index.html#apply` (old [`book.html`](book.html) links forward there):
  the Guest password, then your name and your times.

The clickable prototype Kyle reviewed (`mock.html`) was **deleted on Sept 21 2026**,
once the real tool had superseded it. The encrypted question file `js/data.js` followed in
release R8 (Oct 2026): the questions live in the database, and no file in the repo is
derived from a password.

Design + decisions live in [`DESIGN.md`](DESIGN.md); the paneling algorithm is in
[`js/panels.js`](js/panels.js) (validated in a Python prototype before porting).

## Where it lives

| | |
|---|---|
| Committee | https://michaelgarronhospital-ed.github.io/mgh-ed-hiring/ |
| Applicants | https://michaelgarronhospital-ed.github.io/mgh-ed-hiring/book.html |
| Repo | https://github.com/MichaelGarronHospital-ED/mgh-ed-hiring |
| Owner | Alvin Yang |
| Firebase project | `mgh-ed-hiring` (config in [`js/config.js`](js/config.js), public by design) |

- **Deploys:** GitHub Pages, from `main`, root folder, no build step. A push to
  `main` is live about a minute later.
- **Secrets:** none in the repo and none in GitHub Actions. The ED, Admin and
  Guest passwords are shared by word of mouth and are only the passwords of Firebase
  accounts (see "Passwords" below). No file in the repo is derived from them. The one
  deliberate exception is outside any repo: the ED tools passwords page keeps the three
  passwords encrypted (with a key made from the Admin password) in the separate
  Firebase project `mgh-ed-admin`.
- **Old address:** this tool used to live at
  `https://dralvinyang.github.io/ED-motion-voting/tools/interviews/`. That old
  repo now only redirects here, keeping the path, query string and #hash, so
  links already sent to applicants and the committee still work. The voting tool
  that shared that repo is now `mgh-ed-motion-voting`.

## Passwords: the ED tools' three shared passwords

Since Oct 14 2026 every ED tool uses the same three passwords (shared out of band,
never written in this repo):

- **ED password** (ED physicians / the committee): Screen, Availability, Score.
- **Admin password**: adds Panels, Ranking, Offers and Setup. It is independent of
  the ED password, so knowing the ED password does not give anyone Admin access.
- **Guest password** (applicants): goes straight to the applicant's own scheduling and
  sees no committee data.

Until R10 (Oct 2026) the Admin password was called the Leadership password. Only the name
changed: same password, same accounts and emails, nobody signed out.

Each password is only the password of Firebase accounts: in Physician Hiring
`committee@` (ED), `admin@` (Admin) and `applicant@ed-hiring.app` (Guest); in
Motion Voting `ed@` and `leadership@ed-motion-voting.app`. The Patient Hub statistics
page checks the Admin password against `admin@ed-hiring.app`. **The sign-in page
finds your role by which account accepts the password** (ED first, then Guest, then
Admin; the role that last worked on this browser first; Guest first on an
applicant link). The password itself is never saved: a reload in the same tab resumes
from Firebase's own sign-in for that tab. Since release R7 nothing in the repo is
derived from a password, so changing one needs no code change (the old encrypted
`js/data.js`, and the "Re-keying" it needed, are gone since R8).

**A role is known by its account's uid, never by its email (R7c).** The rules and every page
check the account's uid; the emails are only for signing in. That let the account emails
move to addresses nobody can ever register (`admin@mgh-ed-hiring.invalid` and so on, Phase A
of the passwords design; the pages sign in with them since R8b, the R7d cleanup) without signing anyone in as the wrong role, and an account somebody
makes with a freed email gets another uid and nothing else.

| Role | uid | Email before the move | Email now (R8b) |
|---|---|---|---|
| Admin | `ULgtfRrkAVPS2aT69Tc4CjMqbsx1` | `admin@ed-hiring.app` | `admin@mgh-ed-hiring.invalid` |
| ED | `36FXvbR8ExgU7p4cmwuCNfkgFgD2` | `committee@ed-hiring.app` | `committee@mgh-ed-hiring.invalid` |
| Guest | `jvmQYhgYlRMf3f2J3uw8XXos8yD3` | `applicant@ed-hiring.app` | `applicant@mgh-ed-hiring.invalid` |

**Never delete a role account.** A new one has a new uid, which the rules and the pages refuse
until both are updated (`firestore.rules` and `AUTH.uids` in `js/config.js`;
`tests/uids.test.mjs` keeps them equal). Uids are public identifiers, not secrets.

**To see or change one: the ED tools passwords page**,
https://michaelgarronhospital-ed.github.io/passwords.html (the gear on the ED tools front page).
Since R9 it lives in the ED dashboard repo, not here: sign in with the Admin password, and
each of the three passwords has Show, Copy and Change; Change asks only for the new password
twice and changes it in Physician Hiring and Motion Voting together (the Patient Hub statistics
page follows the Admin password). How it works, and its honest limits, are in the
dashboard repo's README. Then tell people in person or by phone; never email a password.
- This tool's old page, `passwords.html`, is now only a redirect there ("The passwords page has
  moved. Open it."), so old links and bookmarks keep working; `js/pwpage.js` sends a cached
  older copy of that page there too. The address is `PASSWORDS_PAGE` in `js/config.js`.
- Setup, "Passwords for all ED tools", only says where the passwords are and links there. If a
  change started on the old page (R7 to R8) never finished, the card also says "An older
  password change started here didn't finish. Open the passwords page; it finds which tools
  still have the old password." (It reads `interviews_meta/passwords`, which holds only dates
  and which accounts were done, never a password; that document stays in backups and restore.)
  Once the new passwords page shows every tool agrees, a leftover `pending` field in
  `interviews_meta/passwords` can be removed in the Firebase console (project `mgh-ed-hiring`,
  Firestore): it only drives that "didn't finish" line.
- Everyone signed in with an old ED or Admin password is asked for the new one within
  about an hour, phones on Motion Voting included: don't change one on a voting day. Applicants
  with the old Guest password can't sign in until they get the new one.
- `js/passwords.js` (the old page's rules of a change), `store.updatePasswords` and
  `tests/passwords.test.mjs`, unused from R9, were deleted in R10.
- `set-passwords.py` in the `MGH-ED-Tools` folder stays as a break-glass tool for someone
  with the Firebase CLI; the normal way is the passwords page.
- `scripts/diagnose-login.mjs` says which account accepts a given password (read-only).

**Honest limit.** Anyone holding the ED password can change the ED accounts' password
with Firebase's public API (this was always true), which would lock everyone else out of
the ED role; the same holds for the Guest password, which applicants hold. On the free
plan there is no server code to stop it. The real fix is per-person accounts (DESIGN.md).

### If a password stops working and nobody knows the new one

No terminal needed:
1. Whoever can open the department mailbox (MGHEmergencyDepartmentAdministration@tehn.ca)
   signs in at console.firebase.google.com with that Google account.
2. Physician Hiring: open project `mgh-ed-hiring`, then Build, Authentication, Users.
   Motion Voting: project `ed-motion-voting-99b96`, same place.
3. Find the account (`committee@` for ED, `applicant@` for Guest, `admin@` for Admin;
   `ed@` and `leadership@` in Motion Voting; the uids are in the table above). **Do NOT
   delete it and add it again**: the new account would get a new uid, which the rules and
   pages refuse. The console cannot type a new password into an existing account, and
   "Reset password" sends an email these made-up addresses never receive, so the password is
   set by the break-glass script instead: on a Mac with the Firebase CLI signed in as the
   department account, `python3 set-passwords.py` in the `MGH-ED-Tools` folder (its own
   instructions), which changes the password of the same account (same uid).
4. Then open the ED tools passwords page (the gear on the ED tools front page) and sign in as
   Admin. If a tool no longer accepts the password the page has saved, it says which one
   and asks for the one in use, so every tool ends up the same.

## Run it now (local mode)
With `firebaseConfig` left empty in [`js/config.js`](js/config.js), the page uses
`localStorage` + `BroadcastChannel`: fully working on **one machine / browser** (for a demo
or click-through). Its three passwords are `LOCAL_CODES` in `js/config.js`, blank in the
repo on purpose; `sim/make-site.sh` builds such a copy in `sim/site/` with test passwords
and sample questions. Data does **not** sync across devices in this mode.

## Go live (multi-device, real-time)
1. **Create a Firebase project** — a *separate* one from Motion Voting (this holds
   applicant data). Build → Firestore Database → Create (production mode).
2. Authentication → **Get started** → enable **Email/Password** and add the three role
   accounts (see "Real access control" below). The app signs in with the password the
   person types; there is no anonymous sign-in.
3. Firestore → **Rules** → paste [`firestore.rules`](firestore.rules) → Publish.
4. Project settings → Your apps → Web → copy the config → paste into
   `firebaseConfig` in [`js/config.js`](js/config.js).
5. Deploy, then open `index.html` as **Admin** (the Admin password) → the **Setup** tab, and
   set the real **committee** (names + each member's self-identified gender, used only
   to build balanced panels), **chair**, **interview times**, and the **OneDrive**
   applications-folder link. These save to your Firestore — they never go in the repo.
   (`ORG_NAME` branding is the only thing still set in [`js/config.js`](js/config.js);
   the roster placeholders there are just fallbacks until you run Setup.)
6. Committee → `index.html`; applicants → `book.html`.

## Interview times
Availability tab → **Interview times** (Admin; in Setup until R11). Add one time, or a block that's split into
back-to-back interviews (e.g. Oct 7, 9:00–12:00, 1-hour → three times). Each time can be
edited or removed, or a whole day at once; changes show on everyone's screen live.
- Every time has a permanent id (`js/slots.js`); availability and manual panels are
  keyed by it, so adding/editing/removing one time never shifts answers onto another.
- Editing a time people already answered asks: **Keep answers** (typo fix — answers
  and any booked panel move with it) or **Ask again** (real change — old answers are
  discarded and those people show as "waiting on" again). Removing a time discards its
  answers and any manual panel there; affected candidates are re-planned.
- Duplicates are blocked; overlaps and past dates ask for confirmation. Edits run in a
  Firestore transaction, so two admins editing at once don't overwrite each other.
- The `SLOTS` in `js/config.js` are only the starting defaults, used until the first
  edit. After that the saved list is authoritative, even if it's empty.

## One link, three audiences
The same `index.html` serves everyone; what you can do depends on the password you type:
- **ED physician / committee**: the ED password → Screen · Availability · Score.
- **Admin**: the (independent) Admin password → logged in as "Admin" with no name to
  pick: the collation, both availability grids, Panels · Ranking · Setup. An admin who
  also reviews taps **review as a member** in the header to pick their name, which
  adds their own screening, availability and the Score tab.
- **Applicant**: the **Guest password** → taken straight to their own
  scheduling (enter last name, pick times). They never see the roster, questions,
  scores, or other applicants. (`book.html` now just forwards here.)

## Real access control (the "roles" security model)
The live tool runs the "roles" model: each of the three passwords is the password of one Firebase account, and
the Firestore rules decide what each account may do, on the server. (The old
`"anon"` mode, where every visitor signed in anonymously, no longer works since R7:
it found the role by decrypting the old `js/data.js`, deleted in R8.) Setting the roles model up
from scratch takes these console steps (they can't be done from the repo):

1. **Firebase console → Authentication → Sign-in method →** enable **Email/Password**.
2. **Authentication → Users → Add user** three times (emails must match
   `AUTH` in `js/config.js`; the **passwords are the shared secrets** you hand out). These
   three exist; this step is only for a brand-new project. Their uids then go into
   `firestore.rules` and `AUTH.uids` (the rules know each role by uid):

   | Email | Password | Who |
   |---|---|---|
   | `committee@ed-hiring.app` | the **ED password** | ED physicians / reviewers |
   | `admin@ed-hiring.app` | the **Admin password** (independent of the ED one) | leadership |
   | `applicant@ed-hiring.app` | the **Guest password** | candidates |

   > The Admin password is independent of the ED password, so a reviewer who
   > knows the ED password **cannot** sign in as admin: the reviewer/admin (ranking)
   > wall holds. The three must all be different (the sign-in page tells the roles
   > apart by which account accepts the password).

   > **What one reviewer can see of another.** All reviewers share the single
   > `committee@…` account, so the rules cannot tell them apart. Scores are
   > therefore unreadable to the whole committee — that is what keeps the ranking
   > private. **Screening is deliberately looser**: a reviewer may fetch a
   > screening document *by exact id*, which is what lets their own flags and
   > ratings follow them to a new device, so a reviewer who opened the browser
   > console could also fetch a colleague's. Bulk listing stays admin-only, and
   > the app itself never requests anyone else's. The same shared account already
   > means a reviewer could *submit* screening as someone else. Closing both
   > properly means per-member accounts: thirteen users instead of three, rules
   > keyed on `request.auth.token.email`, and the name-pick screen replaced by a
   > real sign-in.

3. **Firestore → Rules →** paste [`firestore.rules`](firestore.rules) → **Publish**.
4. Check that the emails in `AUTH` in [`js/config.js`](js/config.js) match the three accounts.
5. Sign in as **admin** once — the app publishes the PII-free list of interview times
   to `/interviews_public/slots` (and again on every edit of the interview times on the Availability tab),
   so applicants can read *only* that.

What this enforces (server-side, not just UI):
- Applicants can read **only** the interview slots and write **only** their own
  availability. They **cannot** read the roster, questions, screening, or scores.
- Reviewers can submit screening/scores/availability and read the roster +
  availability, but **cannot read anyone's scores** or list the screening, so the
  **ranking is admin-only for real**, not just hidden in the UI.
- The ED password (every ED physician has it) can **save but never delete**: no
  document in any collection, and it **cannot change the applicant list**. Adding,
  removing and deleting are Admin's.
- Applicant availability can only hold `slots` (time id → in person / virtual / either; virtual is stored as `zoom`),
  at most 200 times.
- A sign-in lasts for that browser tab only. **Log out** signs out of Firebase too.
- **Rules v2 (Oct 2026).** When Admin closes a stage (screening, availability or
  scoring), the ED password can no longer change that stage's answers, on the server,
  not just on screen; applicants can still confirm or withdraw after availability
  closes. While a round is being closed, ED and Guest writes are paused. The change
  history, the applicants' confirmed times and the saved copies of closed rounds are
  three new collections; only Admin can read them (an applicant can fetch only
  their own confirmed time). Admin is always checked first in every rule, so
  these gates cost nothing on Admin saves and one extra read on ED and Guest
  saves. Everything reads "not set" as open, so data from before v2 behaves as before.

Honest limits (see the header of `firestore.rules`): reviewers share one committee
account, so per-**member** write-isolation isn't rule-enforceable (needs per-member
accounts or custom claims). So a reviewer cannot delete anything, but could still
overwrite a colleague's screening or score. And an applicant could overwrite another's
availability by typing their last name. The same shared Guest account means an applicant
who types another applicant's surname could see that person's confirmed interview time,
or confirm or withdraw for them; every reply shows to Admin with its date, and a
withdrawal never removes anyone by itself. All of these are low-impact and documented.

### Publishing the rules from the command line

`firebase.json` and `.firebaserc` point the Firebase CLI at this project
(`mgh-ed-hiring`) and at `firestore.rules`, so the console paste above can be replaced by:

```bash
npx firebase-tools login                    # once, as the department Google account
node scripts/sync-allowed.mjs --apply       # first, as above
npx firebase-tools deploy --only firestore:rules
```

`--only firestore:rules` publishes the rules and nothing else (no hosting, no data).
The tests in `tests/` keep their own emulator-only `firebase.json` and are unaffected.

**Every published rules version gets a git tag**, so a rollback is one command:
`rules-v1-2026-10-16` (before stages and rounds) and `rules-v2-<date>` (tag it on the
commit you published, the day you publish). To go back: `git show <tag>:firestore.rules
> firestore.rules`, then deploy as above. **Roll back the page first, then the rules, and
never the rules alone while a page from Oct 2026 release R1 or later is live**: those
pages write a change-history entry with every Admin save, and the v1 rules refuse
it, so every Admin save would fail.

## Backups and the change history (Oct 2026)

- **Download a backup before every release of the tool and before any big change.**
  Ranking tab, "Back up this hiring cycle", or Setup, Back up: **Download backup file (for
  restoring)** saves the whole working round as one JSON file, read fresh from the database
  (never from what the page happens to hold). It includes the interview questions, the input
  of people who have left or were taken off the list, the applicants' replies and the change
  history. A later release can load it back in. **Download Excel** is the same read, for
  people to look at. With no connection neither is made (R15): the page says "Backup not made:
  you seem to be offline. Connect and try again." and nothing downloads. Both have applicant names and the committee's comments: save them with
  the CVs on OneDrive and don't email them.
- **Setup, Change history** lists every change made with the Admin password, newest
  first, 50 at a time. It never stores an applicant's name (names are filled in when it is
  shown). Hand-made panel changes can be undone there (and for 10 seconds from the message
  after "Reset hand-made panels"); undo is refused if the panel changed since.
- **Setup, Committee and screeners** has one row per person: name, "Interviews and screens"
  or "Screens only", F or M (interviewers only; self-identified, used only to balance panels),
  "Active" or "Left the committee", and an optional work email. Renaming someone keeps all
  their input. Someone who left keeps their input, and it still counts, but they leave every
  list of people. A row can be removed outright only if that person saved nothing. "Add
  people" takes one per line: "Name, F" or "Name, M" for interviewers, just the name for
  screeners.
- **The Questions tab** (Admin; in Setup until R11) edits the questions, the rating scale and the guidance.
  Once anyone has scored, questions can't be added, removed or reordered (only the wording
  fixed), because notes are filed under each question.
- **Round stages (Setup).** Close screening, availability and scoring as each deadline
  passes. A closed stage can't be changed with the ED password; the server refuses it, and
  the page greys the buttons out ("Screening is closed. Your answers are saved."). Closing
  screening saves the interview list as it is then. Closing availability tells applicants
  booking is closed (they can still confirm or withdraw). Any stage can be reopened.
  Revealing the ranking offers to close scoring in the same step.
- **Deadlines (Setup)** sets the screening countdown everyone sees (no code edit), and the
  availability and reply dates used in reminders.
- **Screening rule (Setup)**: how many concerns take an applicant off the interview list
  automatically (0 = decide each one yourself). On the Screen tab each applicant has
  "Interview list: Auto / On / Off"; your On or Off always wins. Reviewers can raise a
  **concern** (counts) or leave a **note** (never counts, with "I know this applicant
  personally"); "Make this a note" moves a concern's words into a note.
- **Rename, merge, delete (Screen tab, More).** Rename keeps everything attached (and moves
  the applicant's interview times if the surname changes). Merge fixes a remove-and-add-again
  mix-up, with a preview of exactly what moves and an offer to download a backup first.
  Delete permanently works only on an entry already removed, after typing their last name.
  No terminal needed; `scripts/` stays as a fallback.
- **Applicants who share a surname.** The applicant page asks for first and last name. When a
  second applicant with an existing surname is added, both get their own answers (the page
  says so); applicants with a unique surname see no difference. If answers were already saved
  under the shared surname, Panels, Needs attention asks whose they are.
- **Two rooms and day chairs (Availability tab, Interview times).** Each time can be "1 room" or "2 rooms"
  (two interviews at once, two separate panels). Each day can have its own chair ("Chair this
  day"), or none; a day with two-room times also picks who leads room 2.
- **Your interviews (Score tab).** Nobody is pre-selected. Once the schedule is locked, a reviewer
  sees only the applicants on their own panels, with "Show all applicants" to widen.
- **Messages and calendar files (Panels).** For each panel: Email (to the applicant, to the
  panel) and Calendar (.ics for the panel, for the applicant); in the tab's More menu, "Calendar
  file for all interviews" and "Copy all applicant emails". Setup, Interview details holds the
  location, virtual meeting link and contact used in them. Availability: "Email who we're waiting on"
  opens your mail app with the interviewers' work emails (from Setup) in Bcc; for applicants it
  copies a reminder (applicant emails are never stored). Nothing is sent by the tool itself.
- **Applicants see their confirmed time (Panels, Send times to applicants, once locked).** An
  applicant then sees their time when they sign in, and can confirm ("I'll be there") or
  withdraw ("I can't come", with Undo). Admin sees "Withdrew" on the panel row (and in Needs
  attention), and "No reply yet" only after the reply date. Applicant links now end in `#apply`.
- **Lock the schedule (Panels)** freezes every panel; later availability changes don't move
  an interview, and Needs attention names anyone no longer free or no longer on the
  committee. You can still edit a locked panel, and unlock.
- **Close the round (Setup, This round).** Saves a copy of the whole round (checked after it is
  saved), asks you to download the backup file and type the round name, then clears the working
  round so the committee and applicants see an empty tool. Kept for next round: the committee, the
  interview questions and your settings. While it runs, ED and applicant pages are paused and other
  Admin pages are read-only. If the closing page stops part way (closed laptop, lost
  connection), any Admin page can "Finish closing" or "Stop closing" after 5 minutes;
  stopping after clearing began puts everything back. Anything someone changed after the copy is
  never deleted: it is kept and listed in This round for you to keep or delete.
- **Past rounds (Setup)** lists closed rounds: download the backup file or Excel again, print a
  summary, "Bring back" (only into an empty working round), or "Delete permanently" once the
  keep-until date has passed (type the round name). **Keep closed rounds for** sets that date
  (1 to 7 years, or until deleted by hand); nothing is ever deleted automatically, and the server
  refuses to delete a closed round earlier than 30 days after closing.
- **Restore from a backup file (Setup)** shows exactly what would be added (per kind of item: in
  the file, here now, will be added, same, different) before anything is written. "Bring back
  missing items only" never changes or deletes anything and works only for a file from the round
  you are working on; "Replace the working round" only into an empty round.
- **Interview questions live in the database** (`interviews_meta/questions`). Releases R1 to
  R6 copied them out of the old locked `js/data.js` at the first Admin sign-in (Change
  history: "Copied the interview questions"); since R7 the database is the only copy (the file
  was deleted in R8), and every backup file carries it. Notes stay attached to their question.
- **Log out** (top right of every signed-in screen) first saves anything still pausing and waits
  up to 5 seconds for unsaved changes, reading "Logging out…" meanwhile. If some are still
  unsaved it asks ("Log out?", Stay or Log out anyway, Stay focused) before throwing any away, then clears this
  browser's copy of your scores. The sign-in screen then says "You are logged out." (R14)
- **With no connection** (R13), a change waits in the open page and saves when the connection is
  back. After 10 seconds the page says "Not saved yet. Waiting for the connection. Keep this page
  open and it will save." until it does; closing the page before then loses it, so while a change
  is waiting the browser asks "Leave page?" first (R15; never on the page's own reloads). Admin settings
  saves are not held: with no connection they fail after a few seconds and say so. An
  applicant's name check gives up after 20 seconds with "Couldn't reach the server".
- **When a new version goes live**, an open page notices within 10 minutes and shows "This
  page was updated. Reload to get the latest version." An Admin page reloads itself
  instead, but only when nothing typed could be lost.
- **Known gaps while a page from before Oct 2026 is still open** (it never shows that line,
  so reload every open tab on release day). Low risk, but known:
  - An old page saving the committee from its text box drops each person's id, role, status
    and email. Anyone added with the new editor (an id like `m-...`) would then lose the link
    to what they entered until it is put back from the JSON backup; people from before keep
    theirs (their id is their name).
  - An old page editing interview times drops "2 rooms".
  - An old page counts concerns with a fixed threshold of 2 and ignores Admin's On or
    Off decisions.
  - An old page saving during a closed stage gets "Couldn't save. Check your connection"
    (the server refuses it).

## After the interviews: offers and the backup

On the **Ranking** tab (admin):

- **Offers**: for each candidate choose Not offered / Offered / Accepted / Declined;
  the dates fill in themselves and can be changed; add a note. Only the admin
  account can see or change offers (`interviews_offers` in `firestore.rules`).
- **Back up this hiring cycle**: *Download Excel* saves everything in the round
  (candidates, screening, availability, panels, scores, ranking, offers) as one
  workbook; *Print or save as PDF* prints a summary. Save the Excel file with the
  CVs on OneDrive after each cycle: the site is the working copy, not the record.

## Security notes
- The **questions/scale/guidance** live in Firestore; the rules let only the ED and Admin
  accounts read them (never applicants), and they are not in the page source.
- Applicant **names/CVs** never live in the repo — names in Firestore/local, CVs in
  access-controlled OneDrive (the app only links out).
