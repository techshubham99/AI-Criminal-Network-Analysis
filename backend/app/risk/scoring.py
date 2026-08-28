"""Phase 4 scoring: six features, 0-100, deterministic and explainable.

The score is a triage ordering. It answers "whose records should an analyst open
first, given what was observed" and nothing else. It is not a probability of
guilt, not a probability of criminality, and not proof of wrongdoing — that
sentence travels with every score this module produces.

**How a score is built.** Six features, each with a configured maximum
contribution summing to exactly 100:

======================================  ====  ===============================
feature                                  max  driven by
======================================  ====  ===============================
``network_importance``                    20  Phase 2 degree + PageRank percentiles
``multi_channel_relationship``            20  §1 patterns
``transaction_patterns``                  20  §3 patterns
``communication_anomaly``                 15  §2 patterns
``location_patterns``                     15  §4 patterns
``bridge_network_structure``              10  §5 patterns
======================================  ====  ===============================

Each feature produces a value in ``[0, 1]``; the contribution is
``round(value * max, 2)``; the score is the sum rounded half-up and clamped to
``[0, 100]``. Feature values and contributions are stored separately (spec §8)
so the arithmetic is checkable line by line.

**Why double-counting cannot happen.** ``PATTERN_FEATURE`` maps every pattern
type to exactly one feature, so no pattern can be spent twice. The two graph
metrics are partitioned the same way: degree and PageRank belong to network
importance, betweenness belongs to the bridge feature, and neither feature
reads the other's metric. Within a feature, evidence ids are de-duplicated.

**Bands.** ``0-39 LOW``, ``40-69 MEDIUM``, ``70-100 HIGH`` — inclusive upper
bounds, configuration-driven, and not to be moved to make a demo look better.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Optional

from app.config import Settings
from app.graph.analytics import GraphAnalytics
from app.graph.model import person_eid
from app.risk import explain
from app.risk.detectors import CommunicationBaseline
from app.risk.models import (
    PATTERN_FEATURE,
    EvidenceRef,
    Pattern,
    PatternType,
    PriorityScore,
    ScoreFactor,
    band_for,
    dedupe_evidence,
    split_evidence,
)

FEATURES = (
    "network_importance",
    "multi_channel_relationship",
    "transaction_patterns",
    "communication_anomaly",
    "location_patterns",
    "bridge_network_structure",
)

# Metrics reserved to one feature each, so structural importance is never
# counted twice (spec §8).
NETWORK_IMPORTANCE_METRICS = ("degree", "pagerank")
BRIDGE_METRICS = ("betweenness",)


class PriorityScorer:
    """Turns detected patterns into per-person 0-100 priority scores."""

    def __init__(
        self,
        settings: Settings,
        analytics: GraphAnalytics,
        patterns: list[Pattern],
        baselines: dict[int, CommunicationBaseline],
    ) -> None:
        self.settings = settings
        self.analytics = analytics
        self.baselines = baselines
        self.weights = {
            "network_importance": settings.intel_weight_network_importance,
            "multi_channel_relationship": settings.intel_weight_multi_channel,
            "transaction_patterns": settings.intel_weight_transaction,
            "communication_anomaly": settings.intel_weight_communication,
            "location_patterns": settings.intel_weight_location,
            "bridge_network_structure": settings.intel_weight_bridge,
        }
        # Index patterns by the person entity ids they involve.
        self._by_person: dict[str, list[Pattern]] = defaultdict(list)
        for pattern in patterns:
            for eid in pattern.entity_ids:
                if eid.startswith("person:"):
                    self._by_person[eid].append(pattern)

    @property
    def weight_total(self) -> float:
        return round(sum(self.weights.values()), 6)

    def patterns_for(self, entity_id: str) -> list[Pattern]:
        return sorted(self._by_person.get(entity_id, ()), key=lambda p: p.pattern_id)

    # -- public ------------------------------------------------------------
    def score(self, person_id: int) -> PriorityScore:
        eid = person_eid(person_id)
        patterns = self.patterns_for(eid)
        grouped: dict[str, list[Pattern]] = defaultdict(list)
        for pattern in patterns:
            grouped[PATTERN_FEATURE[pattern.pattern_type]].append(pattern)

        factors = [
            self._network_importance(eid),
            self._multi_channel(eid, grouped["multi_channel_relationship"]),
            self._transaction(grouped["transaction_patterns"]),
            self._communication(person_id, grouped["communication_anomaly"]),
            self._location(eid, grouped["location_patterns"]),
            self._bridge(grouped["bridge_network_structure"]),
        ]

        total = sum(f.contribution for f in factors)
        # Half-up rounding, stated explicitly so the integer is reproducible on
        # any platform, then clamped to the mandated range.
        score = max(0, min(100, int(math.floor(total + 0.5))))
        band = band_for(
            score,
            low_max=self.settings.intel_band_low_max,
            medium_max=self.settings.intel_band_medium_max,
        )
        structured, narrative = split_evidence(
            [e for pattern in patterns for e in pattern.evidence]
        )
        return PriorityScore(
            person_id=person_id,
            entity_id=eid,
            score=score,
            band=band,
            factors=factors,
            structured_evidence=structured,
            nlp_evidence=narrative,
            pattern_ids=[p.pattern_id for p in patterns],
            explanation=explain.explain_score(
                person_id=person_id,
                score=score,
                band=band,
                factors=factors,
                structured_count=len(structured),
                nlp_count=len(narrative),
            ),
        )

    # -- features ----------------------------------------------------------
    def _factor(
        self,
        feature: str,
        value: float,
        *,
        patterns: list[Pattern] | None = None,
        evidence: list[EvidenceRef] | None = None,
        explanation: str,
        detail: Optional[dict[str, Any]] = None,
    ) -> ScoreFactor:
        cap = self.weights[feature]
        value = max(0.0, min(1.0, value))
        items = dedupe_evidence(
            evidence
            if evidence is not None
            else [e for p in (patterns or []) for e in p.evidence]
        )
        return ScoreFactor(
            feature=feature,
            value=round(value, 4),
            max_contribution=cap,
            contribution=round(round(value, 4) * cap, 2),
            pattern_ids=sorted(p.pattern_id for p in (patterns or [])),
            evidence_ids=[e.evidence_id for e in items],
            explanation=explanation,
            detail=dict(detail or {}),
        )

    def _network_importance(self, eid: str) -> ScoreFactor:
        """Relative structural prominence: degree and PageRank percentiles.

        Percentile-based on purpose — "important" here means important
        *relative to this observed population*, which is the only frame the
        data supports. Betweenness is excluded; it is the bridge feature's.
        """
        in_projection = eid in self.analytics.degree
        if not in_projection:
            return self._factor(
                "network_importance",
                0.0,
                evidence=[],
                explanation=explain.explain_network_importance(
                    degree=None, degree_pct=0.0, pagerank_pct=0.0, in_projection=False
                ),
                detail={"in_projection": False},
            )
        degree = float(self.analytics.degree.get(eid, 0.0))
        pagerank = float(self.analytics.pagerank.get(eid, 0.0))
        degree_pct = self.analytics._percentile("degree", degree)
        pagerank_pct = self.analytics._percentile("pagerank", pagerank)
        value = (degree_pct + pagerank_pct) / 200.0
        return self._factor(
            "network_importance",
            value,
            evidence=[],
            explanation=explain.explain_network_importance(
                degree=degree,
                degree_pct=degree_pct,
                pagerank_pct=pagerank_pct,
                in_projection=True,
            ),
            detail={
                "in_projection": True,
                "degree": degree,
                "degree_percentile": degree_pct,
                "pagerank": round(pagerank, 8),
                "pagerank_percentile": pagerank_pct,
                "metrics_used": list(NETWORK_IMPORTANCE_METRICS),
                "note": "betweenness is excluded here and scored once under the bridge feature",
            },
        )

    def _multi_channel(self, eid: str, patterns: list[Pattern]) -> ScoreFactor:
        """Independent channels first, breadth of partners second."""
        if not patterns:
            return self._factor(
                "multi_channel_relationship",
                0.0,
                explanation=explain.explain_multi_channel(
                    channel_count=0, partner_count=0, channels=[], nlp_channels=[]
                ),
            )
        best = max(int(p.detail.get("channel_count", 0)) for p in patterns)
        channels = sorted(
            {c for p in patterns for c in p.detail.get("channels", [])}
        )
        nlp_channels = sorted(
            {c for p in patterns for c in p.detail.get("independent_nlp_channels", [])}
        )
        partners = sorted(
            {e for p in patterns for e in p.entity_ids if e != eid}
        )
        # (channels - 1) / 3 puts the qualifying floor of 2 channels at 0.33 and
        # all four channels at 1.0; each additional partner adds a quarter.
        value = (best - 1) / 3.0 + 0.25 * (len(partners) - 1)
        return self._factor(
            "multi_channel_relationship",
            value,
            patterns=patterns,
            explanation=explain.explain_multi_channel(
                channel_count=best,
                partner_count=len(partners),
                channels=channels,
                nlp_channels=nlp_channels,
            ),
            detail={
                "max_channel_count": best,
                "partner_count": len(partners),
                "partners": partners,
                "channels": channels,
                "independent_nlp_channels_excluded_from_score": nlp_channels,
                "formula": "(max_channels - 1) / 3 + 0.25 * (partners - 1), capped at 1.0",
            },
        )

    def _transaction(self, patterns: list[Pattern]) -> ScoreFactor:
        if not patterns:
            return self._factor(
                "transaction_patterns",
                0.0,
                explanation=explain.explain_transaction(
                    types=[], top_severity=0.0, detail={}
                ),
            )
        strongest = max(patterns, key=lambda p: (p.severity, p.pattern_id))
        types = sorted({p.pattern_type.value for p in patterns})
        # The strongest pattern sets the level; further distinct categories add
        # a fixed 0.15 each, because two different shapes are more than one.
        value = strongest.severity + 0.15 * (len(types) - 1)
        return self._factor(
            "transaction_patterns",
            value,
            patterns=patterns,
            explanation=explain.explain_transaction(
                types=types, top_severity=strongest.severity, detail=strongest.detail
            ),
            detail={
                "pattern_types": types,
                "pattern_count": len(patterns),
                "top_severity": round(strongest.severity, 4),
                "top_pattern_id": strongest.pattern_id,
                "formula": "top severity + 0.15 per additional distinct pattern type, capped at 1.0",
                "review_label": "Potential transaction pattern requiring review",
            },
        )

    def _communication(self, person_id: int, patterns: list[Pattern]) -> ScoreFactor:
        baseline = self.baselines.get(person_id)
        baseline_dict = baseline.as_dict() if baseline else None
        if not patterns:
            return self._factor(
                "communication_anomaly",
                0.0,
                explanation=explain.explain_communication(baseline=baseline_dict),
                detail={"baseline": baseline_dict},
            )
        pattern = patterns[0]
        return self._factor(
            "communication_anomaly",
            pattern.severity,
            patterns=patterns,
            explanation=explain.explain_communication(baseline=baseline_dict),
            detail={
                "baseline": baseline_dict,
                "formula": (
                    "absolute excess over baseline / configured material excess, "
                    "capped at 1.0; the z-test decides whether the anomaly is "
                    "flagged at all"
                ),
            },
        )

    def _location(self, eid: str, patterns: list[Pattern]) -> ScoreFactor:
        cohorts = [p for p in patterns if p.pattern_type == PatternType.LOCATION_COHORT]
        pairs = [
            p for p in patterns if p.pattern_type == PatternType.SHARED_LOCATION_PAIR
        ]
        if not patterns:
            return self._factor(
                "location_patterns",
                0.0,
                explanation=explain.explain_location(cohorts=0, pairs=0, detail={}),
            )
        largest = max(
            (int(p.detail.get("member_count", 0)) for p in cohorts), default=0
        )
        cohort_value = max((p.severity for p in cohorts), default=0.0)
        # A corroborated pair is worth a fixed step on top of cohort size; two
        # or more corroborations saturate it.
        pair_value = min(0.5, 0.25 * len(pairs))
        detail = {
            "cohort_count": len(cohorts),
            "largest_cohort_size": largest,
            "shared_location_pair_count": len(pairs),
            "formula": "max cohort severity + 0.25 per corroborated pair (max 0.5), capped at 1.0",
        }
        return self._factor(
            "location_patterns",
            cohort_value + pair_value,
            patterns=patterns,
            explanation=explain.explain_location(
                cohorts=len(cohorts), pairs=len(pairs), detail=detail
            ),
            detail=detail,
        )

    def _bridge(self, patterns: list[Pattern]) -> ScoreFactor:
        if not patterns:
            return self._factor(
                "bridge_network_structure",
                0.0,
                explanation=explain.explain_bridge(is_bridge=False, detail={}),
                detail={"metrics_used": list(BRIDGE_METRICS)},
            )
        pattern = patterns[0]
        detail = dict(pattern.detail)
        detail["metrics_used"] = list(BRIDGE_METRICS)
        detail["formula"] = (
            "0.5 + 0.5 * (betweenness percentile - floor) / (100 - floor)"
        )
        return self._factor(
            "bridge_network_structure",
            pattern.severity,
            patterns=patterns,
            explanation=explain.explain_bridge(is_bridge=True, detail=pattern.detail),
            detail=detail,
        )
