"""Relationship extraction from FIR narratives (Phase 3 spec §6).

Only the six narrative relation types in :class:`app.graph.model.NarrativeEdgeType`
may be produced: MET, CALLED, LOCATED_AT, ASSOCIATED_WITH, REPORTED_AGAINST,
TRANSFERRED_TO.

**The core rule: co-occurrence is not a relationship.** Two people appearing in
the same FIR produces nothing. Every relationship requires an *explicit textual
trigger* — a verb or set phrase that states the link — plus endpoints bound by an
explicit mention or an explicit role word. Each rule records the trigger span, so
any assertion can be traced back to the words that justify it.

Endpoint binding, in the two forms allowed here:

* **Named mention** — a PERSON/LOCATION entity the extractor already located and
  the resolver already linked to a structured record.
* **Role anaphora** — a definite role phrase ("the accused", "the complainant")
  bound to the FIR party whose *name was explicitly extracted from this same
  narrative* and carried the matching role marker. This is coreference over
  closed-class role words, not name guessing.

Confidence ladder (deterministic, documented in ``docs/phase3_nlp.md``):

* ``CONF_REL_EXPLICIT`` (1.0) — trigger and both endpoints stated outright.
* ``CONF_REL_HEDGED`` (0.9) — the assertion is hedged, or an endpoint came from
  role anaphora rather than a name.
* ``CONF_REL_SOFT_PLACEMENT`` (0.7) — placement stated by proximity ("seen *near*
  the scene"), which is weaker than being placed *at* somewhere.

Two deliberate, documented over-reads (they are approximations, and their
confidence is discounted for exactly this reason):

* ``"the accused ... is known to associate with the complainant's circle"`` yields
  ASSOCIATED_WITH(accused, complainant). The text names the complainant's
  *circle*, not the complainant; the edge records ``target_scope="circle"``.
* ``"was seen near the scene"`` yields LOCATED_AT(accused, incident location).
  "Near" is not "at"; the edge records ``proximity="near"``.

Measured on this corpus (300 narratives): REPORTED_AGAINST 300, LOCATED_AT 300,
ASSOCIATED_WITH 5. MET / CALLED / TRANSFERRED_TO are implemented and match zero
times — the templates never state them. That zero is reported, not hidden.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Sequence

from app.graph.model import NarrativeEdgeType, source_record_id
from app.nlp import validators
from app.nlp.extractor import (
    ROLE_ACCUSED,
    ROLE_COMPLAINANT,
    evidence_for_span,
    sentence_spans,
)
from app.nlp.models import (
    CONF_REL_EXPLICIT,
    CONF_REL_HEDGED,
    CONF_REL_SOFT_PLACEMENT,
    EntityType,
    NarrativeRelationship,
    ResolutionStatus,
    ResolvedEntity,
)

# --- explicit triggers ------------------------------------------------------
ASSOCIATION_TRIGGER_RE = re.compile(
    r"\b(?:known\s+to\s+associate\s+with|associates?\s+with|is\s+associated\s+with"
    r"|in\s+league\s+with|linked\s+to)\b",
    re.IGNORECASE,
)
HEDGE_RE = re.compile(r"\b(?:known\s+to|reportedly|allegedly|suspected\s+to|believed\s+to)\b", re.IGNORECASE)
MET_TRIGGER_RE = re.compile(
    r"\b(?:met\s+with|met|meeting\s+with|was\s+seen\s+with|seen\s+together\s+with)\b",
    re.IGNORECASE,
)
CALL_TRIGGER_RE = re.compile(
    r"\b(?:called|phoned|rang|contacted|spoke\s+to|spoke\s+with|dialled|dialed)\b",
    re.IGNORECASE,
)
TRANSFER_TRIGGER_RE = re.compile(
    r"\b(?:transferred|remitted|wired|paid|sent\s+money|handed\s+over)\b",
    re.IGNORECASE,
)
PLACEMENT_TRIGGER_RE = re.compile(
    r"\b(?:was|were)\s+seen\s+(?P<prox>near|at|around|outside)\b"
    r"|\b(?:was|were)\s+present\s+(?P<prox2>near|at|outside)\b"
    r"|\bspotted\s+(?P<prox3>near|at|outside)\b",
    re.IGNORECASE,
)
# Definite role phrases usable as anaphora for this FIR's parties.
ROLE_ANAPHORA_RE = re.compile(
    r"\bthe\s+(?P<role>accused|suspect|complainant|victim)\b"
    r"(?P<poss>'s\s+(?:circle|associates|network|contacts|group))?",
    re.IGNORECASE,
)
# Definite phrases that refer back to the FIR's incident location.
SCENE_ANAPHORA_RE = re.compile(
    r"\bthe\s+(?:scene|spot|site|location|place)\b(?:\s+of\s+(?:the\s+)?\w+)?",
    re.IGNORECASE,
)
_ROLE_ANAPHORA_MAP = {
    "accused": ROLE_ACCUSED,
    "suspect": ROLE_ACCUSED,
    "complainant": ROLE_COMPLAINANT,
    "victim": ROLE_COMPLAINANT,
}
ACCUSED_MARKER_RE = re.compile(r"\b(?:[Ss]uspect|[Aa]ccused)\b")

# Which narrative types are undirected (endpoint order is not meaningful).
_UNDIRECTED = frozenset({NarrativeEdgeType.MET, NarrativeEdgeType.ASSOCIATED_WITH})


@dataclass(frozen=True)
class _Endpoint:
    """A candidate relationship endpoint located at a position in the text."""

    entity_id: Optional[str]
    mention: str
    start: int
    end: int
    via: str            # "mention" | "role_anaphora"
    scope: Optional[str] = None  # e.g. "circle" for "the complainant's circle"


class RelationExtractor:
    """Extracts narrative relationships from one FIR at a time.

    Stateless with respect to the FIR: everything it needs comes from the
    narrative text plus the already-resolved entities, so output is deterministic
    and independently reproducible.
    """

    def __init__(self, repo) -> None:
        self.repo = repo
        self.dropped: list[tuple[int, str, str]] = []  # (fir_id, rule, reason)

    def extract(
        self, fir_id: int, narrative: str, resolved: Sequence[ResolvedEntity]
    ) -> list[NarrativeRelationship]:
        if not narrative or not resolved:
            return []
        sentences = sentence_spans(narrative)
        narrative_date = _first_value(resolved, EntityType.DATE)

        candidates: list[NarrativeRelationship] = []
        candidates.extend(self._reported_against(fir_id, narrative, sentences, resolved))
        candidates.extend(self._placement(fir_id, narrative, sentences, resolved))
        candidates.extend(
            self._sentence_local(
                fir_id, narrative, sentences, resolved,
                trigger_re=ASSOCIATION_TRIGGER_RE,
                rel_type=NarrativeEdgeType.ASSOCIATED_WITH,
                rule="association_trigger",
            )
        )
        candidates.extend(
            self._sentence_local(
                fir_id, narrative, sentences, resolved,
                trigger_re=MET_TRIGGER_RE,
                rel_type=NarrativeEdgeType.MET,
                rule="met_trigger",
            )
        )
        candidates.extend(
            self._sentence_local(
                fir_id, narrative, sentences, resolved,
                trigger_re=CALL_TRIGGER_RE,
                rel_type=NarrativeEdgeType.CALLED,
                rule="call_trigger",
            )
        )
        candidates.extend(
            self._sentence_local(
                fir_id, narrative, sentences, resolved,
                trigger_re=TRANSFER_TRIGGER_RE,
                rel_type=NarrativeEdgeType.TRANSFERRED_TO,
                rule="transfer_trigger",
                require_money=True,
            )
        )

        kept: list[NarrativeRelationship] = []
        seen: set[tuple] = set()
        for rel in candidates:
            if narrative_date and "narrative_date" not in rel.attributes:
                rel.attributes["narrative_date"] = narrative_date
            ok, reason = validators.validate_relationship(rel, narrative)
            if not ok:
                self.dropped.append((fir_id, rel.extraction_method, reason or "invalid"))
                continue
            key = _dedupe_key(rel)
            if key in seen:
                continue
            seen.add(key)
            kept.append(rel)
        return sorted(
            kept,
            key=lambda r: (r.character_start, r.character_end, r.relationship_type.value),
        )

    # -- rule: complainant reported against the named suspect ----------------
    def _reported_against(
        self, fir_id: int, text: str, sentences, resolved: Sequence[ResolvedEntity]
    ) -> list[NarrativeRelationship]:
        """REPORTED_AGAINST, justified by two explicit role markers in the text.

        Requires BOTH: a person whose name is followed by a reporting verb
        (``role="complainant"``) and a person introduced by "Suspect"/"Accused"
        (``role="accused"``). If either marker is missing the rule does not fire —
        this is what stops mere co-occurrence in one FIR from creating an edge.
        """
        complainant = _person_with_role(resolved, ROLE_COMPLAINANT)
        accused = _person_with_role(resolved, ROLE_ACCUSED)
        if complainant is None or accused is None:
            return []
        marker = ACCUSED_MARKER_RE.search(text)
        if marker is None:
            return []

        c_ent, a_ent = complainant.entity, accused.entity
        start = min(c_ent.character_start, marker.start())
        end = max(a_ent.character_end, marker.end())
        return [
            self._make(
                rel_type=NarrativeEdgeType.REPORTED_AGAINST,
                fir_id=fir_id,
                text=text,
                sentences=sentences,
                source=_from_resolved(complainant),
                target=_from_resolved(accused),
                start=start,
                end=end,
                confidence=CONF_REL_EXPLICIT,
                rule="complainant_reported_suspect",
                attributes={
                    "trigger_text": marker.group(0),
                    "complainant_role_evidence": c_ent.raw_text,
                    "accused_role_evidence": a_ent.raw_text,
                },
            )
        ]

    # -- rule: placement of a person at/near a location ----------------------
    def _placement(
        self, fir_id: int, text: str, sentences, resolved: Sequence[ResolvedEntity]
    ) -> list[NarrativeRelationship]:
        """LOCATED_AT from an explicit sighting/presence trigger."""
        out: list[NarrativeRelationship] = []
        for m in PLACEMENT_TRIGGER_RE.finditer(text):
            proximity = (
                m.group("prox") or m.group("prox2") or m.group("prox3") or ""
            ).lower()
            s_start, s_end = _sentence_of(sentences, m.start())
            people = _people_in_range(resolved, s_start, m.start())
            if not people:
                continue
            subject = people[-1]  # nearest person before the trigger

            target, via = self._placement_target(text, resolved, m.end(), s_end)
            if target is None:
                continue

            if proximity in ("near", "around", "outside"):
                confidence = CONF_REL_SOFT_PLACEMENT
            elif via == "role_anaphora":
                confidence = CONF_REL_HEDGED
            else:
                confidence = CONF_REL_EXPLICIT

            out.append(
                self._make(
                    rel_type=NarrativeEdgeType.LOCATED_AT,
                    fir_id=fir_id,
                    text=text,
                    sentences=sentences,
                    source=_from_resolved(subject),
                    target=target,
                    start=min(subject.entity.character_start, m.start()),
                    end=max(target.end, m.end()),
                    confidence=confidence,
                    rule="sighting_placement",
                    attributes={
                        "trigger_text": m.group(0),
                        "proximity": proximity or "at",
                        "target_bound_via": via,
                    },
                )
            )
        return out

    def _placement_target(
        self, text: str, resolved: Sequence[ResolvedEntity], search_from: int, sentence_end: int
    ) -> tuple[Optional[_Endpoint], str]:
        """Bind a placement target: an explicit LOCATION mention, else "the scene"."""
        for r in resolved:
            e = r.entity
            if (
                e.entity_type is EntityType.LOCATION
                and search_from <= e.character_start < sentence_end
            ):
                return _from_resolved(r), "mention"
        scene = SCENE_ANAPHORA_RE.search(text, search_from, sentence_end)
        if scene is None:
            return None, ""
        # "the scene" refers to the incident location this narrative already named.
        location = _first_resolved(resolved, EntityType.LOCATION)
        if location is None:
            return None, ""
        return (
            _Endpoint(
                entity_id=location.resolution.matched_entity_id,
                mention=scene.group(0),
                start=scene.start(),
                end=scene.end(),
                via="role_anaphora",
            ),
            "role_anaphora",
        )

    # -- generic sentence-local rule -----------------------------------------
    def _sentence_local(
        self,
        fir_id: int,
        text: str,
        sentences,
        resolved: Sequence[ResolvedEntity],
        *,
        trigger_re: re.Pattern[str],
        rel_type: NarrativeEdgeType,
        rule: str,
        require_money: bool = False,
    ) -> list[NarrativeRelationship]:
        """Bind ``<endpoint> TRIGGER <endpoint>`` strictly within one sentence.

        The endpoint before the trigger is the source, the endpoint after it is
        the target. Nothing crosses a sentence boundary, and an endpoint must be
        either a resolved PERSON mention or a role anaphor.
        """
        out: list[NarrativeRelationship] = []
        for m in trigger_re.finditer(text):
            s_start, s_end = _sentence_of(sentences, m.start())
            if require_money and not _has_money(resolved, s_start, s_end):
                continue
            before = self._endpoints(text, resolved, s_start, m.start())
            after = self._endpoints(text, resolved, m.end(), s_end)
            if not before or not after:
                continue
            source, target = before[-1], after[0]
            if source.entity_id is not None and source.entity_id == target.entity_id:
                # Same party on both sides of the trigger: nothing is asserted.
                continue
            hedged = HEDGE_RE.search(text, s_start, m.end()) is not None
            anaphoric = "role_anaphora" in (source.via, target.via)
            confidence = (
                CONF_REL_HEDGED if (hedged or anaphoric) else CONF_REL_EXPLICIT
            )
            attributes = {
                "trigger_text": m.group(0),
                "source_bound_via": source.via,
                "target_bound_via": target.via,
            }
            if hedged:
                attributes["hedged"] = True
            if target.scope:
                attributes["target_scope"] = target.scope
            if source.scope:
                attributes["source_scope"] = source.scope
            out.append(
                self._make(
                    rel_type=rel_type,
                    fir_id=fir_id,
                    text=text,
                    sentences=sentences,
                    source=source,
                    target=target,
                    start=min(source.start, m.start()),
                    end=max(target.end, m.end()),
                    confidence=confidence,
                    rule=rule,
                    attributes=attributes,
                )
            )
        return out

    def _endpoints(
        self, text: str, resolved: Sequence[ResolvedEntity], start: int, end: int
    ) -> list[_Endpoint]:
        """All person endpoints inside ``[start, end)``, ordered by position."""
        found = [_from_resolved(r) for r in _people_in_range(resolved, start, end)]
        for m in ROLE_ANAPHORA_RE.finditer(text, start, end):
            role = _ROLE_ANAPHORA_MAP[m.group("role").lower()]
            party = _person_with_role(resolved, role)
            if party is None:
                continue
            scope = None
            if m.group("poss"):
                # "the complainant's circle" — the assertion is about the party's
                # circle; recorded so the approximation stays visible.
                scope = "circle"
            found.append(
                _Endpoint(
                    entity_id=party.resolution.matched_entity_id,
                    mention=m.group(0),
                    start=m.start(),
                    end=m.end(),
                    via="role_anaphora",
                    scope=scope,
                )
            )
        return sorted(found, key=lambda ep: (ep.start, ep.end))

    # -- construction --------------------------------------------------------
    def _make(
        self,
        *,
        rel_type: NarrativeEdgeType,
        fir_id: int,
        text: str,
        sentences,
        source: _Endpoint,
        target: _Endpoint,
        start: int,
        end: int,
        confidence: float,
        rule: str,
        attributes: dict,
    ) -> NarrativeRelationship:
        return NarrativeRelationship(
            relationship_type=rel_type,
            fir_id=fir_id,
            directed=rel_type not in _UNDIRECTED,
            source_entity_id=source.entity_id,
            target_entity_id=target.entity_id,
            source_mention=source.mention,
            target_mention=target.mention,
            confidence=confidence,
            evidence_text=evidence_for_span(text, sentences, start, end),
            character_start=start,
            character_end=end,
            extraction_method=f"rule:{rule}",
            source_dataset="fir_text",
            source_record_id=source_record_id("firs", fir_id),
            attributes=dict(attributes),
        )


# --- helpers ----------------------------------------------------------------
def _from_resolved(r: ResolvedEntity) -> _Endpoint:
    return _Endpoint(
        entity_id=r.resolution.matched_entity_id,
        mention=r.entity.raw_text,
        start=r.entity.character_start,
        end=r.entity.character_end,
        via="mention",
    )


def _person_with_role(resolved: Sequence[ResolvedEntity], role: str) -> Optional[ResolvedEntity]:
    for r in resolved:
        if r.entity.entity_type is EntityType.PERSON and r.entity.role == role:
            return r
    return None


def _people_in_range(
    resolved: Sequence[ResolvedEntity], start: int, end: int
) -> list[ResolvedEntity]:
    return sorted(
        (
            r
            for r in resolved
            if r.entity.entity_type is EntityType.PERSON
            and start <= r.entity.character_start < end
        ),
        key=lambda r: (r.entity.character_start, r.entity.character_end),
    )


def _first_resolved(
    resolved: Sequence[ResolvedEntity], etype: EntityType
) -> Optional[ResolvedEntity]:
    for r in resolved:
        if r.entity.entity_type is etype and r.resolution.status is ResolutionStatus.RESOLVED:
            return r
    return None


def _first_value(resolved: Sequence[ResolvedEntity], etype: EntityType) -> Optional[str]:
    for r in resolved:
        if r.entity.entity_type is etype:
            return r.entity.normalized_value
    return None


def _has_money(resolved: Sequence[ResolvedEntity], start: int, end: int) -> bool:
    return any(
        r.entity.entity_type is EntityType.MONEY
        and start <= r.entity.character_start < end
        for r in resolved
    )


def _sentence_of(sentences: list[tuple[int, int]], position: int) -> tuple[int, int]:
    for s, e in sentences:
        if s <= position < e:
            return s, e
    return (sentences[0][0], sentences[-1][1]) if sentences else (0, 0)


def _dedupe_key(rel: NarrativeRelationship) -> tuple:
    """Identity of an extracted relationship within one FIR.

    Undirected types canonicalise endpoint order so the same pair is not emitted
    twice from mirrored phrasings.
    """
    a, b = rel.source_entity_id, rel.target_entity_id
    if rel.relationship_type in _UNDIRECTED:
        a, b = sorted((a or "", b or ""))
    return (rel.relationship_type.value, a, b, rel.character_start, rel.character_end)
