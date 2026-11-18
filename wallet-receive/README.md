# Wallet receive proof

Wallet: cashu.me, upstream commit 002a0a3, cashu-ts 4.9.0.
Mint: a deterministic mock on http://localhost:3338 (keyset B 00102821c3bc6333).
Core: @nutcheck/core.

## Scope
This is a finding against the upstream cashu.me wallet, tested live at
commit 002a0a3 with its installed cashu-ts 4.9.0. The same fixtures were
also tested against a local clone with cashu-ts 4.13.1 (see below).
The upstream result is the finding; the clone result shows the
collision-token acceptance was observed in both environments, while
partial-DLEQ behavior differed by version.

## Method
Each token was run through the wallet's receive operation, the same
cashu-ts call the wallet's redeem step makes
(mintWallet.ops.receive(token).asDeterministic().privkey().proofsWeHave().run()).
The wallet's receiveToken/redeem code was read in full: it has no residue
collision check, no DLEQ completeness check, and no keyset derivation
check. It decodes the token, adds the mint if unknown, and calls redeem.

## Versions (live, upstream)
```
$ node --version
v24.22.1
$ npm --version
10.9.4
$ npm ls @cashu/cashu-ts
cashu@0.0.1
└── @cashu/cashu-ts@4.9.0
$ git log --oneline -1
002a0a3 Merge pull request #615 from cashubtc/docs/responsible-disclosure-guidance
```

## Versions (live, core)
```
$ node --version
v24.22.1
$ npm --version
10.9.4
$ npm ls @cashu/cashu-ts
@nutcheck/core@0.1.0
└── @cashu/cashu-ts@4.13.1
$ npm run build:core
> @nutcheck/core@0.1.0 build:core
> tsc
$ npm run typecheck
> tsc --noEmit
$ npm run build
> @nutcheck/core@0.1.0 build
> vite build
```

## Case 1: colliding-residue V1 keyset (upstream)
Token: token-colliding-residue.txt (keyset B 00102821c3bc6333).
Core verdict: Hold. Residue COLLISION 1138537334 shared by B (token),
B (mint), A 00206785c39be46b (caller-supplied comparison keyset). DLEQ valid.
Wallet receive (upstream, cashu-ts 4.9.0): ACCEPTED. The swap completed
and returned 1 new proof, amount 1, keyset B. The wallet does not check
the residue collision.

Live log (upstream):
```
=== 1 colliding-residue ===
RECEIVE: ACCEPTED | proofs: 1 | amount: 1 | keysets: 00102821c3bc6333
```

Note: this shows the wallet accepts a token whose keyset collides in
residue with a known keyset. It does not show signature recovery at the
target mint, which needs a /v1/restore call the mock does not implement.
Signature recovery and proof theft are Cannot prove here.

## Version note
The two cases differ by cashu-ts version. The colliding-residue token is
accepted by both 4.9.0 (upstream) and 4.13.1 (clone). The partial-DLEQ
token is REJECTED by 4.9.0 with "expected Uint8Array, got type=undefined"
and ACCEPTED silently by 4.13.1. Issue #629 records both observations
with the version beside each.

## Case 2: partial-DLEQ token (upstream)
Token: token-partial-dleq.txt (the token from Case 1 with r removed from
its real DLEQ block, 281 chars).
Core verdict: Hold. DLEQ "a proof carries an incomplete DLEQ".
Wallet receive (upstream, cashu-ts 4.9.0): REJECTED with
`expected Uint8Array, got type=undefined`. The library does not handle
the incomplete DLEQ block gracefully.

Wallet receive (clone, cashu-ts 4.13.1): ACCEPTED. The library silently
drops the incomplete DLEQ on decode and the wallet redeems the token.
The swap completed and returned 1 new proof, amount 1.

Live log (clone, 4.13.1, fresh mock):
```
TOKEN 2 RECEIVE: ACCEPTED | proofs: 1 | amount: 1
```

## What this shows
The upstream cashu.me wallet, at commit 002a0a3 with cashu-ts 4.9.0,
accepts a token whose V1 keyset collides in residue with a known
keyset. The wallet has no check that would stop it. The partial-DLEQ
behavior differs by library version: 4.9.0 rejects with a cryptic
error, 4.13.1 accepts silently. Neither version reports the incomplete
DLEQ to the user.

Upstream issue filed: https://github.com/cashubtc/cashu.me/issues/629

## Gated receive demo
The wallet now has a NutCheck check on receive. @nutcheck/core is
installed into the cashu.me clone, a Buffer polyfill boot file is
registered, and receiveTokensStore.receiveToken calls diagnoseToken
before redeem and throws on a Hold headline. The wallet builds
(dist/spa) and the bundle contains the core, the check, the Buffer
polyfill, and the known keyset A. Verified against the installed
package: the colliding token and the partial-DLEQ token both return
headline "Hold, here is why." so the check blocks both.

## Tests
Automated tests cover the mock swap, checkstate, and the core findings
(tests/evilmint-swap.test.ts, 13 tests). Full suite: 277 tests pass.

```
Test Files  14 passed (14)
     Tests  277 passed (277)
```
