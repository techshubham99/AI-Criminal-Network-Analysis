/**
 * CommandCenter — §4's dashboard and §10's deterministic demo entry point.
 *
 * Every figure on this page is a field of a live response. There is no constant
 * in this file that holds a count, a metric, a date or a name, and no value is
 * derived from another except where the arithmetic is stated on screen. If the
 * backend stops reporting a field, its tile shows an em dash rather than a zero:
 * "0 relationships" and "not reported" are different claims.
 *
 * FIVE INDEPENDENT REQUESTS. `/data/summary`, `/graph/summary`, `/nlp/summary`,
 * `/analytics/demo` and `/analytics/persons/top` each get their own `useAsync`,
 * so a failure degrades one card and leaves the rest of the dashboard standing.
 * There is deliberately no sixth request for `/health` — TopBar owns the only
 * health poll in the app, and a second heartbeat here could disagree with it.
 *
 * THREE HONESTY RULES THIS PAGE IS BUILT AROUND.
 *
 *  1. The headline relationship count is `observed_edge_count`, not
 *     `edge_count`. The difference between them is the 1,980-edge SAME_RING
 *     overlay, which is the synthetic generator's own answer key.
 *  2. Anything computed from, or compared against, that answer key —
 *     `ring_distribution`, `in_ring`/`not_in_ring`, `ground_truth_ring_id`, the
 *     community/ring adjusted Rand index — is quarantined inside a dashed
 *     overlay block behind <ProvenanceTag provenance="overlay" />, and is never
 *     ranked, coloured, sorted or filtered by.
 *  3. Where the backend supplies its own caveat (`provenance_note`,
 *     `confidence_semantics.kind`, `evaluation.methodology.caveat`,
 *     `interpretation.disclaimer`, `framing_note`, the top-persons `note`), that
 *     sentence is reproduced verbatim instead of paraphrased. Paraphrasing a
 *     disclaimer is how a prototype ends up overclaiming.
 *
 * Phase 4 risk scoring does not exist in this build, so the leads panel says so
 * in as many words rather than letting a centrality ranking be mistaken for one.
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
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  RelationshipBadge,
  SectionHeading,
  SkeletonRows,
  SkeletonText,
  SkeletonTile,
  StatInline,
  StatTile,
} from '@/components/ui';
import type { AsyncState } from '@/hooks/useAsync';
import { useAsync } from '@/hooks/useAsync';
import type {
  DataSummaryResponse,
  DemoInvestigationResponse,
  GraphSummaryResponse,
  NlpSummaryResponse,
  PersonAnalyticsOut,
  TimeRange,
  TopPersonsResponse,
} from '@/types/api';
import { cn } from '@/utils/cn';
import { personIdFromEntityId } from '@/utils/entity';
import {
  formatCount,
  formatDateRange,
  formatDateTime,
  formatMetric,
  humanizeToken,
  sortedCounts,
} from '@/utils/format';
import { flattenScalars, readNumber, readRecord, readString, readStringArray } from '@/utils/records';

/** `/analytics/persons/top` is asked for one metric; the response names it back. */
const LEADS_METRIC = 'pagerank';
const LEADS_LIMIT = 8;

const PAGE_SUBTITLE =
  'Scale, provenance and structure of the corpus this prototype can actually see. Every number below is a field of a live backend response — nothing on this page is precomputed, cached or illustrative.';

/**
 * The one sentence that has to survive the whole demo. Structural prominence in
 * observed data is a reason to look, not a finding.
 */
const NEUTRAL_FRAMING =
  'Connectivity is not culpability. Nothing on this dashboard asserts that any person, community or group is criminal.';

/** A link that has to read as the primary action. Full literal class strings. */
const PRIMARY_LINK_CLASS =
  'inline-flex h-8.5 shrink-0 items-center justify-center gap-2 rounded-sm border border-cyan-600/55 bg-cyan-500/14 px-3 text-xs font-semibold whitespace-nowrap text-cyan-200 transition-colors hover:border-cyan-500/70 hover:bg-cyan-500/22';
const SECONDARY_LINK_CLASS =
  'inline-flex h-8.5 shrink-0 items-center justify-center gap-2 rounded-sm border border-line-strong bg-panel-2 px-3 text-xs font-semibold whitespace-nowrap text-ink-2 transition-colors hover:border-line-accent hover:bg-panel-3 hover:text-ink';

/* ========================================================== shared fragments */

/**
 * The standard body flow for a panel fed by one request: error before data,
 * skeleton while there is no data, and — on a failed retry — the previous answer
 * kept on screen under a compact error rather than blanked.
 */
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
    if (state.error) return <ErrorState error={state.error} onRetry={state.retry} />;
    return <>{skeleton}</>;
  }
  return (
    <>
      {state.error ? (
        <ErrorState error={state.error} onRetry={state.retry} compact className="mb-3" />
      ) : null}
      {children(state.data)}
    </>
  );
}

/** A dashed block for the generator's ground-truth label and anything derived from it. */
function OverlayBlock({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      data-testid="overlay-block"
      className={cn('border-overlay/35 bg-overlay/10 rounded-md border border-dashed p-3', className)}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="field-label">{title}</span>
        <ProvenanceTag provenance="overlay" short />
      </div>
      {children}
    </div>
  );
}

/** A caveat the backend wrote. Amber, never red: red is reserved for failures. */
function BackendCaveat({
  label,
  text,
  className,
}: {
  label: string;
  text: string;
  className?: string;
}): ReactElement {
  return (
    <div
      data-testid="backend-caveat"
      className={cn('border-warn-400/30 bg-warn-400/8 rounded-md border p-3', className)}
    >
      <p className="field-label text-warn-300">{label}</p>
      <p className="text-ink-2 mt-1.5 text-xs leading-relaxed">{text}</p>
    </div>
  );
}

/** `{"PERSON": 600}` as chips, most numerous first. */
function CountChips({
  counts,
  emptyLabel,
  overlayKeys,
}: {
  counts: Record<string, number>;
  emptyLabel: string;
  /** Keys the backend itself reports as overlay; marked, never hidden. */
  overlayKeys?: string[];
}): ReactElement {
  const rows = sortedCounts(counts);
  if (rows.length === 0) return <p className="text-ink-4 text-xs">{emptyLabel}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {rows.map(([key, count]) => {
        const isOverlay = overlayKeys?.includes(key) ?? false;
        return (
          <li key={key}>
            <span
              className={cn(
                'ring-line bg-inset inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 font-mono text-2xs ring-1 ring-inset',
                isOverlay ? 'border-overlay/40 text-overlay border border-dashed' : 'text-ink-2',
              )}
            >
              {key}
              <span className="text-ink-4 tabular-nums">{formatCount(count)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const timeRange = (range: TimeRange | undefined): string =>
  formatDateRange(range?.min ?? null, range?.max ?? null);

/* ========================================================== the page */

export function CommandCenter(): ReactElement {
  const summary = useAsync((signal) => api.getDataSummary({ signal }), []);
  const graph = useAsync((signal) => api.getGraphSummary({ signal }), []);
  const nlp = useAsync((signal) => api.getNlpSummary({ signal }), []);
  const demo = useAsync((signal) => api.getDemoInvestigation({ signal }), []);
  const leads = useAsync((signal) => api.getTopPersons(LEADS_METRIC, LEADS_LIMIT, { signal }), []);

  return (
    <div className="space-y-4 pb-10" data-testid="command-center">
      <SectionHeading title="Command Center" subtitle={PAGE_SUBTITLE} />

      <ScaleStrip summary={summary} graph={graph} nlp={nlp} />

      <p className="text-ink-4 text-xs leading-relaxed">{NEUTRAL_FRAMING}</p>

      <DemoEntryPoint state={demo} />

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphEnginePanel state={graph} />
        <NarrativeNlpPanel state={nlp} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DatasetPanel state={summary} />
        <StructuralLeadsPanel state={leads} />
      </div>
    </div>
  );
}

/* ========================================================== §4 scale strip */

/**
 * Six figures, three sources. Each tile is skeletoned by its own request, so the
 * dataset counts appear as soon as `/data/summary` lands even if the graph
 * summary is still in flight — and a failed source leaves its tiles dashed with
 * the reason stated underneath instead of silently showing nothing.
 */
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
  const failures: Array<[string, AsyncState<unknown>]> = [
    ['/data/summary', summary],
    ['/graph/summary', graph],
    ['/nlp/summary', nlp],
  ];

  return (
    <section aria-label="Corpus scale" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {summary.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Persons on record"
            value={formatCount(counts?.persons)}
            accent="neutral"
            footnote="Rows in the persons table · /data/summary"
            hint="The count of person rows in the read-only synthetic dataset. This is the population the graph is built from, not the number of people of interest."
          />
        )}

        {graph.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Graph entities"
            value={formatCount(g?.node_count)}
            accent="cyan"
            footnote="Nodes materialised in the graph · /graph/summary"
            hint="Persons plus the phones, Aadhaar numbers, locations, FIRs and cell towers they resolve to. It is larger than the person count because one person contributes several entity nodes."
          />
        )}

        {graph.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Observed relationships"
            value={formatCount(g?.observed_edge_count)}
            accent="cyan"
            footnote="Overlay edges excluded · /graph/summary"
            hint="Edges traceable to at least one source record. The generator's SAME_RING answer key is deliberately NOT counted here — it is reported separately in the graph panel below."
          />
        )}

        {summary.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="FIRs"
            value={formatCount(counts?.firs)}
            accent="azure"
            footnote="First Information Reports · /data/summary"
            hint="Each FIR carries structured columns and a free-text narrative. Both are read, and kept apart, on FIR Intelligence."
          />
        )}

        {summary.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Locations"
            value={formatCount(counts?.locations)}
            accent="neutral"
            footnote="Distinct location rows · /data/summary"
            hint="Canonical locations referenced by persons and FIRs. Two persons sharing one of these is what produces a derived CO_LOCATED link."
          />
        )}

        {nlp.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Narrative entities"
            value={formatCount(nlp.data?.entity_count)}
            accent="azure"
            footnote="Extracted from FIR free text · /nlp/summary"
            hint="Mentions found in FIR narratives by deterministic rules, each with a character span and a quoted evidence phrase. Held in a separate narrative layer — never merged into the structured graph."
          />
        )}
      </div>

      {failures.map(([endpoint, state]) =>
        state.error && !state.data ? (
          <ErrorState
            key={endpoint}
            error={state.error}
            onRetry={state.retry}
            title={`${endpoint} did not answer`}
            compact
          />
        ) : null,
      )}
    </section>
  );
}

/* ========================================================== §10 demo entry point */

/**
 * The demo entry point is the backend's own pick, not this screen's.
 * `/analytics/demo` decides which person to open and says in
 * `selection_method` exactly how it decided; that sentence is printed verbatim
 * so nobody has to trust the front end's account of it.
 */
function DemoEntryPoint({ state }: { state: AsyncState<DemoInvestigationResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="Start here"
        subtitle="A single real subject from the loaded dataset, chosen by the backend"
        actions={<Badge tone="cyan">DETERMINISTIC</Badge>}
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonText lines={5} />}>
          {(demo) => {
            if (!demo.available) {
              return (
                <EmptyState
                  title="The backend reports no demo subject"
                  description="/analytics/demo answered available: false. Nothing is substituted here — a fabricated subject would defeat the purpose of the entry point."
                />
              );
            }

            const numericId = demo.person_id ? personIdFromEntityId(demo.person_id) : null;
            const metrics = demo.notable_metrics;
            const interpretation = metrics?.interpretation;
            const basis = interpretation?.basis ?? null;
            const overlay = readRecord(demo.community ?? null, 'ground_truth_overlay');

            return (
              <div className="space-y-4">
                {/* ---------- who, and how they were chosen ---------- */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <EntityBadge entityType="PERSON" />
                      <h3 className="text-ink truncate text-lg font-semibold">
                        {demo.label ?? 'Unlabelled subject'}
                      </h3>
                      {demo.person_id ? <Mono>{demo.person_id}</Mono> : null}
                      <ProvenanceTag provenance="structured" short />
                    </div>
                    {demo.description ? (
                      <p className="text-ink-3 mt-1.5 max-w-3xl text-xs leading-relaxed">
                        {demo.description}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {numericId === null ? (
                      <Badge tone="warn">NO ROUTABLE ID</Badge>
                    ) : (
                      <>
                        <Link to={`/network/${numericId}`} className={PRIMARY_LINK_CLASS}>
                          Open network for {demo.label ?? `person ${numericId}`}
                        </Link>
                        <Link
                          to={`/evidence?entity=${encodeURIComponent(demo.person_id ?? '')}`}
                          className={SECONDARY_LINK_CLASS}
                        >
                          Provenance
                        </Link>
                      </>
                    )}
                  </div>
                </div>

                {demo.selection_method ? (
                  <div className="border-line bg-inset rounded-md border p-3">
                    <p className="field-label">Selection method, as reported</p>
                    <p className="text-ink-2 mt-1.5 font-mono text-xs leading-relaxed">
                      {demo.selection_method}
                    </p>
                  </div>
                ) : null}

                {/* ---------- neighbourhood size at both depths ---------- */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <HopCard
                    title="1-hop"
                    caption="Direct links only"
                    hop={demo.one_hop}
                    to={numericId === null ? null : `/network/${numericId}`}
                  />
                  <HopCard
                    title="2-hop"
                    caption="Neighbours of neighbours"
                    hop={demo.two_hop}
                    to={numericId === null ? null : `/network/${numericId}`}
                  />
                </div>

                {/* ---------- structural position ---------- */}
                {metrics ? (
                  <div className="space-y-3">
                    <Divider label="Structural position in the observed graph" />
                    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                      <KeyValueList dense>
                        <KeyValueRow
                          label="Degree"
                          value={formatCount(metrics.degree)}
                          mono
                          hint="How many distinct entities this person is linked to in the observed graph."
                        />
                        <KeyValueRow
                          label="Weighted degree"
                          value={formatMetric(metrics.weighted_degree, 2)}
                          mono
                          hint="Degree with each link weighted by how much evidence supports it."
                        />
                        <KeyValueRow
                          label="Degree centrality"
                          value={formatMetric(metrics.degree_centrality)}
                          mono
                          hint="Degree expressed as a share of the largest possible degree in this projection."
                        />
                      </KeyValueList>
                      <KeyValueList dense>
                        <KeyValueRow
                          label="PageRank"
                          value={formatMetric(metrics.pagerank)}
                          mono
                          hint="How often a random walk over the weighted person graph would arrive here. A measure of position, not of behaviour."
                        />
                        <KeyValueRow
                          label="Betweenness"
                          value={formatMetric(metrics.betweenness)}
                          mono
                          hint="How often this person lies on the shortest path between two others — the broker-position measure."
                        />
                        <KeyValueRow
                          label="Community · component"
                          value={`${metrics.community_id ?? '—'} · ${metrics.component_id ?? '—'}`}
                          mono
                          hint="Community is an unsupervised Louvain grouping of the person projection. Component is the connected component id."
                        />
                      </KeyValueList>
                    </div>

                    {interpretation?.label ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="field-label">Backend interpretation</span>
                        <Badge tone="cyan">{humanizeToken(interpretation.label)}</Badge>
                        {interpretation.is_investigation_lead ? (
                          <Badge tone="azure" title="The backend's own wording for this flag.">
                            INVESTIGATION LEAD
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}

                    {basis ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {flattenScalars(basis).map(([key, value]) => (
                          <li
                            key={key}
                            className="ring-line bg-inset text-ink-3 rounded-xs px-1.5 py-0.5 font-mono text-2xs ring-1 ring-inset"
                          >
                            {key} <span className="text-ink-2">{value}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {interpretation?.disclaimer ? (
                      <BackendCaveat
                        label="The backend's disclaimer on these metrics"
                        text={interpretation.disclaimer}
                      />
                    ) : null}
                  </div>
                ) : null}

                {/* ---------- best-evidenced links ---------- */}
                {demo.strongest_relationships && demo.strongest_relationships.length > 0 ? (
                  <div className="space-y-2">
                    <Divider label="Best-evidenced links" />
                    <ul className="space-y-1.5">
                      {demo.strongest_relationships.map((rel) => {
                        const evidence = readStringArray(rel, 'evidence_sample');
                        const confidence = readNumber(rel, 'provenance_confidence');
                        const neighbourId = personIdFromEntityId(rel.with);
                        return (
                          <li
                            key={rel.relationship_id}
                            className="border-line bg-panel-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm border px-2.5 py-2"
                          >
                            <RelationshipBadge relationshipType={rel.relationship_type} />
                            {neighbourId === null ? (
                              <Mono>{rel.with}</Mono>
                            ) : (
                              <Link
                                to={`/network/${neighbourId}`}
                                className="text-ink hover:text-cyan-300 truncate text-xs font-medium underline decoration-dotted underline-offset-2"
                              >
                                {rel.with_label ?? rel.with}
                              </Link>
                            )}
                            <span className="text-ink-4 font-mono text-2xs">
                              weight {formatMetric(rel.weight ?? null, 2)}
                            </span>
                            {evidence.length > 0 ? (
                              <span className="flex flex-wrap items-center gap-1">
                                <span className="field-label">evidence</span>
                                {evidence.map((citation) => (
                                  <Mono key={citation}>{citation}</Mono>
                                ))}
                              </span>
                            ) : null}
                            {confidence !== null ? (
                              <span className="text-ink-4 ml-auto flex items-center gap-1 font-mono text-2xs">
                                provenance {formatMetric(confidence, 2)}
                                <InfoHint content="A data-provenance flag, not a model confidence: 1.0 means the edge is traceable to at least one source record. No confidence value in this system is learned or fabricated." />
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

                {/* ---------- community, then the answer key, kept apart ---------- */}
                {demo.community ? (
                  <div className="space-y-2">
                    <Divider label="Community context" />
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      <StatInline
                        label="Community"
                        value={demo.community.community_id ?? '—'}
                      />
                      <StatInline
                        label="Members"
                        value={formatCount(demo.community.community_size)}
                      />
                      <StatInline
                        label="Modularity"
                        value={formatMetric(demo.community.modularity ?? null)}
                        hint="How well the whole partition separates the person graph. It says nothing about this individual."
                      />
                    </div>
                    {overlay ? (
                      <OverlayBlock title="Compared against the generator's ring label">
                        <KeyValueList dense>
                          <KeyValueRow
                            label="Overlay field"
                            value={readString(overlay, 'label') ?? '—'}
                            mono
                          />
                          <KeyValueRow
                            label="Adjusted Rand index"
                            value={formatMetric(readNumber(overlay, 'adjusted_rand_index'))}
                            mono
                            hint="Agreement between the unsupervised communities and the generator's rings. 0 means no agreement beyond chance."
                          />
                          <KeyValueRow
                            label="Persons compared"
                            value={formatCount(readNumber(overlay, 'ari_persons') ?? undefined)}
                            mono
                          />
                        </KeyValueList>
                        {readString(overlay, 'note') ? (
                          <p className="text-ink-3 mt-2 text-xs leading-relaxed">
                            {readString(overlay, 'note')}
                          </p>
                        ) : null}
                      </OverlayBlock>
                    ) : null}
                  </div>
                ) : null}

                {demo.ground_truth_ring_id !== null && demo.ground_truth_ring_id !== undefined ? (
                  <OverlayBlock title="Generator ring label for this subject">
                    <p className="text-ink-2 font-mono text-xs">
                      ring_id {demo.ground_truth_ring_id}
                    </p>
                    <p className="text-ink-3 mt-1.5 text-xs leading-relaxed">
                      Shown only because the backend reports it. It is the synthetic generator's
                      answer key, it is excluded from the graph view and from every analytic in this
                      system, and nothing on this dashboard is ranked, coloured, grouped or filtered
                      by it.
                    </p>
                  </OverlayBlock>
                ) : null}

                {demo.framing_note ? (
                  <BackendCaveat label="Framing, as the backend states it" text={demo.framing_note} />
                ) : null}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/** One depth of the demo subject's neighbourhood, with truncation admitted. */
function HopCard({
  title,
  caption,
  hop,
  to,
}: {
  title: string;
  caption: string;
  hop: { node_count?: number; edge_count?: number; truncated?: boolean } | undefined;
  to: string | null;
}): ReactElement {
  return (
    <div className="border-line bg-panel-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-ink text-sm font-semibold">{title}</p>
          <p className="text-ink-4 text-2xs">{caption}</p>
        </div>
        {hop?.truncated ? (
          <Badge tone="warn" title="The backend capped this response; the real neighbourhood is larger.">
            TRUNCATED
          </Badge>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
        <StatInline label="Entities" value={formatCount(hop?.node_count)} />
        <StatInline label="Links" value={formatCount(hop?.edge_count)} />
      </div>
      {to ? (
        <Link
          to={to}
          className="text-ink-3 hover:text-cyan-300 mt-2 inline-block text-2xs underline decoration-dotted underline-offset-2"
        >
          Open in Network Investigation
        </Link>
      ) : null}
    </div>
  );
}

/* ========================================================== graph status */

function GraphEnginePanel({ state }: { state: AsyncState<GraphSummaryResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="Graph engine"
        subtitle={state.data?.phase ?? 'Structured entity graph'}
        actions={<ProvenanceTag provenance="structured" short />}
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonRows rows={6} />}>
          {(data) => {
            const g = data.graph ?? {};
            const overlayTypes = Object.keys(g.overlay_edges_by_type ?? {});
            const analytics = data.analytics ?? {};
            const communities = data.communities ?? {};
            const limits = data.limits ?? {};
            const build = data.build ?? null;

            return (
              <div className="space-y-4">
                <KeyValueList dense>
                  <KeyValueRow label="Entities" value={formatCount(g.node_count)} mono />
                  <KeyValueRow
                    label="Observed relationships"
                    value={formatCount(g.observed_edge_count)}
                    mono
                    tone="cyan"
                    hint="Edges backed by at least one source record. This is the number every other view of this app counts."
                  />
                  <KeyValueRow
                    label="Overlay relationships"
                    value={formatCount(g.overlay_edge_count)}
                    mono
                    tone="muted"
                    hint="The generator's SAME_RING answer key. Requested with include_overlay=false everywhere in this UI, so it is never drawn."
                  />
                  <KeyValueRow
                    label="Total edges in store"
                    value={formatCount(g.edge_count)}
                    mono
                    tone="muted"
                    hint="Observed plus overlay. Reported for completeness; the observed figure is the one to quote."
                  />
                  <KeyValueRow
                    label="Self-loops"
                    value={formatCount(g.self_loops)}
                    mono
                    tone={g.self_loops ? 'muted' : 'default'}
                    hint="Rows whose two endpoints are the same person. Kept in the store for traceability and excluded from analytics."
                  />
                </KeyValueList>

                <div className="space-y-2">
                  <Divider label="Entity types materialised" />
                  <CountChips counts={g.nodes_by_type ?? {}} emptyLabel="No node types reported." />
                  {data.future_node_types && data.future_node_types.length > 0 ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      Declared but not present in this dataset:{' '}
                      <span className="font-mono">{data.future_node_types.join(', ')}</span>. No view
                      in this build renders them, because there are no rows behind them.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Divider label="Relationship types" />
                  <CountChips
                    counts={g.edges_by_type ?? {}}
                    emptyLabel="No edge types reported."
                    overlayKeys={overlayTypes}
                  />
                  {overlayTypes.length > 0 ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      Dashed:{' '}
                      <span className="text-overlay font-mono">{overlayTypes.join(', ')}</span> — the
                      generator's own label, counted here but excluded from the graph view and from
                      analytics.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Divider label="Analytics scope" />
                  <KeyValueList dense>
                    <KeyValueRow label="Persons analysed" value={formatCount(analytics.persons)} mono />
                    <KeyValueRow
                      label="Undirected edges"
                      value={formatCount(analytics.undirected?.edges)}
                      mono
                      hint="The projection degree, community and betweenness are computed on."
                    />
                    <KeyValueRow
                      label="Directed edges"
                      value={formatCount(analytics.directed?.edges)}
                      mono
                      hint="The projection PageRank is computed on."
                    />
                  </KeyValueList>
                  {analytics.excluded_from_analytics &&
                  analytics.excluded_from_analytics.length > 0 ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      Excluded from every metric:{' '}
                      <span className="font-mono">
                        {analytics.excluded_from_analytics.join(', ')}
                      </span>
                      .
                    </p>
                  ) : null}
                  {analytics.undirected?.note ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      {analytics.undirected.note}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Divider label="Communities" />
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <StatInline label="Communities" value={formatCount(communities.count)} />
                    <StatInline
                      label="Modularity"
                      value={formatMetric(communities.modularity ?? null)}
                      hint="How cleanly the partition separates the person graph. Higher is a tidier split; it is not a measure of correctness."
                    />
                  </div>
                  <OverlayBlock title="Do these communities recover the generator's rings?">
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      <StatInline
                        label="Adjusted Rand index"
                        value={formatMetric(communities.adjusted_rand_index_vs_rings ?? null)}
                        hint="1.0 would be perfect agreement with the generator's rings; 0.0 is no better than chance."
                      />
                      <StatInline
                        label="Persons compared"
                        value={formatCount(communities.ari_persons)}
                      />
                    </div>
                    <p className="text-ink-3 mt-2 text-xs leading-relaxed">
                      This index is the honest negative result of Phase 2: the unsupervised
                      communities do not reproduce the synthetic rings, so no crime-ring detection
                      is claimed anywhere in this system. Communities are a way to organise a large
                      graph, not an accusation.
                    </p>
                  </OverlayBlock>
                </div>

                {build ? (
                  <div className="space-y-2">
                    <Divider label="Build" />
                    <KeyValueList dense>
                      {flattenScalars(build).map(([key, value]) => (
                        <KeyValueRow key={key} label={humanizeToken(key)} value={value} mono wrap />
                      ))}
                    </KeyValueList>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Divider label="Response limits enforced by the backend" />
                  <KeyValueList dense>
                    <KeyValueRow
                      label="Max network depth"
                      value={formatCount(limits.max_network_depth)}
                      mono
                      hint="Why Network Investigation offers 1-hop and 2-hop and nothing wider: a deeper request is rejected."
                    />
                    <KeyValueRow
                      label="Max network nodes"
                      value={formatCount(limits.max_network_nodes)}
                      mono
                      hint="A network response above this size comes back truncated, and the toolbar says so."
                    />
                    <KeyValueRow label="Max path length" value={formatCount(limits.max_path_length)} mono />
                    <KeyValueRow label="Max paths" value={formatCount(limits.max_paths)} mono />
                    <KeyValueRow
                      label="Search limit"
                      value={formatCount(limits.search_limit)}
                      mono
                    />
                  </KeyValueList>
                </div>

                {data.provenance_note ? (
                  <div className="border-line bg-inset rounded-md border p-3">
                    <p className="field-label">Provenance, as the backend states it</p>
                    <p className="text-ink-2 mt-1.5 text-xs leading-relaxed">
                      {data.provenance_note}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================== NLP status */

function NarrativeNlpPanel({ state }: { state: AsyncState<NlpSummaryResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="FIR narrative NLP"
        subtitle={state.data?.phase ?? 'Deterministic narrative extraction'}
        actions={<ProvenanceTag provenance="narrative" short />}
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonRows rows={6} />}>
          {(data) => {
            const additions = data.graph_additions_by_status ?? {};
            const narrative = data.narrative_graph ?? {};
            const capabilities = data.capabilities ?? {};
            const semantics = readString(data.confidence_semantics ?? null, 'kind');
            const methodology = readRecord(data.evaluation ?? null, 'methodology');
            const caveat = readString(methodology, 'caveat');
            const duplicates = additions.rejected_duplicate;

            return (
              <div className="space-y-4">
                <KeyValueList dense>
                  <KeyValueRow label="FIRs analysed" value={formatCount(data.firs_analyzed)} mono />
                  <KeyValueRow
                    label="With a narrative"
                    value={formatCount(data.firs_with_narrative)}
                    mono
                  />
                  <KeyValueRow
                    label="Without a narrative"
                    value={formatCount(data.firs_without_narrative)}
                    mono
                    hint="An FIR with no free text yields no narrative entities. Reported so coverage is not assumed."
                  />
                  <KeyValueRow
                    label="Yielding no entities"
                    value={formatCount(data.firs_without_entities)}
                    mono
                  />
                </KeyValueList>

                <div className="space-y-2">
                  <Divider label="Entities extracted" />
                  <StatInline label="Total" value={formatCount(data.entity_count)} />
                  <CountChips
                    counts={data.entities_by_type ?? {}}
                    emptyLabel="No entity types reported."
                  />
                  <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <p className="field-label">By extraction method</p>
                      <CountChips
                        counts={data.entities_by_extraction_method ?? {}}
                        emptyLabel="Not reported."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <p className="field-label flex items-center gap-1.5">
                        By confidence tier
                        <InfoHint content="These are rule-assigned tiers, not learned probabilities. A tier of 1.0 means a deterministic rule matched exactly — it is not a claim that a model is 100% accurate." />
                      </p>
                      <CountChips
                        counts={data.entities_by_confidence ?? {}}
                        emptyLabel="Not reported."
                      />
                    </div>
                  </div>
                  {semantics ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      Confidence semantics, as reported:{' '}
                      <span className="text-ink-3">{semantics}</span>
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Divider label="Resolution to known records" />
                  <CountChips
                    counts={data.resolution_by_status ?? {}}
                    emptyLabel="No resolution statuses reported."
                  />
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <StatInline
                      label="Unresolved"
                      value={formatCount(data.unresolved_entities)}
                      hint="A mention that could not be tied to a dataset record. It stays visible as a mention and is never invented into an entity."
                    />
                    <StatInline
                      label="Ambiguous"
                      value={formatCount(data.ambiguous_resolutions)}
                      hint="A mention that matched more than one record. The backend refuses to pick one."
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Divider label="Relationships asserted by narrative text" />
                  <StatInline label="Validated" value={formatCount(data.relationship_count)} />
                  <CountChips
                    counts={data.relationships_by_type ?? {}}
                    emptyLabel="No relationship types reported."
                  />
                </div>

                <div className="space-y-2">
                  <Divider label="What the narrative layer added" />
                  <CountChips counts={additions} emptyLabel="No addition statuses reported." />
                  {typeof duplicates === 'number' &&
                  typeof data.relationship_count === 'number' &&
                  data.relationship_count > 0 ? (
                    <p className="text-ink-3 text-xs leading-relaxed">
                      {formatCount(duplicates)} of the {formatCount(data.relationship_count)}{' '}
                      validated narrative relationships were rejected because the structured graph
                      already contains that link. In this synthetic corpus the narratives largely
                      restate the structured columns, so the narrative layer mostly corroborates
                      what is already on record rather than revealing new connections. That is a
                      property of the dataset, and it is reported rather than dressed up.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Divider label="Narrative graph, held separately" />
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <StatInline label="Nodes" value={formatCount(narrative.node_count)} />
                    <StatInline label="Edges" value={formatCount(narrative.edge_count)} />
                    <StatInline
                      label="Source records"
                      value={formatCount(narrative.contributing_source_records)}
                      hint="How many FIR rows contributed at least one narrative edge."
                    />
                  </div>
                  <p className="text-ink-4 text-2xs leading-relaxed">
                    {narrative.all_edges_are_narrative
                      ? 'The backend reports that every edge in this graph is narrative-derived: the structured graph is not mutated by narrative extraction.'
                      : 'The backend does not report this graph as wholly narrative-derived.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Divider label="How this runs" />
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={capabilities.external_model_apis_used ? 'warn' : 'ok'}>
                      {capabilities.external_model_apis_used
                        ? 'EXTERNAL MODEL APIS USED'
                        : 'NO EXTERNAL MODEL APIS'}
                    </Badge>
                    <Badge tone="muted">
                      {capabilities.optional_spacy_model_available
                        ? 'OPTIONAL SPACY MODEL PRESENT'
                        : 'NO SPACY MODEL — RULES ONLY'}
                    </Badge>
                  </div>
                  {capabilities.extraction_methods && capabilities.extraction_methods.length > 0 ? (
                    <p className="text-ink-4 text-2xs leading-relaxed">
                      Extraction methods:{' '}
                      <span className="font-mono">{capabilities.extraction_methods.join(', ')}</span>
                    </p>
                  ) : null}
                </div>

                {caveat ? (
                  <BackendCaveat
                    label="What these figures do and do not measure"
                    text={caveat}
                  />
                ) : null}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================== dataset of record */

function DatasetPanel({ state }: { state: AsyncState<DataSummaryResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="Dataset of record"
        subtitle="The read-only synthetic source tables everything else is built from"
        actions={<ProvenanceTag provenance="structured" short />}
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonRows rows={6} />}>
          {(data) => {
            const integrity = data.validation.referential_integrity;
            const findings = Object.entries(integrity).filter(([, count]) => count > 0);

            return (
              <div className="space-y-4">
                <KeyValueList dense>
                  <KeyValueRow label="Dataset directory" value={data.dataset_dir} mono wrap />
                  <KeyValueRow
                    label="Loaded at"
                    value={formatDateTime(data.loaded_at)}
                    mono
                    hint="When the backend read these tables into memory. The files themselves are never written to."
                  />
                </KeyValueList>

                <div className="space-y-2">
                  <Divider label="Table sizes" />
                  <CountChips
                    counts={data.counts as unknown as Record<string, number>}
                    emptyLabel="No table counts reported."
                  />
                </div>

                <div className="space-y-2">
                  <Divider label="Observed time spans" />
                  <KeyValueList dense>
                    <KeyValueRow label="Calls" value={timeRange(data.temporal.calls)} mono wrap />
                    <KeyValueRow
                      label="Transactions"
                      value={timeRange(data.temporal.transactions)}
                      mono
                      wrap
                    />
                    <KeyValueRow label="FIRs" value={timeRange(data.temporal.firs)} mono wrap />
                  </KeyValueList>
                </div>

                <div className="space-y-2">
                  <Divider label="Referential integrity" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={data.validation.is_valid ? 'ok' : 'alert'}>
                      {data.validation.is_valid ? 'VALID' : 'INVALID'}
                    </Badge>
                    <span className="text-ink-4 text-2xs">
                      as reported by the backend's own check
                    </span>
                  </div>
                  {findings.length > 0 ? (
                    <>
                      <p className="text-ink-3 text-xs leading-relaxed">
                        The check passes and still reports these rows. They are listed rather than
                        rounded away, because a reader deserves to know the corpus is not perfectly
                        clean:
                      </p>
                      <ul className="flex flex-wrap gap-1.5">
                        {findings.map(([key, count]) => (
                          <li
                            key={key}
                            className="border-warn-400/30 bg-warn-400/8 text-warn-300 rounded-xs border px-1.5 py-0.5 font-mono text-2xs"
                          >
                            {key} <span className="tabular-nums">{formatCount(count)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-ink-4 text-2xs">
                      Every foreign key resolves and no row references itself.
                    </p>
                  )}
                </div>

                <OverlayBlock title="Generator ring labels in the persons table">
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <StatInline label="Labelled" value={formatCount(data.persons.in_ring)} />
                    <StatInline label="Unlabelled" value={formatCount(data.persons.not_in_ring)} />
                  </div>
                  <div className="mt-2">
                    <CountChips
                      counts={data.persons.ring_distribution}
                      emptyLabel="No distribution reported."
                    />
                  </div>
                  <p className="text-ink-3 mt-2 text-xs leading-relaxed">
                    This is the synthetic generator's answer key, reported here only because it
                    exists in the source file. It is not evidence, it is excluded from the graph and
                    from every analytic, and no screen in this application ranks, colours, groups or
                    filters by it.
                  </p>
                </OverlayBlock>

                {data.notes.length > 0 ? (
                  <div className="space-y-2">
                    <Divider label="Notes from the backend" />
                    <ul className="space-y-1.5">
                      {data.notes.map((note) => (
                        <li key={note} className="text-ink-3 text-xs leading-relaxed">
                          {note}
                        </li>
                      ))}
                    </ul>
                  </div>
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

/**
 * Centrality, and nothing more. The panel says outright that no risk score
 * exists in this build, because a ranked list of people is exactly the thing a
 * viewer will otherwise read as one.
 */
function StructuralLeadsPanel({ state }: { state: AsyncState<TopPersonsResponse> }): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title="Structural leads"
        subtitle={
          state.data
            ? `${humanizeToken(state.data.metric)} · ${state.data.projection}`
            : 'Most structurally central persons in the observed graph'
        }
        actions={<Badge tone="muted">NOT A RISK SCORE</Badge>}
      />
      <PanelBody>
        <RequestBody state={state} skeleton={<SkeletonRows rows={LEADS_LIMIT} />}>
          {(data) => {
            if (data.persons.length === 0) {
              return (
                <EmptyState
                  title="No persons ranked"
                  description="The backend returned an empty ranking for this metric."
                />
              );
            }
            return (
              <div className="space-y-3">
                <ul className="space-y-1.5">
                  {data.persons.map((person, index) => (
                    <LeadRow key={person.entity_id} person={person} rank={index + 1} />
                  ))}
                </ul>

                <p className="text-ink-3 text-xs leading-relaxed">
                  Phase 4 risk scoring is not implemented in this build. This ranking is a
                  structural measure of position in the observed graph — it is not a risk score, a
                  suspicion level, or a prioritisation of people, and it must not be presented as
                  one.
                </p>

                {data.note ? (
                  <BackendCaveat label="The backend's note on this ranking" text={data.note} />
                ) : null}
              </div>
            );
          }}
        </RequestBody>
      </PanelBody>
    </Panel>
  );
}

/**
 * One ranked person. `/analytics/persons/top` returns metrics keyed by prefixed
 * entity id and no display name, so the id is shown as an id — a name is not
 * synthesised, and the row links to the network where the real label is fetched.
 */
function LeadRow({ person, rank }: { person: PersonAnalyticsOut; rank: number }): ReactElement {
  const numericId = personIdFromEntityId(person.entity_id);
  const label = person.interpretation.label;

  const body = (
    <>
      <span className="text-ink-4 w-6 shrink-0 font-mono text-2xs tabular-nums">#{rank}</span>
      <Mono className="shrink-0">{person.entity_id}</Mono>
      {label ? (
        <Badge tone="muted" className="shrink-0">
          {humanizeToken(label)}
        </Badge>
      ) : null}
      <span className="text-ink-4 ml-auto flex shrink-0 flex-wrap items-baseline gap-x-3 font-mono text-2xs tabular-nums">
        <span>deg {formatCount(person.degree)}</span>
        <span>pr {formatMetric(person.pagerank)}</span>
        <span>btw {formatMetric(person.betweenness)}</span>
      </span>
    </>
  );

  return (
    <li>
      {numericId === null ? (
        <div className="border-line bg-panel-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm border px-2.5 py-2">
          {body}
        </div>
      ) : (
        <Link
          to={`/network/${numericId}`}
          className="border-line bg-panel-2 hover:border-line-accent hover:bg-panel-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm border px-2.5 py-2 transition-colors"
        >
          {body}
        </Link>
      )}
    </li>
  );
}
