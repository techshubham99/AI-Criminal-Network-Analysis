/**
 * Alerts — the priority queue, the band filter and the pattern pair, at page level.
 *
 * What these cases hold in place:
 *
 *  1. THE QUEUE IS THE BACKEND'S ORDER. Rows, ranks and counts come from the
 *     recording; nothing is re-sorted or re-scored here.
 *  2. THE BAND FILTER IS A REQUEST. Choosing LOW must reach the API as `band=LOW`,
 *     not slice the ten rows already on screen — otherwise the queue would show
 *     "the LOW members of the top ten" while claiming to show the LOW band.
 *  3. AN EMPTY BAND SAYS SO. Nothing in this corpus reaches HIGH, and the recorded
 *     empty answer must render as empty rather than as the previous page's rows.
 *  4. A SCORE ARRIVES WITH ITS DERIVATION. Selecting a person drives the full
 *     priority panel; clicking a pattern loads that pattern.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { AlertsPage } from './AlertsPage';

const ranking = fixtures.priorityRanking;
const rankingLow = fixtures.priorityRankingLow;
const top = ranking.persons[0];

const render = () => renderWithRouter(<AlertsPage />, { route: '/alerts' });
const queueRows = () => screen.getAllByTestId('queue-row');
const awaitQueue = () => waitFor(() => expect(queueRows().length).toBeGreaterThan(0));

describe('AlertsPage — the priority queue', () => {
  it('renders the recorded ranking and opens on its top row', async () => {
    const { calls } = installFetch();
    render();
    await awaitQueue();

    const rows = queueRows();
    expect(rows).toHaveLength(ranking.persons.length);
    expect(rows[0]).toHaveAttribute('data-person-id', String(top.person_id));
    // The queue opens on its own top row rather than on an empty panel.
    await waitFor(() => expect(queueRows()[0]).toHaveAttribute('aria-current'));
    expect(within(rows[0]).getByText(top.name)).toBeInTheDocument();
    expect(within(rows[0]).getByText(top.band)).toBeInTheDocument();
    expect(within(rows[0]).getByText(String(top.score))).toBeInTheDocument();

    // The header count is the backend's, and the rank order is the response order.
    expect(screen.getByText(`${ranking.count} shown`)).toBeInTheDocument();
    expect(rows.map((row) => row.getAttribute('data-person-id'))).toEqual(
      ranking.persons.map((person) => String(person.person_id)),
    );

    // The queue asks for the full page it means to show, not for a slice.
    expect(calls.some((url) => url.includes('/intelligence/persons/top?'))).toBe(true);
    expect(calls.some((url) => url.includes('limit=25'))).toBe(true);
    expect(calls.some((url) => url.includes('band='))).toBe(false);
  });

  it('drives the priority panel from the selected row', async () => {
    const { calls } = installFetch();
    render();

    await waitFor(() => expect(screen.getByTestId('priority-panel')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('priority-score')).toBeInTheDocument());

    const panel = screen.getByTestId('priority-panel');
    expect(screen.getByTestId('priority-score')).toHaveAttribute('data-band', top.band);
    expect(within(panel).getByText(String(top.score))).toBeInTheDocument();
    expect(within(panel).getByText(top.name)).toBeInTheDocument();

    // A score is never shown on its own.
    expect(within(panel).getByTestId('factor-breakdown')).toBeInTheDocument();
    expect(within(panel).getAllByTestId('factor-row').length).toBeGreaterThan(0);

    expect(calls).toContain(`/api/v1/intelligence/persons/${top.person_id}`);
  });

  it('quotes the backend note and disclaimer rather than paraphrasing them', async () => {
    installFetch();
    render();
    await awaitQueue();

    expect(screen.getByText(ranking.note)).toBeInTheDocument();
    expect(screen.getByText(ranking.disclaimer)).toBeInTheDocument();
  });

  it('filters by band at the backend and re-opens on the new top row', async () => {
    const { calls } = installFetch();
    render();
    await awaitQueue();

    fireEvent.click(screen.getByRole('radio', { name: 'LOW' }));

    await waitFor(() => expect(queueRows()).toHaveLength(rankingLow.persons.length));
    expect(calls.some((url) => url.includes('band=LOW'))).toBe(true);

    const rows = queueRows();
    for (const row of rows) expect(within(row).getByText('LOW')).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute('data-person-id', String(rankingLow.persons[0].person_id));

    // The selection followed the filter, so the panel cannot still show a person
    // the queue no longer lists.
    await waitFor(() =>
      expect(screen.getByTestId('priority-score')).toHaveAttribute('data-band', 'LOW'),
    );
    expect(calls).toContain(`/api/v1/intelligence/persons/${rankingLow.persons[0].person_id}`);
  });

  it('reports a band with no members as empty', async () => {
    installFetch();
    render();
    await awaitQueue();

    fireEvent.click(screen.getByRole('radio', { name: 'HIGH' }));

    await waitFor(() => expect(screen.getByText('No persons in this band')).toBeInTheDocument());
    expect(screen.queryAllByTestId('queue-row')).toHaveLength(0);
    // No stale score left standing beside an empty queue.
    await waitFor(() => expect(screen.getByText('Select a person')).toBeInTheDocument());
    expect(screen.queryByTestId('priority-score')).not.toBeInTheDocument();
  });

  it('surfaces a failed ranking instead of an empty queue', async () => {
    installFetch([
      { match: '/api/v1/intelligence/persons/top', body: fixtures.error404Person, status: 500 },
    ]);
    render();

    await waitFor(() =>
      expect(within(screen.getByTestId('priority-queue')).getByTestId('error-state')).toBeInTheDocument(),
    );
    expect(screen.queryAllByTestId('queue-row')).toHaveLength(0);
  });
});

describe('AlertsPage — the pattern pair', () => {
  it('loads the pattern that was clicked', async () => {
    const { calls } = installFetch();
    render();

    await waitFor(() => expect(screen.getAllByTestId('pattern-row').length).toBeGreaterThan(0));
    expect(screen.getByText('No pattern selected')).toBeInTheDocument();

    const first = fixtures.patternsPage1.patterns[0];
    fireEvent.click(screen.getAllByTestId('pattern-row')[0]);

    await waitFor(() => expect(screen.getByTestId('pattern-details')).toBeInTheDocument());
    expect(
      calls.some((url) =>
        url.includes(`/intelligence/patterns/${encodeURIComponent(first.pattern_id)}`),
      ),
    ).toBe(true);
    expect(
      within(screen.getByTestId('pattern-details')).getByText(fixtures.patternDetail.pattern_id),
    ).toBeInTheDocument();
  });

  it('keeps the pattern list corpus-wide, not scoped to the selected person', async () => {
    const { calls } = installFetch();
    render();

    await waitFor(() => expect(screen.getAllByTestId('pattern-row').length).toBeGreaterThan(0));

    // The queue answers "who first"; the list answers "what was detected". A row
    // click must not quietly turn the second question into the first.
    const second = ranking.persons[1];
    fireEvent.click(queueRows()[1]);

    await waitFor(() =>
      expect(calls).toContain(`/api/v1/intelligence/persons/${second.person_id}`),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId('priority-panel')).getByText(second.name),
      ).toBeInTheDocument(),
    );
    expect(
      calls.some((url) => url.includes('/intelligence/patterns?') && url.includes('entity_id=')),
    ).toBe(false);
  });
});
