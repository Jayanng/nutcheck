// Decoder tests: the official NUT-00 vectors decode to their expected values,
// the raw parser reads the same tokens, an empty keyset list is refused, a
// token with its DLEQ r removed is flagged, a multi-mint token is rejected,
// and a V3 token never reaches the library.
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

const hex32 = (ch: string): string => ch.repeat(64);
const KEYSET = '009a1f293253e41e';

function buildCompleteToken(): string {
  return getEncodedToken({
    mint: 'https://testnut.cashu.space',
    unit: 'sat',
    proofs: [
      {
        id: KEYSET,
        amount: Amount.from(1),
        secret: hex32('a1'),
        C: '02' + hex32('b2'),
        dleq: { e: hex32('c3'), s: hex32('d4'), r: hex32('e5') },
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
    expect(raw.proofs[0].dleq.eHex).toBe(hex32('c3'));
    expect(raw.proofs[0].dleq.sHex).toBe(hex32('d4'));
    expect(raw.proofs[0].dleq.rHex).toBe(hex32('e5'));
  });
});

describe('strict proof fields', () => {
  it('throws instead of defaulting when a proof field is missing', async () => {
    const v3 = {
      token: [
        {
          mint: 'https://testnut.cashu.space',
          proofs: [{ id: KEYSET, amount: 1, secret: hex32('a1') }],
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
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') }],
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

  it('accepts the list when every token keyset is covered, short or full', async () => {
    const v4 = readVectors().v4;
    const result = await decodeAndReconcile(v4.token, ['00ad268c4d1f5826']);
    expect(result.status).toBe('decoded');
  });

  it('throws for a V3 token whose keyset is not in the supplied list', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') }],
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
          proofs: [{ id: KEYSET, amount: 1, secret: hex32('a1'), C: '02' + hex32('b2') }],
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
            proofs: [{ id: KEYSET, amount: badAmount, secret: hex32('a1'), C: '02' + hex32('b2') }],
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
    raw2.t[0].p[0].c = '02' + hex32('b2');
    const mangledBytes2 = await cbor.encodeAsync(raw2);
    const mangled2 = 'cashuB' + Buffer.from(mangledBytes2).toString('base64url');
    await expect(parseTokenRaw(mangled2)).rejects.toThrow(
      'cashuB field commitment C must be bytes',
    );
  });
});

describe('incomplete DLEQ', () => {
  it('flags a token whose DLEQ r was removed from the raw bytes', async () => {
    const mangled = await buildMangledToken();
    const raw = await parseTokenRaw(mangled);
    expect(raw.proofs[0].dleq).toEqual({
      present: true,
      e: true,
      s: true,
      r: false,
      eHex: hex32('c3'),
      sHex: hex32('d4'),
      rHex: undefined,
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
      eHex: hex32('c3'),
      sHex: hex32('d4'),
      rHex: hex32('e5'),
    });
    const result = await decodeAndReconcile(complete, [KEYSET]);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.proofs[0].dleq).toEqual({
      e: hex32('c3'),
      s: hex32('d4'),
      r: hex32('e5'),
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
          secret: hex32('a1'),
          C: '02' + hex32('b2'),
          dleq: { e: hex32('c3'), s: hex32('d4'), r: hex32('e5') },
        },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: hex32('a2'),
          C: '02' + hex32('b3'),
          dleq: { e: hex32('c4'), s: hex32('d5'), r: hex32('e6') },
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
      e: hex32('c3'),
      s: hex32('d4'),
      r: hex32('e5'),
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
          proofs: [{ id: KEYSET, amount: 1, secret: hex32('a1'), C: '02' + hex32('b2') }],
        },
        {
          mint: 'https://mint-b.example',
          proofs: [{ id: KEYSET, amount: 2, secret: hex32('a2'), C: '02' + hex32('b3') }],
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

  it('classifies a V3 id and never routes it through the library', async () => {
    expect(classifyKeysetVersion(v3Id)).toBe('v3');
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') }],
    });
    // The library itself refuses V3 keysets, so NutCheck never calls it here.
    expect(() => getDecodedToken(token, [v3Id])).toThrow('Unknown keyset ID version: 2');
    const raw = await parseTokenRaw(token);
    // The CBOR stores the short form of the keyset id (first 8 bytes), so
    // the raw parse carries that, and it still classifies as v3.
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
          'V3 signatures are not checked: the pinned library does not verify BLS12-381 pairing',
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
        { id: v3Id, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: hex32('a2'),
          C: '02' + hex32('b3'),
          dleq: { e: hex32('c4'), s: hex32('d5'), r: hex32('e6') },
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
          'V3 signatures are not checked: the pinned library does not verify BLS12-381 pairing',
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
        { id: KEYSET, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') },
        {
          id: KEYSET,
          amount: Amount.from(2),
          secret: hex32('a1'),
          C: '02' + hex32('b3'),
          dleq: { e: hex32('c4'), s: hex32('d5'), r: hex32('e6') },
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
          proofs: [{ id: KEYSET, amount: 1, secret: hex32('a1'), C: '02' + hex32('b2') }],
        },
        {
          mint: 'https://mint-b.example',
          proofs: [{ id: KEYSET, amount: 2, secret: hex32('a2'), C: '02' + hex32('b3') }],
        },
      ],
    };
    const multiEncoded =
      'cashuA' + Buffer.from(JSON.stringify(multi)).toString('base64url');
    await expect(decodeToken(multiEncoded, [KEYSET])).rejects.toThrow(MultiMintTokenError);
    const v3Token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v3Id, amount: Amount.from(1), secret: hex32('a1'), C: '02' + hex32('b2') }],
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
          secret: hex32('a1'),
          C: '02' + hex32('b2'),
          dleq: { e: hex32('c3'), s: hex32('d4'), r: hex32('e5') },
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
    expect(parsed.proofs[0].dleq).toEqual({ present: true, e: false, s: false, r: false });
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
          secret: hex32('a1'),
          C: '02' + hex32('b2'),
          dleq: { e: hex32('c3'), s: hex32('d4'), r: hex32('e5') },
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
        return;
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
          secret: hex32('a1'),
          C: '02' + hex32('b2'),
          dleq: { e: hex32('c3'), s: hex32('d4'), r: hex32('e5') },
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
        return;
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
