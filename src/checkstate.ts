// Checkstate, opt-in. Builds Y = hash_to_curve(secret) per NUT-00
// and sends POST /v1/checkstate only after consent. The privacy copy
// (CHECKSTATE_PRIVACY_COPY) is shown to the user before consent is
// asked for; that ordering lives with the caller, which is the report.
// Results map like this:
// - spent: RED
// - pending: AMBER, "the mint reports this proof as pending"
// - unspent: clean
// - unreachable or connection timeout: AMBER, "mint unreachable, verify manually"
// - the mint answered but the body could not be read: AMBER, "the mint answered but the response could not be read, verify manually"
// - 401 or 403: "not checked (auth required)", with the rest of the
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
  secret: string,
  consent: boolean,
  fetchFn: FetchFn = fetch,
): Promise<CheckstateResult> {
  if (!consent) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'none',
      message: 'checkstate was not sent: consent was not given',
    };
  }
  const y = hashToCurve(secretToBytes(secret)).toHex();
  let raw: unknown;
  try {
    raw = await fetchMintJson(
      mintEndpointUrl(mintUrl, '/v1/checkstate'),
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
        message: 'not checked (auth required)',
      };
    }
    if (err instanceof MintFetchError && err.status !== undefined) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: `the mint answered with an error (status ${err.status}), verify manually`,
      };
    }
    // An invalid mint URL (a query, fragment, or non-HTTP base) is a
    // problem with the URL itself, not with the mint answering.
    if (err instanceof MintFetchError && /mint URL/.test(err.message)) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'the mint URL is not usable, verify manually',
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
        message: 'the mint answered but the response could not be read, verify manually',
      };
    }
    if (
      err instanceof MintFetchError &&
      (/timed out/.test(err.message) || /mint request failed/.test(err.message))
    ) {
      return {
        status: 'not-checked',
        state: undefined,
        severity: 'amber',
        message: 'mint unreachable, verify manually',
      };
    }
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'the mint answered but the response could not be read, verify manually',
    };
  }
  if (!isRecord(raw) || !Array.isArray(raw.states) || raw.states.length === 0) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'the mint answered but the response could not be read, verify manually',
    };
  }
  const first = raw.states[0];
  const state = isRecord(first) && typeof first.state === 'string' ? first.state : '';
  const returnedY = isRecord(first) && typeof first.Y === 'string' ? first.Y : '';
  // The mint must answer for the Y that was asked about. A response for
  // a different Y is not an answer for this proof.
  if (returnedY.toLowerCase() !== y.toLowerCase()) {
    return {
      status: 'not-checked',
      state: undefined,
      severity: 'amber',
      message: 'the mint answered but the response could not be read, verify manually',
    };
  }
  if (state === 'SPENT') {
    return {
      status: 'checked',
      state: 'spent',
      severity: 'red',
      message: 'the mint reports this proof as spent',
    };
  }
  if (state === 'PENDING') {
    return {
      status: 'checked',
      state: 'pending',
      severity: 'amber',
      message: 'the mint reports this proof as pending',
    };
  }
  if (state === 'UNSPENT') {
    return {
      status: 'checked',
      state: 'unspent',
      severity: 'none',
      message: 'the mint reports this proof as unspent',
    };
  }
  return {
    status: 'not-checked',
    state: undefined,
    severity: 'amber',
    message: 'the mint answered but the response could not be read, verify manually',
  };
}
