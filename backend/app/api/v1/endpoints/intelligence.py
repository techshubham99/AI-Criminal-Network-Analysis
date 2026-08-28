"""Investigation intelligence endpoints (/api/v1/intelligence).

Phase 4's HTTP surface. Note what this router does *not* do: no detection, no
scoring, no thresholds, no explanation text. All of that lives in
``app.risk.*``; the handlers below only shape objects the engine already built
(spec §12).

On the naming, which matters more than it looks (spec §11):

* ``GET /api/v1/analytics/persons/top`` — Phase 2. Ranks by a **graph
  centrality metric**: who sits where in the observed network.
* ``GET /api/v1/intelligence/persons/top`` — Phase 4. Ranks by the **0-100
  investigation priority score**: whose records an analyst should open first.

They are different questions with different answers and are never merged.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_analytics, get_dataset, get_intelligence
from app.core.errors import BadRequestError, NotFoundError
from app.graph.analytics import GraphAnalytics
from app.graph.model import person_eid
from app.repositories.dataset import DatasetRepository
from app.risk.models import (
    BAND_HIGH,
    BAND_LOW,
    BAND_MEDIUM,
    EvidenceRef,
    Pattern,
    PatternType,
    PriorityScore,
)
from app.risk.service import RANKING_NOTE, IntelligenceService
from app.schemas.intelligence import (
    ExplainResponse,
    IntelligenceSummaryResponse,
    PatternListResponse,
    PatternOut,
    PersonIntelligenceResponse,
    PriorityScoreOut,
    RankedPersonOut,
    TopPersonsResponse,
)

router = APIRouter()

_BANDS = {BAND_LOW, BAND_MEDIUM, BAND_HIGH}
_PATTERN_TYPES = {p.value for p in PatternType}


# --- serialisation helpers (shape only, no logic) ---------------------------


def _evidence_out(items: list[EvidenceRef]) -> list[dict[str, Any]]:
    return [e.as_dict() for e in items]


def _pattern_out(pattern: Pattern) -> PatternOut:
    return PatternOut(
        pattern_id=pattern.pattern_id,
        pattern_type=pattern.pattern_type.value,
        entity_ids=pattern.entity_ids,
        relationship_types=pattern.relationship_types,
        source_datasets=pattern.source_datasets,
        severity=round(pattern.severity, 4),
        explanation=pattern.explanation,
        structured_evidence=_evidence_out(pattern.structured_evidence),
        nlp_evidence=_evidence_out(pattern.nlp_evidence),
        detail=pattern.detail,
    )


def _score_out(score: PriorityScore) -> PriorityScoreOut:
    return PriorityScoreOut(
        person_id=score.person_id,
        entity_id=score.entity_id,
        score=score.score,
        band=score.band,
        factors=[f.as_dict() for f in score.factors],
        pattern_ids=score.pattern_ids,
        structured_evidence=_evidence_out(score.structured_evidence),
        nlp_evidence=_evidence_out(score.nlp_evidence),
        explanation=score.explanation,
        disclaimer=score.disclaimer,
    )


def _band_boundaries(service: IntelligenceService) -> dict[str, str]:
    return service.summary()["score_bands"]["boundaries"]


# --- endpoints --------------------------------------------------------------


@router.get(
    "/summary",
    response_model=IntelligenceSummaryResponse,
    summary="Phase 4 detection and scoring summary (explainable, honest about zeros)",
)
def intelligence_summary(
    service: IntelligenceService = Depends(get_intelligence),
) -> IntelligenceSummaryResponse:
    """Corpus-level Phase 4 results, including categories that found nothing."""
    return IntelligenceSummaryResponse(**service.summary())


@router.get(
    "/persons/top",
    response_model=TopPersonsResponse,
    summary="Top persons by investigation priority score (NOT the graph centrality ranking)",
)
def top_persons_by_priority(
    limit: Optional[int] = Query(
        None, ge=1, description="Number of persons to return"
    ),
    band: Optional[str] = Query(
        None, description="Filter to one band: LOW, MEDIUM or HIGH"
    ),
    min_score: int = Query(0, ge=0, le=100, description="Minimum score to include"),
    service: IntelligenceService = Depends(get_intelligence),
    repo: DatasetRepository = Depends(get_dataset),
) -> TopPersonsResponse:
    settings = service.settings
    resolved = limit or settings.intel_default_top
    if resolved > settings.intel_max_top:
        raise BadRequestError(
            f"limit must not exceed {settings.intel_max_top}",
            detail={"limit": resolved, "max": settings.intel_max_top},
        )
    normalised: Optional[str] = None
    if band is not None:
        normalised = band.strip().upper()
        if normalised not in _BANDS:
            raise BadRequestError(
                "Unknown band", detail={"band": band, "allowed": sorted(_BANDS)}
            )

    scores = service.top_persons(resolved, band=normalised, min_score=min_score)
    rows: list[RankedPersonOut] = []
    for score in scores:
        person = repo.get_person(score.person_id) or {}
        # The two or three factors that actually moved the number, so the row is
        # readable without opening /explain.
        top_factors = sorted(
            (f for f in score.factors if f.contribution > 0),
            key=lambda f: (-f.contribution, f.feature),
        )[:3]
        rows.append(
            RankedPersonOut(
                person_id=score.person_id,
                entity_id=score.entity_id,
                name=person.get("name"),
                city=person.get("city"),
                state=person.get("state"),
                score=score.score,
                band=score.band,
                top_factors=[f.as_dict() for f in top_factors],
                pattern_count=len(score.pattern_ids),
                structured_evidence_count=len(score.structured_evidence),
                nlp_evidence_count=len(score.nlp_evidence),
                explanation=score.explanation,
            )
        )
    return TopPersonsResponse(
        count=len(rows),
        limit=resolved,
        band=normalised,
        persons=rows,
        band_boundaries=_band_boundaries(service),
        note=RANKING_NOTE,
        disclaimer=scores[0].disclaimer if scores else "",
    )


@router.get(
    "/persons/{person_id}",
    response_model=PersonIntelligenceResponse,
    summary="One person's priority score, patterns and evidence",
)
def person_intelligence(
    person_id: int = Path(..., ge=1, description="Numeric person row id"),
    service: IntelligenceService = Depends(get_intelligence),
    repo: DatasetRepository = Depends(get_dataset),
    analytics: GraphAnalytics = Depends(get_analytics),
) -> PersonIntelligenceResponse:
    person = repo.get_person(person_id)
    if person is None:
        raise NotFoundError("Person", person_id)
    score = service.score_for(person_id)
    return PersonIntelligenceResponse(
        person=dict(person),
        priority=_score_out(score),
        patterns=[_pattern_out(p) for p in service.patterns_for_person(person_id)],
        communication_baseline=service.anomaly_report(person_id),
        network_position=analytics.person_metrics(person_eid(person_id)),
        disclaimer=score.disclaimer,
    )


@router.get(
    "/persons/{person_id}/explain",
    response_model=ExplainResponse,
    summary="Line-by-line derivation of one person's priority score",
)
def explain_person(
    person_id: int = Path(..., ge=1, description="Numeric person row id"),
    service: IntelligenceService = Depends(get_intelligence),
    repo: DatasetRepository = Depends(get_dataset),
) -> ExplainResponse:
    if repo.get_person(person_id) is None:
        raise NotFoundError("Person", person_id)
    return ExplainResponse(**service.explain_person(person_id))


@router.get(
    "/patterns",
    response_model=PatternListResponse,
    summary="Detected patterns, filterable by type and involved entity",
)
def list_patterns(
    pattern_type: Optional[str] = Query(
        None, description="Filter to one pattern type (see /summary for the list)"
    ),
    entity_id: Optional[str] = Query(
        None, description="Filter to patterns involving a prefixed entity id"
    ),
    limit: Optional[int] = Query(None, ge=1, description="Page size"),
    offset: int = Query(0, ge=0, description="Number of patterns to skip"),
    service: IntelligenceService = Depends(get_intelligence),
) -> PatternListResponse:
    settings = service.settings
    resolved = limit or settings.intel_patterns_limit
    if resolved > settings.intel_patterns_max_limit:
        raise BadRequestError(
            f"limit must not exceed {settings.intel_patterns_max_limit}",
            detail={"limit": resolved, "max": settings.intel_patterns_max_limit},
        )
    ptype: Optional[PatternType] = None
    if pattern_type is not None:
        normalised = pattern_type.strip().upper()
        if normalised not in _PATTERN_TYPES:
            raise BadRequestError(
                "Unknown pattern_type",
                detail={"pattern_type": pattern_type, "allowed": sorted(_PATTERN_TYPES)},
            )
        ptype = PatternType(normalised)

    patterns, total = service.list_patterns(
        pattern_type=ptype, entity_id=entity_id, limit=resolved, offset=offset
    )
    return PatternListResponse(
        total=total,
        count=len(patterns),
        offset=offset,
        limit=resolved,
        patterns=[_pattern_out(p) for p in patterns],
        filters={"pattern_type": ptype.value if ptype else None, "entity_id": entity_id},
        note=(
            "Pattern ids are content-addressed (sha256 of pattern type + sorted "
            "entity ids + sorted evidence ids) and therefore stable across "
            "restarts. A category with zero detections is reported as zero in "
            "/summary rather than filled with an example."
        ),
    )


@router.get(
    "/patterns/{pattern_id}",
    response_model=PatternOut,
    summary="One detected pattern with its full evidence trail",
)
def get_pattern(
    pattern_id: str = Path(..., min_length=1, description="Deterministic pattern id"),
    service: IntelligenceService = Depends(get_intelligence),
) -> PatternOut:
    return _pattern_out(service.pattern_for(pattern_id))
