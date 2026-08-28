/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactElement, ReactNode } from 'react';
import { act, render, screen, type RenderOptions } from '@testing-library/react';
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
import intelligenceSummary from './fixtures/intelligence-summary.json';
import priorityRanking from './fixtures/intelligence-persons-top.json';
import priorityRankingLow from './fixtures/intelligence-persons-top-low.json';
import priorityRankingHigh from './fixtures/intelligence-persons-top-high.json';
import personIntelligence21 from './fixtures/intelligence-person-21.json';
import personIntelligence212 from './fixtures/intelligence-person-212.json';
import personIntelligence141 from './fixtures/intelligence-person-141.json';
import personExplain141 from './fixtures/intelligence-person-141-explain.json';
import personIntelligence445 from './fixtures/intelligence-person-445.json';
import personExplain445 from './fixtures/intelligence-person-445-explain.json';
import patternsPage1 from './fixtures/intelligence-patterns.json';
import patternsCycle from './fixtures/intelligence-patterns-cycle.json';
import patternsEmpty from './fixtures/intelligence-patterns-empty.json';
import patternDetail from './fixtures/intelligence-pattern-detail.json';
// Record listings — the corpus-wide browse behind Communication, Financial and
// Location Intelligence, plus the person-scoped slices those pages request once a
// subject is selected.
import personsPage1 from './fixtures/persons-page1.json';
import personsCityMumbai from './fixtures/persons-city-mumbai.json';
import callsPage1 from './fixtures/calls-page1.json';
import callsCaller445 from './fixtures/calls-caller-445.json';
import callsCallee445 from './fixtures/calls-callee-445.json';
import transactionsPage1 from './fixtures/transactions-page1.json';
import transactionsSender445 from './fixtures/transactions-sender-445.json';
import transactionsReceiver445 from './fixtures/transactions-receiver-445.json';
import locationsPage1 from './fixtures/locations-page1.json';
// One recording per pattern type the domain pages filter on. Without these a
// filtered request would fall through to the unfiltered list — and that list is
// all BRIDGE_ENTITY, so a page would show a pattern of the wrong type.
import patternsCommunication from './fixtures/patterns-communication.json';
import patternsMultiChannel from './fixtures/patterns-multi-channel-relationship.json';
import patternsFanIn from './fixtures/patterns-fan-in.json';
import patternsFanOut from './fixtures/patterns-transaction-fan-out.json';
import patternsConcentration from './fixtures/patterns-transaction-concentration.json';
import patternsLocationCohort from './fixtures/patterns-location-cohort.json';
import patternsSharedLocation from './fixtures/patterns-shared-location-pair.json';
import error404Person from './fixtures/error-404-person.json';
import error404Pattern from './fixtures/error-404-pattern.json';
import error400Depth from './fixtures/error-400-depth.json';
import error422Search from './fixtures/error-422-search.json';
// Phase 4.6 — the live-ingestion recordings. Each is a verdict the running
// pipeline actually returned for the submission named in the file, captured by
// `backend/scripts/phase4_6_demo.py`. The four statuses and both review reasons
// are represented because the backend produced all six, not because a test
// needed them to exist.
import ingestCallAccepted from './fixtures/ingest-call-accepted.json';
import ingestCallDuplicate from './fixtures/ingest-call-duplicate.json';
import ingestCallRejected from './fixtures/ingest-call-rejected.json';
import ingestCallReview from './fixtures/ingest-call-review.json';
import ingestCallAmbiguous from './fixtures/ingest-call-ambiguous.json';
import ingestTransactionAccepted from './fixtures/ingest-transaction-accepted.json';
import ingestFirAccepted from './fixtures/ingest-fir-accepted.json';
import ingestLocationAccepted from './fixtures/ingest-location-accepted.json';
import ingestLocationAmbiguous from './fixtures/ingest-location-ambiguous.json';
import ingestRecord from './fixtures/ingest-record.json';
import ingestImpact from './fixtures/ingest-impact.json';
import entityChanges141 from './fixtures/entity-changes-141.json';
import liveEvents from './fixtures/live-events.json';
// Phase 5 — the audit chain, recorded by `backend/scripts/phase5_audit_demo.py`.
// The compromised recording is what the real ledger answered after one field of
// one recorded event was changed in memory; the hashes in it are genuine.
import auditVerify from './fixtures/audit-verify.json';
import auditVerifyCompromised from './fixtures/audit-verify-compromised.json';

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
  intelligenceSummary,
  priorityRanking,
  priorityRankingLow,
  priorityRankingHigh,
  personIntelligence21,
  personIntelligence212,
  personIntelligence141,
  personExplain141,
  personIntelligence445,
  personExplain445,
  patternsPage1,
  patternsCycle,
  patternsEmpty,
  patternDetail,
  personsPage1,
  personsCityMumbai,
  callsPage1,
  callsCaller445,
  callsCallee445,
  transactionsPage1,
  transactionsSender445,
  transactionsReceiver445,
  locationsPage1,
  patternsCommunication,
  patternsMultiChannel,
  patternsFanIn,
  patternsFanOut,
  patternsConcentration,
  patternsLocationCohort,
  patternsSharedLocation,
  error404Person,
  error404Pattern,
  error400Depth,
  error422Search,
  ingestCallAccepted,
  ingestCallDuplicate,
  ingestCallRejected,
  ingestCallReview,
  ingestCallAmbiguous,
  ingestTransactionAccepted,
  ingestFirAccepted,
  ingestLocationAccepted,
  ingestLocationAmbiguous,
  ingestRecord,
  ingestImpact,
  entityChanges141,
  liveEvents,
  auditVerify,
  auditVerifyCompromised,
} as const;

export type FixtureRoute = {
  /** Substring or RegExp matched against the requested URL. */
  match: string | RegExp;
  body: unknown;
  status?: number;
};

/** Location 23 — Mumbai — lifted out of the 200-row locations recording. */
const locationRecord23 = (locationsPage1 as { items: Array<{ location_id: number }> }).items.find(
  (item) => item.location_id === 23,
);

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
    // `/persons/445` reports `location_id: 23`, so the person-scoped Location
    // screen asks for that record by id. The 200-row locations recording already
    // holds that row, so it is served from there rather than re-recorded.
    { match: '/api/v1/locations/23', body: locationRecord23 },
    // Record listings. Person-scoped slices come first: `caller_id` and `callee_id`
    // are different questions with different recordings, and the general list route
    // would otherwise answer both. Both general routes sit after the `/{id}` detail
    // routes above for the same reason.
    { match: /\/api\/v1\/calls\?[^]*caller_id=445/, body: callsCaller445 },
    { match: /\/api\/v1\/calls\?[^]*callee_id=445/, body: callsCallee445 },
    { match: '/api/v1/calls', body: callsPage1 },
    { match: /\/api\/v1\/transactions\?[^]*sender_id=445/, body: transactionsSender445 },
    { match: /\/api\/v1\/transactions\?[^]*receiver_id=445/, body: transactionsReceiver445 },
    { match: '/api/v1/transactions', body: transactionsPage1 },
    { match: /\/api\/v1\/persons\?[^]*city=Mumbai/, body: personsCityMumbai },
    { match: '/api/v1/persons', body: personsPage1 },
    { match: '/api/v1/locations', body: locationsPage1 },
    // Phase 4 intelligence. Order matters twice over: `/persons/top` must be
    // matched before the numeric person routes (it is not a person id), and
    // `/{id}/explain` before `/{id}`. The pattern-detail route is a regex so the
    // content-addressed id in the URL is matched rather than the list endpoint.
    { match: '/api/v1/intelligence/summary', body: intelligenceSummary },
    { match: /\/api\/v1\/intelligence\/persons\/top\?[^]*band=LOW/, body: priorityRankingLow },
    // A genuinely empty answer: nothing in this corpus scores 70 or above.
    { match: /\/api\/v1\/intelligence\/persons\/top\?[^]*band=HIGH/, body: priorityRankingHigh },
    { match: '/api/v1/intelligence/persons/top', body: priorityRanking },
    { match: '/api/v1/intelligence/persons/141/explain', body: personExplain141 },
    { match: '/api/v1/intelligence/persons/445/explain', body: personExplain445 },
    // Anchored so `/persons/21` cannot answer for `/persons/212` or `/21/explain`.
    { match: /\/api\/v1\/intelligence\/persons\/21(?:$|\?)/, body: personIntelligence21 },
    { match: /\/api\/v1\/intelligence\/persons\/212(?:$|\?)/, body: personIntelligence212 },
    { match: '/api/v1/intelligence/persons/141', body: personIntelligence141 },
    { match: '/api/v1/intelligence/persons/445', body: personIntelligence445 },
    { match: /\/api\/v1\/intelligence\/patterns\?[^]*entity_id=person(%3A|:)999999/, body: patternsEmpty },
    {
      match: /\/api\/v1\/intelligence\/patterns\?[^]*pattern_type=TRANSACTION_CYCLE/,
      body: patternsCycle,
    },
    // One route per type the domain pages ask for, each a recording of that exact
    // filter. TRANSACTION_FAN_IN and TRANSACTION_FAN_OUT are separate detections and
    // separate recordings; neither answers for the other.
    { match: /pattern_type=COMMUNICATION_ANOMALY/, body: patternsCommunication },
    { match: /pattern_type=MULTI_CHANNEL_RELATIONSHIP/, body: patternsMultiChannel },
    { match: /pattern_type=TRANSACTION_FAN_IN/, body: patternsFanIn },
    { match: /pattern_type=TRANSACTION_FAN_OUT/, body: patternsFanOut },
    { match: /pattern_type=TRANSACTION_CONCENTRATION/, body: patternsConcentration },
    { match: /pattern_type=LOCATION_COHORT/, body: patternsLocationCohort },
    { match: /pattern_type=SHARED_LOCATION_PAIR/, body: patternsSharedLocation },
    { match: /\/api\/v1\/intelligence\/patterns\/[^?]+/, body: patternDetail },
    { match: '/api/v1/intelligence/patterns', body: patternsPage1 },
    // Phase 4.6 ingestion — the only writes in the app. `installFetch` matches on
    // URL, not verb, so these answer the POSTs; a test that needs a different
    // verdict for the same route passes its own table.
    { match: '/api/v1/ingest/call', body: ingestCallAccepted },
    { match: '/api/v1/ingest/transaction', body: ingestTransactionAccepted },
    { match: '/api/v1/ingest/fir', body: ingestFirAccepted },
    { match: '/api/v1/ingest/location', body: ingestLocationAccepted },
    { match: /\/api\/v1\/ingest\/[^/?]+\/impact/, body: ingestImpact },
    { match: /\/api\/v1\/entities\/person(%3A|:)141\/changes/, body: entityChanges141 },
    // Phase 5 — the audit chain verdict. A VERIFIED chain by default; a test that
    // needs the compromised recording passes its own table.
    { match: '/api/v1/audit/verify', body: auditVerify },
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

/** One stubbed SSE connection. Only what `api/live.ts` actually touches. */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = StubEventSource.CONNECTING;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  readonly named = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: any) => void) {
    const set = this.named.get(type) ?? new Set();
    set.add(handler);
    this.named.set(type, set);
  }

  removeEventListener(type: string, handler: (event: any) => void) {
    this.named.get(type)?.delete(handler);
  }

  close() {
    this.closed = true;
    this.readyState = StubEventSource.CLOSED;
  }
}

/**
 * Install a stub `EventSource`.
 *
 * jsdom ships none, so an un-stubbed test sees the live channel report `offline`
 * — which is the honest answer, and is itself worth testing. With this installed
 * a test can drive the three connection states and push recorded frames.
 *
 * `push` delivers to NAMED listeners only, exactly as the backend does: every
 * frame it writes carries `event: <type>`, so a client that only wired
 * `onmessage` would receive nothing. That failure is silent in a browser, so the
 * stub reproduces the constraint rather than papering over it.
 */
export function installEventSource() {
  const instances: StubEventSource[] = [];
  class Stub extends StubEventSource {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  }
  vi.stubGlobal('EventSource', Stub);

  const latest = () => instances[instances.length - 1];

  return {
    instances,
    latest,
    /** The connection succeeds. */
    open() {
      const stream = latest();
      stream.readyState = StubEventSource.OPEN;
      act(() => stream.onopen?.(new Event('open')));
    },
    /** The connection drops. `retrying` is the browser's own reconnect state. */
    fail({ retrying = false }: { retrying?: boolean } = {}) {
      const stream = latest();
      stream.readyState = retrying ? StubEventSource.CONNECTING : StubEventSource.CLOSED;
      act(() => stream.onerror?.(new Event('error')));
    },
    /** Deliver one recorded event envelope as a named frame. */
    push(event: { event_type: string; [key: string]: unknown }) {
      const stream = latest();
      const handlers = stream.named.get(event.event_type);
      act(() => {
        for (const handler of handlers ?? []) handler({ data: JSON.stringify(event) });
      });
    },
  };
}

/** One recorded frame of the given type, from the captured SSE session. */
export function liveEvent(type: string) {
  const event = (liveEvents as Array<{ event_type: string }>).find((e) => e.event_type === type);
  if (!event) throw new Error(`No recorded live event of type ${type}`);
  return event as { event_type: string; [key: string]: unknown };
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

/**
 * The `<StatTile>` carrying the given label.
 *
 * A label is not unique on a page — "Locations" is both a tile and a table's
 * heading — so this walks up from every matching text node to a tile container
 * instead of assuming the first match is the one wanted.
 */
export function statTile(label: string): HTMLElement {
  const found = screen
    .getAllByText(label)
    .map((node) => node.closest('[data-testid="stat-tile"]'))
    .find((node): node is HTMLElement => node !== null);
  if (!found) throw new Error(`No stat tile labelled "${label}"`);
  return found;
}
