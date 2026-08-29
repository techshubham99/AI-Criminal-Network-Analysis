"""CSV bulk import: preview first, commit only on confirmation (Phase 6.2).

A preview answers "what would this file do to the investigation?" without doing
any of it. That guarantee is structural, not a convention:

* Every row is judged by :meth:`app.ingest.pipeline.IngestPipeline.classify` —
  the same steps 2-7 a single submission walks — which writes nothing.
* Candidate rows are then applied to an **overlay** graph and a **snapshot**
  ingest store. The overlay is a fresh :class:`NetworkXGraphStore` seeded with the
  live store's own node and edge objects; :mod:`app.ingest.graph_update` writes a
  replacement :class:`Edge` rather than mutating one in place, so the overlay's
  writes land in the overlay's dictionaries and cannot reach the live graph.
* Analytics and pattern detection run through the existing
  :class:`app.ingest.recompute.Recomputer`, pointed at the overlay. The Phase 3
  narrative pipeline is skipped for a preview, because that one *does* write to
  the live narrative overlay.
* Nothing is journalled, nothing is audited and no event other than progress is
  published until :meth:`BulkIngest.confirm` runs.

Duplicates are excluded, never asked about: a record id is a hash of its
normalized content, so a row that is already in the store is already recorded and
there is nothing for an investigator to decide about it.

An "All Types" upload (Phase 6.2b) is the same machinery run once, not once per
file: each file is parsed and judged on its own, and then *every* candidate row
from *every* file is applied to ONE overlay before the analytics and the
detectors read it. That is the whole point of the mode. A call file and a
transaction file describing the same pair of people become two rows on one
overlay, so the existing detectors see the pair rather than two unrelated halves
of it. Previewing each file separately could not do that, however the results
were merged afterwards.

Progress frames are published on the existing SSE channel, one per real
checkpoint. There are no timers and no synthetic stages: a frame says work has
finished, never that it is about to start.
"""
from __future__ import annotations

import csv
import hashlib
import io
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Optional

from app.core.errors import BadRequestError, NotFoundError
from app.graph.model import Edge, Node
from app.graph.store import NetworkXGraphStore
from app.ingest.events import EventType
from app.ingest.models import (
    INGEST_DISCLAIMER,
    IngestRecord,
    IngestStatus,
    Provenance,
    SourceType,
)
from app.ingest.normalize import reference_label
from app.ingest.recompute import Recomputer

logger = logging.getLogger(__name__)

# Upload bounds. A preview runs a full global analytics pass over the overlay, so
# the row cap is what keeps one upload from becoming an unbounded computation.
MAX_ROWS = 2000
MAX_BYTES = 5 * 1024 * 1024
# How long a computed preview stays confirmable. A preview describes the graph as
# it was when the preview ran, so it is deliberately not kept indefinitely.
PREVIEW_TTL_SEC = 1800.0
# Immediate neighbours of the affected entities, per the preview contract.
PREVIEW_DEPTH = 1

# The six checkpoints, in the order they are reached.
STAGES = (
    "received",
    "validating",
    "checking_duplicates",
    "building_preview",
    "analyzing_preview",
    "preview_ready",
)

# Flat CSV columns, mapped onto the nested payload the normalizers expect. A
# person reference is spelled `<field>_<identifier>`; everything else is a
# top-level column of the same name a single submission uses.
_REFERENCE_FIELDS: dict[SourceType, tuple[str, ...]] = {
    SourceType.CALL: ("caller", "callee"),
    SourceType.TRANSACTION: ("sender", "receiver"),
    SourceType.LOCATION: ("person",),
    SourceType.FIR: ("complainant", "accused"),
}
# Column suffix -> the identifier key :func:`app.ingest.normalize.normalize_reference`
# reads. Two spellings of a person id are accepted because the corpus uses one and
# the ingest API uses the other: `calls.csv` names its parties `caller_id` and
# `callee_id` — the same column names the graph builder, the live store and the
# Phase 4 detectors use — while a single submission posts `caller: {person_id}`.
# A file exported from the dataset must therefore import as itself. `_person_id`
# is the explicit long form and wins if a file somehow carries both.
_REFERENCE_SUFFIXES: dict[str, str] = {
    "person_id": "person_id",
    "id": "person_id",
    "phone": "phone",
    "aadhaar": "aadhaar",
    "aadhar": "aadhar",
    "name": "name",
}
# The references a row of this type cannot be built without. An FIR may name no
# accused yet, so `accused` is absent here; every other role is required by its
# normalizer. A file whose header cannot supply one of these cannot yield a single
# usable row, which is a fact about the file rather than about its rows.
_REQUIRED_REFERENCES: dict[SourceType, tuple[str, ...]] = {
    SourceType.CALL: ("caller", "callee"),
    SourceType.TRANSACTION: ("sender", "receiver"),
    SourceType.LOCATION: ("person",),
    SourceType.FIR: ("complainant",),
}
_SCALAR_FIELDS: dict[SourceType, tuple[str, ...]] = {
    SourceType.CALL: ("start_time", "duration_sec", "cell_tower_id"),
    SourceType.TRANSACTION: (
        "amount_inr", "txn_time", "mode", "bank_ref", "reference_id",
    ),
    SourceType.LOCATION: ("observed_at", "location_id", "city", "state"),
    SourceType.FIR: ("date", "narrative", "location_id", "city", "state"),
}

# What a row was judged to be. ACCEPTED is reported as NEW_VALID because in a
# bulk preview nothing has been accepted yet.
NEW_VALID = "NEW_VALID"
_VERDICTS = {
    IngestStatus.ACCEPTED: NEW_VALID,
    IngestStatus.DUPLICATE: "DUPLICATE",
    IngestStatus.REVIEW_REQUIRED: "REVIEW_REQUIRED",
    IngestStatus.REJECTED: "REJECTED",
}

# Publishes one progress frame for the import it was built for.
_Stager = Callable[[str], None]


def columns_for(source_type: SourceType) -> list[str]:
    """Every column this source type reads. Used to explain a rejected file."""
    return [
        f"{field_name}_{suffix}"
        for field_name in _REFERENCE_FIELDS[source_type]
        for suffix in _REFERENCE_SUFFIXES
    ] + list(_SCALAR_FIELDS[source_type])


@dataclass
class BulkRow:
    """One judged row of the uploaded file."""

    row: int
    verdict: str
    reason: str
    summary: str
    record_id: Optional[str] = None
    # Which file the row came from. ``None`` in a single-type import, where every
    # row is of the one type the request named.
    source_type: Optional[str] = None
    file_index: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "row": self.row,
            "verdict": self.verdict,
            "reason": self.reason,
            "summary": self.summary,
            "record_id": self.record_id,
            "source_type": self.source_type,
        }


@dataclass
class Candidate:
    """A NEW_VALID row, kept so confirm can re-judge it against the live store.

    It carries its own source type and provenance, because a combined preview
    holds candidates from several files at once and each must be re-judged as
    what it is.
    """

    row: int
    payload: dict[str, Any]
    source_type: SourceType
    provenance: Provenance
    file_index: int = 0


@dataclass
class BulkUpload:
    """One selected file in an All Types upload."""

    source_type: SourceType
    filename: str
    content: str
    provenance: Provenance


@dataclass
class BulkFile:
    """What one selected file contributed to a combined preview."""

    index: int
    source_type: str
    filename: str
    # ok | skipped | rejected | review | error, and `committed` after a commit.
    # "skipped" means the rows are already in the system; it is not a synonym for
    # "produced nothing", because a file can produce nothing by being unusable.
    status: str
    counts: dict[str, int]
    import_id: Optional[str] = None
    error: Optional[str] = None
    # Why the file contributed nothing new, in the words the row itself was given.
    # None when it did contribute, or when the file itself could not be read — that
    # is what ``error`` is for.
    reason: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "source_type": self.source_type,
            "filename": self.filename,
            "status": self.status,
            "counts": self.counts,
            "import_id": self.import_id,
            "error": self.error,
            "reason": self.reason,
        }


@dataclass
class BulkPreview:
    """A computed preview, held in memory until it is confirmed or rejected."""

    import_id: str
    source_type: Optional[SourceType]
    provenance: Optional[Provenance]
    created_at: float
    counts: dict[str, int]
    candidates: list[Candidate]
    rows: list[BulkRow]
    metrics: dict[str, Any]
    network_nodes: list[Node]
    network_edges: list[Edge]
    network_meta: dict[str, Any]
    patterns: list[Any] = field(default_factory=list)
    # ``call`` for a single-type import; ``call+transaction`` for a combined one.
    source_label: str = ""
    # Per-file detail and the per-file import ids, for a combined import only.
    files: list[BulkFile] = field(default_factory=list)
    graph_before: dict[str, int] = field(default_factory=dict)

    def rows_with(self, verdict: str) -> list[BulkRow]:
        return [r for r in self.rows if r.verdict == verdict]

    @property
    def commit_applicable(self) -> bool:
        return bool(self.candidates)

    @property
    def is_batch(self) -> bool:
        return bool(self.files)

    @property
    def import_ids(self) -> list[str]:
        """Every id this preview answers to: the batch id, then each file's."""
        return [self.import_id] + [f.import_id for f in self.files if f.import_id]


@dataclass
class _Analysis:
    """What reading one overlay produced. Internal to this module."""

    metrics: dict[str, Any]
    nodes: list[Node]
    edges: list[Edge]
    meta: dict[str, Any]
    patterns: list[Any]
    graph_before: dict[str, int]


class BulkIngest:
    """Preview and commit CSV imports. Owns previews, and nothing else."""

    def __init__(self, pipeline) -> None:
        self.pipeline = pipeline
        self._previews: dict[str, BulkPreview] = {}
        self._lock = threading.Lock()

    # ==================================================================
    # preview
    # ==================================================================
    def preview(
        self, source_type: SourceType, content: str, provenance: Provenance
    ) -> BulkPreview:
        """Judge every row and compute what committing them would produce."""
        import_id = _import_id(source_type, content)
        stage = self._stager(import_id)
        stage("received")

        rows = parse_csv(source_type, content)
        stage("validating")

        judged, candidates = _judge(
            self.pipeline, source_type, rows, provenance, set(), 0, tag_type=False
        )
        counts = _counts(judged)
        stage("checking_duplicates")

        analysis = self._analyse(candidates, stage)
        preview = BulkPreview(
            import_id=import_id,
            source_type=source_type,
            provenance=provenance,
            created_at=time.monotonic(),
            counts=counts,
            candidates=candidates,
            rows=judged,
            metrics=analysis.metrics,
            network_nodes=analysis.nodes,
            network_edges=analysis.edges,
            network_meta=analysis.meta,
            patterns=analysis.patterns,
            source_label=source_type.value,
            graph_before=analysis.graph_before,
        )
        self._hold(preview)
        stage("preview_ready")
        logger.info(
            "Bulk preview %s (%s): %s", import_id[:12], source_type.value, counts
        )
        return preview

    def preview_batch(self, uploads: list[BulkUpload]) -> BulkPreview:
        """One combined preview for several files of different types (Phase 6.2b).

        Every file is validated and judged on its own — an unusable file is
        reported as such and the rest of the batch continues — and then all of the
        candidate rows are handed to the *same* :meth:`_analyse` the single-type
        path uses. One overlay, one analytics pass, one detector pass, one
        sequence of progress frames for the whole batch.

        Row numbers restart per file, so a judged row carries the source type of
        the file it came from and its index in the selection.
        """
        if not uploads:  # pragma: no cover - the schema requires at least one
            raise BadRequestError("No file was selected.")
        batch_id = _batch_import_id(uploads)
        detail = f"{len(uploads)} file(s)"
        stage = self._stager(batch_id, detail)
        stage("received")

        parsed: list[tuple[int, BulkUpload, list[tuple[int, dict, dict]]]] = []
        files: list[BulkFile] = []
        for index, upload in enumerate(uploads):
            try:
                rows = parse_csv(upload.source_type, upload.content)
            except BadRequestError as exc:
                # §4: one unusable file is reported, not fatal to the batch.
                files.append(
                    BulkFile(
                        index=index,
                        source_type=upload.source_type.value,
                        filename=upload.filename,
                        status="error",
                        counts=_counts([]),
                        error=exc.message,
                    )
                )
                continue
            parsed.append((index, upload, rows))
        stage("validating")

        judged: list[BulkRow] = []
        candidates: list[Candidate] = []
        # Shared across files: the same observation listed in two selected files is
        # a duplicate of itself, exactly as it would be twice in one file.
        seen: set[str] = set()
        for index, upload, rows in parsed:
            file_rows, file_candidates = _judge(
                self.pipeline,
                upload.source_type,
                rows,
                upload.provenance,
                seen,
                index,
                tag_type=True,
            )
            file_counts = _counts(file_rows)
            status, reason = _file_outcome(file_rows, file_candidates)
            files.append(
                BulkFile(
                    index=index,
                    source_type=upload.source_type.value,
                    filename=upload.filename,
                    status=status,
                    counts=file_counts,
                    import_id=_import_id(upload.source_type, upload.content),
                    reason=reason,
                )
            )
            judged.extend(file_rows)
            candidates.extend(file_candidates)
        files.sort(key=lambda f: f.index)
        counts = _counts(judged)
        stage("checking_duplicates")

        # --- the one combined overlay ---------------------------------------
        analysis = self._analyse(candidates, stage)

        types = sorted({u.source_type.value for u in uploads})
        preview = BulkPreview(
            import_id=batch_id,
            source_type=None,
            provenance=None,
            created_at=time.monotonic(),
            counts=counts,
            candidates=candidates,
            rows=judged,
            metrics=analysis.metrics,
            network_nodes=analysis.nodes,
            network_edges=analysis.edges,
            network_meta=analysis.meta,
            patterns=analysis.patterns,
            source_label="+".join(types),
            files=files,
            graph_before=analysis.graph_before,
        )
        self._hold(preview)
        stage("preview_ready")
        logger.info(
            "Bulk preview %s (%d file(s), %s): %s",
            batch_id[:12],
            len(uploads),
            preview.source_label,
            counts,
        )
        return preview

    def _analyse(
        self, candidates: list[Candidate], stage: _Stager
    ) -> _Analysis:
        """Apply every candidate row to ONE overlay, then read the overlay.

        This is the only place a bulk preview computes anything, and it is shared
        by both modes: the single-type path passes one file's candidates, the
        combined path passes every selected file's. Each candidate is re-judged
        with its own source type and provenance, so a mixed batch is applied as
        the mixture it is.

        The overlay is a fresh store seeded with the live store's node and edge
        objects, plus a snapshot ingest store. Both are discarded with this call;
        nothing here can reach the live graph, the live store or the ledger.
        """
        pipeline = self.pipeline
        settings = pipeline.settings
        live = pipeline.graph.store.graph_summary()
        graph_before = {
            "nodes": int(live.get("node_count", 0)),
            "edges": int(live.get("edge_count", 0)),
        }

        overlay = NetworkXGraphStore()
        for node in pipeline.graph.store.iter_nodes():
            overlay.add_node(node)
        for edge in pipeline.graph.store.iter_edges():
            overlay.add_edge(edge)
        scratch = pipeline.store.snapshot(pipeline.repo)

        touched: set[int] = set()
        affected: set[str] = set()
        for candidate in candidates:
            record = pipeline.classify(
                candidate.source_type, candidate.payload, candidate.provenance
            )
            if record.status is not IngestStatus.ACCEPTED:  # pragma: no cover
                continue
            _, person_ids, _ = pipeline.write_record(
                record, graph_store=overlay, ingest_store=scratch, run_nlp=False
            )
            touched |= person_ids
            affected.update(record.entity_ids)
        stage("building_preview")

        nodes, edges, network_meta = _preview_network(
            overlay, sorted(affected), settings.graph_max_network_nodes
        )

        metrics: dict[str, Any] = {
            "graph": overlay.graph_summary(),
            "live_rows": scratch.live_counts(),
        }
        patterns: list[Any] = []
        if candidates:
            stage("analyzing_preview")
            recomputer = Recomputer(
                pipeline.repo,
                settings,
                overlay,
                scratch,
                narrative_store=pipeline.recomputer.narrative_store,
            )
            result = recomputer.run(
                person_ids=sorted(touched),
                before_analytics=pipeline.graph.cached_analytics,
                before_intelligence=pipeline.intelligence,
            )
            communities = result.analytics.communities_summary()
            metrics["analytics"] = result.analytics.projection_stats()
            metrics["communities"] = {
                "count": communities["community_count"],
                "modularity": communities["modularity"],
                "adjusted_rand_index_vs_rings": communities["ground_truth_overlay"][
                    "adjusted_rand_index"
                ],
                "ari_persons": communities["ground_truth_overlay"]["ari_persons"],
            }
            metrics["recompute_cost_ms"] = result.cost_ms
            metrics["priority_changes"] = list(result.priority_changes)
            # One entry per pattern id. The detectors already emit each id once;
            # this is the safety net for a combined preview, where the same id
            # must not be listed twice because two files contributed to it.
            new_ids = set(result.new_pattern_ids)
            unique: dict[str, Any] = {}
            for pattern in result.intelligence.patterns:
                if pattern.pattern_id in new_ids:
                    unique.setdefault(pattern.pattern_id, pattern)
            patterns = list(unique.values())
        else:
            stage("analyzing_preview")
            metrics["note"] = (
                "No new rows to analyse, so no analytics were recomputed."
            )
        return _Analysis(
            metrics=metrics,
            nodes=nodes,
            edges=edges,
            meta=network_meta,
            patterns=patterns,
            graph_before=graph_before,
        )

    # ==================================================================
    # confirm / reject
    # ==================================================================
    def confirm(self, import_id: str) -> dict[str, Any]:
        """Commit a preview's NEW_VALID rows for real.

        The preview is taken out of the registry first, so a confirmation happens
        at most once even if the request arrives twice — and for a combined import,
        confirming through any one of its ids consumes the whole batch. Every row is
        then re-judged against the live store: a row that became a duplicate or
        lost its resolution since the preview is skipped and reported, not forced
        through.

        One import is one write: the rows go in, the global recomputation runs once
        for the whole batch, and one audit event records the decision. There is no
        per-file recomputation and no per-file event.
        """
        preview = self._take(import_id)
        if preview is None:
            raise NotFoundError("Bulk import", import_id)

        pipeline = self.pipeline
        records: list[IngestRecord] = []
        skipped: list[dict[str, Any]] = []
        seen: set[str] = set()
        imported_per_file: dict[int, int] = {}
        for candidate in preview.candidates:
            record = pipeline.classify(
                candidate.source_type, candidate.payload, candidate.provenance
            )
            if record.status is IngestStatus.ACCEPTED and record.record_id not in seen:
                seen.add(record.record_id)
                records.append(record)
                imported_per_file[candidate.file_index] = (
                    imported_per_file.get(candidate.file_index, 0) + 1
                )
            else:
                skipped.append(
                    {
                        "row": candidate.row,
                        "source_type": candidate.source_type.value,
                        "verdict": _VERDICTS[record.status],
                        "reason": record.reason,
                    }
                )

        before = pipeline.graph.store.graph_summary()
        outcome = pipeline.apply_batch(records)
        manifest: dict[str, Any] = {
            "import_id": preview.import_id,
            "source_type": preview.source_label,
            "record_ids": [r.record_id for r in records],
        }
        if preview.is_batch:
            # The manifest hash commits to which files were imported as well as
            # which rows: the filenames are hashed, never stored (Phase 5 §1).
            manifest["files"] = [
                {
                    "import_id": f.import_id,
                    "source_type": f.source_type,
                    "filename": f.filename,
                    "status": f.status,
                }
                for f in preview.files
            ]
        for record in records:
            record.impact["bulk_import_id"] = preview.import_id

        counts = dict(preview.counts)
        counts["imported"] = len(records)
        counts["skipped_on_confirm"] = len(skipped)
        if preview.is_batch:
            counts["files"] = len(preview.files)
        out: dict[str, Any] = {
            "import_id": preview.import_id,
            "source_type": preview.source_label,
            "counts": counts,
            "record_ids": manifest["record_ids"],
            "skipped": skipped,
            "graph_totals": outcome["graph_totals"],
            "live_rows": outcome["live_rows"],
            "new_pattern_ids": outcome.get("new_pattern_ids", []),
            "priority_changes": outcome.get("priority_changes", []),
            "recompute_cost_ms": outcome.get("recompute_cost_ms", {}),
            "recompute_error": outcome.get("recompute_error"),
            "manifest_hash": None,
            "audit_event_id": None,
            "disclaimer": INGEST_DISCLAIMER,
        }
        if preview.is_batch:
            out["import_ids"] = preview.import_ids
            out["graph_before"] = {
                "nodes": int(before.get("node_count", 0)),
                "edges": int(before.get("edge_count", 0)),
            }
            out["files"] = [
                {
                    **f.as_dict(),
                    "imported": imported_per_file.get(f.index, 0),
                    # A file that wrote rows is committed. A file that had rows to
                    # write and wrote none lost them between preview and commit, so
                    # they are in the system now: skipped. A file that never had any
                    # keeps the status that says why — it is still not a duplicate.
                    "status": (
                        "committed"
                        if imported_per_file.get(f.index)
                        else ("skipped" if f.status == "ok" else f.status)
                    ),
                }
                for f in preview.files
            ]
        out["manifest_hash"] = self._audit(preview, manifest, counts, out)
        logger.info(
            "Bulk import %s committed %d record(s)",
            preview.import_id[:12],
            len(records),
        )
        return out

    def reject(self, import_id: str) -> dict[str, Any]:
        """Discard a preview. Writes nothing, and an expired id is not an error."""
        discarded = self._take(import_id) is not None
        return {
            "import_id": import_id,
            "discarded": discarded,
            "note": (
                "Preview discarded. Nothing was written to the graph, the store or "
                "the audit ledger."
                if discarded
                else "No preview is held for this import id. Nothing was written."
            ),
        }

    def get(self, import_id: str) -> Optional[BulkPreview]:
        with self._lock:
            self._prune()
            return self._previews.get(import_id)

    # ==================================================================
    # internals
    # ==================================================================
    def _audit(
        self,
        preview: BulkPreview,
        manifest: dict[str, Any],
        counts: dict[str, int],
        out: dict[str, Any],
    ) -> Optional[str]:
        """One audit event for the whole import (Phase 5 §11, Phase 6.2).

        An import is one investigator decision, so it is one link in the chain —
        one link for a combined multi-file import too, addressed by its batch id.
        The committed record ids are committed to by hash: the ledger proves which
        set was imported without holding the set. For a combined import the
        manifest also names the files, so the hash covers them as well; the
        filenames themselves stay out of the ledger.
        """
        audit = self.pipeline.audit
        if audit is None:
            return None
        try:
            from app.audit.models import content_hash

            manifest_hash = content_hash(manifest)
            event = audit.record_bulk_import(
                preview.import_id,
                source_type=preview.source_label,
                counts=counts,
                manifest_hash=manifest_hash,
            )
            out["audit_event_id"] = event.audit_event_id
            return manifest_hash
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Audit append failed for bulk import %s", preview.import_id)
            out["audit_error"] = f"{type(exc).__name__}: {exc}"
            return None

    def _hold(self, preview: BulkPreview) -> None:
        """Register a preview under every id it answers to.

        A combined preview is one object registered under the batch id and under
        each file's own import id, so "reject each import id" — which is what the
        client does with a multi-file selection — reaches the same preview and is
        idempotent after the first call.
        """
        with self._lock:
            self._prune()
            for key in preview.import_ids:
                self._previews[key] = preview

    def _take(self, import_id: str) -> Optional[BulkPreview]:
        """Remove a preview by any of its ids, and drop its other ids with it."""
        with self._lock:
            self._prune()
            preview = self._previews.pop(import_id, None)
            if preview is not None:
                for key in [k for k, p in self._previews.items() if p is preview]:
                    del self._previews[key]
            return preview

    def _prune(self) -> None:
        cutoff = time.monotonic() - PREVIEW_TTL_SEC
        for key in [k for k, p in self._previews.items() if p.created_at < cutoff]:
            del self._previews[key]

    def _stager(self, import_id: str, detail: Optional[str] = None) -> _Stager:
        """A one-argument publisher, so the shared analysis need not know the id.

        ``detail`` is the sub-label of a combined import ("3 file(s)"). It rides
        along on every frame of the one sequence; it does not add frames.
        """

        def stage(name: str) -> None:
            data: dict[str, Any] = {"import_id": import_id, "stage": name}
            if detail is not None:
                data["detail"] = detail
            self.pipeline.bus.publish(EventType.BULK_PREVIEW, data)

        return stage


# ==================================================================
# judging
# ==================================================================
def _judge(
    pipeline,
    source_type: SourceType,
    rows: list[tuple[int, dict[str, str], dict[str, Any]]],
    provenance: Provenance,
    seen: set[str],
    file_index: int,
    *,
    tag_type: bool,
) -> tuple[list[BulkRow], list[Candidate]]:
    """Classify one file's rows. Writes nothing.

    ``seen`` is the caller's, so a combined upload can treat the same observation
    listed in two files the way it treats it twice in one file. ``tag_type`` marks
    each row with its source type, which a combined preview needs to tell "row 1"
    of one file from "row 1" of another.
    """
    judged: list[BulkRow] = []
    candidates: list[Candidate] = []
    repeat_reason = (
        "Identical to an earlier row in this upload."
        if tag_type
        else "Identical to an earlier row in this file."
    )
    for number, raw, payload in rows:
        record = pipeline.classify(source_type, payload, provenance)
        verdict = _VERDICTS[record.status]
        reason = record.reason
        if record.status is not IngestStatus.REJECTED:
            if record.record_id in seen:
                verdict = "DUPLICATE"
                reason = repeat_reason
            else:
                seen.add(record.record_id)
        if verdict == NEW_VALID:
            candidates.append(
                Candidate(
                    row=number,
                    payload=payload,
                    source_type=source_type,
                    provenance=provenance,
                    file_index=file_index,
                )
            )
        judged.append(
            BulkRow(
                row=number,
                verdict=verdict,
                reason=reason,
                summary=_summary(source_type, record, raw),
                record_id=(
                    None if record.status is IngestStatus.REJECTED else record.record_id
                ),
                source_type=source_type.value if tag_type else None,
                file_index=file_index,
            )
        )
    return judged, candidates


def _counts(judged: list[BulkRow]) -> dict[str, int]:
    return {
        "total": len(judged),
        "new_valid": sum(1 for r in judged if r.verdict == NEW_VALID),
        "duplicate": sum(1 for r in judged if r.verdict == "DUPLICATE"),
        "review_required": sum(1 for r in judged if r.verdict == "REVIEW_REQUIRED"),
        "rejected": sum(1 for r in judged if r.verdict == "REJECTED"),
    }


# Which status a file gets when it produced no new row, by what actually happened
# to its rows. Ordered: a tie goes to the more serious outcome, because a file the
# investigator must look at should not be reported as one already dealt with.
_NO_NEW_STATUS = (
    ("REJECTED", "rejected"),
    ("REVIEW_REQUIRED", "review"),
    ("DUPLICATE", "skipped"),
)


def _file_outcome(
    rows: list[BulkRow], candidates: list[Candidate]
) -> tuple[str, Optional[str]]:
    """A file's status, and why, when it contributed nothing new.

    "Nothing new" has several causes and they are not interchangeable: rows already
    in the system are *skipped*, rows whose fields are unusable are *rejected*, and
    rows whose person could not be resolved to exactly one existing person need
    *review*. Reporting all three as "skipped" tells the investigator the file was
    already dealt with when in fact none of it was read, so the dominant outcome
    names the status and that outcome's own reason is carried with it.
    """
    if candidates:
        return "ok", None
    grouped = {verdict: [r for r in rows if r.verdict == verdict] for verdict, _ in _NO_NEW_STATUS}
    verdict, status = max(
        _NO_NEW_STATUS,
        key=lambda pair: len(grouped[pair[0]]),
    )
    matched = grouped[verdict]
    if not matched:  # no rows at all; nothing to explain
        return "skipped", None
    return status, matched[0].reason


# ==================================================================
# parsing
# ==================================================================
def parse_csv(
    source_type: SourceType, content: str
) -> list[tuple[int, dict[str, str], dict[str, Any]]]:
    """Read the upload into ``(row number, raw row, payload)`` triples.

    Only the shape of the *file* is judged here. A row whose values are unusable
    is not an error: it becomes a REJECTED row with the field that failed, exactly
    as a single submission would.
    """
    size = len(content.encode("utf-8"))
    if size > MAX_BYTES:
        raise BadRequestError(
            "The file is larger than this endpoint accepts.",
            detail={"max_bytes": MAX_BYTES, "bytes": size},
        )

    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        raise BadRequestError(
            "The file has no header row.",
            detail={"expected_columns": columns_for(source_type)},
        )
    header = {(name or "").strip().lower() for name in reader.fieldnames}
    known = set(columns_for(source_type))
    if not header & known:
        raise BadRequestError(
            f"No {source_type.value} column was found in the header.",
            detail={"expected_columns": sorted(known), "header": sorted(header)},
        )
    # A row of this type needs its people named. If no column in the header could
    # name one, no row in the file can be usable, and saying so once is the honest
    # answer — rejecting every row one at a time reports the count of a problem
    # the file has, not the rows.
    unnamed = [
        field_name
        for field_name in _REQUIRED_REFERENCES[source_type]
        if not any(f"{field_name}_{suffix}" in header for suffix in _REFERENCE_SUFFIXES)
    ]
    if unnamed:
        roles = " or ".join(unnamed)
        raise BadRequestError(
            f"No column identifies the {roles} of a "
            f"{source_type.value.lower()} row.",
            detail={
                "missing_references": unnamed,
                "expected_columns": sorted(
                    f"{field_name}_{suffix}"
                    for field_name in unnamed
                    for suffix in _REFERENCE_SUFFIXES
                ),
                "header": sorted(header),
            },
        )

    out: list[tuple[int, dict[str, str], dict[str, Any]]] = []
    for number, row in enumerate(reader, start=1):
        if number > MAX_ROWS:
            raise BadRequestError(
                "The file has more rows than this endpoint accepts.",
                detail={"max_rows": MAX_ROWS},
            )
        raw = {
            (key or "").strip().lower(): _cell(value)
            for key, value in row.items()
            if isinstance(key, str)
        }
        if not any(raw.values()):
            continue  # a blank line is not a row
        out.append((number, raw, build_payload(source_type, raw)))

    if not out:
        raise BadRequestError(
            "The file has a header but no data rows.",
            detail={"expected_columns": sorted(known)},
        )
    return out


def build_payload(source_type: SourceType, raw: dict[str, str]) -> dict[str, Any]:
    """Turn one flat CSV row into the payload a single submission would send."""
    payload: dict[str, Any] = {}
    for field_name in _REFERENCE_FIELDS[source_type]:
        reference: dict[str, Any] = {}
        for suffix, key in _REFERENCE_SUFFIXES.items():
            value = raw.get(f"{field_name}_{suffix}")
            # setdefault, and `person_id` before `id` in the mapping: a file that
            # carries both spellings is read by the explicit one.
            if value:
                reference.setdefault(key, value)
        if reference:
            payload[field_name] = reference
    for column in _SCALAR_FIELDS[source_type]:
        if raw.get(column):
            payload[column] = raw[column]
    return payload


def _cell(value: Any) -> str:
    if isinstance(value, list):  # a row with more fields than the header
        value = value[0] if value else ""
    return str(value or "").strip()


def _summary(source_type: SourceType, record: IngestRecord, raw: dict[str, str]) -> str:
    """A short label for one row, using the existing non-revealing reference label.

    A phone or Aadhaar number is shown by its last four digits, exactly as every
    other explanation in the ingestion layer shows one. A row that failed
    normalization has no references to label, so the columns it filled are named
    instead of their values.
    """
    fields = _REFERENCE_FIELDS[source_type]
    normalized = record.normalized_payload
    labels = [
        f"{name} {reference_label(normalized[name])}"
        for name in fields
        if isinstance(normalized.get(name), dict)
    ]
    if labels:
        return ", ".join(labels)[:160]
    present = [
        column
        for column in (f"{n}_{s}" for n in fields for s in _REFERENCE_SUFFIXES)
        if raw.get(column)
    ]
    return ", ".join(present[:4]) if present else "no identifying column"


def _import_id(source_type: SourceType, content: str) -> str:
    """Content-addressed, like a record id: the same file is the same import."""
    material = f"{source_type.value}|{content}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _batch_import_id(uploads: list[BulkUpload]) -> str:
    """One id for a selection of files, addressed by their contents in order."""
    material = "batch|" + "|".join(
        _import_id(u.source_type, u.content) for u in uploads
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _preview_network(
    overlay: NetworkXGraphStore, anchors: list[str], max_nodes: int
) -> tuple[list[Node], list[Edge], dict[str, Any]]:
    """The affected entities and their immediate neighbours, on the overlay."""
    nodes: dict[str, Node] = {}
    edges: dict[str, Edge] = {}
    truncated = False
    for anchor in anchors:
        if len(nodes) >= max_nodes:
            truncated = True
            break
        found_nodes, found_edges, meta = overlay.get_subgraph(
            anchor, PREVIEW_DEPTH, max_nodes=max_nodes
        )
        truncated = truncated or bool(meta.get("truncated"))
        nodes.update({n.entity_id: n for n in found_nodes})
        edges.update({e.relationship_id: e for e in found_edges})
    return (
        [nodes[k] for k in sorted(nodes)],
        [edges[k] for k in sorted(edges)],
        {
            "truncated": truncated,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "depth": PREVIEW_DEPTH,
            "max_nodes": max_nodes,
            "anchors": len(anchors),
        },
    )
