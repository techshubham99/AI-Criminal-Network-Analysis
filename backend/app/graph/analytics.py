"""Graph analytics: centrality, PageRank, components, and communities.

All metrics are computed on **person-only projections** of the full evidence
graph and cached at build time (deterministic). Two projections are maintained
and it is documented which metric uses which and why:

* **Undirected weighted person graph** — folds CALLED / TRANSACTED /
  REPORTED_AGAINST (both directions) plus derived CO_LOCATED into one weighted
  edge per pair. Used for *degree*, *weighted degree*, *betweenness*,
  *connected components*, and *Louvain communities* — these ask "who is
  connected to whom / how central", which is inherently undirected. Betweenness
  is computed **unweighted** because the multiplex weights are affinities
  (stronger = closer), not path costs/distances.
* **Directed weighted person graph** — keeps CALLED / TRANSACTED /
  REPORTED_AGAINST direction. Used for *PageRank*, which models directed
  influence/flow (who is pointed at by important others).

Self-loops (the 3 self-references) and the SAME_RING ground-truth overlay are
excluded from both projections — they distort centrality/community and are not
observed intelligence.

Interpretation is strictly percentile-based over the actual metric values and
uses neutral investigative language. It never labels a person a criminal.

PageRank is a deterministic numpy power-iteration (damping 0.85, weighted) —
implemented here to avoid a scipy dependency, matching the standard Google
PageRank formulation with uniform dangling-mass redistribution.
"""
from __future__ import annotations

import bisect
import logging
from collections import defaultdict
from typing import Optional

import networkx as nx
import numpy as np

from app.config import Settings
from app.graph.model import EdgeType, NodeType
from app.graph.store import GraphStore

logger = logging.getLogger("app.graph.analytics")

# Person-person relationship types that feed the analytic projections.
_UNDIRECTED_CONTRIB = {EdgeType.CALLED, EdgeType.TRANSACTED, EdgeType.REPORTED_AGAINST}
_DIRECTED_CONTRIB = {EdgeType.CALLED, EdgeType.TRANSACTED, EdgeType.REPORTED_AGAINST}


def _comb2(n: int) -> float:
    return n * (n - 1) / 2.0


def adjusted_rand_index(labels_true: list[int], labels_pred: list[int]) -> float:
    """Adjusted Rand Index between two labelings of the same items.

    Pure-Python (no sklearn). Returns 1.0 for perfect agreement, ~0.0 for random.
    """
    if not labels_true:
        return 0.0
    contingency: dict[tuple[int, int], int] = defaultdict(int)
    a_counts: dict[int, int] = defaultdict(int)
    b_counts: dict[int, int] = defaultdict(int)
    for t, p in zip(labels_true, labels_pred):
        contingency[(t, p)] += 1
        a_counts[t] += 1
        b_counts[p] += 1
    sum_comb = sum(_comb2(v) for v in contingency.values())
    sum_a = sum(_comb2(v) for v in a_counts.values())
    sum_b = sum(_comb2(v) for v in b_counts.values())
    n = len(labels_true)
    total_comb = _comb2(n)
    expected = (sum_a * sum_b) / total_comb if total_comb else 0.0
    max_index = (sum_a + sum_b) / 2.0
    denom = max_index - expected
    if denom == 0:
        return 1.0 if sum_comb == expected else 0.0
    return (sum_comb - expected) / denom


def pagerank_numpy(
    node_ids: list[str],
    edges: list[tuple[str, str, float]],
    *,
    damping: float,
    tol: float,
    max_iter: int,
) -> dict[str, float]:
    """Deterministic weighted PageRank via numpy power iteration (no scipy).

    ``edges`` are directed (src, dst, weight>0). Dangling nodes (no out-edges)
    redistribute their mass uniformly. Result sums to 1.0.
    """
    n = len(node_ids)
    if n == 0:
        return {}
    idx = {nid: i for i, nid in enumerate(node_ids)}
    out_weight = np.zeros(n, dtype=float)
    src_idx: list[int] = []
    dst_idx: list[int] = []
    w_vals: list[float] = []
    for s, d, w in edges:
        si, di = idx[s], idx[d]
        out_weight[si] += w
        src_idx.append(si)
        dst_idx.append(di)
        w_vals.append(w)
    src_arr = np.asarray(src_idx, dtype=np.intp)
    dst_arr = np.asarray(dst_idx, dtype=np.intp)
    # Normalise each edge weight by its source's total out-weight (column-stochastic).
    if w_vals:
        contrib_base = np.asarray(w_vals, dtype=float) / out_weight[src_arr]
    else:
        contrib_base = np.zeros(0, dtype=float)
    dangling_mask = out_weight == 0

    r = np.full(n, 1.0 / n, dtype=float)
    teleport = (1.0 - damping) / n
    for _ in range(max_iter):
        new_r = np.full(n, teleport, dtype=float)
        new_r += damping * r[dangling_mask].sum() / n
        if contrib_base.size:
            np.add.at(new_r, dst_arr, damping * r[src_arr] * contrib_base)
        if np.abs(new_r - r).sum() < tol:
            r = new_r
            break
        r = new_r
    total = r.sum()
    if total > 0:
        r = r / total
    return {node_ids[i]: float(r[i]) for i in range(n)}


class GraphAnalytics:
    def __init__(self, store: GraphStore, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        self._computed = False

        self.person_ids: list[str] = []
        self.undirected = nx.Graph()
        self.directed = nx.DiGraph()

        self.degree: dict[str, int] = {}
        self.degree_centrality: dict[str, float] = {}
        self.weighted_degree: dict[str, float] = {}
        self.betweenness: dict[str, float] = {}
        self.pagerank: dict[str, float] = {}
        self.community_of: dict[str, int] = {}
        self.component_of: dict[str, int] = {}

        self._communities: list[list[str]] = []
        self._components: list[list[str]] = []
        self._modularity: float = 0.0
        self._ring_ari: Optional[float] = None
        self._ring_ari_n: int = 0

        # Sorted value arrays for percentile lookups.
        self._sorted: dict[str, list[float]] = {}

    # -- construction ------------------------------------------------------
    def compute(self) -> "GraphAnalytics":
        if self._computed:
            return self
        self._build_projections()
        self._compute_centrality()
        self._compute_pagerank()
        self._compute_components()
        self._compute_communities()
        self._prepare_percentiles()
        self._computed = True
        logger.info(
            "Analytics computed over %d persons: undirected_edges=%d directed_edges=%d "
            "communities=%d components=%d modularity=%.4f",
            len(self.person_ids),
            self.undirected.number_of_edges(),
            self.directed.number_of_edges(),
            len(self._communities),
            len(self._components),
            self._modularity,
        )
        return self

    def _build_projections(self) -> None:
        self.person_ids = sorted(
            n.entity_id for n in self.store.iter_nodes() if n.entity_type == NodeType.PERSON
        )
        self.undirected.add_nodes_from(self.person_ids)
        self.directed.add_nodes_from(self.person_ids)

        undirected_w: dict[tuple[str, str], float] = defaultdict(float)
        directed_w: dict[tuple[str, str], float] = defaultdict(float)
        w_cfg = {
            EdgeType.CALLED: self.settings.graph_weight_called,
            EdgeType.TRANSACTED: self.settings.graph_weight_transacted,
            EdgeType.REPORTED_AGAINST: self.settings.graph_weight_reported_against,
        }
        wd_cfg = {
            EdgeType.CALLED: self.settings.graph_dir_weight_called,
            EdgeType.TRANSACTED: self.settings.graph_dir_weight_transacted,
            EdgeType.REPORTED_AGAINST: self.settings.graph_dir_weight_reported_against,
        }
        for edge in self.store.iter_edges():
            if edge.is_overlay:
                continue  # SAME_RING excluded from analytics
            u, v = edge.source_entity_id, edge.target_entity_id
            if u == v:
                continue  # self-loops excluded from analytics
            etype = edge.relationship_type
            if etype in _UNDIRECTED_CONTRIB:
                key = (u, v) if u < v else (v, u)
                undirected_w[key] += w_cfg[etype] * edge.weight
                directed_w[(u, v)] += wd_cfg[etype] * edge.weight
            elif etype == EdgeType.CO_LOCATED:
                key = (u, v) if u < v else (v, u)
                undirected_w[key] += self.settings.graph_weight_co_located * edge.weight
            # all other edge types are not person-person -> ignored here

        for (a, b), w in undirected_w.items():
            self.undirected.add_edge(a, b, weight=w)
        for (a, b), w in directed_w.items():
            self.directed.add_edge(a, b, weight=w)

    def _compute_centrality(self) -> None:
        self.degree = dict(self.undirected.degree())
        n = self.undirected.number_of_nodes()
        norm = (n - 1) if n > 1 else 1
        self.degree_centrality = {k: v / norm for k, v in self.degree.items()}
        self.weighted_degree = {
            k: float(v) for k, v in self.undirected.degree(weight="weight")
        }
        # Unweighted betweenness: multiplex weights are affinities, not distances.
        self.betweenness = nx.betweenness_centrality(
            self.undirected, weight=None, normalized=True
        )

    def _compute_pagerank(self) -> None:
        edges = [
            (u, v, float(data["weight"]))
            for u, v, data in self.directed.edges(data=True)
            if data["weight"] > 0
        ]
        self.pagerank = pagerank_numpy(
            self.person_ids,
            edges,
            damping=self.settings.pagerank_damping,
            tol=self.settings.pagerank_tolerance,
            max_iter=self.settings.pagerank_max_iter,
        )

    def _compute_components(self) -> None:
        comps = [sorted(c) for c in nx.connected_components(self.undirected)]
        comps.sort(key=lambda c: (-len(c), c[0]))
        self._components = comps
        for i, comp in enumerate(comps):
            for nid in comp:
                self.component_of[nid] = i

    def _compute_communities(self) -> None:
        communities = nx.community.louvain_communities(
            self.undirected, weight="weight", seed=self.settings.louvain_seed
        )
        comm = [sorted(c) for c in communities]
        comm.sort(key=lambda c: (-len(c), c[0]))
        self._communities = comm
        for i, members in enumerate(comm):
            for nid in members:
                self.community_of[nid] = i
        self._modularity = float(
            nx.community.modularity(
                self.undirected, [set(c) for c in comm], weight="weight"
            )
        )
        self._compute_ring_ari()

    def _compute_ring_ari(self) -> None:
        # Honest overlay agreement: only over persons that HAVE a ground-truth
        # ring label (preflight §8). Community label is the detected community.
        labels_true: list[int] = []
        labels_pred: list[int] = []
        for nid in self.person_ids:
            node = self.store.get_node(nid)
            ring = node.attributes.get("ring_id") if node else None
            if ring is None:
                continue
            labels_true.append(int(ring))
            labels_pred.append(self.community_of.get(nid, -1))
        self._ring_ari_n = len(labels_true)
        self._ring_ari = (
            adjusted_rand_index(labels_true, labels_pred) if labels_true else None
        )

    def _prepare_percentiles(self) -> None:
        self._sorted = {
            "degree": sorted(float(v) for v in self.degree.values()),
            "weighted_degree": sorted(self.weighted_degree.values()),
            "betweenness": sorted(self.betweenness.values()),
            "pagerank": sorted(self.pagerank.values()),
        }

    # -- percentile / interpretation --------------------------------------
    def _percentile(self, metric: str, value: float) -> float:
        arr = self._sorted.get(metric)
        if not arr:
            return 0.0
        rank = bisect.bisect_right(arr, value)
        return round(100.0 * rank / len(arr), 2)

    def _interpret(self, deg_pct: float, pr_pct: float, btw_pct: float) -> dict:
        top = self.settings.analytics_top_percentile
        high_degree = deg_pct >= top
        high_pr = pr_pct >= top
        high_btw = btw_pct >= top
        if high_btw and (high_degree or high_pr):
            label = "high_network_importance"
            text = (
                "High network importance: both highly connected and positioned as a "
                "bridge between otherwise separate groups in the observed data."
            )
        elif high_btw:
            label = "bridge_entity"
            text = (
                "Bridge entity: lies on many shortest paths, connecting otherwise "
                "separate parts of the observed network."
            )
        elif high_degree or high_pr:
            label = "high_connectivity_entity"
            text = "High-connectivity entity: has many or strong direct connections."
        elif deg_pct >= 50:
            label = "moderately_connected"
            text = "Moderately connected entity."
        else:
            label = "peripheral"
            text = "Peripheral entity: few connections in the observed data."
        return {
            "label": label,
            "text": text,
            "is_investigation_lead": bool(high_btw or high_degree or high_pr),
            "basis": {
                "degree_percentile": deg_pct,
                "pagerank_percentile": pr_pct,
                "betweenness_percentile": btw_pct,
                "top_percentile_threshold": top,
            },
            "disclaimer": (
                "Describes structural position in the observed data only; it is NOT "
                "a determination of criminality or guilt."
            ),
        }

    # -- public accessors --------------------------------------------------
    def is_person(self, entity_id: str) -> bool:
        return entity_id in self.degree

    def person_metrics(self, entity_id: str) -> Optional[dict]:
        if entity_id not in self.degree:
            return None
        deg_pct = self._percentile("degree", float(self.degree[entity_id]))
        pr_pct = self._percentile("pagerank", self.pagerank[entity_id])
        btw_pct = self._percentile("betweenness", self.betweenness[entity_id])
        return {
            "entity_id": entity_id,
            "degree": self.degree[entity_id],
            "degree_centrality": round(self.degree_centrality[entity_id], 6),
            "weighted_degree": round(self.weighted_degree[entity_id], 4),
            "betweenness": round(self.betweenness[entity_id], 6),
            "pagerank": round(self.pagerank[entity_id], 6),
            "community_id": self.community_of.get(entity_id),
            "component_id": self.component_of.get(entity_id),
            "interpretation": self._interpret(deg_pct, pr_pct, btw_pct),
        }

    def top_persons(self, metric: str, limit: int) -> list[dict]:
        source = {
            "degree": self.degree,
            "weighted_degree": self.weighted_degree,
            "betweenness": self.betweenness,
            "pagerank": self.pagerank,
        }.get(metric)
        if source is None:
            raise ValueError(f"Unknown metric: {metric}")
        # Deterministic tie-break by entity id.
        ranked = sorted(source.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
        return [self.person_metrics(eid) for eid, _ in ranked]

    def communities_summary(self, min_size: int = 1) -> dict:
        comms = [
            {
                "community_id": i,
                "size": len(members),
                "members_sample": members[:10],
            }
            for i, members in enumerate(self._communities)
            if len(members) >= min_size
        ]
        return {
            "algorithm": "networkx.community.louvain_communities",
            "projection": "undirected_weighted_person_graph",
            "weight": "multiplex (CALLED+TRANSACTED+REPORTED_AGAINST+CO_LOCATED)",
            "seed": self.settings.louvain_seed,
            "deterministic": True,
            "community_count": len(self._communities),
            "modularity": round(self._modularity, 6),
            "ground_truth_overlay": {
                "label": "ring_id",
                "note": (
                    "Detected communities are reported BESIDE the ground-truth ring "
                    "overlay; no clean unsupervised ring recovery is claimed (DQ-3)."
                ),
                "adjusted_rand_index": (
                    round(self._ring_ari, 6) if self._ring_ari is not None else None
                ),
                "ari_persons": self._ring_ari_n,
            },
            "communities": comms,
        }

    def components_summary(self) -> dict:
        sizes = [len(c) for c in self._components]
        return {
            "projection": "undirected_weighted_person_graph",
            "component_count": len(self._components),
            "largest_component_size": max(sizes) if sizes else 0,
            "isolated_person_count": sum(1 for s in sizes if s == 1),
        }

    def projection_stats(self) -> dict:
        return {
            "persons": len(self.person_ids),
            "undirected": {
                "edges": self.undirected.number_of_edges(),
                "metrics": ["degree", "weighted_degree", "betweenness", "components", "louvain"],
                "note": "betweenness is unweighted (weights are affinities, not distances)",
            },
            "directed": {
                "edges": self.directed.number_of_edges(),
                "metrics": ["pagerank"],
            },
            "excluded_from_analytics": ["self_loops", "SAME_RING_overlay", "non_person_nodes"],
        }
