/**
 * IngestVerdict — what the pipeline decided about one submitted record.
 *
 * Four outcomes, shown as themselves: ACCEPTED, DUPLICATE, REVIEW_REQUIRED,
 * REJECTED. The backend's own `reason` is printed verbatim rather than
 * paraphrased, and a review outcome names which of the two reasons applies —
 * AMBIGUOUS_MATCH (cannot tell which existing person) and NO_MATCH_NEW_ENTITY
 * (appears to be new) are different findings and are never merged.
 *
 * The impact block reports only what the response actually carries. Nothing here
 * is computed on the client: if the record changed nothing, it says so.
 */
import type { ReactElement } from 'react';

import { Badge, KeyValueList, KeyValueRow, Mono } from '@/components/ui';
import type { IngestRecordOut, IngestRelationshipOut, MatchOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';
import { readNumber, readRecord, readString, readStringArray } from '@/utils/records';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'alert' | 'azure' | 'neutral'> = {
  ACCEPTED: 'ok',
  DUPLICATE: 'azure',
  REVIEW_REQUIRED: 'warn',
  REJECTED: 'alert',
};

interface PriorityMove {
  entity_id: string;
  score_before: number | null;
  score_after: number | null;
  band_after: string | null;
}

function readPriorityMoves(impact: Record<string, unknown>): PriorityMove[] {
  const raw = impact.priority_changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const entityId = readString(row, 'entity_id');
    if (!entityId) return [];
    return [
      {
        entity_id: entityId,
        score_before: readNumber(row, 'score_before'),
        score_after: readNumber(row, 'score_after'),
        band_after: readString(row, 'band_after'),
      },
    ];
  });
}

export function IngestVerdict({ record }: { record: IngestRecordOut }): ReactElement {
  const tone = STATUS_TONE[record.status] ?? 'neutral';
  const accepted = record.relationships.filter((r) => r.accepted);
  const refused = record.relationships.filter((r) => !r.accepted);
  const reviews = record.matches.filter((m) => m.status !== 'MATCHED');

  return (
    <div className="space-y-3" data-testid="ingest-verdict" data-status={record.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{record.status.replace(/_/g, ' ')}</Badge>
        {record.review_reason ? <Badge tone="warn">{record.review_reason}</Badge> : null}
        {record.reject_reason ? <Badge tone="alert">{record.reject_reason}</Badge> : null}
        <Mono className="truncate">{record.record_id.slice(0, 12)}</Mono>
      </div>

      <p className="text-ink-2 text-xs leading-snug" data-testid="ingest-reason">
        {record.reason}
      </p>

      {record.duplicate_of ? (
        <p className="text-ink-4 text-2xs">
          Same as <Mono>{record.duplicate_of.slice(0, 12)}</Mono> — nothing was added.
        </p>
      ) : null}

      {reviews.length > 0 ? <MatchNotes matches={reviews} /> : null}

      {accepted.length > 0 ? (
        <RelationshipLines title="Accepted" rows={accepted} accepted />
      ) : null}
      {refused.length > 0 ? <RelationshipLines title="Not accepted" rows={refused} /> : null}

      <Impact impact={record.impact} />
    </div>
  );
}

/* --------------------------------------------------------- resolution notes -- */

function MatchNotes({ matches }: { matches: MatchOut[] }): ReactElement {
  return (
    <div className="inset space-y-2 p-2" data-testid="match-notes">
      {matches.map((match) => (
        <div key={match.field}>
          <p className="field-label">{match.field.replace(/_/g, ' ')}</p>
          <p className="text-ink-2 mt-0.5 text-2xs leading-snug">{match.explanation}</p>
          {match.candidates.length > 0 ? (
            <ul className="text-ink-3 mt-1 space-y-0.5 text-2xs">
              {match.candidates.slice(0, 4).map((candidate) => (
                <li key={candidate.entity_id} className="flex items-baseline gap-2">
                  <Mono>{candidate.entity_id}</Mono>
                  <span className="truncate">{candidate.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ relationships -- */

function RelationshipLines({
  title,
  rows,
  accepted = false,
}: {
  title: string;
  rows: IngestRelationshipOut[];
  accepted?: boolean;
}): ReactElement {
  return (
    <div>
      <p className="field-label">{title}</p>
      <ul className="mt-1 space-y-1">
        {rows.map((row, index) => (
          <li
            key={row.relationship_id ?? `${row.relationship_type}-${index}`}
            className="text-2xs leading-snug"
          >
            <span className={cn('font-semibold', accepted ? 'text-ok-300' : 'text-ink-3')}>
              {row.relationship_type}
            </span>
            {row.excluded_from_intelligence ? (
              <span className="text-ink-4"> · evidence only</span>
            ) : null}
            <span className="text-ink-4"> — {row.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------- impact -- */

function Impact({ impact }: { impact: Record<string, unknown> }): ReactElement | null {
  const graph = readRecord(impact, 'graph');
  const totals = readRecord(impact, 'graph_totals');
  const cost = readRecord(impact, 'recompute_cost_ms');
  const nodesAdded = readStringArray(graph, 'nodes_added').length;
  const edgesAdded = readStringArray(graph, 'edges_added').length;
  const edgesUpdated = readStringArray(graph, 'edges_updated').length;
  const newPatterns = readStringArray(impact, 'new_pattern_ids').length;
  const clearedPatterns = readStringArray(impact, 'cleared_pattern_ids').length;
  const moves = readPriorityMoves(impact);
  const changed = impact.changed === true;

  if (!changed && moves.length === 0) {
    const note = readString(impact, 'note');
    return note ? <p className="text-ink-4 text-2xs">{note}</p> : null;
  }

  return (
    <div className="border-line border-t pt-2" data-testid="ingest-impact">
      <KeyValueList dense>
        <KeyValueRow
          label="Graph"
          value={
            changed
              ? `+${formatCount(nodesAdded)} nodes · +${formatCount(edgesAdded)} edges · ${formatCount(edgesUpdated)} updated`
              : 'unchanged'
          }
        />
        {totals ? (
          <KeyValueRow
            label="Totals"
            value={`${formatCount(readNumber(totals, 'nodes'))} nodes · ${formatCount(readNumber(totals, 'edges'))} edges`}
            mono
          />
        ) : null}
        <KeyValueRow
          label="Patterns"
          value={`+${formatCount(newPatterns)} new · ${formatCount(clearedPatterns)} cleared`}
        />
        {cost ? (
          <KeyValueRow
            label="Recompute"
            value={`${formatCount(Math.round(readNumber(cost, 'total_ms') ?? 0))} ms`}
            hint="PageRank, betweenness and communities are global metrics: they are fully recomputed after an accepted change, never patched."
            mono
          />
        ) : null}
        <KeyValueRow
          label="Priority"
          value={
            moves.length === 0 ? (
              'no change'
            ) : (
              <span className="block space-y-0.5">
                {moves.slice(0, 3).map((move) => (
                  <span key={move.entity_id} className="block">
                    <Mono>{move.entity_id}</Mono> {move.score_before ?? '–'} →{' '}
                    <span className="text-ink font-semibold">{move.score_after ?? '–'}</span>
                    {move.band_after ? <span className="text-ink-4"> {move.band_after}</span> : null}
                  </span>
                ))}
                {moves.length > 3 ? (
                  <span className="text-ink-4 block">+{moves.length - 3} more</span>
                ) : null}
              </span>
            )
          }
        />
      </KeyValueList>
    </div>
  );
}
