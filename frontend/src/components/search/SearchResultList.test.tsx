/**
 * SearchResultList — §7's "entity type / display value / entity ID" rows, and the
 * part of §7 that is easy to get wrong: "clicking navigates to the right view".
 *
 * This backend's network endpoint is person-rooted (`/graph/persons/{id}/network`),
 * so a phone, Aadhaar, location or tower simply cannot be a network root. The
 * honest response is to say where each row actually opens rather than to offer a
 * destination that would 404 — so the destination hint is asserted per entity
 * type, using real nodes from the recorded responses.
 *
 * The rows also carry `attributes.ring_id`, the data generator's ground-truth
 * label. It must never surface here; that is asserted directly.
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { NodeOut } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { SearchResultList, type SearchResultListProps } from './SearchResultList';

const search = fixtures.graphSearchOjas as unknown as { count: number; results: NodeOut[] };
const network = fixtures.network445Depth2 as unknown as { nodes: NodeOut[] };
const results = search.results;

/** A real recorded node of the given type — non-person rows come from the network. */
function nodeOfType(entityType: string): NodeOut {
  const found = network.nodes.find((node) => node.entity_type === entityType);
  if (!found) throw new Error(`the recorded network has no ${entityType} node`);
  return found;
}

function renderList(props: Partial<SearchResultListProps> = {}) {
  const onSelect = vi.fn();
  const onHoverIndex = vi.fn();
  const utils = renderWithRouter(
    <SearchResultList
      results={props.results ?? results}
      onSelect={onSelect}
      onHoverIndex={onHoverIndex}
      {...props}
    />,
  );
  return { ...utils, onSelect, onHoverIndex };
}

const options = () => screen.queryAllByRole('option');

describe('SearchResultList — the rows are the response', () => {
  it('needs no backend of its own: the search box hands it the results', async () => {
    const { calls } = installFetch();
    renderList();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('renders one option per result, and the response agrees on the count', () => {
    renderList();
    expect(options()).toHaveLength(results.length);
    expect(results).toHaveLength(search.count);
  });

  it('shows the display label and the entity id for every row', () => {
    renderList();
    for (const node of results) {
      expect(screen.getByText(node.label)).toBeInTheDocument();
      expect(screen.getByText(node.entity_id)).toBeInTheDocument();
    }
  });

  it('shows the entity type as its own badge rather than folding it into the label', () => {
    renderList();
    // Five PERSON rows in the recorded response for "Ojas".
    const persons = results.filter((node) => node.entity_type === 'PERSON');
    expect(screen.getAllByText('PERSON')).toHaveLength(persons.length);
  });

  it('never shows the generator’s ring label, which the rows do carry', () => {
    // person:445 arrives with attributes.ring_id === 1. It is the answer key, so
    // it may not appear in a list an operator reads as evidence.
    const anchor = results.find((node) => node.entity_id === 'person:445');
    expect((anchor?.attributes as Record<string, unknown>).ring_id).toBe(1);
    renderList();

    const listbox = screen.getByRole('listbox');
    expect(listbox).not.toHaveTextContent('ring');
    expect(listbox).not.toHaveTextContent('Ring');
  });

  it('renders an empty listbox rather than a bare container when nothing matched', () => {
    renderList({ results: [] });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(options()).toHaveLength(0);
  });
});

describe('SearchResultList — where each row opens', () => {
  it('offers no destination hint for a person, because a person is the default', () => {
    renderList();
    expect(screen.queryByText(/Opens/)).not.toBeInTheDocument();
  });

  it('says an FIR row opens the narrative view', () => {
    renderList({ results: [nodeOfType('FIR')] });
    expect(screen.getByText('Opens FIR narrative')).toBeInTheDocument();
  });

  it('says a non-person, non-FIR row opens Evidence, not a network', () => {
    // A phone cannot root /graph/persons/{id}/network, so it must not promise to.
    const nonPersons = ['PHONE', 'AADHAAR', 'LOCATION', 'CELL_TOWER'].map(nodeOfType);
    renderList({ results: nonPersons });

    expect(screen.getAllByText('Opens in Evidence & Provenance')).toHaveLength(nonPersons.length);
  });

  it('hands the whole node back, so the caller does not re-parse an id', () => {
    const { onSelect } = renderList();
    const target = results[4];
    fireEvent.click(screen.getByText(target.label));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(target);
  });
});

describe('SearchResultList — the keyboard contract', () => {
  it('exposes the listbox under an id the combobox can point at', () => {
    renderList();
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'cna-dropdown-search-listbox');
    expect(screen.getByRole('listbox')).toHaveAccessibleName('Entity search results');
  });

  it('gives each option a deterministic id derived from its entity id', () => {
    renderList();
    // person:445 -> cna-dropdown-search-option-person-445. aria-activedescendant
    // needs an id the owning combobox can compute without a callback.
    expect(screen.getByText('Ojas Kuruvilla').closest('[role="option"]')).toHaveAttribute(
      'id',
      'cna-dropdown-search-option-person-445',
    );
  });

  it('keeps the two surfaces’ ids apart, so both can be mounted at once', () => {
    renderList({ variant: 'page' });
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'cna-page-search-listbox');
    expect(screen.getByText('Ojas Kuruvilla').closest('[role="option"]')).toHaveAttribute(
      'id',
      'cna-page-search-option-person-445',
    );
  });

  it('marks exactly the active row as selected', () => {
    renderList({ activeIndex: 4 });
    const selected = options().filter((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Ojas Kuruvilla');
  });

  it('marks nothing when the caller has no active row', () => {
    renderList();
    expect(options().every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('reports the row under the pointer so the highlight follows the mouse', () => {
    const { onHoverIndex } = renderList();
    fireEvent.mouseMove(options()[2]);
    expect(onHoverIndex).toHaveBeenCalledWith(2);
  });

  it('reports a row that receives focus, so tabbing and arrowing agree', () => {
    const { onHoverIndex } = renderList();
    fireEvent.focus(options()[1]);
    expect(onHoverIndex).toHaveBeenCalledWith(1);
  });
});

describe('SearchResultList — the roomier page variant', () => {
  it('adds the provenance of each row where there is space for it', () => {
    renderList({ variant: 'page' });
    const anchor = results.find((node) => node.entity_id === 'person:445');
    // `persons` / `persons:445` — the dataset and the row it came from.
    expect(
      screen.getByText(`${anchor?.source_dataset} · ${anchor?.source_record_id}`),
    ).toBeInTheDocument();
  });

  it('leaves provenance out of the dropdown, where it would crowd the label', () => {
    renderList();
    expect(screen.queryByText(/persons · persons:445/)).not.toBeInTheDocument();
  });
});
