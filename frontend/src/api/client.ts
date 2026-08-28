/**
 * HTTP client — the ONLY module in this application that calls `fetch`.
 *
 * Everything else goes through `src/api/endpoints.ts`, which is a thin typed
 * wrapper over `request()`. That rule is what keeps the data layer auditable:
 * there is exactly one place where a URL is constructed, one place where the
 * backend's error envelope is decoded, and no component anywhere that can
 * quietly reach the network on its own.
 *
 * There are no external services. The base URL is same-origin by default and
 * the Vite dev-server proxies it to the local FastAPI backend.
 *
 * Almost all of this backend is read-only. The one exception is Phase 4.6's
 * ingestion routes (`POST /ingest/*`), which is why {@link HttpMethod} exists
 * and is deliberately narrow: GET or POST, nothing else. No PUT, PATCH or
 * DELETE verb exists anywhere in the app, because no endpoint accepts one.
 */
import type { ApiErrorEnvelope } from '@/types/api';

/** Same-origin by default; the dev-server proxy forwards to the backend. */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') || '/api/v1';

/** `/health` sits outside the versioned prefix. */
export const HEALTH_URL: string = (() => {
  if (API_BASE_URL === '/api/v1') return '/health';
  // Absolute base like http://host:8000/api/v1 -> http://host:8000/health
  try {
    const u = new URL(API_BASE_URL);
    return `${u.origin}/health`;
  } catch {
    return API_BASE_URL.replace(/\/api\/v1$/, '') + '/health';
  }
})();

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;
/**
 * Query input also accepts a declared interface (e.g. `NetworkQuery`). Those have
 * no index signature, so `Record<string, QueryValue>` alone would reject them and
 * force a cast at every call site.
 */
export type QueryInput = QueryParams | object;

/**
 * A failed backend call, carrying enough context for the UI to say something
 * true about what went wrong instead of a generic "something broke".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  readonly url: string;
  /** True when the request never reached the backend at all. */
  readonly isNetworkError: boolean;

  constructor(init: {
    message: string;
    status: number;
    code: string;
    detail?: unknown;
    url: string;
    isNetworkError?: boolean;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.url = init.url;
    this.isNetworkError = init.isNetworkError ?? false;
  }

  /** A short, human-readable label for the failure class. */
  get kind(): 'offline' | 'not_found' | 'bad_request' | 'validation' | 'server' | 'unknown' {
    if (this.isNetworkError) return 'offline';
    if (this.status === 404) return 'not_found';
    if (this.status === 422) return 'validation';
    if (this.status === 400) return 'bad_request';
    if (this.status >= 500) return 'server';
    return 'unknown';
  }
}

/** True when `e` is an abort triggered by us (unmount / superseded request). */
export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export function buildUrl(path: string, params?: QueryInput): string {
  const full =
    path.startsWith('http') || path.startsWith('/') ? path : `${API_BASE_URL}/${path}`;
  if (!params) return full;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    // A nested object has no meaningful query-string form; the backend takes none.
    if (typeof value === 'object' || typeof value === 'function') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${full}?${qs}` : full;
}

/** Path relative to the versioned API base, e.g. `graph/summary`. */
export function apiPath(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

function decodeErrorEnvelope(body: unknown): { code: string; message: string; detail: unknown } {
  if (body && typeof body === 'object' && 'error' in body) {
    const env = (body as ApiErrorEnvelope).error;
    if (env && typeof env === 'object') {
      return {
        code: typeof env.code === 'string' ? env.code : 'http_error',
        message: typeof env.message === 'string' ? env.message : 'Request failed',
        detail: env.detail,
      };
    }
  }
  // FastAPI's own default shape, in case a route bypasses the app handler.
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    return {
      code: 'http_error',
      message: typeof d === 'string' ? d : 'Request failed',
      detail: d,
    };
  }
  return { code: 'http_error', message: 'Request failed', detail: body };
}

/**
 * The only two verbs in use: GET everywhere, POST for the Phase 4.6 ingestion
 * routes. Kept as a closed union so a mutating verb cannot be introduced by
 * passing a string.
 */
export type HttpMethod = 'GET' | 'POST';

export interface RequestOptions {
  params?: QueryInput;
  signal?: AbortSignal;
  /** Absolute or root-relative URL; bypasses the API base. */
  absolute?: boolean;
  /** Defaults to `'GET'`. */
  method?: HttpMethod;
  /** JSON request body, serialised as-is. POST only. */
  body?: unknown;
}

/**
 * Issue a request and decode the result, or throw an {@link ApiError}.
 *
 * The single `fetch` site in the application.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const target = options.absolute ? path : apiPath(path);
  const url = buildUrl(target, options.params);
  const method: HttpMethod = options.method ?? 'GET';
  const sendsBody = method !== 'GET' && options.body !== undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: sendsBody
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      body: sendsBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError({
      message:
        'Cannot reach the analysis backend. Confirm the FastAPI server is running locally.',
      status: 0,
      code: 'network_error',
      detail: cause instanceof Error ? cause.message : String(cause),
      url,
      isNetworkError: true,
    });
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const { code, message, detail } = decodeErrorEnvelope(body);
    throw new ApiError({ message, status: response.status, code, detail, url });
  }

  return body as T;
}

/**
 * POST a JSON body. Only the `ingest/*` routes accept one.
 *
 * A rejected submission is not an HTTP failure: the backend answers 200 with a
 * record whose status is `REJECTED` and a reason, because "this record was
 * refused, and here is why" is a result, not a transport error. A 4xx here means
 * the request itself was malformed (422) or the query was invalid (400).
 */
export function post<T>(
  path: string,
  body: unknown,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}
