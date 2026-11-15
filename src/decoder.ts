// Decoder: turns a Cashu token string into a decoded token plus findings.
// An empty keyset list is refused outright. A token naming more than one
// mint is rejected, not worked around. A token carrying a V3 keyset is
// reported with its signatures marked as not checked, with the reason.
// When a token mixes V3 and V1/V2 proofs, the V1/V2 proofs are still
// checked for incomplete DLEQ, so a V3 proof cannot hide a bad V1/V2
// proof in the same token. This step checks that DLEQ fields are present
// and well formed; checking a DLEQ proof itself is a later step, and a
// complete DLEQ here means structurally complete, not yet verified.
import { getDecodedToken } from '@cashu/cashu-ts';
import {
  parseTokenRaw,
  stripUriPrefix,
  TokenParseError,
  type RawProof,
  type RawToken,
} from './rawParser.js';
import { classifyKeysetVersion } from './keysetVersion.js';

export class MissingKeysetListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingKeysetListError';
  }
}

export class MultiMintTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiMintTokenError';
  }
}

export class V3KeysetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3KeysetError';
  }
}

export class MissingKeysetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingKeysetError';
  }
}

export interface DecodedProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq: { e: string; s: string; r?: string } | undefined;
}

export interface DecodedToken {
  mint: string;
  unit: string | undefined;
  memo: string | undefined;
  proofs: DecodedProof[];
}

export interface Finding {
  code: 'dleq-incomplete' | 'v3-not-checked' | 'decode-failed' | 'not-checked';
  message: string;
  proofIndex?: number;
}

export type DecodeResult =
  | { status: 'decoded'; token: DecodedToken; findings: Finding[] }
  | {
      status: 'v3-not-checked';
      mint: string;
      unit: string | undefined;
      memo: string | undefined;
      proofs: RawProof[];
      findings: Finding[];
    }
  | {
      status: 'decode-failed';
      token: DecodedToken;
      findings: Finding[];
    };

function requireKeysetList(keysetIds: readonly string[]): void {
  if (
    !Array.isArray(keysetIds) ||
    keysetIds.length === 0 ||
    keysetIds.some((id) => typeof id !== 'string' || id.trim() === '')
  ) {
    throw new MissingKeysetListError(
      'a non-empty keyset list is required; decoding never falls back to an empty list',
    );
  }
}

function hasV3Keyset(raw: RawToken): boolean {
  return raw.keysetIds.some((id) => classifyKeysetVersion(id) === 'v3');
}

function requireKeysetsCoverToken(raw: RawToken, keysetIds: readonly string[]): void {
  for (const tokenId of raw.keysetIds) {
    // A token keyset whose version is unknown (for example an 8-byte id
    // starting with 03) is not a missing keyset, it is a version NutCheck
    // does not know. Report it as such instead of claiming the keyset list
    // is incomplete.
    if (classifyKeysetVersion(tokenId) === 'unknown') {
      throw new TokenParseError(
        `keyset ${tokenId} in the token has an unknown keyset version; only V1, V2 and V3 keysets are supported`,
      );
    }
    const matches = keysetIds.filter((supplied) => {
      // A supplied id with an unknown version (for example a 66-char id
      // starting with 00, which is not a valid V2 or V3 id) can never cover
      // a token keyset.
      if (classifyKeysetVersion(supplied) === 'unknown') {
        return false;
      }
      const a = supplied.toLowerCase();
      const b = tokenId.toLowerCase();
      if (a === b) {
        return true;
      }
      // A short (16-char) id is covered by a longer id that starts with it,
      // or a longer id is covered by the 16-char short id that starts it.
      // The shorter side must be exactly 16 chars, so a 1- or 2-character
      // prefix cannot satisfy coverage.
      if (b.length === 16 && a.startsWith(b)) {
        return true;
      }
      if (a.length === 16 && b.startsWith(a)) {
        return true;
      }
      return false;
    });
    // Duplicate entries of the same keyset in the supplied list are one
    // keyset, not ambiguity. A short form and a full form of the same
    // keyset are the same keyset, but only when the short form is a
    // valid 16-char id and the full form is a valid V2 or V3 id that
    // begins with it. Two different full ids sharing a prefix are
    // still ambiguous, and a malformed value never discards a valid one.
    const normalized = matches.map((m) => m.toLowerCase());
    const deduped = normalized.filter((m) => {
      if (m.length !== 16 || !/^[0-9a-f]{16}$/.test(m)) {
        return true;
      }
      return !normalized.some(
        (other) =>
          other.length === 66 &&
          /^[0-9a-f]{66}$/.test(other) &&
          (other.startsWith('01') || other.startsWith('02')) &&
          other.startsWith(m),
      );
    });
    const uniqueMatches = [...new Set(deduped)];
    if (uniqueMatches.length === 0) {
      throw new MissingKeysetError(
        `keyset ${tokenId} in the token is not in the supplied keyset list; the mint's full keyset list is required`,
      );
    }
    // For a V2 or V3 token keyset, the library needs the full 66-char
    // id to decode the token. A supplied short id alone cannot cover
    // it, even when it matches the prefix, because the library cannot
    // map the short form without the full id. V1 keysets are 16 chars,
    // so a short id is the full id for them.
    const version = classifyKeysetVersion(tokenId);
    if (version === 'v2' || version === 'v3') {
      const hasFull = uniqueMatches.some((m) => m.length === 66);
      if (!hasFull) {
        throw new MissingKeysetError(
          `keyset ${tokenId} in the token needs its full keyset id in the supplied list; the mint's full keyset list is required`,
        );
      }
    }
    // For a V3 token keyset, an ambiguous short id is left unresolved.
    // For a V1/V2 keyset, ambiguity is rejected rather than letting one
    // keyset be picked silently.
    if (classifyKeysetVersion(tokenId) !== 'v3' && uniqueMatches.length > 1) {
      throw new MissingKeysetError(
        `keyset ${tokenId} in the token matches more than one supplied keyset; the keyset list is ambiguous`,
      );
    }
  }
}

function resolveKeysetId(id: string, keysetIds: readonly string[]): string {
  const short = id.toLowerCase();
  if (short.length !== 16) {
    return id;
  }
  const matches = keysetIds.filter(
    (candidate) =>
      classifyKeysetVersion(candidate) !== 'unknown' &&
      candidate.toLowerCase().startsWith(short) &&
      candidate.length > 16,
  );
  // Duplicate entries of the same full id are one keyset, not ambiguity.
  const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
  if (unique.length === 1) {
    return matches[0];
  }
  return id;
}

function idsMatch(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) {
    return true;
  }
  if (lowerA.length === 16 && lowerB.startsWith(lowerA)) {
    return true;
  }
  if (lowerB.length === 16 && lowerA.startsWith(lowerB)) {
    return true;
  }
  return false;
}

function decodeWithLibrary(tokenString: string, keysetIds: readonly string[]): DecodedToken {
  // The library treats a short form and a full form of the same keyset
  // as two different keysets sharing a prefix, and throws ambiguous.
  // It also treats a malformed full-length entry sharing the prefix
  // as a competing keyset. So the list handed to the library holds
  // only valid keyset ids, with a short form dropped when a valid
  // V2 or V3 full id with the same prefix is present. Coverage was
  // already verified, so dropping an invalid entry cannot hide a
  // missing keyset.
  const valid = keysetIds.filter((id) => classifyKeysetVersion(id) !== 'unknown');
  const normalized = valid.filter((id) => {
    const lower = id.toLowerCase();
    if (lower.length !== 16 || !/^[0-9a-f]{16}$/.test(lower)) {
      return true;
    }
    return !valid.some((other) => {
      const otherLower = other.toLowerCase();
      return (
        otherLower.length === 66 &&
        /^[0-9a-f]{66}$/.test(otherLower) &&
        (otherLower.startsWith('01') || otherLower.startsWith('02')) &&
        otherLower.startsWith(lower)
      );
    });
  });
  const decoded = getDecodedToken(stripUriPrefix(tokenString), normalized);
  return {
    mint: decoded.mint,
    unit: decoded.unit,
    memo: decoded.memo,
    proofs: decoded.proofs.map((proof) => {
      const amount = proof.amount.toNumber();
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new TokenParseError('the decoded token has an amount that is not a safe integer');
      }
      // A DLEQ with any member missing is incomplete, so the whole block
      // is reported as absent rather than half populated.
      const dleq = proof.dleq;
      const dleqComplete =
        dleq !== undefined &&
        dleq.e !== undefined &&
        dleq.s !== undefined &&
        dleq.r !== undefined;
      return {
        id: proof.id,
        amount,
        secret: proof.secret,
        C: proof.C,
        dleq: dleqComplete
          ? { e: dleq.e, s: dleq.s, r: dleq.r }
          : undefined,
      };
    }),
  };
}

export async function decodeToken(
  tokenString: string,
  keysetIds: readonly string[],
): Promise<DecodedToken> {
  // decodeToken decodes a token directly. It returns a plain decoded
  // token and throws for V3 keysets, because V3 signatures are not checked.
  // For a diagnostic result that labels V3 as not checked instead of
  // throwing, use decodeAndReconcile.
  requireKeysetList(keysetIds);
  const raw = await parseTokenRaw(tokenString);
  if (raw.mints.length > 1) {
    throw new MultiMintTokenError(
      'token names more than one mint; multi-mint tokens are rejected',
    );
  }
  requireKeysetsCoverToken(raw, keysetIds);
  if (hasV3Keyset(raw)) {
    throw new V3KeysetError(
      'token carries a V3 keyset; V3 signatures are not checked',
    );
  }
  if (raw.proofs.some((proof) => proof.dleq.malformed)) {
    throw new TokenParseError('the token carries a malformed DLEQ member');
  }
  return decodeWithLibrary(tokenString, keysetIds);
}

export function reconcileToken(raw: RawToken, decoded: DecodedToken): Finding[] {
  const findings: Finding[] = [];
  if (raw.mints.length !== 1 || raw.mints[0] !== decoded.mint) {
    throw new TokenParseError('the decoded token names a different mint than the token holds');
  }
  // The library defaults a missing unit to sat, while the raw parse
  // reports it as absent. Only a mismatch between two present values,
  // or a unit or memo the token holds that the decoded token dropped,
  // is a real disagreement. A missing unit or memo in the token is not
  // a disagreement with the library's default.
  if (
    (raw.unit !== undefined && decoded.unit === undefined) ||
    (raw.unit !== undefined && decoded.unit !== undefined && raw.unit !== decoded.unit) ||
    (raw.memo !== undefined && decoded.memo === undefined) ||
    (raw.memo !== undefined && decoded.memo !== undefined && raw.memo !== decoded.memo)
  ) {
    throw new TokenParseError('the decoded token has a different unit or memo than the token holds');
  }
  if (raw.proofs.length !== decoded.proofs.length) {
    throw new TokenParseError(
      'the decoded token has a different number of proofs than the token holds',
    );
  }
  for (let index = 0; index < raw.proofs.length; index++) {
    const rawProof = raw.proofs[index];
    const keptProof = decoded.proofs[index];
    if (!idsMatch(rawProof.id, keptProof.id)) {
      throw new TokenParseError(
        'the decoded proof at an index does not match the token proof at the same index',
      );
    }
    if (
      rawProof.amount !== keptProof.amount ||
      rawProof.secret !== keptProof.secret ||
      rawProof.C.toLowerCase() !== keptProof.C.toLowerCase()
    ) {
      throw new TokenParseError(
        'the decoded proof at an index does not match the token proof at the same index',
      );
    }
    const kept = keptProof.dleq;
    // A DLEQ scalar is 64 hex chars (32 bytes) per NUT-12; a shorter
    // string is not a complete scalar even if it is non-empty.
    const isCompleteScalar = (value: unknown): boolean =>
      typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
    const keptComplete =
      kept !== undefined &&
      isCompleteScalar(kept.e) &&
      isCompleteScalar(kept.s) &&
      isCompleteScalar(kept.r);
    if (rawProof.dleq.present && !keptComplete) {
      findings.push({
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: index,
      });
    }
    if (!rawProof.dleq.present && kept !== undefined) {
      throw new TokenParseError(
        'the decoded token carries a DLEQ block that the token does not hold',
      );
    }
  }
  return findings;
}

function v3NotCheckedResult(raw: RawToken, keysetIds: readonly string[]): DecodeResult {
  const findings: Finding[] = [];
  const proofs: RawProof[] = raw.proofs.map((proof, index) => {
    const resolved: RawProof = { ...proof, id: resolveKeysetId(proof.id, keysetIds) };
    if (classifyKeysetVersion(proof.id) === 'v3') {
      findings.push({
        code: 'v3-not-checked',
        message:
          'V3 signatures are not checked: BLS12-381 pairing is not verified',
        proofIndex: index,
      });
      return resolved;
    }
    const dleq = proof.dleq;
    if (dleq.present && !(dleq.e && dleq.s && dleq.r)) {
      findings.push({
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: index,
      });
    } else if (dleq.present) {
      // A V1/V2 proof in a token that also carries a V3 keyset was not
      // checked, because the token could not be decoded. Its DLEQ block
      // is present and structurally complete, but that is not a
      // verification; the proof has not been verified.
      findings.push({
        code: 'not-checked',
        message:
          'DLEQ is present and complete but not verified; this proof was not checked because the token carries a V3 keyset',
        proofIndex: index,
      });
    } else {
      // This proof carries no DLEQ block at all, and it was not checked
      // because the token carries a V3 keyset.
      findings.push({
        code: 'not-checked',
        message:
          'this proof carries no DLEQ and was not checked because the token carries a V3 keyset',
        proofIndex: index,
      });
    }
    return resolved;
  });
  return {
    status: 'v3-not-checked',
    mint: raw.mints[0],
    unit: raw.unit,
    memo: raw.memo,
    proofs,
    findings,
  };
}

function decodedFromRaw(raw: RawToken, keysetIds: readonly string[]): DecodedToken {
  return {
    mint: raw.mints[0],
    unit: raw.unit,
    memo: raw.memo,
    proofs: raw.proofs.map((proof) => ({
      id: resolveKeysetId(proof.id, keysetIds),
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      dleq:
        proof.dleq.eHex !== undefined &&
        proof.dleq.sHex !== undefined &&
        proof.dleq.rHex !== undefined
          ? { e: proof.dleq.eHex, s: proof.dleq.sHex, r: proof.dleq.rHex }
          : undefined,
    })),
  };
}

function findingsFromRaw(raw: RawToken): Finding[] {
  const findings: Finding[] = [];
  raw.proofs.forEach((proof, index) => {
    const dleq = proof.dleq;
    if (dleq.present && !(dleq.e && dleq.s && dleq.r)) {
      findings.push({
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: index,
      });
    }
  });
  return findings;
}

export async function decodeAndReconcile(
  tokenString: string,
  keysetIds: readonly string[],
): Promise<DecodeResult> {
  requireKeysetList(keysetIds);
  const raw = await parseTokenRaw(tokenString);
  if (raw.mints.length > 1) {
    throw new MultiMintTokenError(
      'token names more than one mint; multi-mint tokens are rejected',
    );
  }
  requireKeysetsCoverToken(raw, keysetIds);
  if (hasV3Keyset(raw)) {
    // V3 signatures are not checked, and any V1/V2 proof in the same token
    // is still checked for incomplete DLEQ. Keyset coverage is validated
    // first, so a V3 token cannot be reported against an unrelated or
    // incomplete keyset list.
    return v3NotCheckedResult(raw, keysetIds);
  }
  const hasMalformedDleq = raw.proofs.some((proof) => proof.dleq.malformed);
  if (hasMalformedDleq) {
    // A DLEQ member of the wrong type is reported as incomplete rather
    // than aborting the diagnosis.
    return { status: 'decoded', token: decodedFromRaw(raw, keysetIds), findings: findingsFromRaw(raw) };
  }
  let decoded: DecodedToken;
  try {
    decoded = decodeWithLibrary(tokenString, keysetIds);
  } catch (error) {
    // A TokenParseError from the decoder's own validation is a hard
    // failure, not a decode failure, so it propagates. Only a library
    // rejection becomes a decode-failed result.
    if (error instanceof TokenParseError) {
      throw error;
    }
    // The token could not be decoded. The facts still come from the token
    // itself, and the failure is reported with a distinct status so the
    // report does not present it as a decoded token.
    const message = error instanceof Error ? error.message : 'the token could not be decoded';
    return {
      status: 'decode-failed',
      token: decodedFromRaw(raw, keysetIds),
      findings: [
        ...findingsFromRaw(raw),
        { code: 'decode-failed', message },
      ],
    };
  }
  return { status: 'decoded', token: decoded, findings: reconcileToken(raw, decoded) };
}
