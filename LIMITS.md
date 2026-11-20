# Limits

Read this before you rely on a NutCheck report. It takes one minute.

## What a clean headline does not mean

"No known issues found." means nothing in the checks that ran turned up a finding. It does not mean the token is good. It means nothing was found.

## The residue screen is V1 only

A V1 keyset ID reduces to a 31-bit residue, and two different IDs can share one. That is what the screen catches. V2 and V3 keysets use different derivations, so they are excluded from the screen. A V2 or V3 keyset is not screened for collisions.

The screen covers only the keyset lists you supply: the token's keysets, the mint's keysets, and any trusted keysets you add. It cannot prove that no collision exists elsewhere.

## DLEQ is optional

A proof with no DLEQ is still valid spendable ecash. DLEQ proves the mint owns its key. It never proves the mint is honest. A proof with a partial DLEQ is treated as having no DLEQ.

Keysets with prefix 02 are V3 keysets. Their BLS12-381 signatures use pairing verification, not secp256k1 DLEQ, and this tool does not check them. A cashuA token is a token encoding format and may contain keysets of different keyset versions.

## The mint's answer is a snapshot

When you turn on "Ask the mint", the mint answers spent, pending, or unspent. That is its word at one moment. A proof can be spent the moment after. The answer does not stay true.

Asking the mint discloses what you hold. The mint learns which proofs you have. Do not ask for a token you want to keep private from that mint.

## What this tool can never prove

That the mint is honest. That the mint is solvent. That the proofs stay unspent after the check. That no collision exists outside the lists you supplied.

## What this tool never does

It never spends, signs, derives, or holds proofs. It never keeps your token. The check runs locally, and the mint is contacted only when you ask.
