// ============================================================================
//  Confidential content — interview questions, the revised overall rating scale,
//  and panelist guidance. Stored ENCRYPTED (PBKDF2→HKDF-SHA256 keystream, XOR) so
//  the questions are NOT readable in the public source. Decrypted client-side only
//  after the correct staff OR admin code is entered (each independently unwraps the
//  content key). The codes themselves live nowhere in the repo.
// ============================================================================

const ENC_SALT = "ZWQtbW9jay1zYWx0LTAxIQ==";
const ENC_ITER = 100000;
const ENC_CIPHER =
  "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";

const ENC_WRAP_STAFF = "qj3B/OGljpRolrbtbD3ZOgPCYSPAweAdTtEpv7du0/g=";
const ENC_WRAP_ADMIN = "VHMhwqusAveXfIXK305uOvN2glj50rSqBoBudu1hBIQ=";

function b64bytes(b) {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// The questions are encrypted once with a random 32-byte content key K; K is
// then "wrapped" (K XOR PBKDF2(code)) separately under the STAFF code and the
// ADMIN code, so two INDEPENDENT codes both decrypt the questions without either
// revealing the other. The wraps + cipher live here; the codes themselves live
// NOWHERE in the repo (a wrong code just yields garbage → UTF-8/JSON throw).
//
// Keystream from K = HKDF-Expand(SHA-256). PBKDF2 (small 256-bit output) does the
// password stretching to unwrap K; HKDF produces the full-length keystream. This
// two-step avoids Firefox's PBKDF2 deriveBits length cap — the same cipher
// decrypts in Chrome, Safari/WebKit and Firefox alike.

// derive a 32-byte key from a code (PBKDF2, Firefox-safe small output)
async function kdf32(code, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ENC_ITER, hash: "SHA-256" }, km, 256);
  return new Uint8Array(bits);
}
// try one wrap: unwrap K, expand to keystream, decrypt + validate. null on mismatch.
async function tryWrap(code, wrapB64, salt, ct) {
  try {
    const kd = await kdf32(code, salt), wrap = b64bytes(wrapB64);
    const K = new Uint8Array(32);
    for (let i = 0; i < 32; i++) K[i] = wrap[i] ^ kd[i];
    const hk = await crypto.subtle.importKey("raw", K, "HKDF", false, ["deriveBits"]);
    const ksBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array() }, hk, ct.length * 8);
    const ks = new Uint8Array(ksBits), pt = new Uint8Array(ct.length);
    for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
    const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
    if (!Array.isArray(obj.q) || !Array.isArray(obj.s)) return null;
    return obj;
  } catch { return null; }
}

// Returns { q, s, g, isAdmin } for the admin OR staff code, or throws for anything
// else (wrong code, or the applicant/guest code, which decrypts nothing).
export async function decryptContent(code) {
  if (!(window.crypto && window.crypto.subtle))
    throw new Error("secure-context-required");
  const salt = b64bytes(ENC_SALT), ct = b64bytes(ENC_CIPHER);
  const asAdmin = await tryWrap(code, ENC_WRAP_ADMIN, salt, ct);
  if (asAdmin) return { ...asAdmin, isAdmin: true };
  const asStaff = await tryWrap(code, ENC_WRAP_STAFF, salt, ct);
  if (asStaff) return { ...asStaff, isAdmin: false };
  throw new Error("bad");
}
