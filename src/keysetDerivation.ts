// Keyset-ID derivation check. Fetches the keys, recomputes the ID
// with deriveKeysetId using the right version options, and compares it
// with the advertised ID. NUT-02 V2 ID derivation is SHA256 over a
// structured string of the keyset data; that is a separate step from the
// NUT-13 secret derivation, so the two are not mixed up here. A mismatch
// is a finding. A fetch failure is "unknown", never "fail".
import { deriveKeysetId } from '@cashu/cashu-ts';
import { fetchMintJson, mintEndpointUrl, isRecord, type FetchFn } from './fetch.js';
import { classifyKeysetVersion } from './keysetVersion.js';

// Canonical form of a keys map for comparison. JSON property order is
// not significant: two maps with the same amount-to-pubkey entries in
// different orders are the same keys, not a conflict. Sorting the
// entries makes the comparison order-independent.
function canonicalKeys(keys: unknown): string {
  if (!isRecord(keys)) {
    return JSON.stringify(keys);
  }
  const entries = Object.entries(keys).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

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
  // Required. The mint named in the decoded token. This is the one
  // origin the call is allowed to contact. The URL to check (mintUrl)
  // is fetched only when its origin matches this token mint; a URL
  // outside it is refused before any request is sent, so a mint absent
  // from the token causes zero fetches. The integration passes the
  // token's mint for both.
  tokenMintUrl: string,
  fetchFn: FetchFn = fetch,
  tokenKeysetIds: string[] = [],
): Promise<KeysetDerivationCheck[]> {
  let keysRaw: Record<string, unknown> | undefined;
  let keysetsRaw: Record<string, unknown> | undefined;
  try {
    // The one mint base this call is allowed to contact: the mint named
    // in the decoded token. The fetch helper refuses any other base.
    const allowedMintBase = tokenMintUrl;
    keysRaw = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/keys'), allowedMintBase, {}, fetchFn)) as Record<string, unknown>;
    if (!isRecord(keysRaw) || !Array.isArray(keysRaw.keysets)) {
      throw new Error('The /v1/keys response has no keysets list');
    }
    keysetsRaw = (await fetchMintJson(mintEndpointUrl(mintUrl, '/v1/keysets'), allowedMintBase, {}, fetchFn)) as Record<string, unknown>;
    if (!isRecord(keysetsRaw) || !Array.isArray(keysetsRaw.keysets)) {
      throw new Error('The /v1/keysets response has no keysets list');
    }
  } catch (err) {
    // A failed list request leaves every token-referenced keyset
    // unchecked. Report one unknown per token keyset ID so none is
    // silently dropped, plus one for the list failure itself.
    const detail = `The keys could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
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
  // A mint that lists one keyset ID twice, with different entries, is
  // ambiguous: the second entry must not silently overwrite the first
  // and hide a mismatch. Conflicting duplicates are recorded and
  // reported as unknown below, never resolved by picking one.
  const conflictingIds = new Set<string>();
  // A malformed entry (not an object, or no string ID) is not a keyset
  // fact. It is counted and reported at the end instead of being
  // silently skipped, so a mint that answers with broken shapes does
  // not look clean.
  let malformedMeta = 0;
  for (const entry of keysetsRaw.keysets as unknown[]) {
    if (isRecord(entry) && typeof entry.id === 'string') {
      // Map keys are normalized to lowercase so a token-supplied
      // uppercase ID and a mint-listed lowercase ID are the same keyset.
      // The advertised spelling is kept in the entry itself for display.
      const lower = entry.id.toLowerCase();
      if (metaById.has(lower)) {
        const prev = metaById.get(lower) as Record<string, unknown>;
        if (prev.unit !== entry.unit || prev.active !== entry.active || prev.input_fee_ppk !== entry.input_fee_ppk || prev.final_expiry !== entry.final_expiry) {
          conflictingIds.add(lower);
        }
        // Keep the first entry; do not let a later one overwrite it.
        continue;
      }
      metaById.set(lower, entry);
    } else {
      malformedMeta += 1;
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
  let malformedKeys = 0;
  for (const entry of keysRaw.keysets as unknown[]) {
    if (isRecord(entry) && typeof entry.id === 'string' && isRecord(entry.keys)) {
      const lower = entry.id.toLowerCase();
      if (keysById.has(lower)) {
        const prev = keysById.get(lower) as Record<string, unknown>;
        // Every V2 derivation input is compared, not just unit and keys:
        // a different fee or expiry changes the derived V2 ID, so two
        // entries that agree on keys but disagree on fee or expiry are
        // still a conflict.
        if (
          prev.unit !== entry.unit ||
          canonicalKeys(prev.keys) !== canonicalKeys(entry.keys) ||
          prev.input_fee_ppk !== entry.input_fee_ppk ||
          prev.final_expiry !== entry.final_expiry
        ) {
          conflictingIds.add(lower);
        }
        // Keep the first entry; do not let a later one overwrite it.
        continue;
      }
      keysById.set(lower, entry);
    } else {
      malformedKeys += 1;
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
        detail: 'The advertised ID is not a hex string, so its keys were not fetched',
      });
      continue;
    }
    try {
      const single = (await fetchMintJson(
        mintEndpointUrl(mintUrl, `/v1/keys/${id}`),
        tokenMintUrl,
        {},
        fetchFn,
      )) as Record<string, unknown>;
      if (isRecord(single) && Array.isArray(single.keysets) && single.keysets.length > 0) {
        // Select ONLY entries whose ID matches the requested ID
        // case-insensitively. Keyset IDs are lowercase hex, but a mint
        // may advertise uppercase, and the module compares IDs
        // case-insensitively elsewhere, so an uppercase response for a
        // lowercase request is the same keyset, not an inconsistency.
        // If no entry matches, the requested keyset was not returned:
        // report it as unknown with the IDs that were returned, instead
        // of falling back to an unrelated first entry.
        // Every matching entry is inspected, not just the first: a mint
        // that returns the same ID twice with different keys must not
        // get a match by putting the matching keys first.
        const matchedAll = (single.keysets as unknown[]).filter(
          (e) => isRecord(e) && typeof e.id === 'string' && e.id.toLowerCase() === id.toLowerCase(),
        ) as Array<Record<string, unknown>>;
        const matched = matchedAll[0];
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
        // Conflicting duplicates in this single-keyset response: the
        // same ID with different keys, unit, fee or expiry. Every V2
        // derivation input is compared, the same as the list path, so a
        // mint cannot get a match by putting the agreeing entry first
        // and a conflicting fee or expiry second. Mark it conflicting
        // so the main loop reports unknown instead of deriving from one.
        if (matchedAll.length > 1) {
          const firstKeys = canonicalKeys(matched.keys);
          const firstUnit = matched.unit;
          const firstFee = matched.input_fee_ppk;
          const firstExpiry = matched.final_expiry;
          const conflict = matchedAll.some(
            (e) =>
              canonicalKeys(e.keys) !== firstKeys ||
              e.unit !== firstUnit ||
              e.input_fee_ppk !== firstFee ||
              e.final_expiry !== firstExpiry,
          );
          if (conflict) {
            conflictingIds.add(id.toLowerCase());
          }
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
    // A keyset the mint listed twice with different entries is
    // ambiguous: neither entry can be trusted to derive the ID, so the
    // check reports unknown instead of picking one and hiding the
    // conflict.
    if (conflictingIds.has(key)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        result: 'unknown',
        detail: 'The mint listed this keyset ID more than once with different entries, so the ID cannot be established',
      });
      continue;
    }
    if (!isRecord(entry.keys)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        result: 'unknown',
        detail: 'The keys for this keyset could not be fetched',
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
    const version = classifyKeysetVersion(advertisedId);
    // Notes for V1, where metadata problems do not block the ID check.
    // V1 derives its ID from the public keys alone, so a conflicting or
    // malformed unit is noted in the result detail instead of blocking
    // the comparison.
    const v1Notes: string[] = [];
    const unitConflict =
      keysUnit !== undefined && metaUnit !== undefined && keysUnit !== metaUnit;
    if (unitConflict && version !== 'v1') {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: keysUnit,
        result: 'unknown',
        detail: 'The /v1/keys and /v1/keysets responses disagree on the unit, so the ID cannot be established',
      });
      continue;
    }
    if (unitConflict) {
      v1Notes.push('The /v1/keys and /v1/keysets responses disagree on the unit');
    }
    const unit = keysUnit ?? metaUnit;
    if (version === 'v2' && unit === undefined) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: '',
        result: 'unknown',
        detail: 'No unit was supplied for this keyset, so the V2 ID cannot be established',
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
        detail: 'This is a V3 keyset (BLS12-381); V3 keyset ID derivation is not checked here',
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
        detail: 'The advertised ID has an unknown version, so it was not recomputed',
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
    if (versionByte === 1 && (keysFeeMalformed || metaFeeMalformed)) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'The input fee in the mint response is malformed, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 1 && feeConflict) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'The /v1/keys and /v1/keysets responses disagree on the input fee, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 0) {
      if (keysFeeMalformed || metaFeeMalformed) {
        v1Notes.push('The mint advertises a malformed input_fee_ppk, which V1 derivation does not use');
      } else if (feeConflict) {
        v1Notes.push('The /v1/keys and /v1/keysets responses disagree on the input fee, which V1 derivation does not use');
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
        detail: 'The expiry in the mint response is malformed, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 1 && expiryConflict) {
      checks.push({
        advertisedId,
        derivedId: undefined,
        unit: effectiveUnit,
        result: 'unknown',
        detail: 'The /v1/keys and /v1/keysets responses disagree on the expiry, so the ID cannot be established',
      });
      continue;
    }
    if (versionByte === 0) {
      if (keysExpiryMalformed || metaExpiryMalformed) {
        v1Notes.push('The mint advertises a malformed final_expiry, which V1 derivation does not use');
      } else if (expiryConflict) {
        v1Notes.push('The /v1/keys and /v1/keysets responses disagree on the expiry, which V1 derivation does not use');
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
        detail: 'The keys for this keyset are malformed, so the ID was not recomputed',
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
        detail: `The ID could not be recomputed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    // Keyset IDs are lowercase hex, but a mint may advertise uppercase.
    // Compare case-insensitively so an uppercase advertisement is not a
    // false mismatch.
    const idsMatch = derivedId.toLowerCase() === advertisedId.toLowerCase();
    const baseDetail = idsMatch
      ? 'The recomputed ID matches the advertised ID'
      : `The recomputed ID ${derivedId} does not match the advertised ID ${advertisedId}`;
    checks.push({
      advertisedId,
      derivedId,
      unit: effectiveUnit,
      result: idsMatch ? 'match' : 'mismatch',
      detail: v1Notes.length > 0 ? `${baseDetail}; note: ${v1Notes.join('; ')}` : baseDetail,
    });
  }
  // A malformed entry in either list is reported as an unknown check so
  // it is visible instead of silently dropped. It carries no keyset ID,
  // because the entry had none usable.
  if (malformedMeta > 0 || malformedKeys > 0) {
    const parts: string[] = [];
    if (malformedMeta > 0) {
      parts.push(`${malformedMeta} malformed ${malformedMeta === 1 ? 'entry' : 'entries'} in the /v1/keysets response`);
    }
    if (malformedKeys > 0) {
      parts.push(`${malformedKeys} malformed ${malformedKeys === 1 ? 'entry' : 'entries'} in the /v1/keys response`);
    }
    checks.push({
      advertisedId: '',
      derivedId: undefined,
      unit: '',
      result: 'unknown',
      detail: `The mint response has ${parts.join(' and ')} that were skipped`,
    });
  }
  return checks;
}
