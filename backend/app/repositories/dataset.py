"""In-memory dataset repository.

Loads the five read-only synthetic CSVs into native-Python records, indexes them
for O(1) detail lookups, computes a referential-integrity report, and exposes
filtered/paginated queries. The source CSV files are never written.

Design notes:
* CSVs are read with a quote-aware parser and ``keep_default_na=False`` so the
  256 multi-line ``address`` values (§DQ-2) are parsed correctly and empty
  ``ring_id`` stays an empty string (not NaN).
* Everything is coerced to native Python types up front, so API serialization
  never has to deal with numpy scalars.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from app.config import Settings
from app.services.geo import canonical_coords

logger = logging.getLogger("app.repositories.dataset")

REQUIRED_FILES: dict[str, str] = {
    "persons": "persons.csv",
    "calls": "calls.csv",
    "transactions": "transactions.csv",
    "locations": "locations.csv",
    "firs": "fir_text.csv",
}


class DatasetError(RuntimeError):
    """Raised when the dataset cannot be located or loaded."""


def _read_csv(path: Path) -> pd.DataFrame:
    # Read everything as string; do not coerce empty strings to NaN. This keeps
    # identifiers exact and multi-line quoted fields intact.
    return pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[])


def _to_int(value: Any) -> int:
    return int(str(value).strip())


def _to_float(value: Any) -> float:
    return float(str(value).strip())


def _opt_int(value: Any) -> Optional[int]:
    text = str(value).strip()
    return int(text) if text != "" else None


def _count_duplicates(values: list[Any]) -> int:
    seen: set = set()
    dupes = 0
    for v in values:
        if v in seen:
            dupes += 1
        else:
            seen.add(v)
    return dupes


class DatasetRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.dataset_dir = Path(settings.dataset_dir)
        self.loaded_at: Optional[datetime] = None

        self.persons: list[dict] = []
        self.calls: list[dict] = []
        self.transactions: list[dict] = []
        self.locations: list[dict] = []
        self.firs: list[dict] = []

        self._index: dict[str, dict[int, dict]] = {}
        self.validation: dict[str, Any] = {}

    # -- loading ------------------------------------------------------------
    def load(self) -> None:
        if not self.dataset_dir.exists():
            raise DatasetError(f"Dataset directory not found: {self.dataset_dir}")

        paths: dict[str, Path] = {}
        for key, filename in REQUIRED_FILES.items():
            path = self.dataset_dir / filename
            if not path.exists():
                raise DatasetError(f"Missing dataset file: {path}")
            paths[key] = path

        frames = {key: _read_csv(path) for key, path in paths.items()}
        self._assert_columns(frames)

        # Materialize native-Python records (locations first: persons reference them).
        self.locations = [self._location_record(r) for r in frames["locations"].to_dict("records")]
        self.persons = [self._person_record(r) for r in frames["persons"].to_dict("records")]
        self.calls = [self._call_record(r) for r in frames["calls"].to_dict("records")]
        self.transactions = [self._txn_record(r) for r in frames["transactions"].to_dict("records")]
        self.firs = [self._fir_record(r) for r in frames["firs"].to_dict("records")]

        self._index = {
            "persons": {r["person_id"]: r for r in self.persons},
            "calls": {r["call_id"]: r for r in self.calls},
            "transactions": {r["txn_id"]: r for r in self.transactions},
            "locations": {r["location_id"]: r for r in self.locations},
            "firs": {r["fir_id"]: r for r in self.firs},
        }

        self.loaded_at = datetime.now(timezone.utc)
        self.validation = self._validate()
        logger.info(
            "Dataset loaded from %s: persons=%d calls=%d transactions=%d locations=%d firs=%d (valid=%s)",
            self.dataset_dir,
            len(self.persons),
            len(self.calls),
            len(self.transactions),
            len(self.locations),
            len(self.firs),
            self.validation.get("is_valid"),
        )

    @staticmethod
    def _assert_columns(frames: dict[str, pd.DataFrame]) -> None:
        expected = {
            "persons": {"person_id", "name", "phone", "aadhar", "address", "city", "state", "location_id", "ring_id"},
            "calls": {"call_id", "caller_id", "callee_id", "start_time", "duration_sec", "cell_tower_id"},
            "transactions": {"txn_id", "sender_id", "receiver_id", "amount_inr", "txn_time", "mode", "bank_ref"},
            "locations": {"location_id", "state", "city", "latitude", "longitude"},
            "firs": {"fir_id", "date", "complainant_id", "accused_id", "location_id", "narrative"},
        }
        for key, cols in expected.items():
            actual = set(frames[key].columns)
            missing = cols - actual
            if missing:
                raise DatasetError(f"{REQUIRED_FILES[key]} missing columns: {sorted(missing)}")

    # -- record builders ----------------------------------------------------
    def _location_record(self, r: dict) -> dict:
        location_id = _to_int(r["location_id"])
        clat, clng = canonical_coords(r["city"], location_id, self.settings.geo_jitter_degrees)
        return {
            "location_id": location_id,
            "state": r["state"],
            "city": r["city"],
            "latitude": _to_float(r["latitude"]),
            "longitude": _to_float(r["longitude"]),
            "canonical_lat": clat,
            "canonical_lng": clng,
        }

    def _person_record(self, r: dict) -> dict:
        return {
            "person_id": _to_int(r["person_id"]),
            "name": r["name"],
            "phone": r["phone"],
            "aadhar": r["aadhar"],
            "address": r["address"],
            "city": r["city"],
            "state": r["state"],
            "location_id": _to_int(r["location_id"]),
            "ring_id": _opt_int(r["ring_id"]),
        }

    def _call_record(self, r: dict) -> dict:
        return {
            "call_id": _to_int(r["call_id"]),
            "caller_id": _to_int(r["caller_id"]),
            "callee_id": _to_int(r["callee_id"]),
            "start_time": r["start_time"],
            "duration_sec": _to_int(r["duration_sec"]),
            "cell_tower_id": _to_int(r["cell_tower_id"]),
        }

    def _txn_record(self, r: dict) -> dict:
        return {
            "txn_id": _to_int(r["txn_id"]),
            "sender_id": _to_int(r["sender_id"]),
            "receiver_id": _to_int(r["receiver_id"]),
            "amount_inr": _to_float(r["amount_inr"]),
            "txn_time": r["txn_time"],
            "mode": r["mode"],
            "bank_ref": r["bank_ref"],
        }

    def _fir_record(self, r: dict) -> dict:
        return {
            "fir_id": _to_int(r["fir_id"]),
            "date": r["date"],
            "complainant_id": _to_int(r["complainant_id"]),
            "accused_id": _to_int(r["accused_id"]),
            "location_id": _to_int(r["location_id"]),
            "narrative": r["narrative"],
        }

    # -- validation ---------------------------------------------------------
    def _validate(self) -> dict[str, Any]:
        person_ids = {p["person_id"] for p in self.persons}
        location_ids = {loc["location_id"] for loc in self.locations}
        ids_list = [p["person_id"] for p in self.persons]

        if ids_list:
            full_range = set(range(min(ids_list), max(ids_list) + 1))
            missing = sorted(full_range - person_ids)
            id_min, id_max = min(ids_list), max(ids_list)
        else:
            missing, id_min, id_max = [], 0, 0

        ri = {
            "calls_bad_caller": sum(1 for c in self.calls if c["caller_id"] not in person_ids),
            "calls_bad_callee": sum(1 for c in self.calls if c["callee_id"] not in person_ids),
            "calls_self": sum(1 for c in self.calls if c["caller_id"] == c["callee_id"]),
            "txns_bad_sender": sum(1 for t in self.transactions if t["sender_id"] not in person_ids),
            "txns_bad_receiver": sum(1 for t in self.transactions if t["receiver_id"] not in person_ids),
            "txns_self": sum(1 for t in self.transactions if t["sender_id"] == t["receiver_id"]),
            "firs_bad_complainant": sum(1 for f in self.firs if f["complainant_id"] not in person_ids),
            "firs_bad_accused": sum(1 for f in self.firs if f["accused_id"] not in person_ids),
            "firs_bad_location": sum(1 for f in self.firs if f["location_id"] not in location_ids),
            "firs_self": sum(1 for f in self.firs if f["complainant_id"] == f["accused_id"]),
            "persons_bad_location_fk": sum(1 for p in self.persons if p["location_id"] not in location_ids),
        }

        # Foreign-key violations invalidate the dataset. Self-references are
        # legal edge cases (reported, not treated as errors).
        fk_error_keys = [
            "calls_bad_caller", "calls_bad_callee",
            "txns_bad_sender", "txns_bad_receiver",
            "firs_bad_complainant", "firs_bad_accused", "firs_bad_location",
            "persons_bad_location_fk",
        ]
        is_valid = all(ri[k] == 0 for k in fk_error_keys)

        return {
            "is_valid": is_valid,
            "persons": {
                "unique_ids": len(person_ids),
                "id_min": id_min,
                "id_max": id_max,
                "missing_ids_count": len(missing),
                "missing_ids_sample": missing[:10],
                "duplicate_phones": _count_duplicates([p["phone"] for p in self.persons]),
                "duplicate_aadhaar": _count_duplicates([p["aadhar"] for p in self.persons]),
                "duplicate_names": _count_duplicates([p["name"] for p in self.persons]),
            },
            "referential_integrity": ri,
        }

    # -- queries ------------------------------------------------------------
    @staticmethod
    def _slice(rows: list[dict], offset: int, limit: int) -> tuple[list[dict], int]:
        return rows[offset : offset + limit], len(rows)

    def list_persons(
        self,
        offset: int,
        limit: int,
        *,
        city: Optional[str] = None,
        state: Optional[str] = None,
        ring_id: Optional[int] = None,
        q: Optional[str] = None,
    ) -> tuple[list[dict], int]:
        rows = self.persons
        if city:
            rows = [r for r in rows if r["city"].lower() == city.lower()]
        if state:
            rows = [r for r in rows if r["state"].lower() == state.lower()]
        if ring_id is not None:
            rows = [r for r in rows if r["ring_id"] == ring_id]
        if q:
            needle = q.lower()
            rows = [r for r in rows if needle in r["name"].lower()]
        return self._slice(rows, offset, limit)

    def get_person(self, person_id: int) -> Optional[dict]:
        return self._index["persons"].get(person_id)

    def list_calls(
        self,
        offset: int,
        limit: int,
        *,
        caller_id: Optional[int] = None,
        callee_id: Optional[int] = None,
    ) -> tuple[list[dict], int]:
        rows = self.calls
        if caller_id is not None:
            rows = [r for r in rows if r["caller_id"] == caller_id]
        if callee_id is not None:
            rows = [r for r in rows if r["callee_id"] == callee_id]
        return self._slice(rows, offset, limit)

    def get_call(self, call_id: int) -> Optional[dict]:
        return self._index["calls"].get(call_id)

    def list_transactions(
        self,
        offset: int,
        limit: int,
        *,
        sender_id: Optional[int] = None,
        receiver_id: Optional[int] = None,
        mode: Optional[str] = None,
    ) -> tuple[list[dict], int]:
        rows = self.transactions
        if sender_id is not None:
            rows = [r for r in rows if r["sender_id"] == sender_id]
        if receiver_id is not None:
            rows = [r for r in rows if r["receiver_id"] == receiver_id]
        if mode:
            rows = [r for r in rows if r["mode"].lower() == mode.lower()]
        return self._slice(rows, offset, limit)

    def get_transaction(self, txn_id: int) -> Optional[dict]:
        return self._index["transactions"].get(txn_id)

    def list_locations(
        self,
        offset: int,
        limit: int,
        *,
        city: Optional[str] = None,
        state: Optional[str] = None,
    ) -> tuple[list[dict], int]:
        rows = self.locations
        if city:
            rows = [r for r in rows if r["city"].lower() == city.lower()]
        if state:
            rows = [r for r in rows if r["state"].lower() == state.lower()]
        return self._slice(rows, offset, limit)

    def get_location(self, location_id: int) -> Optional[dict]:
        return self._index["locations"].get(location_id)

    def list_firs(
        self,
        offset: int,
        limit: int,
        *,
        complainant_id: Optional[int] = None,
        accused_id: Optional[int] = None,
        location_id: Optional[int] = None,
    ) -> tuple[list[dict], int]:
        rows = self.firs
        if complainant_id is not None:
            rows = [r for r in rows if r["complainant_id"] == complainant_id]
        if accused_id is not None:
            rows = [r for r in rows if r["accused_id"] == accused_id]
        if location_id is not None:
            rows = [r for r in rows if r["location_id"] == location_id]
        return self._slice(rows, offset, limit)

    def get_fir(self, fir_id: int) -> Optional[dict]:
        return self._index["firs"].get(fir_id)
