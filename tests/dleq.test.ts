import { describe, expect, it } from 'vitest';
import { verifyProofDleq } from '../src/dleq.js';

// The NUT-12 Proof vector: a valid DLEQ proof. A is the generator point G.
const validProof = {
  amount: 1,
  id: '00882760bfa2eb41',
  secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
  C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
  dleq: {
    e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
    s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
    r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
  },
};
const keyset = {
  id: '00882760bfa2eb41',
  unit: 'sat',
  keys: { 1: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
};

describe('DLEQ verification', () => {
  it('the NUT-12 valid vector passes', () => {
    const check = verifyProofDleq(validProof, 0, keyset);
    expect(check.outcome).toBe('valid');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('key consistency only');
  });

  it('a tampered DLEQ fails and is RED', () => {
    const tampered = {
      ...validProof,
      dleq: { ...validProof.dleq, e: 'c31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4' },
    };
    const check = verifyProofDleq(tampered, 0, keyset);
    expect(check.outcome).toBe('invalid');
    expect(check.severity).toBe('red');
    expect(check.message).toBe('DLEQ verification failed against the advertised key');
  });

  it('absent DLEQ is reported, never RED', () => {
    const { dleq: _dleq, ...noDleq } = validProof;
    const check = verifyProofDleq(noDleq, 0, keyset);
    expect(check.outcome).toBe('absent');
    expect(check.severity).toBe('none');
    expect(check.message).toBe('no DLEQ present, signatures cannot be verified offline');
  });

  it('a DLEQ present but missing e or s is incomplete, not absent', () => {
    const incomplete = { ...validProof, dleq: { e: '', s: validProof.dleq.s } };
    const check = verifyProofDleq(incomplete, 0, keyset);
    expect(check.outcome).toBe('incomplete');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('incomplete');
  });

  it('V3 proofs are skipped, not checked', () => {
    const v3Proof = {
      ...validProof,
      id: '02' + '00'.repeat(7) + '00'.repeat(25),
    };
    const check = verifyProofDleq(v3Proof, 0, keyset);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('V3 signatures are not checked');
  });

  it('a missing keyset is not-checked, never a crash', () => {
    const check = verifyProofDleq(validProof, 0, undefined);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
  });

  it('a keyset that does not belong to the proof is not-checked, never a misleading valid', () => {
    const wrongKeyset = {
      id: '009a1f293253e41e',
      unit: 'sat',
      keys: { 1: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
    };
    const check = verifyProofDleq(validProof, 0, wrongKeyset);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('does not belong to this proof');
  });

  it('an uppercase keyset ID on the proof is the same keyset, not a mismatch', () => {
    const upperProof = { ...validProof, id: validProof.id.toUpperCase() };
    const check = verifyProofDleq(upperProof, 0, keyset);
    expect(check.outcome).toBe('valid');
    expect(check.severity).toBe('none');
  });

  it('a keyset without a key for the proof amount is not-checked, never RED', () => {
    const keysetNoAmount = {
      id: '00882760bfa2eb41',
      unit: 'sat',
      keys: { 2: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
    };
    const check = verifyProofDleq(validProof, 0, keysetNoAmount);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('no public key for amount 1');
  });

  it('a keyset key that is not a usable point is not-checked, never RED', () => {
    const keysetBadKey = {
      id: '00882760bfa2eb41',
      unit: 'sat',
      keys: { 1: '02zzzz' },
    };
    const check = verifyProofDleq(validProof, 0, keysetBadKey);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('not a usable point');
  });

  it('a correctly formatted but off-curve key is not-checked, never RED', () => {
    const keysetOffCurve = {
      id: '00882760bfa2eb41',
      unit: 'sat',
      keys: { 1: '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    };
    const check = verifyProofDleq(validProof, 0, keysetOffCurve);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('not a usable point');
  });

  it('a proof C that is not a usable point is not-checked, never RED', () => {
    // A malformed C makes hasValidDleq return false, but an unusable
    // point is not a demonstrated invalid DLEQ. RED is reserved for a
    // DLEQ that ran and failed, so a bad C is not-checked.
    for (const badC of [
      '02zzzz',
      '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    ]) {
      const badProof = { ...validProof, C: badC };
      const check = verifyProofDleq(badProof, 0, keyset);
      expect(check.outcome).toBe('not-checked');
      expect(check.severity).toBe('none');
      expect(check.message).toContain('C is not a usable point');
    }
  });

  it('a DLEQ without r is not-checked, never RED, the proof cannot be verified offline', () => {
    const { r: _r, ...dleqNoR } = validProof.dleq;
    const noR = { ...validProof, dleq: dleqNoR };
    const check = verifyProofDleq(noR, 0, keyset);
    expect(check.outcome).toBe('not-checked');
    expect(check.severity).toBe('none');
    expect(check.message).toContain('blinding factor r is missing');
  });
});
