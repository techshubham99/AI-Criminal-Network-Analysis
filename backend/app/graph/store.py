"""GraphStore abstraction and its NetworkX implementation.

The rest of Phase 2 talks to the abstract :class:`GraphStore` interface, never
to NetworkX directly, so a Neo4j-backed store can be dropped in later without
touching the builder, analytics, or API layers.

The concrete :class:`NetworkXGraphStore` keeps a ``networkx.MultiDiGraph`` as the
full multiplex evidence graph (directed, with parallel edges and self-loops
retained). Traversal / neighbour / path queries treat the graph as undirected
(direction is preserved on each edge record and reported to the caller), which
is the correct projection for "who is connected to whom" investigative queries.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections import deque
from typing import Iterable, Optional

import networkx as nx

from app.graph.model import (
    OVERLAY_EDGE_TYPES,
    Edge,
    EdgeType,
    Node,
    NodeType,
)

# A neighbour is an adjacent node together with every edge connecting it to the
# anchor (there may be several: e.g. both CALLED and TRANSACTED).
Neighbor = tuple[Node, list[Edge]]


class GraphStore(ABC):
    """Storage-agnostic graph interface (the seven Phase 2 operations)."""

    @abstractmethod
    def add_node(self, node: Node) -> None: ...

    @abstractmethod
    def add_edge(self, edge: Edge) -> None: ...

    @abstractmethod
    def get_node(self, entity_id: str) -> Optional[Node]: ...

    @abstractmethod
    def get_edge(self, relationship_id: str) -> Optional[Edge]: ...

    @abstractmethod
    def get_neighbors(
        self,
        entity_id: str,
        *,
        edge_types: Optional[Iterable[EdgeType]] = None,
        node_types: Optional[Iterable[NodeType]] = None,
        include_overlay: bool = False,
    ) -> list[Neighbor]: ...

    @abstractmethod
    def edges_between(
        self,
        source: str,
        target: str,
        *,
        edge_types: Optional[Iterable[EdgeType]] = None,
        include_overlay: bool = False,
    ) -> list[Edge]: ...

    @abstractmethod
    def get_subgraph(
        self,
        entity_id: str,
        depth: int,
        *,
        max_nodes: int,
        expandable_types: Optional[Iterable[NodeType]] = None,
        node_types: Optional[Iterable[NodeType]] = None,
        edge_types: Optional[Iterable[EdgeType]] = None,
        include_overlay: bool = False,
    ) -> tuple[list[Node], list[Edge], dict]: ...

    @abstractmethod
    def find_paths(
        self,
        source: str,
        target: str,
        *,
        max_length: int,
        max_paths: int,
        include_overlay: bool = False,
    ) -> list[list[str]]: ...

    @abstractmethod
    def graph_summary(self) -> dict: ...

    # -- convenience (concrete helpers shared by all stores) ---------------
    @abstractmethod
    def has_node(self, entity_id: str) -> bool: ...

    @abstractmethod
    def node_count(self) -> int: ...

    @abstractmethod
    def edge_count(self) -> int: ...

    @abstractmethod
    def iter_nodes(self) -> Iterable[Node]: ...

    @abstractmethod
    def iter_edges(self) -> Iterable[Edge]: ...


class NetworkXGraphStore(GraphStore):
    def __init__(self) -> None:
        self.g = nx.MultiDiGraph()
        self._nodes: dict[str, Node] = {}
        self._edges: dict[str, Edge] = {}
        # Cached simple undirected projection for path queries (built lazily,
        # invalidated on mutation). Excludes overlay edges by default.
        self._paths_graph: Optional[nx.Graph] = None
        self._paths_graph_overlay: Optional[nx.Graph] = None

    # -- mutation ----------------------------------------------------------
    def add_node(self, node: Node) -> None:
        existing = self._nodes.get(node.entity_id)
        if existing is not None:
            # Idempotent: first write wins; type must stay consistent.
            if existing.entity_type != node.entity_type:
                raise ValueError(
                    f"Node {node.entity_id} already exists as "
                    f"{existing.entity_type} != {node.entity_type}"
                )
            return
        self._nodes[node.entity_id] = node
        self.g.add_node(node.entity_id, type=node.entity_type.value)
        self._paths_graph = self._paths_graph_overlay = None

    def add_edge(self, edge: Edge) -> None:
        if edge.source_entity_id not in self._nodes:
            raise ValueError(f"Unknown source node: {edge.source_entity_id}")
        if edge.target_entity_id not in self._nodes:
            raise ValueError(f"Unknown target node: {edge.target_entity_id}")
        self._edges[edge.relationship_id] = edge
        self.g.add_edge(
            edge.source_entity_id,
            edge.target_entity_id,
            key=edge.relationship_id,
            type=edge.relationship_type.value,
            weight=edge.weight,
        )
        self._paths_graph = self._paths_graph_overlay = None

    # -- lookups -----------------------------------------------------------
    def get_node(self, entity_id: str) -> Optional[Node]:
        return self._nodes.get(entity_id)

    def get_edge(self, relationship_id: str) -> Optional[Edge]:
        return self._edges.get(relationship_id)

    def has_node(self, entity_id: str) -> bool:
        return entity_id in self._nodes

    def node_count(self) -> int:
        return len(self._nodes)

    def edge_count(self) -> int:
        return len(self._edges)

    def iter_nodes(self) -> Iterable[Node]:
        return self._nodes.values()

    def iter_edges(self) -> Iterable[Edge]:
        return self._edges.values()

    # -- internal helpers --------------------------------------------------
    @staticmethod
    def _edge_allowed(
        edge: Edge,
        edge_types: Optional[set[EdgeType]],
        include_overlay: bool,
    ) -> bool:
        if not include_overlay and edge.is_overlay:
            return False
        if edge_types is not None and edge.relationship_type not in edge_types:
            return False
        return True

    def _edges_between(self, u: str, v: str) -> dict[str, Edge]:
        """All edges connecting u and v (both directions), keyed by rel id."""
        found: dict[str, Edge] = {}
        seen_pairs = {(u, v)} if u == v else {(u, v), (v, u)}
        for a, b in seen_pairs:
            data = self.g.get_edge_data(a, b)
            if not data:
                continue
            for rel_id in data:  # key == relationship_id
                edge = self._edges.get(rel_id)
                if edge is not None:
                    found[rel_id] = edge
        return found

    def _adjacent_ids(self, entity_id: str) -> list[str]:
        """Undirected neighbours (excluding self), deterministically ordered."""
        ids = set(self.g.successors(entity_id)) | set(self.g.predecessors(entity_id))
        ids.discard(entity_id)
        return sorted(ids)

    def edges_between(
        self,
        source: str,
        target: str,
        *,
        edge_types: Optional[Iterable[EdgeType]] = None,
        include_overlay: bool = False,
    ) -> list[Edge]:
        et = set(edge_types) if edge_types is not None else None
        edges = [
            e
            for e in self._edges_between(source, target).values()
            if self._edge_allowed(e, et, include_overlay)
        ]
        edges.sort(key=lambda e: e.relationship_id)
        return edges

    def get_neighbors(
        self,
        entity_id: str,
        *,
        edge_types: Optional[Iterable[EdgeType]] = None,
        node_types: Optional[Iterable[NodeType]] = None,
        include_overlay: bool = False,
    ) -> list[Neighbor]:
        if entity_id not in self._nodes:
            return []
        et = set(edge_types) if edge_types is not None else None
        nt = set(node_types) if node_types is not None else None
        out: list[Neighbor] = []
        for nid in self._adjacent_ids(entity_id):
            neighbor = self._nodes[nid]
            if nt is not None and neighbor.entity_type not in nt:
                continue
            edges = [
                e
                for e in self._edges_between(entity_id, nid).values()
                if self._edge_allowed(e, et, include_overlay)
            ]
            if not edges:
                continue
            edges.sort(key=lambda e: e.relationship_id)
            out.append((neighbor, edges))
        return out

    def get_subgraph(
        self,
        entity_id: str,
        depth: int,
        *,
        max_nodes: int,
        expandable_types: Optional[Iterable[NodeType]] = None,
        node_types: Optional[Iterable[NodeType]] = None,
        edge_types: Optional[Iterable[EdgeType]] = None,
        include_overlay: bool = False,
    ) -> tuple[list[Node], list[Edge], dict]:
        """Bounded BFS ego-network, returned as an induced subgraph.

        Expansion only continues *through* nodes whose type is in
        ``expandable_types`` (default: PERSON) — so attribute nodes (phone,
        location, tower, FIR) appear as leaves rather than bridging unrelated
        persons. The returned edge set is the induced subgraph over the selected
        node set (every allowed edge whose endpoints are both included), which
        is complete and deterministic. Growth is capped at ``max_nodes``.
        """
        if entity_id not in self._nodes:
            return [], [], {"truncated": False, "node_count": 0, "edge_count": 0, "depth": depth}

        expand = (
            set(expandable_types) if expandable_types is not None else {NodeType.PERSON}
        )
        nt = set(node_types) if node_types is not None else None
        et = set(edge_types) if edge_types is not None else None

        selected: set[str] = {entity_id}
        truncated = False
        queue: deque[tuple[str, int]] = deque([(entity_id, 0)])
        visited_levels: dict[str, int] = {entity_id: 0}

        while queue:
            node_id, level = queue.popleft()
            if level >= depth:
                continue
            node = self._nodes[node_id]
            if node.entity_type not in expand:
                continue  # do not expand through non-expandable (leaf) nodes
            for nid in self._adjacent_ids(node_id):
                neighbor = self._nodes[nid]
                if nt is not None and neighbor.entity_type not in nt:
                    continue
                # Must have at least one allowed connecting edge to include it.
                if not any(
                    self._edge_allowed(e, et, include_overlay)
                    for e in self._edges_between(node_id, nid).values()
                ):
                    continue
                if nid not in selected:
                    if len(selected) >= max_nodes:
                        truncated = True
                        continue
                    selected.add(nid)
                if nid not in visited_levels:
                    visited_levels[nid] = level + 1
                    queue.append((nid, level + 1))

        # Induced edge set over the selected nodes (deterministic order).
        edges = [
            e
            for e in self._edges.values()
            if e.source_entity_id in selected
            and e.target_entity_id in selected
            and self._edge_allowed(e, et, include_overlay)
        ]
        edges.sort(key=lambda e: e.relationship_id)
        nodes = [self._nodes[i] for i in sorted(selected)]
        meta = {
            "truncated": truncated,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "depth": depth,
            "max_nodes": max_nodes,
        }
        return nodes, edges, meta

    def _build_paths_graph(self, include_overlay: bool) -> nx.Graph:
        """Simple undirected projection used for path queries (cached)."""
        cached = self._paths_graph_overlay if include_overlay else self._paths_graph
        if cached is not None:
            return cached
        graph = nx.Graph()
        for nid in sorted(self._nodes):  # stable node order -> deterministic paths
            graph.add_node(nid)
        for rel_id in sorted(self._edges):
            edge = self._edges[rel_id]
            if not include_overlay and edge.is_overlay:
                continue
            if edge.source_entity_id == edge.target_entity_id:
                continue  # self-loops carry no path information
            graph.add_edge(edge.source_entity_id, edge.target_entity_id)
        if include_overlay:
            self._paths_graph_overlay = graph
        else:
            self._paths_graph = graph
        return graph

    def find_paths(
        self,
        source: str,
        target: str,
        *,
        max_length: int,
        max_paths: int,
        include_overlay: bool = False,
    ) -> list[list[str]]:
        if source not in self._nodes or target not in self._nodes or source == target:
            return []
        graph = self._build_paths_graph(include_overlay)
        # shortest_simple_paths is a lazy generator: NetworkXNoPath is raised on
        # the first iteration (not at creation), so the loop must sit *inside*
        # the try for the documented no-path contract (return []) to hold.
        paths: list[list[str]] = []
        try:
            for path in nx.shortest_simple_paths(graph, source, target):
                if len(path) - 1 > max_length:
                    break  # generator yields in non-decreasing length -> done
                paths.append(path)
                if len(paths) >= max_paths:
                    break
        except nx.NetworkXNoPath:
            return []
        return paths

    def graph_summary(self) -> dict:
        node_counts: dict[str, int] = {}
        for node in self._nodes.values():
            node_counts[node.entity_type.value] = node_counts.get(node.entity_type.value, 0) + 1
        edge_counts: dict[str, int] = {}
        overlay_counts: dict[str, int] = {}
        self_loops = 0
        for edge in self._edges.values():
            key = edge.relationship_type.value
            edge_counts[key] = edge_counts.get(key, 0) + 1
            if edge.is_overlay:
                overlay_counts[key] = overlay_counts.get(key, 0) + 1
            if edge.source_entity_id == edge.target_entity_id:
                self_loops += 1
        observed_edges = sum(
            c for t, c in edge_counts.items() if EdgeType(t) not in OVERLAY_EDGE_TYPES
        )
        return {
            "node_count": len(self._nodes),
            "edge_count": len(self._edges),
            "observed_edge_count": observed_edges,
            "overlay_edge_count": len(self._edges) - observed_edges,
            "nodes_by_type": dict(sorted(node_counts.items())),
            "edges_by_type": dict(sorted(edge_counts.items())),
            "overlay_edges_by_type": dict(sorted(overlay_counts.items())),
            "self_loops": self_loops,
        }
