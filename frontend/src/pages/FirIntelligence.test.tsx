/**
 * FIR Intelligence — the §11 checklist items "FIR detail page loads", "NLP
 * extraction results render" and the structured-vs-narrative distinction §6
 * requires, asserted at page level.
 *
 * The numbers checked here are the recordings' own: FIR 79 has 6 extracted
 * entities and 2 asserted relationships, and the corpus has 300 FIRs. Nothing on
 * the page may state a figure this file cannot trace to a fixture.
 */
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { defaultRoutes, installFetch, renderWithRouter } from '@/test/helpers';

import { FirIntelligence } from './FirIntelligence';

/** Both routes, so `:firId` is a real route param rather than always absent. */
const routedPage = (
  <Routes>
    <Route path="/fir" element={<FirIntelligence />} />
    <Route path="/fir/:firId" element={<FirIntelligence />} />
  </Routes>
);

describe('FirIntelligence — the record as filed, beside what was read out of it', () => {
  it('is the FIR list when no FIR is selected, and asks for no extraction', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/fir' });

    // §5: useful with nothing selected. The list IS the page — not an empty
    // detail pane waiting for a click.
    expect(screen.getByRole('heading', { name: 'FIR Intelligence' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((url) => url.includes('/api/v1/firs?'))).toBe(true));
    for (const column of ['FIR', 'Date', 'Complainant', 'Accused', 'Location', 'Narrative']) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(
        screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/fir/1'),
      ).toBe(true),
    );
    // No narrative extraction is requested for a FIR nobody opened.
    expect(calls.some((url) => url.includes('/api/v1/nlp/firs/'))).toBe(false);
  });

  it('renders the record and all four extraction sections for FIR 79', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/fir/79' });

    // 01 — structured record, straight from the `firs` row.
    expect(await screen.findByRole('heading', { name: /FIR record/ })).toBeInTheDocument();
    // The date column is shown through the app's date formatter, so assert the
    // dataset citation instead of guessing its display form.
    await waitFor(() => expect(screen.getAllByText('firs:79').length).toBeGreaterThan(0));
    expect(screen.getAllByText('person:114').length).toBeGreaterThan(0); // complainant
    expect(screen.getAllByText('person:445').length).toBeGreaterThan(0); // accused
    // The location opens in Evidence, and the query parameter carries the
    // PREFIXED id, percent-encoded by URLSearchParams.
    expect(
      screen
        .getAllByRole('link')
        .some((link) => link.getAttribute('href') === '/evidence?entity=location%3A178'),
    ).toBe(true);

    // 02/03 — narrative verbatim, then what the extractor claimed about it.
    await waitFor(() =>
      expect(screen.getAllByText(/Suhani Chand \(Aadhar 409029431863\)/).length).toBeGreaterThan(0),
    );
    const entities = await screen.findByRole('heading', { name: /Extracted entities/ });
    expect(entities).toBeInTheDocument();
    // nlp-fir-79-entities.json reports entity_count 6.
    expect(screen.getByText('Entities').parentElement?.textContent).toContain('6');
    // A DATE mention that no node type can hold is reported as such, not dropped.
    expect(
      screen.getByText(/no DATE\/EVENT node type is materialised/i),
    ).toBeInTheDocument();

    // 04 — relationships, with the backend's own caveat quoted rather than
    // paraphrased: two people in one FIR is never enough to assert a link.
    expect(await screen.findByRole('heading', { name: /Extracted relationships/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText(/two people appearing in the same FIR is never sufficient/i),
      ).toBeInTheDocument(),
    );

    // 05 — graph impact, which on this backend is per-FIR, not corpus-wide (the
    // panel says so, and repeats the heading over its inner accepted/rejected
    // breakdown, hence findAllBy).
    expect((await screen.findAllByRole('heading', { name: /Graph impact/ })).length).toBeGreaterThan(
      0,
    );
    for (const path of [
      '/api/v1/firs/79',
      '/api/v1/nlp/firs/79/entities',
      '/api/v1/nlp/firs/79/relationships',
      '/api/v1/nlp/firs/79/graph-impact',
    ]) {
      expect(calls.some((url) => url.includes(path))).toBe(true);
    }
    // The shared entities request is issued once for sections 02 and 03.
    expect(calls.filter((url) => url.includes('/nlp/firs/79/entities'))).toHaveLength(1);
  });

  it('tags the record as structured and the extraction as narrative-derived', async () => {
    installFetch();
    renderWithRouter(routedPage, { route: '/fir/79' });

    // The tags are compact on a dense screen; the claim each one makes lives in
    // its tooltip, which is in the document either way.
    await waitFor(() => expect(screen.getAllByText('STRUCT').length).toBeGreaterThan(0));
    // §6: the two kinds of claim must never read as one kind of fact.
    expect(screen.getAllByText('NARRATIVE').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/never merged into the structured graph/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/recorded column value, not an inference/i).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a prefixed FIR id without sending it to the backend', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/fir/fir:79' });

    expect(await screen.findByText('Invalid FIR reference')).toBeInTheDocument();
    expect(calls.some((url) => url.includes('fir:79') || url.includes('fir%3A79'))).toBe(false);
    expect(calls.some((url) => url.includes('/api/v1/nlp/firs/'))).toBe(false);
  });

  it('answers an unknown FIR id with a 404 state and a way back', async () => {
    // The backend's own envelope for a missing row, ahead of the list route so the
    // detail URL is not swallowed by it.
    const { calls } = installFetch([
      {
        match: '/api/v1/firs/424242',
        body: { error: { code: 'not_found', message: 'FIR 424242 not found.' } },
        status: 404,
      },
      ...defaultRoutes(),
    ]);
    renderWithRouter(routedPage, { route: '/fir/424242' });

    expect(await screen.findByText('FIR 424242 not found')).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/api/v1/firs/424242'))).toBe(true);
    // §5: concise, and the only offered next step is the list.
    expect(screen.getByRole('button', { name: 'Back to the FIR list' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Extracted entities/ })).not.toBeInTheDocument();
  });

  it('fails one section at a time when an extraction request fails', async () => {
    // Only the entities endpoint is missing; everything else still answers.
    const routes = defaultRoutes().filter(
      (route) => String(route.match) !== '/api/v1/nlp/firs/79/entities',
    );
    installFetch(routes);
    renderWithRouter(routedPage, { route: '/fir/79' });

    expect(await screen.findByText('Entity extraction unavailable')).toBeInTheDocument();
    // The structured record is a different request and is unaffected.
    await waitFor(() => expect(screen.getAllByText('person:445').length).toBeGreaterThan(0));
    expect(await screen.findByRole('heading', { name: /Extracted relationships/ })).toBeInTheDocument();
  });
});
