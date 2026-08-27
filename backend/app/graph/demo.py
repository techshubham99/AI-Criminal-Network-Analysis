"""Deterministic demo-investigation selector.

Picks one real person whose *observed* network makes a meaningful but honest
demonstration — the most-connected hub in the undirected person projection,
with deterministic tie-breaks. It invents nothing: every reported relationship
comes straight from the structured data, and the language is deliberately
neutral ("connected network", "dense subgraph", "investigation lead") — never
"criminal network detected".
"""
from __future__ import annotations

from app.config import Settings
from app.graph.analytics import GraphAnalytics
from app.graph.model import EdgeType, NodeType
from app.graph.store import GraphStore

# Observed person-person relationship types used to describe the demo network.
_OBSERVED_PP = {
    EdgeType.CALLED,
    EdgeType.TRANSACTED,
    EdgeType.REPORTED_AGAINST,
    EdgeType.CO_LOCATED,
}


def select_demo(store: GraphStore, analytics: GraphAnalytics, settings: Settings) -> dict:
    if not analytics.person_ids:
        return {"available": False, "reason": "no persons in graph"}

    # Deterministic hub selection: most connected, tie-broken by strength then id.
    def rank_key(eid: str):
        return (
            -analytics.degree.get(eid, 0),
            -analytics.weighted_degree.get(eid, 0.0),
            -analytics.betweenness.get(eid, 0.0),
            eid,
        )

    demo_id = sorted(analytics.person_ids, key=rank_key)[0]
    node = store.get_node(demo_id)

    # 1-hop and 2-hop person-only networks (bounded, honest counts).
    _, e1, m1 = store.get_subgraph(
        demo_id, 1, max_nodes=settings.graph_max_network_nodes, node_types=[NodeType.PERSON]
    )
    _, e2, m2 = store.get_subgraph(
        demo_id, 2, max_nodes=settings.graph_max_network_nodes, node_types=[NodeType.PERSON]
    )

    # Strongest observed relationships incident to the demo person.
    incident = []
    for neighbor, edges in store.get_neighbors(demo_id, edge_types=_OBSERVED_PP):
        for edge in edges:
            incident.append(
                {
                    "relationship_id": edge.relationship_id,
                    "relationship_type": edge.relationship_type.value,
                    "with": neighbor.entity_id,
                    "with_label": neighbor.label,
                    "weight": edge.weight,
                    "weight_detail": edge.weight_detail,
                    "evidence_count": len(edge.evidence),
                    "evidence_sample": edge.evidence[:3],
                    "provenance_confidence": edge.provenance_confidence,
                }
            )
    incident.sort(key=lambda r: (-r["weight"], r["relationship_id"]))

    metrics = analytics.person_metrics(demo_id)
    comm_id = analytics.community_of.get(demo_id)
    comm_size = (
        len(analytics._communities[comm_id])
        if comm_id is not None and comm_id < len(analytics._communities)
        else None
    )
    cs = analytics.communities_summary()

    ring_id = node.attributes.get("ring_id") if node else None

    description = (
        f"Connected network around {node.label if node else demo_id}: a densely "
        f"connected hub with {metrics['degree']} direct observed contacts. Presented "
        f"as an investigation lead based on network position only — not a finding of "
        f"criminality."
    )

    return {
        "available": True,
        "selection_method": (
            "deterministic: highest observed degree in the undirected person "
            "projection, tie-broken by weighted degree, betweenness, then entity id"
        ),
        "person_id": demo_id,
        "label": node.label if node else demo_id,
        "one_hop": {"node_count": m1["node_count"], "edge_count": m1["edge_count"]},
        "two_hop": {
            "node_count": m2["node_count"],
            "edge_count": m2["edge_count"],
            "truncated": m2["truncated"],
        },
        "strongest_relationships": incident[:5],
        "notable_metrics": metrics,
        "community": {
            "community_id": comm_id,
            "community_size": comm_size,
            "modularity": cs["modularity"],
            "ground_truth_overlay": cs["ground_truth_overlay"],
        },
        "ground_truth_ring_id": ring_id,
        "description": description,
        "framing_note": (
            "Neutral framing only. This is a structurally connected subgraph / "
            "investigation lead; no crime-ring detection is asserted."
        ),
    }
