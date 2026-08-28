"""Recomputation after an accepted change (spec §10, §11).

Two honest commitments live here.

**Global metrics are actually recomputed.** PageRank, betweenness centrality and
community detection are *global* properties: one new edge can change the score
of a person the edge does not touch. There is no correct way to patch them
locally, so this module builds a fresh :class:`GraphAnalytics` over the mutated
store and lets it do the full computation. No partial-update shortcut is faked,
and the measured cost is reported on every response
(``impact.recompute_cost_ms``) rather than hidden. On this dataset (500 persons,
~4 500 person-person edges) a full pass is on the order of a second, dominated by
betweenness; §10 of ``docs/phase4_6_live_ingestion.md`` records the measurement.

**Phase 4 sees live rows without the dataset changing.** The Phase 4 detectors
read the repository's record lists, so accepted live rows are exposed through
:class:`LiveDataView` — a read-only overlay that returns *base rows + accepted
live rows*. The CSVs are untouched, ``DatasetRepository``'s own lists are
untouched (so every Phase 1 count stays exactly what it was), and no Phase 4
threshold, weight or band is altered: the same rules simply run over more
observations.

``SAME_RING`` plays no part in any of this. It is a ground-truth overlay, the
projections already exclude it, and nothing here reads it, writes it or scores
it.

**A changed pattern id is not a new detection.** Phase 4 pattern ids hash the
pattern's detail, which for ``BRIDGE_ENTITY`` includes community labels — and
community *labels* move when one edge shifts the modularity partition, even
though the same person still bridges the same neighbours on the same evidence.
Comparing raw ids would therefore report dozens of "new patterns" for a single
call. :func:`pattern_signature` compares what a pattern actually asserts (its
type and its entities) so ``new_pattern_ids`` means *newly detected* and nothing
else; ids that moved without their assertion changing are counted separately as
``reidentified``.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from app.config import Settings
from app.graph.analytics import GraphAnalytics
from app.graph.model import person_eid
from app.graph.store import GraphStore
from app.ingest.store import IngestStore
from app.risk.service import IntelligenceService

logger = logging.getLogger(__name__)


class LiveDataView:
    """Read-only union of the dataset and the accepted live rows.

    Duck-types the parts of ``DatasetRepository`` the Phase 4 detectors use.
    Anything else is delegated to the real repository, so this is an overlay
    rather than a reimplementation. Rows are snapshotted at construction: a view
    is built per recomputation and never mutates.
    """

    def __init__(self, repo, ingest: IngestStore) -> None:
        self._repo = repo
        # No new persons: creating a person requires an investigator decision
        # that this phase deliberately does not automate (spec §6).
        self.persons: list[dict] = repo.persons
        self.locations: list[dict] = repo.locations
        self.calls: list[dict] = repo.calls + ingest.live_calls
        self.transactions: list[dict] = repo.transactions + ingest.live_transactions
        # A FIR that names no accused yet is a real state of an investigation,
        # but the Phase 4 detectors read `accused_id` as a person id. Such a FIR
        # therefore contributes graph evidence and stays out of pair-level
        # intelligence until an accused is named, rather than being given an
        # invented counterparty.
        self.firs: list[dict] = repo.firs + [
            f for f in ingest.live_firs if f.get("accused_id") is not None
        ]
        self._live_firs_by_id = {int(f["fir_id"]): f for f in ingest.live_firs}
        self.excluded_firs: list[int] = [
            int(f["fir_id"]) for f in ingest.live_firs if f.get("accused_id") is None
        ]

    def get_fir(self, fir_id: int) -> Optional[dict]:
        live = self._live_firs_by_id.get(int(fir_id))
        return live if live is not None else self._repo.get_fir(int(fir_id))

    def __getattr__(self, name: str) -> Any:
        # Only reached for attributes this view does not define.
        return getattr(self._repo, name)


@dataclass
class PersonSnapshot:
    """One person's intelligence state at a point in time."""

    person_id: int
    score: Optional[int] = None
    band: Optional[str] = None
    pattern_count: int = 0
    pagerank: Optional[float] = None
    betweenness: Optional[float] = None
    community_id: Optional[int] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "person_id": self.person_id,
            "score": self.score,
            "band": self.band,
            "pattern_count": self.pattern_count,
            "pagerank": self.pagerank,
            "betweenness": self.betweenness,
            "community_id": self.community_id,
        }


@dataclass
class RecomputeResult:
    """A completed recomputation: the new engines plus what changed."""

    analytics: GraphAnalytics
    intelligence: IntelligenceService
    cost_ms: dict[str, float]
    new_pattern_ids: list[str] = field(default_factory=list)
    cleared_pattern_ids: list[str] = field(default_factory=list)
    reidentified_pattern_count: int = 0
    priority_changes: list[dict[str, Any]] = field(default_factory=list)
    person_before: dict[int, PersonSnapshot] = field(default_factory=dict)
    person_after: dict[int, PersonSnapshot] = field(default_factory=dict)
    pattern_counts_before: dict[str, int] = field(default_factory=dict)
    pattern_counts_after: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "recompute_cost_ms": self.cost_ms,
            "new_pattern_ids": list(self.new_pattern_ids),
            "cleared_pattern_ids": list(self.cleared_pattern_ids),
            "reidentified_pattern_count": self.reidentified_pattern_count,
            "reidentified_note": (
                "Patterns whose deterministic id changed because community "
                "labels shifted, while the pattern still asserts the same thing "
                "about the same entities. Not new detections."
            ),
            "priority_changes": list(self.priority_changes),
            "persons": [
                {
                    "before": self.person_before[pid].as_dict(),
                    "after": self.person_after[pid].as_dict(),
                }
                for pid in sorted(self.person_after)
                if pid in self.person_before
            ],
            "patterns_before": self.pattern_counts_before,
            "patterns_after": self.pattern_counts_after,
        }


def pattern_signature(pattern) -> tuple[str, tuple[str, ...]]:
    """What a pattern asserts, independent of the detail its id also hashes."""
    return (pattern.pattern_type.value, tuple(sorted(pattern.entity_ids)))


def snapshot_person(
    person_id: int,
    intelligence: Optional[IntelligenceService],
    analytics: Optional[GraphAnalytics],
) -> PersonSnapshot:
    """Capture one person's current score, band and global metrics."""
    snap = PersonSnapshot(person_id=int(person_id))
    if intelligence is not None:
        try:
            score = intelligence.score_for(int(person_id))
        except Exception:  # a person not in the corpus has no score to capture
            score = None
        if score is not None:
            snap.score = score.score
            snap.band = score.band
            snap.pattern_count = len(score.pattern_ids)
    if analytics is not None:
        metrics = analytics.person_metrics(person_eid(int(person_id)))
        if metrics:
            snap.pagerank = metrics["pagerank"]
            snap.betweenness = metrics["betweenness"]
            snap.community_id = metrics["community_id"]
    return snap


class Recomputer:
    """Builds a fresh analytics + intelligence pair over the mutated graph."""

    def __init__(
        self,
        repo,
        settings: Settings,
        graph_store: GraphStore,
        ingest_store: IngestStore,
        narrative_store: Optional[GraphStore] = None,
    ) -> None:
        self.repo = repo
        self.settings = settings
        self.graph_store = graph_store
        self.ingest_store = ingest_store
        self.narrative_store = narrative_store

    def data_view(self) -> LiveDataView:
        return LiveDataView(self.repo, self.ingest_store)

    def run(
        self,
        *,
        person_ids: list[int],
        before_analytics: Optional[GraphAnalytics],
        before_intelligence: Optional[IntelligenceService],
    ) -> RecomputeResult:
        """Recompute everything global, then diff against the captured before."""
        before_persons = {
            pid: snapshot_person(pid, before_intelligence, before_analytics)
            for pid in person_ids
        }
        before_patterns = (
            list(before_intelligence.patterns) if before_intelligence is not None else []
        )
        before_ids = {p.pattern_id for p in before_patterns}
        before_signatures = {pattern_signature(p) for p in before_patterns}
        before_counts = (
            dict(before_intelligence.pattern_counts())
            if before_intelligence is not None
            else {}
        )

        t0 = time.perf_counter()
        analytics = GraphAnalytics(self.graph_store, self.settings).compute()
        t1 = time.perf_counter()
        intelligence = IntelligenceService(
            self.data_view(),
            self.settings,
            self.graph_store,
            analytics,
            narrative_store=self.narrative_store,
        )
        t2 = time.perf_counter()

        after_persons = {
            pid: snapshot_person(pid, intelligence, analytics) for pid in person_ids
        }
        new_pattern_ids = sorted(
            p.pattern_id
            for p in intelligence.patterns
            if pattern_signature(p) not in before_signatures
        )
        after_signatures = {pattern_signature(p) for p in intelligence.patterns}
        cleared_pattern_ids = sorted(
            p.pattern_id
            for p in before_patterns
            if pattern_signature(p) not in after_signatures
        )
        # Same assertion, different id: the community labels underneath it moved.
        reidentified = sum(
            1
            for p in intelligence.patterns
            if p.pattern_id not in before_ids
            and pattern_signature(p) in before_signatures
        )
        priority_changes = [
            {
                "person_id": pid,
                "entity_id": person_eid(pid),
                "score_before": before_persons[pid].score,
                "score_after": after_persons[pid].score,
                "band_before": before_persons[pid].band,
                "band_after": after_persons[pid].band,
            }
            for pid in sorted(after_persons)
            if pid in before_persons
            and (
                before_persons[pid].score != after_persons[pid].score
                or before_persons[pid].band != after_persons[pid].band
            )
        ]

        cost = {
            "analytics_ms": round((t1 - t0) * 1000.0, 1),
            "intelligence_ms": round((t2 - t1) * 1000.0, 1),
            "total_ms": round((t2 - t0) * 1000.0, 1),
        }
        logger.info(
            "Recomputed global analytics + intelligence in %.0f ms "
            "(analytics %.0f ms, intelligence %.0f ms); %d new pattern(s), "
            "%d cleared, %d re-identified",
            cost["total_ms"],
            cost["analytics_ms"],
            cost["intelligence_ms"],
            len(new_pattern_ids),
            len(cleared_pattern_ids),
            reidentified,
        )
        return RecomputeResult(
            analytics=analytics,
            intelligence=intelligence,
            cost_ms=cost,
            new_pattern_ids=new_pattern_ids,
            cleared_pattern_ids=cleared_pattern_ids,
            reidentified_pattern_count=reidentified,
            priority_changes=priority_changes,
            person_before=before_persons,
            person_after=after_persons,
            pattern_counts_before=before_counts,
            pattern_counts_after=dict(intelligence.pattern_counts()),
        )
