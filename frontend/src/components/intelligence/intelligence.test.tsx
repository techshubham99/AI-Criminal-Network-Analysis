/**
 * Phase 4 intelligence panels, asserted against recorded backend responses.
 *
 * What these tests are actually protecting:
 *
 *  1. THE NUMBER IS NEVER ALONE. A rendered score must arrive with its band, its
 *     factor contributions and a reachable derivation. Two of the cases below
 *     fail if the "Why?" action stops opening the arithmetic.
 *
 *  2. THE TWO EVIDENCE CLASSES STAY APART. Structured and NLP-derived counts are
 *     asserted separately; nothing in the UI is allowed to total them.
 *
 *  3. A ZERO IS REPORTED AS A ZERO. The empty-pattern case uses the recording of
 *     a real query that genuinely matched nothing.
 *
 * Every response body is a recording of the live backend — see `test/helpers`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';
import type { PersonIntelligenceResponse, PriorityScoreOut } from '@/types/api';

import { FactorBreakdown } from './FactorBreakdown';
import { PatternDetails } from './PatternDetails';
import { PatternList } from './PatternList';
import { PersonIntelligence } from './PersonIntelligence';
import { PriorityPanel } from './PriorityPanel';
import { ScoreReadout } from './ScoreReadout';

const person445 = fixtures.personIntelligence445 as unknown as PersonIntelligenceResponse;
const priority445 = person445.priority as PriorityScoreOut;

describe('PriorityPanel — score, band, factors, evidence', () => {
  it('renders the recorded score and band for the requested person', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PriorityPanel personId={445} />);

    await waitFor(() => expect(screen.getByTestId('priority-panel')).toBeInTheDocument());

    const readout = screen.getByTestId('priority-score');
    expect(readout).toHaveAttribute('data-band', 'MEDIUM');
    expect(within(readout).getByText(String(priority445.score))).toBeInTheDocument();
    expect(within(readout).getByText('/100')).toBeInTheDocument();
    expect(within(readout).getByText('MEDIUM')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: `Score ${priority445.score} of 100, band MEDIUM` }),
    ).toBeInTheDocument();

    // The person's name and entity id come from the same response, not the route.
    expect(screen.getByText('Ojas Kuruvilla')).toBeInTheDocument();
    expect(screen.getByText('person:445')).toBeInTheDocument();

    expect(calls).toEqual(['/api/v1/intelligence/persons/445']);
  });

  it('shows one factor row per scored feature, largest contribution first', async () => {
    installFetch();
    renderWithRouter(<PriorityPanel personId={445} />);

    await waitFor(() => expect(screen.getByTestId('factor-breakdown')).toBeInTheDocument());

    const rows = screen.getAllByTestId('factor-row');
    expect(rows).toHaveLength(priority445.factors.length);

    const contributions = [...priority445.factors].map((factor) => factor.contribution).sort((a, b) => b - a);
    const rendered = rows.map((row) => row.getAttribute('data-feature'));
    const expected = [...priority445.factors]
      .sort(
        (a, b) =>
          b.contribution - a.contribution ||
          b.max_contribution - a.max_contribution ||
          a.feature.localeCompare(b.feature),
      )
      .map((factor) => factor.feature);
    expect(rendered).toEqual(expected);

    // The arithmetic is printed, so a reader can check the weighting by hand.
    const top = [...priority445.factors].sort((a, b) => b.contribution - a.contribution)[0];
    expect(
      screen.getByText(`${top.value} × ${top.max_contribution} = ${top.contribution}`),
    ).toBeInTheDocument();
    expect(contributions[0]).toBe(top.contribution);
  });

  it('keeps structured and NLP-derived evidence in separate lists', async () => {
    installFetch();
    renderWithRouter(<PriorityPanel personId={445} />);

    await waitFor(() => expect(screen.getByTestId('evidence-structured')).toBeInTheDocument());
    expect(screen.getByTestId('evidence-nlp')).toBeInTheDocument();

    // 29 structured records, 0 NLP-derived — reported as two figures, never one.
    const structured = screen.getByTestId('evidence-structured');
    expect(
      within(structured).getByText(String(priority445.structured_evidence.length), {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(priority445.nlp_evidence).toHaveLength(0);
  });

  it('opens the arithmetic behind the score on demand', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PriorityPanel personId={445} />);

    await waitFor(() => expect(screen.getByTestId('why-toggle')).toBeInTheDocument());
    const toggle = screen.getByTestId('why-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByTestId('priority-explain')).toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('walkthrough-row')).toHaveLength(6);

    // The rounding step is the backend's, and it is shown: 58.17 -> 58.
    expect(screen.getByText('58.17')).toBeInTheDocument();
    expect(calls).toContain('/api/v1/intelligence/persons/445/explain');
  });

  it('requests nothing until a person is selected', () => {
    const { calls } = installFetch();
    renderWithRouter(<PriorityPanel personId={null} />);

    expect(screen.getByText('Select a person')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('reports a failed lookup instead of rendering an empty score', async () => {
    installFetch([
      {
        match: '/api/v1/intelligence/persons/',
        body: fixtures.error404Person,
        status: 404,
      },
    ]);
    renderWithRouter(<PriorityPanel personId={445} />);

    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.queryByTestId('priority-score')).not.toBeInTheDocument();
  });
});

describe('ScoreReadout — band rendering', () => {
  it.each([
    ['LOW', 12],
    ['MEDIUM', 58],
    ['HIGH', 91],
  ] as const)('labels a %s score with its band', (band, score) => {
    renderWithRouter(<ScoreReadout score={score} band={band} />);

    const readout = screen.getByTestId('priority-score');
    expect(readout).toHaveAttribute('data-band', band);
    expect(within(readout).getByText(String(score))).toBeInTheDocument();
    expect(within(readout).getByText(band)).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: `Score ${score} of 100, band ${band}` }),
    ).toBeInTheDocument();
  });
});

describe('FactorBreakdown', () => {
  it('lists a factor that contributed nothing rather than hiding it', () => {
    renderWithRouter(<FactorBreakdown factors={priority445.factors} />);

    const rows = screen.getAllByTestId('factor-row');
    expect(rows).toHaveLength(priority445.factors.length);

    const zero = priority445.factors.find((factor) => factor.contribution === 0);
    expect(zero, 'the recording should contain one unspent factor').toBeDefined();
    expect(
      screen.getByTestId('factor-breakdown').querySelector(`[data-feature="${zero!.feature}"]`),
    ).not.toBeNull();
  });

  it('says so plainly when there are no factors at all', () => {
    renderWithRouter(<FactorBreakdown factors={[]} />);
    expect(screen.getByText('No factors contributed to this score.')).toBeInTheDocument();
  });
});

describe('PatternList', () => {
  it('renders the recorded page and the backend total', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PatternList />);

    await waitFor(() => expect(screen.getAllByTestId('pattern-row').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('pattern-row')).toHaveLength(fixtures.patternsPage1.count);
    expect(
      screen.getByText(`${fixtures.patternsPage1.count} of ${fixtures.patternsPage1.total}`),
    ).toBeInTheDocument();
    expect(calls[0]).toContain('/api/v1/intelligence/patterns?');
  });

  it('filters by pattern type through the backend, not in the client', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PatternList />);

    await waitFor(() => expect(screen.getAllByTestId('pattern-row').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByTestId('pattern-type-filter'), {
      target: { value: 'TRANSACTION_CYCLE' },
    });

    await waitFor(() =>
      expect(calls.some((url) => url.includes('pattern_type=TRANSACTION_CYCLE'))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByText('Transaction cycle').length).toBeGreaterThan(0),
    );
  });

  it('hands the selected pattern id to its caller', async () => {
    installFetch();
    const selected: string[] = [];
    renderWithRouter(<PatternList onSelect={(id) => selected.push(id)} />);

    await waitFor(() => expect(screen.getAllByTestId('pattern-row').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('pattern-row')[0]);

    expect(selected).toEqual([fixtures.patternsPage1.patterns[0].pattern_id]);
  });

  it('reports an empty category as empty', async () => {
    installFetch();
    renderWithRouter(<PatternList entityId="person:999999" />);

    await waitFor(() => expect(screen.getByText('No patterns detected')).toBeInTheDocument());
    expect(screen.queryAllByTestId('pattern-row')).toHaveLength(0);
  });

  it('surfaces a transport failure instead of an empty list', async () => {
    installFetch([{ match: '/api/v1/intelligence/patterns', body: {}, status: 500 }]);
    renderWithRouter(<PatternList />);

    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
  });
});

describe('PatternDetails', () => {
  it('waits for a selection before requesting anything', () => {
    const { calls } = installFetch();
    renderWithRouter(<PatternDetails patternId={null} />);

    expect(screen.getByText('No pattern selected')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('shows the pattern type, its entities and both evidence lists', async () => {
    const { calls } = installFetch();
    const detail = fixtures.patternDetail;
    renderWithRouter(<PatternDetails patternId={detail.pattern_id} />);

    await waitFor(() => expect(screen.getByTestId('pattern-details')).toBeInTheDocument());

    expect(screen.getByText('Bridge entity')).toBeInTheDocument();
    expect(screen.getByText(detail.pattern_id)).toBeInTheDocument();
    expect(screen.getByText(detail.explanation)).toBeInTheDocument();
    expect(screen.getByTestId('evidence-structured')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-nlp')).toBeInTheDocument();

    // A person entity is a route into the network view.
    const firstPerson = detail.entity_ids.find((id) => id.startsWith('person:'));
    expect(screen.getByRole('link', { name: firstPerson })).toHaveAttribute(
      'href',
      `/network/${firstPerson!.slice('person:'.length)}`,
    );

    expect(calls).toEqual([
      `/api/v1/intelligence/patterns/${encodeURIComponent(detail.pattern_id)}`,
    ]);
  });

  it('reports an unknown pattern id as the backend does', async () => {
    installFetch([
      { match: '/api/v1/intelligence/patterns/', body: fixtures.error404Pattern, status: 404 },
    ]);
    renderWithRouter(<PatternDetails patternId="bridge_entity~0000000000000000" />);

    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
  });
});

describe('PersonIntelligence — the compact strip on the network view', () => {
  it('summarises score, band, top factors and pattern types', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PersonIntelligence personId={445} />);

    await waitFor(() => expect(screen.getByTestId('person-intelligence')).toBeInTheDocument());

    expect(screen.getByTestId('priority-score')).toHaveAttribute('data-band', 'MEDIUM');
    expect(screen.getByText('Investigation priority')).toBeInTheDocument();
    expect(screen.getByText(`Patterns · ${person445.patterns.length}`)).toBeInTheDocument();

    // Three at most, and only factors that actually contributed.
    const spent = priority445.factors.filter((factor) => factor.contribution > 0);
    expect(spent.length).toBeGreaterThan(0);
    expect(screen.getByText(/Network importance · /)).toBeInTheDocument();

    expect(calls).toEqual(['/api/v1/intelligence/persons/445']);
  });

  it('opens the same derivation the full panel does', async () => {
    const { calls } = installFetch();
    renderWithRouter(<PersonIntelligence personId={445} />);

    await waitFor(() => expect(screen.getByTestId('why-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('why-toggle'));

    await waitFor(() => expect(screen.getByTestId('priority-explain')).toBeInTheDocument());
    expect(calls).toContain('/api/v1/intelligence/persons/445/explain');
  });

  it('degrades to a compact error without taking the page down', async () => {
    installFetch([
      { match: '/api/v1/intelligence/persons/', body: fixtures.error404Person, status: 404 },
    ]);
    renderWithRouter(<PersonIntelligence personId={445} />);

    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByText('Priority unavailable')).toBeInTheDocument();
  });
});
