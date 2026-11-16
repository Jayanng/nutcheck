// DLEQ verification. Verifies (e, s) for every proof that carries
// DLEQ, against the keyset pubkey, using the library's hasValidDleq. The
// NUT-12 test vectors are the source of truth. Outcomes:
// - Absent DLEQ: "no DLEQ present, signatures cannot be verified offline".
//   Never RED.
// - Invalid DLEQ: RED, "signatures do not match the advertised key".
// - Valid DLEQ: reported as key consistency only, never as evidence of
//   honesty. DLEQ proves the mint used the same key for the public key
//   and the signature; a mint that owns its key passes DLEQ.
// - V3: skipped here (see the decoder). V3 signatures are not checked.
import { hasValidDleq, Amount, pointFromHex } from '@cashu/cashu-ts';
import { classifyKeysetVersion } from './keysetVersion.js';

export interface DleqProofInput {
  amount: number;
  id: string;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r?: string };
}

export interface KeysetKeys {
  id: string;
  unit: string;
  keys: Record<string, string>;
}

export type DleqOutcome = 'valid' | 'invalid' | 'absent' | 'incomplete' | 'not-checked';

export interface DleqCheck {
  proofIndex: number;
  outcome: DleqOutcome;
  // 'red' only for invalid DLEQ. Absent is never RED. Valid is key
  // consistency only, never evidence of honesty.
  severity: 'red' | 'none';
  message: string;
}

export function verifyProofDleq(
  proof: DleqProofInput,
  proofIndex: number,
  keyset: KeysetKeys | undefined,
): DleqCheck {
  const version = classifyKeysetVersion(proof.id);
  if (version === 'v3') {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: 'V3 signatures are not checked; the proof carries a V3 keyset',
    };
  }
  if (!proof.dleq) {
    return {
      proofIndex,
      outcome: 'absent',
      severity: 'none',
      message: 'no DLEQ present, signatures cannot be verified offline',
    };
  }
  // A DLEQ block that is present but missing e or s is incomplete, not
  // absent. The proof carries a DLEQ that cannot be verified as written.
  if (!proof.dleq.e || !proof.dleq.s) {
    return {
      proofIndex,
      outcome: 'incomplete',
      severity: 'none',
      message: 'DLEQ is present but incomplete (e or s missing), so the proof cannot be verified',
    };
  }
  // Verifying a received proof needs the blinding factor r to rebuild
  // the blinded message and blind signature (NUT-12, Carol's check).
  // Without r the proof cannot be verified offline, and that is not
  // evidence the signatures are wrong, so it is not-checked, never RED.
  if (!proof.dleq.r) {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message:
        'DLEQ is present but the blinding factor r is missing, so the proof cannot be verified offline',
    };
  }
  if (!keyset) {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: 'the keyset for this proof was not supplied, so DLEQ was not verified',
    };
  }
  // The keyset must belong to this proof. The library does not check
  // that keyset.id matches proof.id, so a wrong keyset could return a
  // misleading valid result. Compare case-insensitively, the same as the
  // derivation check: an uppercase spelling of the same ID is the same
  // keyset.
  if (keyset.id.toLowerCase() !== proof.id.toLowerCase()) {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: 'the supplied keyset does not belong to this proof, so DLEQ was not verified',
    };
  }
  // DLEQ verification needs the mint public key for the proof's amount.
  // If the keyset has no key for that amount, or the key is not a usable
  // curve point, the proof cannot be verified, and that is not evidence
  // the signatures are wrong. The format check alone is not enough: a
  // correctly formatted hex string can still be off the curve, so the
  // key is parsed as a point before verification runs.
  const amountKey = keyset.keys[String(proof.amount)];
  if (!amountKey) {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: `the keyset has no public key for amount ${proof.amount}, so DLEQ was not verified`,
    };
  }
  try {
    pointFromHex(amountKey);
  } catch {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: `the keyset public key for amount ${proof.amount} is not a usable point, so DLEQ was not verified`,
    };
  }
  // The proof's own C must be a usable curve point too. A malformed C
  // makes hasValidDleq return false, which would be mapped to RED, but
  // an unusable point is not a demonstrated invalid DLEQ, it is a proof
  // that cannot be verified. RED is reserved for a DLEQ that ran and
  // failed, so a bad C is not-checked, never RED.
  try {
    pointFromHex(proof.C);
  } catch {
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: 'the proof C is not a usable point, so DLEQ was not verified',
    };
  }
  let valid: boolean;
  try {
    valid = hasValidDleq(
      {
        amount: Amount.from(proof.amount),
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
        dleq: { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r },
      },
      keyset,
    );
  } catch {
    // Verification could not be performed. That is not evidence the
    // DLEQ is invalid, so it is not-checked, never RED. RED is reserved
    // for a DLEQ that ran and failed.
    return {
      proofIndex,
      outcome: 'not-checked',
      severity: 'none',
      message: 'DLEQ verification could not be performed, so the proof was not verified',
    };
  }
  if (valid) {
    return {
      proofIndex,
      outcome: 'valid',
      severity: 'none',
      message:
        'DLEQ is valid: the mint used the same key for the public key and the signature. This proves key consistency only, never honesty.',
    };
  }
  return {
    proofIndex,
    outcome: 'invalid',
    severity: 'red',
    message: 'DLEQ verification failed against the advertised key',
  };
}
