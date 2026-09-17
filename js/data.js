// ============================================================================
//  Confidential content — interview questions, the revised overall rating scale,
//  and panelist guidance. Stored ENCRYPTED (PBKDF2-SHA256 keystream, XOR) so the
//  questions are NOT readable in the public source. Decrypted client-side only
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
export async function decryptContent(code) {
  if (!(window.crypto && window.crypto.subtle))
    throw new Error("secure-context-required");
  const salt = b64bytes(ENC_SALT), ct = b64bytes(ENC_CIPHER);
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ENC_ITER, hash: "SHA-256" }, km, ct.length * 8);
  const ks = new Uint8Array(bits), pt = new Uint8Array(ct.length);
  for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
  const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
  if (!Array.isArray(obj.q) || !Array.isArray(obj.s)) throw new Error("bad");
  return obj;
}
