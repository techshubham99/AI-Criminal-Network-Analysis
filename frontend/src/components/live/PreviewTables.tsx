/**
 * The preview dashboard's detail tables.
 *
 * Same data as before, read row by row instead of as narrative cards. Nothing
 * here computes anything: every cell is a field the backend already returned for
 * this preview — the Phase 4 detectors' own `detail` dicts, and the centrality
 * and Louvain output of the one overlay pass `bulk.py:_analyse()` already ran.
 * There is no client-side scoring, grouping heuristic or derived metric, so a
 * table can only ever say what the detectors said.
 *
 * The tabs are Phase 4's own pattern types, spelled as the API spells them. The
 * four transaction types share one scoring feature upstream but are two
 * different questions for a reader — a closed circuit is a shape, a fan or a
 * concentration is a volume — so cycles get their own tab. Nothing is renamed
 * and nothing is dropped: `LOCATION_*` and `BRIDGE_ENTITY` keep tabs too, or the
 * preview would silently stop showing patterns it used to show.
 *
 * A tab with no rows says so. That is the honest answer for most uploads: a
 * two-row call file has no reason to produce a transaction cycle, and inventing
 * a placeholder row would be a claim about the data.
 */
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';

import { Badge, EmptyState, Panel, PanelBody, PanelHeader } from '@/components/ui';
import type {
  BulkCommunityOut,
  BulkKeyPlayerOut,
  PatternOut,
} from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount, formatInr, formatMetric } from '@/utils/format';

/**
 * The tab set, defined by the `pattern_type` values the API returns. `types` is
 * matched verbatim against `pattern.pattern_type`; a value that matched nothing
 * here would be unreachable, so `OTHER` catches anything a later phase adds
 * rather than hiding it.
 */
const CATEGORIES = [
  {
    key: 'cycles',
    label: 'Transaction cycles',
    types: ['TRANSACTION_CYCLE'],
    empty: 'No closed transaction circuit runs through the rows in this import.',
  },
  {
    key: 'multi',
    label: 'Multi-channel pairs',
    types: ['MULTI_CHANNEL_RELATIONSHIP'],
    empty: 'No pair in this import is linked through more than one channel.',
  },
  {
    key: 'comms',
    label: 'Communication anomalies',
    types: ['COMMUNICATION_ANOMALY'],
    empty: 'No person in this import exceeds their own call baseline.',
  },
  {
    key: 'txn',
    label: 'Transaction anomalies',
    types: ['TRANSACTION_FAN_IN', 'TRANSACTION_FAN_OUT', 'TRANSACTION_CONCENTRATION'],
    empty: 'No fan-in, fan-out or concentration threshold is crossed by this import.',
  },
  {
    key: 'location',
    label: 'Location patterns',
    types: ['LOCATION_COHORT', 'SHARED_LOCATION_PAIR'],
    empty: 'No shared-location cohort or pair is asserted for this import.',
  },
  {
    key: 'bridge',
    label: 'Bridge entities',
    types: ['BRIDGE_ENTITY'],
    empty: 'No person in this import bridges two communities.',
  },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]['key'] | 'other';

const OTHER_EMPTY = 'No other pattern type was asserted for this import.';

const KNOWN_TYPES = new Set<string>(CATEGORIES.flatMap((category) => category.types));

function categoryOf(pattern: PatternOut): CategoryKey {
  const found = CATEGORIES.find((category) =>
    (category.types as readonly string[]).includes(pattern.pattern_type),
  );
  return found ? found.key : 'other';
}

/* -------------------------------------------------------------- helpers -- */

/** A `detail` value read as a number, or undefined if it is not one. */
function num(detail: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = detail?.[key];
  return typeof value === 'number' ? value : undefined;
}

function str(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

function list(detail: Record<string, unknown> | undefined, key: string): string[] {
  const value = detail?.[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** The record ids the detector cited. This is the evidence, verbatim. */
function evidenceIds(pattern: PatternOut): string[] {
  return pattern.structured_evidence.map((item) => item.source_record_id);
}

/** `person:411` reads as `411` in a table that is already about persons. */
function shortId(entityId: string): string {
  const colon = entityId.indexOf(':');
  return colon === -1 ? entityId : entityId.slice(colon + 1);
}

/* ----------------------------------------------------------- primitives -- */

function Th({ children, align }: { children: ReactNode; align?: 'right' }): ReactElement {
  return (
    <th scope="col" className={cn('px-3 py-2 whitespace-nowrap', align === 'right' && 'text-right')}>
      <span className="field-label">{children}</span>
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: ReactNode;
  align?: 'right';
  mono?: boolean;
}): ReactElement {
  return (
    <td
      className={cn(
        'text-ink-2 px-3 py-2 align-top text-2xs',
        align === 'right' && 'text-right tabular-nums',
        mono && 'font-mono',
      )}
    >
      {children}
    </td>
  );
}

/** The table shell every table below shares, matching the app's other tables. */
function Table({
  caption,
  head,
  minWidth = '44rem',
  children,
}: {
  caption: string;
  head: ReactNode;
  minWidth?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full border-collapse text-left"
        style={{ minWidth }}
      >
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-line border-b">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children, testId }: { children: ReactNode; testId: string }): ReactElement {
  return (
    <tr className="border-line/60 border-b last:border-0" data-testid={testId}>
      {children}
    </tr>
  );
}

/**
 * A long list of ids or names, cut to `max` with the remainder counted. The
 * count is the real remainder, so "+66 more" means sixty-six more.
 */
function Truncated({ items, max = 4 }: { items: string[]; max?: number }): ReactElement {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <span className="break-words">
      {shown.join(', ')}
      {rest > 0 ? <span className="text-ink-4"> +{formatCount(rest)} more</span> : null}
    </span>
  );
}

/* --------------------------------------------------------- pattern tabs -- */

function CycleRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Transaction cycles this import would assert, with their path, length, value and the transaction records behind them."
      head={
        <>
          <Th>Cycle path</Th>
          <Th align="right">Length</Th>
          <Th align="right">Total amount</Th>
          <Th>Transaction records</Th>
        </>
      }
      minWidth="52rem"
    >
      {patterns.map((pattern) => {
        const ids = evidenceIds(pattern);
        return (
          <Row key={pattern.pattern_id} testId="preview-pattern-row">
            <Td mono>{str(pattern.detail, 'cycle_path') ?? pattern.entity_ids.join(' -> ')}</Td>
            <Td align="right">{formatCount(num(pattern.detail, 'cycle_length'))}</Td>
            <Td align="right">{formatInr(num(pattern.detail, 'total_amount_inr'))}</Td>
            <Td mono>
              <Truncated items={ids} max={3} />
            </Td>
          </Row>
        );
      })}
    </Table>
  );
}

function MultiChannelRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Pairs linked through more than one independent channel, with the channels and the records behind them."
      head={
        <>
          <Th>Person A</Th>
          <Th>Person B</Th>
          <Th>Relationship types</Th>
          <Th align="right">Channels</Th>
          <Th>Source records</Th>
        </>
      }
    >
      {patterns.map((pattern) => (
        <Row key={pattern.pattern_id} testId="preview-pattern-row">
          <Td mono>{pattern.entity_ids[0] ?? ''}</Td>
          <Td mono>{pattern.entity_ids[1] ?? ''}</Td>
          <Td>{pattern.relationship_types.join(', ')}</Td>
          <Td align="right">{formatCount(num(pattern.detail, 'channel_count'))}</Td>
          <Td mono>
            <Truncated items={evidenceIds(pattern)} max={3} />
          </Td>
        </Row>
      ))}
    </Table>
  );
}

function CommunicationRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Persons whose call count on one day exceeded their own baseline, with the z-score and absolute excess the detector measured."
      head={
        <>
          <Th>Person</Th>
          <Th>Peak date</Th>
          <Th align="right">Calls</Th>
          <Th align="right">z-score</Th>
          <Th align="right">Excess</Th>
          <Th>Material</Th>
        </>
      }
    >
      {patterns.map((pattern) => {
        const material = pattern.detail?.materially_significant === true;
        return (
          <Row key={pattern.pattern_id} testId="preview-pattern-row">
            <Td mono>{pattern.entity_ids[0] ?? `person:${num(pattern.detail, 'person_id')}`}</Td>
            <Td>{str(pattern.detail, 'peak_date') ?? '—'}</Td>
            <Td align="right">{formatCount(num(pattern.detail, 'observed_count'))}</Td>
            <Td align="right">{formatMetric(num(pattern.detail, 'z_score'), 2)}</Td>
            <Td align="right">{formatMetric(num(pattern.detail, 'excess_over_baseline'), 1)}</Td>
            <Td>
              <Badge tone={material ? 'warn' : 'muted'}>{material ? 'Material' : 'Small'}</Badge>
            </Td>
          </Row>
        );
      })}
    </Table>
  );
}

/**
 * Fan-in, fan-out and concentration. Phase 4 reports all three per PERSON, not
 * per transaction: the detectors count a hub's counterparties and sum their
 * value, and none of them attaches a z-score to a single transfer. The columns
 * are therefore the ones that exist — a `txn_id` column here would have nothing
 * to put in it.
 */
function TransactionAnomalyRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Fan-in, fan-out and concentration patterns, reported per person with the counterparties, value and threshold the detector used."
      head={
        <>
          <Th>Type</Th>
          <Th>Person</Th>
          <Th>Counterparties</Th>
          <Th align="right">Transactions</Th>
          <Th align="right">Total amount</Th>
          <Th align="right">Threshold / share</Th>
        </>
      }
      minWidth="56rem"
    >
      {patterns.map((pattern) => {
        const share = num(pattern.detail, 'share');
        const counterparty = str(pattern.detail, 'counterparty');
        const counterparties = counterparty
          ? [counterparty]
          : list(pattern.detail, 'counterparties');
        return (
          <Row key={pattern.pattern_id} testId="preview-pattern-row">
            <Td>
              <Badge tone="azure">{pattern.pattern_type}</Badge>
            </Td>
            <Td mono>
              {str(pattern.detail, 'hub') ?? str(pattern.detail, 'person') ?? pattern.entity_ids[0]}
            </Td>
            <Td mono>
              <Truncated items={counterparties} max={4} />
            </Td>
            <Td align="right">{formatCount(num(pattern.detail, 'transaction_count'))}</Td>
            <Td align="right">{formatInr(num(pattern.detail, 'total_amount_inr'))}</Td>
            <Td align="right">
              {share === undefined
                ? formatCount(num(pattern.detail, 'threshold'))
                : `${formatMetric(share * 100, 1)}%`}
            </Td>
          </Row>
        );
      })}
    </Table>
  );
}

function LocationRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Shared-location cohorts and pairs, with the location and the persons the detector grouped there."
      head={
        <>
          <Th>Type</Th>
          <Th>Location</Th>
          <Th>Persons</Th>
          <Th align="right">Size</Th>
          <Th>Source records</Th>
        </>
      }
    >
      {patterns.map((pattern) => (
        <Row key={pattern.pattern_id} testId="preview-pattern-row">
          <Td>
            <Badge tone="azure">{pattern.pattern_type}</Badge>
          </Td>
          <Td>
            {str(pattern.detail, 'location_label') ?? str(pattern.detail, 'location_entity_id') ?? '—'}
          </Td>
          <Td mono>
            <Truncated
              items={
                list(pattern.detail, 'members').length > 0
                  ? list(pattern.detail, 'members')
                  : pattern.entity_ids
              }
            />
          </Td>
          <Td align="right">
            {formatCount(
              num(pattern.detail, 'member_count') ?? num(pattern.detail, 'cohort_size'),
            )}
          </Td>
          <Td mono>
            <Truncated items={evidenceIds(pattern)} max={3} />
          </Td>
        </Row>
      ))}
    </Table>
  );
}

function BridgeRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Persons whose removal would disconnect communities, with the betweenness and neighbouring communities the detector measured."
      head={
        <>
          <Th>Person</Th>
          <Th align="right">Betweenness</Th>
          <Th align="right">Percentile</Th>
          <Th align="right">Community</Th>
          <Th>Neighbouring communities</Th>
          <Th align="right">Crossing links</Th>
        </>
      }
      minWidth="52rem"
    >
      {patterns.map((pattern) => (
        <Row key={pattern.pattern_id} testId="preview-pattern-row">
          <Td mono>{pattern.entity_ids[0] ?? ''}</Td>
          <Td align="right">{formatMetric(num(pattern.detail, 'betweenness'), 6)}</Td>
          <Td align="right">{formatMetric(num(pattern.detail, 'betweenness_percentile'), 1)}</Td>
          <Td align="right">{formatCount(num(pattern.detail, 'community_id'))}</Td>
          <Td mono>
            <Truncated items={list(pattern.detail, 'neighbour_communities')} />
          </Td>
          <Td align="right">
            {formatCount(num(pattern.detail, 'crossing_relationship_count'))}
          </Td>
        </Row>
      ))}
    </Table>
  );
}

/** Anything a later phase adds: shown as the detector explained it, not hidden. */
function OtherRows({ patterns }: { patterns: PatternOut[] }): ReactElement {
  return (
    <Table
      caption="Patterns of a type this table set does not have columns for, with the detector's own explanation."
      head={
        <>
          <Th>Type</Th>
          <Th>Entities</Th>
          <Th>Explanation</Th>
        </>
      }
    >
      {patterns.map((pattern) => (
        <Row key={pattern.pattern_id} testId="preview-pattern-row">
          <Td>
            <Badge tone="azure">{pattern.pattern_type}</Badge>
          </Td>
          <Td mono>
            <Truncated items={pattern.entity_ids} />
          </Td>
          <Td>{pattern.explanation}</Td>
        </Row>
      ))}
    </Table>
  );
}

const RENDERERS: Record<CategoryKey, (props: { patterns: PatternOut[] }) => ReactElement> = {
  cycles: CycleRows,
  multi: MultiChannelRows,
  comms: CommunicationRows,
  txn: TransactionAnomalyRows,
  location: LocationRows,
  bridge: BridgeRows,
  other: OtherRows,
};

/**
 * The pattern tables, one tab per Phase 4 category. The tab bar reuses the
 * `.tab-bar` / `.tab-item` styling the import modal's own mode switch uses.
 */
export function PreviewPatterns({
  title,
  patterns,
  note,
}: {
  title: string;
  patterns: PatternOut[];
  note: string;
}): ReactElement {
  const grouped = useMemo(() => {
    const map = new Map<CategoryKey, PatternOut[]>();
    for (const pattern of patterns) {
      const key = categoryOf(pattern);
      const bucket = map.get(key);
      if (bucket) bucket.push(pattern);
      else map.set(key, [pattern]);
    }
    return map;
  }, [patterns]);

  const hasOther = (grouped.get('other')?.length ?? 0) > 0;
  const tabs: { key: CategoryKey; label: string; empty: string }[] = [
    ...CATEGORIES.map((category) => ({
      key: category.key as CategoryKey,
      label: category.label,
      empty: category.empty,
    })),
    ...(hasOther ? [{ key: 'other' as CategoryKey, label: 'Other', empty: OTHER_EMPTY }] : []),
  ];

  /* Open on the first tab that actually has rows, so the reader is not greeted
     by an empty table when there is something to read. */
  const firstFilled = tabs.find((tab) => (grouped.get(tab.key)?.length ?? 0) > 0);
  const [active, setActive] = useState<CategoryKey | null>(null);
  const current = active ?? firstFilled?.key ?? tabs[0].key;
  const rows = grouped.get(current) ?? [];
  const Renderer = RENDERERS[current];
  const emptyText = tabs.find((tab) => tab.key === current)?.empty ?? OTHER_EMPTY;

  return (
    <Panel className="min-w-0" data-testid="preview-patterns">
      <PanelHeader
        title={title}
        subtitle={`${formatCount(patterns.length)} in total · deterministic rule output`}
        accent
      />
      <PanelBody className="space-y-3">
        <div className="tab-bar" role="tablist" aria-label="Pattern category">
          {tabs.map((tab) => {
            const count = grouped.get(tab.key)?.length ?? 0;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={tab.key === current}
                onClick={() => setActive(tab.key)}
                className="tab-item"
                data-testid={`preview-tab-${tab.key}`}
                data-count={count}
              >
                {tab.label} ({formatCount(count)})
              </button>
            );
          })}
        </div>

        <div data-testid={`preview-panel-${current}`}>
          {rows.length === 0 ? (
            <EmptyState title="None in this preview" description={emptyText} />
          ) : (
            <Renderer patterns={rows} />
          )}
        </div>

        <p className="text-ink-4 text-2xs leading-snug">{note}</p>
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------ key players -- */

/**
 * The overlay's most central persons. Every column is a value
 * `GraphAnalytics.person_metrics` returned for that person on the overlay this
 * preview built — the same function the graph pages read. A person this import
 * touched is marked, because the ranking is over the whole graph and the reader
 * needs to see where the uploaded rows land in it.
 */
export function KeyPlayers({ players }: { players: BulkKeyPlayerOut[] }): ReactElement {
  return (
    <Panel className="min-w-0" data-testid="preview-key-players">
      <PanelHeader
        title="Key players"
        subtitle="Most central persons of the previewed graph"
        accent
      />
      <PanelBody>
        {players.length === 0 ? (
          <EmptyState
            title="No centrality to report"
            description="Centrality is only recomputed when an import has at least one new row, so there is nothing to rank for this preview."
          />
        ) : (
          <Table
            caption="The most central persons of the previewed graph, with degree centrality, betweenness, PageRank and detected community."
            head={
              <>
                <Th>Person</Th>
                <Th>Name</Th>
                <Th align="right">Degree centrality</Th>
                <Th align="right">Betweenness</Th>
                <Th align="right">PageRank</Th>
                <Th align="right">Community</Th>
              </>
            }
            minWidth="46rem"
          >
            {players.map((player) => (
              <Row key={player.entity_id} testId="preview-key-player-row">
                <Td mono>
                  <span className="flex items-center gap-1.5">
                    {shortId(player.entity_id)}
                    {player.in_import ? <Badge tone="cyan">In this import</Badge> : null}
                  </span>
                </Td>
                <Td>{player.name ?? '—'}</Td>
                <Td align="right">{formatMetric(player.degree_centrality, 6)}</Td>
                <Td align="right">{formatMetric(player.betweenness, 6)}</Td>
                <Td align="right">{formatMetric(player.pagerank, 6)}</Td>
                <Td align="right">
                  {player.community_id === null || player.community_id === undefined
                    ? '—'
                    : formatCount(player.community_id)}
                </Td>
              </Row>
            ))}
          </Table>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ---------------------------------------------------------- communities -- */

/**
 * The Louvain communities of the same overlay. `members_sample` is the backend's
 * own cut at ten, so the "+N more" is the real remainder of a community's size
 * and not a rendering guess.
 */
export function DetectedCommunities({
  communities,
  modularity,
}: {
  communities: BulkCommunityOut[];
  modularity?: number;
}): ReactElement {
  return (
    <Panel className="min-w-0" data-testid="preview-communities">
      <PanelHeader
        title="Detected communities"
        subtitle={
          modularity === undefined
            ? 'Louvain, on the previewed graph'
            : `Louvain, modularity ${formatMetric(modularity, 3)}`
        }
        accent
      />
      <PanelBody>
        {communities.length === 0 ? (
          <EmptyState
            title="No communities to report"
            description="Communities are only recomputed when an import has at least one new row, so there is nothing to list for this preview."
          />
        ) : (
          <Table
            caption="Communities detected in the previewed graph, with their size and a sample of their members."
            head={
              <>
                <Th align="right">Community</Th>
                <Th align="right">Size</Th>
                <Th>Members</Th>
              </>
            }
            minWidth="40rem"
          >
            {communities.map((community) => {
              const names = (community.member_names ?? []).map(
                (name, index) => name ?? shortId(community.members_sample[index] ?? ''),
              );
              const shown = names.length > 0 ? names : community.members_sample.map(shortId);
              const rest = community.size - shown.length;
              return (
                <Row key={community.community_id} testId="preview-community-row">
                  <Td align="right">{formatCount(community.community_id)}</Td>
                  <Td align="right">{formatCount(community.size)}</Td>
                  <Td>
                    <span className="break-words">
                      {shown.join(', ')}
                      {rest > 0 ? (
                        <span className="text-ink-4"> +{formatCount(rest)} more</span>
                      ) : null}
                    </span>
                  </Td>
                </Row>
              );
            })}
          </Table>
        )}
      </PanelBody>
    </Panel>
  );
}

export { KNOWN_TYPES as PREVIEW_PATTERN_TYPES };
