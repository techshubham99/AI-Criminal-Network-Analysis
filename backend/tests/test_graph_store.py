"""Phase 2 — GraphStore query tests (neighbors, subgraph, paths, edges)."""
from __future__ import annotations

from app.graph.model import EdgeType, NodeType

HUB = "person:445"  # deterministic most-connected hub (degree 29)


def _first_person_neighbor(store, eid=HUB) -> str:
    neighbors = store.get_neighbors(eid, node_types=[NodeType.PERSON])
    assert neighbors, "hub should have person neighbours"
    return neighbors[0][0].entity_id


def test_get_node(store):
    node = store.get_node("person:1")
    assert node is not None
    assert node.entity_type == NodeType.PERSON
    assert node.entity_id == "person:1"


def test_get_node_missing(store):
    assert store.get_node("person:999999") is None


def test_get_edge_and_missing(store):
    assert store.get_edge("CALLED~person:146~person:146") is not None
    assert store.get_edge("CALLED~person:1~person:999999") is None


def test_neighbors_exclude_overlay_by_default(store):
    neighbors = store.get_neighbors(HUB)
    assert neighbors
    for _, edges in neighbors:
        assert all(not e.is_overlay for e in edges)
        assert all(e.relationship_type != EdgeType.SAME_RING for e in edges)


def test_neighbors_include_overlay_adds_same_ring(store):
    with_overlay = store.get_neighbors(HUB, include_overlay=True)
    ring_edges = [
        e
        for _, edges in with_overlay
        for e in edges
        if e.relationship_type == EdgeType.SAME_RING
    ]
    # The hub is a ring member, so overlay neighbours appear only when requested.
    assert ring_edges
    assert all(e.is_overlay for e in ring_edges)


def test_neighbors_node_type_filter(store):
    phones = store.get_neighbors(HUB, node_types=[NodeType.PHONE])
    assert len(phones) == 1  # each person owns exactly one phone
    node, edges = phones[0]
    assert node.entity_type == NodeType.PHONE
    assert all(e.relationship_type == EdgeType.OWNS_PHONE for e in edges)


def test_edges_between(store):
    node, _ = store.get_neighbors(HUB, node_types=[NodeType.PHONE])[0]
    edges = store.edges_between(HUB, node.entity_id)
    assert len(edges) == 1
    assert edges[0].relationship_type == EdgeType.OWNS_PHONE
    assert edges[0].source_entity_id == HUB


def test_subgraph_depth1_persons_only(store):
    nodes, edges, meta = store.get_subgraph(
        HUB, 1, max_nodes=300, node_types=[NodeType.PERSON]
    )
    assert meta["node_count"] == 30
    assert meta["edge_count"] == 55
    assert meta["truncated"] is False
    assert all(n.entity_type == NodeType.PERSON for n in nodes)
    assert any(n.entity_id == HUB for n in nodes)


def test_subgraph_depth2_expands(store):
    _, _, m1 = store.get_subgraph(HUB, 1, max_nodes=300, node_types=[NodeType.PERSON])
    nodes2, _, m2 = store.get_subgraph(HUB, 2, max_nodes=300, node_types=[NodeType.PERSON])
    assert m2["node_count"] >= m1["node_count"]
    assert m2["node_count"] <= 300  # respects the cap


def test_subgraph_node_cap(store):
    nodes, _, meta = store.get_subgraph(
        HUB, 2, max_nodes=15, node_types=[NodeType.PERSON]
    )
    assert meta["node_count"] <= 15
    assert meta["truncated"] is True


def test_subgraph_includes_attribute_leaves(store):
    # Without a node_types filter, attribute nodes appear as leaves at depth 1.
    nodes, _, _ = store.get_subgraph(HUB, 1, max_nodes=300)
    types = {n.entity_type for n in nodes}
    assert NodeType.PERSON in types
    assert types - {NodeType.PERSON}  # at least one non-person leaf (phone/aadhaar/...)


def test_subgraph_missing_node(store):
    nodes, edges, meta = store.get_subgraph("person:999999", 1, max_nodes=300)
    assert nodes == [] and edges == []
    assert meta["node_count"] == 0


def test_find_paths_basic(store):
    paths = store.find_paths(HUB, "person:1", max_length=6, max_paths=5)
    assert paths  # single connected component => a path exists
    lengths = [len(p) - 1 for p in paths]
    assert lengths == sorted(lengths)  # non-decreasing length
    for p in paths:
        assert p[0] == HUB and p[-1] == "person:1"
        assert len(p) - 1 <= 6


def test_find_paths_same_node_empty(store):
    assert store.find_paths(HUB, HUB, max_length=6, max_paths=5) == []


def test_find_paths_direct_neighbour_length_one(store):
    neighbor = _first_person_neighbor(store)
    paths = store.find_paths(HUB, neighbor, max_length=1, max_paths=5)
    assert paths
    assert all(len(p) - 1 == 1 for p in paths)


def test_find_paths_respects_max_paths(store):
    paths = store.find_paths(HUB, "person:1", max_length=6, max_paths=2)
    assert len(paths) <= 2


def test_find_paths_no_path_returns_empty(store):
    # Some LOCATION nodes have no person/FIR pointing at them, so they are
    # isolated in the path projection. A query to one must return [] gracefully
    # (the documented no-path contract) and never raise NetworkXNoPath.
    isolated = next(
        (
            n.entity_id
            for n in store.iter_nodes()
            if n.entity_type == NodeType.LOCATION and not store.get_neighbors(n.entity_id)
        ),
        None,
    )
    assert isolated is not None, "expected at least one isolated location node"
    assert store.find_paths("person:1", isolated, max_length=6, max_paths=5) == []


def test_search_exact_id_first(graph_service):
    results = graph_service.search("person:445", limit=10)
    assert results
    assert results[0].entity_id == "person:445"


def test_search_substring(graph_service):
    results = graph_service.search("445", limit=50)
    ids = {n.entity_id for n in results}
    assert "person:445" in ids
