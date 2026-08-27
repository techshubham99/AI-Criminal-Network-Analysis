/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import health from './fixtures/health.json';
import dataSummary from './fixtures/data-summary.json';
import graphSummary from './fixtures/graph-summary.json';
import nlpSummary from './fixtures/nlp-summary.json';
import analyticsDemo from './fixtures/analytics-demo.json';
import analyticsPersonsTop from './fixtures/analytics-persons-top.json';
import analyticsCommunities from './fixtures/analytics-communities.json';
import analyticsPerson445 from './fixtures/analytics-person-445.json';
import graphSearchOjas from './fixtures/graph-search-ojas.json';
import graphSearchPhone from './fixtures/graph-search-phone.json';
import graphSearchLocation178 from './fixtures/graph-search-location-178.json';
import graphSearchFir79 from './fixtures/graph-search-fir-79.json';
import graphSearchNone from './fixtures/graph-search-none.json';
import graphPerson445 from './fixtures/graph-person-445.json';
import network445Depth1 from './fixtures/network-445-depth1.json';
import network445Depth2 from './fixtures/network-445-depth2.json';
import relationshipCalled from './fixtures/relationship-called.json';
import graphPath from './fixtures/graph-path-445-114.json';
import firEntities79 from './fixtures/nlp-fir-79-entities.json';
import firRelationships79 from './fixtures/nlp-fir-79-relationships.json';
import firGraphImpact79 from './fixtures/nlp-fir-79-graph-impact.json';
import nlpSearchMumbai from './fixtures/nlp-search-mumbai.json';
import firsPage1 from './fixtures/firs-page1.json';
import fir79 from './fixtures/fir-79.json';
import personRecord445 from './fixtures/person-record-445.json';
import locationRecord178 from './fixtures/location-record-178.json';
import error404Person from './fixtures/error-404-person.json';
import error400Depth from './fixtures/error-400-depth.json';
import error422Search from './fixtures/error-422-search.json';

/**
 * Test helpers.
 *
 * The fixtures below are recordings, not inventions: each file is the verbatim
 * JSON body the running backend returned for the URL named in its key. The
 * router here matches URL shape to recording, so a component under test exercises
 * its real request path (query params included) rather than a hand-written stub.
 */
export const fixtures = {
  health,
  dataSummary,
  graphSummary,
  nlpSummary,
  analyticsDemo,
  analyticsPersonsTop,
  analyticsCommunities,
  analyticsPerson445,
  graphSearchOjas,
  graphSearchPhone,
  graphSearchLocation178,
  graphSearchFir79,
  graphSearchNone,
  graphPerson445,
  network445Depth1,
  network445Depth2,
  relationshipCalled,
  graphPath,
  firEntities79,
  firRelationships79,
  firGraphImpact79,
  nlpSearchMumbai,
  firsPage1,
  fir79,
  personRecord445,
  locationRecord178,
  error404Person,
  error400Depth,
  error422Search,
} as const;

export type FixtureRoute = {
  /** Substring or RegExp matched against the requested URL. */
  match: string | RegExp;
  body: unknown;
  status?: number;
};

/** The default routing table: real recorded responses for the app's real URLs. */
export function defaultRoutes(): FixtureRoute[] {
  return [
    { match: '/health', body: health },
    { match: '/api/v1/data/summary', body: dataSummary },
    { match: '/api/v1/graph/summary', body: graphSummary },
    { match: '/api/v1/nlp/summary', body: nlpSummary },
    { match: '/api/v1/analytics/demo', body: analyticsDemo },
    { match: '/api/v1/analytics/communities', body: analyticsCommunities },
    { match: '/api/v1/analytics/persons/top', body: analyticsPersonsTop },
    { match: '/api/v1/analytics/persons/445', body: analyticsPerson445 },
    // Exact-id resolution (Evidence & Provenance). These recordings are what the
    // live backend returns for a full prefixed entity id, so they must be matched
    // before the general name-search route below, which would otherwise answer
    // every /graph/search URL with the "Ojas" recording.
    { match: /\/graph\/search\?q=phone(%3A|:)/, body: graphSearchPhone },
    { match: /\/graph\/search\?q=location(%3A|:)178/, body: graphSearchLocation178 },
    { match: /\/graph\/search\?q=fir(%3A|:)79/, body: graphSearchFir79 },
    { match: /\/graph\/search\?q=person(%3A|:)99999/, body: graphSearchNone },
    { match: '/api/v1/graph/search', body: graphSearchOjas },
    { match: /\/api\/v1\/graph\/persons\/445\/network\?[^]*depth=2/, body: network445Depth2 },
    { match: /\/api\/v1\/graph\/persons\/445\/network/, body: network445Depth1 },
    { match: '/api/v1/graph/persons/445', body: graphPerson445 },
    { match: '/api/v1/graph/relationships/', body: relationshipCalled },
    { match: '/api/v1/graph/path', body: graphPath },
    { match: '/api/v1/nlp/firs/79/entities', body: firEntities79 },
    { match: '/api/v1/nlp/firs/79/relationships', body: firRelationships79 },
    { match: '/api/v1/nlp/firs/79/graph-impact', body: firGraphImpact79 },
    { match: '/api/v1/nlp/search', body: nlpSearchMumbai },
    // Specific-before-general: `/firs/79` must win over the `/firs` list route.
    { match: '/api/v1/firs/79', body: fir79 },
    { match: '/api/v1/firs', body: firsPage1 },
    { match: '/api/v1/persons/445', body: personRecord445 },
    { match: '/api/v1/locations/178', body: locationRecord178 },
  ];
}

/**
 * Install a `fetch` that serves recorded responses. Returns the spy so a test can
 * assert which URLs the component actually requested — the check that matters
 * most here, since the rule is "consume only verified endpoints".
 */
export function installFetch(routes: FixtureRoute[] = defaultRoutes()) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(url);
    const route = routes.find((candidate) =>
      typeof candidate.match === 'string' ? url.includes(candidate.match) : candidate.match.test(url),
    );
    if (!route) {
      return jsonResponse({ error: { code: 'not_found', message: `No fixture for ${url}` } }, 404);
    }
    return jsonResponse(route.body, route.status ?? 200);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** A fetch that always fails at the transport layer, i.e. backend not running. */
export function installOfflineFetch() {
  const fetchMock = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fetch that returns the recorded error envelope for a given status. */
export function installErrorFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function renderWithRouter(
  ui: ReactElement,
  { route = '/', ...options }: RenderOptions & { route?: string } = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  }
  return render(ui, { wrapper: Wrapper, ...options });
}
