"""The writable investigation store (spec §1).

Two hard rules shape this module:

* **The synthetic dataset is read-only.** Accepted live records live here, in
  their own directory (``settings.ingest_dir``) and their own in-memory lists.
  Not one byte is written back to the CSVs under ``settings.dataset_dir``, and
  the repository's own record lists are never mutated.
* **A record's identity is its content.** Records are keyed by the ``record_id``
  from :func:`app.ingest.models.make_record_id`, so storing the same normalized
  observation twice is impossible by construction rather than by a check.

Persistence, when enabled, is an append-only JSONL journal of *submissions*
(raw payload + provenance + the original ingestion time), not of derived
conclusions. On startup those submissions are replayed through the same
pipeline that first judged them, so a restored store cannot disagree with the
pipeline about what a record means. Derived state is never trusted from disk.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from app.config import Settings
from app.ingest.models import (
    IngestRecord,
    IngestStatus,
    Provenance,
    SourceType,
)

logger = logging.getLogger(__name__)

JOURNAL_FILENAME = "records.jsonl"

# Statuses worth surviving a restart: an accepted observation, and a submission
# still waiting for an investigator. A REJECTED submission never became a
# record of anything, so it is reported and not journalled.
PERSISTED_STATUSES = frozenset({IngestStatus.ACCEPTED, IngestStatus.REVIEW_REQUIRED})


class Submission:
    """One journalled submission: exactly what is needed to replay it."""

    __slots__ = ("record_id", "source_type", "raw_payload", "provenance", "ingested_at")

    def __init__(
        self,
        record_id: str,
        source_type: SourceType,
        raw_payload: dict[str, Any],
        provenance: Provenance,
        ingested_at: str,
    ) -> None:
        self.record_id = record_id
        self.source_type = source_type
        self.raw_payload = raw_payload
        self.provenance = provenance
        self.ingested_at = ingested_at

    def as_json(self) -> str:
        return json.dumps(
            {
                "record_id": self.record_id,
                "source_type": self.source_type.value,
                "raw_payload": self.raw_payload,
                "provenance": self.provenance.as_dict(),
                "ingested_at": self.ingested_at,
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    @classmethod
    def from_json(cls, line: str) -> "Submission":
        data = json.loads(line)
        prov = data.get("provenance") or {}
        return cls(
            record_id=data["record_id"],
            source_type=SourceType(data["source_type"]),
            raw_payload=data.get("raw_payload") or {},
            provenance=Provenance(
                source_type=prov.get("source_type", data["source_type"]),
                source_name=prov.get("source_name", "unknown"),
                submitted_by=prov.get("submitted_by"),
                reference=prov.get("reference"),
                note=prov.get("note"),
            ),
            ingested_at=data["ingested_at"],
        )


class IngestStore:
    """In-memory record store with an optional append-only journal."""

    def __init__(self, settings: Settings, repo) -> None:
        self.settings = settings
        self._records: dict[str, IngestRecord] = {}
        self._by_entity: dict[str, list[str]] = {}
        # How many times an already-stored observation was submitted again. The
        # record itself is not rewritten (its content is its identity), but the
        # resubmission is worth counting rather than discarding silently.
        self._duplicate_submissions: dict[str, int] = {}

        # Live structured rows, shaped exactly like the repository's own rows so
        # Phase 4 detectors can read them through the overlay in
        # `app.ingest.recompute` without a single change to Phase 4 code.
        self.live_calls: list[dict] = []
        self.live_transactions: list[dict] = []
        self.live_firs: list[dict] = []
        # Accepted person->location observations. These add graph evidence; they
        # deliberately do NOT rewrite a person's recorded home location, so no
        # dataset fact is overwritten by an observation.
        self.live_observations: list[dict] = []

        # Live row ids continue past the dataset's, so a live row can never be
        # mistaken for (or collide with) a dataset row.
        self._next_call_id = _max_id(repo.calls, "call_id") + 1
        self._next_txn_id = _max_id(repo.transactions, "txn_id") + 1
        self._next_fir_id = _max_id(repo.firs, "fir_id") + 1

        self._journal: Optional[Path] = None
        if settings.ingest_persist:
            self._journal = Path(settings.ingest_dir) / JOURNAL_FILENAME
            self._journal.parent.mkdir(parents=True, exist_ok=True)

    # -- identity / lookup --------------------------------------------------
    def has(self, record_id: str) -> bool:
        return record_id in self._records

    def get(self, record_id: str) -> Optional[IngestRecord]:
        return self._records.get(record_id)

    def __len__(self) -> int:
        return len(self._records)

    def __iter__(self) -> Iterator[IngestRecord]:
        return iter(self._records.values())

    def counts(self) -> dict[str, int]:
        out = {status.value: 0 for status in IngestStatus}
        for record in self._records.values():
            out[record.status.value] += 1
        out["total"] = len(self._records)
        out["duplicate_submissions"] = sum(self._duplicate_submissions.values())
        return out

    def note_duplicate(self, record_id: str) -> int:
        """Count one resubmission of an existing record; returns the new total."""
        total = self._duplicate_submissions.get(record_id, 0) + 1
        self._duplicate_submissions[record_id] = total
        return total

    def duplicate_submissions(self, record_id: str) -> int:
        return self._duplicate_submissions.get(record_id, 0)

    def for_entity(self, entity_id: str) -> list[IngestRecord]:
        """Records that touched ``entity_id``, oldest first (spec §3 changes)."""
        return [self._records[rid] for rid in self._by_entity.get(entity_id, [])]

    def list_records(
        self,
        *,
        status: Optional[IngestStatus] = None,
        source_type: Optional[SourceType] = None,
    ) -> list[IngestRecord]:
        records = [
            r
            for r in self._records.values()
            if (status is None or r.status is status)
            and (source_type is None or r.source_type is source_type)
        ]
        records.reverse()  # newest first: what a review queue wants
        return records

    # -- writes -------------------------------------------------------------
    def put(self, record: IngestRecord) -> IngestRecord:
        """Store a judged record. Idempotent: an existing id is left untouched."""
        existing = self._records.get(record.record_id)
        if existing is not None:
            return existing
        self._records[record.record_id] = record
        for entity_id in record.entity_ids:
            self._by_entity.setdefault(entity_id, []).append(record.record_id)
        if record.status in PERSISTED_STATUSES:
            self._append_journal(record)
        return record

    def _append_journal(self, record: IngestRecord) -> None:
        if self._journal is None:
            return
        submission = Submission(
            record_id=record.record_id,
            source_type=record.source_type,
            raw_payload=record.raw_payload,
            provenance=record.provenance,
            ingested_at=record.ingested_at,
        )
        try:
            with self._journal.open("a", encoding="utf-8") as fh:
                fh.write(submission.as_json() + "\n")
        except OSError:  # pragma: no cover - a full disk must not lose the API
            logger.exception("Could not journal ingest record %s", record.record_id)

    def read_journal(self) -> list[Submission]:
        """Replayable submissions in original order; empty if there is none."""
        if self._journal is None or not self._journal.exists():
            return []
        out: list[Submission] = []
        for lineno, line in enumerate(
            self._journal.read_text(encoding="utf-8").splitlines(), start=1
        ):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(Submission.from_json(line))
            except (ValueError, KeyError):
                logger.warning(
                    "Skipping unreadable ingest journal line %s:%d", self._journal, lineno
                )
        return out

    def suspend_journal(self) -> Optional[Path]:
        """Temporarily stop journalling (used while replaying it)."""
        path, self._journal = self._journal, None
        return path

    def resume_journal(self, path: Optional[Path]) -> None:
        self._journal = path

    # -- derived live rows --------------------------------------------------
    def add_live_call(
        self, *, caller_id: int, callee_id: int, start_time: str, duration_sec: int,
        cell_tower_id: Optional[int],
    ) -> dict:
        row = {
            "call_id": self._next_call_id,
            "caller_id": int(caller_id),
            "callee_id": int(callee_id),
            "start_time": start_time,
            "duration_sec": int(duration_sec),
            "cell_tower_id": cell_tower_id,
        }
        self._next_call_id += 1
        self.live_calls.append(row)
        return row

    def add_live_transaction(
        self, *, sender_id: int, receiver_id: int, amount_inr: float, txn_time: str,
        mode: str, bank_ref: str,
    ) -> dict:
        row = {
            "txn_id": self._next_txn_id,
            "sender_id": int(sender_id),
            "receiver_id": int(receiver_id),
            "amount_inr": float(amount_inr),
            "txn_time": txn_time,
            "mode": mode,
            "bank_ref": bank_ref,
        }
        self._next_txn_id += 1
        self.live_transactions.append(row)
        return row

    def add_live_fir(
        self, *, date: str, complainant_id: int, accused_id: Optional[int],
        location_id: int, narrative: str,
    ) -> dict:
        row = {
            "fir_id": self._next_fir_id,
            "date": date,
            "complainant_id": int(complainant_id),
            "accused_id": None if accused_id is None else int(accused_id),
            "location_id": int(location_id),
            "narrative": narrative,
        }
        self._next_fir_id += 1
        self.live_firs.append(row)
        return row

    def add_live_observation(
        self, *, person_id: int, location_id: int, observed_at: Optional[str]
    ) -> dict:
        row = {
            "person_id": int(person_id),
            "location_id": int(location_id),
            "observed_at": observed_at,
        }
        self.live_observations.append(row)
        return row

    def live_counts(self) -> dict[str, int]:
        return {
            "calls": len(self.live_calls),
            "transactions": len(self.live_transactions),
            "firs": len(self.live_firs),
            "location_observations": len(self.live_observations),
        }


def _max_id(rows: Iterable[dict], key: str) -> int:
    return max((int(r[key]) for r in rows), default=0)
