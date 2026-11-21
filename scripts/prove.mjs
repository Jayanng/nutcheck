// One-command proof of NutCheck's headline numbers.
//
// Run it with: npm run prove
// It builds the core first, then recomputes every number the README and
// JUDGES.md state, and prints each one with its limit. It exits non-zero
// if any number does not match, so a passing run is a real check, not a
// printout.
//
// What it proves, and the limit beside each number:
// - The official NUT-13 vector reduces to 864559728, and the wrong modulus
//   gives 844358686. The modulus is pinned by this check.
// - The birthday pair (00ec0ed941f4b5c6, 00c0d23b424b2f02) shares residue
//   1137496952. The pair is fixed, it is the one the tests pin.
// - The issue 629 pair (00102821c3bc6333, 00206785c39be46b) shares residue
//   1138537334. The pair is fixed, it is the one filed against cashu.me.
// - The NUT-02 vectors derive to 00456a94ab4e1c46 (V1) and
//   015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a (V2).
// - A fresh birthday search finds a new colliding pair. Limit: the pair
//   and the try count are different on every run. The 2,929 tries in the
//   README were one run. The mechanism is what this proves, not the count.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { deriveKeysetId } from '@cashu/cashu-ts';
import { keysetResidue } from '../dist/src/index.js';

let failures = 0;

function check(label, actual, expected, limit) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      got ${actual}, expected ${expected}`);
  if (limit) {
    console.log(`      limit: ${limit}`);
  }
}

// 1. Official NUT-13 vector, correct modulus.
check(
  'NUT-13 vector 009a1f293253e41e, mod (2^31 - 1)',
  keysetResidue('009a1f293253e41e'),
  864559728,
  'The modulus is the NUT-13 rule. A different modulus gives a different residue.',
);

// 2. The wrong modulus, shown so the pin is explicit.
const wrongModulus = Number(BigInt('0x009a1f293253e41e') % (2n ** 31n));
check(
  'Same vector, wrong modulus mod 2^31',
  wrongModulus,
  844358686,
  'This is the number a wrong modulus gives. It must stay different from 864559728.',
);

// 3. Birthday pair, both at 1137496952.
const pairA = keysetResidue('00ec0ed941f4b5c6');
const pairB = keysetResidue('00c0d23b424b2f02');
check(
  'Birthday pair 00ec0ed941f4b5c6 and 00c0d23b424b2f02 share a residue',
  pairA === pairB ? pairA : -1,
  1137496952,
  'The pair is fixed, it is the one the tests pin. A fresh search finds a different pair.',
);

// 4. Issue 629 pair, both at 1138537334.
const issueA = keysetResidue('00102821c3bc6333');
const issueB = keysetResidue('00206785c39be46b');
check(
  'Issue 629 pair 00102821c3bc6333 and 00206785c39be46b share a residue',
  issueA === issueB ? issueA : -1,
  1138537334,
  'The pair is the one filed against cashu.me. The issue is open.',
);

// 5. NUT-02 derivation vectors.
const nut02 = JSON.parse(
  readFileSync(new URL('../tests/fixtures/nut02-vectors.json', import.meta.url), 'utf-8'),
);
const v1 = deriveKeysetId(nut02.v1.keys, { versionByte: 0 });
check(
  'NUT-02 V1 vector derives to 00456a94ab4e1c46',
  v1,
  '00456a94ab4e1c46',
  'The vector keys are the NUT-02 test vector, not a live mint.',
);
const v2 = deriveKeysetId(nut02.v2.keys, {
  unit: 'sat',
  input_fee_ppk: 100,
  expiry: 2059210353,
  versionByte: 1,
});
check(
  'NUT-02 V2 vector derives to 015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a',
  v2,
  '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a',
  'The vector keys are the NUT-02 test vector, not a live mint.',
);

// 6. Fresh birthday search. Generate random V1 IDs until two share a residue.
function randomV1Id() {
  const bytes = randomBytes(8);
  bytes[0] = 0x00;
  return bytes.toString('hex');
}
const seen = new Map();
let freshPair = null;
let tries = 0;
while (!freshPair) {
  tries += 1;
  const id = randomV1Id();
  const residue = keysetResidue(id);
  const first = seen.get(residue);
  if (first && first !== id) {
    freshPair = { first, second: id, residue };
  } else if (!first) {
    seen.set(residue, id);
  }
  if (tries > 500000) {
    break;
  }
}
if (freshPair) {
  console.log('PASS  Fresh birthday search found a colliding pair');
  console.log(`      ${freshPair.first} and ${freshPair.second}, residue ${freshPair.residue}, in ${tries} tries`);
  console.log(
    '      limit: the pair and the try count are different on every run. The 2,929 tries in the README were one run. The mechanism is what this proves, not the count.',
  );
} else {
  failures += 1;
  console.log('FAIL  Fresh birthday search found no colliding pair in 500000 tries');
}

console.log('');
if (failures === 0) {
  console.log('All headline numbers check out.');
} else {
  console.log(`${failures} headline number(s) did not match.`);
  process.exit(1);
}
