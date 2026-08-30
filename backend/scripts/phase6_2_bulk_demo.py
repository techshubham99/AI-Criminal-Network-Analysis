"""Phase 6.2 demo flow: a CSV previewed, committed, re-uploaded and rejected.

Runs the whole decision cycle in one command and prints only what the application
answered. Sections A-E are the single-type flow; F-H are the Phase 6.2b flow,
where several files of different types are previewed as ONE import. Section I is
the same mode fed the corpus's own column spelling, plus the two files that add
nothing for reasons that are not "already in the system".

    python -m scripts.phase6_2_bulk_demo
    python -m scripts.phase6_2_bulk_demo --record

``--record`` writes the preview, confirm, re-upload and reject responses — plus
the progress frames each preview published on the live channel — into
``frontend/src/test/fixtures/``, so the import UI is tested against real backend
output rather than a hand-written stub.

Like ``phase5_audit_demo.py`` this drives the app in-process through Starlette's
test client: the flow needs one graph observed before and after a commit, and one
process makes that unambiguous. Persistence is off by default, so nothing here
outlives the run, and the synthetic dataset is never written to.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "frontend" / "src" / "test" / "fixtures"

BULK = "/api/v1/ingest/bulk"

FIELDS = (
    "caller_person_id",
    "callee_person_id",
    "callee_name",
    "start_time",
    "duration_sec",
    "cell_tower_id",
)

# One file carrying all four verdicts: two observations that are new, the first of
# them repeated, one unusable duration, and one party who matches nobody.
ROWS = (
    {"caller_person_id": 301, "callee_person_id": 302, "start_time": "2026-08-25T09:05:00", "duration_sec": 214, "cell_tower_id": 12},
    {"caller_person_id": 303, "callee_person_id": 304, "start_time": "2026-08-25T09:11:00", "duration_sec": 96, "cell_tower_id": 12},
    {"caller_person_id": 301, "callee_person_id": 302, "start_time": "2026-08-25T09:05:00", "duration_sec": 214, "cell_tower_id": 12},
    {"caller_person_id": 305, "callee_person_id": 306, "start_time": "2026-08-25T09:18:00", "duration_sec": -5, "cell_tower_id": 12},
    {"caller_person_id": 307, "callee_name": "Zarvix Quorlan", "start_time": "2026-08-25T09:24:00", "duration_sec": 60, "cell_tower_id": 12},
)


def csv_text(rows: tuple[dict[str, Any], ...] = ROWS) -> str:
    header = ",".join(FIELDS)
    lines = [",".join(str(row.get(field, "")) for field in FIELDS) for row in rows]
    return "\n".join([header, *lines]) + "\n"


# --- Phase 6.2b: three files chosen at once ---------------------------------
# Persons 411 and 412 speak in one file and move money in the other. Neither file
# alone gives the multi-channel detector two channels for the pair; the two
# analysed together do, which is the whole point of a combined preview.
TXN_FIELDS = (
    "sender_person_id",
    "receiver_person_id",
    "amount_inr",
    "txn_time",
    "mode",
    "bank_ref",
)
BATCH_CALLS = (
    {"caller_person_id": 411, "callee_person_id": 412, "start_time": "2026-08-26T10:05:00", "duration_sec": 168, "cell_tower_id": 12},
    {"caller_person_id": 413, "callee_person_id": 414, "start_time": "2026-08-26T10:19:00", "duration_sec": -5, "cell_tower_id": 12},
)
BATCH_TXNS = (
    {"sender_person_id": 411, "receiver_person_id": 412, "amount_inr": 48000, "txn_time": "2026-08-26T11:02:00", "mode": "UPI", "bank_ref": "REF-48000-411"},
)


def csv_of(fields: tuple[str, ...], rows: tuple[dict[str, Any], ...]) -> str:
    header = ",".join(fields)
    lines = [",".join(str(row.get(field, "")) for field in fields) for row in rows]
    return "\n".join([header, *lines]) + "\n"


def batch_files(include_broken: bool = True, committed_only: bool = False) -> list[dict[str, str]]:
    """The selection an operator would make. ``committed_only`` re-uploads exactly
    the rows a previous commit wrote, which is the all-duplicate case."""
    calls = BATCH_CALLS[:1] if committed_only else BATCH_CALLS
    files = [
        {
            "source_type": "call",
            "filename": "calls-aug26.csv",
            "content": csv_of(FIELDS, calls),
        },
        {
            "source_type": "transaction",
            "filename": "transfers-aug26.csv",
            "content": csv_of(TXN_FIELDS, BATCH_TXNS),
        },
    ]
    if include_broken:
        # A file the parser cannot read at all: it is reported on its own row and
        # the other two are still previewed.
        files.append(
            {
                "source_type": "location",
                "filename": "seen-aug26.csv",
                "content": "who,where\n411,pune\n",
            }
        )
    return files


# --- The corpus's own column spelling, and the three ways of adding nothing ---
# `calls.csv` names its parties `caller_id`/`callee_id`, not `caller_person_id`:
# the same column names the graph builder and the live store use. A file exported
# from the dataset must import as itself, so this section uploads exactly that
# spelling. Alongside it, one file whose every row is unusable and one whose header
# cannot name a person at all — three files, three different reasons for three
# different statuses, none of them "already in the system".
NATIVE_CALL_FIELDS = ("caller_id", "callee_id", "start_time", "duration_sec", "cell_tower_id")
NATIVE_CALLS = (
    {"caller_id": 421, "callee_id": 422, "start_time": "2026-08-27T09:14:00", "duration_sec": 233, "cell_tower_id": 41},
    {"caller_id": 423, "callee_id": 424, "start_time": "2026-08-27T09:31:00", "duration_sec": 187, "cell_tower_id": 41},
)
NATIVE_TXN_FIELDS = ("sender_id", "receiver_id", "amount_inr", "txn_time", "mode", "bank_ref")
# Every amount is zero, so every row is REJECTED — a file that adds nothing because
# nothing in it is usable, which is not the same as a file already accounted for.
UNUSABLE_TXNS = (
    {"sender_id": 421, "receiver_id": 422, "amount_inr": 0, "txn_time": "2026-08-27T10:02:00", "mode": "UPI", "bank_ref": "REF-A"},
    {"sender_id": 423, "receiver_id": 424, "amount_inr": 0, "txn_time": "2026-08-27T10:09:00", "mode": "UPI", "bank_ref": "REF-B"},
)
# The corpus's `locations.csv` header verbatim: a table of places, with no column
# that could name the person observed at one.
PLACES_CSV = "location_id,state,city,latitude,longitude\n1,Delhi,New Delhi,8.725312,75.97585\n"


def native_files() -> list[dict[str, str]]:
    return [
        {
            "source_type": "call",
            "filename": "calls.csv",
            "content": csv_of(NATIVE_CALL_FIELDS, NATIVE_CALLS),
        },
        {
            "source_type": "transaction",
            "filename": "transactions.csv",
            "content": csv_of(NATIVE_TXN_FIELDS, UNUSABLE_TXNS),
        },
        {"source_type": "location", "filename": "locations.csv", "content": PLACES_CSV},
    ]


# --- what the preview's own tables read -------------------------------------
# Two persons who call each other AND send money both ways. That one shape is
# enough for several *different* existing detectors to fire on the same overlay —
# a reciprocal transaction cycle, a multi-channel pair, fan-in and fan-out at
# both hubs — which is what makes it the honest fixture for a screen that groups
# findings by pattern type. Nothing here is tuned to produce a given tab; the
# tabs show whatever the detectors say about it.
RICH_FILES = [
    {
        "source_type": "call",
        "filename": "calls-pair.csv",
        "content": (
            "caller_id,callee_id,start_time,duration_sec,cell_tower_id\n"
            "461,462,2026-08-28T09:05:00,214,41\n"
            "462,461,2026-08-28T09:41:00,96,41\n"
        ),
    },
    {
        "source_type": "transaction",
        "filename": "transfers-pair.csv",
        "content": (
            "sender_id,receiver_id,amount_inr,txn_time,mode,bank_ref\n"
            "461,462,48000,2026-08-28T10:02:00,UPI,REF-X1\n"
            "462,461,47000,2026-08-28T10:44:00,UPI,REF-X2\n"
        ),
    },
]


def show(label: str, value: Any) -> None:    print(f"{label:<34} {value}")


def digests(directory: Path) -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*.csv"))
    }


def frames(client: TestClient, import_id: str) -> list[dict[str, Any]]:
    return [
        event.as_dict()
        for event in client.app.state.ingest.bus.recent()
        if event.event_type.value == "bulk_preview"
        and event.data["import_id"] == import_id
    ]


def graph_totals(client: TestClient) -> tuple[int, int]:
    store = client.app.state.graph.store
    return store.node_count(), store.edge_count()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", action="store_true", help="write frontend fixtures")
    args = parser.parse_args()
    recorded: dict[str, Any] = {}
    content = csv_text()

    with TestClient(create_app()) as client:
        dataset = client.app.state.settings.dataset_dir
        before_files = digests(dataset)

        print("\n=== A  the file is judged, and nothing is written ===")
        nodes_before, edges_before = graph_totals(client)
        preview = client.post(
            f"{BULK}/call/preview", json={"filename": "calls-batch.csv", "content": content}
        ).json()
        recorded["bulk-preview-call"] = preview
        recorded["bulk-preview-events"] = frames(client, preview["import_id"])
        show("import", preview["import_id"][:16] + "...")
        show("counts", preview["counts"])
        show("commit applicable", preview["commit_applicable"])
        show("stages published", [f["data"]["stage"] for f in recorded["bulk-preview-events"]])
        show("live graph unchanged", graph_totals(client) == (nodes_before, edges_before))
        show("preview graph (overlay)", preview["metrics_preview"]["graph"]["edge_count"])
        show("patterns it would add", preview["suspicious_patterns_preview"]["total"])
        show("network shown", f"{len(preview['network_preview']['nodes'])} entities")
        for row in preview["review_required_rows"] + preview["rejected_rows"]:
            print(f"  row {row['row']}  {row['verdict']:<16} {row['reason']}")

        print("\n=== B  the operator adds it, once ===")
        confirmed = client.post(f"{BULK}/{preview['import_id']}/confirm").json()
        recorded["bulk-confirm-call"] = confirmed
        show("committed", confirmed["counts"]["imported"])
        show("graph totals", confirmed["graph_totals"])
        show("matches the preview", confirmed["graph_totals"]["edges"] == preview["metrics_preview"]["graph"]["edge_count"])
        show("audit events for the import", 1 if confirmed["audit_event_id"] else 0)
        show("manifest", (confirmed["manifest_hash"] or "")[:16] + "...")
        show("chain", client.get("/api/v1/audit/verify").json()["status"])
        show("committing again", client.post(f"{BULK}/{preview['import_id']}/confirm").status_code)

        print("\n=== C  the two committed rows, uploaded again ===")
        again = client.post(
            f"{BULK}/call/preview",
            json={"filename": "calls-batch.csv", "content": csv_text(ROWS[:2])},
        ).json()
        recorded["bulk-preview-duplicates"] = again
        show("counts", again["counts"])
        show("commit applicable", again["commit_applicable"])
        show("patterns claimed", again["suspicious_patterns_preview"]["patterns"])
        show("note", again["metrics_preview"].get("note"))

        print("\n=== D  a preview is rejected ===")
        nodes_now, edges_now = graph_totals(client)
        rejected = client.post(f"{BULK}/{again['import_id']}/reject").json()
        recorded["bulk-reject"] = rejected
        show("discarded", rejected["discarded"])
        show("graph unchanged", graph_totals(client) == (nodes_now, edges_now))
        show("confirming it now", client.post(f"{BULK}/{again['import_id']}/confirm").status_code)
        show("rejecting it again", client.post(f"{BULK}/{again['import_id']}/reject").json()["discarded"])

        print("\n=== E  the dataset files ===")
        show("SHA-256 unchanged", digests(dataset) == before_files)

        print("\n=== F  three files chosen at once, previewed as one import ===")
        nodes_now, edges_now = graph_totals(client)
        batch = client.post(f"{BULK}/preview", json={"files": batch_files()}).json()
        recorded["bulk-preview-batch"] = batch
        recorded["bulk-preview-batch-events"] = frames(client, batch["import_id"])
        show("import", batch["import_id"][:16] + "...")
        show("types", batch["source_type"])
        show("combined counts", batch["counts"])
        show("stage sequences published", 1)
        show("stages", [f["data"]["stage"] for f in recorded["bulk-preview-batch-events"]])
        for f in batch["files"]:
            note = f["error"] or f"new {f['counts']['new_valid']} of {f['counts']['total']}"
            print(f"  [{f['source_type']:<12}] {f['filename']:<20} {f['status']:<8} {note}")
        show("graph before", batch["graph_before"])
        show("graph in preview", batch["metrics_preview"]["graph"])
        show("live graph unchanged", graph_totals(client) == (nodes_now, edges_now))
        cross = [
            p
            for p in batch["suspicious_patterns_preview"]["patterns"]
            if p["pattern_type"] == "MULTI_CHANNEL_RELATIONSHIP"
        ]
        show("patterns it would add", batch["suspicious_patterns_preview"]["total"])
        for p in cross:
            print(f"  {p['pattern_type']}  {p['entity_ids']}  channels={p['detail']['channels']}")

        print("\n=== G  added together: one recomputation, one audit event ===")
        chain_before = len(client.app.state.audit.ledger.all_events())
        done = client.post(f"{BULK}/{batch['import_id']}/confirm").json()
        recorded["bulk-confirm-batch"] = done
        show("committed", done["counts"]["imported"])
        show("per file", [(f["source_type"], f["status"], f["imported"]) for f in done["files"]])
        show("audit events added", len(client.app.state.audit.ledger.all_events()) - chain_before)
        show("graph before → after", (done["graph_before"], done["graph_totals"]))
        show("chain", client.get("/api/v1/audit/verify").json()["status"])

        print("\n=== H  the same two files, uploaded again ===")
        repeat = client.post(
            f"{BULK}/preview",
            json={"files": batch_files(include_broken=False, committed_only=True)},
        ).json()
        recorded["bulk-preview-batch-duplicates"] = repeat
        show("counts", repeat["counts"])
        show("commit applicable", repeat["commit_applicable"])
        show("per file", [(f["source_type"], f["status"]) for f in repeat["files"]])
        show("rejecting it", client.post(f"{BULK}/{repeat['import_id']}/reject").json()["discarded"])
        show("dataset SHA-256 unchanged", digests(dataset) == before_files)

        print("\n=== I  the corpus's own column names, and why a file added nothing ===")
        native = client.post(f"{BULK}/preview", json={"files": native_files()}).json()
        recorded["bulk-preview-batch-native"] = native
        show("combined counts", native["counts"])
        for f in native["files"]:
            note = f["error"] or f["reason"] or ""
            print(f"  [{f['source_type']:<12}] {f['filename']:<18} {f['status']:<9} {note}")
        show("no file called 'skipped'", all(f["status"] != "skipped" for f in native["files"]))
        show("rejecting it", client.post(f"{BULK}/{native['import_id']}/reject").json()["discarded"])
        show("dataset SHA-256 unchanged", digests(dataset) == before_files)

        print("\n=== J  what the preview tables read ===")
        rich = client.post(f"{BULK}/preview", json={"files": RICH_FILES}).json()
        recorded["bulk-preview-batch-rich"] = rich
        show("combined counts", rich["counts"])
        by_type: dict[str, int] = {}
        for p in rich["suspicious_patterns_preview"]["patterns"]:
            by_type[p["pattern_type"]] = by_type.get(p["pattern_type"], 0) + 1
        for name, n in sorted(by_type.items()):
            print(f"  {name:<32} {n}")
        players = rich["metrics_preview"]["key_players"]
        show("key players", len(players))
        for p in players[:3]:
            print(
                f"  {p['entity_id']:<12} {str(p['name'])[:22]:<24} "
                f"degree={p['degree_centrality']} btw={p['betweenness']} "
                f"pr={p['pagerank']} community={p['community_id']}"
            )
        detected = rich["metrics_preview"]["communities"]["detected"]
        show("communities listed", len(detected))
        for c in detected[:2]:
            print(
                f"  community {c['community_id']}  size {c['size']}  "
                f"sample {len(c['members_sample'])}  {c['member_names'][:2]}"
            )
        show("rejecting it", client.post(f"{BULK}/{rich['import_id']}/reject").json()["discarded"])
        show("dataset SHA-256 unchanged", digests(dataset) == before_files)

    if args.record:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        for name, payload in recorded.items():
            path = FIXTURES / f"{name}.json"
            path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(f"recorded {path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
