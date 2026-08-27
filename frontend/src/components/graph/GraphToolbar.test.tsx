/**
 * GraphToolbar — §11's "1-hop graph loads / 2-hop graph loads" controls and
 * §12's "1-hop and 2-hop controls work", tested at the control level.
 *
 * Two things this bar must never do, and both are asserted below.
 *
 * It must not offer a depth the backend rejects. `/graph/persons/{id}/network`
 * answers HTTP 400 above depth 2, so a 3-hop button would be a control that can
 * only produce an error — there are exactly two options, and the wider one says
 * in its own tooltip why it is the widest.
 *
 * And it must not describe a truncated answer as a whole one. The recorded
 * depth-2 response for person 445 came back with `meta.truncated: true`, so the
 * numbers on this bar are a subset of that person's neighbourhood. The counts
 * are the ones the caller passes — nothing here recomputes or rounds them.
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { GraphToolbar, type GraphToolbarProps } from './GraphToolbar';

const recorded = fixtures.network445Depth2 as unknown as {
  nodes: unknown[];
  edges: unknown[];
  meta: { node_count: number; edge_count: number; truncated: boolean };
};

/** Handlers are spies by default so any test can assert on the one it cares about. */
function renderToolbar(props: Partial<GraphToolbarProps> = {}) {
  const handlers = {
    onDepthChange: vi.fn(),
    onPersonsOnlyChange: vi.fn(),
    onFit: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onRelayout: vi.fn(),
  };
  const utils = renderWithRouter(
    <GraphToolbar
      depth={2}
      personsOnly={false}
      nodeCount={recorded.meta.node_count}
      edgeCount={recorded.meta.edge_count}
      truncated={recorded.meta.truncated}
      isLoading={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

const depthOption = (label: string) => screen.getByRole('radio', { name: label });

describe('GraphToolbar — the depth control', () => {
  it('needs no backend of its own', async () => {
    const { calls } = installFetch();
    renderToolbar();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('offers exactly the two depths the backend will serve', () => {
    renderToolbar();
    const group = screen.getByRole('radiogroup', { name: 'Traversal depth' });
    const options = Array.from(group.querySelectorAll('[role="radio"]')).map((el) =>
      el.textContent?.trim(),
    );
    // No 3-HOP: the endpoint answers HTTP 400 above depth 2.
    expect(options).toEqual(['1-HOP', '2-HOP']);
  });

  it('marks the depth the caller is currently showing', () => {
    renderToolbar({ depth: 1 });
    expect(depthOption('1-HOP')).toHaveAttribute('aria-checked', 'true');
    expect(depthOption('2-HOP')).toHaveAttribute('aria-checked', 'false');
  });

  it('asks for the other depth when the operator picks it', () => {
    const { onDepthChange } = renderToolbar({ depth: 1 });
    fireEvent.click(depthOption('2-HOP'));
    expect(onDepthChange).toHaveBeenCalledWith(2);
  });

  it('says in the wider option’s own tooltip why there is nothing beyond it', () => {
    renderToolbar();
    expect(depthOption('2-HOP')).toHaveAttribute(
      'title',
      expect.stringContaining('caps traversal at depth 2'),
    );
    expect(depthOption('2-HOP')).toHaveAttribute('title', expect.stringContaining('HTTP 400'));
  });

  it('describes 1-hop as direct links rather than as a smaller graph', () => {
    renderToolbar();
    expect(depthOption('1-HOP')).toHaveAttribute(
      'title',
      expect.stringContaining('Direct links only'),
    );
  });
});

describe('GraphToolbar — the persons-only projection', () => {
  it('reflects and reports the projection state', () => {
    const { onPersonsOnlyChange } = renderToolbar({ personsOnly: false });
    const toggle = screen.getByRole('checkbox', { name: /Persons only/i });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(onPersonsOnlyChange).toHaveBeenCalledWith(true);
  });

  it('turns the projection back off from the checked state', () => {
    const { onPersonsOnlyChange } = renderToolbar({ personsOnly: true });
    const toggle = screen.getByRole('checkbox', { name: /Persons only/i });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(onPersonsOnlyChange).toHaveBeenCalledWith(false);
  });

  it('credits the projection to the backend rather than to this screen', () => {
    renderToolbar();
    // The hop-collapsing is `persons_only=true` on the endpoint, not a local
    // filter — saying otherwise would misdescribe where the answer came from.
    expect(
      screen.getByText(/The projection is computed by the backend, not here/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Phone, Aadhaar, location and cell-tower nodes are hidden/i)).toBeInTheDocument();
  });

  it('keeps the explanation’s trigger outside the toggle, so reading it cannot flip it', () => {
    // truncated:false leaves exactly one hint on the bar — the projection's.
    const { onPersonsOnlyChange } = renderToolbar({ truncated: false });
    fireEvent.click(screen.getByRole('button', { name: 'What does this mean?' }));
    expect(onPersonsOnlyChange).not.toHaveBeenCalled();
  });
});

describe('GraphToolbar — the readout describes the response', () => {
  it('prints the counts it was handed, and they are the recorded ones', () => {
    renderToolbar();
    const bar = screen.getByTestId('graph-toolbar');

    expect(bar).toHaveTextContent('NODES 60');
    expect(bar).toHaveTextContent('EDGES 117');
    // The same numbers the backend put in the envelope for this response.
    expect(recorded.meta.node_count).toBe(recorded.nodes.length);
    expect(recorded.meta.edge_count).toBe(recorded.edges.length);
  });

  it('renders a zero answer as 0, not as a dash', () => {
    renderToolbar({ nodeCount: 0, edgeCount: 0, truncated: false });
    const bar = screen.getByTestId('graph-toolbar');
    expect(bar).toHaveTextContent('NODES 0');
    expect(bar).toHaveTextContent('EDGES 0');
  });

  it('admits that the recorded response was capped', () => {
    // meta.truncated was true for person 445 at depth 2 — 60 of a larger set.
    expect(recorded.meta.truncated).toBe(true);
    renderToolbar();

    expect(screen.getByText('Truncated at backend cap')).toBeInTheDocument();
    expect(
      screen.getByText(/limits a single network response to 300 nodes/i),
    ).toBeInTheDocument();
    // The sentence that stops a capped view from contradicting a bigger figure
    // shown for the same person elsewhere on the page.
    expect(
      screen.getByText(/Counts shown elsewhere\s+for the same entity can legitimately be larger/i),
    ).toBeInTheDocument();
  });

  it('says nothing about truncation when the answer was complete', () => {
    renderToolbar({ truncated: false });
    expect(screen.queryByText('Truncated at backend cap')).not.toBeInTheDocument();
  });

  it('shows a request in flight without blanking the counts already on screen', () => {
    renderToolbar({ isLoading: true });
    expect(screen.getByRole('status', { name: 'Loading network' })).toBeInTheDocument();
    // The previous answer stays legible while the next one is fetched.
    expect(screen.getByTestId('graph-toolbar')).toHaveTextContent('NODES 60');
  });

  it('shows no spinner when nothing is in flight', () => {
    renderToolbar();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('GraphToolbar — the view controls', () => {
  it('wires each canvas action to its own handler', () => {
    const { onZoomIn, onZoomOut, onFit, onRelayout } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit graph to screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-run graph layout' }));

    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onZoomOut).toHaveBeenCalledTimes(1);
    expect(onFit).toHaveBeenCalledTimes(1);
    expect(onRelayout).toHaveBeenCalledTimes(1);
  });

  it('refuses to relayout a graph that is still being fetched', () => {
    const { onRelayout } = renderToolbar({ isLoading: true });
    const relayout = screen.getByRole('button', { name: 'Re-run graph layout' });

    expect(relayout).toBeDisabled();
    fireEvent.click(relayout);
    expect(onRelayout).not.toHaveBeenCalled();
  });

  it('keeps zoom and fit usable during a fetch, since they act on what is drawn', () => {
    const { onFit } = renderToolbar({ isLoading: true });
    expect(screen.getByRole('button', { name: 'Zoom in' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Fit graph to screen' }));
    expect(onFit).toHaveBeenCalledTimes(1);
  });
});
