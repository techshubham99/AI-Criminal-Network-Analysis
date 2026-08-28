/**
 * The shared table, pager and person-reference primitives used by the record
 * screens — Communication, Financial, Locations and Investigations.
 *
 * These four pages all present the same shape of thing: a paged slice of a
 * backend table, one row per record, ids that need turning into names and links.
 * Putting the shell here keeps every one of them visually identical and stops
 * four near-copies of a pager drifting apart.
 */
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button, Mono } from '@/components/ui';
import type { PersonNames } from '@/hooks/usePersonNames';
import type { PageMeta } from '@/types/api';
import { formatCount } from '@/utils/format';

/* ------------------------------------------------------------------ table -- */

/**
 * A compact record table. Horizontally scrollable rather than wrapping, because a
 * squeezed numeric column is harder to read than a scrolled one.
 */
export function DataTable({
  head,
  children,
  className = '',
}: {
  head: ReactNode[];
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr className="border-line border-b">
            {head.map((label, i) => (
              <th
                key={i}
                scope="col"
                className="text-ink-4 px-3 py-2 text-2xs font-semibold tracking-[0.08em] uppercase whitespace-nowrap"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-line divide-y">{children}</tbody>
      </table>
    </div>
  );
}

/** One table cell. `numeric` right-aligns and tabularises, for amounts and counts. */
export function Cell({
  children,
  numeric = false,
  className = '',
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}): ReactElement {
  return (
    <td
      className={`px-3 py-2 align-middle text-xs ${
        numeric ? 'text-ink font-mono tabular-nums' : 'text-ink-2'
      } ${className}`}
    >
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------ pager -- */

/**
 * Previous/Next driven strictly by the backend's own `has_prev` / `has_next`.
 * The UI never computes whether another page exists — it asks.
 */
export function Pager({
  meta,
  onPage,
  isLoading = false,
  unit,
}: {
  meta: PageMeta | null;
  onPage: (page: number) => void;
  isLoading?: boolean;
  unit: string;
}): ReactElement | null {
  if (!meta) return null;
  return (
    <div className="border-line flex items-center justify-between gap-2 border-t px-3 py-2">
      <Button
        size="sm"
        onClick={() => onPage(Math.max(1, meta.page - 1))}
        disabled={!meta.has_prev || isLoading}
        aria-label="Previous page"
      >
        Prev
      </Button>
      <span className="text-ink-4 text-center font-mono text-2xs tabular-nums">
        {meta.page} / {meta.total_pages} · {formatCount(meta.total)} {unit}
      </span>
      <Button
        size="sm"
        onClick={() => onPage(meta.page + 1)}
        disabled={!meta.has_next || isLoading}
        aria-label="Next page"
      >
        Next
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- person ref -- */

/**
 * A person, by numeric row id, as a link into their investigation.
 *
 * Shows the indexed name when there is one and the prefixed id when there is not.
 * It never invents a placeholder name for an id the backend has not described.
 */
export function PersonRef({
  personId,
  names,
  label,
  className = '',
}: {
  personId: number | null | undefined;
  names: PersonNames;
  /** A name the caller already has from its own response; skips the index. */
  label?: string | null;
  className?: string;
}): ReactElement {
  if (personId === null || personId === undefined) {
    return <span className={`text-ink-4 text-xs ${className}`}>—</span>;
  }
  const name = label ?? names.nameOf(personId);
  return (
    <Link
      to={`/network/${personId}`}
      className={`text-ink hover:text-cyan-300 inline-flex max-w-[13rem] items-baseline gap-1.5 truncate text-xs font-medium underline decoration-dotted underline-offset-2 ${className}`}
      title={name ?? `person:${personId}`}
    >
      <span className="truncate">{name ?? `person:${personId}`}</span>
      {name ? <Mono className="text-2xs shrink-0">{personId}</Mono> : null}
    </Link>
  );
}
