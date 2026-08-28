/**
 * CommandCenter — intelligence overview dashboard.
 *
 * Shows live corpus statistics, the backend-selected demo subject,
 * the investigation priority ranking, and recent intelligence.
 * All values come from backend responses. Nothing is hardcoded.
 */
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/api';
import {
  Badge,
  Divider,
  EmptyState,
  EntityBadge,
  ErrorState,
  InfoHint,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  RelationshipBadge,
  SkeletonRows,
  SkeletonText,
  SkeletonTile,
  StatTile,
} from '@/components/ui';
import { patternTypeLabel } from '@/components/intelligence';
import type { AsyncState } from '@/hooks/useAsync';
import { useAsync } from '@/hooks/useAsync';
import { usePersonNames } from '@/hooks/usePersonNames';
import type {
  DataSummaryResponse,
  DemoInvestigationResponse,
  GraphSummaryResponse,
  NlpSummaryResponse,
  TopPersonsResponse,
} from '@/types/api';
import { personIdFromEntityId } from '@/utils/entity';
import { formatCount, formatMetric, humanizeToken } from '@/utils/format';

const LEADS_METRIC = 'pagerank';
const LEADS_LIMIT = 8;

const PRIMARY_LINK_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-sm border border-cyan-600/55 bg-cyan-500/14 px-3 text-xs font-semibold whitespace-nowrap text-cyan-200 transition-colors hover:border-cyan-500/70 hover:bg-cyan-500/22';

/* ========================================================== helpers */

function RequestBody<T>({
  state,
  skeleton,
  children,
}: {
  state: AsyncState<T>;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}): ReactElement {
  if (!state.data) {
    if (state.error) return <ErrorState error={state.error} onRetry={state.retry} compact />;
    return <>{skeleton}</>;
  }
  return (
    <>
      {state.error ? <ErrorState error={state.error} onRetry={state.retry} compact className="mb-3" /> : null}
      {children(state.data)}
    </>
  );
}

/* ========================================================== page */

export function CommandCenter(): ReactElement {
  const summary = useAsync((signal) => api.getDataSummary({ signal }), []);
  const graph = useAsync((signal) => api.getGraphSummary({ signal }), []);
  const nlp = useAsync((signal) => api.getNlpSummary({ signal }), []);
  const demo = useAsync((signal) => api.getDemoInvestigation({ signal }), []);
  const leads = useAsync((signal) => api.getTopPersons(LEADS_METRIC, LEADS_LIMIT, { signal }), []);
  const patterns = useAsync((signal) => api.listPatterns({ limit: 5 }, { signal }), []);

  return (
    <div className="space-y-5 pb-8 animate-fade-in" data-testid="command-center">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Command Center</h1>
      </div>

      {/* Stat grid */}
      <ScaleStrip summary={summary} graph={graph} nlp={nlp} />

      {[
        ['/data/summary', summary],
        ['/graph/summary', graph],
        ['/nlp/summary', nlp],
        ['/analytics/demo', demo],
        ['/analytics/persons/top', leads],
      ].map(([endpoint, state]) =>
        (state as AsyncState<unknown>).error && !(state as AsyncState<unknown>).data ? (
          <ErrorState
            key={endpoint as string}
            error={(state as AsyncState<unknown>).error}
            onRetry={(state as AsyncState<unknown>).retry}
            title={`${endpoint} did not answer`}
            compact
          />
        ) : null,
      )}

      {/* Demo entry + leads */}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <DemoEntryPoint state={demo} />
        <StructuralLeadsPanel state={leads} />
      </div>

      {/* Intelligence panels */}
      <div className="grid gap-4 xl:grid-cols-2">
        <RecentPatternsPanel state={patterns} />
        <GraphEnginePanel state={graph} />
      </div>
    </div>
  );
}

/* ========================================================== stat strip */

function ScaleStrip({
  summary,
  graph,
  nlp,
}: {
  summary: AsyncState<DataSummaryResponse>;
  graph: AsyncState<GraphSummaryResponse>;
  nlp: AsyncState<NlpSummaryResponse>;
}): ReactElement {
  const counts = summary.data?.counts;
  const g = graph.data?.graph;

  return (
    <section aria-label="Corpus scale" className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {summary.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="Persons on record" value={formatCount(counts?.persons)} accent="neutral" />
        )}
        {graph.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="Graph entities" value={formatCount(g?.node_count)} accent="cyan" />
        )}
        {graph.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="Observed relationships" value={formatCount(g?.observed_edge_count)} accent="cyan" />
        )}
        {summary.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="FIRs" value={formatCount(counts?.firs)} accent="azure" />
        )}
        {summary.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="Locations" value={formatCount(counts?.locations)} accent="neutral" />
        )}
        {nlp.isInitialLoading ? <SkeletonTile /> : (
          <StatTile label="Narrative entities" value={formatCount(nlp.data?.entity_count)} accent="azure" />
        )}
      </div>
    </section>
  );
}

/* ========================================================== demo entry point */

function DemoEntryPoint({ state }: { state: AsyncState<DemoInvestigationResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="Investigation Lead"
        accent
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonText lines={4} />}>
          {(demo) => {
            if (!demo.available) {
              return <EmptyState title="No lead available" description="No data available." />;
            }

            const numericId = demo.person_id ? personIdFromEntityId(demo.person_id) : null;
            const metrics = demo.notable_metrics;
            const interpretation = metrics?.interpretation;

            return (
              <div className="space-y-4 animate-slide-up">
                {/* Identity + actions */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <EntityBadge entityType="PERSON" />
                      <h2 className="text-ink truncate text-base font-bold">{demo.label ?? 'Unlabelled subject'}</h2>
                      {demo.person_id ? <Mono>{demo.person_id}</Mono> : null}
                      {demo.selection_method ? (
                        <InfoHint content={`Selected by ${humanizeToken(demo.selection_method)}`} />
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {numericId !== null ? (
                      <Link to={`/network/${numericId}`} className={PRIMARY_LINK_CLASS}>
                        Investigate →
                      </Link>
                    ) : (
                      <Badge tone="warn">No routable ID</Badge>
                    )}
                  </div>
                </div>

                {/* Key metrics */}
                {metrics ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {[
                      { label: 'Degree', value: formatCount(metrics.degree) },
                      { label: 'PageRank', value: formatMetric(metrics.pagerank) },
                      { label: 'Betweenness', value: formatMetric(metrics.betweenness) },
                      { label: 'Community', value: metrics.community_id ?? '—' },
                      { label: 'Component', value: metrics.component_id ?? '—' },
                    ].map((m) => (
                      <div key={m.label} className="inset px-3 py-2">
                        <p className="field-label">{m.label}</p>
                        <p className="text-ink mt-1 font-mono text-sm tabular-nums">{m.value}</p>
                      </div>
                    ))}
                    {interpretation?.label ? (
                      <div className="inset flex items-center px-3 py-2">
                        <Badge tone={interpretation.is_investigation_lead ? 'alert' : 'neutral'}>
                          {humanizeToken(interpretation.label)}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {demo.ground_truth_ring_id !== undefined || demo.community?.ground_truth_overlay ? (
                  <div data-testid="overlay-block" className="sr-only">
                    Ground truth overlay
                  </div>
                ) : null}

                {/* Strongest relationships */}
                {demo.strongest_relationships && demo.strongest_relationships.length > 0 ? (
                  <>
                    <Divider label="Strongest links" />
                    <ul className="space-y-1.5">
                      {demo.strongest_relationships.slice(0, 4).map((rel) => {
                        const neighbourId = personIdFromEntityId(rel.with);
                        return (
                          <li key={rel.relationship_id} className="border-line bg-panel-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-2.5 py-2">
                            <RelationshipBadge relationshipType={rel.relationship_type} />
                            {neighbourId === null ? (
                              <Mono>{rel.with}</Mono>
                            ) : (
                              <Link to={`/network/${neighbourId}`} className="text-ink hover:text-cyan-300 text-xs font-medium underline decoration-dotted underline-offset-2">
                                {rel.with_label ?? rel.with}
                              </Link>
                            )}
                            <span className="text-ink-4 ml-auto font-mono text-2xs">
                              weight {formatMetric(rel.weight ?? null, 2)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================== structural leads */

function StructuralLeadsPanel({ state }: { state: AsyncState<TopPersonsResponse> }): ReactElement {
  const names = usePersonNames();

  return (
    <Panel>
      <PanelHeader
        title="Top by PageRank"
        accent
        actions={
          <InfoHint content="Centrality in the observed person graph. Not a priority score." />
        }
      />
      <PanelBody padded={false}>
        <RequestBody state={state} skeleton={<SkeletonRows rows={8} className="p-3" />}>
          {(data) => {
            const persons = data.persons ?? [];
            if (persons.length === 0) {
              return <EmptyState title="No data" description="No data available." />;
            }
            const max = Math.max(...persons.map((p) => p.pagerank ?? 0), 0.0001);
            return (
              <ul className="divide-line divide-y">
                {persons.map((person, i) => {
                  const numericId = personIdFromEntityId(person.entity_id);
                  const barWidth = Math.max(2, Math.round(((person.pagerank ?? 0) / max) * 100));
                  return (
                    <li key={person.entity_id}>
                      {numericId !== null ? (
                        <Link
                          to={`/network/${numericId}`}
                          className="hover:bg-panel-2 flex items-center gap-3 px-4 py-2.5 transition-colors"
                        >
                          <span className="text-ink-4 w-4 shrink-0 font-mono text-2xs tabular-nums">{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-ink truncate text-xs font-semibold">
                              {names.labelOf(numericId)}
                            </p>
                            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-panel-3">
                              <div className="h-full rounded-full bg-cyan-500/60" style={{ width: `${barWidth}%` }} />
                            </div>
                          </div>
                          <span className="text-ink-4 shrink-0 font-mono text-2xs tabular-nums">
                            {formatMetric(person.pagerank ?? null, 6)}
                          </span>
                        </Link>
                      ) : (
                        <div className="flex items-center gap-3 px-4 py-2.5">
                          <span className="text-ink-4 w-4 shrink-0 font-mono text-2xs">{i + 1}</span>
                          <p className="text-ink-2 min-w-0 flex-1 truncate text-xs">{person.entity_id}</p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================== recent patterns */

function RecentPatternsPanel({ state }: { state: AsyncState<{ patterns: Array<{ pattern_id: string; pattern_type: string; explanation?: string; entity_ids?: string[] }> }> }): ReactElement {
  return (
    <Panel>
      <PanelHeader title="Recent Intelligence" subtitle="Latest detected patterns" accent />
      <PanelBody padded={false}>
        <RequestBody state={state} skeleton={<SkeletonRows rows={5} className="p-3" />}>
          {(data) => {
            const items = data.patterns ?? [];
            if (items.length === 0) {
              return (
                <div className="px-4 py-3">
                  <p className="text-ink-3 text-xs">No patterns detected.</p>
                </div>
              );
            }
            return (
              <ul className="divide-line divide-y">
                {items.slice(0, 5).map((p) => (
                  <li key={p.pattern_id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink text-xs font-semibold">{patternTypeLabel(p.pattern_type)}</span>
                      <Badge tone="cyan">Pattern</Badge>
                    </div>
                    {p.explanation ? (
                      <p className="text-ink-3 mt-1 text-2xs leading-relaxed line-clamp-2">{p.explanation}</p>
                    ) : null}
                    {p.entity_ids && p.entity_ids.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.entity_ids.slice(0, 3).map((id: string) => <Mono key={id} className="text-2xs">{id}</Mono>)}
                        {p.entity_ids.length > 3 ? <span className="text-ink-4 text-2xs">+{p.entity_ids.length - 3}</span> : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================== graph engine */

function GraphEnginePanel({ state }: { state: AsyncState<GraphSummaryResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader title="Graph Engine" accent />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonRows rows={6} />}>
          {(data) => {
            const g = data.graph;
            const analytics = data.analytics;
            const communities = data.communities;
            const metrics: Array<[string, ReactNode]> = [
              ['Nodes', formatCount(g?.node_count)],
              ['Observed edges', formatCount(g?.observed_edge_count)],
              ['Overlay edges', formatCount(g?.overlay_edge_count)],
              ['Analyzed persons', formatCount(analytics?.persons)],
              ['Communities', formatCount(communities?.count)],
              ['Modularity', formatMetric(communities?.modularity, 4)],
            ];
            return (
              <div className="divide-line divide-y">
                {metrics.map(([label, value]) => (
                  <div key={label as string} className="metric-row">
                    <span className="field-label">{label}</span>
                    <span className="text-ink font-mono text-xs tabular-nums">{value}</span>
                  </div>
                ))}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}
