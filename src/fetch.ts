// Fetch helper for mint calls. One helper for every mint call, so the
// timeout, size cap, and shape checks are the same everywhere. The
// helper only contacts HTTP or HTTPS URLs, applies a 4 second timeout
// and a 1 MB response cap, rejects redirects, and parses the body as
// JSON. It never executes or follows anything the mint supplies.
//
// The mint boundary is enforced here, not left to caller discipline.
// Every call names the one origin it is allowed to contact, and the
// helper refuses any URL outside that origin without sending a request.
// The modules pass the origin of the mint URL they were configured
// with; the integration that configures them passes the mint named in
// the token, so only that mint is ever contacted. A caller that tries
// to fetch a different mint gets a MintFetchError and zero requests.

// The response size cap, in bytes. A mint info, keysets, or keys response
// is a few kilobytes at most; 1 MB leaves wide headroom for a mint with
// many denominations while stopping a runaway body.
export const RESPONSE_SIZE_CAP = 1048576;

// The request timeout, in milliseconds. The timeout is 4 seconds.
export const FETCH_TIMEOUT_MS = 4000;

// Builds a mint endpoint URL from a base URL and a path like
// "/v1/checkstate". The base is parsed and validated first: a base with
// a query string or fragment could turn the appended path into a
// different endpoint (for example, a base ending in a forbidden path
// with a query would put the request on that path instead of the
// intended endpoint). Only HTTP and HTTPS bases are accepted, and only
// the origin and path of the base are kept.
export function mintEndpointUrl(base: string, path: string): string {
  // Validation errors are fixed strings with no URL: the base is
  // token-supplied data, and a mint whose URL contains a banned word
  // must not put that word into the report copy through an error
  // message.
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new MintFetchError('Not a valid mint URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MintFetchError('Not an HTTP mint URL');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new MintFetchError('Mint URL must not carry a query or fragment');
  }
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}${path}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export class MintFetchError extends Error {
  // The HTTP error status when one was recorded, undefined otherwise.
  // An undefined status does not by itself mean the mint was never
  // reached: redirects, invalid JSON, oversized responses, and body-read
  // failures also produce errors without a status after the mint has
  // answered. Callers that need to tell auth failures apart from
  // unreachable mints read this, not the message, so a port number in
  // the URL cannot confuse it.
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MintFetchError';
    this.status = status;
  }
}

// The fetch function used. Defaults to the global fetch; tests pass a stub.
// The type is the shape this tool uses (a URL string plus init), not the
// full fetch signature, so a stub taking a string is assignable.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Reads the body with the size cap enforced while streaming, so a large
// body is stopped early instead of buffered in full. The signal is
// watched too: a mint that sends headers and then stalls must not hang
// the read past the timeout.
async function readCappedBody(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No readable body stream. The size cap cannot be enforced while
    // streaming, so the response is not read at all: a body that is only
    // checked after buffering would defeat the cap's purpose, which is
    // to stop a runaway body early. Real fetch responses always carry a
    // body stream, so this only fires for a malformed response.
    throw new MintFetchError('Mint response has no readable body stream');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // If the signal fires while the body is stalled, cancel the reader so
  // the read ends instead of waiting forever. A cancelled read resolves
  // as done, so track whether the abort fired and report the timeout
  // instead of treating a cut-short body as a complete one. If the
  // signal already fired before this read starts, fail at once instead
  // of waiting on a read that may never resolve.
  let abortedDuringRead = false;
  const onAbort = () => {
    abortedDuringRead = true;
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    signal.removeEventListener('abort', onAbort);
    throw new MintFetchError('Mint request timed out while reading the response body');
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > RESPONSE_SIZE_CAP) {
        // Cancel the stream but do not await it: if cancellation does
        // not settle, the helper would stay pending after detecting the
        // limit. The size error is thrown at once.
        reader.cancel().catch(() => {});
        throw new MintFetchError(
          `Mint response exceeds the ${RESPONSE_SIZE_CAP} byte cap`,
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (signal.aborted) {
      throw new MintFetchError('Mint request timed out while reading the response body');
    }
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (abortedDuringRead) {
    throw new MintFetchError('Mint request timed out while reading the response body');
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchMintJson(
  url: string,
  // Required, and placed before the defaulted parameters so the
  // signature is unambiguous. The full mint base named in the decoded
  // token, for example https://testnut.cashu.space. There is no call
  // without an allowed mint: a fetch that does not name its mint is a
  // fetch that could go anywhere, and this helper refuses to make one.
  // The check is on the full base, not just the origin: two mints on
  // the same host (https://example.com/mint-a and
  // https://example.com/mint-b) are different mints, and only the one
  // in the token is contacted.
  allowedMintBase: string,
  init: { method?: 'GET' | 'POST'; body?: string } = {},
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  // Error messages carry only the request path, never the full URL:
  // the URL is token-supplied data, and a mint whose hostname contains
  // a banned word must not put that word into the report copy via an
  // error message. The path is enough to identify which endpoint failed.
  const pathOf = (u: string): string => {
    try {
      return new URL(u).pathname;
    } catch {
      return '';
    }
  };
  if (!isHttpUrl(url)) {
    throw new MintFetchError('Refusing to contact a non-HTTP mint URL');
  }
  // The mint boundary: only the one allowed mint base is contacted. A
  // URL outside it is refused before any request is sent, so an unlisted
  // mint causes zero fetches. The check runs before the fetch, not
  // after, so a refused URL never reaches the network. The URL must sit
  // under the allowed base followed by a slash, so a base that merely
  // shares a string prefix (mint-a-evil) does not pass.
  let base: string;
  try {
    base = new URL(allowedMintBase).href.replace(/\/+$/, '');
  } catch {
    throw new MintFetchError('Not a valid mint base URL');
  }
  if (!isHttpUrl(base)) {
    throw new MintFetchError('Not a valid mint base URL');
  }
  let target: string;
  try {
    target = new URL(url).href;
  } catch {
    throw new MintFetchError('Not a valid mint URL');
  }
  if (target !== base && !target.startsWith(base + '/')) {
    throw new MintFetchError(
      `Refusing to contact a mint outside the allowed mint: ${pathOf(url)}`,
    );
  }
  let response: Response;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    // Content-Type is only sent when there is a body. A GET with a JSON
    // content type forces a CORS preflight in browsers for no reason.
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    response = await fetchFn(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    // A MintFetchError from the fetch itself (for example, a stubbed
    // error carrying a status) is re-thrown unchanged so its status
    // survives. Other errors are wrapped.
    if (error instanceof MintFetchError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new MintFetchError(`Mint request timed out after ${FETCH_TIMEOUT_MS} ms: ${pathOf(url)}`);
    }
    // The wrapped message is fixed and path-only: the thrown error's
    // message is never interpolated, because it can carry untrusted
    // text (a fetch failure naming the mint, for example) into the
    // report copy.
    throw new MintFetchError(`Mint request failed: ${pathOf(url)}`);
  }
  // A redirect is the mint pointing somewhere else. Do not follow it.
  // In a browser, redirect: 'manual' gives an opaqueredirect response
  // with status 0, not a 3xx code, so check the type too.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new MintFetchError(`Mint redirected; redirects are not followed: ${pathOf(url)}`);
  }
  const path = pathOf(url);
  if (response.status === 401 || response.status === 403) {
    throw new MintFetchError(
      `Mint refused the request (status ${response.status}): ${path}`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new MintFetchError(`mint returned status ${response.status}: ${path}`, response.status);
  }
  const text = await readCappedBody(response, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MintFetchError(`mint returned a body that is not JSON: ${path}`);
  }
}

// The shape check for a JSON value. Every mint response is validated
// before use, so a malformed body is reported, never trusted.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
