"""Response schemas for the Phase 3 narrative NLP API (/api/v1/nlp).

Every extracted item carries its provenance: the source record id, the character
span it was read from, the enclosing sentence as ``evidence_text``, the rule that
found it (``extraction_method``), and a deterministic rule-assigned
``confidence``. Narrative edges are exposed through a dedicated
:class:`NarrativeEdgeOut` (not the Phase 2 ``EdgeOut``) so structured-observed and
narrative-derived intelligence can never be confused in a client.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel

from app.graph.model import Edge
from app.nlp.models import (
    EntityResolution,
    ExtractedEntity,
    GraphAddition,
    NarrativeRelationship,
    ResolvedEntity,
)
from app.nlp.service import SearchHit
from app.schemas.common import PageMeta


class EntityOut(BaseModel):
    """One extracted entity mention (spec §2: every listed field is present)."""

    entity_type: str
    raw_text: str
    normalized_value: str
    confidence: float
    fir_id: int
    character_start: int
    character_end: int
    extraction_method: str
    evidence_text: str
    # Template role the mention was captured under, when the anchor carried one.
    role: Optional[str] = None

    @classmethod
    def from_entity(cls, e: ExtractedEntity) -> "EntityOut":
        return cls(
            entity_type=e.entity_type.value,
            raw_text=e.raw_text,
            normalized_value=e.normalized_value,
            confidence=e.confidence,
            fir_id=e.fir_id,
            character_start=e.character_start,
            character_end=e.character_end,
            extraction_method=e.extraction_method.value,
            evidence_text=e.evidence_text,
            role=e.role,
        )


class ResolutionOut(BaseModel):
    """How (or why not) a mention was linked to an existing entity (spec §5)."""

    status: str
    matched_entity_id: Optional[str] = None
    resolution_method: Optional[str] = None
    confidence: Optional[float] = None
    evidence: list[str] = []
    ambiguous: bool = False
    candidates: list[str] = []
    reason: Optional[str] = None

    @classmethod
    def from_resolution(cls, r: EntityResolution) -> "ResolutionOut":
        return cls(
            status=r.status.value,
            matched_entity_id=r.matched_entity_id,
            resolution_method=r.resolution_method,
            confidence=r.confidence,
            evidence=list(r.evidence),
            ambiguous=r.ambiguous,
            candidates=list(r.candidates),
            reason=r.reason,
        )


class ResolvedEntityOut(BaseModel):
    entity: EntityOut
    resolution: ResolutionOut

    @classmethod
    def from_resolved(cls, r: ResolvedEntity) -> "ResolvedEntityOut":
        return cls(
            entity=EntityOut.from_entity(r.entity),
            resolution=ResolutionOut.from_resolution(r.resolution),
        )


class RelationshipOut(BaseModel):
    """A narrative-asserted relationship (spec §6), with full provenance."""

    relationship_type: str
    fir_id: int
    directed: bool
    source_entity_id: Optional[str] = None
    target_entity_id: Optional[str] = None
    source_mention: str
    target_mention: str
    source_resolved: bool
    target_resolved: bool
    confidence: float
    evidence_text: str
    character_start: int
    character_end: int
    extraction_method: str
    source_dataset: str
    source_record_id: str
    attributes: dict[str, Any] = {}

    @classmethod
    def from_relationship(cls, r: NarrativeRelationship) -> "RelationshipOut":
        return cls(
            relationship_type=r.relationship_type.value,
            fir_id=r.fir_id,
            directed=r.directed,
            source_entity_id=r.source_entity_id,
            target_entity_id=r.target_entity_id,
            source_mention=r.source_mention,
            target_mention=r.target_mention,
            source_resolved=r.source_resolved,
            target_resolved=r.target_resolved,
            confidence=r.confidence,
            evidence_text=r.evidence_text,
            character_start=r.character_start,
            character_end=r.character_end,
            extraction_method=r.extraction_method,
            source_dataset=r.source_dataset,
            source_record_id=r.source_record_id,
            attributes=dict(r.attributes),
        )


class NarrativeEdgeOut(BaseModel):
    """An edge in the SEPARATE narrative graph.

    ``is_narrative`` is always ``True`` and ``source_dataset`` always ``fir_text``:
    this is how a client tells narrative-derived from structured-observed
    intelligence. ``provenance_confidence`` here is the deterministic rule
    confidence of the narrative assertion, not an existence certainty.
    """

    relationship_id: str
    source_entity_id: str
    target_entity_id: str
    relationship_type: str
    directed: bool
    source_dataset: str
    is_narrative: bool
    is_overlay: bool
    provenance_confidence: float
    weight: float
    date_first: Optional[str] = None
    date_last: Optional[str] = None
    evidence: list[str] = []
    attributes: dict[str, Any] = {}

    @classmethod
    def from_edge(cls, edge: Edge) -> "NarrativeEdgeOut":
        return cls(
            relationship_id=edge.relationship_id,
            source_entity_id=edge.source_entity_id,
            target_entity_id=edge.target_entity_id,
            relationship_type=edge.relationship_type.value,
            directed=edge.directed,
            source_dataset=edge.source_dataset,
            is_narrative=edge.is_narrative,
            is_overlay=edge.is_overlay,
            provenance_confidence=edge.provenance_confidence,
            weight=edge.weight,
            date_first=edge.date_first,
            date_last=edge.date_last,
            evidence=list(edge.evidence),
            attributes=dict(edge.attributes),
        )


class GraphAdditionOut(BaseModel):
    """One proposed narrative edge and its disposition, with the reason (spec §7,§8)."""

    status: str
    accepted: bool
    reason: str
    relationship_id: Optional[str] = None
    duplicate_of: Optional[str] = None
    detail: dict[str, Any] = {}
    relationship: RelationshipOut

    @classmethod
    def from_addition(cls, g: GraphAddition) -> "GraphAdditionOut":
        return cls(
            status=g.status.value,
            accepted=g.accepted,
            reason=g.reason,
            relationship_id=g.relationship_id,
            duplicate_of=g.duplicate_of,
            detail=dict(g.detail),
            relationship=RelationshipOut.from_relationship(g.relationship),
        )


class FirEntitiesResponse(BaseModel):
    fir_id: int
    narrative: str
    source_record_id: str
    entity_count: int
    counts_by_type: dict[str, int]
    resolution_counts: dict[str, int]
    entities: list[ResolvedEntityOut]
    # Entity types the extractor supports but did not find in this narrative.
    absent_entity_types: list[str]


class FirRelationshipsResponse(BaseModel):
    fir_id: int
    narrative: str
    source_record_id: str
    relationship_count: int
    counts_by_type: dict[str, int]
    relationships: list[RelationshipOut]
    note: str


class GraphImpactResponse(BaseModel):
    fir_id: int
    narrative: str
    source_record_id: str
    summary: dict[str, Any]
    extracted_entities: list[ResolvedEntityOut]
    resolved_entities: list[ResolvedEntityOut]
    # UNRESOLVED or AMBIGUOUS: a graph target exists in principle but was not
    # confidently identified. Ambiguous people are never silently merged.
    unresolved_entities: list[ResolvedEntityOut]
    # NOT_APPLICABLE: the type has no materialised node to link to (e.g. DATE).
    not_applicable_entities: list[ResolvedEntityOut]
    validated_relationships: list[RelationshipOut]
    proposed_additions: list[GraphAdditionOut]
    accepted_additions: list[GraphAdditionOut]
    rejected_additions: list[GraphAdditionOut]
    narrative_edges: list[NarrativeEdgeOut]
    structured_graph_mutated: bool


class SearchHitOut(BaseModel):
    fir_id: int
    source_record_id: str
    matched_field: str
    entity: EntityOut
    resolution: ResolutionOut

    @classmethod
    def from_hit(cls, hit: SearchHit) -> "SearchHitOut":
        return cls(
            fir_id=hit.fir_id,
            source_record_id=f"firs:{hit.fir_id}",
            matched_field=hit.matched_field,
            entity=EntityOut.from_entity(hit.resolved.entity),
            resolution=ResolutionOut.from_resolution(hit.resolved.resolution),
        )


class NlpSearchResponse(BaseModel):
    query: str
    counts_by_type: dict[str, int]
    matched_fir_count: int
    items: list[SearchHitOut]
    meta: PageMeta
    searched_fields: list[str] = ["raw_text", "normalized_value", "matched_entity_id"]
