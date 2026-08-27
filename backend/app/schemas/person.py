from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class Person(BaseModel):
    person_id: int
    name: str
    phone: str
    aadhar: str
    address: str
    city: str
    state: str
    location_id: int
    ring_id: Optional[int] = None
