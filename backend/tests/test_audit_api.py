"""Phase 5 over HTTP: the audit endpoints, and ingestion actually being audited.

Like ``test_ingest_api.py`` this module builds its OWN app, so its submissions
cannot disturb the exact counts the Phase 1-4 suites assert. Everything here goes
through the real routes against the real pipeline: §15 asks for the endpoints to
be verified as endpoints, and for the audit filtering rules to be demonstrated on
data the application actually produced rather than on a hand-built fixture.
"""
from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.audit.models import GENESIS_PREVIOUS_HASH, content_hash
from app.main import create_app

BASE = "/api/v1/audit"
INGEST = "/api/v1/ingest"
PROV = {"source_name": "phase-5 test", "submitted_by": "pytest"}


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(scope="module")
def dataset_digest(client):
    """Hash every dataset CSV once, before any submission in this module runs."""
    directory = client.app.state.settings.dataset_dir
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*.csv"))
    }


def call_body(caller: int, callee: int, minute: int, **extra) -> dict:
    body = {
        "caller": {"person_id": caller},
        "callee": {"person_id": callee},
        "start_time": f"2026-08-21T11:{minute:02d}:00",
        "duration_sec": 180,
        "provenance": PROV,
    }
    body.update(extra)
    return body


@pytest.fixture(scope="module")
def accepted(client, dataset_digest):
    """One real accepted submission, shared by the integration assertions."""
    response = client.post(f"{INGEST}/call", json=call_body(301, 302, 1))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ACCEPTED"
    return body


# --- §9 the ledger is wired in ---------------------------------------------
def test_summary_reports_the_local_backend(client):
    body = client.get(f"{BASE}/summary").json()
    assert body["backend"] == "local_hash_chain"
    assert body["persisted"] is False  # default; CNA_AUDIT_PERSIST=true turns it on
    assert body["chain_length"] >= 0
    assert len(body["head_hash"]) == 64


def test_an_empty_chain_verifies_against_the_fixed_genesis(client):
    body = client.get(f"{BASE}/verify").json()
    assert body["status"] == "VERIFIED"
    assert body["genesis_previous_hash"] == GENESIS_PREVIOUS_HASH
    assert body["backend"] == "local_hash_chain"
    assert body["failure"] is None


# --- §11 ingestion is audited ----------------------------------------------
def test_an_accepted_submission_is_audited(client, accepted):
    ids = accepted["impact"]["audit_event_ids"]
    assert ids, "an accepted submission must produce at least a decision event"
    assert "audit_error" not in accepted["impact"]

    decision = client.get(f"{BASE}/events/{ids[0]}").json()
    assert decision["action"] == "INGEST_ACCEPTED"
    assert decision["resource_type"] == "ingest_record"
    assert decision["resource_id"] == accepted["record_id"]
    assert decision["actor"] == "system"
    assert decision["previous_hash"] and len(decision["current_hash"]) == 64
    assert len(decision["metadata"]["content_hash"]) == 64


def test_the_chain_verifies_after_real_submissions(client, accepted):
    body = client.get(f"{BASE}/verify").json()
    assert body["status"] == "VERIFIED"
    assert body["events_checked"] == body["chain_length"] >= len(
        accepted["impact"]["audit_event_ids"]
    )
    assert body["head_hash"] == client.get(f"{BASE}/summary").json()["head_hash"]


def test_a_new_relationship_is_audited(client, accepted):
    added = accepted["impact"]["graph"]["edges_added"]
    assert added, "a call between two new pairs must add an edge"
    events = client.get(
        f"{BASE}/events", params={"resource_id": added[0], "limit": 200}
    ).json()["events"]
    assert [e["action"] for e in events] == ["RELATIONSHIP_ADDED"]
    assert events[0]["resource_type"] == "relationship"


def test_reidentified_patterns_produce_no_audit_events(client, accepted):
    """The §5 suppression rule, measured on the corpus that motivated it."""
    impact = accepted["impact"]
    reidentified = impact.get("reidentified_pattern_count") or 0
    assert reidentified > 0, "this corpus re-identifies patterns on every accept"

    events = client.get(
        f"{BASE}/events", params={"action": "PATTERN_DETECTED", "limit": 200}
    ).json()
    new_ids = impact.get("new_pattern_ids") or []
    # Exactly as many pattern events as genuinely new patterns — never one per
    # re-identified pattern, which would be 50 links of noise per submission.
    assert events["total"] == len(new_ids)
    assert {e["resource_id"] for e in events["events"]} == set(new_ids)


def test_only_band_changes_are_audited(client, accepted):
    """Numeric drift inside a band is invisible to the ledger (§5)."""
    changes = accepted["impact"].get("priority_changes") or []
    band_changes = [
        c for c in changes if c.get("band_before") != c.get("band_after")
    ]
    numeric_only = [c for c in changes if c.get("band_before") == c.get("band_after")]

    events = client.get(
        f"{BASE}/events", params={"action": "PRIORITY_BAND_CHANGED", "limit": 200}
    ).json()
    assert events["total"] == len(band_changes)
    audited = {e["resource_id"] for e in events["events"]}
    assert audited == {c["entity_id"] for c in band_changes}
    for change in numeric_only:
        assert change["entity_id"] not in audited
    for event in events["events"]:
        assert event["metadata"]["band_before"] != event["metadata"]["band_after"]
        # The scores are committed, not published.
        assert len(event["metadata_hash"]) == 64
        assert "score_after" not in event["metadata"]


def test_a_duplicate_resubmission_is_audited_as_a_duplicate(client):
    body = call_body(303, 304, 2)
    first = client.post(f"{INGEST}/call", json=body).json()
    assert first["status"] == "ACCEPTED"
    second = client.post(f"{INGEST}/call", json=body).json()
    assert second["status"] == "DUPLICATE"

    event_id = second["impact"]["audit_event_ids"][0]
    event = client.get(f"{BASE}/events/{event_id}").json()
    assert event["action"] == "INGEST_DUPLICATE"
    assert event["resource_id"] == first["record_id"]
    assert event["metadata"]["original_status"] == "ACCEPTED"
    # A duplicate changes nothing, so the decision is the only event it produces.
    assert len(second["impact"]["audit_event_ids"]) == 1


def test_a_rejected_submission_is_audited_but_has_no_verifiable_record(client):
    rejected = client.post(
        f"{INGEST}/call", json={**call_body(305, 306, 3), "start_time": "not-a-time"}
    ).json()
    assert rejected["status"] == "REJECTED"

    event = client.get(
        f"{BASE}/events/{rejected['impact']['audit_event_ids'][0]}"
    ).json()
    assert event["action"] == "INGEST_REJECTED"
    assert event["metadata"]["reject_reason"]
    # Nothing was stored, so nothing can be re-derived and verified.
    assert "content_hash" not in event["metadata"]
    assert len(event["metadata_hash"]) == 64
    missing = client.get(
        f"{BASE}/records/ingest_record/{rejected['record_id']}/verify"
    )
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"


# --- §6, §8 resource verification ------------------------------------------
def test_a_stored_record_verifies_against_its_recorded_hash(client, accepted):
    response = client.get(
        f"{BASE}/records/ingest_record/{accepted['record_id']}/verify"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "VERIFIED"
    assert body["expected_hash"] == body["actual_hash"]
    assert body["failure"] is None
    assert body["audit_event_id"] == accepted["impact"]["audit_event_ids"][0]
    # Idempotent: verifying is a read, so it appends nothing.
    before = client.get(f"{BASE}/summary").json()["chain_length"]
    client.get(f"{BASE}/records/ingest_record/{accepted['record_id']}/verify")
    assert client.get(f"{BASE}/summary").json()["chain_length"] == before


def test_verifying_an_unknown_resource_is_a_404(client):
    response = client.get(f"{BASE}/records/ingest_record/{'0' * 64}/verify")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


# --- §7 the generic content hash and the tamper demonstration --------------
def test_content_is_committed_then_verified_then_detected_as_changed(client):
    original = {
        "case_reference": "demo-case-1",
        "entities": ["person:301", "person:302"],
        "relationship_count": 2,
        "generated_at": "2026-08-21T11:30:00",
    }

    created = client.post(
        f"{BASE}/records",
        json={
            "resource_id": "evidence-summary-1",
            "content": original,
            "content_type": "evidence_summary",
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["created"] is True
    assert body["verification"]["status"] == "VERIFIED"
    assert body["integrity_record"]["content_hash"] == content_hash(original)

    # Same content again: VERIFIED, and the commitment is unchanged.
    again = client.post(
        f"{BASE}/records", json={"resource_id": "evidence-summary-1", "content": original}
    ).json()
    assert again["created"] is False
    assert again["verification"]["status"] == "VERIFIED"
    assert again["integrity_record"]["content_hash"] == body["integrity_record"][
        "content_hash"
    ]

    # One field changed: INTEGRITY_COMPROMISED, with both hashes side by side.
    tampered = client.post(
        f"{BASE}/records",
        json={
            "resource_id": "evidence-summary-1",
            "content": {**original, "relationship_count": 3},
        },
    ).json()
    verification = tampered["verification"]
    assert tampered["created"] is False
    assert verification["status"] == "INTEGRITY_COMPROMISED"
    assert verification["expected_hash"] != verification["actual_hash"]
    assert verification["failure"]["reason"] == "content_hash_mismatch"
    # The commitment still stands — append-only means it was never replaced.
    assert tampered["integrity_record"]["content_hash"] == content_hash(original)
    # And the chain itself is intact: a changed document is not a changed ledger.
    assert client.get(f"{BASE}/verify").json()["status"] == "VERIFIED"


def test_the_content_of_a_commitment_never_appears_in_the_ledger(client):
    marker = "seven-five-three-confidential-marker"
    client.post(
        f"{BASE}/records",
        json={"resource_id": "evidence-summary-2", "content": {"note_body": marker}},
    )
    events = client.get(
        f"{BASE}/events", params={"resource_id": "evidence-summary-2", "limit": 200}
    ).json()
    assert events["total"] == 1
    assert marker not in str(events)
    assert marker not in str(client.get(f"{BASE}/summary").json())


def test_a_content_resource_cannot_be_verified_without_the_content(client):
    client.post(
        f"{BASE}/records",
        json={"resource_id": "evidence-summary-3", "content": {"case_reference": "d3"}},
    )
    response = client.get(f"{BASE}/records/content/evidence-summary-3/verify")
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "bad_request"
    # The client is told what to do instead, rather than being told VERIFIED.
    assert "POST /api/v1/audit/records" in error["message"]


def test_empty_and_oversized_content_are_rejected(client):
    empty = client.post(f"{BASE}/records", json={"resource_id": "e4", "content": {}})
    assert empty.status_code == 400

    limit = client.app.state.settings.audit_max_content_bytes
    oversized = client.post(
        f"{BASE}/records",
        json={"resource_id": "e5", "content": {"blob": "x" * (limit + 100)}},
    )
    assert oversized.status_code == 400
    assert oversized.json()["error"]["detail"]["limit"] == limit


def test_the_write_schema_forbids_unknown_fields(client):
    response = client.post(
        f"{BASE}/records",
        json={"resource_id": "e6", "content": {"a": 1}, "content_hash": "deadbeef"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# --- §10 the read surface ---------------------------------------------------
def test_events_are_returned_in_chain_order_and_paginate(client, accepted):
    # Guarantee at least four links regardless of the order the module runs in.
    for n in range(4):
        client.post(
            f"{BASE}/records",
            json={"resource_id": f"pagination-{n}", "content": {"n": n}},
        )
    first_page = client.get(f"{BASE}/events", params={"limit": 3, "offset": 0}).json()
    assert first_page["returned"] == 3
    assert [e["audit_event_id"] for e in first_page["events"]] == [
        "ae-000001",
        "ae-000002",
        "ae-000003",
    ]
    # Each event links to the one before it, in the order they are served.
    events = first_page["events"]
    assert events[0]["previous_hash"] == GENESIS_PREVIOUS_HASH
    assert events[1]["previous_hash"] == events[0]["current_hash"]
    assert events[2]["previous_hash"] == events[1]["current_hash"]

    second_page = client.get(f"{BASE}/events", params={"limit": 3, "offset": 3}).json()
    assert second_page["offset"] == 3
    assert second_page["events"][0]["audit_event_id"] == "ae-000004"
    assert second_page["total"] == first_page["total"]


def test_events_can_be_filtered_by_action_and_resource_type(client, accepted):
    accepted_events = client.get(
        f"{BASE}/events", params={"action": "INGEST_ACCEPTED", "limit": 200}
    ).json()
    assert accepted_events["total"] >= 1
    assert {e["action"] for e in accepted_events["events"]} == {"INGEST_ACCEPTED"}

    records = client.get(
        f"{BASE}/events", params={"resource_type": "ingest_record", "limit": 200}
    ).json()
    assert {e["resource_type"] for e in records["events"]} == {"ingest_record"}
    assert records["total"] >= accepted_events["total"]


def test_unknown_and_malformed_event_ids_are_reported_distinctly(client):
    assert client.get(f"{BASE}/events/ae-999999").status_code == 404
    assert client.get(f"{BASE}/events/not-an-event-id").status_code == 422


def test_an_unknown_action_filter_is_a_validation_error(client):
    response = client.get(f"{BASE}/events", params={"action": "USER_CLICKED_A_BUTTON"})
    assert response.status_code == 422


def test_the_ledger_exposes_no_mutating_route(client):
    """§1 append-only, checked against the published API surface."""
    schema = client.get("/openapi.json").json()["paths"]
    audit_paths = {
        path: {method.upper() for method in operations}
        for path, operations in schema.items()
        if path.startswith("/api/v1/audit")
    }
    assert audit_paths, "the audit routes must be published"
    for path, methods in audit_paths.items():
        assert not methods - {"GET", "POST"}, f"{path} exposes {methods}"
    posts = sorted(p for p, methods in audit_paths.items() if "POST" in methods)
    assert posts == ["/api/v1/audit/records"]
    # No PUT, PATCH or DELETE anywhere: an event cannot be edited or removed
    # through the API, because there is no route that could.
    assert sorted(audit_paths) == [
        "/api/v1/audit/events",
        "/api/v1/audit/events/{audit_event_id}",
        "/api/v1/audit/records",
        "/api/v1/audit/records/{resource_type}/{resource_id}/verify",
        "/api/v1/audit/summary",
        "/api/v1/audit/verify",
    ]


# --- §15 compatibility and dataset integrity -------------------------------
def test_phase_1_to_4_6_endpoints_still_answer(client, accepted):
    for path in (
        "/health",
        "/api/v1/data/summary",
        "/api/v1/persons?limit=1",
        "/api/v1/graph/summary",
        "/api/v1/analytics/persons/top?limit=1",
        "/api/v1/nlp/summary",
        "/api/v1/intelligence/summary",
        "/api/v1/intelligence/persons/top?limit=1",
        "/api/v1/intelligence/patterns?limit=1",
        f"{INGEST}/summary",
        f"{INGEST}/records?limit=1",
    ):
        assert client.get(path).status_code == 200, path


def test_the_dataset_is_untouched_by_auditing(client, dataset_digest):
    directory = client.app.state.settings.dataset_dir
    after = {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*.csv"))
    }
    assert dataset_digest, "the dataset digest must not be vacuously empty"
    assert after == dataset_digest
