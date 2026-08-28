/**
 * The data layer's contract tests.
 *
 * These are the tests that keep the "only consume endpoints that are actually
 * present and verified in the backend" rule honest. Each case asserts the exact
 * URL a binding produces, so a typo, a lost query param, or — the mistake that
 * actually happened during development — passing a prefixed entity id where the
 * backend parses an integer, fails here rather than at demo time.
 *
 * No backend behaviour is mocked: `fetch` is replaced with a spy that records the
 * URL and hands back a recorded response body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, API_BASE_URL, HEALTH_URL, buildUrl } from '@/api';
import { fixtures } from '@/test/helpers';

/** Records every requested URL and answers with `body`. */
function spyFetch(body: unknown = {}, status = 200) {
  const urls: string[] = [];
  const init: RequestInit[] = [];
  const fetchMock = vi.fn(async (input: unknown, options?: RequestInit) => {
    urls.push(String(input));
    if (options) init.push(options);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, init, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('base URLs', () => {
  it('defaults to a same-origin relative base so the browser never needs CORS', () => {
    expect(API_BASE_URL).toBe('/api/v1');
  });

  it('puts /health outside the versioned prefix, because the backend does', () => {
    expect(HEALTH_URL).toBe('/health');
  });
});

describe('buildUrl', () => {
  it('drops undefined, null and empty-string params instead of sending them empty', () => {
    expect(buildUrl('/api/v1/graph/search', { q: 'ojas', limit: undefined, x: null, y: '' })).toBe(
      '/api/v1/graph/search?q=ojas',
    );
  });

  it('keeps false, because false is a meaningful value for include_overlay', () => {
    expect(buildUrl('/api/v1/x', { include_overlay: false })).toBe(
      '/api/v1/x?include_overlay=false',
    );
  });

  it('encodes values that need it', () => {
    expect(buildUrl('/api/v1/graph/path', { source: 'person:445' })).toBe(
      '/api/v1/graph/path?source=person%3A445',
    );
  });

  it('skips nested objects rather than serialising "[object Object]"', () => {
    expect(buildUrl('/api/v1/x', { a: 1, nested: { b: 2 } })).toBe('/api/v1/x?a=1');
  });

  it('omits the query string entirely when nothing survives filtering', () => {
    expect(buildUrl('/api/v1/x', { a: undefined })).toBe('/api/v1/x');
  });
});

describe('every binding requests the URL the backend actually exposes', () => {
  const cases: Array<[name: string, call: () => Promise<unknown>, url: string]> = [
    ['getHealth', () => api.getHealth(), '/health'],
    ['getDataSummary', () => api.getDataSummary(), '/api/v1/data/summary'],
    ['getGraphSummary', () => api.getGraphSummary(), '/api/v1/graph/summary'],
    ['searchGraph', () => api.searchGraph('ojas'), '/api/v1/graph/search?q=ojas&limit=25'],
    ['searchGraph (limit)', () => api.searchGraph('ojas', 5), '/api/v1/graph/search?q=ojas&limit=5'],
    ['getPersonDetail', () => api.getPersonDetail(445), '/api/v1/graph/persons/445'],
    [
      'getPersonNetwork (no query)',
      () => api.getPersonNetwork(445),
      '/api/v1/graph/persons/445/network',
    ],
    [
      'getPersonNetwork (depth 2)',
      () => api.getPersonNetwork(445, { depth: 2, persons_only: true }),
      '/api/v1/graph/persons/445/network?depth=2&persons_only=true',
    ],
    [
      'getRelationship',
      () => api.getRelationship('CALLED~person:141~person:189'),
      '/api/v1/graph/relationships/CALLED~person%3A141~person%3A189',
    ],
    [
      'getPath',
      () => api.getPath({ source: 'person:445', target: 'person:114' }),
      '/api/v1/graph/path?source=person%3A445&target=person%3A114',
    ],
    [
      'getTopPersons',
      () => api.getTopPersons(),
      '/api/v1/analytics/persons/top?metric=pagerank&limit=10',
    ],
    ['getPersonAnalytics', () => api.getPersonAnalytics(445), '/api/v1/analytics/persons/445'],
    ['getCommunities', () => api.getCommunities(), '/api/v1/analytics/communities?min_size=2'],
    ['getDemoInvestigation', () => api.getDemoInvestigation(), '/api/v1/analytics/demo'],
    ['listFirs', () => api.listFirs(2, 5), '/api/v1/firs?page=2&page_size=5'],
    ['getFir', () => api.getFir(79), '/api/v1/firs/79'],
    ['getNlpSummary', () => api.getNlpSummary(), '/api/v1/nlp/summary'],
    ['getFirEntities', () => api.getFirEntities(79), '/api/v1/nlp/firs/79/entities'],
    ['getFirRelationships', () => api.getFirRelationships(79), '/api/v1/nlp/firs/79/relationships'],
    ['getFirGraphImpact', () => api.getFirGraphImpact(79), '/api/v1/nlp/firs/79/graph-impact'],
    [
      'searchNlp',
      () => api.searchNlp('mumbai'),
      '/api/v1/nlp/search?q=mumbai&page=1&page_size=20',
    ],
    ['getPersonRecord', () => api.getPersonRecord(445), '/api/v1/persons/445'],
    ['getLocationRecord', () => api.getLocationRecord(178), '/api/v1/locations/178'],
  ];

  for (const [name, call, url] of cases) {
    it(name, async () => {
      const { urls } = spyFetch({});
      await call();
      expect(urls).toEqual([url]);
    });
  }

  it('never issues a verb other than GET — this API is read-only', async () => {
    const { init } = spyFetch({});
    await Promise.all(cases.map(([, call]) => call()));
    expect(init).toHaveLength(cases.length);
    for (const options of init) {
      expect(options.method).toBe('GET');
    }
  });
});

describe('the two id forms', () => {
  it('sends the NUMERIC row id in a path parameter', async () => {
    const { urls } = spyFetch(fixtures.network445Depth1);
    await api.getPersonNetwork(445, { depth: 1 });
    // A prefixed id here returns HTTP 422 int_parsing from the real backend.
    expect(urls[0]).toBe('/api/v1/graph/persons/445/network?depth=1');
    expect(urls[0]).not.toContain('person:');
    expect(urls[0]).not.toContain('person%3A');
  });

  it('sends the PREFIXED entity id in a query parameter', async () => {
    const { urls } = spyFetch(fixtures.graphPath);
    await api.getPath({ source: 'person:445', target: 'person:114' });
    // A bare numeric id here returns 404 from the real backend.
    expect(urls[0]).toContain('source=person%3A445');
    expect(urls[0]).toContain('target=person%3A114');
  });

  it('encodes a composite relationship id exactly once', async () => {
    const { urls } = spyFetch(fixtures.relationshipCalled);
    await api.getRelationship('CALLED~person:141~person:189');
    expect(urls[0]).toBe('/api/v1/graph/relationships/CALLED~person%3A141~person%3A189');
    expect(urls[0]).not.toContain('%253A'); // no double-encoding
  });
});

describe('responses are returned verbatim', () => {
  it('parses a recorded network response into the shape the UI reads', async () => {
    spyFetch(fixtures.network445Depth1);
    const body = await api.getPersonNetwork(445, { depth: 1 });
    expect(body.anchor.entity_id).toBe('person:445');
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.edges.length).toBeGreaterThan(0);
    expect(body.meta.max_nodes).toBeGreaterThan(0);
  });

  it('carries edge provenance through as an evidence citation list', async () => {
    spyFetch(fixtures.relationshipCalled);
    const edge = await api.getRelationship('CALLED~person:141~person:189');
    expect(typeof edge.source_dataset).toBe('string');
    // An edge has no scalar source_record_id; `evidence` is its provenance.
    expect(edge.evidence).toBeDefined();
    expect(edge.evidence).toHaveLength(edge.evidence_count);
  });
});

describe('error handling', () => {
  it('classifies a transport failure as offline with an actionable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await api.getGraphSummary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.isNetworkError).toBe(true);
    expect(apiError.kind).toBe('offline');
    expect(apiError.status).toBe(0);
    // The message names the thing the operator can actually change — the
    // configured base URL — because the backend need not be local.
    expect(apiError.message).toMatch(/configured API base URL/);
  });

  it('decodes the backend error envelope for a 404', async () => {
    spyFetch(fixtures.error404Person, 404);
    const error = (await api.getPersonDetail(999999).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.kind).toBe('not_found');
    // The envelope's own code and message survive intact — the UI shows the
    // backend's wording rather than a generic "something went wrong".
    expect(error.code).toBe('not_found');
    expect(error.message).toBe("Person '99999' not found");
    expect(error.detail).toMatchObject({ resource: 'Person' });
  });

  it('decodes a 400 from the depth cap and keeps the backend wording', async () => {
    spyFetch(fixtures.error400Depth, 400);
    const error = (await api
      .getPersonNetwork(445, { depth: 2 })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('bad_request');
    expect(error.code).toBe('bad_request');
    expect(error.message).toMatch(/depth/i);
  });

  it('classifies a 422 as validation', async () => {
    spyFetch(fixtures.error422Search, 422);
    // An empty q is dropped by buildUrl, so the backend sees a missing required
    // query param — which is exactly the 422 recorded in this fixture.
    const error = (await api.searchGraph('').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('validation');
    expect(error.code).toBe('validation_error');
  });

  it('classifies a 500 as server', async () => {
    spyFetch({ error: { code: 'internal', message: 'boom' } }, 500);
    const error = (await api.getGraphSummary().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('server');
  });

  it('still yields a usable message when the body is not the documented envelope', async () => {
    spyFetch('plain text failure', 503);
    const error = (await api.getGraphSummary().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.message).toBe('Request failed');
  });

  it('re-throws an abort untouched so callers can ignore superseded requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }),
    );
    const error = await api.getGraphSummary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});
