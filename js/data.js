// ============================================================================
//  Confidential content — interview questions, the revised overall rating scale,
//  and panelist guidance. Stored ENCRYPTED (PBKDF2→HKDF-SHA256 keystream, XOR) so
//  the questions are NOT readable in the public source. Decrypted client-side only
//  after the correct committee code is entered (the code is the key). Same blob
//  and scheme as the reviewed mock.
// ============================================================================

const ENC_SALT = "ZWQtbW9jay1zYWx0LTAxIQ==";
const ENC_ITER = 100000;
const ENC_CIPHER =
  "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";

function b64bytes(b) {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// Returns { q:[...questions], s:[...scale], g:[...guidance] } or throws if the
// code is wrong (garbage decrypt fails UTF-8 / JSON). `code` is the committee
// code WITHOUT any trailing "!" (the admin marker is stripped by the caller).
// Keystream = HKDF-Expand(SHA-256) of a PBKDF2-derived PRK. PBKDF2 does the
// password stretching (small 256-bit output); HKDF produces the full-length
// keystream. This two-step avoids Firefox's PBKDF2 deriveBits length cap
// (Firefox rejects large single PBKDF2 derives; HKDF handles them) — so the
// same cipher decrypts in Chrome, Safari/WebKit and Firefox alike.
export async function decryptContent(code) {
  if (!(window.crypto && window.crypto.subtle))
    throw new Error("secure-context-required");
  const salt = b64bytes(ENC_SALT), ct = b64bytes(ENC_CIPHER);
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const prkBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ENC_ITER, hash: "SHA-256" }, km, 256);
  const hk = await crypto.subtle.importKey("raw", new Uint8Array(prkBits), "HKDF", false, ["deriveBits"]);
  const ksBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array() }, hk, ct.length * 8);
  const ks = new Uint8Array(ksBits), pt = new Uint8Array(ct.length);
  for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
  const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
  if (!Array.isArray(obj.q) || !Array.isArray(obj.s)) throw new Error("bad");
  return obj;
}
