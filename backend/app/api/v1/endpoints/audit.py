"""Audit ledger and evidence integrity (/api/v1/audit).

Five routes, and the split between them is the point:

* the four ``GET``s are pure reads — verifying the chain or a resource appends
  nothing, so asking twice gives the same answer and a read can never change what
  the next read sees;
* the single ``POST`` is the only route that appends a content commitment, and it
  cannot overwrite one. Committing a hash for an id that already has one
  re-checks the supplied content against the recorded hash instead.

That is what makes the tamper demonstration of §7 possible without an endpoint
that edits anything: submit the content, then submit it again with one field
changed, and the second call reports ``INTEGRITY_COMPROMISED``.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Request

from app.api.deps import get_audit
from app.audit.models import (
    AuditAction,
    ResourceType,
    ingest_record_content,
)
from app.audit.service import AuditService
from app.config import get_settings
from app.core.errors import BadRequestError, NotFoundError, ServiceUnavailableError
from app.ingest.models import canonical_payload
from app.schemas.audit import (
    AuditEventOut,
    AuditEventsOut,
    AuditSummaryOut,
    ChainVerificationOut,
    ContentIntegrityOut,
    ContentIntegrityRequest,
    ResourceVerificationOut,
)

router = APIRouter()


@router.get(
    "/events",
    response_model=AuditEventsOut,
    summary="Audit events, oldest first",
)
def list_events(
    audit: AuditService = Depends(get_audit),
    limit: int = Query(50, ge=1, le=200, description="Events per page"),
    offset: int = Query(0, ge=0),
    action: Optional[AuditAction] = Query(
        None, description="Filter by action, e.g. INGEST_ACCEPTED"
    ),
    resource_type: Optional[ResourceType] = Query(None),
    resource_id: Optional[str] = Query(None, max_length=128),
) -> AuditEventsOut:
    """Chain order, which is also decision order. Never reverse-sorted: the
    sequence is the evidence, so it is not reordered for display."""
    matched = audit.events(
        action=action, resource_type=resource_type, resource_id=resource_id
    )
    page = matched[offset : offset + limit]
    return AuditEventsOut(
        total=len(matched),
        chain_length=len(audit.ledger),
        returned=len(page),
        offset=offset,
        limit=limit,
        events=[AuditEventOut(**event.as_dict()) for event in page],
    )


@router.get(
    "/summary",
    response_model=AuditSummaryOut,
    summary="Ledger backend, length and head hash",
)
def summary(audit: AuditService = Depends(get_audit)) -> AuditSummaryOut:
    """``head_hash`` is the current chain head: exporting it is the cheapest
    external anchor available without a signing key or a third party."""
    return AuditSummaryOut(**audit.summary())


@router.get(
    "/verify",
    response_model=ChainVerificationOut,
    summary="Verify the whole audit chain",
)
def verify_chain(audit: AuditService = Depends(get_audit)) -> ChainVerificationOut:
    """Re-derives every hash and every link and reports the first break.

    Appends nothing. ``events_checked`` is reported because this walk is O(chain
    length) and stops at the first failure — so on a compromised chain it is the
    position of the break, not the chain length.
    """
    result = audit.verify_chain()
    return ChainVerificationOut(
        **result.as_dict(),
        chain_length=len(audit.ledger),
        backend=audit.ledger.backend_name,
        persisted=audit.ledger.persisted,
    )


@router.get(
    "/events/{audit_event_id}",
    response_model=AuditEventOut,
    summary="One audit event",
)
def get_event(
    audit_event_id: str = Path(..., pattern=r"^ae-\d{6,}$", examples=["ae-000001"]),
    audit: AuditService = Depends(get_audit),
) -> AuditEventOut:
    event = audit.get(audit_event_id)
    if event is None:
        raise NotFoundError("Audit event", audit_event_id)
    return AuditEventOut(**event.as_dict())


@router.get(
    "/records/{resource_type}/{resource_id}/verify",
    response_model=ResourceVerificationOut,
    summary="Verify one resource against its recorded hash",
)
def verify_record(
    request: Request,
    resource_type: ResourceType = Path(...),
    resource_id: str = Path(..., min_length=1, max_length=128),
    audit: AuditService = Depends(get_audit),
) -> ResourceVerificationOut:
    """Re-derive the resource's content server-side and compare hashes.

    Only resources the application can re-derive can be verified this way. An
    ``ingest_record`` is re-read from the investigation store and re-hashed.
    Generic ``content`` is not stored anywhere by the audit layer, so it cannot be
    re-derived — the content has to be supplied, which is what ``POST
    /api/v1/audit/records`` is for. Saying VERIFIED without re-deriving anything
    would be the one answer this endpoint must never give.
    """
    record = audit.integrity_record(resource_type, resource_id)
    if record is None:
        raise NotFoundError("Integrity record", f"{resource_type.value}/{resource_id}")

    if resource_type is not ResourceType.INGEST_RECORD:
        raise BadRequestError(
            f"A '{resource_type.value}' resource cannot be re-derived by the "
            "server; supply the content to POST /api/v1/audit/records to verify "
            "it against the recorded hash.",
            detail={
                "resource_type": resource_type.value,
                "resource_id": resource_id,
                "content_hash": record.content_hash,
                "audit_event_id": record.audit_event_id,
            },
        )

    pipeline = getattr(request.app.state, "ingest", None)
    if pipeline is None:
        raise ServiceUnavailableError(
            "Live ingestion is not available, so the stored record cannot be "
            "re-derived for verification"
        )
    stored = pipeline.store.get(resource_id)
    if stored is None:
        # Phase 4.6 never stores a rejected submission, so its decision event
        # exists while the record does not. Reported as missing, not as verified.
        raise NotFoundError("Ingest record", resource_id)

    verification = audit.verify_content(
        ResourceType.INGEST_RECORD, resource_id, ingest_record_content(stored)
    )
    return ResourceVerificationOut(**verification.as_dict())


@router.post(
    "/records",
    response_model=ContentIntegrityOut,
    status_code=200,
    summary="Commit or re-check a content hash",
)
def record_content(
    payload: ContentIntegrityRequest,
    audit: AuditService = Depends(get_audit),
) -> ContentIntegrityOut:
    """Hash supplied content and commit it, or check it against a commitment (§7).

    The content is hashed and discarded — the audit layer stores no content, only
    hashes. A commitment is never replaced, so this is safe to call repeatedly:
    the first call records, every later call verifies.
    """
    settings = get_settings()
    size = len(canonical_payload(payload.content).encode("utf-8"))
    if size > settings.audit_max_content_bytes:
        raise BadRequestError(
            f"Content is {size} bytes canonicalized, above the "
            f"{settings.audit_max_content_bytes} byte limit for hashing.",
            detail={"bytes": size, "limit": settings.audit_max_content_bytes},
        )
    if not payload.content:
        raise BadRequestError("content must not be empty: there is nothing to hash.")

    outcome = audit.record_content(
        payload.resource_id,
        payload.content,
        content_type=payload.content_type,
    )
    record = audit.integrity_record(ResourceType.CONTENT, payload.resource_id)
    return ContentIntegrityOut(
        created=outcome.created,
        verification=ResourceVerificationOut(**outcome.verification.as_dict()),
        integrity_record=record.as_dict(),
        audit_event_id=outcome.event.audit_event_id,
    )
