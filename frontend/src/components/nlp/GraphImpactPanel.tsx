import type { ReactElement, ReactNode } from 'react';

import {
  Badge,
  ConfidenceMeter,
  Divider,
  InfoHint,
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  RelationshipBadge,
  StatInline,
} from '@/components/ui';
import type { GraphAdditionOut, GraphImpactResponse, NarrativeEdgeOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount, formatDateRange, humanizeToken, sortedCounts } from '@/utils/format';
import { flattenScalars, readString } from '@/utils/records';

/**
 * GraphImpactPanel — what narrative extraction did, and did not, do to the graph.
 *
 * This panel exists to make a negative result legible. The Phase 3 verification
 * of this corpus found that narrative extraction adds ZERO new connectivity: the
 * relationships an FIR's text asserts are either already present as structured
 * edges, or they connect entities the structured graph already links by another
 * path. Both outcomes are stated here in plain words, computed from the response —
 * never hardcoded, and never dressed up as a discovery.
 *
 * Two claims are made from the data on every render:
 *   1. whether `structured_graph_mutated` is false, i.e. whether the structured
 *      evidence graph was left untouched;
 *   2. whether every proposal was rejected as a duplicate, i.e. whether the
 *      narrative merely confirmed links the evidence graph already had.
 */

/** Statuses declared in `src/types/api.ts` as `GraphAdditionStatus`. */
function statusTone(status: string): 'ok' | 'muted' | 'warn' | 'neutral' {
  if (status.startsWith('accepted_')) return 'ok';
  // A duplicate rejection is the benign case: the structured graph already knew.
  if (status === 'rejected_duplicate') return 'muted';
  if (status.startsWith('rejected_')) return 'warn';
  return 'neutral';
}

/** Summary keys rendered as tiles; anything else that is a string is an explanation. */
const RENDERED_SUMMARY_KEYS = new Set([
  'extracted_entity_count',
  'resolved_entity_count',
  'unresolved_entity_count',
  'ambiguous_entity_count',
  'validated_relationship_count',
  'proposed_count',
  'accepted_count',
  'rejected_count',
  'by_status',
  'structured_graph_mutated',
]);

export interface GraphImpactPanelProps {
  impact: GraphImpactResponse;
  className?: string;
}

export function GraphImpactPanel({ impact, className }: GraphImpactPanelProps): ReactElement {
  const summary = impact.summary ?? {};
  const proposed = impact.proposed_additions ?? [];
  const accepted = impact.accepted_additions ?? [];
  const rejected = impact.rejected_additions ?? [];
  const narrativeEdges = impact.narrative_edges ?? [];

  const mutated = impact.structured_graph_mutated === true;
  const duplicateRejections = proposed.filter((a) => a.status === 'rejected_duplicate').length;
  const allRejectedAsDuplicate = proposed.length > 0 && duplicateRejections === proposed.length;
  const noneAccepted = proposed.length > 0 && accepted.length === 0;

  const byStatus = sortedCounts(summary.by_status);

  // Any explanatory string the response itself carries, rendered verbatim rather
  // than paraphrased. Only string values are treated as prose.
  const responseNotes = Object.entries(summary)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0 &&
        !RENDERED_SUMMARY_KEYS.has(entry[0]),
    )
    .map(([key, value]) => ({ key, value }));

  return (
    <Panel className={className}>
      <PanelHeader
        title="Graph impact of this narrative"
        subtitle={
          <>
            What the extractor proposed for FIR {impact.fir_id}, what the validator admitted, and
            what it refused. Source record <span className="font-mono">{impact.source_record_id}</span>.
          </>
        }
        actions={<ProvenanceTag provenance="narrative" short />}
      />

      <PanelBody className="space-y-4">
        {/* ---------------------------------------------- the honest statements -- */}
        <div className="space-y-2">
          <Claim tone={mutated ? 'warn' : 'ok'}>
            {mutated ? (
              <>
                The backend reports <Mono>structured_graph_mutated: true</Mono> for this FIR — the
                structured evidence graph was modified. That contradicts this system's stated design,
                and the discrepancy should be investigated before this view is relied on.
              </>
            ) : (
              <>
                The structured evidence graph was <strong className="text-ink font-semibold">not
                modified</strong>. <Mono>structured_graph_mutated: false</Mono>. Narrative-derived
                edges are held in a separate narrative graph, never merged into the observed graph.
              </>
            )}
          </Claim>

          {proposed.length === 0 ? (
            <Claim tone="muted">
              This narrative proposed no relationship to the graph at all, so there is nothing to
              accept or reject. A validated relationship still needs an explicit trigger phrase with
              resolved endpoints before it becomes a proposal.
            </Claim>
          ) : allRejectedAsDuplicate ? (
            <Claim tone="muted">
              Every one of the {formatCount(proposed.length)} relationship
              {proposed.length === 1 ? '' : 's'} this narrative proposed was rejected as a duplicate
              of an existing structured edge. This FIR's narrative{' '}
              <strong className="text-ink font-semibold">
                confirmed links the evidence graph already held and added no new connectivity
              </strong>
              . That is the result, not a shortfall of the extractor.
            </Claim>
          ) : noneAccepted ? (
            <Claim tone="muted">
              None of the {formatCount(proposed.length)} proposal
              {proposed.length === 1 ? '' : 's'} from this narrative was admitted; the validator's
              reason for each refusal is quoted below. No narrative edge was created from this FIR.
            </Claim>
          ) : (
            <Claim tone="ok">
              {formatCount(accepted.length)} of {formatCount(proposed.length)} proposal
              {proposed.length === 1 ? '' : 's'} {accepted.length === 1 ? 'was' : 'were'} admitted to
              the separate narrative graph
              {duplicateRejections > 0 ? (
                <>
                  , and {formatCount(duplicateRejections)}{' '}
                  {duplicateRejections === 1 ? 'was' : 'were'} rejected as already present in the
                  structured graph
                </>
              ) : null}
              . Each addition's own reason is reproduced verbatim below, including whether the two
              entities were already connected structurally — an admitted edge is not by itself a new
              link between people.
            </Claim>
          )}
        </div>

        {/* ------------------------------------------------------------ summary -- */}
        <div className="inset grid grid-cols-1 gap-x-6 gap-y-2 px-3 py-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <StatInline label="Entities extracted" value={formatCount(summary.extracted_entity_count)} />
          <StatInline label="Resolved" value={formatCount(summary.resolved_entity_count)} />
          <StatInline
            label="Unresolved"
            value={formatCount(summary.unresolved_entity_count)}
            hint="Mentions the resolver could not tie to any entity in the structured graph."
          />
          <StatInline
            label="Ambiguous"
            value={formatCount(summary.ambiguous_entity_count)}
            hint="Mentions that matched more than one candidate record and were not silently narrowed to one."
          />
          <StatInline
            label="Validated relationships"
            value={formatCount(summary.validated_relationship_count)}
            hint="Relationships that passed the extraction rules — an explicit trigger phrase with role-bound endpoints."
          />
          <StatInline
            label="Proposed"
            value={formatCount(summary.proposed_count)}
            hint="Validated relationships offered to the graph validator for admission."
          />
          <StatInline label="Accepted" value={formatCount(summary.accepted_count)} />
          <StatInline label="Rejected" value={formatCount(summary.rejected_count)} />
        </div>

        {byStatus.length > 0 ? (
          <div className="space-y-2">
            <p className="field-label flex items-center gap-1.5">
              <span>Validator outcome by status</span>
              <InfoHint content="The validator's own status token for each proposal. 'accepted_additive' means the edge was added to the narrative graph; 'rejected_duplicate' means an equivalent structured edge already existed." />
            </p>
            <ul className="flex flex-wrap items-center gap-2">
              {byStatus.map(([status, count]) => (
                <li key={status}>
                  <Badge tone={statusTone(status)}>
                    {humanizeToken(status)} · {formatCount(count)}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* -------------------------------------------------- proposed additions -- */}
        {proposed.length > 0 ? (
          <section className="space-y-2.5">
            <Divider label={`Proposed additions (${formatCount(proposed.length)})`} />
            <ul className="space-y-2.5">
              {proposed.map((addition, index) => (
                <li key={`${addition.status}-${addition.relationship_id ?? index}`}>
                  <AdditionCard addition={addition} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* The accepted/rejected arrays are the partition of the proposals above;
            they are listed compactly so the split is visible without repeating
            every card in full. */}
        {accepted.length > 0 || rejected.length > 0 ? (
          <section className="space-y-2.5">
            <Divider label="Validator partition of those proposals" />
            <div className="grid gap-2.5 lg:grid-cols-2">
              <AdditionRoster
                heading={`Accepted (${formatCount(accepted.length)})`}
                additions={accepted}
                emptyText="No proposal was accepted."
              />
              <AdditionRoster
                heading={`Rejected (${formatCount(rejected.length)})`}
                additions={rejected}
                emptyText="No proposal was rejected."
              />
            </div>
          </section>
        ) : null}

        {/* ------------------------------------------------------ narrative graph -- */}
        <section className="space-y-2.5">
          <Divider label={`Narrative graph edges (${formatCount(narrativeEdges.length)})`} />
          {narrativeEdges.length === 0 ? (
            <p className="text-ink-3 text-xs leading-relaxed">
              This FIR contributed no edge to the narrative graph — a zero in its own right, not a
              missing value.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {narrativeEdges.map((edge) => (
                <li key={edge.relationship_id}>
                  <NarrativeEdgeCard edge={edge} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {responseNotes.length > 0 ? (
          <section className="space-y-1.5">
            <Divider label="Backend notes" />
            {responseNotes.map((note) => (
              <p key={note.key} className="text-ink-3 text-xs leading-relaxed">
                <span className="field-label mr-1.5">{humanizeToken(note.key)}</span>
                {note.value}
              </p>
            ))}
          </section>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/** A plain-language statement about the data, with a restrained status colour. */
function Claim({ children, tone }: { children: ReactNode; tone: 'ok' | 'muted' | 'warn' }) {
  const tones = {
    ok: 'border-ok-500/30 bg-ok-900/20',
    muted: 'border-line-strong bg-panel-2',
    warn: 'border-warn-400/35 bg-warn-900/20',
  } as const;

  return (
    <p className={cn('text-ink-2 rounded-md border px-3 py-2 text-xs leading-relaxed', tones[tone])}>
      {children}
    </p>
  );
}

function AdditionCard({ addition }: { addition: GraphAdditionOut }) {
  const relationship = addition.relationship;
  const detail = flattenScalars(addition.detail);

  return (
    <article className="border-line bg-panel-2 rounded-lg border px-3.5 py-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(addition.status)}>{humanizeToken(addition.status)}</Badge>
          <RelationshipBadge relationshipType={relationship?.relationship_type} />
        </div>
        {relationship ? (
          <ConfidenceMeter
            value={relationship.confidence}
            method={relationship.extraction_method}
          />
        ) : null}
      </header>

      {relationship ? (
        <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-2xs">
          <Mono>{relationship.source_entity_id ?? 'unresolved'}</Mono>
          <span aria-hidden className="text-ink-4 font-mono">
            {relationship.directed ? '→' : '↔'}
          </span>
          <Mono>{relationship.target_entity_id ?? 'unresolved'}</Mono>
        </p>
      ) : null}

      <p className="text-ink-2 mt-2.5 text-xs leading-relaxed">
        <span className="field-label mr-1.5">Validator reason</span>
        {addition.reason}
      </p>

      <KeyValueList dense className="mt-2.5">
        <KeyValueRow
          label="Accepted"
          value={addition.accepted ? 'Yes' : 'No'}
          tone={addition.accepted ? 'ok' : 'muted'}
        />
        {addition.relationship_id ? (
          <KeyValueRow
            label="Narrative edge ID"
            value={<Mono>{addition.relationship_id}</Mono>}
            hint="Narrative-derived relationship ids are prefixed narr~ and live only in the narrative graph."
            wrap
          />
        ) : null}
        {addition.duplicate_of ? (
          <KeyValueRow
            label="Duplicate of"
            value={<Mono>{addition.duplicate_of}</Mono>}
            hint="The existing structured relationship this proposal restated. Its presence is why the proposal was refused."
            wrap
          />
        ) : null}
        {detail.map(([key, value]) => (
          <KeyValueRow key={key} label={humanizeToken(key)} value={value} mono wrap />
        ))}
      </KeyValueList>
    </article>
  );
}

/** Compact roster of one side of the accepted/rejected partition. */
function AdditionRoster({
  heading,
  additions,
  emptyText,
}: {
  heading: string;
  additions: GraphAdditionOut[];
  emptyText: string;
}) {
  return (
    <div className="border-line bg-panel-2 rounded-lg border px-3 py-2.5">
      <p className="field-label">{heading}</p>
      {additions.length === 0 ? (
        <p className="text-ink-4 mt-1.5 text-xs">{emptyText}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {additions.map((addition, index) => (
            <li
              key={`${addition.status}-${addition.relationship_id ?? addition.duplicate_of ?? index}`}
              className="space-y-1"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={statusTone(addition.status)}>{humanizeToken(addition.status)}</Badge>
                <Mono>{addition.relationship?.source_entity_id ?? 'unresolved'}</Mono>
                <span aria-hidden className="text-ink-4 font-mono text-2xs">
                  {addition.relationship?.directed === false ? '↔' : '→'}
                </span>
                <Mono>{addition.relationship?.target_entity_id ?? 'unresolved'}</Mono>
              </div>
              <p className="text-ink-3 text-2xs leading-relaxed">{addition.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NarrativeEdgeCard({ edge }: { edge: NarrativeEdgeOut }) {
  const extractionMethod = readString(edge.attributes, 'extraction_method');
  const evidenceText = readString(edge.attributes, 'evidence_text');
  const triggerText = readString(edge.attributes, 'trigger_text');

  return (
    <article className="border-line bg-panel-2 rounded-lg border px-3.5 py-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <RelationshipBadge relationshipType={edge.relationship_type} />
          <Mono>{edge.source_entity_id}</Mono>
          <span aria-hidden className="text-ink-4 font-mono text-2xs">
            {edge.directed ? '→' : '↔'}
          </span>
          <Mono>{edge.target_entity_id}</Mono>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceMeter value={edge.provenance_confidence} method={extractionMethod} />
          <ProvenanceTag provenance={edge.is_overlay ? 'overlay' : 'narrative'} short />
        </div>
      </header>

      {triggerText ? (
        <p className="text-ent-phone mt-2.5 font-mono text-2xs">Trigger phrase: “{triggerText}”</p>
      ) : null}

      {evidenceText ? (
        <blockquote className="inset text-ink-2 mt-2 px-3 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap">
          {evidenceText}
        </blockquote>
      ) : null}

      <KeyValueList dense className="mt-2.5">
        <KeyValueRow label="Relationship ID" value={<Mono>{edge.relationship_id}</Mono>} wrap />
        <KeyValueRow
          label="Provenance confidence"
          value={edge.provenance_confidence.toFixed(2)}
          hint="The rule tier the extraction rule assigned to this assertion. It is a fixed constant per rule, not a calibrated probability."
          mono
        />
        <KeyValueRow label="Weight" value={edge.weight} mono />
        <KeyValueRow label="Source dataset" value={<Mono>{edge.source_dataset}</Mono>} />
        <KeyValueRow
          label="Held in"
          value={edge.is_narrative ? 'Narrative graph (separate)' : 'Structured graph'}
          tone="cyan"
        />
        <KeyValueRow
          label="Date range"
          value={formatDateRange(edge.date_first, edge.date_last)}
          mono
        />
        {edge.evidence && edge.evidence.length > 0 ? (
          <KeyValueRow
            label="Evidence"
            value={<Mono>{edge.evidence.join(', ')}</Mono>}
            hint="An edge has no single source_record_id: its provenance is this list of dataset:record_id citations."
            wrap
          />
        ) : null}
      </KeyValueList>
    </article>
  );
}
