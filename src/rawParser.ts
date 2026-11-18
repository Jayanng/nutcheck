// Raw token parser. Reads the token bytes directly, so NutCheck can see
// an incomplete DLEQ block and can tell when a token names more than one
// mint. It also reads tokens carrying a V3 keyset, so the report can still
// show the facts and mark the signatures as not checked instead of failing
// outright.
import cbor from 'cbor';
import { classifyKeysetVersion } from './keysetVersion.js';

export interface RawDleq {
  present: boolean;
  e: boolean;
  s: boolean;
  r: boolean;
  eHex: string | undefined;
  sHex: string | undefined;
  rHex: string | undefined;
  malformed: boolean;
}

export interface RawProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq: RawDleq;
}

export interface RawToken {
  format: 'cashuA' | 'cashuB';
  mints: string[];
  unit: string | undefined;
  memo: string | undefined;
  proofs: RawProof[];
  keysetIds: string[];
}

export class TokenParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHex(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  throw new TokenParseError('expected bytes');
}

function dleqMemberHex(value: unknown, bytesOnly: boolean): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (bytesOnly) {
    // A DLEQ scalar is 32 bytes per NUT-12. Any other length is malformed.
    if (
      (Buffer.isBuffer(value) || value instanceof Uint8Array) &&
      value.length === 32
    ) {
      return Buffer.from(value).toString('hex');
    }
    return undefined;
  }
  // A DLEQ scalar is 64 hex chars (32 bytes) per NUT-12.
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }
  return undefined;
}

function dleqPresence(value: unknown, bytesOnly = false): RawDleq {
  const none: RawDleq = {
    present: false,
    e: false,
    s: false,
    r: false,
    eHex: undefined,
    sHex: undefined,
    rHex: undefined,
    malformed: false,
  };
  if (value === undefined || value === null) {
    return none;
  }
  if (!isRecord(value)) {
    // The DLEQ field is present but malformed (a scalar or an array, not a
    // map). It counts as present so the report flags it as incomplete
    // instead of silently treating it as absent.
    return { present: true, e: false, s: false, r: false, eHex: undefined, sHex: undefined, rHex: undefined, malformed: true };
  }
  const eHex = dleqMemberHex(value.e, bytesOnly);
  const sHex = dleqMemberHex(value.s, bytesOnly);
  const rHex = dleqMemberHex(value.r, bytesOnly);
  const malformed =
    (value.e !== undefined && eHex === undefined) ||
    (value.s !== undefined && sHex === undefined) ||
    (value.r !== undefined && rHex === undefined);
  return {
    present: true,
    e: eHex !== undefined,
    s: sHex !== undefined,
    r: rHex !== undefined,
    eHex,
    sHex,
    rHex,
    malformed,
  };
}

function requireValidAmount(amount: unknown, field: string): number {
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    throw new TokenParseError(`${field} must be a finite, non-negative safe integer`);
  }
  return amount;
}

function assertBase64Url(payload: string): void {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(payload)) {
    throw new TokenParseError('payload is not valid base64url');
  }
}

function decodeBase64Url(payload: string): Buffer {
  // The browser Buffer polyfill does not support the 'base64url' encoding
  // (it throws "Unknown encoding: base64url"), so convert the payload to
  // standard base64 first. The polyfill does support 'base64'. The payload
  // was already checked by assertBase64Url, so it holds only base64url
  // characters and at most two trailing '='.
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function requireBytes(value: unknown, field: string): void {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TokenParseError(`cashuB field ${field} must be bytes, not a string or number`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TokenParseError(`${field} must be a string`);
  }
  return value;
}

export function stripUriPrefix(token: string): string {
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith('cashu:')) {
    return trimmed.slice('cashu:'.length);
  }
  return trimmed;
}

export async function parseTokenRaw(tokenString: string): Promise<RawToken> {
  if (typeof tokenString !== 'string' || tokenString.trim() === '') {
    throw new TokenParseError('token must be a non-empty string');
  }
  const token = stripUriPrefix(tokenString);
  const lower = token.toLowerCase();
  if (lower.startsWith('creqa') || lower.startsWith('creqb')) {
    throw new TokenParseError(
      'this is a payment request (creqA or creqB), not a Cashu token; paste a cashuA or cashuB token',
    );
  }
  if (token.startsWith('cashuA')) {
    return parseV3(token.slice('cashuA'.length));
  }
  if (token.startsWith('cashuB')) {
    return parseV4(token.slice('cashuB'.length));
  }
  throw new TokenParseError('token must start with cashuA or cashuB');
}

function parseV3(payload: string): RawToken {
  assertBase64Url(payload);
  let json: unknown;
  try {
    json = JSON.parse(decodeBase64Url(payload).toString('utf8'));
  } catch {
    throw new TokenParseError('cashuA payload is not valid base64url JSON');
  }
  if (!isRecord(json) || !Array.isArray(json.token) || json.token.length === 0) {
    throw new TokenParseError('cashuA payload has no token list');
  }
  const mints: string[] = [];
  const proofs: RawProof[] = [];
  const keysetIds: string[] = [];
  for (const entry of json.token) {
    if (
      !isRecord(entry) ||
      typeof entry.mint !== 'string' ||
      entry.mint.trim() === '' ||
      !Array.isArray(entry.proofs) ||
      entry.proofs.length === 0
    ) {
      throw new TokenParseError('cashuA token entry has no mint or proofs');
    }
    if (!mints.includes(entry.mint)) {
      mints.push(entry.mint);
    }
    for (const proof of entry.proofs) {
      if (!isRecord(proof)) {
        throw new TokenParseError('cashuA proof is not an object');
      }
      if (
        typeof proof.id !== 'string' ||
        proof.id === '' ||
        !/^[0-9a-fA-F]+$/.test(proof.id) ||
        (proof.id.length !== 16 && proof.id.length !== 66) ||
        typeof proof.amount !== 'number' ||
        typeof proof.secret !== 'string' ||
        proof.secret === '' ||
        typeof proof.C !== 'string' ||
        proof.C === ''
      ) {
        throw new TokenParseError('cashuA proof is missing id, amount, secret or C');
      }
      const proofId = proof.id;
      if (!keysetIds.some((existing) => existing.toLowerCase() === proofId.toLowerCase())) {
        keysetIds.push(proofId);
      }
      proofs.push({
        id: proofId,
        amount: requireValidAmount(proof.amount, 'cashuA proof amount'),
        secret: proof.secret,
        C: proof.C,
        dleq: dleqPresence(proof.dleq),
      });
    }
  }
  return {
    format: 'cashuA',
    mints,
    unit:
      json.unit === undefined || json.unit === null
        ? undefined
        : requireString(json.unit, 'cashuA unit'),
    memo:
      json.memo === undefined || json.memo === null
        ? undefined
        : requireString(json.memo, 'cashuA memo'),
    proofs,
    keysetIds,
  };
}

async function parseV4(payload: string): Promise<RawToken> {
  assertBase64Url(payload);
  let items: unknown[];
  try {
    items = cbor.decodeAllSync(decodeBase64Url(payload));
  } catch {
    throw new TokenParseError('cashuB payload is not valid base64url CBOR');
  }
  if (items.length !== 1) {
    throw new TokenParseError('cashuB payload must hold exactly one CBOR item');
  }
  const decoded = items[0];
  if (!isRecord(decoded) || !Array.isArray(decoded.t) || decoded.t.length === 0) {
    throw new TokenParseError('cashuB payload has no token list');
  }
  if (typeof decoded.m !== 'string' || decoded.m.trim() === '') {
    throw new TokenParseError('cashuB token has no mint');
  }
  const mints: string[] = [decoded.m];
  const proofs: RawProof[] = [];
  const keysetIds: string[] = [];
  for (const entry of decoded.t) {
    if (!isRecord(entry) || !Array.isArray(entry.p) || entry.p.length === 0) {
      throw new TokenParseError('cashuB token entry has no proofs');
    }
    requireBytes(entry.i, 'keyset id');
    const keysetId = toHex(entry.i);
    // NUT-00 stores the short 8-byte id in a cashuB token, but the
    // library also accepts a full 33-byte V2 or V3 id in the same field.
    // Accept both, so a token the library decodes is not rejected here.
    // A full id must be a valid V2 or V3 id; anything else is malformed.
    if (keysetId === '' || (keysetId.length !== 16 && keysetId.length !== 66)) {
      throw new TokenParseError('cashuB token entry has an empty or malformed keyset id');
    }
    if (keysetId.length === 66 && classifyKeysetVersion(keysetId) === 'unknown') {
      throw new TokenParseError('cashuB token entry has an empty or malformed keyset id');
    }
    if (!keysetIds.includes(keysetId)) {
      keysetIds.push(keysetId);
    }
    for (const proof of entry.p) {
      if (!isRecord(proof)) {
        throw new TokenParseError('cashuB proof is not an object');
      }
      if (
        typeof proof.a !== 'number' ||
        typeof proof.s !== 'string' ||
        proof.s === '' ||
        proof.c === undefined ||
        proof.c === null
      ) {
        throw new TokenParseError('cashuB proof is missing amount, secret or C');
      }
      requireBytes(proof.c, 'commitment C');
      if ((Buffer.isBuffer(proof.c) || proof.c instanceof Uint8Array) && proof.c.length === 0) {
        throw new TokenParseError('cashuB proof has an empty commitment C');
      }
      proofs.push({
        id: keysetId,
        amount: requireValidAmount(proof.a, 'cashuB proof amount'),
        secret: proof.s,
        C: toHex(proof.c),
        dleq: dleqPresence(proof.d, true),
      });
    }
  }
  return {
    format: 'cashuB',
    mints,
    unit:
      decoded.u === undefined || decoded.u === null
        ? undefined
        : requireString(decoded.u, 'cashuB unit'),
    memo:
      decoded.d === undefined || decoded.d === null
        ? undefined
        : requireString(decoded.d, 'cashuB memo'),
    proofs,
    keysetIds,
  };
}
