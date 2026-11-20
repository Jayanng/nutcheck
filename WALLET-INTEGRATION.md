# Wallet Integration

How a cashu-ts wallet checks a token before it swaps it. Copy, paste, adapt.

## Install

```sh
npm install @nutcheck/core @cashu/cashu-ts@4.13.1
```

Pin cashu-ts to exactly 4.13.1. NutCheck is tested against that version. A different version can change keyset derivation or DLEQ handling, and the checks may not mean what you think.

## Check a token before you swap it

Call `diagnoseToken` on every token you receive, before you call the wallet's receive or swap. Pass the keysets your wallet already holds as `knownKeysets`, so the residue screen compares the incoming token against what you already trust.

```ts
import { diagnoseToken } from '@nutcheck/core';

async function acceptToken(token: string, walletKeysets: string[]) {
  const report = await diagnoseToken(token, {
    consent: false, // do not ask the mint until the user agrees
    knownKeysets: walletKeysets,
  });

  if (report.headline === 'Hold, here is why.') {
    // A check found something. Do not swap. Show the user the finding
    // in report.checked, and let them decide.
    return { accepted: false, report };
  }

  if (report.headline === 'Not fully checked.') {
    // The only open items are checks that did not run, usually the
    // mint check without consent. Ask the user whether to turn on
    // "Ask the mint", then run diagnoseToken again with consent: true.
    return { accepted: false, needsConsent: true, report };
  }

  // "No known issues found." Nothing in the checks that ran turned up
  // a finding. A clean headline means no known issues were found in the checks that ran. Read LIMITS.md.
  return { accepted: true, report };
}
```

## What to pass as knownKeysets

The keyset IDs your wallet already holds proofs on. The residue screen compares the incoming token's keysets against these. If the token's keyset collides with one you hold, the report flags it. Without this list, the screen only compares the token against the mint's own keysets, and a collision with your holdings goes unnoticed.

Get the IDs from your wallet's keyset store. They are the 16-character hex IDs for V1, longer for V2. Do not pass secret keys, only the public keyset IDs.

## What not to do

- Do not call `diagnoseToken` with `consent: true` by default. Asking the mint sends the proofs' secret hashes (Ys) to the mint, and the mint learns what the user holds. Ask the user first, every time.
- Do not treat "No known issues found." as more than it is. It means nothing was found in the checks that ran. Show the user the Not checked and Cannot prove sections alongside the headline.
- Do not swallow a Hold. If the headline is "Hold, here is why.", surface the finding. Silently accepting a flagged token defeats the check.

## The report shape

`diagnoseToken` returns a `NutCheckReport`:

- `headline`: "No known issues found.", "Hold, here is why.", or "Not fully checked."
- `severity`: "none", "amber", or "red".
- `checked`: what ran, each with a result, an outcome, and a severity.
- `notChecked`: what did not run, and why.
- `cannotProve`: what this tool can never prove, whatever the result.

Render all three sections. A headline without the sections hides what did not run.
