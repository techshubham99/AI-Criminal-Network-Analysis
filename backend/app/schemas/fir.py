from __future__ import annotations

from datetime import date

from pydantic import BaseModel


class FIR(BaseModel):
    fir_id: int
    date: date
    complainant_id: int
    accused_id: int
    location_id: int
    narrative: str
