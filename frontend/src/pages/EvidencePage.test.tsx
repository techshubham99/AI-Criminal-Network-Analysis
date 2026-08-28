/**
 * Evidence & Provenance — the §11 checklist items "evidence/provenance view
 * resolves an entity" and "entity search works", asserted at page level.
 *
 * The three cases below are the three shapes provenance actually takes on this
 * backend: an entity whose `source_record_id` names a row of a *different* table
 * (a phone is read off a person's row), an entity whose row is its own (a FIR),
 * and an id the graph simply does not contain — which is an answer, not an error.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installFetch, renderWithRouter } from '@/test/helpers';

import { EvidencePage } from './EvidencePage';

const PHONE_ROUTE = '/evidence?entity=phone%3A%2B91-7804841598';

describe('EvidencePage — resolve an entity, then show the row it came from', () => {
  it('asks for no entity data until an entity is named', async () => {
    const { calls } = installFetch();
    renderWithRouter(<EvidencePage />, { route: '/evidence' });

    expect(screen.getByText('No entity selected')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    // The page-level integrity read-out checks the audit chain on mount; nothing
    // else is requested, because nothing else has been asked for yet.
    await waitFor(() => expect(calls).toEqual(['/api/v1/audit/verify']));
  });

  it('finds entities through the graph search index', async () => {
    const { calls } = installFetch();
    renderWithRouter(<EvidencePage />, { route: '/evidence' });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ojas' } });

    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    expect(calls.some((url) => url.includes('/api/v1/graph/search?q=Ojas'))).toBe(true);
  });

  it('traces a phone to the person row it was read from', async () => {
    const { calls } = installFetch();
    renderWithRouter(<EvidencePage />, { route: PHONE_ROUTE });

    // Resolution is one exact-id lookup — the id goes in the query string.
    await waitFor(() =>
      expect(calls.some((url) => url.includes('/graph/search?q=phone%3A%2B91-7804841598'))).toBe(
        true,
      ),
    );

    await waitFor(() => expect(screen.getAllByText('PHONE').length).toBeGreaterThan(0));
    expect(screen.getAllByText('persons:445').length).toBeGreaterThan(0);

    // `source_record_id` is persons:445, so that is the row fetched — not
    // `/persons/+91-7804841598`, which is not a thing this backend has.
    await waitFor(() => expect(calls.some((url) => url.includes('/api/v1/persons/445'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Ojas Kuruvilla')).toBeInTheDocument());

    // `ring_id` is the generator's answer key: shown once, inside the tagged
    // overlay block, and nowhere in the record's own field list.
    const overlay = screen.getByTestId('overlay-block');
    expect(overlay.textContent).toContain('ring_id');
    expect(screen.getAllByText('ring_id')).toHaveLength(1);
    expect(screen.getByText(/never used to rank, colour, cluster or filter/i)).toBeInTheDocument();

    // A phone cannot root a network on this backend, and the page says so
    // instead of offering a link that would 422.
    expect(screen.getByText(/network endpoint is person-rooted/i)).toBeInTheDocument();
    expect(
      screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/network/445'),
    ).toBe(false);
  });

  it('shows a FIR’s own row and offers its narrative view', async () => {
    const { calls } = installFetch();
    renderWithRouter(<EvidencePage />, { route: '/evidence?entity=fir%3A79' });

    await waitFor(() => expect(screen.getAllByText('FIR').length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.some((url) => url.includes('/api/v1/firs/79'))).toBe(true));

    expect(screen.getAllByText('firs:79').length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getByText(/Suspect Ojas Kuruvilla/)).toBeInTheDocument(),
    );
    expect(
      screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/fir/79'),
    ).toBe(true);
  });

  it('reports an id the graph does not contain as an answer, not a failure', async () => {
    installFetch();
    renderWithRouter(<EvidencePage />, { route: '/evidence?entity=person%3A99999' });

    expect(await screen.findByText('The graph does not contain this entity')).toBeInTheDocument();
    // count: 0 arrived over HTTP 200. Nothing here is an error state.
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
