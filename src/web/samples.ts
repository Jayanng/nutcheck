// Sample tokens and mock fixtures for client-side demonstration and testing.
// Every sample token is a valid Cashu token representing a distinct check state.

export interface SampleToken {
  key: string;
  name: string;
  shortLabel: string;
  description: string;
  token: string;
  knownKeysets: string[];
  consent: boolean;
  mint: string;
  expectedState: 'green' | 'amber' | 'red';
  expectedStateWord: string;
  expectedHeadline: string;
  expectedStateAfterConsent?: 'green' | 'amber' | 'red';
  expectedHeadlineAfterConsent?: string;
}

export const SAMPLES: Record<string, SampleToken> = {
  clean: {
    key: 'clean',
    name: 'Clean token',
    shortLabel: 'clean',
    description: 'Decodes cleanly, valid keysets, valid signatures, unspent.',
    token: 'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIKiYWlIAOFXdwDhJ_FhcIGjYWEBYXN4QDAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDFhY1ghAhERERERERERERERERERERERERERERERERERERERERERomFpSAFhILMSZvIYYXCBo2FhFGFzeEAwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyYWNYIQIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIg',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://testnut.cashu.space',
    expectedState: 'green',
    expectedStateWord: 'No findings',
    expectedHeadline: 'No known issues found.',
  },
  evil: {
    key: 'evil',
    name: 'Evil mint token',
    shortLabel: 'collision',
    description: 'Colliding V1 keyset residue shared with a trusted keyset.',
    token: 'cashuBo2FtdWh0dHA6Ly9sb2NhbGhvc3Q6MzMzOGF1Y3NhdGF0gaJhaUgAECghw7xjM2FwgaRhYQFhc3glZXZpbG1pbnQtZGVtby1zZWNyZXQtMDAwMDAwMDAwMDAwMDAwMWFjWCECOjU6zzCXBlq-epbX3_GDMjCpN6jm15_Fya5g99RKXHVhZKNhZVggViAJUh8Y5fyvVpR1KKECbGC5yjlJUgsn-jTCnahxanJhc1ggVgpOjZc6p4zRwKg7rRuCzdJP9Lb1lPsqHyVtvQCypmNhclggERERERERERERERERERERERERERERERERERERERERERE',
    knownKeysets: ['00206785c39be46b'],
    consent: false,
    mint: 'http://localhost:3338',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
  spent: {
    key: 'spent',
    name: 'Spent token',
    shortLabel: 'spent',
    description: 'Proof state checked against mint: proof is already spent.',
    token: 'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAOFXdwDhJ_FhcIGjYWEBYXN4QDA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDdhY1ghAnd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://testnut.cashu.space',
    // Before consent, proof state is not checked, so the report is green
    // "No known issues found" (verified live 2026-11-18). After consent,
    // the simulated mint answer makes it red.
    expectedState: 'green',
    expectedStateWord: 'No findings',
    expectedHeadline: 'No known issues found.',
    expectedStateAfterConsent: 'red',
    expectedHeadlineAfterConsent: 'Hold, here is why.',
  },
  partial: {
    key: 'partial',
    name: 'Partial DLEQ token',
    shortLabel: 'incomplete',
    description: 'Raw parse detects stripped DLEQ field (r missing from payload).',
    token: 'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAOFXdwDhJ_FhcIGkYWEBYXN4QGExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhMWExYTFhY1ghArKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKyYWSiYWVYIMPDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDYXNYINTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://testnut.cashu.space',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
  pending: {
    key: 'pending',
    name: 'Pending proof token',
    shortLabel: 'pending',
    description: 'Mint reports proof state as pending (melt in flight).',
    token: 'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAOFXdwDhJ_FhcIGjYWEBYXN4QDA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDVhY1ghAlVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://testnut.cashu.space',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
  unreachable: {
    key: 'unreachable',
    name: 'Unreachable mint token',
    shortLabel: 'unreachable',
    description: 'Mint cannot be reached; verify manually.',
    token: 'cashuBo2FteCBodHRwczovL29mZmxpbmUtbWludC5leGFtcGxlLm9yZ2F1Y3NhdGF0gaJhaUgA4Vd3AOEn8WFwgaNhYQZhc3hAMDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNmFjWCECZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://offline-mint.example.org',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
  auth: {
    key: 'auth',
    name: 'Auth required token',
    shortLabel: 'auth required',
    description: 'Checkstate endpoint returns 401/403 (Blind auth required).',
    token: 'cashuBo2FteB1odHRwczovL2F1dGgtbWludC5leGFtcGxlLm9yZ2F1Y3NhdGF0gaJhaUgA4Vd3AOEn8WFwgaNhYQhhc3hAMDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwOGFjWCECiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIg',
    knownKeysets: ['00e1577700e127f1'],
    consent: false,
    mint: 'https://auth-mint.example.org',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
  v3: {
    key: 'v3',
    name: 'V3 BLS12-381 token',
    shortLabel: 'v3 keyset',
    description: 'V3 keyset (prefix 02) identified; secp DLEQ skipped.',
    token: 'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAgAAAAAAAABhcIGjYWEBYXN4QDA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDlhY1ghApmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZ',
    knownKeysets: ['020000000000000000000000000000000000000000000000000000000000000000'],
    consent: false,
    mint: 'https://testnut.cashu.space',
    expectedState: 'amber',
    expectedStateWord: 'Hold',
    expectedHeadline: 'Hold, here is why.',
  },
};

const v1Id = '00e1577700e127f1';
const v2Id = '016120b31266f218a699ebf7ca9f156fe7d90c8c1340d0004b4457ca39001a8db6';
const v3Id = '020000000000000000000000000000000000000000000000000000000000000000';
const evilId = '00102821c3bc6333';

const keys1: Record<string, string> = {
  '1': '02' + '11'.repeat(32),
};
const keys2: Record<string, string> = {
  '20': '02' + '22'.repeat(32),
};
const evilKeys: Record<string, string> = {
  '1': '03d96f211f5d7507b4915aa5247093fb28155425de443319e95d4ac052eff9d3d0',
};

// Fixture responses for offline operation and deterministic tests
export function getSampleFetchFn(sampleKey?: string) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.href;

    // Offline test mint
    if (url.includes('offline-mint.example.org')) {
      throw new Error('Network down: mint unreachable');
    }

    // Auth required mint
    if (url.includes('auth-mint.example.org')) {
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'auth-mint',
            pubkey: '02' + '11'.repeat(32),
            version: '0.1.0',
            description: 'Mock authenticated mint',
            nuts: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: v1Id, unit: 'sat', active: true }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keys') || url.includes('/v1/keys/')) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: v1Id, unit: 'sat', keys: keys1 }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/checkstate')) {
        return new Response('Blind auth required', { status: 401 });
      }
    }

    // Evil mint (local mock)
    if (url.includes('localhost:3338') || url.includes('evil.example')) {
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'evilmint',
            pubkey: '02' + '11'.repeat(32),
            version: '0.1.0',
            description: 'Adversarial mock mint with colliding keyset',
            nuts: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        return new Response(
          JSON.stringify({
            keysets: [{ id: evilId, unit: 'sat', active: true, input_fee_ppk: 0 }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keys') || url.includes('/v1/keys/')) {
        return new Response(
          JSON.stringify({
            keysets: [
              {
                id: evilId,
                unit: 'sat',
                keys: evilKeys,
              },
            ],
          }),
          { status: 200 },
        );
      }
    }

    // testnut responses
    if (url.includes('testnut.cashu.space')) {
      if (url.endsWith('/v1/info')) {
        return new Response(
          JSON.stringify({
            name: 'testnut',
            pubkey: '02' + '11'.repeat(32),
            version: '0.16.0',
            description: 'Test mint (testnut.cashu.space)',
            nuts: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/keysets')) {
        const keysets =
          sampleKey === 'v3'
            ? [{ id: v3Id, unit: 'sat', active: true }]
            : [
                { id: v1Id, unit: 'sat', active: true },
                { id: v2Id, unit: 'sat', active: true },
              ];
        return new Response(JSON.stringify({ keysets }), { status: 200 });
      }
      if (url.endsWith('/v1/keys') || url.includes('/v1/keys/')) {
        const single = url.match(/\/v1\/keys\/([0-9a-fA-F]+)$/);
        if (single) {
          const reqId = single[1].toLowerCase();
          if (reqId === v1Id.toLowerCase()) {
            return new Response(
              JSON.stringify({ keysets: [{ id: v1Id, unit: 'sat', keys: keys1 }] }),
              { status: 200 },
            );
          }
          if (reqId === v2Id.toLowerCase()) {
            return new Response(
              JSON.stringify({ keysets: [{ id: v2Id, unit: 'sat', keys: keys2 }] }),
              { status: 200 },
            );
          }
          if (reqId === v3Id.toLowerCase()) {
            return new Response(
              JSON.stringify({
                keysets: [{ id: v3Id, unit: 'sat', keys: { '1': '02' + '99'.repeat(32) } }],
              }),
              { status: 200 },
            );
          }
        }
        const keysets =
          sampleKey === 'v3'
            ? [{ id: v3Id, unit: 'sat', keys: { '1': '02' + '99'.repeat(32) } }]
            : [
                { id: v1Id, unit: 'sat', keys: keys1 },
                { id: v2Id, unit: 'sat', keys: keys2 },
              ];
        return new Response(JSON.stringify({ keysets }), { status: 200 });
      }
      if (url.endsWith('/v1/checkstate')) {
        let stateStr = 'UNSPENT';
        if (sampleKey === 'spent') {
          stateStr = 'SPENT';
        } else if (sampleKey === 'pending') {
          stateStr = 'PENDING';
        }
        let Ys: string[] = [];
        try {
          const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
          if (Array.isArray(parsed.Ys)) {
            Ys = parsed.Ys;
          }
        } catch {
          // fallback
        }
        if (Ys.length === 0) {
          Ys = ['02' + '11'.repeat(32)];
        }
        return new Response(
          JSON.stringify({
            states: Ys.map((Y: string) => ({
              Y,
              state: stateStr,
              witness: stateStr === 'SPENT' ? 'proof spent recorded' : null,
            })),
          }),
          { status: 200 },
        );
      }
    }

    // Fallback: try real fetch if available, else 404
    try {
      return await fetch(input, init);
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}
