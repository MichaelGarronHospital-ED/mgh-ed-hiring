// Throwaway fixture reproducing the real situation: a candidate was added as
// "Rosalind Ashcombe", reviewers screened her, then the name was fixed by removing
// her and re-adding as "Rosalind Ashcomb" — stranding the input on the old id.
// Emulator only. `dump` prints the resulting state.
import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, doc, setDoc, collection, getDocs } from "firebase/firestore";

const db = getFirestore(initializeApp({ projectId: "mgh-ed-hiring" }));
const [host, port] = (process.env.ED_IV_EMULATOR || "127.0.0.1:8080").split(":");
connectFirestoreEmulator(db, host, Number(port));

if (process.argv[2] === "dump") {
  for (const c of ["interviews_candidates", "interviews_screening", "interviews_scores", "interviews_availCand", "interviews_meta"]) {
    console.log(`\n${c}:`);
    (await getDocs(collection(db, c))).docs.forEach((d) => console.log(`  ${d.id} → ${JSON.stringify(d.data())}`));
  }
  process.exit(0);
}

await setDoc(doc(db, "interviews_candidates", "c-old"), { name: "Rosalind Ashcombe", removed: true });
await setDoc(doc(db, "interviews_candidates", "c-new"), { name: "Rosalind Ashcomb", removed: false });
await setDoc(doc(db, "interviews_candidates", "c-ana"), { name: "Ana Brill", removed: false });

// real reviewer ratings, stranded on the old id
await setDoc(doc(db, "interviews_screening", "Vojdani~c-old"), { member: "Vojdani", candId: "c-old", rating: 4 });
await setDoc(doc(db, "interviews_screening", "Rivera~c-old"), { member: "Rivera", candId: "c-old", flag: true, reason: "check CV gap" });
await setDoc(doc(db, "interviews_screening", "Nassar~c-old"), { member: "Nassar", candId: "c-old", rating: 5 });
await setDoc(doc(db, "interviews_scores", "Vojdani~c-old"), { member: "Vojdani", candId: "c-old", overall: 4, notes: { 0: "strong" } });

// collision: Nassar already re-screened her under the NEW entry — must NOT be clobbered
await setDoc(doc(db, "interviews_screening", "Nassar~c-new"), { member: "Nassar", candId: "c-new", rating: 2 });
// an empty doc on the new id — safe to replace
await setDoc(doc(db, "interviews_screening", "Vojdani~c-new"), { member: "Vojdani", candId: "c-new" });

// availability under the OLD surname
await setDoc(doc(db, "interviews_availCand", "young"), { slots: { 0: "ip", 2: "either" } });
// unrelated candidate's input, must be untouched
await setDoc(doc(db, "interviews_screening", "Rivera~c-ana"), { member: "Rivera", candId: "c-ana", rating: 3 });
// a manual panel built for the old id
await setDoc(doc(db, "interviews_meta", "config"), { panelOverrides: { "c-old": { slot: "0", members: ["Vojdani", "Rivera"] } } });

console.log("seeded");
process.exit(0);
