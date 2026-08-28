"""Phase 4.6 ingestion: the decision gate, resolution, graph update, recompute.

Every test in this module runs against its OWN application instance
(``live_app``), not the session-scoped one from ``conftest``. Ingestion mutates
the graph, and the Phase 1-4 suites assert exact node/edge counts and exact
metric values — sharing an app between them would make this phase's tests
silently rewrite theirs.
"""
from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.graph.model import EdgeType
from app.ingest.models import (
    NO_LINK_EXPLANATION,
    IngestStatus,
    Provenance,
    ReviewReason,
    SourceType,
    canonical_payload,
    make_record_id,
)
from app.ingest.normalize import FieldError, normalize
from app.main import create_app

PROV = Provenance(source_type="CALL", source_name="test-suite", submitted_by="pytest")


# --- fixtures ---------------------------------------------------------------
@pytest.fixture(scope="module")
def live_app():
    app = create_app()
    with TestClient(app):  # run lifespan so every phase is built
        yield app


@pytest.fixture(scope="module")
def pipeline(live_app):
    assert live_app.state.ingest is not None, "ingestion must build when the graph does"
    return live_app.state.ingest


@pytest.fixture(scope="module")
def repo(live_app):
    return live_app.state.dataset


@pytest.fixture(scope="module")
def settings(live_app):
    return live_app.state.settings


@pytest.fixture(scope="module")
def crowded_place(repo):
    """A (city, state) shared by many location rows, plus a person in it.

    The corpus has 200 location rows over only 10 distinct city/state pairs, so
    a place given by name alone is genuinely ambiguous — this is the natural
    AMBIGUOUS_MATCH case, not a contrived one.
    """
    by_place: dict[tuple[str, str], list[int]] = {}
    for row in repo.locations:
        by_place.setdefault((row["city"], row["state"]), []).append(int(row["location_id"]))
    city, state = max(by_place, key=lambda k: len(by_place[k]))
    ids = set(by_place[(city, state)])
    inside = next(p for p in repo.persons if int(p["location_id"]) in ids)
    outside = next(p for p in repo.persons if int(p["location_id"]) not in ids)
    return {
        "city": city,
        "state": state,
        "location_ids": ids,
        "person_inside": inside,
        "person_outside": outside,
    }


def submit(pipeline, source_type: SourceType, payload: dict):
    return pipeline.submit(source_type, payload, PROV)


# --- §2 deterministic record id --------------------------------------------
def test_record_id_ignores_ingestion_time_and_key_order():
    a = {"caller": {"person_id": 1}, "callee": {"person_id": 2}, "duration_sec": 60}
    b = {"duration_sec": 60, "callee": {"person_id": 2}, "caller": {"person_id": 1}}
    assert make_record_id(SourceType.CALL, a) == make_record_id(SourceType.CALL, b)
    # No timestamp anywhere in the hash input.
    assert "ingested_at" not in canonical_payload(a)


def test_record_id_is_source_type_scoped():
    payload = {"x": 1}
    assert make_record_id(SourceType.CALL, payload) != make_record_id(
        SourceType.TRANSACTION, payload
    )


def test_record_id_treats_explicit_null_as_omitted():
    assert make_record_id(SourceType.FIR, {"a": 1, "accused": None}) == make_record_id(
        SourceType.FIR, {"a": 1}
    )


# --- normalization ----------------------------------------------------------
@pytest.mark.parametrize(
    "raw",
    [
        "2026-08-20T10:15:00",
        "2026-08-20 10:15:00",
        "2026-08-20T10:15",
        "20-08-2026 10:15:00",
        "2026-08-20T10:15:00Z",
        "2026-08-20T10:15:00+05:30",
    ],
)
def test_timestamp_forms_normalize_to_one_shape(raw, settings):
    out = normalize(
        "CALL",
        {
            "caller": {"person_id": 1},
            "callee": {"person_id": 2},
            "start_time": raw,
            "duration_sec": 60,
        },
        settings,
    )
    assert out["start_time"] == "2026-08-20T10:15:00"


def test_normalization_rejects_unusable_values(settings):
    with pytest.raises(FieldError) as exc:
        normalize(
            "CALL",
            {
                "caller": {"person_id": 1},
                "callee": {"person_id": 2},
                "start_time": "2026-08-20T10:15:00",
                "duration_sec": -5,
            },
            settings,
        )
    assert exc.value.field == "duration_sec"


def test_transaction_normalization_upper_cases_reference_and_rounds_amount(settings):
    out = normalize(
        "TRANSACTION",
        {
            "sender": {"person_id": 1},
            "receiver": {"person_id": 2},
            "amount_inr": "1234.567",
            "txn_time": "2026-08-20T10:15:00",
            "mode": "upi",
            "reference_id": "ref-1",
        },
        settings,
    )
    assert out["mode"] == "UPI"
    assert out["bank_ref"] == "REF-1"
    assert out["amount_inr"] == 1234.57


def test_reference_needs_at_least_one_identifier(settings):
    with pytest.raises(FieldError):
        normalize(
            "CALL",
            {
                "caller": {},
                "callee": {"person_id": 2},
                "start_time": "2026-08-20T10:15:00",
                "duration_sec": 60,
            },
            settings,
        )


# --- §4 accept path per source type ----------------------------------------
def test_call_is_accepted_and_updates_the_graph(pipeline):
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": 141},
            "callee": {"person_id": 21},
            "start_time": "2026-08-20T10:15:00",
            "duration_sec": 240,
            "cell_tower_id": 7,
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    assert record.impact["changed"] is True
    types = {r.relationship_type for r in record.relationships}
    assert types == {"CALLED", "USED_TOWER"}
    edge = pipeline.graph.store.get_edge("CALLED~person:141~person:21")
    assert edge is not None
    assert record.record_id in edge.attributes["ingest_record_ids"]


def test_transaction_is_accepted_and_records_its_reference(pipeline):
    record = submit(
        pipeline,
        SourceType.TRANSACTION,
        {
            "sender": {"person_id": 141},
            "receiver": {"person_id": 21},
            "amount_inr": 125000,
            "txn_time": "2026-08-22T14:00:00",
            "mode": "upi",
            "bank_ref": "ref-9001",
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    assert record.normalized_payload["bank_ref"] == "REF-9001"
    assert pipeline.graph.store.get_edge("TRANSACTED~person:141~person:21") is not None


def test_transaction_without_a_reference_is_rejected(pipeline):
    record = submit(
        pipeline,
        SourceType.TRANSACTION,
        {
            "sender": {"person_id": 141},
            "receiver": {"person_id": 21},
            "amount_inr": 500,
            "txn_time": "2026-08-22T14:05:00",
            "mode": "cash",
        },
    )
    assert record.status is IngestStatus.REJECTED
    assert "reference" in record.reason


def test_fir_is_accepted_and_runs_the_existing_nlp_pipeline(pipeline, crowded_place):
    person = crowded_place["person_inside"]
    record = submit(
        pipeline,
        SourceType.FIR,
        {
            "date": "2026-08-22",
            "complainant": {"person_id": int(person["person_id"])},
            "accused": {"person_id": 141},
            "narrative": (
                "Complainant reports that the accused demanded money and "
                "threatened him near the market on 22 August 2026."
            ),
            "city": crowded_place["city"],
            "state": crowded_place["state"],
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    types = [r.relationship_type for r in record.relationships]
    assert types.count("NAMED_IN_FIR") == 2
    assert "REPORTED_AGAINST" in types
    assert "LOCATED_AT" in types
    # §7: the accepted FIR went through Phase 3, and Phase 3 kept its narrative
    # edges out of the structured graph.
    nlp = record.impact["nlp"]
    assert nlp["impact"]["structured_graph_mutated"] is False
    assert "extracted_entities" in nlp
    assert pipeline.nlp.get_analysis(nlp["fir_id"]) is not None
    assert f"firs:{nlp['fir_id']}" in record.evidence


def test_fir_without_an_accused_creates_no_counterparty_edge(pipeline, crowded_place):
    person = crowded_place["person_inside"]
    record = submit(
        pipeline,
        SourceType.FIR,
        {
            "date": "2026-08-24",
            "complainant": {"person_id": int(person["person_id"])},
            "narrative": (
                "Complainant reports that an unidentified person took his bag "
                "from the bus stand and left before he could react."
            ),
            "location_id": int(person["location_id"]),
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    rejected = [r for r in record.relationships if not r.accepted]
    assert [r.relationship_type for r in rejected] == ["REPORTED_AGAINST"]
    assert "no counterparty is inferred" in rejected[0].reason


def test_location_observation_does_not_overwrite_a_recorded_address(pipeline, repo):
    person = repo.get_person(141)
    home = int(person["location_id"])
    elsewhere = next(
        int(row["location_id"]) for row in repo.locations if int(row["location_id"]) != home
    )
    record = submit(
        pipeline,
        SourceType.LOCATION,
        {
            "person": {"person_id": 141},
            "location_id": elsewhere,
            "observed_at": "2026-08-22T16:30:00",
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    assert record.relationships[0].relationship_id == (
        f"LOCATED_AT~observed~person:141~location:{elsewhere}"
    )
    # The dataset-derived home edge is a different edge and is untouched.
    assert pipeline.graph.store.get_edge(f"LOCATED_AT~person:141~location:{home}") is not None
    assert int(repo.get_person(141)["location_id"]) == home


# --- §2/§4 duplicates -------------------------------------------------------
def test_resubmitting_an_identical_record_is_a_duplicate(pipeline):
    payload = {
        "caller": {"person_id": 60},
        "callee": {"person_id": 61},
        "start_time": "2026-08-25T09:00:00",
        "duration_sec": 45,
    }
    first = submit(pipeline, SourceType.CALL, payload)
    assert first.status is IngestStatus.ACCEPTED
    edge_before = pipeline.graph.store.get_edge("CALLED~person:60~person:61")
    weight_before = edge_before.weight
    events_before = pipeline.bus.stats()["published"]

    second = submit(pipeline, SourceType.CALL, dict(payload))
    assert second.status is IngestStatus.DUPLICATE
    assert second.record_id == first.record_id
    assert second.duplicate_of == first.record_id
    assert second.relationships == []
    assert second.impact["changed"] is False
    # No duplicate edge, no inflated weight, no second event storm.
    assert pipeline.graph.store.get_edge("CALLED~person:60~person:61").weight == weight_before
    assert pipeline.bus.stats()["published"] == events_before


def test_a_second_distinct_call_aggregates_onto_one_edge(pipeline):
    base = {
        "caller": {"person_id": 300},
        "callee": {"person_id": 301},
        "start_time": "2026-08-23T12:00:00",
        "duration_sec": 60,
    }
    first = submit(pipeline, SourceType.CALL, base)
    second = submit(pipeline, SourceType.CALL, {**base, "start_time": "2026-08-23T13:00:00"})
    assert first.status is second.status is IngestStatus.ACCEPTED
    rid = "CALLED~person:300~person:301"
    assert first.impact["graph"]["edges_added"] == [rid]
    assert second.impact["graph"]["edges_added"] == []
    assert second.impact["graph"]["edges_updated"] == [rid]
    edge = pipeline.graph.store.get_edge(rid)
    assert edge.weight_detail["count"] == 2
    assert edge.weight_detail["total_duration_sec"] == 120.0
    assert edge.attributes["ingest_record_ids"] == [first.record_id, second.record_id]


# --- §5 resolution outcomes -------------------------------------------------
def test_unknown_identifiers_are_new_entities_not_matches(pipeline):
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"phone": "9998887777"},
            "callee": {"phone": "9998887776"},
            "start_time": "2026-08-21T09:00:00",
            "duration_sec": 60,
        },
    )
    assert record.status is IngestStatus.REVIEW_REQUIRED
    assert record.review_reason is ReviewReason.NO_MATCH_NEW_ENTITY
    assert record.reason == NO_LINK_EXPLANATION
    assert all(m.is_new_entity for m in record.matches)
    # §6: nothing was forced into the graph, and nothing was called suspicious.
    assert record.impact["changed"] is False
    assert record.relationships == []


def test_conflicting_identifiers_are_ambiguous_never_merged(pipeline, repo):
    first, second = repo.persons[0], repo.persons[1]
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": int(first["person_id"]), "phone": second["phone"]},
            "callee": {"person_id": 21},
            "start_time": "2026-08-23T11:00:00",
            "duration_sec": 30,
        },
    )
    assert record.status is IngestStatus.REVIEW_REQUIRED
    assert record.review_reason is ReviewReason.AMBIGUOUS_MATCH
    caller = next(m for m in record.matches if m.field_name == "caller")
    assert {c.entity_id for c in caller.candidates} == {
        f"person:{first['person_id']}",
        f"person:{second['person_id']}",
    }
    assert caller.entity_id is None  # no silent merge
    assert record.impact["changed"] is False


def test_a_shared_city_state_is_ambiguous_without_a_location_id(pipeline, crowded_place):
    outsider = crowded_place["person_outside"]
    record = submit(
        pipeline,
        SourceType.FIR,
        {
            "date": "2026-08-22",
            "complainant": {"person_id": int(outsider["person_id"])},
            "narrative": (
                "Complainant reports that two unknown persons demanded money "
                "near the market and left in a hurry."
            ),
            "city": crowded_place["city"],
            "state": crowded_place["state"],
        },
    )
    assert record.status is IngestStatus.REVIEW_REQUIRED
    assert record.review_reason is ReviewReason.AMBIGUOUS_MATCH
    place = next(m for m in record.matches if m.field_name == "place")
    assert place.entity_id is None
    assert len(place.candidates) > 1


def test_the_referenced_persons_own_location_resolves_a_shared_place(
    pipeline, crowded_place
):
    insider = crowded_place["person_inside"]
    record = submit(
        pipeline,
        SourceType.LOCATION,
        {
            "person": {"person_id": int(insider["person_id"])},
            "city": crowded_place["city"],
            "state": crowded_place["state"],
            "observed_at": "2026-08-26T08:00:00",
        },
    )
    place = next(m for m in record.matches if m.field_name == "place")
    assert record.status is IngestStatus.ACCEPTED
    assert place.method.value == "deterministic_context"
    assert place.entity_id == f"location:{int(insider['location_id'])}"


def test_an_unknown_place_is_never_given_coordinates(pipeline):
    record = submit(
        pipeline,
        SourceType.LOCATION,
        {
            "person": {"person_id": 141},
            "city": "Nowhereville",
            "state": "Nowhere",
        },
    )
    assert record.status is IngestStatus.REVIEW_REQUIRED
    assert record.review_reason is ReviewReason.NO_MATCH_NEW_ENTITY
    place = next(m for m in record.matches if m.field_name == "place")
    assert "no coordinates are inferred" in place.explanation


# --- §8/§11 self-references -------------------------------------------------
def test_a_self_reference_is_evidence_but_changes_no_score(pipeline):
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": 50},
            "callee": {"person_id": 50},
            "start_time": "2026-08-23T10:00:00",
            "duration_sec": 30,
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    decision = record.relationships[0]
    assert decision.is_self_reference is True
    assert decision.excluded_from_intelligence is True
    # The edge exists as evidence...
    assert pipeline.graph.store.get_edge("CALLED~person:50~person:50") is not None
    # ...and moved neither the score nor either global centrality metric.
    before, after = record.impact["persons"][0]["before"], record.impact["persons"][0]["after"]
    assert before["score"] == after["score"]
    assert before["pagerank"] == after["pagerank"]
    assert before["betweenness"] == after["betweenness"]


# --- §10/§11 recomputation --------------------------------------------------
def test_global_metrics_are_really_recomputed_and_the_cost_is_reported(pipeline):
    analytics_before = pipeline.graph.cached_analytics
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": 400},
            "callee": {"person_id": 401},
            "start_time": "2026-08-27T10:00:00",
            "duration_sec": 90,
        },
    )
    assert record.status is IngestStatus.ACCEPTED
    # A genuinely fresh pass, published to the graph service.
    assert pipeline.graph.cached_analytics is not analytics_before
    cost = record.impact["recompute_cost_ms"]
    assert cost["analytics_ms"] > 0 and cost["total_ms"] >= cost["analytics_ms"]
    metrics = pipeline.graph.cached_analytics.person_metrics("person:400")
    assert metrics["pagerank"] > 0
    assert metrics["betweenness"] >= 0
    assert metrics["community_id"] is not None


def test_a_changed_pattern_id_is_not_reported_as_a_new_detection(pipeline):
    """Community labels move when the partition shifts; that is not a detection."""
    record = submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": 410},
            "callee": {"person_id": 411},
            "start_time": "2026-08-27T11:00:00",
            "duration_sec": 75,
        },
    )
    impact = record.impact
    signature_changes = len(impact["new_pattern_ids"]) + len(impact["cleared_pattern_ids"])
    id_churn = impact["reidentified_pattern_count"]
    # Whatever churn the partition caused, it is counted separately and never
    # inflates new_pattern_ids.
    assert isinstance(id_churn, int)
    assert signature_changes == len(set(impact["new_pattern_ids"])) + len(
        set(impact["cleared_pattern_ids"])
    )
    for pattern_id in impact["new_pattern_ids"]:
        assert pipeline.intelligence.pattern_for(pattern_id) is not None


def test_accepted_rows_reach_phase_4_without_touching_the_repository(pipeline, repo):
    calls_before = len(repo.calls)
    view = pipeline.recomputer.data_view()
    assert len(view.calls) == calls_before + len(pipeline.store.live_calls)
    assert len(repo.calls) == calls_before  # the repository's own list is untouched
    assert view.persons is repo.persons  # this phase creates no persons


def test_a_live_fir_without_an_accused_is_kept_out_of_pair_intelligence(pipeline):
    view = pipeline.recomputer.data_view()
    accused_less = [f for f in pipeline.store.live_firs if f.get("accused_id") is None]
    assert accused_less, "the accused-less FIR test above must have run first"
    assert view.excluded_firs == [int(f["fir_id"]) for f in accused_less]
    assert all(f.get("accused_id") is not None for f in view.firs)
    # Still reachable as a record, and still present in the graph as evidence.
    for fir in accused_less:
        assert view.get_fir(int(fir["fir_id"])) is not None


# --- §11 SAME_RING stays out ------------------------------------------------
def test_no_same_ring_edge_is_ever_written_by_ingestion(pipeline):
    live_edges = [
        edge
        for edge in pipeline.graph.store.iter_edges()
        if "ingest_record_ids" in (edge.attributes or {})
    ]
    assert live_edges, "the accepted records above must have written edges"
    assert all(edge.relationship_type is not EdgeType.SAME_RING for edge in live_edges)
    assert all(edge.is_overlay is False for edge in live_edges)


def test_ingestion_never_reads_ring_id(pipeline):
    import app.ingest.graph_update as graph_update
    import app.ingest.pipeline as pipeline_module
    import app.ingest.recompute as recompute
    import app.ingest.resolution as resolution

    for module in (pipeline_module, resolution, graph_update, recompute):
        source = open(module.__file__, encoding="utf-8").read()
        code = "\n".join(
            line for line in source.splitlines() if not line.strip().startswith("#")
        )
        assert "ring_id" not in code, f"{module.__name__} must not read ring_id"


# --- §1 dataset integrity ---------------------------------------------------
def test_the_original_dataset_is_byte_for_byte_unchanged(pipeline, settings):
    """The whole point of a separate writable store."""
    digests = {}
    for path in sorted(settings.dataset_dir.glob("*.csv")):
        digests[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digests, "the dataset must be where settings says it is"

    submit(
        pipeline,
        SourceType.CALL,
        {
            "caller": {"person_id": 420},
            "callee": {"person_id": 421},
            "start_time": "2026-08-27T12:00:00",
            "duration_sec": 30,
        },
    )
    after = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(settings.dataset_dir.glob("*.csv"))
    }
    assert after == digests
    assert pipeline.summary()["persistence"]["dataset_directory_written"] is False


def test_persistence_is_off_by_default_so_nothing_is_written_at_all(pipeline, settings):
    assert settings.ingest_persist is False
    assert not settings.ingest_dir.exists() or not any(settings.ingest_dir.iterdir())
