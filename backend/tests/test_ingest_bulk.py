"""Phase 6.2: CSV preview, confirm and reject over HTTP.

Like ``test_ingest_api.py`` this module builds its OWN app, so the exact counts
the Phase 1-4 suites assert cannot be disturbed by anything committed here.

The whole point of the feature is that a preview writes nothing, so most of these
tests are written as before/after comparisons of the live graph, the live store
and the audit chain around a preview call.
"""
from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.ingest import bulk
from app.ingest.models import SourceType
from app.main import create_app

BASE = "/api/v1/ingest"
STAGES = [
    "received",
    "validating",
    "checking_duplicates",
    "building_preview",
    "analyzing_preview",
    "preview_ready",
]

HEADER_FIELDS = (
    "caller_person_id",
    "callee_person_id",
    "callee_name",
    "callee_phone",
    "start_time",
    "duration_sec",
    "cell_tower_id",
)
HEADER = ",".join(HEADER_FIELDS)


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(scope="module")
def dataset_digest(client):
    directory = client.app.state.settings.dataset_dir
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }


def row(**values: object) -> str:
    return ",".join(str(values.get(field, "")) for field in HEADER_FIELDS)


def csv_rows(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


def call_row(caller: int, callee: int, minute: int, duration: int = 90) -> str:
    return row(
        caller_person_id=caller,
        callee_person_id=callee,
        start_time=f"2026-08-24T11:{minute:02d}:00",
        duration_sec=duration,
        cell_tower_id=12,
    )


def upload(client, content: str, source_type: str = "call", name: str = "batch.csv"):
    return client.post(
        f"{BASE}/bulk/{source_type}/preview",
        json={"filename": name, "content": content},
    )


def state(client) -> dict:
    """Everything a preview is forbidden to change."""
    app = client.app
    graph = app.state.graph.store
    ingest = app.state.ingest.store
    audit = app.state.audit
    return {
        "nodes": graph.node_count(),
        "edges": graph.edge_count(),
        "records": len(ingest),
        "live_rows": ingest.live_counts(),
        "narrative_edges": app.state.nlp.integrator.store.edge_count(),
        "chain": len(audit.ledger.all_events()) if audit else 0,
    }


def bulk_stages(client, import_id: str) -> list[str]:
    return [
        event.data["stage"]
        for event in client.app.state.ingest.bus.recent()
        if event.event_type.value == "bulk_preview"
        and event.data["import_id"] == import_id
    ]


# --- preview ----------------------------------------------------------------
def test_preview_classifies_every_row_and_writes_nothing(client):
    before = state(client)
    content = csv_rows(
        call_row(201, 202, 1),
        call_row(201, 202, 1),  # the same observation again, in the same file
        call_row(203, 204, 2, duration=-5),  # unusable value
        row(  # a party that resolves to nobody
            caller_person_id=205,
            callee_name="Zarvix Quorlan",
            start_time="2026-08-24T11:03:00",
            duration_sec=60,
            cell_tower_id=12,
        ),
    )

    response = upload(client, content)
    assert response.status_code == 200
    body = response.json()

    assert body["counts"] == {
        "total": 4,
        "new_valid": 1,
        "duplicate": 1,
        "review_required": 1,
        "rejected": 1,
    }
    assert body["commit_applicable"] is True
    assert [r["row"] for r in body["duplicate_rows"]] == [2]
    assert body["duplicate_rows"][0]["reason"] == (
        "Identical to an earlier row in this file."
    )
    assert [r["row"] for r in body["rejected_rows"]] == [3]
    assert "duration_sec" in body["rejected_rows"][0]["reason"]
    assert [r["row"] for r in body["review_required_rows"]] == [4]
    assert body["review_required_rows"][0]["reason"]

    # The preview reports the overlay, which is ahead of the live graph.
    assert body["metrics_preview"]["graph"]["edge_count"] > before["edges"]
    assert body["network_preview"]["nodes"]
    assert state(client) == before

    assert bulk_stages(client, body["import_id"]) == STAGES


def test_preview_row_summaries_mask_an_identifier(client):
    """A summary labels a reference the way every other explanation does."""
    content = csv_rows(
        row(
            caller_person_id=206,
            callee_phone="9000000001",
            start_time="2026-08-24T11:20:00",
            duration_sec=60,
            cell_tower_id=12,
        )
    )
    body = upload(client, content).json()
    assert body["counts"]["review_required"] == 1
    summary = body["review_required_rows"][0]["summary"]
    assert "0001" in summary
    assert "9000000001" not in summary


def test_preview_reports_no_patterns_when_the_detectors_assert_none(client):
    """An all-duplicate file changes nothing, so there is nothing to report."""
    content = csv_rows(call_row(207, 208, 5), call_row(207, 208, 5))
    first = upload(client, content).json()
    assert first["counts"]["new_valid"] == 1
    client.post(f"{BASE}/bulk/{first['import_id']}/confirm").raise_for_status()

    again = upload(client, content).json()
    assert again["counts"]["new_valid"] == 0
    assert again["counts"]["duplicate"] == 2
    assert again["commit_applicable"] is False
    assert again["suspicious_patterns_preview"]["patterns"] == []
    assert again["suspicious_patterns_preview"]["total"] == 0
    assert again["metrics_preview"]["note"]
    assert "analytics" not in again["metrics_preview"]
    for row in again["duplicate_rows"]:
        assert "already" in row["reason"].lower() or "identical" in row["reason"].lower()


def test_preview_carries_the_overlay_centralities_and_communities(client):
    """The preview's own tables read two fields, and both are the analytics object
    the rest of ``metrics_preview`` already comes from — a ranking and a summary of
    the one overlay, not a second computation and not a second graph."""
    content = csv_rows(call_row(214, 215, 9), call_row(215, 214, 10))
    body = upload(client, content).json()
    metrics = body["metrics_preview"]

    players = metrics["key_players"]
    assert players and len(players) <= bulk.KEY_PLAYERS
    for player in players:
        assert player["entity_id"].startswith("person:")
        # Every column the table shows is a value the analytics pass produced.
        for field in ("degree_centrality", "betweenness", "pagerank"):
            assert isinstance(player[field], (int, float))
        assert isinstance(player["in_import"], bool)
    # Ranked, descending, by the metric asked for.
    degrees = [player["degree"] for player in players]
    assert degrees == sorted(degrees, reverse=True)

    detected = metrics["communities"]["detected"]
    assert len(detected) == metrics["communities"]["count"]
    for community in detected:
        # The sample is the backend's, so the client can state the real remainder.
        assert 0 < len(community["members_sample"]) <= community["size"]
        assert len(community["member_names"]) == len(community["members_sample"])

    # Read-only: nothing about these two fields writes to the live graph.
    client.post(f"{BASE}/bulk/{body['import_id']}/reject").raise_for_status()


# --- confirm ----------------------------------------------------------------
def test_confirm_commits_exactly_the_previewed_rows(client):
    before = state(client)
    content = csv_rows(call_row(210, 211, 7), call_row(212, 213, 8))
    preview = upload(client, content).json()
    assert preview["counts"]["new_valid"] == 2
    previewed_edges = preview["metrics_preview"]["graph"]["edge_count"]

    response = client.post(f"{BASE}/bulk/{preview['import_id']}/confirm")
    assert response.status_code == 200
    body = response.json()

    assert body["counts"]["imported"] == 2
    assert body["skipped"] == []
    assert len(body["record_ids"]) == 2
    assert body["graph_totals"]["edges"] == previewed_edges
    assert body["recompute_error"] is None
    assert body["recompute_cost_ms"]["total_ms"] > 0

    after = state(client)
    assert after["edges"] == previewed_edges
    assert after["records"] == before["records"] + 2
    assert after["live_rows"]["calls"] == before["live_rows"]["calls"] + 2

    # One audit event for the import, not one per row.
    assert after["chain"] == before["chain"] + 1
    event = client.app.state.audit.ledger.all_events()[-1]
    assert event.action.value == "INGEST_BULK_CONFIRMED"
    assert event.resource_type.value == "ingest_import"
    assert event.resource_id == preview["import_id"]
    assert event.metadata["manifest_hash"] == body["manifest_hash"]
    assert event.metadata["imported_count"] == 2
    assert body["audit_event_id"] == event.audit_event_id
    assert client.get("/api/v1/audit/verify").json()["status"] == "VERIFIED"

    # Committing is a one-shot: the preview is gone.
    assert client.post(f"{BASE}/bulk/{preview['import_id']}/confirm").status_code == 404


def test_committed_rows_are_readable_through_the_existing_record_endpoints(client):
    content = csv_rows(call_row(214, 215, 9))
    preview = upload(client, content).json()
    body = client.post(f"{BASE}/bulk/{preview['import_id']}/confirm").json()
    record_id = body["record_ids"][0]

    record = client.get(f"{BASE}/{record_id}")
    assert record.status_code == 200
    assert record.json()["status"] == "ACCEPTED"
    impact = client.get(f"{BASE}/{record_id}/impact").json()["impact"]
    assert impact["bulk_import_id"] == preview["import_id"]
    assert impact["graph_totals"] == body["graph_totals"]


# --- reject / unknown ids ---------------------------------------------------
def test_reject_discards_the_preview_and_writes_nothing(client):
    before = state(client)
    content = csv_rows(call_row(220, 221, 11), call_row(222, 223, 12))
    preview = upload(client, content).json()
    assert preview["counts"]["new_valid"] == 2

    response = client.post(f"{BASE}/bulk/{preview['import_id']}/reject")
    assert response.status_code == 200
    assert response.json()["discarded"] is True
    assert state(client) == before

    # A rejected import cannot be committed afterwards.
    assert client.post(f"{BASE}/bulk/{preview['import_id']}/confirm").status_code == 404
    # Rejecting again is not an error.
    second = client.post(f"{BASE}/bulk/{preview['import_id']}/reject").json()
    assert second["discarded"] is False
    assert state(client) == before


def test_confirming_an_unknown_import_is_a_clean_404(client):
    before = state(client)
    response = client.post(f"{BASE}/bulk/{'0' * 64}/confirm")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert state(client) == before


def test_a_bad_upload_is_a_clean_400(client):
    before = state(client)
    assert upload(client, "not,a,known,header\n1,2,3,4\n").status_code == 400
    assert upload(client, HEADER + "\n").status_code == 400
    assert upload(client, "x", source_type="unknown").status_code == 400
    assert state(client) == before


# --- the column names the dataset itself uses -------------------------------
# The corpus spells a party `caller_id` / `sender_id` / `complainant_id`; a single
# submission posts `caller: {person_id: …}`, so the flat column for it is
# `caller_person_id`. Both spellings name the same thing, and a file exported from
# the dataset has to import as itself — otherwise every row fails on a *column
# name*, which is not a fact about the observation in it.
NATIVE_CALL_HEADER = "caller_id,callee_id,start_time,duration_sec,cell_tower_id"


def native_calls(*pairs: tuple[int, int, int]) -> str:
    lines = [
        f"{caller},{callee},2026-08-24T16:{minute:02d}:00,120,12"
        for caller, callee, minute in pairs
    ]
    return "\n".join([NATIVE_CALL_HEADER, *lines]) + "\n"


def test_the_dataset_spelling_of_a_person_column_is_read(client):
    """`caller_id`/`callee_id` identify the parties, as they do everywhere else."""
    before = state(client)
    body = upload(client, native_calls((241, 242, 1), (243, 244, 2))).json()

    assert body["counts"] == {
        "total": 2,
        "new_valid": 2,
        "duplicate": 0,
        "review_required": 0,
        "rejected": 0,
    }
    assert body["rejected_rows"] == []
    # The parties were resolved to the persons those ids name, not merely parsed:
    # all four are anchors of the preview, and the overlay is ahead of the graph.
    entity_ids = {node["entity_id"] for node in body["network_preview"]["nodes"]}
    assert {"person:241", "person:242", "person:243", "person:244"} <= entity_ids
    assert body["network_preview"]["meta"]["anchors"] == 4
    assert body["metrics_preview"]["graph"]["edge_count"] > before["edges"]
    assert state(client) == before


def test_both_spellings_of_a_party_describe_the_same_observation(client):
    """One observation, two headers: the second upload is a known duplicate.

    Nothing weaker would do. Matching counts could be reached by two different
    readings of the same file; an identical record id cannot, because the id is the
    hash of the normalized payload.
    """
    native = upload(client, native_calls((245, 246, 3))).json()
    assert native["counts"]["new_valid"] == 1
    committed = client.post(f"{BASE}/bulk/{native['import_id']}/confirm").json()

    explicit = upload(
        client,
        csv_rows(
            row(
                caller_person_id=245,
                callee_person_id=246,
                start_time="2026-08-24T16:03:00",
                duration_sec=120,
                cell_tower_id=12,
            )
        ),
    ).json()
    assert explicit["counts"]["duplicate"] == 1
    assert explicit["duplicate_rows"][0]["record_id"] == committed["record_ids"][0]


def test_the_explicit_column_wins_when_a_file_carries_both_spellings():
    """A file with both is not ambiguous: `_person_id` is the explicit form."""
    payload = bulk.build_payload(
        SourceType.CALL,
        {
            "caller_person_id": "247",
            "caller_id": "999",
            "callee_id": "248",
            "start_time": "2026-08-24T16:10:00",
            "duration_sec": "120",
        },
    )
    assert payload["caller"] == {"person_id": "247"}
    assert payload["callee"] == {"person_id": "248"}


def test_a_header_that_names_no_person_is_one_error_not_many_rejected_rows(client):
    """The corpus's `locations.csv` is a table of places, not of sightings.

    Its header carries `location_id`, `city` and `state`, so it is recognisably a
    LOCATION file — but nothing in it can say *who* was seen there. Rejecting each
    row one at a time would report the row count of a problem the file has, so this
    is answered once, at the file, naming the column that is missing.
    """
    before = state(client)
    response = upload(
        client,
        "location_id,state,city,latitude,longitude\n1,Delhi,New Delhi,8.72,75.97\n",
        source_type="location",
    )
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["message"] == "No column identifies the person of a location row."
    assert error["detail"]["missing_references"] == ["person"]
    assert "person_id" in error["detail"]["expected_columns"]
    assert "person_person_id" in error["detail"]["expected_columns"]
    assert state(client) == before


def test_an_fir_needs_a_complainant_column_but_not_an_accused_one(client):
    """§4: an FIR naming no accused yet is valid; one naming no complainant is not."""
    narrative = (
        "Complainant states that cash was taken from the counter on "
        "24 August 2026 while the shop was open."
    )
    no_complainant = upload(
        client,
        f"accused_id,date,narrative,location_id\n249,2026-08-24,{narrative},5\n",
        source_type="fir",
    )
    assert no_complainant.status_code == 400
    assert no_complainant.json()["error"]["detail"]["missing_references"] == [
        "complainant"
    ]

    no_accused = upload(
        client,
        f"complainant_id,date,narrative,location_id\n250,2026-08-24,{narrative},5\n",
        source_type="fir",
    )
    assert no_accused.status_code == 200
    assert no_accused.json()["counts"]["rejected"] == 0


# --- dataset integrity and Phase 4.6 compatibility --------------------------
def test_the_dataset_files_are_untouched_after_every_request_above(
    client, dataset_digest
):
    directory = client.app.state.settings.dataset_dir
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }
    assert after == dataset_digest


def test_single_record_ingestion_and_the_read_surface_still_work(client):
    response = client.post(
        f"{BASE}/call",
        json={
            "caller": {"person_id": 230},
            "callee": {"person_id": 231},
            "start_time": "2026-08-24T12:00:00",
            "duration_sec": 120,
            "provenance": {"source_name": "phase-6.2 test"},
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ACCEPTED"

    summary = client.get(f"{BASE}/summary").json()
    assert summary["records"]["ACCEPTED"] > 0
    assert summary["events"]["transport"] == "sse"
    assert client.get("/api/v1/intelligence/summary").json()["persons_scored"] == 500
    assert client.get("/api/v1/graph/summary").json()["graph"]["node_count"] > 0
