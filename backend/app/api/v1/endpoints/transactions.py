"""Transactions endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import PaginationParams, get_dataset
from app.core.errors import NotFoundError
from app.repositories.dataset import DatasetRepository
from app.schemas.common import Page, build_meta
from app.schemas.transaction import Transaction

router = APIRouter()


@router.get("", response_model=Page[Transaction], summary="List transactions (paginated)")
def list_transactions(
    pagination: PaginationParams = Depends(),
    repo: DatasetRepository = Depends(get_dataset),
    sender_id: Optional[int] = Query(None),
    receiver_id: Optional[int] = Query(None),
    mode: Optional[str] = Query(None, description="UPI | NEFT | IMPS | CASH | CARD"),
) -> Page[Transaction]:
    rows, total = repo.list_transactions(
        pagination.offset,
        pagination.limit,
        sender_id=sender_id,
        receiver_id=receiver_id,
        mode=mode,
    )
    return Page[Transaction](
        items=[Transaction(**r) for r in rows],
        meta=build_meta(pagination.page, pagination.page_size, total),
    )


@router.get("/{txn_id}", response_model=Transaction, summary="Get a transaction by id")
def get_transaction(
    txn_id: int = Path(..., ge=1),
    repo: DatasetRepository = Depends(get_dataset),
) -> Transaction:
    record = repo.get_transaction(txn_id)
    if record is None:
        raise NotFoundError("Transaction", txn_id)
    return Transaction(**record)
