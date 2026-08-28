/**
 * Alerts — the investigation-priority queue and the patterns behind it.
 *
 * Two things on this screen, both read straight from Phase 4 endpoints:
 *
 *  1. THE QUEUE. `GET /intelligence/persons/top` ranks persons by the explainable
 *     0-100 priority score. It is not the Phase 2 centrality ranking on the
 *     Command Center; the two order different things and are never mixed. The
 *     band filter is a backend parameter, not a client-side slice, so a band with
 *     no members comes back empty and is reported as empty.
 *
 *  2. THE PATTERNS. `GET /intelligence/patterns` with its own type filter, and one
 *     pattern in full beside it. Selecting a person does not filter the pattern
 *     list: the queue answers "who should be looked at first" and the pattern list
 *     answers "what was detected across the corpus", and scoping one to the other
 *     would quietly turn the second question into the first.
 *
 *  3. ADD INTELLIGENCE (Phase 4.6). The one write surface in the app: submit a new
 *     FIR, call, transaction or location observation and read the pipeline's
 *     verdict. An accepted record publishes a live event, and this screen refetches
 *     the queue, the priority detail and the pattern list when it arrives — which is
 *     why the ranking can change without a page reload.
 *
 * A score is never shown without its factors, and the backend's own note and
 * disclaimer are displayed verbatim rather than paraphrased.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api } from '@/api';
import { PatternDetails, PatternList, PriorityPanel } from '@/components/intelligence';
import { AddIntelligence } from '@/components/live';
import { BAND_BAR_CLASS, BAND_TEXT_CLASS, BAND_TONE, featureLabel } from '@/components/intelligence';
import {
  Badge,
  EmptyState,
  ErrorState,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  SectionHeading,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useLive } from '@/hooks/useLive';
import { useInvestigation } from '@/hooks/useInvestigation';
import { SCORE_BANDS, type LiveEvent, type RankedPersonOut, type ScoreBand } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';

const QUEUE_LIMIT = 25;

/** `''` is "every band" — the query parameter is simply omitted. */
type BandFilter = '' | ScoreBand;

const BAND_OPTIONS: ReadonlyArray<{ value: BandFilter; label: string }> = [
  { value: '', label: 'All' },
  ...SCORE_BANDS.map((band) => ({ value: band as BandFilter, label: band })),
];

export function AlertsPage(): ReactElement {
  const [band, setBand] = useState<BandFilter>('');
  const [personId, setPersonId] = useState<number | null>(null);
  const [patternId, setPatternId] = useState<string | null>(null);
  const { setSubject } = useInvestigation();

  /* Bumped on every live event that can move a score or a pattern. Threaded into
     the panels' request deps, so they refetch in place rather than remounting. */
  const [refreshKey, setRefreshKey] = useState(0);

  const ranking = useAsync(
    (signal) =>
      api.getPriorityRanking({ limit: QUEUE_LIMIT, band: band || undefined }, { signal }),
    [band, refreshKey],
  );
  /* One refresh per accepted record, not one per frame. An accepted submission
     publishes several events and `new_intelligence` is the last of them, so
     keying off it refetches once, after the recomputation has landed. */
  const onLiveEvent = useCallback((event: LiveEvent) => {
    if (event.event_type !== 'new_intelligence') return;
    setRefreshKey((n) => n + 1);
  }, []);

  // The indicator itself is in the top bar; this screen only needs the events.
  useLive(onLiveEvent);

  /* Undefined until the first response, and a stable reference afterwards, so the
     selection effect below runs on a change of answer rather than on every render. */
  const persons = ranking.data?.persons;

  /* Open on the top of the queue rather than on an empty panel, and drop a
     selection the current filter no longer contains. */
  useEffect(() => {
    if (!persons || persons.length === 0) {
      setPersonId(null);
      return;
    }
    setPersonId((current) =>
      current !== null && persons.some((person) => person.person_id === current)
        ? current
        : persons[0].person_id,
    );
  }, [persons]);

  // The top bar names whatever the operator is working on; leaving it set after
  // navigating away would misreport the active subject.
  useEffect(() => () => setSubject(null), [setSubject]);

  const rows = persons ?? [];

  const select = (person: RankedPersonOut) => {
    setPersonId(person.person_id);
    setSubject({
      entityId: person.entity_id,
      label: person.name ?? person.entity_id,
      kind: 'person',
    });
  };

  return (
    <div className="space-y-4 pb-10" data-testid="alerts-page">
      <SectionHeading
        title="Alerts"
        subtitle="Persons ranked by investigation priority, and the patterns behind the ranking."
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Panel className="flex min-w-0 flex-col" data-testid="priority-queue">
          <PanelHeader
            title="Priority queue"
            subtitle={ranking.data ? `${formatCount(ranking.data.count)} shown` : undefined}
            accent
            actions={
              <SegmentedControl
                label="Filter queue by band"
                options={BAND_OPTIONS}
                value={band}
                onChange={setBand}
              />
            }
          />
          <PanelBody className="min-h-0 flex-1 overflow-y-auto">
            {ranking.isInitialLoading ? <SkeletonRows rows={6} /> : null}

            {ranking.error ? <ErrorState error={ranking.error} onRetry={ranking.retry} /> : null}

            {ranking.data && rows.length === 0 ? (
              <EmptyState
                title="No persons in this band"
                description={
                  band
                    ? `No scored person falls in the ${band} band.`
                    : 'The backend returned no scored persons.'
                }
              />
            ) : null}

            {rows.length > 0 ? (
              <ol className="space-y-1.5">
                {rows.map((person, index) => (
                  <li key={person.person_id}>
                    <QueueRow
                      rank={index + 1}
                      person={person}
                      active={person.person_id === personId}
                      onSelect={() => select(person)}
                    />
                  </li>
                ))}
              </ol>
            ) : null}

            {ranking.data ? (
              <p className="text-ink-4 mt-3 text-2xs leading-snug">{ranking.data.note}</p>
            ) : null}
          </PanelBody>
        </Panel>

        <PriorityPanel personId={personId} refreshKey={refreshKey} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <PatternList
          selectedId={patternId}
          onSelect={setPatternId}
          limit={12}
          refreshKey={refreshKey}
        />
        <PatternDetails patternId={patternId} />
      </div>

      <AddIntelligence />

      {ranking.data ? (
        <p className="text-ink-4 text-2xs leading-relaxed">{ranking.data.disclaimer}</p>
      ) : null}
    </div>
  );
}

/** One row of the queue: rank, subject, score, band and what drove it. */
function QueueRow({
  rank,
  person,
  active,
  onSelect,
}: {
  rank: number;
  person: RankedPersonOut;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const place = [person.city, person.state].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      data-testid="queue-row"
      data-person-id={person.person_id}
      className={cn(
        'w-full rounded-sm border px-2.5 py-2 text-left transition-colors',
        active
          ? 'border-cyan-600/60 bg-cyan-500/10'
          : 'border-line bg-inset hover:border-line-accent hover:bg-panel-2',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-ink-4 shrink-0 font-mono text-2xs tabular-nums">{rank}</span>
          <span className="text-ink truncate text-xs font-semibold">
            {person.name ?? person.entity_id}
          </span>
        </span>
        <Badge tone={BAND_TONE[person.band]}>{person.band}</Badge>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <span className={cn('shrink-0 font-mono text-sm tabular-nums', BAND_TEXT_CLASS[person.band])}>
          {person.score}
        </span>
        <span className="text-ink-4 shrink-0 font-mono text-2xs">/100</span>
        {/* Same 0-100 scale as the detail panel, so rows compare by eye. */}
        <span className="bg-panel-3 h-1 min-w-0 flex-1 overflow-hidden rounded-full">
          <span
            className={cn('block h-full rounded-full', BAND_BAR_CLASS[person.band])}
            style={{ width: `${Math.max(0, Math.min(100, person.score))}%` }}
          />
        </span>
      </div>

      <p className="text-ink-4 mt-1 flex flex-wrap gap-x-3 text-2xs">
        {place ? <span className="truncate">{place}</span> : null}
        <Mono>{person.entity_id}</Mono>
        <span>{formatCount(person.pattern_count)} patterns</span>
      </p>

      {person.top_factors.length > 0 ? (
        <p className="text-ink-3 mt-1 truncate text-2xs">
          {person.top_factors.map((factor) => featureLabel(factor.feature)).join(' · ')}
        </p>
      ) : null}
    </button>
  );
}
