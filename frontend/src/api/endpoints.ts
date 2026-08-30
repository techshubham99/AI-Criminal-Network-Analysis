/**
 * Typed bindings for the backend endpoints this frontend consumes.
 *
 * ONE FUNCTION PER REAL ENDPOINT. Every path below was verified against the
 * live `GET /openapi.json` of this project's backend; the inventory is
 * reproduced in `frontend/README.md`. Nothing here is speculative and nothing
 * here is mocked — if an endpoint is not in this file, the UI has no way to ask
 * for it.
 *
 * Endpoints deliberately NOT bound, because the backend does not provide them:
 * vehicle or organisation entities. The Phase 4 intelligence routes, the Phase
 * 4.6 ingestion routes and the Phase 5 chain verification ARE bound, at the foot
 * of this file — the `ingest/*` POSTs are the only writes in the application,
 * and they write to the separate live store, never to the dataset. The audit
 * ledger's own write route is not bound: this UI only ever reads a verdict.
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
import { HEALTH_URL, post, request } from './client';
import type {
  BulkBatchIn,
  BulkBatchPreviewOut,
  BulkConfirmOut,
  BulkPreviewOut,
  BulkRejectOut,
  BulkSourceType,
  BulkUploadIn,
  CallIn,
  CallRecord,
  ChainVerificationOut,
  CommunitiesResponse,
  DataSummaryResponse,
  DemoInvestigationResponse,
  EdgeOut,
  ExplainResponse,
  FIR,
  FirEntitiesResponse,
  FirIn,
  FirRelationshipsResponse,
  GraphImpactResponse,
  GraphSummaryResponse,
  HealthResponse,
  IngestRecordOut,
  IntelligenceSummaryResponse,
  LocationIn,
  LocationRecord,
  NetworkResponse,
  NlpSearchResponse,
  NlpSummaryResponse,
  Page,
  PatternListResponse,
  PatternOut,
  Person,
  PersonAnalyticsOut,
  PersonDetailResponse,
  PersonIntelligenceResponse,
  PathResponse,
  PriorityRankingResponse,
  ScoreBand,
  SearchResponse,
  TopPersonsResponse,
  TransactionIn,
  TransactionRecord,
} from '@/types/api';

export interface Signalled {
  signal?: AbortSignal;
}

/* ---------------------------------------------------------------- system -- */

/** `GET /health` — outside the /api/v1 prefix, so it follows {@link HEALTH_URL}. */
export const getHealth = (o: Signalled = {}) =>
  request<HealthResponse>(HEALTH_URL, { absolute: true, signal: o.signal });

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

/* ---------------------------------------------------------- intelligence -- */

/**
 * `GET /api/v1/intelligence/summary` — engine-wide counts, band boundaries,
 * feature weights and the published policies.
 */
export const getIntelligenceSummary = (o: Signalled = {}) =>
  request<IntelligenceSummaryResponse>('intelligence/summary', { signal: o.signal });

export interface PriorityRankingQuery {
  limit?: number;
  band?: ScoreBand;
  min_score?: number;
}

/**
 * `GET /api/v1/intelligence/persons/top` — the investigation-priority ranking.
 *
 * NOT the same list as `getTopPersons()` above. That one ranks structural
 * importance in the observed graph; this one ranks the explainable 0-100
 * priority score. The backend says so in the response's own `note`, which the
 * UI shows rather than paraphrasing.
 */
export const getPriorityRanking = (query: PriorityRankingQuery = {}, o: Signalled = {}) =>
  request<PriorityRankingResponse>('intelligence/persons/top', {
    params: query,
    signal: o.signal,
  });

/** `GET /api/v1/intelligence/persons/{person_id}` — score, patterns, evidence. */
export const getPersonIntelligence = (personId: number, o: Signalled = {}) =>
  request<PersonIntelligenceResponse>(`intelligence/persons/${personId}`, { signal: o.signal });

/**
 * `GET /api/v1/intelligence/persons/{person_id}/explain`
 *
 * The arithmetic behind one score, factor by factor. This is what the "Why?"
 * action opens — the number is never shown without a way to reach its derivation.
 */
export const explainPersonPriority = (personId: number, o: Signalled = {}) =>
  request<ExplainResponse>(`intelligence/persons/${personId}/explain`, { signal: o.signal });

export interface PatternQuery {
  pattern_type?: string;
  entity_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * `GET /api/v1/intelligence/patterns` — detected patterns, paged.
 *
 * `entity_id` takes the PREFIXED form (`person:141`); it is a query parameter.
 * A category with no detections answers with an empty list, and the UI reports
 * that zero as a zero.
 */
export const listPatterns = (query: PatternQuery = {}, o: Signalled = {}) =>
  request<PatternListResponse>('intelligence/patterns', { params: query, signal: o.signal });

/** `GET /api/v1/intelligence/patterns/{pattern_id}` — one pattern, in full. */
export const getPattern = (patternId: string, o: Signalled = {}) =>
  request<PatternOut>(`intelligence/patterns/${encodeURIComponent(patternId)}`, {
    signal: o.signal,
  });

/* ----------------------------------------------------------- misc lookups -- */

/** `GET /api/v1/persons/{person_id}` — the raw structured person record. */
export const getPersonRecord = (personId: number, o: Signalled = {}) =>
  request<Person>(`persons/${personId}`, { signal: o.signal });

/** `GET /api/v1/locations/{location_id}` — the raw structured location record. */
export const getLocationRecord = (locationId: number, o: Signalled = {}) =>
  request<LocationRecord>(`locations/${locationId}`, { signal: o.signal });

/* --------------------------------------------------- structured record lists -- */
/*
 * The paged record tables behind the Communication, Financial and Location
 * screens. Every filter below is a query parameter the backend declares; there is
 * no client-side substitute for one it does not offer, and `page_size` is capped
 * at 200 server-side (`MAX_PAGE_SIZE`), so a caller asking for more gets a 422
 * rather than a silently truncated page.
 */

export interface PersonQuery {
  page?: number;
  page_size?: number;
  /** Case-insensitive substring match on `name`. */
  q?: string;
  city?: string;
  state?: string;
}

/** `GET /api/v1/persons` — the paged `persons` table. */
export const listPersons = (query: PersonQuery = {}, o: Signalled = {}) =>
  request<Page<Person>>('persons', { params: { ...query }, signal: o.signal });

export interface CallQuery {
  page?: number;
  page_size?: number;
  caller_id?: number;
  callee_id?: number;
}

/** `GET /api/v1/calls` — the paged `calls` table, optionally by either party. */
export const listCalls = (query: CallQuery = {}, o: Signalled = {}) =>
  request<Page<CallRecord>>('calls', { params: { ...query }, signal: o.signal });

export interface TransactionQuery {
  page?: number;
  page_size?: number;
  sender_id?: number;
  receiver_id?: number;
  /** One of the modes the dataset actually uses: UPI, NEFT, IMPS, CASH, CARD. */
  mode?: string;
}

/** `GET /api/v1/transactions` — the paged `transactions` table. */
export const listTransactions = (query: TransactionQuery = {}, o: Signalled = {}) =>
  request<Page<TransactionRecord>>('transactions', { params: { ...query }, signal: o.signal });

export interface LocationQuery {
  page?: number;
  page_size?: number;
  city?: string;
  state?: string;
}

/** `GET /api/v1/locations` — the paged `locations` table. */
export const listLocations = (query: LocationQuery = {}, o: Signalled = {}) =>
  request<Page<LocationRecord>>('locations', { params: { ...query }, signal: o.signal });

/* ------------------------------------------- Phase 4.6 — live ingestion -- */
/*
 * The only writes in this application. Each POST submits ONE record and returns
 * the pipeline's verdict: ACCEPTED, DUPLICATE, REVIEW_REQUIRED or REJECTED, with
 * the reason and (when accepted) what actually changed.
 *
 * A refused record is HTTP 200 with `status: 'REJECTED'` — a verdict, not a
 * transport failure. HTTP 422 means the submission itself was malformed.
 */

/** `POST /api/v1/ingest/fir` — a new FIR, analysed by the Phase 3 NLP pipeline. */
export const ingestFir = (body: FirIn, o: Signalled = {}) =>
  post<IngestRecordOut>('ingest/fir', body, { signal: o.signal });

/** `POST /api/v1/ingest/call` — one call detail record. */
export const ingestCall = (body: CallIn, o: Signalled = {}) =>
  post<IngestRecordOut>('ingest/call', body, { signal: o.signal });

/** `POST /api/v1/ingest/transaction` — one money transfer. */
export const ingestTransaction = (body: TransactionIn, o: Signalled = {}) =>
  post<IngestRecordOut>('ingest/transaction', body, { signal: o.signal });

/** `POST /api/v1/ingest/location` — one observation of a person at a place. */
export const ingestLocation = (body: LocationIn, o: Signalled = {}) =>
  post<IngestRecordOut>('ingest/location', body, { signal: o.signal });

/* --------------------------------------------- Phase 6.2 — CSV import -- */
/*
 * A CSV is judged before anything is written. `previewBulkCsv` classifies every
 * row and computes the metrics, graph and patterns that committing it *would*
 * produce, on an in-memory overlay; the live graph only changes when
 * `confirmBulkImport` is called. `rejectBulkImport` drops the held preview.
 */

/** `POST /api/v1/ingest/bulk/{source_type}/preview` — judge a file, write nothing. */
export const previewBulkCsv = (
  sourceType: BulkSourceType,
  body: BulkUploadIn,
  o: Signalled = {},
) =>
  post<BulkPreviewOut>(`ingest/bulk/${sourceType}/preview`, body, { signal: o.signal });

/**
 * `POST /api/v1/ingest/bulk/preview` — judge one to four files as ONE import.
 *
 * Not the same as calling `previewBulkCsv` per file: the backend applies every
 * file's candidate rows to one overlay and analyses it once, so a relationship
 * that spans two of the files is detected before either is committed. Confirm and
 * reject are the existing routes, called with the returned import id.
 */
export const previewBulkBatch = (body: BulkBatchIn, o: Signalled = {}) =>
  post<BulkBatchPreviewOut>('ingest/bulk/preview', body, { signal: o.signal });

/** `POST /api/v1/ingest/bulk/{import_id}/confirm` — commit the new rows only. */
export const confirmBulkImport = (importId: string, o: Signalled = {}) =>
  post<BulkConfirmOut>(`ingest/bulk/${importId}/confirm`, undefined, { signal: o.signal });

/** `POST /api/v1/ingest/bulk/{import_id}/reject` — discard the preview. */
export const rejectBulkImport = (importId: string, o: Signalled = {}) =>
  post<BulkRejectOut>(`ingest/bulk/${importId}/reject`, undefined, { signal: o.signal });

/* ------------------------------------ Phase 5 — audit chain verification -- */

/**
 * `GET /api/v1/audit/verify` — recompute the audit hash chain, end to end.
 *
 * A read: it appends nothing. The answer is `VERIFIED` or
 * `INTEGRITY_COMPROMISED`, and on failure it names the event and both hashes.
 * The ledger's other routes (the event list, per-resource verification and the
 * integrity-record write) exist on the backend but are not consumed here.
 */
export const verifyAuditChain = (o: Signalled = {}) =>
  request<ChainVerificationOut>('audit/verify', { signal: o.signal });
