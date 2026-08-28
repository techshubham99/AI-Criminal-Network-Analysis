/**
 * GraphLegend — the §5 requirement "filter relationship types", and the legend
 * that has to make the canvas readable without relying on colour alone.
 *
 * The counts handed to this component describe what is actually drawn, so the
 * assertions below use the type tallies of the recorded depth-2 network for
 * person 445 rather than a hand-written record. Two consequences of that are
 * worth stating outright:
 *
 *  - the recorded response was fetched with `include_overlay=false`, so no
 *    SAME_RING edge exists in it. The generator's ground-truth ring label can
 *    therefore never appear as a filter row, and that is asserted directly;
 *  - CO_LOCATED is the most numerous derived link in this network (26 of 117
 *    edges). Its hint has to say it is derived rather than observed, or the
 *    canvas reads as though two people were seen together.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EdgeOut, NodeOut } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { GraphLegend, type GraphLegendProps } from './GraphLegend';

const recorded = fixtures.network445Depth2 as unknown as { nodes: NodeOut[]; edges: EdgeOut[] };

function tally(values: Array<string | null | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

const nodeCounts = tally(recorded.nodes.map((node) => node.entity_type));
const edgeCounts = tally(recorded.edges.map((edge) => edge.relationship_type));
const edgeTypes = Object.keys(edgeCounts);

function renderLegend(props: Partial<GraphLegendProps> = {}) {
  const handlers = { onToggleEdgeType: vi.fn(), onSetAllEdgeTypes: vi.fn() };
  const utils = renderWithRouter(
    <GraphLegend
      nodeCounts={props.nodeCounts ?? nodeCounts}
      edgeCounts={props.edgeCounts ?? edgeCounts}
      enabledEdgeTypes={props.enabledEdgeTypes ?? edgeTypes}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

/** The section whose divider label reads `label`. */
function section(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const el = heading.closest('section');
  if (!el) throw new Error(`no section titled "${label}"`);
  return el as HTMLElement;
}

/**
 * The relationship filter checkbox for `edgeType`.
 *
 * Its accessible name is the type immediately followed by the tally with no
 * separator — `CALLED38` — because the label text and the count are adjacent
 * spans. Anchoring on `\d+$` addresses the row without hardcoding the number.
 */
const filter = (edgeType: string) =>
  within(section('Relationship types')).getByRole('checkbox', {
    name: new RegExp(`^${edgeType}\\d+$`),
  });

describe('GraphLegend — entity types on the canvas', () => {
  it('needs no backend of its own', async () => {
    const { calls } = installFetch();
    renderLegend();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('lists each entity type present, most numerous first, with its tally', () => {
    renderLegend();
    const rows = Array.from(section('Entity types').querySelectorAll('li')).map((li) =>
      li.textContent?.trim(),
    );

    // PERSON 42 · CELL_TOWER 7 · FIR 6 · AADHAAR 2 · LOCATION 2 · PHONE 1.
    // AADHAAR precedes LOCATION on the count tie because the tiebreak is
    // alphabetical, not insertion order — a stable legend between renders.
    expect(rows).toEqual([
      'PERSON42',
      'CELL TOWER7',
      'FIR6',
      'AADHAAR2',
      'LOCATION2',
      'PHONE1',
    ]);
  });

  it('legends no entity type the view does not contain', () => {
    renderLegend();
    const legend = screen.getByTestId('graph-legend');
    // The Phase 2 graph materialises six node types. TRANSACTION is not one of
    // them — money movement is an edge — and VEHICLE / ORGANIZATION are declared
    // future types with no rows in this dataset.
    for (const absent of ['TRANSACTION', 'VEHICLE', 'ORGANIZATION', 'EVENT']) {
      expect(legend).not.toHaveTextContent(absent);
    }
  });

  it('explains node size as structure, not as a ranking of a person', () => {
    renderLegend();
    expect(
      screen.getByText(/a structural count of links, not a ranking of a person/i),
    ).toBeInTheDocument();
    // Shape as well as colour, so the graph survives a projector and colour blindness.
    expect(
      screen.getByText(/Node shape and colour both encode the entity type/i),
    ).toBeInTheDocument();
  });

  it('says the view is empty rather than showing an empty list', () => {
    renderLegend({ nodeCounts: {} });
    expect(screen.getByText('No entities in the current view.')).toBeInTheDocument();
    expect(section('Entity types').querySelector('li')).toBeNull();
  });
});

describe('GraphLegend — relationship types are the filter', () => {
  it('offers one checkbox per relationship type in the view', () => {
    renderLegend();
    const boxes = within(section('Relationship types')).getAllByRole('checkbox');
    expect(boxes).toHaveLength(edgeTypes.length);
    // Nine types in the recorded depth-2 network.
    expect(edgeTypes.length).toBeGreaterThan(0);
  });

  it('shows each type’s edge count beside it', () => {
    renderLegend();
    // CALLED is the most numerous observed link in this network: 38 of 117.
    expect(filter('CALLED')).toHaveAccessibleName(`CALLED${edgeCounts.CALLED}`);
    expect(edgeCounts.CALLED).toBe(38);
  });

  it('reflects which types the caller currently has enabled', () => {
    renderLegend({ enabledEdgeTypes: ['CALLED'] });
    expect(filter('CALLED')).toBeChecked();
    expect(filter('CO_LOCATED')).not.toBeChecked();
  });

  it('reports the type the operator toggled, not a new list', () => {
    // The page owns the filter state; the legend only names what changed.
    const { onToggleEdgeType } = renderLegend();
    fireEvent.click(filter('CO_LOCATED'));
    expect(onToggleEdgeType).toHaveBeenCalledWith('CO_LOCATED');
  });

  it('offers a way back to the whole answer, and a way to clear it', () => {
    const { onSetAllEdgeTypes } = renderLegend();

    fireEvent.click(screen.getByRole('button', { name: 'Show all relationship types' }));
    expect(onSetAllEdgeTypes).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Hide all relationship types' }));
    expect(onSetAllEdgeTypes).toHaveBeenCalledWith(false);
  });

  it('offers no bulk controls when there is nothing to filter', () => {
    renderLegend({ edgeCounts: {}, enabledEdgeTypes: [] });
    expect(screen.getByText('No relationships in the current view.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show all relationship types' }),
    ).not.toBeInTheDocument();
  });
});

describe('GraphLegend — a line has to say what it is', () => {
  it('calls a shared-column link derived, and weak, in its own hint', () => {
    renderLegend();
    // 26 of the 117 recorded edges are CO_LOCATED. If this read as an
    // observation the canvas would look far more incriminating than the data is.
    expect(edgeCounts.CO_LOCATED).toBeGreaterThan(0);
    expect(
      screen.getByText(/Derived, not observed: two persons share a location_id/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Weak evidence by design/i)).toBeInTheDocument();
  });

  it('calls an FIR allegation an allegation rather than a finding', () => {
    renderLegend();
    expect(screen.getByText(/An allegation on record — not a finding of guilt/i)).toBeInTheDocument();
  });

  it('states in prose what a dashed line means', () => {
    renderLegend();
    expect(
      screen.getByText(/inferred from shared attributes or asserted by narrative text/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dashed = derived, not observed/i)).toBeInTheDocument();
  });

  it('never offers the generator’s ring label as a filter', () => {
    // The network is requested with include_overlay=false, so SAME_RING cannot
    // be in the tally — and the answer key is therefore not filterable, not
    // colourable, and not countable anywhere on this legend.
    expect(edgeTypes).not.toContain('SAME_RING');
    renderLegend();
    expect(screen.getByTestId('graph-legend')).not.toHaveTextContent('SAME_RING');
  });
});
