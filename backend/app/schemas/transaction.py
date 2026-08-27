from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class Transaction(BaseModel):
    txn_id: int
    sender_id: int
    receiver_id: int
    amount_inr: float
    txn_time: datetime
    mode: str
    bank_ref: str
