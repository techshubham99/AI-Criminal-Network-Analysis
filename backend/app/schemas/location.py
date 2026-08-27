from __future__ import annotations

from pydantic import BaseModel


class Location(BaseModel):
    location_id: int
    state: str
    city: str
    # Raw coordinates as provided (NOT geographically reliable — see §DQ-1).
    latitude: float
    longitude: float
    # Canonical city-centroid coordinates + deterministic jitter, used for maps.
    canonical_lat: float
    canonical_lng: float
