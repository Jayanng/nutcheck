// Decoder tests: the official NUT-00 vectors decode to their expected values,
// an empty keyset list is refused, a token with its DLEQ r removed is
// flagged, a multi-mint token is rejected, and a V3 token is reported with
// its signatures marked as not checked.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cbor from 'cbor';
import { Amount, getDecodedToken, getEncodedToken } from '@cashu/cashu-ts';
import {
  decodeAndReconcile,
  decodeToken,
  MissingKeysetError,
  MissingKeysetListError,
  MultiMintTokenError,
  reconcileToken,
  V3KeysetError,
} from '../src/decoder.js';
import { parseTokenRaw, TokenParseError } from '../src/rawParser.js';
import { classifyKeysetVersion } from '../src/keysetVersion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface FixtureProof {
  C: string;
  amount: number;
  id: string;
  secret: string;
}

interface FixtureToken {
  memo?: string;
  mint: string;
  proofs: FixtureProof[];
  token: string;
  unit: string;
}

function readVectors(): Record<string, FixtureToken> {
  return JSON.parse(
    readFileSync(path.join(root, 'tests', 'fixtures', 'nut00-vectors.json'), 'utf8'),
  ) as Record<string, FixtureToken>;
}

// Builds a 32-byte value as hex: ch is a 2-char hex pair, repeated 32 times
// gives 64 hex characters, which is 32 bytes. This is the correct size for a
// NUT-12 DLEQ scalar, a secret, and (with a 02 prefix) a compressed point.
const bytes32Hex = (ch: string): string => ch.repeat(32);
const KEYSET = '009a1f293253e41e';

function buildCompleteToken(): string {
  return getEncodedToken({
    mint: 'https://testnut.cashu.space',
    unit: 'sat',
    proofs: [
      {
        id: KEYSET,
        amount: Amount.from(1),
        secret: bytes32Hex('a1'),
        C: '02' + bytes32Hex('b2'),
        dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
      },
    ],
  });
}

async function buildMangledToken(): Promise<string> {
  const encoded = buildCompleteToken();
  const raw = await cbor.decodeFirst(
    Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
  );
  delete raw.t[0].p[0].d.r;
  const mangledBytes = await cbor.encodeAsync(raw);
  return 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
}

describe('official NUT-00 vectors', () => {
  const vectors = readVectors();

  it('decodes the v3 vector to the expected mint, unit, memo and proofs', async () => {
    const v3 = vectors.v3;
    const raw = await parseTokenRaw(v3.token);
    expect(raw.format).toBe('cashuA');
    expect(raw.mints).toEqual([v3.mint]);
    expect(raw.unit).toBe(v3.unit);
    expect(raw.memo).toBe(v3.memo);
    expect(raw.proofs).toHaveLength(2);
    const result = await decodeAndReconcile(v3.token, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.mint).toBe(v3.mint);
    expect(result.token.unit).toBe(v3.unit);
    expect(result.token.memo).toBe(v3.memo);
    expect(result.token.proofs).toEqual(
      v3.proofs.map((proof) => ({
        id: proof.id,
        amount: proof.amount,
        secret: proof.secret,
        C: proof.C,
        dleq: undefined,
      })),
    );
    expect(result.findings).toEqual([]);
  });

  it('decodes the padded v3 vector', async () => {
    const v3 = vectors.v3Padded;
    const result = await decodeAndReconcile(v3.token, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.mint).toBe(v3.mint);
    expect(result.token.memo).toBe(v3.memo);
    expect(result.token.proofs.map((proof) => proof.amount)).toEqual([2, 8]);
  });

  it('decodes the v4 single-keyset vector to the expected values', async () => {
    const v4 = vectors.v4;
    const raw = await parseTokenRaw(v4.token);
    expect(raw.format).toBe('cashuB');
    expect(raw.mints).toEqual([v4.mint]);
    expect(raw.unit).toBe(v4.unit);
    expect(raw.memo).toBe(v4.memo);
    expect(raw.proofs).toHaveLength(1);
    const result = await decodeAndReconcile(v4.token, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.mint).toBe(v4.mint);
    expect(result.token.unit).toBe(v4.unit);
    expect(result.token.memo).toBe(v4.memo);
    expect(result.token.proofs).toEqual(
      v4.proofs.map((proof) => ({
        id: proof.id,
        amount: proof.amount,
        secret: proof.secret,
        C: proof.C,
        dleq: undefined,
      })),
    );
    expect(result.findings).toEqual([]);
  });

  it('decodes the v4 multi-keyset vector', async () => {
    const v4 = vectors.v4MultiKeyset;
    const result = await decodeAndReconcile(v4.token, [
      '00ffd48b8f5ecf80',
      '00ad268c4d1f5826',
    ]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.mint).toBe(v4.mint);
    expect(result.token.proofs.map((proof) => `${proof.amount}:${proof.id}`)).toEqual([
      '1:00ffd48b8f5ecf80',
      '2:00ad268c4d1f5826',
      '1:00ad268c4d1f5826',
    ]);
  });

  it('accepts the cashu: URI prefix', async () => {
    const v4 = vectors.v4;
    const result = await decodeAndReconcile(`cashu:${v4.token}`, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });
});

describe('empty keyset list', () => {
  it('throws instead of decoding silently', async () => {
    const v4 = readVectors().v4;
    await expect(decodeToken(v4.token, [])).rejects.toThrow(MissingKeysetListError);
    await expect(decodeAndReconcile(v4.token, [])).rejects.toThrow(MissingKeysetListError);
  });

  it('throws for a list that holds only empty or blank strings', async () => {
    const v4 = readVectors().v4;
    await expect(decodeToken(v4.token, [''])).rejects.toThrow(MissingKeysetListError);
    await expect(decodeToken(v4.token, ['  '])).rejects.toThrow(MissingKeysetListError);
    await expect(decodeAndReconcile(v4.token, [''])).rejects.toThrow(MissingKeysetListError);
  });
});

describe('raw DLEQ values', () => {
  it('records the DLEQ scalars as hex so later verification can use them', async () => {
    const token = buildCompleteToken();
    const raw = await parseTokenRaw(token);
    expect(raw.proofs[0].dleq.eHex).toBe(bytes32Hex('c3'));
    expect(raw.proofs[0].dleq.sHex).toBe(bytes32Hex('d4'));
    expect(raw.proofs[0].dleq.rHex).toBe(bytes32Hex('e5'));
  });
});

describe('strict proof fields', () => {
  it('throws instead of defaulting when a proof field is missing', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1') }],
        },
      ],
    };
    const v3Encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    await expect(parseTokenRaw(v3Encoded)).rejects.toThrow(
      'cashuA proof is missing id, amount, secret or C',
    );
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[0].p[0].s;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB proof is missing amount, secret or C',
    );
  });

  it('throws for a payload with characters outside base64url', async () => {
    await expect(parseTokenRaw('cashuA!!!')).rejects.toThrow(TokenParseError);
    await expect(parseTokenRaw('cashuB!!!')).rejects.toThrow(TokenParseError);
  });
});

describe('ambiguous short keyset id', () => {
  it('leaves the short id unresolved when two full ids share the same prefix', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const otherV3 = '02' + '00'.repeat(31) + '01';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const result = await decodeAndReconcile(token, [v3Id, otherV3]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      return;
    }
    expect(result.proofs[0].id).toBe('0200000000000000');
  });
});

describe('missing keyset context', () => {
  it('throws when a token keyset is not in the supplied list', async () => {
    const v4 = readVectors().v4;
    await expect(decodeToken(v4.token, ['00ffd48b8f5ecf80'])).rejects.toThrow(
      MissingKeysetError,
    );
    await expect(decodeAndReconcile(v4.token, ['00ffd48b8f5ecf80'])).rejects.toThrow(
      MissingKeysetError,
    );
    const v4Multi = readVectors().v4MultiKeyset;
    await expect(decodeToken(v4Multi.token, ['00ad268c4d1f5826'])).rejects.toThrow(
      MissingKeysetError,
    );
  });

  it('accepts the list when every token keyset is covered', async () => {
    const v4 = readVectors().v4;
    const result = await decodeAndReconcile(v4.token, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });

  it('throws for a V3 token whose keyset is not in the supplied list', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    await expect(decodeAndReconcile(token, ['00ad268c4d1f5826'])).rejects.toThrow(
      MissingKeysetError,
    );
  });
});

describe('strict token shape', () => {
  it('rejects an empty V3 mint', async () => {
    const v3 = {
      token: [
        {
          mint: '  ',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    await expect(parseTokenRaw(encoded)).rejects.toThrow(
      'cashuA token entry has no mint or proofs',
    );
  });

  it('rejects a proof amount that is negative, fractional, non-finite or unsafe', async () => {
    // JSON turns NaN and Infinity into null, so those are caught by the
    // missing-field check; the numbers that survive JSON are tested here.
    for (const badAmount of [-1, 1.5, 2 ** 53] as const) {
      const v3 = {
        token: [
          {
            mint: 'https://testnut.cashu.space',
            proofs: [{ id: KEYSET, amount: badAmount, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
          },
        ],
      };
      const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
      await expect(parseTokenRaw(encoded)).rejects.toThrow(
        'must be a finite, non-negative safe integer',
      );
    }
    // CBOR can carry NaN and Infinity, so those are tested on a v4 token.
    const complete = buildCompleteToken();
    for (const badAmount of [Number.NaN, Number.POSITIVE_INFINITY, -5] as const) {
      const raw = await cbor.decodeFirst(
        Buffer.from(complete.slice('cashuB'.length), 'base64url'),
      );
      raw.t[0].p[0].a = badAmount;
      const mangledBytes = await cbor.encodeAsync(raw);
      const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
      await expect(parseTokenRaw(mangled)).rejects.toThrow(
        'must be a finite, non-negative safe integer',
      );
    }
  });

  it('rejects trailing bytes after the CBOR item', async () => {
    const complete = buildCompleteToken();
    const payload = Buffer.from(complete.slice('cashuB'.length), 'base64url');
    const withTrailing = Buffer.concat([payload, Buffer.from([0x01])]);
    const mangled = 'cashuB' + withTrailing.toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB payload must hold exactly one CBOR item',
    );
  });

  it('rejects a V4 keyset id or commitment given as a string instead of bytes', async () => {
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].i = '009a1f293253e41e';
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB field keyset id must be bytes',
    );
    const raw2 = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw2.t[0].p[0].c = '02' + bytes32Hex('b2');
    const mangledBytes2 = await cbor.encodeAsync(raw2);
    const mangled2 = 'cashuB' + Buffer.from(mangledBytes2).toString('base64url');
    await expect(parseTokenRaw(mangled2)).rejects.toThrow(
      'cashuB field commitment C must be bytes',
    );
  });
});

describe('incomplete DLEQ', () => {
  it('flags a token whose DLEQ r was removed from the token bytes', async () => {
    const mangled = await buildMangledToken();
    const raw = await parseTokenRaw(mangled);
    expect(raw.proofs[0].dleq).toEqual({
      present: true,
      e: true,
      s: true,
      r: false,
      eHex: bytes32Hex('c3'),
      sHex: bytes32Hex('d4'),
      rHex: undefined,
      malformed: false,
    });
    const result = await decodeAndReconcile(mangled, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.proofs[0].dleq).toBeUndefined();
    expect(result.findings).toEqual([
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 0,
      },
    ]);
  });

  it('raises no such finding for the unmangled token', async () => {
    const complete = buildCompleteToken();
    const raw = await parseTokenRaw(complete);
    expect(raw.proofs[0].dleq).toEqual({
      present: true,
      e: true,
      s: true,
      r: true,
      eHex: bytes32Hex('c3'),
      sHex: bytes32Hex('d4'),
      rHex: bytes32Hex('e5'),
      malformed: false,
    });
    const result = await decodeAndReconcile(complete, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.proofs[0].dleq).toEqual({
      e: bytes32Hex('c3'),
      s: bytes32Hex('d4'),
      r: bytes32Hex('e5'),
    });
    expect(result.findings).toEqual([]);
  });

  it('flags only the proof whose DLEQ is partial when a token has two proofs', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: bytes32Hex('a2'),
          C: '02' + bytes32Hex('b3'),
          dleq: { e: bytes32Hex('c4'), s: bytes32Hex('d5'), r: bytes32Hex('e6') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[0].p[1].d.r;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const result = await decodeAndReconcile(mangled, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.proofs[0].dleq).toEqual({
      e: bytes32Hex('c3'),
      s: bytes32Hex('d4'),
      r: bytes32Hex('e5'),
    });
    expect(result.token.proofs[1].dleq).toBeUndefined();
    expect(result.findings).toEqual([
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 1,
      },
    ]);
  });
});

describe('multi-mint tokens', () => {
  it('rejects a token naming more than one mint', async () => {
    const multi = {
      token: [
        {
          mint: 'https://mint-a.example',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
        {
          mint: 'https://mint-b.example',
          proofs: [{ id: KEYSET, amount: 2, secret: bytes32Hex('a2'), C: '02' + bytes32Hex('b3') }],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(multi)).toString('base64url');
    const raw = await parseTokenRaw(encoded);
    expect(raw.mints).toEqual(['https://mint-a.example', 'https://mint-b.example']);
    await expect(decodeAndReconcile(encoded, [KEYSET])).rejects.toThrow(MultiMintTokenError);
  });
});

describe('V3 keysets', () => {
  const v3Id = '02' + '00'.repeat(32);

  it('classifies a V3 id and reports it as not checked', async () => {
    expect(classifyKeysetVersion(v3Id)).toBe('v3');
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    // This test proves the live behavior that V3 keysets are refused by
    // the underlying decoder, which is why NutCheck reports them as not
    // checked instead of decoding them.
    expect(() => getDecodedToken(token, [v3Id])).toThrow('Unknown keyset ID version: 2');
    const raw = await parseTokenRaw(token);
    // The CBOR stores the short form of the keyset id (first 8 bytes), so
    // the token still carries that, and it still classifies as v3.
    const v3ShortId = '0200000000000000';
    expect(raw.proofs[0].id).toBe(v3ShortId);
    expect(classifyKeysetVersion(raw.proofs[0].id)).toBe('v3');
    const result = await decodeAndReconcile(token, [v3Id]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      return;
    }
    expect(result.mint).toBe('https://testnut.cashu.space');
    // The short id is resolved against the supplied keyset list, so the
    // result carries the full V3 id.
    expect(result.proofs[0].id).toBe(v3Id);
    expect(result.findings).toEqual([
      {
        code: 'v3-not-checked',
        message:
          'V3 signatures are not checked: BLS12-381 pairing is not verified',
        proofIndex: 0,
      },
    ]);
  });
});

describe('mixed V3 and V1 proofs', () => {
  it('still flags an incomplete DLEQ on a V1 proof when a V3 proof is present', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        { id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: bytes32Hex('a2'),
          C: '02' + bytes32Hex('b3'),
          dleq: { e: bytes32Hex('c4'), s: bytes32Hex('d5'), r: bytes32Hex('e6') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[1].p[0].d.r;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const result = await decodeAndReconcile(mangled, [KEYSET, v3Id]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      return;
    }
    expect(result.findings).toEqual([
      {
        code: 'v3-not-checked',
        message:
          'V3 signatures are not checked: BLS12-381 pairing is not verified',
        proofIndex: 0,
      },
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 1,
      },
    ]);
  });
});

describe('duplicate secrets', () => {
  it('flags the second proof when two proofs share a secret and only the second has an incomplete DLEQ', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        { id: KEYSET, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b3'),
          dleq: { e: bytes32Hex('c4'), s: bytes32Hex('d5'), r: bytes32Hex('e6') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[0].p[1].d.r;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const result = await decodeAndReconcile(mangled, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.findings).toEqual([
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 1,
      },
    ]);
  });
});

describe('decodeToken guards', () => {
  it('rejects a multi-mint token and a V3 token when called directly', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const multi = {
      token: [
        {
          mint: 'https://mint-a.example',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
        {
          mint: 'https://mint-b.example',
          proofs: [{ id: KEYSET, amount: 2, secret: bytes32Hex('a2'), C: '02' + bytes32Hex('b3') }],
        },
      ],
    };
    const multiEncoded =
      'cashuA' + Buffer.from(JSON.stringify(multi)).toString('base64url');
    await expect(decodeToken(multiEncoded, [KEYSET])).rejects.toThrow(MultiMintTokenError);
    const v3Token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    await expect(decodeToken(v3Token, [v3Id])).rejects.toThrow(V3KeysetError);
  });
});

describe('malformed tokens', () => {
  it('throws a clear error for a bad prefix, bad base64 and bad CBOR', async () => {
    await expect(parseTokenRaw('not a token')).rejects.toThrow(TokenParseError);
    await expect(parseTokenRaw('cashuA!!!')).rejects.toThrow(TokenParseError);
    await expect(parseTokenRaw('cashuB!!!')).rejects.toThrow(TokenParseError);
    await expect(parseTokenRaw('')).rejects.toThrow(TokenParseError);
  });

  it('rejects a v4 token with no mint and a NUT-26 payment request', async () => {
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    delete raw.m;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow('cashuB token has no mint');
    await expect(parseTokenRaw('creqAeyJwcm9vZnMiOltdfQ')).rejects.toThrow(
      'payment request',
    );
    await expect(
      parseTokenRaw('CREQB1QYQQWER9D4HNZV3NQGQQSQQQQQQQQQQRAQPSQQGQQSQQZQG9QQVXSAR5WPEN5TE0D45KUAPWV4UXZMTSD3JJUCM0D5RQQRJRDANXVET9YPCXZ7TDV4H8GXHR3TQ'),
    ).rejects.toThrow('payment request');
    await expect(parseTokenRaw('creqb1qyqqwer9d4hnzv3nqgqqsqqqqqqqqqqraqpsqqgqqsqqzqg9qqvxsar5wpen5te0d45kuapwv4uxzmtsd3jjucm0d5rq')).rejects.toThrow(
      'payment request',
    );
  });

  it('accepts an uppercase CASHU: URI prefix', async () => {
    const v4 = readVectors().v4;
    const result = await decodeAndReconcile(`CASHU:${v4.token}`, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });
});

describe('empty DLEQ block', () => {
  it('flags a proof whose DLEQ block is present but empty', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].d = {};
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const parsed = await parseTokenRaw(mangled);
    expect(parsed.proofs[0].dleq).toEqual({
      present: true,
      e: false,
      s: false,
      r: false,
      eHex: undefined,
      sHex: undefined,
      rHex: undefined,
      malformed: false,
    });
    const result = await decodeAndReconcile(mangled, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.findings).toEqual([
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 0,
      },
    ]);
  });

  it('flags a proof whose DLEQ block is a string or an array instead of a map', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    for (const bad of ['invalid', [1, 2, 3]] as const) {
      const raw = await cbor.decodeFirst(
        Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
      );
      raw.t[0].p[0].d = bad;
      const mangledBytes = await cbor.encodeAsync(raw);
      const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
      const parsed = await parseTokenRaw(mangled);
      expect(parsed.proofs[0].dleq.present).toBe(true);
      const result = await decodeAndReconcile(mangled, [KEYSET]);
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') {
        throw new Error('expected decoded');
      }
      expect(result.findings).toEqual([
        {
          code: 'dleq-incomplete',
          message: 'DLEQ incomplete, signatures cannot be verified',
          proofIndex: 0,
        },
      ]);
    }
  });

  it('flags a proof whose DLEQ member is the wrong CBOR type instead of aborting', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    for (const badMember of [
      { field: 'e', value: 1 },
      { field: 's', value: 'text' },
      { field: 'r', value: [] },
    ] as const) {
      const raw = await cbor.decodeFirst(
        Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
      );
      raw.t[0].p[0].d[badMember.field] = badMember.value;
      const mangledBytes = await cbor.encodeAsync(raw);
      const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
      const parsed = await parseTokenRaw(mangled);
      expect(parsed.proofs[0].dleq.present).toBe(true);
      expect(parsed.proofs[0].dleq[badMember.field]).toBe(false);
      const result = await decodeAndReconcile(mangled, [KEYSET]);
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') {
        throw new Error('expected decoded');
      }
      expect(result.findings).toEqual([
        {
          code: 'dleq-incomplete',
          message: 'DLEQ incomplete, signatures cannot be verified',
          proofIndex: 0,
        },
      ]);
    }
  });
});

describe('rejection is not hidden', () => {
  it('throws instead of reporting decoded when a proof has an empty secret', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].s = '';
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    // An empty secret is rejected before decoding,
    // so the token is never reported as decoded.
    await expect(decodeAndReconcile(mangled, [KEYSET])).rejects.toThrow(
      'cashuB proof is missing amount, secret or C',
    );
  });

  it('throws when a two-character prefix is passed as the keyset list', async () => {
    const v4 = readVectors().v4;
    await expect(decodeToken(v4.token, ['00'])).rejects.toThrow(MissingKeysetError);
    await expect(decodeAndReconcile(v4.token, ['00'])).rejects.toThrow(MissingKeysetError);
  });

  it('accepts the exact 16-char token keyset when it is supplied', async () => {
    const v4 = readVectors().v4;
    const result = await decodeAndReconcile(v4.token, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });
});

describe('cashuA malformed DLEQ members', () => {
  it('flags a proof whose DLEQ member is a number instead of crashing', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: 1,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
              dleq: { e: 123, s: bytes32Hex('d4'), r: bytes32Hex('e5') },
            },
          ],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const parsed = await parseTokenRaw(encoded);
    expect(parsed.proofs[0].dleq.present).toBe(true);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.malformed).toBe(true);
    const result = await decodeAndReconcile(encoded, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.findings).toEqual([
      {
        code: 'dleq-incomplete',
        message: 'DLEQ incomplete, signatures cannot be verified',
        proofIndex: 0,
      },
    ]);
  });
});

describe('amount boundary', () => {
  it('accepts the largest safe integer and rejects one above it', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: Number.MAX_SAFE_INTEGER,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
            },
          ],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const parsed = await parseTokenRaw(encoded);
    expect(parsed.proofs[0].amount).toBe(Number.MAX_SAFE_INTEGER);
    const v3Bad = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: Number.MAX_SAFE_INTEGER + 1,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
            },
          ],
        },
      ],
    };
    const encodedBad = 'cashuA' + Buffer.from(JSON.stringify(v3Bad)).toString('base64url');
    await expect(parseTokenRaw(encodedBad)).rejects.toThrow(
      'must be a finite, non-negative safe integer',
    );
  });
});

describe('payment request casing', () => {
  it('rejects mixed-case creqA and creqB', async () => {
    await expect(parseTokenRaw('CreqAeyJwcm9vZnMiOltdfQ')).rejects.toThrow('payment request');
    await expect(
      parseTokenRaw('cReQb1qyqqwer9d4hnzv3nqgqqsqqqqqqqqqqraqpsqqgqqsqqzqg9qqvxsar5wpen5te0d45kuapwv4uxzmtsd3jjucm0d5rq'),
    ).rejects.toThrow('payment request');
  });
});

describe('structural validation', () => {
  it('rejects an empty secret in cashuA and cashuB', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: '', C: '02' + bytes32Hex('b2') }],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    await expect(parseTokenRaw(encoded)).rejects.toThrow(
      'cashuA proof is missing id, amount, secret or C',
    );
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].s = '';
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB proof is missing amount, secret or C',
    );
  });

  it('rejects an empty token list and an empty proofs array', async () => {
    const v3Empty = { token: [] };
    const encodedEmpty = 'cashuA' + Buffer.from(JSON.stringify(v3Empty)).toString('base64url');
    await expect(parseTokenRaw(encodedEmpty)).rejects.toThrow('cashuA payload has no token list');
    const v3NoProofs = {
      token: [{ mint: 'https://testnut.cashu.space', proofs: [] }],
    };
    const encodedNoProofs =
      'cashuA' + Buffer.from(JSON.stringify(v3NoProofs)).toString('base64url');
    await expect(parseTokenRaw(encodedNoProofs)).rejects.toThrow(
      'cashuA token entry has no mint or proofs',
    );
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p = [];
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow('cashuB token entry has no proofs');
  });

  it('rejects a keyset id that is not 8 bytes in cashuB', async () => {
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].i = Buffer.from([0x02]);
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB token entry has an empty or malformed keyset id',
    );
  });
});

describe('DLEQ scalar validation', () => {
  it('flags a non-hex DLEQ string in cashuA as malformed', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: 1,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
              dleq: { e: 'not-hex', s: bytes32Hex('d4'), r: bytes32Hex('e5') },
            },
          ],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const parsed = await parseTokenRaw(encoded);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.malformed).toBe(true);
  });

  it('flags a DLEQ scalar that is not 32 bytes in cashuB as malformed', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].d.e = Buffer.from([0x01]);
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const parsed = await parseTokenRaw(mangled);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.malformed).toBe(true);
  });

  it('flags a null DLEQ member as malformed', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].d.e = null;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const parsed = await parseTokenRaw(mangled);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.malformed).toBe(true);
  });

  it('flags a short hex DLEQ string in cashuA as malformed', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: 1,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
              dleq: { e: '01', s: bytes32Hex('d4'), r: bytes32Hex('e5') },
            },
          ],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const parsed = await parseTokenRaw(encoded);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.malformed).toBe(true);
  });
});

describe('ambiguous keyset coverage', () => {
  it('throws when two supplied keysets share the same short prefix', async () => {
    const v2Short = '015ba18a8adcd02e';
    const fullA = v2Short + '00'.repeat(25);
    const fullB = v2Short + '11'.repeat(25);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v2Short,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    await expect(decodeToken(token, [fullA, fullB])).rejects.toThrow(MissingKeysetError);
    await expect(decodeAndReconcile(token, [fullA, fullB])).rejects.toThrow(
      MissingKeysetError,
    );
  });

  it('throws when a supplied keyset id has an unknown version', async () => {
    const v4 = readVectors().v4;
    // A 66-char id starting with 00 is not a valid V2 or V3 id, so it
    // cannot cover the token keyset.
    const malformed = '00ad268c4d1f5826' + '00'.repeat(25);
    await expect(decodeToken(v4.token, [malformed])).rejects.toThrow(MissingKeysetError);
    await expect(decodeAndReconcile(v4.token, [malformed])).rejects.toThrow(
      MissingKeysetError,
    );
  });

  it('covers a short token keyset with the matching full keyset id', async () => {
    const v2Short = '015ba18a8adcd02e';
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const clean = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v2Short,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const result = await decodeAndReconcile(clean, [v2Full]);
    expect(result.status).toBe('decoded');
  });
});

describe('keyset ambiguity in V3 results', () => {
  it('resolves a short id when the same full id is listed twice', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const result = await decodeAndReconcile(token, [v3Id, v3Id]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      throw new Error('expected v3-not-checked');
    }
    expect(result.proofs[0].id).toBe(v3Id);
  });
});

describe('empty commitment C', () => {
  it('rejects a cashuB proof with a zero-byte C', async () => {
    const complete = buildCompleteToken();
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].c = Buffer.alloc(0);
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    await expect(parseTokenRaw(mangled)).rejects.toThrow(
      'cashuB proof has an empty commitment C',
    );
  });
});

describe('duplicate supplied keyset ids', () => {
  it('does not treat the same keyset listed twice as ambiguous', async () => {
    const v4 = readVectors().v4;
    const result = await decodeAndReconcile(v4.token, ['00ad268c4d1f5826', '00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });
});

describe('unknown keyset version', () => {
  it('reports an unknown keyset version instead of a missing keyset', async () => {
    const unknownId = '03' + '00'.repeat(7);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: unknownId,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    await expect(decodeAndReconcile(token, [unknownId])).rejects.toThrow(
      'has an unknown keyset version',
    );
  });
});

describe('mint whitespace', () => {
  it('treats the same mint with trailing whitespace as a distinct mint value', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
        {
          mint: 'https://testnut.cashu.space ',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
      ],
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const parsed = await parseTokenRaw(encoded);
    expect(parsed.mints).toEqual([
      'https://testnut.cashu.space',
      'https://testnut.cashu.space ',
    ]);
    await expect(decodeAndReconcile(encoded, [KEYSET])).rejects.toThrow(MultiMintTokenError);
  });
});

describe('cashuA incomplete DLEQ is not half populated', () => {
  it('returns dleq undefined when r is missing from a cashuA token', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [
            {
              id: KEYSET,
              amount: 1,
              secret: bytes32Hex('a1'),
              C: '02' + bytes32Hex('b2'),
              dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4') },
            },
          ],
        },
      ],
      unit: 'sat',
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const result = await decodeAndReconcile(encoded, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.token.proofs[0].dleq).toBeUndefined();
    expect(result.findings).toContainEqual({
      code: 'dleq-incomplete',
      message: 'DLEQ incomplete, signatures cannot be verified',
      proofIndex: 0,
    });
  });
});

describe('invalid curve point is passed through', () => {
  it('reports a token whose C is not a valid point as decoded', async () => {
    const encoded = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: KEYSET,
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(encoded.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].p[0].c = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0)]);
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const result = await decodeAndReconcile(mangled, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.token.proofs[0].C).toBe('02' + '00'.repeat(32));
  });
});

describe('non-string unit and memo', () => {
  it('rejects a cashuA token whose unit is a number', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
      ],
      unit: 42,
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    await expect(parseTokenRaw(encoded)).rejects.toThrow('cashuA unit must be a string');
  });
});

describe('mixed V3 and V1 proofs with complete DLEQ', () => {
  it('marks a V1 proof as not checked when the token also carries a V3 keyset', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        { id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: bytes32Hex('a2'),
          C: '02' + bytes32Hex('b3'),
          dleq: { e: bytes32Hex('c4'), s: bytes32Hex('d5'), r: bytes32Hex('e6') },
        },
      ],
    });
    const result = await decodeAndReconcile(token, [KEYSET, v3Id]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      throw new Error('expected v3-not-checked');
    }
    expect(result.findings).toEqual([
      {
        code: 'v3-not-checked',
        message:
          'V3 signatures are not checked: BLS12-381 pairing is not verified',
        proofIndex: 0,
      },
      {
        code: 'not-checked',
        message:
          'DLEQ is present and complete but not verified; this proof was not checked because the token carries a V3 keyset',
        proofIndex: 1,
      },
    ]);
  });
});

describe('reconciliation failure is not decoded', () => {
  it('throws instead of returning decoded when the mint does not match', async () => {
    const raw = {
      format: 'cashuB',
      mints: ['https://testnut.cashu.space'],
      unit: 'sat',
      memo: undefined,
      proofs: [
        {
          id: KEYSET,
          amount: 1,
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { present: false, e: false, s: false, r: false, malformed: false },
        },
      ],
      keysetIds: [KEYSET],
    };
    const decoded = {
      mint: 'https://other.example',
      unit: 'sat',
      memo: undefined,
      proofs: [
        {
          id: KEYSET,
          amount: 1,
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: undefined,
        },
      ],
    };
    expect(() => reconcileToken(raw as never, decoded as never)).toThrow(
      'the decoded token names a different mint than the token holds',
    );
  });
});

describe('short and full forms of the same keyset', () => {
  it('does not call the list ambiguous when it holds both the short and full form of one V2 keyset', async () => {
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const v2Short = '015ba18a8adcd02e';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v2Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const result = await decodeAndReconcile(token, [v2Short, v2Full]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.findings).toEqual([]);
  });
});

describe('null unit and memo', () => {
  it('treats an explicit null unit as absent in a cashuA token', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
        },
      ],
      unit: null,
      memo: null,
    };
    const encoded = 'cashuA' + Buffer.from(JSON.stringify(v3)).toString('base64url');
    const raw = await parseTokenRaw(encoded);
    expect(raw.unit).toBeUndefined();
    expect(raw.memo).toBeUndefined();
  });
});

describe('keyset normalization does not discard a valid id', () => {
  it('keeps a valid full V2 id when the list also holds a malformed longer prefix', async () => {
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const malformed = '015ba18a8adcd02e' + 'zz'.repeat(25);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v2Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const result = await decodeAndReconcile(token, [v2Full, malformed]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.findings).toEqual([]);
  });
});

describe('V2/V3 keysets need their full id', () => {
  it('throws when only the short id is supplied for a V2 token keyset', async () => {
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const v2Short = '015ba18a8adcd02e';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v2Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    await expect(decodeAndReconcile(token, [v2Short])).rejects.toThrow(MissingKeysetError);
  });
});

describe('mixed token with a V1 proof carrying no DLEQ', () => {
  it('says the V1 proof carries no DLEQ instead of claiming one is present', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        { id: v3Id, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: bytes32Hex('a2'),
          C: '02' + bytes32Hex('b3'),
        },
      ],
    });
    const result = await decodeAndReconcile(token, [KEYSET, v3Id]);
    expect(result.status).toBe('v3-not-checked');
    if (result.status !== 'v3-not-checked') {
      throw new Error('expected v3-not-checked');
    }
    expect(result.findings).toContainEqual({
      code: 'not-checked',
      message:
        'this proof carries no DLEQ and was not checked because the token carries a V3 keyset',
      proofIndex: 1,
    });
  });
});

describe('token with no unit', () => {
  it('decodes a token that omits the unit instead of throwing', async () => {
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      proofs: [{ id: KEYSET, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const result = await decodeAndReconcile(token, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.findings).toEqual([]);
  });
});

describe('cashuB token with a full 33-byte keyset id', () => {
  it('accepts a V2 full id in the CBOR i field and decodes it', async () => {
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v2Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(token.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].i = Buffer.from(v2Full, 'hex');
    const bytes = await cbor.encodeAsync(raw);
    const withFullId = 'cashuB' + Buffer.from(bytes).toString('base64url');
    const parsed = await parseTokenRaw(withFullId);
    expect(parsed.keysetIds).toEqual([v2Full]);
    const result = await decodeAndReconcile(withFullId, [v2Full]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      throw new Error('expected decoded');
    }
    expect(result.token.proofs[0].id).toBe(v2Full);
    expect(result.findings).toEqual([]);
  });

  it('reports a V3 full id in the CBOR i field as not checked', async () => {
    const v3Full = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(token.slice('cashuB'.length), 'base64url'),
    );
    raw.t[0].i = Buffer.from(v3Full, 'hex');
    const bytes = await cbor.encodeAsync(raw);
    const withFullId = 'cashuB' + Buffer.from(bytes).toString('base64url');
    const result = await decodeAndReconcile(withFullId, [v3Full]);
    expect(result.status).toBe('v3-not-checked');
  });
});
