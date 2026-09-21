# Firestore security-rule tests

Tests for [`../firestore.rules`](../firestore.rules). They run against the local
Firestore **emulator** — no real Firebase project, no real data, no credentials,
nothing to clean up afterwards.

**The tool itself still has no build step and no dependencies.** Everything here
is dev-only and never shipped: `node_modules/` is gitignored, and GitHub Pages
serves the static files regardless of what lives in this folder.

## Run it

Needs Node 18+ (for the built-in `node --test` runner) and Java, which the
Firestore emulator requires.

```bash
cd tools/interviews/tests
npm install
npm test
```

`npm test` starts the emulator, runs the suite against it, and shuts it down.

**Last run: Sept 21 2026 — 30 tests, 30 pass.** On a bare Debian devcontainer the
toolchain is one line:

```bash
sudo apt-get install -y --no-install-recommends nodejs npm default-jre-headless
```

## What it asserts

Each group maps to a promise the tool makes to a real person:

| Group | Guarantee |
|---|---|
| The ranking stays private to the admin | Reviewers can submit scores but cannot read anyone's — including their own collection. This is the anti-bias guarantee in DESIGN.md. |
| Screening input stays private to the admin | Same shape for flags and reasons, so one concern can't anchor the committee. |
| An applicant cannot reach any committee data | No roster, no other applicants, no scores, no interviewer availability, no setup. |
| An applicant can do their own scheduling | Reads the PII-free time list, writes their own availability — and *cannot read it back*. |
| Only the admin can change setup | Roster, chair and times drive panel building; reviewers must not rewrite them. |
| Reviewers can do their own job | Guards against over-tightening: adding candidates and availability must keep working. |
| Accounts the rules do not know | Signed-out, Anonymous sign-in (no email in the token), and any other valid Firebase account all get nothing, including from collections the rules never mention. |

The role emails in the test file must match `AUTH` in [`../js/config.js`](../js/config.js)
and the constants in the rules. Renaming an account in one place and not the
other makes these fail — deliberately.

## The "KNOWN LIMITATIONS" group

That last group asserts things that are currently **true but not ideal**:

- One applicant can overwrite another's availability by typing their surname.
- Reviewers share one account, so the rules cannot tell reviewer A from B — one
  can overwrite another's score.

Both are documented under "Honest limits" in the rules file. They are pinned
here so a change is *deliberate*: if one of these tests ever fails, someone
implemented per-person identity. That's an improvement — update `DESIGN.md` and
delete the test rather than making it pass again.

## Scope

These test **the rules only** — the server-side guarantees. They say nothing
about the UI. A rule can be perfectly locked down while the app still shows the
wrong thing (the committee roster bug in Sept 2026 was exactly that: a pure
client-side fallback, invisible to any rules test). The manual click-through
still matters for anything a person sees.

## Why `firebase.json` has no rules path

`"firestore": {}` is deliberate. `firebase-tools` rejects any path that points
outside the config file's own directory — `"rules": "../firestore.rules"` fails
with *"../firestore.rules is outside of project directory"*.

It isn't needed. [`firestore.rules.test.mjs`](firestore.rules.test.mjs) reads
`../firestore.rules` itself and passes it to `initializeTestEnvironment`, which
loads it into the running emulator, replacing whatever it started with. So the
real rules file is still exactly what's under test — `firebase.json` only has to
get a Firestore emulator listening.

**The emulator will warn that it found no rules file and defaulted to allowing
everything.** That's expected, and it is not what the tests run against. If you
want proof rather than reassurance, break something in `../firestore.rules` —
change `isAdmin()` to `true` — and watch the suite fail.

That check has been done: with `isAdmin()` forced to `true`, **16 of the 30 fail**,
including every anti-bias guarantee (reviewers reading scores and screening,
applicants reading the roster). So the suite is testing the real file.

## Expected noise

- **"You are not currently authenticated"** — ignore it. These tests never touch
  a real project, so `firebase login` is not needed.
- **`npm audit` vulnerabilities** — they come from the `firebase-tools`
  dependency tree. This package never ships, never runs in a browser, and never
  handles untrusted input; `npm audit fix --force` is more likely to break the
  emulator than to help. Leave it.

## If the emulator won't start

- **"Cannot start the Firestore emulator without firestore config"** — you're not
  in this directory. `cd tools/interviews/tests` first.
- **Port 8080 in use** — change it in both `firebase.json` and the `port` in
  `firestore.rules.test.mjs`; they must match.
- **Java missing** — the Firestore emulator needs it. `java -version` to check,
  `brew install --cask temurin` to install.
- **Install fails on a pinned version** — the versions in `package.json` are a
  starting point, not a requirement. `npm install @firebase/rules-unit-testing@latest
  firebase@latest firebase-tools@latest --save-dev` is fine.
