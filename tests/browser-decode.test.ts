// Browser decode check for the core library. The page and the wallet run
// in the browser, where the only Buffer is the 'buffer' package polyfill
// (set as the global by the app's shims). That polyfill does not support
// the 'base64url' encoding, so any decode path that relies on it fails for
// every token. This test reproduces the browser environment by replacing
// the global Buffer with the polyfill before importing the parser, then
// decodes the evilmint fixture token and runs the full check on it.
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const polyfill = require('../node_modules/buffer/index.js');
const nativeBuffer = globalThis.Buffer;
(globalThis as unknown as { Buffer: unknown }).Buffer = polyfill.Buffer;

afterAll(() => {
  (globalThis as unknown as { Buffer: unknown }).Buffer = nativeBuffer;
});

describe('browser decode with only the polyfill Buffer', () => {
  it('decodes the evilmint fixture token', async () => {
    const { parseTokenRaw } = await import('../src/rawParser.js');
    const token = readFileSync('tests/fixtures/evilmint/token.txt', 'utf8').trim();
    const raw = await parseTokenRaw(token);
    expect(raw.proofs.length).toBeGreaterThan(0);
    expect(raw.format).toBe('cashuB');
  });

  it('runs the full check on the evilmint token without a decode failure', async () => {
    const { diagnoseToken } = await import('../src/report.js');
    const token = readFileSync('tests/fixtures/evilmint/token.txt', 'utf8').trim();
    const report = await diagnoseToken(token, {
      knownKeysets: ['00206785c39be46b'],
      fetchFn: async () => {
        throw new Error('no mint fetch in this test');
      },
      consent: false,
    });
    const all = [...report.checked, ...report.notChecked];
    for (const c of all) {
      expect(c.result).not.toContain('could not be parsed');
      expect(c.result).not.toContain('not valid base64url');
    }
    expect(report.headline).not.toContain('could not be parsed');
  });
});
