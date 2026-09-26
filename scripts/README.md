# Maintenance scripts

One-off admin tooling for the interviews tool. **Not part of the deployed site**
— GitHub Pages serves `tools/interviews/`, and nothing here is loaded by
`index.html`. These are run by hand from a terminal.

```bash
cd tools/interviews/scripts
npm install
read -rsp "Admin password: " ED_IV_ADMIN_PASSWORD; echo; export ED_IV_ADMIN_PASSWORD
```

`read -rsp` keeps the password out of your shell history and out of `ps`. It is
the password for `admin@ed-hiring.app` from the Firebase console — the same
admin code typed into the app. Admin is required to *read* `interviews_scores`
and `interviews_screening` at all, so the committee code will not work here.

**Every script that writes is a dry run by default.** None of them writes
anything until you add `--apply`, and each prints exactly what it would do
first. Firestore has no per-document history, so there is no undo: read the dry
run before applying.

| Script | What it does |
| --- | --- |
| `report-data.mjs` | Read-only inventory of everything stored, grouped by candidate. **Start here.** `--issues` lists only what needs attention. |
| `diagnose-login.mjs` | Read-only. Why won't a code sign in? Tests the two independent halves — does it decrypt the questions (staff vs admin), and does Firebase accept it as that account's password — and names the fault. `ED_IV_CODE='…' node diagnose-login.mjs`; `--offline` skips the network half. Never prints the code. |
| `rename-candidate.mjs` | Fix a candidate's name **in place**. The right way to correct a spelling. |
| `migrate-candidate.mjs` | Move reviewer input from one roster entry onto another. For cleaning up after a remove-and-re-add. |
| `purge-candidate.mjs` | Permanently delete a roster entry. Refuses if anything still references it. |
| `sync-allowed.mjs` | Publish the roster's surnames to the list the security rules check on applicant writes. |
| `allowed-list.mjs` | Shared helper, not run directly: the one definition of that list, so a rename or purge can't leave the gate out of step. |

## Fixing a misspelled name

**Use `rename-candidate.mjs`. Do not remove and re-add the candidate in the app.**

Screening, scores and notes are keyed to the candidate's document id, not their
name. The app's "remove" is a soft delete and "add" mints a fresh `c-<uuid>`, so
removing and re-adding leaves every rating attached to the old id and invisible
in the UI — with the old entry still on the Screen tab, marked removed. That is
exactly what happened to one applicant this round.

```bash
node rename-candidate.mjs --who "Dr Jane Doe" --to "Dr Jane Roe"          # dry run
node rename-candidate.mjs --who "Dr Jane Doe" --to "Dr Jane Roe" --apply
```

The document id never changes, so nothing needs migrating. The one thing keyed
by name is applicant availability (`interviews_availCand` is keyed by normalized
surname), which the script moves when the surname changes. It refuses if the new
surname collides with another candidate's, because they would then share one
availability document.

### If someone already did the remove-and-re-add

```bash
node migrate-candidate.mjs --from "Old Name" --to "New Name"          # dry run
node migrate-candidate.mjs --from "Old Name" --to "New Name" --apply
node purge-candidate.mjs   --name "Old Name" --apply                  # once it's empty
```

`migrate-candidate.mjs` writes each copy before deleting its source, so a
failure mid-run leaves a duplicate rather than losing a rating. Where a reviewer
has input on **both** entries it skips and reports, rather than picking a winner.

## The applicant surname gate

`firestore.rules` refuses an applicant's availability write unless their surname
is in `/interviews_meta/allowed`. Without it, a typo or a name we hold
differently saved to a document nobody reads: the applicant saw "Saved" and was
never scheduled.

`rename-candidate.mjs` and `purge-candidate.mjs` update the list themselves, and
the admin session keeps it in sync too (`syncAllowedNames` in `js/app.js`), so in
normal operation there is nothing to run. `sync-allowed.mjs`
is for the initial publish and for checking:

```bash
node sync-allowed.mjs            # dry run: what would change
node sync-allowed.mjs --apply    # publish
node sync-allowed.mjs --check    # exits non-zero if the list has drifted
```

**The rule is fail-closed, so rollout order matters:**

1. `node sync-allowed.mjs --apply` — an admin write the *current* rules already allow
2. publish the new `firestore.rules`
3. deploy the app

Publishing the rules before step 1 locks every applicant out until you catch up.

`sync-allowed.mjs` and `report-data.mjs --issues` both flag **duplicate
surnames**, which the allowed list cannot express: two applicants with the same
surname share one availability document and the second to submit overwrites the
first.

## Testing against the emulator

Every script takes `ED_IV_EMULATOR=127.0.0.1:8080`, which points it at a local
Firestore emulator and skips the sign-in, so you can rehearse on throwaway data.
`seed-migration.mjs` writes a fixture reproducing the remove-and-re-add mess:

```bash
npx firebase-tools emulators:start --only firestore --project mgh-ed-hiring &
ED_IV_EMULATOR=127.0.0.1:8080 node seed-migration.mjs
ED_IV_EMULATOR=127.0.0.1:8080 node migrate-candidate.mjs --from "Rosalind Ashcombe" --to "Rosalind Ashcomb"
ED_IV_EMULATOR=127.0.0.1:8080 node seed-migration.mjs dump
```

## Log files

These scripts print real candidate names and ratings. Redirecting that to a file
(`| tee something.log`) puts applicant data in the working tree — `*.log` is in
`.gitignore` so it cannot be committed, but delete it when you're done.
