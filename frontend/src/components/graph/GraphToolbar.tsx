import type { ReactElement } from 'react';

import { Badge, CheckToggle, IconButton, InfoHint, SegmentedControl, Spinner } from '@/components/ui';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';

/**
 * Controls that sit directly above the network canvas.
 *
 * Every control here changes *what is asked of the backend* (hop depth, the
 * persons-only projection) or *how the existing answer is viewed* (zoom, fit,
 * relayout). Nothing in this bar transforms the data locally, so the readout
 * beside them can be trusted as a description of the backend's response.
 */
export interface GraphToolbarProps {
  depth: 1 | 2;
  onDepthChange: (depth: 1 | 2) => void;
  personsOnly: boolean;
  onPersonsOnlyChange: (value: boolean) => void;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  isLoading: boolean;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRelayout: () => void;
  className?: string;
}

/* The backend rejects depth > 2 with HTTP 400, so the option titles say so
   rather than letting an operator wonder why there is no 3-hop button. */
const DEPTH_OPTIONS: ReadonlyArray<{ value: 1 | 2; label: string; title: string }> = [
  {
    value: 1,
    label: '1-HOP',
    title: 'Direct links only: entities one relationship away from the anchor.',
  },
  {
    value: 2,
    label: '2-HOP',
    title:
      'Two relationships out from the anchor. The backend caps traversal at depth 2 and answers HTTP 400 above it, so this is the widest view available.',
  },
];

const ICON = 'size-3.5';

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="6.75" cy="6.75" r="4.35" />
      <path d="M10 10l3.6 3.6M6.75 4.85v3.8M4.85 6.75h3.8" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="6.75" cy="6.75" r="4.35" />
      <path d="M10 10l3.6 3.6M4.85 6.75h3.8" strokeLinecap="round" />
    </svg>
  );
}

function FitIcon() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path
        d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="6.1" y="6.1" width="3.8" height="3.8" rx="0.6" />
    </svg>
  );
}

function RelayoutIcon() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path
        d="M13.2 8a5.2 5.2 0 1 1-1.72-3.86"
        strokeLinecap="round"
      />
      <path d="M13.4 2.3v2.9h-2.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GraphToolbar({
  depth,
  onDepthChange,
  personsOnly,
  onPersonsOnlyChange,
  nodeCount,
  edgeCount,
  truncated,
  isLoading,
  onFit,
  onZoomIn,
  onZoomOut,
  onRelayout,
  className,
}: GraphToolbarProps): ReactElement {
  return (
    <div
      className={cn(
        'bg-panel-2 border-line flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-2.5 py-2',
        className,
      )}
      data-testid="graph-toolbar"
    >
      {/* ------------------------------------------------ query-shaping controls */}
      <div className="flex items-center gap-1.5">
        <span className="field-label">Depth</span>
        <SegmentedControl<1 | 2>
          label="Traversal depth"
          options={DEPTH_OPTIONS}
          value={depth}
          onChange={onDepthChange}
        />
      </div>

      {/* The hint lives OUTSIDE the CheckToggle: its trigger is a real button, and
          a button inside the toggle's <label> would flip the checkbox on click. */}
      <div className="flex items-center gap-1">
        <CheckToggle checked={personsOnly} onChange={onPersonsOnlyChange} className="px-1">
          Persons only
        </CheckToggle>
        <InfoHint
          content={
            <>
              Projects the network onto <span className="font-mono">person → person</span> links.
              Phone, Aadhaar, location and cell-tower nodes are hidden and the persons they connect
              are joined directly. The projection is computed by the backend, not here.
            </>
          }
        />
      </div>

      {/* ------------------------------------------------------------- readout */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-ink-3 font-mono text-2xs whitespace-nowrap tabular-nums">
          <span className="text-ink-4">NODES</span> <span className="text-ink">{formatCount(nodeCount)}</span>
          <span className="text-ink-4"> · EDGES</span>{' '}
          <span className="text-ink">{formatCount(edgeCount)}</span>
        </span>

        {isLoading ? <Spinner label="Loading network" className="size-3" /> : null}

        {truncated ? (
          <span className="flex items-center gap-1">
            {/* A cap on the answer is a limitation of the view, so warn colour is
                correct here — this is the one place the graph bar uses it. */}
            <Badge tone="warn">Truncated at backend cap</Badge>
            <InfoHint
              content={
                <>
                  The backend limits a single network response to 300 nodes. This view is therefore a
                  subset of the anchor's neighbourhood, not the whole of it. Counts shown elsewhere
                  for the same entity can legitimately be larger.
                </>
              }
            />
          </span>
        ) : null}
      </div>

      {/* ------------------------------------------------------- view controls */}
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton label="Zoom in" icon={<ZoomInIcon />} onClick={onZoomIn} />
        <IconButton label="Zoom out" icon={<ZoomOutIcon />} onClick={onZoomOut} />
        <IconButton label="Fit graph to screen" icon={<FitIcon />} onClick={onFit} />
        <IconButton
          label="Re-run graph layout"
          icon={<RelayoutIcon />}
          onClick={onRelayout}
          disabled={isLoading}
        />
      </div>
    </div>
  );
}
