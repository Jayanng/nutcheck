// Tests for the evilmint mock: /v1/swap, /v1/checkstate, and the
// NutCheck receive findings. The evilmint is a deterministic mock mint
// whose keyset B collides in residue with the known keyset A.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// @ts-ignore - evilmint.mjs is a plain JS mock; its types are in evilmint.d.ts
import { startEvilmint, resetEvilmint, getSwapRequestCount, KEYSET_A, KEYSET_B } from '../scripts/evilmint.mjs';
import { diagnoseToken } from '../src/report.js';
import { parseTokenRaw } from '../src/rawParser.js';
import { hashToCurve, deriveKeysetId } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = 3338;
const BASE = `http://localhost:${PORT}`;
let server: any;

const EVIL_TOKEN = readFileSync('wallet-receive/token-colliding-residue.txt', 'utf8').trim();
const PARTIAL_TOKEN = readFileSync('wallet-receive/token-partial-dleq.txt', 'utf8').trim();

// Make a blinded output message B_ for amount 1. Pick a random secret,
// compute Y = hash_to_curve(secret), blind it with a random factor r.
function makeBlindedOutput() {
  const secret = randomBytes(32).toString('hex');
  const Y = hashToCurve(new TextEncoder().encode(secret));
  const r = randomBytes(32);
  const rPoint = secp256k1.Point.BASE.multiply(BigInt('0x' + Buffer.from(r).toString('hex')));
  const B_ = Y.add(rPoint);
  return { B_: Buffer.from(B_.toBytes(true)).toString('hex'), secret };
}

async function post(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function decodeEvilToken() {
  const raw = await parseTokenRaw(EVIL_TOKEN);
  const proof = raw.proofs[0];
  return { proof };
}

function proofInput(proof: any) {
  return { id: proof.id, amount: proof.amount, secret: proof.secret, C: proof.C };
}

beforeAll(async () => {
  server = await startEvilmint(PORT);
});

afterAll(() => {
  server.close();
});

describe('evilmint keyset derivation', () => {
  it('keyset A and B IDs derive from their public keys (NUT-02 V1)', () => {
    const idA = deriveKeysetId({ '1': KEYSET_A.pub }, { versionByte: 0 });
    expect(idA).toBe(KEYSET_A.id);
    const idB = deriveKeysetId({ '1': KEYSET_B.pub }, { versionByte: 0 });
    expect(idB).toBe(KEYSET_B.id);
  });

  it('both keyset IDs reduce to residue 1138537334 (NUT-13)', () => {
    const mod = 2n ** 31n - 1n;
    const residueA = BigInt('0x' + KEYSET_A.id) % mod;
    const residueB = BigInt('0x' + KEYSET_B.id) % mod;
    expect(residueA).toBe(1138537334n);
    expect(residueB).toBe(1138537334n);
    expect(residueA).toBe(residueB);
  });
});

describe('evilmint swap', () => {
  it('a valid amount-1 swap succeeds and returns well-formed signature fields', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const out = makeBlindedOutput();
    const { status, json } = await post('/v1/swap', {
      inputs: [proofInput(proof)],
      outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
    });
    expect(status).toBe(200);
    expect(json.signatures).toHaveLength(1);
    expect(json.signatures[0].id).toBe(KEYSET_B.id);
    expect(json.signatures[0].amount).toBe(1);
    expect(typeof json.signatures[0].C_).toBe('string');
    expect(json.signatures[0].C_.length).toBeGreaterThan(0);
    // The returned signature carries a DLEQ proof with well-formed e and s.
    const sig = json.signatures[0];
    expect(sig.dleq).toBeDefined();
    expect(sig.dleq.e).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.dleq.s).toMatch(/^[0-9a-f]{64}$/);
    // C_ is a valid compressed curve point (33 bytes, 66 hex).
    expect(sig.C_).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it('a second spend of the same input fails', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const input = proofInput(proof);
    const out1 = makeBlindedOutput();
    const first = await post('/v1/swap', { inputs: [input], outputs: [{ amount: 1, id: KEYSET_B.id, B_: out1.B_ }] });
    expect(first.status).toBe(200);
    const out2 = makeBlindedOutput();
    const second = await post('/v1/swap', { inputs: [input], outputs: [{ amount: 1, id: KEYSET_B.id, B_: out2.B_ }] });
    expect(second.status).toBe(400);
    expect(second.json.detail).toMatch(/already spent/);
  });

  it('a wrong-keyset input fails', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const out = makeBlindedOutput();
    const bad = { ...proofInput(proof), id: KEYSET_A.id };
    const { status, json } = await post('/v1/swap', {
      inputs: [bad],
      outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
    });
    expect(status).toBe(400);
    expect(json.detail).toMatch(/not keyset B/);
  });

  it('input and output totals must match', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const out = makeBlindedOutput();
    const { status, json } = await post('/v1/swap', {
      inputs: [proofInput(proof)],
      outputs: [
        { amount: 1, id: KEYSET_B.id, B_: out.B_ },
        { amount: 1, id: KEYSET_B.id, B_: out.B_ },
      ],
    });
    expect(status).toBe(400);
    expect(json.detail).toMatch(/do not match/);
  });

  it('an amount other than 1 is rejected', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const out = makeBlindedOutput();
    const { status, json } = await post('/v1/swap', {
      inputs: [{ ...proofInput(proof), amount: 1000000 }],
      outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
    });
    expect(status).toBe(400);
    expect(json.detail).toMatch(/not 1/);
  });

  it('duplicate inputs in one swap are rejected', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const out = makeBlindedOutput();
    const input = proofInput(proof);
    const { status, json } = await post('/v1/swap', {
      inputs: [input, input],
      outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
    });
    expect(status).toBe(400);
    expect(json.detail).toMatch(/duplicate/);
  });
});

describe('evilmint checkstate', () => {
  it('reports UNSPENT before a swap and SPENT after', async () => {
    resetEvilmint();
    const { proof } = await decodeEvilToken();
    const Y = hashToCurve(new TextEncoder().encode(proof.secret));
    const yHex = Buffer.from(Y.toBytes(true)).toString('hex');
    const before = await post('/v1/checkstate', { Ys: [yHex] });
    expect(before.status).toBe(200);
    expect(before.json.states[0].state).toBe('UNSPENT');
    const out = makeBlindedOutput();
    const swap = await post('/v1/swap', {
      inputs: [proofInput(proof)],
      outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
    });
    expect(swap.status).toBe(200);
    const after = await post('/v1/checkstate', { Ys: [yHex] });
    expect(after.status).toBe(200);
    expect(after.json.states[0].state).toBe('SPENT');
  });
});

describe('nutcheck findings on the evilmint tokens', () => {
  it('the colliding token is Hold with residue 1138537334, AMBER severity', async () => {
    const report = await diagnoseToken(EVIL_TOKEN, {
      knownKeysets: [KEYSET_A.id],
      consent: false,
    });
    expect(report.headline).toBe('Hold, here is why.');
    const residue = report.checked.find((c) => c.name === 'Residue screen');
    expect(residue).toBeDefined();
    expect(residue!.result).toMatch(/1138537334/);
    expect(residue!.result).toMatch(/00102821c3bc6333/);
    expect(residue!.result).toMatch(/00206785c39be46b/);
    expect(residue!.severity).toBe('amber');
  });

  it('the partial-DLEQ token differs from the colliding token only by r', async () => {
    const rawEvil = await parseTokenRaw(EVIL_TOKEN);
    const rawPartial = await parseTokenRaw(PARTIAL_TOKEN);
    const proofEvil = rawEvil.proofs[0];
    const proofPartial = rawPartial.proofs[0];
    // Same secret, same C, same keyset, same amount.
    expect(proofPartial.secret).toBe(proofEvil.secret);
    expect(proofPartial.C).toBe(proofEvil.C);
    expect(proofPartial.id).toBe(proofEvil.id);
    expect(proofPartial.amount).toBe(proofEvil.amount);
    // DLEQ: e and s remain, only r is missing.
    expect(proofEvil.dleq.present).toBe(true);
    expect(proofEvil.dleq.e).toBe(true);
    expect(proofEvil.dleq.s).toBe(true);
    expect(proofEvil.dleq.r).toBe(true);
    expect(proofPartial.dleq.present).toBe(true);
    expect(proofPartial.dleq.e).toBe(true);
    expect(proofPartial.dleq.s).toBe(true);
    expect(proofPartial.dleq.r).toBe(false);
    const report = await diagnoseToken(PARTIAL_TOKEN, {
      knownKeysets: [KEYSET_A.id],
      consent: false,
    });
    expect(report.headline).toBe('Hold, here is why.');
    const dleq = [...report.checked, ...report.notChecked].find((c) => c.name === 'DLEQ');
    expect(dleq).toBeDefined();
    expect(dleq!.result).toMatch(/incomplete/);
    expect(dleq!.result).not.toMatch(/invalid/);
    expect(dleq!.severity).toBe('amber');
  });

  it('the receive check blocks both Hold cases', async () => {
    for (const token of [EVIL_TOKEN, PARTIAL_TOKEN]) {
      const report = await diagnoseToken(token, {
        knownKeysets: [KEYSET_A.id],
        consent: false,
      });
      const blocked = report.headline === 'Hold, here is why.';
      expect(blocked).toBe(true);
    }
  });

  it('the wallet check blocks before redeem and makes no swap request', async () => {
    // Simulate the wallet receive entry point: diagnose first, redeem only
    // if the headline is not Hold. Track whether redeem was called and
    // whether the mock mint saw a swap.
    resetEvilmint();
    let redeemCalled = false;
    const redeem = async () => {
      redeemCalled = true;
      const out = makeBlindedOutput();
      const { proof } = await decodeEvilToken();
      await post('/v1/swap', {
        inputs: [proofInput(proof)],
        outputs: [{ amount: 1, id: KEYSET_B.id, B_: out.B_ }],
      });
    };
    for (const token of [EVIL_TOKEN, PARTIAL_TOKEN]) {
      const report = await diagnoseToken(token, {
        knownKeysets: [KEYSET_A.id],
        consent: false,
      });
      if (report.headline === 'Hold, here is why.') {
        // Check throws, redeem never runs.
        expect(() => {
          throw new Error(`NutCheck hold: ${report.checked.map((c) => c.name).join(', ')}`);
        }).toThrow('NutCheck hold');
      } else {
        await redeem();
      }
    }
    expect(redeemCalled).toBe(false);
    // The mock mint saw zero swap requests, proving no swap ran.
    expect(getSwapRequestCount()).toBe(0);
    // The mock mint should have no spent proofs, proving no swap ran.
    const { proof } = await decodeEvilToken();
    const Y = hashToCurve(new TextEncoder().encode(proof.secret));
    const yHex = Buffer.from(Y.toBytes(true)).toString('hex');
    const state = await post('/v1/checkstate', { Ys: [yHex] });
    expect(state.json.states[0].state).toBe('UNSPENT');
  });
});
