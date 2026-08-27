"""Persons endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import PaginationParams, get_dataset
from app.core.errors import NotFoundError
from app.repositories.dataset import DatasetRepository
from app.schemas.common import Page, build_meta
from app.schemas.person import Person

router = APIRouter()


@router.get("", response_model=Page[Person], summary="List persons (paginated)")
def list_persons(
    pagination: PaginationParams = Depends(),
    repo: DatasetRepository = Depends(get_dataset),
    city: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    ring_id: Optional[int] = Query(None, description="Filter by ground-truth ring id"),
    q: Optional[str] = Query(None, description="Case-insensitive substring match on name"),
) -> Page[Person]:
    rows, total = repo.list_persons(
        pagination.offset, pagination.limit, city=city, state=state, ring_id=ring_id, q=q
    )
    return Page[Person](
        items=[Person(**r) for r in rows],
        meta=build_meta(pagination.page, pagination.page_size, total),
    )


@router.get("/{person_id}", response_model=Person, summary="Get a person by id")
def get_person(
    person_id: int = Path(..., ge=1),
    repo: DatasetRepository = Depends(get_dataset),
) -> Person:
    record = repo.get_person(person_id)
    if record is None:
        raise NotFoundError("Person", person_id)
    return Person(**record)
