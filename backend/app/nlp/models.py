"""Phase 3 NLP domain model: enums, records, and confidence tiers.

This is the single source of truth for *what the NLP layer produces*. It is kept
free of any extraction/resolution logic (that lives in the sibling modules) so
the shapes can be imported everywhere without pulling in behaviour.

Design commitments (Phase 3 spec):
* Every extracted entity keeps its ORIGINAL ``raw_text`` alongside the
  ``normalized_value`` — normalization never loses the source substring.
* Confidence values are DETERMINISTIC, rule-assigned tiers (see the ``CONF_*``
  constants). They are NOT learned probabilities and NOT a claim of empirical
  accuracy on real-world text — the synthetic FIRs are templated (see
  ``docs/phase3_nlp.md`` §confidence-semantics).
* Ambiguous person resolutions are NEVER silently merged: they are surfaced as
  ``AMBIGUOUS`` with the candidate ids, and ``matched_entity_id`` stays ``None``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from app.graph.model import NarrativeEdgeType

# --- confidence tiers (deterministic, rule-assigned; NOT learned) -----------
# Documented in docs/phase3_nlp.md. Centralised here so every module and the
# evaluation report reference the same explainable numbers.
CONF_REGEX_STRUCTURED = 1.0    # phone / aadhaar / date / money matched a strict format
CONF_KNOWN_RECORD = 1.0        # PERSON/LOCATION mention equals a known structured record
CONF_ANCHORED_ONLY = 0.6       # located by a template anchor but NOT found in known records
CONF_REL_EXPLICIT = 1.0        # relationship stated by an explicit trigger verb/phrase
CONF_REL_HEDGED = 0.9          # explicit but linguistically hedged ("known to associate with")
CONF_REL_SOFT_PLACEMENT = 0.7  # placement stated softly ("was seen near the scene")

# Resolution tiers (spec §5 priority ladder). Separate from the extraction tiers
# above: these score *which structured record a mention refers to*, not whether
# the mention was correctly located in the text.
CONF_RES_IDENTIFIER = 1.0    # unique structured identifier (phone / aadhaar) matched
CONF_RES_UNIQUE_NAME = 1.0   # normalized value matches exactly ONE structured record
CONF_RES_FIR_CONTEXT = 0.9   # several records matched; disambiguated by the FIR's own
                             # foreign keys (structural corroboration, not text evidence)


class EntityType(str, Enum):
    """Entity types the extractor supports (Phase 3 spec §2)."""

    PERSON = "PERSON"
    PHONE = "PHONE"
    AADHAAR = "AADHAAR"
    LOCATION = "LOCATION"
    DATE = "DATE"
    MONEY = "MONEY"
    VEHICLE = "VEHICLE"            # only emitted if explicitly present in text
    ORGANIZATION = "ORGANIZATION"  # only emitted if explicitly present in text


class ExtractionMethod(str, Enum):
    """How an entity mention was located (all deterministic, rules-first)."""

    REGEX = "regex"                     # strict structured pattern (phone/aadhaar/date/money/vehicle)
    KNOWN_RECORD = "known_record"       # text equals a known structured record (gazetteer)
    ANCHORED_PATTERN = "anchored_pattern"  # located by a template anchor, not (yet) a known record


class ResolutionStatus(str, Enum):
    RESOLVED = "resolved"
    AMBIGUOUS = "ambiguous"          # >1 candidate; never silently merged
    UNRESOLVED = "unresolved"        # below threshold / no confident match
    NOT_APPLICABLE = "not_applicable"  # entity type has no resolvable graph target (e.g. DATE)


class GraphAdditionStatus(str, Enum):
    """Disposition of a proposed narrative edge against the structured graph."""

    ACCEPTED_NEW = "accepted_new"              # new edge AND new connectivity
    ACCEPTED_ADDITIVE = "accepted_additive"    # new edge type, endpoints already linked
    ACCEPTED_MERGED = "accepted_merged"        # edge existed; this FIR added new provenance
    REJECTED_DUPLICATE = "rejected_duplicate"  # duplicates an existing edge, no new provenance
    REJECTED_SELF_LOOP = "rejected_self_loop"  # source == target
    REJECTED_UNRESOLVED = "rejected_unresolved"  # an endpoint could not be resolved
    REJECTED_LOW_CONFIDENCE = "rejected_low_confidence"


# --- records ----------------------------------------------------------------
@dataclass(frozen=True)
class ExtractedEntity:
    """A single entity mention located in one FIR narrative (spec §2).

    Contains every spec-required field. ``character_start``/``character_end`` are
    0-based indices into the narrative string (end exclusive), so
    ``narrative[character_start:character_end] == raw_text``.
    """

    entity_type: EntityType
    raw_text: str
    normalized_value: str
    confidence: float
    fir_id: int
    character_start: int
    character_end: int
    extraction_method: ExtractionMethod
    evidence_text: str
    # Non-spec provenance hint: role in the template ("complainant"/"accused")
    # when the mention was captured by a role-bearing anchor. Used by relation
    # extraction; never a substitute for resolution.
    role: Optional[str] = None


@dataclass(frozen=True)
class EntityResolution:
    """Result of resolving one extracted entity against structured records (spec §5)."""

    status: ResolutionStatus
    matched_entity_id: Optional[str] = None     # graph node id, e.g. "person:21"
    resolution_method: Optional[str] = None     # "structured_identifier" | "normalized_name" | ...
    confidence: Optional[float] = None
    evidence: list[str] = field(default_factory=list)  # source_record_ids corroborating the match
    ambiguous: bool = False
    candidates: list[str] = field(default_factory=list)  # candidate node ids when ambiguous
    reason: Optional[str] = None                 # why unresolved/ambiguous/not-applicable


@dataclass(frozen=True)
class ResolvedEntity:
    """An extracted entity bundled with its resolution (convenience for output)."""

    entity: ExtractedEntity
    resolution: EntityResolution


@dataclass(frozen=True)
class NarrativeRelationship:
    """A relationship asserted by narrative text (spec §6).

    Endpoints are resolved graph node ids when available; ``source_resolved`` /
    ``target_resolved`` flag whether each end resolved. Provenance is explicit:
    ``source_dataset='fir_text'`` and ``source_record_id='firs:{fir_id}'``.
    """

    relationship_type: NarrativeEdgeType
    fir_id: int
    directed: bool
    # Resolved graph node ids (None if that endpoint did not resolve).
    source_entity_id: Optional[str]
    target_entity_id: Optional[str]
    # The raw mentions the endpoints were read from (for traceability).
    source_mention: str
    target_mention: str
    confidence: float
    evidence_text: str
    character_start: int
    character_end: int
    extraction_method: str          # "rule:<name>"
    source_dataset: str = "fir_text"
    source_record_id: str = ""       # "firs:{fir_id}"
    attributes: dict[str, Any] = field(default_factory=dict)

    @property
    def source_resolved(self) -> bool:
        return self.source_entity_id is not None

    @property
    def target_resolved(self) -> bool:
        return self.target_entity_id is not None


@dataclass(frozen=True)
class GraphAddition:
    """A proposed narrative edge together with its accept/reject disposition (spec §7,§8)."""

    relationship: NarrativeRelationship
    status: GraphAdditionStatus
    reason: str
    # When rejected as a duplicate, the id of the edge it duplicates.
    duplicate_of: Optional[str] = None
    # The narrative edge's relationship id (set only when accepted/materialised).
    relationship_id: Optional[str] = None
    # Machine-readable decision detail (hop distance, matched structured type, …).
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def accepted(self) -> bool:
        return self.status in (
            GraphAdditionStatus.ACCEPTED_NEW,
            GraphAdditionStatus.ACCEPTED_ADDITIVE,
            GraphAdditionStatus.ACCEPTED_MERGED,
        )


@dataclass(frozen=True)
class FirAnalysis:
    """The complete NLP analysis of one FIR (cached per fir_id)."""

    fir_id: int
    narrative: str
    resolved_entities: list[ResolvedEntity]
    relationships: list[NarrativeRelationship]
    graph_additions: list[GraphAddition]
