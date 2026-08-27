/**
 * EdgeEvidencePanel — the §11 check "edge evidence panel works".
 *
 * The point of this panel is that a line on the canvas has to justify itself, so
 * the assertions here are about provenance rather than layout:
 *
 *  - a structured edge has NO scalar `source_record_id`; its provenance is the
 *    `evidence` array of `dataset:record_id` citations, and its length is
 *    `evidence_count`. A panel that showed a blank "source record" field would be
 *    hiding that;
 *  - a narrative-derived edge lives in a separate graph, so the structured
 *    relationship lookup is never issued for it — it would be a guaranteed 404;
 *  - visible truth is never blanked while enrichment is in flight.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EdgeOut } from '@/types/api';
import { fixtures, installErrorFetch, installFetch, installOfflineFetch, renderWithRouter } from '@/test/helpers';

import { EdgeEvidencePanel } from './EdgeEvidencePanel';

const network = fixtures.network445Depth2 as unknown as { edges: EdgeOut[] };
const relationship = fixtures.relationshipCalled as unknown as EdgeOut;
const narrativeRelationships = fixtures.firRelationships79 as unknown as {
  relationships: Array<Record<string, unknown>>;
};

function edgeOfType(relationshipType: string): EdgeOut {
  const found = network.edges.find((candidate) => candidate.relationship_type === relationshipType);
  if (!found) throw new Error(`the recorded network has no ${relationshipType} edge`);
  return found;
}

/** The recorded edge that the recorded relationship lookup actually describes. */
function enrichableEdge(): EdgeOut {
  const found = network.edges.find(
    (candidate) => candidate.relationship_id === relationship.relationship_id,
  );
  if (!found) throw new Error('the recorded network and relationship fixtures no longer agree');
  return found;
}

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

function renderPanel(edge: EdgeOut | null, onClose: () => void = () => {}) {
  return renderWithRouter(<EdgeEvidencePanel edge={edge} onClose={onClose} />);
}

describe('EdgeEvidencePanel — the panel itself', () => {
  it('renders nothing when no edge is selected', () => {
    installFetch();
    const { container } = renderPanel(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('is findable by the id the pages address it with', async () => {
    installFetch();
    renderPanel(enrichableEdge());
    expect(await screen.findByTestId('edge-evidence-panel')).toBeInTheDocument();
  });

  it('closes on request', () => {
    installFetch();
    const onClose = vi.fn();
    renderPanel(enrichableEdge(), onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('EdgeEvidencePanel — provenance of a structured edge', () => {
  it('shows the citation list, not a source-record field that does not exist', async () => {
    installFetch();
    const edge = enrichableEdge();
    renderPanel(edge);

    // The recorded CALLED edge cites exactly one row: calls:584.
    for (const citation of edge.evidence ?? []) {
      expect(await screen.findByText(citation)).toBeInTheDocument();
    }
    expect(screen.getByText(/Source record citations/i)).toBeInTheDocument();
    // An EdgeOut has no scalar source_record_id, so no such field may appear.
    expect(labels()).not.toContain('Source record ID');
  });

  it('reports an evidence count that matches the number of citations', async () => {
    installFetch();
    const edge = enrichableEdge();
    renderPanel(edge);

    await waitFor(() => expect(field('Evidence count')).toHaveTextContent(String(edge.evidence_count)));
    expect(edge.evidence).toHaveLength(edge.evidence_count);
  });

  it('names the source dataset and the composite relationship id', () => {
    installFetch();
    const edge = enrichableEdge();
    renderPanel(edge);

    expect(field('Source dataset')).toHaveTextContent(edge.source_dataset as string);
    expect(field('Relationship ID')).toHaveTextContent(edge.relationship_id);
  });

  it('says "not recorded" rather than inventing a date for a dateless link type', () => {
    installFetch();
    const colocated = edgeOfType('CO_LOCATED');
    expect(colocated.date_first).toBeNull();
    renderPanel(colocated);

    expect(field('Date range')).toHaveTextContent('Not recorded');
  });

  it('explains what direction means on a money transfer', () => {
    installFetch();
    renderPanel(edgeOfType('TRANSACTED'));
    expect(screen.getByText(/money moved from the source \(sender\)/i)).toBeInTheDocument();
  });

  it('says outright that a shared-column link is weak evidence', () => {
    installFetch();
    renderPanel(edgeOfType('CO_LOCATED'));
    expect(
      screen.getByText(/derived from a shared column value, which makes it weak/i),
    ).toBeInTheDocument();
  });

  it('formats a rupee total as currency rather than a bare number', async () => {
    installFetch();
    const transacted = edgeOfType('TRANSACTED');
    // The recorded edge carries total_amount_inr: 337348.75.
    expect((transacted.weight_detail as Record<string, unknown>).total_amount_inr).toBe(337348.75);
    renderPanel(transacted);

    await waitFor(() => expect(field('Total amount inr').textContent).toMatch(/₹/));
  });

  it('formats a call duration as time rather than a count of seconds', () => {
    installFetch();
    renderPanel(enrichableEdge());
    // total_duration_sec: 3529 -> 58m 49s, not "3529".
    expect(field('Total duration sec').textContent).toBe('58m 49s');
  });

  it('describes an FIR allegation as an allegation, not a finding', () => {
    installFetch();
    renderPanel(edgeOfType('REPORTED_AGAINST'));
    expect(screen.getByText(/it is not a finding of guilt/i)).toBeInTheDocument();
  });

  it('shows the role a person holds on an FIR record', () => {
    installFetch();
    const named = edgeOfType('NAMED_IN_FIR');
    expect((named.attributes as Record<string, unknown>).role).toBe('accused');
    renderPanel(named);

    expect(field('Role')).toHaveTextContent('accused');
    expect(
      screen.getByText(/whether they appear as complainant or accused/i),
    ).toBeInTheDocument();
  });
});

describe('EdgeEvidencePanel — enrichment', () => {
  it('asks the relationship endpoint for the id verbatim', async () => {
    const { calls } = installFetch();
    const edge = enrichableEdge();
    renderPanel(edge);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toEqual([
      `/api/v1/graph/relationships/${encodeURIComponent(edge.relationship_id)}`,
    ]);
  });

  it('shows the edge it was given immediately, without waiting for enrichment', () => {
    // A fetch that never settles: whatever is on screen came from the prop.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const edge = enrichableEdge();
    renderPanel(edge);

    expect(field('Relationship ID')).toHaveTextContent(edge.relationship_id);
    expect(field('Evidence count')).toHaveTextContent(String(edge.evidence_count));
  });

  it('keeps the edge on screen and explains a 404 instead of alarming the operator', async () => {
    installErrorFetch(404, fixtures.error404Person);
    const edge = enrichableEdge();
    renderPanel(edge);

    expect(await screen.findByText(/returned no additional provenance record/i)).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    expect(field('Relationship ID')).toHaveTextContent(edge.relationship_id);
  });

  it('reports a genuine lookup failure, with the edge still readable', async () => {
    installOfflineFetch();
    const edge = enrichableEdge();
    renderPanel(edge);

    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    expect(screen.getByText('Provenance lookup failed')).toBeInTheDocument();
    expect(field('Relationship ID')).toHaveTextContent(edge.relationship_id);
  });

  it('ignores a payload that describes a different relationship', async () => {
    // The stub answers every relationship URL with CALLED~person:141~person:445.
    installFetch();
    const other = edgeOfType('CO_LOCATED');
    expect(other.relationship_id).not.toBe(relationship.relationship_id);
    renderPanel(other);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(field('Relationship ID')).toHaveTextContent(other.relationship_id);
    expect(field('Relationship ID')).not.toHaveTextContent(relationship.relationship_id);
  });
});

describe('EdgeEvidencePanel — narrative-derived edges', () => {
  /** A real narrative relationship from the recorded NLP response, shaped as an edge. */
  function narrativeEdge(): EdgeOut {
    const source = narrativeRelationships.relationships[0];
    expect(source).toBeDefined();
    return {
      relationship_id: `narr~${String(source.relationship_type)}~${String(source.source_entity_id)}~${String(source.target_entity_id)}`,
      source_entity_id: String(source.source_entity_id),
      target_entity_id: String(source.target_entity_id),
      relationship_type: String(source.relationship_type),
      directed: Boolean(source.directed ?? false),
      source_dataset: 'fir_text',
      weight: 1,
      weight_detail: {},
      date_first: null,
      date_last: null,
      provenance_confidence: Number(source.confidence ?? 0),
      is_overlay: false,
      attributes: {
        evidence_text: String(source.evidence_text ?? ''),
        extraction_method: String(source.extraction_method ?? ''),
      },
      evidence_count: 1,
      evidence: [String(source.source_record_id ?? '')],
    } as unknown as EdgeOut;
  }

  it('never issues the structured lookup, which would be a guaranteed 404', async () => {
    const { calls } = installFetch();
    renderPanel(narrativeEdge());

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
  });

  it('tags it NARRATIVE-DERIVED and says why there is no structured record', () => {
    installFetch();
    renderPanel(narrativeEdge());

    expect(screen.getAllByText('NARRATIVE-DERIVED').length).toBeGreaterThan(0);
    expect(screen.getByText(/and was never merged into the/i)).toBeInTheDocument();
    expect(screen.getByText(/deliberately does not ask for one/i)).toBeInTheDocument();
  });

  it('quotes the FIR narrative span it was extracted from', () => {
    installFetch();
    const edge = narrativeEdge();
    const quoted = String((edge.attributes as Record<string, unknown>).evidence_text);
    expect(quoted.length).toBeGreaterThan(0);
    renderPanel(edge);

    expect(screen.getByText(/Quoted from the FIR narrative/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(quoted.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
  });
});
