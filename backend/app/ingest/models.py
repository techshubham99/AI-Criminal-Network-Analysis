"""Phase 4.6 domain model: statuses, reasons, records, and the record id.

Two rules are enforced by the types here rather than by convention:

1. **A record's identity is its normalized content.** :func:`make_record_id`
   hashes the source type together with the normalized payload and nothing else
   — in particular *not* the ingestion timestamp — so resubmitting the same
   observation is recognisable as the same observation (spec §2).
2. **A decision is never a bare verdict.** Every :class:`IngestRecord` carries
   the reason, the candidate matches that were considered, and the per-step
   decisions that produced its status, so "REVIEW_REQUIRED" can always be
   answered with "because of what".

Nothing here decides anything. The ladder lives in :mod:`app.ingest.resolution`
and the gate in :mod:`app.ingest.pipeline`.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class SourceType(str, Enum):
    """The four record kinds this phase accepts (spec §3)."""

    FIR = "FIR"
    CALL = "CALL"
    TRANSACTION = "TRANSACTION"
    LOCATION = "LOCATION"


class IngestStatus(str, Enum):
    """Terminal disposition of one submission (spec §1)."""

    ACCEPTED = "ACCEPTED"
    DUPLICATE = "DUPLICATE"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    REJECTED = "REJECTED"


class ReviewReason(str, Enum):
    """Why a record needs a human before it may touch the graph (spec §5, §6).

    ``AMBIGUOUS_MATCH`` and ``NO_MATCH_NEW_ENTITY`` are deliberately distinct:
    the first means *we cannot tell which existing person this is*, the second
    means *this appears to be someone/something we have never seen*. Collapsing
    them would hide the difference between a merge risk and a new subject.
    """

    AMBIGUOUS_MATCH = "AMBIGUOUS_MATCH"
    NO_MATCH_NEW_ENTITY = "NO_MATCH_NEW_ENTITY"


class RejectReason(str, Enum):
    """Why a record cannot be a record at all."""

    SCHEMA_INVALID = "SCHEMA_INVALID"
    INVALID_FIELD = "INVALID_FIELD"
    INVALID_RELATIONSHIP = "INVALID_RELATIONSHIP"


class MatchMethod(str, Enum):
    """Which rung of the §5 ladder produced a match."""

    TRUSTED_IDENTIFIER = "trusted_identifier"   # 1: person_id / phone / aadhaar
    NORMALIZED_EXACT = "normalized_exact"       # 2: normalized value, one record
    DETERMINISTIC_CONTEXT = "deterministic_context"  # 3: corroborated by the payload
    NONE = "none"


class MatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NO_MATCH = "NO_MATCH"


# The sentence spec §6 requires verbatim when nothing links to existing data.
NO_LINK_EXPLANATION = (
    "No validated connection found with existing investigation data."
)

# Said in the payload so a client that only reads JSON still reads the caveat.
INGEST_DISCLAIMER = (
    "Ingestion decisions describe record validity and how a reference resolves "
    "against existing records. They are not findings about any person, and a "
    "new or unconnected record is not treated as suspicious."
)


@dataclass(frozen=True)
class CandidateMatch:
    """One existing entity a reference could mean."""

    entity_id: str
    label: str
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"entity_id": self.entity_id, "label": self.label, "detail": self.detail}


@dataclass(frozen=True)
class EntityMatch:
    """Outcome of resolving ONE reference in a submitted payload (spec §5)."""

    field_name: str
    status: MatchStatus
    method: MatchMethod
    entity_id: Optional[str] = None
    label: Optional[str] = None
    confidence: Optional[float] = None
    candidates: list[CandidateMatch] = field(default_factory=list)
    explanation: str = ""
    is_new_entity: bool = False

    @property
    def matched(self) -> bool:
        return self.status is MatchStatus.MATCHED

    def as_dict(self) -> dict[str, Any]:
        return {
            "field": self.field_name,
            "status": self.status.value,
            "method": self.method.value,
            "entity_id": self.entity_id,
            "label": self.label,
            "confidence": self.confidence,
            "candidates": [c.as_dict() for c in self.candidates],
            "explanation": self.explanation,
            "is_new_entity": self.is_new_entity,
        }


@dataclass(frozen=True)
class RelationshipDecision:
    """Accept/reject accounting for one proposed relationship (spec §4)."""

    relationship_type: str
    source_entity_id: Optional[str]
    target_entity_id: Optional[str]
    accepted: bool
    reason: str
    relationship_id: Optional[str] = None
    is_new_edge: bool = False
    is_self_reference: bool = False
    excluded_from_intelligence: bool = False
    is_narrative: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "relationship_type": self.relationship_type,
            "source_entity_id": self.source_entity_id,
            "target_entity_id": self.target_entity_id,
            "accepted": self.accepted,
            "reason": self.reason,
            "relationship_id": self.relationship_id,
            "is_new_edge": self.is_new_edge,
            "is_self_reference": self.is_self_reference,
            "excluded_from_intelligence": self.excluded_from_intelligence,
            "is_narrative": self.is_narrative,
        }


@dataclass(frozen=True)
class Provenance:
    """Where a record came from, in the caller's own words.

    ``source_name`` is free text supplied by the submitter. It is stored and
    echoed, never interpreted, and never presented as an integration with any
    external system (spec §13).
    """

    source_type: str
    source_name: str
    submitted_by: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_type": self.source_type,
            "source_name": self.source_name,
            "submitted_by": self.submitted_by,
            "reference": self.reference,
            "note": self.note,
        }


@dataclass
class IngestRecord:
    """One submitted record and everything the pipeline concluded about it."""

    record_id: str
    source_type: SourceType
    raw_payload: dict[str, Any]
    normalized_payload: dict[str, Any]
    provenance: Provenance
    ingested_at: str
    status: IngestStatus
    validation_status: str
    resolution_status: str
    review_reason: Optional[ReviewReason] = None
    reject_reason: Optional[RejectReason] = None
    reason: str = ""
    matches: list[EntityMatch] = field(default_factory=list)
    relationships: list[RelationshipDecision] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    impact: dict[str, Any] = field(default_factory=dict)
    duplicate_of: Optional[str] = None
    # Entity ids this record touches — the index behind /entities/{id}/changes.
    entity_ids: list[str] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return self.status is IngestStatus.ACCEPTED

    def as_dict(self) -> dict[str, Any]:
        return {
            "record_id": self.record_id,
            "source_type": self.source_type.value,
            "status": self.status.value,
            "validation_status": self.validation_status,
            "resolution_status": self.resolution_status,
            "review_reason": self.review_reason.value if self.review_reason else None,
            "reject_reason": self.reject_reason.value if self.reject_reason else None,
            "reason": self.reason,
            "raw_payload": self.raw_payload,
            "normalized_payload": self.normalized_payload,
            "provenance": self.provenance.as_dict(),
            "ingested_at": self.ingested_at,
            "matches": [m.as_dict() for m in self.matches],
            "relationships": [r.as_dict() for r in self.relationships],
            "evidence": list(self.evidence),
            "entity_ids": list(self.entity_ids),
            "duplicate_of": self.duplicate_of,
            "impact": self.impact,
            "disclaimer": INGEST_DISCLAIMER,
        }


def canonical_payload(normalized: dict[str, Any]) -> str:
    """The exact string that gets hashed.

    Sorted keys, no insertion-order dependence, no whitespace, and ``None``
    dropped so an omitted optional field and an explicit ``null`` are the same
    observation. This is the only place the hash input is defined.
    """

    def prune(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: prune(v) for k, v in sorted(value.items()) if v is not None}
        if isinstance(value, list):
            return [prune(v) for v in value]
        return value

    return json.dumps(
        prune(normalized), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def make_record_id(source_type: SourceType, normalized: dict[str, Any]) -> str:
    """``SHA-256(source_type + normalized_payload_fields)`` (spec §2).

    The ingestion timestamp is NOT part of the input, so the same observation
    submitted twice — a minute or a restart apart — yields the same id and is
    recognised as a duplicate rather than doubling the evidence behind an edge.
    """
    material = f"{source_type.value}|{canonical_payload(normalized)}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
