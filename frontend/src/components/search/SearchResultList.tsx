import type { ReactElement } from 'react';

import { EntityBadge, Mono } from '@/components/ui';
import type { NodeOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { entityColor } from '@/utils/entity';

/**
 * SearchResultList — the rendered rows of `GET /api/v1/graph/search`.
 *
 * Two variants, one markup: the `dropdown` variant is the combobox popup in the
 * top bar, the `page` variant is the roomier list a full-width view can show.
 * Both are the same accessible structure (`role="listbox"` → `role="option"`),
 * because the keyboard contract must not change with the surface.
 *
 * DOM ids are deterministic rather than `useId()`-generated. The combobox that
 * owns this list needs to point `aria-activedescendant` at the active option,
 * and the props of this component are a fixed contract with no slot for an id
 * prefix — so the scheme below is the shared convention, and it is duplicated
 * (with this same comment) in `GlobalSearch.tsx`. The `variant` is part of the
 * id, so a dropdown and a page list can coexist without colliding.
 */

/** `person:445` -> `tracex-dropdown-search-option-person-445` */
function optionDomId(variant: 'dropdown' | 'page', entityId: string): string {
  return `tracex-${variant}-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;
}

function listboxDomId(variant: 'dropdown' | 'page'): string {
  return `tracex-${variant}-search-listbox`;
}

/**
 * Where a result opens, in words.
 *
 * This backend's network endpoint is person-rooted
 * (`/graph/persons/{id}/network`), so a phone, Aadhaar, location or tower cannot
 * be a network root. Rather than hide that, every non-person row says where it
 * actually goes: an FIR to its narrative view, a location to Location
 * Intelligence, and every identifier to its provenance.
 */
function destinationHint(entityType: string | null | undefined): string | null {
  const type = (entityType ?? '').toUpperCase();
  if (type === 'PERSON') return null;
  if (type === 'FIR') return 'Opens FIR narrative';
  if (type === 'LOCATION') return 'Opens Location Intelligence';
  return 'Opens in Evidence & Provenance';
}

export interface SearchResultListProps {
  results: NodeOut[];
  activeIndex?: number;
  onSelect: (node: NodeOut) => void;
  onHoverIndex?: (index: number) => void;
  variant?: 'dropdown' | 'page';
  className?: string;
}

export function SearchResultList({
  results,
  activeIndex,
  onSelect,
  onHoverIndex,
  variant = 'dropdown',
  className,
}: SearchResultListProps): ReactElement {
  const roomy = variant === 'page';

  return (
    <div
      role="listbox"
      id={listboxDomId(variant)}
      aria-label="Entity search results"
      className={cn('flex flex-col', roomy ? 'gap-1' : 'gap-0.5', className)}
    >
      {results.map((node, index) => {
        const active = index === activeIndex;
        const hint = destinationHint(node.entity_type);

        return (
          <button
            key={node.entity_id}
            type="button"
            role="option"
            id={optionDomId(variant, node.entity_id)}
            aria-selected={active}
            // Mouse move (not enter) keeps the active row in step with the
            // pointer even when the list scrolls under a stationary cursor.
            onMouseMove={onHoverIndex ? () => onHoverIndex(index) : undefined}
            onFocus={onHoverIndex ? () => onHoverIndex(index) : undefined}
            onClick={() => onSelect(node)}
            className={cn(
              'group flex w-full items-center gap-3 rounded-sm border-l-2 text-left transition-colors',
              roomy ? 'px-3 py-2.5' : 'px-2.5 py-2',
              active
                ? 'border-l-cyan-500 bg-panel-3'
                : 'border-l-transparent hover:bg-panel-2 focus-visible:bg-panel-2',
            )}
          >
            <EntityBadge entityType={node.entity_type} className="shrink-0" />

            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block truncate text-xs font-medium',
                  active ? 'text-ink' : 'text-ink-2 group-hover:text-ink',
                )}
              >
                {node.label}
              </span>
              {roomy && node.source_dataset ? (
                <span className="text-ink-4 mt-0.5 block font-mono text-2xs">
                  {node.source_dataset}
                  {node.source_record_id ? ` · ${node.source_record_id}` : ''}
                </span>
              ) : null}
            </span>

            {hint ? (
              <span
                className={cn(
                  'hidden shrink-0 text-2xs sm:inline',
                  active ? 'text-ink-3' : 'text-ink-4',
                )}
              >
                {hint}
              </span>
            ) : null}

            <Mono className="shrink-0" title={node.entity_id}>
              {node.entity_id}
            </Mono>

            {/* Entity-palette tick: the one runtime colour, so it goes in style. */}
            <span
              aria-hidden
              className="h-4 w-0.5 shrink-0 rounded-full"
              style={{
                backgroundColor: entityColor(node.entity_type),
                opacity: active ? 1 : 0.45,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
