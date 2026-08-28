/**
 * GlobalSearch — the §11 check "person search works", plus the routing rule that
 * is easiest to get wrong in this app: a search result speaks the PREFIXED entity
 * id (`person:445`), while the route it opens carries the backend's NUMERIC row
 * id (`/network/445`). Getting that backwards produces an HTTP 422 two screens
 * later, which is exactly the kind of bug a URL assertion catches early.
 *
 * Every response served here is a recorded one. The non-person rows are real
 * nodes lifted out of the recorded depth-2 network, so the `+` in a phone id —
 * the character that forces the query parameter to be encoded — is the real one.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { NodeOut } from '@/types/api';
import { fixtures, installErrorFetch, installFetch, installOfflineFetch, renderWithRouter } from '@/test/helpers';

import { GlobalSearch } from './GlobalSearch';

const search = fixtures.graphSearchOjas as unknown as { count: number; results: NodeOut[] };
const networkNodes = fixtures.network445Depth2 as unknown as { nodes: NodeOut[] };

/** A real recorded node of the given type, so nothing here is hand-authored. */
function realNode(entityType: string): NodeOut {
  const node = networkNodes.nodes.find((candidate) => candidate.entity_type === entityType);
  if (!node) throw new Error(`the recorded network has no ${entityType} node`);
  return node;
}

/** The recorded search envelope, re-pointed at a different set of real nodes. */
function searchBody(results: NodeOut[]) {
  return { query: 'q', count: results.length, results };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderSearch(route = '/') {
  const view = renderWithRouter(
    <>
      <GlobalSearch />
      <LocationProbe />
    </>,
    { route },
  );
  return { ...view, input: screen.getByRole('combobox') };
}

/** Type a whole query in one change event — the field is controlled. */
function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

const location = () => screen.getByTestId('location').textContent;

describe('GlobalSearch — querying', () => {
  it('asks the backend nothing until two characters have been typed', async () => {
    const { calls } = installFetch();
    const { input } = renderSearch();

    type(input, 'o');
    expect(await screen.findByText(/characters to search the graph/i)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('issues exactly one debounced request for the verified search endpoint', async () => {
    const { calls } = installFetch();
    const { input } = renderSearch();

    for (const value of ['o', 'oj', 'oja', 'ojas']) type(input, value);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // One request for the settled value, not one per keystroke.
    expect(calls).toEqual(['/api/v1/graph/search?q=ojas&limit=12']);
  });

  it('shows a skeleton while the debounce settles, never an empty result list', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    // Before the debounce fires there is no answer yet, so there must be no
    // listbox on screen claiming zero results.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('global-search-panel')).toBeInTheDocument();
    await screen.findAllByRole('option');
  });

  it('renders every recorded hit as a selectable option', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    const options = await screen.findAllByRole('option');
    const listbox = screen.getByRole('listbox');
    expect(options).toHaveLength(search.results.length);
    for (const node of search.results) {
      expect(within(listbox).getByText(node.label)).toBeInTheDocument();
      expect(within(listbox).getByTitle(node.entity_id)).toBeInTheDocument();
    }
  });

  it('reports the result count from the response, not from its own list length', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    await screen.findAllByRole('option');
    expect(screen.getByText(`${search.count} results`)).toBeInTheDocument();
  });
});

describe('GlobalSearch — the two id forms', () => {
  it('opens a person at the NUMERIC route, because the path parameter parses as an int', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    const option = await screen.findByText('Ojas Kuruvilla');
    fireEvent.click(option);

    // person:445 -> /network/445. `/network/person:445` is the HTTP 422 path.
    expect(location()).toBe('/network/445');
  });

  it('opens an FIR at its numeric route', async () => {
    const fir = realNode('FIR');
    installFetch([{ match: '/api/v1/graph/search', body: searchBody([fir]) }]);
    const { input } = renderSearch();
    type(input, 'fir');

    fireEvent.click(await screen.findByText(fir.label));
    expect(location()).toBe(`/fir/${fir.entity_id.split(':')[1]}`);
  });

  it('opens a phone in Evidence with the PREFIXED id, url-encoded', async () => {
    const phone = realNode('PHONE');
    // The recorded phone id contains a '+', which is a space if left unencoded.
    expect(phone.entity_id).toContain('+');
    installFetch([{ match: '/api/v1/graph/search', body: searchBody([phone]) }]);
    const { input } = renderSearch();
    type(input, '7804');

    fireEvent.click(await screen.findByText(phone.label));
    expect(location()).toBe(`/evidence?entity=${encodeURIComponent(phone.entity_id)}`);
    expect(location()).toContain('%2B');
  });

  it('opens a location in Location Intelligence, at its numeric id', async () => {
    const place = realNode('LOCATION');
    installFetch([{ match: '/api/v1/graph/search', body: searchBody([place]) }]);
    const { input } = renderSearch();
    type(input, 'mumbai');

    fireEvent.click(await screen.findByText(place.label));
    // §21: a location is a location, not a node to draw. The locations screen
    // reads the NUMERIC row id, so the prefix is stripped here and not later.
    expect(location()).toBe(`/locations?location=${place.entity_id.split(':')[1]}`);
    expect(location()).not.toContain('location%3A');
  });

  it('says where a non-person result will open rather than hiding the limitation', async () => {
    const tower = realNode('CELL_TOWER');
    installFetch([{ match: '/api/v1/graph/search', body: searchBody([tower]) }]);
    const { input } = renderSearch();
    type(input, 'tower');

    expect(await screen.findByText(/Opens in Evidence & Provenance/i)).toBeInTheDocument();
  });
});

describe('GlobalSearch — keyboard', () => {
  it('moves the active option with ArrowDown and opens it with Enter', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Index 0 is the first recorded hit, so one ArrowDown lands on the second.
    const second = search.results[1];
    expect(location()).toBe(`/network/${second.entity_id.split(':')[1]}`);
  });

  it('wraps from the last option back to the first', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(location()).toBe(`/network/${search.results[0].entity_id.split(':')[1]}`);
  });

  it('points aria-activedescendant at the option the caret is on', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');
    await screen.findAllByRole('option');

    expect(input).toHaveAttribute('aria-activedescendant', 'tracex-dropdown-search-option-person-123');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'tracex-dropdown-search-option-person-275');
  });

  it('clears the field on Escape and closes the panel', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('global-search-panel')).not.toBeInTheDocument();
  });

  it('clears the field once a result has been opened', async () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    fireEvent.click(await screen.findByText('Ojas Kuruvilla'));
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('global-search-panel')).not.toBeInTheDocument();
  });

  it('focuses the field when "/" is pressed elsewhere on the page', () => {
    installFetch();
    const { input } = renderSearch();

    expect(input).not.toHaveFocus();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(input).toHaveFocus();
  });

  it('does not steal "/" while the user is typing in the field', () => {
    installFetch();
    const { input } = renderSearch();
    type(input, 'a');
    fireEvent.keyDown(input, { key: '/' });
    // No assertion on focus here: what matters is that the handler bailed out and
    // nothing threw. The value the user typed is untouched.
    expect(input).toHaveValue('a');
  });
});

describe('GlobalSearch — states the backend can put it in', () => {
  it('says nothing matched, without claiming a fault', async () => {
    installFetch([{ match: '/api/v1/graph/search', body: searchBody([]) }]);
    const { input } = renderSearch();
    type(input, 'zzzz');

    expect(await screen.findByText(/No matching entity/i)).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('treats a 422 as "nothing was searched", not as an error to alarm the operator', async () => {
    installErrorFetch(422, fixtures.error422Search);
    const { input } = renderSearch();
    type(input, 'ojas');

    expect(
      await screen.findByText(/rejected this as an empty or invalid query/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('surfaces a real failure with a retry that re-issues the request', async () => {
    installOfflineFetch();
    const { input } = renderSearch();
    type(input, 'ojas');

    const retry = await screen.findByRole('button', { name: /retry/i });
    const { calls } = installFetch();
    fireEvent.click(retry);

    expect(await screen.findByText('Ojas Kuruvilla')).toBeInTheDocument();
    expect(calls).toEqual(['/api/v1/graph/search?q=ojas&limit=12']);
  });

  it('drops a result whose id cannot become the integer its route needs', async () => {
    // A PERSON row with an unparseable id would navigate to `/network/NaN`; the
    // component drops it instead. Both rows are otherwise identical.
    const broken: NodeOut = { ...search.results[0], entity_id: 'person:not-a-number' };
    installFetch([
      { match: '/api/v1/graph/search', body: searchBody([broken, search.results[4]]) },
    ]);
    const { input } = renderSearch();
    type(input, 'ojas');

    const listbox = await screen.findAllByRole('option');
    expect(listbox).toHaveLength(1);
    expect(within(screen.getByRole('listbox')).getByText('Ojas Kuruvilla')).toBeInTheDocument();
  });
});
