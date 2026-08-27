# Backend — AI-Powered Criminal Network Analysis System

Phases 1–2: **Backend Foundation** + **Criminal Network Graph Engine** (FastAPI, a
read-only dataset access layer, and a deterministic, explainable graph over the
normalized data).

This service loads the synthetic dataset into memory, validates its referential
integrity, exposes verification/inspection endpoints (Phase 1), and builds an
evidence-backed entity graph with centrality/community analytics and path queries
(Phase 2). Later phases (NLP text extraction, risk scoring, audit ledger) are **not
implemented yet**. `docs/architecture.md` (see §Q) is the source of truth for the design.

## Guarantees

- **The original dataset is never modified.** All CSVs are opened read-only; the
  service only reads. Any future demo enrichment goes in new files under
  `backend/data/enrichment/` (see its README).
- **No fabricated results.** The summary endpoint reports descriptive statistics
  only. There is no crime-ring detection or model-accuracy claim anywhere.
- **Runs fully offline.** No external API key or network call is required.
- **No sensitive raw data in logs.** A logging filter redacts Aadhaar numbers and
  phone numbers before anything is written to a log handler.

## Requirements

- **Python 3.12** (pinned in `pyproject.toml`: `>=3.12,<3.13`).
- The dataset present at the path resolved by `app/config.py`
  (`dataset/AI-Powered-Criminal-Network-Analysis-System-main/.../synthetic dataset/`).

## Setup

From the `backend/` directory:

```bash
py -3.12 -m venv .venv
```

```bash
source .venv/Scripts/activate
```

```bash
pip install -r requirements-dev.txt
```

(`requirements.txt` = runtime only; `requirements-dev.txt` adds `pytest` + `httpx`.)

## Run the server

```bash
uvicorn app.main:app --reload --port 8000
```

- Interactive docs: <http://127.0.0.1:8000/docs>
- Health: <http://127.0.0.1:8000/health>

## Run the tests

```bash
pytest
```

## Endpoints (Phase 1)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/` | Service metadata |
| GET | `/health` | Liveness + `dataset_loaded` flag |
| GET | `/api/v1/data/summary` | Counts, referential-integrity report, descriptive stats |
| GET | `/api/v1/persons` | List persons (paginated; filter `ring_id`, `city`) |
| GET | `/api/v1/persons/{id}` | One person |
| GET | `/api/v1/calls` | List calls (paginated; filter `caller_id`, `callee_id`) |
| GET | `/api/v1/calls/{id}` | One call |
| GET | `/api/v1/transactions` | List transactions (paginated; filter `sender_id`, `receiver_id`, `mode`) |
| GET | `/api/v1/transactions/{id}` | One transaction |
| GET | `/api/v1/locations` | List locations (paginated; includes canonical coords) |
| GET | `/api/v1/locations/{id}` | One location |
| GET | `/api/v1/firs` | List FIRs (paginated; filter `complainant_id`, `accused_id`, `location_id`) |
| GET | `/api/v1/firs/{id}` | One FIR |

**Pagination:** `?page=1&page_size=50` (`page ≥ 1`, `1 ≤ page_size ≤ 200`). Every list
response is `{ "items": [...], "meta": { page, page_size, total, total_pages,
has_next, has_prev } }`.

**Errors:** uniform envelope `{ "error": { "code", "message", "detail" } }`.
Unknown id → `404 not_found`; bad query/path types → `422`.

## Endpoints (Phase 2 — graph engine)

Built once at startup from the Phase 1 data. Every edge is evidence-backed and every
existence-confidence is a deterministic `1.0` (never a model confidence).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/graph/summary` | Node/edge counts, projections, community/ARI, limits, provenance note |
| GET | `/api/v1/graph/persons/{id}` | Person node + relationship breakdown + metrics |
| GET | `/api/v1/graph/persons/{id}/network` | Bounded ego-network (depth 1–2, node-capped, optional overlay) |
| GET | `/api/v1/graph/relationships/{rel_id}` | One relationship by id, with its source evidence |
| GET | `/api/v1/graph/path` | Shortest path(s) between two entities (`found:false` when disconnected) |
| GET | `/api/v1/graph/search` | Search nodes by id or label (exact matches first) |
| GET | `/api/v1/analytics/persons/top` | Top persons by `pagerank`/`degree`/`betweenness` (+ neutral interpretation) |
| GET | `/api/v1/analytics/persons/{id}` | One person's metrics + neutral interpretation |
| GET | `/api/v1/analytics/communities` | Louvain communities + modularity + ARI vs ground-truth rings |
| GET | `/api/v1/analytics/demo` | Deterministic, neutral demo investigation (evidence-backed) |

**Node types (materialized):** PERSON, PHONE, AADHAAR, LOCATION, FIR, CELL_TOWER.
**Edge types (the only 10):** CALLED, TRANSACTED, NAMED_IN_FIR, LOCATED_AT,
REPORTED_AGAINST, CO_LOCATED, OWNS_PHONE, OWNS_AADHAAR, USED_TOWER, and SAME_RING
(a ground-truth overlay, excluded from analytics by default).

**Safety limits (server-side):** network depth ≤ 2, ≤ 300 nodes per subgraph, path
length ≤ 6, and capped path/search results.

**Neutral framing:** analytics describe network *position* only (percentile bands) with
an explicit disclaimer — nothing is labelled criminal, and no confidence is fabricated.

## Layout

```
app/
  main.py            # app factory, lifespan (loads dataset), /health, /
  config.py          # settings (env prefix CNA_), dataset path, CORS, paging limits
  core/              # logging (PII redaction), error handlers
  schemas/           # Pydantic response models + pagination envelope
  repositories/      # DatasetRepository: CSV load, indexing, integrity validation
  services/          # geo normalization (canonical centroids), summary builder
  api/v1/            # routers + endpoints
  graph/             # Phase 2: model, store (GraphStore ABC), builder, analytics, demo, service
  nlp/ risk/ audit/  # placeholders for later phases (empty)
tests/               # Phase 1: startup, health, loading, summary, endpoints; Phase 2: build, store, analytics, graph API
data/enrichment/     # optional future enrichment (new files only)
```

## Key design decisions

1. **In-memory repository.** 4,500 rows load instantly; O(1) id lookups via dict
   indexes. A `GraphStore`/DB abstraction is deferred to the phase that needs it.
2. **Quote-aware CSV parsing (pandas).** 256 person addresses contain embedded
   newlines; a naive line count reports 757 rows. pandas keeps the true count (500).
3. **Identifiers kept as strings.** Aadhaar/phone are parsed as text, never floats,
   to avoid precision loss and accidental reformatting.
4. **Canonical geo coordinates.** Provided lat/long are not geographically reliable
   (§DQ-1), so each location is mapped to its city centroid plus small deterministic
   (hash-based, reproducible) jitter. Raw values are preserved alongside.
5. **Fail-fast startup.** If the dataset is missing or a required column is absent,
   the app refuses to start rather than serving partial data.
6. **Deterministic graph engine (Phase 2).** The graph is built once at startup and is
   byte-reproducible (sorted iteration, seeded Louvain, numpy power-iteration PageRank —
   no scipy). Analytics run on person-only projections; self-loops and the SAME_RING
   overlay are excluded. Unlike the dataset, a graph-build failure is **non-fatal**:
   Phase 1 stays up and graph/analytics routes return `503`.
