"""Audit event model, canonical hashing and the genesis constant (§1, §2, §3).

Three rules define this module, and everything else in Phase 5 depends on them
being stated in exactly one place.

**One canonicalization.** The hash input is produced by
:func:`app.ingest.models.canonical_payload` — the same function that already
defines a Phase 4.6 ``record_id``: sorted keys, no insertion-order dependence,
``None`` dropped so an omitted optional field and an explicit ``null`` hash
identically, ``separators=(",", ":")`` so no whitespace can drift, and
``ensure_ascii=False`` so the bytes are the UTF-8 of the real characters. Phase 5
does not invent a second serializer, because two serializers is how a chain
starts verifying against itself and nothing else.

**One genesis.** :data:`GENESIS_PREVIOUS_HASH` is ``SHA-256("")`` —
``e3b0c442...b855``, a fixed, published, reproducible constant. Not a random
value, not a timestamp, not a UUID, not a zero-filled string.

**One privacy boundary.** An audit event stores identifiers, enum values and
counts. It never stores raw FIR text, phone numbers, Aadhaar numbers, financial
amounts, provenance free-text or any other payload field. Detail that the event
needs to *commit to* without *revealing* goes into ``metadata_hash``, which is a
hash of content that stays outside the ledger. :func:`assert_safe_metadata` is a
backstop for that rule, not the rule itself: the real guarantee is that
``app.audit.service`` builds metadata from a fixed vocabulary.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from app.ingest.models import canonical_payload

# §3. The first event's ``previous_hash``. SHA-256 of the empty byte string:
# fixed, documented, and reproducible with one line of the standard library.
GENESIS_PREVIOUS_HASH = hashlib.sha256(b"").hexdigest()

# §1. No authentication system exists yet, so the actor is not a claim about a
# human being. Events raised by the application say "system"; the demo actor
# exists only for flows an investigator explicitly triggers.
DEFAULT_ACTOR = "system"
DEMO_ACTOR = "demo_investigator"


class AuditAction(str, Enum):
    """The closed vocabulary of audited actions (§5).

    Deliberately small. Every member corresponds to a decision or a state
    transition an investigator could be asked to justify later. UI navigation,
    page views and numeric score drift are not in this list and are not audited.
    """

    INGEST_ACCEPTED = "INGEST_ACCEPTED"
    INGEST_DUPLICATE = "INGEST_DUPLICATE"
    INGEST_REVIEW_REQUIRED = "INGEST_REVIEW_REQUIRED"
    INGEST_REJECTED = "INGEST_REJECTED"
    RELATIONSHIP_ADDED = "RELATIONSHIP_ADDED"
    PATTERN_DETECTED = "PATTERN_DETECTED"
    PRIORITY_BAND_CHANGED = "PRIORITY_BAND_CHANGED"
    INTEGRITY_RECORDED = "INTEGRITY_RECORDED"
    INTEGRITY_VERIFIED = "INTEGRITY_VERIFIED"


class ResourceType(str, Enum):
    """What an audit event is about."""

    INGEST_RECORD = "ingest_record"
    RELATIONSHIP = "relationship"
    PATTERN = "pattern"
    PERSON = "person"
    # Generic content committed by hash: the illustrative evidence summary of
    # §7. There is no report-generation feature, and this is not one.
    CONTENT = "content"


class VerificationStatus(str, Enum):
    """The only two answers a verification gives (§8)."""

    VERIFIED = "VERIFIED"
    INTEGRITY_COMPROMISED = "INTEGRITY_COMPROMISED"


class FailureReason(str, Enum):
    """Why a verification failed. Codes, so a client can branch on them."""

    HASH_MISMATCH = "hash_mismatch"
    BROKEN_LINK = "broken_link"
    SEQUENCE_MISMATCH = "sequence_mismatch"
    CONTENT_HASH_MISMATCH = "content_hash_mismatch"


class UnsafeMetadataError(ValueError):
    """Raised when metadata would put sensitive or unbounded data in the chain."""


# Key fragments that must never appear in ledger metadata. This is a backstop
# for a mistake, not the mechanism that keeps the ledger clean.
_BLOCKED_KEY_PARTS = (
    "aadhaar",
    "address",
    "amount",
    "dob",
    "email",
    "narrative",
    "password",
    "payload",
    "phone",
    "raw",
    "secret",
    "text",
    "token",
)
# Metadata values are enum members, bands, counts and identifiers. Nothing in
# that vocabulary is long, so a long value means a payload leaked in.
MAX_METADATA_VALUE_CHARS = 64
# Catches an Aadhaar (12 digits) or a phone number (10) reaching an allowed key.
_DIGIT_RUN = re.compile(r"\d{10,}")
# A SHA-256 digest is hex, and roughly a third of random digests happen to
# contain a 10-digit run. Digests are exactly what the ledger exists to hold, so
# they are recognised and exempted rather than tripping the identifier check.
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _check_value(key: str, value: Any) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        if _DIGIT_RUN.search(str(value)):
            raise UnsafeMetadataError(
                f"metadata['{key}'] looks like an identifier or payload number"
            )
        return
    if isinstance(value, str):
        if len(value) > MAX_METADATA_VALUE_CHARS:
            raise UnsafeMetadataError(
                f"metadata['{key}'] is longer than {MAX_METADATA_VALUE_CHARS} "
                "characters: free text does not belong in the ledger"
            )
        if _HEX64.match(value):
            return
        if _DIGIT_RUN.search(value):
            raise UnsafeMetadataError(
                f"metadata['{key}'] contains a 10+ digit run: identifiers such "
                "as phone or Aadhaar numbers must not enter the ledger"
            )
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _check_value(key, item)
        return
    if isinstance(value, dict):
        assert_safe_metadata(value)
        return
    raise UnsafeMetadataError(
        f"metadata['{key}'] has unsupported type {type(value).__name__}"
    )


def assert_safe_metadata(metadata: dict[str, Any]) -> None:
    """Reject metadata that would carry sensitive or unbounded data (§1).

    A key ending in ``_hash`` is exempt from the key blocklist, because a hash of
    something sensitive is exactly what the ledger is allowed to hold.
    """
    for key, value in metadata.items():
        if not isinstance(key, str):
            raise UnsafeMetadataError(f"metadata key {key!r} is not a string")
        lowered = key.lower()
        if not lowered.endswith("_hash"):
            for part in _BLOCKED_KEY_PARTS:
                if part in lowered:
                    raise UnsafeMetadataError(
                        f"metadata key '{key}' matches blocked fragment "
                        f"'{part}': store a hash, not the value"
                    )
        _check_value(key, value)


def content_hash(content: Any) -> str:
    """``SHA-256`` of canonically serialized content (§2, §6).

    The generic content hash of §7. Works on any JSON-shaped value, and the
    content itself is never retained by the audit layer.
    """
    return hashlib.sha256(canonical_payload(content).encode("utf-8")).hexdigest()


def compute_event_hash(content: dict[str, Any], previous_hash: str) -> str:
    """``current_hash = SHA-256(canonicalized_audit_content + previous_hash)``.

    Concatenation, not nesting: the canonical string of the event's own fields
    followed by the 64 hex characters of the link it extends. Both halves are
    fixed-format, so the boundary is unambiguous.
    """
    material = canonical_payload(content) + previous_hash
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def make_audit_event_id(sequence: int) -> str:
    """``ae-000001`` for chain position 1. Deterministic; never a random UUID."""
    return f"ae-{sequence:06d}"


def audit_now() -> str:
    """Second-resolution local timestamp, matching the rest of the application.

    Ordering is defined by chain position, never by this string.
    """
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


@dataclass
class AuditEvent:
    """One append-only link in the chain (§1).

    Every field except ``current_hash`` is covered by the hash, including
    ``timestamp``. That is a deliberate strengthening of §2's "exclude
    non-deterministic fields": a *recorded* timestamp is data, not randomness
    injected at hash time, and covering it means the recorded time of an event
    cannot be altered without breaking the chain. Verification stays exactly
    reproducible because it re-hashes the stored fields.
    """

    audit_event_id: str
    timestamp: str
    actor: str
    action: AuditAction
    resource_type: ResourceType
    resource_id: str
    previous_hash: str
    current_hash: str
    metadata: dict[str, Any] = field(default_factory=dict)
    # Commits to detail that is deliberately not stored here (§1).
    metadata_hash: Optional[str] = None

    @property
    def sequence(self) -> int:
        """1-based chain position, parsed back out of the id."""
        return int(self.audit_event_id.split("-")[-1])

    def content(self) -> dict[str, Any]:
        """Exactly what gets hashed. ``current_hash`` is excluded; it is the output."""
        return {
            "audit_event_id": self.audit_event_id,
            "timestamp": self.timestamp,
            "actor": self.actor,
            "action": self.action.value,
            "resource_type": self.resource_type.value,
            "resource_id": self.resource_id,
            "metadata": self.metadata,
            "metadata_hash": self.metadata_hash,
        }

    def recompute_hash(self) -> str:
        return compute_event_hash(self.content(), self.previous_hash)

    def as_dict(self) -> dict[str, Any]:
        payload = self.content()
        payload["previous_hash"] = self.previous_hash
        payload["current_hash"] = self.current_hash
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AuditEvent":
        """Rebuild an event from persisted JSON.

        Stored values are taken verbatim — hashes are never recomputed here, so a
        tampered file stays detectable by :meth:`recompute_hash`.
        """
        return cls(
            audit_event_id=data["audit_event_id"],
            timestamp=data["timestamp"],
            actor=data["actor"],
            action=AuditAction(data["action"]),
            resource_type=ResourceType(data["resource_type"]),
            resource_id=data["resource_id"],
            previous_hash=data["previous_hash"],
            current_hash=data["current_hash"],
            metadata=data.get("metadata") or {},
            metadata_hash=data.get("metadata_hash"),
        )


@dataclass
class IntegrityRecord:
    """A content commitment (§6). The content itself lives outside the ledger."""

    resource_type: ResourceType
    resource_id: str
    content_hash: str
    audit_event_id: str
    timestamp: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "resource_type": self.resource_type.value,
            "resource_id": self.resource_id,
            "content_hash": self.content_hash,
            "audit_event_id": self.audit_event_id,
            "timestamp": self.timestamp,
        }


def ingest_record_content(record: Any) -> dict[str, Any]:
    """The immutable snapshot of an ingestion record that gets hashed (§6).

    Covers the observation, the decision taken on it, when it was taken and what
    it was sourced from — so altering a stored record's payload, its status, its
    timestamp or its provenance all break verification. Derived state (scores,
    patterns, communities) is deliberately excluded: it legitimately changes on
    every accepted record, and hashing it would report a compromise for normal
    operation.
    """
    return {
        "record_id": record.record_id,
        "source_type": record.source_type.value,
        "status": record.status.value,
        "ingested_at": record.ingested_at,
        "normalized_payload": record.normalized_payload,
        "provenance": record.provenance.as_dict(),
    }
