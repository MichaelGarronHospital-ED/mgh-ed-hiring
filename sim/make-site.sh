#!/bin/bash
# Rebuild the test copy of the tool from the repo, with the doubles the
# CLAUDE.md recipe calls for: blank firebaseConfig (→ LocalStore), the three
# local-mode passwords (adminpw, staffpw, guestpw in LOCAL_CODES) and sample
# interview questions in LocalStore's empty state.
#
#   bash make-site.sh              → sim/site/          (LocalStore, no Firebase at all)
#   bash make-site.sh --emulator   → sim/site-emulator/ (the REAL Firestore and Auth code,
#                                    pointed at the local emulators; see emulator.mjs)
#
# The emulator copy is made by patching the COPY only: config.js gets the test
# project id and app.js's loadFirestore() gets connectFirestoreEmulator and
# connectAuthEmulator right after getFirestore/getAuth. The repo's own files never
# mention an emulator, so the live page can never talk to one, and this script
# fails if a patch target is missing, so a refactor can't silently turn the
# harness into a run against the live project.
set -e
MODE="${1:-}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$MODE" = "--emulator" ]; then DST="$(dirname "$0")/site-emulator"; else DST="$(dirname "$0")/site"; fi
rm -rf "$DST"; mkdir -p "$DST"
cp -r "$SRC"/index.html "$SRC"/book.html "$SRC"/version.json "$SRC"/css "$SRC"/js "$SRC"/icons "$DST"/

python3 - "$DST/js/config.js" "$MODE" <<'PY'
import re, sys
p, mode = sys.argv[1], sys.argv[2]
s = open(p).read()
if mode == "--emulator":
    cfg = 'export const firebaseConfig = { apiKey: "fake-api-key", authDomain: "127.0.0.1", projectId: "mgh-ed-hiring-test-emu", appId: "emu" };'
else:
    cfg = 'export const firebaseConfig = {};'
s2 = re.sub(r'export const firebaseConfig = \{.*?\n\};', cfg, s, flags=re.S)
if s2 == s: sys.exit("make-site: firebaseConfig not found in config.js")
old = 'export const LOCAL_CODES = { admin: "", committee: "", candidate: "" };'
if s2.count(old) != 1: sys.exit("make-site: LOCAL_CODES not found in config.js")
s2 = s2.replace(old, 'export const LOCAL_CODES = { admin: "adminpw", committee: "staffpw", candidate: "guestpw" };')
if mode == "--emulator":
    # Motion Voting's accounts live in the same local Auth emulator, under a test project id
    old = 'projectId: "ed-motion-voting-99b96",'
    if s2.count(old) != 1: sys.exit("make-site: voting projectId not found in config.js")
    s2 = s2.replace(old, 'projectId: "ed-motion-voting-test",').replace('apiKey: "AIzaSyD1IvlP16tceVfwMUHEvrMrxKf5BVZIok0"', 'apiKey: "fake-voting-key"')
open(p, 'w').write(s2)
PY

# Sample interview questions in LocalStore's empty state (the emulator cases seed
# their own questions document).
python3 - "$DST/js/store.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  questions: null, schedule: null, passwordsMeta: null,\n"
if s.count(old) != 1: sys.exit("make-site: EMPTY questions not found in store.js")
s = s.replace(old, '  questions: { version: 1, questions: [{ id: "0", text: "Tell us about yourself" }, { id: "1", text: "A difficult case" }, '
  '{ id: "2", text: "Why this ED?" }], scale: ["1 no", "2 weak", "3 ok", "4 good", "5 excellent"], guide: ["Give everyone the same questions"] },\n'
  '  schedule: null, passwordsMeta: null,\n')
open(p, "w").write(s)
PY

if [ "$MODE" = "--emulator" ]; then
python3 - "$DST/js/app.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
pairs = [
  ('  const auth = au.getAuth(app);\n', '  const auth = au.getAuth(app);\n  au.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });\n'),
  ('  const db = f.getFirestore(app);\n', '  const db = f.getFirestore(app);\n  f.connectFirestoreEmulator(db, "127.0.0.1", 8080);\n'),
  # the emulator cases reach the store directly, to make the writes an older
  # page (one without today's client-side guards) would make
  ('    store = new FirestoreStore(fb, { scopes, echo });\n', '    store = new FirestoreStore(fb, { scopes, echo });\n    window.__edStore = store;\n'),
  # the Passwords card's helper apps (H3) talk to the same local Auth emulator
  ('{ mainAuth: fb.auth, configs: { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig } });\n',
   '{ mainAuth: fb.auth, configs: { hiring: firebaseConfig, voting: PARTNERS.voting.firebaseConfig },\n'
   '      connect: (a) => fb.authFns.connectAuthEmulator(a, "http://127.0.0.1:9099", { disableWarnings: true }) });\n'),
]
for old, new in pairs:
    if s.count(old) != 1: sys.exit("make-site --emulator: patch target not found in app.js: " + old.strip())
    s = s.replace(old, new)
open(p, 'w').write(s)
PY
fi

# Both copies: let the round-close tests shorten the lease timings and reach the
# flow's controller (test hooks). Copy only; the repo's own files never do this.
python3 - "$DST/js/rounds.js" "$DST/js/app.js" <<'PY'
import sys
r, a = sys.argv[1], sys.argv[2]
s = open(r).read()
old = "  keptMax: 200, chunk: 450, partBytes: 900000, keptHistoryBytes: 400000 };\n"
if s.count(old) != 1: sys.exit("make-site: TIMING not found in rounds.js")
s = s.replace(old, old + "Object.assign(TIMING, globalThis.__edRoundsTiming || {});\n")
open(r, "w").write(s)
s = open(a).read()
old = "  onActive: (on) => { ui.closing = on; },\n});\n"
if s.count(old) != 1: sys.exit("make-site: createRounds call not found in app.js")
s = s.replace(old, old + "window.__edRounds = rounds;\n")
open(a, "w").write(s)
PY

echo "site rebuilt at $DST"
