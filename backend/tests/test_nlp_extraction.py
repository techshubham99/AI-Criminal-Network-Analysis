"""Phase 3 — entity extraction, normalization, and validation.

Synthetic narratives are always run through a FRESH ``EntityExtractor`` so the
service extractor's ``dropped`` list (reported in ``/nlp/summary``) is never
polluted by test input.
"""
from __future__ import annotations

import sys

import pytest

from app.nlp import normalizer as norm
from app.nlp import validators
from app.nlp.extractor import EntityExtractor, spacy_available
from app.nlp.models import (
    CONF_ANCHORED_ONLY,
    CONF_KNOWN_RECORD,
    CONF_REGEX_STRUCTURED,
    EntityType,
    ExtractedEntity,
    ExtractionMethod,
)

FIR1_NARRATIVE = (
    "FIR No 1: On 2026-06-08 Chavvi Anne (Aadhar 316148459341) reported a theft "
    "at Jaipur, Rajasthan. Suspect Gunbir Sankar (Phone +91-8298229437) was seen "
    "near the scene."
)


@pytest.fixture
def fresh_extractor(repo):
    """A throwaway extractor for synthetic text (keeps service metrics clean)."""
    return EntityExtractor(repo)


def _by_type(entities, etype):
    return [e for e in entities if e.entity_type is etype]


def _one(entities, etype):
    found = _by_type(entities, etype)
    assert len(found) == 1, f"expected exactly one {etype.value}, got {len(found)}"
    return found[0]


# --- extraction over real FIRs ----------------------------------------------
def test_fir1_narrative_is_the_expected_record(nlp_service):
    analysis = nlp_service.get_analysis(1)
    assert analysis.narrative == FIR1_NARRATIVE


def test_fir1_extracts_all_expected_types(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    assert len(entities) == 6
    assert [e.entity_type.value for e in entities] == [
        "DATE",
        "PERSON",
        "AADHAAR",
        "LOCATION",
        "PERSON",
        "PHONE",
    ]


def test_fir1_spans_are_ascending_and_non_overlapping(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    previous_end = -1
    for e in entities:
        assert e.character_start >= previous_end
        previous_end = e.character_end


def test_every_corpus_entity_span_reproduces_raw_text(nlp_service):
    for fir_id in range(1, 301):
        analysis = nlp_service.get_analysis(fir_id)
        for r in analysis.resolved_entities:
            e = r.entity
            assert (
                analysis.narrative[e.character_start : e.character_end] == e.raw_text
            ), f"span mismatch in FIR {fir_id}: {e.raw_text!r}"


def test_every_corpus_entity_carries_all_spec_fields(nlp_service):
    for fir_id in (1, 12, 162, 300):
        for r in nlp_service.get_analysis(fir_id).resolved_entities:
            e = r.entity
            assert e.entity_type in EntityType
            assert e.raw_text and e.normalized_value
            assert 0.0 < e.confidence <= 1.0
            assert e.fir_id == fir_id
            assert e.character_end > e.character_start
            assert e.extraction_method in ExtractionMethod
            assert e.evidence_text


def test_phone_is_normalized_to_ten_digits(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    phone = _one(entities, EntityType.PHONE)
    assert phone.raw_text == "+91-8298229437"          # raw text is never lost
    assert phone.normalized_value == "8298229437"
    assert phone.extraction_method is ExtractionMethod.REGEX
    assert phone.confidence == CONF_REGEX_STRUCTURED


def test_aadhaar_is_twelve_digits(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    aadhaar = _one(entities, EntityType.AADHAAR)
    assert aadhaar.normalized_value == "316148459341"
    assert len(aadhaar.normalized_value) == 12
    assert aadhaar.extraction_method is ExtractionMethod.REGEX


def test_date_is_iso_normalized(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    date = _one(entities, EntityType.DATE)
    assert date.normalized_value == "2026-06-08"
    assert validators.is_iso_date(date.normalized_value)


def test_person_names_exclude_the_role_keyword(nlp_service):
    """"Suspect Gunbir Sankar" must extract the NAME, not the role word."""
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    people = _by_type(entities, EntityType.PERSON)
    assert [e.raw_text for e in people] == ["Chavvi Anne", "Gunbir Sankar"]
    assert [e.role for e in people] == ["complainant", "accused"]
    assert all(e.extraction_method is ExtractionMethod.KNOWN_RECORD for e in people)
    assert all(e.confidence == CONF_KNOWN_RECORD for e in people)


def test_location_is_city_state_pair(nlp_service):
    entities = [r.entity for r in nlp_service.get_analysis(1).resolved_entities]
    location = _one(entities, EntityType.LOCATION)
    assert location.raw_text == "Jaipur, Rajasthan"
    assert location.normalized_value == "Jaipur, Rajasthan"
    assert location.extraction_method is ExtractionMethod.KNOWN_RECORD


def test_evidence_text_is_the_enclosing_sentence(nlp_service):
    analysis = nlp_service.get_analysis(1)
    entities = [r.entity for r in analysis.resolved_entities]
    phone = _one(entities, EntityType.PHONE)
    assert phone.evidence_text.startswith("Suspect Gunbir Sankar")
    assert phone.evidence_text.endswith("near the scene.")
    for r in analysis.resolved_entities:
        assert r.entity.evidence_text in analysis.narrative


def test_confidence_is_a_function_of_extraction_method(nlp_service):
    """Confidence tiers are deterministic per method (spec §2 semantics)."""
    expected = {
        ExtractionMethod.REGEX: CONF_REGEX_STRUCTURED,
        ExtractionMethod.KNOWN_RECORD: CONF_KNOWN_RECORD,
        ExtractionMethod.ANCHORED_PATTERN: CONF_ANCHORED_ONLY,
    }
    for fir_id in range(1, 301):
        for r in nlp_service.get_analysis(fir_id).resolved_entities:
            e = r.entity
            assert e.confidence == expected[e.extraction_method]


def test_no_corpus_entity_was_dropped_by_validation(nlp_service):
    assert nlp_service.extractor.dropped == []


def test_extraction_is_deterministic(repo):
    a = EntityExtractor(repo).extract(1, FIR1_NARRATIVE)
    b = EntityExtractor(repo).extract(1, FIR1_NARRATIVE)
    assert a == b


def test_empty_narrative_yields_no_entities(fresh_extractor):
    assert fresh_extractor.extract(999, "") == []


def test_extraction_does_not_import_spacy(nlp_service):
    """Phase 3 is rule-based; spaCy is optional and unused (spec §3)."""
    assert isinstance(spacy_available(), bool)
    assert "spacy" not in sys.modules
    assert nlp_service.get_analysis(1).resolved_entities  # rules alone suffice


# --- extraction of types that never occur in this corpus ---------------------
def test_money_vehicle_organization_absent_from_the_whole_corpus(nlp_service):
    counts = {EntityType.MONEY: 0, EntityType.VEHICLE: 0, EntityType.ORGANIZATION: 0}
    for fir_id in range(1, 301):
        for r in nlp_service.get_analysis(fir_id).resolved_entities:
            if r.entity.entity_type in counts:
                counts[r.entity.entity_type] += 1
    assert counts == {EntityType.MONEY: 0, EntityType.VEHICLE: 0, EntityType.ORGANIZATION: 0}


@pytest.mark.parametrize(
    "text,expected",
    [
        ("A sum of Rs. 5,000 was recovered.", "5000"),
        ("A sum of ₹5,000 was recovered.", "5000"),
        ("A sum of INR 5000 was recovered.", "5000"),
        ("A sum of 5,000 rupees was recovered.", "5000"),
    ],
)
def test_money_rule_fires_on_explicit_currency(fresh_extractor, text, expected):
    money = _one(fresh_extractor.extract(9001, text), EntityType.MONEY)
    assert money.normalized_value == expected
    assert money.extraction_method is ExtractionMethod.REGEX
    assert money.confidence == CONF_REGEX_STRUCTURED


def test_money_rule_requires_a_currency_marker(fresh_extractor):
    """A bare number is not money — no magnitude is asserted without a marker."""
    assert _by_type(fresh_extractor.extract(9002, "A sum of 5000 was recovered."),
                    EntityType.MONEY) == []


def test_abbreviation_period_does_not_split_a_sentence(fresh_extractor):
    """"Rs." must not end a sentence, or evidence_text would be truncated."""
    text = "Chavvi Anne transferred Rs. 5,000 to Gunbir Sankar. She then left."
    money = _one(fresh_extractor.extract(9010, text), EntityType.MONEY)
    assert money.evidence_text == "Chavvi Anne transferred Rs. 5,000 to Gunbir Sankar."
    from app.nlp.extractor import sentence_spans

    assert [text[s:e] for s, e in sentence_spans(text)] == [
        "Chavvi Anne transferred Rs. 5,000 to Gunbir Sankar.",
        "She then left.",
    ]


def test_vehicle_rule_fires_on_a_registration_plate(fresh_extractor):
    vehicle = _one(
        fresh_extractor.extract(9003, "Vehicle MH 12 AB 1234 was seen leaving."),
        EntityType.VEHICLE,
    )
    assert vehicle.raw_text == "MH 12 AB 1234"
    assert vehicle.extraction_method is ExtractionMethod.REGEX


def test_organization_rule_requires_an_entity_suffix(fresh_extractor):
    org = _one(
        fresh_extractor.extract(9004, "The complaint names Alpha Traders as the buyer."),
        EntityType.ORGANIZATION,
    )
    assert org.raw_text == "Alpha Traders"
    assert org.extraction_method is ExtractionMethod.ANCHORED_PATTERN
    assert org.confidence == CONF_ANCHORED_ONLY
    assert _by_type(
        fresh_extractor.extract(9005, "The complaint names Alpha as the buyer."),
        EntityType.ORGANIZATION,
    ) == []


# --- conservative behaviour --------------------------------------------------
def test_unknown_name_is_anchored_only_not_known_record(fresh_extractor):
    text = "Suspect Zebulon Qwertyson (Phone +91-9000000001) was seen near the scene."
    person = _one(fresh_extractor.extract(9006, text), EntityType.PERSON)
    assert person.raw_text == "Zebulon Qwertyson"
    assert person.extraction_method is ExtractionMethod.ANCHORED_PATTERN
    assert person.confidence == CONF_ANCHORED_ONLY


def test_role_word_without_a_capitalised_name_yields_no_person(fresh_extractor):
    entities = fresh_extractor.extract(9007, "the suspect fled the area on foot.")
    assert _by_type(entities, EntityType.PERSON) == []


def test_bare_capitalised_phrase_is_not_promoted_to_a_person(fresh_extractor):
    entities = fresh_extractor.extract(9008, "The Investigating Officer visited later.")
    assert _by_type(entities, EntityType.PERSON) == []


def test_digit_run_is_not_sliced_into_a_phone(fresh_extractor):
    """The Aadhaar run must not also yield a 10-digit 'phone' substring."""
    entities = fresh_extractor.extract(9009, "Aadhar 316148459341 was produced.")
    assert len(_by_type(entities, EntityType.AADHAAR)) == 1
    assert _by_type(entities, EntityType.PHONE) == []


# --- normalizer (spec §4) ----------------------------------------------------
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("+91-98765-43210", "9876543210"),
        ("+91 98765 43210", "9876543210"),
        ("09876543210", "9876543210"),
        ("9876543210", "9876543210"),
        ("91 9876543210", "9876543210"),
    ],
)
def test_normalize_phone(raw, expected):
    assert norm.normalize_phone(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("3161 4845 9341", "316148459341"),
        ("3161-4845-9341", "316148459341"),
        ("316148459341", "316148459341"),
    ],
)
def test_normalize_aadhaar(raw, expected):
    assert norm.normalize_aadhaar(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-06-08", "2026-06-08"),
        ("08-06-2026", "2026-06-08"),
        ("8/6/2026", "2026-06-08"),
        ("8 June 2026", "2026-06-08"),
        ("June 8, 2026", "2026-06-08"),
    ],
)
def test_normalize_date(raw, expected):
    assert norm.normalize_date(raw) == expected


def test_normalize_date_falls_back_to_trimmed_raw():
    assert norm.normalize_date("  last Tuesday  ") == "last Tuesday"


@pytest.mark.parametrize(
    "raw,expected",
    [("₹5,000", "5000"), ("Rs. 5,000", "5000"), ("INR 5000", "5000"),
     ("5,000 rupees", "5000"), ("Rs 1,234.50", "1234.50")],
)
def test_normalize_money(raw, expected):
    assert norm.normalize_money(raw) == expected


def test_normalize_whitespace_and_name_and_location():
    assert norm.normalize_whitespace("  a\t b \n c ") == "a b c"
    assert norm.normalize_name("  Chavvi   Anne ") == "Chavvi Anne"
    assert norm.normalize_name("chavvi anne") == "chavvi anne"  # casing preserved
    assert norm.normalize_location(" Jaipur ,   Rajasthan ") == "Jaipur, Rajasthan"


# --- validators --------------------------------------------------------------
def test_aadhaar_validation_accepts_a_leading_one():
    """36 of 500 dataset Aadhaar values start with '1' (see validators docstring)."""
    assert validators.is_valid_aadhaar("116148459341")
    assert not validators.is_valid_aadhaar("31614845934")     # 11 digits
    assert not validators.is_valid_aadhaar("3161484593411")   # 13 digits
    assert not validators.is_valid_aadhaar("31614845934a")


def test_every_dataset_aadhaar_and_phone_passes_validation(repo):
    for p in repo.persons:
        assert validators.is_valid_aadhaar(norm.normalize_aadhaar(p["aadhar"]))
        assert validators.is_valid_phone10(norm.normalize_phone(p["phone"]))


def test_phone_validation_rules():
    assert validators.is_valid_phone10("9876543210")
    assert not validators.is_valid_phone10("5876543210")  # leading digit < 6
    assert not validators.is_valid_phone10("987654321")   # 9 digits


def test_iso_date_validation_rejects_impossible_dates():
    assert validators.is_iso_date("2026-06-08")
    assert not validators.is_iso_date("2026-02-30")
    assert not validators.is_iso_date("08-06-2026")


def test_person_name_shape_is_conservative():
    assert validators.is_plausible_person_name("Chavvi Anne")
    assert not validators.is_plausible_person_name("chavvi anne")
    assert not validators.is_plausible_person_name("A B")            # 1-char tokens
    assert not validators.is_plausible_person_name("One Two Three Four Five")


def test_every_dataset_name_passes_the_shape_rule(repo):
    for p in repo.persons:
        assert validators.is_plausible_person_name(norm.normalize_name(p["name"]))


def _entity(**overrides) -> ExtractedEntity:
    base = dict(
        entity_type=EntityType.PHONE,
        raw_text="+91-8298229437",
        normalized_value="8298229437",
        confidence=1.0,
        fir_id=1,
        character_start=126,
        character_end=140,
        extraction_method=ExtractionMethod.REGEX,
        evidence_text="Suspect Gunbir Sankar (Phone +91-8298229437) was seen near the scene.",
    )
    base.update(overrides)
    return ExtractedEntity(**base)


def test_validate_entity_accepts_a_real_mention():
    ok, reason = validators.validate_entity(_entity(), FIR1_NARRATIVE)
    assert ok and reason is None


def test_validate_entity_rejects_a_span_that_does_not_reproduce_raw_text():
    ok, reason = validators.validate_entity(
        _entity(character_start=0, character_end=14), FIR1_NARRATIVE
    )
    assert not ok
    assert "span" in reason


def test_validate_entity_rejects_out_of_bounds_and_empty_spans():
    ok, reason = validators.validate_entity(
        _entity(character_start=10_000, character_end=10_014), FIR1_NARRATIVE
    )
    assert not ok and "outside narrative bounds" in reason
    ok, reason = validators.validate_entity(
        _entity(character_start=126, character_end=126), FIR1_NARRATIVE
    )
    assert not ok and "empty character span" in reason


def test_validate_entity_rejects_out_of_range_confidence():
    ok, reason = validators.validate_entity(_entity(confidence=0.0), FIR1_NARRATIVE)
    assert not ok and "confidence" in reason
    ok, reason = validators.validate_entity(_entity(confidence=1.5), FIR1_NARRATIVE)
    assert not ok and "confidence" in reason


def test_validate_entity_rejects_a_malformed_value_per_type():
    ok, reason = validators.validate_entity(
        _entity(normalized_value="5298229437"), FIR1_NARRATIVE
    )
    assert not ok and "phone" in reason
