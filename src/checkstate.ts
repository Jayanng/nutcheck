// Checkstate, opt-in. Builds Y = hash_to_curve(secret) per NUT-00
// and sends POST /v1/checkstate only after consent. The privacy copy
// (CHECKSTATE_PRIVACY_COPY) must be shown to the user before consent
// is asked for; that ordering is the report's job, not this module's,
// and it is not implemented here. It is a report-integration check:
// the report shows the copy, then offers consent, and no request is
// sent before that action.
// Results map like this:
// - spent: RED
// - pending: AMBER, "The mint reports this proof as pending"
// - unspent: clean
// - unreachable or connection timeout: AMBER, "Mint unreachable, verify manually"
// - the mint answered but the body could not be read: AMBER, "The mint answered but the response could not be read, verify manually"
// - 401 or 403: "Not checked (auth required)", with the rest of the
//   report left intact.
// No code path sends checkstate without the consent flag set.
import { hashToCurve } from '@cashu/cashu-ts';
import { fetchMintJson, mintEndpointUrl, MintFetchError, isRecord, type FetchFn } from './fetch.js';

export const CHECKSTATE_PRIVACY_COPY =
  'Before checkstate runs: the mint learns which proofs you hold, it can correlate sender and receiver, and its answer is its own word at one moment. Checkstate is opt-in and only runs after you consent.';

export type ProofState = 'spent' | 'pending' | 'unspent';

export interface CheckstateResult {
  // 'checked' when the mint answered, 'not-checked' when consent was
  // missing, auth was required, or the mint could not be reached.
  status: 'checked' | 'not-checked';
  state: ProofState | undefined;
  severity: 'red' | 'amber' | 'none';
  message: string;
}

function secretToBytes(secret: string): Uint8Array {
  // The secret is hashed as its UTF-8 bytes, not as hex-decoded bytes.
  // That is how the library and the mint compute Y: a standard token
  // secret is a hex string, and hash_to_curve hashes the UTF-8 bytes of
  // that string. A NUT-10 or NUT-11 secret is a JSON string, and the same
  // rule applies. The NUT-12 vector secret hashes to the proof's C point
  // under this rule, which is how the encoding was confirmed.
  return new TextEncoder().encode(secret);
}

export async function checkProofState(
  mintUrl: string,
  // Required. The mint named in the decoded token. This is the one
  // origin the call is allowed to contact. The URL to check (mintUrl)
  // is fetched only when its origin matches this token mint; a URL
  // outside it is refused before any request is sent, so a mint absent
  // from the token causes zero fetches. The integration passes the
  // token's mint for both.
  tokenMintUrl: string,
  secret: string,
  consent: boolean,
  fetchFn: FetchFn = fetch,
): Promise<CheckstateResult> {
  if (!consent) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'none',
      message: 'Checkstate was not sent: consent was not given',
    };
  }
  const y = hashToCurve(secretToBytes(secret)).toHex();
  let raw: unknown;
  try {
    raw = await fetchMintJson(
      mintEndpointUrl(mintUrl, '/v1/checkstate'),
      tokenMintUrl,
      { method: 'POST', body: JSON.stringify({ Ys: [y] }) },
      fetchFn,
    );
  } catch (err) {
    // Distinguish the failure: a mint that was never reached is not the
    // same as a mint that answered with an error or a body that could
    // not be read. All three leave the proof not checked.
    if (err instanceof MintFetchError && (err.status === 401 || err.status === 403)) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'none',
        message: 'Not checked (auth required)',
      };
    }
    if (err instanceof MintFetchError && err.status !== undefined) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: `The mint answered with an error (status ${err.status}), verify manually`,
      };
    }
    // An invalid mint URL (a query, fragment, or non-HTTP base) is a
    // problem with the URL itself, not with the mint answering.
    if (err instanceof MintFetchError && /Mint URL/.test(err.message)) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'The mint URL is not usable, verify manually',
      };
    }
    // A body that stalls after the mint answered is not the same as a
    // mint that was never reached: the mint answered, but the proof
    // state was not obtained.
    if (err instanceof MintFetchError && /timed out while reading/.test(err.message)) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'The mint answered but the response could not be read, verify manually',
      };
    }
    if (
      err instanceof MintFetchError &&
      (/timed out/.test(err.message) || /Mint request failed/.test(err.message))
    ) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'Mint unreachable, verify manually',
      };
    }
    // A mint outside the one named in the token is refused before any
    // request is sent. The mint was never contacted, so this is not a
    // mint that answered badly; it is a URL the tool will not use.
    if (err instanceof MintFetchError && /outside the allowed mint/.test(err.message)) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'The mint is not the one named in the token, verify manually',
      };
    }
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'The mint answered but the response could not be read, verify manually',
    };
  }
  if (!isRecord(raw) || !Array.isArray(raw.states) || raw.states.length === 0) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'The mint answered but the response could not be read, verify manually',
    };
  }
  // One Y was asked about, so the response must contain exactly one state
  // entry, and it must be for the Y that was asked about. A mint that
  // returns two entries, or an entry for a Y that was not asked about, is
  // not giving one clear answer. Extra or conflicting entries are not
  // checked, never resolved by picking one.
  if (raw.states.length !== 1) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'The mint answered but the response could not be read, verify manually',
    };
  }
  const first = raw.states[0];
  if (!isRecord(first) || typeof first.Y !== 'string' || first.Y.toLowerCase() !== y.toLowerCase()) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'The mint answered but the response could not be read, verify manually',
    };
  }
  const state = typeof first.state === 'string' ? first.state : '';
  if (state === 'SPENT') {
    return {
      status: 'checked',
      state: 'spent',
      severity: 'red',
      message: 'The mint reports this proof as spent',
    };
  }
  if (state === 'PENDING') {
    return {
      status: 'checked',
      state: 'pending',
      severity: 'amber',
      message: 'The mint reports this proof as pending',
    };
  }
  if (state === 'UNSPENT') {
    return {
      status: 'checked',
      state: 'unspent',
      severity: 'none',
      message: 'The mint reports this proof as unspent',
    };
  }
  return {
    status: 'not-checked',
    state: undefined,
    severity: 'amber',
    message: 'The mint answered but the response could not be read, verify manually',
  };
}
