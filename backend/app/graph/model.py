"""Graph domain model: node/edge types, records, and entity-id helpers.

This is the single source of truth for *what may exist* in the Phase 2 graph.
The allowed node and edge types are exactly those verified against the
structured synthetic dataset in ``docs/phase2_preflight.md`` — nothing is
invented here. In particular:

* Only the six spec node types (PERSON, PHONE, AADHAAR, LOCATION, FIR,
  TRANSACTION) plus the auxiliary CELL_TOWER (endpoint of ``USED_TOWER``) are
  *modelled*. TRANSACTION is a first-class type but is represented as a
  person->person ``TRANSACTED`` edge, so it is not materialised as a node in
  the default projection. VEHICLE / ORGANIZATION / EVENT exist only as future
  extensibility (no source data — preflight §7).
* Only the ten allowed edge types are emitted, all with existence-confidence
  ``1.0`` at the provenance layer. No sub-1.0 confidence is ever fabricated for
  the synthetic structured data (preflight §3).

Entity ids are stable, human-readable, and namespaced by type so the same id
is reproduced on every rebuild (determinism).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class NodeType(str, Enum):
    """Node types. See module docstring for materialisation rules."""

    # Spec node types (preflight §2)
    PERSON = "PERSON"
    PHONE = "PHONE"
    AADHAAR = "AADHAAR"
    LOCATION = "LOCATION"
    FIR = "FIR"
    TRANSACTION = "TRANSACTION"  # supported; modelled as an edge, not materialised
    # Auxiliary infrastructure node (endpoint of USED_TOWER; preflight edge table)
    CELL_TOWER = "CELL_TOWER"
    # Future extensibility only — no source data (preflight §7). Never built.
    VEHICLE = "VEHICLE"
    ORGANIZATION = "ORGANIZATION"
    EVENT = "EVENT"


class EdgeType(str, Enum):
    """The ONLY relationship types allowed in Phase 2 (preflight edge table)."""

    CALLED = "CALLED"                      # PERSON -> PERSON (directed)
    TRANSACTED = "TRANSACTED"              # PERSON -> PERSON (directed)
    NAMED_IN_FIR = "NAMED_IN_FIR"          # PERSON -> FIR   (role: complainant|accused)
    LOCATED_AT = "LOCATED_AT"              # PERSON/FIR -> LOCATION
    REPORTED_AGAINST = "REPORTED_AGAINST"  # PERSON(complainant) -> PERSON(accused)
    CO_LOCATED = "CO_LOCATED"              # PERSON <-> PERSON (derived, shared location)
    OWNS_PHONE = "OWNS_PHONE"              # PERSON -> PHONE
    OWNS_AADHAAR = "OWNS_AADHAAR"          # PERSON -> AADHAAR
    USED_TOWER = "USED_TOWER"              # PERSON -> CELL_TOWER
    SAME_RING = "SAME_RING"                # PERSON <-> PERSON (GROUND-TRUTH overlay only)


class NarrativeEdgeType(str, Enum):
    """Relationship types that may be *asserted by FIR narrative text* (Phase 3).

    Kept as a SEPARATE enum from the closed structured :class:`EdgeType` set on
    purpose: narrative-derived edges have ``source_dataset="fir_text"``, carry a
    text ``evidence`` span, are assigned a deterministic rule-based confidence
    (often < 1.0), and live only in the Phase 3 narrative overlay store — they
    are NEVER added to the Phase 2 structured graph. Because this enum is
    disjoint from ``EdgeType``, the Phase 2 ``ALLOWED_EDGE_TYPES`` invariant is
    untouched. These are exactly the six narrative relation types in the Phase 3
    specification.
    """

    MET = "MET"                            # PERSON <-> PERSON (co-presence stated)
    CALLED = "CALLED"                      # PERSON -> PERSON (communication stated)
    LOCATED_AT = "LOCATED_AT"              # PERSON -> LOCATION (placement stated)
    ASSOCIATED_WITH = "ASSOCIATED_WITH"    # PERSON <-> PERSON (association stated)
    REPORTED_AGAINST = "REPORTED_AGAINST"  # PERSON(complainant) -> PERSON(accused)
    TRANSFERRED_TO = "TRANSFERRED_TO"      # PERSON -> PERSON (value transfer stated)


# Node types actually built from the current dataset.
MATERIALIZED_NODE_TYPES: tuple[NodeType, ...] = (
    NodeType.PERSON,
    NodeType.PHONE,
    NodeType.AADHAAR,
    NodeType.LOCATION,
    NodeType.FIR,
    NodeType.CELL_TOWER,
)
# Future extensibility — deliberately never emitted in Phase 2.
FUTURE_NODE_TYPES: tuple[NodeType, ...] = (
    NodeType.VEHICLE,
    NodeType.ORGANIZATION,
    NodeType.EVENT,
)
ALLOWED_EDGE_TYPES: tuple[EdgeType, ...] = tuple(EdgeType)

# Undirected relationship types (canonicalised endpoint order in the id).
UNDIRECTED_EDGE_TYPES: frozenset[EdgeType] = frozenset(
    {EdgeType.CO_LOCATED, EdgeType.SAME_RING}
)
# SAME_RING is a benchmark/ground-truth overlay, kept separate from observed
# intelligence (preflight §8) and excluded from the default analytic graph.
OVERLAY_EDGE_TYPES: frozenset[EdgeType] = frozenset({EdgeType.SAME_RING})

# --- Phase 3: narrative-derived relationship metadata -----------------------
NARRATIVE_EDGE_TYPES: tuple[NarrativeEdgeType, ...] = tuple(NarrativeEdgeType)
# Narrative types whose endpoints are unordered (canonicalised in the id).
NARRATIVE_UNDIRECTED_EDGE_TYPES: frozenset[NarrativeEdgeType] = frozenset(
    {NarrativeEdgeType.MET, NarrativeEdgeType.ASSOCIATED_WITH}
)

# Separator used inside relationship ids. Safe: no entity id contains "~".
_SEP = "~"


# --- entity-id helpers ------------------------------------------------------
def person_eid(person_id: int) -> str:
    return f"person:{person_id}"


def phone_eid(phone: str) -> str:
    return f"phone:{phone}"


def aadhaar_eid(aadhaar: str) -> str:
    return f"aadhaar:{aadhaar}"


def location_eid(location_id: int) -> str:
    return f"location:{location_id}"


def fir_eid(fir_id: int) -> str:
    return f"fir:{fir_id}"


def tower_eid(tower_id: int) -> str:
    return f"tower:{tower_id}"


def source_record_id(table: str, pk: Any) -> str:
    """Traceability id in ``{table}:{pk}`` form (preflight §4)."""
    return f"{table}:{pk}"


def make_relationship_id(
    edge_type: EdgeType,
    source: str,
    target: str,
    *,
    role: Optional[str] = None,
) -> str:
    """Deterministic relationship id.

    Undirected types canonicalise endpoint order (min, max) so the same pair
    always yields the same id regardless of arrival order. ``role`` (for
    ``NAMED_IN_FIR``) is embedded so complainant/accused edges to the same FIR
    stay distinct.
    """
    if edge_type in UNDIRECTED_EDGE_TYPES:
        a, b = sorted((source, target))
    else:
        a, b = source, target
    parts = [edge_type.value]
    if role:
        parts.append(role)
    parts.extend((a, b))
    return _SEP.join(parts)


def make_narrative_relationship_id(
    rel_type: NarrativeEdgeType,
    source: str,
    target: str,
) -> str:
    """Deterministic id for a NARRATIVE-derived relationship.

    Prefixed with ``narr`` so narrative ids can never collide with the
    structured ids from :func:`make_relationship_id` (the two edge sets live in
    separate stores, but distinct ids keep cross-references unambiguous).
    Undirected narrative types canonicalise endpoint order.
    """
    if rel_type in NARRATIVE_UNDIRECTED_EDGE_TYPES:
        a, b = sorted((source, target))
    else:
        a, b = source, target
    return _SEP.join(("narr", rel_type.value, a, b))


@dataclass(frozen=True)
class Node:
    """A typed graph node.

    ``attributes`` holds non-identifying descriptive fields (e.g. city, ring_id
    overlay). Raw phone/aadhaar values live only on PHONE/AADHAAR nodes whose id
    already encodes them — consistent with the Phase 1 API, which also exposes
    them — and are never written to logs.
    """

    entity_id: str
    entity_type: NodeType
    label: str
    source_dataset: Optional[str] = None
    source_record_id: Optional[str] = None
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass
class Edge:
    """A typed, evidence-backed graph edge.

    Every edge is traceable to >=1 ``source_record_id`` (preflight §4).
    ``weight`` is analytic edge strength (NOT confidence). ``provenance_confidence``
    is a deterministic 1.0 for all structured/derived Phase 2 edges and must not
    be presented as model confidence. For Phase 3 NARRATIVE edges (``is_narrative``)
    it instead carries a deterministic rule-assigned confidence (often < 1.0) and
    ``source_dataset='fir_text'`` — distinguishing narrative-derived from
    structured-observed intelligence.
    """

    relationship_id: str
    source_entity_id: str
    target_entity_id: str
    relationship_type: EdgeType | NarrativeEdgeType
    directed: bool
    source_dataset: str
    evidence: list[str] = field(default_factory=list)  # source_record_ids
    weight: float = 1.0
    weight_detail: dict[str, Any] = field(default_factory=dict)
    date_first: Optional[str] = None
    date_last: Optional[str] = None
    provenance_confidence: float = 1.0
    is_overlay: bool = False  # True for SAME_RING (ground-truth, not observed)
    is_narrative: bool = False  # True for Phase 3 narrative-derived edges
    attributes: dict[str, Any] = field(default_factory=dict)  # e.g. role, shared key
