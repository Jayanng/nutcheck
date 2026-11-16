import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getMintFacts } from '../src/mintFacts.js';

const infoFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/info.json', import.meta.url), 'utf-8'),
) as Record<string, unknown>;
const keysetsFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/keysets.json', import.meta.url), 'utf-8'),
) as Record<string, unknown>;

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

describe('getMintFacts', () => {
  it('surfaces version, nuts, keysets, fees, and active flags from the testnut fixtures', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': keysetsFixture,
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('ok');
    expect(facts.name).toBe('Testnut mint');
    expect(facts.version).toBe('cdk-mintd/0.18.1');
    expect(Object.keys(facts.nuts)).toContain('4');
    expect(facts.keysets).toHaveLength(2);
    expect(facts.keysets[0].id).toBe('017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda');
    expect(facts.keysets[0].unit).toBe('sat');
    expect(facts.keysets[0].active).toBe(true);
    expect(facts.keysets[0].inputFeePpk).toBe(100);
    expect(facts.keysets[1].unit).toBe('usd');
  });

  it('reports keyset age as unknown, a trust signal only, not a cryptographic fact', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': keysetsFixture,
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.keysets[0].age).toContain('unknown');
    expect(facts.keysets[0].age).toContain('trust signal only');
  });

  it('reports unknown, never fail, when the mint cannot be reached', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('unknown');
    expect(facts.keysets).toEqual([]);
    expect(facts.error).toBeDefined();
  });

  it('reports the active flag as unknown when it is absent or malformed', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': {
        keysets: [
          { id: '017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda', unit: 'sat', input_fee_ppk: 100 },
          { id: '010eca897fd3b9d496c4ef28de870727ef616cb0a05404035c65cf5cc6fa879504', unit: 'usd', active: 'yes', input_fee_ppk: 100 },
        ],
      },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('ok');
    expect(facts.keysets[0].active).toBeUndefined();
    expect(facts.keysets[1].active).toBeUndefined();
  });

  it('reports unknown when the keysets response has no list', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': { keysets: 'not a list' },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('unknown');
  });

  it('a keyset entry without a usable ID or unit is unknown, never a blank fact', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': { keysets: [{}] },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('unknown');
    expect(facts.keysets).toHaveLength(0);
    expect(facts.error).toContain('without a usable ID or unit');
  });

  it('a keyset entry with a missing unit is unknown, never a blank fact', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': { keysets: [{ id: '017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda' }] },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('unknown');
    expect(facts.keysets).toHaveLength(0);
  });

  it('a fractional or negative fee or expiry is left undefined, never published as a fact', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': {
        keysets: [
          {
            id: '017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda',
            unit: 'sat',
            active: true,
            input_fee_ppk: 100.5,
            final_expiry: -1,
          },
        ],
      },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('ok');
    expect(facts.keysets).toHaveLength(1);
    expect(facts.keysets[0].inputFeePpk).toBeUndefined();
    expect(facts.keysets[0].finalExpiry).toBeUndefined();
    // Malformed is named, not silently treated as absent.
    expect(facts.findings).toHaveLength(2);
    expect(facts.findings[0]).toContain('malformed input_fee_ppk');
    expect(facts.findings[1]).toContain('malformed final_expiry');
  });

  it('an absent fee or expiry produces no finding, unlike a malformed one', async () => {
    const fetchFn = stubFetch({
      '/v1/info': infoFixture,
      '/v1/keysets': {
        keysets: [
          {
            id: '017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda',
            unit: 'sat',
            active: true,
          },
        ],
      },
    });
    const facts = await getMintFacts('https://testnut.cashu.space', fetchFn);
    expect(facts.status).toBe('ok');
    expect(facts.keysets[0].inputFeePpk).toBeUndefined();
    expect(facts.keysets[0].finalExpiry).toBeUndefined();
    expect(facts.findings).toEqual([]);
  });
});
