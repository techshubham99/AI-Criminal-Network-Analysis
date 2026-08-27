"""Phase 3 — FIR narrative NLP intelligence.

A deterministic, offline, rules-first NLP layer over the FIR ``narrative`` column.
It extracts entity mentions, normalizes them, resolves them against the existing
structured records, extracts explicitly-stated relationships, and integrates only
validated narrative intelligence into a SEPARATE narrative graph — the Phase 2
structured graph is never mutated.

Stage order (each stage is one module, with no NLP logic in the API routers):

``extractor`` → ``normalizer`` → ``validators`` → ``resolver``
→ ``relation_extractor`` → ``integration`` → ``service``

Nothing here calls an external model API or requires a downloaded model. spaCy is
optional and unused by default; see :func:`app.nlp.extractor.spacy_available`.
"""
from app.nlp.models import (
    EntityResolution,
    EntityType,
    ExtractedEntity,
    ExtractionMethod,
    FirAnalysis,
    GraphAddition,
    GraphAdditionStatus,
    NarrativeRelationship,
    ResolutionStatus,
    ResolvedEntity,
)
from app.nlp.service import NlpService, build_nlp_service

__all__ = [
    "EntityResolution",
    "EntityType",
    "ExtractedEntity",
    "ExtractionMethod",
    "FirAnalysis",
    "GraphAddition",
    "GraphAdditionStatus",
    "NarrativeRelationship",
    "NlpService",
    "ResolutionStatus",
    "ResolvedEntity",
    "build_nlp_service",
]
