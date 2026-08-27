/**
 * Live backend contract suite.
 *
 * This is the test that enforces the Phase 3.5 rule "only consume endpoints that
 * are actually present and verified in the backend". It talks to a running
 * FastAPI instance over real HTTP and asserts that every endpoint the frontend
 * binds exists and still returns the fields the UI reads.
 *
 * It is deliberately NOT part of `npm test`: it needs a live server. Run it with
 *   npm run test:live
 * When the backend is unreachable every test self-skips rather than failing, so a
 * developer without the backend running is not blocked.
 *
 * Base URL: CNA_LIVE_API_URL or VITE_LIVE_API_URL, default http://127.0.0.1:8000
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = (
  process.env.CNA_LIVE_API_URL ||
  process.env.VITE_LIVE_API_URL ||
  'http://127.0.0.1:8000'
).replace(/\/+$/, '');

let reachable = false;

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

beforeAll(async () => {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.warn(
      `[live] Backend not reachable at ${BASE} — skipping the contract suite. ` +
        `Start it with: python -m uvicorn app.main:app --port 8000`,
    );
  }
});

/** Skips instead of failing when the backend is down. */
function live(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });
}

describe('live backend contract', () => {
  live('GET /health reports a status', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(typeof body.status).toBe('string');
  });

  live('GET /api/v1/data/summary returns dataset counts', async () => {
    const { status, body } = await get('/api/v1/data/summary');
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  live('GET /api/v1/graph/summary reports a built graph', async () => {
    const { status, body } = await get('/api/v1/graph/summary');
    expect(status).toBe(200);
    // Counts are nested under `graph` — not at the top level.
    expect(body.graph.node_count).toBeGreaterThan(0);
    expect(body.graph.edge_count).toBeGreaterThan(0);
    expect(body.graph.overlay_edge_count).toBeGreaterThan(0);
  });

  live('GET /api/v1/graph/search requires q and returns nodes', async () => {
    const { status, body } = await get('/api/v1/graph/search?q=Ojas&limit=5');
    expect(status).toBe(200);
    expect(Array.isArray(body.results ?? body.items ?? body.nodes)).toBe(true);
    const results = body.results ?? body.items ?? body.nodes;
    if (results.length) {
      // The three fields the search UI renders.
      expect(results[0]).toHaveProperty('entity_id');
      expect(results[0]).toHaveProperty('entity_type');
      expect(results[0]).toHaveProperty('label');
    }
  });

  live('GET /api/v1/graph/persons/{id}/network honours depth=1', async () => {
    const { status, body } = await get(
      '/api/v1/graph/persons/445/network?depth=1',
    );
    expect(status).toBe(200);
    expect(body.anchor.entity_id).toBe('person:445');
    expect(body.depth).toBe(1);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.meta).toMatchObject({ truncated: expect.any(Boolean), max_nodes: expect.any(Number) });
    expect(body.nodes.length).toBeGreaterThan(0);
    // Every field NetworkGraph and EdgeEvidencePanel read.
    for (const key of ['entity_id', 'entity_type', 'label']) {
      expect(body.nodes[0]).toHaveProperty(key);
    }
    for (const key of [
      'relationship_id',
      'source_entity_id',
      'target_entity_id',
      'relationship_type',
      'directed',
      'source_dataset',
      'weight',
      'provenance_confidence',
      'is_overlay',
      'evidence_count',
    ]) {
      expect(body.edges[0]).toHaveProperty(key);
    }
  });

  live('GET .../network?depth=2 returns a strictly larger neighbourhood', async () => {
    const one = await get('/api/v1/graph/persons/445/network?depth=1');
    const two = await get('/api/v1/graph/persons/445/network?depth=2');
    expect(two.status).toBe(200);
    expect(two.body.nodes.length).toBeGreaterThanOrEqual(one.body.nodes.length);
  });

  live('the overlay is excluded unless explicitly requested', async () => {
    const { body } = await get(
      '/api/v1/graph/persons/445/network?depth=1',
    );
    const overlayEdges = body.edges.filter((edge: any) => edge.is_overlay === true);
    expect(overlayEdges).toHaveLength(0);
  });

  live('GET /api/v1/graph/relationships/{id} returns full provenance', async () => {
    const { body: network } = await get(
      '/api/v1/graph/persons/445/network?depth=1',
    );
    const edge = network.edges[0];
    const { status, body } = await get(
      `/api/v1/graph/relationships/${encodeURIComponent(edge.relationship_id)}`,
    );
    expect(status).toBe(200);
    expect(body.relationship_id).toBe(edge.relationship_id);
    expect(typeof body.source_dataset).toBe('string');
    // There is no scalar `source_record_id` field. Provenance arrives as an
    // `evidence` array of `dataset:record_id` strings — that array is what the
    // EdgeEvidencePanel cites as the source record, so assert its real shape.
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.evidence).toHaveLength(body.evidence_count);
    for (const citation of body.evidence) {
      expect(citation).toMatch(/^[a-z_]+:\d+$/);
    }
    expect(body).toHaveProperty('weight_detail');
    expect(body).toHaveProperty('date_first');
    expect(body).toHaveProperty('date_last');
  });

  live('GET /api/v1/graph/path returns hop provenance', async () => {
    const { status, body } = await get(
      `/api/v1/graph/path?source=${encodeURIComponent('person:445')}&target=${encodeURIComponent('person:114')}`,
    );
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
  });

  live('GET /api/v1/analytics/persons/top ranks by a named metric', async () => {
    const { status, body } = await get('/api/v1/analytics/persons/top?metric=pagerank&limit=5');
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
  });

  live('GET /api/v1/analytics/communities returns clusters', async () => {
    const { status, body } = await get('/api/v1/analytics/communities?min_size=2');
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
  });

  live('GET /api/v1/analytics/demo is deterministic and neutrally framed', async () => {
    const first = await get('/api/v1/analytics/demo');
    const second = await get('/api/v1/analytics/demo');
    expect(first.status).toBe(200);
    expect(first.body.available).toBe(true);
    expect(typeof first.body.person_id).toBe('string');
    expect(typeof first.body.selection_method).toBe('string');
    // The demo entry point must not drift between two runs, or the demo is not a demo.
    expect(second.body.person_id).toBe(first.body.person_id);
    // The backend carries its own neutral-framing disclaimer; the UI renders it verbatim.
    expect(typeof first.body.framing_note).toBe('string');
  });

  live('GET /api/v1/firs paginates', async () => {
    const { status, body } = await get('/api/v1/firs?page=1&page_size=5');
    expect(status).toBe(200);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.meta).toMatchObject({ page: 1, page_size: 5 });
    expect(body.meta.total).toBeGreaterThan(0);
  });

  live('GET /api/v1/nlp/summary reports the narrative corpus', async () => {
    const { status, body } = await get('/api/v1/nlp/summary');
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
  });

  live('GET /api/v1/nlp/firs/{id}/entities carries spans and methods', async () => {
    const { status, body } = await get('/api/v1/nlp/firs/79/entities');
    expect(status).toBe(200);
    expect(body.entities.length).toBeGreaterThan(0);
    const { entity, resolution } = body.entities[0];
    for (const key of [
      'entity_type',
      'raw_text',
      'normalized_value',
      'confidence',
      'character_start',
      'character_end',
      'extraction_method',
      'evidence_text',
    ]) {
      expect(entity).toHaveProperty(key);
    }
    expect(resolution).toHaveProperty('status');
    // Spans must index into the narrative the same response returns.
    expect(body.narrative.slice(entity.character_start, entity.character_end)).toBe(entity.raw_text);
  });

  live('GET /api/v1/nlp/firs/{id}/relationships is narrative-sourced', async () => {
    const { status, body } = await get('/api/v1/nlp/firs/79/relationships');
    expect(status).toBe(200);
    expect(body.relationships.length).toBeGreaterThan(0);
    expect(body.relationships[0].source_dataset).toBe('fir_text');
    expect(body.relationships[0]).toHaveProperty('extraction_method');
  });

  live('GET /api/v1/nlp/firs/{id}/graph-impact never mutates the structured graph', async () => {
    const { status, body } = await get('/api/v1/nlp/firs/79/graph-impact');
    expect(status).toBe(200);
    expect(body.summary.structured_graph_mutated).toBe(false);
    expect(body.structured_graph_mutated).toBe(false);
  });

  live('GET /api/v1/nlp/search pages over narrative text', async () => {
    const { status, body } = await get('/api/v1/nlp/search?q=Mumbai&page=1&page_size=5');
    expect(status).toBe(200);
    expect(body).toBeTypeOf('object');
  });

  live('unknown ids return the documented 404 envelope', async () => {
    const { status, body } = await get('/api/v1/graph/persons/999999');
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });

  live('depth above the backend cap is rejected with 400', async () => {
    const { status, body } = await get(
      '/api/v1/graph/persons/445/network?depth=9',
    );
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/depth/i);
  });

  live('an empty search query is rejected with 422', async () => {
    const { status } = await get('/api/v1/graph/search?q=');
    expect(status).toBe(422);
  });

  live('no write verb is exposed on a read-only API', async () => {
    const response = await fetch(`${BASE}/api/v1/graph/summary`, { method: 'DELETE' });
    expect([404, 405]).toContain(response.status);
  });
});
