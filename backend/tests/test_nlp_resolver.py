"""Phase 3 — entity resolution (spec §5).

Real-corpus assertions use the built service; the ambiguity / threshold / failure
branches are driven by a small ``StubRepo`` because the supplied dataset happens
to contain no duplicate names, phones, or Aadhaar numbers.
"""
from __future__ import annotations

import pytest

from app.config import Settings
from app.nlp.models import (
    CONF_RES_FIR_CONTEXT,
    CONF_RES_IDENTIFIER,
    CONF_RES_UNIQUE_NAME,
    EntityType,
    ExtractedEntity,
    ExtractionMethod,
    ResolutionStatus,
)
from app.nlp.resolver import EntityResolver


def _entity(
    entity_type: EntityType,
    normalized_value: str,
    *,
    raw_text: str | None = None,
    fir_id: int = 500,
    role: str | None = None,
) -> ExtractedEntity:
    text = raw_text if raw_text is not None else normalized_value
    return ExtractedEntity(
        entity_type=entity_type,
        raw_text=text,
        normalized_value=normalized_value,
        confidence=1.0,
        fir_id=fir_id,
        character_start=0,
        character_end=len(text),
        extraction_method=ExtractionMethod.KNOWN_RECORD,
        evidence_text=text,
        role=role,
    )


class StubRepo:
    """Minimal repository surface used by EntityResolver (persons/locations/FIRs)."""

    def __init__(self, persons: list[dict], locations: list[dict], firs: list[dict]) -> None:
        self.persons = persons
        self.locations = locations
        self.firs = firs

    def get_person(self, person_id: int):
        return next((p for p in self.persons if p["person_id"] == person_id), None)

    def get_location(self, location_id: int):
        return next((l for l in self.locations if l["location_id"] == location_id), None)

    def get_fir(self, fir_id: int):
        return next((f for f in self.firs if f["fir_id"] == fir_id), None)


def _person(pid: int, name: str, phone: str, aadhar: str, location_id: int = 1) -> dict:
    return {
        "person_id": pid,
        "name": name,
        "phone": phone,
        "aadhar": aadhar,
        "address": "1 Test Road",
        "city": "Jaipur",
        "state": "Rajasthan",
        "location_id": location_id,
        "ring_id": None,
    }


def _location(lid: int, city: str = "Jaipur", state: str = "Rajasthan") -> dict:
    return {
        "location_id": lid,
        "state": state,
        "city": city,
        "latitude": 26.9,
        "longitude": 75.8,
        "canonical_lat": 26.9,
        "canonical_lng": 75.8,
    }


def _fir(fir_id: int, complainant_id: int, accused_id: int, location_id: int) -> dict:
    return {
        "fir_id": fir_id,
        "date": "2026-06-08",
        "complainant_id": complainant_id,
        "accused_id": accused_id,
        "location_id": location_id,
        "narrative": "stub",
    }


@pytest.fixture
def stub_settings():
    return Settings()


def _twin_repo(fir: dict) -> StubRepo:
    """Two DIFFERENT people who share a name — the merge hazard from spec §5."""
    return StubRepo(
        persons=[
            _person(1, "Rohan Mehta", "+91-9111111111", "111111111111"),
            _person(2, "Rohan Mehta", "+91-9222222222", "222222222222"),
        ],
        locations=[_location(1)],
        firs=[fir],
    )


# --- real corpus -------------------------------------------------------------
def test_fir1_resolutions(nlp_service):
    resolved = nlp_service.get_analysis(1).resolved_entities
    got = [
        (r.entity.entity_type.value, r.resolution.status.value,
         r.resolution.matched_entity_id, r.resolution.resolution_method)
        for r in resolved
    ]
    assert got == [
        ("DATE", "not_applicable", None, None),
        ("PERSON", "resolved", "person:489", "normalized_name"),
        ("AADHAAR", "resolved", "aadhaar:316148459341", "structured_identifier"),
        ("LOCATION", "resolved", "location:143", "fir_context_location"),
        ("PERSON", "resolved", "person:21", "normalized_name"),
        ("PHONE", "resolved", "phone:+91-8298229437", "structured_identifier"),
    ]


def test_fir1_resolution_confidences(nlp_service):
    by_type = {
        r.entity.entity_type: r.resolution
        for r in nlp_service.get_analysis(1).resolved_entities
    }
    assert by_type[EntityType.PHONE].confidence == CONF_RES_IDENTIFIER
    assert by_type[EntityType.AADHAAR].confidence == CONF_RES_IDENTIFIER
    assert by_type[EntityType.PERSON].confidence == CONF_RES_UNIQUE_NAME
    # City/state alone maps to many rows; the FIR's own location_id decides.
    assert by_type[EntityType.LOCATION].confidence == CONF_RES_FIR_CONTEXT


def test_resolutions_carry_evidence_source_records(nlp_service):
    for r in nlp_service.get_analysis(1).resolved_entities:
        if r.resolution.status is ResolutionStatus.RESOLVED:
            assert r.resolution.evidence
            assert all(":" in ref for ref in r.resolution.evidence)


def test_date_is_not_applicable_with_an_explanation(nlp_service):
    date = next(
        r for r in nlp_service.get_analysis(1).resolved_entities
        if r.entity.entity_type is EntityType.DATE
    )
    assert date.resolution.status is ResolutionStatus.NOT_APPLICABLE
    assert date.resolution.matched_entity_id is None
    assert "no DATE/EVENT node type" in date.resolution.reason


@pytest.mark.parametrize(
    "etype", [EntityType.DATE, EntityType.MONEY, EntityType.VEHICLE, EntityType.ORGANIZATION]
)
def test_non_graph_types_are_not_applicable(repo, stub_settings, etype):
    resolution = EntityResolver(repo, stub_settings).resolve(_entity(etype, "x"))
    assert resolution.status is ResolutionStatus.NOT_APPLICABLE
    assert resolution.reason


def test_every_resolved_id_exists_in_the_structured_graph(nlp_service, store):
    checked = 0
    for fir_id in range(1, 301):
        for r in nlp_service.get_analysis(fir_id).resolved_entities:
            if r.resolution.status is ResolutionStatus.RESOLVED:
                assert store.get_node(r.resolution.matched_entity_id) is not None
                checked += 1
    assert checked == 1500


def test_corpus_has_no_unresolved_or_ambiguous_mentions(nlp_service):
    """Honest reporting: this templated corpus yields no ambiguity (see docs §Limits)."""
    counts = {s: 0 for s in ResolutionStatus}
    for fir_id in range(1, 301):
        for r in nlp_service.get_analysis(fir_id).resolved_entities:
            counts[r.resolution.status] += 1
    assert counts[ResolutionStatus.UNRESOLVED] == 0
    assert counts[ResolutionStatus.AMBIGUOUS] == 0
    assert counts[ResolutionStatus.RESOLVED] == 1500
    assert counts[ResolutionStatus.NOT_APPLICABLE] == 300


# --- ambiguity is never silently merged --------------------------------------
def test_shared_name_with_unrelated_fir_is_ambiguous(stub_settings):
    repo = _twin_repo(_fir(500, complainant_id=9, accused_id=8, location_id=1))
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta")
    )
    assert resolution.status is ResolutionStatus.AMBIGUOUS
    assert resolution.ambiguous is True
    assert resolution.matched_entity_id is None
    assert resolution.candidates == ["person:1", "person:2"]
    assert "merging distinct people" in resolution.reason


def test_shared_name_resolved_by_the_firs_own_role_reference(stub_settings):
    repo = _twin_repo(_fir(500, complainant_id=9, accused_id=2, location_id=1))
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta", role="accused")
    )
    assert resolution.status is ResolutionStatus.RESOLVED
    assert resolution.matched_entity_id == "person:2"
    assert resolution.resolution_method == "fir_context_role"
    assert resolution.confidence == CONF_RES_FIR_CONTEXT
    assert resolution.candidates == ["person:1", "person:2"]  # ambiguity stays visible
    assert "firs:500" in resolution.evidence


def test_shared_name_resolved_by_either_party_when_no_role_is_known(stub_settings):
    repo = _twin_repo(_fir(500, complainant_id=1, accused_id=8, location_id=1))
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta")
    )
    assert resolution.status is ResolutionStatus.RESOLVED
    assert resolution.resolution_method == "fir_context_party"


def test_shared_name_stays_ambiguous_when_the_fir_names_both_twins(stub_settings):
    repo = _twin_repo(_fir(500, complainant_id=1, accused_id=2, location_id=1))
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta")
    )
    assert resolution.status is ResolutionStatus.AMBIGUOUS
    assert resolution.candidates == ["person:1", "person:2"]


def test_shared_name_with_a_missing_fir_is_ambiguous(stub_settings):
    repo = _twin_repo(_fir(500, 1, 2, 1))
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta", fir_id=99999)
    )
    assert resolution.status is ResolutionStatus.AMBIGUOUS


def test_duplicate_phone_is_ambiguous_not_merged(stub_settings):
    repo = StubRepo(
        persons=[
            _person(1, "Rohan Mehta", "+91-9111111111", "111111111111"),
            _person(2, "Isha Verma", "+91-9111111111", "222222222222"),
        ],
        locations=[_location(1)],
        firs=[_fir(500, 1, 2, 1)],
    )
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PHONE, "9111111111", raw_text="+91-9111111111")
    )
    assert resolution.status is ResolutionStatus.AMBIGUOUS
    assert resolution.matched_entity_id is None
    assert len(resolution.candidates) == 2
    assert "not merged" in resolution.reason


# --- unresolved branches ------------------------------------------------------
def test_unknown_name_is_unresolved_and_no_fuzzy_matching_is_attempted(repo, stub_settings):
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.PERSON, "Zebulon Qwertyson", fir_id=1)
    )
    assert resolution.status is ResolutionStatus.UNRESOLVED
    assert resolution.matched_entity_id is None
    assert "no fuzzy name matching" in resolution.reason


def test_unknown_phone_and_aadhaar_are_unresolved(repo, stub_settings):
    resolver = EntityResolver(repo, stub_settings)
    phone = resolver.resolve(_entity(EntityType.PHONE, "9000000001"))
    assert phone.status is ResolutionStatus.UNRESOLVED
    assert "matches no person record" in phone.reason
    aadhaar = resolver.resolve(_entity(EntityType.AADHAAR, "999999999999"))
    assert aadhaar.status is ResolutionStatus.UNRESOLVED


def test_unknown_place_is_unresolved(repo, stub_settings):
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.LOCATION, "Atlantis, Nowhere", fir_id=1)
    )
    assert resolution.status is ResolutionStatus.UNRESOLVED
    assert "matches no location record" in resolution.reason


def test_threshold_downgrades_a_weaker_tier_to_unresolved():
    """Raising the floor above the FIR-context tier must NOT resolve at 0.9."""
    repo = _twin_repo(_fir(500, complainant_id=9, accused_id=2, location_id=1))
    strict = Settings(nlp_resolution_min_confidence=0.95)
    resolution = EntityResolver(repo, strict).resolve(
        _entity(EntityType.PERSON, "Rohan Mehta", role="accused")
    )
    assert resolution.status is ResolutionStatus.UNRESOLVED
    assert resolution.matched_entity_id is None
    assert resolution.resolution_method == "fir_context_role"
    assert "below the configured minimum of 0.95" in resolution.reason


def test_threshold_does_not_affect_identifier_tier():
    repo = _twin_repo(_fir(500, 1, 2, 1))
    strict = Settings(nlp_resolution_min_confidence=0.95)
    resolution = EntityResolver(repo, strict).resolve(
        _entity(EntityType.PHONE, "9111111111", raw_text="+91-9111111111")
    )
    assert resolution.status is ResolutionStatus.RESOLVED
    assert resolution.confidence == CONF_RES_IDENTIFIER


# --- locations ----------------------------------------------------------------
def test_shared_place_resolved_by_the_firs_own_location_id(stub_settings):
    repo = StubRepo(
        persons=[_person(1, "Rohan Mehta", "+91-9111111111", "111111111111")],
        locations=[_location(1), _location(2)],
        firs=[_fir(500, 1, 1, location_id=2)],
    )
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.LOCATION, "Jaipur, Rajasthan")
    )
    assert resolution.status is ResolutionStatus.RESOLVED
    assert resolution.matched_entity_id == "location:2"
    assert resolution.resolution_method == "fir_context_location"
    assert resolution.candidates == ["location:1", "location:2"]


def test_shared_place_is_ambiguous_when_the_fir_points_elsewhere(stub_settings):
    repo = StubRepo(
        persons=[_person(1, "Rohan Mehta", "+91-9111111111", "111111111111")],
        locations=[_location(1), _location(2), _location(3, city="Pune", state="Maharashtra")],
        firs=[_fir(500, 1, 1, location_id=3)],
    )
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.LOCATION, "Jaipur, Rajasthan")
    )
    assert resolution.status is ResolutionStatus.AMBIGUOUS
    assert resolution.candidates == ["location:1", "location:2"]


def test_unique_place_resolves_on_the_normalized_tier(stub_settings):
    repo = StubRepo(
        persons=[_person(1, "Rohan Mehta", "+91-9111111111", "111111111111")],
        locations=[_location(7)],
        firs=[_fir(500, 1, 1, location_id=7)],
    )
    resolution = EntityResolver(repo, stub_settings).resolve(
        _entity(EntityType.LOCATION, "Jaipur, Rajasthan")
    )
    assert resolution.resolution_method == "normalized_place"
    assert resolution.confidence == CONF_RES_UNIQUE_NAME


# --- identifier helpers used by relationship extraction ----------------------
def test_person_by_identifier_returns_none_when_not_unique(stub_settings):
    repo = StubRepo(
        persons=[
            _person(1, "Rohan Mehta", "+91-9111111111", "111111111111"),
            _person(2, "Isha Verma", "+91-9111111111", "111111111111"),
        ],
        locations=[_location(1)],
        firs=[_fir(500, 1, 2, 1)],
    )
    resolver = EntityResolver(repo, stub_settings)
    assert resolver.person_by_phone("9111111111") is None
    assert resolver.person_by_aadhaar("111111111111") is None
    assert resolver.person_by_phone("9000000000") is None


def test_person_by_identifier_returns_the_unique_record(repo, stub_settings):
    resolver = EntityResolver(repo, stub_settings)
    person = resolver.person_by_phone("8298229437")
    assert person is not None and person["person_id"] == 21
