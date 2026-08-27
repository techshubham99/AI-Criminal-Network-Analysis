"""Locations endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import PaginationParams, get_dataset
from app.core.errors import NotFoundError
from app.repositories.dataset import DatasetRepository
from app.schemas.common import Page, build_meta
from app.schemas.location import Location

router = APIRouter()


@router.get("", response_model=Page[Location], summary="List locations (paginated)")
def list_locations(
    pagination: PaginationParams = Depends(),
    repo: DatasetRepository = Depends(get_dataset),
    city: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
) -> Page[Location]:
    rows, total = repo.list_locations(
        pagination.offset, pagination.limit, city=city, state=state
    )
    return Page[Location](
        items=[Location(**r) for r in rows],
        meta=build_meta(pagination.page, pagination.page_size, total),
    )


@router.get("/{location_id}", response_model=Location, summary="Get a location by id")
def get_location(
    location_id: int = Path(..., ge=1),
    repo: DatasetRepository = Depends(get_dataset),
) -> Location:
    record = repo.get_location(location_id)
    if record is None:
        raise NotFoundError("Location", location_id)
    return Location(**record)
