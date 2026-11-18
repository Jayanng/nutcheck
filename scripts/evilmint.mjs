// Evilmint mock: a deterministic Cashu mint that signs correctly with its
// own key (so DLEQ passes) but whose keyset collides in residue with a
// known trusted keyset, so the residue screen is what catches it. It
// serves /v1/info, /v1/keysets, /v1/keys, /v1/checkstate, and /v1/swap.
// No Lightning, no real funds: every run serves the same keyset, and the
// swap only mints new proofs for keyset B. The two keysets were found by
// a birthday search over derived V1 IDs: both derive from real keys, and
// both share residue 1138537334.
//   Keyset B: id 00102821c3bc6333, the evilmint's own keyset, served here.
//   Keyset A: id 00206785c39be46b, the known trusted keyset, supplied by
//     the caller through knownKeysets, not served by this mock.
// The token (tests/fixtures/evilmint/token.txt) is a proof for keyset B
// with a valid DLEQ. Run with:
//   node scripts/evilmint.mjs [port]
// Default port 3338. The mint base is http://localhost:<port>.
import { createServer } from 'node:http';
import { createBlindSignature, createDLEQProof, hashToCurve } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const EVILMINT_PORT = 3338;
export const EVILMINT_MINT = `http://localhost:${EVILMINT_PORT}`;

export const KEYSET_A = {
  // Keyset A is the known trusted keyset. It is NOT served by the
  // evilmint; the caller supplies it through knownKeysets. Keyset B,
  // the evilmint's own keyset, shares residue 1138537334 with A, so
  // the residue screen flags a token-to-known collision.
  id: '00206785c39be46b',
  priv: '55de3213061a5c5b6f2667c0f1f55dfd0758c3c91912bce199b0c343a518e090',
  pub: '03703356a18a6fcb99651ab428903a1c5d890533928cc4e3a7d3d8954de0fe216a',
  unit: 'sat',
};
export const KEYSET_B = {
  id: '00102821c3bc6333',
  priv: '6f50331145adc72cd8718e2990ab304b523b360093c536178fc0c000ddbadda6',
  pub: '03d96f211f5d7507b4915aa5247093fb28155425de443319e95d4ac052eff9d3d0',
  unit: 'sat',
};
export const EVILMINT_RESIDUE = 1138537334;

const INFO = {
  name: 'Evilmint (demo)',
  pubkey: KEYSET_B.pub,
  version: 'evilmint/0.2.0',
  description: 'A deterministic demo mint whose keyset collides in residue with a known trusted keyset.',
  description_long: 'Evilmint signs correctly with its own key, so DLEQ passes. Its keyset shares a residue with a known trusted keyset, so the residue screen is what catches it.',
  contact: [],
  motd: 'Demo mint. No real funds.',
  nuts: {
    '3': { supported: true },
    '7': { supported: true },
    '8': { supported: false },
    '9': { supported: false },
    '10': { supported: false },
    '11': { supported: false },
    '12': { supported: true },
    '14': { supported: false },
  },
};

const KEYSETS = {
  keysets: [
    { id: KEYSET_B.id, unit: KEYSET_B.unit, active: true, input_fee_ppk: 0 },
  ],
};

const KEYS = {
  keysets: [
    { id: KEYSET_B.id, unit: KEYSET_B.unit, keys: { 1: KEYSET_B.pub } },
  ],
};

// Spent proof Y values (hash_to_curve of the secret), hex. A proof whose
// Y is already here has been spent and is rejected.
const spentYs = new Set();

// Count of /v1/swap requests received. Tests use it to prove that a
// blocked receive made no swap request at all.
let swapRequestCount = 0;
export function getSwapRequestCount() {
  return swapRequestCount;
}

// Reset the spent set. Tests that import this module and run swaps
// should call it between cases so one swap does not leak into the next.
export function resetEvilmint() {
  spentYs.clear();
  swapRequestCount = 0;
}

function pointFromHex(hex) {
  return secp256k1.Point.fromHex(hex);
}

function verifyProof(proof) {
  // A proof is valid for keyset B when its C equals k * hash_to_curve(secret),
  // where k is the keyset private key. This is the mint-side check that the
  // blind signature is genuine.
  if (proof.id !== KEYSET_B.id) return { ok: false, detail: 'proof keyset is not keyset B' };
  if (typeof proof.amount !== 'number' || proof.amount <= 0) return { ok: false, detail: 'proof amount is not positive' };
  // Keyset B only serves a key for amount 1. Any other amount cannot be
  // signed correctly, so reject it rather than signing it under the
  // amount-1 key.
  if (proof.amount !== 1) return { ok: false, detail: 'proof amount is not 1, keyset B only serves amount 1' };
  if (typeof proof.secret !== 'string' || proof.secret === '') return { ok: false, detail: 'proof secret is empty' };
  if (typeof proof.C !== 'string' || proof.C === '') return { ok: false, detail: 'proof C is empty' };
  let Y;
  try {
    Y = hashToCurve(new TextEncoder().encode(proof.secret));
  } catch {
    return { ok: false, detail: 'secret does not hash to a curve point' };
  }
  const yHex = Buffer.from(Y.toBytes(true)).toString('hex');
  if (spentYs.has(yHex)) return { ok: false, detail: 'proof already spent' };
  const priv = BigInt('0x' + KEYSET_B.priv);
  const expected = Y.multiply(priv);
  const expectedHex = Buffer.from(expected.toBytes(true)).toString('hex');
  if (expectedHex.toLowerCase() !== proof.C.toLowerCase()) {
    return { ok: false, detail: 'proof signature does not match keyset B' };
  }
  return { ok: true, yHex };
}

export function evilmintHandler(req, res) {
  const url = new URL(req.url ?? '/', EVILMINT_MINT);
  // CORS: the web report fetches this mock from a different
  // local port, so the browser needs these headers, including the
  // preflight for POST /v1/checkstate and /v1/swap with a JSON body.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/v1/info') {
    res.writeHead(200);
    res.end(JSON.stringify(INFO));
    return;
  }
  if (url.pathname === '/v1/keysets') {
    res.writeHead(200);
    res.end(JSON.stringify(KEYSETS));
    return;
  }
  if (url.pathname === '/v1/keys') {
    res.writeHead(200);
    res.end(JSON.stringify(KEYS));
    return;
  }
  const single = url.pathname.match(/^\/v1\/keys\/([0-9a-fA-F]+)$/);
  if (single) {
    const id = single[1].toLowerCase();
    const found = KEYS.keysets.find((k) => k.id.toLowerCase() === id);
    if (found) {
      res.writeHead(200);
      res.end(JSON.stringify({ keysets: [found] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ detail: 'keyset not found' }));
    return;
  }
  if (url.pathname === '/v1/checkstate' && req.method === 'POST') {
    // Read the posted Ys and answer SPENT for proofs already swapped,
    // UNSPENT for the rest. The evilmint never spends except through swap.
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const Ys = Array.isArray(parsed.Ys) ? parsed.Ys : [];
        res.writeHead(200);
        res.end(
          JSON.stringify({
            states: Ys.map((Y) => ({
              Y,
              state: spentYs.has(String(Y).toLowerCase()) ? 'SPENT' : 'UNSPENT',
              witness: null,
            })),
          }),
        );
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ detail: 'bad request' }));
      }
    });
    return;
  }
  if (url.pathname === '/v1/swap' && req.method === 'POST') {
    swapRequestCount += 1;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const inputs = Array.isArray(parsed.inputs) ? parsed.inputs : [];
        const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
        if (inputs.length === 0 || outputs.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ detail: 'swap needs at least one input and one output' }));
          return;
        }
        // Verify every input proof before signing anything.
        const verified = [];
        const seenYs = new Set();
        for (const proof of inputs) {
          const v = verifyProof(proof);
          if (!v.ok) {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'invalid input proof: ' + v.detail }));
            return;
          }
          if (seenYs.has(v.yHex)) {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'duplicate input proof in one swap' }));
            return;
          }
          seenYs.add(v.yHex);
          verified.push(v);
        }
        const inTotal = inputs.reduce((s, p) => s + p.amount, 0);
        const outTotal = outputs.reduce((s, o) => s + (typeof o.amount === 'number' ? o.amount : 0), 0);
        if (inTotal !== outTotal) {
          res.writeHead(400);
          res.end(JSON.stringify({ detail: 'input and output amounts do not match' }));
          return;
        }
        // Sign each output blinded message with keyset B's private key.
        const privKey = Buffer.from(KEYSET_B.priv, 'hex');
        const signatures = [];
        for (const out of outputs) {
          if (out.id !== KEYSET_B.id) {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'output keyset is not keyset B' }));
            return;
          }
          if (typeof out.amount !== 'number' || out.amount <= 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'output amount is not positive' }));
            return;
          }
          // Keyset B only serves a key for amount 1.
          if (out.amount !== 1) {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'output amount is not 1, keyset B only serves amount 1' }));
            return;
          }
          if (typeof out.B_ !== 'string' || out.B_ === '') {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'output B_ is empty' }));
            return;
          }
          let bPoint;
          try {
            bPoint = pointFromHex(out.B_);
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ detail: 'output B_ is not a curve point' }));
            return;
          }
          const blindSig = createBlindSignature(bPoint, privKey, KEYSET_B.id);
          const cHex = Buffer.from(blindSig.C_.toBytes(true)).toString('hex');
          const dleq = createDLEQProof(bPoint, privKey);
          const dleqHex = {
            e: Buffer.from(dleq.e).toString('hex'),
            s: Buffer.from(dleq.s).toString('hex'),
          };
          signatures.push({ id: KEYSET_B.id, amount: out.amount, C_: cHex, dleq: dleqHex });
        }
        // Mark the inputs spent only after all outputs signed.
        for (const v of verified) spentYs.add(v.yHex);
        res.writeHead(200);
        res.end(JSON.stringify({ signatures }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ detail: 'bad request' }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ detail: 'not found' }));
}

export function startEvilmint(port = EVILMINT_PORT) {
  const server = createServer(evilmintHandler);
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

// When run directly, start the server and keep it up.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.argv[2] ?? EVILMINT_PORT);
  startEvilmint(port).then(() => {
    console.log(`evilmint listening on http://localhost:${port}`);
    console.log(`keyset B: ${KEYSET_B.id} (the evilmint keyset)`);
    console.log(`keyset A: ${KEYSET_A.id} (known trusted keyset, collides, residue ${EVILMINT_RESIDUE})`);
  });
}
