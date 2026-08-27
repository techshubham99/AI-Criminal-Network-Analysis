/**
 * NarrativeViewer — §6's "original narrative" plus the evidence span for every
 * extracted entity, laid over the text in place.
 *
 * This is the most persuasive thing on the FIR page, which is exactly why it is
 * the most dangerous: an overlay that quietly drops, duplicates or rewrites a
 * character has corrupted evidence. So the assertions below are about the text
 * itself rather than the styling —
 *
 *   - the rendered paragraph's `textContent` must equal the narrative EXACTLY,
 *     with highlights present;
 *   - a highlight must show the narrative's own substring, not the entity's
 *     `raw_text`, so drifted offsets are visible instead of being papered over;
 *   - overlapping spans must not double-wrap, and the count that was skipped must
 *     be admitted in prose.
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntityOut } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { NarrativeViewer } from './NarrativeViewer';

const recorded = fixtures.firEntities79 as unknown as {
  narrative: string;
  entities: Array<{ entity: EntityOut }>;
};
const narrative = recorded.narrative;
const entities: EntityOut[] = recorded.entities.map((item) => item.entity);

function renderViewer(props: Partial<Parameters<typeof NarrativeViewer>[0]> = {}) {
  return renderWithRouter(
    <NarrativeViewer
      narrative={props.narrative ?? narrative}
      entities={props.entities ?? entities}
      {...props}
    />,
  );
}

/** The paragraph that holds the interleaved plain-text and highlighted segments. */
function textBody(): HTMLElement {
  const anchor = screen.getAllByRole('button')[0];
  const paragraph = anchor.closest('p');
  if (!paragraph) throw new Error('no paragraph holds the narrative segments');
  return paragraph as HTMLElement;
}

const highlights = () =>
  Array.from(textBody().querySelectorAll('button')).map((button) => button.textContent);

describe('NarrativeViewer — the text is reproduced verbatim', () => {
  it('renders every character of the narrative, and no character twice', () => {
    renderViewer();
    // The single assertion that matters: highlights are wrappers, not edits.
    expect(textBody().textContent).toBe(narrative);
  });

  it('needs no backend of its own', async () => {
    const { calls } = installFetch();
    renderViewer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('highlights exactly the characters each recorded span claims', () => {
    renderViewer();
    const expected = entities.map((entity) =>
      narrative.slice(entity.character_start, entity.character_end),
    );
    expect(highlights()).toEqual(expected);
  });

  it('shows the narrative’s own substring, never the entity’s raw_text', () => {
    // Offsets kept, raw_text deliberately falsified. If the component trusted
    // raw_text, a drifted offset would silently rewrite the evidence.
    const falsified: EntityOut[] = [{ ...entities[1], raw_text: 'NOT-IN-THE-NARRATIVE' }];
    renderViewer({ entities: falsified });

    expect(highlights()).toEqual(['Suhani Chand']);
    expect(screen.queryByText(/NOT-IN-THE-NARRATIVE/)).not.toBeInTheDocument();
    expect(textBody().textContent).toBe(narrative);
  });

  it('keeps the record’s own spacing rather than collapsing it', () => {
    renderViewer();
    expect(textBody().className).toContain('whitespace-pre-wrap');
  });
});

describe('NarrativeViewer — overlapping and out-of-range offsets', () => {
  it('wraps no character twice and says how many spans it skipped', () => {
    // The recorded PERSON span is [25, 37). A second span starting inside it can
    // only be admitted by deleting or duplicating text, so it is skipped.
    const overlapping: EntityOut[] = [
      entities[1],
      { ...entities[1], character_start: 30, character_end: 44 },
    ];
    renderViewer({ entities: overlapping });

    expect(highlights()).toEqual(['Suhani Chand']);
    expect(textBody().textContent).toBe(narrative);
    expect(
      screen.getByText(/1 extracted span overlapped an earlier highlight/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/so no character is wrapped twice/i)).toBeInTheDocument();
  });

  it('says nothing about skipped spans when none overlapped', () => {
    renderViewer();
    expect(screen.queryByText(/overlapped an earlier highlight/i)).not.toBeInTheDocument();
  });

  it('degrades an offset past the end of the string to a missing highlight', () => {
    const outOfRange: EntityOut[] = [
      { ...entities[1], character_start: 9_999, character_end: 10_005 },
    ];
    renderViewer({ entities: outOfRange });

    // No throw, no highlight, and the text survives intact.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(narrative)).toBeInTheDocument();
  });

  it('clamps a negative start into the string instead of throwing', () => {
    const negative: EntityOut[] = [{ ...entities[0], character_start: -20, character_end: 10 }];
    renderViewer({ entities: negative });

    expect(highlights()).toEqual([narrative.slice(0, 10)]);
    expect(textBody().textContent).toBe(narrative);
  });

  it('drops a zero-width span rather than rendering an empty highlight', () => {
    const empty: EntityOut[] = [{ ...entities[0], character_start: 14, character_end: 14 }];
    renderViewer({ entities: empty });

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(narrative)).toBeInTheDocument();
  });
});

describe('NarrativeViewer — framing', () => {
  it('tags the overlay as narrative-derived and counts the spans', () => {
    renderViewer();
    expect(screen.getByText('NARRATIVE-DERIVED')).toBeInTheDocument();
    expect(screen.getByText(`${entities.length} entity spans highlighted`)).toBeInTheDocument();
  });

  it('states that the highlights are rule matches, not a model’s reading', () => {
    renderViewer();
    expect(
      screen.getByText(/deterministic rule and regex\s+matches over character offsets/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/not a language model's interpretation/i)).toBeInTheDocument();
  });

  it('legends only the entity types this narrative actually contains', () => {
    renderViewer();
    const items = Array.from(document.querySelectorAll('ul li')).map((li) =>
      li.textContent?.trim(),
    );
    // Order of first appearance in the recorded response; PERSON appears twice
    // and is listed once. MONEY / VEHICLE / ORGANIZATION are absent from this
    // FIR and must not be legended.
    expect(items).toEqual(['DATE', 'PERSON', 'AADHAAR', 'LOCATION', 'PHONE']);
  });

  it('explains what a highlight is on hover, including the normalized value', () => {
    renderViewer();
    const phone = screen.getByRole('button', { name: '+91-7804841598' });
    // Raw mention on screen, normalized value in the title — 7804841598.
    expect(phone).toHaveAttribute('title', expect.stringContaining('normalized: 7804841598'));
    expect(phone).toHaveAttribute('title', expect.stringContaining('characters 134–148'));
  });

  it('reports an empty narrative as an empty record, not as an error', () => {
    renderViewer({ narrative: '' });
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText(/carries no narrative text/i)).toBeInTheDocument();
    expect(screen.getByText(/No entity spans can exist/i)).toBeInTheDocument();
  });
});

describe('NarrativeViewer — selection pairs with the entity table', () => {
  it('reports the index of the span the operator clicked', () => {
    const onActiveEntityChange = vi.fn();
    renderViewer({ onActiveEntityChange });

    fireEvent.click(screen.getByRole('button', { name: 'Ojas Kuruvilla' }));
    // Index into the entities prop as given, so the table row and the span agree.
    expect(onActiveEntityChange).toHaveBeenCalledWith(4);
  });

  it('deselects when the active span is clicked again', () => {
    const onActiveEntityChange = vi.fn();
    renderViewer({ onActiveEntityChange, activeEntityIndex: 4 });

    fireEvent.click(screen.getByRole('button', { name: 'Ojas Kuruvilla' }));
    expect(onActiveEntityChange).toHaveBeenCalledWith(null);
  });

  it('marks only the active span as pressed', () => {
    renderViewer({ activeEntityIndex: 4, onActiveEntityChange: vi.fn() });
    expect(screen.getByRole('button', { name: 'Ojas Kuruvilla' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Suhani Chand' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('is still readable with no selection handler wired up', () => {
    renderViewer();
    expect(textBody().textContent).toBe(narrative);
    expect(screen.getByRole('button', { name: 'Suhani Chand' })).toBeInTheDocument();
  });
});
