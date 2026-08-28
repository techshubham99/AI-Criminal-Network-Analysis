"""Phase 5 §15 demo flow: the audit chain, the suppression rules, and tamper detection.

Runs the whole demonstration in one command and prints only what the application
actually answered. Nothing here fabricates a status.

    python -m scripts.phase5_audit_demo
    python -m scripts.phase5_audit_demo --record

``--record`` writes the two chain-verification responses into
``frontend/src/test/fixtures/`` so the UI's integrity view is tested against real
backend output rather than a hand-written stub.

Unlike ``phase4_6_demo.py``, this drives the app in-process through Starlette's
test client instead of a separate server. The demonstration needs a *before* and
*after* view of one specific chain, and one process makes that unambiguous — the
routes exercised are the same real routes either way.

Step E is the only place in this repository that modifies a recorded audit event.
It does so in memory, on purpose, to show that the modification is detected. The
synthetic dataset is never touched by any step.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "frontend" / "src" / "test" / "fixtures"

AUDIT = "/api/v1/audit"
INGEST = "/api/v1/ingest"

# Two existing subjects, read from the corpus (same pair as the Phase 4.6 demo).
CALL_BODY = {
    "provenance": {"source_name": "station-log", "submitted_by": "demo", "reference": "CDR-5501"},
    "caller": {"person_id": 141},
    "callee": {"person_id": 21},
    "start_time": "2026-08-23T20:10",
    "duration_sec": 372,
}

# The illustrative evidence summary of §7. Counts and ids only: this stands in
# for whatever a future report feature would produce, and there is no report
# builder in this phase.
EVIDENCE_SUMMARY = {
    "case_reference": "DEMO-CASE-1",
    "prepared_at": "2026-08-23T20:15:00",
    "entities": ["person:141", "person:21"],
    "relationship_count": 2,
    "pattern_count": 1,
}


def show(label: str, value: Any) -> None:
    print(f"{label:<34} {value}")


def short(digest: str, size: int = 12) -> str:
    return digest[:size] + "..." if len(digest) > size else digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", action="store_true", help="write frontend fixtures")
    args = parser.parse_args()
    recorded: dict[str, Any] = {}

    with TestClient(create_app()) as client:
        print("\n=== A  genesis and the empty chain ===")
        start = client.get(f"{AUDIT}/summary").json()
        show("backend", start["backend"])
        show("persistence", "on" if start["persisted"] else "off")
        show("chain length at start", start["chain_length"])
        show("head == SHA256(\"\")", start["head_hash"])

        print("\n=== B  one real submission, and what it audits ===")
        submitted = client.post(f"{INGEST}/call", json=CALL_BODY).json()
        impact = submitted["impact"]
        show("ingestion decision", submitted["status"])
        show("audit events appended", impact.get("audit_event_ids"))
        show("new relationships", len(impact.get("graph", {}).get("edges_added") or []))
        show("merged (not audited)", len(impact.get("graph", {}).get("edges_updated") or []))
        show("new patterns", len(impact.get("new_pattern_ids") or []))
        show("re-identified (NOT audited)", impact.get("reidentified_pattern_count"))
        changes = impact.get("priority_changes") or []
        bands = [c for c in changes if c["band_before"] != c["band_after"]]
        show("score changes", len(changes))
        show("band changes (audited)", len(bands))
        show("numeric-only (NOT audited)", len(changes) - len(bands))

        for event_id in impact.get("audit_event_ids") or []:
            event = client.get(f"{AUDIT}/events/{event_id}").json()
            print(
                f"  {event['audit_event_id']}  {event['action']:<22}"
                f" {event['resource_type']:<13} {event['resource_id'][:34]:<34}"
                f" prev={short(event['previous_hash'], 8)} cur={short(event['current_hash'], 8)}"
            )

        print("\n=== C  chain verification ===")
        verified = client.get(f"{AUDIT}/verify").json()
        recorded["audit-verify"] = verified
        show("status", verified["status"])
        show("events checked", verified["events_checked"])
        show("genesis previous_hash", verified["genesis_previous_hash"])
        show("head", verified["head_hash"])

        print("\n=== D  content integrity, original then one field changed ===")
        commit = client.post(
            f"{AUDIT}/records",
            json={
                "resource_id": "demo-evidence-summary",
                "content": EVIDENCE_SUMMARY,
                "content_type": "evidence_summary",
            },
        ).json()
        show("committed", f"created={commit['created']} hash={short(commit['integrity_record']['content_hash'])}")
        show("original content", commit["verification"]["status"])

        unchanged = client.post(
            f"{AUDIT}/records",
            json={"resource_id": "demo-evidence-summary", "content": EVIDENCE_SUMMARY},
        ).json()
        show("same content again", unchanged["verification"]["status"])

        tampered_content = {**EVIDENCE_SUMMARY, "relationship_count": 3}
        changed = client.post(
            f"{AUDIT}/records",
            json={"resource_id": "demo-evidence-summary", "content": tampered_content},
        ).json()
        check = changed["verification"]
        show("one field changed", check["status"])
        show("  expected hash", short(check["expected_hash"], 16))
        show("  actual hash", short(check["actual_hash"], 16))
        show("  reason", check["failure"]["reason"])
        show("commitment unchanged", short(changed["integrity_record"]["content_hash"]))
        show("chain still", client.get(f"{AUDIT}/verify").json()["status"])

        print("\n=== E  a recorded event is modified in memory ===")
        # The one deliberate tamper in this repository. In-memory only; the
        # dataset and the ingestion store are untouched.
        target = client.app.state.audit.ledger._events[0]
        original_actor = target.actor
        target.actor = "someone_else"
        compromised = client.get(f"{AUDIT}/verify").json()
        recorded["audit-verify-compromised"] = compromised
        show("status", compromised["status"])
        show("event", compromised["failure"]["audit_event_id"])
        show("reason", compromised["failure"]["reason"])
        show("expected hash", short(compromised["failure"]["expected_hash"], 16))
        show("actual hash", short(compromised["failure"]["actual_hash"], 16))
        show("events checked", compromised["events_checked"])
        target.actor = original_actor
        show("after restoring the field", client.get(f"{AUDIT}/verify").json()["status"])

        print("\n=== F  what the ledger does NOT contain ===")
        events = client.get(f"{AUDIT}/events", params={"limit": 200}).json()
        body = json.dumps(events)
        for probe, label in (
            ("8600506062", "caller phone"),
            ("877449847333", "callee Aadhaar"),
            ("DEMO-CASE-1", "content field value"),
            ("narrative", "FIR text key"),
        ):
            show(f"{label} in ledger", probe in body)
        show("events on the chain", events["total"])

    if args.record:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        for name, payload in recorded.items():
            path = FIXTURES / f"{name}.json"
            path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(f"recorded {path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
