"""Phase 4 explanation generation.

Kept apart from :mod:`app.risk.scoring` on purpose (spec §12): the scorer decides
*what a number is*, this module decides *how that number is described*, and
neither may quietly become the other. Every sentence produced here has to be
traceable to a feature value, a contribution, a threshold, or an evidence id
that the caller already holds.

The house style for all of it: say what was observed, say what it was measured
against, and do not imply anything the records do not state. No person is
described as a criminal, a suspect, or guilty — the vocabulary is *pattern*,
*signal*, *bridge entity*, *investigation lead*, *requires review*.
"""
from __future__ import annotations

from typing import Any, Optional

from app.risk.models import (
    BAND_HIGH,
    BAND_LOW,
    BAND_MEDIUM,
    PriorityScore,
    ScoreFactor,
)

# --- Feature-level text -----------------------------------------------------

FEATURE_LABELS: dict[str, str] = {
    "network_importance": "Network importance",
    "multi_channel_relationship": "Multi-channel relationships",
    "transaction_patterns": "Transaction patterns",
    "communication_anomaly": "Communication anomaly",
    "location_patterns": "Location patterns",
    "bridge_network_structure": "Bridge / network structure",
}

BAND_MEANING: dict[str, str] = {
    BAND_LOW: (
        "LOW — nothing in the observed records distinguishes this person from the "
        "ordinary shape of the corpus. Not a clearance; simply no signal here."
    ),
    BAND_MEDIUM: (
        "MEDIUM — one or more patterns are present and worth a look, in the "
        "ordinary course of triage."
    ),
    BAND_HIGH: (
        "HIGH — several independent signals coincide on this person, so they sort "
        "to the top of a review queue. This says where to look first. It says "
        "nothing about whether anything wrong happened."
    ),
}


def explain_network_importance(
    *, degree: Optional[float], degree_pct: float, pagerank_pct: float, in_projection: bool
) -> str:
    if not in_projection:
        return (
            "No observed person-to-person relationships, so this person does not "
            "appear in the analytics projection and network importance "
            "contributes nothing."
        )
    return (
        f"Observed degree {degree} sits at the {degree_pct}th percentile and "
        f"PageRank at the {pagerank_pct}th percentile of the person projection; "
        f"the feature value is the mean of the two. Betweenness is deliberately "
        f"excluded here — it is scored once, under the bridge feature."
    )


def explain_multi_channel(
    *, channel_count: int, partner_count: int, channels: list[str], nlp_channels: list[str]
) -> str:
    if channel_count == 0:
        return (
            "No person pair involving this person is linked through two or more "
            "independent observed channels."
        )
    text = (
        f"Linked to {partner_count} other person(s) through as many as "
        f"{channel_count} independent channels ({', '.join(channels)}). Channels "
        f"are counted, not records: one channel with many records is still one "
        f"channel."
    )
    if nlp_channels:
        text += (
            f" FIR narrative text separately asserts {', '.join(sorted(set(nlp_channels)))} "
            f"for at least one of these pairs; that evidence is listed under "
            f"nlp_evidence and is excluded from this contribution."
        )
    return text


def explain_transaction(*, types: list[str], top_severity: float, detail: dict[str, Any]) -> str:
    if not types:
        return "No transaction pattern was detected for this person."
    readable = ", ".join(t.replace("TRANSACTION_", "").lower() for t in types)
    return (
        f"Potential transaction pattern(s) requiring review: {readable}. The "
        f"strongest of them scores {round(top_severity, 3)} on the 0-1 severity "
        f"scale{_txn_detail_clause(detail)}. These are shapes in the transaction "
        f"records; no claim of laundering, fraud or confirmed criminal activity "
        f"is made or implied."
    )


def _txn_detail_clause(detail: dict[str, Any]) -> str:
    bits: list[str] = []
    if detail.get("cycle_length"):
        bits.append(f"a closed circuit of {detail['cycle_length']} persons")
    if detail.get("counterparty_count"):
        bits.append(f"{detail['counterparty_count']} counterparties")
    if detail.get("share"):
        bits.append(f"{round(float(detail['share']) * 100, 1)}% value concentration")
    return f" ({'; '.join(bits)})" if bits else ""


def explain_communication(*, baseline: Optional[dict[str, Any]]) -> str:
    if baseline is None:
        return "No call records for this person, so no baseline and no anomaly."
    status = baseline.get("anomaly_status")
    if status == "insufficient_baseline_data":
        return (
            f"Insufficient baseline data: only "
            f"{baseline['baseline']['observation_days']} day(s) of observed call "
            f"activity. No baseline was invented and no anomaly is claimed."
        )
    if status == "insufficient_baseline_variance":
        return (
            "Every observed day carries the same number of calls, so the standard "
            "deviation is zero and a z-score cannot be computed. Reported as "
            "such rather than as an anomaly."
        )
    if status == "no_anomaly":
        return (
            f"Peak day {baseline['observed_count']} call(s) against a baseline of "
            f"{baseline['baseline']['mean_calls_per_active_day']}; z = "
            f"{baseline['z_score']} does not exceed the threshold. Low activity is "
            f"never flagged."
        )
    material = (
        "materially significant in absolute terms"
        if baseline.get("materially_significant")
        else "small in absolute terms, so the contribution is scaled down"
    )
    return (
        f"Unusually high activity: {baseline['observed_count']} call(s) on "
        f"{baseline['peak_date']} against this person's own baseline of "
        f"{baseline['baseline']['mean_calls_per_active_day']} per observed day "
        f"(z = {baseline['z_score']}). The excess of "
        f"{baseline['excess_over_baseline']} call(s) is {material}."
    )


def explain_location(*, cohorts: int, pairs: int, detail: dict[str, Any]) -> str:
    if not cohorts and not pairs:
        return "No shared-location pattern was detected for this person."
    bits: list[str] = []
    if cohorts:
        bits.append(
            f"registered at a canonical location shared with "
            f"{detail.get('largest_cohort_size', '?')} persons in total"
        )
    if pairs:
        bits.append(
            f"{pairs} shared-location pair(s) corroborated by FIR records filed at "
            f"that same location"
        )
    return (
        "Shared canonical location: "
        + "; ".join(bits)
        + ". Derived from the dataset's canonical location ids, never from raw "
        "coordinates. Sharing an address is not contact and asserts no meeting."
    )


def explain_bridge(*, is_bridge: bool, detail: dict[str, Any]) -> str:
    if not is_bridge:
        return (
            "Not a bridge entity: betweenness is below the configured percentile "
            "floor, or its relationships do not reach more than one detected "
            "community."
        )
    return (
        f"Bridge entity and investigation lead: betweenness at the "
        f"{detail.get('betweenness_percentile')}th percentile, with relationships "
        f"reaching {detail.get('neighbour_community_count')} distinct detected "
        f"communities. A structural position in the observed graph — not a "
        f"determination of criminality or guilt."
    )


# --- Score-level text -------------------------------------------------------


def explain_score(
    *,
    person_id: int,
    score: int,
    band: str,
    factors: list[ScoreFactor],
    structured_count: int,
    nlp_count: int,
) -> str:
    """Compose the person-level narrative from the factors that fired."""
    active = [f for f in factors if f.contribution > 0]
    active.sort(key=lambda f: (-f.contribution, f.feature))
    if not active:
        return (
            f"Investigation priority score 0 of 100 ({band}) for person:{person_id}: "
            f"no Phase 4 feature produced a contribution. The person's records "
            f"remain fully available as evidence; there is simply no pattern to "
            f"report. This is a triage signal, not a statement about the person."
        )
    parts = ", ".join(
        f"{FEATURE_LABELS.get(f.feature, f.feature)} {f.contribution} of "
        f"{f.max_contribution}"
        for f in active
    )
    return (
        f"Investigation priority score {score} of 100 ({band}) for "
        f"person:{person_id}, summed from {len(active)} contributing feature(s): "
        f"{parts}. {BAND_MEANING[band]} The score rests on {structured_count} "
        f"structured evidence item(s) and {nlp_count} NLP-derived item(s), which "
        f"are listed separately and never merged. It is an investigation-"
        f"prioritization signal only: not a probability of guilt, not a "
        f"probability of criminality, and not proof of wrongdoing."
    )


def explain_zero_result(pattern_type: str) -> str:
    """The honest report for a category that detected nothing (spec §10)."""
    return (
        f"{pattern_type}: 0 detections on this dataset. Reported as zero rather "
        f"than met by lowering the threshold or by manufacturing an example."
    )


def score_walkthrough(score: PriorityScore) -> dict[str, Any]:
    """A line-by-line audit of one score, for ``/explain``.

    Every row states the feature value, the cap, the arithmetic that produced
    the contribution, and the evidence ids the contribution rests on, so a
    reader can recompute the total by hand.
    """
    rows = []
    for factor in sorted(score.factors, key=lambda f: f.feature):
        rows.append(
            {
                "feature": factor.feature,
                "label": FEATURE_LABELS.get(factor.feature, factor.feature),
                "feature_value": factor.value,
                "max_contribution": factor.max_contribution,
                "arithmetic": (
                    f"{factor.value} x {factor.max_contribution} = "
                    f"{factor.contribution}"
                ),
                "contribution": factor.contribution,
                "pattern_ids": factor.pattern_ids,
                "evidence_ids": factor.evidence_ids,
                "explanation": factor.explanation,
                "detail": factor.detail,
            }
        )
    total = round(sum(f.contribution for f in score.factors), 2)
    return {
        "person_id": score.person_id,
        "entity_id": score.entity_id,
        "score": score.score,
        "band": score.band,
        "sum_of_contributions": total,
        "rounding": "sum of contributions rounded half-up to the nearest integer, then clamped to 0-100",
        "band_meaning": BAND_MEANING[score.band],
        "factor_walkthrough": rows,
        "structured_evidence": [e.as_dict() for e in score.structured_evidence],
        "nlp_evidence": [e.as_dict() for e in score.nlp_evidence],
        "evidence_separation_note": (
            "Structured evidence is an observed dataset record. NLP-derived "
            "evidence is a rule-extraction claim about FIR free text, carries its "
            "own extraction confidence, and does not raise this score."
        ),
        "explanation": score.explanation,
        "disclaimer": score.disclaimer,
    }
