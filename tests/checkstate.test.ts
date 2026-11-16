import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkProofState, CHECKSTATE_PRIVACY_COPY } from '../src/checkstate.js';
import { MintFetchError } from '../src/fetch.js';

const unspentFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/checkstate-unspent.json', import.meta.url), 'utf-8'),
) as { states: Array<{ Y: string; state: string; witness: unknown }> };
const spentFixture = JSON.parse(
  readFileSync(new URL('./fixtures/testnut/checkstate-spent.json', import.meta.url), 'utf-8'),
) as { states: Array<{ Y: string; state: string; witness: unknown }> };

const secret = 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9';
// The secret of a proof minted at testnut and then spent by a melt, so it
// is worth nothing. It is recorded only so this test can reproduce the Y
// in the spent fixture, the same way the public NUT-12 vector secret is
// used for the unspent fixture.
const spentSecret = '419a961f39355101018f17d01487db2e12712b3c97cb6fe2e5994e185455ea7b';

function stubFetchFor(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    if (status === 401 || status === 403) {
      return new Response('', { status });
    }
    return new Response(JSON.stringify(body), { status });
  });
}

describe('checkstate', () => {
  it('no code path sends checkstate without consent, and a test proves it', async () => {
    const fetchFn = stubFetchFor(unspentFixture);
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, false, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.message).toContain('consent was not given');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a mint absent from the decoded token gets zero fetches through the public check', async () => {
    const fetchFn = stubFetchFor(unspentFixture);
    const result = await checkProofState(
      'https://other-mint.example',
      'https://testnut.cashu.space',
      secret,
      true,
      fetchFn,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.status).toBe('not-checked');
    expect(result.message).toMatch(/not the one named in the token/);
  });

  it('the live testnut fixture maps to unspent', async () => {
    const fetchFn = stubFetchFor(unspentFixture);
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('checked');
    expect(result.state).toBe('unspent');
    expect(result.severity).toBe('none');
    expect(result.message).toBe('the mint reports this proof as unspent');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('the live testnut spent fixture maps to spent and RED', async () => {
    // The fixture was recorded live: a proof minted at testnut, then
    // spent by a melt, then checkstate returned SPENT for its Y.
    expect(spentFixture.states).toHaveLength(2);
    expect(spentFixture.states.every((s) => s.state === 'SPENT')).toBe(true);
    const fetchFn = stubFetchFor(spentFixture);
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', spentSecret, true, fetchFn);
    expect(result.status).toBe('checked');
    expect(result.state).toBe('spent');
    expect(result.severity).toBe('red');
    expect(result.message).toBe('the mint reports this proof as spent');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('spent maps to RED', async () => {
    const fetchFn = stubFetchFor({ states: [{ Y: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc', state: 'SPENT', witness: null }] });
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.state).toBe('spent');
    expect(result.severity).toBe('red');
    expect(result.message).toBe('the mint reports this proof as spent');
  });

  it('pending maps to AMBER, the mint reports the proof as pending', async () => {
    const fetchFn = stubFetchFor({ states: [{ Y: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc', state: 'PENDING', witness: null }] });
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.state).toBe('pending');
    expect(result.severity).toBe('amber');
    expect(result.message).toBe('the mint reports this proof as pending');
  });

  it('an HTTP error from a reachable mint is not called unreachable', async () => {
    // A real stubbed Response with status 500, so the test exercises the
    // same !response.ok path a live mint takes.
    const fetchFn = vi.fn(async (): Promise<Response> => new Response('server error', { status: 500 }));
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.severity).toBe('amber');
    expect(result.message).toBe('the mint answered with an error (status 500), verify manually');
  });

  it(
    'a timeout maps to AMBER, mint unreachable, verify manually',
    async () => {
      // An abort-aware stub: the fetch rejects with a TimeoutError when the
      // signal fires, the same way a real timed-out fetch behaves. This
      // exercises the timeout mapping, not the generic failure path.
      const fetchFn = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation timed out.');
            err.name = 'TimeoutError';
            reject(err);
          });
        }),
      );
      const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
      expect(result.status).toBe('not-checked');
      expect(result.severity).toBe('amber');
      expect(result.message).toBe('mint unreachable, verify manually');
    },
    10000,
  );

  it('a body that stalls after the mint answered is not called unreachable', async () => {
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new MintFetchError('mint request timed out while reading the response body');
    });
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.severity).toBe('amber');
    expect(result.message).toBe('the mint answered but the response could not be read, verify manually');
  });

  it('401 maps to not checked (auth required)', async () => {
    const fetchFn = stubFetchFor(null, 401);
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.message).toBe('not checked (auth required)');
    expect(result.severity).toBe('none');
  });

  it('403 maps to not checked (auth required)', async () => {
    const fetchFn = stubFetchFor(null, 403);
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.message).toBe('not checked (auth required)');
    expect(result.severity).toBe('none');
  });

  it('a response for a different Y is not accepted as the proof state', async () => {
    const fetchFn = stubFetchFor({
      states: [{ Y: '02' + '00'.repeat(32), state: 'SPENT', witness: null }],
    });
    const result = await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    expect(result.status).toBe('not-checked');
    expect(result.state).toBeUndefined();
    expect(result.message).toBe('the mint answered but the response could not be read, verify manually');
  });

  it('the privacy copy warns about disclosure, correlation, and the mint word', () => {
    expect(CHECKSTATE_PRIVACY_COPY).toContain('learns which proofs you hold');
    expect(CHECKSTATE_PRIVACY_COPY).toContain('correlate sender and receiver');
    expect(CHECKSTATE_PRIVACY_COPY).toContain('its own word at one moment');
  });

  it('hashes the secret as UTF-8 bytes, the same Y the mint computes', async () => {
    // The NUT-12 vector secret, hashed as UTF-8, gives the proof's C
    // point. A hex-decoded hash would give a different Y and the mint
    // would answer for a proof that does not exist.
    let sentBody = '';
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      sentBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify(unspentFixture), { status: 200 });
    });
    await checkProofState('https://testnut.cashu.space', 'https://testnut.cashu.space', secret, true, fetchFn);
    const parsed = JSON.parse(sentBody) as { Ys: string[] };
    expect(parsed.Ys).toHaveLength(1);
    expect(parsed.Ys[0]).toBe(
      '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
    );
  });
});
