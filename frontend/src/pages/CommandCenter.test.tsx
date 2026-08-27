/**
 * CommandCenter — the §11 checklist items "command center loads" and "API errors
 * are handled", asserted at page level.
 *
 * Every number checked below is read out of the recorded backend responses rather
 * than written here: `data-summary.json` reports 500 persons, `graph-summary.json`
 * reports 3,803 nodes and 8,822 *observed* edges, `nlp-summary.json` reports 1,800
 * extracted entities. If the page ever starts computing a figure of its own, or
 * reads `edge_count` (10,802 — which includes the synthetic SAME_RING overlay)
 * where it should read `observed_edge_count`, these tests fail.
 */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installFetch, installOfflineFetch, renderWithRouter } from '@/test/helpers';

import { CommandCenter } from './CommandCenter';

/** Each stat tile's full text, so a label and its value can be checked together. */
const tileTexts = () =>
  screen.getAllByTestId('stat-tile').map((tile) => tile.textContent ?? '');

const hasTile = (label: string, value: string) =>
  tileTexts().some((text) => text.includes(label) && text.includes(value));

describe('CommandCenter — the dashboard is the backend, formatted', () => {
  it('reports the corpus scale from the recorded responses', async () => {
    installFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() => expect(screen.getAllByTestId('stat-tile').length).toBeGreaterThan(0));

    await waitFor(() => {
      // data/summary → counts.persons / counts.firs / counts.locations
      expect(hasTile('Persons on record', '500')).toBe(true);
      expect(hasTile('FIRs', '300')).toBe(true);
      expect(hasTile('Locations', '200')).toBe(true);
      // graph/summary → graph.node_count / graph.observed_edge_count
      expect(hasTile('Graph entities', '3,803')).toBe(true);
      expect(hasTile('Observed relationships', '8,822')).toBe(true);
      // nlp/summary → entity_count
      expect(hasTile('Narrative entities', '1,800')).toBe(true);
    });
  });

  it('counts observed edges, not the ground-truth overlay', async () => {
    installFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() => expect(hasTile('Observed relationships', '8,822')).toBe(true));
    // 10,802 is `edge_count` — observed plus the 1,980 synthetic SAME_RING edges.
    // It may appear as a clearly-labelled secondary row, but never as the headline.
    expect(tileTexts().some((text) => text.includes('10,802'))).toBe(false);
  });

  it('asks for the five dashboard endpoints and leaves /health to the top bar', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(5));
    for (const path of [
      '/api/v1/data/summary',
      '/api/v1/graph/summary',
      '/api/v1/nlp/summary',
      '/api/v1/analytics/demo',
      '/api/v1/analytics/persons/top',
    ]) {
      expect(calls.some((url) => url.includes(path))).toBe(true);
    }
    // A second heartbeat here would double the poll the shell already runs.
    expect(calls.some((url) => url.includes('/health'))).toBe(false);
  });

  it('opens the backend’s own deterministic demo subject', async () => {
    installFetch();
    renderWithRouter(<CommandCenter />);

    // analytics/demo picks person:445 "Ojas Kuruvilla"; the route takes the integer.
    await waitFor(() => expect(screen.getAllByText(/Ojas Kuruvilla/).length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(
        screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/network/445'),
      ).toBe(true),
    );
    // The selection rule is quoted, so the pick is auditable rather than magic.
    expect(screen.getByText(/highest observed degree/i)).toBeInTheDocument();
  });

  it('quarantines the generator’s ring label away from every headline figure', async () => {
    installFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() => expect(screen.getAllByTestId('overlay-block').length).toBeGreaterThan(0));
    // `ground_truth_ring_id` and `ring_distribution` are the answer key. They are
    // shown for transparency inside a tagged overlay block — never as a metric.
    for (const text of tileTexts()) {
      expect(text).not.toMatch(/ring_id|ground_truth|ring_distribution/i);
    }
  });

  it('states that Phase 4 risk scoring does not exist in this build', async () => {
    installFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() =>
      expect(screen.getByText(/Phase 4 risk scoring is not implemented/i)).toBeInTheDocument(),
    );
    expect(screen.getByText('NOT A RISK SCORE')).toBeInTheDocument();
  });

  it('reports a dead backend per request, with a retry, instead of an empty page', async () => {
    installOfflineFetch();
    renderWithRouter(<CommandCenter />);

    await waitFor(() => expect(screen.getAllByTestId('error-state').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Cannot reach the analysis backend/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    // No fabricated zeroes stand in for the numbers that never arrived.
    expect(tileTexts().some((text) => text.includes('500'))).toBe(false);
  });
});
