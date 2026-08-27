/**
 * NodeDetailsPanel — the §11 check "node selection works", and the two claims
 * this panel makes that matter most for the demo's credibility:
 *
 *  - the generator's `ring_id` answer key is quarantined into a tagged overlay
 *    block and stated to be non-evidential, instead of sitting in the attribute
 *    list looking like an observed column;
 *  - centrality figures are captioned as structural position, not risk.
 *
 * Analytics come from `GET /analytics/persons/{numeric id}`; a wrong id form
 * there is an HTTP 422, so the requested URL is asserted directly.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { NodeOut } from '@/types/api';
import { fixtures, installFetch, installOfflineFetch, renderWithRouter } from '@/test/helpers';

import { NodeDetailsPanel } from './NodeDetailsPanel';

const network = fixtures.network445Depth2 as unknown as { nodes: NodeOut[] };
const analytics = fixtures.analyticsPerson445 as unknown as {
  degree: number;
  pagerank: number;
  weighted_degree: number;
  interpretation: { text: string; disclaimer: string };
};

function node(entityId: string): NodeOut {
  const found = network.nodes.find((candidate) => candidate.entity_id === entityId);
  if (!found) throw new Error(`the recorded network has no ${entityId}`);
  return found;
}

function firstOfType(entityType: string): NodeOut {
  const found = network.nodes.find((candidate) => candidate.entity_type === entityType);
  if (!found) throw new Error(`the recorded network has no ${entityType} node`);
  return found;
}

/** The <dd> belonging to the <dt> whose label reads exactly `label`. */
function field(label: string): HTMLElement {
  const dts = Array.from(document.querySelectorAll('dt'));
  const dt = dts.find((el) => el.querySelector('span')?.textContent?.trim() === label);
  if (!dt) {
    const seen = dts.map((el) => el.querySelector('span')?.textContent?.trim()).join(' | ');
    throw new Error(`no field labelled "${label}". Present: ${seen}`);
  }
  const dd = dt.parentElement?.querySelector('dd');
  if (!dd) throw new Error(`field "${label}" has no value cell`);
  return dd as HTMLElement;
}

const labels = () =>
  Array.from(document.querySelectorAll('dt')).map((el) =>
    el.querySelector('span')?.textContent?.trim(),
  );

function renderPanel(target: NodeOut | null, props: Partial<Parameters<typeof NodeDetailsPanel>[0]> = {}) {
  return renderWithRouter(
    <NodeDetailsPanel node={target} onClose={props.onClose ?? (() => {})} {...props} />,
  );
}

describe('NodeDetailsPanel — identity and provenance', () => {
  it('renders nothing at all when no node is selected', () => {
    installFetch();
    const { container } = renderPanel(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the entity id, dataset and source record id the graph returned', () => {
    installFetch();
    const person = node('person:445');
    renderPanel(person);

    expect(screen.getByText(person.label)).toBeInTheDocument();
    expect(field('Entity ID')).toHaveTextContent('person:445');
    expect(field('Source dataset')).toHaveTextContent('persons');
    // A NODE does carry a scalar source_record_id — this is the field a
    // structured EDGE does not have.
    expect(field('Source record ID')).toHaveTextContent('persons:445');
  });

  it('tags a table-derived entity as STRUCTURED', () => {
    installFetch();
    renderPanel(node('person:445'));
    expect(screen.getByText('STRUCTURED')).toBeInTheDocument();
  });

  it('lists the observed attribute columns', () => {
    installFetch();
    renderPanel(node('person:445'));
    // From the recorded node: city Mumbai, state Maharashtra, location_id 23.
    expect(screen.getByText('Mumbai')).toBeInTheDocument();
    expect(screen.getByText('Maharashtra')).toBeInTheDocument();
  });
});

describe('NodeDetailsPanel — the ground-truth overlay is quarantined', () => {
  it('never lists ring_id among the observed attributes', () => {
    installFetch();
    renderPanel(node('person:445'));
    // It is present on the recorded node, so its absence here is the panel's doing.
    expect((node('person:445').attributes as Record<string, unknown>).ring_id).toBe(1);
    const observed = labels().filter((label) => label && /ring/i.test(label));
    // Exactly one ring row exists, and it lives inside the overlay block.
    expect(observed).toHaveLength(1);
  });

  it('tags the ring label as a ground-truth overlay and says nothing consumes it', () => {
    installFetch();
    renderPanel(node('person:445'));

    expect(screen.getByText('GROUND-TRUTH OVERLAY')).toBeInTheDocument();
    expect(screen.getByText(/Synthetic data only/i)).toBeInTheDocument();
    expect(
      screen.getByText(/is not\s+evidence, and no analytic in this system reads it/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/A real case file has no such column/i)).toBeInTheDocument();
  });

  it('reports a null ring label as an answer rather than dropping the row', () => {
    installFetch();
    // person:277 in the recorded search response carries ring_id: null.
    const unringed = (fixtures.graphSearchOjas as unknown as { results: NodeOut[] }).results.find(
      (candidate) => (candidate.attributes as Record<string, unknown>).ring_id === null,
    );
    expect(unringed).toBeDefined();
    renderPanel(unringed as NodeOut);

    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.getByText(/did not place this person in any ring/i)).toBeInTheDocument();
  });
});

describe('NodeDetailsPanel — structural position', () => {
  it('requests analytics with the NUMERIC row id', async () => {
    const { calls } = installFetch();
    renderPanel(node('person:445'));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toEqual(['/api/v1/analytics/persons/445']);
  });

  it('prints an integer degree as an integer and a probability at full precision', async () => {
    installFetch();
    renderPanel(node('person:445'));

    // degree is a count (29), not a measurement: "29.00" would be wrong.
    await waitFor(() => expect(field('Degree')).toHaveTextContent(String(analytics.degree)));
    expect(field('Degree').textContent).toBe('29');
    expect(field('Weighted degree').textContent).toBe('26.50');
    expect(field('PageRank').textContent).toBe('0.004731');
  });

  it("surfaces the backend's own reading and disclaimer verbatim", async () => {
    installFetch();
    renderPanel(node('person:445'));

    expect(await screen.findByText(analytics.interpretation.text)).toBeInTheDocument();
    expect(screen.getByText(analytics.interpretation.disclaimer)).toBeInTheDocument();
    // The raw label token `high_network_importance`, humanized into a badge.
    expect(screen.getByText('High network importance')).toBeInTheDocument();
  });

  it('states in its own voice that these are not risk scores', async () => {
    installFetch();
    renderPanel(node('person:445'));

    await screen.findByText(analytics.interpretation.disclaimer);
    expect(
      screen.getByText(/not a risk score, not a probability, and not a measure of\s+guilt/i),
    ).toBeInTheDocument();
  });

  it('asks for no analytics at all for a non-person entity', async () => {
    const { calls } = installFetch();
    renderPanel(firstOfType('PHONE'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    expect(screen.queryByText(/Structural position/i)).not.toBeInTheDocument();
  });

  it('refuses to show one person’s metrics under another person’s name', async () => {
    // The stub answers every analytics URL with person:445's numbers. The panel is
    // showing person:114, so the payload must be rejected on identity.
    installFetch([{ match: '/api/v1/analytics/persons/', body: fixtures.analyticsPerson445 }]);
    renderPanel(node('person:114'));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('29')).not.toBeInTheDocument();
    expect(screen.queryByText(analytics.interpretation.text)).not.toBeInTheDocument();
  });

  it('keeps the identity block when the metrics request fails, and offers a retry', async () => {
    installOfflineFetch();
    renderPanel(node('person:445'));

    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    expect(screen.getByText('Structural metrics unavailable')).toBeInTheDocument();
    // The separate request failed; the node's own fields are still on screen.
    expect(field('Entity ID')).toHaveTextContent('person:445');

    const { calls } = installFetch();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(field('Degree').textContent).toBe('29'));
    expect(calls).toEqual(['/api/v1/analytics/persons/445']);
  });
});

describe('NodeDetailsPanel — actions', () => {
  it('hands the PREFIXED entity id to the investigate action', () => {
    installFetch();
    const onInvestigate = vi.fn();
    renderPanel(node('person:445'), { onInvestigate });

    fireEvent.click(screen.getByRole('button', { name: /Investigate this network/i }));
    expect(onInvestigate).toHaveBeenCalledWith('person:445');
  });

  it('hands the NUMERIC row id to the FIR action', () => {
    installFetch();
    const onOpenFir = vi.fn();
    const fir = firstOfType('FIR');
    renderPanel(fir, { onOpenFir });

    fireEvent.click(screen.getByRole('button', { name: /Open in FIR Intelligence/i }));
    expect(onOpenFir).toHaveBeenCalledWith(Number(fir.entity_id.split(':')[1]));
  });

  it('offers no action a caller has not wired up', () => {
    installFetch();
    renderPanel(node('person:445'));
    expect(screen.queryByRole('button', { name: /Investigate this network/i })).not.toBeInTheDocument();
  });

  it('offers no network action for an entity the network endpoint cannot root on', () => {
    installFetch();
    renderPanel(firstOfType('CELL_TOWER'), { onInvestigate: vi.fn() });
    expect(screen.queryByRole('button', { name: /Investigate this network/i })).not.toBeInTheDocument();
  });

  it('closes on request', () => {
    installFetch();
    const onClose = vi.fn();
    renderPanel(node('person:445'), { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
