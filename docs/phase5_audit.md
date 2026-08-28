# Phase 5 — Evidence Integrity & Tamper-Evident Audit Ledger

**Status:** shipped, 2026-08-28. Backend `app/audit/`, one API group, one compact frontend
read-out. Phases 1–4.6 unchanged.

> **What this is.** A local, append-only, hash-chained audit ledger over the investigation
> decisions this system makes, plus content commitments that let a document be re-checked
> later. It detects modification of what was recorded.
>
> **What this is not.** Not a blockchain. There is no network, no consensus, no peers, no
> mining, no wallet, no smart contract, no Hyperledger, no Fabric, nothing installed and
> nothing deployed. The correct name for it is **Tamper-Evident Audit Ledger**, and that is
> the name used in the API (`"backend": "local_hash_chain"`), the UI and these docs.

---

## 1. Why the ledger exists

Every earlier phase answers questions about data. Phase 4.6 added the ability to *change* the
data: a submitted call can create a relationship, a submitted FIR can create a pattern, and a
recomputation can move a person from one priority band to another. Once the graph can change,
"what did the system decide, and when?" becomes a question the system has to be able to answer
about itself — and an answer that can be edited afterwards is not an answer.

So Phase 5 records the decisions, chains them so that changing one breaks every later link, and
commits to evidence content by hash so that a document can be re-checked without the ledger
ever holding the document.

The privacy consequence is the design constraint: **the ledger stores identifiers, enum values,
counts and hashes. Never raw FIR text, phone numbers, Aadhaar numbers, amounts or free-text
provenance.**

---

## 2. Architecture

```
app/audit/
  models.py    AuditEvent, IntegrityRecord, the action/resource vocabularies,
               canonical hashing, GENESIS_PREVIOUS_HASH, assert_safe_metadata
  ledger.py    AuditLedger (abstract)  ->  LocalHashChainLedger (the only impl)
               PermissionedBlockchainLedger (declared, deliberately unimplemented)
  service.py   AuditService: what deserves an event, what a failure looks like,
               the integrity index, build_audit_service()
app/api/v1/endpoints/audit.py   five routes (six OpenAPI paths)
app/schemas/audit.py            response models
```

Wiring, in `app/main.py`:

```
dataset -> graph -> nlp -> intelligence -> AUDIT -> ingestion
```

The ledger is built **before** ingestion and handed to the pipeline, because a pipeline that
started without one would silently produce unaudited decisions. Like every phase before it,
Phase 5 is additive and non-fatal: if the build fails, or `CNA_AUDIT_ENABLED=false`, the
`/audit` routes return 503 and **ingestion keeps working — loudly unaudited rather than
unavailable.**

`AuditService` never imports the ingestion pipeline; the pipeline calls the service. The
dependency points one way, so the audit layer can be removed without touching Phase 4.6 logic
and Phase 4.6 cannot come to depend on audit internals.

---

## 3. Canonical serialization (§2) — one rule, stated once

The hash input comes from **`app.ingest.models.canonical_payload`** — the same function that
already defines a Phase 4.6 `record_id`. Phase 5 does not introduce a second serializer,
because two serializers is how a chain ends up verifying against itself and nothing else.

```python
canonical_payload(value) = json.dumps(
    prune(value),                    # recursively drop None / empty-after-prune
    sort_keys=True,                  # key order cannot change the hash
    separators=(",", ":"),           # no whitespace can drift in
    ensure_ascii=False,              # bytes are the UTF-8 of the real characters
)
```

Worked example — the same content in a different key order, and with an explicit null, hashes
identically:

```python
canonical_payload({"b": 2, "a": 1, "nested": {"y": True, "z": None}})
== '{"a":1,"b":2,"nested":{"y":true}}'
```

`content_hash(content) = SHA-256(canonical_payload(content))`, hex digest, lower case.

---

## 4. Genesis (§3) — a fixed, published constant

```python
GENESIS_PREVIOUS_HASH = hashlib.sha256(b"").hexdigest()
= "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

The first event's `previous_hash` is exactly that value. It is **not** a random value, not a
timestamp, not a UUID and not an arbitrary zero-filled string: anyone can reproduce it with one
line of the standard library, and `GET /api/v1/audit/verify` publishes it in every response so
a verifier never has to trust the server for it. An empty ledger's `head_hash` is this same
constant.

---

## 5. The chain (§2)

```
current_hash = SHA-256( canonical_payload(audit_content) + previous_hash )
```

Concatenation of the canonical JSON string and the 64 hex characters of the link being
extended. Both halves are fixed-format, so the boundary is unambiguous.

`audit_content` is every field of the event **except `current_hash`** (which is the output):

| field | in the hash | notes |
| --- | --- | --- |
| `audit_event_id` | yes | `ae-000001`, chain position, deterministic — never a random UUID |
| `timestamp` | yes | see below |
| `actor` | yes | `system`, or `demo_investigator` for an explicitly triggered flow |
| `action` | yes | closed enum |
| `resource_type` | yes | closed enum |
| `resource_id` | yes | e.g. `person:21`, `CALLED~person:141~person:21`, a `record_id` |
| `metadata` | yes | small, non-sensitive |
| `metadata_hash` | yes | commits to detail kept out of the ledger |
| `previous_hash` | yes, via the concatenation | the link |
| `current_hash` | **no** | it is the result |

**Timestamp inside the hash — a deliberate strengthening.** §2 says to exclude
non-deterministic fields. A *recorded* timestamp is data, not randomness injected at hash time:
it is written once, then re-hashed from storage on every verification, so verification stays
exactly reproducible — and covering it means the recorded time of an event cannot be altered
without breaking the chain. Ordering is defined by chain position, never by the timestamp
string.

**Append-only in the strict sense.** `LocalHashChainLedger` exposes `append`, `all_events`,
`get`, `head`, `length`, `verify`, `load` — and no `update`, `delete`, `remove`, `truncate`,
`clear` or `replace`. There is no route with a `PUT`, `PATCH` or `DELETE` verb anywhere under
`/api/v1/audit`. Both facts are asserted by tests, because "we don't call it" is weaker than
"it does not exist".

---

## 6. Single-writer concurrency (§4)

One `threading.Lock` inside `LocalHashChainLedger`. Under it, and only under it, the ledger:
reads the current head, assigns the next sequence number, computes `current_hash`, appends the
event to the list, and (when persistence is on) writes its JSONL line. A concurrent appender
therefore cannot read a stale head, so two events can never claim the same predecessor and the
chain cannot fork.

This is the simplest mechanism that is actually correct here — the app is a single process, and
the write path it guards is the same one Phase 4.6 already serializes with its own ingestion
lock.

Two properties worth stating plainly:

* **Validation happens before the lock.** `assert_safe_metadata` runs first, so a rejected
  event never enters the chain and cannot leave a gap in the sequence.
* **Ingestion audits inside the ingestion lock**, not off the SSE bus. The live event stream is
  lossy by design (a disconnected client misses frames); an audit trail must not be.

Measured: 32 threads × 4 appends each, released together from a `threading.Barrier`, produce
**128 events, dense ids `ae-000001…ae-000128`, 128 distinct resources, one valid chain,
`VERIFIED`, `events_checked: 128`.**

---

## 7. What is audited — and what is deliberately not (§5, §11)

| action | resource | raised when |
| --- | --- | --- |
| `INGEST_ACCEPTED` | `ingest_record` | a submission is accepted |
| `INGEST_DUPLICATE` | `ingest_record` | a resubmission matches a stored record |
| `INGEST_REVIEW_REQUIRED` | `ingest_record` | held for review (ambiguous / new entity) |
| `INGEST_REJECTED` | `ingest_record` | refused; nothing was stored |
| `RELATIONSHIP_ADDED` | `relationship` | a genuinely **new** edge was added |
| `PATTERN_DETECTED` | `pattern` | a genuinely **new** pattern id appeared |
| `PRIORITY_BAND_CHANGED` | `person` | the **band** changed (LOW/MEDIUM/HIGH) |
| `INTEGRITY_RECORDED` | `content` / `ingest_record` | a content hash was committed |
| `INTEGRITY_VERIFIED` | `content` / `ingest_record` | a commitment was re-checked via `POST` |

**Not audited, on purpose:** UI clicks, page visits, searches, every numeric score
fluctuation, re-identified patterns, and merged/strengthened existing edges.

The three suppression rules, and why each exists:

1. **Re-identified patterns produce nothing.** Phase 4.6 re-derives the pattern set on every
   accepted record; ~50 of the same patterns are re-identified each time. Auditing those would
   add ~50 links of noise per submission and bury the one link that matters. `_pattern_events`
   reads **only** `new_pattern_ids` (a comparison of `pattern_signature`), never
   `reidentified_pattern_count`. Measured on a real accept: **51 re-identified → 0 events.**
2. **Numeric-only score changes produce nothing.** `68 → 69` and `69 → 68` are not decisions;
   `MEDIUM → HIGH` is. `_priority_events` skips any change whose `band_before` equals its
   `band_after`. The two scores are committed in `metadata_hash` rather than published, so the
   numbers are provable later without being disclosed now.
3. **Merged edges produce nothing.** `_relationship_events` reads only `edges_added`, never
   `edges_updated`: strengthening an edge that already existed is not a new relationship.

A duplicate resubmission produces exactly **one** event (the decision) because it changes
nothing else.

---

## 8. Evidence integrity records (§6) and generic content verification (§7)

An `IntegrityRecord` stores `resource_type`, `resource_id`, `content_hash`, `audit_event_id`
and `timestamp`. **The content itself stays outside the ledger** — the ledger holds the
commitment, not the evidence.

There is **no report-generation feature in this phase, and none was built.** What exists is a
generic content commitment: `POST /api/v1/audit/records` takes any small JSON object, hashes it
canonically, and — the first time — commits it. On any later call for the same `resource_id` it
**re-checks and never overwrites**; append-only means a commitment cannot be quietly replaced
with a hash of the altered document. The single `POST` is both "commit" and "re-check", so
verification never needs a write route.

Two resource kinds can be verified, and the difference is honest rather than convenient:

* **`ingest_record`** — the record is stored by Phase 4.6, so the backend can re-derive the
  content itself: `GET /api/v1/audit/records/ingest_record/{record_id}/verify`. The hash covers
  an immutable snapshot of the submission (its identity, provenance and normalized payload) and
  deliberately excludes derived state such as impact counts, which change as the graph changes.
* **`content`** — the backend does *not* keep the document, so a `GET` cannot verify it and
  returns **400** naming the route that can (`POST /api/v1/audit/records`) instead of answering
  `VERIFIED` about something it never saw.

A `REJECTED` submission has a decision event but **no** `content_hash` and no stored record, so
its verify returns **404**. That is the truthful answer: nothing was stored, so nothing can be
re-derived.

---

## 9. Verification and failure reporting (§8)

Two answers only: **`VERIFIED`** or **`INTEGRITY_COMPROMISED`**. No "probably fine", no score.

`GET /api/v1/audit/verify` walks the whole chain and runs three independent checks per event:

1. **sequence** — the id matches the position it occupies (`sequence_mismatch` catches an
   inserted, removed or reordered event);
2. **link** — `previous_hash` equals the predecessor's `current_hash`, genesis for the first
   (`broken_link`);
3. **content** — a fresh hash of the stored fields reproduces `current_hash` (`hash_mismatch`
   catches an edited event).

The walk stops at the **first** failure, because the earliest break is the one that matters,
and reports `audit_event_id`, `reason`, `expected_hash`, `actual_hash` and a plain-language
`message`. Content verification adds `content_hash_mismatch`, reported with both hashes and
the resource ids. **No failure response includes raw content** — a failure names the event and
the digests, nothing more.

Verification is a pure read: `GET /verify` and `GET /records/…/verify` append nothing, which is
asserted by comparing `chain_length` before and after.

### API surface (§10) — four reads and one minimal write

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/v1/audit/summary` | backend name, persistence flag, `chain_length`, `head_hash` |
| GET | `/api/v1/audit/events` | chain-order list; filters `action`, `resource_type`, `resource_id`, `limit`, `offset` |
| GET | `/api/v1/audit/events/{audit_event_id}` | one event (404 unknown, 422 malformed id) |
| GET | `/api/v1/audit/verify` | verify the whole chain |
| GET | `/api/v1/audit/records/{resource_type}/{resource_id}/verify` | verify one resource |
| POST | `/api/v1/audit/records` | commit **or** re-check one content hash |

That is the whole surface. No report builder, no admin routes, no delete.

---

## 10. Persistence (§9)

| setting | env var | default |
| --- | --- | --- |
| `audit_enabled` | `CNA_AUDIT_ENABLED` | `true` |
| `audit_persist` | `CNA_AUDIT_PERSIST` | `false` |
| `audit_dir` | `CNA_AUDIT_DIR` | `backend/data/audit` (file: `ledger.jsonl`) |
| `audit_max_content_bytes` | `CNA_AUDIT_MAX_CONTENT_BYTES` | `65536` |
| `audit_max_page_size` | `CNA_AUDIT_MAX_PAGE_SIZE` | `200` |

**No new database.** One JSONL file, one line per event, appended inside the same lock that
appends to the in-memory chain — the existing Phase 4.6 persistence convention, reused.

`load()` restores every field **verbatim** and never recomputes a hash. That is what makes an
edited ledger file *detectable*: the file loads successfully and then fails `verify()` at the
edited event, which is exactly the behaviour a tamper-evident store should have.

On restart, the integrity index is rebuilt from the chain itself (`reindex()`), from events
carrying `metadata.content_hash`, with first-commitment-wins semantics. No second store, no
sidecar file to fall out of sync.

**Measured, with `CNA_AUDIT_PERSIST=true CNA_INGEST_PERSIST=true` and a real process restart:**

| | before restart | after restart |
| --- | --- | --- |
| chain length | 3 | 3 |
| head hash | `1208c8cb0056647e…` | `1208c8cb0056647e…` (identical) |
| `verify()` | `VERIFIED` | `VERIFIED`, `events_checked: 3` |

The log line `Loaded 3 persisted audit event(s)` confirms the restore, and
`Replayed 1 persisted ingest submission(s)` produced **no duplicate audit events** — replay
re-establishes state, it does not re-decide.

---

## 11. The privacy boundary (§1)

Metadata is built from a fixed vocabulary in `AuditService` — statuses, reasons, counts, ids,
band labels. That construction is the guarantee. `assert_safe_metadata` is the backstop, and it
refuses an event before the lock if any of the following holds:

* a key contains a blocked fragment: `aadhaar, address, amount, dob, email, narrative,
  password, payload, phone, raw, secret, text, token` (keys ending in `_hash` are exempt, since
  a hash of sensitive content is the whole point of `metadata_hash`);
* a value is longer than **64 characters** (narrative text cannot fit);
* a value contains a run of **10 or more digits** (phone and Aadhaar shapes), unless the value
  is exactly a 64-character hex digest.

Verified end to end: a submission whose payload carried a real corpus phone number, a real
Aadhaar number and a narrative sentence produced audit events whose full serialization contains
**none of those values, and not even the field names** `phone`, `aadhaar`, `note`, `caller` or
`duration_sec`.

> A hex digest is `[0-9a-f]`, so any short digit string can appear inside one by chance. Tests
> therefore assert on key names containing non-hex letters rather than on short numeric values
> — a "secret `415` is absent" assertion would fail at random.

---

## 12. Local ledger now, permissioned blockchain later (§13)

`AuditLedger` is the abstraction, and it is deliberately narrow:

```python
class AuditLedger(ABC):
    backend_name: str
    def append(...) -> AuditEvent
    def all_events() -> list[AuditEvent]
    def get(audit_event_id) -> AuditEvent | None
    def head() -> str
    def length() -> int
    def verify() -> ChainVerification
```

`AuditService` and every endpoint depend only on that interface, so a future
`PermissionedBlockchainLedger` can replace `LocalHashChainLedger` without touching application
logic. The class exists in `ledger.py` as a declared seam whose methods raise
`NotImplementedError`, with the real requirements written down (an actual network, ordering
service, identity/MSP, endorsement policy, and an operator to run it). It is a **stated
intention, not a claim** — nothing is installed, nothing is deployed, and no response, log line
or UI string says "blockchain".

---

## 13. Frontend (§12)

One compact read-out, `frontend/src/components/audit/LedgerIntegrity.tsx`, rendered once at the
top of **Evidence & Provenance**. It shows `✓ VERIFIED` or `⚠ INTEGRITY COMPROMISED`, the
events-checked count, a **truncated** head hash (full value on hover), and one `[Verify]`
action. On a compromised chain it adds one line: the event id, the reason, and both truncated
hashes. If the ledger is disabled or unreachable it says so in one muted sentence and shows no
tick at all.

Only `GET /api/v1/audit/verify` is bound in `api/endpoints.ts`. The event list, per-resource
verify and the write route are intentionally **unbound**: an unused binding is an invitation to
build the ledger browser §12 rules out. A test asserts that `verifyAuditChain` is the only
audit binding that exists.

No dashboard, no block explorer, no chain diagram, no explanatory paragraphs, no "prototype"
wording, and no other page was changed.

---

## 14. Demo procedure (§15)

```bash
cd backend && python -m scripts.phase5_audit_demo
```

Runs in-process against the real routes and prints only what the application answered. Add
`--record` to refresh the two frontend fixtures. Recorded output, 2026-08-28:

| step | what it shows | result |
| --- | --- | --- |
| A | empty chain | `chain_length 0`, head = `e3b0c442…b855` |
| B | one accepted call | 3 events: `INGEST_ACCEPTED`, `RELATIONSHIP_ADDED`, `PRIORITY_BAND_CHANGED`; each `previous_hash` = the previous `current_hash` |
| B | suppression | **50 re-identified patterns → 0 events**; 0 new patterns → 0 events; 1 band change → 1 event |
| C | chain verification | `VERIFIED`, `events_checked 3`, head `7ca3b2d3…` |
| D | evidence summary committed | `VERIFIED` (original), `VERIFIED` (same content again) |
| D | one field changed (`relationship_count 2 → 3`) | **`INTEGRITY_COMPROMISED`**, `content_hash_mismatch`, `bd2ced83…` expected vs `26c5e679…` actual; the commitment is unchanged and the chain is still `VERIFIED` |
| E | one recorded event's `actor` changed in memory | **`INTEGRITY_COMPROMISED`** at `ae-000001`, `hash_mismatch`, both hashes reported; restoring the field returns `VERIFIED` |
| F | privacy | phone, Aadhaar, committed field value and `narrative` all **absent** from the ledger |

Step E is the only place in the repository that modifies a recorded audit event; it is
in-memory, on purpose, to show detection. **No step writes to the synthetic dataset**, and the
tamper demonstration never touches the original data.

### Cost

`0.034 ms` per append (2,000 appends). `verify()` over 2,000 events: `25.3 ms`, `VERIFIED`.
Against a measured `1,711 ms` Phase 4.6 recomputation inside a `1,786 ms` accepted request,
auditing is about **0.005%** of the cost of the request it audits.

---

## 15. Tests (§14)

| file | count | covers |
| --- | --- | --- |
| `backend/tests/test_audit.py` | 40 | canonicalization, SHA-256 hashing, the fixed genesis, chaining, 32-thread concurrency, append-only surface, chain verification, resource verification, all three tamper modes, event construction, decision/new-pattern/band-change filtering, re-identified suppression, generic content hash, sensitive-data exclusion, persistence round-trip, the declared blockchain seam |
| `backend/tests/test_audit_api.py` | 23 | the same rules over HTTP against the real pipeline, on its own app instance: decision events, new relationship, re-identified → 0 events, band-only auditing, duplicate, rejected (no verifiable record), stored-record verify and its idempotence, the full commit → verify → tamper sequence, redaction, 400/404/422 boundaries, pagination and link chaining, the published route surface, Phase 1–4.6 compatibility, dataset digests unchanged |
| `frontend/src/components/audit/LedgerIntegrity.test.tsx` | 5 | both verdicts rendered from recorded backend output, the failure line, `[Verify]` re-asking the backend, the unavailable case, and that only the verification route is requested |

---

## 16. Limitations — stated plainly

1. **A local chain detects modification; it does not prevent it.** Anyone who can rewrite the
   ledger *and* recompute every subsequent hash produces a self-consistent chain. The defence
   is to keep the head hash somewhere the ledger's author does not control:
   `GET /api/v1/audit/summary` returns `head_hash` for exactly that purpose. A permissioned
   blockchain, or any external anchor, is what would remove this limitation.
2. **No signing keys in this phase.** Events are not signed, so the ledger shows *that* content
   is unmodified, not *who* wrote it. There is no login system either, which is why `actor` is
   `system` rather than a person's name — an unauthenticated actor string would be a claim
   about a human being that the system cannot support.
3. **`GET /verify` is O(chain length).** It re-hashes every event and reports
   `events_checked`, so the number is never a promise about work not done. 25 ms per 2,000
   events measured; a very long chain would want incremental checkpoints.
4. **Forward-only, with no backfill.** The chain starts empty and records what happens from
   startup onward. The static synthetic corpus is not retro-hashed into it, so an empty ledger
   means "nothing has happened yet", not "nothing is verifiable".
5. **A rejected submission has a decision event but no verifiable record**, because nothing was
   stored to verify.
6. **`content`-type resources cannot be verified by `GET`.** The backend does not keep the
   document, so the holder must present it (`POST /api/v1/audit/records`). This is a property
   of hash commitments, not a gap in the implementation.
7. **Persistence is off by default** (`CNA_AUDIT_PERSIST=false`), so a demo restart starts from
   genesis unless it is switched on.
8. **Second-resolution timestamps** come from local system time. Ordering is defined by chain
   position, never by the timestamp, and the ledger has no trusted time source.
