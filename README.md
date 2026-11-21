# NutCheck

**The pre-flight check for ecash, with its limits on the label.**

[![npm version](https://img.shields.io/npm/v/@nutcheck/core)](https://www.npmjs.com/package/@nutcheck/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Paste a Cashu token, get a report of what can be verified about it before your wallet swaps it. The report has three sections: Checked, Not checked, Cannot prove. When nothing turns up, the headline is "No known issues found.", never anything stronger.

**Live:** https://nutcheck.vercel.app
**Package:** `npm install @nutcheck/core`

## The problem

On 10 January 2026, the Cashu ecosystem disclosed a protocol vulnerability (NUT-13): a V1 keyset ID reduces to a 31-bit residue, and two different keysets can land on the same residue. A wallet that holds proofs on one keyset and receives a token on a colliding keyset can be tricked into treating the wrong proofs as its own. The disclosure was found in July 2025 and published on 10 January 2026.

NutCheck screens a token against that failure before the wallet swaps it. It decodes the token locally, recomputes each keyset ID from the mint's public keys, screens the V1 keyset IDs for residue collisions, checks DLEQ conformance, and, only with your consent, asks the mint whether the proofs are spent. It never spends, signs, or holds proofs.

The collision it catches is real: an evil mint keyset sharing residue 1138537334 with a trusted one, filed as [cashu.me issue 629](https://github.com/cashubtc/cashu.me/issues/629) in November 2026.

## Quick start

Node 22.4.0 or later.

```sh
git clone https://github.com/Jayanng/nutcheck.git
cd nutcheck
npm install
npm test
npm run prove
```

Run the web checker locally:

```sh
npm run dev
```

Build the core library:

```sh
npm run build:core
```

## Use it in a wallet

```sh
npm install @nutcheck/core
```

`@nutcheck/core` exposes one entry point, `diagnoseToken`. It takes a token string and returns a report. Nothing is spent, signed, or held.

```ts
import { diagnoseToken } from '@nutcheck/core';

const report = await diagnoseToken(token, {
  consent: false, // ask the mint only when the user agrees
  knownKeysets: ['00206785c39be46b'], // keysets you already trust
});

if (report.headline === 'Reject, here is why.') {
  // Do not swap this token. Read report.checked for the finding.
}
```

The report has three sections. `checked` lists what ran and its result. `notChecked` lists what did not run and why. `cannotProve` lists what this tool can never prove, whatever the result. The headline is one of four: "No known issues found.", "Reject, here is why." (a proven problem: a residue collision, a spent proof, an invalid DLEQ), "Hold, here is why." (a finding that is not a proven hard failure), or "Not fully checked." (the last when the only open items are checks that did not run, such as the mint check without consent).

A v4 token is CBOR plus base64url, never bech32. A v3 token is base64url JSON. Bech32m is used for NUT-26 payment requests, not tokens. NutCheck decodes both locally, in your browser or in your process, before anything is judged.

## What it checks

- Local decoding of cashuB (v4) and cashuA (v3) tokens. NUT-00.
- The V1 keyset residue-collision screen. A V1 keyset ID is reduced mod (2^31 - 1); two different IDs sharing a residue are flagged. The official NUT-13 vector, keyset `009a1f293253e41e`, reduces to residue 864559728. A wrong modulus gives 844358686, so the modulus is pinned by test. NUT-13.
- Keyset ID derivation against the mint's public keys. The NUT-02 V1 vector derives to `00456a94ab4e1c46`; the V2 vector derives to `015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a`. NUT-02.
- DLEQ conformance. A proof with no DLEQ is still valid spendable ecash; DLEQ proves the mint owns its key, never that the mint is honest. NUT-12.
- Proof state, only with your consent. The mint answers spent, pending, or unspent. Its word, one moment, and it learns what you hold. NUT-07.
- Keyset age, as a trust signal only. An old keyset is not proof of anything.

A birthday search over V1 keyset IDs found a colliding pair in 2,929 tries, both at residue 1137496952. The pair is different on every run; the mechanism stays the same.

## What it cannot prove

That the mint is honest, that the mint is solvent, that the proofs stay unspent after this check, that no collision exists outside the lists you supplied. The residue screen covers only the keyset lists supplied. It cannot prove that no collision exists elsewhere.

## Security scope

NutCheck reads tokens and mint metadata. It does not spend, sign, derive, or hold proofs. It does not keep your token: the check runs locally, and the mint is contacted only when you turn on "Ask the mint", and only for the proofs you submit.

The checkstate call sends the proofs' secret hashes (Ys) to the mint. The mint learns which proofs you hold. Do not turn it on for a token you want to keep private from that mint.

If you find a vulnerability in NutCheck itself, report it privately to jayanng300@gmail.com. We will respond within 7 days and aim to fix it within 90 days of the report. See SECURITY.md for the full disclosure policy.

## Limits

See LIMITS.md for the full list. In short: the residue screen is V1 only (V2 and V3 keysets use different derivations and are excluded); DLEQ is optional in Cashu, so a proof without it is still valid; the mint's answer is a snapshot that can change the moment after; and this tool cannot prove a mint is honest or solvent. Read LIMITS.md before you rely on a report.

## What's honest

Real: the checker runs on real tokens against real mints. The Clean sample is a real 21-sat token from the live testnut.cashu.exchange mint, checked live. The colliding-residue finding is real and filed as cashu.me issue 629, which is open. The NUT-13 vulnerability was disclosed on 10 January 2026. 292 tests pass. Run `npm run prove` to recompute every headline number with its limit beside it. `@nutcheck/core` 0.1.0 is published on npm, install it with `npm install @nutcheck/core`.

Demo only: the other seven samples are synthetic tokens with simulated mint answers. Each one is labeled as a demo on the page. They show states (collision, spent, unreachable, partial DLEQ) that cannot be reproduced on demand from a live mint.

Cut: QR upload is not built.

## License

MIT. See LICENSE.
