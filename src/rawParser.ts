// Raw token parser. Reads the token bytes directly, without the library, so
// NutCheck can see what the library hides and can tell when a token names
// more than one mint. The library drops an incomplete DLEQ block on decode
// without an error, so the raw bytes are the only place that fact is visible.
// It also decodes tokens the library refuses, such as one carrying a V3
// keyset, so the report can still show the facts and mark the signatures as
// not checked instead of failing outright.
import cbor from 'cbor';

export interface RawDleq {
  present: boolean;
  e: boolean;
  s: boolean;
  r: boolean;
  eHex: string | undefined;
  sHex: string | undefined;
  rHex: string | undefined;
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
  if (typeof value === 'string') {
    return value;
  }
  throw new TokenParseError('expected a hex string or bytes');
}

function isNonEmpty(value: unknown, bytesOnly = false): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (bytesOnly) {
    return (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.length > 0;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.length > 0;
  }
  return true;
}

function toHexOrUndefined(value: unknown, bytesOnly = false): string | undefined {
  if (!isNonEmpty(value, bytesOnly)) {
    return undefined;
  }
  return toHex(value);
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
  };
  if (value === undefined || value === null) {
    return none;
  }
  if (!isRecord(value)) {
    // The DLEQ field is present but malformed (a scalar or an array, not a
    // map). It counts as present so the report flags it as incomplete
    // instead of silently treating it as absent.
    return { present: true, e: false, s: false, r: false, eHex: undefined, sHex: undefined, rHex: undefined };
  }
  return {
    present: true,
    e: isNonEmpty(value.e, bytesOnly),
    s: isNonEmpty(value.s, bytesOnly),
    r: isNonEmpty(value.r, bytesOnly),
    eHex: toHexOrUndefined(value.e, bytesOnly),
    sHex: toHexOrUndefined(value.s, bytesOnly),
    rHex: toHexOrUndefined(value.r, bytesOnly),
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

function requireBytes(value: unknown, field: string): void {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TokenParseError(`cashuB field ${field} must be bytes, not a string or number`);
  }
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
    json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TokenParseError('cashuA payload is not valid base64url JSON');
  }
  if (!isRecord(json) || !Array.isArray(json.token)) {
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
      !Array.isArray(entry.proofs)
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
        typeof proof.amount !== 'number' ||
        typeof proof.secret !== 'string' ||
        typeof proof.C !== 'string'
      ) {
        throw new TokenParseError('cashuA proof is missing id, amount, secret or C');
      }
      if (proof.id !== '' && !keysetIds.includes(proof.id)) {
        keysetIds.push(proof.id);
      }
      proofs.push({
        id: proof.id,
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
    unit: typeof json.unit === 'string' ? json.unit : undefined,
    memo: typeof json.memo === 'string' ? json.memo : undefined,
    proofs,
    keysetIds,
  };
}

async function parseV4(payload: string): Promise<RawToken> {
  assertBase64Url(payload);
  let items: unknown[];
  try {
    items = cbor.decodeAllSync(Buffer.from(payload, 'base64url'));
  } catch {
    throw new TokenParseError('cashuB payload is not valid base64url CBOR');
  }
  if (items.length !== 1) {
    throw new TokenParseError('cashuB payload must hold exactly one CBOR item');
  }
  const decoded = items[0];
  if (!isRecord(decoded) || !Array.isArray(decoded.t)) {
    throw new TokenParseError('cashuB payload has no token list');
  }
  if (typeof decoded.m !== 'string' || decoded.m === '') {
    throw new TokenParseError('cashuB token has no mint');
  }
  const mints: string[] = [decoded.m];
  const proofs: RawProof[] = [];
  const keysetIds: string[] = [];
  for (const entry of decoded.t) {
    if (!isRecord(entry) || !Array.isArray(entry.p)) {
      throw new TokenParseError('cashuB token entry has no proofs');
    }
    requireBytes(entry.i, 'keyset id');
    const keysetId = toHex(entry.i);
    if (keysetId !== '' && !keysetIds.includes(keysetId)) {
      keysetIds.push(keysetId);
    }
    for (const proof of entry.p) {
      if (!isRecord(proof)) {
        throw new TokenParseError('cashuB proof is not an object');
      }
      if (
        typeof proof.a !== 'number' ||
        typeof proof.s !== 'string' ||
        proof.c === undefined ||
        proof.c === null
      ) {
        throw new TokenParseError('cashuB proof is missing amount, secret or C');
      }
      requireBytes(proof.c, 'commitment C');
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
    unit: typeof decoded.u === 'string' ? decoded.u : undefined,
    memo: typeof decoded.d === 'string' ? decoded.d : undefined,
    proofs,
    keysetIds,
  };
}
