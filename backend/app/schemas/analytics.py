"""Response schemas for the analytics API (/api/v1/analytics)."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class PersonAnalyticsOut(BaseModel):
    entity_id: str
    degree: int
    degree_centrality: float
    weighted_degree: float
    betweenness: float
    pagerank: float
    community_id: Optional[int] = None
    component_id: Optional[int] = None
    # Percentile-based, neutral interpretation over the actual metric values.
    interpretation: dict[str, Any]


class TopPersonsResponse(BaseModel):
    metric: str
    projection: str
    count: int
    persons: list[PersonAnalyticsOut]
    note: str


class CommunitiesResponse(BaseModel):
    algorithm: str
    projection: str
    weight: str
    seed: int
    deterministic: bool
    community_count: int
    modularity: float
    ground_truth_overlay: dict[str, Any]
    communities: list[dict[str, Any]]
