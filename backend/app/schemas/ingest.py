"""Request and response schemas for the Phase 4.6 ingestion endpoints.

Request models are deliberately permissive about *form* and strict about
*presence*: an identifier may arrive as a number or a string, a timestamp in any
of the shapes :mod:`app.ingest.normalize` accepts, but a call without a caller
is a schema error before anything else runs. Pydantic covers step 1 of the §4
pipeline (shape); :mod:`app.ingest.normalize` covers step 2 (values), and the
two are kept apart so a value-level failure can be reported *as a record* with
a status and a reason instead of as a bare HTTP error.

Response models mirror the record dataclasses in :mod:`app.ingest.models`. Every
verdict field is accompanied by its reason, and ``candidates`` is always present
on a review outcome so "which person did you mean" is answerable from the
payload alone.
"""
from __future__ import annotations

from typing import Any, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.graph import EdgeOut, NodeOut
from app.schemas.intelligence import PatternListResponse

# An identifier a caller may send as either a number or a string. Normalization
# decides what it means; the schema only insists it is scalar.
Scalar = Union[str, int, float]


class PersonRef(BaseModel):
    """How a submission points at a person.

    At least one field must be usable — enforced in normalization rather than
    here, so the failure is reported with the same reason vocabulary as every
    other field problem.
    """

    model_config = ConfigDict(extra="forbid")

    person_id: Optional[Scalar] = Field(None, description="Existing person row id")
    phone: Optional[Scalar] = Field(None, description="10-digit Indian mobile number")
    aadhaar: Optional[Scalar] = Field(None, description="12-digit Aadhaar number")
    aadhar: Optional[Scalar] = Field(None, description="Accepted spelling variant")
    name: Optional[str] = None


class ProvenanceIn(BaseModel):
    """Where the submitter says this record came from.

    Free text, stored and echoed verbatim. It is never interpreted as an
    integration with any external system (spec §13).
    """

    model_config = ConfigDict(extra="forbid")

    source_name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Stated origin, e.g. 'station-log', 'manual-entry'",
    )
    submitted_by: Optional[str] = Field(None, max_length=200)
    reference: Optional[str] = Field(
        None, max_length=200, description="The submitter's own reference for this record"
    )
    note: Optional[str] = Field(None, max_length=500)


class _Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provenance: ProvenanceIn


class FirIn(_Submission):
    date: Scalar = Field(..., description="Report date, ISO preferred")
    complainant: PersonRef
    accused: Optional[PersonRef] = Field(
        None, description="Omit when no accused is named yet — that is a valid FIR"
    )
    narrative: str = Field(..., description="The report text, stored verbatim")
    location_id: Optional[Scalar] = None
    city: Optional[str] = None
    state: Optional[str] = None


class CallIn(_Submission):
    caller: PersonRef
    callee: PersonRef
    start_time: Scalar
    duration_sec: Scalar
    cell_tower_id: Optional[Scalar] = None


class TransactionIn(_Submission):
    sender: PersonRef
    receiver: PersonRef
    amount_inr: Scalar
    txn_time: Scalar
    mode: str = Field(..., description="UPI / NEFT / IMPS / CASH / …")
    bank_ref: Optional[str] = None
    reference_id: Optional[str] = Field(None, description="Alias for bank_ref")


class LocationIn(_Submission):
    person: PersonRef
    observed_at: Optional[Scalar] = Field(
        None, description="When the person was seen there, if known"
    )
    location_id: Optional[Scalar] = None
    city: Optional[str] = None
    state: Optional[str] = None


# --- responses --------------------------------------------------------------
class CandidateOut(BaseModel):
    entity_id: str
    label: str
    detail: dict[str, Any] = Field(default_factory=dict)


class MatchOut(BaseModel):
    field: str
    status: str = Field(..., description="MATCHED | AMBIGUOUS | NO_MATCH")
    method: str = Field(
        ...,
        description=(
            "Which rung of the §5 ladder answered: trusted_identifier, "
            "normalized_exact, deterministic_context, or none"
        ),
    )
    entity_id: Optional[str] = None
    label: Optional[str] = None
    confidence: Optional[float] = None
    candidates: list[CandidateOut] = Field(default_factory=list)
    explanation: str
    is_new_entity: bool


class RelationshipOut(BaseModel):
    relationship_type: str
    source_entity_id: Optional[str] = None
    target_entity_id: Optional[str] = None
    accepted: bool
    reason: str
    relationship_id: Optional[str] = None
    is_new_edge: bool
    is_self_reference: bool
    excluded_from_intelligence: bool = Field(
        ...,
        description=(
            "True for a self-reference: kept as evidence, excluded from Phase 4 "
            "scoring and from centrality, exactly as the dataset's own "
            "self-references are"
        ),
    )
    is_narrative: bool


class ProvenanceOut(BaseModel):
    source_type: str
    source_name: str
    submitted_by: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None


class IngestRecordOut(BaseModel):
    record_id: str = Field(
        ...,
        description=(
            "SHA-256 of source type + normalized payload fields. Excludes the "
            "ingestion timestamp, so the same observation always hashes the same."
        ),
    )
    source_type: str
    status: str = Field(
        ..., description="ACCEPTED | DUPLICATE | REVIEW_REQUIRED | REJECTED"
    )
    validation_status: str
    resolution_status: str
    review_reason: Optional[str] = Field(
        None,
        description=(
            "AMBIGUOUS_MATCH (cannot tell which existing record) or "
            "NO_MATCH_NEW_ENTITY (appears to be new). Distinct reasons."
        ),
    )
    reject_reason: Optional[str] = None
    reason: str
    raw_payload: dict[str, Any] = Field(
        ..., description="Exactly what was submitted, kept beside the normalized form"
    )
    normalized_payload: dict[str, Any]
    provenance: ProvenanceOut
    ingested_at: str
    matches: list[MatchOut]
    relationships: list[RelationshipOut]
    evidence: list[str]
    entity_ids: list[str]
    duplicate_of: Optional[str] = None
    impact: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "What actually changed. Empty of graph changes unless the record was "
            "accepted; carries measured recomputation cost when it was."
        ),
    )
    disclaimer: str


class ImpactOut(BaseModel):
    record_id: str
    source_type: str
    status: str
    reason: str
    impact: dict[str, Any]
    relationships: list[RelationshipOut]
    evidence: list[str]
    entity_ids: list[str]
    disclaimer: str


class EntityChangeOut(BaseModel):
    record_id: str
    source_type: str
    status: str
    at: str
    reason: str
    relationship_ids: list[str] = Field(default_factory=list)
    priority_change: Optional[dict[str, Any]] = Field(
        None, description="Before/after score and band, when this record moved them"
    )


class EntityChangesOut(BaseModel):
    entity_id: str
    count: int
    changes: list[EntityChangeOut]
    disclaimer: str


class IngestSummaryOut(BaseModel):
    phase: str
    records: dict[str, int]
    live_rows: dict[str, int]
    graph_totals: dict[str, int]
    events: dict[str, Any]
    persistence: dict[str, Any]
    external_sources: dict[str, Any] = Field(
        ...,
        description=(
            "Adapter configuration only. The registry is empty: no external "
            "system is integrated (spec §13)."
        ),
    )
    disclaimer: str


# --- Phase 6.2: CSV bulk import ---------------------------------------------
class BulkUploadIn(BaseModel):
    """One uploaded CSV, sent as text so the existing JSON client carries it."""

    model_config = ConfigDict(extra="forbid")

    filename: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1, description="The file's text, verbatim")


class BulkBatchFileIn(BulkUploadIn):
    """One file of an All Types upload, which names its own source type."""

    source_type: str = Field(
        ..., min_length=2, max_length=20, description="fir | call | transaction | location"
    )


class BulkBatchIn(BaseModel):
    """Several files, previewed together as one import (Phase 6.2b).

    One to four files, in any combination of types. Every file is validated on its
    own; the candidate rows of all of them are then analysed together, so a
    relationship that spans two files is visible before either is committed.
    """

    model_config = ConfigDict(extra="forbid")

    files: list[BulkBatchFileIn] = Field(..., min_length=1, max_length=4)


class BulkRowOut(BaseModel):
    row: int = Field(..., description="1-based data row number, header excluded")
    verdict: str = Field(
        ..., description="NEW_VALID | DUPLICATE | REVIEW_REQUIRED | REJECTED"
    )
    reason: str
    summary: str = Field(
        ...,
        description=(
            "Which entities the row points at. A phone or Aadhaar number is shown "
            "by its last four digits only."
        ),
    )
    record_id: Optional[str] = None
    source_type: Optional[str] = Field(
        None,
        description=(
            "Which file the row came from, in a combined import. Null in a "
            "single-type import, where every row is of the type requested."
        ),
    )


class BulkCountsOut(BaseModel):
    total: int
    new_valid: int
    duplicate: int
    review_required: int
    rejected: int


class BulkNetworkOut(BaseModel):
    """The preview subgraph, in the shape the graph endpoints already return."""

    nodes: list[NodeOut]
    edges: list[EdgeOut]
    meta: dict[str, Any]


class BulkPreviewOut(BaseModel):
    import_id: str
    source_type: str
    counts: BulkCountsOut
    commit_applicable: bool = Field(
        ..., description="False when no row is new: there is nothing to commit"
    )
    metrics_preview: dict[str, Any] = Field(
        ...,
        description=(
            "What the graph and analytics would look like after committing. "
            "Computed on an in-memory overlay; the live graph is untouched."
        ),
    )
    network_preview: BulkNetworkOut
    suspicious_patterns_preview: PatternListResponse = Field(
        ...,
        description=(
            "Patterns the existing Phase 4 detectors would newly assert. Empty "
            "when they assert none — nothing is generated to fill it."
        ),
    )
    duplicate_rows: list[BulkRowOut]
    review_required_rows: list[BulkRowOut]
    rejected_rows: list[BulkRowOut]
    disclaimer: str


class BulkFileOut(BaseModel):
    """One selected file's own contribution to a combined preview."""

    index: int
    source_type: str
    filename: str
    status: str = Field(
        ...,
        description=(
            "ok (has new rows) | skipped (its rows are already in the system) | "
            "rejected (no row was usable) | review (no row could be added without "
            "a decision) | error (the file itself could not be read). After a "
            "commit, a file that wrote rows is `committed`."
        ),
    )
    counts: BulkCountsOut
    import_id: Optional[str] = None
    error: Optional[str] = Field(
        None, description="Why the file was not usable, if it was not"
    )
    reason: Optional[str] = Field(
        None,
        description=(
            "Why the file contributed nothing new, in the same words the row itself "
            "was given. Null when it did contribute."
        ),
    )


class BulkBatchPreviewOut(BulkPreviewOut):
    """A combined preview: the same body, plus which files it was built from.

    ``counts``, ``metrics_preview``, ``network_preview`` and
    ``suspicious_patterns_preview`` describe the whole selection analysed
    together on ONE overlay — not per-file results added up.
    """

    files: list[BulkFileOut]
    import_ids: list[str] = Field(
        ...,
        description="The batch id, then each file's own id. Any of them confirms "
        "or rejects the whole import.",
    )
    graph_before: dict[str, int] = Field(
        ..., description="Live graph totals the preview was computed against"
    )


class BulkConfirmOut(BaseModel):
    import_id: str
    source_type: str
    counts: dict[str, int]
    record_ids: list[str]
    skipped: list[dict[str, Any]] = Field(
        ...,
        description="Rows that stopped being committable between preview and confirm",
    )
    graph_totals: dict[str, int]
    live_rows: dict[str, int]
    new_pattern_ids: list[str]
    priority_changes: list[dict[str, Any]]
    recompute_cost_ms: dict[str, Any]
    recompute_error: Optional[str] = None
    manifest_hash: Optional[str] = Field(
        None, description="SHA-256 of the committed record ids, as audited"
    )
    audit_event_id: Optional[str] = None
    audit_error: Optional[str] = None
    disclaimer: str
    # Combined imports only; null for a single-type import.
    files: Optional[list[dict[str, Any]]] = Field(
        None, description="What each selected file committed"
    )
    import_ids: list[str] = Field(
        default_factory=list, description="Every id this import answered to"
    )
    graph_before: Optional[dict[str, int]] = Field(
        None, description="Live graph totals immediately before this commit"
    )


class BulkRejectOut(BaseModel):
    import_id: str
    discarded: bool
    note: str
