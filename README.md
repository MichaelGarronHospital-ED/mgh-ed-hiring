# ED Physician Hiring — Interviews Tool

A five-stage hiring tool: **Screen → Availability → Panels → Score → Ranking**.
Static frontend (no build step). Runs in **local mode** out of the box; add a
Firebase project to go multi-device and real-time.

- **Committee:** [`index.html`](index.html) — enter the committee code, pick your name.
- **Applicants:** [`book.html`](book.html) — one link, type your name, pick your times.
- **Mock (design demo):** [`mock.html`](mock.html) — the clickable prototype Kyle reviewed.

Design + decisions live in [`DESIGN.md`](DESIGN.md); the paneling algorithm is in
[`js/panels.js`](js/panels.js) (validated in a Python prototype before porting).

## Access codes
There is **no code in the source**. The committee code (shared with the team
out-of-band, not written down in this repo) is what people type to enter; it also
decrypts the interview questions. Admins type the same code **+ `!`** and additionally
see the Ranking tab. Regular members never see the Ranking — it's admin-only and hidden
until all interviews are marked complete.

> **Security:** the code decrypts the confidential questions, so treat it like the
> questions themselves. Before real use, set your real questions + a **strong private
> code** and re-encrypt (below) — never a code that appears anywhere public.

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
5. Deploy, then open `index.html` as **admin** (code + `!`) → the **Setup** tab, and
   set the real **committee** (names + each member's self-identified gender, used only
   to build balanced panels), **chair**, **interview times**, and the **OneDrive**
   applications-folder link. These save to your Firestore — they never go in the repo.
   (`ORG_NAME` branding is the only thing still set in [`js/config.js`](js/config.js);
   the roster placeholders there are just fallbacks until you run Setup.)
6. Committee → `index.html`; applicants → `book.html`.

## Changing the committee code
The questions are encrypted with the code, so changing it means re-encrypting them.
Run this (Python 3), then paste the new `ENC_CIPHER` into [`js/data.js`](js/data.js):

The keystream is `HKDF-Expand(SHA-256)` of a PBKDF2-derived PRK (this two-step is
what lets the same cipher decrypt in Firefox as well as Chrome/Safari). Run this
(Python 3), then paste the new `ENC_CIPHER` into [`js/data.js`](js/data.js) **and**
`mock.html`:

```python
import hashlib, hmac, json, base64
CODE = "your-new-code"            # committee code (no trailing "!")
QUESTIONS = [ ... ]               # the 10 questions
SCALE = [ ... ]; GUIDE = [ ... ]  # the 5 scale levels + guidance bullets
salt = base64.b64decode("ZWQtbW9jay1zYWx0LTAxIQ=="); iters = 100000  # = ENC_SALT/ENC_ITER
def hkdf(ikm, salt, length, info=b""):     # RFC 5869, matches WebCrypto HKDF
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest(); okm += t; i += 1
    return okm[:length]
pt = json.dumps({"q":QUESTIONS,"s":SCALE,"g":GUIDE}, ensure_ascii=False).encode()
prk = hashlib.pbkdf2_hmac("sha256", CODE.encode(), salt, iters, dklen=32)
ks = hkdf(prk, salt, len(pt))
print(base64.b64encode(bytes(a ^ b for a, b in zip(pt, ks))).decode())
```

## One link, three audiences
The same `index.html` serves everyone; what you can do depends on the code you type:
- **Committee reviewer** — the committee code → Screen · Availability · Score.
- **Admin** — committee code **+ `!`** → the above plus Panels · Ranking · Setup.
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
   | `committee@ed-hiring.app` | the **committee code** | reviewers |
   | `admin@ed-hiring.app` | the committee code **+ `!`** | leadership |
   | `applicant@ed-hiring.app` | a separate **applicant code** | candidates |

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
