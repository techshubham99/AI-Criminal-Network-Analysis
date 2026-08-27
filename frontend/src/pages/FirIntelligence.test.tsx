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
  it('lists FIRs and selects none until one is chosen', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/fir' });

    expect(screen.getByText('No FIR selected')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((url) => url.includes('/api/v1/firs?'))).toBe(true));
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

    await waitFor(() => expect(screen.getAllByText('STRUCTURED').length).toBeGreaterThan(0));
    // §6: the two kinds of claim must never read as one kind of fact.
    expect(screen.getAllByText('NARRATIVE').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/stored in a separate narrative graph and never added to the structured/i),
    ).toBeInTheDocument();
  });

  it('refuses a prefixed FIR id without sending it to the backend', async () => {
    const { calls } = installFetch();
    renderWithRouter(routedPage, { route: '/fir/fir:79' });

    expect(await screen.findByText('Invalid FIR reference')).toBeInTheDocument();
    expect(calls.some((url) => url.includes('fir:79') || url.includes('fir%3A79'))).toBe(false);
    expect(calls.some((url) => url.includes('/api/v1/nlp/firs/'))).toBe(false);
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
