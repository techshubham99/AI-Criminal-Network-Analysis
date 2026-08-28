"""Phase 4.6 §15 demo flow, driven over live HTTP.

Runs the deterministic scenario against a running server and records each
response. Nothing here fabricates a verdict: every status printed is whatever
the pipeline answered, and the recorded bodies are reused verbatim as frontend
test fixtures so the UI is tested against real backend output.

    python -m scripts.phase4_6_demo --base http://127.0.0.1:8011 --record

``--record`` writes the response bodies into ``frontend/src/test/fixtures/``.
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "frontend" / "src" / "test" / "fixtures"

# Two existing subjects and one third party, read from the corpus:
#   141 Yashica Borah  +91-8600506062  245220443325  Bhopal,  Madhya Pradesh
#    21 Gunbir Sankar  +91-8298229437  877449847333  Lucknow, Uttar Pradesh
#     7 Sudiksha Patla +91-8395925222  633356940935  Lucknow, Uttar Pradesh
CALL_BODY = {
    "provenance": {"source_name": "station-log", "submitted_by": "demo", "reference": "CDR-4471"},
    "caller": {"person_id": 141},
    "callee": {"person_id": 21},
    "start_time": "2026-08-20T21:40",
    "duration_sec": 415,
}

STEPS: list[tuple[str, str, str, Optional[dict[str, Any]], Optional[str]]] = [
    # label, method, path, body, fixture name
    ("A  before / graph", "GET", "/api/v1/graph/summary", None, None),
    ("A  before / intel", "GET", "/api/v1/intelligence/summary", None, None),
    ("A  before / p141", "GET", "/api/v1/intelligence/persons/141", None, None),
    ("B  valid call", "POST", "/api/v1/ingest/call", CALL_BODY, "ingest-call-accepted"),
    ("C  same call again", "POST", "/api/v1/ingest/call", CALL_BODY, "ingest-call-duplicate"),
    (
        "D  invalid call",
        "POST",
        "/api/v1/ingest/call",
        {
            "provenance": {"source_name": "manual-entry"},
            "caller": {"phone": "12345"},
            "callee": {"person_id": 21},
            "start_time": "not-a-time",
            "duration_sec": -3,
        },
        "ingest-call-rejected",
    ),
    (
        "E  unrelated pair",
        "POST",
        "/api/v1/ingest/call",
        {
            "provenance": {"source_name": "new-case-file"},
            "caller": {"phone": "9812345670"},
            "callee": {"phone": "9812345671"},
            "start_time": "2026-08-22T11:05",
            "duration_sec": 96,
        },
        "ingest-call-review",
    ),
    (
        "F  transaction",
        "POST",
        "/api/v1/ingest/transaction",
        {
            "provenance": {"source_name": "bank-statement", "reference": "STMT-88"},
            "sender": {"person_id": 141},
            "receiver": {"person_id": 7},
            "amount_inr": 250000,
            "txn_time": "2026-08-20T22:15",
            "mode": "UPI",
            "bank_ref": "UPI-DEMO-4601",
        },
        "ingest-transaction-accepted",
    ),
    (
        "G  FIR",
        "POST",
        "/api/v1/ingest/fir",
        {
            "provenance": {"source_name": "station-log", "submitted_by": "demo"},
            "date": "2026-08-21",
            "complainant": {"person_id": 21},
            "accused": {"person_id": 141},
            "narrative": (
                "Complainant Gunbir Sankar reports that Yashica Borah called him "
                "from 8600506062 on 20-08-2026 demanding payment, and that an "
                "amount of Rs 250000 was transferred by UPI the same night."
            ),
            "city": "Lucknow",
            "state": "Uttar Pradesh",
        },
        "ingest-fir-accepted",
    ),
    (
        "H  location (own place)",
        "POST",
        "/api/v1/ingest/location",
        {
            "provenance": {"source_name": "field-report"},
            "person": {"person_id": 141},
            "observed_at": "2026-08-21T09:30",
            "city": "Bhopal",
            "state": "Madhya Pradesh",
        },
        "ingest-location-accepted",
    ),
    (
        "I  location (crowded city)",
        "POST",
        "/api/v1/ingest/location",
        {
            "provenance": {"source_name": "field-report"},
            "person": {"person_id": 141},
            "observed_at": "2026-08-21T18:05",
            "city": "Chennai",
            "state": "Tamil Nadu",
        },
        "ingest-location-ambiguous",
    ),
    (
        "J  conflicting identifiers",
        "POST",
        "/api/v1/ingest/call",
        {
            "provenance": {"source_name": "manual-entry"},
            "caller": {"phone": "8600506062", "aadhaar": "877449847333"},
            "callee": {"person_id": 7},
            "start_time": "2026-08-22T08:12",
            "duration_sec": 61,
        },
        "ingest-call-ambiguous",
    ),
    ("K  after / graph", "GET", "/api/v1/graph/summary", None, None),
    ("K  after / intel", "GET", "/api/v1/intelligence/summary", None, None),
    ("K  after / p141", "GET", "/api/v1/intelligence/persons/141", None, None),
    ("K  after / changes", "GET", "/api/v1/entities/person:141/changes", None, "entity-changes-141"),
    ("K  after / records", "GET", "/api/v1/ingest/records?limit=5", None, None),
    ("K  after / summary", "GET", "/api/v1/ingest/summary", None, None),
]


def call(base: str, method: str, path: str, body: Optional[dict]) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:  # a 4xx is a result, not a crash
        return error.code, json.loads(error.read() or b"null")


def digest(path: str, payload: Any) -> str:
    if not isinstance(payload, dict):
        return str(payload)[:160]
    if "/ingest/" in path and "record_id" in payload:
        impact = payload.get("impact") or {}
        graph = impact.get("graph") or {}
        cost = impact.get("recompute_cost_ms") or {}
        return " ".join(
            part
            for part in (
                payload["status"],
                payload.get("review_reason") or payload.get("reject_reason") or "",
                f"id={payload['record_id'][:10]}",
                f"nodes+{len(graph.get('nodes_added') or [])}",
                f"edges+{len(graph.get('edges_added') or [])}",
                f"upd={len(graph.get('edges_updated') or [])}",
                f"new_patterns={len(impact.get('new_pattern_ids') or [])}",
                f"prio={len(impact.get('priority_changes') or [])}",
                f"{round(cost.get('total_ms') or 0)}ms",
            )
            if part
        )
    keys = ("nodes", "edges", "total_nodes", "total_edges", "pattern_count", "person_count",
            "score", "band", "modularity", "community_count", "total", "accepted",
            "duplicate", "review_required", "rejected", "changes", "priority_score")
    flat = {k: v for k, v in payload.items() if k in keys and not isinstance(v, (list, dict))}
    if not flat:
        nested = {k: v for k, v in payload.items() if isinstance(v, dict)}
        for name, block in nested.items():
            inner = {k: v for k, v in block.items() if k in keys}
            if inner:
                flat[name] = inner
    return json.dumps(flat)[:220] if flat else json.dumps(payload)[:200]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8011")
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()

    recorded: dict[str, Any] = {}
    for label, method, path, body, fixture in STEPS:
        status, payload = call(args.base, method, path, body)
        print(f"{label:26} {method:4} {status} {digest(path, payload)}")
        if fixture:
            recorded[fixture] = payload
        if fixture == "ingest-call-accepted" and isinstance(payload, dict):
            record_id = payload.get("record_id")
            if record_id:
                for suffix, name in ((f"/{record_id}", "ingest-record"),
                                     (f"/{record_id}/impact", "ingest-impact")):
                    code, got = call(args.base, "GET", f"/api/v1/ingest{suffix}", None)
                    print(f"{'  -> ' + name:26} GET  {code} {digest(suffix, got)}")
                    recorded[name] = got

    if args.record:
        for name, payload in recorded.items():
            target = FIXTURES / f"{name}.json"
            target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"\nrecorded {len(recorded)} fixture(s) into {FIXTURES}")


if __name__ == "__main__":
    main()
