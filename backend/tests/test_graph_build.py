"""Phase 2 — graph construction tests (counts, determinism, provenance)."""
from __future__ import annotations

from app.graph.builder import build_store
from app.graph.model import (
    ALLOWED_EDGE_TYPES,
    MATERIALIZED_NODE_TYPES,
    EdgeType,
    NodeType,
)

# Deterministic ground truth (measured against the real loader).
EXPECTED_NODES = {
    "PERSON": 500,
    "PHONE": 500,
    "AADHAAR": 500,
    "LOCATION": 200,
    "FIR": 300,
    "CELL_TOWER": 1803,
}
EXPECTED_EDGES = {
    "CALLED": 1990,
    "TRANSACTED": 1498,
    "NAMED_IN_FIR": 600,
    "LOCATED_AT": 800,
    "REPORTED_AGAINST": 300,
    "CO_LOCATED": 634,
    "OWNS_PHONE": 500,
    "OWNS_AADHAAR": 500,
    "USED_TOWER": 2000,
    "SAME_RING": 1980,
}
TOTAL_NODES = sum(EXPECTED_NODES.values())  # 3803
TOTAL_EDGES = sum(EXPECTED_EDGES.values())  # 10802


def test_node_counts_by_type(store):
    summary = store.graph_summary()
    assert summary["node_count"] == TOTAL_NODES
    assert summary["nodes_by_type"] == EXPECTED_NODES


def test_edge_counts_by_type(store):
    summary = store.graph_summary()
    assert summary["edge_count"] == TOTAL_EDGES
    assert summary["edges_by_type"] == EXPECTED_EDGES
    assert summary["observed_edge_count"] == TOTAL_EDGES - EXPECTED_EDGES["SAME_RING"]
    assert summary["overlay_edge_count"] == EXPECTED_EDGES["SAME_RING"]


def test_only_allowed_edge_types_are_emitted(store):
    used = {e.relationship_type for e in store.iter_edges()}
    assert used == set(ALLOWED_EDGE_TYPES)
    for e in store.iter_edges():
        assert e.relationship_type in ALLOWED_EDGE_TYPES


def test_disallowed_edge_types_absent(store):
    # CO_ACCUSED / MEMBER_OF / DROVE etc. are structurally unavailable (preflight).
    assert not hasattr(EdgeType, "CO_ACCUSED")
    used_names = {e.relationship_type.value for e in store.iter_edges()}
    for forbidden in {"CO_ACCUSED", "MEMBER_OF", "DROVE", "SIMILAR_TO"}:
        assert forbidden not in used_names


def test_named_in_fir_is_structured_only(store):
    # Exactly two structured roles per FIR (complainant + accused) => 2 * 300.
    named = [e for e in store.iter_edges() if e.relationship_type == EdgeType.NAMED_IN_FIR]
    assert len(named) == 600
    roles = {e.attributes.get("role") for e in named}
    assert roles == {"complainant", "accused"}


def test_materialized_node_types_only(store):
    present = {n.entity_type for n in store.iter_nodes()}
    assert present == set(MATERIALIZED_NODE_TYPES)
    # TRANSACTION is modelled as an edge, never materialised as a node.
    assert NodeType.TRANSACTION not in present
    for future in (NodeType.VEHICLE, NodeType.ORGANIZATION, NodeType.EVENT):
        assert future not in present


def test_self_references_retained_as_self_loops(store):
    summary = store.graph_summary()
    assert summary["self_loops"] == 3  # 2 self-calls + 1 self REPORTED_AGAINST
    # The specific known self-references are present in the evidence graph.
    assert store.get_edge("CALLED~person:146~person:146") is not None
    assert store.get_edge("CALLED~person:443~person:443") is not None
    assert store.get_edge("REPORTED_AGAINST~person:325~person:325") is not None


def test_every_edge_has_evidence(store):
    for e in store.iter_edges():
        assert len(e.evidence) >= 1
        for ref in e.evidence:
            table, _, pk = ref.partition(":")
            assert table in {"persons", "calls", "transactions", "firs", "locations"}
            assert pk != ""


def test_provenance_confidence_is_deterministic_one(store):
    # No fabricated model confidence: existence-confidence is 1.0 for all edges.
    assert all(e.provenance_confidence == 1.0 for e in store.iter_edges())


def test_same_ring_is_overlay_and_separate(store):
    for e in store.iter_edges():
        if e.relationship_type == EdgeType.SAME_RING:
            assert e.is_overlay is True
        else:
            assert e.is_overlay is False


def test_evidence_edge_traces_to_source(store):
    # A CALLED edge's evidence points at real call rows.
    edge = store.get_edge("CALLED~person:146~person:146")
    assert edge is not None
    assert edge.evidence  # e.g. ["calls:397"]
    assert all(ref.startswith("calls:") for ref in edge.evidence)


def test_deterministic_rebuild(repo, settings):
    s1, _ = build_store(repo, settings)
    s2, _ = build_store(repo, settings)
    e1 = sorted(e.relationship_id for e in s1.iter_edges())
    e2 = sorted(e.relationship_id for e in s2.iter_edges())
    n1 = sorted(n.entity_id for n in s1.iter_nodes())
    n2 = sorted(n.entity_id for n in s2.iter_nodes())
    assert e1 == e2
    assert n1 == n2
    # Weights are stable too.
    w1 = {e.relationship_id: e.weight for e in s1.iter_edges()}
    w2 = {e.relationship_id: e.weight for e in s2.iter_edges()}
    assert w1 == w2


def test_co_located_clique_guard(repo, settings):
    _, stats_default = build_store(repo, settings)
    assert stats_default["co_located"]["skipped_groups_over_cap"] == 0
    assert stats_default["co_located"]["edges"] == EXPECTED_EDGES["CO_LOCATED"]
    assert stats_default["co_located"]["max_group_size"] == 8

    tight = settings.model_copy(update={"co_located_max_group": 5})
    _, stats_tight = build_store(repo, tight)
    assert stats_tight["co_located"]["skipped_groups_over_cap"] > 0
    assert stats_tight["co_located"]["edges"] < EXPECTED_EDGES["CO_LOCATED"]


def test_same_ring_overlay_stats(repo, settings):
    _, stats = build_store(repo, settings)
    ov = stats["same_ring_overlay"]
    assert ov["edges"] == EXPECTED_EDGES["SAME_RING"]
    assert ov["persons_in_a_ring"] == 142
    assert ov["ring_sizes"] == {0: 24, 1: 30, 2: 33, 3: 24, 4: 31}
