"""Phase 6.2b: several CSVs previewed together as ONE import.

The claim this module has to hold up is narrow and testable: the files are
analysed *together*, not previewed one by one and added up. So the load-bearing
case here is
:func:`test_a_relationship_that_spans_two_files_is_only_visible_combined` — a
call file and a transaction file about the same pair of people, where each file
alone asserts no multi-channel pattern and the two together do. If that test
ever passes with per-file previews merged afterwards, the merge is wrong, not the
test.

Like the other bulk suite this module builds its OWN app, so nothing committed
here can disturb the counts the Phase 1-4 suites assert.
"""
from __future__ import annotations

import csv
import hashlib
import io

import pytest
from fastapi.testclient import TestClient

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

CALL_COLUMNS = (
    "caller_person_id",
    "callee_person_id",
    "callee_name",
    "start_time",
    "duration_sec",
    "cell_tower_id",
)
TXN_COLUMNS = (
    "sender_person_id",
    "receiver_person_id",
    "amount_inr",
    "txn_time",
    "mode",
    "bank_ref",
)
LOCATION_COLUMNS = ("person_person_id", "location_id", "observed_at")
FIR_COLUMNS = (
    "complainant_person_id",
    "accused_person_id",
    "date",
    "narrative",
    "location_id",
)
NARRATIVE = (
    "Complainant states that the accused took cash from the shop on "
    "24 August 2026 and left in a hurry."
)


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


# --- building uploads -------------------------------------------------------
def csv_text(columns: tuple[str, ...], rows: list[dict]) -> str:
    """A CSV the real parser reads, with quoting handled by the csv module."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(columns), lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({column: row.get(column, "") for column in columns})
    return buffer.getvalue()


def calls(*pairs: tuple[int, int, int]) -> str:
    return csv_text(
        CALL_COLUMNS,
        [
            {
                "caller_person_id": a,
                "callee_person_id": b,
                "start_time": f"2026-08-24T13:{minute:02d}:00",
                "duration_sec": 120,
                "cell_tower_id": 12,
            }
            for a, b, minute in pairs
        ],
    )


def transactions(*pairs: tuple[int, int, int]) -> str:
    return csv_text(
        TXN_COLUMNS,
        [
            {
                "sender_person_id": a,
                "receiver_person_id": b,
                "amount_inr": amount,
                "txn_time": f"2026-08-24T14:{amount % 60:02d}:00",
                "mode": "UPI",
                "bank_ref": f"REF{amount}{a}{b}",
            }
            for a, b, amount in pairs
        ],
    )


def locations(*seen: tuple[int, int]) -> str:
    return csv_text(
        LOCATION_COLUMNS,
        [
            {
                "person_person_id": person,
                "location_id": location,
                "observed_at": "2026-08-24T15:00:00",
            }
            for person, location in seen
        ],
    )


def firs(*reports: tuple[int, int]) -> str:
    return csv_text(
        FIR_COLUMNS,
        [
            {
                "complainant_person_id": complainant,
                "accused_person_id": accused,
                "date": "2026-08-24",
                "narrative": NARRATIVE,
                "location_id": 5,
            }
            for complainant, accused in reports
        ],
    )


def batch(client, files: list[tuple[str, str]], names: list[str] | None = None):
    """POST an All Types selection. ``files`` is [(source_type, content), …]."""
    payload = [
        {
            "source_type": source_type,
            "filename": (names[index] if names else f"{source_type}s.csv"),
            "content": content,
        }
        for index, (source_type, content) in enumerate(files)
    ]
    return client.post(f"{BASE}/bulk/preview", json={"files": payload})


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


def frames(client, import_id: str) -> list[dict]:
    return [
        event.data
        for event in client.app.state.ingest.bus.recent()
        if event.event_type.value == "bulk_preview"
        and event.data["import_id"] == import_id
    ]


def multi_channel(body: dict, entity_ids: set[str]) -> list[dict]:
    return [
        pattern
        for pattern in body["suspicious_patterns_preview"]["patterns"]
        if pattern["pattern_type"] == "MULTI_CHANNEL_RELATIONSHIP"
        and entity_ids <= set(pattern["entity_ids"])
    ]


# --- one preview over several files -----------------------------------------
def test_two_files_are_previewed_as_one_import(client):
    before = state(client)
    response = batch(
        client,
        [("call", calls((301, 302, 1))), ("transaction", transactions((303, 304, 700)))],
    )
    assert response.status_code == 200
    body = response.json()

    # One import, both files, and the counts are the whole selection's.
    assert body["source_type"] == "CALL+TRANSACTION"
    assert body["counts"]["total"] == 2
    assert body["counts"]["new_valid"] == 2
    assert [f["source_type"] for f in body["files"]] == ["CALL", "TRANSACTION"]
    assert [f["status"] for f in body["files"]] == ["ok", "ok"]
    assert [f["counts"]["new_valid"] for f in body["files"]] == [1, 1]
    assert [f["filename"] for f in body["files"]] == ["calls.csv", "transactions.csv"]

    # Each file has its own id for provenance, and the batch id leads them.
    assert body["import_ids"][0] == body["import_id"]
    assert len(set(body["import_ids"])) == 3

    # The overlay is ahead of the live graph, which has not moved.
    assert body["graph_before"] == {"nodes": before["nodes"], "edges": before["edges"]}
    assert body["metrics_preview"]["graph"]["edge_count"] > before["edges"]
    assert state(client) == before


def test_all_four_types_are_previewed_together(client):
    before = state(client)
    body = batch(
        client,
        [
            ("call", calls((305, 306, 2))),
            ("transaction", transactions((305, 307, 701))),
            ("location", locations((308, 9))),
            ("fir", firs((309, 310))),
        ],
    ).json()

    assert body["source_type"] == "CALL+FIR+LOCATION+TRANSACTION"
    assert len(body["files"]) == 4
    assert [f["index"] for f in body["files"]] == [0, 1, 2, 3]
    assert body["counts"]["total"] == 4
    assert body["counts"]["new_valid"] == 4
    # One combined network, built from every file's affected entities.
    assert body["network_preview"]["meta"]["anchors"] > 4
    assert body["commit_applicable"] is True
    assert state(client) == before

    client.post(f"{BASE}/bulk/{body['import_id']}/reject").raise_for_status()


def test_the_combined_preview_reflects_every_selected_file(client):
    """Rows from all files land on the one overlay, not just the first file's."""
    one = ("call", calls((311, 312, 3), (313, 314, 4)))
    two = ("transaction", transactions((315, 316, 702)))
    alone = batch(client, [one]).json()
    combined = batch(client, [one, two]).json()

    assert alone["counts"]["new_valid"] == 2
    assert combined["counts"]["new_valid"] == 3
    # The third row is on the overlay: the combined graph is strictly larger.
    assert (
        combined["metrics_preview"]["graph"]["edge_count"]
        > alone["metrics_preview"]["graph"]["edge_count"]
    )
    # Both files' entities are anchors of the one preview network.
    entity_ids = {node["entity_id"] for node in combined["network_preview"]["nodes"]}
    assert {"person:311", "person:315"} <= entity_ids


def test_a_relationship_that_spans_two_files_is_only_visible_combined(client):
    """§6/§12: the reason the files are analysed together, stated as a test.

    Persons 411 and 412 exchange a call in one file and money in another. Neither
    file on its own gives the multi-channel detector two channels for the pair;
    the two files analysed together do. A per-file preview merged afterwards
    cannot produce this pattern, whatever it displays.
    """
    call_file = ("call", calls((411, 412, 5)))
    txn_file = ("transaction", transactions((411, 412, 703)))
    pair = {"person:411", "person:412"}

    calls_only = batch(client, [call_file]).json()
    txns_only = batch(client, [txn_file]).json()
    combined = batch(client, [call_file, txn_file]).json()

    assert multi_channel(calls_only, pair) == []
    assert multi_channel(txns_only, pair) == []

    found = multi_channel(combined, pair)
    assert len(found) == 1
    assert set(found[0]["detail"]["channels"]) == {"CALL", "TRANSACTION"}
    # Evidence from both files, and no invented relationship types.
    assert set(found[0]["relationship_types"]) == {"CALLED", "TRANSACTED"}


def test_a_pattern_is_listed_once_however_many_files_contributed(client):
    body = batch(
        client,
        [
            ("call", calls((413, 414, 6))),
            ("transaction", transactions((413, 414, 704))),
            ("location", locations((413, 9), (414, 9))),
        ],
    ).json()
    ids = [p["pattern_id"] for p in body["suspicious_patterns_preview"]["patterns"]]
    assert ids == sorted(set(ids), key=ids.index)
    assert body["suspicious_patterns_preview"]["total"] == len(ids)
    for pattern in body["suspicious_patterns_preview"]["patterns"]:
        assert pattern["structured_evidence"], "a pattern must keep its evidence"

    client.post(f"{BASE}/bulk/{body['import_id']}/reject").raise_for_status()


def test_a_combined_preview_writes_nothing_anywhere(client):
    before = state(client)
    body = batch(
        client,
        [("call", calls((317, 318, 7))), ("fir", firs((319, 320)))],
    ).json()
    assert body["counts"]["new_valid"] == 2
    assert state(client) == before
    # Not even the narrative overlay, which the FIR row would otherwise reach.
    assert state(client)["narrative_edges"] == before["narrative_edges"]


def test_one_stage_sequence_for_the_whole_batch(client):
    body = batch(
        client,
        [("call", calls((321, 322, 8))), ("transaction", transactions((323, 324, 705)))],
    ).json()

    published = frames(client, body["import_id"])
    assert [f["stage"] for f in published] == STAGES
    # The sub-label rides on the sequence; it does not add frames to it.
    assert {f["detail"] for f in published} == {"2 file(s)"}
    # No file publishes a sequence of its own.
    for import_id in body["import_ids"][1:]:
        assert frames(client, import_id) == []

    client.post(f"{BASE}/bulk/{body['import_id']}/reject").raise_for_status()


# --- per-file outcomes ------------------------------------------------------
def test_an_unusable_file_does_not_stop_the_others(client):
    body = batch(
        client,
        [
            ("call", "not,a,known,header\n1,2,3,4\n"),
            ("transaction", transactions((325, 326, 706))),
        ],
    ).json()

    broken, good = body["files"]
    assert broken["status"] == "error"
    assert broken["error"]
    assert broken["counts"]["total"] == 0
    assert good["status"] == "ok"
    assert body["counts"]["new_valid"] == 1
    assert body["commit_applicable"] is True

    committed = client.post(f"{BASE}/bulk/{body['import_id']}/confirm").json()
    assert committed["counts"]["imported"] == 1
    assert [f["status"] for f in committed["files"]] == ["error", "committed"]


def test_a_file_with_nothing_new_is_skipped_and_the_rest_still_commits(client):
    """§17: a duplicate-only file is skipped; the valid file is not held back."""
    already = calls((327, 328, 9))
    first = batch(client, [("call", already)]).json()
    client.post(f"{BASE}/bulk/{first['import_id']}/confirm").raise_for_status()

    body = batch(
        client,
        [("call", already), ("transaction", transactions((329, 330, 707)))],
    ).json()
    stale, fresh = body["files"]
    assert stale["status"] == "skipped"
    assert stale["counts"] == {
        "total": 1,
        "new_valid": 0,
        "duplicate": 1,
        "review_required": 0,
        "rejected": 0,
    }
    assert fresh["status"] == "ok"

    committed = client.post(f"{BASE}/bulk/{body['import_id']}/confirm").json()
    assert committed["counts"]["imported"] == 1
    assert [f["status"] for f in committed["files"]] == ["skipped", "committed"]
    assert [f["imported"] for f in committed["files"]] == [0, 1]


def test_nothing_new_in_any_file_is_reported_and_not_committable(client):
    """§15: every row already in the system means there is nothing to add."""
    content = [("call", calls((331, 332, 10))), ("transaction", transactions((333, 334, 708)))]
    first = batch(client, content).json()
    client.post(f"{BASE}/bulk/{first['import_id']}/confirm").raise_for_status()

    again = batch(client, content).json()
    assert again["counts"]["new_valid"] == 0
    assert again["counts"]["duplicate"] == 2
    assert again["commit_applicable"] is False
    assert [f["status"] for f in again["files"]] == ["skipped", "skipped"]
    assert again["suspicious_patterns_preview"]["patterns"] == []
    assert again["metrics_preview"]["note"]
    assert "analytics" not in again["metrics_preview"]


def test_rows_keep_their_own_verdicts_and_reasons_across_files(client):
    body = batch(
        client,
        [
            ("call", calls((335, 336, 11), (335, 336, 11))),
            (
                "call",
                csv_text(
                    CALL_COLUMNS,
                    [
                        {  # a party that resolves to nobody
                            "caller_person_id": 337,
                            "callee_name": "Zarvix Quorlan",
                            "start_time": "2026-08-24T13:30:00",
                            "duration_sec": 60,
                        },
                        {  # an unusable value
                            "caller_person_id": 338,
                            "callee_person_id": 339,
                            "start_time": "2026-08-24T13:31:00",
                            "duration_sec": -5,
                        },
                    ],
                ),
            ),
        ],
        names=["a.csv", "b.csv"],
    ).json()

    assert body["counts"] == {
        "total": 4,
        "new_valid": 1,
        "duplicate": 1,
        "review_required": 1,
        "rejected": 1,
    }
    # Row numbers restart per file, so each row says which file it is from.
    assert body["duplicate_rows"][0]["source_type"] == "CALL"
    assert body["duplicate_rows"][0]["reason"] == (
        "Identical to an earlier row in this upload."
    )
    held = body["review_required_rows"][0]
    # §16: the two review reasons stay distinguishable. This row is a new entity,
    # not an ambiguous match, and it says which — and it says which field.
    assert "New to this investigation: callee" in held["reason"]
    assert "ambiguous" not in held["reason"].lower()
    assert held["record_id"], "a held row is stored for review, not discarded"
    assert "duration_sec" in body["rejected_rows"][0]["reason"]
    assert body["rejected_rows"][0]["record_id"] is None

    # §17: each file says what became of ITS rows. The first has a new row, so it is
    # ready; the second has one held row and one unusable one and no new row, so it
    # is not "already in the system" — it carries the reason a row of it was given.
    # Rejected and review are tied one-to-one here, and the more serious wins.
    assert [f["status"] for f in body["files"]] == ["ok", "rejected"]
    assert body["files"][0]["reason"] is None
    assert "duration_sec" in body["files"][1]["reason"]
    assert body["files"][1]["error"] is None

    # Only the new row is committed; the held row is not.
    committed = client.post(f"{BASE}/bulk/{body['import_id']}/confirm").json()
    assert committed["counts"]["imported"] == 1
    assert len(committed["record_ids"]) == 1
    assert set(committed["record_ids"]).isdisjoint(
        {r["record_id"] for r in body["review_required_rows"]}
    )
    # The duplicate row names the same record as the committed one — being the
    # same observation is exactly why it was skipped rather than written twice.
    assert body["duplicate_rows"][0]["record_id"] == committed["record_ids"][0]


# --- what a file that added nothing actually says ---------------------------
# "Nothing new" has three causes and they are not interchangeable. A file whose
# rows are already in the system is skipped; a file whose rows are unusable is
# rejected and says which field failed; a file whose people cannot be resolved to
# exactly one person each needs review. Reporting all three as "skipped" would tell
# the investigator the file had already been dealt with when none of it was read.
def unusable_calls(*pairs: tuple[int, int, int]) -> str:
    """Rows whose duration cannot be a duration, so every row is REJECTED."""
    return csv_text(
        CALL_COLUMNS,
        [
            {
                "caller_person_id": a,
                "callee_person_id": b,
                "start_time": f"2026-08-24T17:{minute:02d}:00",
                "duration_sec": -5,
                "cell_tower_id": 12,
            }
            for a, b, minute in pairs
        ],
    )


def unresolvable_calls(*names: tuple[int, str, int]) -> str:
    """Rows naming a party who matches nobody, so every row needs REVIEW."""
    return csv_text(
        CALL_COLUMNS,
        [
            {
                "caller_person_id": caller,
                "callee_name": name,
                "start_time": f"2026-08-24T18:{minute:02d}:00",
                "duration_sec": 90,
            }
            for caller, name, minute in names
        ],
    )


def test_a_rejected_file_is_not_reported_as_already_in_the_system(client):
    """The bug this test exists for: every file said "skipped" whatever happened."""
    already = calls((341, 342, 20))
    first = batch(client, [("call", already)]).json()
    client.post(f"{BASE}/bulk/{first['import_id']}/confirm").raise_for_status()

    body = batch(
        client,
        [
            ("call", already),
            ("call", unusable_calls((343, 344, 21), (345, 346, 22))),
            ("transaction", transactions((347, 348, 709))),
        ],
        names=["seen-before.csv", "broken.csv", "good.csv"],
    ).json()
    stale, broken, good = body["files"]

    assert [f["status"] for f in body["files"]] == ["skipped", "rejected", "ok"]
    # The skipped file is the only one whose rows are accounted for elsewhere.
    assert stale["counts"]["duplicate"] == 1
    assert "already" in (stale["reason"] or "").lower()
    # The rejected file says which field failed, and does not claim to be known.
    assert broken["counts"]["rejected"] == 2
    assert "duration_sec" in broken["reason"]
    assert "already in" not in broken["reason"].lower()
    assert broken["error"] is None
    assert good["reason"] is None

    # A commit does not flatten the distinction either.
    committed = client.post(f"{BASE}/bulk/{body['import_id']}/confirm").json()
    assert [f["status"] for f in committed["files"]] == [
        "skipped",
        "rejected",
        "committed",
    ]
    assert [f["imported"] for f in committed["files"]] == [0, 0, 1]


def test_a_file_whose_rows_all_need_a_decision_is_reported_as_review(client):
    """§16: a held row is not a rejected one and not a duplicate one."""
    body = batch(
        client,
        [("call", unresolvable_calls((349, "Zarvix Quorlan", 23), (350, "Melbik Trandor", 24)))],
    ).json()
    held = body["files"][0]
    assert held["status"] == "review"
    assert held["counts"]["review_required"] == 2
    assert held["counts"]["rejected"] == 0
    assert "New to this investigation" in held["reason"]
    assert body["commit_applicable"] is False


# --- the column names the dataset itself uses -------------------------------
# The reported symptom was four files uploaded together and every row of all four
# rejected. The cause was the column spelling: the corpus names a party
# `caller_id`, `sender_id`, `person_id`, `complainant_id`, and only the long
# `<role>_person_id` form was read. Files exported from the dataset must import as
# themselves, so this is the case that has to keep working.
NATIVE_CALL_COLUMNS = ("caller_id", "callee_id", "start_time", "duration_sec", "cell_tower_id")
NATIVE_TXN_COLUMNS = ("sender_id", "receiver_id", "amount_inr", "txn_time", "mode", "bank_ref")
NATIVE_LOCATION_COLUMNS = ("person_id", "location_id", "observed_at")
NATIVE_FIR_COLUMNS = ("complainant_id", "accused_id", "date", "narrative", "location_id")
# The corpus's own `locations.csv` header: a table of places. It is recognisably a
# LOCATION file and yet nothing in it can name the person seen at one.
PLACES = "location_id,state,city,latitude,longitude\n1,Delhi,New Delhi,8.72,75.97\n"


def native_files() -> list[tuple[str, str]]:
    return [
        (
            "call",
            csv_text(
                NATIVE_CALL_COLUMNS,
                [{"caller_id": 351, "callee_id": 352, "start_time": "2026-08-24T19:01:00", "duration_sec": 210, "cell_tower_id": 41}],
            ),
        ),
        (
            "transaction",
            csv_text(
                NATIVE_TXN_COLUMNS,
                [{"sender_id": 351, "receiver_id": 352, "amount_inr": 52000, "txn_time": "2026-08-24T19:02:00", "mode": "UPI", "bank_ref": "REF-52000-351"}],
            ),
        ),
        (
            "location",
            csv_text(
                NATIVE_LOCATION_COLUMNS,
                [{"person_id": 353, "location_id": 7, "observed_at": "2026-08-24T19:03:00"}],
            ),
        ),
        (
            "fir",
            csv_text(
                NATIVE_FIR_COLUMNS,
                [{"complainant_id": 354, "accused_id": 355, "date": "2026-08-24", "narrative": NARRATIVE, "location_id": 5}],
            ),
        ),
    ]


def test_files_exported_with_the_dataset_column_names_import_as_themselves(client):
    before = state(client)
    body = batch(client, native_files()).json()

    assert [f["status"] for f in body["files"]] == ["ok"] * 4
    assert body["counts"] == {
        "total": 4,
        "new_valid": 4,
        "duplicate": 0,
        "review_required": 0,
        "rejected": 0,
    }
    assert body["rejected_rows"] == []
    assert [f["reason"] for f in body["files"]] == [None] * 4
    assert body["commit_applicable"] is True
    assert state(client) == before


def test_a_file_of_places_says_it_cannot_name_a_person_and_says_it_once(client):
    """A file-level fact is reported at the file, not as N rejected rows."""
    body = batch(
        client,
        [("location", PLACES), ("call", calls((356, 357, 25)))],
        names=["locations.csv", "calls.csv"],
    ).json()
    places, good = body["files"]

    assert places["status"] == "error"
    assert places["error"] == "No column identifies the person of a location row."
    assert places["counts"]["total"] == 0
    assert places["counts"]["rejected"] == 0
    assert good["status"] == "ok"
    assert body["counts"]["new_valid"] == 1


# --- confirm and reject -----------------------------------------------------
def test_confirm_recomputes_once_and_audits_once_for_the_whole_batch(client, monkeypatch):
    pipeline = client.app.state.ingest
    runs: list[int] = []
    original = pipeline.recomputer.run

    def counted(**kwargs):
        runs.append(1)
        return original(**kwargs)

    monkeypatch.setattr(pipeline.recomputer, "run", counted)

    before = state(client)
    preview = batch(
        client,
        [
            ("call", calls((341, 342, 13))),
            ("transaction", transactions((343, 344, 709))),
            ("location", locations((345, 9))),
        ],
    ).json()
    assert preview["counts"]["new_valid"] == 3
    # The preview's own analysis runs on its own Recomputer, never the live one.
    assert runs == []

    body = client.post(f"{BASE}/bulk/{preview['import_id']}/confirm").json()
    assert runs == [1], "one recomputation for the import, not one per file"

    after = state(client)
    assert after["records"] == before["records"] + 3
    assert after["chain"] == before["chain"] + 1, "one audit event, not one per file"
    assert body["counts"]["imported"] == 3
    assert body["counts"]["files"] == 3
    assert body["graph_before"] == {"nodes": before["nodes"], "edges": before["edges"]}
    assert body["graph_totals"]["edges"] == after["edges"]
    assert body["recompute_error"] is None

    event = client.app.state.audit.ledger.all_events()[-1]
    assert event.action.value == "INGEST_BULK_CONFIRMED"
    assert event.resource_id == preview["import_id"]
    assert event.metadata["source_type"] == "CALL+LOCATION+TRANSACTION"
    assert event.metadata["files_count"] == 3
    assert event.metadata["imported_count"] == 3
    assert event.metadata["manifest_hash"] == body["manifest_hash"]
    assert body["audit_event_id"] == event.audit_event_id
    assert client.get("/api/v1/audit/verify").json()["status"] == "VERIFIED"

    # Confirming again — by the batch id or by any file's id — is a clean 404.
    for import_id in preview["import_ids"]:
        assert client.post(f"{BASE}/bulk/{import_id}/confirm").status_code == 404
    assert state(client) == after


def test_rejecting_a_combined_preview_writes_nothing(client):
    before = state(client)
    preview = batch(
        client,
        [("call", calls((351, 352, 15))), ("transaction", transactions((353, 354, 710)))],
    ).json()
    assert preview["counts"]["new_valid"] == 2

    # The client rejects every id it was given; the first discards the import and
    # the rest are already gone, which is not an error.
    discarded = [
        client.post(f"{BASE}/bulk/{import_id}/reject").json()["discarded"]
        for import_id in preview["import_ids"]
    ]
    assert discarded == [True, False, False]
    assert state(client) == before
    assert client.post(f"{BASE}/bulk/{preview['import_id']}/confirm").status_code == 404
    assert state(client) == before


def test_a_selection_with_no_usable_file_is_reported_not_crashed(client):
    before = state(client)
    body = batch(client, [("call", "a,b\n1,2\n"), ("transaction", "c,d\n3,4\n")]).json()
    assert [f["status"] for f in body["files"]] == ["error", "error"]
    assert body["counts"]["total"] == 0
    assert body["commit_applicable"] is False
    assert state(client) == before


def test_an_unknown_source_type_is_a_clean_400(client):
    before = state(client)
    response = batch(client, [("unknown", calls((355, 356, 16)))])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
    assert state(client) == before


def test_more_than_four_files_is_refused_by_the_schema(client):
    response = batch(client, [("call", calls((357, 358, i))) for i in range(17, 22)])
    assert response.status_code == 422


# --- integrity and single-type compatibility --------------------------------
def test_the_dataset_files_are_untouched_after_every_request_above(
    client, dataset_digest
):
    directory = client.app.state.settings.dataset_dir
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }
    assert after == dataset_digest


def test_the_single_type_route_is_unchanged(client):
    """§22: the mode that existed before this phase behaves as it did."""
    content = calls((361, 362, 23))
    response = client.post(
        f"{BASE}/bulk/call/preview", json={"filename": "one.csv", "content": content}
    )
    assert response.status_code == 200
    body = response.json()

    assert body["source_type"] == "CALL"
    assert body["counts"]["new_valid"] == 1
    # A single-type preview is not a batch: no per-file section, and its own id.
    assert "files" not in body
    assert "import_ids" not in body
    assert frames(client, body["import_id"])[0]["stage"] == "received"
    assert "detail" not in frames(client, body["import_id"])[0]
    assert body["duplicate_rows"] == []

    committed = client.post(f"{BASE}/bulk/{body['import_id']}/confirm").json()
    assert committed["counts"]["imported"] == 1
    assert committed["source_type"] == "CALL"
    assert committed["files"] is None
    assert committed["import_ids"] == []
    assert client.get("/api/v1/audit/verify").json()["status"] == "VERIFIED"
