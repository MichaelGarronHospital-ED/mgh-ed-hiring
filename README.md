# ED Physician Hiring — Interviews Tool

A five-stage hiring tool: **Screen → Availability → Panels → Score → Ranking**.
Static frontend (no build step). Runs in **local mode** out of the box; add a
Firebase project to go multi-device and real-time.

- **Committee:** [`index.html`](index.html) — enter the committee code, pick your name.
- **Applicants:** [`book.html`](book.html) — one link, type your name, pick your times.
- **Mock (design demo):** [`mock.html`](mock.html) — the clickable prototype Kyle reviewed.

Design + decisions live in [`DESIGN.md`](DESIGN.md); the paneling algorithm is in
[`js/panels.js`](js/panels.js) (validated in a Python prototype before porting).

## Access codes — three independent codes
There are **three codes**, none written in the source (they're shared out-of-band):

- **Staff code** (ED physicians / committee) — decrypts the interview questions and
  opens Screen · Availability · Score.
- **Admin code** (leadership) — a **separate, independent** code that also decrypts the
  questions and additionally opens Panels · Ranking · Setup. Because it's independent,
  a reviewer who knows the staff code **cannot** become admin.
- **Guest code** (applicants) — a different code that goes straight to the applicant's
  own scheduling; it decrypts nothing and sees no committee data.

The staff and admin codes each independently "unwrap" the question key (a random content
key wrapped under each — see "Re-keying" below), so both decrypt without either revealing
the other. Regular members never see the Ranking — it's admin-only and hidden until all
interviews are marked complete.

> **Security:** the staff/admin codes decrypt the confidential questions, so treat them
> like the questions themselves. Prefer codes that aren't trivially guessable (a short
> dictionary word can be brute-forced) — never a code that appears anywhere public.

## Run it now (local mode)
Open `index.html` over **https** (or `http://localhost`, not a `file://` path — the
question decryption needs a secure context). With `firebaseConfig` left empty in
[`js/config.js`](js/config.js), it uses `localStorage` + `BroadcastChannel`: fully
working on **one machine / browser** (great for demo and click-through), seeded with
sample candidates. Data does **not** sync across devices in this mode.

## Go live (multi-device, real-time)
1. **Create a Firebase project** — a *separate* one from Motion Voting (this holds
   applicant data). Build → Firestore Database → Create (production mode).
2. Firestore → **Rules** → paste [`firestore.rules`](firestore.rules) → Publish.
3. Authentication → **Get started** → enable **Anonymous**.
4. Project settings → Your apps → Web → copy the config → paste into
   `firebaseConfig` in [`js/config.js`](js/config.js).
5. Deploy, then open `index.html` as **admin** (the admin code) → the **Setup** tab, and
   set the real **committee** (names + each member's self-identified gender, used only
   to build balanced panels), **chair**, **interview times**, and the **OneDrive**
   applications-folder link. These save to your Firestore — they never go in the repo.
   (`ORG_NAME` branding is the only thing still set in [`js/config.js`](js/config.js);
   the roster placeholders there are just fallbacks until you run Setup.)
6. Committee → `index.html`; applicants → `book.html`.

## Re-keying (change the staff / admin codes or the questions)
The questions are encrypted once with a random content key `K`; `K` is then wrapped
(`K XOR PBKDF2(code)`) separately under the **staff** and **admin** codes. Changing a
code = re-wrapping `K`; changing the questions = re-encrypting + re-wrapping. Run this
(Python 3), then paste the printed `ENC_CIPHER`, `ENC_WRAP_STAFF`, `ENC_WRAP_ADMIN` into
[`js/data.js`](js/data.js) **and** `mock.html`:

```python
import hashlib, hmac, json, base64, os
STAFF = "your-staff-code"; ADMIN = "your-admin-code"   # independent; never commit these
QUESTIONS = [ ... ]               # the 10 questions
SCALE = [ ... ]; GUIDE = [ ... ]  # the 5 scale levels + guidance bullets
salt = base64.b64decode("ZWQtbW9jay1zYWx0LTAxIQ=="); iters = 100000  # = ENC_SALT/ENC_ITER
def hkdf(ikm, salt, length, info=b""):     # RFC 5869, matches WebCrypto HKDF
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest(); okm += t; i += 1
    return okm[:length]
kdf = lambda c: hashlib.pbkdf2_hmac("sha256", c.encode(), salt, iters, dklen=32)
K = os.urandom(32)
pt = json.dumps({"q":QUESTIONS,"s":SCALE,"g":GUIDE}, ensure_ascii=False).encode()
enc  = bytes(a ^ b for a, b in zip(pt, hkdf(K, salt, len(pt))))
wS   = bytes(a ^ b for a, b in zip(K, kdf(STAFF)))
wA   = bytes(a ^ b for a, b in zip(K, kdf(ADMIN)))
b64 = lambda b: base64.b64encode(b).decode()
print("ENC_CIPHER    =", b64(enc)); print("ENC_WRAP_STAFF =", b64(wS)); print("ENC_WRAP_ADMIN =", b64(wA))
```

## One link, three audiences
The same `index.html` serves everyone; what you can do depends on the code you type:
- **ED physician / committee** — the staff code → Screen · Availability · Score.
- **Admin** — the (independent) admin code → the above plus Panels · Ranking · Setup.
- **Applicant** — a **different applicant code** → taken straight to their own
  scheduling (enter last name, pick times). They never see the roster, questions,
  scores, or other applicants. (`book.html` now just forwards here.)

## Real access control (the "roles" security model)
By default `AUTH.mode` in [`js/config.js`](js/config.js) is `"anon"` — every client
signs in anonymously (matches the original open rules; no console setup, but the
data is only protected client-side). To get a **hard, server-enforced** boundary,
switch to the roles model. The app code is already written for it; you only need to
do these console steps (they can't be done from the repo):

1. **Firebase console → Authentication → Sign-in method →** enable **Email/Password**.
2. **Authentication → Users → Add user** three times (emails must match
   `AUTH` in `js/config.js`; the **passwords are the shared secrets** you hand out):

   | Email | Password | Who |
   |---|---|---|
   | `committee@ed-hiring.app` | the **staff code** | ED physicians / reviewers |
   | `admin@ed-hiring.app` | the **admin code** (independent of the staff code) | leadership |
   | `applicant@ed-hiring.app` | the **guest code** | candidates |

   > The admin code is independent of the staff code, so a reviewer who knows the
   > staff code **cannot** sign in as admin — the reviewer/admin (ranking) wall holds.
   > Remaining tradeoff: the staff code both decrypts the questions and is the
   > committee Firebase password, so keep it off any public channel and prefer a
   > code that isn't trivially guessable.

3. **Firestore → Rules →** paste [`firestore.rules`](firestore.rules) → **Publish**.
4. In [`js/config.js`](js/config.js) set `AUTH.mode = "roles"` and redeploy.
5. Sign in as **admin**, open **Setup**, and **Save the interview times** once — this
   publishes the PII-free slot list to `/interviews_public/slots` so applicants can
   read *only* that.

What this enforces (server-side, not just UI):
- Applicants can read **only** the interview slots and write **only** their own
  availability. They **cannot** read the roster, questions, screening, or scores.
- Reviewers can submit screening/scores/availability and read the roster +
  availability, but **cannot read anyone's scores/screening** — so the **ranking is
  admin-only for real**, not just hidden in the UI.

Honest limits (see the header of `firestore.rules`): reviewers share one committee
account, so per-**member** write-isolation isn't rule-enforceable (needs per-member
accounts or custom claims). And an applicant could overwrite another's availability
by typing their last name. Both are low-impact and documented.

## Security notes
- The **questions/scale/guidance** are encrypted and only decrypt with the correct
  committee code — not readable in the page source.
- Applicant **names/CVs** never live in the repo — names in Firestore/local, CVs in
  access-controlled OneDrive (the app only links out).
