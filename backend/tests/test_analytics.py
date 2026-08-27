"""Phase 2 — analytics tests (centrality, PageRank, communities, determinism)."""
from __future__ import annotations

import pytest

from app.graph.analytics import GraphAnalytics, adjusted_rand_index, pagerank_numpy
from app.graph.builder import build_store

_ALLOWED_LABELS = {
    "high_network_importance",
    "bridge_entity",
    "high_connectivity_entity",
    "moderately_connected",
    "peripheral",
}


# -- pure functions --------------------------------------------------------
def test_adjusted_rand_index_perfect_and_permutation_invariant():
    assert abs(adjusted_rand_index([0, 0, 1, 1], [0, 0, 1, 1]) - 1.0) < 1e-9
    assert abs(adjusted_rand_index([0, 0, 1, 1], [1, 1, 0, 0]) - 1.0) < 1e-9


def test_pagerank_numpy_cycle_is_uniform():
    pr = pagerank_numpy(
        ["A", "B", "C"],
        [("A", "B", 1.0), ("B", "C", 1.0), ("C", "A", 1.0)],
        damping=0.85,
        tol=1e-12,
        max_iter=200,
    )
    assert abs(sum(pr.values()) - 1.0) < 1e-9
    assert all(abs(v - 1.0 / 3.0) < 1e-6 for v in pr.values())


def test_pagerank_numpy_star_hub_dominates():
    pr = pagerank_numpy(
        ["H", "A", "B", "C"],
        [("A", "H", 1.0), ("B", "H", 1.0), ("C", "H", 1.0)],
        damping=0.85,
        tol=1e-12,
        max_iter=500,
    )
    assert abs(sum(pr.values()) - 1.0) < 1e-9
    assert pr["H"] == max(pr.values())
    assert pr["H"] > pr["A"]


# -- projections & metrics -------------------------------------------------
def test_person_projection_sizes(analytics):
    assert len(analytics.person_ids) == 500
    assert analytics.undirected.number_of_edges() == 4363
    assert analytics.directed.number_of_edges() == 3778


def test_all_persons_have_metrics(analytics):
    for eid in analytics.person_ids:
        assert eid in analytics.degree
        assert eid in analytics.betweenness
        assert eid in analytics.pagerank
        m = analytics.person_metrics(eid)
        assert m is not None
        for key in ("degree", "degree_centrality", "weighted_degree",
                    "betweenness", "pagerank", "community_id", "component_id",
                    "interpretation"):
            assert key in m


def test_pagerank_sums_to_one(analytics):
    assert abs(sum(analytics.pagerank.values()) - 1.0) < 1e-9
    assert all(v >= 0 for v in analytics.pagerank.values())


def test_components_single_connected(analytics):
    cs = analytics.components_summary()
    assert cs["component_count"] == 1
    assert cs["largest_component_size"] == 500
    assert cs["isolated_person_count"] == 0
    assert len(analytics.component_of) == 500


def test_communities_partition_and_modularity(analytics):
    cs = analytics.communities_summary()
    assert cs["deterministic"] is True
    assert cs["community_count"] >= 1
    assert -1.0 <= cs["modularity"] <= 1.0
    # Every person is assigned to exactly one community; sizes cover all 500.
    total = sum(c["size"] for c in cs["communities"])
    assert total == 500
    assert len(analytics.community_of) == 500


def test_ari_overlay_is_honest(analytics):
    overlay = analytics.communities_summary()["ground_truth_overlay"]
    assert overlay["ari_persons"] == 142  # only ring-labelled persons
    ari = overlay["adjusted_rand_index"]
    assert ari is not None and -1.0 <= ari <= 1.0


def test_top_persons_ordering(analytics):
    top = analytics.top_persons("pagerank", 10)
    assert len(top) == 10
    values = [p["pagerank"] for p in top]
    assert values == sorted(values, reverse=True)
    assert all("interpretation" in p for p in top)


def test_top_persons_unknown_metric_raises(analytics):
    with pytest.raises(ValueError):
        analytics.top_persons("nonsense", 5)


def test_interpretation_is_neutral(analytics):
    for eid in analytics.person_ids:
        interp = analytics.person_metrics(eid)["interpretation"]
        assert interp["label"] in _ALLOWED_LABELS
        assert isinstance(interp["is_investigation_lead"], bool)
        # Explicitly disclaims criminality; never asserts a crime.
        disclaimer = interp["disclaimer"].lower()
        assert "not" in disclaimer and "criminality" in disclaimer
        assert "criminal network" not in interp["text"].lower()


def test_projection_documents_unweighted_betweenness(analytics):
    stats = analytics.projection_stats()
    assert "unweighted" in stats["undirected"]["note"].lower()
    assert "SAME_RING_overlay" in stats["excluded_from_analytics"]


# -- determinism -----------------------------------------------------------
def test_analytics_deterministic_on_fresh_rebuild(repo, settings):
    store2, _ = build_store(repo, settings)
    a2 = GraphAnalytics(store2, settings).compute()

    a1_service_free = GraphAnalytics(build_store(repo, settings)[0], settings).compute()

    # PageRank, betweenness, degree, communities and modularity are bit-stable.
    assert a1_service_free.degree == a2.degree
    assert a1_service_free.community_of == a2.community_of
    assert round(a1_service_free._modularity, 9) == round(a2._modularity, 9)
    for eid in a2.person_ids:
        assert round(a1_service_free.pagerank[eid], 9) == round(a2.pagerank[eid], 9)
        assert round(a1_service_free.betweenness[eid], 9) == round(a2.betweenness[eid], 9)
