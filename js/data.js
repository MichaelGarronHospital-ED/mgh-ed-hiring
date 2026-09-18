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
  "+bouvwk9o3aRq1XncoqjS2JhGHS+tjPrZl20lMXcBxCuSRtl9/Rq+NOwR6uz3fYu4F8sCNgyMqwZa9Oc8PDnGCNCfjoqHC7oWatjP2/rKkwXzwR2G35dwuCIyX9enblk3RKjqdyb6RMeDGLwHSmYw94wXa1Jue5ZsM7cnzl1LA2L5sGVbbO0kOju0MbPsbehGLTunw8x727Zjn9hjYKTFn+Xw6rnWRNJxBmVQs94RIQ58oCrukuzMwxKed6hTdD9qHKX5+lef6I2R0BWqVduzvgyGdlAL1fuPOR6BM4Ra9XbDCCtiT2OHsJ8udUWzy43u0ovBYxB+E4h+dVixHUWcOkCo07gK+SIOUidsFcXgGnJbXuD4LrrjfMjJr0sT4r6krfdSB1x7pf7lTBoTyMrakD8Uc1Z9I/vTqzgvI/n5QAoVsxYKHGXZPXwYdoUwnUtxwZ1k1paMu4r3IvXdrhA1E0nEzh0l/vzA9WfeRmnIbnJzmDVJuPr8PhEdz2p+xwsukbTQ0fPr4ZMa3rHF4XHJeQYod5zlOmgD8v4CZnjZ/DhX2G5MTKpMflHUdu7uV15+J5f3wehiHg831ChBmBLRv83vHnUn0B8x4eIq2Np4jm4/jab2MWIYgbuaVgC0BIrRNFwNiOxqjoEZ2zCLA7nSUHHpK5kMkKTQbScDw7vPoQNO9BP2KsNl3CANsRFHww+OxBHSR0ZkezECdXQ3/1CzP4M5PDQCdI1rHWHfMfktAQzViIDLxFuQkUYAGlkGwNpKmi0DaTN+aGFHjNe3+zsScrZTXVZ2Pmx8FTCaY9wXvCyISHgFt4Bi0HRuysjkJFlIblMl6G9vSSR7TqKVeEO27UdhWReZ11uRu3SQYJnJ36qHgBVgKng89lz4TZCRzQMw8QPLhtkBEi5hqhaKKS5TyG0xD9VVhohuAjsvbvnkcanyu/zFuzG1SD+HTeBdW5aFbg0NPP89Kdcd8zytB1eXj3PHXkNvjxKPzBj4uVssPkfWf4IpabA36wu4E7+Xk/W3YLBgGZIIL8RqPtpN6b8C5d+YbcbSTsJNY0e2yNmEMzQhSFtSnL+gyvFFeO7BgxUvPcAM5jF3Yf3MZISrtu54CfnFy95eqcPrfEOrdcXZmH6fqYIS57VTENha+2bMwmjbw8NiakHxXs2HUDuPKjb/yligYlBbc/yL5K6YWAjcgCLXuHGwK9d6C4jJRakqC3HjvSJ0cNZpYurEUyPoagxvhO3pCHdKrvz9DhK0Goec2ycOs1XZlJHx/rBEclnc22ipruFHyG7rx/doDN+SnlJixSIsQg0UqnktKh5lCDLIt+bXaLrDbACvGbrOjF5Ubc1lhe58yn/OkHB5NsH5kLyS5/qfvHS9iUKsbnmhZoVLKw950dbjn+rXznptA9In8FjWYGpbBU853gAvPsJka3s2eKJGXYbxchxhVYMDn+3EbfSzL9NzrkQCpfp9BOLGPZ4kV7nQkjO3Zt8j4d40PUV7e7G6q5rckzm9v9/Kxr4NBtn+5v9O1S1qx6qd6ys/rHX9P7hoB4x4rpfLf2jQ89h5oGeefeH12hbotDivnCBLfqcvR+8GbgJN1tNfSOI3IVU8GDo80JZXgqkQDeJi5igQwT8ghaqI4jp3LyPcUaACYbFiOxJhiMHG/+vRRfNxGDcckNkUOk//cdobxy1cAq9gQUfEiZZtlIN20uk+szf7zzCeSnqmCq537PARRAeLpaRi9GiKOGXvW3izatSjQFnASqpKi2qXBSPDg1J7dnsnM4q7ii4DrjWKAIxP/HbmY3xjcywswTetkkiUsFObgxVkECPzjNg3ci4d0FIVYfZ8MjbbvJqBmnH4qEpUreAg5ZZ+TnrEXf79kmU/SWYLOmJ+xpgWGsBs5guKzq1k6hxfZCo5Do3ymJ+SF2AYGdy+EDi7iz2Me8+ZExUn3tebd9PSJ6BzVOg4+U+Jnb1Nx86WVKNfxTsVAdS9p/zcyM7Dnl/jzquZ9XXLxqwuKFadO5nq7+gKu5V7VzGDrvp8wOWqpO4OvK4v2ihRrSYgpH1YLB8UoPry7xbHEF0XYa2UJ8Jv35Buc5/h+lfxwQBUbq5TrzthLSrJzrvojSJZ0vuXMv+zOzmJeB6ToabJsV6UEYD2TKKJnCFyzJwZ04w//uoBEdT3u3Kgm5aOgosd4dzyd9AHHFkRYAB+p9tamCtFbCuhQchO2XyHIHx52iyHMAAQUl6ZO8PkQSxxBVIYGx250P2NjfzHA6a7tRDEDNp0fyWTHNaOEC+ELNcWiLXRNd/H9Thm0y1CbAWjCws0fOWdfaTZ/WQMV1J6F1GOlo92D2wOAIIlrGqNPp3pMheLWH4FFI4nGvshq61IacOhom0b0rJnRHkWufJBlHc7DOUqWoYRvoOanPndPzavM5IwT66Xc3f0PM95+hjQvO3jAsDMHQrgoZxzKgO3UsJkav31lR74Gp2VaWGSlVLl69yy8e+HqMpybcqbaiN3v2qWN2J/eEa6g35v6vQrzqJep5W5Ab6t4HdFW69Ou/F4lmqh/B9nHLfe196Yq1K/vN0GV+P3XhkN5jA1OKJwzFywCU4eCONNkwJjyu7bf8yf11ub0BdmE3gppRDglkxbUqZqn0qlxcA00gdG3PTOSO1S1tg6gpiWn3dKhAOU7MyUk5j674mPMETYrX5R8GfXg2kXOhP2t5O84DpRiR7VyS1uVvbzAE7aM3hgCGbUP5MYT0rBEzjuxdzxxh0RxtYtUSdcruImJCeVaD/5jvKkctlWH38rCwBQT39pf3IogsxthdQaLvkzIWRCjrtKxehEaI22e1hh7yS1sHHU8j7mT7zxK3+f2IQYif2V0j1Rnjd1ezUQkGVhheN8SPIhVrICpfceqJlZYgrFYCrGyCMZnWMhNufRmDs4AchNbk2Od2fTZBJfvNuozEgk7s95m+auu4pb7TH2ixXZ2+1x7cks0obsQBfK5KOcIJrZcNV/4XyVhTSRgCzoeps7cpdnuRDne2yN+6yHI2J8HWP2QpkGTYbgdVNP2IxaYg14m5FvIGb6ASVi3m/3jA/nCDdqaPvt2RiSP78fkMZ5ZA96kDOshg0mkIUxvDKoXE4AOH+PxRMFXyGwAy8GDo1ECAv8kiA3TzSqPnf4vEVZI+O8gjfVhrWaPlgn5ZYIEyukExafK7W7p7d4BqbY98aY6aQWQsuK3703O7RxdmIiLt7pCrsLrSlDVZ0HYFEpO40zYma55C2BAfMicgMqXpXhyzBht7ZWvkY+QZrBqANxri88F/+BaiFzr/D9v3146/r51IOMmjR/gaT8Rgp/ViTUljk3hmpQ+aNVQjWSIqPXYSL/zKV/fZI0vX+QfHrZJCsdS3hfwYRjW1qPg==";

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
