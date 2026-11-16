// Mint facts. Calls GET /v1/info and GET /v1/keysets on a mint and
// surfaces what the mint says about itself: version, the nuts map, keyset
// IDs, the active flag, input_fee_ppk as given, final_expiry, and keyset
// age. Keyset age is a trust signal, not a cryptographic fact, and the
// copy says so. A fetch failure is reported as unknown, never as fail.
import { fetchMintJson, mintEndpointUrl, isRecord, type FetchFn } from './fetch.js';

export interface KeysetFact {
  id: string;
  unit: string;
  // True when the mint says the keyset is active, false when it says it
  // is inactive, undefined when the flag is absent or malformed. An
  // absent flag does not establish that the keyset is inactive.
  active: boolean | undefined;
  inputFeePpk: number | undefined;
  finalExpiry: number | undefined;
  // Keyset age is a trust signal, not a cryptographic fact. The keysets
  // response carries no creation timestamp, so age is unknown unless the
  // caller supplies a first-seen time.
  age: string;
}

export interface MintFacts {
  mintUrl: string;
  name: string | undefined;
  version: string | undefined;
  nuts: Record<string, unknown>;
  keysets: KeysetFact[];
  // 'ok' when both calls worked, 'unknown' when either failed.
  status: 'ok' | 'unknown';
  error: string | undefined;
  // A field the mint supplied in a form that cannot be used (a
  // fractional or negative fee, a negative expiry) is named here, so
  // the report can say the mint's metadata was malformed instead of
  // silently treating it as absent. Empty when nothing was malformed.
  findings: string[];
}

function keysetAge(): string {
  return 'unknown: the keysets response carries no creation timestamp, so age is a trust signal only when a first-seen time is known';
}

export async function getMintFacts(
  mintUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<MintFacts> {
  let info: Record<string, unknown> | undefined;
  let keysetsRaw: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    info = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/info'), {}, fetchFn)) as Record<string, unknown>;
    if (!isRecord(info)) {
      throw new Error('the /v1/info response is not an object');
    }
    keysetsRaw = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/keysets'), {}, fetchFn)) as Record<string, unknown>;
    if (!isRecord(keysetsRaw) || !Array.isArray(keysetsRaw.keysets)) {
      throw new Error('the /v1/keysets response has no keysets list');
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return {
      mintUrl,
      name: undefined,
      version: undefined,
      nuts: {},
      keysets: [],
      status: 'unknown',
      error,
      findings: [],
    };
  }
  // Each keyset entry must carry a usable ID and unit. A malformed entry
  // (an empty object, a non-string ID, a missing unit) is not a keyset
  // fact; the whole call is reported as unknown instead of presenting
  // blank IDs as facts.
  const keysets: KeysetFact[] = [];
  const findingsSoFar: string[] = [];
  for (const entry of keysetsRaw.keysets as unknown[]) {
    const record = isRecord(entry) ? entry : {};
    const id = typeof record.id === 'string' ? record.id : '';
    const unit = typeof record.unit === 'string' ? record.unit : '';
    if (id === '' || unit === '') {
      return {
        mintUrl,
        name: typeof info.name === 'string' ? info.name : undefined,
        version: typeof info.version === 'string' ? info.version : undefined,
        nuts: isRecord(info.nuts) ? info.nuts : {},
        keysets: [],
        status: 'unknown',
        error: 'the /v1/keysets response has a keyset entry without a usable ID or unit',
        findings: [],
      };
    }
    // A fee or expiry the mint supplied in a form that cannot be used
    // is named in findings, so absent and malformed stay distinguishable.
    const findings: string[] = [];
    const feeOk =
      typeof record.input_fee_ppk === 'number' &&
      Number.isSafeInteger(record.input_fee_ppk) &&
      record.input_fee_ppk >= 0;
    const expiryOk =
      typeof record.final_expiry === 'number' &&
      Number.isSafeInteger(record.final_expiry) &&
      record.final_expiry >= 0;
    if (record.input_fee_ppk !== undefined && !feeOk) {
      findings.push(`keyset ${id} advertises a malformed input_fee_ppk`);
    }
    if (record.final_expiry !== undefined && !expiryOk) {
      findings.push(`keyset ${id} advertises a malformed final_expiry`);
    }
    keysets.push({
      id,
      unit,
      active: typeof record.active === 'boolean' ? record.active : undefined,
      // The fee and expiry are published only when they are non-negative
      // safe integers, the same rule the derivation check applies. A
      // fractional, negative, or non-finite value is malformed metadata,
      // not a fact, so it is left undefined here and named in findings.
      inputFeePpk: feeOk ? (record.input_fee_ppk as number) : undefined,
      finalExpiry: expiryOk ? (record.final_expiry as number) : undefined,
      age: keysetAge(),
    });
    findingsSoFar.push(...findings);
  }
  return {
    mintUrl,
    name: typeof info.name === 'string' ? info.name : undefined,
    version: typeof info.version === 'string' ? info.version : undefined,
    nuts: isRecord(info.nuts) ? info.nuts : {},
    keysets,
    status: 'ok',
    error: undefined,
    findings: findingsSoFar,
  };
}
