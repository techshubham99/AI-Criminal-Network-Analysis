import { useState, type ReactElement } from 'react';

import type { EvidenceOut } from '@/types/api';
import { Button, Mono, ProvenanceTag } from '@/components/ui';
import { cn } from '@/utils/cn';
import { formatConfidence, formatCount, truncate } from '@/utils/format';

/**
 * One evidence list. Two of these are always rendered side by side, never merged.
 *
 * The backend returns structured records and NLP-derived claims as separate
 * fields, and that separation is the whole point: a structured record is an
 * observed row, an NLP-derived claim is a rule's reading of free text and raises
 * no score. Merging them in the UI would quietly undo a backend guarantee, so
 * this component takes exactly one list and labels its provenance.
 *
 * Long lists are collapsed to `initial` rows. A person can carry dozens of
 * evidence records, and a panel that scrolls for a screen and a half hides the
 * score it is supposed to support.
 */
export function EvidenceList({
  items,
  kind,
  initial = 6,
  className,
}: {
  items: EvidenceOut[];
  kind: 'structured' | 'nlp';
  initial?: number;
  className?: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initial);
  const hidden = items.length - visible.length;

  return (
    <div className={cn('min-w-0', className)} data-testid={`evidence-${kind}`}>
      <div className="flex items-center justify-between gap-2">
        <ProvenanceTag provenance={kind === 'structured' ? 'structured' : 'narrative'} short />
        <span className="text-ink-4 font-mono text-2xs tabular-nums">
          {formatCount(items.length)}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-ink-4 mt-1.5 text-2xs">None</p>
      ) : (
        <>
          <ul className="mt-1.5 space-y-1">
            {visible.map((item) => (
              <li
                key={item.evidence_id}
                className="border-line bg-inset rounded-sm border px-2 py-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <Mono className="truncate">{item.evidence_id}</Mono>
                  <span className="text-ink-4 shrink-0 font-mono text-2xs tabular-nums">
                    {formatConfidence(item.confidence)}
                  </span>
                </div>
                {item.evidence_text ? (
                  <p className="text-ink-3 mt-1 text-2xs leading-snug">
                    {truncate(item.evidence_text, 160)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {hidden > 0 ? (
            <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setExpanded(true)}>
              Show {formatCount(hidden)} more
            </Button>
          ) : null}
          {expanded && items.length > initial ? (
            <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setExpanded(false)}>
              Show fewer
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The pair, side by side, with the separation made visible by the layout. */
export function EvidencePair({
  structured,
  nlp,
  initial = 6,
  className,
}: {
  structured: EvidenceOut[];
  nlp: EvidenceOut[];
  initial?: number;
  className?: string;
}): ReactElement {
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', className)}>
      <EvidenceList items={structured} kind="structured" initial={initial} />
      <EvidenceList items={nlp} kind="nlp" initial={initial} />
    </div>
  );
}
