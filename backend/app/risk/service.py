"""Phase 4 service facade: build once, then answer questions.

Mirrors the Phase 2/3 pattern — detection and scoring run eagerly at startup,
results are indexed, and the API layer only shapes what is already computed.
Nothing here is lazy or cached per request, so two calls to the same endpoint
cannot disagree, and a restart cannot change an answer.

The construction order matters and is fixed: detect patterns (five detectors,
each independent), then score persons from those patterns. Scoring never reaches
back into the raw records — if a signal is not expressible as a pattern with
evidence, it does not reach the score.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from typing import Any, Optional

from app.config import Settings
from app.core.errors import NotFoundError
from app.graph.analytics import GraphAnalytics
from app.graph.model import person_eid
from app.graph.store import GraphStore
from app.repositories.dataset import DatasetRepository
from app.risk import explain
from app.risk.detectors import (
    STATUS_HIGH_ACTIVITY,
    BridgeEntityDetector,
    CommunicationAnomalyDetector,
    LocationPatternDetector,
    MultiChannelDetector,
    TransactionPatternDetector,
)
from app.risk.models import (
    BAND_HIGH,
    BAND_LOW,
    BAND_MEDIUM,
    SCORE_DISCLAIMER,
    Pattern,
    PatternType,
    PriorityScore,
)
from app.risk.scoring import PriorityScorer

logger = logging.getLogger(__name__)

# The distinction spec §11 insists on, stated in the payloads themselves so it
# survives contact with a client that only reads JSON.
RANKING_NOTE = (
    "Investigation-priority ranking from the Phase 4 explainable 0-100 score. "
    "This is NOT the Phase 2 graph-based network importance ranking served by "
    "/api/v1/analytics/persons/top; the two rank different things and are not "
    "interchangeable."
)


class IntelligenceService:
    """Detection + scoring + explanation over one built graph."""

    def __init__(
        self,
        repo: DatasetRepository,
        settings: Settings,
        store: GraphStore,
        analytics: GraphAnalytics,
        narrative_store: Optional[GraphStore] = None,
    ) -> None:
        self.repo = repo
        self.settings = settings
        self.store = store
        self.analytics = analytics
        self.narrative_store = narrative_store

        self._validate_weights()

        self.multi_channel = MultiChannelDetector(store, settings, narrative_store)
        self.communication = CommunicationAnomalyDetector(repo, settings)
        self.transactions = TransactionPatternDetector(repo, settings)
        self.locations = LocationPatternDetector(repo, store, settings)
        self.bridges = BridgeEntityDetector(store, analytics, settings)

        self.patterns: list[Pattern] = []
        self._by_id: dict[str, Pattern] = {}
        self._by_type: dict[PatternType, list[Pattern]] = defaultdict(list)
        self._scores: dict[int, PriorityScore] = {}
        self._ranked: list[PriorityScore] = []
        self._duplicate_pattern_ids = 0

        self.build()

    def _validate_weights(self) -> None:
        total = round(
            self.settings.intel_weight_network_importance
            + self.settings.intel_weight_multi_channel
            + self.settings.intel_weight_transaction
            + self.settings.intel_weight_communication
            + self.settings.intel_weight_location
            + self.settings.intel_weight_bridge,
            6,
        )
        if abs(total - 100.0) > 1e-6:
            raise ValueError(
                f"Phase 4 feature weights must sum to 100 for the score to be a "
                f"0-100 scale; configured weights sum to {total}."
            )
        bands = (self.settings.intel_band_low_max, self.settings.intel_band_medium_max)
        if not 0 <= bands[0] < bands[1] < 100:
            raise ValueError(
                f"Phase 4 band boundaries must satisfy 0 <= low_max < medium_max "
                f"< 100; got {bands}."
            )

    # -- build -------------------------------------------------------------
    def build(self) -> None:
        detected: list[Pattern] = []
        detected.extend(self.multi_channel.detect())
        detected.extend(self.communication.detect())
        detected.extend(self.transactions.detect())
        detected.extend(self.locations.detect())
        detected.extend(self.bridges.detect())

        # Content-addressed ids collapse genuine duplicates (the same pattern
        # reached twice) without renumbering anything. A collision here would be
        # two detections with identical type, entities and evidence, which are
        # the same finding by definition.
        for pattern in detected:
            if pattern.pattern_id in self._by_id:
                self._duplicate_pattern_ids += 1
                continue
            self._by_id[pattern.pattern_id] = pattern
            self._by_type[pattern.pattern_type].append(pattern)

        self.patterns = sorted(
            self._by_id.values(), key=lambda p: (p.pattern_type.value, p.pattern_id)
        )
        for bucket in self._by_type.values():
            bucket.sort(key=lambda p: p.pattern_id)

        self.scorer = PriorityScorer(
            self.settings,
            self.analytics,
            self.patterns,
            self.communication.baselines(),
        )
        for person in self.repo.persons:
            pid = int(person["person_id"])
            self._scores[pid] = self.scorer.score(pid)
        # Deterministic ranking: score descending, then person id ascending.
        self._ranked = sorted(
            self._scores.values(), key=lambda s: (-s.score, s.person_id)
        )
        logger.info(
            "Phase 4 intelligence built: %d patterns, %d scored persons",
            len(self.patterns),
            len(self._scores),
        )

    # -- lookups -----------------------------------------------------------
    def score_for(self, person_id: int) -> PriorityScore:
        score = self._scores.get(person_id)
        if score is None:
            raise NotFoundError("Person", person_id)
        return score

    def pattern_for(self, pattern_id: str) -> Pattern:
        pattern = self._by_id.get(pattern_id)
        if pattern is None:
            raise NotFoundError("Pattern", pattern_id)
        return pattern

    def patterns_for_person(self, person_id: int) -> list[Pattern]:
        return self.scorer.patterns_for(person_eid(person_id))

    def explain_person(self, person_id: int) -> dict[str, Any]:
        return explain.score_walkthrough(self.score_for(person_id))

    def top_persons(
        self, limit: int, *, band: Optional[str] = None, min_score: int = 0
    ) -> list[PriorityScore]:
        out = [
            s
            for s in self._ranked
            if s.score >= min_score and (band is None or s.band == band)
        ]
        return out[:limit]

    def list_patterns(
        self,
        *,
        pattern_type: Optional[PatternType] = None,
        entity_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[Pattern], int]:
        source = (
            self._by_type.get(pattern_type, [])
            if pattern_type is not None
            else self.patterns
        )
        if entity_id is not None:
            source = [p for p in source if p.involves(entity_id)]
        return source[offset : offset + limit], len(source)

    # -- summary -----------------------------------------------------------
    def pattern_counts(self) -> dict[str, int]:
        return {
            ptype.value: len(self._by_type.get(ptype, [])) for ptype in PatternType
        }

    def zero_result_categories(self) -> list[dict[str, str]]:
        """Categories that detected nothing, reported as such (spec §10)."""
        return [
            {"pattern_type": ptype, "note": explain.explain_zero_result(ptype)}
            for ptype, count in sorted(self.pattern_counts().items())
            if count == 0
        ]

    def band_distribution(self) -> dict[str, int]:
        counts = Counter(s.band for s in self._scores.values())
        return {band: counts.get(band, 0) for band in (BAND_LOW, BAND_MEDIUM, BAND_HIGH)}

    def summary(self) -> dict[str, Any]:
        scores = [s.score for s in self._scores.values()]
        anomaly_coverage = self.communication.coverage()
        return {
            "phase": "4 - Investigation Intelligence Engine",
            "persons_scored": len(self._scores),
            "patterns_detected": len(self.patterns),
            "duplicate_pattern_ids_collapsed": self._duplicate_pattern_ids,
            "patterns_by_type": self.pattern_counts(),
            "zero_result_categories": self.zero_result_categories(),
            "score_bands": {
                "distribution": self.band_distribution(),
                "boundaries": {
                    "LOW": f"0-{self.settings.intel_band_low_max}",
                    "MEDIUM": (
                        f"{self.settings.intel_band_low_max + 1}-"
                        f"{self.settings.intel_band_medium_max}"
                    ),
                    "HIGH": f"{self.settings.intel_band_medium_max + 1}-100",
                },
            },
            "score_stats": {
                "min": min(scores) if scores else 0,
                "max": max(scores) if scores else 0,
                "mean": round(sum(scores) / len(scores), 2) if scores else 0.0,
            },
            "feature_weights": dict(sorted(self.scorer.weights.items())),
            "feature_weight_total": self.scorer.weight_total,
            "detection_coverage": {
                "communication_anomaly": anomaly_coverage,
                "transaction_patterns": self.transactions.coverage(),
                "location_patterns": self.locations.coverage(),
                "bridge_network_structure": self.bridges.coverage(),
                "multi_channel_relationship": {
                    "min_channels": self.settings.intel_multi_channel_min_channels,
                    "channels": ["CALL", "TRANSACTION", "FIR", "CO_LOCATION"],
                },
            },
            "evidence_policy": {
                "structured": "observed dataset records, provenance confidence 1.0",
                "nlp_derived": (
                    "Phase 3 rule-extraction claims about FIR free text, each "
                    "carrying its own extraction confidence"
                ),
                "separation": "reported in separate collections and never merged",
                "nlp_scoring": (
                    "NLP-derived evidence is attached and reported but does not "
                    "raise any score in this build"
                ),
            },
            "self_reference_policy": (
                "Self-calls, self-transfers and self-FIR references are excluded "
                "from all Phase 4 detection and scoring. The records remain "
                "available as Phase 1/2 evidence."
            ),
            "overlay_policy": (
                "The SAME_RING ground-truth overlay is never an input to Phase 4 "
                "detection or scoring."
            ),
            "structured_graph_mutated": False,
            "ranking_note": RANKING_NOTE,
            "disclaimer": SCORE_DISCLAIMER,
        }

    def anomaly_report(self, person_id: int) -> Optional[dict[str, Any]]:
        baseline = self.communication.baseline_for(person_id)
        return baseline.as_dict() if baseline else None

    def high_activity_person_ids(self) -> list[int]:
        return sorted(
            pid
            for pid, base in self.communication.baselines().items()
            if base.status == STATUS_HIGH_ACTIVITY
        )


def build_intelligence_service(
    repo: DatasetRepository,
    settings: Settings,
    store: GraphStore,
    analytics: GraphAnalytics,
    narrative_store: Optional[GraphStore] = None,
) -> IntelligenceService:
    """Build the Phase 4 engine over an already-built Phase 2 graph."""
    return IntelligenceService(
        repo, settings, store, analytics, narrative_store=narrative_store
    )
