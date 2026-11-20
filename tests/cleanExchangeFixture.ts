// Replay fetch for the Clean sample: serves the real responses recorded
// from the live testnut.cashu.exchange mint (tests/fixtures/clean-exchange.json).
// The fixture holds real recorded data, not invented values. The product
// itself never uses it; it hits the live mint. The tests replay it so they
// stay deterministic and do not depend on the mint being up.
import { readFileSync } from 'node:fs';

interface FixtureRecord {
  url: string;
  method: string;
  body: string | null;
  status: number;
  response: string;
}

export function cleanExchangeFetchFn(): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/clean-exchange.json', import.meta.url), 'utf-8'),
  ) as { mint: string; records: FixtureRecord[] };
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.href;
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    const exact = fixture.records.find((r) => r.url === url && r.method === method && r.body === body);
    const record = exact || fixture.records.find((r) => r.url === url && r.method === method);
    if (!record) {
      return new Response('not found', { status: 404 });
    }
    return new Response(record.response, { status: record.status });
  };
}
