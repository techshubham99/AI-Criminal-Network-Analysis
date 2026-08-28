import { useMemo, useState, type ReactElement } from 'react';

import type { EdgeOut, NodeOut } from '@/types/api';
import { Button, EmptyState, Panel, PanelBody, PanelHeader, RelationshipBadge } from '@/components/ui';
import { cn } from '@/utils/cn';
import { formatCount, formatDateRange, formatDateTime } from '@/utils/format';

const INITIAL_ROWS = 10;

interface TimelineEvent {
  key: string;
  /** ISO date the backend recorded on the relationship. Never derived. */
  date: string;
  dateLast: string | null;
  relationshipType: string;
  counterpartLabel: string;
  sourceDataset: string;
  evidenceCount: number;
}

/**
 * A dated view of one subject's observed relationships.
 *
 * BUILT ONLY FROM WHAT THE BACKEND ALREADY SENT. Every row is a relationship from
 * the network response that carries a `date_first`: calls, transactions and FIR
 * links all record one. Relationships with no date are counted, not placed — a
 * timeline that guesses at when something happened is worse than a shorter
 * timeline.
 */
export function ActivityTimeline({
  edges,
  nodes,
  anchorEntityId,
  className,
}: {
  edges: EdgeOut[];
  nodes: NodeOut[];
  anchorEntityId: string;
  className?: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const { events, undated } = useMemo(() => {
    const labels = new Map(nodes.map((node) => [node.entity_id, node.label]));
    const dated: TimelineEvent[] = [];
    let missing = 0;

    for (const edge of edges) {
      if (!edge.date_first) {
        missing += 1;
        continue;
      }
      const counterpartId =
        edge.source_entity_id === anchorEntityId ? edge.target_entity_id : edge.source_entity_id;
      dated.push({
        key: edge.relationship_id,
        date: edge.date_first,
        dateLast: edge.date_last ?? null,
        relationshipType: edge.relationship_type,
        counterpartLabel: labels.get(counterpartId) ?? counterpartId,
        sourceDataset: edge.source_dataset,
        evidenceCount: edge.evidence_count,
      });
    }

    dated.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    return { events: dated, undated: missing };
  }, [edges, nodes, anchorEntityId]);

  const visible = expanded ? events : events.slice(0, INITIAL_ROWS);
  const hidden = events.length - visible.length;
  const span =
    events.length > 0
      ? formatDateRange(events[0].date, events[events.length - 1].dateLast ?? events[events.length - 1].date)
      : undefined;

  return (
    <Panel className={cn('min-w-0', className)} data-testid="activity-timeline">
      <PanelHeader
        title="Timeline"
        subtitle={events.length > 0 ? `${formatCount(events.length)} dated · ${span}` : undefined}
        accent
      />
      <PanelBody>
        {events.length === 0 ? (
          <EmptyState
            title="No dated activity"
            description="None of the visible relationships carry a date."
          />
        ) : (
          <>
            <ol className="space-y-0">
              {visible.map((event, index) => (
                <li key={event.key} className="flex gap-3" data-testid="timeline-event">
                  {/* Rail: a dot per event, joined by a hairline. */}
                  <div className="flex w-3 shrink-0 flex-col items-center">
                    <span className="bg-cyan-500 mt-1.5 size-1.5 shrink-0 rounded-full" />
                    {index < visible.length - 1 ? (
                      <span className="bg-line w-px flex-1" aria-hidden />
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1 pb-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-ink-2 font-mono text-2xs tabular-nums">
                        {formatDateTime(event.date)}
                      </span>
                      <RelationshipBadge relationshipType={event.relationshipType} />
                      <span className="text-ink truncate text-xs">{event.counterpartLabel}</span>
                    </div>
                    <p className="text-ink-4 mt-0.5 flex flex-wrap gap-x-3 text-2xs">
                      <span>{event.sourceDataset}</span>
                      <span>{formatCount(event.evidenceCount)} records</span>
                      {event.dateLast && event.dateLast !== event.date ? (
                        <span>through {formatDateTime(event.dateLast)}</span>
                      ) : null}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            {hidden > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => setExpanded(true)}>
                Show {formatCount(hidden)} more
              </Button>
            ) : null}
            {expanded && events.length > INITIAL_ROWS ? (
              <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
                Show fewer
              </Button>
            ) : null}
          </>
        )}

        {undated > 0 ? (
          <p className="text-ink-4 mt-2 text-2xs">
            {formatCount(undated)} relationships carry no date and are not placed here.
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
