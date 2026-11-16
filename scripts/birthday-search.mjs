// Birthday search: finds a fresh pair of different V1 keyset ids that share
// a residue, so the residue screen is not leaning on one fixed example.
// This is a synthetic NUT-13 residue demonstration, not a finding against a
// real mint: the ids are V1-shaped (8 bytes, first byte 00), not derived
// from real public keys. The screen works on ids as hex strings, so the
// shape is what matters for demonstrating the residue collision. The fixed
// colliding pair in the tests is the deterministic fixture; this script finds
// a fresh pair on every run.
// Run with: node scripts/birthday-search.mjs
// It prints the pair and the shared residue, and exits 0 when one is found.
import { randomBytes } from 'node:crypto';

const MODULUS = 2n ** 31n - 1n;

function residue(hex) {
  return Number(BigInt(`0x${hex}`) % MODULUS);
}

function randomV1Id() {
  // A V1 keyset id is 8 bytes, first byte 00.
  const bytes = randomBytes(8);
  bytes[0] = 0x00;
  return bytes.toString('hex');
}

const seen = new Map();
let tries = 0;
while (true) {
  tries += 1;
  const id = randomV1Id();
  const r = residue(id);
  const first = seen.get(r);
  if (first && first !== id) {
    // Verify the result before printing it: both ids are V1-shaped,
    // they differ, and their residues are equal when recomputed.
    const firstResidue = residue(first);
    const secondResidue = residue(id);
    if (
      /^00[0-9a-f]{14}$/.test(first) &&
      /^00[0-9a-f]{14}$/.test(id) &&
      first !== id &&
      firstResidue === secondResidue
    ) {
      console.log(`found after ${tries} tries`);
      console.log(`first:  ${first}`);
      console.log(`second: ${id}`);
      console.log(`residue: ${secondResidue}`);
      process.exit(0);
    }
  }
  if (!first) {
    seen.set(r, id);
  }
}
