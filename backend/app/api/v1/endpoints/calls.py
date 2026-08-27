"""Calls endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import PaginationParams, get_dataset
from app.core.errors import NotFoundError
from app.repositories.dataset import DatasetRepository
from app.schemas.call import Call
from app.schemas.common import Page, build_meta

router = APIRouter()


@router.get("", response_model=Page[Call], summary="List calls (paginated)")
def list_calls(
    pagination: PaginationParams = Depends(),
    repo: DatasetRepository = Depends(get_dataset),
    caller_id: Optional[int] = Query(None),
    callee_id: Optional[int] = Query(None),
) -> Page[Call]:
    rows, total = repo.list_calls(
        pagination.offset, pagination.limit, caller_id=caller_id, callee_id=callee_id
    )
    return Page[Call](
        items=[Call(**r) for r in rows],
        meta=build_meta(pagination.page, pagination.page_size, total),
    )


@router.get("/{call_id}", response_model=Call, summary="Get a call by id")
def get_call(
    call_id: int = Path(..., ge=1),
    repo: DatasetRepository = Depends(get_dataset),
) -> Call:
    record = repo.get_call(call_id)
    if record is None:
        raise NotFoundError("Call", call_id)
    return Call(**record)
