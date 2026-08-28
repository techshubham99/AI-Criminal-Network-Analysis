/**
 * Communication — an independent product area, not a tab of the network page.
 *
 * Corpus-wide by default: the call record table, the detected communication
 * patterns, and the totals the backend reports for them. Scoped to a subject on
 * request: that person's calls in both directions, their contacts ranked by call
 * frequency, and the anomaly baseline the intelligence engine computed for them.
 *
 * Every figure below is read from a response. Where the backend exposes no filter
 * — corpus-wide unique-contact counts, for instance — the figure is simply absent
 * rather than approximated from one page of rows.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { PatternDetails, PatternList } from '@/components/intelligence';
import { Cell, DataTable, Pager, PersonRef, SubjectScope } from '@/components/records';
import {
  Badge,
  Divider,
  EmptyState,
  ErrorState,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  SkeletonRows,
  SkeletonTile,
  StatTile,
} from '@/components/ui';
import { useAsync, type AsyncState } from '@/hooks/useAsync';
import { useLive } from '@/hooks/useLive';
import { usePersonNames, type PersonNames } from '@/hooks/usePersonNames';
import { usePersonScope } from '@/hooks/usePersonScope';
import type { CallRecord, CommunicationBaselineOut, EdgeOut, Page } from '@/types/api';
import { formatCount, formatDateTime, formatDuration, formatMetric, humanizeToken } from '@/utils/format';

const PAGE_SIZE = 25;

/** The two categories the pattern engine derives from call records. */
const COMMUNICATION_PATTERNS = ['COMMUNICATION_ANOMALY', 'MULTI_CHANNEL_RELATIONSHIP'] as const;

/** The relationship type the call table produces in the graph. */
const CALL_EDGE = 'CALLED';

/* ============================================================ route */

export function CommunicationPage(): ReactElement {
  const { personId, setPersonId } = usePersonScope();
  const names = usePersonNames();

  return (
    <div className="space-y-4 pb-8 animate-fade-in" data-testid="communication-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Communication</h1>
      </div>

      <SubjectScope personId={personId} label={names.nameOf(personId)} onChange={setPersonId} />

      {personId === null ? <CorpusCommunication /> : <PersonCommunication personId={personId} />}
    </div>
  );
}

/* ============================================================ corpus-wide */

function CorpusCommunication(): ReactElement {
  const [params, setParams] = useSearchParams();
  const rawPage = params.get('page');
  const page = rawPage !== null && /^\d+$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);

  const calls = useAsync(
    (signal) => api.listCalls({ page, page_size: PAGE_SIZE }, { signal }),
    [page],
  );
  const anomalies = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'COMMUNICATION_ANOMALY', limit: 1 }, { signal }),
    [],
  );
  const multiChannel = useAsync(
    (signal) =>
      api.listPatterns({ pattern_type: 'MULTI_CHANNEL_RELATIONSHIP', limit: 1 }, { signal }),
    [],
  );

  const onPage = (next: number) => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        updated.set('page', String(next));
        return updated;
      },
      { replace: true },
    );
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {calls.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Call records" value={formatCount(calls.data?.meta.total)} accent="cyan" />
        )}
        {anomalies.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Communication anomalies"
            value={formatCount(anomalies.data?.total)}
            accent="warn"
          />
        )}
        {multiChannel.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Multi-channel links"
            value={formatCount(multiChannel.data?.total)}
            accent="azure"
          />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <CallTable
          title="Call records"
          state={calls}
          onPage={onPage}
          emptyTitle="No call records"
        />
        <div className="space-y-4">
          <PatternList
            title="Communication patterns"
            types={COMMUNICATION_PATTERNS}
            limit={10}
            selectedId={selectedPattern}
            onSelect={setSelectedPattern}
          />
          {selectedPattern ? <PatternDetails patternId={selectedPattern} /> : null}
        </div>
      </div>
    </>
  );
}

/* ============================================================ person-scoped */

/**
 * One subject's communication picture. Exported so the investigation workspace's
 * Communication tab renders exactly this, rather than a second implementation of
 * the same screen.
 */
export function PersonCommunication({ personId }: { personId: number }): ReactElement {
  const names = usePersonNames();
  const [refreshKey, setRefreshKey] = useState(0);

  useLive((event) => {
    if (event.event_type === 'new_intelligence') setRefreshKey((key) => key + 1);
  });

  const network = useAsync(
    (signal) => api.getPersonNetwork(personId, { depth: 1, persons_only: true }, { signal }),
    [personId, refreshKey],
  );
  const outgoing = useAsync(
    (signal) => api.listCalls({ caller_id: personId, page_size: PAGE_SIZE }, { signal }),
    [personId, refreshKey],
  );
  const incoming = useAsync(
    (signal) => api.listCalls({ callee_id: personId, page_size: PAGE_SIZE }, { signal }),
    [personId, refreshKey],
  );
  const intelligence = useAsync(
    (signal) => api.getPersonIntelligence(personId, { signal }),
    [personId, refreshKey],
  );

  const anchorId = `person:${personId}`;
  const contacts = useMemo(
    () => rankContacts(network.data?.edges ?? [], anchorId),
    [network.data, anchorId],
  );

  const totalCalls =
    outgoing.data && incoming.data ? outgoing.data.meta.total + incoming.data.meta.total : null;
  const partial =
    (outgoing.data?.meta.has_next ?? false) || (incoming.data?.meta.has_next ?? false);

  /* Duration is only summed over the rows actually fetched; labelled as such. */
  const rows = useMemo(
    () =>
      [...(outgoing.data?.items ?? []), ...(incoming.data?.items ?? [])].sort((a, b) =>
        b.start_time.localeCompare(a.start_time),
      ),
    [outgoing.data, incoming.data],
  );
  const durationShown = rows.reduce((total, call) => total + (call.duration_sec ?? 0), 0);

  const baseline = intelligence.data?.communication_baseline ?? null;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total calls" value={totalCalls === null ? '—' : formatCount(totalCalls)} accent="cyan" />
        <StatTile label="Outgoing" value={formatCount(outgoing.data?.meta.total)} accent="neutral" />
        <StatTile label="Incoming" value={formatCount(incoming.data?.meta.total)} accent="neutral" />
        <StatTile
          label="Unique contacts"
          value={network.data ? formatCount(contacts.length) : '—'}
          accent="azure"
          footnote="Direct call links"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader
              title="Recent calls"
              subtitle={partial ? `Latest ${formatCount(rows.length)} of ${formatCount(totalCalls)}` : undefined}
              accent
              actions={
                rows.length > 0 ? (
                  <span className="text-ink-4 font-mono text-2xs">
                    {formatDuration(durationShown)} shown
                  </span>
                ) : null
              }
            />
            <PanelBody padded={false}>
              {outgoing.isInitialLoading || incoming.isInitialLoading ? (
                <SkeletonRows rows={6} className="p-3" />
              ) : null}
              {outgoing.error ? <ErrorState error={outgoing.error} onRetry={outgoing.retry} compact /> : null}
              {incoming.error ? <ErrorState error={incoming.error} onRetry={incoming.retry} compact /> : null}
              {outgoing.data && incoming.data && rows.length === 0 ? (
                <EmptyState title="No calls on record" description="No data available for this subject." />
              ) : null}
              {rows.length > 0 ? <CallRows rows={rows} names={names} /> : null}
            </PanelBody>
          </Panel>

          <TopContacts contacts={contacts} anchorId={anchorId} loading={network.isInitialLoading} />
        </div>

        <div className="space-y-4">
          <AnomalyPanel
            baseline={baseline}
            loading={intelligence.isInitialLoading}
            error={intelligence.error}
            onRetry={intelligence.retry}
          />
          <PatternList
            title="Communication patterns"
            types={COMMUNICATION_PATTERNS}
            entityId={anchorId}
            limit={10}
            refreshKey={refreshKey}
          />
        </div>
      </div>
    </>
  );
}

/* ============================================================ pieces */

interface Contact {
  entityId: string;
  personId: number | null;
  label: string;
  frequency: number;
  callIds: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Contacts ranked by call frequency, from the CALLED edges of the subject's
 * depth-1 network.
 *
 * Only edges that touch the subject count. A depth-1 network also carries the
 * calls the subject's neighbours made to *each other*, and those are not the
 * subject's contacts — counting them would attribute a call link to someone who
 * never made it. Repeat edges for the same pair are merged, so a contact is a
 * person rather than an edge.
 *
 * `evidence_count` is the backend's own count of the calls behind an edge, and
 * `evidence` holds their source call ids.
 */
function rankContacts(edges: EdgeOut[], anchorId: string): Contact[] {
  const byEntity = new Map<string, Contact>();

  for (const edge of edges) {
    if (edge.relationship_type !== CALL_EDGE || edge.is_overlay) continue;
    if (edge.source_entity_id !== anchorId && edge.target_entity_id !== anchorId) continue;

    const other =
      edge.source_entity_id === anchorId ? edge.target_entity_id : edge.source_entity_id;
    const numeric = other.startsWith('person:') ? Number(other.slice('person:'.length)) : NaN;
    const seen = byEntity.get(other);

    byEntity.set(other, {
      entityId: other,
      personId: Number.isInteger(numeric) ? numeric : null,
      label: other,
      frequency: (seen?.frequency ?? 0) + (edge.evidence_count ?? 0),
      callIds: [...(seen?.callIds ?? []), ...(edge.evidence ?? [])],
      firstSeen: earlierOf(seen?.firstSeen ?? null, edge.date_first ?? null),
      lastSeen: laterOf(seen?.lastSeen ?? null, edge.date_last ?? null),
    });
  }

  return [...byEntity.values()].sort((a, b) => b.frequency - a.frequency);
}

/* ISO-8601 timestamps compare lexicographically; null means "not reported". */
function earlierOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function TopContacts({
  contacts,
  anchorId,
  loading,
}: {
  contacts: Contact[];
  anchorId: string;
  loading: boolean;
}): ReactElement {
  const names = usePersonNames();
  const max = Math.max(...contacts.map((contact) => contact.frequency), 1);

  return (
    <Panel data-testid="top-contacts">
      <PanelHeader title="Contacts by call frequency" accent />
      <PanelBody padded={false}>
        {loading ? <SkeletonRows rows={5} className="p-3" /> : null}
        {!loading && contacts.length === 0 ? (
          <EmptyState title="No call links" description="No data available for this subject." />
        ) : null}
        {contacts.length > 0 ? (
          <ul className="divide-line divide-y">
            {contacts.map((contact) => (
              <li key={contact.entityId} className="px-3 py-2.5" data-testid="contact-row">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <PersonRef personId={contact.personId} names={names} />
                    <div className="bg-panel-3 mt-1.5 h-1 w-full overflow-hidden rounded-full">
                      <div
                        className="bg-cyan-500/60 h-full rounded-full"
                        style={{ width: `${Math.max(3, Math.round((contact.frequency / max) * 100))}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-ink shrink-0 font-mono text-xs tabular-nums">
                    {formatCount(contact.frequency)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {contact.firstSeen || contact.lastSeen ? (
                    <span className="text-ink-4 font-mono text-2xs">
                      {formatDateTime(contact.firstSeen)} → {formatDateTime(contact.lastSeen)}
                    </span>
                  ) : null}
                  {contact.callIds.length > 0 ? (
                    <span className="text-ink-4 text-2xs">
                      calls{' '}
                      {contact.callIds.slice(0, 4).map((id) => (
                        <Mono key={id} className="text-2xs ml-1">
                          {id}
                        </Mono>
                      ))}
                      {contact.callIds.length > 4 ? ` +${contact.callIds.length - 4}` : ''}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </PanelBody>
      <div className="border-line text-ink-4 border-t px-3 py-1.5 font-mono text-2xs">
        anchor <Mono className="text-2xs">{anchorId}</Mono>
      </div>
    </Panel>
  );
}

function AnomalyPanel({
  baseline,
  loading,
  error,
  onRetry,
}: {
  baseline: CommunicationBaselineOut | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}): ReactElement {
  return (
    <Panel data-testid="communication-anomaly">
      <PanelHeader title="Call frequency baseline" accent />
      <PanelBody>
        {loading ? <SkeletonRows rows={4} /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} compact /> : null}
        {!loading && !error && !baseline ? (
          <p className="text-ink-3 text-xs">No baseline available for this subject.</p>
        ) : null}
        {baseline ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="field-label">Status</span>
              <Badge tone={baseline.materially_significant ? 'warn' : 'neutral'}>
                <span data-testid="anomaly-status">{humanizeToken(baseline.anomaly_status)}</span>
              </Badge>
            </div>
            <div className="divide-line divide-y">
              {[
                ['Observed on peak day', formatCount(baseline.observed_count ?? null)],
                ['Peak date', formatDateTime(baseline.peak_date ?? null)],
                ['z-score', formatMetric(baseline.z_score ?? null, 2)],
                ['Excess over baseline', formatMetric(baseline.excess_over_baseline ?? null, 2)],
                ['Mean calls / active day', formatMetric(baseline.baseline?.mean_calls_per_active_day ?? null, 2)],
                ['Observation days', formatCount(baseline.baseline?.observation_days ?? null)],
              ].map(([label, value]) => (
                <div key={label} className="metric-row">
                  <span className="field-label">{label}</span>
                  <span className="text-ink font-mono text-xs tabular-nums">{value}</span>
                </div>
              ))}
            </div>
            {baseline.supporting_call_ids && baseline.supporting_call_ids.length > 0 ? (
              <>
                <Divider label="Source calls" />
                <div className="flex flex-wrap gap-1">
                  {baseline.supporting_call_ids.slice(0, 12).map((id) => (
                    <Mono key={id} className="text-2xs">
                      {id}
                    </Mono>
                  ))}
                  {baseline.supporting_call_ids.length > 12 ? (
                    <span className="text-ink-4 text-2xs">
                      +{baseline.supporting_call_ids.length - 12}
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------ call tables -- */

function CallRows({ rows, names }: { rows: CallRecord[]; names: PersonNames }): ReactElement {
  return (
    <DataTable head={['Call', 'Time', 'Caller', 'Callee', 'Duration', 'Tower']}>
      {rows.map((call) => (
        <tr key={call.call_id} className="hover:bg-panel-2 transition-colors" data-testid="call-row">
          <Cell numeric>{call.call_id}</Cell>
          <Cell>
            <span className="font-mono text-2xs">{formatDateTime(call.start_time)}</span>
          </Cell>
          <Cell>
            <PersonRef personId={call.caller_id} names={names} />
          </Cell>
          <Cell>
            <PersonRef personId={call.callee_id} names={names} />
          </Cell>
          <Cell numeric>{formatDuration(call.duration_sec)}</Cell>
          <Cell numeric>{call.cell_tower_id}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}

function CallTable({
  title,
  state,
  onPage,
  emptyTitle,
}: {
  title: string;
  state: AsyncState<Page<CallRecord>>;
  onPage: (page: number) => void;
  emptyTitle: string;
}): ReactElement {
  const names = usePersonNames();
  return (
    <Panel data-testid="call-table">
      <PanelHeader title={title} accent />
      <PanelBody padded={false}>
        {state.isInitialLoading ? <SkeletonRows rows={8} className="p-3" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.retry} compact /> : null}
        {state.data && state.data.items.length === 0 ? (
          <EmptyState title={emptyTitle} description="No data available." />
        ) : null}
        {state.data && state.data.items.length > 0 ? (
          <CallRows rows={state.data.items} names={names} />
        ) : null}
      </PanelBody>
      <Pager meta={state.data?.meta ?? null} onPage={onPage} isLoading={state.isLoading} unit="calls" />
    </Panel>
  );
}
