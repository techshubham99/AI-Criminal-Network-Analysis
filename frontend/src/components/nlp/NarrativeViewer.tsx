import { useMemo } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ProvenanceTag } from '@/components/ui';
import type { EntityOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { entityColor, entityStyle } from '@/utils/entity';

/**
 * NarrativeViewer — the FIR narrative with the machine's reading laid over it.
 *
 * This is the most persuasive artefact on the FIR page: the investigator reads
 * the original text and sees, in place, exactly which characters the extractor
 * claimed as an entity. Nothing is paraphrased and nothing is summarised.
 *
 * Three rules govern the rendering, and all three exist to protect the text:
 *
 *  1. VERBATIM. Every character between highlights is emitted untouched, and the
 *     highlighted characters are the narrative's own substring — never the
 *     entity's `raw_text`, which could differ if offsets ever drifted.
 *  2. NO DOUBLE-WRAPPING. Spans are sorted by start offset and any span that
 *     begins inside a span already emitted is skipped. Overlapping offsets would
 *     otherwise either duplicate or silently delete text.
 *  3. CLAMPED. Offsets are clamped into the string, so a bad offset degrades to a
 *     missing highlight rather than a thrown range.
 *
 * Offsets come from `character_start` / `character_end` on `EntityOut`, which are
 * half-open [start, end) indices into `narrative`.
 */

export interface NarrativeViewerProps {
  narrative: string;
  entities: EntityOut[];
  activeEntityIndex?: number | null;
  onActiveEntityChange?: (index: number | null) => void;
  className?: string;
}

interface Span {
  /** Index into the `entities` prop as given, so it pairs with EntityTable rows. */
  index: number;
  entity: EntityOut;
  start: number;
  end: number;
}

type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'span'; key: string; text: string; span: Span };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function buildSegments(narrative: string, entities: EntityOut[]): {
  segments: Segment[];
  skipped: number;
} {
  const length = narrative.length;

  const spans: Span[] = entities
    .map((entity, index) => {
      const start = clamp(entity.character_start, 0, length);
      const end = clamp(entity.character_end, start, length);
      return { index, entity, start, end };
    })
    .filter((span) => span.end > span.start)
    // Earliest start first; on a tie prefer the longer span, then the original
    // order, so the choice of which overlapping span survives is deterministic.
    .sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);

  const segments: Segment[] = [];
  let cursor = 0;
  let skipped = 0;

  for (const span of spans) {
    if (span.start < cursor) {
      skipped += 1;
      continue;
    }
    if (span.start > cursor) {
      segments.push({
        kind: 'text',
        key: `t${cursor}`,
        text: narrative.slice(cursor, span.start),
      });
    }
    segments.push({
      kind: 'span',
      key: `s${span.index}-${span.start}`,
      text: narrative.slice(span.start, span.end),
      span,
    });
    cursor = span.end;
  }

  if (cursor < length) {
    segments.push({ kind: 'text', key: `t${cursor}`, text: narrative.slice(cursor) });
  }

  return { segments, skipped };
}

export function NarrativeViewer({
  narrative,
  entities,
  activeEntityIndex,
  onActiveEntityChange,
  className,
}: NarrativeViewerProps): ReactElement {
  const { segments, skipped } = useMemo(
    () => buildSegments(narrative ?? '', entities),
    [narrative, entities],
  );

  // Legend of the types actually present, in order of first appearance. Nothing
  // is listed that the extractor did not find in this narrative.
  const legend = useMemo(() => {
    const seen: string[] = [];
    for (const entity of entities) {
      if (entity.entity_type && !seen.includes(entity.entity_type)) seen.push(entity.entity_type);
    }
    return seen;
  }, [entities]);

  if (!narrative) {
    return (
      <EmptyState
        title="This FIR record carries no narrative text"
        description="The backend returned an empty narrative for this FIR, so there is nothing for the extractor to read. No entity spans can exist."
        className={className}
      />
    );
  }

  return (
    <div className={cn('space-y-2.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceTag provenance="narrative" />
          <span className="field-label">{entities.length} entity spans highlighted</span>
        </div>
        {legend.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {legend.map((type) => (
              <li key={type} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-0.5 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: entityColor(type) }}
                />
                <span className="text-ink-4 text-2xs tracking-wide uppercase">
                  {entityStyle(type).label}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* `whitespace-pre-wrap` keeps the record's own line breaks and spacing. */}
      <div className="inset px-3.5 py-3">
        <p className="text-ink-2 font-mono text-xs leading-[1.85] break-words whitespace-pre-wrap">
          {segments.map((segment) => {
            if (segment.kind === 'text') return <span key={segment.key}>{segment.text}</span>;

            const { span } = segment;
            const color = entityColor(span.entity.entity_type);
            const isActive = activeEntityIndex === span.index;

            return (
              <button
                key={segment.key}
                type="button"
                // Runtime palette colours cannot be Tailwind classes (v4 scans
                // source text), so the entity colour goes in a style prop.
                style={{
                  color,
                  backgroundColor: isActive ? `${color}2e` : `${color}1a`,
                  boxShadow: isActive
                    ? `0 0 0 1px ${color}, inset 0 -1px 0 0 ${color}`
                    : `inset 0 -1px 0 0 ${color}99`,
                }}
                aria-pressed={isActive}
                title={`${entityStyle(span.entity.entity_type).label} · normalized: ${
                  span.entity.normalized_value
                } · characters ${span.start}–${span.end}`}
                onClick={() => onActiveEntityChange?.(isActive ? null : span.index)}
                className={cn(
                  'rounded-xs px-px font-mono text-xs transition-colors',
                  onActiveEntityChange ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                {segment.text}
              </button>
            );
          })}
        </p>
      </div>

      <p className="text-ink-4 text-2xs leading-relaxed">
        Text reproduced verbatim from the FIR record; highlights are deterministic rule and regex
        matches over character offsets, not a language model's interpretation.
        {skipped > 0
          ? ` ${skipped} extracted span${
              skipped === 1 ? '' : 's'
            } overlapped an earlier highlight and ${
              skipped === 1 ? 'is' : 'are'
            } listed in the entity table instead, so no character is wrapped twice.`
          : ''}
      </p>
    </div>
  );
}
