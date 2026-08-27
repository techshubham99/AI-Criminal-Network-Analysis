"""FIR endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import PaginationParams, get_dataset
from app.core.errors import NotFoundError
from app.repositories.dataset import DatasetRepository
from app.schemas.common import Page, build_meta
from app.schemas.fir import FIR

router = APIRouter()


@router.get("", response_model=Page[FIR], summary="List FIRs (paginated)")
def list_firs(
    pagination: PaginationParams = Depends(),
    repo: DatasetRepository = Depends(get_dataset),
    complainant_id: Optional[int] = Query(None),
    accused_id: Optional[int] = Query(None),
    location_id: Optional[int] = Query(None),
) -> Page[FIR]:
    rows, total = repo.list_firs(
        pagination.offset,
        pagination.limit,
        complainant_id=complainant_id,
        accused_id=accused_id,
        location_id=location_id,
    )
    return Page[FIR](
        items=[FIR(**r) for r in rows],
        meta=build_meta(pagination.page, pagination.page_size, total),
    )


@router.get("/{fir_id}", response_model=FIR, summary="Get an FIR by id")
def get_fir(
    fir_id: int = Path(..., ge=1),
    repo: DatasetRepository = Depends(get_dataset),
) -> FIR:
    record = repo.get_fir(fir_id)
    if record is None:
        raise NotFoundError("FIR", fir_id)
    return FIR(**record)
