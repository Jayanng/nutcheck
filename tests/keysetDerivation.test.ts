import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveKeysetId } from '@cashu/cashu-ts';
import { checkKeysetDerivation } from '../src/keysetDerivation.js';

const nut02 = JSON.parse(
  readFileSync(new URL('./fixtures/nut02-vectors.json', import.meta.url), 'utf-8'),
) as {
  v1: { id: string; keys: Record<string, string> };
  v2: {
    id: string;
    unit: string;
    input_fee_ppk: number;
    final_expiry: number;
    keys: Record<string, string>;
  };
};
const keysFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/keys.json', import.meta.url), 'utf-8'),
) as { keysets: Array<{ id: string; unit: string; keys: Record<string, string> }> };
const keysetsFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/keysets.json', import.meta.url), 'utf-8'),
) as { keysets: Array<Record<string, unknown>> };

function stubFetch(map: Record<string, unknown>) {
  return async (url: string): Promise<Response> => {
    for (const [suffix, body] of Object.entries(map)) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

describe('keyset-ID derivation', () => {
  it('deriveKeysetId on the NUT-02 V1 vector gives 00456a94ab4e1c46', () => {
    const derived = deriveKeysetId(nut02.v1.keys, { versionByte: 0 });
    expect(derived).toBe('00456a94ab4e1c46');
  });

  it('unit sat, fee 100, expiry 2059210353 gives the NUT-02 V2 vector', () => {
    const derived = deriveKeysetId(nut02.v2.keys, {
      unit: 'sat',
      input_fee_ppk: 100,
      expiry: 2059210353,
      versionByte: 1,
    });
    expect(derived).toBe('015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a');
  });

  it('one flipped pubkey digit gives 000fa40071a69c0e and is flagged as a mismatch', async () => {
    const tampered = { ...nut02.v1.keys };
    const firstAmount = Object.keys(tampered)[0];
    const k = tampered[firstAmount];
    tampered[firstAmount] = k.slice(0, -1) + (k.endsWith('0') ? '1' : '0');
    const derived = deriveKeysetId(tampered, { versionByte: 0 });
    expect(derived).toBe('000fa40071a69c0e');
    // The check flags it: the mint advertises the real ID but the keys
    // recompute to the tampered one.
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v1.id, unit: 'sat', keys: tampered }] },
      '/v1/keysets': { keysets: [{ id: nut02.v1.id, unit: 'sat', active: true }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('mismatch');
    expect(checks[0].derivedId).toBe('000fa40071a69c0e');
  });

  it('matches both live testnut keyset IDs when the fee is included', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': keysFixture,
      '/v1/keysets': keysetsFixture,
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.result).toBe('match');
      expect(check.derivedId).toBe(check.advertisedId);
    }
  });

  it('a mint answering for a different keyset than asked is unknown, with the discrepancy recorded', async () => {
    const otherId = '00456a94ab4e1c46';
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [] },
      '/v1/keysets': {
        keysets: [{ id: nut02.v2.id, unit: 'sat', active: false, input_fee_ppk: 100, final_expiry: 2059210353 }],
      },
      [`/v1/keys/${nut02.v2.id}`]: {
        keysets: [{ id: otherId, unit: 'sat', keys: nut02.v1.keys }],
      },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].advertisedId).toBe(nut02.v2.id);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].derivedId).toBeUndefined();
    expect(checks[0].detail).toContain('when ' + nut02.v2.id + ' was asked for');
    expect(checks[0].detail).toContain(otherId);
  });

  it('an uppercase response ID for a lowercase request is the same keyset, not an inconsistency', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [] },
      '/v1/keysets': {
        keysets: [{ id: nut02.v1.id, unit: 'sat', active: false }],
      },
      [`/v1/keys/${nut02.v1.id}`]: {
        keysets: [{ id: nut02.v1.id.toUpperCase(), unit: 'sat', keys: nut02.v1.keys }],
      },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].advertisedId).toBe(nut02.v1.id);
    expect(checks[0].result).toBe('match');
    expect(checks[0].derivedId).toBe('00456a94ab4e1c46');
  });

  it('a V3 keyset is labelled V3, not an unknown version', async () => {
    const v3Id = '02' + '00'.repeat(32);
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: v3Id, unit: 'sat', keys: { 1: '02' + '00'.repeat(32) } }] },
      '/v1/keysets': { keysets: [{ id: v3Id, unit: 'sat', active: true }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('V3 keyset');
  });

  it('a V2 keyset with no unit in either response is unknown, never a guessed sat', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, active: true, input_fee_ppk: 100, final_expiry: 2059210353 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('no unit was supplied');
  });

  it('conflicting units in the two responses are unknown, never a guess', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'usd', keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, input_fee_ppk: 100, final_expiry: 2059210353 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('disagree on the unit');
  });

  it('conflicting fees in the two responses are unknown, never a guess', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: 200, keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, input_fee_ppk: 100, final_expiry: 2059210353 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('disagree on the input fee');
  });

  it('a fee present only in /v1/keys is used', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: 100, keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, final_expiry: 2059210353 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('match');
  });

  it('reports unknown, never fail, when the keys cannot be fetched', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
  });

  it('a failed list request reports one unknown per token keyset ID', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn, [
      nut02.v1.id,
      nut02.v2.id,
    ]);
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.advertisedId)).toEqual([nut02.v1.id, nut02.v2.id]);
    for (const check of checks) {
      expect(check.result).toBe('unknown');
      expect(check.detail).toContain('could not be fetched');
    }
  });

  it('checks a token keyset the mint no longer lists in /v1/keysets', async () => {
    // A token can reference a keyset the mint has dropped from /v1/keysets
    // entirely. The caller passes the token's keyset IDs, and the check
    // fetches each one from /v1/keys/{id} instead of skipping it.
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', keys: nut02.v2.keys }] },
      '/v1/keysets': {
        keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, input_fee_ppk: 100, final_expiry: 2059210353 }],
      },
      [`/v1/keys/${nut02.v1.id}`]: {
        keysets: [{ id: nut02.v1.id, unit: 'sat', keys: nut02.v1.keys }],
      },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn, [nut02.v1.id]);
    expect(checks).toHaveLength(2);
    const tokenKeyset = checks.find((c) => c.advertisedId === nut02.v1.id);
    expect(tokenKeyset).toBeDefined();
    expect(tokenKeyset?.result).toBe('match');
    expect(tokenKeyset?.derivedId).toBe('00456a94ab4e1c46');
  });

  it('an uppercase token ID is checked once, with the mint metadata', async () => {
    // The token supplies the V2 ID in uppercase; the mint lists it in
    // lowercase with fee and expiry. The check must not fetch it twice
    // and must not miss the metadata, which would derive a wrong ID.
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [] },
      '/v1/keysets': {
        keysets: [{ id: nut02.v2.id, unit: 'sat', active: false, input_fee_ppk: 100, final_expiry: 2059210353 }],
      },
      [`/v1/keys/${nut02.v2.id}`]: {
        keysets: [{ id: nut02.v2.id, unit: 'sat', keys: nut02.v2.keys }],
      },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn, [
      nut02.v2.id.toUpperCase(),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0].advertisedId).toBe(nut02.v2.id);
    expect(checks[0].result).toBe('match');
    expect(checks[0].derivedId).toBe('015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a');
  });

  it('a malformed fee in either response is unknown, never derived with zero', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: '100', keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, final_expiry: 2059210353 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('fee');
    expect(checks[0].detail).toContain('malformed');
  });

  it('a fractional or non-finite fee is unknown, never derived', async () => {
    for (const badFee of [100.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const fetchFn = stubFetch({
        '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: badFee, keys: nut02.v2.keys }] },
        '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, final_expiry: 2059210353 }] },
      });
      const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
      expect(checks).toHaveLength(1);
      expect(checks[0].result).toBe('unknown');
      expect(checks[0].detail).toContain('malformed');
    }
  });

  it('a fractional expiry is unknown, never treated as absent', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: 100, keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, final_expiry: 2059210353.5 }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('expiry');
    expect(checks[0].detail).toContain('malformed');
  });

  it('a malformed expiry in either response is unknown, never treated as absent', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', input_fee_ppk: 100, keys: nut02.v2.keys }] },
      '/v1/keysets': { keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, final_expiry: '2059210353' }] },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('unknown');
    expect(checks[0].detail).toContain('expiry');
    expect(checks[0].detail).toContain('malformed');
  });

  it('a token keyset whose keys cannot be fetched is unknown, never skipped', async () => {
    const fetchFn = stubFetch({
      '/v1/keys': { keysets: [{ id: nut02.v2.id, unit: 'sat', keys: nut02.v2.keys }] },
      '/v1/keysets': {
        keysets: [{ id: nut02.v2.id, unit: 'sat', active: true, input_fee_ppk: 100, final_expiry: 2059210353 }],
      },
      // No /v1/keys/{id} entry for the token keyset: the fetch returns 404.
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn, [nut02.v1.id]);
    expect(checks).toHaveLength(2);
    const tokenKeyset = checks.find((c) => c.advertisedId === nut02.v1.id);
    expect(tokenKeyset).toBeDefined();
    expect(tokenKeyset?.result).toBe('unknown');
    expect(tokenKeyset?.detail).toContain('could not be fetched');
  });

  it('checks an inactive keyset by fetching its keys from /v1/keys/{id}', async () => {
    // /v1/keys returns only active keysets. The inactive V1 keyset is in
    // /v1/keysets but not in /v1/keys, so the check fetches it directly.
    const fetchFn = stubFetch({
      '/v1/keys': {
        keysets: [
          {
            id: nut02.v2.id,
            unit: 'sat',
            keys: nut02.v2.keys,
          },
        ],
      },
      '/v1/keysets': {
        keysets: [
          { id: nut02.v2.id, unit: 'sat', active: true, input_fee_ppk: 100, final_expiry: 2059210353 },
          { id: nut02.v1.id, unit: 'sat', active: false },
        ],
      },
      [`/v1/keys/${nut02.v1.id}`]: {
        keysets: [{ id: nut02.v1.id, unit: 'sat', keys: nut02.v1.keys }],
      },
    });
    const checks = await checkKeysetDerivation('https://testnut.cashu.space', fetchFn);
    expect(checks).toHaveLength(2);
    const active = checks.find((c) => c.advertisedId === nut02.v2.id);
    expect(active).toBeDefined();
    expect(active?.result).toBe('match');
    const inactive = checks.find((c) => c.advertisedId === nut02.v1.id);
    expect(inactive).toBeDefined();
    expect(inactive?.result).toBe('match');
    expect(inactive?.derivedId).toBe('00456a94ab4e1c46');
  });
});
