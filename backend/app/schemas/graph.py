"""Response schemas for the graph query API (/api/v1/graph)."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel

from app.graph.model import Edge, Node


class NodeOut(BaseModel):
    entity_id: str
    entity_type: str
    label: str
    source_dataset: Optional[str] = None
    source_record_id: Optional[str] = None
    attributes: dict[str, Any] = {}

    @classmethod
    def from_node(cls, node: Node) -> "NodeOut":
        return cls(
            entity_id=node.entity_id,
            entity_type=node.entity_type.value,
            label=node.label,
            source_dataset=node.source_dataset,
            source_record_id=node.source_record_id,
            attributes=node.attributes,
        )


class EdgeOut(BaseModel):
    relationship_id: str
    source_entity_id: str
    target_entity_id: str
    relationship_type: str
    directed: bool
    source_dataset: str
    weight: float
    weight_detail: dict[str, Any] = {}
    date_first: Optional[str] = None
    date_last: Optional[str] = None
    # Deterministic 1.0 provenance existence-confidence — NOT a model confidence.
    provenance_confidence: float
    is_overlay: bool
    attributes: dict[str, Any] = {}
    evidence_count: int
    evidence: list[str] = []

    @classmethod
    def from_edge(cls, edge: Edge, *, evidence_limit: int = 25) -> "EdgeOut":
        return cls(
            relationship_id=edge.relationship_id,
            source_entity_id=edge.source_entity_id,
            target_entity_id=edge.target_entity_id,
            relationship_type=edge.relationship_type.value,
            directed=edge.directed,
            source_dataset=edge.source_dataset,
            weight=edge.weight,
            weight_detail=edge.weight_detail,
            date_first=edge.date_first,
            date_last=edge.date_last,
            provenance_confidence=edge.provenance_confidence,
            is_overlay=edge.is_overlay,
            attributes=edge.attributes,
            evidence_count=len(edge.evidence),
            evidence=edge.evidence[:evidence_limit],
        )


class PersonDetailResponse(BaseModel):
    person: NodeOut
    relationship_counts: dict[str, int]
    neighbor_count: int
    metrics: Optional[dict[str, Any]] = None


class NetworkResponse(BaseModel):
    anchor: NodeOut
    depth: int
    persons_only: bool
    nodes: list[NodeOut]
    edges: list[EdgeOut]
    meta: dict[str, Any]


class PathHop(BaseModel):
    length: int
    nodes: list[NodeOut]
    edges: list[EdgeOut]


class PathResponse(BaseModel):
    source: str
    target: str
    found: bool
    path_count: int
    max_length: int
    paths: list[PathHop]


class SearchResponse(BaseModel):
    query: str
    count: int
    results: list[NodeOut]
