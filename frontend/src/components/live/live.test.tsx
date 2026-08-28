/**
 * The live-ingestion surface: submit, verdict, connection state, auto-refresh.
 *
 * Every fixture below is a recording of what the running pipeline answered for
 * the submission named in the file — captured by `backend/scripts/phase4_6_demo.py`
 * against a live server. That matters more here than anywhere else in this suite:
 * the point of these cases is that the UI reports the backend's decision rather
 * than forming one, so a hand-written "accepted" body would test nothing.
 *
 * What these cases hold in place:
 *
 *  1. THE CLIENT DECIDES NOTHING. It posts what was typed and renders what came
 *     back. All four statuses render, and a REJECTED or held record renders as
 *     fully as an accepted one.
 *  2. THE TWO REVIEW REASONS STAY APART. AMBIGUOUS_MATCH ("which of these people
 *     is this?") and NO_MATCH_NEW_ENTITY ("this is nobody we have") are different
 *     findings and are never shown as each other.
 *  3. NEW IS NOT SUSPICIOUS. An unrelated pair is held for review with the
 *     backend's own explanation, and nothing about it is called a detection.
 *  4. THE STREAM IS NAMED FRAMES. The backend names every frame, so the client
 *     must listen per type; the stub delivers named frames only, which is what
 *     makes the "did you actually addEventListener" question testable.
 *  5. LIVE MEANS NO RELOAD. One accepted record refreshes the queue in place,
 *     once — and a frame that cannot have moved a score does not refetch at all.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LIVE_EVENT_TYPES } from '@/types/api';
import type { IngestRecordOut } from '@/types/api';
import {
  fixtures,
  installEventSource,
  installFetch,
  liveEvent,
  renderWithRouter,
} from '@/test/helpers';
import { AlertsPage } from '@/pages/AlertsPage';

import { AddIntelligence, toPersonRef } from './AddIntelligence';
import { IngestVerdict } from './IngestVerdict';
import { LiveIndicator } from './LiveIndicator';

const accepted = fixtures.ingestCallAccepted as unknown as IngestRecordOut;
const duplicate = fixtures.ingestCallDuplicate as unknown as IngestRecordOut;
const rejected = fixtures.ingestCallRejected as unknown as IngestRecordOut;
const review = fixtures.ingestCallReview as unknown as IngestRecordOut;
const ambiguousPerson = fixtures.ingestCallAmbiguous as unknown as IngestRecordOut;
const ambiguousPlace = fixtures.ingestLocationAmbiguous as unknown as IngestRecordOut;
const firAccepted = fixtures.ingestFirAccepted as unknown as IngestRecordOut;

/** Fill the call form the way an operator would, then submit. */
function submitCall() {
  fireEvent.change(screen.getByLabelText('Caller'), { target: { value: '141' } });
  fireEvent.change(screen.getByLabelText('Receiver'), { target: { value: '21' } });
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2026-08-20T21:40' } });
  fireEvent.change(screen.getByLabelText('Duration (sec)'), { target: { value: '415' } });
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'station-log' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit record' }));
}

const verdict = () => screen.getByTestId('ingest-verdict');

describe('toPersonRef — an identifier is read as the kind its shape implies', () => {
  it('reads digits by length and anything else as a name', () => {
    expect(toPersonRef('141')).toEqual({ person_id: 141 });
    expect(toPersonRef('8600506062')).toEqual({ phone: '8600506062' });
    expect(toPersonRef('245220443325')).toEqual({ aadhaar: '245220443325' });
    expect(toPersonRef('Yashica Borah')).toEqual({ name: 'Yashica Borah' });
  });

  it('ignores the separators an operator types, and sends nothing for nothing', () => {
    expect(toPersonRef(' 8600 506 062 ')).toEqual({ phone: '8600506062' });
    expect(toPersonRef('2452-2044-3325')).toEqual({ aadhaar: '245220443325' });
    expect(toPersonRef('   ')).toBeUndefined();
    expect(toPersonRef('')).toBeUndefined();
  });
});

describe('AddIntelligence — the submission', () => {
  it('posts exactly what was typed to the ingestion route', async () => {
    const { fetchMock, calls } = installFetch();
    renderWithRouter(<AddIntelligence />);

    submitCall();
    await waitFor(() => expect(verdict()).toBeInTheDocument());

    expect(calls).toContain('/api/v1/ingest/call');
    // The stub's declared signature takes the URL alone; the init object is the
    // second argument `fetch` was really called with.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    // The client normalises nothing: no reformatted timestamp, no coerced
    // duration, no invented fields. The backend owns every one of those steps.
    expect(JSON.parse(String(init.body))).toEqual({
      provenance: { source_name: 'station-log' },
      caller: { person_id: 141 },
      callee: { person_id: 21 },
      start_time: '2026-08-20T21:40',
      duration_sec: '415',
    });
  });

  it('switches route and fields with the record type', async () => {
    const { calls } = installFetch();
    renderWithRouter(<AddIntelligence />);

    fireEvent.click(screen.getByRole('radio', { name: 'FIR' }));
    fireEvent.change(screen.getByLabelText('Complainant'), { target: { value: '21' } });
    fireEvent.change(screen.getByLabelText('Accused (optional)'), { target: { value: '141' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-21' } });
    fireEvent.change(screen.getByLabelText('Narrative'), {
      target: { value: 'Complainant reports a demand for payment.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit record' }));

    await waitFor(() => expect(verdict()).toBeInTheDocument());
    expect(calls).toContain('/api/v1/ingest/fir');
    // A narrative belongs to a FIR alone; a call has no such field to send.
    fireEvent.click(screen.getByRole('radio', { name: 'Call' }));
    expect(screen.queryByLabelText('Narrative')).not.toBeInTheDocument();
  });

  it('reports a transport failure as a failure, not as a rejected record', async () => {
    installFetch([{ match: '/api/v1/ingest/call', body: fixtures.error422Search, status: 422 }]);
    renderWithRouter(<AddIntelligence />);

    submitCall();

    await waitFor(() => expect(screen.getByTestId('ingest-error')).toBeInTheDocument());
    expect(screen.queryByTestId('ingest-verdict')).not.toBeInTheDocument();
  });

  it('hands the verdict to its caller so the page can react', async () => {
    installFetch();
    const seen: IngestRecordOut[] = [];
    renderWithRouter(<AddIntelligence onSubmitted={(record) => seen.push(record)} />);

    submitCall();

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].record_id).toBe(accepted.record_id);
    expect(seen[0].status).toBe('ACCEPTED');
  });
});

describe('IngestVerdict — all four outcomes render as themselves', () => {
  it('an accepted record shows what it changed', () => {
    renderWithRouter(<IngestVerdict record={accepted} />);

    expect(verdict()).toHaveAttribute('data-status', 'ACCEPTED');
    expect(screen.getByTestId('ingest-reason')).toHaveTextContent(accepted.reason);
    expect(screen.getByText('ACCEPTED')).toBeInTheDocument();

    // The relationship the pipeline accepted, named as the backend named it.
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText(accepted.relationships[0].relationship_type)).toBeInTheDocument();

    // Impact is reported, including the cost of the global recomputation.
    const impact = screen.getByTestId('ingest-impact');
    expect(within(impact).getByText('Graph')).toBeInTheDocument();
    expect(within(impact).getByText('Recompute')).toBeInTheDocument();
    expect(within(impact).getByText('Priority')).toBeInTheDocument();
  });

  it('a duplicate says nothing was added', () => {
    renderWithRouter(<IngestVerdict record={duplicate} />);

    expect(verdict()).toHaveAttribute('data-status', 'DUPLICATE');
    expect(screen.getByTestId('ingest-reason')).toHaveTextContent(duplicate.reason);
    expect(screen.queryByTestId('ingest-impact')).not.toBeInTheDocument();
    expect(screen.getByText(String(duplicate.impact.note))).toBeInTheDocument();

    // The record it repeats is named — and it is the same content hash, which is
    // why it appears twice: as this record's id and as the one it duplicates.
    expect(duplicate.record_id).toBe(accepted.record_id);
    expect(screen.getAllByText(duplicate.record_id.slice(0, 12))).toHaveLength(2);
    expect(duplicate.duplicate_of).toBe(accepted.record_id);
  });

  it('a rejected record carries its field-level reason and no impact', () => {
    renderWithRouter(<IngestVerdict record={rejected} />);

    expect(verdict()).toHaveAttribute('data-status', 'REJECTED');
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    expect(screen.getByText(String(rejected.reject_reason))).toBeInTheDocument();
    expect(screen.getByTestId('ingest-reason')).toHaveTextContent(rejected.reason);
    expect(screen.getByText('Rejected: nothing was stored or changed.')).toBeInTheDocument();
    expect(screen.queryByTestId('ingest-impact')).not.toBeInTheDocument();
  });

  it('an unrelated pair is held for review, and is not called suspicious', () => {
    renderWithRouter(<IngestVerdict record={review} />);

    expect(verdict()).toHaveAttribute('data-status', 'REVIEW_REQUIRED');
    expect(screen.getByText('NO_MATCH_NEW_ENTITY')).toBeInTheDocument();
    expect(screen.getByTestId('ingest-reason')).toHaveTextContent(
      'No validated connection found with existing investigation data.',
    );
    // Nothing was forced into the graph, and nothing was scored.
    expect(screen.queryByTestId('ingest-impact')).not.toBeInTheDocument();
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument();

    const rendered = verdict().textContent ?? '';
    for (const word of ['suspicious', 'criminal', 'guilty', 'AMBIGUOUS_MATCH']) {
      expect(rendered).not.toContain(word);
    }
  });

  it('an ambiguous person is left for a decision, with the candidates named', () => {
    renderWithRouter(<IngestVerdict record={ambiguousPerson} />);

    expect(verdict()).toHaveAttribute('data-status', 'REVIEW_REQUIRED');
    expect(screen.getByText('AMBIGUOUS_MATCH')).toBeInTheDocument();
    expect(verdict().textContent).not.toContain('NO_MATCH_NEW_ENTITY');

    // "Which of these?" is answerable from the payload alone.
    const notes = screen.getByTestId('match-notes');
    const candidates = ambiguousPerson.matches.find((m) => m.status === 'AMBIGUOUS')!.candidates;
    expect(candidates.length).toBeGreaterThan(1);
    expect(within(notes).getByText(candidates[0].entity_id)).toBeInTheDocument();
    expect(within(notes).getByText(candidates[0].label)).toBeInTheDocument();
    // No merge happened.
    expect(screen.queryByTestId('ingest-impact')).not.toBeInTheDocument();
  });

  it('an ambiguous place invents no geography', () => {
    renderWithRouter(<IngestVerdict record={ambiguousPlace} />);

    expect(screen.getByText('AMBIGUOUS_MATCH')).toBeInTheDocument();
    expect(screen.getByTestId('ingest-reason')).toHaveTextContent('supply a location_id');
    // The person resolved; only the place did not. The resolved half is not
    // silently promoted into a stored observation.
    expect(ambiguousPlace.matches.map((m) => m.status)).toEqual(['MATCHED', 'AMBIGUOUS']);
    expect(screen.queryByTestId('ingest-impact')).not.toBeInTheDocument();
  });

  it('marks a self-reference as evidence only', () => {
    // The recorded FIR names its own subjects; anything the pipeline flagged as a
    // self-reference must be shown as excluded from intelligence, not as a link.
    const selfRefs = firAccepted.relationships.filter((r) => r.is_self_reference);
    renderWithRouter(<IngestVerdict record={firAccepted} />);

    expect(verdict()).toHaveAttribute('data-status', 'ACCEPTED');
    if (selfRefs.length > 0) {
      expect(selfRefs.every((r) => r.excluded_from_intelligence)).toBe(true);
      expect(screen.getAllByText('· evidence only').length).toBe(selfRefs.length);
    } else {
      expect(screen.queryByText('· evidence only')).not.toBeInTheDocument();
    }
  });
});

describe('LiveIndicator — the connection state, honestly', () => {
  it('says the stream is off when the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    renderWithRouter(<LiveIndicator />);

    expect(screen.getByTestId('live-indicator')).toHaveAttribute('data-status', 'offline');
    expect(screen.getByText('Live off')).toBeInTheDocument();
  });

  it('goes connecting → live → offline with the transport', () => {
    const sse = installEventSource();
    renderWithRouter(<LiveIndicator />);

    const indicator = () => screen.getByTestId('live-indicator');
    expect(indicator()).toHaveAttribute('data-status', 'connecting');
    expect(sse.instances).toHaveLength(1);
    expect(sse.latest().url).toContain('/api/v1/ingest/stream');

    sse.open();
    expect(indicator()).toHaveAttribute('data-status', 'live');
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    // The browser retrying on its own is not "offline"; giving up is.
    sse.fail({ retrying: true });
    expect(indicator()).toHaveAttribute('data-status', 'connecting');
    sse.fail();
    expect(indicator()).toHaveAttribute('data-status', 'offline');
  });

  it('opens one connection for two mounted subscribers and closes it after both', () => {
    const sse = installEventSource();
    const first = renderWithRouter(<LiveIndicator />);
    const second = renderWithRouter(<LiveIndicator />);

    expect(sse.instances).toHaveLength(1);

    first.unmount();
    expect(sse.latest().closed).toBe(false);
    second.unmount();
    expect(sse.latest().closed).toBe(true);
  });

  it('listens for every frame name the backend sends', () => {
    const sse = installEventSource();
    renderWithRouter(<LiveIndicator />);

    // The recording is a real SSE session; every type in it must be a type the
    // client registered a listener for, or those frames would arrive nowhere.
    const recorded = new Set(
      (fixtures.liveEvents as Array<{ event_type: string }>).map((e) => e.event_type),
    );
    expect(recorded.size).toBe(5);
    for (const type of recorded) {
      expect(LIVE_EVENT_TYPES as readonly string[]).toContain(type);
      expect(sse.latest().named.get(type)?.size ?? 0).toBeGreaterThan(0);
    }
  });

  it('carries no record content over the stream', () => {
    // §12: the frames say what changed, not what was written. The record body is
    // fetched over REST, where it is subject to the same rules as everything else.
    const raw = JSON.stringify(fixtures.liveEvents);
    for (const key of ['narrative', 'raw_payload', 'normalized_payload', 'name', 'phone', 'aadhaar']) {
      expect(raw).not.toContain(`"${key}"`);
    }
  });
});

describe('the live channel refreshes the screen it belongs to', () => {
  it('refetches the queue on new intelligence, without a reload', async () => {
    const { calls } = installFetch();
    const sse = installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    await waitFor(() => expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0));
    sse.open();
    const rankingCalls = () => calls.filter((url) => url.includes('/intelligence/persons/top'));
    const before = rankingCalls().length;
    expect(before).toBeGreaterThan(0);

    // A frame that cannot have moved a score must not cost a request.
    sse.push(liveEvent('entity_updated'));
    expect(rankingCalls()).toHaveLength(before);

    // The last frame of an accepted record is the one that refreshes.
    sse.push(liveEvent('new_intelligence'));
    await waitFor(() => expect(rankingCalls().length).toBe(before + 1));

    // Refreshed in place: the queue never emptied and no reload happened.
    expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0);
  });

  it('refreshes once per accepted record, not once per frame', async () => {
    const { calls } = installFetch();
    const sse = installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    await waitFor(() => expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0));
    sse.open();
    const rankingCalls = () => calls.filter((url) => url.includes('/intelligence/persons/top'));
    const before = rankingCalls().length;

    // One accepted record publishes the whole recorded sequence.
    for (const event of fixtures.liveEvents as Array<{ event_type: string }>) {
      sse.push(event as { event_type: string });
    }

    await waitFor(() => expect(rankingCalls().length).toBe(before + 1));
    expect(rankingCalls()).toHaveLength(before + 1);
  });

  it('offers the write surface on the screen that shows the priorities', async () => {
    installFetch();
    installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    await waitFor(() => expect(screen.getByTestId('add-intelligence')).toBeInTheDocument());
    expect(within(screen.getByTestId('add-intelligence')).getByText('Synthetic data only'))
      .toBeInTheDocument();
  });
});
