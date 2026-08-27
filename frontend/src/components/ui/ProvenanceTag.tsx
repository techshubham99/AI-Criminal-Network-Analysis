import { cn } from '@/utils/cn';
import { Tooltip } from './Tooltip';

/**
 * ProvenanceTag — the single most important label in this application.
 *
 * Every fact on screen is one of three things, and they must never be allowed to
 * blur together:
 *
 *  STRUCTURED        observed in a dataset table (persons/calls/transactions/
 *                    locations/fir_text columns). Cyan, solid.
 *  NARRATIVE-DERIVED asserted only by the free text of an FIR narrative, via a
 *                    deterministic rule with a quoted trigger phrase. Violet,
 *                    dashed. Stored in a SEPARATE narrative graph; the backend
 *                    never merges these into the structured graph.
 *  GROUND-TRUTH      the synthetic generator's own `ring_id` overlay. Not
 *                    evidence of anything. Excluded from the graph view and from
 *                    all analytics; shown only where the backend reports it.
 */
export type Provenance = 'structured' | 'narrative' | 'overlay';

/**
 * Every class here is written out in full. Tailwind v4 scans source text, so a
 * class assembled at runtime (`'bg-' + name`) would never make it into the
 * stylesheet.
 */
const PROVENANCE_META: Record<
  Provenance,
  { label: string; short: string; className: string; lineClassName: string; hint: string }
> = {
  structured: {
    label: 'STRUCTURED',
    short: 'STRUCT',
    className: 'bg-structured/12 text-ent-person ring-structured/35',
    lineClassName: 'border-t-structured',
    hint: 'Observed directly in a structured dataset table. This is a recorded column value, not an inference.',
  },
  narrative: {
    label: 'NARRATIVE-DERIVED',
    short: 'NARRATIVE',
    className: 'bg-narrative/12 text-ent-phone ring-narrative/35',
    lineClassName: 'border-t-narrative border-dashed',
    hint: 'Asserted only by FIR narrative text, extracted by a deterministic rule with a quoted trigger phrase. Held in a separate narrative graph — never merged into the structured graph.',
  },
  overlay: {
    label: 'GROUND-TRUTH OVERLAY',
    short: 'OVERLAY',
    className: 'bg-overlay/12 text-overlay ring-overlay/35',
    lineClassName: 'border-t-overlay border-dashed',
    hint: 'The synthetic data generator’s own ring_id label. It is not evidence and is excluded from the graph view and from every analytic in this system.',
  },
};

export function ProvenanceTag({
  provenance,
  short = false,
  className,
}: {
  provenance: Provenance;
  short?: boolean;
  className?: string;
}) {
  const meta = PROVENANCE_META[provenance];
  return (
    <Tooltip content={meta.hint}>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 text-2xs font-bold tracking-wider uppercase ring-1 ring-inset whitespace-nowrap',
          meta.className,
          className,
        )}
      >
        <span
          aria-hidden
          className={cn('h-0 w-3 shrink-0 border-t-2', meta.lineClassName)}
        />
        {short ? meta.short : meta.label}
      </span>
    </Tooltip>
  );
}

/** Infer provenance from a source dataset name plus the overlay flag. */
export function provenanceOf(input: {
  source_dataset?: string | null;
  is_overlay?: boolean | null;
  is_narrative?: boolean | null;
  relationship_id?: string | null;
}): Provenance {
  if (input.is_overlay) return 'overlay';
  if (input.is_narrative) return 'narrative';
  if (input.relationship_id?.startsWith('narr~')) return 'narrative';
  if (input.source_dataset === 'fir_text') return 'narrative';
  return 'structured';
}
