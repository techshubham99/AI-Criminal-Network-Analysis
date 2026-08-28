"""Graph service facade.

Bundles the built :class:`GraphStore` with its (lazily computed, cached)
analytics and demo selection, plus search and summary helpers. The API layer
depends only on this facade via ``app.state.graph`` — routers never build graphs
or run analytics themselves.
"""
from __future__ import annotations

from typing import Optional

from app.config import Settings
from app.graph.analytics import GraphAnalytics
from app.graph.builder import build_store
from app.graph.demo import select_demo
from app.graph.model import (
    ALLOWED_EDGE_TYPES,
    FUTURE_NODE_TYPES,
    MATERIALIZED_NODE_TYPES,
    Node,
)
from app.graph.store import GraphStore
from app.repositories.dataset import DatasetRepository

_PROVENANCE_NOTE = (
    "Every edge is traceable to >=1 source record. Existence-confidence is a "
    "deterministic 1.0 at the data-provenance layer for all structured/derived "
    "edges; this is NOT a model confidence. No confidence values are fabricated."
)


class GraphService:
    def __init__(self, store: GraphStore, settings: Settings, build_stats: dict) -> None:
        self.store = store
        self.settings = settings
        self.build_stats = build_stats
        self._analytics: Optional[GraphAnalytics] = None
        self._demo: Optional[dict] = None

    @property
    def analytics(self) -> GraphAnalytics:
        if self._analytics is None:
            self._analytics = GraphAnalytics(self.store, self.settings).compute()
        return self._analytics

    @property
    def cached_analytics(self) -> Optional[GraphAnalytics]:
        """The already-computed pass, or ``None`` — never triggers a computation.

        Live ingestion needs the *pre-change* metrics to report a before/after,
        and the ``analytics`` property would compute them against the graph it
        has just mutated. Reading the cache instead keeps "before" honest: if
        nothing was computed yet, there is no before to report.
        """
        return self._analytics

    def publish_analytics(self, analytics: GraphAnalytics) -> None:
        """Adopt an externally recomputed analytics pass (Phase 4.6).

        Live ingestion mutates the store in place, which makes the cached
        analytics — and the demo selection derived from it — stale. Both are
        replaced together so a served response can never mix pre-change
        centrality with post-change topology.
        """
        self._analytics = analytics
        self._demo = None

    def demo(self) -> dict:
        if self._demo is None:
            self._demo = select_demo(self.store, self.analytics, self.settings)
        return self._demo

    def search(self, query: str, limit: int) -> list[Node]:
        """Case-insensitive match on entity id or label; exact matches first."""
        q = query.strip().lower()
        if not q:
            return []
        scored: list[tuple[int, str, Node]] = []
        for node in self.store.iter_nodes():
            eid = node.entity_id.lower()
            label = node.label.lower()
            if q == eid or q == label:
                rank = 0
            elif eid.endswith(":" + q) or label == q:
                rank = 1
            elif q in eid or q in label:
                rank = 2
            else:
                continue
            scored.append((rank, node.entity_id, node))
        scored.sort(key=lambda t: (t[0], t[1]))
        return [n for _, _, n in scored[:limit]]

    def summary(self) -> dict:
        graph_summary = self.store.graph_summary()
        analytics = self.analytics
        comms = analytics.communities_summary()
        return {
            "phase": "2 - Criminal Network Graph Engine",
            "graph": graph_summary,
            "build": {
                "distinct_towers": self.build_stats.get("distinct_towers"),
                "co_located": self.build_stats.get("co_located"),
                "same_ring_overlay": self.build_stats.get("same_ring_overlay"),
                "deterministic": True,
            },
            "analytics": analytics.projection_stats(),
            "communities": {
                "count": comms["community_count"],
                "modularity": comms["modularity"],
                "adjusted_rand_index_vs_rings": comms["ground_truth_overlay"]["adjusted_rand_index"],
                "ari_persons": comms["ground_truth_overlay"]["ari_persons"],
            },
            "materialized_node_types": [t.value for t in MATERIALIZED_NODE_TYPES],
            "future_node_types": [t.value for t in FUTURE_NODE_TYPES],
            "allowed_edge_types": [t.value for t in ALLOWED_EDGE_TYPES],
            "limits": {
                "max_network_depth": self.settings.graph_max_depth,
                "max_network_nodes": self.settings.graph_max_network_nodes,
                "max_path_length": self.settings.graph_max_path_length,
                "max_paths": self.settings.graph_max_paths,
                "co_located_max_group": self.settings.co_located_max_group,
                "search_limit": self.settings.graph_search_limit,
            },
            "provenance_note": _PROVENANCE_NOTE,
        }


def build_graph_service(
    repo: DatasetRepository, settings: Settings, *, warm: bool = True
) -> GraphService:
    """Build the graph and return the service. If ``warm``, eagerly compute
    analytics so the first request is fast and errors surface at startup."""
    store, stats = build_store(repo, settings)
    service = GraphService(store, settings, stats)
    if warm:
        service.analytics  # noqa: B018 - trigger compute + cache
        service.demo()
    return service
