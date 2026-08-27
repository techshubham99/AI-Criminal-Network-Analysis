import type { ReactElement } from 'react';

import { CheckToggle, Divider, EntityBadge, Tooltip } from '@/components/ui';
import { cn } from '@/utils/cn';
import { formatCount, sortedCounts } from '@/utils/format';
import { relationshipStyle } from '@/utils/entity';

/**
 * Legend for the network canvas — and, for relationships, the filter itself.
 *
 * The counts come from whatever the backend returned for the current view, so
 * the legend lists only types that are actually on screen. A type with no edges
 * in this network simply does not appear; nothing is padded out to look fuller.
 *
 * The component is deliberately unbordered so a page can drop it into its own
 * Panel without stacking two surfaces.
 */
export interface GraphLegendProps {
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  enabledEdgeTypes: string[];
  onToggleEdgeType: (edgeType: string) => void;
  onSetAllEdgeTypes: (enabled: boolean) => void;
  className?: string;
}

function BulkButton({
  children,
  onClick,
  label,
}: {
  children: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="text-ink-4 hover:text-cyan-300 rounded-xs px-1 py-0.5 text-2xs font-semibold tracking-wide uppercase transition-colors"
    >
      {children}
    </button>
  );
}

export function GraphLegend({
  nodeCounts,
  edgeCounts,
  enabledEdgeTypes,
  onToggleEdgeType,
  onSetAllEdgeTypes,
  className,
}: GraphLegendProps): ReactElement {
  const entityRows = sortedCounts(nodeCounts);
  const relationshipRows = sortedCounts(edgeCounts);

  return (
    <div className={cn('space-y-4', className)} data-testid="graph-legend">
      {/* ------------------------------------------------------ entity types */}
      <section>
        <Divider label="Entity types" className="mb-2" />
        {entityRows.length === 0 ? (
          <p className="text-ink-4 text-xs">No entities in the current view.</p>
        ) : (
          <ul className="space-y-1">
            {entityRows.map(([entityType, count]) => (
              <li key={entityType} className="flex items-center gap-2 px-1.5 py-0.5">
                <EntityBadge entityType={entityType} className="shrink-0" />
                <span className="flex-1" />
                <span className="text-ink-3 shrink-0 font-mono text-2xs tabular-nums">
                  {formatCount(count)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-4 mt-2 text-2xs leading-relaxed">
          Node shape and colour both encode the entity type, so the graph still reads without
          colour. Node size is the entity's degree within this view — a structural count of links,
          not a ranking of a person.
        </p>
      </section>

      {/* ------------------------------------------------ relationship types */}
      <section>
        <Divider label="Relationship types" className="mb-2" />
        {relationshipRows.length === 0 ? (
          <p className="text-ink-4 text-xs">No relationships in the current view.</p>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-end gap-1">
              <BulkButton label="Show all relationship types" onClick={() => onSetAllEdgeTypes(true)}>
                All
              </BulkButton>
              <span aria-hidden className="text-ink-4 text-2xs">
                /
              </span>
              <BulkButton label="Hide all relationship types" onClick={() => onSetAllEdgeTypes(false)}>
                None
              </BulkButton>
            </div>
            <ul className="space-y-0.5">
              {relationshipRows.map(([edgeType, count]) => {
                const style = relationshipStyle(edgeType);
                return (
                  <li key={edgeType}>
                    {/* The hint is what stops CO_LOCATED from reading as an
                        observation; it is surfaced on hover and on keyboard
                        focus of the checkbox inside. */}
                    <Tooltip content={style.hint} className="w-full">
                      <CheckToggle
                        checked={enabledEdgeTypes.includes(edgeType)}
                        onChange={() => onToggleEdgeType(edgeType)}
                        accentColor={style.color}
                        count={count}
                        className="w-full"
                      >
                        {edgeType}
                      </CheckToggle>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="text-ink-4 mt-2 text-2xs leading-relaxed">
          A dashed line marks a relationship that was <em className="not-italic font-semibold">derived</em>{' '}
          — inferred from shared attributes or asserted by narrative text — rather than directly
          observed in a source record.
        </p>
      </section>
    </div>
  );
}
