"""The audit service: what gets audited, and what deliberately does not (§5, §6, §7, §11).

This is the only place that decides an event is worth recording. Two rules do
most of that work, and both exist because the alternative is a ledger nobody can
read:

* **A re-identified pattern is not a new detection.** Phase 4.6 already
  distinguishes ``new_pattern_ids`` (a pattern that was not previously asserted)
  from ``reidentified_pattern_count`` (the same assertion under a new id, because
  community labels moved). One accepted call re-identifies ~50 patterns on this
  dataset. Auditing those would add fifty meaningless links per submission, so
  only genuinely new pattern ids are audited.
* **A score that moves is not a decision.** 68 → 69 changes nothing an
  investigator acts on. A band change — LOW → MEDIUM, MEDIUM → HIGH, and the
  reverse — is a change in how a person is triaged, so that is what gets audited.

The other half of this module is content integrity (§6, §7). The ledger commits
to a hash; the content stays with whatever system owns it. There is no report
builder here, and no content is stored by the audit layer at all.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from app.audit.ledger import AuditLedger, ChainFailure, ChainVerification, LocalHashChainLedger
from app.audit.models import (
    DEFAULT_ACTOR,
    AuditAction,
    AuditEvent,
    FailureReason,
    IntegrityRecord,
    ResourceType,
    VerificationStatus,
    content_hash,
    ingest_record_content,
)

logger = logging.getLogger(__name__)

# Phase 4.6 statuses map one-to-one onto audited ingestion decisions (§11).
_DECISION_ACTIONS = {
    "ACCEPTED": AuditAction.INGEST_ACCEPTED,
    "DUPLICATE": AuditAction.INGEST_DUPLICATE,
    "REVIEW_REQUIRED": AuditAction.INGEST_REVIEW_REQUIRED,
    "REJECTED": AuditAction.INGEST_REJECTED,
}


@dataclass
class ResourceVerification:
    """The answer to "does this resource still hash to what we committed?" (§8)."""

    status: VerificationStatus
    resource_type: ResourceType
    resource_id: str
    expected_hash: str
    actual_hash: str
    audit_event_id: str
    recorded_at: str
    failure: Optional[ChainFailure] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "resource_type": self.resource_type.value,
            "resource_id": self.resource_id,
            "expected_hash": self.expected_hash,
            "actual_hash": self.actual_hash,
            "audit_event_id": self.audit_event_id,
            "recorded_at": self.recorded_at,
            "failure": self.failure.as_dict() if self.failure else None,
        }


@dataclass
class ContentOutcome:
    """Result of committing or re-checking a content hash."""

    verification: ResourceVerification
    created: bool
    event: AuditEvent


class AuditService:
    """Application-facing audit API. Owns no storage of its own."""

    def __init__(self, ledger: AuditLedger) -> None:
        self.ledger = ledger
        self._integrity: dict[tuple[str, str], IntegrityRecord] = {}
        self.reindex()

    # ==================================================================
    # index
    # ==================================================================
    def reindex(self) -> int:
        """Rebuild the integrity index from the chain.

        Integrity records are not a second store: each one *is* an audit event
        carrying a ``content_hash``, which is what makes the commitment itself
        tamper-evident. The index is a lookup, rebuilt from the chain on startup.
        """
        index: dict[tuple[str, str], IntegrityRecord] = {}
        for event in self.ledger.all_events():
            digest = event.metadata.get("content_hash")
            if not digest:
                continue
            key = (event.resource_type.value, event.resource_id)
            # First commitment wins: a later event may re-state the same hash
            # (a duplicate submission, a re-verification) but cannot replace it.
            index.setdefault(
                key,
                IntegrityRecord(
                    resource_type=event.resource_type,
                    resource_id=event.resource_id,
                    content_hash=str(digest),
                    audit_event_id=event.audit_event_id,
                    timestamp=event.timestamp,
                ),
            )
        self._integrity = index
        return len(index)

    def integrity_record(
        self, resource_type: ResourceType, resource_id: str
    ) -> Optional[IntegrityRecord]:
        return self._integrity.get((resource_type.value, str(resource_id)))

    def _index(self, event: AuditEvent, digest: str) -> None:
        key = (event.resource_type.value, event.resource_id)
        self._integrity.setdefault(
            key,
            IntegrityRecord(
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                content_hash=digest,
                audit_event_id=event.audit_event_id,
                timestamp=event.timestamp,
            ),
        )

    # ==================================================================
    # §11 ingestion integration
    # ==================================================================
    def record_submission(
        self, record: Any, *, actor: str = DEFAULT_ACTOR
    ) -> list[AuditEvent]:
        """Audit one ingestion submission and everything it genuinely changed.

        Called by the Phase 4.6 pipeline *inside its ingestion lock*, so appends
        happen synchronously in decision order. The lossy, per-subscriber SSE bus
        is not involved: it can drop frames when a client is slow, and a ledger
        that can drop events is not a ledger.

        Event order per submission is fixed: the decision, then new relationships,
        then genuinely new patterns, then band changes.
        """
        impact = record.impact or {}
        events = [self._decision_event(record, impact, actor)]
        events.extend(self._relationship_events(record, impact, actor))
        events.extend(self._pattern_events(record, impact, actor))
        events.extend(self._priority_events(record, impact, actor))
        return events

    def _decision_event(
        self, record: Any, impact: dict[str, Any], actor: str
    ) -> AuditEvent:
        status = record.status.value
        action = _DECISION_ACTIONS[status]
        metadata: dict[str, Any] = {
            "source_type": record.source_type.value,
            "decision": status,
        }
        metadata_hash: Optional[str] = None

        if status == "REJECTED":
            # Nothing was stored, so there is nothing to verify later. The event
            # still commits to what was submitted, without holding it.
            metadata["reject_reason"] = (
                record.reject_reason.value if record.reject_reason else None
            )
            metadata_hash = content_hash(
                {"raw_payload": record.raw_payload, "reason": record.reason}
            )
        else:
            metadata["content_hash"] = content_hash(ingest_record_content(record))
            if status == "REVIEW_REQUIRED":
                metadata["review_reason"] = (
                    record.review_reason.value if record.review_reason else None
                )
            elif status == "DUPLICATE":
                metadata["original_status"] = impact.get("original_status")
                metadata["resubmissions"] = impact.get("resubmissions")
            elif status == "ACCEPTED":
                graph = impact.get("graph") or {}
                metadata["graph_changed"] = bool(impact.get("changed"))
                metadata["new_relationships"] = len(graph.get("edges_added") or [])
                metadata["merged_relationships"] = len(graph.get("edges_updated") or [])

        metadata = {k: v for k, v in metadata.items() if v is not None}
        event = self.ledger.append(
            action,
            ResourceType.INGEST_RECORD,
            record.record_id,
            metadata=metadata,
            metadata_hash=metadata_hash,
            actor=actor,
        )
        digest = metadata.get("content_hash")
        if digest:
            self._index(event, str(digest))
        return event

    def _relationship_events(
        self, record: Any, impact: dict[str, Any], actor: str
    ) -> list[AuditEvent]:
        """Only genuinely new edges (§11).

        Phase 4.6 folds a repeated observation into an existing aggregate edge:
        ``edges_updated`` is more evidence for a relationship that was already
        asserted, so it is not a new relationship and is not audited as one.
        """
        graph = impact.get("graph") or {}
        return [
            self.ledger.append(
                AuditAction.RELATIONSHIP_ADDED,
                ResourceType.RELATIONSHIP,
                relationship_id,
                metadata={
                    "record_id": record.record_id,
                    "source_type": record.source_type.value,
                },
                actor=actor,
            )
            for relationship_id in (graph.get("edges_added") or [])
        ]

    def _pattern_events(
        self, record: Any, impact: dict[str, Any], actor: str
    ) -> list[AuditEvent]:
        """Only newly asserted patterns — never a re-identified one (§5).

        ``new_pattern_ids`` is already computed by comparing what a pattern
        *asserts* (type plus entities), so this reads it and adds no logic of its
        own. ``reidentified_pattern_count`` is deliberately never read here.
        """
        return [
            self.ledger.append(
                AuditAction.PATTERN_DETECTED,
                ResourceType.PATTERN,
                pattern_id,
                metadata={"record_id": record.record_id},
                actor=actor,
            )
            for pattern_id in (impact.get("new_pattern_ids") or [])
        ]

    def _priority_events(
        self, record: Any, impact: dict[str, Any], actor: str
    ) -> list[AuditEvent]:
        """Only band transitions (§5).

        A numeric move inside a band is not audited. The scores themselves are
        committed through ``metadata_hash`` instead of being written into the
        ledger, so the event proves which numbers produced the transition without
        publishing a score against a person.
        """
        events: list[AuditEvent] = []
        for change in impact.get("priority_changes") or []:
            before = change.get("band_before")
            after = change.get("band_after")
            if not before or not after or before == after:
                continue
            events.append(
                self.ledger.append(
                    AuditAction.PRIORITY_BAND_CHANGED,
                    ResourceType.PERSON,
                    change.get("entity_id") or f"person:{change.get('person_id')}",
                    metadata={
                        "band_before": before,
                        "band_after": after,
                        "record_id": record.record_id,
                    },
                    metadata_hash=content_hash(
                        {
                            "score_before": change.get("score_before"),
                            "score_after": change.get("score_after"),
                        }
                    ),
                    actor=actor,
                )
            )
        return events

    def record_bulk_import(
        self,
        import_id: str,
        *,
        source_type: str,
        counts: dict[str, int],
        manifest_hash: str,
        actor: str = DEFAULT_ACTOR,
    ) -> AuditEvent:
        """One event for a confirmed CSV import (Phase 6.2).

        A bulk import is a single investigator decision — "add this file" — so it
        gets a single link, addressed by its import id. Per-row events would bury
        that decision under a hundred indistinguishable ones.

        ``manifest_hash`` commits to the ordered list of record ids that were
        actually written, so which rows the import claimed to commit is provable
        later without the ledger holding the rows.
        """
        metadata: dict[str, Any] = {
            "source_type": source_type,
            "decision": "CONFIRMED",
            "manifest_hash": manifest_hash,
        }
        for key, value in counts.items():
            metadata[f"{key}_count"] = int(value)
        return self.ledger.append(
            AuditAction.INGEST_BULK_CONFIRMED,
            ResourceType.INGEST_IMPORT,
            import_id,
            metadata=metadata,
            actor=actor,
        )

    # ==================================================================
    # §6, §7 content integrity
    # ==================================================================
    def record_content(
        self,
        resource_id: str,
        content: Any,
        *,
        content_type: Optional[str] = None,
        resource_type: ResourceType = ResourceType.CONTENT,
        actor: str = DEFAULT_ACTOR,
    ) -> ContentOutcome:
        """Commit a content hash, or re-check content against an existing one (§7).

        First call for a resource id commits the hash. A later call with the same
        id does **not** overwrite it — the ledger is append-only — it re-hashes
        the supplied content, compares, and records the verification and its
        outcome. Changing one field of the content and calling again is therefore
        the whole tamper demonstration, with no endpoint that edits anything.
        """
        digest = content_hash(content)
        existing = self.integrity_record(resource_type, resource_id)

        if existing is None:
            metadata: dict[str, Any] = {"content_hash": digest}
            if content_type:
                metadata["content_type"] = content_type
            event = self.ledger.append(
                AuditAction.INTEGRITY_RECORDED,
                resource_type,
                resource_id,
                metadata=metadata,
                actor=actor,
            )
            self._index(event, digest)
            return ContentOutcome(
                verification=ResourceVerification(
                    status=VerificationStatus.VERIFIED,
                    resource_type=resource_type,
                    resource_id=str(resource_id),
                    expected_hash=digest,
                    actual_hash=digest,
                    audit_event_id=event.audit_event_id,
                    recorded_at=event.timestamp,
                ),
                created=True,
                event=event,
            )

        verification = self._compare(existing, digest)
        event = self.ledger.append(
            AuditAction.INTEGRITY_VERIFIED,
            resource_type,
            resource_id,
            metadata={
                "result": verification.status.value,
                "content_hash": existing.content_hash,
                "observed_hash": digest,
                "recorded_by": existing.audit_event_id,
            },
            actor=actor,
        )
        return ContentOutcome(verification=verification, created=False, event=event)

    def verify_content(
        self,
        resource_type: ResourceType,
        resource_id: str,
        content: Any,
    ) -> Optional[ResourceVerification]:
        """Re-hash content and compare it to the commitment. Appends nothing.

        This is the read path behind ``GET .../verify``: a verification that
        changed the ledger would make every read a write and make the answer
        depend on how many times it had been asked.
        """
        existing = self.integrity_record(resource_type, resource_id)
        if existing is None:
            return None
        return self._compare(existing, content_hash(content))

    def verify_ingest_record(self, record: Any) -> Optional[ResourceVerification]:
        """Verify a stored ingestion record against its commitment (§6)."""
        return self.verify_content(
            ResourceType.INGEST_RECORD,
            record.record_id,
            ingest_record_content(record),
        )

    def _compare(
        self, existing: IntegrityRecord, digest: str
    ) -> ResourceVerification:
        if digest == existing.content_hash:
            return ResourceVerification(
                status=VerificationStatus.VERIFIED,
                resource_type=existing.resource_type,
                resource_id=existing.resource_id,
                expected_hash=existing.content_hash,
                actual_hash=digest,
                audit_event_id=existing.audit_event_id,
                recorded_at=existing.timestamp,
            )
        return ResourceVerification(
            status=VerificationStatus.INTEGRITY_COMPROMISED,
            resource_type=existing.resource_type,
            resource_id=existing.resource_id,
            expected_hash=existing.content_hash,
            actual_hash=digest,
            audit_event_id=existing.audit_event_id,
            recorded_at=existing.timestamp,
            failure=ChainFailure(
                audit_event_id=existing.audit_event_id,
                reason=FailureReason.CONTENT_HASH_MISMATCH,
                expected_hash=existing.content_hash,
                actual_hash=digest,
                message=(
                    "The content does not hash to the value committed when this "
                    "resource was recorded: it has changed since."
                ),
            ),
        )

    # ==================================================================
    # §8 chain verification, §10 reads
    # ==================================================================
    def verify_chain(self) -> ChainVerification:
        return self.ledger.verify()

    def events(
        self,
        *,
        action: Optional[AuditAction] = None,
        resource_type: Optional[ResourceType] = None,
        resource_id: Optional[str] = None,
    ) -> list[AuditEvent]:
        events = self.ledger.all_events()
        if action is not None:
            events = [e for e in events if e.action is action]
        if resource_type is not None:
            events = [e for e in events if e.resource_type is resource_type]
        if resource_id is not None:
            events = [e for e in events if e.resource_id == resource_id]
        return events

    def get(self, audit_event_id: str) -> Optional[AuditEvent]:
        return self.ledger.get(audit_event_id)

    def summary(self) -> dict[str, Any]:
        events = self.ledger.all_events()
        counts: dict[str, int] = {}
        for event in events:
            counts[event.action.value] = counts.get(event.action.value, 0) + 1
        return {
            "backend": self.ledger.backend_name,
            "persisted": self.ledger.persisted,
            "chain_length": len(events),
            "head_hash": self.ledger.head(),
            "integrity_records": len(self._integrity),
            "actions": counts,
        }


def build_audit_service(settings: Any) -> AuditService:
    """Construct the ledger, replaying a persisted chain if there is one (§9).

    Persistence is off by default, exactly as Phase 4.6's ``ingest_persist`` is:
    the records the ledger audits do not survive a restart unless persistence is
    turned on, so a ledger that persisted by itself would describe a graph that
    no longer exists. ``CNA_AUDIT_PERSIST=true`` (with ``CNA_INGEST_PERSIST=true``)
    is the deployed configuration, and the restart is verified in the tests.
    """
    path = settings.audit_dir / "ledger.jsonl" if settings.audit_persist else None
    ledger = LocalHashChainLedger(path)
    if path is not None:
        ledger.load()
    return AuditService(ledger)
