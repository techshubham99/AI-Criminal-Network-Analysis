/**
 * EdgeEvidencePanel — "why does the system believe this link exists?"
 *
 * A line between two nodes is an assertion. This panel is where that assertion
 * has to justify itself: which dataset rows it was derived from, how many of
 * them, over what dates, with what rule-assigned confidence, and — for
 * narrative-derived links — the exact sentence of FIR text that produced it.
 *
 * Three correctness points that shape the whole component:
 *
 *  1. The caller already holds a complete `EdgeOut`. The panel therefore renders
 *     immediately from the prop and treats
 *     `GET /graph/relationships/{relationship_id}` as *enrichment*. Visible truth
 *     is never blanked out while that request is in flight — a spinner sits next
 *     to the header instead.
 *  2. Narrative edges live in a SEPARATE narrative graph and are not in the
 *     structured relationship store, so the enrichment request would 404 for
 *     them. `isNarrativeRelationshipId` skips it entirely; their evidence is the
 *     quoted FIR text carried in `attributes`.
 *  3. An edge has NO scalar `source_record_id`. Its provenance is the `evidence`
 *     array of `dataset:record_id` citations, whose length is `evidence_count`.
 *     Nothing here looks for a field that does not exist.
 */
import type { ReactElement } from 'react';
import { api } from '@/api';
import type { EdgeOut } from '@/types/api';
import { useAsync } from '@/hooks/useAsync';
import {
  ConfidenceMeter,
  Divider,
  EmptyState,
  ErrorState,
  IconButton,
  InfoHint,
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  RelationshipBadge,
  Spinner,
  provenanceOf,
} from '@/components/ui';
import { isNarrativeRelationshipId, relationshipStyle } from '@/utils/entity';
import {
  formatCount,
  formatDateRange,
  formatDateTime,
  formatDuration,
  formatInr,
  formatMetric,
  humanizeToken,
} from '@/utils/format';
import { flattenScalars, readNumber, readString } from '@/utils/records';
import { cn } from '@/utils/cn';

/**
 * What "direction" actually means for each relationship type. Written out per
 * type because "source → target" is meaningless on its own: on a CALLED edge it
 * is who dialled, on a TRANSACTED edge it is who paid, and on a CO_LOCATED edge
 * it means nothing at all.
 */
const DIRECTION_NOTES: Record<string, string> = {
  CALLED:
    'Directed: the source placed the call and the target received it. Reversing the arrow would reverse who dialled whom.',
  TRANSACTED:
    'Directed: money moved from the source (sender) to the target (receiver). The arrow is the direction of funds.',
  REPORTED_AGAINST:
    'Directed: the source is the complainant who named the target as the accused in an FIR. This records an allegation that was filed — it is not a finding of guilt.',
  NAMED_IN_FIR:
    'Directed: the person is the source and the FIR record is the target. The role attribute below says whether they appear as complainant or accused.',
  OWNS_PHONE:
    'Directed: the person record on the source side lists the phone number on the target side as its own.',
  OWNS_AADHAAR:
    'Directed: the person record on the source side lists the Aadhaar number on the target side as its own.',
  LOCATED_AT:
    'Directed: the subject on the source side is associated with the location record on the target side.',
  CO_LOCATED:
    'Undirected: the two persons are registered to the same location record. Neither side did anything to the other — this link is derived from a shared column value, which makes it weak evidence by design.',
  USED_TOWER:
    'Directed: a call involving the person on the source side was routed through the cell tower on the target side.',
  SAME_RING:
    'Undirected: this is the synthetic generator’s own ring label, not an observed interaction.',
  ASSOCIATED_WITH:
    'Undirected in meaning: the narrative text placed these two together without saying who acted on whom.',
  MET: 'Symmetric by nature: the narrative records that the two met.',
  TRANSFERRED_TO:
    'Directed: the narrative text describes value moving from the source to the target.',
};

/** Hints for the open `attributes` dict keys this backend actually emits. */
const ATTRIBUTE_HINTS: Record<string, string> = {
  role: 'How the person appears on the FIR record — complainant or accused. An accused role is a filed allegation, not a determination.',
  shared_location_id:
    'The location record both persons are registered to. This shared id is the entire basis of a CO_LOCATED link.',
  subject_type: 'The entity type on the subject side of this link.',
  fir_date: 'Date carried on the FIR record this link was derived from.',
  extraction_method:
    'The deterministic rule that fired to assert this link from narrative text. No trained model and no external service is involved.',
  character_start:
    'Character offset where the quoted phrase begins in the FIR narrative, so the assertion can be located in the original text.',
  character_end: 'Character offset where the quoted phrase ends in the FIR narrative.',
  source_mention: 'The exact surface text in the narrative that was matched to the source entity.',
  target_mention: 'The exact surface text in the narrative that was matched to the target entity.',
  target_bound_via: 'How the extraction rule decided which entity the phrase referred to.',
  proximity: 'The proximity word the rule matched, e.g. “near”.',
  contributing_firs: 'FIR row ids that contributed to this link.',
};

/** Hints for the open `weight_detail` dict keys this backend actually emits. */
const WEIGHT_DETAIL_HINTS: Record<string, string> = {
  count: 'How many individual source records were aggregated into this single edge.',
  total_duration_sec: 'Total call time across every aggregated call record.',
  total_amount_inr: 'Total value moved across every aggregated transaction record.',
  fir_count: 'How many FIRs carry this same complainant-and-accused pair.',
};

/**
 * Attribute keys whose value is quoted source text. They are lifted out of the
 * key/value stack and given a blockquote of their own — a sentence of FIR
 * narrative is the most persuasive item on this panel and must not be truncated
 * into a table cell.
 */
const QUOTE_KEYS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: 'evidence_text',
    label: 'Quoted from the FIR narrative',
    hint: 'The span of FIR narrative text this link was extracted from, reproduced verbatim.',
  },
  {
    key: 'trigger_text',
    label: 'Trigger phrase',
    hint: 'The specific phrase inside the quoted span that caused the extraction rule to fire.',
  },
  {
    key: 'trigger_phrase',
    label: 'Trigger phrase',
    hint: 'The specific phrase inside the quoted span that caused the extraction rule to fire.',
  },
];

/**
 * Reformat one open-dict value by the *name* of its key — never by sniffing the
 * value, so a plain count can never be rendered as rupees. `flattenScalars` has
 * already stringified everything; the raw number is re-read only when a
 * unit-aware formatter needs it.
 */
function formatDetailValue(
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

/** The connector between the two endpoint ids: arrowed when directed, a plain
 *  rule when not. Dashed for derived/narrative types, matching the graph edges
 *  and the RelationshipBadge, so the same visual language means the same thing
 *  everywhere. Colour is a runtime palette value, so it goes in `style`. */
function Connector({ color, dashed, directed }: { color: string; dashed: boolean; directed: boolean }) {
  const dash = dashed ? '4 3' : undefined;
  return (
    <svg viewBox="0 0 36 8" className="h-2 w-9 shrink-0" aria-hidden>
      <line
        x1="0"
        y1="4"
        x2={directed ? 27 : 36}
        y2="4"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={dash}
      />
      {directed ? <path d="M27 0.5 35.5 4 27 7.5Z" fill={color} /> : null}
    </svg>
  );
}

export interface EdgeEvidencePanelProps {
  edge: EdgeOut | null;
  onClose: () => void;
  className?: string;
}

export function EdgeEvidencePanel({
  edge,
  onClose,
  className,
}: EdgeEvidencePanelProps): ReactElement | null {
  const relationshipId = edge?.relationship_id ?? null;
  // Narrative relationship ids are not in the structured store — asking for one
  // is a guaranteed 404, so the request is never issued for them.
  const isNarrative = isNarrativeRelationshipId(relationshipId);

  const enrichment = useAsync(
    (signal) => api.getRelationship(relationshipId as string, { signal }),
    [relationshipId],
    { enabled: relationshipId !== null && !isNarrative },
  );

  if (!edge) return null;

  // Only adopt an enrichment payload that belongs to the edge on screen:
  // `useAsync` keeps the previous response while the next is in flight.
  const enriched =
    enrichment.data && enrichment.data.relationship_id === edge.relationship_id
      ? enrichment.data
      : null;
  const view: EdgeOut = enriched ?? edge;

  const style = relationshipStyle(view.relationship_type);
  const provenance = provenanceOf(view);
  const citations = view.evidence ?? [];
  const hasDates = Boolean(view.date_first || view.date_last);

  // flatMap rather than map+filter so the narrowed `text: string` survives
  // without a cast.
  const quotes = QUOTE_KEYS.flatMap((quote) => {
    const text = readString(view.attributes, quote.key);
    return text ? [{ ...quote, text }] : [];
  });

  const quotedKeys = new Set(QUOTE_KEYS.map((quote) => quote.key));
  const attributeRows = flattenScalars(view.attributes).filter(([key]) => !quotedKeys.has(key));
  const weightDetailRows = flattenScalars(view.weight_detail);

  const notFound = enrichment.error?.status === 404;
  const enrichmentFailed = enrichment.status === 'error' && !notFound;

  return (
    // The root carries the test id; Panel is the surface inside it. h-full plus
    // min-h-0 makes the body the only scroller, so the header does not move when
    // enrichment lands and changes the content height.
    <div
      data-testid="edge-evidence-panel"
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <Panel as="aside" className="flex h-full min-h-0 flex-col overflow-hidden">
        <PanelHeader
          title={
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <RelationshipBadge relationshipType={view.relationship_type} />
              <span>Evidence</span>
            </span>
          }
          subtitle={style.hint}
          actions={
            <>
              {enrichment.isLoading ? <Spinner label="Loading provenance record" /> : null}
              <IconButton label="Close" icon={CloseIcon} variant="ghost" onClick={onClose} />
            </>
          }
        />

        <PanelBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {/* ------------------------------------------------- provenance -- */}
          <div className="flex flex-wrap items-center gap-2">
            <ProvenanceTag provenance={provenance} />
          </div>

          {view.is_overlay ? (
            // This UI always requests include_overlay=false, so an overlay edge
            // should never arrive here. If one does, say so rather than let it
            // pass as evidence.
            <div className="border-warn-400/40 bg-warn-900/30 mt-3 rounded-md border px-3 py-2.5">
              <p className="text-warn-300 text-xs font-semibold">
                Synthetic ground-truth link, not observed evidence
              </p>
              <p className="text-ink-2 mt-1.5 text-2xs leading-relaxed">
                This edge is flagged <Mono>is_overlay = true</Mono>, which means it comes from the
                data generator’s own ring label rather than from any recorded interaction. This
                interface requests the graph with overlay edges excluded, so it should not be here at
                all. Nothing in this system treats it as evidence.
              </p>
            </div>
          ) : null}

          {/* -------------------------------------------------- direction -- */}
          <div className="inset mt-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Mono className="break-all">{view.source_entity_id}</Mono>
              <span className="sr-only">{view.directed ? 'directed to' : 'connected with'}</span>
              <Connector color={style.color} dashed={style.dashed} directed={view.directed} />
              <Mono className="break-all">{view.target_entity_id}</Mono>
            </div>
            <p className="text-ink-3 mt-2 text-2xs leading-relaxed">
              {DIRECTION_NOTES[view.relationship_type.toUpperCase()] ??
                (view.directed
                  ? 'Directed: the graph records this link from the source entity to the target entity, in that order.'
                  : 'Undirected: the graph records this link between the two entities without a direction.')}
            </p>
          </div>

          {/* --------------------------------------- enrichment reporting -- */}
          {isNarrative ? (
            <div className="border-narrative/35 bg-narrative/10 mt-3 rounded-md border border-dashed px-3 py-2.5">
              <ProvenanceTag provenance="narrative" />
              <p className="text-ink-2 mt-2 text-2xs leading-relaxed">
                The evidence for this link is the FIR narrative text it was extracted from, quoted
                below. It is held in a separate narrative graph and was never merged into the
                structured graph, so there is no structured relationship record to look up for it —
                this panel deliberately does not ask for one.
              </p>
            </div>
          ) : notFound ? (
            <p className="text-ink-3 mt-3 text-2xs leading-relaxed">
              The relationship store returned no additional provenance record for this id (HTTP 404).
              Everything below is the edge exactly as the graph returned it — nothing has been
              dropped, and nothing has been added.
            </p>
          ) : enrichmentFailed ? (
            <ErrorState
              error={enrichment.error}
              onRetry={enrichment.retry}
              title="Provenance lookup failed"
              compact
              className="mt-3"
            />
          ) : null}

          {/* ----------------------------------------------- quoted text -- */}
          {quotes.length > 0 ? (
            <>
              <Divider label="Quoted source text" className="mt-4" />
              {quotes.map((quote) => (
                <div key={quote.key} className="mt-3">
                  <p className="field-label flex items-center gap-1.5">
                    <span>{quote.label}</span>
                    <InfoHint content={quote.hint} />
                  </p>
                  <blockquote className="inset text-ink-2 mt-1.5 px-3 py-2.5 font-mono text-xs leading-relaxed break-words">
                    “{quote.text}”
                  </blockquote>
                </div>
              ))}
            </>
          ) : null}

          {/* --------------------------------------------------- evidence -- */}
          <Divider label="Provenance" className="mt-4" />

          <KeyValueList className="mt-3">
            <KeyValueRow
              label="Relationship ID"
              value={<Mono className="break-all">{view.relationship_id}</Mono>}
              wrap
              hint="The graph's composite identifier for this link, e.g. CALLED~person:141~person:189. It is what the relationship lookup endpoint takes verbatim."
            />
            <KeyValueRow
              label="Source dataset"
              value={<Mono>{view.source_dataset}</Mono>}
              wrap
              hint="The synthetic dataset this link was derived from. fir_text means it came from narrative prose rather than a structured table."
            />
            <KeyValueRow
              label="Date range"
              value={hasDates ? formatDateRange(view.date_first, view.date_last) : 'Not recorded'}
              mono={hasDates}
              wrap
              tone={hasDates ? 'default' : 'muted'}
              hint="First and last dates across the source records behind this link. Some link types — CO_LOCATED, OWNS_PHONE — carry no date at all, and the graph reports null rather than a guess."
            />
            <KeyValueRow
              label="Evidence count"
              value={formatCount(view.evidence_count)}
              mono
              hint="The number of underlying source records aggregated into this single edge. Ten calls between the same two people are one edge with an evidence count of ten."
            />
            <KeyValueRow
              label="Weight"
              value={formatMetric(view.weight)}
              mono
              hint="The graph builder's aggregate strength for this link, derived from the underlying records shown under weight detail. Comparable between links of the same type; not a probability, and not comparable across different relationship types."
            />
            <KeyValueRow
              label="Provenance confidence"
              value={<ConfidenceMeter value={view.provenance_confidence} />}
              hint="A rule-assigned tier that reflects how directly the data source states this link — a fixed constant chosen per source type, not the output of any model and not a calibrated probability."
            />
          </KeyValueList>

          {/* -------------------------------------------------- citations -- */}
          <div className="mt-4">
            <p className="field-label flex items-center gap-1.5">
              <span>Source record citations</span>
              <InfoHint content="Each citation is a dataset:record_id pointer to the exact row in the original synthetic dataset this link was derived from. An edge has no single source record field — this list is its provenance, and its length is the evidence count above." />
            </p>
            {citations.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {citations.map((citation) => (
                  <li key={citation}>
                    <Mono className="break-all">{citation}</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No citations returned"
                description="The graph returned this link without an evidence list. Nothing can be traced back to a source row from here — treat the link as unverified until the backend reports its citations."
                className="mt-2"
              />
            )}
          </div>

          {/* ------------------------------------------------ weight detail -- */}
          {weightDetailRows.length > 0 ? (
            <>
              <Divider label="Weight detail" className="mt-4" />
              <KeyValueList className="mt-3" dense>
                {weightDetailRows.map(([key, value]) => (
                  <KeyValueRow
                    key={key}
                    label={humanizeToken(key)}
                    value={formatDetailValue(view.weight_detail, key, value)}
                    mono
                    wrap
                    hint={WEIGHT_DETAIL_HINTS[key]}
                  />
                ))}
              </KeyValueList>
            </>
          ) : null}

          {/* -------------------------------------------------- attributes -- */}
          {attributeRows.length > 0 ? (
            <>
              <Divider label="Attributes" className="mt-4" />
              <KeyValueList className="mt-3" dense>
                {attributeRows.map(([key, value]) => (
                  <KeyValueRow
                    key={key}
                    label={humanizeToken(key)}
                    value={formatDetailValue(view.attributes, key, value)}
                    mono
                    wrap
                    hint={ATTRIBUTE_HINTS[key]}
                  />
                ))}
              </KeyValueList>
            </>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}
