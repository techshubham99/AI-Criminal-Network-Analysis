/**
 * NodeDetailsPanel — "what is this entity?"
 *
 * The graph answers *who is connected to whom*; this panel answers *what the
 * system actually knows about the thing you clicked, and where that knowledge
 * came from*. Every value on screen is a field of the `NodeOut` the caller
 * already holds, or a field of `GET /analytics/persons/{id}`. Nothing is
 * computed, inferred or embellished here.
 *
 * Two deliberate constraints:
 *
 *  - `ring_id` is the synthetic generator's own answer key. It arrives inside
 *    `attributes` alongside genuine observed columns, so this panel splits it
 *    out into a visually separate overlay row, tags it, and says in words that
 *    no analytic consumes it. A real case file has no such column.
 *  - Centrality is a structural measure of position in the observed network.
 *    It is not a risk score. The caveat is stated in the panel, not buried in
 *    a tooltip.
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { api } from '@/api';
import type { NodeOut } from '@/types/api';
import { useAsync } from '@/hooks/useAsync';
import {
  Badge,
  Button,
  Divider,
  EmptyState,
  EntityBadge,
  ErrorState,
  IconButton,
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  SkeletonText,
  provenanceOf,
} from '@/components/ui';
import { entityStyle, firIdFromEntityId, personIdFromEntityId } from '@/utils/entity';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatInr,
  formatMetric,
  formatPercent,
  humanizeToken,
} from '@/utils/format';
import { flattenScalars, readNumber, readRecord, readString } from '@/utils/records';
import { cn } from '@/utils/cn';

/**
 * Keys inside `attributes` that belong to the synthetic generator's ground-truth
 * overlay rather than to the observed record. Held out of the main attribute
 * list on purpose — see the module comment.
 */
const OVERLAY_ATTRIBUTE_KEYS = ['ring_id', 'ground_truth_ring_id'];

/**
 * Reformat one attribute value by the *name* of its key.
 *
 * Matching is on key name only, never on the value, so a plain count can never
 * be mistaken for rupees. `flattenScalars` has already stringified the value;
 * the raw number is re-read from the record when a unit-aware formatter needs
 * it, and the stringified form is the fallback.
 */
function formatAttributeValue(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const lower = key.toLowerCase();
  const numeric = readNumber(record, key);

  if (numeric !== null && (/amount/.test(lower) || lower.endsWith('_inr'))) {
    return formatInr(numeric);
  }
  if (numeric !== null && /duration/.test(lower)) {
    return formatDuration(numeric);
  }
  if (/(^|_)date(_|$)/.test(lower) || /(^|_)(timestamp|datetime)(_|$)/.test(lower)) {
    const raw = readString(record, key);
    if (raw) return formatDateTime(raw);
  }
  return fallback;
}

/** Percentiles inside `interpretation.basis` are reported as 0–100 numbers. */
function formatBasisValue(
  basis: Record<string, unknown> | null,
  key: string,
  fallback: string,
): string {
  const numeric = readNumber(basis, key);
  if (numeric !== null && /percentile|threshold/.test(key.toLowerCase())) {
    return formatPercent(numeric);
  }
  return fallback;
}

const CloseIcon = (
  <svg
    viewBox="0 0 16 16"
    className="size-3.5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    aria-hidden
  >
    <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);

const NetworkIcon = (
  <svg
    viewBox="0 0 24 24"
    className="size-3.5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden
  >
    <circle cx="5" cy="6" r="2" />
    <circle cx="19" cy="8" r="2" />
    <circle cx="11" cy="18" r="2" />
    <path d="M7 6.6l10 1.1M6.2 7.9 10 16M17.5 9.6 12.5 16.4" strokeLinecap="round" />
  </svg>
);

const FileIcon = (
  <svg
    viewBox="0 0 24 24"
    className="size-3.5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden
  >
    <path d="M6 3.75h7L18 8.5v11.75H6z" />
    <path d="M12.75 4v5h5" />
    <path d="M9 13h6M9 16.25h4" strokeLinecap="round" />
  </svg>
);

export interface NodeDetailsPanelProps {
  node: NodeOut | null;
  onClose: () => void;
  onInvestigate?: (personEntityId: string) => void;
  onOpenFir?: (firId: number) => void;
  className?: string;
}

export function NodeDetailsPanel({
  node,
  onClose,
  onInvestigate,
  onOpenFir,
  className,
}: NodeDetailsPanelProps): ReactElement | null {
  // `getPersonAnalytics` takes the NUMERIC row id — `person:445` in a path
  // segment is an HTTP 422. The null result of the conversion is what gates the
  // request, so a non-person node never issues one.
  const personId = node ? personIdFromEntityId(node.entity_id) : null;
  const isPerson = node?.entity_type === 'PERSON';

  const metrics = useAsync(
    (signal) => api.getPersonAnalytics(personId as number, { signal }),
    [personId],
    { enabled: isPerson && personId !== null },
  );

  const attributes = node?.attributes;

  const attributeRows = useMemo(
    () =>
      flattenScalars(attributes)
        .filter(([key]) => !OVERLAY_ATTRIBUTE_KEYS.includes(key))
        .map(([key, value]) => ({
          key,
          label: humanizeToken(key),
          value: formatAttributeValue(attributes, key, value),
        })),
    [attributes],
  );

  // Presence matters more than value here: `ring_id: null` is the generator
  // saying "this person was not placed in a fabricated ring", which is a real
  // (if non-evidential) statement. `flattenScalars` drops nulls, so the key is
  // read directly.
  const overlayRows = useMemo(() => {
    if (!attributes) return [] as Array<{ key: string; value: string; isNull: boolean }>;
    return OVERLAY_ATTRIBUTE_KEYS.filter((key) => key in attributes).map((key) => {
      const raw = attributes[key];
      const isNull = raw === null || raw === undefined;
      return { key, value: isNull ? 'null' : String(raw), isNull };
    });
  }, [attributes]);

  if (!node) return null;

  const style = entityStyle(node.entity_type);
  const firId = firIdFromEntityId(node.entity_id);

  // `useAsync` keeps the previous response while the next one is in flight, so
  // the payload is matched against the node on screen before it is rendered.
  // Showing person A's centrality under person B's name would be a lie.
  const analytics = metrics.data?.entity_id === node.entity_id ? metrics.data : null;
  const interpretation = analytics?.interpretation;
  const basis = readRecord(interpretation, 'basis');

  const showInvestigate = isPerson && Boolean(onInvestigate);
  const showOpenFir = node.entity_type === 'FIR' && firId !== null && Boolean(onOpenFir);
  const hasActions = showInvestigate || showOpenFir;

  return (
    <Panel
      as="aside"
      // h-full + min-h-0 keeps the body the only scroller, so the header and the
      // action footer never move when the metrics block resolves.
      className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}
    >
      <PanelHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <EntityBadge entityType={node.entity_type} />
            <span className="truncate" title={node.label}>
              {node.label}
            </span>
          </span>
        }
        subtitle={style.hint}
        actions={<IconButton label="Close" icon={CloseIcon} variant="ghost" onClick={onClose} />}
      />

      <PanelBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {/* ---------------------------------------------------- identity -- */}
        <ProvenanceTag provenance={provenanceOf({ source_dataset: node.source_dataset })} />

        <KeyValueList className="mt-3">
          <KeyValueRow
            label="Entity ID"
            value={<Mono className="break-all">{node.entity_id}</Mono>}
            wrap
            hint="The graph's own prefixed identifier. Query parameters and relationship ids use this form; URL path parameters take the bare numeric row id."
          />
          <KeyValueRow label="Entity type" value={style.label} mono hint={style.hint} />
          <KeyValueRow
            label="Source dataset"
            value={node.source_dataset ? <Mono>{node.source_dataset}</Mono> : '—'}
            wrap
            hint="The synthetic dataset table this entity was materialised from."
          />
          <KeyValueRow
            label="Source record ID"
            value={
              node.source_record_id ? (
                <Mono className="break-all">{node.source_record_id}</Mono>
              ) : (
                '—'
              )
            }
            wrap
            hint="Points at the exact row in the original synthetic dataset this entity was built from — read it as table:row_id. It is how anything on this panel can be traced back to a source record."
          />
        </KeyValueList>

        {/* -------------------------------------------------- attributes -- */}
        <Divider label="Recorded attributes" className="mt-4" />

        {attributeRows.length > 0 ? (
          <KeyValueList className="mt-3" dense>
            {attributeRows.map((row) => (
              <KeyValueRow key={row.key} label={row.label} value={row.value} mono wrap />
            ))}
          </KeyValueList>
        ) : (
          <EmptyState
            title="No further attributes"
            description="The graph carries no additional column values for this entity beyond the identity above."
            className="mt-3"
          />
        )}

        {/* ------------------------------------ ground-truth overlay row -- */}
        {overlayRows.length > 0 ? (
          <div className="border-overlay/35 bg-overlay/10 mt-4 rounded-md border border-dashed px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <ProvenanceTag provenance="overlay" />
              <span className="field-label">Synthetic data only</span>
            </div>
            <KeyValueList className="mt-2.5" dense>
              {overlayRows.map((row) => (
                <KeyValueRow
                  key={row.key}
                  label={humanizeToken(row.key)}
                  value={<Mono>{row.value}</Mono>}
                  wrap
                  tone="muted"
                />
              ))}
            </KeyValueList>
            <p className="text-ink-3 mt-2.5 text-2xs leading-relaxed">
              This is the data generator's own ground-truth label for the fabricated ring it placed
              this person into. It is present only because the dataset is synthetic. It is not
              evidence, and no analytic in this system reads it — nothing anywhere in this interface
              is ranked, clustered, filtered or coloured by it. A real case file has no such column.
              {overlayRows.some((row) => row.isNull)
                ? ' A null value means the generator did not place this person in any ring.'
                : null}
            </p>
          </div>
        ) : null}

        {/* --------------------------------------- structural position -- */}
        {isPerson && personId !== null ? (
          <>
            <Divider label="Structural position" className="mt-5" />

            {metrics.status === 'error' ? (
              // A failed metrics call must not take the identity block above it
              // down with it: it is a separate request with a separate answer.
              <ErrorState
                error={metrics.error}
                onRetry={metrics.retry}
                title="Structural metrics unavailable"
                compact
                className="mt-3"
              />
            ) : analytics ? (
              <>
                <KeyValueList className="mt-3" dense>
                  <KeyValueRow
                    label="Degree"
                    value={formatCount(analytics.degree)}
                    mono
                    hint="How many distinct other persons this person is directly connected to in the observed network."
                  />
                  <KeyValueRow
                    label="Degree centrality"
                    value={formatMetric(analytics.degree_centrality)}
                    mono
                    hint="Degree expressed as a share of the maximum possible, which makes it comparable across networks of different sizes."
                  />
                  <KeyValueRow
                    label="Weighted degree"
                    value={formatMetric(analytics.weighted_degree)}
                    mono
                    hint="Degree with each connection counted by its edge weight rather than once, so repeated contact counts for more than a single contact."
                  />
                  <KeyValueRow
                    label="PageRank"
                    value={formatMetric(analytics.pagerank, 6)}
                    mono
                    hint="Importance by association: a person connected to well-connected people scores higher than one connected to isolated people. The same family of algorithm search engines use to rank pages."
                  />
                  <KeyValueRow
                    label="Betweenness"
                    value={formatMetric(analytics.betweenness, 6)}
                    mono
                    hint="How often this person sits on the shortest route between two others. A high value means the observed network would fall into separate pieces without them — the structural signature of a broker or go-between position."
                  />
                  <KeyValueRow
                    label="Community ID"
                    value={formatMetric(analytics.community_id)}
                    mono
                    hint="Label of the densely interconnected group this person falls into, from the deterministic community-detection run over the observed graph. It is a grouping, not a ranking."
                  />
                  <KeyValueRow
                    label="Component ID"
                    value={formatMetric(analytics.component_id)}
                    mono
                    hint="Which connected chunk of the graph this person belongs to. Two persons in different components have no path between them at all in the observed data."
                  />
                </KeyValueList>

                {/* The backend supplies its own plain-language reading of these
                    numbers; it is surfaced verbatim rather than paraphrased. */}
                {interpretation?.label || interpretation?.text || interpretation?.disclaimer ? (
                  <div className="bg-inset border-line mt-3 rounded-md border px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="field-label">Backend reading</span>
                      {interpretation.label ? (
                        <Badge tone="neutral">{humanizeToken(interpretation.label)}</Badge>
                      ) : null}
                      {interpretation.is_investigation_lead ? (
                        <Badge
                          tone="cyan"
                          title="The backend's own flag, set by percentile threshold on the metrics above. It marks a lead worth examining, nothing more."
                        >
                          Investigation lead
                        </Badge>
                      ) : null}
                    </div>
                    {interpretation.text ? (
                      <p className="text-ink-2 mt-2 text-xs leading-relaxed">
                        {interpretation.text}
                      </p>
                    ) : null}
                    {basis ? (
                      <KeyValueList className="mt-2.5" dense>
                        {flattenScalars(basis).map(([key, value]) => (
                          <KeyValueRow
                            key={key}
                            label={humanizeToken(key)}
                            value={formatBasisValue(basis, key, value)}
                            mono
                            tone="muted"
                            hint={
                              key.includes('percentile')
                                ? 'Where this person sits relative to every other person in the observed graph on that metric. 100% means top-ranked.'
                                : undefined
                            }
                          />
                        ))}
                      </KeyValueList>
                    ) : null}
                    {interpretation.disclaimer ? (
                      <p className="text-ink-3 mt-2.5 text-2xs leading-relaxed">
                        {interpretation.disclaimer}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* The one caveat this panel states in its own voice. */}
                <p className="text-ink-3 mt-3 text-2xs leading-relaxed">
                  These figures describe this person's structural position in the observed network —
                  how the recorded calls, transfers, FIRs and shared locations happen to be arranged
                  around them. They are not a risk score, not a probability, and not a measure of
                  guilt. A person can score highly for entirely lawful reasons, and a person central
                  to an offence can score low when the relevant records were never captured.
                </p>
              </>
            ) : (
              <SkeletonText lines={6} className="mt-3" />
            )}
          </>
        ) : null}
      </PanelBody>

      {/* Actions sit outside the scroll area so they stay reachable while the
          operator scrolls a long attribute list. */}
      {hasActions ? (
        <div className="border-line flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {showInvestigate ? (
            <Button
              variant="primary"
              size="sm"
              icon={NetworkIcon}
              onClick={() => onInvestigate?.(node.entity_id)}
            >
              Investigate this network
            </Button>
          ) : null}
          {showOpenFir && firId !== null ? (
            <Button variant="primary" size="sm" icon={FileIcon} onClick={() => onOpenFir?.(firId)}>
              Open in FIR Intelligence
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
