# Phase 3 — FIR Narrative NLP Intelligence (as built, 2026-08-26)

**Objective.** Add a clean, explainable NLP layer that analyzes FIR narrative text and
integrates *only validated* narrative intelligence into the existing graph.

```
FIR text → Preprocessing → Entity extraction → Normalization → Entity resolution
        → Relationship extraction → Validation → Evidence-backed graph integration
```

Everything in this phase is **deterministic and offline**. There is no model download,
no external API, no learned parameter, and no new third-party dependency. Run the same
dataset twice and you get byte-identical output.

Companion documents: [`architecture.md`](architecture.md) (§G is the original NLP plan,
§R is the as-built summary) and [`phase2_preflight.md`](phase2_preflight.md) (the graph
invariants Phase 3 must not break).

---

## 1. Module map

All NLP logic lives in `backend/app/nlp/`. API routers contain no business logic — they
translate service output into response schemas and nothing more.

| File | Lines | Responsibility |
|---|---:|---|
| `app/nlp/models.py` | 198 | Dataclasses + enums: `ExtractedEntity`, `EntityResolution`, `ResolvedEntity`, `NarrativeRelationship`, `GraphAddition`, `FirAnalysis`; the confidence constants |
| `app/nlp/normalizer.py` | 94 | Pure value normalization (phone, Aadhaar, date, money, name, location, whitespace) |
| `app/nlp/extractor.py` | 523 | Rule-based entity extraction, sentence segmentation, span/evidence assignment, overlap arbitration |
| `app/nlp/resolver.py` | 321 | Mention → graph-entity resolution across a 5-tier ladder |
| `app/nlp/relation_extractor.py` | 521 | Trigger-anchored relationship extraction |
| `app/nlp/validators.py` | 148 | Per-type value validation + the entity/relationship admission gates |
| `app/nlp/integration.py` | 363 | `NarrativeGraphIntegrator` — the disposition ladder and the separate narrative store |
| `app/nlp/service.py` | 685 | Orchestration, per-FIR cache, search, summary, evaluation, graph-impact |
| `app/nlp/__init__.py` | 44 | Public surface |
| `app/schemas/nlp.py` | 275 | Pydantic v2 response models (11) |
| `app/api/v1/endpoints/nlp.py` | 181 | The five HTTP handlers |

Configuration (all `CNA_`-prefixed env overrides, `app/config.py`):

| Setting | Default | Meaning |
|---|---:|---|
| `nlp_resolution_min_confidence` | 0.5 | below this a mention is left **unresolved**, with a reason |
| `nlp_relationship_min_confidence` | 0.5 | below this a relationship is refused at integration |
| `nlp_derivability_max_hops` | 2 | how far to look for existing structured connectivity before calling an edge "new" |
| `nlp_search_limit` / `nlp_search_max_limit` | 50 / 200 | default and clamp for `/nlp/search` pagination |

---

## 2. Preprocessing

Narratives are read from the FIR record's `narrative` field (`fir_text.csv`) with **one**
transformation: whitespace collapsing. No lowercasing, no punctuation stripping, no
re-encoding, no template rewriting. That collapse is a **no-op on all 300 records**
(measured: 0 narratives differ), and the exact string the offsets index is always returned
alongside them in every response, so a reviewer can always reproduce a span locally. This
is what makes every claim auditable.

Two derived structures are computed per narrative:

- **Sentence spans.** A regex boundary on `[.!?]` + whitespace, with a fixed-width
  negative-lookbehind guard for abbreviations (`Rs. No. Mr. Mrs. Ms. Dr. Smt. Shri.
  St. Sr. Jr. vs.`). Without the guard, `"transferred Rs. 5,000 to <name>"` splits
  mid-sentence, which truncates `evidence_text` and silently suppresses any relationship
  whose trigger and endpoints then land in different "sentences". *No narrative in this
  corpus contains such an abbreviation* (measured: 0 across all 300), so the guard
  changes nothing here — it exists so the rules stay correct on realistic text.
- **Evidence text.** Every entity and relationship carries the enclosing sentence(s)
  verbatim, so a reviewer never has to re-open the CSV to see the basis of a claim.

---

## 3. Entity extraction

### Supported types

`PERSON`, `PHONE`, `AADHAAR`, `LOCATION`, `DATE`, `MONEY`, `VEHICLE`, `ORGANIZATION`.

`MONEY`, `VEHICLE` and `ORGANIZATION` are implemented as first-class types but are
**only emitted when explicitly present in the text**. This corpus contains none, so the
extractor reports zero for all three. That zero is surfaced in the API
(`absent_entity_types`, `zero_occurrence_types`) rather than hidden.

### Every entity carries

`entity_type`, `raw_text`, `normalized_value`, `confidence`, `fir_id`,
`character_start`, `character_end`, `extraction_method`, `evidence_text` (+ `role` where
the template assigns one: `complainant` / `accused`).

### Extraction methods and their rules

| Method | Confidence | What it means | Rules |
|---|---:|---|---|
| `regex` | 1.0 | a strict structured format matched | `PHONE_RE` `(?<!\d)(?:\+?91[-\s]?\|0)?[6-9]\d{9}(?!\d)`; `AADHAAR_RE` 12 digits, optional 4-4-4 grouping; `DATE_RE` (ISO, `DD-MM-YYYY`, `D Month YYYY`, `Month D, YYYY`); `MONEY_RE` — a currency marker is **required** (`₹`, `Rs`, `Rs.`, `INR`, or a trailing `rupees`); `VEHICLE_RE` `[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{4}` |
| `known_record` | 1.0 | the matched text **equals a known structured record** — a gazetteer hit against `persons.name` or a `locations` "City, State" / city value | person-name scan, `(at\|in\|near) <City>, <State>`, bare known city |
| `anchored_pattern` | 0.6 | located only by a template anchor, with no corresponding structured record | `Suspect/Accused/Complainant/Victim <Name>`, `<Name> (Aadhar\|Phone …)`, `ORG_RE` (a legal/entity suffix must be literally present: `Pvt Ltd`, `Private Limited`, `Ltd`, `LLP`, `Bank`, `Enterprises`, `Traders`, `Corporation`, `Industries`, `Agency`, `Society`, `Association`, `Trust`, `Foundation`) |

Two deliberate omissions in the money rule: no bare number is ever money, and multiplier
words (`lakh`, `crore`) are **not** expanded — doing so would assert a magnitude the text
does not literally state.

The digit-run lookarounds matter: `(?<!\d)…(?!\d)` is what stops a 12-digit Aadhaar from
also yielding a 10-digit "phone" substring.

The 0.6 tier is the honest one: it says *"the template says this is a name, but no such
person exists in our records."* On this dataset it never fires for PERSON (all 600
mentions are known records), which is itself a finding — the narratives restate the
structured columns.

### Conservatism rules (each covered by a test)

- A capitalised phrase is **not** promoted to a person without either a gazetteer hit or
  a template anchor — `"The Investigating Officer visited later."` yields no PERSON.
- A role word with no name (`"the suspect fled"`) yields no PERSON.
- A 12-digit Aadhaar run is never sliced into a 10-digit "phone".
- A bare number is never money.
- Overlapping candidates are arbitrated by a fixed priority ladder
  (identifier 60 > strict format 50 > known `City, State` 45 > template anchor 40 >
  known bare city 35 > name scan 30 > organization 20), so output spans are always
  ascending and non-overlapping.
- Every candidate passes `validators.validate_entity` before it is emitted: the span
  must reproduce `raw_text` exactly, sit inside the narrative, be non-empty, carry
  `0 < confidence ≤ 1`, and hold a type-valid normalized value. Anything rejected is
  recorded in `extractor.dropped` and reported in `/nlp/summary`
  (`entities_dropped_by_validation`) — **0 for this corpus**.

### spaCy

`spacy_available()` exists and is reported by the API
(`capabilities.optional_spacy_model_available: false`). It is **not a dependency**, is
never imported, and the deterministic rules are the only code path. A test asserts
`"spacy" not in sys.modules` after a full corpus run.

---

## 4. Normalization

Normalization never overwrites `raw_text`; it writes a parallel `normalized_value`.

| Type | Rule | Example |
|---|---|---|
| PHONE | strip non-digits, drop `91`/`0` country/trunk prefix → 10 digits | `+91-98765-43210` → `9876543210` |
| AADHAAR | strip separators → 12 digits | `3161 4845 9341` → `316148459341` |
| DATE | parse to ISO `YYYY-MM-DD`; if unparseable, fall back to the trimmed raw string (never invent a date) | `8 June 2026` → `2026-06-08` |
| MONEY | strip currency markers and thousands separators, keep decimals | `Rs 1,234.50` → `1234.50` |
| PERSON | collapse whitespace, **preserve casing** (casing is evidence) | `"  Chavvi   Anne "` → `Chavvi Anne` |
| LOCATION | collapse whitespace, canonical `City, State` spacing | `" Jaipur ,   Rajasthan "` → `Jaipur, Rajasthan` |

---

## 5. Entity resolution

A mention resolves to an **existing Phase 2 graph node id** or it does not resolve. No
new identity is minted from text.

| Tier | Method | Confidence | Basis |
|---|---|---:|---|
| 1 | `structured_identifier` | 1.0 | normalized phone / Aadhaar equals a unique `persons` key → `phone:…` / `aadhaar:…` node |
| 2 | `normalized_name` | 1.0 | normalized name matches **exactly one** `persons.name` → `person:{id}` |
| 3 | `fir_context_location` | 0.9 | the narrative's `City, State` matches the FIR's **own** `locations` record → `location:{id}` (safe deterministic disambiguation using only that FIR's structured context) |
| 4 | *ambiguous* | — | more than one candidate → `status: ambiguous`, all candidates listed, **never silently merged** |
| 5 | *unresolved* | — | no candidate, or best candidate below `nlp_resolution_min_confidence` → `status: unresolved` + a `reason` string |

`DATE` mentions get `status: not_applicable` with the reason *"no DATE/EVENT node type is
materialised in the Phase 2 graph; the value is retained as relationship metadata"* —
an explicit non-answer rather than a forced match.

**Ambiguity policy.** Tier 4 lists every candidate with its evidence and stops. Nothing
downstream may consume an ambiguous mention as an endpoint: integration refuses the edge
with `rejected_unresolved`.

---

## 6. Relationship extraction

Allowed types: `MET`, `CALLED`, `LOCATED_AT`, `ASSOCIATED_WITH`, `REPORTED_AGAINST`,
`TRANSFERRED_TO` — modelled by `NarrativeEdgeType`, a **separate enum** from Phase 2's
`EdgeType`.

**The load-bearing rule: co-occurrence is never a relationship.** Every relationship
requires (a) an explicit trigger phrase, (b) both endpoints bound within the *same
sentence* as that trigger, and (c) endpoints that are role-bound or gazetteer-matched.
Three tests state the negative directly:

- `"Chavvi Anne and Gunbir Sankar are both residents of Jaipur, Rajasthan."` → nothing
- `"Chavvi Anne called the police. Gunbir Sankar fled the area."` → nothing (no cross-sentence binding)
- a trigger whose two sides resolve to the same party → nothing

| Rule | Type | Trigger vocabulary | Confidence |
|---|---|---|---:|
| `complainant_reported_suspect` | REPORTED_AGAINST | both role markers present (a reporting verb — `reported/lodged/filed/complained` — near the complainant name, plus a `Suspect`/`Accused` marker) | 1.0 |
| `call_trigger` | CALLED | `called`, `phoned`, `rang`, `contacted`, `spoke to/with`, `dialled`/`dialed` | 1.0 |
| `meeting_trigger` | MET | `met`, `met with`, `meeting with`, `was seen with`, `seen together with` | 1.0 |
| `transfer_trigger` | TRANSFERRED_TO | `transferred`, `remitted`, `wired`, `paid`, `sent money`, `handed over` — **and** a MONEY entity in the same sentence | 1.0 |
| `association_trigger` | ASSOCIATED_WITH | `associates with`, `is associated with`, `in league with`, `linked to` (1.0); hedged by `known to`, `reportedly`, `allegedly`, `suspected to`, `believed to` → 0.9 with `hedged: true` | 1.0 / 0.9 |
| `sighting_placement` | LOCATED_AT | `was/were seen`, `was/were present`, `spotted` + a proximity word; `at` → 1.0, `near`/`around`/`outside` → 0.7 (recorded as `proximity`) | 1.0 / 0.7 |

`MET` and `ASSOCIATED_WITH` are flagged `directed: false`; the rest are directed.

Anaphora is resolved **only** against role markers within the same FIR (`"The accused"`,
`"the complainant's circle"`, `"the scene"`), and the approximation is always recorded in
attributes — e.g. `target_bound_via: "role_anaphora"`, `target_scope: "circle"`. The
reader can see exactly how loose the binding was.

Every relationship carries provenance `source_dataset="fir_text"`,
`source_record_id="firs:{fir_id}"`, the trigger text, the character span, the evidence
sentence, and both endpoint mentions. `validators.validate_relationship` enforces all of
that before emission (dropped count for this corpus: **0**).

Extraction deliberately **reports what the text says**, even when the assertion is
degenerate: FIR 162 names one person as both complainant and suspect, so a
`REPORTED_AGAINST person:325 → person:325` relationship *is* extracted. Refusing it is
integration's job, not extraction's — that separation keeps the audit trail complete.

---

## 7. Confidence semantics

> These are **deterministic rule-assigned tiers, not learned probabilities.** They
> express *which rule fired*, not a calibrated likelihood. Nothing in this system was
> trained, and no accuracy figure here transfers to real-world text.

| Stage | Tier | Value |
|---|---|---:|
| Extraction | strict regex format | 1.0 |
| | known structured record | 1.0 |
| | template anchor only | 0.6 |
| Resolution | structured identifier | 1.0 |
| | unique normalized match | 1.0 |
| | FIR-context disambiguation | 0.9 |
| Relationship | explicit trigger | 1.0 |
| | hedged or anaphoric | 0.9 |
| | soft placement (`near`) | 0.7 |

The same table is served at `GET /api/v1/nlp/summary` → `confidence_semantics`, so a
consumer of the API never has to guess what a number means.

---

## 8. Graph integration

### Separation

Narrative edges are written to a **separate `NetworkXGraphStore`** owned by
`NarrativeGraphIntegrator`. The Phase 2 structured store (`app.state.graph.store`) is
**read** for duplicate/derivability checks and **never written**. Node attributes copied
into the narrative store are copied dict-by-dict, because `Node` is frozen but its
attribute dict is not.

Structured-vs-narrative provenance is always distinguishable: narrative edges carry
`is_narrative: true`, `source_dataset: "fir_text"`, evidence ids of the form `firs:{id}`,
a `NarrativeEdgeType` relationship type, and ids prefixed `narr~`. A test asserts the
structured store holds **no** edge with `is_narrative` or `source_dataset == "fir_text"`.

Narrative edge `weight` is fixed at 1.0 and carries
`weight_detail.note: "not an analytic coefficient"` — it must not be fed to centrality.

### Disposition ladder (every proposal gets exactly one, with a reason)

| Status | When |
|---|---|
| `accepted_new` | edge materialised **and** the endpoints had no structured path within `nlp_derivability_max_hops` — genuinely new connectivity |
| `accepted_additive` | edge materialised, but the endpoints were already connected structurally; the narrative adds a type + text evidence, **not** new connectivity |
| `accepted_merged` | the edge already existed and this FIR contributed **new provenance** (evidence list, contributing FIRs, date range extended; confidence = **max**, never averaged, recorded as `confidence_basis`) |
| `rejected_duplicate` | an equivalent structured edge exists (same type, same direction), or the identical narrative edge exists with nothing new to add |
| `rejected_self_loop` | both endpoints resolve to the same entity |
| `rejected_unresolved` | an endpoint is unresolved/ambiguous, or resolves to a node that is not materialised in the graph |
| `rejected_low_confidence` | relationship confidence < `nlp_relationship_min_confidence` |

Direction matters for duplicate detection: a narrative `B → A` is **not** a duplicate of
a structured `A → B`, because it asserts something different.

### Ground truth is excluded

`SAME_RING` (the synthetic ground-truth ring overlay) is **never consulted**:
`STRUCTURED_EQUIVALENT` maps no narrative type to it, and every duplicate/derivability
query passes `include_overlay=False`. Two tests pin this — one proves `person:24` and
`person:26` are connected *only* by the overlay, the next proves a narrative
`ASSOCIATED_WITH` between them is still labelled `accepted_new`. If ground truth leaked
in, that edge would have been mislabelled as already-known.

---

## 9. API surface

All five endpoints are live under `/api/v1/nlp` (verified over HTTP, §11).

| Endpoint | Returns |
|---|---|
| `GET /nlp/summary` | corpus-level counts by type / method / confidence, resolution breakdown, relationship counts, graph-addition dispositions, narrative-graph shape, capabilities, confidence semantics, and the full evaluation block |
| `GET /nlp/firs/{fir_id}/entities` | the narrative, `source_record_id`, per-entity spans + normalized values + resolution decisions, `counts_by_type`, `resolution_counts`, `absent_entity_types` |
| `GET /nlp/firs/{fir_id}/relationships` | validated relationships with endpoints, mentions, trigger, evidence sentence, span, confidence, provenance, plus a `note` restating the co-occurrence rule |
| `GET /nlp/firs/{fir_id}/graph-impact` | the whole audit trail for one FIR: extracted / resolved / unresolved / not-applicable entities, validated relationships, `proposed_additions` with dispositions and reasons, the accepted/rejected partition, the materialised narrative edges, and `structured_graph_mutated: false` |
| `GET /nlp/search?q=` | paginated entity mentions matching `raw_text`, `normalized_value`, or `matched_entity_id` (case-insensitive), with `counts_by_type` and `matched_fir_count` describing the **whole** match set, not just the page |

Contract details: unknown FIR → **404** with the shared error envelope
`{"error": {"code", "message", "detail"}}`; malformed input → **422** with the same
envelope; empty results are **useful, not blank** (they still carry the query, zeroed
aggregates, and pagination meta); `page_size` is clamped to `nlp_search_max_limit`;
output is deterministic (repeat requests are byte-identical).

---

## 10. Evaluation — methodology and measured results

### What can and cannot be measured

There is **no human-annotated ground truth** for these narratives. What exists is the
FIR's own structured columns, so entity extraction is scored as a per-FIR set comparison
of `(entity_type, normalized_value)` against: complainant Aadhaar, accused phone,
complainant/accused names, and the FIR location's `City, State`.

- **Excluded from scoring:** `DATE` (no structured column corresponds to the narrative
  date — validated by ISO format + span checks instead) and `MONEY`/`VEHICLE`/
  `ORGANIZATION` (zero occurrences; reported as an honest zero).
- **Relationships:** only `REPORTED_AGAINST` has a structured counterpart (the
  `(complainant_id, accused_id)` pair) and is scored as P/R/F1. For the others, only
  *endpoint agreement* with the FIR's own records is reported — never the truth of the
  assertion itself, which nothing in the dataset can adjudicate.

> **The caveat that governs every number below.** These FIR narratives are generated
> from three fixed templates and mostly restate structured columns. The figures measure
> how reliably deterministic rules recover known fields from a known template. They are
> **not** a measure of real-world NLP accuracy and must not be reported as one.

### Measured (300 FIRs, `GET /nlp/summary`)

**Entities — 1,800 total**

| Type | Count | Method | TP | FP | FN | P | R | F1 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| PERSON | 600 | known_record | 599 | 0 | 0 | 1.0 | 1.0 | 1.0 |
| PHONE | 300 | regex | 300 | 0 | 0 | 1.0 | 1.0 | 1.0 |
| AADHAAR | 300 | regex | 300 | 0 | 0 | 1.0 | 1.0 | 1.0 |
| LOCATION | 300 | known_record | 300 | 0 | 0 | 1.0 | 1.0 | 1.0 |
| DATE | 300 | regex | — excluded from scoring — |||||
| MONEY / VEHICLE / ORGANIZATION | 0 | — | — none present in corpus — |||||

Overall over the 1,500 scored mentions: TP 1,499 / FP 0 / FN 0 (1,499 distinct
`(type, value)` pairs — FIR 162 names the same person twice, so 600 PERSON *mentions*
collapse to 599 distinct pairs). Span mismatches: **0**. Entities dropped by validation:
**0**.

**Resolution — 1,500 resolvable mentions**

| Status | Count | | Method | Count |
|---|---:|---|---|---:|
| resolved | 1,500 | | `structured_identifier` | 600 |
| not_applicable (DATE) | 300 | | `normalized_name` | 600 |
| **unresolved** | **0** | | `fir_context_location` | 300 |
| **ambiguous** | **0** | | *(none — DATE)* | 300 |

Resolution correctness against structured truth: 1,500 / 1,500. **Why zero ambiguity is
not a claim of skill:** names, phones and Aadhaar numbers are all unique in this dataset
(0 duplicates), and every narrative city/state matches the FIR's own location record, so
no genuinely ambiguous mention *exists*. The ambiguity and threshold branches are
therefore exercised by unit tests with synthetic twin records instead.

**Relationships — 605 total**

| Type | Count | Endpoint agreement | Scored |
|---|---:|---|---|
| REPORTED_AGAINST | 300 | 300 agree / 0 disagree | P 1.0 / R 1.0 / F1 1.0 |
| LOCATED_AT | 300 | 300 agree / 0 disagree | no structured counterpart |
| ASSOCIATED_WITH | 5 | 5 agree / 0 disagree | no structured counterpart |
| MET / CALLED / TRANSFERRED_TO | 0 | — | implemented, never triggered by these templates |

Relationships from co-occurrence alone: **0**. Dropped by validation: **0**.

**Information gain — the honest bottom line**

| Measure | Value |
|---|---:|
| proposed relationships | 605 |
| restates an existing structured edge (`rejected_duplicate`) | 300 |
| new edge type but **no new connectivity** (`accepted_additive`) | 304 |
| **new connectivity (`accepted_new`)** | **0** |
| merged additional provenance | 0 |
| self-loop refused | 1 |
| narrative edges materialised | 304 |
| structured graph mutated | **false** |

Structured hop distance of the 304 accepted edges: 1 hop → 5, 2 hops → 299. In other
words: **this corpus's narratives discover no hidden link.** Half of what they assert is
a verbatim restatement of a structured column; the rest adds a relationship type between
entities that were already connected within two hops (person → FIR → location).

The one field the text genuinely contributes is the **narrative date**: 300/300 FIRs
carry one, and it differs from the structured filing date in **296** of them (matches in
only 4). It is carried as relationship metadata (`narrative_date`, and
`date_first`/`date_last` on materialised edges), not as a graph node.

This is exactly the result the spec asked to be reported rather than dressed up. The
machinery for genuine discovery is present and unit-tested (`accepted_new`,
`accepted_merged`, `MET`/`CALLED`/`TRANSFERRED_TO`, the 0.6 anchored-only tier, the
ambiguity ladder); this dataset simply does not contain the text to trigger it.

**Narrative graph:** 381 nodes (PERSON 226, LOCATION 155), 304 edges
(LOCATED_AT 299, ASSOCIATED_WITH 5), 299 contributing source records, all flagged
narrative.

---

## 11. Worked examples (live HTTP, port 8017)

### FIR 1 — the common template

> `FIR No 1: On 2026-06-08 Chavvi Anne (Aadhar 316148459341) reported a theft at Jaipur, Rajasthan. Suspect Gunbir Sankar (Phone +91-8298229437) was seen near the scene.`

`GET /api/v1/nlp/firs/1/entities` → 6 entities:

| Type | raw_text | normalized | span | conf | method | role | resolved to | conf |
|---|---|---|---|---:|---|---|---|---:|
| DATE | `2026-06-08` | `2026-06-08` | 13–23 | 1.0 | regex | — | *not_applicable* | — |
| PERSON | `Chavvi Anne` | `Chavvi Anne` | 24–35 | 1.0 | known_record | complainant | `person:489` | 1.0 |
| AADHAAR | `316148459341` | `316148459341` | 44–56 | 1.0 | regex | — | `aadhaar:316148459341` | 1.0 |
| LOCATION | `Jaipur, Rajasthan` | `Jaipur, Rajasthan` | 78–95 | 1.0 | known_record | — | `location:143` | 0.9 |
| PERSON | `Gunbir Sankar` | `Gunbir Sankar` | 105–118 | 1.0 | known_record | accused | `person:21` | 1.0 |
| PHONE | `+91-8298229437` | `8298229437` | 126–140 | 1.0 | regex | — | `phone:+91-8298229437` | 1.0 |

`GET /api/v1/nlp/firs/1/relationships` → 2:

- `REPORTED_AGAINST person:489 → person:21`, directed, conf 1.0, span 24–118, trigger
  `"Suspect"`, rule `complainant_reported_suspect`.
- `LOCATED_AT person:21 → location:143`, directed, conf **0.7**, span 105–165, trigger
  `"was seen near"`, `proximity: near`, `target_bound_via: role_anaphora` — "seen *near*
  the scene" is deliberately weaker than being placed *at* somewhere.

`GET /api/v1/nlp/firs/1/graph-impact` → 1 accepted, 1 rejected, `structured_graph_mutated: false`:

- REPORTED_AGAINST → `rejected_duplicate`, *"a structured REPORTED_AGAINST edge already
  connects these entities; the narrative only restates it, adding no new information"*,
  `duplicate_of: REPORTED_AGAINST~person:489~person:21`.
- LOCATED_AT → `accepted_additive`, *"…already connected structurally at 2 hop(s); the
  narrative adds a new relationship type and text evidence, not new connectivity"*,
  materialised as `narr~LOCATED_AT~person:21~location:143` with `evidence: ["firs:1"]`.

### FIR 12 — the hedged-association variant (5 of 300)

> `… Suspect Chaaya Chatterjee (Phone +91-7273846739) was seen near the scene. The accused is known to associate with the complainant's circle.`

3 relationships. The third is
`ASSOCIATED_WITH person:369 ↔ person:500`, **undirected**, conf **0.9**, trigger
`"known to associate with"`, `hedged: true`, `target_scope: "circle"`,
`source_bound_via`/`target_bound_via: role_anaphora`. The text names the complainant's
*circle*, not the complainant — the approximation is recorded, not smoothed over. It
integrates as `accepted_additive` at 1 structured hop.

### FIR 162 — the self-referential FIR

> `… Zaid Bahl (Aadhar 625347689741) reported a theft at Bhopal, Madhya Pradesh. Suspect Zaid Bahl (Phone +91-9100252248) …`

Both PERSON mentions resolve to `person:325`. Extraction reports the
`REPORTED_AGAINST person:325 → person:325` the text asserts; integration refuses it:
`rejected_self_loop`, *"both endpoints resolve to 'person:325'; this FIR names the same
person on both sides of the relationship"*, `detail: {"entity_id": "person:325"}`, no
edge created.

### Error and empty behaviour (verified)

| Request | Result |
|---|---|
| `/nlp/firs/9999/entities` (and `/relationships`, `/graph-impact`) | **404** `{"error": {"code": "not_found", "message": "FIR '9999' not found", "detail": {"resource": "FIR", "id": 9999}}}` |
| `/nlp/firs/0/entities`, `/nlp/firs/abc/entities` | **422** `validation_error` |
| `/nlp/search` (missing `q`), `page=0`, `page_size=0` | **422** `validation_error` |
| `/nlp/search?q=ZZZ-no-such-value` | **200**, `total: 0`, `matched_fir_count: 0`, query echoed, `searched_fields` listed |
| `/nlp/search?q=jaipur&page=2&page_size=5` | **200**, `total: 39`, `total_pages: 8`, `has_next/has_prev` true — aggregates describe the whole match set |
| `/nlp/search?q=8298229437` | **200**, 2 hits (FIR 1 and FIR 152), both `matched_field: raw_text`, each resolved to `phone:+91-8298229437` with evidence `persons:21` |

---

## 12. Tests

**196 Phase 3 tests** across five files (full suite: **331 passed**, = 57 Phase 1 +
78 Phase 2 + 196 Phase 3; the 57/78 figures match those recorded at the end of Phase 2,
so there are no regressions).

| File | Lines | Covers |
|---|---:|---|
| `tests/test_nlp_extraction.py` | 429 | per-type extraction, corpus-wide span integrity (all 300 narratives), confidence-per-method, conservatism negatives, MONEY/VEHICLE/ORG synthetic positives, abbreviation-split regression, normalizer, validators |
| `tests/test_nlp_resolver.py` | 378 | all five tiers, ambiguity with synthetic twin records, threshold behaviour, corpus resolution counts, not-applicable reasons |
| `tests/test_nlp_relations.py` | 322 | per-rule positives, the three co-occurrence negatives, undirected flags, corpus counts, provenance on every relationship, `validate_relationship` rejections |
| `tests/test_nlp_integration.py` | 366 | store separation, structured-store immutability, every disposition branch, provenance merge with reversed endpoints, SAME_RING exclusion, node-attribute copying |
| `tests/test_nlp_api.py` | 568 | response shapes, 404/422, pagination aggregates, evidence/provenance on every item, determinism, Phase 1/2 endpoints unchanged, no over-claiming language |

Two test-design notes worth keeping:

- `EntityExtractor.dropped` / `RelationExtractor.dropped` are mutable instance lists
  surfaced in `/nlp/summary`. Synthetic-input tests **must** build fresh components
  (`fresh_extractor`, `_relations()`, `fresh_integrator`) so test text never pollutes the
  service's reported metrics.
- `pyproject.toml` sets `addopts = "-ra -q"`. Passing `-q` again yields `-qq`, which
  suppresses the "N passed" line — run plain `pytest` to see counts.

---

## 13. Dataset integrity

The original synthetic dataset is read-only and was never written to. SHA-256 of every
file under `dataset/`, measured after the full Phase 3 run and the live HTTP session:

| File | Bytes | SHA-256 |
|---|---:|---|
| `persons.csv` | 45,623 | `4f913757637991234b5b289925397f13cb95b25cc9881284d85a3179316253f7` |
| `calls.csv` | 85,431 | `8134ea808fbe558f380483c0ee085cb8a7a43ebdbea3b79b9d40bb0a26900000` |
| `transactions.csv` | 98,030 | `e6415a26841b5d00b32e59950f739f51e717c69bd9ec59b8414ec3d4c710e990` |
| `locations.csv` | 8,749 | `19b063400bbee2d909372a15653fe6ea602d30e3ddde1ac875c96c61b3df4a2c` |
| `fir_text.csv` | 60,616 | `b6c9c2bead87f0835bbbf033f4e948e054466d124118c15be5e848a35a48bc49` |
| `generate_synthetic.py` | 9,766 | `59a619e12166b69593fd6a66a8907cc261e0052df23673ee0a4f08cabfd99bbf` |
| `README.md` | 46 | `4682f223333673d2babfebc5f80c9b578db72e4f8c5327a5f6aa56b104c38521` |

All seven mtimes remain `2026-08-25T23:20:05`, which predates all Phase 2 and Phase 3
work. Reproduce with:

```bash
cd backend && ./.venv/Scripts/python.exe -c "import hashlib,pathlib;[print(p.name, hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(pathlib.Path('../dataset').rglob('*')) if p.is_file()]"
```

---

## 14. Known limitations

1. **Template-bound rules.** The extraction rules are tuned to three fixed FIR
   templates. Free-form police prose would need either more rules or the optional
   statistical layer; recall on such text is **unknown and unmeasured**.
2. **No independent ground truth.** Every P/R/F1 figure is scored against the FIR's own
   structured columns, which the narrative largely restates. The numbers demonstrate
   rule reliability on a known template, not NLP quality.
3. **Zero new connectivity on this corpus.** No hidden link is discovered from text
   here. That is a property of the synthetic data, and it is reported rather than masked.
4. **Zero ambiguous and zero unresolved mentions**, because the dataset has no duplicate
   names/phones/Aadhaar numbers. Those branches are covered only by synthetic unit tests.
5. **MET / CALLED / TRANSFERRED_TO never fire** on this corpus. They are implemented and
   unit-tested, but their real-text behaviour is unvalidated.
6. **Anaphora is shallow.** Only role-marker references inside the same FIR are bound
   (`"The accused"`, `"the scene"`, `"the complainant's circle"`). No cross-sentence
   pronoun resolution, no coreference model. Each binding records how it was made.
7. **`ASSOCIATED_WITH` from "the complainant's circle"** binds to the complainant
   individually — an approximation flagged via `target_scope: "circle"`, not a claim
   that the two are directly associated.
8. **Narrative dates are not graph nodes.** No EVENT/DATE node type exists in Phase 2,
   so dates ride along as relationship metadata.
9. **Narrative edge weight is not analytic.** It is fixed at 1.0 with an explicit note;
   feeding narrative edges to centrality would be a category error.
10. **Search is substring matching**, not semantic. TF-IDF / embedding search from §G.3
    remains future work.
11. **Aadhaar/phone values appear in API responses** because they are the evidence.
    Log output is PII-redacted (Phase 1 filter), but response payloads are not — access
    control is a later phase.

---

## 15. Out of scope for Phase 3

No risk scoring, no blockchain/audit ledger, no frontend, no new dependencies, no
external API, no dataset modification, and no change to Phase 1 or Phase 2 behaviour.
Nothing in this layer labels any person or relationship as criminal; narrative
relationships are *assertions made by FIR text*, presented with their evidence.
