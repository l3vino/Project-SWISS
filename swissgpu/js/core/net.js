/* net.js — asking a service for one file, and what its answer means.
 *
 * Every answer falls in one of three kinds, and each is handled once, here,
 * for every layer and every service:
 *   absent     204, 400, 403, 404, 410 and the other client errors: there
 *              is nothing at this address (object stores answer 403 rather
 *              than 404 for a key that is not there, and a tile outside a
 *              service's grid is a 400). Remembered and never asked again.
 *   transient  408, 429, any 5xx, a network failure, a timeout: worth
 *              another try later. The error says so (`retry`), with the
 *              status and how long the server asked to wait (Retry-After,
 *              seconds or a date); the scheduler spaces the retries.
 *   the file   anything else that is OK.
 * A request that was called off (its AbortSignal) rejects with an
 * AbortError, which is neither: nobody wants the answer any more.
 */

import { isAbort, abortError } from './rpc.js';

/** Seconds a Retry-After header asks for, or undefined. */
export function retryAfterSeconds(value, now = Date.now()) {
  if (value == null || value === '') return undefined;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, (at - now) / 1000) : undefined;
}

function transient(message, status, retryAfter) {
  const err = new Error(message);
  err.retry = true;
  err.status = status;
  err.retryAfter = retryAfter;
  return err;
}

/**
 * Fetches `url`. Resolves to the Response, or to null when there is nothing
 * there; throws a transient error (see above) or an AbortError.
 * @param signal    AbortSignal that calls the request off
 * @param priority  'high', 'low' or 'auto' (Fetch Priority)
 * @param headers   extra request headers
 * @param pass      statuses handed back as they are, for the caller to read
 */
export async function fetchFile(url, { signal = null, priority = 'auto', headers, pass } = {}) {
  let response;
  try {
    response = await fetch(url, { signal, priority, headers });
  } catch (err) {
    if (signal?.aborted || isAbort(err)) throw abortError();
    throw transient(`network: ${err.message}`, 0);
  }
  const status = response.status;
  if (pass?.includes(status)) return response;
  if (status === 204) return null;
  if (status === 408 || status === 429 || status >= 500) {
    // The body is not needed; let the connection go.
    response.body?.cancel().catch(() => {});
    throw transient(`HTTP ${status}`, status, retryAfterSeconds(response.headers.get('retry-after')));
  }
  if (status >= 400) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  return response;
}

/** A response's body, 'arrayBuffer' or 'blob': a connection cut off half
 * way is transient, not a broken file. */
export async function bodyOf(response, signal = null, as = 'arrayBuffer') {
  try {
    return await (as === 'blob' ? response.blob() : response.arrayBuffer());
  } catch (err) {
    if (signal?.aborted || isAbort(err)) throw abortError();
    throw transient(`network: ${err.message}`, response.status);
  }
}

/** The whole body as an ArrayBuffer, or null when absent (see fetchFile). */
export async function fetchBytes(url, options = {}) {
  const response = await fetchFile(url, options);
  return response ? bodyOf(response, options.signal) : null;
}
