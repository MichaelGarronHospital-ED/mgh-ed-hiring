#!/bin/bash
# Rebuild the test copy of the tool from the repo, with the two doubles the
# CLAUDE.md recipe calls for: blank firebaseConfig (→ LocalStore) and a stub
# decryptContent (so the gate opens without the real code).
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="$(dirname "$0")/site"
rm -rf "$DST"; mkdir -p "$DST"
cp -r "$SRC"/index.html "$SRC"/book.html "$SRC"/css "$SRC"/js "$DST"/

# config: same roster/times/chair as the real thing, but no Firebase.
python3 - "$DST/js/config.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'export const firebaseConfig = \{.*?\n\};', 'export const firebaseConfig = {};', s, flags=re.S)
open(p, 'w').write(s)
PY

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
