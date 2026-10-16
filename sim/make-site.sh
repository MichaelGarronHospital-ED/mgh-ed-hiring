#!/bin/bash
# Rebuild the test copy of the tool from the repo, with the two doubles the
# CLAUDE.md recipe calls for: blank firebaseConfig (→ LocalStore) and a stub
# decryptContent (so the gate opens without the real code).
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
open(p, 'w').write(s2)
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
]
for old, new in pairs:
    if s.count(old) != 1: sys.exit("make-site --emulator: patch target not found in app.js: " + old.strip())
    s = s.replace(old, new)
open(p, 'w').write(s)
PY
fi

cat > "$DST/js/data.js" <<'JS'
// TEST DOUBLE — no crypto, no real codes.
export async function decryptContent(code) {
  const q = ["Tell us about yourself", "A difficult case", "Why this ED?"];
  const s = ["1 no", "2 weak", "3 ok", "4 good", "5 excellent"];
  const g = ["Give everyone the same questions"];
  if (code === "adminpw") return { q, s, g, isAdmin: true };
  if (code === "staffpw") return { q, s, g, isAdmin: false };
  throw new Error("bad");
}
JS
echo "site rebuilt at $DST"
