"""Phase 4.6 over HTTP: the four ingestion endpoints, the reads, and the stream.

Like ``test_ingest.py`` this module builds its OWN app so it cannot disturb the
Phase 1-4 suites' exact counts. Everything here goes through the real routes,
because §17 asks for the endpoints to be verified as endpoints — not for the
pipeline to be called directly a second time.
"""
from __future__ import annotations

import asyncio
import hashlib
import json

import anyio
import pytest
from fastapi.testclient import TestClient

from app.main import create_app

BASE = "/api/v1/ingest"
PROV = {"source_name": "phase-4.6 test", "submitted_by": "pytest"}


@pytest.fixture(scope="module")
def client():
    """One app, one lifespan, for this module only."""
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(scope="module")
def live_app(client):
    return client.app


@pytest.fixture(scope="module")
def dataset_digest(client):
    """Hash every dataset CSV once, before any submission in this module runs."""
    directory = client.app.state.settings.dataset_dir
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }


def call_body(caller: int, callee: int, minute: int, **extra) -> dict:
    body = {
        "caller": {"person_id": caller},
        "callee": {"person_id": callee},
        "start_time": f"2026-08-20T09:{minute:02d}:00",
        "duration_sec": 120,
        "provenance": PROV,
    }
    body.update(extra)
    return body


# --- §3 the four ingestion endpoints ---------------------------------------
def test_call_endpoint_accepts_and_reports_its_impact(client):
    response = client.post(f"{BASE}/call", json=call_body(101, 102, 1, cell_tower_id=12))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ACCEPTED"
    assert body["source_type"] == "CALL"
    assert body["validation_status"] == "VALID"
    assert body["impact"]["changed"] is True
    assert "CALLED~person:101~person:102" in body["impact"]["graph"]["edges_added"]
    assert body["provenance"]["source_name"] == PROV["source_name"]
    assert body["disclaimer"]

    impact = client.get(f"{BASE}/{body['record_id']}/impact")
    assert impact.status_code == 200
    assert impact.json()["impact"]["recompute_cost_ms"]["total_ms"] > 0


def test_transaction_endpoint_accepts(client):
    response = client.post(
        f"{BASE}/transaction",
        json={
            "sender": {"person_id": 103},
            "receiver": {"person_id": 104},
            "amount_inr": 250000,
            "txn_time": "2026-08-20T10:00:00",
            "mode": "neft",
            "reference_id": "neft-77001",
            "provenance": PROV,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ACCEPTED"
    assert body["normalized_payload"]["bank_ref"] == "NEFT-77001"
    assert [r["relationship_id"] for r in body["relationships"]] == [
        "TRANSACTED~person:103~person:104"
    ]


def test_fir_endpoint_accepts_and_returns_narrative_analysis(client):
    response = client.post(
        f"{BASE}/fir",
        json={
            "date": "2026-08-21",
            "complainant": {"person_id": 105},
            "accused": {"person_id": 106},
            "narrative": (
                "Complainant states that the accused took cash from his shop on "
                "21 August 2026 and threatened him before leaving."
            ),
            "location_id": 5,
            "provenance": PROV,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ACCEPTED"
    accepted = [r for r in body["relationships"] if r["accepted"]]
    assert {r["relationship_type"] for r in accepted} == {
        "NAMED_IN_FIR",
        "REPORTED_AGAINST",
        "LOCATED_AT",
    }
    nlp = body["impact"]["nlp"]
    assert nlp["impact"]["structured_graph_mutated"] is False
    # §7 requires each of these to be reported, even when a list is empty.
    for key in (
        "extracted_entities",
        "resolved_entity_ids",
        "new_entities",
        "review_required_entities",
        "relationships_accepted",
        "relationships_rejected",
    ):
        assert key in nlp


def test_location_endpoint_accepts(client):
    response = client.post(
        f"{BASE}/location",
        json={
            "person": {"person_id": 107},
            "location_id": 9,
            "observed_at": "2026-08-21T18:00:00",
            "provenance": PROV,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ACCEPTED"
    assert body["relationships"][0]["relationship_id"] == (
        "LOCATED_AT~observed~person:107~location:9"
    )


# --- §3 reads ---------------------------------------------------------------
def test_a_record_can_be_read_back_by_id(client):
    posted = client.post(f"{BASE}/call", json=call_body(110, 111, 2)).json()
    fetched = client.get(f"{BASE}/{posted['record_id']}")
    assert fetched.status_code == 200
    assert fetched.json()["record_id"] == posted["record_id"]
    assert fetched.json()["status"] == "ACCEPTED"


def test_an_unknown_record_id_is_a_404_in_the_standard_envelope(client):
    response = client.get(f"{BASE}/{'0' * 64}")
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert "0" * 64 in error["message"]


def test_entity_changes_lists_what_touched_that_entity(client):
    posted = client.post(f"{BASE}/call", json=call_body(112, 113, 3)).json()
    response = client.get("/api/v1/entities/person:112/changes")
    assert response.status_code == 200
    body = response.json()
    assert body["entity_id"] == "person:112"
    assert body["count"] >= 1
    assert posted["record_id"] in [c["record_id"] for c in body["changes"]]
    change = next(c for c in body["changes"] if c["record_id"] == posted["record_id"])
    assert "CALLED~person:112~person:113" in change["relationship_ids"]


def test_an_entity_with_no_live_records_gets_an_empty_change_list(client):
    response = client.get("/api/v1/entities/person:499/changes")
    assert response.status_code == 200
    body = response.json()
    assert body["entity_id"] == "person:499"
    assert body["count"] == 0
    assert body["changes"] == []


def test_the_summary_reports_counts_and_makes_no_integration_claim(client):
    body = client.get(f"{BASE}/summary").json()
    assert body["records"]["ACCEPTED"] >= 1
    assert body["live_rows"]["calls"] >= 1
    assert body["graph_totals"]["edges"] > 0
    assert body["events"]["transport"] == "sse"
    assert body["persistence"]["dataset_directory_written"] is False
    assert body["external_sources"]["configured"] == []
    assert body["external_sources"]["available"] == []
    assert "NCRB" in body["external_sources"]["note"]


def test_records_can_be_filtered_by_status_and_source_type(client):
    accepted = client.get(f"{BASE}/records", params={"status": "ACCEPTED"}).json()
    assert accepted
    assert {r["status"] for r in accepted} == {"ACCEPTED"}
    calls = client.get(f"{BASE}/records", params={"source_type": "CALL"}).json()
    assert {r["source_type"] for r in calls} == {"CALL"}
    bad = client.get(f"{BASE}/records", params={"status": "MAYBE"})
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "bad_request"


# --- §2 duplicate over HTTP -------------------------------------------------
def test_the_same_body_posted_twice_is_a_duplicate(client):
    body = call_body(120, 121, 4)
    first = client.post(f"{BASE}/call", json=body).json()
    graph_before = client.get(f"{BASE}/summary").json()["graph_totals"]

    second = client.post(f"{BASE}/call", json=body).json()
    assert second["status"] == "DUPLICATE"
    assert second["record_id"] == first["record_id"]
    assert second["duplicate_of"] == first["record_id"]
    assert second["impact"]["changed"] is False
    assert second["relationships"] == []
    assert client.get(f"{BASE}/summary").json()["graph_totals"] == graph_before


def test_a_different_provenance_does_not_change_a_records_identity(client):
    body = call_body(122, 123, 5)
    first = client.post(f"{BASE}/call", json=body).json()
    second = client.post(
        f"{BASE}/call",
        json={**body, "provenance": {"source_name": "a different desk"}},
    ).json()
    # §2 hashes the observation, not who reported it.
    assert second["record_id"] == first["record_id"]
    assert second["status"] == "DUPLICATE"


# --- §4 rejection -----------------------------------------------------------
def test_a_structurally_wrong_body_is_a_422_validation_error(client):
    response = client.post(f"{BASE}/call", json={"caller": {"person_id": 1}})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_an_unknown_field_is_refused_rather_than_silently_dropped(client):
    response = client.post(
        f"{BASE}/call", json={**call_body(124, 125, 6), "suspicion_level": "high"}
    )
    assert response.status_code == 422


def test_an_unusable_value_is_a_rejected_record_not_an_http_error(client):
    response = client.post(
        f"{BASE}/call", json={**call_body(126, 127, 7), "start_time": "not-a-time"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "REJECTED"
    assert body["reject_reason"] == "INVALID_FIELD"
    assert body["validation_status"] == "INVALID"
    assert "start_time" in body["reason"]
    assert body["impact"]["changed"] is False
    # A rejected submission never became a record, so it is not stored.
    assert client.get(f"{BASE}/{body['record_id']}").status_code == 404


def test_a_narrative_too_short_to_analyse_is_rejected(client):
    response = client.post(
        f"{BASE}/fir",
        json={
            "date": "2026-08-21",
            "complainant": {"person_id": 128},
            "narrative": "theft",
            "location_id": 5,
            "provenance": PROV,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "REJECTED"
    assert "narrative" in response.json()["reason"]


def test_provenance_is_required(client):
    body = call_body(129, 130, 8)
    body.pop("provenance")
    assert client.post(f"{BASE}/call", json=body).status_code == 422


# --- §5/§6 review -----------------------------------------------------------
def test_unknown_participants_are_held_for_review_not_connected(client):
    response = client.post(
        f"{BASE}/call",
        json={
            "caller": {"phone": "9111000111"},
            "callee": {"phone": "9111000112"},
            "start_time": "2026-08-20T11:00:00",
            "duration_sec": 60,
            "provenance": PROV,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "REVIEW_REQUIRED"
    assert body["review_reason"] == "NO_MATCH_NEW_ENTITY"
    assert body["reason"] == "No validated connection found with existing investigation data."
    assert body["impact"]["changed"] is False
    assert body["relationships"] == []
    assert all(m["is_new_entity"] for m in body["matches"])
    # Held, not discarded: it is readable and appears in the review queue.
    assert client.get(f"{BASE}/{body['record_id']}").status_code == 200
    queue = client.get(f"{BASE}/records", params={"status": "REVIEW_REQUIRED"}).json()
    assert body["record_id"] in [r["record_id"] for r in queue]


def test_conflicting_identifiers_are_ambiguous_with_candidates(client, live_app):
    persons = live_app.state.dataset.persons
    first, second = persons[10], persons[11]
    response = client.post(
        f"{BASE}/call",
        json={
            "caller": {
                "person_id": int(first["person_id"]),
                "phone": second["phone"],
            },
            "callee": {"person_id": 131},
            "start_time": "2026-08-20T11:30:00",
            "duration_sec": 60,
            "provenance": PROV,
        },
    )
    body = response.json()
    assert body["status"] == "REVIEW_REQUIRED"
    assert body["review_reason"] == "AMBIGUOUS_MATCH"
    caller = next(m for m in body["matches"] if m["field"] == "caller")
    assert caller["status"] == "AMBIGUOUS"
    assert caller["entity_id"] is None
    assert len(caller["candidates"]) == 2
    assert body["impact"]["changed"] is False


def test_an_ambiguous_reason_is_distinct_from_a_no_match_reason(client):
    """§5: the two review reasons must not be collapsed into one."""
    no_match = client.post(
        f"{BASE}/location",
        json={
            "person": {"phone": "9111000113"},
            "city": "Nowhereville",
            "state": "Nowhere",
            "provenance": PROV,
        },
    ).json()
    assert no_match["review_reason"] == "NO_MATCH_NEW_ENTITY"
    assert no_match["reason"] != ""

    ambiguous = client.post(
        f"{BASE}/location",
        json={
            "person": {"person_id": 132},
            "city": "Nowhereville",
            "state": "Nowhere",
            "provenance": PROV,
        },
    ).json()
    # A known person and an unknown place: still NO_MATCH on the place, and the
    # person's own match is reported as resolved rather than being thrown away.
    person_match = next(m for m in ambiguous["matches"] if m["field"] == "person")
    assert person_match["status"] == "MATCHED"
    assert ambiguous["review_reason"] == "NO_MATCH_NEW_ENTITY"


# --- §12 SSE ----------------------------------------------------------------
def _sse_scope() -> dict:
    path = f"{BASE}/stream"
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"live"), (b"accept", b"text/event-stream")],
        "client": ("127.0.0.1", 54321),
        "server": ("live", 80),
    }


def test_sse_stream_delivers_live_events_for_an_accepted_record(client, live_app):
    """One accepted call, read off the live stream as real SSE frames.

    Driven through the ASGI interface rather than ``httpx.ASGITransport``: that
    transport buffers a whole response before returning it, which can never
    happen for an open event stream. The frames below come out of the actual
    route, through the actual middleware and dependency stack.
    """

    async def scenario() -> tuple[dict, list[dict]]:
        chunks: asyncio.Queue[str] = asyncio.Queue()
        meta: dict = {}
        disconnect = asyncio.Event()

        async def receive() -> dict:
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                meta["status"] = message["status"]
                meta["headers"] = {
                    k.decode().lower(): v.decode() for k, v in message["headers"]
                }
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                if body:
                    await chunks.put(body.decode("utf-8"))

        served = asyncio.create_task(live_app(_sse_scope(), receive, send))
        try:
            # The opening comment frame: connected and quiet, not still connecting.
            assert (await asyncio.wait_for(chunks.get(), timeout=30)).startswith(":")

            # Submitting blocks this thread, not the pipeline: the POST handler
            # runs in the TestClient's own loop and publishes across threads.
            posted = client.post(f"{BASE}/call", json=call_body(140, 141, 9)).json()
            assert posted["status"] == "ACCEPTED"

            events: list[dict] = []
            while not events or events[-1]["event_type"] != "new_intelligence":
                chunk = await asyncio.wait_for(chunks.get(), timeout=30)
                events.extend(
                    json.loads(line[len("data: ") :])
                    for line in chunk.splitlines()
                    if line.startswith("data: ")
                )
            return meta, events
        finally:
            disconnect.set()
            await asyncio.wait_for(served, timeout=15)

    meta, events = anyio.run(scenario)
    assert meta["status"] == 200
    assert meta["headers"]["content-type"].startswith("text/event-stream")
    assert meta["headers"]["cache-control"] == "no-cache"
    assert meta["headers"]["x-accel-buffering"] == "no"

    types = [e["event_type"] for e in events]
    assert "relationship_added" in types
    assert "entity_updated" in types
    assert types[-1] == "new_intelligence"
    assert types == sorted(set(types), key=types.index)  # each type once per record
    for event in events:
        assert event["event_id"] > 0 and event["at"]
        # §12: notifications carry ids and counts, never raw or sensitive content.
        blob = json.dumps(event["data"]).casefold()
        for leaked in ("narrative", "aadhaar", "aadhar", "phone", "amount", "duration"):
            assert leaked not in blob


def test_the_stream_unsubscribes_when_a_client_goes_away(client, live_app):
    """A closed tab must not leave a subscriber (or its queue) behind."""
    bus = live_app.state.ingest.bus
    before = bus.stats()["subscribers"]

    async def scenario() -> int:
        started = asyncio.Event()
        disconnect = asyncio.Event()

        async def receive() -> dict:
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.body" and message.get("body"):
                started.set()

        served = asyncio.create_task(live_app(_sse_scope(), receive, send))
        await asyncio.wait_for(started.wait(), timeout=30)
        attached = bus.stats()["subscribers"]
        disconnect.set()
        await asyncio.wait_for(served, timeout=15)
        return attached

    attached = anyio.run(scenario)
    assert attached == before + 1
    assert bus.stats()["subscribers"] == before


# --- §17 dataset integrity and Phase 1-4 compatibility ---------------------
def test_the_dataset_files_are_untouched_after_every_request_above(
    client, dataset_digest
):
    directory = client.app.state.settings.dataset_dir
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }
    assert after == dataset_digest


def test_phase_1_to_4_endpoints_still_answer_after_ingestion(client):
    """Ingestion changed the graph; the read-only surface must still work."""
    assert client.get("/health").json()["dataset_loaded"] is True
    checks = {
        # Phase 1 still reports the dataset, not the dataset plus live rows.
        "/api/v1/data/summary": lambda b: b["counts"]["persons"] == 500,
        "/api/v1/persons/141": lambda b: b["person_id"] == 141,
        "/api/v1/graph/summary": lambda b: b["graph"]["node_count"] > 0,
        "/api/v1/nlp/summary": lambda b: b["firs_analyzed"] >= 300,
        "/api/v1/intelligence/summary": lambda b: b["persons_scored"] == 500,
        "/api/v1/analytics/communities": lambda b: b["community_count"] > 0,
    }
    for path, ok in checks.items():
        response = client.get(path)
        assert response.status_code == 200, path
        assert ok(response.json()), path


def test_intelligence_reflects_the_post_ingestion_graph(client):
    """§11: a recomputed engine is published, so reads are not the startup snapshot."""
    posted = client.post(f"{BASE}/call", json=call_body(150, 151, 10)).json()
    assert posted["status"] == "ACCEPTED"
    after = next(
        p["after"] for p in posted["impact"]["persons"] if p["after"]["person_id"] == 150
    )
    served = client.get("/api/v1/intelligence/persons/150").json()["priority"]
    assert served["score"] == after["score"]
    assert served["band"] == after["band"]
