// Upstream check: run the same fixtures against cashu.me commit 002a0a3
// with its installed cashu-ts 4.9.0. This script was run live on
// 2026-11-18 and produced the logs in wallet-receive/README.md.
// Usage: start the evilmint first (node scripts/evilmint.mjs), then:
//   node wallet-receive/upstream-check.mjs
import { Wallet } from "@cashu/cashu-ts";
import { readFileSync } from "node:fs";

const bip39seed = new Uint8Array(64).fill(7);
const wallet = new Wallet("http://localhost:3338", { unit: "sat", bip39seed });
await wallet.loadMint();
console.log("mint loaded");

const tokens = [
  ["1 colliding-residue", "wallet-receive/token-colliding-residue.txt"],
  ["2 partial-DLEQ", "wallet-receive/token-partial-dleq.txt"],
];

for (const [name, path] of tokens) {
  const token = readFileSync(path, "utf8").trim();
  try {
    const proofs = await wallet.ops.receive(token).asDeterministic().privkey(new Uint8Array(32).fill(9)).proofsWeHave([]).run();
    console.log(`=== ${name} ===`);
    console.log(`RECEIVE: ACCEPTED | proofs: ${proofs.length} | amount: ${proofs.reduce((s,p)=>s+p.amount,0)} | keysets: ${proofs.map(p=>p.id).join(",")}`);
  } catch (e) {
    console.log(`=== ${name} ===`);
    console.log(`RECEIVE: REJECTED | ${e.message}`);
  }
}
console.log("done.");
