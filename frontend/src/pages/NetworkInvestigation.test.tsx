/**
 * Network Investigation — the full-page investigation workspace: subject search,
 * the header that names the subject, the tab bar, and the graph that owns the
 * main content area when the Network tab is active.
 *
 * Node and edge *clicks* are exercised against a real renderer in the browser
 * smoke test, not here: jsdom has no canvas, so Cytoscape is built headless and
 * a tap on a node cannot be synthesised through the DOM. What these tests pin
 * down instead is everything around the canvas — that a search reaches the real
 * endpoint, that the depth control changes the request rather than filtering
 * locally, that the counts shown are the backend's own, and that each tab shows
 * its own product area rather than a second copy of the graph.
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

/**
 * The workspace opens on Overview — the subject has to be readable before the
 * canvas is. Every graph assertion therefore starts by opening the Network tab.
 */
async function openNetworkTab() {
  const tab = await screen.findByRole('tab', { name: 'Network' });
  fireEvent.click(tab);
  return waitFor(() => expect(screen.getByTestId('graph-toolbar')).toBeInTheDocument());
}

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
    // §7: the subject is named in a page header, not in a rail.
    await waitFor(() => expect(screen.getByTestId('subject-name')).toHaveTextContent('Ojas Kuruvilla'));
    expect(
      calls.some((url) => url.includes('/api/v1/graph/persons/445/network')),
    ).toBe(true);
    expect(
      calls.some((url) => url.includes('/api/v1/graph/persons/445') && !url.includes('/network')),
    ).toBe(true);

    await openNetworkTab();
    // network-445-depth1.json: 25 nodes, 38 edges, capped by the backend.
    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*25\s*·\s*EDGES\s*38/));
    expect(screen.getByText('Truncated at backend cap')).toBeInTheDocument();
  });

  it('asks the backend for depth 2 rather than widening the answer locally', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/network/445' });

    await openNetworkTab();
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

    await openNetworkTab();
    await waitFor(() => expect(toolbarText()).toMatch(/NODES\s*25/));
    // The SAME_RING overlay is the generator's answer key; it is never drawn.
    expect(calls.some((url) => url.includes('include_overlay=true'))).toBe(false);
    expect(screen.getByText(/25 entities and 38 relationships shown/)).toBeInTheDocument();
    // §6: selection detail arrives in a drawer over the canvas, so nothing takes
    // width from the graph until something is actually selected.
    expect(screen.queryByTestId('graph-drawer')).not.toBeInTheDocument();
  });

  it('opens on Overview, and each tab shows its own product area', async () => {
    installFetch();
    renderWithRouter(routedPage, { route: '/network/445' });

    // §6/§7: Overview is the landing tab and is full-width, not a narrow rail.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByTestId('key-relationships')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-toolbar')).not.toBeInTheDocument();

    // The eight views §7 names, each its own tab.
    for (const label of [
      'Overview', 'Network', 'Communication', 'Financial',
      'Locations', 'FIR', 'Timeline', 'Evidence',
    ]) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }

    // Communication renders the communication product area, not the graph.
    fireEvent.click(screen.getByRole('tab', { name: 'Communication' }));
    await waitFor(() => expect(screen.getByTestId('communication-view')).toBeInTheDocument());
    expect(screen.queryByTestId('graph-toolbar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Financial' }));
    await waitFor(() => expect(screen.getByTestId('financial-view')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Locations' }));
    await waitFor(() => expect(screen.getByTestId('locations-view')).toBeInTheDocument());
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
