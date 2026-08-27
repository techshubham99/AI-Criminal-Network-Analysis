"""Phase 2 — HTTP API tests for /graph and /analytics.

Also asserts Phase 1 behaviour is unchanged and that no endpoint labels a
person a criminal.
"""
from __future__ import annotations

from urllib.parse import quote

BASE = "/api/v1"

# Phrases that would over-claim; the disclaimer's "criminality"/"guilt" negations
# are intentionally NOT in this list.
_FORBIDDEN = [
    "criminal network detected",
    "known criminal",
    "is a criminal",
    "confirmed criminal",
    "found guilty",
]


def _assert_neutral(text: str) -> None:
    low = text.lower()
    for phrase in _FORBIDDEN:
        assert phrase not in low, f"over-claiming phrase leaked: {phrase!r}"


# -- graph summary ---------------------------------------------------------
def test_graph_summary(client):
    r = client.get(f"{BASE}/graph/summary")
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "2 - Criminal Network Graph Engine"
    assert body["graph"]["node_count"] == 3803
    assert body["graph"]["edge_count"] == 10802
    assert len(body["allowed_edge_types"]) == 10
    assert "provenance_note" in body
    for key in ("max_network_depth", "max_network_nodes", "max_path_length",
                "max_paths", "co_located_max_group", "search_limit"):
        assert key in body["limits"]


# -- person node -----------------------------------------------------------
def test_person_node(client):
    r = client.get(f"{BASE}/graph/persons/445")
    assert r.status_code == 200
    body = r.json()
    assert body["person"]["entity_id"] == "person:445"
    assert body["person"]["entity_type"] == "PERSON"
    assert body["neighbor_count"] > 0
    assert isinstance(body["relationship_counts"], dict)
    assert body["metrics"]["pagerank"] >= 0


def test_person_node_404(client):
    r = client.get(f"{BASE}/graph/persons/999999")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_person_node_invalid_id_422(client):
    assert client.get(f"{BASE}/graph/persons/0").status_code == 422
    assert client.get(f"{BASE}/graph/persons/abc").status_code == 422


# -- network ---------------------------------------------------------------
def test_network_depth1_persons_only(client):
    r = client.get(f"{BASE}/graph/persons/445/network", params={"depth": 1, "persons_only": True})
    assert r.status_code == 200
    body = r.json()
    assert body["depth"] == 1
    assert body["persons_only"] is True
    assert body["meta"]["node_count"] == 30
    assert body["meta"]["edge_count"] == 55
    assert all(n["entity_type"] == "PERSON" for n in body["nodes"])


def test_network_depth2_truncates(client):
    r = client.get(f"{BASE}/graph/persons/445/network", params={"depth": 2, "persons_only": True})
    assert r.status_code == 200
    meta = r.json()["meta"]
    assert meta["node_count"] <= 300


def test_network_depth_over_max_400(client):
    r = client.get(f"{BASE}/graph/persons/445/network", params={"depth": 3})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "bad_request"
    assert body["error"]["detail"]["max_depth"] == 2


def test_network_node_cap(client):
    r = client.get(
        f"{BASE}/graph/persons/445/network",
        params={"depth": 2, "persons_only": True, "max_nodes": 10},
    )
    assert r.status_code == 200
    meta = r.json()["meta"]
    assert meta["node_count"] <= 10
    assert meta["truncated"] is True


def test_network_include_overlay(client):
    r = client.get(
        f"{BASE}/graph/persons/445/network",
        params={"depth": 1, "persons_only": True, "include_overlay": True},
    )
    assert r.status_code == 200
    types = {e["relationship_type"] for e in r.json()["edges"]}
    assert "SAME_RING" in types  # hub is a ring member


# -- relationships ---------------------------------------------------------
def test_relationship_self_loop(client):
    r = client.get(f"{BASE}/graph/relationships/CALLED~person:146~person:146")
    assert r.status_code == 200
    body = r.json()
    assert body["provenance_confidence"] == 1.0
    assert body["is_overlay"] is False
    assert body["evidence_count"] >= 1
    assert body["evidence"]


def test_relationship_with_plus_in_id(client):
    # OWNS_PHONE ids embed a phone number with a leading '+'.
    net = client.get(f"{BASE}/graph/persons/1/network", params={"depth": 1}).json()
    owns = [e for e in net["edges"] if e["relationship_type"] == "OWNS_PHONE"]
    assert owns
    rel_id = owns[0]["relationship_id"]
    assert "+" in rel_id
    r = client.get(f"{BASE}/graph/relationships/{quote(rel_id, safe='~:')}")
    assert r.status_code == 200
    assert r.json()["relationship_id"] == rel_id


def test_relationship_404(client):
    r = client.get(f"{BASE}/graph/relationships/CALLED~person:1~person:999999")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# -- path ------------------------------------------------------------------
def test_path_found(client):
    r = client.get(f"{BASE}/graph/path", params={"source": "person:445", "target": "person:1"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["path_count"] >= 1
    first = body["paths"][0]
    assert first["nodes"][0]["entity_id"] == "person:445"
    assert first["nodes"][-1]["entity_id"] == "person:1"
    assert first["edges"]  # hops carry the connecting evidence edges


def test_path_same_source_target_400(client):
    r = client.get(f"{BASE}/graph/path", params={"source": "person:1", "target": "person:1"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bad_request"


def test_path_unknown_node_404(client):
    r = client.get(f"{BASE}/graph/path", params={"source": "person:999999", "target": "person:1"})
    assert r.status_code == 404


def test_path_missing_query_422(client):
    assert client.get(f"{BASE}/graph/path", params={"source": "person:1"}).status_code == 422


def test_path_no_path_found_200(client):
    # A valid but disconnected pair must yield a graceful 200 found:false, not a
    # 500 (regression: shortest_simple_paths raises NetworkXNoPath lazily, so the
    # no-path handler was previously dead code). location:138 is isolated in the
    # path projection (no person/FIR located there).
    r = client.get(f"{BASE}/graph/path", params={"source": "person:1", "target": "location:138"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is False
    assert body["path_count"] == 0
    assert body["paths"] == []


# -- search ----------------------------------------------------------------
def test_search(client):
    r = client.get(f"{BASE}/graph/search", params={"q": "person:445"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    assert body["results"][0]["entity_id"] == "person:445"


def test_search_requires_query_422(client):
    assert client.get(f"{BASE}/graph/search", params={"q": ""}).status_code == 422


# -- analytics -------------------------------------------------------------
def test_analytics_top_default(client):
    r = client.get(f"{BASE}/analytics/persons/top")
    assert r.status_code == 200
    body = r.json()
    assert body["metric"] == "pagerank"
    assert body["count"] == 20  # analytics_default_top
    values = [p["pagerank"] for p in body["persons"]]
    assert values == sorted(values, reverse=True)
    assert "note" in body
    for p in body["persons"]:
        assert "interpretation" in p and "disclaimer" in p["interpretation"]
    _assert_neutral(r.text)


def test_analytics_top_metric_and_limit(client):
    r = client.get(f"{BASE}/analytics/persons/top", params={"metric": "degree", "limit": 5})
    assert r.status_code == 200
    assert r.json()["count"] == 5


def test_analytics_top_invalid_metric_400(client):
    r = client.get(f"{BASE}/analytics/persons/top", params={"metric": "bogus"})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "bad_request"
    assert "allowed" in body["error"]["detail"]


def test_analytics_top_limit_capped(client):
    r = client.get(f"{BASE}/analytics/persons/top", params={"limit": 100000})
    assert r.status_code == 200
    assert r.json()["count"] == 100  # analytics_max_top


def test_analytics_communities(client):
    r = client.get(f"{BASE}/analytics/communities")
    assert r.status_code == 200
    body = r.json()
    assert body["deterministic"] is True
    assert body["community_count"] >= 1
    assert -1.0 <= body["modularity"] <= 1.0
    assert body["ground_truth_overlay"]["ari_persons"] == 142
    _assert_neutral(r.text)


def test_analytics_communities_min_size_filter(client):
    r = client.get(f"{BASE}/analytics/communities", params={"min_size": 1000})
    assert r.status_code == 200
    assert r.json()["communities"] == []  # no community that large


def test_analytics_person(client):
    r = client.get(f"{BASE}/analytics/persons/445")
    assert r.status_code == 200
    body = r.json()
    assert body["entity_id"] == "person:445"
    for key in ("degree", "betweenness", "pagerank", "community_id", "interpretation"):
        assert key in body
    _assert_neutral(r.text)


def test_analytics_person_404(client):
    r = client.get(f"{BASE}/analytics/persons/999999")
    assert r.status_code == 404


# -- demo ------------------------------------------------------------------
def test_demo_investigation(client):
    r = client.get(f"{BASE}/analytics/demo")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["person_id"].startswith("person:")
    assert "one_hop" in body and "two_hop" in body
    assert body["strongest_relationships"]
    for rel in body["strongest_relationships"]:
        assert rel["evidence_count"] >= 1  # real, evidence-backed relationship
        assert rel["provenance_confidence"] == 1.0
    assert "framing_note" in body
    _assert_neutral(r.text)


# -- Phase 1 regression ----------------------------------------------------
def test_phase1_health_unchanged(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == "0.1.0"
    assert body["phase"] == "1 - Backend Foundation"
    assert body["dataset_loaded"] is True


def test_phase1_and_phase2_routes_coexist(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    # Phase 1 person endpoint still present...
    assert "/api/v1/persons/{person_id}" in paths
    # ...alongside the new Phase 2 graph engine.
    assert "/api/v1/graph/summary" in paths
    assert "/api/v1/analytics/persons/top" in paths


def test_no_criminal_labeling_across_endpoints(client):
    for path in (
        f"{BASE}/graph/summary",
        f"{BASE}/analytics/demo",
        f"{BASE}/analytics/persons/top",
        f"{BASE}/analytics/persons/445",
        f"{BASE}/analytics/communities",
    ):
        _assert_neutral(client.get(path).text)
