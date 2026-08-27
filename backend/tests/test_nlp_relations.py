"""Phase 3 — narrative relationship extraction (spec §6).

The load-bearing rule under test: **co-occurrence in one FIR is never enough.**
Every relationship must trace back to an explicit trigger span.
"""
from __future__ import annotations

import pytest

from app.graph.model import NarrativeEdgeType
from app.nlp.extractor import EntityExtractor
from app.nlp.models import (
    CONF_REL_EXPLICIT,
    CONF_REL_HEDGED,
    CONF_REL_SOFT_PLACEMENT,
    NarrativeRelationship,
)
from app.nlp.relation_extractor import RelationExtractor
from app.nlp.resolver import EntityResolver

# Two real persons, so mentions resolve on the unique-name tier.
CHAVVI = "person:489"   # "Chavvi Anne"
GUNBIR = "person:21"    # "Gunbir Sankar"


def _relations(repo, settings, text, fir_id=1):
    """Run the whole per-FIR pipeline on synthetic text with FRESH components.

    Fresh instances matter: the service's extractor/relation-extractor expose
    ``dropped`` in ``/nlp/summary``, and test input must not leak into it.
    """
    entities = EntityExtractor(repo).extract(fir_id, text)
    resolved = EntityResolver(repo, settings).resolve_all(entities)
    return RelationExtractor(repo).extract(fir_id, text, resolved)


def _types(rels):
    return [r.relationship_type for r in rels]


# --- real FIRs ---------------------------------------------------------------
def test_fir1_relationships(nlp_service):
    rels = nlp_service.get_analysis(1).relationships
    assert len(rels) == 2

    reported, located = rels
    assert reported.relationship_type is NarrativeEdgeType.REPORTED_AGAINST
    assert (reported.source_entity_id, reported.target_entity_id) == (CHAVVI, GUNBIR)
    assert reported.directed is True
    assert reported.confidence == CONF_REL_EXPLICIT
    assert reported.extraction_method == "rule:complainant_reported_suspect"
    assert (reported.character_start, reported.character_end) == (24, 118)

    assert located.relationship_type is NarrativeEdgeType.LOCATED_AT
    assert (located.source_entity_id, located.target_entity_id) == (GUNBIR, "location:143")
    # "seen NEAR the scene" is weaker than being placed AT somewhere.
    assert located.confidence == CONF_REL_SOFT_PLACEMENT
    assert located.attributes["proximity"] == "near"
    assert located.attributes["target_bound_via"] == "role_anaphora"


def test_fir1_relationship_evidence_quotes_the_text(nlp_service):
    analysis = nlp_service.get_analysis(1)
    for rel in analysis.relationships:
        span = analysis.narrative[rel.character_start : rel.character_end]
        assert span in rel.evidence_text
        assert rel.evidence_text in analysis.narrative
        assert rel.source_mention and rel.target_mention


def test_fir12_hedged_association(nlp_service):
    """The variant template hedges ("known to associate with ... circle")."""
    rels = nlp_service.get_analysis(12).relationships
    assert len(rels) == 3
    assoc = next(r for r in rels if r.relationship_type is NarrativeEdgeType.ASSOCIATED_WITH)
    assert {assoc.source_entity_id, assoc.target_entity_id} == {"person:369", "person:500"}
    assert assoc.confidence == CONF_REL_HEDGED
    assert assoc.directed is False
    assert assoc.attributes["hedged"] is True
    # The text names the complainant's *circle*; the approximation stays visible.
    assert assoc.attributes["target_scope"] == "circle"
    assert assoc.extraction_method == "rule:association_trigger"


def test_undirected_types_are_flagged_undirected(nlp_service):
    for fir_id in range(1, 301):
        for rel in nlp_service.get_analysis(fir_id).relationships:
            undirected = rel.relationship_type in (
                NarrativeEdgeType.MET,
                NarrativeEdgeType.ASSOCIATED_WITH,
            )
            assert rel.directed is not undirected


def test_corpus_relationship_counts_by_type(nlp_service):
    counts = {t: 0 for t in NarrativeEdgeType}
    total = 0
    for fir_id in range(1, 301):
        for rel in nlp_service.get_analysis(fir_id).relationships:
            counts[rel.relationship_type] += 1
            total += 1
    assert total == 605
    assert counts[NarrativeEdgeType.REPORTED_AGAINST] == 300
    assert counts[NarrativeEdgeType.LOCATED_AT] == 300
    assert counts[NarrativeEdgeType.ASSOCIATED_WITH] == 5
    # Implemented but never triggered by these templates — reported, not hidden.
    assert counts[NarrativeEdgeType.MET] == 0
    assert counts[NarrativeEdgeType.CALLED] == 0
    assert counts[NarrativeEdgeType.TRANSFERRED_TO] == 0


def test_every_relationship_declares_narrative_provenance(nlp_service):
    for fir_id in range(1, 301):
        analysis = nlp_service.get_analysis(fir_id)
        for rel in analysis.relationships:
            assert rel.source_dataset == "fir_text"
            assert rel.source_record_id == f"firs:{fir_id}"
            assert rel.fir_id == fir_id
            assert rel.extraction_method.startswith("rule:")
            assert 0 <= rel.character_start < rel.character_end <= len(analysis.narrative)
            assert 0.0 < rel.confidence <= 1.0
            assert "trigger_text" in rel.attributes
            assert rel.attributes["trigger_text"] in analysis.narrative


def test_relationship_confidence_uses_the_documented_tiers(nlp_service):
    allowed = {CONF_REL_EXPLICIT, CONF_REL_HEDGED, CONF_REL_SOFT_PLACEMENT}
    for fir_id in range(1, 301):
        for rel in nlp_service.get_analysis(fir_id).relationships:
            assert rel.confidence in allowed


def test_relationships_are_unique_within_a_fir(nlp_service):
    for fir_id in range(1, 301):
        keys = [
            (r.relationship_type, r.source_entity_id, r.target_entity_id,
             r.character_start, r.character_end)
            for r in nlp_service.get_analysis(fir_id).relationships
        ]
        assert len(keys) == len(set(keys))


def test_no_corpus_relationship_was_dropped_by_validation(nlp_service):
    assert nlp_service.relation_extractor.dropped == []


def test_self_referential_fir_keeps_its_relationship(nlp_service):
    """FIR 162 names one person as both complainant and suspect.

    Extraction reports what the text says; only integration refuses the edge.
    """
    rels = nlp_service.get_analysis(162).relationships
    reported = next(r for r in rels if r.relationship_type is NarrativeEdgeType.REPORTED_AGAINST)
    assert reported.source_entity_id == reported.target_entity_id == "person:325"


# --- co-occurrence is not a relationship -------------------------------------
def test_two_people_in_one_sentence_without_a_trigger_yields_nothing(repo, settings):
    text = "Chavvi Anne and Gunbir Sankar are both residents of Jaipur, Rajasthan."
    assert _relations(repo, settings, text) == []


def test_a_trigger_does_not_bind_across_a_sentence_boundary(repo, settings):
    text = "Chavvi Anne called the police. Gunbir Sankar fled the area."
    assert _relations(repo, settings, text) == []


def test_same_party_on_both_sides_of_a_trigger_asserts_nothing(repo, settings):
    text = "Suspect Gunbir Sankar was named in the complaint. The accused contacted the suspect."
    assert _relations(repo, settings, text) == []


# --- the implemented-but-unused rules do fire on explicit text ---------------
def test_called_rule(repo, settings):
    rels = _relations(repo, settings, "Chavvi Anne called Gunbir Sankar on 2026-06-08.")
    assert len(rels) == 1
    rel = rels[0]
    assert rel.relationship_type is NarrativeEdgeType.CALLED
    assert (rel.source_entity_id, rel.target_entity_id) == (CHAVVI, GUNBIR)
    assert rel.directed is True
    assert rel.confidence == CONF_REL_EXPLICIT
    assert rel.attributes["trigger_text"] == "called"
    assert rel.attributes["narrative_date"] == "2026-06-08"


def test_met_rule_is_undirected(repo, settings):
    rels = _relations(repo, settings, "Chavvi Anne met Gunbir Sankar on 2026-06-08.")
    assert _types(rels) == [NarrativeEdgeType.MET]
    assert rels[0].directed is False


def test_transferred_to_rule_requires_money_in_the_sentence(repo, settings):
    with_money = _relations(
        repo, settings, "Chavvi Anne transferred Rs. 5,000 to Gunbir Sankar."
    )
    assert _types(with_money) == [NarrativeEdgeType.TRANSFERRED_TO]
    assert with_money[0].source_entity_id == CHAVVI
    assert with_money[0].target_entity_id == GUNBIR

    without_money = _relations(
        repo, settings, "Chavvi Anne transferred the documents to Gunbir Sankar."
    )
    assert without_money == []


def test_association_rule_confidence_reflects_hedging(repo, settings):
    plain = _relations(repo, settings, "Chavvi Anne is associated with Gunbir Sankar.")
    assert _types(plain) == [NarrativeEdgeType.ASSOCIATED_WITH]
    assert plain[0].confidence == CONF_REL_EXPLICIT
    assert "hedged" not in plain[0].attributes

    hedged = _relations(repo, settings, "Chavvi Anne is known to associate with Gunbir Sankar.")
    assert hedged[0].confidence == CONF_REL_HEDGED
    assert hedged[0].attributes["hedged"] is True


def test_placement_at_a_named_location_is_stronger_than_near(repo, settings):
    at_text = "Suspect Gunbir Sankar was seen at Jaipur, Rajasthan."
    at_rel = next(
        r for r in _relations(repo, settings, at_text)
        if r.relationship_type is NarrativeEdgeType.LOCATED_AT
    )
    assert at_rel.confidence == CONF_REL_EXPLICIT
    assert at_rel.attributes["proximity"] == "at"
    assert at_rel.attributes["target_bound_via"] == "mention"
    assert at_rel.target_entity_id == "location:143"

    near_text = "Suspect Gunbir Sankar was seen near Jaipur, Rajasthan."
    near_rel = next(
        r for r in _relations(repo, settings, near_text)
        if r.relationship_type is NarrativeEdgeType.LOCATED_AT
    )
    assert near_rel.confidence == CONF_REL_SOFT_PLACEMENT
    assert near_rel.attributes["proximity"] == "near"


def test_placement_without_a_bindable_target_yields_nothing(repo, settings):
    text = "Suspect Gunbir Sankar was seen near a parked vehicle."
    assert [
        r for r in _relations(repo, settings, text)
        if r.relationship_type is NarrativeEdgeType.LOCATED_AT
    ] == []


def test_reported_against_needs_both_role_markers(repo, settings):
    """Only one role present → the rule must not fire."""
    text = "Suspect Gunbir Sankar was named in the complaint."
    assert [
        r for r in _relations(repo, settings, text)
        if r.relationship_type is NarrativeEdgeType.REPORTED_AGAINST
    ] == []


def test_empty_narrative_yields_no_relationships(repo):
    assert RelationExtractor(repo).extract(1, "", []) == []


def test_relationship_extraction_is_deterministic(repo, settings):
    text = "Chavvi Anne called Gunbir Sankar on 2026-06-08."
    assert _relations(repo, settings, text) == _relations(repo, settings, text)


# --- relationship-level validation gate --------------------------------------
NARRATIVE = "Chavvi Anne called Gunbir Sankar on 2026-06-08."


def _rel(**overrides) -> NarrativeRelationship:
    base = dict(
        relationship_type=NarrativeEdgeType.CALLED,
        fir_id=1,
        directed=True,
        source_entity_id=CHAVVI,
        target_entity_id=GUNBIR,
        source_mention="Chavvi Anne",
        target_mention="Gunbir Sankar",
        confidence=1.0,
        evidence_text=NARRATIVE,
        character_start=0,
        character_end=32,
        extraction_method="rule:call_trigger",
        source_dataset="fir_text",
        source_record_id="firs:1",
    )
    base.update(overrides)
    return NarrativeRelationship(**base)


def test_validate_relationship_accepts_a_well_formed_relationship():
    from app.nlp.validators import validate_relationship

    ok, reason = validate_relationship(_rel(), NARRATIVE)
    assert ok and reason is None


@pytest.mark.parametrize(
    "overrides,fragment",
    [
        ({"source_dataset": "persons"}, "source_dataset='fir_text'"),
        ({"source_record_id": "firs:2"}, "source_record_id must be"),
        ({"confidence": 0.0}, "confidence outside"),
        ({"character_end": 0}, "empty character span"),
        ({"character_end": 10_000}, "outside narrative bounds"),
        ({"evidence_text": "   "}, "empty evidence_text"),
        ({"target_mention": ""}, "missing endpoint mention"),
    ],
)
def test_validate_relationship_rejections(overrides, fragment):
    from app.nlp.validators import validate_relationship

    ok, reason = validate_relationship(_rel(**overrides), NARRATIVE)
    assert not ok
    assert fragment in reason


def test_validate_relationship_permits_self_loops_and_unresolved_endpoints():
    """Both are legitimate EXTRACTION output; integration owns the refusal."""
    from app.nlp.validators import validate_relationship

    ok, _ = validate_relationship(_rel(target_entity_id=CHAVVI), NARRATIVE)
    assert ok
    ok, _ = validate_relationship(_rel(target_entity_id=None), NARRATIVE)
    assert ok
