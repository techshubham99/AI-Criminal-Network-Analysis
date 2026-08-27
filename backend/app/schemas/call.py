from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class Call(BaseModel):
    call_id: int
    caller_id: int
    callee_id: int
    start_time: datetime
    duration_sec: int
    cell_tower_id: int
