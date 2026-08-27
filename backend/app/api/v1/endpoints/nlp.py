"""Phase 3 narrative NLP endpoints (/api/v1/nlp).

These handlers only translate HTTP <-> :class:`app.nlp.service.NlpService` calls.
All extraction, normalization, resolution, relationship extraction, and graph
integration logic lives in ``app.nlp`` (spec §1) — nothing here inspects text.

Contract notes:
* Unknown ``fir_id`` -> 404 with the standard error envelope.
* A FIR with no narrative (or no extractable entity) is a 200 with empty lists
  plus the counts and ``absent_entity_types`` that explain the emptiness — not an
  error and not a silent blank.
* Output is deterministic: the service analyses FIRs in ascending id order and
  every stage is rule-based.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_nlp
from app.core.errors import NotFoundError
from app.graph.model import source_record_id
from app.nlp.models import ResolutionStatus
from app.nlp.service import NlpService
from app.schemas.common import build_meta
from app.schemas.nlp import (
    FirEntitiesResponse,
    FirRelationshipsResponse,
    GraphAdditionOut,
    GraphImpactResponse,
    NarrativeEdgeOut,
    NlpSearchResponse,
    RelationshipOut,
    ResolvedEntityOut,
    SearchHitOut,
)

router = APIRouter()

_RELATIONSHIP_NOTE = (
    "Narrative relationships are asserted by FIR text only. Each requires an "
    "explicit trigger phrase plus role-bound endpoints — two people appearing in "
    "the same FIR is never sufficient. They are stored in a separate narrative "
    "graph and never added to the structured Phase 2 graph."
)


def _require_analysis(fir_id: int, svc: NlpService):
    analysis = svc.get_analysis(fir_id)
    if analysis is None:
        raise NotFoundError("FIR", fir_id)
    return analysis


@router.get(
    "/summary",
    summary="NLP layer counts, confidence semantics, and honest evaluation",
)
def nlp_summary(svc: NlpService = Depends(get_nlp)) -> dict:
    return svc.summary()


@router.get(
    "/firs/{fir_id}/entities",
    response_model=FirEntitiesResponse,
    summary="Entities extracted from one FIR narrative, with spans and resolution",
)
def fir_entities(
    fir_id: int = Path(..., ge=1),
    svc: NlpService = Depends(get_nlp),
) -> FirEntitiesResponse:
    analysis = _require_analysis(fir_id, svc)
    report = svc.entity_report(analysis)
    return FirEntitiesResponse(
        fir_id=analysis.fir_id,
        narrative=analysis.narrative,
        source_record_id=source_record_id("firs", analysis.fir_id),
        entity_count=len(analysis.resolved_entities),
        counts_by_type=report["counts_by_type"],
        resolution_counts=report["resolution_counts"],
        entities=[ResolvedEntityOut.from_resolved(r) for r in analysis.resolved_entities],
        absent_entity_types=report["absent_entity_types"],
    )


@router.get(
    "/firs/{fir_id}/relationships",
    response_model=FirRelationshipsResponse,
    summary="Validated narrative relationships extracted from one FIR",
)
def fir_relationships(
    fir_id: int = Path(..., ge=1),
    svc: NlpService = Depends(get_nlp),
) -> FirRelationshipsResponse:
    analysis = _require_analysis(fir_id, svc)
    report = svc.relationship_report(analysis)
    return FirRelationshipsResponse(
        fir_id=analysis.fir_id,
        narrative=analysis.narrative,
        source_record_id=source_record_id("firs", analysis.fir_id),
        relationship_count=len(analysis.relationships),
        counts_by_type=report["counts_by_type"],
        relationships=[
            RelationshipOut.from_relationship(r) for r in analysis.relationships
        ],
        note=_RELATIONSHIP_NOTE,
    )


@router.get(
    "/search",
    response_model=NlpSearchResponse,
    summary="Search extracted narrative entities (raw text, normalized value, or entity id)",
)
def nlp_search(
    q: str = Query(..., min_length=1, max_length=200, description="Search text"),
    page: int = Query(1, ge=1, description="1-based page number"),
    page_size: Optional[int] = Query(
        None, ge=1, description="Items per page (defaults to the configured NLP limit)"
    ),
    svc: NlpService = Depends(get_nlp),
) -> NlpSearchResponse:
    size = page_size or svc.settings.nlp_search_limit
    size = min(size, svc.settings.nlp_search_max_limit)
    result = svc.search(q, offset=(page - 1) * size, limit=size)
    return NlpSearchResponse(
        query=q,
        counts_by_type=result.counts_by_type,
        matched_fir_count=result.matched_fir_count,
        items=[SearchHitOut.from_hit(h) for h in result.items],
        meta=build_meta(page, size, result.total),
    )


@router.get(
    "/firs/{fir_id}/graph-impact",
    response_model=GraphImpactResponse,
    summary="What this FIR's narrative proposed, what was accepted, and what was rejected + why",
)
def fir_graph_impact(
    fir_id: int = Path(..., ge=1),
    svc: NlpService = Depends(get_nlp),
) -> GraphImpactResponse:
    analysis = _require_analysis(fir_id, svc)
    additions = [GraphAdditionOut.from_addition(g) for g in analysis.graph_additions]
    return GraphImpactResponse(
        fir_id=analysis.fir_id,
        narrative=analysis.narrative,
        source_record_id=source_record_id("firs", analysis.fir_id),
        summary=svc.graph_impact(analysis),
        extracted_entities=[
            ResolvedEntityOut.from_resolved(r) for r in analysis.resolved_entities
        ],
        resolved_entities=[
            ResolvedEntityOut.from_resolved(r)
            for r in analysis.resolved_entities
            if r.resolution.status is ResolutionStatus.RESOLVED
        ],
        unresolved_entities=[
            ResolvedEntityOut.from_resolved(r)
            for r in analysis.resolved_entities
            if r.resolution.status
            in (ResolutionStatus.UNRESOLVED, ResolutionStatus.AMBIGUOUS)
        ],
        not_applicable_entities=[
            ResolvedEntityOut.from_resolved(r)
            for r in analysis.resolved_entities
            if r.resolution.status is ResolutionStatus.NOT_APPLICABLE
        ],
        validated_relationships=[
            RelationshipOut.from_relationship(r) for r in analysis.relationships
        ],
        proposed_additions=additions,
        accepted_additions=[a for a in additions if a.accepted],
        rejected_additions=[a for a in additions if not a.accepted],
        narrative_edges=[
            NarrativeEdgeOut.from_edge(e) for e in svc.narrative_edges_for(analysis)
        ],
        structured_graph_mutated=False,
    )
