# For the judges

Every claim NutCheck makes, with the proof beside it. Run the commands yourself. The links are live.

## Try it in one minute

1. Open https://nutcheck.vercel.app/app.html. The Clean sample loads by default. It is a real 21-sat token from the live testnut.cashu.exchange mint, checked live.
2. Click the "collision" sample (Evil mint token). The report reads "Hold, here is why." and the residue step shows two different V1 keyset IDs sharing one residue. That is the failure this tool catches.
3. Click the Clean sample again and turn on "Ask the mint". The headline becomes "No known issues found.", 7 Passed, and the mint reports all three proofs unspent.

## Claims

| Claim | Proof |
| --- | --- |
| NUT-13 is a real disclosed vulnerability. A V1 keyset ID reduces to a 31-bit residue, and two different keysets can share one. | The Cashu ecosystem disclosed it on 10 January 2026 (found July 2025). The mechanism is the residue screen this tool runs: a V1 keyset ID reduced mod (2^31 - 1). |
| A real wallet accepts a colliding-residue token. | [cashu.me issue 629](https://github.com/cashubtc/cashu.me/issues/629), open. Keyset B `00102821c3bc6333` shares residue 1138537334 with trusted keyset A `00206785c39be46b`. The maintainer confirmed two gaps in the wallet's existing check and keeps the issue open. |
| The official NUT-13 vector reduces to residue 864559728. | `tests/residue.test.ts` pins keyset `009a1f293253e41e` to residue 864559728. A wrong modulus gives 844358686, so the modulus is pinned by test. |
| A birthday search found a colliding V1 pair in 2,929 tries. | `tests/residue.test.ts`. The pair is `00ec0ed941f4b5c6` and `00c0d23b424b2f02`, both at residue 1137496952. |
| Keyset derivation matches the NUT-02 vectors. | The V1 vector derives to `00456a94ab4e1c46`. The V2 vector derives to `015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a`. Both are pinned in tests. |
| The checker runs live on a real token from a real mint. | https://nutcheck.vercel.app. The Clean sample is a real 21-sat token from the live testnut.cashu.exchange mint (V2 keyset `01013273414675b8`, 3 proofs, all with DLEQ). With consent on, the headline is "No known issues found.", 7 Passed, and the mint reports all three proofs unspent. |
| The mint lists 14 keysets. | The live site's Mint facts step reads "The mint answered, 14 keysets listed" for the Clean token. |
| 292 tests pass, and every headline number reproduces in one command. | Run `npm test` in the repo. 14 files, 292 tests, typecheck clean. Run `npm run prove` to recompute every headline number with its limit beside it. |
| The tool never spends, signs, or holds proofs. | It only reads tokens and mint metadata. The report's Cannot prove section states what it can never prove. See `src/report.ts`. |
| A proof without DLEQ is still valid spendable ecash. | The cashu.me maintainer's comment on [issue 629](https://github.com/cashubtc/cashu.me/issues/629#issuecomment-7021368774). DLEQ proves the mint owns its key, never that the mint is honest. |
| The limits are disclosed up front. | `LIMITS.md` in the repo. The residue screen is V1 only, DLEQ is optional, the mint's answer is a snapshot, and the tool cannot prove a mint is honest or solvent. |

## What is real and what is a demo

The Clean sample is a real token from a live mint, checked live. The other seven samples are labeled demos: they show states (collision, spent, unreachable, partial DLEQ) that cannot be reproduced on demand from a live mint. The page says so on each one. Nothing on the site pretends a demo is live.
