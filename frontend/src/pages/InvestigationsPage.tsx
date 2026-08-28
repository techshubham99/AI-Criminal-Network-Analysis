/**
 * Investigations — where an operator picks a subject to work on.
 *
 * Two ways in, on one screen: search a person by name, or take the next lead off
 * the backend's priority ranking. Both open the same full investigation workspace.
 *
 * The ranking, the scores, the bands and the caveat text are all the backend's.
 * Nothing here re-scores, re-orders or re-words them.
 */
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/api';
import { BAND_TONE, ScoreReadout, featureLabel } from '@/components/intelligence';
import { Cell, DataTable, Pager, PersonRef } from '@/components/records';
import {
  Badge,
  EmptyState,
  ErrorState,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLive } from '@/hooks/useLive';
import { usePersonNames } from '@/hooks/usePersonNames';
import { SCORE_BANDS, type ScoreBand } from '@/types/api';
import { formatCount, truncate } from '@/utils/format';

const QUEUE_LIMIT = 20;
const SEARCH_PAGE_SIZE = 20;
const MIN_QUERY_LENGTH = 2;

type BandFilter = '' | ScoreBand;

export function InvestigationsPage(): ReactElement {
  const [band, setBand] = useState<BandFilter>('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const debounced = useDebouncedValue(query.trim(), 250);
  const names = usePersonNames();

  useLive((event) => {
    if (event.event_type === 'new_intelligence') setRefreshKey((key) => key + 1);
  });

  const queue = useAsync(
    (signal) =>
      api.getPriorityRanking({ limit: QUEUE_LIMIT, band: band || undefined }, { signal }),
    [band, refreshKey],
  );

  const searching = debounced.length >= MIN_QUERY_LENGTH;
  const results = useAsync(
    (signal) =>
      api.listPersons({ q: debounced, page, page_size: SEARCH_PAGE_SIZE }, { signal }),
    [debounced, page],
    { enabled: searching },
  );

  return (
    <div className="space-y-4 pb-8 animate-fade-in" data-testid="investigations-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Investigations</h1>
        {queue.data ? (
          <Badge tone="neutral">{formatCount(queue.data.count)} leads</Badge>
        ) : null}
      </div>

      {/* Person search */}
      <Panel data-testid="person-search">
        <PanelHeader
          title="Find a subject"
          accent
          actions={
            searching && results.data ? (
              <span className="text-ink-4 font-mono text-2xs">
                {formatCount(results.data.meta.total)} matches
              </span>
            ) : null
          }
        />
        <PanelBody padded={false}>
          <div className="border-line border-b px-3 py-2">
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Search by name"
              aria-label="Search persons by name"
              data-testid="person-query"
              className="text-ink placeholder:text-ink-4 w-full bg-transparent text-xs outline-none"
            />
          </div>
          {!searching ? (
            <p className="text-ink-4 px-3 py-2.5 text-xs">
              Type at least {MIN_QUERY_LENGTH} characters.
            </p>
          ) : null}
          {searching && results.isInitialLoading ? <SkeletonRows rows={5} className="p-3" /> : null}
          {results.error ? <ErrorState error={results.error} onRetry={results.retry} compact /> : null}
          {searching && results.data && results.data.items.length === 0 ? (
            <EmptyState title="No matching person" description="No data available." />
          ) : null}
          {searching && results.data && results.data.items.length > 0 ? (
            <DataTable head={['Person', 'City', 'State', '']}>
              {results.data.items.map((person) => (
                <tr
                  key={person.person_id}
                  className="hover:bg-panel-2 transition-colors"
                  data-testid="person-result"
                  data-person-id={person.person_id}
                >
                  <Cell>
                    <PersonRef personId={person.person_id} names={names} label={person.name} />
                  </Cell>
                  <Cell>{person.city}</Cell>
                  <Cell>{person.state}</Cell>
                  <Cell>
                    <Link
                      to={`/network/${person.person_id}`}
                      className="border-cyan-600/55 bg-cyan-500/14 text-cyan-200 hover:bg-cyan-500/22 inline-flex h-6 items-center rounded-sm border px-2 text-2xs font-semibold transition-colors"
                    >
                      Investigate
                    </Link>
                  </Cell>
                </tr>
              ))}
            </DataTable>
          ) : null}
          {searching ? (
            <Pager
              meta={results.data?.meta ?? null}
              onPage={setPage}
              isLoading={results.isLoading}
              unit="persons"
            />
          ) : null}
        </PanelBody>
      </Panel>

      {/* Priority queue */}
      <Panel data-testid="lead-queue">
        <PanelHeader
          title="Priority leads"
          subtitle={queue.data?.note}
          accent
          actions={
            <SegmentedControl
              label="Filter leads by band"
              value={band}
              onChange={(next) => setBand(next as BandFilter)}
              options={[
                { value: '', label: 'All' },
                ...SCORE_BANDS.map((value) => ({ value, label: value })),
              ]}
            />
          }
        />
        <PanelBody padded={false}>
          {queue.isInitialLoading ? <SkeletonRows rows={8} className="p-3" /> : null}
          {queue.error ? <ErrorState error={queue.error} onRetry={queue.retry} /> : null}
          {queue.data && queue.data.persons.length === 0 ? (
            <EmptyState
              title="No leads in this band"
              description="The ranking returned no persons for this filter."
            />
          ) : null}
          {queue.data && queue.data.persons.length > 0 ? (
            <ul className="divide-line divide-y">
              {queue.data.persons.map((person, index) => (
                <li key={person.entity_id} data-testid="lead-row" data-person-id={person.person_id}>
                  <Link
                    to={`/network/${person.person_id}`}
                    className="hover:bg-panel-2 flex items-start gap-3 px-3.5 py-3 transition-colors"
                  >
                    <span className="text-ink-4 w-4 shrink-0 pt-0.5 font-mono text-2xs tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink truncate text-xs font-semibold">
                          {person.name ?? person.entity_id}
                        </span>
                        <Mono className="text-2xs">{person.person_id}</Mono>
                        <Badge tone={BAND_TONE[person.band]}>{person.band}</Badge>
                        {person.city ? (
                          <span className="text-ink-4 text-2xs">{person.city}</span>
                        ) : null}
                      </div>
                      {person.top_factors.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {person.top_factors.map((factor) => (
                            <span
                              key={factor.feature}
                              className="border-line bg-panel-2 text-ink-3 rounded-sm border px-1.5 py-0.5 text-2xs"
                            >
                              {featureLabel(factor.feature)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <p className="text-ink-4 mt-1.5 text-2xs">
                        {formatCount(person.pattern_count)} patterns ·{' '}
                        {formatCount(person.structured_evidence_count)} structured ·{' '}
                        {formatCount(person.nlp_evidence_count)} narrative
                      </p>
                    </div>
                    <div className="w-28 shrink-0">
                      <ScoreReadout score={person.score} band={person.band} size="sm" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </PanelBody>
        {queue.data?.disclaimer ? (
          <p className="border-line text-ink-4 border-t px-3.5 py-2 text-2xs">
            {truncate(queue.data.disclaimer, 220)}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
