"""Phase 4 HTTP tests for /api/v1/intelligence.

Covers the six endpoints, their error cases, and the two properties that are
easiest to lose at the serialisation boundary: the §7 evidence separation must
survive into the JSON, and the §11 distinction between the Phase 2 centrality
ranking and the Phase 4 priority ranking must remain visible to a client that
only ever reads JSON.
"""
from __future__ import annotations

import pytest

from app.risk.models import PatternType

API = "/api/v1/intelligence"


# --- /summary ---------------------------------------------------------------


def test_summary_reports_counts_bands_and_weights(client):
    r = client.get(f"{API}/summary")
    assert r.status_code == 200
    body = r.json()
    assert body["phase"].startswith("4 -")
    assert body["persons_scored"] > 0
    assert body["patterns_detected"] == sum(body["patterns_by_type"].values())
    assert body["feature_weight_total"] == 100.0
    assert set(body["feature_weights"]) == {
        "network_importance",
        "multi_channel_relationship",
        "transaction_patterns",
        "communication_anomaly",
        "location_patterns",
        "bridge_network_structure",
    }
    assert body["score_bands"]["boundaries"] == {
        "LOW": "0-39",
        "MEDIUM": "40-69",
        "HIGH": "70-100",
    }
    assert (
        sum(body["score_bands"]["distribution"].values()) == body["persons_scored"]
    )
    assert 0 <= body["score_stats"]["min"] <= body["score_stats"]["max"] <= 100
    assert body["structured_graph_mutated"] is False
    assert body["duplicate_pattern_ids_collapsed"] >= 0


def test_summary_lists_every_pattern_category_including_empty_ones(client):
    body = client.get(f"{API}/summary").json()
    assert set(body["patterns_by_type"]) == {p.value for p in PatternType}
    zero_named = {z["pattern_type"] for z in body["zero_result_categories"]}
    empty = {t for t, n in body["patterns_by_type"].items() if n == 0}
    # Zero is reported as zero, never quietly dropped or filled with an example.
    assert zero_named == empty


def test_summary_publishes_the_policies_and_coverage(client):
    body = client.get(f"{API}/summary").json()
    policy = body["self_reference_policy"].lower()
    assert "self-calls" in policy and "excluded" in policy
    assert "SAME_RING" in body["overlay_policy"]
    coverage = body["detection_coverage"]
    assert coverage["communication_anomaly"]["z_threshold"] == 2.0
    assert coverage["communication_anomaly"]["by_status"]
    assert coverage["transaction_patterns"]["self_transfers_excluded"] >= 0
    assert coverage["location_patterns"]["self_fir_references_excluded"] >= 0
    assert "betweenness" in coverage["bridge_network_structure"]["basis"]
    assert body["evidence_policy"]["separation"]
    assert "NOT a probability of guilt" in body["disclaimer"]


# --- /persons/top -----------------------------------------------------------


def test_top_persons_is_ranked_and_capped(client, settings):
    r = client.get(f"{API}/persons/top", params={"limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["persons"]) <= 10
    scores = [(-p["score"], p["person_id"]) for p in body["persons"]]
    assert scores == sorted(scores)
    for row in body["persons"]:
        assert 0 <= row["score"] <= 100
        assert row["band"] in {"LOW", "MEDIUM", "HIGH"}
        assert row["entity_id"] == f"person:{row['person_id']}"
        assert len(row["top_factors"]) <= 3
        assert all(f["contribution"] > 0 for f in row["top_factors"])
        assert row["structured_evidence_count"] >= 0
        assert row["nlp_evidence_count"] >= 0
    assert body["band_boundaries"]["HIGH"] == "70-100"


def test_top_persons_defaults_to_the_configured_page_size(client, settings):
    body = client.get(f"{API}/persons/top").json()
    assert body["limit"] == settings.intel_default_top
    assert body["count"] <= settings.intel_default_top


def test_top_persons_rejects_an_oversized_limit(client, settings):
    r = client.get(
        f"{API}/persons/top", params={"limit": settings.intel_max_top + 1}
    )
    assert r.status_code == 400
    error = r.json()["error"]
    assert error["code"] == "bad_request"
    assert error["detail"]["max"] == settings.intel_max_top


def test_top_persons_band_filter(client):
    r = client.get(f"{API}/persons/top", params={"band": "medium", "limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["band"] == "MEDIUM"
    assert all(p["band"] == "MEDIUM" for p in body["persons"])


def test_top_persons_rejects_an_unknown_band(client):
    r = client.get(f"{API}/persons/top", params={"band": "SEVERE"})
    assert r.status_code == 400
    error = r.json()["error"]
    assert error["code"] == "bad_request"
    assert error["detail"]["allowed"] == ["HIGH", "LOW", "MEDIUM"]


def test_top_persons_min_score_filter(client):
    body = client.get(f"{API}/persons/top", params={"min_score": 40}).json()
    assert all(p["score"] >= 40 for p in body["persons"])
    r = client.get(f"{API}/persons/top", params={"min_score": 101})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_top_persons_is_not_the_phase2_centrality_ranking(client):
    """§11 — two rankings, two questions, never merged."""
    intel = client.get(f"{API}/persons/top", params={"limit": 5})
    graph = client.get("/api/v1/analytics/persons/top", params={"limit": 5})
    assert intel.status_code == 200 and graph.status_code == 200
    note = intel.json()["note"]
    assert "/api/v1/analytics/persons/top" in note
    assert "NOT" in note
    # The Phase 4 rows carry a band and a score; the Phase 2 rows do not.
    assert all("band" in row for row in intel.json()["persons"])
    graph_rows = graph.json()
    rows = graph_rows["persons"] if isinstance(graph_rows, dict) else graph_rows
    if isinstance(rows, list) and rows:
        assert "band" not in rows[0]


def test_top_persons_is_stable_across_identical_requests(client):
    first = client.get(f"{API}/persons/top", params={"limit": 25}).json()
    second = client.get(f"{API}/persons/top", params={"limit": 25}).json()
    assert first == second


# --- /persons/{person_id} ---------------------------------------------------


def test_person_intelligence_returns_score_patterns_and_evidence(client, intelligence):
    person_id = intelligence.top_persons(1)[0].person_id
    r = client.get(f"{API}/persons/{person_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["person"]["person_id"] == person_id
    priority = body["priority"]
    assert priority["person_id"] == person_id
    assert priority["entity_id"] == f"person:{person_id}"
    assert 0 <= priority["score"] <= 100
    assert priority["band"] in {"LOW", "MEDIUM", "HIGH"}
    assert len(priority["factors"]) == 6
    # Evidence stays in two separate collections all the way into the JSON (§7).
    assert "structured_evidence" in priority and "nlp_evidence" in priority
    assert "evidence" not in priority
    for item in priority["structured_evidence"]:
        assert item["evidence_class"] == "STRUCTURED"
        assert item["confidence"] == 1.0
        assert item["source_dataset"] and ":" in item["source_record_id"]
    for item in priority["nlp_evidence"]:
        assert item["evidence_class"] == "NLP_DERIVED"
    assert "NOT a probability of guilt" in body["disclaimer"]


def test_person_intelligence_includes_baseline_and_phase2_position(client, intelligence):
    person_id = intelligence.high_activity_person_ids()[0]
    body = client.get(f"{API}/persons/{person_id}").json()
    baseline = body["communication_baseline"]
    assert baseline["anomaly_status"] == "high_activity_anomaly"
    assert baseline["z_score"] > 2.0
    assert baseline["baseline"]["observation_days"] >= 5
    assert baseline["supporting_call_ids"]
    # Phase 2 metrics are reported alongside, unchanged and clearly separate.
    position = body["network_position"]
    if position is not None:
        assert "betweenness" in position or "degree" in position


def test_person_intelligence_reports_an_insufficient_baseline_honestly(
    client, intelligence
):
    sparse = [
        pid
        for pid, base in intelligence.communication.baselines().items()
        if base.status == "insufficient_baseline_data"
    ]
    assert sparse, "the corpus is expected to contain sparsely observed persons"
    body = client.get(f"{API}/persons/{sparse[0]}").json()
    baseline = body["communication_baseline"]
    assert baseline["anomaly_status"] == "insufficient_baseline_data"
    assert baseline["z_score"] is None
    assert baseline["baseline"]["mean_calls_per_active_day"] is None
    assert baseline["supporting_call_ids"] == []


def test_person_intelligence_patterns_are_all_about_that_person(client, intelligence):
    person_id = intelligence.top_persons(1)[0].person_id
    body = client.get(f"{API}/persons/{person_id}").json()
    assert body["patterns"]
    for pattern in body["patterns"]:
        assert f"person:{person_id}" in pattern["entity_ids"]
        assert pattern["pattern_type"] in {p.value for p in PatternType}
        assert pattern["explanation"]
        assert 0.0 <= pattern["severity"] <= 1.0


def test_unknown_person_is_a_404(client):
    r = client.get(f"{API}/persons/999999")
    assert r.status_code == 404
    error = r.json()["error"]
    assert error["code"] == "not_found"


def test_non_positive_person_id_is_a_validation_error(client):
    r = client.get(f"{API}/persons/0")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


# --- /persons/{person_id}/explain -------------------------------------------


def test_explain_walks_through_the_arithmetic(client, intelligence):
    person_id = intelligence.top_persons(1)[0].person_id
    r = client.get(f"{API}/persons/{person_id}/explain")
    assert r.status_code == 200
    body = r.json()
    assert body["person_id"] == person_id
    assert len(body["factor_walkthrough"]) == 6
    total = 0.0
    for row in body["factor_walkthrough"]:
        assert row["arithmetic"] == (
            f"{row['feature_value']} x {row['max_contribution']} = "
            f"{row['contribution']}"
        )
        assert row["contribution"] == round(
            row["feature_value"] * row["max_contribution"], 2
        )
        assert row["explanation"]
        total += row["contribution"]
    assert round(total, 2) == body["sum_of_contributions"]
    # The published score is that sum, rounded half-up.
    assert body["score"] == max(0, min(100, int(body["sum_of_contributions"] + 0.5)))
    assert body["band"] in {"LOW", "MEDIUM", "HIGH"}
    assert body["rounding"]
    assert body["band_meaning"]
    assert body["evidence_separation_note"]
    assert "structured_evidence" in body and "nlp_evidence" in body


def test_explain_agrees_with_the_person_endpoint(client, intelligence):
    person_id = intelligence.top_persons(3)[2].person_id
    person = client.get(f"{API}/persons/{person_id}").json()["priority"]
    explain = client.get(f"{API}/persons/{person_id}/explain").json()
    assert person["score"] == explain["score"]
    assert person["band"] == explain["band"]
    assert len(person["structured_evidence"]) == len(explain["structured_evidence"])
    assert len(person["nlp_evidence"]) == len(explain["nlp_evidence"])


def test_explain_for_an_unknown_person_is_a_404(client):
    r = client.get(f"{API}/persons/999999/explain")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# --- /patterns --------------------------------------------------------------


def test_patterns_list_is_paged_and_annotated(client, intelligence, settings):
    r = client.get(f"{API}/patterns", params={"limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == len(intelligence.patterns)
    assert body["count"] == len(body["patterns"]) == 5
    assert body["offset"] == 0 and body["limit"] == 5
    assert "content-addressed" in body["note"]
    for pattern in body["patterns"]:
        assert pattern["pattern_id"].count("~") == 1
        assert pattern["entity_ids"]
        assert pattern["structured_evidence"] or pattern["nlp_evidence"]
        assert "evidence" not in pattern  # never a merged list (§7)


def test_patterns_offset_pages_without_overlap(client):
    first = client.get(f"{API}/patterns", params={"limit": 5}).json()["patterns"]
    second = client.get(
        f"{API}/patterns", params={"limit": 5, "offset": 5}
    ).json()["patterns"]
    ids_a = {p["pattern_id"] for p in first}
    ids_b = {p["pattern_id"] for p in second}
    assert not (ids_a & ids_b)


def test_patterns_can_be_filtered_by_type(client, intelligence):
    counts = intelligence.pattern_counts()
    for ptype, expected in counts.items():
        body = client.get(
            f"{API}/patterns", params={"pattern_type": ptype, "limit": 1}
        ).json()
        assert body["total"] == expected
        assert body["filters"]["pattern_type"] == ptype
        if expected == 0:
            # §10: an empty category answers with an empty list, not an error.
            assert body["patterns"] == []
        else:
            assert body["patterns"][0]["pattern_type"] == ptype


def test_patterns_can_be_filtered_by_entity(client, intelligence):
    person_id = intelligence.top_persons(1)[0].person_id
    entity = f"person:{person_id}"
    body = client.get(
        f"{API}/patterns", params={"entity_id": entity, "limit": 200}
    ).json()
    assert body["total"] == len(intelligence.patterns_for_person(person_id))
    assert all(entity in p["entity_ids"] for p in body["patterns"])


def test_patterns_rejects_an_unknown_type_and_an_oversized_limit(client, settings):
    r = client.get(f"{API}/patterns", params={"pattern_type": "MADE_UP"})
    assert r.status_code == 400
    error = r.json()["error"]
    assert error["code"] == "bad_request"
    assert "MULTI_CHANNEL_RELATIONSHIP" in error["detail"]["allowed"]

    r = client.get(
        f"{API}/patterns", params={"limit": settings.intel_patterns_max_limit + 1}
    )
    assert r.status_code == 400
    assert r.json()["error"]["detail"]["max"] == settings.intel_patterns_max_limit


# --- /patterns/{pattern_id} -------------------------------------------------


@pytest.mark.parametrize("pattern_type", [p.value for p in PatternType])
def test_one_real_example_per_detected_category(client, intelligence, pattern_type):
    """One live example per category — or an honest zero, never a fabrication."""
    listed = client.get(
        f"{API}/patterns", params={"pattern_type": pattern_type, "limit": 1}
    ).json()
    if listed["total"] == 0:
        pytest.skip(f"{pattern_type}: 0 detections on this corpus (reported as zero)")
    example = listed["patterns"][0]
    r = client.get(f"{API}/patterns/{example['pattern_id']}")
    assert r.status_code == 200
    fetched = r.json()
    assert fetched == example  # same id, same content, both directions
    assert fetched["pattern_type"] == pattern_type
    assert fetched["explanation"]
    assert fetched["source_datasets"]
    assert fetched["structured_evidence"], "every detection cites its records"
    for item in fetched["structured_evidence"]:
        assert item["source_record_id"].split(":")[0] == item["source_dataset"]


def test_pattern_ids_are_stable_across_repeated_requests(client):
    first = client.get(f"{API}/patterns", params={"limit": 50}).json()
    second = client.get(f"{API}/patterns", params={"limit": 50}).json()
    assert [p["pattern_id"] for p in first["patterns"]] == [
        p["pattern_id"] for p in second["patterns"]
    ]
    assert first == second


def test_unknown_pattern_id_is_a_404(client):
    r = client.get(f"{API}/patterns/bridge_entity~0000000000000000")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# --- phase isolation --------------------------------------------------------


def test_phase1_to_3_endpoints_still_answer(client):
    """Phase 4 is strictly additive: nothing earlier may change behaviour."""
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/data/summary").status_code == 200
    assert client.get("/api/v1/persons", params={"page_size": 1}).status_code == 200
    assert client.get("/api/v1/graph/summary").status_code == 200
    assert client.get("/api/v1/analytics/persons/top").status_code == 200
    assert client.get("/api/v1/nlp/summary").status_code == 200


def test_intelligence_routes_are_registered_under_their_own_prefix(app):
    paths = set(app.openapi()["paths"])
    assert f"{API}/summary" in paths
    assert f"{API}/persons/top" in paths
    assert f"{API}/persons/{{person_id}}" in paths
    assert f"{API}/persons/{{person_id}}/explain" in paths
    assert f"{API}/patterns" in paths
    assert f"{API}/patterns/{{pattern_id}}" in paths
    # The Phase 2 centrality ranking keeps its own path (§11).
    assert "/api/v1/analytics/persons/top" in paths
