"""Response schemas for the Phase 4 intelligence endpoints.

Two shapes are deliberate and load-bearing:

* ``structured_evidence`` and ``nlp_evidence`` are separate lists on every
  pattern and every score. There is no field anywhere in this module that
  merges them, because §7 forbids collapsing evidence tiers into one
  unexplained number.
* ``value`` and ``contribution`` are separate fields on every score factor, so
  a client can check ``value * max_contribution == contribution`` itself.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class EvidenceOut(BaseModel):
    evidence_id: str = Field(..., description="Stable de-duplication key")
    evidence_class: str = Field(
        ..., description="STRUCTURED (observed record) or NLP_DERIVED (text extraction)"
    )
    source_dataset: str
    source_record_id: str = Field(..., description='"{table}:{pk}" citation')
    confidence: float = Field(
        ...,
        description=(
            "This evidence item's own confidence tier: 1.0 for a structured "
            "record, the Phase 3 extraction confidence for a narrative claim. "
            "Never averaged with other tiers."
        ),
    )
    confidence_basis: str
    evidence_text: Optional[str] = None


class PatternOut(BaseModel):
    pattern_id: str = Field(
        ...,
        description=(
            "Deterministic id: sha256 of pattern type + sorted entity ids + "
            "sorted evidence ids. Stable across restarts and rebuilds."
        ),
    )
    pattern_type: str
    entity_ids: list[str]
    relationship_types: list[str]
    source_datasets: list[str]
    severity: float = Field(
        ...,
        description=(
            "0-1 deterministic strength used by scoring. Not a probability and "
            "not a likelihood of wrongdoing."
        ),
    )
    explanation: str
    structured_evidence: list[EvidenceOut]
    nlp_evidence: list[EvidenceOut]
    detail: dict[str, Any] = Field(default_factory=dict)


class PatternListResponse(BaseModel):
    total: int
    count: int
    offset: int
    limit: int
    patterns: list[PatternOut]
    filters: dict[str, Any] = Field(default_factory=dict)
    note: str


class ScoreFactorOut(BaseModel):
    feature: str
    value: float = Field(..., description="Normalised 0-1 feature value")
    max_contribution: float = Field(..., description="Configured weight cap")
    contribution: float = Field(..., description="value * max_contribution, 2dp")
    pattern_ids: list[str]
    evidence_ids: list[str]
    explanation: str
    detail: dict[str, Any] = Field(default_factory=dict)


class PriorityScoreOut(BaseModel):
    person_id: int
    entity_id: str
    score: int = Field(..., ge=0, le=100)
    band: str = Field(..., description="LOW 0-39 | MEDIUM 40-69 | HIGH 70-100")
    factors: list[ScoreFactorOut]
    pattern_ids: list[str]
    structured_evidence: list[EvidenceOut]
    nlp_evidence: list[EvidenceOut]
    explanation: str
    disclaimer: str


class RankedPersonOut(BaseModel):
    """One row of the priority ranking — the score plus enough to act on it."""

    person_id: int
    entity_id: str
    name: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    score: int = Field(..., ge=0, le=100)
    band: str
    top_factors: list[ScoreFactorOut]
    pattern_count: int
    structured_evidence_count: int
    nlp_evidence_count: int
    explanation: str


class TopPersonsResponse(BaseModel):
    count: int
    limit: int
    band: Optional[str] = None
    persons: list[RankedPersonOut]
    band_boundaries: dict[str, str]
    note: str
    disclaimer: str


class PersonIntelligenceResponse(BaseModel):
    person: dict[str, Any] = Field(
        ..., description="The person's own structured record (Phase 1 row)"
    )
    priority: PriorityScoreOut
    patterns: list[PatternOut]
    communication_baseline: Optional[dict[str, Any]] = Field(
        None,
        description=(
            "The person's own daily-call baseline, including the honest "
            "'insufficient baseline data' case."
        ),
    )
    network_position: Optional[dict[str, Any]] = Field(
        None, description="Phase 2 analytics metrics, unchanged by Phase 4"
    )
    disclaimer: str


class ExplainResponse(BaseModel):
    person_id: int
    entity_id: str
    score: int
    band: str
    sum_of_contributions: float
    rounding: str
    band_meaning: str
    factor_walkthrough: list[dict[str, Any]]
    structured_evidence: list[EvidenceOut]
    nlp_evidence: list[EvidenceOut]
    evidence_separation_note: str
    explanation: str
    disclaimer: str


class IntelligenceSummaryResponse(BaseModel):
    phase: str
    persons_scored: int
    patterns_detected: int
    duplicate_pattern_ids_collapsed: int
    patterns_by_type: dict[str, int]
    zero_result_categories: list[dict[str, str]]
    score_bands: dict[str, Any]
    score_stats: dict[str, Any]
    feature_weights: dict[str, float]
    feature_weight_total: float
    detection_coverage: dict[str, Any]
    evidence_policy: dict[str, str]
    self_reference_policy: str
    overlay_policy: str
    structured_graph_mutated: bool
    ranking_note: str
    disclaimer: str
