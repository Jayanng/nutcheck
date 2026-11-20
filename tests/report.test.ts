// Report tests: the verdict report and the adversarial suite. Every
// adversarial case is a named vitest test. The evilmint token produces
// DLEQ passes, COLLISION flagged, keyset age shown, and headline
// "Hold, here is why", with the report naming the residue screen as the
// check that did the work. Report copy never uses the banned words.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  diagnoseToken,
  reportToText,
  scanReportCopy,
  BANNED_WORDS,
  CANNOT_PROVE,
} from '../src/report.js';
import { screenResidues } from '../src/residue.js';
import { keysetResidue } from '../src/residue.js';
import { verifyProofDleq } from '../src/dleq.js';
import { SAMPLES, getSampleFetchFn } from '../src/web/samples.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readFixture(rel: string): string {
  return readFileSync(path.join(root, 'tests', 'fixtures', rel), 'utf-8').trim();
}
function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, 'tests', 'fixtures', rel), 'utf-8')) as Record<string, unknown>;
}

const evilmintToken = readFixture('evilmint/token.txt');
const evilmintInfo = readJson('evilmint/info.json');
const evilmintKeysets = readJson('evilmint/keysets.json');
const evilmintKeys = readJson('evilmint/keys.json');

const testnutInfo = readJson('testnut/info.json');
const testnutKeysets = readJson('testnut/keysets.json');
const testnutKeys = readJson('testnut/keys.json');
const spentFixture = readJson('testnut/checkstate-spent.json');

// A stub fetch that serves the evilmint responses for any URL under the
// evilmint base, and the testnut fixtures for testnut. Anything else 404s.
function stubFetchForEvilmint() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('localhost:3338')) {
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(evilmintKeysets), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(evilmintKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = (evilmintKeys.keysets as Array<Record<string, unknown>>).find(
          (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

function stubFetchForTestnut(checkstateBody?: Record<string, unknown>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('testnut.cashu.space')) {
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(testnutInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(testnutKeysets), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(testnutKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = (testnutKeys.keysets as Array<Record<string, unknown>>).find(
          (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/v1/checkstate') && checkstateBody) {
        return new Response(JSON.stringify(checkstateBody), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

describe('report: three sections and headline', () => {
  it('a clean run produces the clean headline and its copy has no banned words', async () => {
    // Serve only keyset B, so there is no collision. DLEQ passes, the
    // derivation matches, and checkstate is consented with the mock mint
    // reporting unspent, so nothing is flagged and the headline is the
    // clean one.
    const singleKeyset = JSON.parse(JSON.stringify(evilmintKeysets)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeyset.keysets = singleKeyset.keysets.filter((k) => k.id === '00102821c3bc6333');
    const singleKeys = JSON.parse(JSON.stringify(evilmintKeys)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeys.keysets = singleKeys.keysets.filter((k) => k.id === '00102821c3bc6333');
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/v1/checkstate')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { Ys?: string[] };
        const y = body.Ys?.[0] ?? '';
        return new Response(JSON.stringify({ states: [{ Y: y, state: 'UNSPENT' }] }), { status: 200 });
      }
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(singleKeyset), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(singleKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = singleKeys.keysets.find(
          (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn, consent: true });
    expect(report.headline).toBe('No known issues found.');
    expect(report.severity).toBe('none');
    const text = reportToText(report);
    expect(scanReportCopy(text)).toEqual([]);
    for (const word of BANNED_WORDS) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('a run without mint consent never earns the clean headline', async () => {
    // The clean sample decodes fine and nothing is flagged, but the proof
    // state was never checked, so the headline is "Not fully checked.",
    // not clean and not a Hold.
    const report = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: getSampleFetchFn('clean'),
      consent: false,
      knownKeysets: SAMPLES.clean.knownKeysets,
    });
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
    const text = reportToText(report);
    expect(scanReportCopy(text)).toEqual([]);
  });

  it('every report has Checked, Not checked and Cannot prove, even when short', async () => {
    const report = await diagnoseToken(evilmintToken, { fetchFn: stubFetchForEvilmint() });
    expect(report.checked).toBeDefined();
    expect(report.notChecked).toBeDefined();
    expect(report.cannotProve).toBeDefined();
    expect(report.cannotProve.length).toBeGreaterThan(0);
    expect(report.cannotProve).toEqual(CANNOT_PROVE);
  });

  it('a clean headline is never the default when something errors', async () => {
    // An unreachable mint: the mint facts fail, so the headline must be
    // Hold, never the clean one.
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
  });

  it('a mint that answers info but lists no keysets is not decoded from the token short IDs', async () => {
    // When the mint supplies no keyset list, decoding waits and the
    // report records that keyset context is missing, instead of falling
    // back to the token's own short IDs.
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify({ keysets: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
    const decode = report.notChecked.find((c) => c.checkId === 'decode');
    expect(decode).toBeDefined();
    expect(decode?.result).toContain('keyset list');
  });

  it('when the mint keys cannot be fetched, DLEQ not-checked is AMBER, never clean', async () => {
    // The mint answers info and keysets but /v1/keys fails, so DLEQ
    // cannot be verified. That is an unknown state, so the headline
    // must be Hold, never the clean one.
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(evilmintKeysets), { status: 200 });
      }
      if (url.endsWith('/v1/keys') || url.includes('/v1/keys/')) {
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
    const dleq = report.notChecked.find((c) => c.checkId === 'dleq');
    expect(dleq).toBeDefined();
    expect(dleq?.severity).toBe('amber');
  });

  it('the text export copies the whole report as plain text', async () => {
    const report = await diagnoseToken(evilmintToken, {
      fetchFn: stubFetchForEvilmint(),
      knownKeysets: ['00206785c39be46b'],
    });
    const text = reportToText(report);
    expect(text).toContain('Headline: Hold, here is why.');
    expect(text).toContain('Severity: amber');
    expect(text).toContain('Unit: sat');
    // The mint is identified by a fingerprint of its URL, never the
    // raw URL: the URL is token-supplied data and could contain a
    // banned word.
    expect(text).toMatch(/^Mint: [0-9a-f]{8}$/m);
    expect(text).not.toContain('localhost:3338');
    expect(text).toContain('Checked:');
    expect(text).toContain('Not checked:');
    expect(text).toContain('Cannot prove:');
    expect(text).toContain('Residue screen');
    expect(text).toContain('[residue]');
    expect(text).toContain('[flag]');
    expect(text).toContain('[amber]');
  });
});

describe('report: banned words', () => {
  it('no report copy uses safe, guaranteed, secure, or verified safe', async () => {
    const report = await diagnoseToken(evilmintToken, { fetchFn: stubFetchForEvilmint() });
    const text = reportToText(report);
    const found = scanReportCopy(text);
    expect(found).toEqual([]);
    for (const word of BANNED_WORDS) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // The scan itself catches each banned word when present.
    expect(scanReportCopy('this is safe and guaranteed')).toContain('safe');
    expect(scanReportCopy('this is safe and guaranteed')).toContain('guaranteed');
    expect(scanReportCopy('a secure mint')).toContain('secure');
    expect(scanReportCopy('verified safe')).toContain('verified safe');
    // Word boundaries: a mint named SafeMint does not trip the scan,
    // while a standalone banned word does.
    expect(scanReportCopy('the mint answered: SafeMint, version test')).toEqual([]);
    expect(scanReportCopy('this token is safe')).toContain('safe');
  });

  it('a mint URL containing a banned word does not put it in the verdict copy', async () => {
    // A token whose mint URL contains a banned word (safe, guaranteed,
    // secure) must not put that word into the report copy. The mint URL
    // is token-supplied data, so it stays in the report mint field but
    // is never interpolated into verdict copy (toText header or check
    // strings).
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const token = getEncodedToken({
      mint: 'https://safe-mint.example.com',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({ keysets: [{ id: '009a1f293253e41e', unit: 'sat', active: true }] }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(token, { fetchFn });
    expect(report.mint).toBe('https://safe-mint.example.com');
    expect(scanReportCopy(reportToText(report))).toEqual([]);
  });

  it('a fetch that throws with a banned word does not put it in the verdict copy', async () => {
    // A fetch failure whose error message contains a banned word must
    // not put that word into the report: fetch error messages are
    // fixed and path-only, the thrown message is never interpolated.
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network down at the safe gateway, guaranteed timeout');
    };
    const report = await diagnoseToken(token, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(scanReportCopy(reportToText(report))).toEqual([]);
    const text = reportToText(report);
    expect(text).not.toContain('safe');
    expect(text).not.toContain('guaranteed');
  });

  it('a banned-word mint URL with an invalid query does not put it in the verdict copy', async () => {
    // A token whose mint URL contains a banned word AND an invalid
    // query or fragment must not put the URL into the report through
    // the mint URL validation error: those errors are fixed strings
    // with no URL. The validation fails before any request is sent.
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const token = getEncodedToken({
      mint: 'https://safe-mint.example.com/?evil=1',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    let fetches = 0;
    const fetchFn = async (): Promise<Response> => {
      fetches += 1;
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(token, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(fetches).toBe(0);
    expect(scanReportCopy(reportToText(report))).toEqual([]);
    expect(reportToText(report)).not.toContain('safe-mint');
  });

  it('representative reports are all free of banned words', async () => {
    // The banned-words rule covers NutCheck own copy across report paths, not just one
    // generated report. Scan the text of a clean run, the evilmint
    // collision, an error run, and a V3 run. Quoted data (the mint URL
    // in the report header) is data, not verdict copy; the fixtures
    // use URLs without banned words, so the scan is clean throughout.
    const clean = await diagnoseToken(evilmintToken, { fetchFn: stubFetchForEvilmint() });
    expect(scanReportCopy(reportToText(clean))).toEqual([]);
    const evil = await diagnoseToken(evilmintToken, {
      fetchFn: stubFetchForEvilmint(),
      knownKeysets: ['00206785c39be46b'],
    });
    expect(scanReportCopy(reportToText(evil))).toEqual([]);
    const error = await diagnoseToken('cashuB');
    expect(scanReportCopy(reportToText(error))).toEqual([]);
    // A real V3 token, not the evilmint token again: build one with a
    // V3 keyset and a stub mint that serves it.
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const v3Id = '02' + '00'.repeat(32);
    const v3Token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v3Id,
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    const v3Fetch = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({ keysets: [{ id: v3Id, unit: 'sat', active: true }] }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const v3 = await diagnoseToken(v3Token, { fetchFn: v3Fetch });
    expect(v3.notChecked.some((c) => c.checkId === 'decode')).toBe(true);
    expect(scanReportCopy(reportToText(v3))).toEqual([]);
  });
});

describe('adversarial suite', () => {
  it('forced V1 collision: two different V1 IDs share a residue and the screen flags it', () => {
    // The evilmint pair, found by birthday search over derived IDs.
    const result = screenResidues([
      { id: '00206785c39be46b', source: 'token' },
      { id: '00102821c3bc6333', source: 'mint' },
    ]);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].residue).toBe(1138537334);
    expect(result.collisions[0].relationships).toContain('token-mint');
    expect(keysetResidue('00206785c39be46b')).toBe(keysetResidue('00102821c3bc6333'));
  });

  it('V2 excluded: a V2 keyset is not screened for residue', () => {
    const result = screenResidues([
      { id: '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a', source: 'token' },
      { id: '00456a94ab4e1c46', source: 'mint' },
    ]);
    expect(result.collisions).toHaveLength(0);
    expect(result.excluded.some((e) => e.id.startsWith('015ba18a'))).toBe(true);
  });

  it('V3 with no DLEQ applied: a V3 proof is not-checked, never verified', () => {
    const check = verifyProofDleq(
      {
        amount: 1,
        id: '0200000000000000000000000000000000000000000000000000000000000000',
        secret: '00'.repeat(32),
        C: '02' + '00'.repeat(32),
        dleq: { e: '00'.repeat(32), s: '00'.repeat(32), r: '00'.repeat(32) },
      },
      0,
      undefined,
    );
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
  });

  it('a mixed V1+V3 token still verifies the V1 proof and labels the V3 proof not-checked', async () => {
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    // The V1 proof carries the NUT-12 valid DLEQ vector, so the test
    // exercises real cryptographic DLEQ verification in the
    // v3-not-checked path, not just the absent-DLEQ label.
    const v1Id = '00882760bfa2eb41';
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v1Id,
          amount: Amount.from(1),
          secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
          C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
          dleq: {
            e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
            s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
            r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
          },
        },
        {
          id: v3Id,
          amount: Amount.from(1),
          secret: 'cc'.repeat(32),
          C: '02' + 'dd'.repeat(32),
        },
      ],
    });
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({
            keysets: [
              { id: v1Id, unit: 'sat', active: true },
              { id: v3Id, unit: 'sat', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/v1/keys/${v1Id}`)) {
        return new Response(
          JSON.stringify({
            keysets: [
              {
                id: v1Id,
                unit: 'sat',
                keys: { '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/v1/keys/${v3Id}`)) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: v3Id, unit: 'sat', keys: { '1': '02' + '33'.repeat(32) } }],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(token, { fetchFn });
    const dleqChecks = [...report.checked, ...report.notChecked].filter(
      (c) => c.checkId === 'dleq',
    );
    // The V1 proof (index 0) gets a DLEQ check, the V3 proof (index 1)
    // is labelled not-checked with severity none. The V1 proof carries
    // the NUT-12 valid vector, so its DLEQ verifies as valid here.
    expect(dleqChecks.length).toBe(2);
    const v1Check = report.checked.find(
      (c) => c.checkId === 'dleq' && c.result.includes('Proof 0'),
    );
    expect(v1Check).toBeDefined();
    expect(v1Check!.outcome).toBe('pass');
    expect(v1Check!.result).toContain('DLEQ valid');
    const v3Check = report.notChecked.find(
      (c) => c.checkId === 'dleq' && c.result.includes('Proof 1'),
    );
    expect(v3Check).toBeDefined();
    expect(v3Check!.severity).toBe('none');
    // Checkstate is also offered for a mixed token: the consent notice
    // appears when consent is not given.
    const checkstate = report.notChecked.find((c) => c.checkId === 'checkstate');
    expect(checkstate).toBeDefined();
    expect(checkstate!.result).toContain('Consent not given');
    // The headline is 'Not fully checked.': the V3 proof's signature was not verified,
    // an unknown state, even though the V1 DLEQ is valid.
    expect(report.headline).toBe('Not fully checked.');
  });

  it('an ambiguous short keyset ID is not resolved to the first prefix match', async () => {
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const v3Id = '02' + '00'.repeat(32);
    const otherId = '02' + '00'.repeat(31) + '01';
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v3Id,
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        // Both keysets share the 16-char short prefix 0200000000000000,
        // so the short ID is ambiguous and must not resolve to either.
        return new Response(
          JSON.stringify({
            keysets: [
              { id: v3Id, unit: 'sat', active: true },
              { id: otherId, unit: 'sat', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/v1/keys/${v3Id}`) || url.endsWith(`/v1/keys/${otherId}`)) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: v3Id, unit: 'sat', keys: { '1': '02' + '22'.repeat(32) } }],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(token, { fetchFn });
    // The token still decodes as v3-not-checked, and the residue screen
    // sees the raw short ID, not a wrongly resolved full ID. The report
    // must not claim the token keyset is either of the two full IDs.
    const residue = report.checked.find((c) => c.checkId === 'residue');
    expect(residue).toBeDefined();
    expect(residue!.result).not.toContain(v3Id);
    expect(residue!.result).not.toContain(otherId);
  });

  it('a stripped DLEQ inside a v3-not-checked token lands on AMBER, never silently dropped', async () => {
    // Build a mixed V1+V3 token, then strip the r from the V1 proof's
    // DLEQ via CBOR surgery. The incomplete DLEQ must surface as an
    // AMBER entry in the report, not vanish.
    const cbor = (await import('cbor')).default;
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const bytes32Hex = (ch: string): string => ch.repeat(32);
    const v3Id = '02' + '00'.repeat(32);
    const complete = getEncodedToken({
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
        {
          id: v3Id,
          amount: Amount.from(1),
          secret: bytes32Hex('f6'),
          C: '02' + bytes32Hex('07'),
        },
      ],
    });
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[0].p[0].d.r;
    const mangled = 'cashuB' + Buffer.from(await cbor.encodeAsync(raw)).toString('base64url');
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({
            keysets: [
              { id: '009a1f293253e41e', unit: 'sat', active: true },
              { id: v3Id, unit: 'sat', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keys/009a1f293253e41e')) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: '009a1f293253e41e', unit: 'sat', keys: { '1': '02' + '22'.repeat(32) } }],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(mangled, { fetchFn });
    const incomplete = report.notChecked.find(
      (c) => c.checkId === 'dleq' && c.result.includes('incomplete DLEQ'),
    );
    expect(incomplete).toBeDefined();
    expect(incomplete!.severity).toBe('amber');
    expect(report.headline).toBe('Hold, here is why.');
  });

  it('a V3 token lands on AMBER: its signature was not verified, and that is an unknown state', async () => {
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const v3Id = '02' + '00'.repeat(32);
    const token = getEncodedToken({
      mint: 'https://testnut.cashu.space',
      unit: 'sat',
      proofs: [
        {
          id: v3Id,
          amount: Amount.from(1),
          secret: 'aa'.repeat(32),
          C: '02' + 'bb'.repeat(32),
        },
      ],
    });
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: 'test',
            description: 'test',
            description_long: 'test',
            contact: [],
            motd: 'test',
            nuts: {},
            icon_url: '',
            time: 0,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({ keysets: [{ id: v3Id, unit: 'sat', active: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/v1/keys/${v3Id}`)) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: v3Id, unit: 'sat', keys: { '1': '02' + '22'.repeat(32) } }],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(token, { fetchFn });
    const decode = report.notChecked.find((c) => c.checkId === 'decode');
    expect(decode).toBeDefined();
    expect(decode!.outcome).toBe('not-checked');
    // The V3 signature was not verified, an unknown state, so the
    // headline is 'Not fully checked.', not clean.
    expect(decode!.severity).toBe('amber');
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
  });

  it('partial DLEQ caught by raw parse: a proof with DLEQ missing e is incomplete', async () => {
    // Build a complete token, then strip the DLEQ e from the CBOR bytes
    // and re-encode. The raw parser sees the DLEQ block with e missing,
    // and decodeAndReconcile reports it as an incomplete-DLEQ finding
    // instead of silently dropping it.
    const cbor = (await import('cbor')).default;
    const { getEncodedToken, Amount } = await import('@cashu/cashu-ts');
    const { parseTokenRaw } = await import('../src/rawParser.js');
    const { decodeAndReconcile } = await import('../src/decoder.js');
    const bytes32Hex = (ch: string): string => ch.repeat(32);
    const complete = getEncodedToken({
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
    const raw = await cbor.decodeFirst(
      Buffer.from(complete.slice('cashuB'.length), 'base64url'),
    );
    delete raw.t[0].p[0].d.e;
    const mangledBytes = await cbor.encodeAsync(raw);
    const mangled = 'cashuB' + Buffer.from(mangledBytes).toString('base64url');
    const parsed = await parseTokenRaw(mangled);
    expect(parsed.proofs[0].dleq.present).toBe(true);
    expect(parsed.proofs[0].dleq.e).toBe(false);
    expect(parsed.proofs[0].dleq.s).toBe(true);
    expect(parsed.proofs[0].dleq.r).toBe(true);
    const result = await decodeAndReconcile(mangled, ['009a1f293253e41e']);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') {
      return;
    }
    expect(result.token.proofs[0].dleq).toBeUndefined();
    expect(result.findings.some((f) => f.code === 'dleq-incomplete')).toBe(true);
  });

  it('mis-derived keyset ID: a flipped pubkey digit is flagged as a mismatch', async () => {
    const { checkKeysetDerivation } = await import('../src/keysetDerivation.js');
    // The evilmint keys are correct, so derivation matches. Tamper the
    // served keys: flip one digit of keyset B's pubkey, and the check
    // must report a mismatch.
    const tamperedKeys = JSON.parse(JSON.stringify(evilmintKeys)) as {
      keysets: Array<{ id: string; unit: string; keys: Record<string, string> }>;
    };
    const entry = tamperedKeys.keysets.find((k) => k.id === '00102821c3bc6333');
    if (entry) {
      const k = entry.keys['1'];
      entry.keys['1'] = k.slice(0, -1) + (k.endsWith('0') ? '1' : '0');
    }
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(evilmintKeysets), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(tamperedKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = tamperedKeys.keysets.find(
          (k) => k.id.toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    };
    const checks = await checkKeysetDerivation(
      'http://localhost:3338',
      'http://localhost:3338',
      fetchFn,
      ['00102821c3bc6333'],
    );
    expect(checks.some((c) => c.result === 'mismatch')).toBe(true);
  });

  it('unreachable mint: a mint that never answers yields AMBER, never clean', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('fetch failed');
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn });
    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');
  });

  for (const status of [401, 403]) {
    it(`checkstate ${status}: auth required is not-checked and AMBER, never clean`, async () => {
      // Use a collision-free mint (only keyset B) so the auth status is
      // the only amber in the report, and assert its severity is amber.
      const singleKeyset = JSON.parse(JSON.stringify(evilmintKeysets)) as {
        keysets: Array<Record<string, unknown>>;
      };
      singleKeyset.keysets = singleKeyset.keysets.filter((k) => k.id === '00102821c3bc6333');
      const singleKeys = JSON.parse(JSON.stringify(evilmintKeys)) as {
        keysets: Array<Record<string, unknown>>;
      };
      singleKeys.keysets = singleKeys.keysets.filter((k) => k.id === '00102821c3bc6333');
      const fetchFn = async (url: string): Promise<Response> => {
        if (url.endsWith('/v1/checkstate')) {
          return new Response('auth required', { status });
        }
        if (url.endsWith('/v1/info')) {
          return new Response(JSON.stringify(evilmintInfo), { status: 200 });
        }
        if (url.endsWith('/v1/keysets')) {
          return new Response(JSON.stringify(singleKeyset), { status: 200 });
        }
        if (url.endsWith('/v1/keys')) {
          return new Response(JSON.stringify(singleKeys), { status: 200 });
        }
        const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
        if (single) {
          const found = singleKeys.keysets.find(
            (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
          );
          if (found) {
            return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
          }
          return new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
      };
      const report = await diagnoseToken(evilmintToken, {
        fetchFn,
        consent: true,
      });
      expect(report.headline).toBe('Not fully checked.');
      const cs = report.notChecked.find((c) => c.checkId === 'checkstate');
      expect(cs).toBeDefined();
      expect(cs?.severity).toBe('amber');
      expect(cs?.message).toContain('auth required');
    });
  }

  it('valid DLEQ: the NUT-12 valid vector passes', () => {
    const check = verifyProofDleq(
      {
        amount: 1,
        id: '00882760bfa2eb41',
        secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
        C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
        dleq: {
          e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
          s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
          r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
        },
      },
      0,
      {
        id: '00882760bfa2eb41',
        unit: 'sat',
        keys: { 1: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
      },
    );
    expect(check.outcome).toBe('valid');
    expect(check.severity).toBe('none');
  });

  it('invalid DLEQ: a tampered e fails and is RED', () => {
    const check = verifyProofDleq(
      {
        amount: 1,
        id: '00882760bfa2eb41',
        secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
        C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
        dleq: {
          e: 'c31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
          s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
          r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
        },
      },
      0,
      {
        id: '00882760bfa2eb41',
        unit: 'sat',
        keys: { 1: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
      },
    );
    expect(check.outcome).toBe('invalid');
    expect(check.severity).toBe('red');
  });

  it('spent: a SPENT checkstate is RED', async () => {
    const { checkProofState } = await import('../src/checkstate.js');
    const fetchFn = stubFetchForTestnut(spentFixture);
    const result = await checkProofState(
      'https://testnut.cashu.space',
      'https://testnut.cashu.space',
      'ff8eb03618781736a038ddd5ff91f722a6e761714abbe435e1fb8e1fdf0ae3f3',
      true,
      fetchFn,
    );
    expect(result.status).toBe('checked');
    expect(result.state).toBe('spent');
    expect(result.severity).toBe('red');
  });

  it('spent at the report level: diagnoseToken with consent shows a SPENT proof as RED', async () => {
    // Stub checkstate to answer SPENT for the evilmint proof's Y, and
    // serve only keyset B so the collision does not mask the result.
    const singleKeyset = JSON.parse(JSON.stringify(evilmintKeysets)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeyset.keysets = singleKeyset.keysets.filter((k) => k.id === '00102821c3bc6333');
    const singleKeys = JSON.parse(JSON.stringify(evilmintKeys)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeys.keysets = singleKeys.keysets.filter((k) => k.id === '00102821c3bc6333');
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/v1/checkstate')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { Ys?: string[] };
        const Ys = Array.isArray(body.Ys) ? body.Ys : [];
        return new Response(
          JSON.stringify({
            states: Ys.map((Y) => ({ Y, state: 'SPENT', witness: null })),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(singleKeyset), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(singleKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = singleKeys.keysets.find(
          (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn, consent: true });
    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('red');
    const spent = report.checked.find(
      (c) => c.checkId === 'checkstate' && c.outcome === 'flag',
    );
    expect(spent).toBeDefined();
    expect(spent?.severity).toBe('red');
    expect(spent?.result).toContain('spent');
  });

  it('pending: a PENDING checkstate is AMBER', async () => {
    const { checkProofState } = await import('../src/checkstate.js');
    const pendingFixture = {
      states: [
        {
          Y: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
          state: 'PENDING',
          witness: null,
        },
      ],
    };
    const fetchFn = stubFetchForTestnut(pendingFixture);
    const result = await checkProofState(
      'https://testnut.cashu.space',
      'https://testnut.cashu.space',
      'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
      true,
      fetchFn,
    );
    expect(result.status).toBe('checked');
    expect(result.state).toBe('pending');
    expect(result.severity).toBe('amber');
  });

  it('pending at the report level: diagnoseToken with consent shows a PENDING proof as AMBER', async () => {
    const singleKeyset = JSON.parse(JSON.stringify(evilmintKeysets)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeyset.keysets = singleKeyset.keysets.filter((k) => k.id === '00102821c3bc6333');
    const singleKeys = JSON.parse(JSON.stringify(evilmintKeys)) as {
      keysets: Array<Record<string, unknown>>;
    };
    singleKeys.keysets = singleKeys.keysets.filter((k) => k.id === '00102821c3bc6333');
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/v1/checkstate')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { Ys?: string[] };
        const Ys = Array.isArray(body.Ys) ? body.Ys : [];
        return new Response(
          JSON.stringify({
            states: Ys.map((Y) => ({ Y, state: 'PENDING', witness: null })),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/info')) {
        return new Response(JSON.stringify(evilmintInfo), { status: 200 });
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(JSON.stringify(singleKeyset), { status: 200 });
      }
      if (url.endsWith('/v1/keys')) {
        return new Response(JSON.stringify(singleKeys), { status: 200 });
      }
      const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
      if (single) {
        const found = singleKeys.keysets.find(
          (k) => (k.id as string).toLowerCase() === single[1].toLowerCase(),
        );
        if (found) {
          return new Response(JSON.stringify({ keysets: [found] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    };
    const report = await diagnoseToken(evilmintToken, { fetchFn, consent: true });
    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('amber');
    const pending = report.checked.find(
      (c) => c.checkId === 'checkstate' && c.outcome === 'flag',
    );
    expect(pending).toBeDefined();
    expect(pending?.severity).toBe('amber');
    expect(pending?.result).toContain('pending');
  });
});

describe('evilmint mock', () => {
  it('the evilmint handler serves info, keysets, keys, and checkstate', async () => {
    const { evilmintHandler, KEYSET_A, KEYSET_B, EVILMINT_RESIDUE } = await import(
      '../scripts/evilmint.mjs'
    );
    expect(KEYSET_A.id).toBe('00206785c39be46b');
    expect(KEYSET_B.id).toBe('00102821c3bc6333');
    expect(EVILMINT_RESIDUE).toBe(1138537334);

    function callHandler(pathname: string, method = 'GET', body?: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
      return new Promise((resolve) => {
        const req = {
          url: pathname,
          method,
          on: (event: string, cb: (chunk?: string) => void) => {
            if (event === 'data' && body !== undefined) {
              cb(body);
            }
            if (event === 'end') {
              cb();
            }
          },
        };
        const res: {
          statusCode: number;
          headers: Record<string, string>;
          setHeader: (k: string, v: string) => void;
          writeHead: (code: number) => void;
          end: (data: string) => void;
        } = {
          statusCode: 200,
          headers: {},
          setHeader: (k: string, v: string) => {
            res.headers[k] = v;
          },
          writeHead: (code: number) => {
            res.statusCode = code;
          },
          end: (data: string) => {
            resolve({ status: res.statusCode, body: data, headers: res.headers });
          },
        };
        evilmintHandler(req as never, res as never);
      });
    }

    const info = await callHandler('/v1/info');
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body).name).toContain('Evilmint');
    const keysets = await callHandler('/v1/keysets');
    expect(keysets.status).toBe(200);
    const keysetIds = (JSON.parse(keysets.body).keysets as Array<{ id: string }>).map((k) => k.id);
    // The evilmint serves only its own keyset B. Keyset A is the known
    // trusted keyset, supplied by the caller, not served by the mock.
    expect(keysetIds).toEqual(['00102821c3bc6333']);
    const keys = await callHandler('/v1/keys');
    expect(keys.status).toBe(200);
    expect(JSON.parse(keys.body).keysets).toHaveLength(1);
    const single = await callHandler('/v1/keys/00102821c3bc6333');
    expect(single.status).toBe(200);
    const cs = await callHandler(
      '/v1/checkstate',
      'POST',
      JSON.stringify({ Ys: ['02' + '00'.repeat(32)] }),
    );
    expect(cs.status).toBe(200);
    expect(JSON.parse(cs.body).states[0].state).toBe('UNSPENT');
    const missing = await callHandler('/v1/nope');
    expect(missing.status).toBe(404);
    // CORS: the web report fetches this mock from a different origin,
    // so the handler sets the allow headers and answers preflight.
    const cors = await callHandler('/v1/info');
    expect(cors.status).toBe(200);
    expect(cors.headers['Access-Control-Allow-Origin']).toBe('*');
    const options = await callHandler('/v1/checkstate', 'OPTIONS');
    expect(options.status).toBe(204);
    expect(options.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(options.headers['Access-Control-Allow-Methods']).toContain('POST');
  });
});

describe('evilmint', () => {
  it('every mint request goes only to the mint named in the token', async () => {
    // The token-mint network boundary: diagnoseToken must never fetch
    // level here): diagnoseToken must never fetch from a mint other
    // than the one named in the token. Record every URL the fetch
    // receives and assert each one starts with the token mint base.
    const requested: string[] = [];
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href;
      requested.push(url);
      return stubFetchForEvilmint()(url);
    };
    const report = await diagnoseToken(evilmintToken, {
      fetchFn,
      consent: true,
      knownKeysets: ['00206785c39be46b'],
    });
    expect(report.mint).toBe('http://localhost:3338');
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) {
      expect(url.startsWith('http://localhost:3338/')).toBe(true);
    }
  });

  it('the evilmint token produces DLEQ passes, COLLISION flagged, keyset age shown, headline Hold', async () => {
    // Keyset A is the known trusted keyset, supplied through
    // knownKeysets. The evilmint token is for keyset B, the evilmint's
    // own keyset, which shares residue 1138537334 with A. The report
    // must flag a token-to-known collision while DLEQ passes.
    const report = await diagnoseToken(evilmintToken, {
      fetchFn: stubFetchForEvilmint(),
      knownKeysets: ['00206785c39be46b'],
    });
    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('amber');
    // DLEQ passes.
    const dleq = report.checked.find((c) => c.checkId === 'dleq');
    expect(dleq).toBeDefined();
    expect(dleq?.outcome).toBe('pass');
    expect(dleq?.result).toContain('DLEQ valid');
    // COLLISION flagged, and the report names the residue screen.
    const collision = report.checked.find(
      (c) => c.checkId === 'residue' && c.outcome === 'flag',
    );
    expect(collision).toBeDefined();
    expect(collision?.name).toBe('Residue screen');
    expect(collision?.result).toContain('COLLISION');
    expect(collision?.result).toContain('00206785c39be46b');
    expect(collision?.result).toContain('00102821c3bc6333');
    expect(collision?.result).toContain('1138537334');
    // The collision is token-to-known: the token keyset B collides
    // with the known trusted keyset A.
    expect(collision?.result).toContain('00102821c3bc6333 (token)');
    expect(collision?.result).toContain('00206785c39be46b (known)');
    // The mint lists the keyset the token uses, so that ID must appear
    // once, not twice as (token) and (mint).
    expect(collision?.result).not.toContain('00102821c3bc6333 (mint)');
    expect(collision?.message).toContain('A token keyset collides with a known keyset');
    // Keyset age shown. The age is honestly unknown (trust signal
    // only) unless a first-seen time is supplied; the entry must say
    // so, not invent an age.
    const age = report.checked.find((c) => c.name === 'Keyset age');
    expect(age).toBeDefined();
    expect(age?.result).toContain('unknown, trust signal only');
  });

  it('the evilmint token decodes to the evilmint mint', async () => {
    const report = await diagnoseToken(evilmintToken, { fetchFn: stubFetchForEvilmint() });
    expect(report.mint).toBe('http://localhost:3338');
  });
});

describe('malformed-token corpus', () => {
  const corpus = [
    { name: 'truncated', token: 'cashuB' },
    { name: 'bad prefix', token: 'cashuXAAAA' },
    { name: 'bad base64url', token: 'cashuB!!!not-base64url!!!' },
    {
      name: 'bad CBOR',
      token: 'cashuB' + Buffer.from([0xff, 0xff, 0xff]).toString('base64url'),
    },
    { name: 'empty', token: '' },
    { name: 'plain text', token: 'hello world' },
  ];
  for (const entry of corpus) {
    it(`corpus ${entry.name} is rejected cleanly`, async () => {
      // The fetch must never be called: a malformed token is rejected
      // before any mint request.
      let fetches = 0;
      const fetchFn = async (): Promise<Response> => {
        fetches += 1;
        throw new Error('fetch must not be called for a malformed token');
      };
      const report = await diagnoseToken(entry.token, { fetchFn });
      expect(report.headline).toBe('Hold, here is why.');
      expect(report.severity).toBe('amber');
      expect(fetches).toBe(0);
      // Every report has all three sections, even when short.
      expect(report.checked).toBeDefined();
      expect(report.notChecked).toBeDefined();
      expect(report.cannotProve).toBeDefined();
      expect(report.cannotProve.length).toBeGreaterThan(0);
      // The rejection is recorded as a decode finding, not just a headline.
      const decode = report.notChecked.find((c) => c.checkId === 'decode');
      expect(decode).toBeDefined();
      expect(['not-checked', 'error']).toContain(decode!.outcome);
    });
  }
});
