// Evilmint mock: a deterministic Cashu mint that signs correctly with its
// own key (so DLEQ passes) but whose keyset collides in residue with a
// known trusted keyset, so the residue screen is what catches it. It
// serves /v1/info, /v1/keysets, /v1/keys, and /v1/checkstate. No
// Lightning, no funds, no state: every run serves the same keyset. The
// two keysets were found by a birthday search over derived V1 IDs: both
// derive from real keys, and both share residue 1138537334.
//   Keyset B: id 00102821c3bc6333, the evilmint's own keyset, served here.
//   Keyset A: id 00206785c39be46b, the known trusted keyset, supplied by
//     the caller through knownKeysets, not served by this mock.
// The token (tests/fixtures/evilmint/token.txt) is a proof for keyset B
// with a valid DLEQ. Run with:
//   node scripts/evilmint.mjs [port]
// Default port 3338. The mint base is http://localhost:<port>.
import { createServer } from 'node:http';

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
  version: 'evilmint/0.1.0',
  description: 'A deterministic demo mint whose keyset collides in residue with a known trusted keyset.',
  description_long: 'Evilmint signs correctly with its own key, so DLEQ passes. Its keyset shares a residue with a known trusted keyset, so the residue screen is what catches it.',
  contact: [],
  motd: 'Demo mint. No real funds.',
  nuts: {
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

export function evilmintHandler(req, res) {
  const url = new URL(req.url ?? '/', EVILMINT_MINT);
  // CORS: the web report fetches this mock from a different
  // local port, so the browser needs these headers, including the
  // preflight for POST /v1/checkstate with a JSON body.
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
    // The evilmint never spends: every proof it minted is unspent.
    // Read the posted Ys and answer UNSPENT for each.
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
            states: Ys.map((Y) => ({ Y, state: 'UNSPENT', witness: null })),
          }),
        );
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
