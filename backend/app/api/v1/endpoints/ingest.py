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
from app.core.errors import BadRequestError
from app.ingest.events import format_sse, keepalive_frame
from app.ingest.models import IngestRecord, IngestStatus, Provenance, SourceType
from app.ingest.pipeline import IngestPipeline
from app.schemas.ingest import (
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
