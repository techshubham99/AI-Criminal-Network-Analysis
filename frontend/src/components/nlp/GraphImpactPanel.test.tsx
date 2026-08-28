/**
 * GraphImpactPanel — §6's "resolution status" and the honest end of §3's NLP
 * story, from the recorded `/nlp/firs/79/graph-impact` response.
 *
 * The Phase 3 verification of this corpus produced a NEGATIVE result: narrative
 * extraction adds no new connectivity. Either a proposed relationship restates a
 * structured edge, or it joins two entities the structured graph already links by
 * another path. The brief forbids claiming hidden connections the corpus does not
 * provide, so the job of this panel is to make that negative legible — computed
 * from the response, never hardcoded.
 *
 * FIR 79 exercises both halves at once: one proposal rejected as a duplicate, one
 * accepted while the validator itself records that the two entities were already
 * connected at 2 hops. Those two sentences are the ones asserted hardest here.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { GraphAdditionOut, GraphImpactResponse } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { GraphImpactPanel } from './GraphImpactPanel';

const impact = fixtures.firGraphImpact79 as unknown as GraphImpactResponse;
const proposed = (impact.proposed_additions ?? []) as GraphAdditionOut[];
const rejected = proposed.find((addition) => addition.status === 'rejected_duplicate')!;
const accepted = proposed.find((addition) => addition.status === 'accepted_additive')!;

function renderPanel(payload: GraphImpactResponse = impact) {
  return renderWithRouter(<GraphImpactPanel impact={payload} />);
}

/** The summary tile grid, so a label like "Accepted" is not confused with a badge. */
function summaryGrid(): HTMLElement {
  const anchor = screen.getByText('Entities extracted');
  const grid = anchor.closest('div.inset');
  if (!grid) throw new Error('the summary tiles are not inside their grid');
  return grid as HTMLElement;
}

/** The value rendered beside a summary tile's label. */
function stat(label: string): string {
  const labelEl = within(summaryGrid()).getByText(label);
  const value = labelEl.nextElementSibling;
  if (!value) throw new Error(`the tile "${label}" has no value`);
  return value.textContent ?? '';
}

/** The single <article> containing `text` — cards are addressed by content. */
function articleWith(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('article')).filter((article) =>
    article.textContent?.includes(text),
  );
  if (found.length !== 1) {
    throw new Error(`expected exactly one card containing "${text}", found ${found.length}`);
  }
  return found[0] as HTMLElement;
}

function fieldIn(scope: HTMLElement, label: string): HTMLElement {
  const dts = Array.from(scope.querySelectorAll('dt'));
  const dt = dts.find((el) => el.querySelector('span')?.textContent?.trim() === label);
  if (!dt) {
    const seen = dts.map((el) => el.querySelector('span')?.textContent?.trim()).join(' | ');
    throw new Error(`no field labelled "${label}". Present: ${seen}`);
  }
  const dd = dt.parentElement?.querySelector('dd');
  if (!dd) throw new Error(`field "${label}" has no value cell`);
  return dd as HTMLElement;
}

describe('GraphImpactPanel — the structured graph is untouched', () => {
  it('needs no backend of its own', async () => {
    const { calls } = installFetch();
    renderPanel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('states that the evidence graph was not modified, quoting the flag', () => {
    expect(impact.structured_graph_mutated).toBe(false);
    renderPanel();

    // The two words the whole panel turns on are emphasised, so they are their
    // own element rather than part of the surrounding sentence.
    expect(screen.getByText('not modified')).toBeInTheDocument();
    expect(screen.getByText('structured_graph_mutated: false')).toBeInTheDocument();
    expect(
      screen.getByText(/held in a separate narrative graph, never merged into/i),
    ).toBeInTheDocument();
  });

  it('treats a mutated graph as a contradiction to investigate, not a feature', () => {
    // The design says this can never happen. If the backend ever says otherwise,
    // the panel must say so rather than quietly rendering it as normal.
    renderPanel({ ...impact, structured_graph_mutated: true });

    expect(screen.getByText('structured_graph_mutated: true')).toBeInTheDocument();
    expect(
      screen.getByText(/contradicts this system's stated design/i),
    ).toBeInTheDocument();
  });

  it('identifies the FIR and the record its narrative came from', () => {
    renderPanel();
    expect(screen.getByText(/What the extractor proposed for FIR 79/i)).toBeInTheDocument();
    // firs:79 is cited twice: once as this response's source, once on the edge.
    expect(screen.getAllByText(impact.source_record_id as string).length).toBeGreaterThan(0);
    expect(screen.getAllByText('NARRATIVE').length).toBeGreaterThan(0);
  });
});

describe('GraphImpactPanel — what the validator did with the proposals', () => {
  it('reports the accepted/proposed split from the response', () => {
    renderPanel();
    // 1 of 2 admitted, 1 rejected as already present.
    expect(screen.getByText(/1 of 2 proposals/)).toBeInTheDocument();
    expect(
      screen.getByText(/rejected as already present in the\s+structured graph/i),
    ).toBeInTheDocument();
  });

  it('denies that an admitted edge is by itself a new link between people', () => {
    renderPanel();
    // The sentence that keeps this screen honest.
    expect(
      screen.getByText(/an admitted edge is not by itself a new\s+link between people/i),
    ).toBeInTheDocument();
  });

  it('says plainly when every proposal merely restated a structured edge', () => {
    renderPanel({
      ...impact,
      proposed_additions: [rejected],
      accepted_additions: [],
      rejected_additions: [rejected],
    });

    expect(
      screen.getByText(/confirmed links the evidence graph already held and added no new connectivity/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/That is the result, not a shortfall of the extractor/i)).toBeInTheDocument();
  });

  it('says when nothing was admitted for some other reason', () => {
    renderPanel({
      ...impact,
      proposed_additions: [{ ...rejected, status: 'rejected_endpoint_unresolved' }],
      accepted_additions: [],
      rejected_additions: [{ ...rejected, status: 'rejected_endpoint_unresolved' }],
    });

    expect(
      screen.getByText(/None of the 1 proposal from this narrative was admitted/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/No narrative edge was created from this FIR/i)).toBeInTheDocument();
  });

  it('says when the narrative proposed nothing at all', () => {
    renderPanel({
      ...impact,
      proposed_additions: [],
      accepted_additions: [],
      rejected_additions: [],
    });

    expect(
      screen.getByText(/proposed no relationship to the graph at all/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/still needs an explicit trigger phrase with\s+resolved endpoints/i),
    ).toBeInTheDocument();
  });
});

describe('GraphImpactPanel — the counts come from the response', () => {
  it('renders each summary figure the backend sent', () => {
    renderPanel();
    expect(stat('Entities extracted')).toBe('6');
    expect(stat('Resolved')).toBe('5');
    expect(stat('Unresolved')).toBe('0');
    expect(stat('Ambiguous')).toBe('0');
    expect(stat('Validated relationships')).toBe('2');
    expect(stat('Proposed')).toBe('2');
    expect(stat('Accepted')).toBe('1');
    expect(stat('Rejected')).toBe('1');
  });

  it('does not invent a figure the backend omitted', () => {
    renderPanel({ ...impact, summary: { ...impact.summary, resolved_entity_count: undefined } });
    expect(stat('Resolved')).toBe('—');
  });

  it('badges the validator’s own status tokens with their counts', () => {
    renderPanel();
    expect(screen.getByText('Accepted additive · 1')).toBeInTheDocument();
    expect(screen.getByText('Rejected duplicate · 1')).toBeInTheDocument();
  });

  it('explains what those status tokens mean', () => {
    renderPanel();
    expect(
      screen.getByText(/'rejected_duplicate' means an equivalent structured edge already existed/i),
    ).toBeInTheDocument();
  });
});

describe('GraphImpactPanel — each proposal is auditable', () => {
  it('quotes the validator’s reason for the rejection, and the edge it duplicated', () => {
    renderPanel();
    const card = articleWith(rejected.duplicate_of as string);

    expect(card).toHaveTextContent(rejected.reason as string);
    expect(fieldIn(card, 'Accepted')).toHaveTextContent('No');
    expect(fieldIn(card, 'Duplicate of')).toHaveTextContent(
      'REPORTED_AGAINST~person:114~person:445',
    );
    expect(
      screen.getByText(/The existing structured relationship this proposal restated/i),
    ).toBeInTheDocument();
  });

  it('shows that the accepted proposal joined entities already connected structurally', () => {
    renderPanel();
    const card = articleWith('Structured hop distance');

    expect(card).toHaveTextContent(accepted.reason as string);
    expect(fieldIn(card, 'Accepted')).toHaveTextContent('Yes');
    // The validator's own detail: the two were already 2 hops apart.
    expect(fieldIn(card, 'Structured hop distance')).toHaveTextContent('2');
    expect(fieldIn(card, 'Narrative edge ID')).toHaveTextContent(
      'narr~LOCATED_AT~person:445~location:178',
    );
  });

  it('shows the accepted/rejected partition of those same proposals', () => {
    renderPanel();
    expect(screen.getByText('Accepted (1)')).toBeInTheDocument();
    expect(screen.getByText('Rejected (1)')).toBeInTheDocument();
  });

  it('lists no proposal card when there was no proposal', () => {
    renderPanel({
      ...impact,
      proposed_additions: [],
      accepted_additions: [],
      rejected_additions: [],
    });
    expect(screen.queryByText(/Proposed additions/i)).not.toBeInTheDocument();
  });
});

describe('GraphImpactPanel — the separate narrative graph', () => {
  it('shows the narrative edge with the trigger phrase that produced it', () => {
    renderPanel();
    const card = articleWith('Held in');

    expect(screen.getByText('Narrative graph edges (1)')).toBeInTheDocument();
    expect(within(card).getByText(/Trigger phrase: “was seen near”/)).toBeInTheDocument();
    expect(
      within(card).getByText(/Suspect Ojas Kuruvilla \(Phone \+91-7804841598\) was seen near the scene\./),
    ).toBeInTheDocument();
  });

  it('states which graph the edge is held in, and prints its confidence tier', () => {
    renderPanel();
    const card = articleWith('Held in');

    expect(fieldIn(card, 'Held in')).toHaveTextContent('Narrative graph (separate)');
    expect(fieldIn(card, 'Provenance confidence')).toHaveTextContent('0.70');
    expect(
      screen.getByText(/a fixed constant per rule, not a calibrated probability/i),
    ).toBeInTheDocument();
  });

  it('cites the record the edge is traceable to, and says an edge has no single one', () => {
    renderPanel();
    const card = articleWith('Held in');

    expect(fieldIn(card, 'Evidence')).toHaveTextContent('firs:79');
    // A single-day range is printed once, formatted for reading: 26 Jun 2026.
    expect(fieldIn(card, 'Date range')).toHaveTextContent('26 Jun 2026');
    expect(
      screen.getByText(/An edge has no single source_record_id/i),
    ).toBeInTheDocument();
  });

  it('reports a zero as a zero in its own right, not as a missing value', () => {
    renderPanel({ ...impact, narrative_edges: [] });

    expect(screen.getByText('Narrative graph edges (0)')).toBeInTheDocument();
    expect(
      screen.getByText(/a zero in its own right, not a\s+missing value/i),
    ).toBeInTheDocument();
  });
});

describe('GraphImpactPanel — backend prose', () => {
  it('shows no notes section when the response carries no prose', () => {
    renderPanel();
    expect(screen.queryByText('Backend notes')).not.toBeInTheDocument();
  });

  it('reproduces any explanatory string the summary carries, verbatim', () => {
    const note = 'narrative extraction added no new connectivity for this FIR';
    renderPanel({ ...impact, summary: { ...impact.summary, validator_note: note } });

    expect(screen.getByText('Backend notes')).toBeInTheDocument();
    expect(screen.getByText('Validator note')).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
  });
});
