// Keyset-ID derivation check. Fetches the keys, recomputes the ID
// with deriveKeysetId using the right version options, and compares it
// with the advertised ID. NUT-02 V2 ID derivation is SHA256 over a
// structured string of the keyset data; that is a separate step from the
// NUT-13 secret derivation, so the two are not mixed up here. A mismatch
// is a finding. A fetch failure is "unknown", never "fail".
import { deriveKeysetId } from '@cashu/cashu-ts';
import { fetchMintJson, mintEndpointUrl, mintOrigin, isRecord, type FetchFn } from './fetch.js';
import { classifyKeysetVersion } from './keysetVersion.js';

export interface KeysetDerivationCheck {
  advertisedId: string;
  derivedId: string | undefined;
  unit: string;
  // 'match' when the recomputed ID equals the advertised one, 'mismatch'
  // when it does not, 'unknown' when the keys could not be fetched.
  result: 'match' | 'mismatch' | 'unknown';
  detail: string;
}

function versionByteFor(id: string): number | undefined {
  const version = classifyKeysetVersion(id);
  if (version === 'v1') {
    return 0;
  }
  if (version === 'v2') {
    return 1;
  }
  return undefined;
}

export async function checkKeysetDerivation(
  mintUrl: string,
  fetchFn: FetchFn = fetch,
  tokenKeysetIds: string[] = [],
): Promise<KeysetDerivationCheck[]> {
  let keysRaw: Record<string, unknown> | undefined;
  let keysetsRaw: Record<string, unknown> | undefined;
  try {
    // The one origin this call is allowed to contact: the mint it was
    // configured with. The fetch helper refuses any other origin.
    const allowedOrigin = mintOrigin(mintUrl);
    keysRaw = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/keys'), {}, fetchFn, allowedOrigin)) as Record<string, unknown>;
    if (!isRecord(keysRaw) || !Array.isArray(keysRaw.keysets)) {
      throw new Error('the /v1/keys response has no keysets list');
    }
    keysetsRaw = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/keysets'), {}, fetchFn, allowedOrigin)) as Record<string, unknown>;
    if (!isRecord(keysetsRaw) || !Array.isArray(keysetsRaw.keysets)) {
      throw new Error('the /v1/keysets response has no keysets list');
    }
  } catch (err) {
    // A failed list request leaves every token-referenced keyset
    // unchecked. Report one unknown per token keyset ID so none is
    // silently dropped, plus one for the list failure itself.
    const detail = `the keys could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    const checks: KeysetDerivationCheck[] = tokenKeysetIds.map((id) => ({
      advertisedId: id,
      derivedId: undefined,
      unit: '',
      result: 'unknown' as const,
      detail,
    }));
    if (checks.length === 0) {
      checks.push({
        advertisedId: '',
        derivedId: undefined,
        unit: '',
        result: 'unknown',
        detail,
      });
    }
    return checks;
  }
  const metaById = new Map<string, Record<string, unknown>>();
  for (const entry of keysetsRaw.keysets as unknown[]) {
    if (isRecord(entry) && typeof entry.id === 'string') {
      // Map keys are normalized to lowercase so a token-supplied
      // uppercase ID and a mint-listed lowercase ID are the same keyset.
      // The advertised spelling is kept in the entry itself for display.
      metaById.set(entry.id.toLowerCase(), entry);
    }
  }
  // GET /v1/keys returns only the active keysets (NUT-01). A token can
  // still reference an inactive keyset, so for every keyset in
  // /v1/keysets that is missing from /v1/keys, fetch its keys directly
  // from /v1/keys/{keyset_id} and check its derivation too. A token can
  // also reference a keyset the mint no longer lists in /v1/keysets at
  // all, so the caller passes the token's keyset IDs and those are
  // fetched the same way. A token-referenced keyset whose keys cannot be
  // fetched is reported as unknown, never silently skipped.
  const keysById = new Map<string, Record<string, unknown>>();
  const checks: KeysetDerivationCheck[] = [];
  for (const entry of keysRaw.keysets as unknown[]) {
    if (isRecord(entry) && typeof entry.id === 'string' && isRecord(entry.keys)) {
      keysById.set(entry.id.toLowerCase(), entry);
    }
  }
  // The advertised spelling of each ID, for display. The mint-listed
  // spelling wins; a token-supplied spelling is used only when the mint
  // does not list the keyset. Map and set keys are always lowercase.
  const advertisedById = new Map<string, string>();
  for (const entry of keysetsRaw.keysets as unknown[]) {
    if (isRecord(entry) && typeof entry.id === 'string') {
      advertisedById.set(entry.id.toLowerCase(), entry.id);
    }
  }
  for (const id of tokenKeysetIds) {
    const lower = id.toLowerCase();
    if (!advertisedById.has(lower)) {
      advertisedById.set(lower, id);
    }
  }
  const idsToFetch = new Set<string>();
  for (const id of metaById.keys()) {
    idsToFetch.add(id);
  }
  for (const id of tokenKeysetIds) {
    idsToFetch.add(id.toLowerCase());
  }
  for (const id of idsToFetch) {
    if (keysById.has(id)) {
      continue;
    }
    const advertisedId = advertisedById.get(id) ?? id;
    // A keyset ID is a hex string. Anything else is not a keyset ID, so
    // it is never interpolated into a URL.
    if (!/^[0-9a-fA-F]+$/.test(id)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: '',
        result: 'unknown',
        detail: 'the advertised ID is not a hex string, so its keys were not fetched',
      });
      continue;
    }
    try {
      const single = (await fetchMintJson(
        mintEndpointUrl(mintUrl, `/v1/keys/${id}`),
        {},
        fetchFn,
        mintOrigin(mintUrl),
      )) as Record<string, unknown>;
      if (isRecord(single) && Array.isArray(single.keysets) && single.keysets.length > 0) {
        // Select ONLY an entry whose ID matches the requested ID
        // case-insensitively. Keyset IDs are lowercase hex, but a mint
        // may advertise uppercase, and the module compares IDs
        // case-insensitively elsewhere, so an uppercase response for a
        // lowercase request is the same keyset, not an inconsistency.
        // If no entry matches, the requested keyset was not returned:
        // report it as unknown with the IDs that were returned, instead
        // of falling back to an unrelated first entry.
        const matched = (single.keysets as unknown[]).find(
          (e) => isRecord(e) && typeof e.id === 'string' && e.id.toLowerCase() === id.toLowerCase(),
        );
        if (!isRecord(matched) || typeof matched.id !== 'string') {
          const returnedIds = (single.keysets as unknown[])
            .filter((e) => isRecord(e) && typeof e.id === 'string')
            .map((e) => (e as Record<string, unknown>).id as string)
            .join(', ');
          checks.push({
            advertisedId,
            derivedId: undefined,
            unit: '',
            result: 'unknown',
            detail: `the mint returned keys for ${returnedIds || 'no keysets'} when ${advertisedId} was asked for, so the ID was not recomputed`,
          });
          continue;
        }
        const first = matched;
        if (isRecord(first.keys)) {
          keysById.set(id, first);
          continue;
        }
      }
      // The call worked but the body held no usable keys for this keyset.
      // Report it as unknown below instead of dropping it silently.
      keysById.set(id, { id, unit: '', keys: undefined });
    } catch {
      // An inactive keyset whose keys cannot be fetched is reported as
      // unknown below, never as a failure of the whole check.
      keysById.set(id, { id, unit: '', keys: undefined });
    }
  }
  for (const [key, entry] of keysById) {
    // Display the advertised spelling: the mint-listed spelling when
    // the keyset is listed, otherwise the token-supplied spelling, both
    // from advertisedById. The entry's own ID is not used here because
    // a /v1/keys/{id} response may spell the same ID in a different
    // case than the mint's listing.
    const advertisedId = advertisedById.get(key) ?? key;
    if (!isRecord(entry.keys)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        result: 'unknown',
        detail: 'the keys for this keyset could not be fetched',
      });
      continue;
    }
    // The unit comes from the /v1/keys entry when present, and falls back
    // to the /v1/keysets entry. For V2 the unit is hashed into the ID, so
    // if neither response carries one, the ID cannot be established and
    // the check reports unknown instead of guessing 'sat'. For V1 the
    // unit is not part of the digest, so a missing unit is fine there.
    const meta = metaById.get(key);
    const keysUnit = typeof entry.unit === 'string' ? entry.unit : undefined;
    const metaUnit = typeof meta?.unit === 'string' ? meta.unit : undefined;
    if (keysUnit !== undefined && metaUnit !== undefined && keysUnit !== metaUnit) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: keysUnit,
        result: 'unknown',
        detail: 'the /v1/keys and /v1/keysets responses disagree on the unit, so the ID cannot be established',
      });
      continue;
    }
    const unit = keysUnit ?? metaUnit;
    const version = classifyKeysetVersion(advertisedId);
    if (version === 'v2' && unit === undefined) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: '',
        result: 'unknown',
        detail: 'no unit was supplied for this keyset, so the V2 ID cannot be established',
      });
      continue;
    }
    const effectiveUnit = unit ?? 'sat';
    if (version === 'v3') {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'this is a V3 keyset (BLS12-381); V3 keyset ID derivation is not checked here',
      });
      continue;
    }
    const versionByte = versionByteFor(advertisedId);
    if (versionByte === undefined) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the advertised ID has an unknown version, so it was not recomputed',
      });
      continue;
    }
    // The fee comes from either response. If both carry a number and
    // they disagree, the V2 inputs cannot be established. A present but
    // malformed fee (not a number, or negative) is not the same as an
    // absent fee: it means the inputs were not established, so the
    // check reports unknown instead of deriving with the default of 0.
    // That only applies to V2. V1 derives its ID from the public keys
    // alone, so a malformed or conflicting fee does not block a V1
    // comparison; it is noted in the result detail instead.
    const keysFeeRaw = entry.input_fee_ppk;
    const metaFeeRaw = meta?.input_fee_ppk;
    const keysFeeMalformed =
      keysFeeRaw !== undefined &&
      (typeof keysFeeRaw !== 'number' || !Number.isSafeInteger(keysFeeRaw) || keysFeeRaw < 0);
    const metaFeeMalformed =
      metaFeeRaw !== undefined &&
      (typeof metaFeeRaw !== 'number' || !Number.isSafeInteger(metaFeeRaw) || metaFeeRaw < 0);
    const keysFee = typeof keysFeeRaw === 'number' ? keysFeeRaw : undefined;
    const metaFee = typeof metaFeeRaw === 'number' ? metaFeeRaw : undefined;
    const feeConflict = keysFee !== undefined && metaFee !== undefined && keysFee !== metaFee;
    const v1Notes: string[] = [];
    if (versionByte === 1 && (keysFeeMalformed || metaFeeMalformed)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the input fee in the mint response is malformed, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 1 && feeConflict) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the /v1/keys and /v1/keysets responses disagree on the input fee, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 0) {
      if (keysFeeMalformed || metaFeeMalformed) {
        v1Notes.push('the mint advertises a malformed input_fee_ppk, which V1 derivation does not use');
      } else if (feeConflict) {
        v1Notes.push('the /v1/keys and /v1/keysets responses disagree on the input fee, which V1 derivation does not use');
      }
    }
    const inputFeePpk = versionByte === 1 ? keysFee ?? metaFee : undefined;
    // The expiry comes from /v1/keysets when present, and falls back to
    // the /v1/keys entry (which is the only source for a token-referenced
    // keyset the mint no longer lists). If both carry a number and they
    // disagree, the V2 inputs cannot be established. A present but
    // malformed expiry is unknown, not absent. As with the fee, that
    // only blocks V2; a V1 comparison proceeds and notes it instead.
    const keysExpiryRaw = entry.final_expiry;
    const metaExpiryRaw = meta?.final_expiry;
    const keysExpiryMalformed =
      keysExpiryRaw !== undefined &&
      (typeof keysExpiryRaw !== 'number' || !Number.isSafeInteger(keysExpiryRaw) || keysExpiryRaw < 0);
    const metaExpiryMalformed =
      metaExpiryRaw !== undefined &&
      (typeof metaExpiryRaw !== 'number' || !Number.isSafeInteger(metaExpiryRaw) || metaExpiryRaw < 0);
    const keysExpiry = typeof keysExpiryRaw === 'number' ? keysExpiryRaw : undefined;
    const metaExpiry = typeof metaExpiryRaw === 'number' ? metaExpiryRaw : undefined;
    const expiryConflict = keysExpiry !== undefined && metaExpiry !== undefined && keysExpiry !== metaExpiry;
    if (versionByte === 1 && (keysExpiryMalformed || metaExpiryMalformed)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the expiry in the mint response is malformed, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 1 && expiryConflict) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the /v1/keys and /v1/keysets responses disagree on the expiry, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 0) {
      if (keysExpiryMalformed || metaExpiryMalformed) {
        v1Notes.push('the mint advertises a malformed final_expiry, which V1 derivation does not use');
      } else if (expiryConflict) {
        v1Notes.push('the /v1/keys and /v1/keysets responses disagree on the expiry, which V1 derivation does not use');
      }
    }
    const expiry = versionByte === 1 ? metaExpiry ?? keysExpiry : undefined;
    // The fee: NUT-02 says input_fee_ppk defaults to 0 when absent, and
    // deriveKeysetId treats an omitted fee the same as 0 (proven live:
    // the V2 vector with fee undefined and fee 0 give the same ID). An
    // omitted fee is therefore not a gap; a mint with a non-zero fee
    // that does not report it will produce a mismatch, which is the
    // correct finding.
    // The keys must be a map of amount strings to pubkey strings, and it
    // cannot be empty. A malformed mint response with non-string values,
    // or an empty key list, is reported as unknown, never as a
    // cryptographic mismatch.
    const keysRecord = entry.keys as Record<string, unknown>;
    const keysEntries = Object.entries(keysRecord);
    const keysValid =
      keysEntries.length > 0 &&
      keysEntries.every(
        ([amount, pubkey]) =>
          /^\d+$/.test(amount) && typeof pubkey === 'string' && /^[0-9a-fA-F]+$/.test(pubkey),
      );
    if (!keysValid) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'the keys for this keyset are malformed, so the ID was not recomputed',
      });
      continue;
    }
    let derivedId: string;
    try {
      derivedId = deriveKeysetId(keysRecord as Record<string, string>, {
        unit: effectiveUnit,
        input_fee_ppk: inputFeePpk,
        expiry,
        versionByte,
      });
    } catch (err) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: `the ID could not be recomputed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    // Keyset IDs are lowercase hex, but a mint may advertise uppercase.
    // Compare case-insensitively so an uppercase advertisement is not a
    // false mismatch.
    const idsMatch = derivedId.toLowerCase() === advertisedId.toLowerCase();
    const baseDetail = idsMatch
      ? 'the recomputed ID matches the advertised ID'
      : `the recomputed ID ${derivedId} does not match the advertised ID ${advertisedId}`;
    checks.push({
      advertisedId,
      derivedId,
      unit: effectiveUnit,
      result: idsMatch ? 'match' : 'mismatch',
      detail: v1Notes.length > 0 ? `${baseDetail}; note: ${v1Notes.join('; ')}` : baseDetail,
    });
  }
  return checks;
}
