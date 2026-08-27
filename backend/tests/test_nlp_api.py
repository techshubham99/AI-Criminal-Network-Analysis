"""Phase 3 — HTTP API tests for /api/v1/nlp (spec §8).

Checks the contract rather than re-testing the pipeline: correct status codes,
404 for an unknown FIR, useful (not blank) empty responses, pagination whose
aggregates describe the whole match set, evidence/provenance on every item, and
deterministic output. Also asserts Phase 1 and Phase 2 responses are unchanged
and that nothing here claims real-world NLP accuracy.
"""
from __future__ import annotations

import pytest

from app.nlp.extractor import spacy_available

BASE = "/api/v1/nlp"

# Phrases that would over-claim what a templated synthetic corpus can support.
_FORBIDDEN = [
    "criminal network detected",
    "known criminal",
    "is a criminal",
    "confirmed criminal",
    "found guilty",
    "state-of-the-art",
]


def _assert_neutral(text: str) -> None:
    low = text.lower()
    for phrase in _FORBIDDEN:
        assert phrase not in low, f"over-claiming phrase leaked: {phrase!r}"


def _get(client, path: str) -> dict:
    response = client.get(f"{BASE}{path}")
    assert response.status_code == 200, response.text
    return response.json()


# --- GET /nlp/summary --------------------------------------------------------
def test_summary_counts(client):
    body = _get(client, "/summary")
    assert body["phase"] == "3 - FIR Narrative NLP Intelligence"
    assert body["firs_analyzed"] == 300
    assert body["firs_with_narrative"] == 300
    assert body["firs_without_narrative"] == 0
    assert body["firs_without_entities"] == 0
    assert body["entity_count"] == 1800
    assert body["entities_by_type"] == {
        "AADHAAR": 300,
        "DATE": 300,
        "LOCATION": 300,
        "PERSON": 600,
        "PHONE": 300,
    }
    assert body["entities_by_extraction_method"] == {"known_record": 900, "regex": 900}
    assert body["relationship_count"] == 605
    assert body["relationships_by_type"] == {
        "ASSOCIATED_WITH": 5,
        "LOCATED_AT": 300,
        "REPORTED_AGAINST": 300,
    }
    assert body["relationships_by_confidence"] == {"0.7": 300, "0.9": 5, "1.0": 300}


def test_summary_resolution_block(client):
    body = _get(client, "/summary")
    assert body["resolution_by_status"] == {"not_applicable": 300, "resolved": 1500}
    assert body["resolution_by_method"] == {
        "fir_context_location": 300,
        "none": 300,
        "normalized_name": 600,
        "structured_identifier": 600,
    }
    # Honest zeros: this corpus contains no duplicate identifiers to be unsure about.
    assert body["unresolved_entities"] == 0
    assert body["ambiguous_resolutions"] == 0


def test_summary_graph_additions_and_narrative_graph(client):
    body = _get(client, "/summary")
    assert body["graph_additions_by_status"] == {
        "accepted_additive": 304,
        "rejected_duplicate": 300,
        "rejected_self_loop": 1,
    }
    assert body["graph_additions_accepted"] == 304
    assert body["graph_additions_rejected"] == 301

    narrative = body["narrative_graph"]
    assert narrative["node_count"] == 381
    assert narrative["edge_count"] == 304
    assert narrative["nodes_by_type"] == {"LOCATION": 155, "PERSON": 226}
    assert narrative["edges_by_type"] == {"ASSOCIATED_WITH": 5, "LOCATED_AT": 299}
    assert narrative["contributing_source_records"] == 299
    assert narrative["all_edges_are_narrative"] is True


def test_summary_capabilities_declare_offline_rule_based_operation(client):
    caps = _get(client, "/summary")["capabilities"]
    assert caps["external_model_apis_used"] is False
    assert caps["optional_spacy_model_available"] == spacy_available()
    assert caps["extraction_methods"] == ["regex", "known_record", "anchored_pattern"]
    assert caps["supported_entity_types"] == [
        "PERSON", "PHONE", "AADHAAR", "LOCATION", "DATE", "MONEY", "VEHICLE",
        "ORGANIZATION",
    ]
    assert caps["supported_relationship_types"] == [
        "MET", "CALLED", "LOCATED_AT", "ASSOCIATED_WITH", "REPORTED_AGAINST",
        "TRANSFERRED_TO",
    ]


def test_summary_confidence_semantics_are_declared_as_rules_not_probabilities(client):
    semantics = _get(client, "/summary")["confidence_semantics"]
    assert "not learned probabilities" in semantics["kind"]
    assert semantics["extraction"] == {
        "regex_strict_format": 1.0,
        "known_structured_record": 1.0,
        "template_anchor_only": 0.6,
    }
    assert semantics["resolution"]["fir_context_disambiguation"] == 0.9
    assert semantics["relationship"]["soft_placement"] == 0.7
    assert semantics["thresholds"] == {
        "resolution_min_confidence": 0.5,
        "relationship_min_confidence": 0.5,
    }


def test_summary_evaluation_is_reported_with_its_caveat(client):
    evaluation = _get(client, "/summary")["evaluation"]
    caveat = evaluation["methodology"]["caveat"]
    assert "NOT a measure of real-world NLP accuracy" in caveat
    assert "templates" in caveat

    entities = evaluation["entity_extraction"]
    assert entities["overall"]["precision"] == 1.0
    assert entities["overall"]["recall"] == 1.0
    assert entities["span_mismatches"] == 0
    assert entities["entities_dropped_by_validation"] == 0
    assert entities["zero_occurrence_types"] == {"MONEY": 0, "VEHICLE": 0, "ORGANIZATION": 0}
    assert set(evaluation["methodology"]["evaluated_entity_types"]) == {
        "AADHAAR", "LOCATION", "PERSON", "PHONE",
    }

    resolution = evaluation["entity_resolution"]
    assert resolution["checked_against_structured_truth"] == 1500
    assert resolution["accuracy"] == 1.0
    assert resolution["unresolved"] == 0
    assert resolution["ambiguous"] == 0
    assert resolution["ambiguous_examples"] == []
    assert "ambiguity branch is exercised by unit tests" in resolution["note"]

    relationships = evaluation["relationship_extraction"]
    assert relationships["co_occurrence_only_relationships"] == 0
    assert relationships["relationships_dropped_by_validation"] == 0
    assert relationships["reported_against_scored"]["false_positives"] == 0
    assert "cannot verify" in relationships["note"]


def test_summary_information_gain_is_honest_about_adding_nothing_new(client):
    gain = _get(client, "/summary")["evaluation"]["information_gain"]
    assert gain["proposed_relationships"] == 605
    assert gain["restates_existing_structured_edge"] == 300
    assert gain["new_edge_but_no_new_connectivity"] == 304
    assert gain["new_connectivity"] == 0          # nothing hidden was uncovered
    assert gain["narrative_edges_materialized"] == 304
    assert gain["structured_graph_mutated"] is False
    assert gain["structured_hop_distance_of_accepted_edges"] == {"1": 5, "2": 299}
    assert "SAME_RING overlay edges are excluded" in gain["note"]


def test_summary_dates_are_the_one_genuine_narrative_contribution(client):
    dates = _get(client, "/summary")["evaluation"]["date_extraction"]
    assert dates["firs_with_a_narrative_date"] == 300
    assert dates["narrative_date_differs_from_filing_date"] == 296
    assert dates["narrative_date_equals_structured_filing_date"] == 4


def test_summary_text_makes_no_over_claim(client):
    import json

    _assert_neutral(json.dumps(_get(client, "/summary")))


# --- GET /nlp/firs/{fir_id}/entities ----------------------------------------
def test_fir_entities_response(client):
    body = _get(client, "/firs/1/entities")
    assert body["fir_id"] == 1
    assert body["source_record_id"] == "firs:1"
    assert body["entity_count"] == 6
    assert body["counts_by_type"] == {
        "AADHAAR": 1, "DATE": 1, "LOCATION": 1, "PERSON": 2, "PHONE": 1
    }
    assert body["resolution_counts"] == {"not_applicable": 1, "resolved": 5}
    # Supported-but-not-found types are named, so an absence is explicit.
    assert body["absent_entity_types"] == ["MONEY", "VEHICLE", "ORGANIZATION"]
    assert len(body["entities"]) == 6


def test_fir_entities_carry_every_spec_field_and_a_reproducible_span(client):
    body = _get(client, "/firs/1/entities")
    narrative = body["narrative"]
    for item in body["entities"]:
        entity = item["entity"]
        for field in (
            "entity_type", "raw_text", "normalized_value", "confidence", "fir_id",
            "character_start", "character_end", "extraction_method", "evidence_text",
        ):
            assert entity[field] is not None, field
        assert entity["fir_id"] == 1
        start, end = entity["character_start"], entity["character_end"]
        assert narrative[start:end] == entity["raw_text"]
        assert entity["evidence_text"] in narrative
        assert 0.0 < entity["confidence"] <= 1.0


def test_fir_entities_expose_the_resolution_decision(client):
    body = _get(client, "/firs/1/entities")
    got = [
        (
            item["entity"]["entity_type"],
            item["entity"]["normalized_value"],
            item["resolution"]["status"],
            item["resolution"]["matched_entity_id"],
            item["resolution"]["resolution_method"],
        )
        for item in body["entities"]
    ]
    assert got == [
        ("DATE", "2026-06-08", "not_applicable", None, None),
        ("PERSON", "Chavvi Anne", "resolved", "person:489", "normalized_name"),
        ("AADHAAR", "316148459341", "resolved", "aadhaar:316148459341",
         "structured_identifier"),
        ("LOCATION", "Jaipur, Rajasthan", "resolved", "location:143",
         "fir_context_location"),
        ("PERSON", "Gunbir Sankar", "resolved", "person:21", "normalized_name"),
        ("PHONE", "8298229437", "resolved", "phone:+91-8298229437",
         "structured_identifier"),
    ]
    for item in body["entities"]:
        resolution = item["resolution"]
        assert resolution["ambiguous"] is False
        if resolution["status"] == "resolved":
            # A clean unique match is explained by method + confidence + evidence;
            # `reason` is reserved for outcomes that need prose (spec §5).
            assert resolution["evidence"]
            assert 0.0 < resolution["confidence"] <= 1.0
        else:
            assert resolution["reason"]


@pytest.mark.parametrize("fir_id", [1, 12, 162, 300])
def test_fir_entities_is_consistent_across_several_real_firs(client, fir_id):
    body = _get(client, f"/firs/{fir_id}/entities")
    assert body["fir_id"] == fir_id
    assert body["source_record_id"] == f"firs:{fir_id}"
    assert body["entity_count"] == len(body["entities"]) == sum(
        body["counts_by_type"].values()
    )
    assert sum(body["resolution_counts"].values()) == body["entity_count"]


# --- GET /nlp/firs/{fir_id}/relationships -----------------------------------
def test_fir_relationships_response(client):
    body = _get(client, "/firs/1/relationships")
    assert body["fir_id"] == 1
    assert body["source_record_id"] == "firs:1"
    assert body["relationship_count"] == 2
    assert body["counts_by_type"] == {"LOCATED_AT": 1, "REPORTED_AGAINST": 1}
    assert "two people appearing in the same FIR is never sufficient" in body["note"]
    assert "never added to the structured Phase 2 graph" in body["note"]

    reported, located = body["relationships"]
    assert reported["relationship_type"] == "REPORTED_AGAINST"
    assert (reported["source_entity_id"], reported["target_entity_id"]) == (
        "person:489", "person:21",
    )
    assert reported["directed"] is True
    assert reported["confidence"] == 1.0
    assert reported["extraction_method"] == "rule:complainant_reported_suspect"
    assert located["relationship_type"] == "LOCATED_AT"
    assert located["confidence"] == 0.7
    assert located["attributes"]["proximity"] == "near"


def test_fir_relationships_carry_narrative_provenance_and_spans(client):
    body = _get(client, "/firs/1/relationships")
    narrative = body["narrative"]
    for rel in body["relationships"]:
        assert rel["source_dataset"] == "fir_text"
        assert rel["source_record_id"] == "firs:1"
        assert rel["fir_id"] == 1
        assert rel["extraction_method"].startswith("rule:")
        assert rel["source_resolved"] is True and rel["target_resolved"] is True
        assert rel["source_mention"] and rel["target_mention"]
        span = narrative[rel["character_start"] : rel["character_end"]]
        assert span in rel["evidence_text"]
        assert rel["evidence_text"] in narrative
        assert rel["attributes"]["trigger_text"] in narrative


def test_fir12_relationships_expose_the_hedged_association(client):
    body = _get(client, "/firs/12/relationships")
    assert body["relationship_count"] == 3
    assert body["counts_by_type"] == {
        "ASSOCIATED_WITH": 1, "LOCATED_AT": 1, "REPORTED_AGAINST": 1
    }
    assoc = next(
        r for r in body["relationships"] if r["relationship_type"] == "ASSOCIATED_WITH"
    )
    assert assoc["directed"] is False
    assert assoc["confidence"] == 0.9
    assert assoc["attributes"]["hedged"] is True
    assert assoc["attributes"]["target_scope"] == "circle"
    assert {assoc["source_entity_id"], assoc["target_entity_id"]} == {
        "person:369", "person:500",
    }


# --- GET /nlp/firs/{fir_id}/graph-impact ------------------------------------
def test_graph_impact_response_for_fir1(client):
    body = _get(client, "/firs/1/graph-impact")
    assert body["fir_id"] == 1
    assert body["source_record_id"] == "firs:1"
    assert body["structured_graph_mutated"] is False
    assert body["summary"] == {
        "extracted_entity_count": 6,
        "resolved_entity_count": 5,
        "unresolved_entity_count": 0,
        "ambiguous_entity_count": 0,
        "validated_relationship_count": 2,
        "proposed_count": 2,
        "accepted_count": 1,
        "rejected_count": 1,
        "by_status": {"accepted_additive": 1, "rejected_duplicate": 1},
        "structured_graph_mutated": False,
    }
    # spec §8: extracted, resolved, validated, accepted, rejected — all present.
    assert len(body["extracted_entities"]) == 6
    assert len(body["resolved_entities"]) == 5
    assert body["unresolved_entities"] == []
    assert len(body["not_applicable_entities"]) == 1
    assert body["not_applicable_entities"][0]["entity"]["entity_type"] == "DATE"
    assert len(body["validated_relationships"]) == 2
    assert len(body["proposed_additions"]) == 2
    assert len(body["accepted_additions"]) == 1
    assert len(body["rejected_additions"]) == 1


def test_graph_impact_buckets_partition_the_proposals(client):
    for fir_id in (1, 12, 162, 300):
        body = _get(client, f"/firs/{fir_id}/graph-impact")
        proposed = body["proposed_additions"]
        assert len(proposed) == len(body["accepted_additions"]) + len(
            body["rejected_additions"]
        )
        assert body["summary"]["proposed_count"] == len(proposed)
        for addition in proposed:
            assert addition["reason"]
            assert addition["relationship"]["source_dataset"] == "fir_text"
            if addition["accepted"]:
                assert addition["relationship_id"].startswith("narr~")
            else:
                assert addition["relationship_id"] is None


def test_graph_impact_explains_the_rejected_duplicate(client):
    rejected = _get(client, "/firs/1/graph-impact")["rejected_additions"][0]
    assert rejected["status"] == "rejected_duplicate"
    assert rejected["accepted"] is False
    assert rejected["duplicate_of"] == "REPORTED_AGAINST~person:489~person:21"
    assert "adding no new information" in rejected["reason"]
    assert rejected["detail"]["structured_edge_type"] == "REPORTED_AGAINST"


def test_graph_impact_returns_the_materialised_narrative_edge(client):
    edge = _get(client, "/firs/1/graph-impact")["narrative_edges"][0]
    assert edge["relationship_id"] == "narr~LOCATED_AT~person:21~location:143"
    assert edge["is_narrative"] is True
    assert edge["is_overlay"] is False
    assert edge["source_dataset"] == "fir_text"
    assert edge["provenance_confidence"] == 0.7
    assert edge["evidence"] == ["firs:1"]
    assert edge["date_first"] == edge["date_last"] == "2026-06-08"
    assert edge["attributes"]["contributing_firs"] == [1]
    assert edge["attributes"]["extraction_method"] == "rule:sighting_placement"


def test_graph_impact_reports_the_self_loop_refusal_for_fir162(client):
    body = _get(client, "/firs/162/graph-impact")
    assert body["summary"]["by_status"] == {
        "accepted_additive": 1, "rejected_self_loop": 1
    }
    self_loop = next(
        a for a in body["rejected_additions"] if a["status"] == "rejected_self_loop"
    )
    assert self_loop["detail"] == {"entity_id": "person:325"}
    assert "same person on both sides" in self_loop["reason"]
    # The relationship itself is still reported — the refusal is visible, not hidden.
    assert self_loop["relationship"]["source_entity_id"] == "person:325"
    assert self_loop["relationship"]["target_entity_id"] == "person:325"
    assert body["structured_graph_mutated"] is False


# --- GET /nlp/search --------------------------------------------------------
def test_search_by_normalized_phone_digits(client):
    body = _get(client, "/search?q=8298229437")
    assert body["query"] == "8298229437"
    assert body["meta"]["total"] == 2
    assert body["counts_by_type"] == {"PHONE": 2}
    assert body["matched_fir_count"] == 2
    assert body["searched_fields"] == ["raw_text", "normalized_value", "matched_entity_id"]
    for hit in body["items"]:
        assert hit["matched_field"] in body["searched_fields"]
        assert hit["source_record_id"] == f"firs:{hit['fir_id']}"
        assert hit["resolution"]["matched_entity_id"] == "phone:+91-8298229437"
        assert hit["entity"]["normalized_value"] == "8298229437"


def test_search_by_person_name(client):
    body = _get(client, "/search?q=Gunbir Sankar")
    assert body["meta"]["total"] == 3
    assert body["counts_by_type"] == {"PERSON": 3}
    assert sorted(h["fir_id"] for h in body["items"]) == [1, 152, 276]
    assert all(h["resolution"]["matched_entity_id"] == "person:21" for h in body["items"])


def test_search_by_resolved_entity_id(client):
    """A resolved id is searchable — this is how a client pivots to the graph."""
    body = _get(client, "/search?q=person:21")
    assert body["meta"]["total"] == 11  # person:21 plus person:210..219 (substring)
    assert body["counts_by_type"] == {"PERSON": 11}
    assert all(h["matched_field"] == "matched_entity_id" for h in body["items"])


def test_search_is_case_insensitive(client):
    assert (
        _get(client, "/search?q=jaipur")["meta"]["total"]
        == _get(client, "/search?q=JAIPUR")["meta"]["total"]
        == 39
    )


def test_search_aggregates_describe_the_whole_match_set_not_the_page(client):
    page = _get(client, "/search?q=Jaipur&page=2&page_size=3")
    assert len(page["items"]) == 3
    assert page["meta"] == {
        "page": 2, "page_size": 3, "total": 39, "total_pages": 13,
        "has_next": True, "has_prev": True,
    }
    # Aggregates stay whole-set even on page 2.
    assert page["counts_by_type"] == {"LOCATION": 39}
    assert page["matched_fir_count"] == 39


def test_search_pages_do_not_overlap_and_cover_everything(client):
    seen = []
    for page_no in range(1, 14):
        body = _get(client, f"/search?q=Jaipur&page={page_no}&page_size=3")
        seen.extend((h["fir_id"], h["entity"]["character_start"]) for h in body["items"])
    assert len(seen) == 39
    assert len(set(seen)) == 39
    assert _get(client, "/search?q=Jaipur&page=14&page_size=3")["items"] == []


def test_search_page_size_is_clamped_to_the_configured_maximum(client, settings):
    body = _get(client, "/search?q=a&page_size=500")
    assert body["meta"]["page_size"] == settings.nlp_search_max_limit == 200
    assert len(body["items"]) == 200
    assert body["meta"]["total"] == 1185


def test_search_default_page_size_is_the_configured_limit(client, settings):
    body = _get(client, "/search?q=a")
    assert body["meta"]["page_size"] == settings.nlp_search_limit == 50


def test_search_with_no_match_is_a_useful_empty_response(client):
    body = _get(client, "/search?q=zzzznotfound")
    assert body["items"] == []
    assert body["meta"]["total"] == 0
    assert body["meta"]["total_pages"] == 0
    assert body["meta"]["has_next"] is False
    assert body["counts_by_type"] == {}
    assert body["matched_fir_count"] == 0
    assert body["query"] == "zzzznotfound"


def test_search_for_whitespace_only_returns_empty_rather_than_everything(client):
    body = _get(client, "/search?q=%20")
    assert body["meta"]["total"] == 0
    assert body["items"] == []


# --- error contract ---------------------------------------------------------
@pytest.mark.parametrize("suffix", ["entities", "relationships", "graph-impact"])
def test_unknown_fir_is_404_with_the_standard_envelope(client, suffix):
    response = client.get(f"{BASE}/firs/99999/{suffix}")
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert error["message"] == "FIR '99999' not found"
    assert error["detail"] == {"resource": "FIR", "id": 99999}


@pytest.mark.parametrize(
    "path",
    [
        "/firs/0/entities",
        "/firs/-1/relationships",
        "/firs/abc/graph-impact",
        "/search",
        "/search?q=",
        "/search?q=x&page=0",
        "/search?q=x&page_size=0",
    ],
)
def test_invalid_requests_are_422_with_the_standard_envelope(client, path):
    response = client.get(f"{BASE}{path}")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# --- determinism + Phase 1/2 regression -------------------------------------
@pytest.mark.parametrize(
    "path",
    [
        "/summary",
        "/firs/1/entities",
        "/firs/12/relationships",
        "/firs/162/graph-impact",
        "/search?q=Jaipur&page_size=5",
    ],
)
def test_responses_are_byte_identical_on_repeat(client, path):
    first = client.get(f"{BASE}{path}")
    second = client.get(f"{BASE}{path}")
    assert first.status_code == second.status_code == 200
    assert first.content == second.content


def test_nlp_requests_do_not_change_the_phase2_graph_endpoint(client):
    before = client.get("/api/v1/graph/summary").json()
    for path in ("/summary", "/firs/1/graph-impact", "/search?q=Jaipur"):
        assert client.get(f"{BASE}{path}").status_code == 200
    after = client.get("/api/v1/graph/summary").json()
    assert before == after
    assert after["graph"]["node_count"] == 3803
    assert after["graph"]["edge_count"] == 10802


def test_phase1_health_is_unchanged(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["phase"] == "1 - Backend Foundation"
    assert body["dataset_loaded"] is True


def test_nlp_routes_are_registered_under_the_v1_prefix(client):
    paths = set(client.get("/openapi.json").json()["paths"])
    assert {
        f"{BASE}/summary",
        BASE + "/firs/{fir_id}/entities",
        BASE + "/firs/{fir_id}/relationships",
        BASE + "/firs/{fir_id}/graph-impact",
        f"{BASE}/search",
    } <= paths
