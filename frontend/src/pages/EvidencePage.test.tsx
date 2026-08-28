/**
 * Evidence & Provenance — the §11 checklist items "evidence/provenance view
 * resolves an entity" and "entity search works", asserted at page level.
 *
 * The three cases below are the three shapes provenance actually takes on this
 * backend: an entity whose `source_record_id` names a row of a *different* table
 * (a phone is read off a person's row), an entity whose row is its own (a FIR),
 * and an id the graph simply does not contain — which is an answer, not an error.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { installFetch, renderWithRouter } from '@/test/helpers';

import { EvidencePage } from './EvidencePage';

const PHONE_ROUTE = '/evidence?entity=phone%3A%2B91-7804841598';

/**
 * Evidence with a stub FIR route mounted, so "open this FIR" can be proven to
 * leave this screen for the FIR one rather than merely rendering a control.
 */
const routedPage = (
  <Routes>
    <Route path="/evidence" element={<EvidencePage />} />
    <Route path="/fir/:firId" element={<FirRouteProbe />} />
  </Routes>
);

function FirRouteProbe() {
  return <p data-testid="fir-route">arrived</p>;
}

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
    expect(within(overlay).getByText(/Data-generator label/)).toBeInTheDocument();
    // The OVERLAY tag's own wording, inside that block: what the label is, and
    // what it is kept out of.
    expect(
      within(overlay).getByText(
        /not evidence and is excluded from the graph view and from every analytic/i,
      ),
    ).toBeInTheDocument();

    // A phone cannot root a network on this backend, so no route to one is
    // offered: no link, and no Investigate action either.
    expect(screen.queryByRole('button', { name: /investigate/i })).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole('link').some((link) => link.getAttribute('href') === '/network/445'),
    ).toBe(false);
  });

  it('shows a FIR’s own row and opens it in FIR Intelligence', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/evidence?entity=fir%3A79' });

    await waitFor(() => expect(screen.getAllByText('FIR').length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.some((url) => url.includes('/api/v1/firs/79'))).toBe(true));

    expect(screen.getAllByText('firs:79').length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getByText(/Suspect Ojas Kuruvilla/)).toBeInTheDocument(),
    );

    // The FIR is the one place this screen hands off to, and it really navigates.
    fireEvent.click(screen.getByRole('button', { name: /Open in FIR Intelligence/i }));
    expect(await screen.findByTestId('fir-route')).toBeInTheDocument();
  });

  it('reports an id the graph does not contain as an answer, not a failure', async () => {
    installFetch();
    renderWithRouter(<EvidencePage />, { route: '/evidence?entity=person%3A99999' });

    expect(await screen.findByText('The graph does not contain this entity')).toBeInTheDocument();
    // count: 0 arrived over HTTP 200. Nothing here is an error state.
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
