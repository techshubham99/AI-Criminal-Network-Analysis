import type { ReactElement } from 'react';

import {
  Badge,
  ConfidenceMeter,
  EmptyState,
  InfoHint,
  KeyValueList,
  KeyValueRow,
  Mono,
  ProvenanceTag,
  RelationshipBadge,
} from '@/components/ui';
import type { RelationshipOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { humanizeToken } from '@/utils/format';
import { flattenScalars, readString } from '@/utils/records';

/**
 * RelationshipList — the relationships the extractor asserted from FIR free text.
 *
 * Every card here is NARRATIVE-DERIVED and is tagged as such. None of them is an
 * observation: each is a claim the text makes, admitted only because an explicit
 * trigger phrase fired a named rule with role-bound endpoints. Two people
 * appearing in the same FIR is never sufficient, and the backend's own note on
 * the response says so.
 *
 * The card is built so a reviewer can audit the claim end to end: the human
 * reading (mention → mention), the resolved graph ids underneath, the rule that
 * fired, the trigger phrase that fired it, and the quoted sentence with the
 * character offsets it came from.
 */

export interface RelationshipListProps {
  relationships: RelationshipOut[];
  className?: string;
}

export function RelationshipList({
  relationships,
  className,
}: RelationshipListProps): ReactElement {
  if (relationships.length === 0) {
    return (
      <EmptyState
        title="No relationships asserted by this narrative"
        description="The extractor found no explicit trigger phrase with role-bound endpoints in this text. Co-occurrence in the same FIR is deliberately not treated as a relationship, so an empty list here is the correct answer rather than a gap."
        className={className}
      />
    );
  }

  return (
    <ul className={cn('space-y-3', className)}>
      {relationships.map((relationship, index) => (
        <li
          key={`${relationship.relationship_type}-${relationship.character_start}-${relationship.character_end}-${index}`}
        >
          <RelationshipCard relationship={relationship} />
        </li>
      ))}
    </ul>
  );
}

function RelationshipCard({ relationship }: { relationship: RelationshipOut }) {
  const attributes = relationship.attributes;
  const triggerText = readString(attributes, 'trigger_text');
  // trigger_text is promoted to its own row above; the rest of the rule's
  // metadata is listed verbatim so nothing the backend sent is hidden.
  const otherAttributes = flattenScalars(attributes).filter(([key]) => key !== 'trigger_text');

  return (
    <article className="border-line bg-panel-2 rounded-lg border">
      <header className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <RelationshipBadge relationshipType={relationship.relationship_type} />
          <Badge tone="muted" title={relationship.directed ? 'Directed edge' : 'Undirected edge'}>
            {relationship.directed ? 'Directed' : 'Undirected'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceMeter
            value={relationship.confidence}
            method={relationship.extraction_method}
          />
          <ProvenanceTag provenance="narrative" short />
        </div>
      </header>

      <div className="space-y-3 px-3.5 py-3">
        {/* The human reading: what the sentence says, in the sentence's words. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-ink font-medium">{relationship.source_mention}</span>
          <span aria-hidden className="text-ink-4 font-mono">
            {relationship.directed ? '→' : '↔'}
          </span>
          <span className="text-ink font-medium">{relationship.target_mention}</span>
        </div>

        {/* The machine reading: which graph entities those mentions became. */}
        <div className="grid gap-2 sm:grid-cols-2">
          <EndpointBox
            role="Source"
            mention={relationship.source_mention}
            entityId={relationship.source_entity_id}
            resolved={relationship.source_resolved}
          />
          <EndpointBox
            role="Target"
            mention={relationship.target_mention}
            entityId={relationship.target_entity_id}
            resolved={relationship.target_resolved}
          />
        </div>

        <figure className="space-y-1.5">
          <figcaption className="field-label flex items-center gap-1.5">
            <span>Quoted evidence</span>
            <InfoHint content="The exact narrative substring the rule matched, with the half-open character offsets it occupies in this FIR's narrative." />
          </figcaption>
          <blockquote className="inset text-ink-2 px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {relationship.evidence_text}
          </blockquote>
          <p className="text-ink-4 font-mono text-2xs">
            characters {relationship.character_start}–{relationship.character_end}
          </p>
        </figure>

        {triggerText ? (
          <div className="border-narrative/35 bg-narrative/8 rounded-md border px-3 py-2">
            <p className="field-label flex items-center gap-1.5">
              <span>Trigger phrase</span>
              <InfoHint content="The phrase in the narrative that fired this extraction rule. Without an explicit trigger like this, the relationship is not asserted at all." />
            </p>
            <p className="text-ent-phone mt-1 font-mono text-xs">“{triggerText}”</p>
          </div>
        ) : null}

        <KeyValueList dense>
          <KeyValueRow
            label="Extraction rule"
            value={humanizeToken(relationship.extraction_method)}
            hint="The named deterministic rule that produced this relationship. No external model API is involved."
          />
          <KeyValueRow
            label="Source dataset"
            value={<Mono>{relationship.source_dataset}</Mono>}
            hint="fir_text means the claim comes from narrative prose rather than a structured table column."
          />
          <KeyValueRow
            label="Source record ID"
            value={<Mono>{relationship.source_record_id}</Mono>}
            hint="The dataset:record_id citation this assertion is traceable to — the FIR row whose narrative was read."
          />
          <KeyValueRow label="FIR" value={<Mono>fir:{relationship.fir_id}</Mono>} />
          {otherAttributes.map(([key, value]) => (
            <KeyValueRow key={key} label={humanizeToken(key)} value={value} mono wrap />
          ))}
        </KeyValueList>
      </div>
    </article>
  );
}

/**
 * One endpoint of the assertion. An unresolved side is stated plainly: the
 * mention exists in the text but could not be tied to a known entity, so the
 * relationship cannot be placed in the graph on that side.
 */
function EndpointBox({
  role,
  mention,
  entityId,
  resolved,
}: {
  role: 'Source' | 'Target';
  mention: string;
  entityId: string | null | undefined;
  resolved: boolean;
}) {
  return (
    <div className="inset px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="field-label">{role}</span>
        <Badge tone={resolved ? 'ok' : 'warn'}>{resolved ? 'Resolved' : 'Unresolved'}</Badge>
      </div>
      <p className="text-ink-3 mt-1.5 truncate text-2xs" title={mention}>
        “{mention}”
      </p>
      {entityId ? (
        <Mono className="mt-1 inline-block" title={entityId}>
          {entityId}
        </Mono>
      ) : (
        <p className="text-warn-300 mt-1 text-2xs leading-snug">
          This mention could not be tied to a known entity, so it has no graph id.
        </p>
      )}
    </div>
  );
}
