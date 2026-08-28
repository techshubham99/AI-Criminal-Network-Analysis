# Phase 4.6 — Live Intelligence & New Data Ingestion

*As-built, 2026-08-28. Synthetic data only.*

Phase 4.6 gives the prototype its **first and only write path**. Until now every endpoint
was a read over an immutable corpus. Now a FIR, a call, a transaction or a location
observation can be submitted while the system is running, and — *if and only if it survives
validation* — it enters the graph, the analytics and the Phase 4 intelligence engine, and
the change is announced on a live channel.

The rule that shaped every decision below:

> **The system never blindly adds incoming data.**

---

## 0. What this is, and what it is not

**It is** a validation gate with an ingestion pipeline behind it. A submission is
normalized, hashed, checked for duplication, resolved against existing entities, checked
for relationship validity and provenance, and only then judged. One of four things happens
to it, and the reason is always stated.

**It is not:**

* **Not a data-entry form.** Nothing a caller sends is written to the graph verbatim. What
  the graph receives is a *derived* row built from the normalized payload and resolved
  entity ids (§4, step 9).
* **Not an accusation engine.** An ingestion verdict describes *record validity* and *how a
  reference resolved*. It says nothing about any person. Every response carries this
  sentence in a `disclaimer` field so a client reading JSON alone still reads the caveat:

  > Ingestion decisions describe record validity and how a reference resolves against
  > existing records. They are not findings about any person, and a new or unconnected
  > record is not treated as suspicious.
* **Not an external integration.** There is no access to NCRB, CDR, banking, telecom or
  any government system, and none is claimed. §12 explains what exists instead.
* **Not a rewrite of anything.** The original synthetic dataset is byte-for-byte
  untouched (verified, §16). Phase 1–4 code paths, thresholds, weights and bands are
  unchanged; the same rules simply run over more observations.

---

## 1. Code layout

| File | Lines | Responsibility |
| --- | --- | --- |
| `backend/app/ingest/models.py` | 272 | Statuses, review/reject reasons, match ladder enums, `IngestRecord`, and the one definition of the content hash. |
| `backend/app/ingest/normalize.py` | 297 | Pure normalization + field validation per record type. Reuses Phase 3 `normalizer`/`validators`. |
| `backend/app/ingest/resolution.py` | 368 | The §5 resolution ladder for persons and places. |
| `backend/app/ingest/store.py` | 305 | The writable investigation store and its optional append-only journal. |
| `backend/app/ingest/pipeline.py` | 890 | The nine-step gate; the only place a record can be accepted. |
| `backend/app/ingest/graph_update.py` | 314 | Incremental, aggregation-preserving edits to the Phase 2 graph. |
| `backend/app/ingest/recompute.py` | 309 | Full recomputation of global analytics + Phase 4 intelligence over a live overlay. |
| `backend/app/ingest/events.py` | 148 | The five live event types, the in-process bus, SSE framing. |
| `backend/app/ingest/external.py` | 75 | The adapter *interface*. No adapter is enabled or implemented. |
| `backend/app/schemas/ingest.py` | 254 | Pydantic request/response models (`extra="forbid"`). |
| `backend/app/api/v1/endpoints/ingest.py` | 239 | The four POST routes and the read/stream routes. |
| `backend/app/api/v1/endpoints/entities.py` | 34 | `GET /entities/{entity_id}/changes`. |
| `backend/scripts/phase4_6_demo.py` | 231 | The §14 demo driver; records real responses as frontend fixtures. |
| `backend/tests/test_ingest.py` | 606 | 34 unit/integration tests of the pipeline. |
| `backend/tests/test_ingest_api.py` | 533 | 25 HTTP-level tests including SSE. |

Frontend (deliberately small — §13):

| File | Responsibility |
| --- | --- |
| `frontend/src/api/live.ts` | One shared `EventSource`, named-frame subscription, connection state. |
| `frontend/src/hooks/useLive.ts` | React binding for the above. |
| `frontend/src/components/live/AddIntelligence.tsx` | The submit form for all four record types. |
| `frontend/src/components/live/IngestVerdict.tsx` | The verdict: status, reason, matches, relationships, impact. |
| `frontend/src/components/live/LiveIndicator.tsx` | The small LIVE / connecting / off dot in the top bar. |
| `frontend/src/components/live/live.test.tsx` | 21 tests over recorded backend responses. |

Three small hooks were added to existing services rather than duplicating them:
`GraphService.cached_analytics` + `GraphService.publish_analytics` (so a served response can
never mix pre-change centrality with post-change topology) and `NlpService.ingest_fir` (so
one accepted FIR goes through exactly the per-FIR path `build()` already runs).

---

## 2. The writable investigation store (spec §1)

The synthetic dataset under `settings.dataset_dir` is **read-only**. Accepted live records
live in their own place: `settings.ingest_dir` (`backend/data/ingest`) and their own
in-memory lists. `DatasetRepository`'s record lists are never mutated either, which is why
every Phase 1 count is exactly what it was before.

Each submission is stored as an `IngestRecord`:

```
record_id            deterministic content hash (§3)
source_type          FIR | CALL | TRANSACTION | LOCATION
raw_payload          exactly what the caller sent
normalized_payload   the deterministic normalized form (what gets hashed)
provenance           source_type, source_name, submitted_by, reference, note
ingested_at          wall-clock ingestion timestamp (NOT part of the hash)
status               ACCEPTED | DUPLICATE | REVIEW_REQUIRED | REJECTED
validation_status    VALID | INVALID
resolution_status    RESOLVED | UNRESOLVED | NOT_ATTEMPTED
review_reason        AMBIGUOUS_MATCH | NO_MATCH_NEW_ENTITY | null
reject_reason        SCHEMA_INVALID | INVALID_FIELD | INVALID_RELATIONSHIP | null
reason               one human-readable sentence, always populated
matches              per-field resolution result incl. candidates
relationships        per-relationship accept/reject decision incl. reason
evidence             evidence ids created, e.g. ["calls:2001"]
entity_ids           resolved entity ids touched
duplicate_of         the earlier record this repeats, when DUPLICATE
impact               what actually changed (§8–§10)
```

The original submission is always kept beside the normalized form, so normalization never
destroys what the caller actually sent — the same commitment Phase 3 makes for extracted
text.

**Persistence.** `ingest_persist` is **off by default** so tests and the demo start from a
clean, deterministic store. When on, the journal is an append-only JSONL of *submissions*
(raw payload + provenance + original ingestion time), never of derived conclusions. At
startup those submissions are replayed through the same pipeline that first judged them, so
a restored store cannot disagree with the pipeline about what a record means.

**One deliberate asymmetry:** a `REJECTED` submission is *reported* but not *stored*. A
payload that failed normalization is not an observation, so it is not kept as one. Its
verdict is in the POST response; it is not retrievable afterwards. See §17.

---

## 3. Deterministic record id (spec §2)

```python
def make_record_id(source_type, normalized) -> str:
    material = f"{source_type.value}|{canonical_payload(normalized)}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
```

`canonical_payload` sorts keys, drops `None` (so an omitted optional field and an explicit
`null` are the same observation), and uses compact separators. **The ingestion timestamp is
not an input.** Consequences, all tested:

* The same observation submitted twice — a minute apart or a restart apart — produces the
  same 64-hex id, is recognised as `DUPLICATE`, and changes nothing.
* Duplicate protection is *by construction*, not by a check: the store is keyed by
  `record_id`, so storing the same normalized observation twice is impossible.
* An edge cannot double-count. In the recorded demo, step C (the identical call, resubmitted)
  returned `DUPLICATE id=83408ea024` with `impact.changed = false` in **0 ms**.

A rejected submission gets its id from `{"__rejected__": raw}` instead, because
normalization — the thing the id is supposed to summarise — is exactly what failed.

---

## 4. The nine-step gate (spec §4)

Every submission walks the same nine steps, in this order, and cannot skip one:

| # | Step | Where | Failure |
| --- | --- | --- | --- |
| 1 | Schema validation | Pydantic at the HTTP edge, `extra="forbid"` | `422 validation_error` |
| 2 | Normalization + field validation | `normalize.py` | `REJECTED / INVALID_FIELD` |
| 3 | Duplicate detection | content hash vs store | `DUPLICATE` |
| 4 | Entity resolution | `resolution.py` (§5) | `REVIEW_REQUIRED` |
| 5 | Relationship validation | `pipeline._apply` | relationship not accepted |
| 6 | Provenance / evidence validation | `pipeline` | `REJECTED / INVALID_FIELD` |
| 7 | Decision | `pipeline._decide` | one of the four statuses |
| 8 | Persistence | writable store only | — |
| 9 | Graph update + recomputation | **accepted records only** | — |

Two properties matter more than the list:

* **Steps 1–7 run before any write.** A record that needs a human stops at step 8 with its
  reason attached and `impact.changed = false`.
* **Step 9 never writes caller input.** It writes derived rows built from the *normalized*
  payload and *resolved* entity ids. There is no code path from a request body to a graph
  node.

Ingestion is serialized by a lock. Submissions are cheap; recomputation is global, and a
deterministic order is what makes record ids, live row ids and graph aggregates
reproducible.

`provenance.source_name` is required: a record with no stated source cannot be evidence.
A transaction additionally requires `bank_ref` — unreferenced money movement is not evidence
of anything and is rejected as a field error.

### The four statuses, stated plainly

| Status | Meaning | Graph | Intelligence |
| --- | --- | --- | --- |
| `ACCEPTED` | Valid, and every reference resolved to exactly one existing record. | updated | recomputed |
| `DUPLICATE` | Byte-identical content to a record already held. | untouched | untouched |
| `REVIEW_REQUIRED` | Valid record, unresolved reference. Held for a human. | untouched | untouched |
| `REJECTED` | Not a usable record at all. | untouched | untouched |

---

## 5. Entity resolution, and the two review reasons (spec §5, §6)

The ladder reuses Phase 3's normalization rules — a phone number means the same thing
whether it arrived in a FIR narrative or a call record — and stops at the first rung that
yields exactly one record.

**Persons** (`resolve_person`):

1. **`trusted_identifier`** — `person_id`, phone, or Aadhaar. When several are supplied the
   candidate sets are *intersected*; identifiers that point at different people do **not**
   pick a winner.
2. **`normalized_exact`** — one, and only one, person whose normalized name matches.
3. **`deterministic_context`** — narrowed by something else in the same payload (e.g. the
   stated place) such that exactly one candidate survives.

**Places** (`resolve_place`): `location_id` → trusted; a unique city/state →
`normalized_exact`; the anchor person's own recorded location row → `deterministic_context`.

Then, exactly as the spec requires, two different outcomes:

* **Multiple surviving candidates → `AMBIGUOUS_MATCH`.** *We cannot tell which existing
  record this is.* Nothing is merged. The candidates are returned so the question is
  answerable from the payload alone.
* **Zero candidates → `NO_MATCH_NEW_ENTITY`.** *This appears to be someone or somewhere we
  have never seen.*

These are never collapsed, and the code says why: collapsing them would hide the difference
between a **merge risk** and a **new subject**. Ambiguous people are never silently merged.

### Unrelated data is not forced, and not suspicious (spec §6)

When nothing in a submission resolves, the response carries the required sentence verbatim:

> No validated connection found with existing investigation data.

No edge is invented to attach the record to the existing network. The record is held, and
**nothing about it is treated as a detection**. An isolated, legitimate network is a
supported outcome, not an anomaly — which is also why the disclaimer in §0 exists.

Two ways `AMBIGUOUS_MATCH` actually arises in this corpus (both fired naturally in the
recorded demo — no fabrication was needed, and none was used):

* **Conflicting trusted identifiers.** A phone belonging to person 141 and an Aadhaar
  belonging to person 21 on the same reference: *"The identifiers on this reference match
  different person records; not merged without a decision."*
* **A crowded place.** `Chennai, Tamil Nadu` with no corroborating person location:
  *"29 location records share Chennai, Tamil Nadu; supply a location_id to say which one."*

Note that a *name-only* reference can never be ambiguous in this corpus: it contains no
duplicate full names. That was checked against `persons.csv` rather than assumed.

---

## 6. New FIR analysis (spec §7)

An accepted FIR additionally goes through the **existing** Phase 3 NLP pipeline via
`NlpService.ingest_fir` — the same extraction, resolution, relation extraction and narrative
integration that `build()` runs per FIR. It becomes queryable like any other FIR.

The response reports, under `impact.nlp`: extracted entities, which resolved and which are
new, accepted relationships, rejected relationships **with their reasons**, review items and
evidence. Narrative-derived edges land in the **Phase 3 narrative overlay**, never in the
structured graph — the Phase 3/Phase 4 separation between structured and NLP-derived
evidence is preserved exactly.

No relationship is invented. A narrative relationship the extractor cannot ground in
resolved entities is reported as not accepted, with the reason, and that is the end of it.

---

## 7. Structured ingestion (spec §8)

* **Call** — both parties must resolve to existing persons before an edge is created.
  Optional `cell_tower_id`.
* **Transaction** — `bank_ref` required; amount bounded by `ingest_max_amount_inr`.
* **Location observation** — records that a person *was seen at an existing location*. It
  is added as its own edge and does **not** overwrite the person's recorded address. **No
  coordinates and no geographic facts are ever inferred** for a place that is not already in
  the dataset.

**Self-references.** A person calling their own number, or transacting with themselves, is
written as a self-loop, because it is real evidence. The Phase 2 projections already skip
self-loops, so it stays out of centrality and out of Phase 4 scoring — exactly as already
implemented, with no new exclusion logic. The UI labels such a relationship
`· evidence only`.

---

## 8. Incremental graph update (spec §9)

The graph is **edited, never rebuilt**. Inserting one call touches one aggregate edge (and
possibly one tower node), not 500 persons and 2,000 calls. Three properties are preserved
deliberately, because they are what make the edit indistinguishable from a rebuild:

* **Aggregation.** Phase 2 folds every call between one ordered pair into a single `CALLED`
  edge carrying `weight=count` and `weight_detail={count, total_duration_sec}`. A live call
  therefore *merges into* that edge — one more piece of evidence, a higher count, a wider
  date range — instead of adding a parallel edge. This is the second half of why a
  resubmitted record cannot double-count.
* **Provenance.** Every live row contributes its own `table:pk` evidence id, preserving the
  existing "one evidence id per observation" invariant, and the submission's `record_id` is
  recorded in `attributes.ingest_record_ids`, so an edge can always be traced back to the
  submission that changed it.
* **The structured / narrative split.** Nothing here writes to the Phase 3 narrative
  overlay, and nothing here writes `SAME_RING`.

Measured in the recorded demo: one call `+1 edge`; one transaction `+1 edge`; one FIR
`+1 node, +4 edges`; one location observation `+1 edge`. Graph totals moved from
**3,803 nodes / 10,802 edges → 3,804 / 10,809** across seven stored records — the exact
arithmetic, with no rebuild.

---

## 9. Global analytics: fully recomputed, and what that costs (spec §10)

PageRank, betweenness centrality and community detection are **global** properties: one new
edge can change the score of a person the edge does not touch. There is no correct way to
patch them locally, so `recompute.py` builds a fresh `GraphAnalytics` over the mutated store
and lets it do the full computation.

**No partial-update shortcut is faked.** The cost is reported on every accepted response
instead of hidden, as `impact.recompute_cost_ms`.

Measured on this dataset (500 persons, ~4,500 person-person edges), for the accepted call in
the recorded demo:

```json
"recompute_cost_ms": { "analytics_ms": 1518.1, "intelligence_ms": 227.1, "total_ms": 1745.2 }
```

Across the four accepted records in that run: **1,745 ms** (call), **1,682 ms**
(transaction), **1,766 ms** (FIR), **1,595 ms** (location). A `DUPLICATE` costs **0 ms** —
it recomputes nothing. **Betweenness centrality dominates** the ~1.5 s analytics figure; it
is O(V·E) on the projection and is the reason a single accepted record costs on the order of
a second rather than milliseconds. That is the honest price of not faking a partial update,
and it is stated in the UI too: the impact panel's *Recompute* row carries the hint
*"PageRank, betweenness and communities are global metrics: they are fully recomputed after
an accepted change, never patched."*

One consequence worth knowing before a demo: because the community partition is recomputed,
**community labels move**. In the demo, modularity went `0.219089 → 0.216548`. That is a
different partition of the same graph, not a worse one.

---

## 10. Intelligence recomputation (spec §11)

The Phase 4 detectors read the repository's record lists, so accepted live rows are exposed
through `LiveDataView` — a read-only overlay returning *base rows + accepted live rows*. The
CSVs are untouched, `DatasetRepository`'s own lists are untouched, and **no Phase 4
threshold, weight or band is altered**. The same rules run over more observations. Nothing
lowers a threshold to force a detection.

`impact` reports the before/after so the change is auditable:

```
changed, graph {nodes_added, edges_added, edges_updated}, graph_totals {nodes, edges},
live_rows {calls, transactions, firs, location_observations},
patterns_before, patterns_after, new_pattern_ids, cleared_pattern_ids,
persons, priority_changes [{person_id, entity_id, score_before, score_after,
                            band_before, band_after}],
relationships_accepted, relationships_rejected,
recompute_cost_ms, reidentified_pattern_count, reidentified_note
```

### A changed pattern id is not a new detection

Phase 4 pattern ids hash the pattern's detail, and for `BRIDGE_ENTITY` that detail includes
community labels — which move whenever one edge shifts the modularity partition, even though
the same person still bridges the same neighbours on the same evidence. Comparing raw ids
would report dozens of "new patterns" for a single call.

`pattern_signature` therefore compares what a pattern *asserts* (its type and its entities),
so `new_pattern_ids` means **newly detected** and nothing else. Ids that moved without their
assertion changing are counted separately:

```json
"reidentified_pattern_count": 50,
"reidentified_note": "Patterns whose deterministic id changed because community labels
                      shifted, while the pattern still asserts the same thing"
```

**50 per accepted record** on this corpus. Reporting them as detections would have been the
easiest way to fake an impressive demo; this is why the number is in its own field with an
explanation.

### `SAME_RING` is absent

`SAME_RING` is a ground-truth overlay, not observable intelligence. Nothing in this phase
reads it, writes it, resolves against it or scores it — not in live resolution, not in
pattern detection, not in scoring, not in recomputation. A live-HTTP test asserts the string
never appears in any ingestion response, and the graph updater never emits that edge type.

### The measured intelligence effect of the demo run

Patterns **502 → 504** (+2: one transaction pattern, one FIR pattern). Person `141`'s
investigation-priority score moved **68 (MEDIUM) → 76 (HIGH)** after the four accepted
records. That crossing is a real consequence of added observations — the Phase 4 band
boundaries were not touched — and it is worth saying explicitly what it means and does not
mean: **the priority score is a review-ordering number over records, not a finding about the
person.**

---

## 11. The live channel — SSE only (spec §12)

`GET /api/v1/ingest/stream` is a `text/event-stream` response. **No WebSocket exists
anywhere in the project.** Headers: `cache-control: no-cache`, `connection: keep-alive`,
`x-accel-buffering: no` (so a proxy cannot buffer the stream). A comment frame is written
immediately, then every `ingest_sse_keepalive_sec` (15 s) while idle, so a client can tell
"connected and quiet" from "still connecting".

Five event types, published in this order for one accepted record:

| Frame | Carries |
| --- | --- |
| `relationship_added` | `record_id`, `source_type`, `relationship_ids`, `new_edges`, `updated_edges` |
| `entity_updated` | `record_id`, `source_type`, `entity_ids` |
| `pattern_detected` | `record_id`, `source_type`, `pattern_ids` |
| `priority_changed` | `record_id`, `source_type`, `changes[{person_id, entity_id, score_before, score_after, band_*}]` |
| `new_intelligence` | `record_id`, `source_type`, `status`, `entity_ids`, `new_patterns`, `priority_changes` |

Every frame is **named** (`id: <n>` / `event: <type>` / `data: <json>`), so a client must
subscribe per type. Frames carry entity ids, relationship ids, pattern ids and counts — i.e.
**what to refetch** — and deliberately carry **no narrative text, no phone or Aadhaar number,
no amount and no raw submission**. That is asserted twice: over live HTTP (0 frames
containing `narrative`/`raw_payload`) and in the frontend suite against the recorded frames.

Delivery is a bounded per-client `asyncio.Queue` (`ingest_sse_queue_size = 64`): a client
that cannot keep up drops frames rather than growing the server's memory. A newly attached
client is replayed the last `ingest_event_buffer` (50) events.

---

## 12. External sources (spec §13)

**There is no external integration, and none is claimed.** No adapter is implemented, no
credential is read, and nothing in this codebase contacts a network.

What exists is an interface: `SourceAdapter.fetch` yields payloads in the same shape the HTTP
endpoints accept, so a real, *authorized* integration could later be attached without
changing the pipeline — because anything arriving that way would go through exactly the same
validation, resolution and decision gate as a manual submission. An adapter never decides
anything.

Adapters are opt-in by name via `CNA_INGEST_EXTERNAL_SOURCES`. That setting is empty by
default — the only configuration this prototype ships — so `enabled_adapters()` returns
nothing and the internal ingestion API works in full with no credential of any kind.

---

## 13. Frontend surface (spec §14)

Nothing was rebuilt. Four additions, all small:

1. **`AddIntelligence`** on the Alerts page — a record-type switch (FIR / Call /
   Transaction / Location), the fields that type needs, and a Submit button. The client
   normalises nothing: it posts what was typed. No reformatted timestamp, no coerced
   duration, no invented field. Every one of those steps belongs to the backend.
2. **`IngestVerdict`** — the status badge, the backend's own `reason` **verbatim**, the
   review or reject reason, the per-field match notes with candidates, accepted and
   not-accepted relationships, and a compact impact summary. A `REJECTED` or held record
   renders as fully as an accepted one.
3. **`LiveIndicator`** in the top bar — one dot and one word: `LIVE`, `connecting`, or
   `Live off`. One shared `EventSource` for the whole app regardless of how many components
   subscribe; closed when the last one unmounts. When the browser has no `EventSource`, it
   says the stream is off rather than pretending.
4. **Auto-refresh** on the Alerts page: a `new_intelligence` frame refetches the priority
   queue **in place** — no reload, no notification framework, no animation. A frame that
   cannot have moved a score (e.g. `entity_updated`) costs no request, and one accepted
   record causes exactly **one** refresh, not one per frame.

Text was cut, not added: no long paragraphs, no implementation explanations, no
prototype-status prose. Short labels, the action, the status, the reason, the data.

---

## 14. Demo scenario (spec §15)

`backend/scripts/phase4_6_demo.py` drives the deterministic flow over live HTTP and records
every response. Run it against a **freshly started** server (the store is in-memory by
default, so a restart gives step B a clean slate):

```bash
cd backend && .venv/Scripts/python.exe -m scripts.phase4_6_demo --base http://127.0.0.1:8012 --record
```

The transcript below is the actual recorded output. **Nothing in it was fabricated**; every
status is whatever the pipeline answered, and `--record` writes those exact bodies into
`frontend/src/test/fixtures/` where the UI tests consume them.

```
A  before / graph          200 modularity 0.219089  (3,803 nodes / 10,802 edges)
A  before / intel          200 persons_scored 500, patterns_detected 502
A  before / p141           200 priority score 68 MEDIUM
B  valid call              200 ACCEPTED id=83408ea024 edges+1 prio=1 1745ms
  -> ingest-record         200 status ACCEPTED, validation VALID, resolution RESOLVED
  -> ingest-impact         200 changed=true
C  same call again         200 DUPLICATE id=83408ea024 (identical hash) 0ms
D  invalid call            200 REJECTED INVALID_FIELD "caller.phone: not a 10-digit Indian mobile number"
E  unrelated pair          200 REVIEW_REQUIRED NO_MATCH_NEW_ENTITY
F  transaction             200 ACCEPTED edges+1 new_patterns=1 prio=2 1682ms
G  FIR                     200 ACCEPTED nodes+1 edges+4 new_patterns=1 prio=2 1766ms
H  location (own place)    200 ACCEPTED edges+1 1595ms
I  location (Chennai)      200 REVIEW_REQUIRED AMBIGUOUS_MATCH (29 location records share Chennai, Tamil Nadu)
J  conflicting identifiers 200 REVIEW_REQUIRED AMBIGUOUS_MATCH (caller AMBIGUOUS, callee MATCHED)
K  after / graph           200 modularity 0.216548
K  after / intel           200 patterns_detected 504
K  after / p141            200 priority score 76 HIGH
K  after / changes         200 person:141 count 5
K  after / summary         200 records total 7, graph_totals 3,804 nodes / 10,809 edges
```

Mapping to the required scenario: **A** before, **B** add valid data, **C** duplicate,
**D** invalid → `REJECTED`, **E** new/unrelated → `REVIEW_REQUIRED / NO_MATCH_NEW_ENTITY`,
and **I**/**J** demonstrate `AMBIGUOUS_MATCH` on both a place and a person — which arose
naturally from the corpus rather than being staged.

`records total 7` for nine POSTs is correct and worth reading twice: C is the same record as
B (one content hash), and D was rejected, so it was never stored (§2, §17).

---

## 15. Tests (spec §16)

**Backend — 59 new tests**, `backend/tests/test_ingest.py` (34) and
`backend/tests/test_ingest_api.py` (25), covering: all four ingestion types; normalization
of each field kind; every validation failure; deterministic `record_id` including
timestamp-independence and restart-independence; duplicate/idempotency (no second record, no
second edge, no double-counted weight); `AMBIGUOUS_MATCH` from conflicting identifiers and
from a crowded place; `NO_MATCH_NEW_ENTITY` with the required sentence; unrelated data not
forced and not flagged; incremental graph update with aggregation, provenance and no
duplicate edge; global metric recomputation actually happening; Phase 4 intelligence
updating; self-reference written as evidence but excluded from intelligence; `SAME_RING`
never touched; SSE delivery of named frames with no sensitive content; and the impact and
entity-changes endpoints.

**Frontend — 21 new tests**, `frontend/src/components/live/live.test.tsx`, over the recorded
fixtures: the exact POST body; the record-type switch; a transport failure reported as a
failure rather than a rejected record; all four verdicts rendering as themselves; the two
review reasons never shown as each other; no forbidden word ("suspicious", "criminal",
"guilty") anywhere in a held record's rendering; connection state transitions; one shared
connection; listeners registered for all five frame names; no record content on the stream;
and refresh-in-place-once on `new_intelligence`.

**Live contract — 12 new cases**, `frontend/src/test/live/contract.test.ts`, run over real
HTTP against a running backend (`npm run test:live`). Each case self-skips when the backend
is unreachable, and payloads are stamped unique per run so a rerun is never answered
`DUPLICATE` by accident.

---

## 16. Verification record (2026-08-28)

| Check | Result |
| --- | --- |
| Backend regression, one full run | **481 passed, 0 failed** across 18 files (422 pre-existing + 59 Phase 4.6) → **zero regressions** |
| Frontend `npm run verify` | typecheck clean; **431 tests / 25 files passed**; build OK (1,013.63 kB JS, 304.86 kB gzip; 52.50 kB CSS) |
| Live contract over HTTP | **32 / 32 passed** (20 Phase 1–4 + 12 Phase 4.6) |
| Phase 1–4 API compatibility | the same 32/32 run was executed **after** live ingestion had mutated the in-memory graph |
| All four POST routes over live HTTP | verified; each answered with one of the four statuses, a 64-hex `record_id`, raw + normalized payloads and echoed provenance |
| `GET /ingest/{id}`, `/{id}/impact`, `/entities/{id}/changes` | verified, incl. `404 not_found` for an unknown id |
| SSE stream | `text/event-stream; charset=utf-8`, `cache-control: no-cache`, `x-accel-buffering: no`; keepalive comments; frames in order `relationship_added → entity_updated → pattern_detected → priority_changed → new_intelligence`; **0 frames** carrying `narrative`/`raw_payload` |
| Frontend updates without a manual reload | proven by the jsdom suite driving the **recorded** frames through the real `api/live.ts` path, plus the live SSE ordering test. Browser preview evaluation was out of scope for this run, so this is the substitute — stated as such |
| Duplicate / invalid / no-match behaviour | verified over live HTTP and in the demo transcript (§14 C, D, E) |
| Graph effect | `impact.graph_totals.edges` equals `/graph/summary.edge_count` after an accepted record |
| PageRank / betweenness / community recomputation | `analytics_ms > 0` and `intelligence_ms > 0` on every accepted record; modularity observably moved |
| Priority / pattern updates | patterns 502 → 504; `person:141` 68 MEDIUM → 76 HIGH; `person:21` 39 LOW → 41 MEDIUM |
| `SAME_RING` unused | asserted absent from every ingestion response and from the updater |
| **Original dataset unchanged** | `diff` of before/after SHA-256 lists → **identical, all 5 files**; `git status --porcelain -- dataset/ data/` empty |

Baseline dataset digests (SHA-256, unchanged before and after the full demo run):

```
calls          8134ea80…
fir_text       b6c9c2be…
locations      19b06340…
persons        4f913757…
transactions   e6415a26…
```

---

## 17. Limitations — read before demoing

1. **Two reference forms of the same observation hash differently.** §2 hashes the
   normalized payload and §4 dedupes *before* resolution, so submitting the same call once
   by `person_id` and once by phone produces two record ids. The graph still aggregates
   correctly onto one edge (no double-counted weight), but both record ids appear as
   evidence behind it. Hashing resolved entity ids instead would fix this at the cost of
   making duplicate detection depend on resolution.
2. **There is no approval endpoint.** A `REVIEW_REQUIRED` record persists with its reason
   and candidates, and stops there. Nothing in this phase lets a reviewer resolve it into an
   accepted record — by design, since that is a workflow feature, but it does mean review is
   a dead end for now.
3. **A `REJECTED` submission is not retrievable.** Its verdict is in the POST response only.
   §1 of the spec lists `REJECTED` among the store's statuses; the implementation reports it
   without storing it, on the grounds that a payload which failed normalization is not an
   observation. This is a deliberate deviation, noted here rather than glossed.
4. **`REJECTED` returns HTTP 200.** The *submission* was handled successfully; the *record*
   was refused. A `4xx` is reserved for a malformed request (schema → `422`). Clients must
   read `status`, not the HTTP code.
5. **An accused-less live FIR contributes no pair-level intelligence.** With no resolved
   accused there is no person-pair to score, so such a FIR is stored and analysed but does
   not participate in pair-level patterns.
6. **A location observation changes graph counts but not person centrality.** It is a
   person↔location edge; the Phase 2 person-person projection does not include it, so
   PageRank and betweenness are unmoved by it even though the recompute still runs.
7. **The live store is in-memory unless `ingest_persist` is enabled.** Restarting uvicorn
   discards accepted live records — deliberate, because it makes the demo repeatable, but it
   means a "live" record is not durable in the default configuration.
8. **A full recompute costs ~1.6–1.8 s per accepted record**, dominated by betweenness. At
   this dataset size that is fine; it does not scale to a high submission rate, and no
   partial-update shortcut was faked to hide that.
9. **50 patterns are re-identified per accepted record** because community labels shift while
   the assertion is unchanged (§10). They are reported in their own field precisely so they
   are not mistaken for detections.
10. **No external data source exists.** No NCRB, CDR, banking or telecom access; the adapter
    interface is an interface (§12).
11. **Synthetic data throughout.** No person in this system is a suspect, an accused or a
    criminal. An ingestion verdict is about a *record*; a priority score is about *review
    ordering*.

---

## 18. Configuration reference

All settings take a `CNA_` prefix as environment variables
(`backend/app/config.py:173–202`).

| Setting | Default | Meaning |
| --- | --- | --- |
| `ingest_dir` | `backend/data/ingest` | Writable store directory. Never the dataset directory. |
| `ingest_persist` | `False` | Append-only JSONL journal of submissions, replayed at startup. Off so tests and the demo start clean. |
| `ingest_min_narrative_chars` | `20` | Validation, not truncation: below this a narrative is not a FIR statement. |
| `ingest_max_narrative_chars` | `4000` | Bounds the rule-based extractor's work. |
| `ingest_max_call_duration_sec` | `86_400` | Guards a mistyped duration being accepted as fact. |
| `ingest_max_amount_inr` | `1.0e10` | Same, for an amount. |
| `ingest_sse_keepalive_sec` | `15.0` | Comment-frame interval on an idle stream. |
| `ingest_sse_queue_size` | `64` | Bounded per-client queue; a slow client drops frames rather than growing memory. |
| `ingest_event_buffer` | `50` | Recent events replayed to a newly attached client. |
| `ingest_external_sources` | `[]` | Opt-in adapter names. Empty is the shipped configuration. |

No Phase 4 threshold, weight or band is configurable from this phase, and none was changed
by it.
