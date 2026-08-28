"""Request and response schemas for the Phase 5 audit endpoints.

Two shapes are deliberate:

* An event exposes ``metadata`` and ``metadata_hash`` but never content. The
  ledger holds identifiers, enum values, counts and hashes, so there is no field
  in this module that could carry FIR text, a phone number, an Aadhaar number or
  a financial amount — the response shape itself enforces §1.
* Every verification response carries ``expected_hash`` and ``actual_hash`` side
  by side, so a client can see *what* differs rather than being told a status and
  asked to trust it.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AuditEventOut(BaseModel):
    audit_event_id: str = Field(
        ..., description="Deterministic chain position, e.g. 'ae-000001'"
    )
    timestamp: str
    actor: str = Field(
        ...,
        description=(
            "'system' for events raised by the application. No authentication "
            "system exists yet, so this is not a claim about a person."
        ),
    )
    action: str
    resource_type: str
    resource_id: str
    previous_hash: str
    current_hash: str = Field(
        ...,
        description=(
            "SHA-256 of this event's canonically serialized fields concatenated "
            "with previous_hash"
        ),
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Identifiers, enum values and counts only. Never a raw payload, "
            "never free text, never a sensitive identifier."
        ),
    )
    metadata_hash: Optional[str] = Field(
        None,
        description=(
            "Commits to detail the ledger deliberately does not store, such as "
            "the scores behind a band change or a rejected submission's payload."
        ),
    )


class AuditEventsOut(BaseModel):
    total: int = Field(..., description="Events matching the filters")
    chain_length: int = Field(..., description="Events in the whole chain")
    returned: int
    offset: int
    limit: int
    events: list[AuditEventOut]


class ChainFailureOut(BaseModel):
    audit_event_id: str
    reason: str = Field(
        ...,
        description=(
            "hash_mismatch (an event was modified), broken_link (previous_hash "
            "does not match), sequence_mismatch (an event was inserted, removed "
            "or reordered), or content_hash_mismatch"
        ),
    )
    expected_hash: str
    actual_hash: str
    message: str


class ChainVerificationOut(BaseModel):
    status: str = Field(..., description="VERIFIED or INTEGRITY_COMPROMISED")
    events_checked: int
    chain_length: int
    genesis_previous_hash: str = Field(
        ..., description='Fixed constant: SHA-256("") = e3b0c442...b855'
    )
    head_hash: str
    backend: str = Field(
        ...,
        description=(
            "'local_hash_chain'. A local append-only SHA-256 chain, not a "
            "blockchain network."
        ),
    )
    persisted: bool
    failure: Optional[ChainFailureOut] = None


class ResourceVerificationOut(BaseModel):
    status: str = Field(..., description="VERIFIED or INTEGRITY_COMPROMISED")
    resource_type: str
    resource_id: str
    expected_hash: str = Field(..., description="The hash committed to the ledger")
    actual_hash: str = Field(..., description="The hash of the content as it is now")
    audit_event_id: str = Field(..., description="The event that recorded the hash")
    recorded_at: str
    failure: Optional[ChainFailureOut] = None


class IntegrityRecordOut(BaseModel):
    resource_type: str
    resource_id: str
    content_hash: str
    audit_event_id: str
    timestamp: str


class ContentIntegrityRequest(BaseModel):
    """Commit — or re-check — the hash of a supplied content object (§7).

    There is no report-generation feature and this is not one. The content is
    hashed and discarded: nothing in the audit layer stores it.
    """

    model_config = ConfigDict(extra="forbid")

    resource_id: str = Field(
        ...,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9._:-]+$",
        description="Caller-chosen identifier for the content being committed",
    )
    content: dict[str, Any] = Field(
        ...,
        description=(
            "Any JSON object. Hashed with the canonical serialization used "
            "throughout the project, then discarded."
        ),
    )
    content_type: Optional[str] = Field(
        None,
        max_length=40,
        pattern=r"^[a-z0-9_]+$",
        description="Optional label, e.g. 'evidence_summary'",
    )


class ContentIntegrityOut(BaseModel):
    created: bool = Field(
        ...,
        description=(
            "True when this call committed a new hash; false when a commitment "
            "already existed and the supplied content was checked against it. "
            "An existing commitment is never overwritten."
        ),
    )
    verification: ResourceVerificationOut
    integrity_record: IntegrityRecordOut
    audit_event_id: str = Field(..., description="The event appended by this call")


class AuditSummaryOut(BaseModel):
    backend: str
    persisted: bool
    chain_length: int
    head_hash: str
    integrity_records: int
    actions: dict[str, int]
