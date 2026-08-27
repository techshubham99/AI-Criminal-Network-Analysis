import type { ReactElement, ReactNode } from 'react';

import {
  Badge,
  ConfidenceMeter,
  EmptyState,
  EntityBadge,
  InfoHint,
  Mono,
  Tooltip,
} from '@/components/ui';
import type { ResolutionOut, ResolvedEntityOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { humanizeToken } from '@/utils/format';

/**
 * EntityTable — every entity the Phase 3 extractor pulled out of one FIR
 * narrative, with what happened when it tried to tie that mention to a node in
 * the structured graph.
 *
 * The honest column here is the last one. Resolution is not always a success:
 * a DATE cannot resolve because no DATE node type is materialised in the graph,
 * and a city/state name can match dozens of location records. The backend
 * explains both cases in its own `reason` string, which is surfaced verbatim in a
 * tooltip — it is a better explanation than anything this UI could invent, and it
 * keeps the interface from implying a certainty the resolver never claimed.
 */

/** Statuses declared in `src/types/api.ts` as `ResolutionStatus`, plus a fallback. */
const STATUS_TONE: Record<string, 'ok' | 'muted' | 'warn' | 'neutral'> = {
  resolved: 'ok',
  not_applicable: 'muted',
  unresolved: 'warn',
  ambiguous: 'warn',
};

const STATUS_LABEL: Record<string, string> = {
  resolved: 'Resolved',
  not_applicable: 'Not applicable',
  unresolved: 'Unresolved',
  ambiguous: 'Ambiguous',
};

function statusTone(status: string): 'ok' | 'muted' | 'warn' | 'neutral' {
  return STATUS_TONE[status] ?? 'neutral';
}

export interface EntityTableProps {
  entities: ResolvedEntityOut[];
  activeEntityIndex?: number | null;
  onActiveEntityChange?: (index: number | null) => void;
  className?: string;
}

export function EntityTable({
  entities,
  activeEntityIndex,
  onActiveEntityChange,
  className,
}: EntityTableProps): ReactElement {
  if (entities.length === 0) {
    return (
      <EmptyState
        title="No entities extracted from this narrative"
        description="The extractor read the narrative and matched none of its rules or patterns. That is a result, not a failure: this corpus contains FIRs whose text names nothing the resolver can anchor."
        className={className}
      />
    );
  }

  return (
    // The table has more columns than a 1024px laptop can show. It scrolls inside
    // whatever box it is given rather than forcing the whole page sideways.
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-[58rem] border-collapse text-left">
        <caption className="sr-only">
          Entities extracted from this FIR narrative, with confidence, character offsets and
          resolution against the structured graph.
        </caption>
        <thead>
          <tr className="border-line border-b">
            <Th>Type</Th>
            <Th>Raw text</Th>
            <Th
              hint="The canonical form the extractor derived from the raw mention — e.g. a phone number stripped of its country-code punctuation. This is the value the resolver matches on."
            >
              Normalized
            </Th>
            <Th
              hint="A fixed tier assigned by the extraction rule that fired, not a trained model's probability and not a calibrated likelihood."
            >
              Confidence
            </Th>
            <Th hint="Which mechanism produced this entity: a regex over the text, a match against a known structured record, or a named rule.">
              Method
            </Th>
            <Th hint="Half-open character offsets [start, end) into this FIR's narrative string. These are the exact indices the highlighter uses, which is why the highlight and the raw text always agree.">
              Span
            </Th>
            <Th hint="Whether the mention was tied to an existing graph entity. 'Not applicable' means the graph has no node type that could hold this value.">
              Resolution
            </Th>
          </tr>
        </thead>
        <tbody>
          {entities.map((item, index) => {
            const { entity, resolution } = item;
            const isActive = activeEntityIndex === index;
            const toggle = () => onActiveEntityChange?.(isActive ? null : index);

            return (
              <tr
                key={`${entity.entity_type}-${entity.character_start}-${entity.character_end}-${index}`}
                onClick={onActiveEntityChange ? toggle : undefined}
                className={cn(
                  'border-line/70 border-b align-top transition-colors last:border-b-0',
                  onActiveEntityChange && 'cursor-pointer',
                  isActive ? 'bg-panel-3' : 'hover:bg-panel-2',
                )}
              >
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <EntityBadge entityType={entity.entity_type} />
                    {entity.role ? (
                      <span className="text-ink-4 text-2xs tracking-wide uppercase">
                        {humanizeToken(entity.role)}
                      </span>
                    ) : null}
                  </div>
                </Td>

                <Td>
                  {/* A real button so the row is keyboard-operable; the row's own
                      onClick is a mouse convenience on top of it. */}
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle();
                    }}
                    className={cn(
                      'rounded-xs text-left text-xs transition-colors',
                      isActive ? 'text-cyan-200' : 'text-ink hover:text-cyan-200',
                    )}
                  >
                    {entity.raw_text}
                  </button>
                </Td>

                <Td>
                  <Mono>{entity.normalized_value}</Mono>
                </Td>

                <Td>
                  <ConfidenceMeter value={entity.confidence} method={entity.extraction_method} />
                </Td>

                <Td>
                  <span className="text-ink-2 font-mono text-2xs">
                    {humanizeToken(entity.extraction_method)}
                  </span>
                </Td>

                <Td>
                  <Mono>
                    {entity.character_start}–{entity.character_end}
                  </Mono>
                </Td>

                <Td>
                  <ResolutionCell resolution={resolution} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Status badge, matched id, and the backend's own explanation behind a tooltip. */
function ResolutionCell({ resolution }: { resolution: ResolutionOut }) {
  const status = resolution.status ?? 'unknown';
  const label = STATUS_LABEL[status] ?? humanizeToken(status);
  const candidateCount = resolution.candidates?.length ?? 0;
  const flagged = resolution.ambiguous === true || candidateCount > 0;

  const explanation: ReactNode = (
    <>
      {resolution.resolution_method ? (
        <>
          Resolution method: <span className="text-cyan-300">{humanizeToken(resolution.resolution_method)}</span>
          {resolution.reason ? '. ' : '.'}
        </>
      ) : null}
      {resolution.reason ? <>Backend reason: “{resolution.reason}”</> : null}
      {!resolution.resolution_method && !resolution.reason
        ? 'The backend reported no method and no reason for this resolution.'
        : null}
      {resolution.evidence && resolution.evidence.length > 0 ? (
        <>
          {' '}
          Cited records: <span className="font-mono">{resolution.evidence.join(', ')}</span>.
        </>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Tooltip content={explanation}>
        <Badge tone={statusTone(status)}>{label}</Badge>
      </Tooltip>

      {resolution.matched_entity_id ? (
        <Mono title={resolution.matched_entity_id}>{resolution.matched_entity_id}</Mono>
      ) : null}

      {typeof resolution.confidence === 'number' ? (
        <ConfidenceMeter
          value={resolution.confidence}
          method={resolution.resolution_method}
          showBar={false}
        />
      ) : null}

      {/* Candidates are shown as a count, never narrowed to a silent winner. */}
      {flagged ? (
        <Tooltip
          content={
            <>
              {resolution.ambiguous === true
                ? 'The resolver marked this mention ambiguous. '
                : ''}
              {candidateCount} candidate record{candidateCount === 1 ? '' : 's'} matched this text.
              {resolution.reason ? <> The backend’s explanation: “{resolution.reason}”</> : null}
            </>
          }
        >
          <Badge tone="warn">
            {candidateCount} candidate{candidateCount === 1 ? '' : 's'}
          </Badge>
        </Tooltip>
      ) : null}
    </div>
  );
}

function Th({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 whitespace-nowrap">
      <span className="field-label flex items-center gap-1.5">
        {children}
        {hint ? <InfoHint content={hint} /> : null}
      </span>
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2.5">{children}</td>;
}
