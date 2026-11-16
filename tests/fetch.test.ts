import { describe, expect, it } from 'vitest';
import { Amount, getDecodedToken, getEncodedToken } from '@cashu/cashu-ts';
import {
  fetchMintJson,
  mintEndpointUrl,
  MintFetchError,
  RESPONSE_SIZE_CAP,
  FETCH_TIMEOUT_MS,
} from '../src/fetch.js';

describe('fetchMintJson', () => {
  it('pins the response size cap at 1 MB', () => {
    expect(RESPONSE_SIZE_CAP).toBe(1048576);
  });

  it('pins the request timeout at 4 seconds', () => {
    expect(FETCH_TIMEOUT_MS).toBe(4000);
  });

  it('refuses a mint outside the allowed mint base without sending a request', async () => {
    let called = false;
    const stub = async (): Promise<Response> => {
      called = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await expect(
      fetchMintJson('https://other-mint.example/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(MintFetchError);
    await expect(
      fetchMintJson('https://other-mint.example/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/outside the allowed mint/);
    expect(called).toBe(false);
  });

  it('refuses a different mint base on the same origin, with zero fetches', async () => {
    // Two mints on one host are different mints. An origin-only check
    // would let mint-b through when the token names mint-a.
    let called = false;
    const stub = async (): Promise<Response> => {
      called = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await expect(
      fetchMintJson('https://example.com/mint-b/v1/info', 'https://example.com/mint-a', {}, stub),
    ).rejects.toThrow(/outside the allowed mint/);
    expect(called).toBe(false);
  });

  it('refuses a base that merely shares a string prefix, with zero fetches', async () => {
    let called = false;
    const stub = async (): Promise<Response> => {
      called = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await expect(
      fetchMintJson('https://example.com/mint-a-evil/v1/info', 'https://example.com/mint-a', {}, stub),
    ).rejects.toThrow(/outside the allowed mint/);
    expect(called).toBe(false);
  });

  it('contacts the allowed mint base normally', async () => {
    const stub = async (): Promise<Response> =>
      new Response(JSON.stringify({ name: 'Testnut mint' }), { status: 200 });
    const result = await fetchMintJson(
      'https://testnut.cashu.space/v1/info',
      'https://testnut.cashu.space',
      {},
      stub,
    );
    expect(result).toEqual({ name: 'Testnut mint' });
  });

  it('a mint absent from the decoded token gets zero fetches', async () => {
    // The allowed mint base comes from the token itself: decode a real
    // token, take its mint, and prove a different mint is refused
    // before any request is sent. This is the plan step 3.1 rule, that
    // only mint URLs named in the token are ever contacted.
    const bytes32Hex = (ch: string): string => ch.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: Amount.from(1),
          secret: bytes32Hex('a1'),
          C: '02' + bytes32Hex('b2'),
          dleq: { e: bytes32Hex('c3'), s: bytes32Hex('d4'), r: bytes32Hex('e5') },
        },
      ],
    });
    const decoded = getDecodedToken(token, ['009a1f293253e41e']);
    const tokenMintBase = decoded.mint;
    expect(tokenMintBase).toBe('https://testnut.cashu.space');
    let called = false;
    const stub = async (): Promise<Response> => {
      called = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await expect(
      fetchMintJson('https://other-mint.example/v1/info', tokenMintBase, {}, stub),
    ).rejects.toThrow(/outside the allowed mint/);
    expect(called).toBe(false);
  });

  it('rejects a body larger than the cap', async () => {
    const big = 'x'.repeat(RESPONSE_SIZE_CAP + 1);
    const stub = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: big }), { status: 200 });
    await expect(
      fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(MintFetchError);
    await expect(
      fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/exceeds the 1048576 byte cap/);
  });

  it('rejects a redirect instead of following it', async () => {
    const stub = async (): Promise<Response> =>
      new Response('', { status: 302, headers: { Location: 'https://evil.example/' } });
    await expect(
      fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/redirects are not followed/);
  });

  it('rejects a body that is not JSON', async () => {
    const stub = async (): Promise<Response> =>
      new Response('not json at all', { status: 200 });
    await expect(
      fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/not JSON/);
  });

  it('rejects a non-HTTP mint URL', async () => {
    const stub = async (): Promise<Response> => new Response('{}', { status: 200 });
    await expect(
      fetchMintJson('file:///etc/passwd', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/non-HTTP/);
  });

  it('reports a 401 or 403 as refused, not as a generic failure', async () => {
    const stub = async (): Promise<Response> => new Response('', { status: 401 });
    await expect(
      fetchMintJson('https://testnut.cashu.space/v1/checkstate', 'https://testnut.cashu.space', {}, stub),
    ).rejects.toThrow(/refused the request \(status 401\)/);
  });

  it(
    'times out after 4 seconds',
    async () => {
      const stub = async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation timed out.');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      await expect(
        fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
      ).rejects.toThrow(/timed out after 4000 ms/);
    },
    10000,
  );

  it(
    'a response without a readable body stream is not read',
    async () => {
      const stub = async (): Promise<Response> => new Response(null, { status: 200 });
      await expect(
        fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
      ).rejects.toThrow(/no readable body stream/);
    },
  );

  it(
    'a mint that sends headers and then stalls does not hang past the timeout',
    async () => {
      const stalled = new Response(
        new ReadableStream({
          start() {
            // Never enqueue anything, never close. The body stalls forever.
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const stub = async (): Promise<Response> => stalled;
      const start = Date.now();
      await expect(
        fetchMintJson('https://testnut.cashu.space/v1/info', 'https://testnut.cashu.space', {}, stub),
      ).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(8000);
    },
    10000,
  );
});

describe('mintEndpointUrl', () => {
  it('builds the endpoint from a plain base URL', () => {
    expect(mintEndpointUrl('https://testnut.cashu.space', '/v1/checkstate')).toBe(
      'https://testnut.cashu.space/v1/checkstate',
    );
    expect(mintEndpointUrl('https://testnut.cashu.space/', '/v1/info')).toBe(
      'https://testnut.cashu.space/v1/info',
    );
  });

  it('keeps a base path and appends the endpoint to it', () => {
    expect(mintEndpointUrl('https://example.com/mint', '/v1/info')).toBe(
      'https://example.com/mint/v1/info',
    );
  });

  it('rejects a base with a query string, which could redirect the request', () => {
    // The adversarial case: a base of "https://mint.example/v1/swap?x="
    // would otherwise put the request on /v1/swap instead of the
    // intended endpoint.
    expect(() => mintEndpointUrl('https://mint.example/v1/swap?x=', '/v1/checkstate')).toThrow(
      /must not carry a query or fragment/,
    );
  });

  it('rejects a base with a fragment', () => {
    expect(() => mintEndpointUrl('https://mint.example#x', '/v1/info')).toThrow(
      /must not carry a query or fragment/,
    );
  });

  it('rejects a non-HTTP base', () => {
    expect(() => mintEndpointUrl('ftp://mint.example', '/v1/info')).toThrow(/not an HTTP mint URL/);
  });

  it('rejects a base that is not a URL at all', () => {
    expect(() => mintEndpointUrl('not a url', '/v1/info')).toThrow(/not a valid mint URL/);
  });

  it('a checkstate call to an adversarial mint URL never reaches the network', async () => {
    const { checkProofState } = await import('../src/checkstate.js');
    const fetchFn = async (): Promise<Response> => {
      throw new Error('the network should not have been reached');
    };
    const result = await checkProofState(
      'https://mint.example/v1/swap?x=',
      'https://testnut.cashu.space',
      'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
      true,
      fetchFn,
    );
    expect(result.status).toBe('not-checked');
    expect(result.message).toBe('the mint URL is not usable, verify manually');
  });
});
