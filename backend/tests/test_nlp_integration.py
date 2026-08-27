"""Phase 3 — narrative graph integration (spec §7).

The invariant every test here defends: **the Phase 2 structured store is never
mutated.** Narrative edges live in a separate store, carry ``fir_text``
provenance, and each proposal gets exactly one explainable disposition.
"""
from __future__ import annotations

import pytest

from app.config import Settings
from app.graph.model import (
    ALLOWED_EDGE_TYPES,
    EdgeType,
    NarrativeEdgeType,
    make_narrative_relationship_id,
)
from app.graph.store import NetworkXGraphStore
from app.nlp.integration import STRUCTURED_EQUIVALENT, NarrativeGraphIntegrator
from app.nlp.models import (
    CONF_REL_EXPLICIT,
    CONF_REL_HEDGED,
    CONF_REL_SOFT_PLACEMENT,
    GraphAdditionStatus,
    NarrativeRelationship,
)

STRUCTURED_NODES = 3803   # pinned by Phase 2
STRUCTURED_EDGES = 10802  # pinned by Phase 2


def _rel(
    rel_type: NarrativeEdgeType,
    source: str | None,
    target: str | None,
    *,
    fir_id: int = 1,
    confidence: float = CONF_REL_EXPLICIT,
    directed: bool | None = None,
    narrative_date: str | None = "2026-06-08",
) -> NarrativeRelationship:
    undirected = rel_type in (NarrativeEdgeType.MET, NarrativeEdgeType.ASSOCIATED_WITH)
    attributes = {"trigger_text": "test"}
    if narrative_date:
        attributes["narrative_date"] = narrative_date
    return NarrativeRelationship(
        relationship_type=rel_type,
        fir_id=fir_id,
        directed=(not undirected) if directed is None else directed,
        source_entity_id=source,
        target_entity_id=target,
        source_mention="src",
        target_mention="tgt",
        confidence=confidence,
        evidence_text="synthetic evidence sentence.",
        character_start=0,
        character_end=27,
        extraction_method="rule:test",
        source_dataset="fir_text",
        source_record_id=f"firs:{fir_id}",
        attributes=attributes,
    )


@pytest.fixture
def fresh_integrator(store, settings):
    """A brand-new integrator reading the real structured graph."""
    return NarrativeGraphIntegrator(store, settings)


def _one(integrator, rel):
    additions = integrator.integrate([rel])
    assert len(additions) == 1
    return additions[0]


# --- store separation --------------------------------------------------------
def test_narrative_store_is_a_separate_store(store, narrative_store):
    assert narrative_store is not store
    assert isinstance(narrative_store, NetworkXGraphStore)


def test_structured_graph_is_unchanged_by_phase_3(store):
    assert store.node_count() == STRUCTURED_NODES
    assert store.edge_count() == STRUCTURED_EDGES
    used = {e.relationship_type for e in store.iter_edges()}
    assert used == set(ALLOWED_EDGE_TYPES)
    assert all(isinstance(t, EdgeType) for t in used)
    assert not any(e.is_narrative for e in store.iter_edges())
    assert not any(e.source_dataset == "fir_text" for e in store.iter_edges())


def test_narrative_store_contents(narrative_store):
    assert narrative_store.node_count() == 381
    assert narrative_store.edge_count() == 304
    nodes_by_type: dict[str, int] = {}
    for node in narrative_store.iter_nodes():
        nodes_by_type[node.entity_type.value] = nodes_by_type.get(node.entity_type.value, 0) + 1
    assert nodes_by_type == {"PERSON": 226, "LOCATION": 155}


def test_every_narrative_edge_is_flagged_and_attributed(narrative_store):
    for edge in narrative_store.iter_edges():
        assert edge.is_narrative is True
        assert edge.is_overlay is False
        assert edge.source_dataset == "fir_text"
        assert isinstance(edge.relationship_type, NarrativeEdgeType)
        assert edge.relationship_id.startswith("narr~")
        assert edge.evidence and all(ref.startswith("firs:") for ref in edge.evidence)
        assert 0.0 < edge.provenance_confidence <= 1.0
        assert edge.attributes["evidence_text"]
        assert edge.attributes["contributing_firs"]
        assert "note" in edge.weight_detail  # weight is NOT an analytic coefficient


def test_narrative_edge_types_are_the_narrative_enum(narrative_store):
    counts: dict[str, int] = {}
    for edge in narrative_store.iter_edges():
        counts[edge.relationship_type.value] = counts.get(edge.relationship_type.value, 0) + 1
    assert counts == {"LOCATED_AT": 299, "ASSOCIATED_WITH": 5}


def test_narrative_node_attributes_are_copies_not_aliases(store, narrative_store):
    """Node is frozen but its attribute dict is not — copies keep Phase 2 pristine."""
    shared = [n.entity_id for n in narrative_store.iter_nodes()][:20]
    for eid in shared:
        structured_node = store.get_node(eid)
        assert structured_node is not None
        assert narrative_store.get_node(eid).attributes is not structured_node.attributes


def test_integrator_summary_works_where_the_phase2_summary_cannot(nlp_service, narrative_store):
    """``graph_summary()`` coerces types via ``EdgeType`` — hence the custom summary."""
    summary = nlp_service.integrator.summary()
    assert summary["edge_count"] == 304
    assert summary["all_edges_are_narrative"] is True
    assert summary["contributing_source_records"] == 299
    with pytest.raises(ValueError):
        narrative_store.graph_summary()


# --- corpus dispositions ------------------------------------------------------
def test_corpus_dispositions(nlp_service):
    counts: dict[str, int] = {}
    for fir_id in range(1, 301):
        for addition in nlp_service.get_analysis(fir_id).graph_additions:
            counts[addition.status.value] = counts.get(addition.status.value, 0) + 1
    assert counts == {
        "accepted_additive": 304,
        "rejected_duplicate": 300,
        "rejected_self_loop": 1,
    }


def test_every_addition_explains_itself(nlp_service):
    for fir_id in range(1, 301):
        for addition in nlp_service.get_analysis(fir_id).graph_additions:
            assert addition.reason
            if addition.accepted:
                assert addition.relationship_id
            if addition.status is GraphAdditionStatus.REJECTED_DUPLICATE:
                assert addition.duplicate_of


def test_accepted_additive_records_the_structured_hop_distance(nlp_service):
    hops = set()
    for fir_id in range(1, 301):
        for addition in nlp_service.get_analysis(fir_id).graph_additions:
            if addition.status is GraphAdditionStatus.ACCEPTED_ADDITIVE:
                hops.add(addition.detail["structured_hop_distance"])
    # Honest accounting: every accepted edge short-circuits an existing path.
    assert hops == {1, 2}


def test_fir1_restates_one_structured_edge_and_adds_one(nlp_service):
    additions = nlp_service.get_analysis(1).graph_additions
    assert len(additions) == 2
    duplicate, additive = additions
    assert duplicate.status is GraphAdditionStatus.REJECTED_DUPLICATE
    assert duplicate.duplicate_of == "REPORTED_AGAINST~person:489~person:21"
    assert duplicate.detail["structured_edge_type"] == "REPORTED_AGAINST"
    assert additive.status is GraphAdditionStatus.ACCEPTED_ADDITIVE
    assert additive.relationship_id == "narr~LOCATED_AT~person:21~location:143"


def test_fir162_self_loop_is_rejected_with_the_entity_named(nlp_service):
    additions = nlp_service.get_analysis(162).graph_additions
    self_loop = next(
        a for a in additions if a.status is GraphAdditionStatus.REJECTED_SELF_LOOP
    )
    assert self_loop.detail == {"entity_id": "person:325"}
    assert "same" in self_loop.reason
    assert self_loop.relationship_id is None


# --- dispositions, driven directly ------------------------------------------
def test_unresolved_endpoint_is_rejected(fresh_integrator):
    addition = _one(fresh_integrator, _rel(NarrativeEdgeType.MET, None, "person:2"))
    assert addition.status is GraphAdditionStatus.REJECTED_UNRESOLVED
    assert "source entity did not resolve" in addition.reason
    assert fresh_integrator.store.edge_count() == 0


def test_endpoint_missing_from_the_graph_is_rejected(fresh_integrator):
    addition = _one(
        fresh_integrator, _rel(NarrativeEdgeType.MET, "person:1", "person:999999")
    )
    assert addition.status is GraphAdditionStatus.REJECTED_UNRESOLVED
    assert "not materialised" in addition.reason


def test_self_loop_is_rejected(fresh_integrator):
    addition = _one(fresh_integrator, _rel(NarrativeEdgeType.MET, "person:1", "person:1"))
    assert addition.status is GraphAdditionStatus.REJECTED_SELF_LOOP
    assert fresh_integrator.store.edge_count() == 0


def test_low_confidence_is_rejected_when_the_floor_is_raised(store):
    strict = NarrativeGraphIntegrator(store, Settings(nlp_relationship_min_confidence=0.95))
    addition = _one(
        strict,
        _rel(
            NarrativeEdgeType.LOCATED_AT,
            "person:21",
            "location:143",
            confidence=CONF_REL_SOFT_PLACEMENT,
        ),
    )
    assert addition.status is GraphAdditionStatus.REJECTED_LOW_CONFIDENCE
    assert addition.detail == {"confidence": CONF_REL_SOFT_PLACEMENT, "threshold": 0.95}
    assert strict.store.edge_count() == 0


def test_structured_duplicate_is_rejected(fresh_integrator):
    addition = _one(
        fresh_integrator,
        _rel(NarrativeEdgeType.REPORTED_AGAINST, "person:489", "person:21"),
    )
    assert addition.status is GraphAdditionStatus.REJECTED_DUPLICATE
    assert addition.duplicate_of == "REPORTED_AGAINST~person:489~person:21"
    assert "adding no new information" in addition.reason
    assert fresh_integrator.store.edge_count() == 0


def test_direction_matters_for_duplicate_detection(fresh_integrator):
    """A narrative B→A is NOT a duplicate of a structured A→B: it asserts more."""
    addition = _one(
        fresh_integrator,
        _rel(NarrativeEdgeType.REPORTED_AGAINST, "person:21", "person:489"),
    )
    assert addition.status is GraphAdditionStatus.ACCEPTED_ADDITIVE
    assert addition.detail["structured_hop_distance"] == 1
    assert addition.relationship_id == "narr~REPORTED_AGAINST~person:21~person:489"


def test_repeated_identical_relationship_is_rejected_as_duplicate(fresh_integrator):
    rel = _rel(NarrativeEdgeType.MET, "person:1", "person:2")
    first = _one(fresh_integrator, rel)
    assert first.accepted
    second = _one(fresh_integrator, rel)
    assert second.status is GraphAdditionStatus.REJECTED_DUPLICATE
    assert second.duplicate_of == first.relationship_id
    assert "no new evidence to add" in second.reason
    assert fresh_integrator.store.edge_count() == 1


def test_a_second_fir_merges_provenance_into_the_existing_edge(fresh_integrator):
    first = _one(
        fresh_integrator,
        _rel(NarrativeEdgeType.MET, "person:1", "person:2", fir_id=1,
             confidence=CONF_REL_HEDGED, narrative_date="2026-06-08"),
    )
    assert first.status is GraphAdditionStatus.ACCEPTED_NEW

    # Reversed endpoints: MET is undirected, so this is the SAME edge.
    second = _one(
        fresh_integrator,
        _rel(NarrativeEdgeType.MET, "person:2", "person:1", fir_id=7,
             confidence=CONF_REL_EXPLICIT, narrative_date="2026-01-05"),
    )
    assert second.status is GraphAdditionStatus.ACCEPTED_MERGED
    assert second.relationship_id == first.relationship_id
    assert second.detail == {"evidence_count": 2}
    assert fresh_integrator.store.edge_count() == 1

    edge = fresh_integrator.store.get_edge(first.relationship_id)
    assert edge.evidence == ["firs:1", "firs:7"]
    assert edge.attributes["contributing_firs"] == [1, 7]
    assert edge.provenance_confidence == CONF_REL_EXPLICIT  # max, not averaged
    assert edge.attributes["confidence_basis"] == "max over contributing narratives"
    assert edge.date_first == "2026-01-05"
    assert edge.date_last == "2026-06-08"


def test_new_connectivity_is_labelled_accepted_new(fresh_integrator):
    addition = _one(fresh_integrator, _rel(NarrativeEdgeType.MET, "person:1", "person:2"))
    assert addition.status is GraphAdditionStatus.ACCEPTED_NEW
    assert addition.detail["structured_hop_distance"] is None
    assert "new connectivity" in addition.reason


def test_undirected_endpoints_are_canonicalised(fresh_integrator):
    addition = _one(fresh_integrator, _rel(NarrativeEdgeType.MET, "person:2", "person:1"))
    assert addition.relationship_id == make_narrative_relationship_id(
        NarrativeEdgeType.MET, "person:1", "person:2"
    )


def test_materialised_edge_carries_full_provenance(fresh_integrator):
    rel = _rel(NarrativeEdgeType.LOCATED_AT, "person:21", "location:143")
    addition = _one(fresh_integrator, rel)
    edge = fresh_integrator.store.get_edge(addition.relationship_id)
    assert edge.source_dataset == "fir_text"
    assert edge.evidence == ["firs:1"]
    assert edge.weight == 1.0
    assert "not an analytic coefficient" in edge.weight_detail["note"]
    assert edge.provenance_confidence == rel.confidence
    assert edge.date_first == edge.date_last == "2026-06-08"
    assert edge.attributes["extraction_method"] == "rule:test"
    assert edge.attributes["character_start"] == 0
    assert edge.attributes["character_end"] == 27
    assert "narrative_date" not in edge.attributes  # promoted to date_first/date_last
    assert fresh_integrator.store.has_node("person:21")
    assert fresh_integrator.store.has_node("location:143")


# --- ground truth is never consulted -----------------------------------------
def test_same_ring_is_not_a_structured_equivalent():
    assert STRUCTURED_EQUIVALENT[NarrativeEdgeType.ASSOCIATED_WITH] is None
    assert STRUCTURED_EQUIVALENT[NarrativeEdgeType.MET] is None
    assert EdgeType.SAME_RING not in set(STRUCTURED_EQUIVALENT.values())


def test_ring_only_pair_is_connected_solely_by_the_overlay(store):
    """Fixture premise for the next test: person:24 / person:26 share only SAME_RING."""
    assert store.edges_between("person:24", "person:26", include_overlay=False) == []
    overlay = store.edges_between("person:24", "person:26", include_overlay=True)
    assert [e.relationship_type for e in overlay] == [EdgeType.SAME_RING]
    assert store.find_paths("person:24", "person:26", max_length=2, max_paths=1,
                            include_overlay=False) == []


def test_ground_truth_ring_does_not_suppress_a_narrative_edge(fresh_integrator):
    """If SAME_RING leaked in, this would be called a duplicate or 'additive'."""
    addition = _one(
        fresh_integrator, _rel(NarrativeEdgeType.ASSOCIATED_WITH, "person:24", "person:26")
    )
    assert addition.status is GraphAdditionStatus.ACCEPTED_NEW
    assert addition.detail["structured_hop_distance"] is None
    edge = fresh_integrator.store.get_edge(addition.relationship_id)
    assert edge.is_overlay is False


# --- integration never writes to the structured store ------------------------
def test_integration_leaves_the_structured_store_untouched(store, fresh_integrator):
    before = (store.node_count(), store.edge_count())
    fresh_integrator.integrate(
        [
            _rel(NarrativeEdgeType.MET, "person:1", "person:2"),
            _rel(NarrativeEdgeType.LOCATED_AT, "person:21", "location:143"),
            _rel(NarrativeEdgeType.REPORTED_AGAINST, "person:489", "person:21"),
            _rel(NarrativeEdgeType.MET, "person:1", "person:1"),
        ]
    )
    assert (store.node_count(), store.edge_count()) == before
    assert fresh_integrator.store.edge_count() == 2
