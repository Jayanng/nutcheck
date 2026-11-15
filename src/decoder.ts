// Decoder: the wrapper around the pinned library, plus the reconciliation
// that catches what the library hides. The library needs the mint's full
// keyset list as its second argument, and it decodes silently when that list
// is empty, so this wrapper refuses an empty list outright instead of
// passing it through. A token naming more than one mint is rejected, not
// worked around. A token carrying a V3 keyset never reaches the library at
// all, because the library throws for V3 keysets; its facts come from the
// raw parse and its signatures are marked as not checked, with the reason.
// When a token mixes V3 and V1/V2 proofs, the V1/V2 proofs are still
// checked for incomplete DLEQ from the raw parse, so a V3 proof cannot hide
// a bad V1/V2 proof in the same token.
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
  code: 'dleq-incomplete' | 'v3-not-checked';
  message: string;
  proofIndex: number;
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
    const covered = keysetIds.some((supplied) => {
      const a = supplied.toLowerCase();
      const b = tokenId.toLowerCase();
      return a === b || a.startsWith(b) || b.startsWith(a);
    });
    if (!covered) {
      throw new MissingKeysetError(
        `keyset ${tokenId} in the token is not in the supplied keyset list; the mint's full keyset list is required`,
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
    (candidate) => candidate.toLowerCase().startsWith(short) && candidate.length > 16,
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return id;
}

function decodeWithLibrary(tokenString: string, keysetIds: readonly string[]): DecodedToken {
  const decoded = getDecodedToken(stripUriPrefix(tokenString), keysetIds);
  return {
    mint: decoded.mint,
    unit: decoded.unit,
    memo: decoded.memo,
    proofs: decoded.proofs.map((proof) => ({
      id: proof.id,
      amount: proof.amount.toNumber(),
      secret: proof.secret,
      C: proof.C,
      dleq:
        proof.dleq === undefined
          ? undefined
          : { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r },
    })),
  };
}

export async function decodeToken(
  tokenString: string,
  keysetIds: readonly string[],
): Promise<DecodedToken> {
  // decodeToken is the low-level library wrapper. It returns a plain decoded
  // token and throws for V3 keysets, because the pinned library cannot decode
  // them. For a diagnostic result that labels V3 as not checked instead of
  // throwing, use decodeAndReconcile.
  requireKeysetList(keysetIds);
  const raw = await parseTokenRaw(tokenString);
  if (raw.mints.length > 1) {
    throw new MultiMintTokenError(
      'token names more than one mint; multi-mint tokens are rejected',
    );
  }
  if (hasV3Keyset(raw)) {
    throw new V3KeysetError(
      'token carries a V3 keyset; V3 signatures are not checked and the token never reaches the library',
    );
  }
  requireKeysetsCoverToken(raw, keysetIds);
  return decodeWithLibrary(tokenString, keysetIds);
}

export function reconcileToken(raw: RawToken, decoded: DecodedToken): Finding[] {
  const findings: Finding[] = [];
  if (raw.proofs.length !== decoded.proofs.length) {
    throw new TokenParseError(
      'the library returned a different number of proofs than the raw token holds',
    );
  }
  for (let index = 0; index < raw.proofs.length; index++) {
    const rawProof = raw.proofs[index];
    const keptProof = decoded.proofs[index];
    if (
      rawProof.id !== keptProof.id &&
      !keptProof.id.toLowerCase().startsWith(rawProof.id.toLowerCase()) &&
      !rawProof.id.toLowerCase().startsWith(keptProof.id.toLowerCase())
    ) {
      throw new TokenParseError(
        'the library proof at an index does not match the raw proof at the same index',
      );
    }
    if (
      rawProof.amount !== keptProof.amount ||
      rawProof.secret !== keptProof.secret ||
      rawProof.C.toLowerCase() !== keptProof.C.toLowerCase()
    ) {
      throw new TokenParseError(
        'the library proof at an index does not match the raw proof at the same index',
      );
    }
    const kept = keptProof.dleq;
    const keptComplete =
      kept !== undefined && kept.e !== undefined && kept.s !== undefined && kept.r !== undefined;
    if (rawProof.dleq.present && !keptComplete) {
      findings.push({
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: index,
      });
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
          'V3 signatures are not checked: the pinned library does not verify BLS12-381 pairing',
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

function decodedFromRaw(raw: RawToken): DecodedToken {
  return {
    mint: raw.mints[0],
    unit: raw.unit,
    memo: raw.memo,
    proofs: raw.proofs.map((proof) => ({
      id: proof.id,
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
    // The pinned library throws for V3 keysets, so it is never called here.
    // The facts come from the raw parse, V3 signatures are not checked, and
    // any V1/V2 proof in the same token is still checked for incomplete DLEQ.
    // Keyset coverage is validated first, so a V3 token cannot be reported
    // against an unrelated or incomplete keyset list.
    return v3NotCheckedResult(raw, keysetIds);
  }
  try {
    const decoded = decodeWithLibrary(tokenString, keysetIds);
    return { status: 'decoded', token: decoded, findings: reconcileToken(raw, decoded) };
  } catch {
    // The library throws for a malformed DLEQ member (for example a DLEQ
    // field of the wrong CBOR type) instead of dropping it silently. The
    // token facts still come from the raw parse, and the malformed DLEQ is
    // reported as incomplete rather than aborting the diagnosis.
    return { status: 'decoded', token: decodedFromRaw(raw), findings: findingsFromRaw(raw) };
  }
}
