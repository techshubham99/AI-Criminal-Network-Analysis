"""Schemas for the dataset summary endpoint.

Everything here is *descriptive* — measured counts and statistics only. No
detection, model-accuracy, or crime-ring results are produced in Phase 1
(per the user's decision #5).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class TableCounts(BaseModel):
    persons: int
    calls: int
    transactions: int
    locations: int
    firs: int


class PersonsProfile(BaseModel):
    unique_ids: int
    id_min: int
    id_max: int
    missing_ids_count: int
    duplicate_phones: int
    duplicate_aadhaar: int
    duplicate_names: int
    in_ring: int
    not_in_ring: int
    ring_distribution: dict[str, int]


class ReferentialIntegrity(BaseModel):
    calls_bad_caller: int
    calls_bad_callee: int
    calls_self: int
    txns_bad_sender: int
    txns_bad_receiver: int
    txns_self: int
    firs_bad_complainant: int
    firs_bad_accused: int
    firs_bad_location: int
    firs_self: int
    persons_bad_location_fk: int


class ValidationReport(BaseModel):
    is_valid: bool
    referential_integrity: ReferentialIntegrity


class TimeRange(BaseModel):
    min: Optional[str] = None
    max: Optional[str] = None


class TemporalProfile(BaseModel):
    calls: TimeRange
    transactions: TimeRange
    firs: TimeRange


class FinancialProfile(BaseModel):
    amount_min: float
    amount_median: float
    amount_p90: float
    amount_max: float
    amount_mean: float
    modes: dict[str, int]


class CallsProfile(BaseModel):
    duration_min: int
    duration_max: int
    duration_mean: float


class DataSummaryResponse(BaseModel):
    dataset_dir: str
    loaded_at: str
    counts: TableCounts
    persons: PersonsProfile
    temporal: TemporalProfile
    financial: FinancialProfile
    calls_profile: CallsProfile
    validation: ValidationReport
    notes: list[str]
