# Security Policy

## Reporting a vulnerability

If you find a vulnerability in NutCheck, report it privately. Do not open a public issue.

Email: jayanng300@gmail.com

We will respond within 7 days. We aim to fix the issue within 90 days of your report, and we will credit you in the fix unless you ask us not to.

## The disclosure this tool is built on

NutCheck exists because of a protocol vulnerability disclosed to the Cashu ecosystem (NUT-13). A V1 keyset ID reduces to a 31-bit residue, and two different keysets can land on the same residue. A wallet that holds proofs on one keyset and receives a token on a colliding keyset can be tricked into treating the wrong proofs as its own. The vulnerability was found in July 2025 and published on 10 January 2026.

NutCheck screens a token against that failure before the wallet swaps it. The collision it catches is real: an evil mint keyset sharing residue 1138537334 with a trusted one, filed as [cashu.me issue 629](https://github.com/cashubtc/cashu.me/issues/629) in November 2026. That filing was made privately first, to the maintainers' security contact, before it was opened as a public issue.

## What a NutCheck verdict means

A NutCheck report has three sections: Checked, Not checked, Cannot prove. The headline is one of three:

- "No known issues found." Nothing in the checks that ran turned up a finding.
- "Hold, here is why." A check found something. Do not swap the token.
- "Not fully checked." The only open items are checks that did not run, such as the mint check without consent.

A clean headline means no known issues were found in the checks that ran. The report always lists what did not run and what this tool can never prove: that the mint is honest, that the mint is solvent, that the proofs stay unspent after the check, and that no collision exists outside the lists supplied.

## Scope

NutCheck reads tokens and mint metadata. It does not spend, sign, derive, or hold proofs. It does not keep your token: the check runs locally, and the mint is contacted only when you turn on "Ask the mint", and only for the proofs you submit.

The checkstate call sends the proofs' secret hashes (Ys) to the mint. The mint learns which proofs you hold. Do not turn it on for a token you want to keep private from that mint.

## Out of scope

- Vulnerabilities in Cashu itself, in a mint, or in a wallet. Report those to the relevant project.
- The NUT-13 vulnerability. It is already disclosed; see the disclosure above.
- Issues that require a mainnet token to reproduce. NutCheck is tested on testnet only.
