"""Analytics endpoints (/api/v1/analytics).

Explainable network-analysis results. Every person response carries the raw
metric values plus a percentile-based, neutral interpretation — no metric is
used to label a person a criminal, and no interpretation is fabricated beyond
the actual numbers.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_graph
from app.core.errors import BadRequestError, NotFoundError
from app.graph.model import person_eid
from app.graph.service import GraphService
from app.schemas.analytics import (
    CommunitiesResponse,
    PersonAnalyticsOut,
    TopPersonsResponse,
)

router = APIRouter()

_METRICS = {"degree", "weighted_degree", "betweenness", "pagerank"}
_METRIC_PROJECTION = {
    "degree": "undirected_weighted_person_graph",
    "weighted_degree": "undirected_weighted_person_graph",
    "betweenness": "undirected_person_graph (unweighted)",
    "pagerank": "directed_weighted_person_graph",
}


@router.get(
    "/persons/top",
    response_model=TopPersonsResponse,
    summary="Top persons by a centrality metric (explainable)",
)
def top_persons(
    metric: str = Query("pagerank", description=f"One of: {sorted(_METRICS)}"),
    limit: Optional[int] = Query(None, ge=1, description="Defaults to configured default"),
    svc: GraphService = Depends(get_graph),
) -> TopPersonsResponse:
    if metric not in _METRICS:
        raise BadRequestError(
            f"Unknown metric '{metric}'", detail={"allowed": sorted(_METRICS)}
        )
    default = svc.settings.analytics_default_top
    cap = svc.settings.analytics_max_top
    n = min(limit or default, cap)
    persons = svc.analytics.top_persons(metric, n)
    return TopPersonsResponse(
        metric=metric,
        projection=_METRIC_PROJECTION[metric],
        count=len(persons),
        persons=[PersonAnalyticsOut(**p) for p in persons],
        note=(
            "Ranks reflect structural position in the observed data only. High "
            "rank indicates network importance / an investigation lead, NOT guilt."
        ),
    )


@router.get(
    "/communities",
    response_model=CommunitiesResponse,
    summary="Louvain communities beside the ground-truth ring overlay",
)
def communities(
    min_size: int = Query(1, ge=1, description="Only report communities of at least this size"),
    svc: GraphService = Depends(get_graph),
) -> CommunitiesResponse:
    return CommunitiesResponse(**svc.analytics.communities_summary(min_size=min_size))


@router.get(
    "/demo",
    summary="Deterministic demo investigation (real relationships only)",
)
def demo_investigation(svc: GraphService = Depends(get_graph)) -> dict:
    return svc.demo()


@router.get(
    "/persons/{person_id}",
    response_model=PersonAnalyticsOut,
    summary="Explainable metrics for one person",
)
def person_analytics(
    person_id: int = Path(..., ge=1),
    svc: GraphService = Depends(get_graph),
) -> PersonAnalyticsOut:
    eid = person_eid(person_id)
    metrics = svc.analytics.person_metrics(eid)
    if metrics is None:
        raise NotFoundError("Person", person_id)
    return PersonAnalyticsOut(**metrics)
