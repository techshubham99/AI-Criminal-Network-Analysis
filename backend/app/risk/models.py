"""Phase 4 domain model: evidence references, patterns, features and scores.

Three rules are enforced structurally by the types in this module rather than by
convention, because they are the rules the whole phase rests on:

1. **Evidence is never anonymous.** Every claim Phase 4 makes carries
   :class:`EvidenceRef` items naming the dataset, the record and the confidence
   tier the claim came from (spec §7).
2. **Structured and NLP-derived evidence never merge.** They are separate
   collections on every pattern and every score, with their own confidence
   tiers, so a rule-extracted narrative sentence can never be read as an
   observed record (spec §7).
3. **Pattern identity is content-addressed.** :func:`make_pattern_id` hashes
   pattern type + sorted entity ids + sorted evidence ids, so the same dataset
   yields the same id after any rebuild, in any iteration order (spec §9).

Nothing here is a determination about a person. A pattern is an observation
about records; a score is a triage ordering over observations.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Optional

# --- Evidence ---------------------------------------------------------------

# The two evidence classes are kept distinct everywhere (spec §7). "STRUCTURED"
# is an observed dataset record; "NLP_DERIVED" is a rule-extraction claim about
# free text, which is a weaker kind of statement about the world.
EVIDENCE_STRUCTURED = "STRUCTURED"
EVIDENCE_NLP_DERIVED = "NLP_DERIVED"

# Structured records are transcriptions of the dataset, so their provenance
# confidence is a deterministic 1.0. This is NOT a model confidence and must not
# be read as one (same convention as the Phase 2 edge weights).
CONF_STRUCTURED_RECORD = 1.0


@dataclass(frozen=True)
class EvidenceRef:
    """One traceable evidence item behind a pattern or a score contribution."""

    evidence_id: str
    """Stable key for de-duplication. ``"calls:1234"`` for structured records;
    the narrative relationship id for NLP-derived claims."""

    evidence_class: str  # EVIDENCE_STRUCTURED | EVIDENCE_NLP_DERIVED
    source_dataset: str  # "calls" | "transactions" | "firs" | "persons" | ...
    source_record_id: str  # "{table}:{pk}" — the row the claim rests on
    confidence: float
    """The evidence item's OWN confidence tier, preserved verbatim: 1.0 for a
    structured record, the Phase 3 extraction confidence for a narrative claim.
    Never averaged into a summary number (spec §7)."""

    confidence_basis: str
    """How the confidence above was arrived at, e.g. ``"structured_record"`` or
    ``"rule:explicit_transfer"``."""

    evidence_text: Optional[str] = None
    """Verbatim supporting text where the source has any (narrative claims do;
    structured rows do not)."""

    def as_dict(self) -> dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "evidence_class": self.evidence_class,
            "source_dataset": self.source_dataset,
            "source_record_id": self.source_record_id,
            "confidence": self.confidence,
            "confidence_basis": self.confidence_basis,
            "evidence_text": self.evidence_text,
        }


def structured_evidence(source_record_id: str) -> EvidenceRef:
    """Build a structured :class:`EvidenceRef` from a ``"{table}:{pk}"`` id."""
    dataset = source_record_id.split(":", 1)[0] if ":" in source_record_id else source_record_id
    return EvidenceRef(
        evidence_id=source_record_id,
        evidence_class=EVIDENCE_STRUCTURED,
        source_dataset=dataset,
        source_record_id=source_record_id,
        confidence=CONF_STRUCTURED_RECORD,
        confidence_basis="structured_record",
    )


def dedupe_evidence(items: Iterable[EvidenceRef]) -> list[EvidenceRef]:
    """De-duplicate by (class, evidence_id), keeping a deterministic order.

    This is the mechanism behind "do not count the same underlying evidence
    twice" (spec §1/§7): a record cited by two channels of the same pattern is
    one evidence item, not two.
    """
    seen: dict[tuple[str, str], EvidenceRef] = {}
    for item in items:
        seen.setdefault((item.evidence_class, item.evidence_id), item)
    return [seen[key] for key in sorted(seen)]


def split_evidence(
    items: Iterable[EvidenceRef],
) -> tuple[list[EvidenceRef], list[EvidenceRef]]:
    """Split into (structured, nlp_derived) — the §7 separation, mechanically."""
    evidence = dedupe_evidence(items)
    structured = [e for e in evidence if e.evidence_class == EVIDENCE_STRUCTURED]
    narrative = [e for e in evidence if e.evidence_class == EVIDENCE_NLP_DERIVED]
    return structured, narrative


# --- Patterns ---------------------------------------------------------------


class PatternType(str, Enum):
    """Every pattern category Phase 4 can report.

    Deliberately neutral names. A transaction cycle is a transaction cycle; the
    dataset cannot tell us it is a crime, and neither can this engine.
    """

    MULTI_CHANNEL_RELATIONSHIP = "MULTI_CHANNEL_RELATIONSHIP"
    COMMUNICATION_ANOMALY = "COMMUNICATION_ANOMALY"
    TRANSACTION_CYCLE = "TRANSACTION_CYCLE"
    TRANSACTION_FAN_IN = "TRANSACTION_FAN_IN"
    TRANSACTION_FAN_OUT = "TRANSACTION_FAN_OUT"
    TRANSACTION_CONCENTRATION = "TRANSACTION_CONCENTRATION"
    LOCATION_COHORT = "LOCATION_COHORT"
    SHARED_LOCATION_PAIR = "SHARED_LOCATION_PAIR"
    BRIDGE_ENTITY = "BRIDGE_ENTITY"


# The four transaction categories share one review label, and it is the label
# spec §3 mandates: never "laundering", never "fraud", never "confirmed".
TRANSACTION_REVIEW_LABEL = "Potential transaction pattern requiring review"

# Which scoring feature each pattern type feeds. The mapping is intentionally
# many-to-one and total: a pattern contributes to exactly ONE feature, which is
# how "do not double-count identical evidence across features" (spec §8) is
# enforced rather than merely intended.
PATTERN_FEATURE: dict[PatternType, str] = {
    PatternType.MULTI_CHANNEL_RELATIONSHIP: "multi_channel_relationship",
    PatternType.COMMUNICATION_ANOMALY: "communication_anomaly",
    PatternType.TRANSACTION_CYCLE: "transaction_patterns",
    PatternType.TRANSACTION_FAN_IN: "transaction_patterns",
    PatternType.TRANSACTION_FAN_OUT: "transaction_patterns",
    PatternType.TRANSACTION_CONCENTRATION: "transaction_patterns",
    PatternType.LOCATION_COHORT: "location_patterns",
    PatternType.SHARED_LOCATION_PAIR: "location_patterns",
    PatternType.BRIDGE_ENTITY: "bridge_network_structure",
}


def make_pattern_id(
    pattern_type: PatternType | str,
    entity_ids: Iterable[str],
    evidence_ids: Iterable[str],
) -> str:
    """Content-addressed, restart-stable pattern id (spec §9).

    The digest covers pattern type + sorted unique entity ids + sorted unique
    evidence ids and nothing else: no index, no insertion order, no clock, no
    randomness, no process state. Two runs over the same dataset therefore
    produce byte-identical ids, and a pattern whose evidence changes gets a new
    id rather than silently mutating under the old one.
    """
    ptype = pattern_type.value if isinstance(pattern_type, PatternType) else str(pattern_type)
    entities = ",".join(sorted({e for e in entity_ids}))
    evidence = ",".join(sorted({e for e in evidence_ids}))
    payload = f"{ptype}|{entities}|{evidence}".encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()[:16]
    return f"{ptype.lower()}~{digest}"


@dataclass(frozen=True)
class Pattern:
    """One detected pattern, with everything needed to audit it."""

    pattern_id: str
    pattern_type: PatternType
    entity_ids: list[str]
    """Involved entity ids in the prefixed form (``person:445``), sorted."""

    relationship_types: list[str]
    """Observed relationship/channel types the pattern rests on, sorted."""

    structured_evidence: list[EvidenceRef]
    nlp_evidence: list[EvidenceRef]
    source_datasets: list[str]
    explanation: str
    severity: float
    """0.0-1.0 deterministic strength used by scoring. Not a probability, and
    not a likelihood of wrongdoing — a normalised measure of how far the
    observation sits from the ordinary shape of this dataset."""

    detail: dict[str, Any] = field(default_factory=dict)
    """Category-specific measured values (counts, z-scores, shares)."""

    @property
    def evidence(self) -> list[EvidenceRef]:
        """All evidence, still tagged by class — for single-list responses."""
        return self.structured_evidence + self.nlp_evidence

    @property
    def evidence_ids(self) -> list[str]:
        return [e.evidence_id for e in self.evidence]

    @property
    def feature(self) -> str:
        return PATTERN_FEATURE[self.pattern_type]

    def involves(self, entity_id: str) -> bool:
        return entity_id in self.entity_ids


def build_pattern(
    pattern_type: PatternType,
    *,
    entity_ids: Iterable[str],
    relationship_types: Iterable[str],
    evidence: Iterable[EvidenceRef],
    explanation: str,
    severity: float,
    detail: Optional[dict[str, Any]] = None,
) -> Pattern:
    """Assemble a :class:`Pattern`, deriving its id from its own content."""
    entities = sorted(set(entity_ids))
    structured, narrative = split_evidence(evidence)
    all_evidence = structured + narrative
    return Pattern(
        pattern_id=make_pattern_id(
            pattern_type, entities, [e.evidence_id for e in all_evidence]
        ),
        pattern_type=pattern_type,
        entity_ids=entities,
        relationship_types=sorted(set(relationship_types)),
        structured_evidence=structured,
        nlp_evidence=narrative,
        source_datasets=sorted({e.source_dataset for e in all_evidence}),
        explanation=explanation,
        severity=max(0.0, min(1.0, float(severity))),
        detail=dict(detail or {}),
    )


# --- Scoring ----------------------------------------------------------------

BAND_LOW = "LOW"
BAND_MEDIUM = "MEDIUM"
BAND_HIGH = "HIGH"

SCORE_DISCLAIMER = (
    "Investigation-prioritization signal computed from observed synthetic "
    "records only. It is NOT a probability of guilt, NOT a probability of "
    "criminality, and NOT proof of wrongdoing."
)


@dataclass(frozen=True)
class ScoreFactor:
    """One feature's contribution, with the value it was computed from.

    Feature value and contribution are stored separately (spec §8) so a reader
    can check the arithmetic: ``contribution = round(value * max_contribution)``
    for every factor, always.
    """

    feature: str
    value: float  # 0.0-1.0 normalised feature value
    max_contribution: float  # the configured weight cap for this feature
    contribution: float  # value * max_contribution, rounded to 2dp
    pattern_ids: list[str]
    evidence_ids: list[str]
    explanation: str
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "feature": self.feature,
            "value": self.value,
            "max_contribution": self.max_contribution,
            "contribution": self.contribution,
            "pattern_ids": self.pattern_ids,
            "evidence_ids": self.evidence_ids,
            "explanation": self.explanation,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class PriorityScore:
    """A person's 0-100 investigation priority score and its full derivation."""

    person_id: int
    entity_id: str
    score: int
    band: str
    factors: list[ScoreFactor]
    structured_evidence: list[EvidenceRef]
    nlp_evidence: list[EvidenceRef]
    pattern_ids: list[str]
    explanation: str
    disclaimer: str = SCORE_DISCLAIMER

    @property
    def evidence(self) -> list[EvidenceRef]:
        return self.structured_evidence + self.nlp_evidence


def band_for(score: int, *, low_max: int, medium_max: int) -> str:
    """Map a score to its band. Boundaries are inclusive upper bounds."""
    if score <= low_max:
        return BAND_LOW
    if score <= medium_max:
        return BAND_MEDIUM
    return BAND_HIGH
