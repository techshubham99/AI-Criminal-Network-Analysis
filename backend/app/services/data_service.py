"""Dataset summary service — descriptive statistics only.

No detection, scoring, or model results are produced here (Phase 1 scope).
"""
from __future__ import annotations

from app.repositories.dataset import DatasetRepository
from app.schemas.summary import (
    CallsProfile,
    DataSummaryResponse,
    FinancialProfile,
    PersonsProfile,
    ReferentialIntegrity,
    TableCounts,
    TemporalProfile,
    TimeRange,
    ValidationReport,
)

_NOTES = [
    "Descriptive statistics only — no detection, model, or crime-ring results are "
    "produced in Phase 1.",
    "Map visualization uses canonical city centroids with deterministic jitter; the "
    "raw lat/long in the dataset are not geographically reliable.",
    "Original dataset CSV files are treated as read-only and are never modified.",
]


def _time_range(values: list[str]) -> TimeRange:
    # ISO-8601 strings sort lexicographically in chronological order.
    if not values:
        return TimeRange()
    ordered = sorted(values)
    return TimeRange(min=ordered[0], max=ordered[-1])


def build_summary(repo: DatasetRepository) -> DataSummaryResponse:
    v = repo.validation

    # Ring distribution (ground-truth labels present in the data).
    ring_distribution: dict[str, int] = {}
    in_ring = 0
    for p in repo.persons:
        if p["ring_id"] is None:
            ring_distribution["none"] = ring_distribution.get("none", 0) + 1
        else:
            key = str(p["ring_id"])
            ring_distribution[key] = ring_distribution.get(key, 0) + 1
            in_ring += 1

    amounts = sorted(t["amount_inr"] for t in repo.transactions)
    n = len(amounts)
    median = amounts[n // 2] if n else 0.0
    p90 = amounts[min(n - 1, int(n * 0.9))] if n else 0.0
    mean = (sum(amounts) / n) if n else 0.0

    modes: dict[str, int] = {}
    for t in repo.transactions:
        modes[t["mode"]] = modes.get(t["mode"], 0) + 1

    durations = [c["duration_sec"] for c in repo.calls]

    return DataSummaryResponse(
        dataset_dir=str(repo.dataset_dir),
        loaded_at=repo.loaded_at.isoformat() if repo.loaded_at else "",
        counts=TableCounts(
            persons=len(repo.persons),
            calls=len(repo.calls),
            transactions=len(repo.transactions),
            locations=len(repo.locations),
            firs=len(repo.firs),
        ),
        persons=PersonsProfile(
            unique_ids=v["persons"]["unique_ids"],
            id_min=v["persons"]["id_min"],
            id_max=v["persons"]["id_max"],
            missing_ids_count=v["persons"]["missing_ids_count"],
            duplicate_phones=v["persons"]["duplicate_phones"],
            duplicate_aadhaar=v["persons"]["duplicate_aadhaar"],
            duplicate_names=v["persons"]["duplicate_names"],
            in_ring=in_ring,
            not_in_ring=len(repo.persons) - in_ring,
            ring_distribution=ring_distribution,
        ),
        temporal=TemporalProfile(
            calls=_time_range([c["start_time"] for c in repo.calls]),
            transactions=_time_range([t["txn_time"] for t in repo.transactions]),
            firs=_time_range([f["date"] for f in repo.firs]),
        ),
        financial=FinancialProfile(
            amount_min=round(amounts[0], 2) if n else 0.0,
            amount_median=round(median, 2),
            amount_p90=round(p90, 2),
            amount_max=round(amounts[-1], 2) if n else 0.0,
            amount_mean=round(mean, 2),
            modes=modes,
        ),
        calls_profile=CallsProfile(
            duration_min=min(durations) if durations else 0,
            duration_max=max(durations) if durations else 0,
            duration_mean=round(sum(durations) / len(durations), 2) if durations else 0.0,
        ),
        validation=ValidationReport(
            is_valid=v["is_valid"],
            referential_integrity=ReferentialIntegrity(**v["referential_integrity"]),
        ),
        notes=list(_NOTES),
    )
