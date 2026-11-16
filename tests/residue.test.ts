import { describe, expect, it } from 'vitest';
import { getEncodedToken, Amount } from '@cashu/cashu-ts';
import cbor from 'cbor';
import { decodeToken } from '../src/decoder.js';
import { classifyKeysetVersion } from '../src/keysetVersion.js';
import {
  keysetResidue,
  screenResidues,
  RESIDUE_COVERAGE,
  type LabelledKeyset,
} from '../src/residue.js';

// Builds a 32-byte value as hex: ch is a 2-char hex pair, repeated 32 times
// gives 64 hex characters, which is 32 bytes.
const bytes32Hex = (ch: string): string => ch.repeat(32);

describe('keysetResidue', () => {
  it('returns 864559728 for the official NUT-13 vector 009a1f293253e41e', () => {
    expect(keysetResidue('009a1f293253e41e')).toBe(864559728);
  });

  it('uses mod (2^31 - 1), not mod 2^31, for the NUT-13 vector', () => {
    // The correct modulus gives 864559728; the wrong modulus 2^31 gives
    // 844358686. Both are computed explicitly here, so a modulus change
    // fails this test outright instead of passing a negative-only check.
    const modulus = 2n ** 31n - 1n;
    expect(Number(BigInt('0x009a1f293253e41e') % modulus)).toBe(864559728);
    expect(Number(BigInt('0x009a1f293253e41e') % (2n ** 31n))).toBe(844358686);
    expect(keysetResidue('009a1f293253e41e')).toBe(864559728);
  });

  it('throws for an id that is not a V1 id', () => {
    expect(() => keysetResidue('009a1f293253e41')).toThrow(
      'keyset id must be a V1 id',
    );
    expect(() => keysetResidue('zzzzzzzzzzzzzzzz')).toThrow(
      'keyset id must be a V1 id',
    );
    expect(() => keysetResidue('01faa294bacae5dd')).toThrow(
      'keyset id must be a V1 id',
    );
  });
});

describe('screenResidues', () => {
  it('flags the fixed colliding pair as a collision', () => {
    const keysets: LabelledKeyset[] = [
      { id: '00ec0ed941f4b5c6', source: 'token' },
      { id: '00c0d23b424b2f02', source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].residue).toBe(1137496952);
    expect(result.collisions[0].keysets).toHaveLength(2);
    expect(result.collisions[0].relationships).toEqual(['token-mint']);
    expect(result.excluded).toEqual([]);
  });

  it('recomputes the residue itself instead of trusting a written number', () => {
    const a = keysetResidue('00ec0ed941f4b5c6');
    const b = keysetResidue('00c0d23b424b2f02');
    expect(a).toBe(b);
    expect(a).toBe(1137496952);
  });

  it('does not flag a non-colliding control', () => {
    const keysets: LabelledKeyset[] = [
      { id: '009a1f293253e41e', source: 'token' },
      { id: '00456a94ab4e1c46', source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
  });

  it('does not flag the same id seen twice as a collision', () => {
    const keysets: LabelledKeyset[] = [
      { id: '009a1f293253e41e', source: 'token' },
      { id: '009a1f293253e41e', source: 'mint' },
      { id: '009a1f293253e41e', source: 'known' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
  });

  it('excludes a V2 id that shares a residue with a V1 id, with the reason shown', () => {
    // The V2 short id 01faa294bacae5dd and the V1 id 007c5bd63dc7735a both
    // reduce to residue 1052781318 when taken mod (2^31 - 1). The V2 id
    // here is the short form (16 hex characters, the first 8 bytes of a
    // full V2 id), which is the form a cashuB token carries in its keyset
    // field. The V2 id is excluded anyway, because the legacy residue
    // does not apply to V2, so no false collision is reported. The residues are computed inline here, since
    // keysetResidue only accepts V1 ids.
    const modulus = 2n ** 31n - 1n;
    const residueOf = (hex: string): number =>
      Number(BigInt(`0x${hex}`) % modulus);
    expect(residueOf('007c5bd63dc7735a')).toBe(1052781318);
    expect(residueOf('01faa294bacae5dd')).toBe(1052781318);
    const keysets: LabelledKeyset[] = [
      { id: '007c5bd63dc7735a', source: 'token' },
      { id: '01faa294bacae5dd', source: 'token' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].id).toBe('01faa294bacae5dd');
    expect(result.excluded[0].reason).toContain('legacy residue check does not apply');
  });

  it('excludes a full 66-char V2 id with the reason shown', () => {
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const keysets: LabelledKeyset[] = [
      { id: '009a1f293253e41e', source: 'token' },
      { id: v2Full, source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].id).toBe(v2Full);
    expect(result.excluded[0].reason).toContain('legacy residue check does not apply');
  });

  it('excludes a V3 id with the reason shown', () => {
    const v3Full = '02' + '00'.repeat(32);
    const keysets: LabelledKeyset[] = [
      { id: '009a1f293253e41e', source: 'token' },
      { id: v3Full, source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].id).toBe(v3Full);
    expect(result.excluded[0].reason).toContain('BLS12-381');
  });

  it('carries the coverage line in the output object itself', () => {
    const result = screenResidues([]);
    expect(result.coverage).toBe(RESIDUE_COVERAGE);
    expect(result.coverage).toContain('covers only the keyset lists supplied');
    expect(result.coverage).toContain('cannot prove that no collision exists elsewhere');
  });

  it('keeps the source label on each keyset in a collision', () => {
    const keysets: LabelledKeyset[] = [
      { id: '00ec0ed941f4b5c6', source: 'token' },
      { id: '00c0d23b424b2f02', source: 'known' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions[0].keysets).toEqual([
      { id: '00ec0ed941f4b5c6', source: 'token' },
      { id: '00c0d23b424b2f02', source: 'known' },
    ]);
    expect(result.collisions[0].relationships).toEqual(['token-known']);
  });

  it('excludes an unknown-version id with the reason shown', () => {
    const keysets: LabelledKeyset[] = [
      { id: '009a1f293253e41e', source: 'token' },
      { id: '03' + '00'.repeat(7), source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].id).toBe('03' + '00'.repeat(7));
    expect(result.excluded[0].reason).toContain('unknown version');
  });

  it('reports two colliding ids each appearing in more than one source, with all labels kept', () => {
    const keysets: LabelledKeyset[] = [
      { id: '00ec0ed941f4b5c6', source: 'token' },
      { id: '00ec0ed941f4b5c6', source: 'mint' },
      { id: '00c0d23b424b2f02', source: 'mint' },
      { id: '00c0d23b424b2f02', source: 'known' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].residue).toBe(1137496952);
    expect(result.collisions[0].keysets).toEqual([
      { id: '00ec0ed941f4b5c6', source: 'token' },
      { id: '00ec0ed941f4b5c6', source: 'mint' },
      { id: '00c0d23b424b2f02', source: 'mint' },
      { id: '00c0d23b424b2f02', source: 'known' },
    ]);
    expect(result.collisions[0].relationships).toEqual(['token-mint', 'token-known', 'mint-known']);
  });

  it('encodes the supplied V2 keyset as the expected short wire id', async () => {
    // A cashuB token stores the keyset id as 8 bytes in the CBOR i field,
    // even for a V2 keyset whose full id is 66 hex characters. This test
    // builds a token with the official NUT-02 V2 full id and reads the
    // raw CBOR back, proving the encoder writes the 16-char short form.
    // It also decodes the token with the NutCheck decoder and checks the
    // token carries the short form, so the decode side sees the same id.
    const v2Full = '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [{ id: v2Full, amount: Amount.from(1), secret: bytes32Hex('a1'), C: '02' + bytes32Hex('b2') }],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(token.slice('cashuB'.length), 'base64url'),
    );
    const wireId = Buffer.from(raw.t[0].i).toString('hex');
    expect(wireId).toBe('015ba18a8adcd02e');
    expect(wireId).toHaveLength(16);
    // The NutCheck decoder reads the token back and maps the proof to the
    // full V2 id from the keyset list, while the raw CBOR holds the short
    // form. Both sides agree on which keyset it is.
    const decoded = await decodeToken(token, [v2Full]);
    expect(decoded.proofs[0].id).toBe(v2Full);
    // And the screen excludes that short form as a V2 keyset.
    const result = screenResidues([{ id: wireId, source: 'token' }]);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].id).toBe(wireId);
  });

  it('classifies both the short and the full V2 form as V2 before exclusion', () => {
    expect(classifyKeysetVersion('015ba18a8adcd02e')).toBe('v2');
    expect(classifyKeysetVersion('015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a')).toBe('v2');
    const result = screenResidues([
      { id: '015ba18a8adcd02e', source: 'token' },
      { id: '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a', source: 'mint' },
    ]);
    expect(result.collisions).toEqual([]);
    expect(result.excluded).toHaveLength(2);
  });
  it('marks a same-source collision as same-source, not as a token-mint attack', () => {
    const keysets: LabelledKeyset[] = [
      { id: '00ec0ed941f4b5c6', source: 'mint' },
      { id: '00c0d23b424b2f02', source: 'mint' },
    ];
    const result = screenResidues(keysets);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].residue).toBe(1137496952);
    expect(result.collisions[0].relationships).toEqual(['same-source']);
  });
});
