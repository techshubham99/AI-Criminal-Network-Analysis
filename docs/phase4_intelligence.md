# Phase 4 — Investigation Intelligence Engine

*As-built reference. Every number in this document was measured against the committed
synthetic corpus on 2026-08-27 by the code described here; nothing is illustrative.*

Phase 4 reads the Phase 1 records, the Phase 2 structured graph and the validated Phase 3
narrative extractions, and produces two things:

1. **Patterns** — named, evidence-backed structural observations about entity pairs and
   groups.
2. **An Investigation Priority Score** — a deterministic 0–100 triage signal per person,
   decomposed into six explainable factors.

## 0. What this is, and what it is not

The score is an **investigation-prioritization signal**. It answers *"whose records should
an analyst look at first?"* on this synthetic corpus.

It is **not** a probability of guilt, **not** a probability of criminality, **not** proof
of wrongdoing, and **not** a classifier of people. No output of this phase labels any
person a criminal. Transaction shapes are reported as *"Potential transaction pattern
requiring review"* — never as laundering, fraud, or confirmed criminal activity. Every
score and every pattern response carries this disclaimer verbatim:

> Investigation-prioritization signal computed from observed synthetic records only. It is
> NOT a probability of guilt, NOT a probability of criminality, and NOT proof of
> wrongdoing.

Nothing here fabricates a relationship, an item of evidence, or a result. Every detection
cites the exact source records it rests on, and a detection with no citable record is not
emitted.

## 1. Code layout

```
backend/app/risk/
  models.py      evidence refs, pattern types, deterministic pattern id, score/factor types
  detectors.py   the five detectors (multi-channel, communication, transaction, location, bridge)
  scoring.py     PriorityScorer: features -> factors -> 0-100 score
  explain.py     natural-language explanation for every pattern, factor and score
  service.py     IntelligenceService: build once at startup, then read-only lookups
backend/app/schemas/intelligence.py         response models
backend/app/api/v1/endpoints/intelligence.py  six routes, no business logic
backend/tests/test_intelligence.py          engine-level tests (53)
backend/tests/test_intelligence_api.py      HTTP-level tests (38)
```

The engine is built once, in `main.py`'s lifespan, after the graph and NLP layers, inside
its own `try/except`. If it fails, `app.state.intelligence` stays `None` and only
`/api/v1/intelligence/*` returns 503 — Phases 1–3 are unaffected. Detection and scoring
never write to the Phase 2 graph; `GET /api/v1/intelligence/summary` reports
`structured_graph_mutated: false`, and a test asserts the graph's node and edge counts are
identical to a build in which Phase 4 never ran.

## 2. Evidence model — structured and NLP-derived stay separate (§7)

Every citation is an `EvidenceRef`:

| field | meaning |
|---|---|
| `evidence_id` | de-duplication key |
| `evidence_class` | `STRUCTURED` or `NLP_DERIVED` — never mixed in one list |
| `source_dataset` | `calls`, `transactions`, `persons`, `locations`, `firs`, `fir_text` |
| `source_record_id` | `"{table}:{pk}"`, resolvable through the Phase 1 API |
| `confidence` | this item's **own** tier — see below |
| `confidence_basis` | `structured_record`, or the Phase 3 rule that fired |
| `evidence_text` | the narrative span, when the evidence came from text |

Confidence tiers are never averaged, blended, or collapsed into one unexplained number:

* **STRUCTURED** — an observed dataset row. `confidence = 1.0`,
  `confidence_basis = "structured_record"`. This is a **data-provenance** statement ("this
  row exists"), not a model confidence.
* **NLP_DERIVED** — a Phase 3 rule extraction over FIR free text. It keeps the extraction
  confidence Phase 3 assigned it (e.g. `0.9`, `confidence_basis = "rule:association_trigger"`)
  and the text it came from.

Every pattern and every score exposes `structured_evidence` and `nlp_evidence` as two
separate lists. **There is no merged evidence field anywhere in the API.**

**An NLP-derived edge never raises a score by itself.** Narrative edges live in the
separate Phase 3 narrative store and are reported as *independent channels*, but they are
excluded from the channel count that drives the multi-channel feature. This corpus
contains exactly one such case — pattern
`multi_channel_relationship~22f25782de359f90` for `person:21` / `person:452`:

* structured channels: FIR (`firs:152`) and TRANSACTION (`transactions:1378`) → channel
  count **2**, feature value `0.3333`, contribution `6.67`;
* NLP-derived: `ASSOCIATED_WITH` from `firs:152`'s narrative ("The accused is known to
  associate with the complainant's circle."), confidence `0.9`;
* the pattern's own explanation states: *"that claim is NLP-derived, is listed separately,
  and does not raise the channel count or the score"*, and the factor detail carries
  `independent_nlp_channels_excluded_from_score: ["ASSOCIATION"]`.

**No double counting.** Pattern ids are content-addressed, so two detectors that reach the
same conclusion from the same records produce one pattern, not two (measured:
`duplicate_pattern_ids_collapsed = 0`). Within a pattern, evidence is de-duplicated on
`(evidence_class, evidence_id)`. Multi-channel counts *channels*, not records, so twenty
calls between two people remain one channel. Across the score, a pattern id may appear in
at most one factor — a test asserts the factor→pattern mapping is a partition.

## 3. Self-reference exclusion (§6)

A record whose two endpoints are the same person cannot evidence a relationship. Such
records are excluded from **all** Phase 4 detection and scoring: pattern detection, the
communication baseline, transaction shapes, location shapes, bridge structure, and every
score factor.

This corpus contains three: `calls:397`, `calls:656`, `firs:162` (and zero self-transfers).
Measured live: the 502 patterns cite 1,973 distinct records, **none** of them these three;
the three persons involved (146, 325, 443) score 35 / 39 / 25 with **no** self-reference in
their score evidence or in any factor's `evidence_ids`. The records remain fully available
as Phase 1 evidence — `/api/v1/calls/397`, `/api/v1/calls/656` and `/api/v1/firs/162` all
still return them.

Counts are surfaced honestly rather than hidden: `detection_coverage.transaction_patterns.
self_transfers_excluded = 0` and `detection_coverage.location_patterns.
self_fir_references_excluded = 1`.

## 4. Ground-truth overlay is quarantined

The generator's `ring_id` column produces `SAME_RING` edges (1,980 of them). That is the
dataset's **answer key**. Phase 2 already flags it `is_overlay=True` and excludes it from
analytics projections; Phase 4 excludes it from every detector, every feature and every
score. It is not a channel, not a relationship type, and not a scoring input. Using it
would measure the generator, not the method.

## 5. Deterministic pattern IDs (§9)

```python
payload = f"{pattern_type}|{','.join(sorted(set(entity_ids)))}|{','.join(sorted(set(evidence_ids)))}"
pattern_id = f"{pattern_type.lower()}~{sha256(payload).hexdigest()[:16]}"
```

The id is a function of content only: type, **sorted** entity ids, **sorted** evidence ids.
No array index, no insertion order, no random UUID, no timestamp, no `id()`, no
process-dependent value. Consequences, all covered by tests: the id is invariant under
argument order and duplicate arguments, and changes if the type, the entity set or the
evidence set changes.

Verified over live HTTP across a **full process restart**: all 502 ids, in listing order,
digest to `e7581ca2cf70ecac224937540a6948f3` before and after; the top-100 score list
digests to `1bdd8cd6cea254ff3b02911bd83ab3d4` before and after.

## 6. Pattern definitions

Nine pattern types, six scoring features. Severity is a deterministic 0–1 strength used by
scoring — not a probability and not a likelihood of wrongdoing.

### 6.1 Multi-channel relationship (§1) — 47 detected

An entity pair connected through **≥ 2 independent observed channels**, where a channel is
a *kind* of contact recorded in its own dataset:

| channel | structured edge | dataset |
|---|---|---|
| `CALL` | `CALLED` | `calls` |
| `TRANSACTION` | `TRANSACTED` | `transactions` |
| `FIR` | `REPORTED_AGAINST` | `firs` |
| `CO_LOCATION` | `CO_LOCATED` | `locations` / `persons` |

Counting is over channels, not records, because two people with one call and one transfer
are harder to explain as coincidence than two people with forty calls. Severity =
`(channels − 1) / 3`. Threshold `intel_multi_channel_min_channels = 2`.

Measured distribution — all 47 pairs have exactly 2 channels; none has 3 or 4:

| channels | pairs |
|---|---|
| CALL + CO_LOCATION | 16 |
| CALL + TRANSACTION | 14 |
| CO_LOCATION + TRANSACTION | 8 |
| FIR + TRANSACTION | 5 |
| CALL + FIR | 3 |
| CO_LOCATION + FIR | 1 |

Example: `multi_channel_relationship~10992c2986064eab` — `person:129` / `person:350`, CALL
(`calls:340`) + TRANSACTION (`transactions:1479`), severity 0.3333.

### 6.2 Communication anomaly (§2) — 150 detected, 1 materially significant

**Method.** Calls are aggregated **per person per calendar day** from `start_time`, counting
a person as a participant whether they called or were called. A person's baseline is their
**own** observed daily volume — mean and population stdev over the days on which they
appear. Then:

```
z = (peak_day_count − mean) / stdev
flag high activity  iff  z > 2.0        (intel_anomaly_z_threshold)
```

Rules that are deliberately strict:

* **Only unusually HIGH activity is flagged.** Low activity is never suspicious — silence
  is not evidence.
* **No invented baseline.** Fewer than `intel_anomaly_min_observations = 5` observed days →
  status `insufficient_baseline_data`, `z_score: null`, `mean: null`, no supporting call
  ids, and **no contribution to the score**. Zero stdev (every observed day identical) →
  `insufficient_baseline_variance`; z is undefined and nothing is flagged.
* The comparison is strictly `z > 2`, not `≥`.

**Measured, and this is the honest limitation of the method on this corpus:**

| status | persons |
|---|---|
| `high_activity_anomaly` | 150 |
| `insufficient_baseline_variance` | 159 |
| `no_anomaly` | 126 |
| `insufficient_baseline_data` | 65 |

2,000 calls spread over 500 persons and a 31-day window (2026-07-26 → 2026-08-25) gives
each person 1–16 observed days and a mean near 1 call/day. A peak of 2 calls against a mean
of 1.1 with stdev 0.32 yields z = 2.85 — **statistically** above threshold, **practically**
one extra call. The generator produced no communication bursts, so a z-test on this corpus
mostly measures its own sensitivity.

Rather than quietly redefining the flag rule, the engine keeps `z > 2` exactly as specified
**and separates statistical significance from practical significance**:

* every anomaly reports `excess_over_baseline` and a boolean `materially_significant`
  (`excess ≥ intel_anomaly_material_excess = 2.0` calls);
* the **score contribution** scales on the absolute excess, not on z, so a z = 2.85 blip of
  +0.9 calls contributes proportionally little while a genuine burst contributes fully;
* the explanation says so in plain words: *"The absolute excess is 0.9 calls, which is small
  in absolute terms against the configured materiality of 2."*

**Exactly 1 of the 150 flags is materially significant** — `person:141`, peak 4 calls
against a baseline of 1.375 (z = 2.47, excess 2.63). That number is reported as it was
measured; it is not a bug to be tuned away.

Example: `communication_anomaly~0034931393cd2190` — `person:75`, 2 calls on 2026-08-18
(`calls:917`, `calls:1622`) against a baseline of 1.1 ± 0.3162 over 10 observed days,
z = 2.846.

### 6.3 Transaction patterns (§3) — 226 detected

All four are **structural shapes in the transaction records**. Every detection is labelled
*"Potential transaction pattern requiring review"* and lists the exact `transactions:{id}`
evidence. None cites NLP evidence — these are record-level shapes only. Self-transfers are
excluded (0 in this corpus).

| shape | rule | threshold | detected |
|---|---|---|---|
| **Cycle** | value returns to its origin along a directed closed walk `A→B→…→A` | length 2–4 (`intel_txn_cycle_max_length = 4`) | **29** |
| **Fan-in** | one receiver, ≥ N distinct senders | `intel_txn_fan_in_min = 5` | **91** |
| **Fan-out** | one sender, ≥ N distinct receivers | `intel_txn_fan_out_min = 5` | **102** |
| **Concentration** | ≥ X% of a person's total value sits on one counterparty | `intel_txn_concentration_min_share = 0.6`, `min_txns = 4` | **4** |

Measured detail: cycle lengths 2 (×2 — reciprocal pairs), 3 (×6), 4 (×21); fan-in 5–10
counterparties; fan-out 5–9; concentration shares 0.633, 0.651, 0.698, 0.701. Cycles are
enumerated over canonical, sorted node order so the same circuit yields one pattern with a
stable rotation, not one per starting point.

Example cycle: `transaction_cycle~058d12c49b074df4` —
`person:3 → person:245 → person:21 → person:140 → person:3`, ₹873,738.57 across
`transactions:389`, `transactions:431`, `transactions:822`, `transactions:1109`.

Each explanation includes the counter-argument: *"A circuit is a shape, not a finding"*;
*"Many counterparties is a shape common to legitimate activity as well"*; and every one ends
with *"no claim of laundering, fraud or confirmed criminal activity is made or implied."*

### 6.4 Location patterns (§4) — 28 detected

Built **only** from the canonical `location_id` already present on `persons` and `firs`
rows. Raw latitude/longitude are never clustered and never appear in an explanation — the
Phase 1 data-quality findings recorded them as unreliable, so no geographic inference is
invented from them.

* **Location cohort** (23) — `intel_location_min_group = 5` to `intel_location_max_group = 30`
  persons registered at one canonical location. Sizes measured: 5 (×12), 6 (×9), 7, 8.
  Severity scales with cohort size; a cohort is a shared address and nothing more.
* **Shared location pair** (5) — two persons at the same canonical location **and** at least
  one FIR recorded at that same location naming one of them, i.e. corroboration from a
  second dataset. FIRs whose complainant and accused are the same person cannot corroborate
  a pair and are excluded (1 excluded here).

Self-references are excluded and a pair never contains a person twice. Every explanation
states *"Co-location is not contact"* and *"not a proximity guess from raw coordinates"*.

Example: `shared_location_pair~36e2a1f737e03171` — `person:218` / `person:350` at
`location:61` (Bhopal, Madhya Pradesh), corroborated by `firs:3`.

### 6.5 Bridge / network structure (§5) — 51 detected

Reuses the **Phase 2** analytics unchanged: betweenness centrality on the undirected person
projection (overlay and self-loops already excluded there) plus Louvain community structure
(seed 42).

A person is a **bridge entity** when betweenness sits at or above the
`intel_bridge_percentile = 90.0`th percentile **and** their relationships reach ≥ 2 distinct
communities. Measured: 51 bridges, each reaching 6–10 communities.

The vocabulary is structural by construction: `label: "bridge_entity"`,
`is_investigation_lead: true`, "network importance". Centrality is never interpreted as
guilt; the explanation says *"High network importance marks an investigation lead"* and
nothing stronger.

Example: `bridge_entity~026f8aaf3c7c9b0e` — `person:293`, betweenness 0.004849 at the 90th
percentile, reaching 8 communities across 17 community-crossing relationships, evidenced by
18 records across `calls`, `transactions`, `firs`, `persons`.

## 7. Investigation Priority Score

### 7.1 Bands — fixed

| band | range |
|---|---|
| `LOW` | 0–39 |
| `MEDIUM` | 40–69 |
| `HIGH` | 70–100 |

`intel_band_low_max = 39`, `intel_band_medium_max = 69`. These boundaries were **not**
adjusted to produce a nicer demo, and the fact that this corpus yields **zero HIGH** is
reported as a result, not corrected (§8.3).

### 7.2 Weights — configuration-driven, sum enforced

| feature | max contribution | setting |
|---|---|---|
| Network importance | 20 | `intel_weight_network_importance` |
| Multi-channel relationship | 20 | `intel_weight_multi_channel` |
| Transaction patterns | 20 | `intel_weight_transaction` |
| Communication anomaly | 15 | `intel_weight_communication` |
| Location patterns | 15 | `intel_weight_location` |
| Bridge / network structure | 10 | `intel_weight_bridge` |
| **total** | **100** | |

The service refuses to build if the weights do not sum to 100
(`ValueError: Phase 4 feature weights must sum to 100 …`) — a test drives this by copying
the settings with a bad weight.

### 7.3 Arithmetic

Each feature produces a normalised `value` in 0–1, kept **separately** from its
`contribution`:

```
contribution = round(value, 4) * max_contribution          (rounded to 2dp)
score        = clamp(floor(sum(contributions) + 0.5), 0, 100)
band         = LOW if score <= 39 else MEDIUM if score <= 69 else HIGH
```

Feature values, all deterministic:

| feature | value |
|---|---|
| Network importance | mean of the person's degree and PageRank percentiles ÷ 200 |
| Multi-channel | `(best_channel_count − 1) / 3 + 0.25 × (partners − 1)`, capped at 1 |
| Transaction | severity of the strongest shape + 0.15 per additional distinct shape, capped at 1 |
| Communication | anomaly severity (scaled on absolute excess, see §6.2) |
| Location | strongest cohort severity + `min(0.5, 0.25 × corroborated_pairs)`, capped at 1 |
| Bridge | bridge pattern severity |

A feature may contribute less than its maximum, and a feature with no evidence contributes
exactly 0 — with an explanation saying why, not silence.

### 7.4 Worked example — `person:141`, the top-ranked person

`GET /api/v1/intelligence/persons/141/explain`:

| feature | value | × max | = contribution |
|---|---|---|---|
| network_importance | 0.889 | 20.0 | 17.78 |
| transaction_patterns | 1.0 | 20.0 | 20.00 |
| communication_anomaly | 1.0 | 15.0 | 15.00 |
| bridge_network_structure | 0.89 | 10.0 | 8.90 |
| location_patterns | 0.4 | 15.0 | 6.00 |
| multi_channel_relationship | 0.0 | 20.0 | 0.00 |
| | | **sum** | **67.68** |

`floor(67.68 + 0.5) = 68` → band **MEDIUM**. Backed by 11 patterns, 56 structured evidence
items and 0 NLP-derived items, listed separately. This person is also the corpus's single
materially significant communication anomaly.

Note that `person:141` reaches 68 while contributing **nothing** from multi-channel — which
is exactly why the HIGH band is empty here (§8.3).

## 8. API

### 8.1 The six Phase 4 routes

| method | path | returns |
|---|---|---|
| GET | `/api/v1/intelligence/summary` | counts, band distribution, weights, coverage, policies |
| GET | `/api/v1/intelligence/persons/top` | priority ranking (`limit`, `band`, `min_score`) |
| GET | `/api/v1/intelligence/persons/{person_id}` | score + factors + patterns + baseline + Phase 2 position |
| GET | `/api/v1/intelligence/persons/{person_id}/explain` | factor-by-factor arithmetic walkthrough |
| GET | `/api/v1/intelligence/patterns` | pattern list (`pattern_type`, `entity_id`, `limit`, `offset`) |
| GET | `/api/v1/intelligence/patterns/{pattern_id}` | one pattern by its deterministic id |

Errors follow the house envelope `{"error": {"code", "detail"}}`: 404 `not_found` (unknown
person or pattern id), 400 `bad_request` (oversized `limit`, unknown `band`, unknown
`pattern_type` — each returning the allowed values), 422 `validation_error` (`person_id < 1`,
`min_score > 100`). All verified live.

### 8.2 `/analytics/persons/top` and `/intelligence/persons/top` are different questions (§11)

They are **not** merged and not interchangeable:

* `/api/v1/analytics/persons/top` (Phase 2) ranks **graph centrality** — "who is
  structurally central?" Live top-5: `person:445`, `188`, `422`, `391`, `355`.
* `/api/v1/intelligence/persons/top` (Phase 4) ranks the **priority score** — "whose
  records should be reviewed first?" Live top-5: `person:141` (68), `212` (64), `242` (64),
  `350` (64), `62` (62).

The two top-5 sets **share no person**. The Phase 4 response carries a `note` naming the
Phase 2 path and stating that the two rank different things.

### 8.3 Zero-result honesty (§10)

`summary.zero_result_categories` lists every pattern type with 0 detections, with the reason.
On this corpus that list is **empty** — all nine categories have real detections. Thresholds
were never lowered to reach a detection, and no example was manufactured. Where a category
*is* empty, `/patterns?pattern_type=X` answers `200` with `total: 0` and an empty list, not
an error.

The one genuinely empty result on this corpus is the **HIGH band: 0 persons.** The maximum
observed score is 68. Reaching 70 requires a person to score on nearly all six features at
once, and on this corpus the multi-channel pairs and the bridge entities barely overlap —
the top-ranked person contributes 0.0 from multi-channel. Per §8 the bands and weights are
fixed inputs, so this is reported, not tuned away.

## 9. Measured results (2026-08-27, committed corpus)

**Patterns: 502**, 0 duplicate ids collapsed, covering 499 distinct entities and citing
1,973 distinct source records.

| pattern type | count |
|---|---|
| COMMUNICATION_ANOMALY | 150 |
| TRANSACTION_FAN_OUT | 102 |
| TRANSACTION_FAN_IN | 91 |
| BRIDGE_ENTITY | 51 |
| MULTI_CHANNEL_RELATIONSHIP | 47 |
| TRANSACTION_CYCLE | 29 |
| LOCATION_COHORT | 23 |
| SHARED_LOCATION_PAIR | 5 |
| TRANSACTION_CONCENTRATION | 4 |

**Scores: 500 persons**, min 0, max 68, mean 29.91. Bands: **LOW 399, MEDIUM 101, HIGH 0**.
Exactly one person scores 0.

| feature | persons with a non-zero contribution | max contribution observed |
|---|---|---|
| network_importance | 500 | 20.00 |
| transaction_patterns | 450 | 20.00 |
| communication_anomaly | 150 | 15.00 |
| location_patterns | 136 | 12.00 |
| multi_channel_relationship | 84 | 11.67 |
| bridge_network_structure | 51 | 10.00 |

Top 10: 141 (68), 212 (64), 242 (64), 350 (64), 62 (62), 13 (59), 445 (58), 34 (57),
96 (57), 316 (57).

Phase 2 graph before and after Phase 4: **3,803 nodes / 10,802 edges** (8,822 observed,
1,980 overlay, 3 self-loops) — unchanged.

## 10. Limitations — read before demoing

1. **Synthetic corpus.** Every finding describes generated data. Nothing here says anything
   about any real person.
2. **The score is triage, not truth.** It ranks *records worth reading*. It is not a
   probability of anything, and the band names are workload labels.
3. **The communication z-test is at its sensitivity floor here** (§6.2). 150 statistical
   flags, 1 materially significant. On richer call data the same rule would be meaningful;
   on this corpus it mostly reports thin baselines. Read `materially_significant`, not the
   flag count.
4. **65 persons have no usable baseline at all** (< 5 observed days) and are honestly
   reported as `insufficient_baseline_data` rather than assigned a fabricated normal.
5. **159 persons have zero variance** in daily volume, so z is undefined for them. Not
   flagged, and reported as such.
6. **Structural shapes are common in legitimate activity.** Fan-in of 5 and a 4-cycle occur
   naturally in 1,500 transactions among 500 people; 91 + 102 + 29 detections is a review
   queue, not a list of 222 suspicious findings.
7. **Co-location means shared registered address, not a meeting.** No cell-tower
   trajectories, no timestamps, no proximity inference from raw coordinates.
8. **Betweenness on 500 nodes is fragile.** Values are ~0.005; small edge changes reorder
   the ranking. Percentile, not absolute value, drives the feature.
9. **NLP-derived evidence is visible but never load-bearing.** One narrative channel exists
   in the whole corpus and it moves no score (§2).
10. **The HIGH band is empty** (§8.3), and the weights that make it empty are the specified
    weights.
11. **No temporal reasoning.** Patterns are static: no burst-then-silence, no sequencing
    between a call and a transfer, no ordering within a cycle.
12. **`SAME_RING` is never used** (§4). Detection quality is therefore *not* validated
    against the generator's answer key anywhere in Phase 4 — doing so would be scoring the
    method against the data it was told to ignore.

## 11. Configuration reference

All 23 knobs, `.env`-overridable via `pydantic-settings`, measured values as shipped:

```
intel_multi_channel_min_channels = 2
intel_anomaly_z_threshold        = 2.0     intel_anomaly_min_observations = 5
intel_anomaly_material_excess    = 2.0
intel_txn_cycle_max_length       = 4
intel_txn_fan_in_min             = 5       intel_txn_fan_out_min          = 5
intel_txn_concentration_min_share= 0.6     intel_txn_concentration_min_txns = 4
intel_location_min_group         = 5       intel_location_max_group       = 30
intel_bridge_percentile          = 90.0
intel_band_low_max               = 39      intel_band_medium_max          = 69
intel_weight_network_importance  = 20.0    intel_weight_multi_channel     = 20.0
intel_weight_transaction         = 20.0    intel_weight_communication     = 15.0
intel_weight_location            = 15.0    intel_weight_bridge            = 10.0
intel_default_top                = 20      intel_max_top                  = 100
intel_patterns_limit             = 50      intel_patterns_max_limit       = 200
```

## 12. Verification record

**Tests — 422 passed, 0 failed, 0 skipped** (`python -m pytest`, 13.08s):

| suite | tests |
|---|---|
| Phase 1 | 57 |
| Phase 2 | 78 |
| Phase 3 | 196 |
| **Phase 4** | **91** (53 engine + 38 HTTP) |

The 57 / 78 / 196 figures match those recorded for Phases 1–3, so **zero regressions**.
Phase 4 coverage spans all fourteen required areas: multi-channel patterns, communication
anomaly, transaction cycles, fan-in/fan-out, location patterns, bridge entities, priority
score arithmetic, band mapping (0 / 39 / 40 / 69 / 70 / 100 boundaries), deterministic
pattern ids, self-reference exclusion, evidence traceability, structured-vs-NLP separation,
zero-result handling, and invalid person / pattern ids. A neutral-language guard asserts
every explanation Phase 4 emits — for all 500 persons and all 502 patterns — makes no
accusatory claim, allowing loaded words only inside an explicit denial.

**Live HTTP (uvicorn, 127.0.0.1:8000):** all six endpoints `200`; one real example fetched
and round-tripped for **each of the nine** pattern types (`/patterns?pattern_type=X&limit=1`
then `/patterns/{id}`, byte-identical both ways); all nine error cases returning the
documented code and envelope; `/persons/141` and `/persons/141/explain` agreeing on score
and band with arithmetic that reproduces `sum = 67.68 → 68`.

**Determinism across restart:** the server was killed and restarted; 502/502 unique pattern
ids digest identically (`e7581ca2…`) and the top-100 scores digest identically
(`1bdd8cd6…`). An in-process test additionally rebuilds the repository, graph and engine
from scratch **with no narrative store** and asserts identical pattern counts, identical ids
and identical scores for all 500 persons — which doubles as proof that NLP evidence moves no
score.

**Self-references:** the corpus's three self-referencing records appear in 0 of 502 patterns
and in 0 score factors, while remaining retrievable through the Phase 1 API.

**Phase 2 unchanged:** `/api/v1/graph/summary` reports 3,803 nodes / 10,802 edges, identical
to the Phase 2/3 as-built figures; `structured_graph_mutated: false`.

**Dataset untouched.** `git status` reports no change anywhere under `dataset/`. SHA-256:

```
4f913757637991234b5b289925397f13cb95b25cc9881284d85a3179316253f7  persons.csv
8134ea808fbe558f380483c0ee085cb8a7a43ebdbea3b79b9d40bb0a26900000  calls.csv
e6415a26841b5d00b32e59950f739f51e717c69bd9ec59b8414ec3d4c710e990  transactions.csv
19b063400bbee2d909372a15653fe6ea602d30e3ddde1ac875c96c61b3df4a2c  locations.csv
b6c9c2bead87f0835bbbf033f4e948e054466d124118c15be5e848a35a48bc49  fir_text.csv
59a619e12166b69593fd6a66a8907cc261e0052df23673ee0a4f08cabfd99bbf  generate_synthetic.py
4682f223333673d2babfebc5f80c9b578db72e4f8c5327a5f6aa56b104c38521  README.md
```

**Dependencies added: none.** Phase 4 uses only the standard library plus the pandas /
NetworkX / numpy already present.

**Not started, by instruction:** blockchain / audit ledger, new frontend features, Phase 5.
