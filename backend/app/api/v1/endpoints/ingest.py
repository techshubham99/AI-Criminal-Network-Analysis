"""Live ingestion endpoints (/api/v1/ingest).

The HTTP surface for Phase 4.6. Like every other router in this project it
shapes results and decides nothing: the gate is :class:`app.ingest.pipeline
.IngestPipeline`.

One status-code choice is deliberate and worth stating plainly. A body that is
structurally wrong (missing ``caller``, a ``provenance`` that isn't an object)
never becomes a record, so it fails Pydantic and returns **422** in the standard
``validation_error`` envelope. A body that is structurally fine but carries an
unusable *value* (a duration of ``-5``, a malformed Aadhaar) **is** a record —
a rejected one — so it returns **200** with ``status: "REJECTED"`` and the field
that failed. The error envelope has nowhere to put a record, and §14 requires
the four statuses to be displayable, which they cannot be if one of them is an
HTTP error.

The stream endpoint is Server-Sent Events. There is no WebSocket route in this
project (spec §12), and the frames carry ids and counts — never narrative text,
phone numbers, Aadhaar numbers or amounts.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import StreamingResponse

from app.api.deps import get_ingest
from app.api.v1.endpoints.intelligence import _pattern_out
from app.core.errors import BadRequestError
from app.ingest.bulk import BulkPreview, BulkUpload
from app.ingest.events import format_sse, keepalive_frame
from app.ingest.models import (
    INGEST_DISCLAIMER,
    IngestRecord,
    IngestStatus,
    Provenance,
    SourceType,
)
from app.ingest.pipeline import IngestPipeline
from app.schemas.graph import EdgeOut, NodeOut
from app.schemas.ingest import (
    BulkBatchIn,
    BulkBatchPreviewOut,
    BulkConfirmOut,
    BulkFileOut,
    BulkPreviewOut,
    BulkRejectOut,
    BulkRowOut,
    BulkUploadIn,
    CallIn,
    EntityChangesOut,
    FirIn,
    ImpactOut,
    IngestRecordOut,
    IngestSummaryOut,
    LocationIn,
    ProvenanceIn,
    TransactionIn,
)
from app.schemas.intelligence import PatternListResponse

router = APIRouter()

_STATUSES = {s.value for s in IngestStatus}
_SOURCE_TYPES = {s.value for s in SourceType}


def _provenance(source_type: SourceType, raw: ProvenanceIn) -> Provenance:
    return Provenance(
        source_type=source_type.value,
        source_name=raw.source_name,
        submitted_by=raw.submitted_by,
        reference=raw.reference,
        note=raw.note,
    )


def _payload(body: Any) -> dict[str, Any]:
    """The submitted fields, minus provenance, with unset keys dropped.

    ``exclude_none`` matters for the record id: an explicit ``"accused": null``
    and an omitted ``accused`` describe the same observation and must hash the
    same.
    """
    data = body.model_dump(exclude_none=True)
    data.pop("provenance", None)
    return data


def _submit(
    pipeline: IngestPipeline, source_type: SourceType, body: Any
) -> IngestRecordOut:
    record = pipeline.submit(source_type, _payload(body), _provenance(source_type, body.provenance))
    return IngestRecordOut(**record.as_dict())


# --- POST: the four record types (spec §3) ----------------------------------
@router.post(
    "/fir",
    response_model=IngestRecordOut,
    summary="Submit a new FIR for validation and, if accepted, analysis",
)
def ingest_fir(
    body: FirIn, pipeline: IngestPipeline = Depends(get_ingest)
) -> IngestRecordOut:
    """Validate, resolve and decide on one FIR (spec §7).

    An accepted FIR additionally goes through the existing Phase 3 NLP pipeline;
    its extracted entities and the accept/reject verdict on every narrative
    relationship are reported under ``impact.nlp``. Narrative-derived edges land
    in the Phase 3 narrative overlay, never in the structured graph.
    """
    return _submit(pipeline, SourceType.FIR, body)


@router.post("/call", response_model=IngestRecordOut, summary="Submit a call record")
def ingest_call(
    body: CallIn, pipeline: IngestPipeline = Depends(get_ingest)
) -> IngestRecordOut:
    """Both parties must resolve to existing persons before an edge is created."""
    return _submit(pipeline, SourceType.CALL, body)


@router.post(
    "/transaction", response_model=IngestRecordOut, summary="Submit a transaction record"
)
def ingest_transaction(
    body: TransactionIn, pipeline: IngestPipeline = Depends(get_ingest)
) -> IngestRecordOut:
    """A transaction reference (``bank_ref``) is required: unreferenced money
    movement is not evidence of anything and is rejected as a field error."""
    return _submit(pipeline, SourceType.TRANSACTION, body)


@router.post(
    "/location", response_model=IngestRecordOut, summary="Submit a location observation"
)
def ingest_location(
    body: LocationIn, pipeline: IngestPipeline = Depends(get_ingest)
) -> IngestRecordOut:
    """Record that a person was seen at an existing location.

    The observation is added as its own edge and does **not** overwrite the
    person's recorded address. No coordinates are ever inferred for a place that
    is not already in the dataset.
    """
    return _submit(pipeline, SourceType.LOCATION, body)


# --- POST: CSV bulk import (Phase 6.2) --------------------------------------
_BULK_SOURCE_TYPES = {s.value.lower(): s for s in SourceType}


def _source(value: str) -> SourceType:
    source_type = _BULK_SOURCE_TYPES.get(value.strip().lower())
    if source_type is None:
        raise BadRequestError(
            f"Unknown source_type {value!r}",
            detail={"allowed": sorted(_BULK_SOURCE_TYPES)},
        )
    return source_type


def _preview_fields(preview: BulkPreview) -> dict[str, Any]:
    """The body both preview routes return. One shape, one code path."""
    patterns = [_pattern_out(p) for p in preview.patterns]
    return dict(
        import_id=preview.import_id,
        source_type=preview.source_label,
        counts=preview.counts,
        commit_applicable=preview.commit_applicable,
        metrics_preview=preview.metrics,
        network_preview={
            "nodes": [NodeOut.from_node(n) for n in preview.network_nodes],
            "edges": [EdgeOut.from_edge(e) for e in preview.network_edges],
            "meta": preview.network_meta,
        },
        suspicious_patterns_preview=PatternListResponse(
            total=len(patterns),
            count=len(patterns),
            offset=0,
            limit=len(patterns),
            patterns=patterns,
            filters={"scope": "new_in_preview"},
            note=(
                "Patterns the existing detectors would newly assert if this import "
                "were committed. Deterministic rule output, not an accusation."
            ),
        ),
        duplicate_rows=[BulkRowOut(**r.as_dict()) for r in preview.rows_with("DUPLICATE")],
        review_required_rows=[
            BulkRowOut(**r.as_dict()) for r in preview.rows_with("REVIEW_REQUIRED")
        ],
        rejected_rows=[BulkRowOut(**r.as_dict()) for r in preview.rows_with("REJECTED")],
        disclaimer=INGEST_DISCLAIMER,
    )


def _preview_out(preview: BulkPreview) -> BulkPreviewOut:
    return BulkPreviewOut(**_preview_fields(preview))


def _batch_preview_out(preview: BulkPreview) -> BulkBatchPreviewOut:
    return BulkBatchPreviewOut(
        **_preview_fields(preview),
        files=[BulkFileOut(**f.as_dict()) for f in preview.files],
        import_ids=preview.import_ids,
        graph_before=preview.graph_before,
    )


@router.post(
    "/bulk/preview",
    response_model=BulkBatchPreviewOut,
    summary="Judge several CSVs and compute what committing them together would produce",
)
def bulk_preview_batch(
    body: BulkBatchIn,
    pipeline: IngestPipeline = Depends(get_ingest),
) -> BulkBatchPreviewOut:
    """Preview one to four files of any types as a single import (Phase 6.2b).

    Each file is validated against its own schema and judged row by row; a file
    that is unusable is reported as an error on its own row and the rest of the
    selection continues. The candidate rows of every file are then applied to
    **one** overlay, which the existing analytics and the existing Phase 4
    detectors read once. That is what makes a relationship spanning two files —
    calls between a pair in one file, a transfer between the same pair in another —
    detectable before either file is committed.

    Nothing is written. Progress is published on the existing SSE channel as one
    six-frame ``bulk_preview`` sequence for the whole batch, addressed by the batch
    import id, with the file count as a sub-label.
    """
    uploads: list[BulkUpload] = []
    for file in body.files:
        source_type = _source(file.source_type)
        uploads.append(
            BulkUpload(
                source_type=source_type,
                filename=file.filename,
                content=file.content,
                provenance=_provenance(
                    source_type, ProvenanceIn(source_name=file.filename)
                ),
            )
        )
    return _batch_preview_out(pipeline.bulk.preview_batch(uploads))


@router.post(
    "/bulk/{source_type}/preview",
    response_model=BulkPreviewOut,
    summary="Judge a CSV and compute what committing it would produce",
)
def bulk_preview(
    body: BulkUploadIn,
    source_type: str = Path(..., description="fir | call | transaction | location"),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> BulkPreviewOut:
    """Classify every row, then compute the resulting metrics, graph and patterns.

    Nothing is written. Rows are judged by the same steps 2-7 a single submission
    walks, and the accepted ones are applied to an in-memory overlay graph and a
    snapshot store, which the existing analytics and detectors then read. The live
    graph, the live store, the audit ledger and the dataset files are untouched.

    Progress is published on the existing SSE channel as ``bulk_preview`` frames,
    one per checkpoint actually reached: ``received``, ``validating``,
    ``checking_duplicates``, ``building_preview``, ``analyzing_preview``,
    ``preview_ready``.
    """
    resolved = _source(source_type)
    provenance = _provenance(resolved, ProvenanceIn(source_name=body.filename))
    return _preview_out(pipeline.bulk.preview(resolved, body.content, provenance))


@router.post(
    "/bulk/{import_id}/confirm",
    response_model=BulkConfirmOut,
    summary="Commit a preview's new rows",
)
def bulk_confirm(
    import_id: str = Path(..., min_length=8),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> BulkConfirmOut:
    """Write the rows the preview classified as new, and only those.

    Each row is re-judged against the live store first, so a row that became a
    duplicate since the preview is skipped and reported rather than forced
    through. The global recomputation runs once for the whole import, and the
    import produces exactly one audit event, committing to the set of record ids
    it wrote by hash. An unknown or expired import id is a 404.
    """
    return BulkConfirmOut(**pipeline.bulk.confirm(import_id))


@router.post(
    "/bulk/{import_id}/reject",
    response_model=BulkRejectOut,
    summary="Discard a preview without writing anything",
)
def bulk_reject(
    import_id: str = Path(..., min_length=8),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> BulkRejectOut:
    """Drop the held preview. An id that already expired is not an error."""
    return BulkRejectOut(**pipeline.bulk.reject(import_id))


# --- reads ------------------------------------------------------------------
@router.get(
    "/records",
    response_model=list[IngestRecordOut],
    summary="List submitted records (newest first)",
)
def list_records(
    pipeline: IngestPipeline = Depends(get_ingest),
    status: Optional[str] = Query(
        None, description="ACCEPTED | DUPLICATE | REVIEW_REQUIRED | REJECTED"
    ),
    source_type: Optional[str] = Query(None, description="FIR | CALL | TRANSACTION | LOCATION"),
    limit: int = Query(50, ge=1, le=500),
) -> list[IngestRecordOut]:
    """The review queue. Rejected submissions are not listed: they were never
    stored, only reported to their submitter."""
    if status is not None and status not in _STATUSES:
        raise BadRequestError(
            f"Unknown status {status!r}", detail={"allowed": sorted(_STATUSES)}
        )
    if source_type is not None and source_type not in _SOURCE_TYPES:
        raise BadRequestError(
            f"Unknown source_type {source_type!r}",
            detail={"allowed": sorted(_SOURCE_TYPES)},
        )
    records: list[IngestRecord] = pipeline.store.list_records(
        status=IngestStatus(status) if status else None,
        source_type=SourceType(source_type) if source_type else None,
    )
    return [IngestRecordOut(**r.as_dict()) for r in records[:limit]]


@router.get("/summary", response_model=IngestSummaryOut, summary="Ingestion status")
def ingest_summary(pipeline: IngestPipeline = Depends(get_ingest)) -> IngestSummaryOut:
    return IngestSummaryOut(**pipeline.summary())


@router.get(
    "/stream",
    summary="Server-Sent Events stream of live intelligence updates",
    response_class=StreamingResponse,
)
async def stream(request: Request, pipeline: IngestPipeline = Depends(get_ingest)):
    """SSE stream of ``new_intelligence`` / ``entity_updated`` /
    ``relationship_added`` / ``pattern_detected`` / ``priority_changed`` events.

    Frames carry entity ids, relationship ids, pattern ids and counts so a client
    knows *what to refetch*. They deliberately carry no narrative text, no phone
    or Aadhaar number, no amount and no raw submission (spec §12).
    """
    bus = pipeline.bus
    queue = bus.subscribe()
    keepalive = pipeline.settings.ingest_sse_keepalive_sec

    async def frames():
        try:
            # A comment frame immediately, so a client can distinguish "connected
            # and quiet" from "still connecting".
            yield keepalive_frame()
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=keepalive)
                except asyncio.TimeoutError:
                    yield keepalive_frame()
                    continue
                yield format_sse(event)
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # do not let a proxy buffer the stream
        },
    )


@router.get(
    "/{record_id}",
    response_model=IngestRecordOut,
    summary="One submitted record and its verdict",
)
def get_record(
    record_id: str = Path(..., min_length=8, description="Deterministic record id"),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> IngestRecordOut:
    return IngestRecordOut(**pipeline.get(record_id).as_dict())


@router.get(
    "/{record_id}/impact",
    response_model=ImpactOut,
    summary="What one record actually changed",
)
def get_impact(
    record_id: str = Path(..., min_length=8),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> ImpactOut:
    """Graph delta, before/after priority for the persons involved, new pattern
    ids, and the measured cost of the global recomputation."""
    return ImpactOut(**pipeline.impact(record_id))
