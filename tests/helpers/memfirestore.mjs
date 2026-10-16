// A small in-memory stand-in for the Firestore functions FirestoreStore uses
// (no rules, no network): enough to drive the close flow in node and spy on
// every write and delete it makes.
export class FakeTs {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; this._ms = ms; }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
  static fromMillis(ms) { return new FakeTs(ms); }
  static fromDate(d) { return new FakeTs(d.getTime()); }
}
const SERVER_TS = { __serverTs: true };
const DELETE = { __delete: true };
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x, (k, v) => (v instanceof FakeTs ? { __fakeTs: v._ms } : v)),
  (k, v) => (v && typeof v === "object" && "__fakeTs" in v ? new FakeTs(v.__fakeTs) : v)));
export function memFirestore() {
  const docs = new Map();               // "coll/id" or "coll/id/sub/id" -> data
  const log = { sets: [], deletes: [] };
  const resolve = (v) => (v === SERVER_TS ? new FakeTs(Date.now()) : v && typeof v === "object" && !(v instanceof FakeTs) && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : Array.isArray(v) ? v.map(resolve) : v);
  const ref = (path) => ({ path, id: path.split("/").pop() });
  const write = (r, data, opts) => {
    const cur = docs.get(r.path);
    let next;
    if (opts && opts.mergeFields) { next = { ...(cur || {}) }; opts.mergeFields.forEach((f) => { if (data[f] === DELETE) delete next[f]; else next[f] = resolve(data[f]); }); }
    else if (opts && opts.merge) next = { ...(cur || {}), ...resolve(data) };
    else next = resolve(data);
    Object.keys(next).forEach((k) => { if (next[k] === DELETE) delete next[k]; });
    docs.set(r.path, clone(next)); log.sets.push(r.path);
  };
  const del = (r) => { docs.delete(r.path); log.deletes.push(r.path); };
  const snap = (r) => ({ id: r.id, ref: r, exists: () => docs.has(r.path), data: () => clone(docs.get(r.path)) });
  const fb = {
    db: {},
    collection: (_db, ...segs) => ({ path: segs.join("/"), coll: true }),
    doc: (a, ...segs) => (a && a.coll && !segs.length ? ref(`${a.path}/auto${Math.random().toString(36).slice(2, 10)}`) : ref(segs.join("/"))),
    serverTimestamp: () => SERVER_TS, deleteField: () => DELETE, Timestamp: FakeTs,
    getDoc: async (r) => snap(r),
    getDocs: async (c) => ({ docs: [...docs.keys()].filter((p) => p.startsWith(c.path + "/") && p.slice(c.path.length + 1).split("/").length === 1).map((p) => snap(ref(p))) }),
    setDoc: async (r, d, o) => write(r, d, o), updateDoc: async (r, d) => write(r, d, { merge: true }), deleteDoc: async (r) => del(r),
    writeBatch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => write(r, d, o)), update: (r, d) => ops.push(() => write(r, d, { merge: true })),
      delete: (r) => ops.push(() => del(r)), commit: async () => ops.forEach((f) => f()) }; },
    runTransaction: async (_db, fn) => {
      const ops = [];
      const tx = { get: async (r) => snap(r), set: (r, d, o) => ops.push(() => write(r, d, o)), update: (r, d) => ops.push(() => write(r, d, { merge: true })),
        delete: (r) => ops.push(() => del(r)) };
      const out = await fn(tx);
      ops.forEach((f) => f());
      return out;
    },
    onSnapshot: () => () => {}, query: (...a) => a, orderBy: () => ({}), limit: () => ({}), startAfter: () => ({}),
  };
  return { fb, docs, log, seed: (path, data) => docs.set(path, clone(data)), read: (path) => clone(docs.get(path)) };
}
