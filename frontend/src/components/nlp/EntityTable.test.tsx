/**
 * EntityTable — §6's required columns (type / raw text / normalized value /
 * confidence / extraction method / evidence span) and §11's "NLP results render
 * correctly", asserted against the recorded `/nlp/firs/79/entities` response.
 *
 * FIR 79 is a lucky recording: one narrative produces three genuinely different
 * resolution outcomes, so the honesty of the last column can be tested for real
 * rather than argued about —
 *
 *   - a DATE that CANNOT resolve, because the Phase 2 graph materialises no DATE
 *     node type. The backend says so in its own `reason`, and that sentence has to
 *     reach the screen or the row just looks like a failed match;
 *   - a LOCATION that resolved only after 25 candidate rows were narrowed by the
 *     FIR's own `location_id`. The candidate count must stay visible;
 *   - a PHONE whose normalized value (`7804841598`) differs from its raw mention
 *     (`+91-7804841598`), which is the whole point of having a normalized column.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedEntityOut } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { EntityTable } from './EntityTable';

const recorded = fixtures.firEntities79 as unknown as {
  narrative: string;
  entity_count: number;
  entities: ResolvedEntityOut[];
};
const entities = recorded.entities;

/** The table row whose raw-text button reads exactly `rawText`. */
function row(rawText: string): HTMLElement {
  const button = screen.getByRole('button', { name: rawText });
  const tr = button.closest('tr');
  if (!tr) throw new Error(`the raw text "${rawText}" is not inside a table row`);
  return tr as HTMLElement;
}

const rows = () => Array.from(document.querySelectorAll('tbody tr'));

/**
 * A single cell of a row, by column position. Several values legitimately repeat
 * inside one row — an extraction method is also named in its own tooltip — so the
 * column-level assertions below address the cell rather than the row.
 */
const COLUMN = {
  type: 0,
  rawText: 1,
  normalized: 2,
  confidence: 3,
  method: 4,
  span: 5,
  resolution: 6,
} as const;

function cell(tr: HTMLElement, column: keyof typeof COLUMN): HTMLElement {
  const td = tr.children[COLUMN[column]];
  if (!td) throw new Error(`the row has no ${column} cell`);
  return td as HTMLElement;
}

function renderTable(props: Partial<Parameters<typeof EntityTable>[0]> = {}) {
  return renderWithRouter(<EntityTable entities={props.entities ?? entities} {...props} />);
}

describe('EntityTable — the recorded extraction', () => {
  it('needs no backend of its own: the page hands it the response', async () => {
    const { calls } = installFetch();
    renderTable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('renders one row per extracted entity, and the response agrees on the count', () => {
    renderTable();
    expect(rows()).toHaveLength(entities.length);
    expect(entities).toHaveLength(recorded.entity_count);
  });

  it('shows every raw mention exactly as the narrative wrote it', () => {
    renderTable();
    for (const item of entities) {
      expect(screen.getByRole('button', { name: item.entity.raw_text })).toBeInTheDocument();
    }
  });

  it('shows a normalized value that differs from the raw mention', () => {
    renderTable();
    // +91-7804841598 -> 7804841598. This is the value the resolver matches on.
    expect(cell(row('+91-7804841598'), 'normalized').textContent).toBe('7804841598');
  });

  it('prints the half-open character span the highlighter uses', () => {
    renderTable();
    // The recorded DATE occupies [14, 24).
    expect(cell(row('2026-06-26'), 'span').textContent).toBe('14–24');
  });

  it('names the mechanism that produced each entity', () => {
    renderTable();
    expect(cell(row('Suhani Chand'), 'method').textContent).toBe('Known record');
    expect(cell(row('409029431863'), 'method').textContent).toBe('Regex');
  });

  it('surfaces the role the extractor bound a person to', () => {
    renderTable();
    expect(cell(row('Suhani Chand'), 'type')).toHaveTextContent('Complainant');
    expect(cell(row('Ojas Kuruvilla'), 'type')).toHaveTextContent('Accused');
  });
});

describe('EntityTable — confidence is a rule tier, not a probability', () => {
  it('prints the tier as a decimal and never as a percentage', () => {
    renderTable();
    const confidence = cell(row('Suhani Chand'), 'confidence');
    // 1.0 -> "1.00". "100%" would claim a calibration nothing has measured.
    expect(confidence).toHaveTextContent('1.00');
    expect(confidence.textContent).not.toMatch(/%/);
  });

  it('says in the tooltip that these are fixed constants, not a trained model', () => {
    renderTable();
    expect(
      screen.getAllByText(/fixed constants set by the extraction rule that fired/i).length,
    ).toBeGreaterThan(0);
  });

  it('names the header hint as a fixed tier rather than a likelihood', () => {
    renderTable();
    expect(
      screen.getByText(/A fixed tier assigned by the extraction rule that fired/i),
    ).toBeInTheDocument();
  });
});

describe('EntityTable — resolution against the structured graph', () => {
  it('reports each recorded status, with the graph id it matched', () => {
    renderTable();
    const resolved = entities.filter((item) => item.resolution.status === 'resolved');
    expect(screen.getAllByText('Resolved')).toHaveLength(resolved.length);

    for (const item of resolved) {
      const matched = item.resolution.matched_entity_id as string;
      expect(within(row(item.entity.raw_text)).getByText(matched)).toBeInTheDocument();
    }
  });

  it('explains a NOT-APPLICABLE resolution in the backend’s own words', () => {
    renderTable();
    const date = entities.find((item) => item.entity.entity_type === 'DATE');
    expect(date?.resolution.status).toBe('not_applicable');

    const scope = cell(row('2026-06-26'), 'resolution');
    expect(within(scope).getByText('Not applicable')).toBeInTheDocument();
    // Verbatim, because the resolver's own sentence is a better explanation than
    // anything this UI could compose: it says the graph has no DATE node type.
    expect(
      within(scope).getByText(new RegExp(escapeRegExp(date!.resolution.reason as string))),
    ).toBeInTheDocument();
  });

  it('keeps the candidate count visible instead of hiding a narrowed match', () => {
    renderTable();
    const location = entities.find((item) => item.entity.entity_type === 'LOCATION');
    // 25 location records share "Bhopal, Madhya Pradesh".
    expect(location?.resolution.candidates).toHaveLength(25);

    const scope = cell(row('Bhopal, Madhya Pradesh'), 'resolution');
    expect(within(scope).getByText('25 candidates')).toBeInTheDocument();
    // The reason is quoted behind both the status badge and the candidate badge.
    expect(within(scope).getAllByText(/25 location records share/i).length).toBeGreaterThan(0);
  });

  it('shows the resolver’s own confidence separately from the extractor’s', () => {
    renderTable();
    const scope = row('Bhopal, Madhya Pradesh');
    // Extraction 1.0, resolution 0.9 — two different claims, both on screen.
    expect(cell(scope, 'confidence')).toHaveTextContent('1.00');
    expect(cell(scope, 'resolution')).toHaveTextContent('0.90');
  });

  it('names the resolution method behind the status badge', () => {
    renderTable();
    const scope = cell(row('Bhopal, Madhya Pradesh'), 'resolution');
    expect(within(scope).getAllByText(/Fir context location/i).length).toBeGreaterThan(0);
  });

  it('lists the records the resolver cited', () => {
    renderTable();
    expect(
      within(cell(row('Suhani Chand'), 'resolution')).getByText('persons:114'),
    ).toBeInTheDocument();
    // The Aadhaar number resolved via the person row that carries it.
    expect(
      within(cell(row('409029431863'), 'resolution')).getByText('persons:114'),
    ).toBeInTheDocument();
  });
});

describe('EntityTable — selection', () => {
  it('reports the index of the row the operator clicked', () => {
    const onActiveEntityChange = vi.fn();
    renderTable({ onActiveEntityChange });

    fireEvent.click(screen.getByRole('button', { name: 'Ojas Kuruvilla' }));
    // Ojas Kuruvilla is index 4 in the recorded response.
    expect(onActiveEntityChange).toHaveBeenCalledWith(4);
  });

  it('deselects when the active row is clicked again', () => {
    const onActiveEntityChange = vi.fn();
    renderTable({ onActiveEntityChange, activeEntityIndex: 4 });

    fireEvent.click(screen.getByRole('button', { name: 'Ojas Kuruvilla' }));
    expect(onActiveEntityChange).toHaveBeenCalledWith(null);
  });

  it('marks the active row so it pairs with the highlighted narrative span', () => {
    renderTable({ activeEntityIndex: 4, onActiveEntityChange: vi.fn() });
    expect(screen.getByRole('button', { name: 'Ojas Kuruvilla' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Suhani Chand' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('accepts a click anywhere on the row, not only on the raw text', () => {
    const onActiveEntityChange = vi.fn();
    renderTable({ onActiveEntityChange });

    fireEvent.click(row('Suhani Chand'));
    expect(onActiveEntityChange).toHaveBeenCalledWith(1);
  });
});

describe('EntityTable — nothing extracted', () => {
  it('calls an empty extraction a result rather than a failure', () => {
    renderTable({ entities: [] });
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText(/No entities extracted from this narrative/i)).toBeInTheDocument();
    expect(screen.getByText(/That is a result, not a failure/i)).toBeInTheDocument();
    expect(document.querySelector('tbody')).toBeNull();
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
