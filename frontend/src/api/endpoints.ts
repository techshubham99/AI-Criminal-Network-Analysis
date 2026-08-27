/**
 * Typed bindings for the backend endpoints this frontend consumes.
 *
 * ONE FUNCTION PER REAL ENDPOINT. Every path below was verified against the
 * live `GET /openapi.json` of this project's backend on 2026-08-27; the
 * inventory is reproduced in `frontend/README.md`. Nothing here is speculative
 * and nothing here is mocked — if an endpoint is not in this file, the UI has
 * no way to ask for it.
 *
 * Endpoints deliberately NOT bound, because the backend does not provide them
 * in Phase 3.5: anything to do with risk scoring, an audit/blockchain ledger,
 * vehicle or organisation entities, or writes of any kind.
 *
 * TWO ID FORMS — verified live, and the single easiest thing to get wrong:
 *
 *   NUMERIC ROW ID (`445`)          path parameters. `/graph/persons/{id}`,
 *                                   `/graph/persons/{id}/network`,
 *                                   `/analytics/persons/{id}`, `/persons/{id}`,
 *                                   `/locations/{id}`, `/firs/{id}` and every
 *                                   `/nlp/firs/{id}/…` route parse the segment as
 *                                   an integer. Passing `person:445` returns HTTP
 *                                   422 `int_parsing`. These params are therefore
 *                                   typed `number`, not `number | string`, so the
 *                                   mistake cannot compile.
 *
 *   PREFIXED ENTITY ID (`person:445`)  query parameters and relationship ids.
 *                                   `/graph/path?source=&target=` wants the
 *                                   prefixed form (a bare `445` returns 404), and
 *                                   `/graph/relationships/{relationship_id}` takes
 *                                   the composite id verbatim.
 *
 * Bridge the two with `personIdFromEntityId()` / `firIdFromEntityId()` from
 * `@/utils/entity`: responses always speak `entity_id`, path params always want
 * the integer.
 */
import { request } from './client';
import type {
  CommunitiesResponse,
  DataSummaryResponse,
  DemoInvestigationResponse,
  EdgeOut,
  FIR,
  FirEntitiesResponse,
  FirRelationshipsResponse,
  GraphImpactResponse,
  GraphSummaryResponse,
  HealthResponse,
  LocationRecord,
  NetworkResponse,
  NlpSearchResponse,
  NlpSummaryResponse,
  Page,
  Person,
  PersonAnalyticsOut,
  PersonDetailResponse,
  PathResponse,
  SearchResponse,
  TopPersonsResponse,
} from '@/types/api';

export interface Signalled {
  signal?: AbortSignal;
}

/* ---------------------------------------------------------------- system -- */

/** `GET /health` — outside the /api/v1 prefix. */
export const getHealth = (o: Signalled = {}) =>
  request<HealthResponse>('/health', { absolute: true, signal: o.signal });

/** `GET /api/v1/data/summary` — dataset row counts and validation report. */
export const getDataSummary = (o: Signalled = {}) =>
  request<DataSummaryResponse>('data/summary', { signal: o.signal });

/* ----------------------------------------------------------------- graph -- */

/** `GET /api/v1/graph/summary` */
export const getGraphSummary = (o: Signalled = {}) =>
  request<GraphSummaryResponse>('graph/summary', { signal: o.signal });

/** `GET /api/v1/graph/search?q=&limit=` — entity search over graph nodes. */
export const searchGraph = (q: string, limit = 25, o: Signalled = {}) =>
  request<SearchResponse>('graph/search', { params: { q, limit }, signal: o.signal });

/** `GET /api/v1/graph/persons/{person_id}` */
export const getPersonDetail = (personId: number, o: Signalled = {}) =>
  request<PersonDetailResponse>(`graph/persons/${personId}`, { signal: o.signal });

export interface NetworkQuery {
  depth?: 1 | 2;
  persons_only?: boolean;
  include_overlay?: boolean;
  max_nodes?: number;
}

/**
 * `GET /api/v1/graph/persons/{person_id}/network`
 *
 * `depth` is the hop count (backend caps it at 2 and returns HTTP 400 above
 * that). `include_overlay` defaults to false and is left false throughout this
 * frontend: SAME_RING is synthetic ground truth, not observed evidence.
 */
export const getPersonNetwork = (
  personId: number,
  query: NetworkQuery = {},
  o: Signalled = {},
) =>
  request<NetworkResponse>(`graph/persons/${personId}/network`, {
    params: query,
    signal: o.signal,
  });

/** `GET /api/v1/graph/relationships/{relationship_id}` — full provenance. */
export const getRelationship = (relationshipId: string, o: Signalled = {}) =>
  request<EdgeOut>(`graph/relationships/${encodeURIComponent(relationshipId)}`, {
    signal: o.signal,
  });

export interface PathQuery {
  source: string;
  target: string;
  include_overlay?: boolean;
  max_length?: number;
  max_paths?: number;
}

/** `GET /api/v1/graph/path?source=&target=` — evidence chain between two ids. */
export const getPath = (query: PathQuery, o: Signalled = {}) =>
  request<PathResponse>('graph/path', { params: query, signal: o.signal });

/* ------------------------------------------------------------- analytics -- */

/** `GET /api/v1/analytics/persons/top?metric=&limit=` */
export const getTopPersons = (metric = 'pagerank', limit = 10, o: Signalled = {}) =>
  request<TopPersonsResponse>('analytics/persons/top', {
    params: { metric, limit },
    signal: o.signal,
  });

/** `GET /api/v1/analytics/persons/{person_id}` — centrality for one person. */
export const getPersonAnalytics = (personId: number, o: Signalled = {}) =>
  request<PersonAnalyticsOut>(`analytics/persons/${personId}`, { signal: o.signal });

/** `GET /api/v1/analytics/communities?min_size=` */
export const getCommunities = (minSize = 2, o: Signalled = {}) =>
  request<CommunitiesResponse>('analytics/communities', {
    params: { min_size: minSize },
    signal: o.signal,
  });

/**
 * `GET /api/v1/analytics/demo`
 *
 * The backend's own deterministic pick of one real person from the synthetic
 * dataset (highest observed degree, deterministic tie-breaks). This is what the
 * demo entry point uses — no demo data is invented on the frontend.
 */
export const getDemoInvestigation = (o: Signalled = {}) =>
  request<DemoInvestigationResponse>('analytics/demo', { signal: o.signal });

/* --------------------------------------------------------------- fir/nlp -- */

/** `GET /api/v1/firs?page=&page_size=` — structured FIR records. */
export const listFirs = (page = 1, pageSize = 20, o: Signalled = {}) =>
  request<Page<FIR>>('firs', { params: { page, page_size: pageSize }, signal: o.signal });

/** `GET /api/v1/firs/{fir_id}` — the structured FIR record. */
export const getFir = (firId: number, o: Signalled = {}) =>
  request<FIR>(`firs/${firId}`, { signal: o.signal });

/** `GET /api/v1/nlp/summary` — corpus-wide NLP metrics and self-reported caveats. */
export const getNlpSummary = (o: Signalled = {}) =>
  request<NlpSummaryResponse>('nlp/summary', { signal: o.signal });

/** `GET /api/v1/nlp/firs/{fir_id}/entities` */
export const getFirEntities = (firId: number, o: Signalled = {}) =>
  request<FirEntitiesResponse>(`nlp/firs/${firId}/entities`, { signal: o.signal });

/** `GET /api/v1/nlp/firs/{fir_id}/relationships` */
export const getFirRelationships = (firId: number, o: Signalled = {}) =>
  request<FirRelationshipsResponse>(`nlp/firs/${firId}/relationships`, { signal: o.signal });

/**
 * `GET /api/v1/nlp/firs/{fir_id}/graph-impact`
 *
 * Note the shape: graph-impact is per-FIR on this backend, not corpus-wide.
 */
export const getFirGraphImpact = (firId: number, o: Signalled = {}) =>
  request<GraphImpactResponse>(`nlp/firs/${firId}/graph-impact`, { signal: o.signal });

/** `GET /api/v1/nlp/search?q=&page=&page_size=` — search extracted entities. */
export const searchNlp = (q: string, page = 1, pageSize = 20, o: Signalled = {}) =>
  request<NlpSearchResponse>('nlp/search', {
    params: { q, page, page_size: pageSize },
    signal: o.signal,
  });

/* ----------------------------------------------------------- misc lookups -- */

/** `GET /api/v1/persons/{person_id}` — the raw structured person record. */
export const getPersonRecord = (personId: number, o: Signalled = {}) =>
  request<Person>(`persons/${personId}`, { signal: o.signal });

/** `GET /api/v1/locations/{location_id}` — the raw structured location record. */
export const getLocationRecord = (locationId: number, o: Signalled = {}) =>
  request<LocationRecord>(`locations/${locationId}`, { signal: o.signal });
