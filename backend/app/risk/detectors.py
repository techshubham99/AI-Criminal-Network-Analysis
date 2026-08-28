"""Phase 4 pattern detection.

Five independent detectors, one per spec section, each returning
:class:`~app.risk.models.Pattern` objects that carry their own evidence:

* :class:`MultiChannelDetector`      — §1 pairs linked through several channels
* :class:`CommunicationAnomalyDetector` — §2 unusually HIGH daily call activity
* :class:`TransactionPatternDetector`   — §3 cycles, fan-in, fan-out, concentration
* :class:`LocationPatternDetector`      — §4 shared canonical locations
* :class:`BridgeEntityDetector`         — §5 structural bridges

Two constraints run through all five:

**Self-references are excluded from detection entirely** (spec §6). Every
detector drops records whose two endpoints are the same person before it counts
anything. The records themselves stay reachable as Phase 1/2 evidence; they just
cannot produce a pattern or move a score.

**The ground-truth overlay is never an input.** ``SAME_RING`` edges carry
``is_overlay=True`` and are filtered out here exactly as they are in the Phase 2
analytics projections. The generator's answer key is not a feature.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from app.config import Settings
from app.graph.analytics import GraphAnalytics
from app.graph.model import (
    EdgeType,
    NarrativeEdgeType,
    location_eid,
    person_eid,
    source_record_id,
)
from app.graph.store import GraphStore
from app.repositories.dataset import DatasetRepository
from app.risk.models import (
    EVIDENCE_NLP_DERIVED,
    EvidenceRef,
    Pattern,
    PatternType,
    TRANSACTION_REVIEW_LABEL,
    build_pattern,
    structured_evidence,
)

# --- Channel vocabulary (spec §1) ------------------------------------------
# The four independent observed channels a person pair can be linked through.
# Each maps to exactly one structured edge type, so a channel is present only
# when the underlying dataset actually recorded it.
CHANNEL_CALL = "CALL"
CHANNEL_TRANSACTION = "TRANSACTION"
CHANNEL_FIR = "FIR"
CHANNEL_CO_LOCATION = "CO_LOCATION"

STRUCTURED_CHANNEL_BY_EDGE_TYPE: dict[EdgeType, str] = {
    EdgeType.CALLED: CHANNEL_CALL,
    EdgeType.TRANSACTED: CHANNEL_TRANSACTION,
    EdgeType.REPORTED_AGAINST: CHANNEL_FIR,
    EdgeType.CO_LOCATED: CHANNEL_CO_LOCATION,
}

# Narrative edge types mapped onto the same channel vocabulary, used ONLY to
# report corroboration. A narrative channel never increments the structured
# channel count that scoring reads (spec §7).
NARRATIVE_CHANNEL_BY_EDGE_TYPE: dict[NarrativeEdgeType, str] = {
    NarrativeEdgeType.CALLED: CHANNEL_CALL,
    NarrativeEdgeType.TRANSFERRED_TO: CHANNEL_TRANSACTION,
    NarrativeEdgeType.REPORTED_AGAINST: CHANNEL_FIR,
    NarrativeEdgeType.MET: CHANNEL_CO_LOCATION,
    NarrativeEdgeType.ASSOCIATED_WITH: "ASSOCIATION",
}

PERSON_PREFIX = "person:"


def _is_person(entity_id: str) -> bool:
    return entity_id.startswith(PERSON_PREFIX)


def _person_int(entity_id: str) -> int:
    return int(entity_id.split(":", 1)[1])


def nlp_evidence_ref(edge: Any) -> EvidenceRef:
    """Wrap a Phase 3 narrative edge as an NLP-derived evidence item.

    The extraction confidence and the verbatim sentence span are carried through
    unchanged — that is the whole point of keeping this class of evidence
    separate (spec §7).
    """
    fir_record = edge.evidence[0] if edge.evidence else "firs:unknown"
    method = str(edge.attributes.get("extraction_method") or "rule:unknown")
    return EvidenceRef(
        evidence_id=edge.relationship_id,
        evidence_class=EVIDENCE_NLP_DERIVED,
        source_dataset=edge.source_dataset,
        source_record_id=fir_record,
        confidence=float(edge.provenance_confidence),
        confidence_basis=method,
        evidence_text=edge.attributes.get("evidence_text"),
    )


# --- §1 Multi-channel relationships ----------------------------------------


@dataclass
class _PairChannels:
    """Accumulator for one unordered person pair."""

    structured: dict[str, list[Any]]
    narrative: dict[str, list[Any]]

    @classmethod
    def empty(cls) -> "_PairChannels":
        return cls(structured=defaultdict(list), narrative=defaultdict(list))


class MultiChannelDetector:
    """§1 — person pairs connected through several INDEPENDENT channels.

    Independence is what makes this signal worth anything: two people who
    exchanged calls *and* money *and* share a registered location are linked by
    three separate observation processes recorded in three separate tables. One
    channel with a hundred records is still one channel, so the detector counts
    channels, never records.
    """

    def __init__(
        self,
        store: GraphStore,
        settings: Settings,
        narrative_store: Optional[GraphStore] = None,
    ) -> None:
        self.store = store
        self.settings = settings
        self.narrative_store = narrative_store

    def detect(self) -> list[Pattern]:
        pairs: dict[tuple[str, str], _PairChannels] = {}

        for edge in self.store.iter_edges():
            # The overlay is not evidence, and a narrative edge in the
            # structured store would be a Phase 3 invariant violation.
            if edge.is_overlay or edge.is_narrative:
                continue
            channel = STRUCTURED_CHANNEL_BY_EDGE_TYPE.get(edge.relationship_type)
            if channel is None:
                continue
            u, v = edge.source_entity_id, edge.target_entity_id
            if u == v:  # §6 self-reference exclusion
                continue
            if not (_is_person(u) and _is_person(v)):
                continue
            key = (u, v) if u <= v else (v, u)
            pairs.setdefault(key, _PairChannels.empty()).structured[channel].append(edge)

        if self.narrative_store is not None:
            for edge in self.narrative_store.iter_edges():
                channel = NARRATIVE_CHANNEL_BY_EDGE_TYPE.get(edge.relationship_type)
                if channel is None:
                    continue
                u, v = edge.source_entity_id, edge.target_entity_id
                if u == v or not (_is_person(u) and _is_person(v)):
                    continue
                key = (u, v) if u <= v else (v, u)
                # Only attach narrative corroboration to pairs the structured
                # graph already knows about; a narrative-only pair is a Phase 3
                # finding, not a multi-channel relationship.
                if key in pairs:
                    pairs[key].narrative[channel].append(edge)

        min_channels = self.settings.intel_multi_channel_min_channels
        patterns: list[Pattern] = []
        for (a, b), acc in sorted(pairs.items()):
            channels = sorted(acc.structured)
            if len(channels) < min_channels:
                continue
            patterns.append(self._build(a, b, channels, acc))
        return patterns

    def _build(
        self, a: str, b: str, channels: list[str], acc: _PairChannels
    ) -> Pattern:
        evidence: list[EvidenceRef] = []
        per_channel: dict[str, dict[str, Any]] = {}
        relationship_types: set[str] = set()
        for channel in channels:
            edges = acc.structured[channel]
            ids = sorted({cite for edge in edges for cite in edge.evidence})
            # De-duplication happens in build_pattern too, but doing it per
            # channel keeps the per-channel record counts honest.
            evidence.extend(structured_evidence(cite) for cite in ids)
            for edge in edges:
                relationship_types.add(str(edge.relationship_type.value))
            per_channel[channel] = {
                "relationship_types": sorted(
                    {str(e.relationship_type.value) for e in edges}
                ),
                "record_count": len(ids),
                "evidence_ids": ids,
            }

        # Narrative channels are reported, never counted (spec §7).
        independent_nlp: list[str] = []
        for channel, edges in sorted(acc.narrative.items()):
            evidence.extend(nlp_evidence_ref(edge) for edge in edges)
            if channel not in acc.structured:
                independent_nlp.append(channel)

        channel_count = len(channels)
        # Severity rises with the number of independent channels only: 2 of 4 is
        # the floor that qualifies, 4 of 4 is the ceiling.
        severity = (channel_count - 1) / 3.0
        explanation = (
            f"{a} and {b} are linked through {channel_count} independent observed "
            f"channels ({', '.join(channels)}), each recorded in a separate "
            f"dataset. Multiple independent channels are harder to explain as "
            f"coincidence than one channel with many records, which is why the "
            f"count is over channels and not over records."
        )
        if independent_nlp:
            explanation += (
                f" FIR narrative text additionally asserts "
                f"{', '.join(independent_nlp)} for this pair; that claim is "
                f"NLP-derived, is listed separately, and does not raise the "
                f"channel count or the score."
            )
        return build_pattern(
            PatternType.MULTI_CHANNEL_RELATIONSHIP,
            entity_ids=[a, b],
            relationship_types=relationship_types,
            evidence=evidence,
            explanation=explanation,
            severity=severity,
            detail={
                "channel_count": channel_count,
                "channels": channels,
                "channel_detail": per_channel,
                "independent_nlp_channels": independent_nlp,
                "nlp_channel_count_excluded_from_score": len(independent_nlp),
            },
        )


# --- §2 Communication anomaly ----------------------------------------------

STATUS_HIGH_ACTIVITY = "high_activity_anomaly"
STATUS_NO_ANOMALY = "no_anomaly"
STATUS_INSUFFICIENT_BASELINE = "insufficient_baseline_data"
STATUS_INSUFFICIENT_VARIANCE = "insufficient_baseline_variance"


@dataclass(frozen=True)
class CommunicationBaseline:
    """One person's own daily-call baseline and the peak measured against it."""

    person_id: int
    observation_days: int
    total_calls: int
    mean: Optional[float]
    stdev: Optional[float]
    min_daily: Optional[int]
    max_daily: Optional[int]
    peak_date: Optional[str]
    observed_count: Optional[int]
    z_score: Optional[float]
    status: str
    excess: Optional[float]
    material: bool
    call_ids: list[int]

    def as_dict(self) -> dict[str, Any]:
        return {
            "person_id": self.person_id,
            "anomaly_status": self.status,
            "observed_count": self.observed_count,
            "peak_date": self.peak_date,
            "z_score": self.z_score,
            "excess_over_baseline": self.excess,
            "materially_significant": self.material,
            "baseline": {
                "observation_days": self.observation_days,
                "total_calls": self.total_calls,
                "mean_calls_per_active_day": self.mean,
                "stdev_calls_per_active_day": self.stdev,
                "min_calls_per_active_day": self.min_daily,
                "max_calls_per_active_day": self.max_daily,
            },
            "supporting_call_ids": self.call_ids,
        }


class CommunicationAnomalyDetector:
    """§2 — unusually HIGH call activity, per person, against their own baseline.

    Method, stated exactly because the number is meaningless without it:

    1. Calls are aggregated **per person per calendar day**. A person
       participates in a call as either caller or callee; both count, because
       communication activity is not a property of who dialled.
    2. Self-calls are dropped first (§6).
    3. The baseline is the person's OWN distribution of daily totals across the
       days on which they were observed at all. Days with no record are *not*
       folded in as zeros: absence of a call record in a sampled corpus is not
       evidence that no call happened, and treating it as zero would manufacture
       spikes out of sparsity.
    4. With fewer than ``intel_anomaly_min_observations`` observed days there is
       no baseline to speak of, and the detector says
       ``insufficient_baseline_data`` rather than inventing one.
    5. ``z = (peak_day_count - mean) / stdev`` (sample stdev, ddof=1). Activity
       is flagged when ``z > intel_anomaly_z_threshold``.
    6. Only HIGH activity is flagged. A quiet person is not a suspicious person,
       and low outliers are never reported as anomalies.

    Known limitation, measured on this corpus rather than assumed: daily totals
    here are tiny (most active days carry exactly one call), so the standard
    deviation is small and a two-call day can clear z > 2 while being one call
    above baseline. The z-test is therefore reported as specified, and the
    absolute excess is reported alongside it; scoring uses the excess to scale
    the contribution so a one-call spike cannot earn the full weight.
    """

    def __init__(self, repo: DatasetRepository, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings
        self._baselines: dict[int, CommunicationBaseline] = {}

    # -- baselines ---------------------------------------------------------
    def baselines(self) -> dict[int, CommunicationBaseline]:
        if not self._baselines:
            self._baselines = self._compute()
        return self._baselines

    def baseline_for(self, person_id: int) -> Optional[CommunicationBaseline]:
        return self.baselines().get(person_id)

    def _compute(self) -> dict[int, CommunicationBaseline]:
        # person -> day -> [call_id]
        daily: dict[int, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
        for call in self.repo.calls:
            caller, callee = call["caller_id"], call["callee_id"]
            if caller == callee:  # §6: a self-call is not communication activity
                continue
            day = str(call["start_time"])[:10]
            cid = int(call["call_id"])
            daily[caller][day].append(cid)
            daily[callee][day].append(cid)

        min_obs = self.settings.intel_anomaly_min_observations
        z_threshold = self.settings.intel_anomaly_z_threshold
        material_excess = self.settings.intel_anomaly_material_excess

        out: dict[int, CommunicationBaseline] = {}
        for person_id in sorted(daily):
            by_day = daily[person_id]
            # Deterministic peak: highest count, earliest date on a tie.
            days = sorted(by_day)
            counts = [len(by_day[d]) for d in days]
            total = sum(counts)
            peak_idx = max(range(len(days)), key=lambda i: (counts[i], -i))
            peak_date, peak = days[peak_idx], counts[peak_idx]
            observation_days = len(days)

            if observation_days < min_obs:
                out[person_id] = CommunicationBaseline(
                    person_id=person_id,
                    observation_days=observation_days,
                    total_calls=total,
                    mean=None,
                    stdev=None,
                    min_daily=min(counts),
                    max_daily=peak,
                    peak_date=None,
                    observed_count=None,
                    z_score=None,
                    status=STATUS_INSUFFICIENT_BASELINE,
                    excess=None,
                    material=False,
                    call_ids=[],
                )
                continue

            mean = statistics.mean(counts)
            stdev = statistics.stdev(counts)  # sample stdev, ddof=1
            if stdev == 0:
                status, z = STATUS_INSUFFICIENT_VARIANCE, None
            else:
                z = (peak - mean) / stdev
                status = (
                    STATUS_HIGH_ACTIVITY if z > z_threshold else STATUS_NO_ANOMALY
                )
            excess = peak - mean
            out[person_id] = CommunicationBaseline(
                person_id=person_id,
                observation_days=observation_days,
                total_calls=total,
                mean=round(mean, 4),
                stdev=round(stdev, 4),
                min_daily=min(counts),
                max_daily=peak,
                peak_date=peak_date,
                observed_count=peak,
                z_score=round(z, 4) if z is not None else None,
                status=status,
                excess=round(excess, 4),
                material=excess >= material_excess,
                call_ids=(
                    sorted(set(by_day[peak_date]))
                    if status == STATUS_HIGH_ACTIVITY
                    else []
                ),
            )
        return out

    # -- patterns ----------------------------------------------------------
    def detect(self) -> list[Pattern]:
        material_excess = self.settings.intel_anomaly_material_excess
        patterns: list[Pattern] = []
        for person_id, base in sorted(self.baselines().items()):
            if base.status != STATUS_HIGH_ACTIVITY:
                continue
            eid = person_eid(person_id)
            evidence = [
                structured_evidence(source_record_id("calls", cid))
                for cid in base.call_ids
            ]
            # Severity is driven by the ABSOLUTE excess, not by z: on this
            # corpus z is inflated by tiny variance, and one extra call is one
            # extra call however unusual it is for that person.
            severity = min(1.0, (base.excess or 0.0) / material_excess)
            explanation = (
                f"person:{person_id} recorded {base.observed_count} calls on "
                f"{base.peak_date} against their own baseline of "
                f"{base.mean} calls per observed day (stdev {base.stdev} over "
                f"{base.observation_days} observed days), giving z = "
                f"{base.z_score}, above the configured threshold of "
                f"{self.settings.intel_anomaly_z_threshold}. The absolute "
                f"excess is {base.excess} calls, which is "
                f"{'materially significant' if base.material else 'small in absolute terms'} "
                f"against the configured materiality of {material_excess} calls. "
                f"High activity only; low activity is never flagged."
            )
            patterns.append(
                build_pattern(
                    PatternType.COMMUNICATION_ANOMALY,
                    entity_ids=[eid],
                    relationship_types=[EdgeType.CALLED.value],
                    evidence=evidence,
                    explanation=explanation,
                    severity=severity,
                    detail=base.as_dict(),
                )
            )
        return patterns

    def coverage(self) -> dict[str, Any]:
        """Honest accounting of how the population fell across the statuses."""
        counts: dict[str, int] = defaultdict(int)
        material = 0
        for base in self.baselines().values():
            counts[base.status] += 1
            if base.status == STATUS_HIGH_ACTIVITY and base.material:
                material += 1
        return {
            "persons_with_calls": len(self.baselines()),
            "by_status": dict(sorted(counts.items())),
            "high_activity_materially_significant": material,
            "min_observations_required": self.settings.intel_anomaly_min_observations,
            "z_threshold": self.settings.intel_anomaly_z_threshold,
            "material_excess_calls": self.settings.intel_anomaly_material_excess,
        }


# --- §3 Transaction patterns ------------------------------------------------


class TransactionPatternDetector:
    """§3 — structural patterns in the observed transaction records.

    Four categories: circular paths, fan-in, fan-out and counterparty
    concentration. Every detection lists the exact ``transactions:{txn_id}``
    evidence it rests on.

    On naming: these are transaction *shapes*. This engine does not and cannot
    call them laundering, fraud, or confirmed criminal activity — the label on
    every one of them is "Potential transaction pattern requiring review".
    """

    def __init__(self, repo: DatasetRepository, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings
        # (sender, receiver) -> [txn rows], self-transfers already excluded
        self._pairs: dict[tuple[int, int], list[dict[str, Any]]] = {}
        self._adj: dict[int, list[int]] = {}
        self._self_transfers = 0

    def _index(self) -> None:
        if self._pairs:
            return
        pairs: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
        for txn in self.repo.transactions:
            sender, receiver = int(txn["sender_id"]), int(txn["receiver_id"])
            if sender == receiver:  # §6 self-reference exclusion
                self._self_transfers += 1
                continue
            pairs[(sender, receiver)].append(txn)
        self._pairs = dict(pairs)
        adj: dict[int, set[int]] = defaultdict(set)
        for sender, receiver in self._pairs:
            adj[sender].add(receiver)
        self._adj = {k: sorted(v) for k, v in adj.items()}

    def detect(self) -> list[Pattern]:
        self._index()
        return (
            self._cycles()
            + self._fan(outgoing=False)
            + self._fan(outgoing=True)
            + self._concentration()
        )

    # -- (A) circular paths ------------------------------------------------
    def _cycles(self) -> list[Pattern]:
        max_len = self.settings.intel_txn_cycle_max_length
        found: dict[tuple[int, ...], list[int]] = {}

        def walk(start: int, node: int, path: list[int]) -> None:
            for nxt in self._adj.get(node, ()):
                if nxt == start and len(path) >= 2:
                    # Canonical rotation: the cycle is stored starting at its
                    # minimum member, so the same cycle found from any entry
                    # point collapses to one key.
                    idx = path.index(min(path))
                    found[tuple(path[idx:] + path[:idx])] = list(path)
                    continue
                if nxt <= start or nxt in path or len(path) >= max_len:
                    # `nxt <= start` keeps enumeration to cycles whose minimum
                    # member is `start`, which visits each cycle exactly once.
                    continue
                walk(start, nxt, path + [nxt])

        for start in sorted(self._adj):
            walk(start, start, [start])

        patterns: list[Pattern] = []
        for cycle in sorted(found):
            members = list(cycle)
            evidence: list[EvidenceRef] = []
            legs: list[dict[str, Any]] = []
            total = 0.0
            for i, sender in enumerate(members):
                receiver = members[(i + 1) % len(members)]
                txns = self._pairs[(sender, receiver)]
                ids = sorted(int(t["txn_id"]) for t in txns)
                amount = sum(float(t["amount_inr"]) for t in txns)
                total += amount
                evidence.extend(
                    structured_evidence(source_record_id("transactions", tid))
                    for tid in ids
                )
                legs.append(
                    {
                        "from": person_eid(sender),
                        "to": person_eid(receiver),
                        "transaction_count": len(ids),
                        "total_amount_inr": round(amount, 2),
                        "evidence_ids": [
                            source_record_id("transactions", tid) for tid in ids
                        ],
                    }
                )
            path = " -> ".join(person_eid(m) for m in members) + f" -> {person_eid(members[0])}"
            # A 3+ member ring is a less ordinary shape than a reciprocal pair,
            # so severity rises with the number of distinct members.
            severity = min(1.0, 0.6 + 0.2 * (len(members) - 2))
            patterns.append(
                build_pattern(
                    PatternType.TRANSACTION_CYCLE,
                    entity_ids=[person_eid(m) for m in members],
                    relationship_types=[EdgeType.TRANSACTED.value],
                    evidence=evidence,
                    explanation=(
                        f"{TRANSACTION_REVIEW_LABEL}: value returns to its origin "
                        f"along {path}, a closed circuit of {len(members)} persons "
                        f"carrying {round(total, 2)} INR across "
                        f"{sum(leg['transaction_count'] for leg in legs)} observed "
                        f"transactions. A circuit is a shape, not a finding; the "
                        f"listed transaction records are the whole of the basis."
                    ),
                    severity=severity,
                    detail={
                        "cycle_length": len(members),
                        "cycle_path": path,
                        "members": [person_eid(m) for m in members],
                        "legs": legs,
                        "total_amount_inr": round(total, 2),
                    },
                )
            )
        return patterns

    # -- (B)/(C) fan-in and fan-out ----------------------------------------
    def _fan(self, *, outgoing: bool) -> list[Pattern]:
        threshold = (
            self.settings.intel_txn_fan_out_min
            if outgoing
            else self.settings.intel_txn_fan_in_min
        )
        counterparties: dict[int, set[int]] = defaultdict(set)
        for sender, receiver in self._pairs:
            if outgoing:
                counterparties[sender].add(receiver)
            else:
                counterparties[receiver].add(sender)

        patterns: list[Pattern] = []
        for hub in sorted(counterparties):
            others = sorted(counterparties[hub])
            if len(others) < threshold:
                continue
            evidence: list[EvidenceRef] = []
            total = 0.0
            count = 0
            for other in others:
                key = (hub, other) if outgoing else (other, hub)
                for txn in self._pairs[key]:
                    evidence.append(
                        structured_evidence(
                            source_record_id("transactions", int(txn["txn_id"]))
                        )
                    )
                    total += float(txn["amount_inr"])
                    count += 1
            # Twice the threshold saturates the severity scale.
            severity = min(1.0, len(others) / (2.0 * threshold))
            if outgoing:
                ptype = PatternType.TRANSACTION_FAN_OUT
                shape = (
                    f"one source sending to {len(others)} distinct receivers"
                )
            else:
                ptype = PatternType.TRANSACTION_FAN_IN
                shape = (
                    f"{len(others)} distinct senders paying into one target"
                )
            patterns.append(
                build_pattern(
                    ptype,
                    entity_ids=[person_eid(hub)] + [person_eid(o) for o in others],
                    relationship_types=[EdgeType.TRANSACTED.value],
                    evidence=evidence,
                    explanation=(
                        f"{TRANSACTION_REVIEW_LABEL}: {person_eid(hub)} sits at the "
                        f"centre of {shape}, across {count} observed transactions "
                        f"totalling {round(total, 2)} INR (threshold: {threshold} "
                        f"counterparties). Many counterparties is a shape common to "
                        f"legitimate activity as well; it is a reason to look, not "
                        f"a conclusion."
                    ),
                    severity=severity,
                    detail={
                        "hub": person_eid(hub),
                        "direction": "fan_out" if outgoing else "fan_in",
                        "counterparty_count": len(others),
                        "counterparties": [person_eid(o) for o in others],
                        "transaction_count": count,
                        "total_amount_inr": round(total, 2),
                        "threshold": threshold,
                    },
                )
            )
        return patterns

    # -- (D) counterparty concentration ------------------------------------
    def _concentration(self) -> list[Pattern]:
        min_txns = self.settings.intel_txn_concentration_min_txns
        min_share = self.settings.intel_txn_concentration_min_share

        # person -> counterparty -> (txn rows), both directions pooled: this is
        # about where a person's money is concentrated, not which way it flowed.
        by_person: dict[int, dict[int, list[dict[str, Any]]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for (sender, receiver), txns in self._pairs.items():
            by_person[sender][receiver].extend(txns)
            by_person[receiver][sender].extend(txns)

        patterns: list[Pattern] = []
        for person in sorted(by_person):
            counterparties = by_person[person]
            txn_count = sum(len(v) for v in counterparties.values())
            if txn_count < min_txns:
                continue
            totals = {
                other: sum(float(t["amount_inr"]) for t in txns)
                for other, txns in counterparties.items()
            }
            grand_total = sum(totals.values())
            if grand_total <= 0:
                continue
            # Deterministic top counterparty: largest value, lowest id on a tie.
            top = min(totals, key=lambda o: (-totals[o], o))
            share = totals[top] / grand_total
            if share < min_share:
                continue
            txns = counterparties[top]
            ids = sorted(int(t["txn_id"]) for t in txns)
            severity = min(1.0, (share - min_share) / (1.0 - min_share))
            patterns.append(
                build_pattern(
                    PatternType.TRANSACTION_CONCENTRATION,
                    entity_ids=[person_eid(person), person_eid(top)],
                    relationship_types=[EdgeType.TRANSACTED.value],
                    evidence=[
                        structured_evidence(source_record_id("transactions", tid))
                        for tid in ids
                    ],
                    explanation=(
                        f"{TRANSACTION_REVIEW_LABEL}: "
                        f"{round(share * 100, 1)}% of the "
                        f"{round(grand_total, 2)} INR moving through "
                        f"{person_eid(person)} across {txn_count} observed "
                        f"transactions is concentrated on the single counterparty "
                        f"{person_eid(top)} ({len(ids)} transactions, "
                        f"{round(totals[top], 2)} INR), above the configured "
                        f"{round(min_share * 100)}% share. Concentration is a "
                        f"clustering observation about records, nothing more."
                    ),
                    severity=severity,
                    detail={
                        "person": person_eid(person),
                        "counterparty": person_eid(top),
                        "share": round(share, 4),
                        "min_share": min_share,
                        "counterparty_amount_inr": round(totals[top], 2),
                        "total_amount_inr": round(grand_total, 2),
                        "transaction_count": txn_count,
                        "counterparty_transaction_count": len(ids),
                        "counterparty_count": len(totals),
                    },
                )
            )
        return patterns

    def coverage(self) -> dict[str, Any]:
        self._index()
        return {
            "transaction_records": len(self.repo.transactions),
            "self_transfers_excluded": self._self_transfers,
            "directed_person_pairs": len(self._pairs),
            "cycle_max_length": self.settings.intel_txn_cycle_max_length,
            "fan_in_min_counterparties": self.settings.intel_txn_fan_in_min,
            "fan_out_min_counterparties": self.settings.intel_txn_fan_out_min,
            "concentration_min_transactions": self.settings.intel_txn_concentration_min_txns,
            "concentration_min_share": self.settings.intel_txn_concentration_min_share,
        }


# --- §4 Location patterns ---------------------------------------------------


class LocationPatternDetector:
    """§4 — shared canonical locations, and only what the records support.

    Both categories key off ``persons.location_id`` / ``firs.location_id``: the
    dataset's own canonical location identity, which is also what the Phase 2
    ``CO_LOCATED`` edges were built from. Raw latitude/longitude are never
    clustered here — the corpus carries jittered coordinates alongside a
    canonical pair, and inventing proximity from the jittered values would
    fabricate relationships the data does not assert.

    * ``LOCATION_COHORT`` — a canonical location shared by an unusually large
      group of registered persons.
    * ``SHARED_LOCATION_PAIR`` — two persons registered at the same canonical
      location where that location is ALSO the recorded location of at least one
      FIR naming one of them, so the shared place is corroborated by a second
      dataset rather than resting on the person rows alone.

    A location is not a person, so there is no self-reference to exclude at the
    cohort level; pairs, by construction, are two distinct persons.
    """

    def __init__(
        self, repo: DatasetRepository, store: GraphStore, settings: Settings
    ) -> None:
        self.repo = repo
        self.store = store
        self.settings = settings
        self._skipped_large = 0
        self._self_firs_excluded = 0

    def detect(self) -> list[Pattern]:
        by_location: dict[int, list[int]] = defaultdict(list)
        for person in self.repo.persons:
            lid = person.get("location_id")
            if lid is None:
                continue
            by_location[int(lid)].append(int(person["person_id"]))

        fir_by_location: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for fir in self.repo.firs:
            if int(fir["complainant_id"]) == int(fir["accused_id"]):
                # §6: a FIR naming the same person as complainant and accused
                # cannot corroborate a relationship between two people. It stays
                # available as a Phase 1 record; it just cannot be cited here.
                self._self_firs_excluded += 1
                continue
            lid = fir.get("location_id")
            if lid is not None:
                fir_by_location[int(lid)].append(fir)

        return self._cohorts(by_location) + self._shared_pairs(
            by_location, fir_by_location
        )

    def _location_label(self, lid: int) -> str:
        row = self.repo.get_location(lid)
        if not row:
            return f"location:{lid}"
        return f"{row.get('city')}, {row.get('state')}"

    def _cohorts(self, by_location: dict[int, list[int]]) -> list[Pattern]:
        min_group = self.settings.intel_location_min_group
        max_group = self.settings.intel_location_max_group
        patterns: list[Pattern] = []
        for lid in sorted(by_location):
            members = sorted(by_location[lid])
            if len(members) < min_group:
                continue
            if len(members) > max_group:
                # Same guard as the Phase 2 co-location clique cap: an enormous
                # group is an artefact of the address field, not a lead.
                self._skipped_large += 1
                continue
            evidence = [structured_evidence(source_record_id("locations", lid))] + [
                structured_evidence(source_record_id("persons", pid)) for pid in members
            ]
            severity = min(1.0, (len(members) - min_group + 1) / float(min_group))
            patterns.append(
                build_pattern(
                    PatternType.LOCATION_COHORT,
                    entity_ids=[location_eid(lid)]
                    + [person_eid(pid) for pid in members],
                    relationship_types=[EdgeType.LOCATED_AT.value, EdgeType.CO_LOCATED.value],
                    evidence=evidence,
                    explanation=(
                        f"{len(members)} persons are registered at the single "
                        f"canonical location {location_eid(lid)} "
                        f"({self._location_label(lid)}), against a configured "
                        f"cohort threshold of {min_group}. This is the canonical "
                        f"location id from the dataset, not a proximity guess from "
                        f"raw coordinates. Shared registration is a shared address "
                        f"and nothing more is claimed by it."
                    ),
                    severity=severity,
                    detail={
                        "location_entity_id": location_eid(lid),
                        "location_label": self._location_label(lid),
                        "member_count": len(members),
                        "members": [person_eid(pid) for pid in members],
                        "min_group": min_group,
                    },
                )
            )
        return patterns

    def _shared_pairs(
        self,
        by_location: dict[int, list[int]],
        fir_by_location: dict[int, list[dict[str, Any]]],
    ) -> list[Pattern]:
        max_group = self.settings.intel_location_max_group
        patterns: list[Pattern] = []
        for lid in sorted(by_location):
            firs = fir_by_location.get(lid)
            if not firs:
                continue
            members = sorted(by_location[lid])
            if len(members) > max_group:
                continue
            named = {int(f["complainant_id"]) for f in firs} | {
                int(f["accused_id"]) for f in firs
            }
            for i, a in enumerate(members):
                for b in members[i + 1 :]:
                    if a == b:  # §6, unreachable by construction but explicit
                        continue
                    relevant = [
                        f
                        for f in firs
                        if int(f["complainant_id"]) in (a, b)
                        or int(f["accused_id"]) in (a, b)
                    ]
                    if not relevant:
                        continue
                    # The Phase 2 edge is the structured assertion that these
                    # two share a location; cite it rather than re-deriving it.
                    co_edges = self.store.edges_between(
                        person_eid(a), person_eid(b), edge_types=[EdgeType.CO_LOCATED]
                    )
                    evidence = [
                        structured_evidence(source_record_id("locations", lid)),
                        structured_evidence(source_record_id("persons", a)),
                        structured_evidence(source_record_id("persons", b)),
                    ]
                    fir_ids = sorted(int(f["fir_id"]) for f in relevant)
                    evidence.extend(
                        structured_evidence(source_record_id("firs", fid))
                        for fid in fir_ids
                    )
                    severity = min(1.0, 0.5 + 0.25 * (len(fir_ids) - 1))
                    patterns.append(
                        build_pattern(
                            PatternType.SHARED_LOCATION_PAIR,
                            entity_ids=[person_eid(a), person_eid(b), location_eid(lid)],
                            relationship_types=[EdgeType.CO_LOCATED.value],
                            evidence=evidence,
                            explanation=(
                                f"{person_eid(a)} and {person_eid(b)} are both "
                                f"registered at canonical location "
                                f"{location_eid(lid)} "
                                f"({self._location_label(lid)}), and "
                                f"{len(fir_ids)} FIR(s) recorded at that same "
                                f"location name one of them "
                                f"({', '.join(f'firs:{f}' for f in fir_ids)}). The "
                                f"shared place is therefore corroborated by a "
                                f"second dataset. Co-location is not contact: no "
                                f"meeting, and no relationship beyond the shared "
                                f"registration, is asserted."
                            ),
                            severity=severity,
                            detail={
                                "location_entity_id": location_eid(lid),
                                "location_label": self._location_label(lid),
                                "fir_ids": [f"firs:{f}" for f in fir_ids],
                                "fir_count": len(fir_ids),
                                "co_located_edge_ids": sorted(
                                    e.relationship_id for e in co_edges
                                ),
                                "cohort_size": len(members),
                                "named_in_location_firs": sorted(
                                    person_eid(p) for p in named & {a, b}
                                ),
                            },
                        )
                    )
        return patterns

    def coverage(self) -> dict[str, Any]:
        return {
            "locations": len(self.repo.locations),
            "min_group": self.settings.intel_location_min_group,
            "max_group": self.settings.intel_location_max_group,
            "cohorts_skipped_above_max_group": self._skipped_large,
            "self_fir_references_excluded": self._self_firs_excluded,
            "basis": "canonical location_id from persons/firs rows; raw coordinates are never clustered",
        }


# --- §5 Bridge / network structure -----------------------------------------


class BridgeEntityDetector:
    """§5 — entities whose removal would separate parts of the observed network.

    Built entirely on the Phase 2 analytics projection, so the numbers here are
    the same numbers ``/api/v1/analytics`` already serves: betweenness on the
    undirected person projection, with overlay edges and self-loops excluded.

    An entity qualifies when its betweenness sits at or above the configured
    percentile AND it actually links neighbours drawn from more than one
    detected community — the second condition is what "connects otherwise
    separate network regions" means, and without it a merely busy node would
    pass.

    Vocabulary, per spec: **bridge entity**, **network importance**,
    **investigation lead**. Centrality is a position in a graph. It is not
    guilt, and no wording here may imply otherwise.
    """

    def __init__(
        self, store: GraphStore, analytics: GraphAnalytics, settings: Settings
    ) -> None:
        self.store = store
        self.analytics = analytics
        self.settings = settings

    def detect(self) -> list[Pattern]:
        percentile_floor = self.settings.intel_bridge_percentile
        patterns: list[Pattern] = []
        for eid in self.analytics.person_ids:
            betweenness = self.analytics.betweenness.get(eid, 0.0)
            if betweenness <= 0.0:
                continue
            pct = self.analytics._percentile("betweenness", betweenness)
            if pct < percentile_floor:
                continue
            neighbour_communities, crossing = self._crossings(eid)
            if len(neighbour_communities) < 2:
                continue
            evidence = [
                structured_evidence(cite)
                for cite in sorted({c for _, cites in crossing for c in cites})
            ]
            span = (100.0 - percentile_floor) or 1.0
            severity = min(1.0, 0.5 + 0.5 * (pct - percentile_floor) / span)
            patterns.append(
                build_pattern(
                    PatternType.BRIDGE_ENTITY,
                    entity_ids=[eid],
                    relationship_types=sorted({rtype for rtype, _ in crossing}),
                    evidence=evidence,
                    explanation=(
                        f"{eid} is a bridge entity: its betweenness centrality of "
                        f"{round(betweenness, 6)} is at the "
                        f"{round(pct, 1)}th percentile of the observed person "
                        f"projection (floor {percentile_floor}), and its "
                        f"relationships reach "
                        f"{len(neighbour_communities)} distinct detected "
                        f"communities across {len(crossing)} community-crossing "
                        f"relationships. High network importance marks an "
                        f"investigation lead — a place where the observed network "
                        f"would come apart if this entity were removed. It is a "
                        f"structural position, not a determination of criminality "
                        f"or guilt."
                    ),
                    severity=severity,
                    detail={
                        "betweenness": round(betweenness, 8),
                        "betweenness_percentile": round(pct, 2),
                        "percentile_floor": percentile_floor,
                        "community_id": self.analytics.community_of.get(eid),
                        "neighbour_communities": sorted(neighbour_communities),
                        "neighbour_community_count": len(neighbour_communities),
                        "crossing_relationship_count": len(crossing),
                        "label": "bridge_entity",
                        "is_investigation_lead": True,
                    },
                )
            )
        return patterns

    def _crossings(self, eid: str) -> tuple[set[int], list[tuple[str, list[str]]]]:
        """Communities reached, and the relationships that reach them."""
        own = self.analytics.community_of.get(eid)
        communities: set[int] = set()
        crossing: list[tuple[str, list[str]]] = []
        for edge in self._person_edges(eid):
            other = (
                edge.target_entity_id
                if edge.source_entity_id == eid
                else edge.source_entity_id
            )
            community = self.analytics.community_of.get(other)
            if community is None:
                continue
            communities.add(community)
            if community != own:
                crossing.append((str(edge.relationship_type.value), list(edge.evidence)))
        return communities, crossing

    def _person_edges(self, eid: str) -> Iterable[Any]:
        """Observed person-to-person edges incident on ``eid``.

        Overlay edges are excluded by ``get_neighbors``; self-loops and
        non-person endpoints are excluded here (§6).
        """
        seen: set[str] = set()
        for _node, edges in self.store.get_neighbors(eid):
            for edge in edges:
                if edge.relationship_id in seen:
                    continue
                seen.add(edge.relationship_id)
                if edge.is_overlay or edge.is_narrative:
                    continue
                u, v = edge.source_entity_id, edge.target_entity_id
                if u == v or not (_is_person(u) and _is_person(v)):
                    continue
                if edge.relationship_type not in STRUCTURED_CHANNEL_BY_EDGE_TYPE:
                    continue
                yield edge

    def coverage(self) -> dict[str, Any]:
        return {
            "persons_in_projection": len(self.analytics.person_ids),
            "percentile_floor": self.settings.intel_bridge_percentile,
            "basis": "Phase 2 betweenness on the undirected person projection (overlay and self-loops excluded)",
        }
