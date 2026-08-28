"""Phase 4 engine tests: detection, scoring, determinism, evidence discipline.

These run against the real synthetic corpus, so the numbers they assert are the
corpus's own. Where a category could legitimately be empty, the test says so
rather than demanding a detection — §10 requires zero to be reportable as zero,
and a test that forced a non-zero result would be exactly the pressure to lower a
threshold that the spec forbids.
"""
from __future__ import annotations

import math
import re

import pytest

from app.config import get_settings
from app.core.errors import NotFoundError
from app.graph.service import build_graph_service
from app.repositories.dataset import DatasetRepository
from app.risk.detectors import (
    STATUS_HIGH_ACTIVITY,
    STATUS_INSUFFICIENT_BASELINE,
    STATUS_NO_ANOMALY,
    CommunicationAnomalyDetector,
    MultiChannelDetector,
    TransactionPatternDetector,
)
from app.risk.models import (
    EVIDENCE_NLP_DERIVED,
    EVIDENCE_STRUCTURED,
    PATTERN_FEATURE,
    PatternType,
    band_for,
    make_pattern_id,
)
from app.risk.scoring import BRIDGE_METRICS, NETWORK_IMPORTANCE_METRICS
from app.risk.service import build_intelligence_service

# Claims Phase 4 is never allowed to make.
FORBIDDEN = (
    "is a criminal",
    "are criminals",
    "criminal network confirmed",
    "criminal activity confirmed",
    "confirmed criminal",
    "fraud confirmed",
    "confirmed fraud",
    "money laundering detected",
    "guilty",
    "convicted",
    "perpetrator",
)

# Loaded words that may appear only inside an explicit denial, never asserted.
SENSITIVE = ("laundering", "fraud", "criminal")

_NEGATION = re.compile(r"\b(?:not|no|never|cannot|without|neither|nor)\b")


def _assert_neutral(text: str) -> None:
    """No accusation, and no loaded word used except to deny it.

    Negated sentences are dropped before the check, because the honest
    disclaimers Phase 4 is *required* to emit ("no claim of laundering, fraud or
    confirmed criminal activity is made or implied", "not a probability of
    criminality") legitimately contain the very words that must never be
    asserted. What is left is everything Phase 4 states affirmatively.
    """
    low = (text or "").lower()
    asserted = " ".join(
        part for part in re.split(r"[.;]", low) if not _NEGATION.search(part)
    )
    for phrase in FORBIDDEN:
        assert phrase not in asserted, (
            f"over-claiming phrase leaked: {phrase!r} in {text!r}"
        )
    for word in SENSITIVE:
        assert word not in asserted, (
            f"{word!r} asserted rather than disclaimed: {text!r}"
        )
    if "wrongdoing" in low:
        assert "not proof of wrongdoing" in low


def patterns_of(service, ptype: PatternType):
    return [p for p in service.patterns if p.pattern_type == ptype]


# --- §1 multi-channel relationships -----------------------------------------


def test_multi_channel_patterns_count_channels_not_records(intelligence):
    found = patterns_of(intelligence, PatternType.MULTI_CHANNEL_RELATIONSHIP)
    assert found, "the corpus does contain multi-channel pairs"
    for pattern in found:
        assert len(pattern.entity_ids) == 2
        assert pattern.entity_ids[0] != pattern.entity_ids[1]
        channels = pattern.detail["channels"]
        assert len(channels) == pattern.detail["channel_count"] >= 2
        assert len(set(channels)) == len(channels)
        assert set(channels) <= {"CALL", "TRANSACTION", "FIR", "CO_LOCATION"}
        # Each channel names its own records, and no record is shared between two
        # channels — that is what "do not count the same evidence twice" means
        # here, and it holds because each channel reads a different table.
        seen: set[str] = set()
        for detail in pattern.detail["channel_detail"].values():
            ids = set(detail["evidence_ids"])
            assert ids, "a channel with no cited records"
            assert not (ids & seen), "the same record was counted under two channels"
            seen |= ids
        _assert_neutral(pattern.explanation)


def test_multi_channel_pairs_rest_on_several_datasets(intelligence):
    for pattern in patterns_of(intelligence, PatternType.MULTI_CHANNEL_RELATIONSHIP):
        assert (
            len(pattern.source_datasets) >= 2
        ), "independent channels should come from independent tables"
        assert pattern.structured_evidence
        for item in pattern.structured_evidence:
            assert item.evidence_class == EVIDENCE_STRUCTURED
            assert item.confidence == 1.0
            assert item.confidence_basis == "structured_record"
            assert ":" in item.source_record_id


def test_multi_channel_min_channels_is_enforced(store, settings):
    detector = MultiChannelDetector(store, settings, None)
    for pattern in detector.detect():
        assert (
            pattern.detail["channel_count"]
            >= settings.intel_multi_channel_min_channels
        )


# --- §2 communication anomaly ------------------------------------------------


def test_anomaly_baselines_report_insufficient_data_honestly(intelligence, settings):
    coverage = intelligence.communication.coverage()
    assert coverage["by_status"].get(STATUS_INSUFFICIENT_BASELINE, 0) > 0
    assert (
        coverage["min_observations_required"]
        == settings.intel_anomaly_min_observations
    )
    assert coverage["z_threshold"] == settings.intel_anomaly_z_threshold
    for base in intelligence.communication.baselines().values():
        if base.status == STATUS_INSUFFICIENT_BASELINE:
            # No invented baseline, therefore no invented anomaly.
            assert base.mean is None and base.stdev is None and base.z_score is None
            assert base.call_ids == []
            assert base.observation_days < settings.intel_anomaly_min_observations


def test_anomaly_flags_only_high_activity_above_the_z_threshold(intelligence, settings):
    threshold = settings.intel_anomaly_z_threshold
    for base in intelligence.communication.baselines().values():
        if base.status == STATUS_HIGH_ACTIVITY:
            assert base.z_score > threshold
            assert base.observed_count > base.mean  # HIGH, never low
            assert base.excess > 0
        elif base.status == STATUS_NO_ANOMALY:
            assert base.z_score is not None and base.z_score <= threshold


def test_low_activity_is_never_flagged(intelligence):
    """A quiet person is not a suspicious person."""
    for base in intelligence.communication.baselines().values():
        if base.status == STATUS_HIGH_ACTIVITY:
            # The flagged day is the person's own peak, by construction.
            assert base.observed_count == base.max_daily
            assert base.observed_count >= base.min_daily


def test_anomaly_patterns_cite_the_calls_of_the_peak_day(intelligence, repo):
    found = patterns_of(intelligence, PatternType.COMMUNICATION_ANOMALY)
    assert found
    for pattern in found:
        detail = pattern.detail
        assert detail["anomaly_status"] == STATUS_HIGH_ACTIVITY
        cited = detail["supporting_call_ids"]
        assert len(cited) == detail["observed_count"]
        for call_id in cited:
            call = repo.get_call(call_id)
            assert call is not None
            assert str(call["start_time"]).startswith(detail["peak_date"])
            # §6: a self-call is not communication activity.
            assert call["caller_id"] != call["callee_id"]
        _assert_neutral(pattern.explanation)


def test_anomaly_baseline_excludes_implicit_zero_days(repo, settings):
    """The baseline is built from observed days only, and says so.

    Folding every silent calendar day in as a zero would turn a sparsely sampled
    corpus into a spike generator. The detector's documented method promises not
    to; this holds it to that.
    """
    detector = CommunicationAnomalyDetector(repo, settings)
    base = max(
        (b for b in detector.baselines().values() if b.status == STATUS_HIGH_ACTIVITY),
        key=lambda b: (b.observation_days, b.person_id),
    )
    assert base.min_daily >= 1  # a zero-call day would mean zeros were folded in
    assert base.observation_days <= 31  # the corpus spans about a month


def test_anomaly_reports_absolute_excess_next_to_the_z_score(intelligence):
    """The measured limitation is disclosed, not hidden (§2).

    Daily volumes in this corpus are tiny, so a two-call day can clear z > 2
    while sitting one call above baseline. Both numbers travel together.
    """
    coverage = intelligence.communication.coverage()
    flagged = coverage["by_status"].get(STATUS_HIGH_ACTIVITY, 0)
    material = coverage["high_activity_materially_significant"]
    assert flagged > 0
    assert 0 <= material <= flagged
    for pattern in patterns_of(intelligence, PatternType.COMMUNICATION_ANOMALY):
        assert pattern.detail["excess_over_baseline"] is not None
        assert "materially_significant" in pattern.detail
        assert "absolute excess" in pattern.explanation


# --- §3 transaction patterns -------------------------------------------------


def test_transaction_cycles_return_to_their_origin(intelligence, repo, settings):
    cycles = patterns_of(intelligence, PatternType.TRANSACTION_CYCLE)
    assert cycles, "the corpus does contain closed transaction circuits"
    for pattern in cycles:
        members = pattern.detail["members"]
        assert len(members) == len(set(members)) >= 2
        assert len(members) <= settings.intel_txn_cycle_max_length
        legs = pattern.detail["legs"]
        assert len(legs) == len(members)
        # Each leg starts where the previous ended, and the last one closes.
        for i, leg in enumerate(legs):
            assert leg["from"] == members[i]
            assert leg["to"] == members[(i + 1) % len(members)]
            assert leg["evidence_ids"]
        for item in pattern.structured_evidence:
            txn = repo.get_transaction(int(item.source_record_id.split(":")[1]))
            assert txn is not None
            assert txn["sender_id"] != txn["receiver_id"]  # §6
        _assert_neutral(pattern.explanation)


def test_fan_in_and_fan_out_meet_their_thresholds(intelligence, settings):
    fan_in = patterns_of(intelligence, PatternType.TRANSACTION_FAN_IN)
    fan_out = patterns_of(intelligence, PatternType.TRANSACTION_FAN_OUT)
    assert fan_in and fan_out
    for pattern in fan_in:
        assert pattern.detail["direction"] == "fan_in"
        assert pattern.detail["counterparty_count"] >= settings.intel_txn_fan_in_min
    for pattern in fan_out:
        assert pattern.detail["direction"] == "fan_out"
        assert pattern.detail["counterparty_count"] >= settings.intel_txn_fan_out_min
    for pattern in fan_in + fan_out:
        hub = pattern.detail["hub"]
        counterparties = pattern.detail["counterparties"]
        assert hub not in counterparties  # §6
        assert len(counterparties) == len(set(counterparties))
        assert pattern.detail["counterparty_count"] == len(counterparties)
        assert pattern.detail["transaction_count"] >= len(counterparties)


def test_concentration_share_clears_the_configured_floor(intelligence, settings):
    for pattern in patterns_of(intelligence, PatternType.TRANSACTION_CONCENTRATION):
        detail = pattern.detail
        assert detail["share"] >= settings.intel_txn_concentration_min_share
        assert detail["transaction_count"] >= settings.intel_txn_concentration_min_txns
        assert detail["person"] != detail["counterparty"]  # §6
        assert detail["counterparty_amount_inr"] <= detail["total_amount_inr"]


def test_transaction_patterns_use_the_review_label_not_an_accusation(intelligence):
    types = (
        PatternType.TRANSACTION_CYCLE,
        PatternType.TRANSACTION_FAN_IN,
        PatternType.TRANSACTION_FAN_OUT,
        PatternType.TRANSACTION_CONCENTRATION,
    )
    seen = 0
    for ptype in types:
        for pattern in patterns_of(intelligence, ptype):
            seen += 1
            assert pattern.explanation.startswith(
                "Potential transaction pattern requiring review"
            )
            _assert_neutral(pattern.explanation)
    assert seen > 0


def test_every_transaction_detection_lists_exact_transaction_ids(intelligence):
    for pattern in intelligence.patterns:
        if not pattern.pattern_type.value.startswith("TRANSACTION_"):
            continue
        assert pattern.structured_evidence, f"{pattern.pattern_id} without evidence"
        assert all(
            item.source_dataset == "transactions"
            for item in pattern.structured_evidence
        )
        assert not pattern.nlp_evidence  # structural shapes rest on records only


def test_self_transfers_are_excluded_from_transaction_detection(repo, settings):
    detector = TransactionPatternDetector(repo, settings)
    coverage = detector.coverage()
    # Phase 1 already counts these; the detector's own count must agree with it
    # rather than with a hardcoded number. This corpus happens to have none.
    expected = repo.validation["referential_integrity"]["txns_self"]
    assert coverage["self_transfers_excluded"] == expected


# --- §4 location patterns ----------------------------------------------------


def test_location_cohorts_are_built_from_canonical_location_ids(
    intelligence, repo, settings
):
    cohorts = patterns_of(intelligence, PatternType.LOCATION_COHORT)
    assert cohorts
    for pattern in cohorts:
        members = pattern.detail["members"]
        assert (
            settings.intel_location_min_group
            <= len(members)
            <= settings.intel_location_max_group
        )
        lid = int(pattern.detail["location_entity_id"].split(":")[1])
        for eid in members:
            person = repo.get_person(int(eid.split(":")[1]))
            assert person is not None
            assert int(person["location_id"]) == lid
        cited = {e.source_record_id for e in pattern.structured_evidence}
        assert f"locations:{lid}" in cited
        # Never a proximity guess from the jittered raw coordinates.
        low = pattern.explanation.lower()
        assert "latitude" not in low and "longitude" not in low
        assert "canonical location" in low
        _assert_neutral(pattern.explanation)


def test_shared_location_pairs_are_corroborated_by_a_second_dataset(intelligence, repo):
    pairs = patterns_of(intelligence, PatternType.SHARED_LOCATION_PAIR)
    assert pairs
    for pattern in pairs:
        persons = [e for e in pattern.entity_ids if e.startswith("person:")]
        assert len(persons) == 2
        assert persons[0] != persons[1]
        assert pattern.detail["fir_count"] >= 1
        lid = int(pattern.detail["location_entity_id"].split(":")[1])
        ids = {int(p.split(":")[1]) for p in persons}
        for cite in pattern.detail["fir_ids"]:
            fir = repo.get_fir(int(cite.split(":")[1]))
            assert fir is not None
            assert int(fir["location_id"]) == lid
            assert ids & {int(fir["complainant_id"]), int(fir["accused_id"])}
            # §6: a FIR naming one person twice corroborates nothing.
            assert fir["complainant_id"] != fir["accused_id"]


def test_location_patterns_do_not_claim_contact(intelligence):
    for pattern in patterns_of(intelligence, PatternType.SHARED_LOCATION_PAIR):
        assert "Co-location is not contact" in pattern.explanation
        _assert_neutral(pattern.explanation)
    for pattern in patterns_of(intelligence, PatternType.LOCATION_COHORT):
        assert "not a proximity guess from raw coordinates" in pattern.explanation


# --- §5 bridge entities ------------------------------------------------------


def test_bridge_entities_span_more_than_one_community(intelligence, settings):
    bridges = patterns_of(intelligence, PatternType.BRIDGE_ENTITY)
    assert bridges
    for pattern in bridges:
        assert len(pattern.entity_ids) == 1
        detail = pattern.detail
        assert detail["betweenness"] > 0
        assert detail["betweenness_percentile"] >= settings.intel_bridge_percentile
        assert detail["neighbour_community_count"] >= 2
        assert detail["crossing_relationship_count"] >= 1
        assert detail["label"] == "bridge_entity"
        assert detail["is_investigation_lead"] is True


def test_bridge_language_is_structural_never_moral(intelligence):
    for pattern in patterns_of(intelligence, PatternType.BRIDGE_ENTITY):
        assert "is a bridge entity" in pattern.explanation
        assert "investigation lead" in pattern.explanation
        assert "not a determination of criminality" in pattern.explanation
        _assert_neutral(pattern.explanation)


def test_bridge_and_network_importance_read_different_metrics():
    """The metric partition that makes double-counting structurally impossible."""
    assert set(NETWORK_IMPORTANCE_METRICS).isdisjoint(BRIDGE_METRICS)
    assert set(BRIDGE_METRICS) == {"betweenness"}
    assert set(NETWORK_IMPORTANCE_METRICS) == {"degree", "pagerank"}


# --- §9 deterministic pattern ids -------------------------------------------


def test_pattern_id_is_content_addressed_and_order_independent():
    first = make_pattern_id(
        PatternType.TRANSACTION_CYCLE,
        ["person:2", "person:1"],
        ["transactions:9", "transactions:3"],
    )
    second = make_pattern_id(
        PatternType.TRANSACTION_CYCLE,
        ["person:1", "person:2"],
        ["transactions:3", "transactions:9"],
    )
    assert first == second
    # Repeated inputs cannot change the id either.
    assert first == make_pattern_id(
        PatternType.TRANSACTION_CYCLE,
        ["person:1", "person:1", "person:2"],
        ["transactions:3", "transactions:3", "transactions:9"],
    )
    # A different type, entity set, or evidence set is a different pattern.
    assert first != make_pattern_id(
        PatternType.TRANSACTION_FAN_IN,
        ["person:1", "person:2"],
        ["transactions:3", "transactions:9"],
    )
    assert first != make_pattern_id(
        PatternType.TRANSACTION_CYCLE,
        ["person:1", "person:3"],
        ["transactions:3", "transactions:9"],
    )
    assert first != make_pattern_id(
        PatternType.TRANSACTION_CYCLE, ["person:1", "person:2"], ["transactions:3"]
    )
    # No index, no uuid, no clock: a type prefix plus a 16-hex digest.
    assert first.startswith("transaction_cycle~")
    assert len(first.split("~")[1]) == 16
    int(first.split("~")[1], 16)  # raises if it is not hex


def test_pattern_ids_are_unique_and_match_their_own_content(intelligence):
    ids = [p.pattern_id for p in intelligence.patterns]
    assert len(ids) == len(set(ids))
    for pattern in intelligence.patterns:
        assert pattern.pattern_id == make_pattern_id(
            pattern.pattern_type, pattern.entity_ids, pattern.evidence_ids
        )


def test_pattern_ids_and_scores_survive_a_full_rebuild(intelligence):
    """A second engine over a second graph must agree, id for id (§9).

    The rebuild is given no narrative store, which also pins §7: NLP-derived
    evidence must not move a single score.
    """
    settings = get_settings()
    repo = DatasetRepository(settings)
    repo.load()
    graph = build_graph_service(repo, settings)
    rebuilt = build_intelligence_service(repo, settings, graph.store, graph.analytics)

    # Phase 4 reads the graph and writes nothing to it: a graph built with no
    # Phase 4 in the process has exactly the same size as the one Phase 4 used.
    assert graph.store.node_count() == intelligence.store.node_count()
    assert graph.store.edge_count() == intelligence.store.edge_count()

    assert rebuilt.pattern_counts() == intelligence.pattern_counts()
    original = {
        p.pattern_id
        for p in intelligence.patterns
        if p.pattern_type != PatternType.MULTI_CHANNEL_RELATIONSHIP
    }
    fresh = {
        p.pattern_id
        for p in rebuilt.patterns
        if p.pattern_type != PatternType.MULTI_CHANNEL_RELATIONSHIP
    }
    assert original == fresh
    for person in repo.persons:
        pid = int(person["person_id"])
        assert rebuilt.score_for(pid).score == intelligence.score_for(pid).score


# --- §6 self-reference exclusion --------------------------------------------


def _self_reference_ids(repo) -> set[str]:
    return (
        {
            f"calls:{c['call_id']}"
            for c in repo.calls
            if c["caller_id"] == c["callee_id"]
        }
        | {
            f"transactions:{t['txn_id']}"
            for t in repo.transactions
            if t["sender_id"] == t["receiver_id"]
        }
        | {
            f"firs:{f['fir_id']}"
            for f in repo.firs
            if f["complainant_id"] == f["accused_id"]
        }
    )


def test_the_corpus_really_contains_self_references(repo):
    """Guard the guard: the exclusion tests below are vacuous without these."""
    integrity = repo.validation["referential_integrity"]
    assert integrity["calls_self"] > 0
    assert integrity["firs_self"] > 0
    # This corpus has no self-transfers. Recorded as an observed fact, not as a
    # reason to weaken the exclusion — the transaction detector still filters.
    assert integrity["txns_self"] == 0
    assert _self_reference_ids(repo), "at least one self-referencing record"


def test_no_self_reference_record_appears_in_any_pattern(intelligence, repo):
    banned = _self_reference_ids(repo)
    for pattern in intelligence.patterns:
        cited = {e.source_record_id for e in pattern.evidence}
        assert not (cited & banned), (
            f"{pattern.pattern_id} rests on self-referencing records: "
            f"{sorted(cited & banned)}"
        )


def test_no_pattern_pairs_a_person_with_themselves(intelligence):
    for pattern in intelligence.patterns:
        assert len(pattern.entity_ids) == len(set(pattern.entity_ids))


def test_self_referencing_records_do_not_reach_any_score(intelligence, repo):
    banned = _self_reference_ids(repo)
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        cited = {e.source_record_id for e in score.evidence}
        assert not (cited & banned)
        for factor in score.factors:
            assert not (set(factor.evidence_ids) & banned)


def test_self_referencing_records_remain_available_as_evidence(repo):
    """Excluded from scoring is not the same as deleted (§6)."""
    self_call = next(c for c in repo.calls if c["caller_id"] == c["callee_id"])
    assert repo.get_call(int(self_call["call_id"])) is not None
    self_fir = next(f for f in repo.firs if f["complainant_id"] == f["accused_id"])
    assert repo.get_fir(int(self_fir["fir_id"])) is not None


# --- §7 structured vs NLP-derived evidence ----------------------------------


def test_evidence_classes_are_kept_separate_everywhere(intelligence):
    for pattern in intelligence.patterns:
        assert all(
            e.evidence_class == EVIDENCE_STRUCTURED
            for e in pattern.structured_evidence
        )
        assert all(
            e.evidence_class == EVIDENCE_NLP_DERIVED for e in pattern.nlp_evidence
        )
        structured_ids = {e.evidence_id for e in pattern.structured_evidence}
        nlp_ids = {e.evidence_id for e in pattern.nlp_evidence}
        assert not (structured_ids & nlp_ids)


def test_nlp_evidence_keeps_its_own_confidence_tier(intelligence):
    narrative = [
        item for pattern in intelligence.patterns for item in pattern.nlp_evidence
    ]
    if not narrative:
        pytest.skip(
            "no multi-channel pair carries narrative corroboration in this corpus"
        )
    for item in narrative:
        assert item.source_record_id.startswith("firs:")
        assert 0.0 < item.confidence <= 1.0
        assert item.confidence_basis and item.confidence_basis != "structured_record"


def test_a_narrative_channel_never_raises_the_channel_count(intelligence, repo):
    """§7: an NLP-derived edge is reported, never counted into the score."""
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        for factor in score.factors:
            if factor.feature != "multi_channel_relationship" or not factor.detail:
                continue
            # The value is driven by STRUCTURED channels only, so the count can
            # never exceed the four observed channels however much text agrees.
            assert factor.detail.get("max_channel_count", 0) <= 4
            assert isinstance(
                factor.detail.get("independent_nlp_channels_excluded_from_score", []),
                list,
            )


def test_every_evidence_item_names_its_dataset_and_record(intelligence):
    for pattern in intelligence.patterns:
        for item in pattern.evidence:
            assert item.source_dataset
            assert ":" in item.source_record_id
            assert item.confidence_basis
            assert 0.0 < item.confidence <= 1.0
            if item.evidence_class == EVIDENCE_STRUCTURED:
                assert item.source_record_id.split(":")[0] == item.source_dataset


# --- §8 priority score ------------------------------------------------------


def test_scores_are_in_range_and_bands_match_their_boundaries(
    intelligence, settings, repo
):
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        assert 0 <= score.score <= 100
        assert score.band == band_for(
            score.score,
            low_max=settings.intel_band_low_max,
            medium_max=settings.intel_band_medium_max,
        )


def test_band_boundaries_are_exactly_the_specified_ones(settings):
    assert settings.intel_band_low_max == 39
    assert settings.intel_band_medium_max == 69
    kwargs = {"low_max": 39, "medium_max": 69}
    assert band_for(0, **kwargs) == "LOW"
    assert band_for(39, **kwargs) == "LOW"
    assert band_for(40, **kwargs) == "MEDIUM"
    assert band_for(69, **kwargs) == "MEDIUM"
    assert band_for(70, **kwargs) == "HIGH"
    assert band_for(100, **kwargs) == "HIGH"


def test_feature_weights_are_configuration_driven_and_sum_to_one_hundred(
    intelligence, settings
):
    assert intelligence.scorer.weight_total == 100.0
    assert intelligence.scorer.weights == {
        "network_importance": 20.0,
        "multi_channel_relationship": 20.0,
        "transaction_patterns": 20.0,
        "communication_anomaly": 15.0,
        "location_patterns": 15.0,
        "bridge_network_structure": 10.0,
    }
    assert settings.intel_weight_network_importance == 20.0
    assert settings.intel_weight_multi_channel == 20.0
    assert settings.intel_weight_transaction == 20.0
    assert settings.intel_weight_communication == 15.0
    assert settings.intel_weight_location == 15.0
    assert settings.intel_weight_bridge == 10.0


def test_weights_that_do_not_sum_to_one_hundred_are_rejected(
    repo, settings, store, analytics
):
    """The 0-100 scale is a promise, so a mis-set weight must fail loudly."""
    broken = settings.model_copy(update={"intel_weight_bridge": 40.0})
    with pytest.raises(ValueError, match="sum to 100"):
        build_intelligence_service(repo, broken, store, analytics)


def test_each_contribution_is_its_value_times_its_cap(intelligence, repo):
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        assert len(score.factors) == 6
        for factor in score.factors:
            assert 0.0 <= factor.value <= 1.0
            assert factor.contribution == round(
                factor.value * factor.max_contribution, 2
            )
            assert factor.contribution <= factor.max_contribution


def test_score_is_the_rounded_sum_of_its_contributions(intelligence, repo):
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        total = sum(f.contribution for f in score.factors)
        assert score.score == max(0, min(100, int(math.floor(total + 0.5))))


def test_every_factor_is_explainable(intelligence, repo):
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        assert score.explanation
        _assert_neutral(score.explanation)
        assert {f.feature for f in score.factors} == set(intelligence.scorer.weights)
        for factor in score.factors:
            assert factor.explanation, f"{factor.feature} has no explanation"
            _assert_neutral(factor.explanation)
            if factor.contribution > 0 and factor.feature != "network_importance":
                assert factor.pattern_ids, f"{factor.feature} scored without a pattern"
                assert factor.evidence_ids, f"{factor.feature} scored without evidence"


def test_a_pattern_type_feeds_exactly_one_feature(intelligence):
    """The mechanism behind "no double-counting across features" (§8)."""
    assert set(PATTERN_FEATURE) == set(PatternType)
    assert set(PATTERN_FEATURE.values()) <= set(intelligence.scorer.weights)


def test_no_pattern_is_spent_on_two_features(intelligence, repo):
    for person in repo.persons:
        score = intelligence.score_for(int(person["person_id"]))
        used: set[str] = set()
        for factor in score.factors:
            assert not (set(factor.pattern_ids) & used), "a pattern was counted twice"
            used |= set(factor.pattern_ids)
        assert used <= set(score.pattern_ids)


def test_scores_carry_the_not_a_guilt_signal_disclaimer(intelligence):
    score = intelligence.score_for(1)
    assert "NOT a probability of guilt" in score.disclaimer
    assert "NOT a probability of criminality" in score.disclaimer
    assert "NOT proof of wrongdoing" in score.disclaimer


def test_a_person_with_no_patterns_scores_low_and_says_why(intelligence, repo):
    empty = [
        intelligence.score_for(int(p["person_id"]))
        for p in repo.persons
        if not intelligence.patterns_for_person(int(p["person_id"]))
    ]
    if not empty:
        pytest.skip("every person in this corpus carries at least one pattern")
    for score in empty:
        assert score.band == "LOW"
        assert not score.pattern_ids
        assert score.explanation


def test_ranking_is_deterministic_and_sorted(intelligence):
    top = intelligence.top_persons(50)
    keys = [(-s.score, s.person_id) for s in top]
    assert keys == sorted(keys)
    assert [s.person_id for s in top] == [
        s.person_id for s in intelligence.top_persons(50)
    ]


def test_band_filter_and_min_score_narrow_the_ranking(intelligence):
    medium = intelligence.top_persons(100, band="MEDIUM")
    assert all(s.band == "MEDIUM" for s in medium)
    floor = intelligence.top_persons(100, min_score=50)
    assert all(s.score >= 50 for s in floor)


def test_the_ground_truth_overlay_never_reaches_a_pattern(intelligence):
    """SAME_RING is the generator's answer key, not a feature."""
    for pattern in intelligence.patterns:
        assert "SAME_RING" not in pattern.relationship_types
        for item in pattern.evidence:
            assert "ring" not in item.source_dataset.lower()


# --- §10 zero-result honesty -------------------------------------------------


def test_zero_result_categories_are_reported_not_filled(intelligence):
    counts = intelligence.pattern_counts()
    # Every category is accounted for, whatever it found.
    assert set(counts) == {p.value for p in PatternType}
    zeros = intelligence.zero_result_categories()
    assert {z["pattern_type"] for z in zeros} == {
        ptype for ptype, count in counts.items() if count == 0
    }
    for entry in zeros:
        assert "0 detections" in entry["note"]
        assert "lowering the threshold" in entry["note"]


def test_a_category_with_no_detections_yields_an_empty_list_not_an_error(intelligence):
    for ptype in PatternType:
        found, total = intelligence.list_patterns(pattern_type=ptype, limit=5)
        assert total == intelligence.pattern_counts()[ptype.value]
        assert len(found) <= 5
        assert all(p.pattern_type == ptype for p in found)


def test_thresholds_are_the_configured_ones(settings):
    """Bands and thresholds are configuration, not demo-tuned literals."""
    assert settings.intel_anomaly_z_threshold == 2.0
    assert settings.intel_multi_channel_min_channels == 2
    assert settings.intel_txn_fan_in_min >= 2
    assert settings.intel_txn_fan_out_min >= 2
    assert 0.0 < settings.intel_txn_concentration_min_share <= 1.0
    assert 0.0 < settings.intel_bridge_percentile < 100.0


# --- lookups and errors ------------------------------------------------------


def test_unknown_person_and_pattern_ids_raise_not_found(intelligence):
    with pytest.raises(NotFoundError):
        intelligence.score_for(999999)
    with pytest.raises(NotFoundError):
        intelligence.pattern_for("transaction_cycle~deadbeefdeadbeef")


def test_pattern_lookup_round_trips_by_id(intelligence):
    for pattern in intelligence.patterns[:25]:
        assert intelligence.pattern_for(pattern.pattern_id) is pattern


def test_summary_reports_the_policies_it_follows(intelligence):
    summary = intelligence.summary()
    assert summary["phase"].startswith("4 -")
    assert summary["structured_graph_mutated"] is False
    assert "excluded from all Phase 4" in summary["self_reference_policy"]
    assert "SAME_RING" in summary["overlay_policy"]
    assert summary["feature_weight_total"] == 100.0
    assert summary["persons_scored"] == len(intelligence.repo.persons)
    assert (
        sum(summary["score_bands"]["distribution"].values())
        == summary["persons_scored"]
    )
    assert summary["score_bands"]["boundaries"] == {
        "LOW": "0-39",
        "MEDIUM": "40-69",
        "HIGH": "70-100",
    }
    assert sum(summary["patterns_by_type"].values()) == summary["patterns_detected"]
    assert "/api/v1/analytics/persons/top" in summary["ranking_note"]
    _assert_neutral(summary["disclaimer"])
