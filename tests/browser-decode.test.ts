// Browser decode check. The page runs in the browser, where the only Buffer
// is the 'buffer' package polyfill (set as the global by shims.ts). That
// polyfill does not support the 'base64url' encoding, so any decode path
// that relies on it fails for every token. This test reproduces the browser
// environment by replacing the global Buffer with the polyfill before
// importing the parser, then decodes every sample and runs the full check.
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const polyfill = require('../node_modules/buffer/index.js');
const nativeBuffer = globalThis.Buffer;
(globalThis as unknown as { Buffer: unknown }).Buffer = polyfill.Buffer;

afterAll(() => {
  (globalThis as unknown as { Buffer: unknown }).Buffer = nativeBuffer;
});

describe('browser decode with only the polyfill Buffer', () => {
  it('decodes all 8 samples', async () => {
    const { parseTokenRaw } = await import('../src/rawParser.js');
    const { SAMPLES } = await import('../src/web/samples.js');
    for (const [key, sample] of Object.entries(SAMPLES)) {
      const raw = await parseTokenRaw(sample.token);
      expect(raw.proofs.length, `${key} proofs`).toBeGreaterThan(0);
    }
  });

  it('runs the full check on all 8 samples without a decode failure', async () => {
    const { diagnoseToken } = await import('../src/report.js');
    const { SAMPLES, getSampleFetchFn } = await import('../src/web/samples.js');
    for (const [key, sample] of Object.entries(SAMPLES)) {
      const report = await diagnoseToken(sample.token, {
        fetchFn: getSampleFetchFn(key),
        consent: sample.consent,
        knownKeysets: sample.knownKeysets,
      });
      const all = [...report.checked, ...report.notChecked];
      for (const c of all) {
        expect(c.result, `${key} result`).not.toContain('could not be parsed');
        expect(c.result, `${key} result`).not.toContain('not valid base64url');
        expect(c.message ?? '', `${key} message`).not.toContain('could not be parsed');
      }
      if (key === 'v3') {
        // A V3-only token lands on AMBER by design: the decode entry goes to
        // not-checked because the signature was not verified, not because
        // the token failed to parse.
        const decode = report.notChecked.find((c) => c.checkId === 'decode');
        expect(decode, 'v3 decode check present in not-checked').toBeDefined();
      } else {
        const decode = report.checked.find((c) => c.checkId === 'decode');
        expect(decode, `${key} decode check present`).toBeDefined();
        expect(decode?.outcome, `${key} decode outcome`).toBe('pass');
      }
      expect(report.headline, `${key} headline`).not.toContain('could not be parsed');
    }
    const clean = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: getSampleFetchFn('clean'),
      consent: false,
    });
    expect(clean.headline).toBe('No known issues found.');
    const spent = await diagnoseToken(SAMPLES.spent.token, {
      fetchFn: getSampleFetchFn('spent'),
      consent: true,
      knownKeysets: SAMPLES.spent.knownKeysets,
    });
    expect(spent.severity).toBe('red');
    expect(spent.headline).toBe('Hold, here is why.');
  });
});
