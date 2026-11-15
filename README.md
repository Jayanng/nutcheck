# NutCheck

Diagnostics for Cashu tokens you have just received.

Paste a token, get a report of what can be verified about it before your wallet swaps it. The report has three sections: Checked, Not checked, Cannot prove. When nothing turns up, the headline is "no known issues found", never anything stronger.

## What it checks

- Local decoding of cashuB (v4) and cashuA (v3) tokens.
- The V1 keyset residue-collision screen, the stopgap for the January 2026 disclosure.
- Keyset ID derivation against the mint's public keys.
- DLEQ conformance.
- Proof state, only with your consent.

## What it cannot prove

That the mint is honest, that the mint is solvent, that the proofs stay unspent after this check, that no collision exists outside the lists you supplied.

## Status

Early build. The library is `@nutcheck/core`, the web report is a single static page, and the adversarial suite runs against official NUT test vectors and a local mock mint.

## AI assistance

This project was built with AI coding agents. Every shipped code path was reviewed and tested by the author.

## License

MIT. See LICENSE.
