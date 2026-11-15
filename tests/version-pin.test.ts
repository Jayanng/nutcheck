// Version pin test: the library versions are pinned exactly.
// If any of these fail, the build is on the wrong library version.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p: string): Record<string, any> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
}

describe('version pins', () => {
  it('has no overrides that could redirect a pinned version', () => {
    const pkg = readJson(path.join(root, 'package.json'));
    expect(pkg.overrides).toBeUndefined();
    expect(pkg.resolutions).toBeUndefined();
    expect(pkg.pnpm?.overrides).toBeUndefined();
    // A shrinkwrap file would take precedence over package-lock.json, so
    // there must not be one.
    expect(existsSync(path.join(root, 'npm-shrinkwrap.json'))).toBe(false);
  });

  it('the installed cashu-ts computes the NUT-13 vector residue', async () => {
    const cashu = await import('@cashu/cashu-ts');
    // Official NUT-13 vector: keyset 009a1f293253e41e reduces to 864559728.
    const residue = cashu.getKeysetIdInt('009a1f293253e41e');
    expect(residue).toBe(864559728n);
    // The residue is mod (2^31 - 1), not mod 2^31. The wrong modulus gives
    // 844358686, so the library must not return that value. This is a
    // library-facing assertion: it proves the installed library uses the
    // correct modulus.
    expect(residue).not.toBe(844358686n);
  });

  it('the installed cashu-ts reproduces the NUT-02 vector keyset IDs', async () => {
    const cashu = await import('@cashu/cashu-ts');
    const vectors = readJson(path.join(root, 'probes/nut02-vectors.json'));
    // Expected IDs are hard-coded here from the official NUT-02 vectors, so
    // the test does not just trust the fixture file: a wrong fixture fails.
    const v1 = cashu.deriveKeysetId(vectors.v1.keys, { versionByte: 0 });
    expect(v1).toBe('00456a94ab4e1c46');
    const v2 = cashu.deriveKeysetId(vectors.v2.keys, {
      versionByte: 1,
      unit: vectors.v2.unit,
      input_fee_ppk: vectors.v2.input_fee_ppk,
      expiry: vectors.v2.final_expiry,
    });
    expect(v2).toBe('015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a');
  });

  it('the installed cashu-ts has the expected exports and no v5 residue helper', async () => {
    const cashu = await import('@cashu/cashu-ts');
    expect(typeof cashu.getDecodedToken).toBe('function');
    expect(typeof cashu.getKeysetIdInt).toBe('function');
    expect(typeof cashu.deriveKeysetId).toBe('function');
    // The v5 helper is not declared in the 4.13.1 types, so read it through a
    // plain record instead of the typed namespace, or tsc rejects the access.
    const cashuRecord = cashu as unknown as Record<string, unknown>;
    expect(cashuRecord.findLegacyDerivationCollisions).toBeUndefined();
  });

  it('pins @cashu/cashu-ts to exactly 4.13.1', () => {
    const pkg = readJson(path.join(root, 'package.json'));
    expect(pkg.dependencies['@cashu/cashu-ts']).toBe('4.13.1');
    const installed = readJson(path.join(root, 'node_modules/@cashu/cashu-ts/package.json'));
    expect(installed.version).toBe('4.13.1');
    // The lockfile records the exact resolved version and an integrity hash.
    // npm verifies the hash on install, so the resolved package is the one
    // the lockfile names. This test checks the lockfile pins the version and
    // records an integrity hash; npm itself enforces the hash at install time.
    const lock = readJson(path.join(root, 'package-lock.json'));
    expect(lock.packages).toBeDefined();
    const locked = lock.packages?.['node_modules/@cashu/cashu-ts'];
    expect(locked).toBeDefined();
    expect(locked?.version).toBe('4.13.1');
    expect(typeof locked?.integrity).toBe('string');
    expect(locked?.integrity.length).toBeGreaterThan(0);
  });

  it('pins cbor to exactly 10.0.3', () => {
    const pkg = readJson(path.join(root, 'package.json'));
    expect(pkg.dependencies['cbor']).toBe('10.0.3');
    const installed = readJson(path.join(root, 'node_modules/cbor/package.json'));
    expect(installed.version).toBe('10.0.3');
    const lock = readJson(path.join(root, 'package-lock.json'));
    expect(lock.packages).toBeDefined();
    const locked = lock.packages?.['node_modules/cbor'];
    expect(locked).toBeDefined();
    expect(locked?.version).toBe('10.0.3');
    expect(typeof locked?.integrity).toBe('string');
    expect(locked?.integrity.length).toBeGreaterThan(0);
  });
});
