"""Phase 5 unit tests: the chain, the filtering rules, and the privacy boundary.

No dataset and no app are loaded here. The chain, the canonicalization and the
"what deserves an audit event" decisions are all pure, so they are tested as pure
things; ``test_audit_api.py`` covers the same rules over HTTP against the real
pipeline.
"""
from __future__ import annotations

import hashlib
import json
import threading

import pytest

from app.audit.ledger import LocalHashChainLedger, PermissionedBlockchainLedger
from app.audit.models import (
    GENESIS_PREVIOUS_HASH,
    MAX_METADATA_VALUE_CHARS,
    AuditAction,
    AuditEvent,
    FailureReason,
    ResourceType,
    UnsafeMetadataError,
    VerificationStatus,
    assert_safe_metadata,
    compute_event_hash,
    content_hash,
    ingest_record_content,
    make_audit_event_id,
)
from app.audit.service import AuditService
from app.ingest.models import (
    IngestRecord,
    IngestStatus,
    Provenance,
    RejectReason,
    ReviewReason,
    SourceType,
    canonical_payload,
)

# Real values from the corpus, used to prove they never reach the ledger.
REAL_PHONE = "8600506062"
REAL_AADHAAR = "877449847333"
REAL_NARRATIVE = "Accused was seen transferring cash near the market"


@pytest.fixture
def ledger():
    return LocalHashChainLedger()


@pytest.fixture
def service(ledger):
    return AuditService(ledger)


def make_record(
    status: IngestStatus,
    *,
    impact: dict | None = None,
    review_reason: ReviewReason | None = None,
    reject_reason: RejectReason | None = None,
    record_id: str = "a" * 64,
) -> IngestRecord:
    """A record shaped exactly as the pipeline produces one, without running it."""
    return IngestRecord(
        record_id=record_id,
        source_type=SourceType.CALL,
        raw_payload={"caller": {"phone": REAL_PHONE}, "duration_sec": 415},
        normalized_payload={
            "caller": {"phone": REAL_PHONE, "aadhaar": REAL_AADHAAR},
            "duration_sec": 415,
            "note": REAL_NARRATIVE,
        },
        provenance=Provenance(source_type="manual", source_name="phase-5 test"),
        ingested_at="2026-08-28T10:00:00",
        status=status,
        validation_status="VALID" if status is not IngestStatus.REJECTED else "INVALID",
        resolution_status="RESOLVED",
        review_reason=review_reason,
        reject_reason=reject_reason,
        reason="test record",
        impact=impact if impact is not None else {"changed": False},
    )


# ======================================================================
# §2 canonical serialization and §7 content hashing
# ======================================================================
def test_canonicalization_is_the_phase_4_6_rule():
    """Key order does not matter; an omitted field and an explicit null agree."""
    a = {"b": 2, "a": 1, "nested": {"y": True, "x": None}}
    b = {"a": 1, "nested": {"x": None, "y": True}, "b": 2}
    assert canonical_payload(a) == canonical_payload(b)
    assert canonical_payload(a) == '{"a":1,"b":2,"nested":{"y":true}}'
    assert content_hash(a) == content_hash(b)
    # No whitespace can drift into the hash input.
    assert " " not in canonical_payload(a)


def test_content_hash_is_sha256_of_the_canonical_string():
    payload = {"case": "demo", "items": [1, 2]}
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert content_hash(payload) == expected
    assert len(content_hash(payload)) == 64


def test_content_hash_changes_when_one_field_changes():
    original = {"case": "demo", "entities": ["person:12"], "verdict": "open"}
    modified = {**original, "verdict": "closed"}
    assert content_hash(original) != content_hash(modified)


# ======================================================================
# §3 genesis
# ======================================================================
def test_genesis_is_sha256_of_the_empty_string():
    assert GENESIS_PREVIOUS_HASH == hashlib.sha256(b"").hexdigest()
    # Pinned literally: a changed genesis would invalidate every published head.
    assert GENESIS_PREVIOUS_HASH == (
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )


def test_first_event_links_to_genesis(ledger):
    assert ledger.head() == GENESIS_PREVIOUS_HASH
    event = ledger.append(AuditAction.INTEGRITY_RECORDED, ResourceType.CONTENT, "c1")
    assert event.previous_hash == GENESIS_PREVIOUS_HASH
    assert event.audit_event_id == "ae-000001"


# ======================================================================
# §1, §4 chaining and append-only semantics
# ======================================================================
def test_each_event_links_to_its_predecessor(ledger):
    first = ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p1")
    second = ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p2")
    third = ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p3")

    assert second.previous_hash == first.current_hash
    assert third.previous_hash == second.current_hash
    assert ledger.head() == third.current_hash
    assert [e.audit_event_id for e in ledger.all_events()] == [
        "ae-000001",
        "ae-000002",
        "ae-000003",
    ]


def test_current_hash_is_content_plus_previous_hash(ledger):
    event = ledger.append(
        AuditAction.PRIORITY_BAND_CHANGED,
        ResourceType.PERSON,
        "person:21",
        metadata={"band_before": "LOW", "band_after": "MEDIUM"},
    )
    assert event.current_hash == hashlib.sha256(
        (canonical_payload(event.content()) + event.previous_hash).encode("utf-8")
    ).hexdigest()
    assert event.current_hash == compute_event_hash(event.content(), event.previous_hash)


def test_ledger_exposes_no_way_to_change_or_remove_an_event(ledger):
    """Append-only is structural: the interface has no mutating verb."""
    for verb in ("update", "delete", "remove", "truncate", "clear", "replace"):
        assert not hasattr(ledger, verb)


def test_timestamp_is_covered_by_the_hash(ledger):
    event = ledger.append(AuditAction.INTEGRITY_RECORDED, ResourceType.CONTENT, "c1")
    event.timestamp = "2020-01-01T00:00:00"
    assert event.recompute_hash() != event.current_hash


# ======================================================================
# §4 single writer
# ======================================================================
def test_concurrent_appends_produce_one_valid_chain(ledger):
    """32 threads, 4 appends each: one chain, no fork, no interleaved write."""
    errors: list[BaseException] = []
    start = threading.Barrier(32)

    def worker(n: int) -> None:
        try:
            start.wait(timeout=10)
            for i in range(4):
                ledger.append(
                    AuditAction.RELATIONSHIP_ADDED,
                    ResourceType.RELATIONSHIP,
                    f"rel-{n}-{i}",
                )
        except BaseException as exc:  # pragma: no cover - only on a real failure
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(32)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors
    events = ledger.all_events()
    assert len(events) == 128
    # Ids are dense and sequential: no gaps, no repeats, no reordering.
    assert [e.audit_event_id for e in events] == [
        make_audit_event_id(i) for i in range(1, 129)
    ]
    # Every resource appended exactly once — nothing was lost under contention.
    assert len({e.resource_id for e in events}) == 128
    result = ledger.verify()
    assert result.status is VerificationStatus.VERIFIED
    assert result.events_checked == 128


# ======================================================================
# §8 verification and tamper detection
# ======================================================================
def test_empty_chain_verifies(ledger):
    result = ledger.verify()
    assert result.status is VerificationStatus.VERIFIED
    assert result.events_checked == 0
    assert result.head_hash == GENESIS_PREVIOUS_HASH


def test_modified_event_is_detected(ledger):
    ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p1")
    target = ledger.append(
        AuditAction.PRIORITY_BAND_CHANGED,
        ResourceType.PERSON,
        "person:21",
        metadata={"band_before": "LOW", "band_after": "MEDIUM"},
    )
    ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p2")

    target.metadata["band_after"] = "HIGH"
    result = ledger.verify()
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.HASH_MISMATCH
    assert result.failure.audit_event_id == "ae-000002"
    assert result.failure.expected_hash != result.failure.actual_hash
    assert result.events_checked == 2  # stops at the earliest break


def test_broken_link_is_detected(ledger):
    ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p1")
    second = ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p2")
    # Re-link and re-hash so the event itself is internally consistent: only the
    # chain is wrong, which is the harder case to catch.
    second.previous_hash = GENESIS_PREVIOUS_HASH
    second.current_hash = second.recompute_hash()

    result = ledger.verify()
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.BROKEN_LINK
    assert result.failure.audit_event_id == "ae-000002"


def test_removed_event_is_detected(ledger):
    for i in range(3):
        ledger.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, f"p{i}")
    del ledger._events[1]  # an event quietly dropped from the middle

    result = ledger.verify()
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.SEQUENCE_MISMATCH
    assert result.failure.expected_hash == "ae-000002"
    assert result.failure.actual_hash == "ae-000003"


# ======================================================================
# §6, §7 content integrity
# ======================================================================
def test_recording_content_commits_a_hash_without_storing_content(service):
    content = {"case": "demo-1", "summary_items": 3, "entities": ["person:12"]}
    outcome = service.record_content("evidence-1", content, content_type="evidence_summary")

    assert outcome.created is True
    assert outcome.verification.status is VerificationStatus.VERIFIED
    assert outcome.event.action is AuditAction.INTEGRITY_RECORDED
    assert outcome.event.metadata["content_hash"] == content_hash(content)

    # The content itself appears nowhere in the ledger.
    serialized = json.dumps([e.as_dict() for e in service.ledger.all_events()])
    assert "demo-1" not in serialized


def test_unchanged_content_verifies(service):
    content = {"case": "demo-2", "verdict": "open"}
    service.record_content("evidence-2", content)
    result = service.verify_content(ResourceType.CONTENT, "evidence-2", content)
    assert result.status is VerificationStatus.VERIFIED
    assert result.expected_hash == result.actual_hash


def test_one_changed_field_reports_integrity_compromised(service):
    content = {"case": "demo-3", "entities": ["person:12"], "verdict": "open"}
    service.record_content("evidence-3", content)

    result = service.verify_content(
        ResourceType.CONTENT, "evidence-3", {**content, "verdict": "closed"}
    )
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.CONTENT_HASH_MISMATCH
    assert result.expected_hash != result.actual_hash
    # The chain itself is untouched: a tampered *document* is not a tampered ledger.
    assert service.verify_chain().status is VerificationStatus.VERIFIED


def test_verify_content_appends_nothing(service):
    content = {"case": "demo-4"}
    service.record_content("evidence-4", content)
    before = len(service.ledger)
    for _ in range(3):
        service.verify_content(ResourceType.CONTENT, "evidence-4", content)
    assert len(service.ledger) == before


def test_re_recording_does_not_overwrite_the_commitment(service):
    original = {"case": "demo-5", "verdict": "open"}
    service.record_content("evidence-5", original)
    committed = service.integrity_record(ResourceType.CONTENT, "evidence-5")

    outcome = service.record_content("evidence-5", {**original, "verdict": "closed"})
    assert outcome.created is False
    assert outcome.verification.status is VerificationStatus.INTEGRITY_COMPROMISED
    # Same commitment as before: append-only means the first hash stands.
    still = service.integrity_record(ResourceType.CONTENT, "evidence-5")
    assert still.content_hash == committed.content_hash
    assert still.audit_event_id == committed.audit_event_id
    # ...and the attempt is itself on the record.
    assert outcome.event.action is AuditAction.INTEGRITY_VERIFIED
    assert outcome.event.metadata["result"] == "INTEGRITY_COMPROMISED"


def test_verify_content_for_an_unknown_resource_returns_none(service):
    assert service.verify_content(ResourceType.CONTENT, "nope", {"a": 1}) is None


def test_ingest_record_content_excludes_derived_state(service):
    """Only the immutable observation is hashed, never live Phase 4 output."""
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": ["rel-1"], "edges_updated": []},
            "new_pattern_ids": ["pattern-1"],
            "priority_changes": [],
        },
    )
    snapshot = ingest_record_content(record)
    assert set(snapshot) == {
        "record_id",
        "source_type",
        "status",
        "ingested_at",
        "normalized_payload",
        "provenance",
    }
    # Scores, patterns and communities all move on every accepted record; hashing
    # them would report a compromise for normal operation.
    assert "impact" not in snapshot


def test_stored_record_verifies_and_a_modified_one_does_not(service):
    record = make_record(IngestStatus.ACCEPTED, impact={"changed": False})
    service.record_submission(record)

    assert service.verify_ingest_record(record).status is VerificationStatus.VERIFIED
    record.normalized_payload["duration_sec"] = 999
    result = service.verify_ingest_record(record)
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.CONTENT_HASH_MISMATCH


# ======================================================================
# §5, §11 what gets audited
# ======================================================================
def test_accepted_submission_is_audited(service):
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": ["rel-a"], "edges_updated": ["rel-b", "rel-c"]},
        },
    )
    events = service.record_submission(record)

    decision = events[0]
    assert decision.action is AuditAction.INGEST_ACCEPTED
    assert decision.resource_type is ResourceType.INGEST_RECORD
    assert decision.resource_id == record.record_id
    assert decision.actor == "system"
    assert decision.metadata["new_relationships"] == 1
    assert decision.metadata["merged_relationships"] == 2
    assert decision.metadata["content_hash"] == content_hash(
        ingest_record_content(record)
    )


def test_duplicate_review_and_rejected_are_each_audited(service):
    duplicate = make_record(
        IngestStatus.DUPLICATE,
        record_id="b" * 64,
        impact={"changed": False, "original_status": "ACCEPTED", "resubmissions": 2},
    )
    review = make_record(
        IngestStatus.REVIEW_REQUIRED,
        record_id="c" * 64,
        review_reason=ReviewReason.AMBIGUOUS_MATCH,
    )
    rejected = make_record(
        IngestStatus.REJECTED,
        record_id="d" * 64,
        reject_reason=RejectReason.INVALID_FIELD,
    )

    dup_event = service.record_submission(duplicate)[0]
    rev_event = service.record_submission(review)[0]
    rej_event = service.record_submission(rejected)[0]

    assert dup_event.action is AuditAction.INGEST_DUPLICATE
    assert dup_event.metadata["original_status"] == "ACCEPTED"
    assert dup_event.metadata["resubmissions"] == 2

    assert rev_event.action is AuditAction.INGEST_REVIEW_REQUIRED
    assert rev_event.metadata["review_reason"] == "AMBIGUOUS_MATCH"

    assert rej_event.action is AuditAction.INGEST_REJECTED
    assert rej_event.metadata["reject_reason"] == "INVALID_FIELD"
    # Nothing was stored, so there is no verifiable commitment — but the event
    # still commits to what was submitted.
    assert "content_hash" not in rej_event.metadata
    assert rej_event.metadata_hash is not None
    assert service.integrity_record(ResourceType.INGEST_RECORD, "d" * 64) is None


def test_only_genuinely_new_relationships_are_audited(service):
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {
                "edges_added": ["CALLED~person:1~person:2"],
                # A repeated observation merged into an edge that already existed:
                # more evidence, not a new relationship.
                "edges_updated": ["CALLED~person:3~person:4"],
            },
        },
    )
    events = service.record_submission(record)
    relationship_events = [
        e for e in events if e.action is AuditAction.RELATIONSHIP_ADDED
    ]
    assert [e.resource_id for e in relationship_events] == ["CALLED~person:1~person:2"]


def test_new_patterns_are_audited_and_reidentified_ones_are_not(service):
    """The rule that keeps the ledger readable (§5).

    50 patterns re-identify on a single accepted call in this corpus because
    community labels move. None of them is a new detection.
    """
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": [], "edges_updated": []},
            "new_pattern_ids": ["pattern-new-1"],
            "reidentified_pattern_count": 50,
            "cleared_pattern_ids": ["pattern-gone-1"],
        },
    )
    events = service.record_submission(record)
    pattern_events = [e for e in events if e.action is AuditAction.PATTERN_DETECTED]
    assert [e.resource_id for e in pattern_events] == ["pattern-new-1"]
    assert len(events) == 2  # the decision and exactly one pattern


def test_no_pattern_events_when_only_reidentification_happened(service):
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": [], "edges_updated": []},
            "new_pattern_ids": [],
            "reidentified_pattern_count": 50,
        },
    )
    events = service.record_submission(record)
    assert len(events) == 1
    assert events[0].action is AuditAction.INGEST_ACCEPTED


def test_band_change_is_audited_and_a_numeric_move_is_not(service):
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": [], "edges_updated": []},
            "priority_changes": [
                # A real triage change.
                {
                    "person_id": 21,
                    "entity_id": "person:21",
                    "score_before": 39.0,
                    "score_after": 41.0,
                    "band_before": "LOW",
                    "band_after": "MEDIUM",
                },
                # 68 -> 69: not a decision, not audited.
                {
                    "person_id": 77,
                    "entity_id": "person:77",
                    "score_before": 68.0,
                    "score_after": 69.0,
                    "band_before": "MEDIUM",
                    "band_after": "MEDIUM",
                },
                # 69 -> 68: the reverse, equally uninteresting.
                {
                    "person_id": 78,
                    "entity_id": "person:78",
                    "score_before": 69.0,
                    "score_after": 68.0,
                    "band_before": "MEDIUM",
                    "band_after": "MEDIUM",
                },
                # A reverse transition, which is a triage change.
                {
                    "person_id": 90,
                    "entity_id": "person:90",
                    "score_before": 71.0,
                    "score_after": 66.0,
                    "band_before": "HIGH",
                    "band_after": "MEDIUM",
                },
            ],
        },
    )
    events = service.record_submission(record)
    band_events = [e for e in events if e.action is AuditAction.PRIORITY_BAND_CHANGED]
    assert [e.resource_id for e in band_events] == ["person:21", "person:90"]
    assert band_events[0].metadata == {
        "band_before": "LOW",
        "band_after": "MEDIUM",
        "record_id": "a" * 64,
    }
    # The scores are committed, not published.
    assert band_events[0].metadata_hash == content_hash(
        {"score_before": 39.0, "score_after": 41.0}
    )
    assert "score_after" not in band_events[0].metadata


def test_submission_events_are_appended_in_a_fixed_order(service):
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": ["rel-1"], "edges_updated": []},
            "new_pattern_ids": ["pattern-1"],
            "priority_changes": [
                {
                    "entity_id": "person:21",
                    "person_id": 21,
                    "score_before": 39.0,
                    "score_after": 41.0,
                    "band_before": "LOW",
                    "band_after": "MEDIUM",
                }
            ],
        },
    )
    events = service.record_submission(record)
    assert [e.action for e in events] == [
        AuditAction.INGEST_ACCEPTED,
        AuditAction.RELATIONSHIP_ADDED,
        AuditAction.PATTERN_DETECTED,
        AuditAction.PRIORITY_BAND_CHANGED,
    ]
    assert service.verify_chain().status is VerificationStatus.VERIFIED


# ======================================================================
# §1 privacy boundary
# ======================================================================
def test_no_sensitive_value_reaches_the_ledger(service):
    """Asserted on values, not on key names: the payload is in the record."""
    record = make_record(
        IngestStatus.ACCEPTED,
        impact={
            "changed": True,
            "graph": {"edges_added": ["rel-1"], "edges_updated": []},
            "priority_changes": [
                {
                    "entity_id": "person:21",
                    "person_id": 21,
                    "score_before": 39.0,
                    "score_after": 41.0,
                    "band_before": "LOW",
                    "band_after": "MEDIUM",
                }
            ],
        },
    )
    service.record_submission(record)
    service.record_submission(
        make_record(IngestStatus.REJECTED, record_id="e" * 64,
                   reject_reason=RejectReason.INVALID_FIELD)
    )

    serialized = json.dumps([e.as_dict() for e in service.ledger.all_events()])
    for secret in (REAL_PHONE, REAL_AADHAAR, REAL_NARRATIVE, "39.0", "41.0"):
        assert secret not in serialized, f"{secret!r} leaked into the ledger"
    # Payload field names too — a hex digest can contain any digit sequence, so
    # short numbers are checked by the key that would have carried them.
    for key in ("duration_sec", "caller", "note", "aadhaar", "phone"):
        assert key not in serialized, f"payload field {key!r} leaked into the ledger"


def test_metadata_guard_rejects_sensitive_keys():
    for key in ("phone", "caller_phone", "aadhaar", "raw_payload", "narrative_text",
                "amount_inr", "secret", "email"):
        with pytest.raises(UnsafeMetadataError):
            assert_safe_metadata({key: "x"})


def test_metadata_guard_rejects_identifier_shaped_values():
    with pytest.raises(UnsafeMetadataError):
        assert_safe_metadata({"reference": REAL_PHONE})
    with pytest.raises(UnsafeMetadataError):
        assert_safe_metadata({"reference": int(REAL_AADHAAR)})
    with pytest.raises(UnsafeMetadataError):
        assert_safe_metadata({"reason": "x" * (MAX_METADATA_VALUE_CHARS + 1)})


def test_metadata_guard_allows_hashes_and_enum_values():
    assert_safe_metadata(
        {
            "content_hash": content_hash({"a": 1}),
            "record_id": "0123456789abcdef" * 4,
            "decision": "ACCEPTED",
            "band_after": "MEDIUM",
            "resubmissions": 2,
            "graph_changed": True,
            "review_reason": None,
        }
    )


def test_an_unsafe_event_never_enters_the_chain(ledger):
    with pytest.raises(UnsafeMetadataError):
        ledger.append(
            AuditAction.INGEST_ACCEPTED,
            ResourceType.INGEST_RECORD,
            "r1",
            metadata={"phone": REAL_PHONE},
        )
    assert len(ledger) == 0
    assert ledger.head() == GENESIS_PREVIOUS_HASH


# ======================================================================
# §9 persistence
# ======================================================================
def test_chain_survives_a_restart_and_still_verifies(tmp_path):
    path = tmp_path / "ledger.jsonl"
    first = LocalHashChainLedger(path)
    service = AuditService(first)
    service.record_content("evidence-restart", {"case": "demo", "verdict": "open"})
    service.record_submission(make_record(IngestStatus.ACCEPTED))
    head = first.head()
    assert len(first) == 2

    # A new process: nothing in memory, everything from disk.
    second = LocalHashChainLedger(path)
    assert second.load() == 2
    restored = AuditService(second)

    assert len(second) == 2
    assert second.head() == head
    assert second.verify().status is VerificationStatus.VERIFIED
    # The commitment index is rebuilt from the chain, not from a second store.
    assert restored.integrity_record(
        ResourceType.CONTENT, "evidence-restart"
    ).content_hash == content_hash({"case": "demo", "verdict": "open"})
    assert restored.verify_content(
        ResourceType.CONTENT, "evidence-restart", {"case": "demo", "verdict": "open"}
    ).status is VerificationStatus.VERIFIED


def test_appending_after_a_restart_continues_the_same_chain(tmp_path):
    path = tmp_path / "ledger.jsonl"
    first = LocalHashChainLedger(path)
    first.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p1")

    second = LocalHashChainLedger(path)
    second.load()
    event = second.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p2")
    assert event.audit_event_id == "ae-000002"
    assert second.verify().status is VerificationStatus.VERIFIED

    third = LocalHashChainLedger(path)
    third.load()
    assert len(third) == 2
    assert third.verify().status is VerificationStatus.VERIFIED


def test_an_edited_ledger_file_is_detected_after_a_restart(tmp_path):
    """The file is the attack surface persistence adds, so it is tested as one."""
    path = tmp_path / "ledger.jsonl"
    first = LocalHashChainLedger(path)
    first.append(AuditAction.PATTERN_DETECTED, ResourceType.PATTERN, "p1")
    first.append(
        AuditAction.PRIORITY_BAND_CHANGED,
        ResourceType.PERSON,
        "person:21",
        metadata={"band_before": "LOW", "band_after": "MEDIUM"},
    )

    lines = path.read_text(encoding="utf-8").splitlines()
    edited = json.loads(lines[1])
    edited["metadata"]["band_after"] = "HIGH"
    lines[1] = json.dumps(edited)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    reloaded = LocalHashChainLedger(path)
    reloaded.load()
    result = reloaded.verify()
    assert result.status is VerificationStatus.INTEGRITY_COMPROMISED
    assert result.failure.reason is FailureReason.HASH_MISMATCH
    assert result.failure.audit_event_id == "ae-000002"


def test_persistence_is_off_by_default(ledger):
    assert ledger.persisted is False
    assert ledger.backend_name == "local_hash_chain"


# ======================================================================
# §13 the future-blockchain seam
# ======================================================================
def test_permissioned_blockchain_ledger_is_declared_but_not_implemented():
    with pytest.raises(NotImplementedError, match="local tamper-evident audit ledger"):
        PermissionedBlockchainLedger()
    # Same interface, so swapping implementations is a constructor change.
    for method in ("append", "all_events", "get", "head", "verify"):
        assert hasattr(PermissionedBlockchainLedger, method)


def test_event_round_trips_through_json(ledger):
    event = ledger.append(
        AuditAction.INTEGRITY_RECORDED,
        ResourceType.CONTENT,
        "c1",
        metadata={"content_hash": content_hash({"a": 1})},
    )
    restored = AuditEvent.from_dict(json.loads(json.dumps(event.as_dict())))
    assert restored.as_dict() == event.as_dict()
    assert restored.recompute_hash() == event.current_hash
    assert restored.sequence == 1
