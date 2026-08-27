"""Graph query endpoints (/api/v1/graph).

Typed nodes + evidence-backed relationships, with validated inputs and safe
expansion limits. All graph building/analytics happens in the service layer;
these handlers only translate HTTP <-> service calls.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_graph
from app.core.errors import BadRequestError, NotFoundError
from app.graph.model import NodeType, person_eid
from app.graph.service import GraphService
from app.schemas.graph import (
    EdgeOut,
    NetworkResponse,
    NodeOut,
    PathHop,
    PathResponse,
    PersonDetailResponse,
    SearchResponse,
)

router = APIRouter()


@router.get("/summary", summary="Graph node/edge counts, projections, and limits")
def graph_summary(svc: GraphService = Depends(get_graph)) -> dict:
    return svc.summary()


@router.get(
    "/persons/{person_id}",
    response_model=PersonDetailResponse,
    summary="Person node with relationship breakdown and metrics",
)
def get_person_node(
    person_id: int = Path(..., ge=1),
    svc: GraphService = Depends(get_graph),
) -> PersonDetailResponse:
    eid = person_eid(person_id)
    node = svc.store.get_node(eid)
    if node is None:
        raise NotFoundError("Person", person_id)
    counts: dict[str, int] = {}
    neighbor_ids: set[str] = set()
    for neighbor, edges in svc.store.get_neighbors(eid, include_overlay=True):
        neighbor_ids.add(neighbor.entity_id)
        for edge in edges:
            key = edge.relationship_type.value
            counts[key] = counts.get(key, 0) + 1
    return PersonDetailResponse(
        person=NodeOut.from_node(node),
        relationship_counts=dict(sorted(counts.items())),
        neighbor_count=len(neighbor_ids),
        metrics=svc.analytics.person_metrics(eid),
    )


@router.get(
    "/persons/{person_id}/network",
    response_model=NetworkResponse,
    summary="Bounded ego-network around a person (depth 1 or 2)",
)
def get_person_network(
    person_id: int = Path(..., ge=1),
    depth: int = Query(1, ge=1, description="Expansion depth (bounded by configured max)"),
    persons_only: bool = Query(False, description="Restrict to PERSON nodes / person-person edges"),
    include_overlay: bool = Query(False, description="Include SAME_RING ground-truth overlay edges"),
    max_nodes: Optional[int] = Query(None, ge=1, description="Node cap (defaults to configured max)"),
    svc: GraphService = Depends(get_graph),
) -> NetworkResponse:
    eid = person_eid(person_id)
    anchor = svc.store.get_node(eid)
    if anchor is None:
        raise NotFoundError("Person", person_id)

    if depth > svc.settings.graph_max_depth:
        raise BadRequestError(
            f"depth {depth} exceeds max allowed {svc.settings.graph_max_depth}",
            detail={"max_depth": svc.settings.graph_max_depth},
        )
    cap = svc.settings.graph_max_network_nodes
    node_cap = min(max_nodes, cap) if max_nodes is not None else cap
    node_types = [NodeType.PERSON] if persons_only else None

    nodes, edges, meta = svc.store.get_subgraph(
        eid,
        depth,
        max_nodes=node_cap,
        node_types=node_types,
        include_overlay=include_overlay,
    )
    return NetworkResponse(
        anchor=NodeOut.from_node(anchor),
        depth=depth,
        persons_only=persons_only,
        nodes=[NodeOut.from_node(n) for n in nodes],
        edges=[EdgeOut.from_edge(e) for e in edges],
        meta=meta,
    )


@router.get(
    "/relationships/{relationship_id:path}",
    response_model=EdgeOut,
    summary="One relationship by id, with evidence",
)
def get_relationship(
    relationship_id: str = Path(..., description="e.g. CALLED~person:1~person:2"),
    svc: GraphService = Depends(get_graph),
) -> EdgeOut:
    edge = svc.store.get_edge(relationship_id)
    if edge is None:
        raise NotFoundError("Relationship", relationship_id)
    return EdgeOut.from_edge(edge, evidence_limit=1000)


@router.get("/path", response_model=PathResponse, summary="Shortest path(s) between two entities")
def get_path(
    source: str = Query(..., description="Source entity id, e.g. person:1"),
    target: str = Query(..., description="Target entity id, e.g. person:2"),
    include_overlay: bool = Query(False, description="Allow SAME_RING overlay edges in paths"),
    max_length: Optional[int] = Query(None, ge=1, description="Max hops (defaults to configured max)"),
    max_paths: Optional[int] = Query(None, ge=1, description="Max paths (defaults to configured max)"),
    svc: GraphService = Depends(get_graph),
) -> PathResponse:
    if not svc.store.has_node(source):
        raise NotFoundError("Entity", source)
    if not svc.store.has_node(target):
        raise NotFoundError("Entity", target)
    if source == target:
        raise BadRequestError("source and target must differ")

    length_cap = min(max_length, svc.settings.graph_max_path_length) if max_length else svc.settings.graph_max_path_length
    paths_cap = min(max_paths, svc.settings.graph_max_paths) if max_paths else svc.settings.graph_max_paths

    raw_paths = svc.store.find_paths(
        source, target, max_length=length_cap, max_paths=paths_cap, include_overlay=include_overlay
    )
    hops: list[PathHop] = []
    for node_ids in raw_paths:
        edges = []
        for a, b in zip(node_ids, node_ids[1:]):
            edges.extend(svc.store.edges_between(a, b, include_overlay=include_overlay))
        hops.append(
            PathHop(
                length=len(node_ids) - 1,
                nodes=[NodeOut.from_node(svc.store.get_node(n)) for n in node_ids],
                edges=[EdgeOut.from_edge(e) for e in edges],
            )
        )
    return PathResponse(
        source=source,
        target=target,
        found=bool(hops),
        path_count=len(hops),
        max_length=length_cap,
        paths=hops,
    )


@router.get("/search", response_model=SearchResponse, summary="Search nodes by id or label")
def search_nodes(
    q: str = Query(..., min_length=1, description="Case-insensitive id/label query"),
    limit: Optional[int] = Query(None, ge=1, description="Result cap (defaults to configured max)"),
    svc: GraphService = Depends(get_graph),
) -> SearchResponse:
    result_cap = min(limit, svc.settings.graph_search_limit) if limit else svc.settings.graph_search_limit
    nodes = svc.search(q, result_cap)
    return SearchResponse(
        query=q, count=len(nodes), results=[NodeOut.from_node(n) for n in nodes]
    )
