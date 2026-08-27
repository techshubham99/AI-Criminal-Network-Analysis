# Phase 2 Pre-Flight Verification

**Date:** 2026-08-26 · **Scope:** verification only — *no Phase 2 code written, dataset not modified, no data regenerated.*
**Method:** every item checked against the actual CSV files and Phase 1 code
(`backend/app/repositories/dataset.py`), not assumptions. Facts below were produced by a
read-only inspection run using the Phase 1 loader (quote-aware parser) plus raw `pandas`.
`architecture.md` is the design source of truth; §8 records one correction applied to it.

## Verdict summary

| # | Item | Result |
|---|------|--------|
| 1 | Phase 1 baseline | **PASS** |
| 2 | Entity ID schema | **PASS** |
| 3 | Confidence semantics | **PASS** (not previously codified → defined here) |
| 4 | Evidence / source record IDs | **PASS** |
| 5 | Self-references | **PASS** |
| 6 | FIR → entity mapping | **PASS** (structured mapping exists; text-derived deferred) |
| 7 | Missing entity types (Vehicle/Org/Event) | **PASS** (absent → future extensibility) |
| 8 | Community detection choice | **PASS** |
| 9 | Output / deliverables (`architecture.md` §Q + this file) | **PASS** |

No blocking issues. Watch-items and assumptions are listed at the end.

---

## 1. Phase 1 baseline — PASS

- **Test suite:** `57 passed` (0 failed) via `./.venv/Scripts/python.exe -m pytest` (~0.6 s).
  One non-blocking Starlette deprecation warning (httpx TestClient) — cosmetic.
- **`/api/v1/data/summary` counts** (identical from the live endpoint and raw `pandas`):

  | table | count |
  |-------|------:|
  | persons | 500 |
  | calls | 2000 |
  | transactions | 1500 |
  | locations | 200 |
  | FIRs | 300 |

- **Endpoints:** all Phase 1 routes exercised green (`/health`, `/`, `/api/v1/data/summary`,
  list+detail for persons/calls/transactions/locations/firs; 404/422 error paths). Repository
  `is_valid = True` (all foreign keys resolve).

## 2. Entity ID schema — PASS

| Entity | Source CSV | Column | Example | Guaranteed unique? |
|--------|-----------|--------|---------|--------------------|
| Person | persons.csv | `person_id` | `1` | **Yes** (500/500, ints 1–500, no gaps) |
| Phone | persons.csv | `phone` | `+91-8555585773` | **Yes** (500/500 distinct) |
| Aadhaar | persons.csv | `aadhar` *(note spelling)* | `606070444418` | **Yes** (500/500 distinct, 12-digit) |
| Location | locations.csv | `location_id` | `1` | **Yes** (200/200) |
| FIR / Case | fir_text.csv | `fir_id` | `1` | **Yes** (300/300) |
| Transaction | transactions.csv | `txn_id` | `1` | **Yes** (1500/1500) |
| Call | calls.csv | `call_id` | `1` | **Yes** (2000/2000) |

Supporting identifiers: `transactions.bank_ref` is **unique** (1500/1500, e.g. `XDHE2342321611076`);
`calls.cell_tower_id` is **not** unique (1803/2000 distinct — it is a shared attribute, not a row id).
`persons.location_id` is a reused FK (184 distinct across 500 persons). `persons.ring_id` is blank for
358 persons (only 142 belong to a ring: rings 0–4 with sizes 24/30/33/24/31).

## 3. Confidence semantics — PASS (defined here)

**Finding:** `architecture.md` *references* confidence in several places — exact-match ER at
`confidence 1.0` (§G), a fuzzy-match threshold (§G), and `confidence` columns on the
`entities` / `entity_mentions` tables (§K; the `relationships` table carries `weight` but **no**
`confidence` column) — but it does **not** define an explicit provenance→confidence rule set. It is defined below. **Confidence** (trust that the link is real) is
kept distinct from **weight** (edge strength used by analytics).

| Tier | Relationship provenance | Confidence rule | Produced in Phase 2? |
|------|------------------------|-----------------|----------------------|
| **A — Direct structured** | A source-CSV foreign key (`caller_id`, `sender_id`, `complainant_id`/`accused_id`, `location_id`, person row) | **1.0** (asserted by source data) | **Yes** |
| **B — Normalized / entity-resolved** | Deterministic exact match on a unique key (`aadhar`, `phone`) | **1.0** (both keys verified unique). Fuzzy/normalized match → **< 1.0**, threshold-gated | Exact: only if trivially applicable. Fuzzy: **No** (ER/NLP phase) |
| **C — FIR free-text extracted** | Person/identifier named only in `narrative` | **< 1.0**, extractor-dependent (never assert 1.0 from text) | **No** — deferred to NLP phase |
| **D — Inferred / derived** | Shared-key co-membership (`CO_LOCATED` on shared `location_id`, `CO_ACCUSED` on shared `fir_id`, weighted-proximity, community co-membership) | Existence of the shared key is deterministic (**1.0**); the *association inference* carries a heuristic **weight**, not an invented probability. Edge flagged `derived = true` | Deterministic-shared-key derivations: **Yes**. Weighted-proximity/community: as analytic **annotations**, not stored edges with invented confidence |

**Emission rule for Phase 2:** only Tier A and Tier D-from-deterministic-shared-keys edges are
created; every such edge therefore has existence-confidence **1.0**. **No sub-1.0 confidence value is
invented for the synthetic data.** Tiers B(fuzzy) and C are schema-defined but produce nothing until
later phases.

## 4. Evidence / source record IDs — PASS

Every CSV already has a **unique, non-null, integer primary key** — so **row numbers are not needed**
for traceability:

| Source | Primary key | Unique |
|--------|-------------|--------|
| persons.csv | `person_id` | 500/500 |
| calls.csv | `call_id` | 2000/2000 |
| transactions.csv | `txn_id` | 1500/1500 |
| locations.csv | `location_id` | 200/200 |
| fir_text.csv | `fir_id` | 300/300 |

**Recommended `source_record_id` format:** **`{source}:{pk}`** — e.g. `persons:1`, `calls:397`,
`transactions:1523`, `locations:1`, `firs:162`. Stable across reloads (PKs are stable), human-readable,
and namespaced by table.

**Edge traceability contract:** every graph edge carries `evidence` = a list of `source_record_id`s.
- Aggregated edges (e.g. `CALLED` folding N calls) → `["calls:12","calls:88", …]`.
- Derived edges (e.g. `CO_LOCATED`) → the contributing person rows plus the shared key, e.g.
  `["persons:12","persons:88"]` with `shared="location:111"`.

## 5. Self-references — PASS

Exact self-reference records (re-verified this run):

| Kind | Count | Records |
|------|------:|---------|
| Self-calls (`caller_id == callee_id`) | 2 | `call_id=397` (person 146→146), `call_id=656` (person 443→443) |
| Self-transactions (`sender_id == receiver_id`) | 0 | — |
| Self-FIR (`complainant_id == accused_id`) | 1 | `fir_id=162` (person 325) |

**Phase 2 representation:** these become graph **self-loops**, which distort centrality/community
metrics and carry no relational information. Decision: **drop self-loops from the analytic
person↔person projection**, but **retain the source records** (still queryable via the Phase 1 API and
carried as evidence). The self-loop count is surfaced as a data-quality note, not silently discarded.

## 6. FIR → entity mapping — PASS (structured exists; text deferred)

`fir_text.csv` columns: `fir_id, date, complainant_id, accused_id, location_id, narrative`.

- A **structured FIR→person mapping DOES exist**: `complainant_id` and `accused_id` are non-blank
  integer FKs to `persons`. Therefore **`NAMED_IN_FIR` (roles complainant / accused) can be reliably
  created in Phase 2** at confidence 1.0, along with `REPORTED_AGAINST` (the FIR's complainant → accused —
  one directed edge per FIR, 299 non-self) and `LOCATED_AT` for the FIR's `location_id`.
  **Note:** `CO_ACCUSED` is *not* available — each FIR has exactly **one** `accused_id` (max 1 accused
  per FIR, 0 FIRs with ≥2 accused), so no two persons ever share a FIR as co-accused (0 edges).
- The **`narrative` free text restates the same complainant and accused as prose**, plus their
  Aadhaar/phone as identifier *strings* (FIR 1: `"Chavvi Anne (Aadhar 316148459341)"` = complainant 489;
  `"Suspect Gunbir Sankar (Phone +91-8298229437)"` = accused 21). Verified across **all 300** FIRs: every
  narrative identifier belongs to that FIR's own complainant/accused — **no person or identifier appears
  that isn't already resolvable from the structured FKs** (the narratives are templated). Extracting
  identifiers from prose is nonetheless an NLP task, and real/enriched FIRs *could* name entities absent
  from the FK columns, so **narrative parsing is deferred to the NLP phase.**

**Rule:** Phase 2 must **not** parse `narrative` to create edges. Text-derived `NAMED_IN_FIR` is
deferred; only the structured FK-based `NAMED_IN_FIR` is built now. No relationships are invented.

## 7. Missing entity types (Vehicle / Organization / Event) — PASS

- **Column scan across all 5 CSVs:** no `vehicle`/`plate`/`registration`/`org`/`organization`/
  `company`/`gang`/`event`/`weapon`/`firearm` columns exist.
- **FIR narrative scan:** 0/300 match an Indian vehicle-plate pattern; 0/300 match org keywords
  (confirms `architecture.md` DQ-8).

**Vehicle, Organization, and Event are absent from the current schema → future extensibility only.**
The only event-like records are the FIR/call/transaction tables (each with its own timestamped rows);
a generic first-class `Event` entity is also deferred. Any demonstration of these depends on the
optional, separate enrichment pack (`backend/data/enrichment/`, originals untouched).

## 8. Community detection — PASS

**Decision (exactly one implementation):** **`networkx.algorithms.community.louvain_communities`**.

- **NetworkX-native** — verified against the official docs; module
  `networkx.algorithms.community.louvain`, callable as `nx.community.louvain_communities(G, ...)`.
- Accepts **`weight`** (default `"weight"`) → works directly on the weighted-multiplex projection
  (§H), and **`seed`** → deterministic, reproducible communities.
- **No separate dependency** (`python-louvain`/`community` is *not* required). Phase 2 adds only
  `networkx` itself to `requirements.txt`.
- **Correction applied to `architecture.md` §H:** the prior wording "Louvain (greedy modularity)"
  conflated two different algorithms; `louvain_communities` ≠ `greedy_modularity_communities`. We use
  `louvain_communities` (weighted, seeded).
- **Honesty (DQ-3):** detected communities are always reported **beside** the ground-truth `ring_id`
  overlay with quantified agreement (modularity + ARI computed at runtime). No target metric is
  pre-committed.

---

## Exact graph relationship types allowed in Phase 2

**Allowed — built from structured source data only, all existence-confidence 1.0:**

| Edge | Direction | Source column(s) | Evidence | Notes |
|------|-----------|------------------|----------|-------|
| `CALLED` | PERSON → PERSON | calls.`caller_id`,`callee_id` | `calls:*` | directed; weight = count + total duration; **self-loops dropped** |
| `TRANSACTED` | PERSON → PERSON | transactions.`sender_id`,`receiver_id` | `transactions:*` | directed; weight = count + total amount |
| `NAMED_IN_FIR` | PERSON → FIR (role = complainant \| accused) | firs.`complainant_id`,`accused_id` | `firs:*` | **structured roles only** |
| `LOCATED_AT` | PERSON → LOCATION | persons.`location_id` | `persons:*` | FIR→LOCATION optional (`firs:*`) |
| `REPORTED_AGAINST` | PERSON → PERSON | firs.`complainant_id` → `accused_id` | `firs:*` | directed; one edge per FIR (299 non-self; self-loop at fir 162 dropped) |
| `CO_LOCATED` | PERSON ↔ PERSON | shared persons.`location_id` | `persons:*` | derived; guard against large cliques at popular locations |
| `OWNS_PHONE` / `OWNS_AADHAAR` | PERSON → PHONE/AADHAAR | persons.`phone`,`aadhar` | `persons:*` | deterministic identity edges (optional) |
| `USED_TOWER` | CALL/PERSON → CELL_TOWER | calls.`cell_tower_id` | `calls:*` | optional |
| `SAME_RING` | PERSON ↔ PERSON | persons.`ring_id` | `persons:*` | **ground-truth label only** — validation/overlay, kept separate from discovered edges |

**Explicitly deferred / NOT allowed in Phase 2:**

- Text-derived `NAMED_IN_FIR` or any narrative-extracted person/identifier edge → **NLP phase**.
- `MEMBER_OF` / `DROVE` / vehicle / organization edges → **no source data**; enrichment + NLP phase.
- Fuzzy / normalized entity-resolution edges → **ER/NLP phase**.
- Weighted-proximity "same cluster" as a stored relationship → community membership is an analytic
  **annotation**, never an asserted edge with invented confidence.
- `CO_ACCUSED` (two persons sharing a FIR as co-accused) → **structurally unavailable**: each FIR has
  exactly one accused (0 such edges). *(59 persons are accused across ≥2 FIRs — a repeat-offender node
  attribute for risk scoring, not a co-accused edge.)*

---

## Unresolved issues / watch-items

1. **NetworkX not yet a dependency.** Phase 2 adds `networkx` (3.x, where `louvain_communities` is
   native) to `backend/requirements.txt`. No other new dependency is needed for community detection.
2. **Projection weights α…ζ** (the DQ-3 multiplex formula) are **tunable and not yet fixed.** They must
   be config-driven (e.g. `config/graph_weights.yaml`), not hardcoded; defaults chosen at implementation
   time and documented.
3. **Directed vs undirected.** `CALLED`/`TRANSACTED` are directed in source; the analytic projection is
   an undirected weighted person graph. Phase 2 maintains **both** (directed for money-flow, undirected
   for centrality/community) and must state which each endpoint uses.
4. **`CO_LOCATED` clique blow-up.** Popular `location_id`s are shared by many persons; a naive all-pairs
   `CO_LOCATED` creates dense cliques. Needs a size cap / down-weighting (implementation detail, not a
   blocker).
5. **Ground-truth ring signal is weak (DQ-3/DQ-4).** Community results must be framed against the
   overlay with honest ARI/modularity — no claim of clean unsupervised ring recovery.

## Final Phase 2 assumptions

- Person is the single canonical node identity; `person_id` is the join key across all five files
  (all FKs resolve, `is_valid = True`).
- Every edge is traceable to ≥1 `source_record_id` in `{source}:{pk}` form.
- Phase 2 emits only structured (Tier A) and deterministic-derived (Tier D) edges — all
  existence-confidence 1.0; **no confidence values are fabricated** for synthetic data.
- Self-loops are excluded from analytics; underlying records are preserved.
- Community detection = native `nx.community.louvain_communities` (weighted, seeded), reported beside
  the ground-truth `ring_id` overlay.
- Vehicle/Organization/Event remain future extensibility; the original dataset stays byte-for-byte
  unchanged.

*End of pre-flight. No Phase 2 implementation has been started.*
