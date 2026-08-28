/**
 * Communication — §1: an independent product area, not the Network page shown
 * with an empty person-search state.
 *
 * The page has two states and both are asserted: corpus-wide when nothing is
 * scoped, and one subject's picture when `?person=` names someone. Every expected
 * figure is read out of the same recording the component is served, so an
 * assertion here cannot drift away from the data behind it.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetPersonNames } from '@/hooks/usePersonNames';
import { fixtures, installFetch, renderWithRouter, statTile } from '@/test/helpers';
import type {
  CallRecord,
  CommunicationBaselineOut,
  EdgeOut,
  Page,
  PatternListResponse,
} from '@/types/api';
import { formatCount, formatMetric, humanizeToken } from '@/utils/format';

import { CommunicationPage } from './CommunicationPage';

const ANCHOR = 'person:445';

const allCalls = fixtures.callsPage1 as unknown as Page<CallRecord>;
const outgoing = fixtures.callsCaller445 as unknown as Page<CallRecord>;
const incoming = fixtures.callsCallee445 as unknown as Page<CallRecord>;
const anomalies = fixtures.patternsCommunication as unknown as PatternListResponse;
const multiChannel = fixtures.patternsMultiChannel as unknown as PatternListResponse;
const network = fixtures.network445Depth1 as unknown as { edges: EdgeOut[] };
const baseline = (
  fixtures.personIntelligence445 as unknown as {
    communication_baseline: CommunicationBaselineOut;
  }
).communication_baseline;

/** Every call edge in the recorded depth-1 subgraph… */
const called = network.edges.filter(
  (edge) => edge.relationship_type === 'CALLED' && !edge.is_overlay,
);
/** …and the subset the subject was actually a party to. */
const anchorCalled = called.filter(
  (edge) => edge.source_entity_id === ANCHOR || edge.target_entity_id === ANCHOR,
);
const counterparties = new Set(
  anchorCalled.map((edge) =>
    edge.source_entity_id === ANCHOR ? edge.target_entity_id : edge.source_entity_id,
  ),
);

describe('Communication — the corpus-wide browse', () => {
  beforeEach(resetPersonNames);

  it('is a page of call records, not a network waiting to be given a person', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication' });

    await waitFor(() =>
      expect(screen.getAllByTestId('call-row')).toHaveLength(allCalls.items.length),
    );

    expect(screen.getByTestId('communication-page')).toBeInTheDocument();
    // The subject control is a search that *narrows* what is already on screen,
    // not a gate that has to be satisfied before anything appears.
    expect(screen.getByTestId('scope-search')).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/api/v1/calls?page=1&page_size=25'))).toBe(true);
    // §1 again, from the other side: with no subject selected, nothing
    // person-rooted may be requested — that is the Network page's job.
    expect(calls.some((url) => url.includes('/graph/persons/'))).toBe(false);
  });

  it('reports the backend’s own totals rather than the size of the page it read', async () => {
    installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication' });

    await waitFor(() =>
      expect(statTile('Call records')).toHaveTextContent(formatCount(allCalls.meta.total)),
    );
    expect(statTile('Communication anomalies')).toHaveTextContent(formatCount(anomalies.total));
    expect(statTile('Multi-channel links')).toHaveTextContent(formatCount(multiChannel.total));
  });

  it('asks the pattern engine for its own two categories by name', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication' });

    const panel = await screen.findByTestId('pattern-list');

    // The unfiltered pattern list is ordered by severity across all nine
    // categories, so a two-category screen that read it would find none of its
    // own and report "no patterns detected" over a backend holding hundreds.
    // `limit=10` distinguishes the panel's requests from the tiles' `limit=1`.
    await waitFor(() =>
      expect(
        calls.filter(
          (url) => url.includes('pattern_type=COMMUNICATION_ANOMALY') && url.includes('limit=10'),
        ),
      ).toHaveLength(1),
    );
    expect(
      calls.filter(
        (url) =>
          url.includes('pattern_type=MULTI_CHANNEL_RELATIONSHIP') && url.includes('limit=10'),
      ),
    ).toHaveLength(1);

    await waitFor(() => expect(within(panel).getAllByTestId('pattern-row')).toHaveLength(10));
    expect(within(panel).queryByText('No patterns detected')).not.toBeInTheDocument();
    // Two disjoint detections, so the panel's denominator is their sum.
    expect(panel).toHaveTextContent(formatCount(anomalies.total + multiChannel.total));
  });

  it('pages the table on the backend’s own has_next', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication' });

    const table = await screen.findByTestId('call-table');
    const next = await within(table).findByRole('button', { name: 'Next page' });
    expect(allCalls.meta.has_next).toBe(true);
    await waitFor(() => expect(next).toBeEnabled());

    fireEvent.click(next);
    await waitFor(() =>
      expect(calls.some((url) => url.includes('/api/v1/calls?page=2'))).toBe(true),
    );
  });
});

describe('Communication — scoped to one subject', () => {
  beforeEach(resetPersonNames);

  it('reads both directions and reports the total the backend gives for each', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication?person=445' });

    await waitFor(() =>
      expect(statTile('Total calls')).toHaveTextContent(
        formatCount(outgoing.meta.total + incoming.meta.total),
      ),
    );

    expect(calls.some((url) => url.includes('/api/v1/calls?caller_id=445'))).toBe(true);
    expect(calls.some((url) => url.includes('/api/v1/calls?callee_id=445'))).toBe(true);
    expect(statTile('Outgoing')).toHaveTextContent(formatCount(outgoing.meta.total));
    expect(statTile('Incoming')).toHaveTextContent(formatCount(incoming.meta.total));
    expect(screen.getAllByTestId('call-row')).toHaveLength(
      outgoing.items.length + incoming.items.length,
    );
  });

  it('counts a contact once, and only from calls the subject was party to', async () => {
    installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication?person=445' });

    const panel = await screen.findByTestId('top-contacts');
    await waitFor(() =>
      expect(within(panel).getAllByTestId('contact-row')).toHaveLength(counterparties.size),
    );

    // A depth-1 subgraph also carries the calls the subject's neighbours made to
    // each other. Those are not this subject's contacts, and counting them would
    // attribute a call link to someone who never made it.
    expect(called.length).toBeGreaterThan(anchorCalled.length);
    expect(statTile('Unique contacts')).toHaveTextContent(formatCount(counterparties.size));
  });

  it('shows the source call ids behind a contact', async () => {
    installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication?person=445' });

    const panel = await screen.findByTestId('top-contacts');
    const evidenceId = anchorCalled[0].evidence?.[0];
    expect(evidenceId).toBeTruthy();
    await waitFor(() =>
      expect(within(panel).getAllByText(String(evidenceId)).length).toBeGreaterThan(0),
    );
  });

  it('presents the call-frequency baseline as a status, with the calls behind it', async () => {
    installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication?person=445' });

    const panel = await screen.findByTestId('communication-anomaly');
    await waitFor(() =>
      expect(within(panel).getByTestId('anomaly-status')).toHaveTextContent(
        humanizeToken(baseline.anomaly_status),
      ),
    );

    expect(panel).toHaveTextContent(formatMetric(baseline.z_score, 2));
    for (const callId of baseline.supporting_call_ids ?? []) {
      expect(within(panel).getByText(String(callId))).toBeInTheDocument();
    }
  });

  it('scopes the pattern panel to the subject', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommunicationPage />, { route: '/communication?person=445' });

    await waitFor(() =>
      expect(
        calls.some(
          (url) =>
            url.includes('pattern_type=COMMUNICATION_ANOMALY') &&
            /entity_id=person(%3A|:)445/.test(url),
        ),
      ).toBe(true),
    );
  });
});
