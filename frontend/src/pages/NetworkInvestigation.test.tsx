/**
 * Network Investigation — the §11 checklist items "person search works",
 * "1-hop graph loads", "2-hop graph loads" and the request-level half of "node
 * selection works", asserted at page level.
 *
 * Node and edge *clicks* are exercised against a real renderer in the browser
 * smoke test, not here: jsdom has no canvas, so Cytoscape is built headless and
 * a tap on a node cannot be synthesised through the DOM. What these tests pin
 * down instead is everything around the canvas — that a search reaches the real
 * endpoint, that the depth control changes the request rather than filtering
 * locally, that the counts shown are the backend's own, and that the selection
 * sink exists and starts empty.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { installFetch, renderWithRouter } from '@/test/helpers';

import { NetworkInvestigation } from './NetworkInvestigation';

/** Both routes, so selecting a search result really navigates the app. */
const routedPage = (
  <Routes>
    <Route path="/network" element={<NetworkInvestigation />} />
    <Route path="/network/:personId" element={<NetworkInvestigation />} />
  </Routes>
);

const toolbarText = () => screen.getByTestId('graph-toolbar').textContent ?? '';

describe('NetworkInvestigation — search, then draw what the backend answered', () => {
  it('searches persons and opens the 1-hop network of the one picked', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/network' });

    // Nothing is requested until there is a query worth sending.
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ojas' } });

    // The recording is what the live backend returned for q=Ojas.
    const personRow = await waitFor(
      () => {
        const row = screen
          .getAllByRole('option')
          .find((option) => (option.textContent ?? '').includes('person:445'));
        expect(row).toBeDefined();
        return row as HTMLElement;
      },
      { timeout: 3000 },
    );
    expect(calls.some((url) => url.includes('/api/v1/graph/search?q=Ojas'))).toBe(true);

    fireEvent.click(personRow);

    // person:445 -> /network/445: the path segment carries the integer row id,
    // because `person:445` in that position is a 422 from this backend.
    await waitFor(() => expect(screen.getByTestId('graph-toolbar')).toBeInTheDocument());
    expect(
      calls.some((url) => url.includes('/api/v1/graph/persons/445/network')),
    ).toBe(true);
    expect(
      calls.some((url) => url.includes('/api/v1/graph/persons/445') && !url.includes('/network')),
    ).toBe(true);

    // network-445-depth1.json: 25 nodes, 38 edges, capped by the backend.
    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*25\s*·\s*EDGES\s*38/));
    expect(screen.getByText('Truncated at backend cap')).toBeInTheDocument();
    expect(screen.getAllByText('Ojas Kuruvilla').length).toBeGreaterThan(0);
  });

  it('asks the backend for depth 2 rather than widening the answer locally', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/network/445' });

    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*25\s*·\s*EDGES\s*38/));
    expect(calls.some((url) => url.includes('depth=1'))).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: '2-HOP' }));

    await waitFor(() => expect(calls.some((url) => url.includes('depth=2'))).toBe(true));
    // network-445-depth2.json: 60 nodes, 117 edges.
    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*60\s*·\s*EDGES\s*117/));
  });

  it('never sends the ground-truth overlay request, and reports the visible counts', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/network/445' });

    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*25/));
    // The SAME_RING overlay is the generator's answer key; it is never drawn.
    expect(calls.some((url) => url.includes('include_overlay=true'))).toBe(false);
    expect(screen.getByText(/25 entities and 38 relationships shown/)).toBeInTheDocument();
    // The rail is the sink for a node or edge click and starts genuinely empty.
    expect(screen.getByText('Select something on the graph')).toBeInTheDocument();
  });

  it('rejects a prefixed entity id in the route without calling the backend', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/network/person:445' });

    expect(await screen.findByText('That is not a person id')).toBeInTheDocument();
    // A 422 the interface can predict is a request it should not make.
    expect(calls).toHaveLength(0);
  });

  it('explains a 404 from the network endpoint instead of drawing an empty canvas', async () => {
    installFetch([]); // every URL unmatched -> recorded 404 envelope
    renderWithRouter(routedPage, { route: '/network/999999' });

    expect(await screen.findByText('No person with that id')).toBeInTheDocument();
    // The controls stay mounted so the view is recoverable, but nothing claims
    // to have drawn a network that never arrived.
    expect(screen.queryByText(/entities and .* relationships shown/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
});
