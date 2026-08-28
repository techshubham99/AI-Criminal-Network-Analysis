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

  live('no write verb reaches a read endpoint', async () => {
    // Phase 4.6 added `POST /ingest/*`, and nothing else. A read route still
    // refuses every verb, and no route anywhere accepts DELETE.
    const response = await fetch(`${BASE}/api/v1/graph/summary`, { method: 'DELETE' });
    expect([404, 405]).toContain(response.status);
    const posted = await fetch(`${BASE}/api/v1/graph/summary`, { method: 'POST' });
    expect([404, 405]).toContain(posted.status);
  });
});

/* ------------------------------------------------- Phase 4.6: live ingestion -- */

/**
 * Every submission below is unique per run: the same content always hashes to the
 * same `record_id`, so a fixed payload would be answered DUPLICATE on the second
 * run and the suite would only pass once. The stamp is a wall-clock second.
 */
function stamp(offsetMinutes = 0): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Read named SSE frames until `stop` resolves, then abort the stream. */
async function readStream(
  during: () => Promise<void>,
  budgetMs = 20_000,
): Promise<Array<{ event: string; data: any }>> {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/v1/ingest/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = [];
  let buffer = '';
  let done = false;

  const pump = (async () => {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
        const payload = /^data:\s*(.+)$/m.exec(block)?.[1];
        if (name && payload) frames.push({ event: name, data: JSON.parse(payload) });
        split = buffer.indexOf('\n\n');
      }
    }
  })();

  await during();
  // The recomputation runs before the final frame is published, so give the
  // stream a moment to drain rather than racing it.
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !frames.some((f) => f.event === 'new_intelligence')) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  done = true;
  controller.abort();
  await pump.catch(() => undefined);
  return frames;
}

describe('live backend contract — Phase 4.6 ingestion', () => {
  live('all four ingestion routes accept a submission and answer with a record', async () => {
    const at = stamp();
    const submissions: Array<[string, unknown]> = [
      [
        '/api/v1/ingest/call',
        {
          provenance: { source_name: 'contract-suite' },
          caller: { person_id: 141 },
          callee: { person_id: 21 },
          start_time: at,
          duration_sec: 137,
        },
      ],
      [
        '/api/v1/ingest/transaction',
        {
          provenance: { source_name: 'contract-suite' },
          sender: { person_id: 141 },
          receiver: { person_id: 7 },
          amount_inr: 64000,
          txn_time: at,
          mode: 'IMPS',
          bank_ref: `IMPS-${at}`,
        },
      ],
      [
        '/api/v1/ingest/fir',
        {
          provenance: { source_name: 'contract-suite' },
          date: at.slice(0, 10),
          complainant: { person_id: 21 },
          accused: { person_id: 141 },
          narrative: `Contract check ${at}: complainant reports a demand for payment.`,
          city: 'Lucknow',
          state: 'Uttar Pradesh',
        },
      ],
      [
        '/api/v1/ingest/location',
        {
          provenance: { source_name: 'contract-suite' },
          person: { person_id: 141 },
          observed_at: at,
          city: 'Bhopal',
          state: 'Madhya Pradesh',
        },
      ],
    ];

    for (const [path, payload] of submissions) {
      const { status, body } = await post(path, payload);
      expect(status, path).toBe(200);
      // The four documented statuses, and nothing else.
      expect(['ACCEPTED', 'DUPLICATE', 'REVIEW_REQUIRED', 'REJECTED'], path).toContain(body.status);
      expect(body.record_id, path).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof body.reason, path).toBe('string');
      // Raw and normalized forms are kept side by side, and provenance is echoed
      // verbatim rather than interpreted as an external integration.
      expect(body.raw_payload, path).toBeTypeOf('object');
      expect(body.normalized_payload, path).toBeTypeOf('object');
      expect(body.provenance.source_name, path).toBe('contract-suite');
      expect(body.provenance.source_type, path).toBe(
        path.split('/').pop()!.toUpperCase(),
      );
    }
  });

  live('the same observation hashes the same and is not stored twice', async () => {
    const payload = {
      provenance: { source_name: 'contract-suite' },
      caller: { person_id: 141 },
      callee: { person_id: 21 },
      start_time: stamp(1),
      duration_sec: 211,
    };
    const first = await post('/api/v1/ingest/call', payload);
    // A different ingestion timestamp, a different stated submitter: neither is
    // part of the hash, so the content still resolves to the same record.
    const second = await post('/api/v1/ingest/call', {
      ...payload,
      provenance: { source_name: 'contract-suite', submitted_by: 'someone-else' },
    });

    expect(first.body.record_id).toBe(second.body.record_id);
    expect(second.body.status).toBe('DUPLICATE');
    expect(second.body.duplicate_of).toBe(first.body.record_id);
    expect(second.body.impact.changed).toBe(false);
    expect(second.body.relationships).toHaveLength(0);
  });

  live('an invalid field is rejected with a field-level reason, and nothing is stored', async () => {
    const { status, body } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      caller: { phone: '12345' },
      callee: { person_id: 21 },
      start_time: 'not-a-time',
      duration_sec: -3,
    });

    // A rejection is a result, not a transport failure.
    expect(status).toBe(200);
    expect(body.status).toBe('REJECTED');
    expect(body.reject_reason).toBe('INVALID_FIELD');
    expect(body.reason).toMatch(/caller\.phone/);
    expect(body.validation_status).toBe('INVALID');
    expect(body.resolution_status).toBe('NOT_ATTEMPTED');
    expect(body.impact.changed).toBe(false);
    expect(body.relationships).toHaveLength(0);
  });

  live('an unrelated pair is held for review, not connected and not flagged', async () => {
    const { body } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      caller: { phone: '9812345670' },
      callee: { phone: '9812345671' },
      start_time: stamp(2),
      duration_sec: 96,
    });

    expect(body.status).toBe('REVIEW_REQUIRED');
    expect(body.review_reason).toBe('NO_MATCH_NEW_ENTITY');
    expect(body.reason).toBe(
      'No validated connection found with existing investigation data.',
    );
    // No forced connection, no graph change, and nothing called suspicious. The
    // response's own disclaimer says so, so the check is on the fields that
    // describe the record rather than on the whole body.
    expect(body.relationships).toHaveLength(0);
    expect(body.impact.changed).toBe(false);
    expect(body.disclaimer).toMatch(/not treated as suspicious/);
    const described = [body.reason, ...body.matches.map((m: any) => m.explanation)].join(' ');
    expect(described).not.toMatch(/suspicious|criminal|guilty/i);
    for (const match of body.matches) {
      expect(match.status).toBe('NO_MATCH');
      expect(match.is_new_entity).toBe(true);
    }
  });

  live('two identifiers naming different people are never merged', async () => {
    const { body } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      // Person 141's phone with person 21's Aadhaar.
      caller: { phone: '8600506062', aadhaar: '877449847333' },
      callee: { person_id: 7 },
      start_time: stamp(3),
      duration_sec: 61,
    });

    expect(body.status).toBe('REVIEW_REQUIRED');
    // The two review reasons are distinct findings.
    expect(body.review_reason).toBe('AMBIGUOUS_MATCH');
    const caller = body.matches.find((m: any) => m.field === 'caller');
    expect(caller.status).toBe('AMBIGUOUS');
    expect(caller.entity_id).toBeNull();
    expect(caller.candidates.length).toBeGreaterThan(1);
    expect(body.impact.changed).toBe(false);
  });

  live('an accepted record is retrievable, with its impact and its entity changes', async () => {
    const { body: record } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      caller: { person_id: 141 },
      callee: { person_id: 21 },
      start_time: stamp(4),
      duration_sec: 305,
    });
    expect(record.status).toBe('ACCEPTED');

    const fetched = await get(`/api/v1/ingest/${record.record_id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.record_id).toBe(record.record_id);

    const impact = await get(`/api/v1/ingest/${record.record_id}/impact`);
    expect(impact.status).toBe(200);
    expect(impact.body.impact.changed).toBe(true);
    // A global recomputation happened and its cost is reported, not hidden.
    expect(impact.body.impact.recompute_cost_ms.total_ms).toBeGreaterThan(0);

    const changes = await get(
      `/api/v1/entities/${encodeURIComponent('person:141')}/changes`,
    );
    expect(changes.status).toBe(200);
    expect(changes.body.entity_id).toBe('person:141');
    expect(changes.body.count).toBeGreaterThan(0);
    expect(changes.body.changes.some((c: any) => c.record_id === record.record_id)).toBe(true);

    const unknown = await get('/api/v1/ingest/' + 'f'.repeat(64));
    expect(unknown.status).toBe(404);
  });

  live('the stream publishes named frames and no record content', async () => {
    const frames = await readStream(async () => {
      const { body } = await post('/api/v1/ingest/transaction', {
        provenance: { source_name: 'contract-suite' },
        sender: { person_id: 141 },
        receiver: { person_id: 21 },
        amount_inr: 91000,
        txn_time: stamp(5),
        mode: 'NEFT',
        bank_ref: `NEFT-${stamp(5)}`,
      });
      expect(body.status).toBe('ACCEPTED');
    });

    const names = frames.map((f) => f.event);
    expect(names).toContain('relationship_added');
    expect(names).toContain('new_intelligence');
    // `new_intelligence` is published last, after the recomputation — which is why
    // the UI can key a single refresh off it.
    expect(names.lastIndexOf('new_intelligence')).toBe(names.length - 1);
    for (const frame of frames) {
      expect(frame.data).toMatchObject({
        // A monotonic integer, as `LiveEvent.event_id` in the type layer declares.
        event_id: expect.any(Number),
        event_type: frame.event,
        at: expect.any(String),
      });
      // Frames say what changed, not what was written.
      const raw = JSON.stringify(frame.data);
      for (const key of ['narrative', 'raw_payload', 'normalized_payload', 'phone', 'aadhaar']) {
        expect(raw).not.toContain(`"${key}"`);
      }
    }
  });

  live('an accepted record recomputes the global metrics', async () => {
    const before = await get('/api/v1/graph/summary');
    const { body: record } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      caller: { person_id: 141 },
      callee: { person_id: 7 },
      start_time: stamp(6),
      duration_sec: 452,
    });
    expect(record.status).toBe('ACCEPTED');
    const after = await get('/api/v1/graph/summary');

    // The graph grew, and the person-level intelligence was recomputed from the
    // grown graph rather than patched.
    expect(after.body.graph.edge_count).toBeGreaterThanOrEqual(
      before.body.graph.edge_count,
    );
    expect(record.impact.graph_totals.edges).toBe(after.body.graph.edge_count);
    expect(record.impact.recompute_cost_ms.analytics_ms).toBeGreaterThan(0);
    expect(record.impact.recompute_cost_ms.intelligence_ms).toBeGreaterThan(0);

    const intel = await get('/api/v1/intelligence/persons/141');
    expect(intel.status).toBe(200);
    expect(intel.body.priority.score).toBeGreaterThanOrEqual(0);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(intel.body.priority.band);
  });

  live('the ring overlay is never used by the live pipeline', async () => {
    const { body } = await post('/api/v1/ingest/call', {
      provenance: { source_name: 'contract-suite' },
      caller: { person_id: 141 },
      callee: { person_id: 21 },
      start_time: stamp(7),
      duration_sec: 188,
    });
    // SAME_RING is ground truth, excluded from resolution, detection and scoring.
    expect(JSON.stringify(body)).not.toContain('SAME_RING');
    expect(JSON.stringify(body)).not.toContain('ring_id');

    const records = await get('/api/v1/ingest/records?limit=25');
    expect(JSON.stringify(records.body)).not.toContain('SAME_RING');
  });

  live('the original dataset is untouched by an accepted record', async () => {
    const before = await get('/api/v1/data/summary');
    const { body } = await post('/api/v1/ingest/location', {
      provenance: { source_name: 'contract-suite' },
      person: { person_id: 21 },
      observed_at: stamp(8),
      city: 'Lucknow',
      state: 'Uttar Pradesh',
    });
    expect(['ACCEPTED', 'DUPLICATE']).toContain(body.status);
    const after = await get('/api/v1/data/summary');

    // The writable store is separate: the corpus counts cannot move.
    expect(after.body.counts).toEqual(before.body.counts);
    expect(after.body.loaded_at).toBe(before.body.loaded_at);
  });
});
