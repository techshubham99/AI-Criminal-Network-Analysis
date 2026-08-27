"""Geographic normalization (docs/architecture.md §DQ-1).

The dataset's raw latitude/longitude are effectively random (median ~1,500 km
from the labelled city), so they cannot be plotted. For visualization we map
each location to its city's real centroid and add a small, *deterministic*
jitter derived from the location id — stable across runs, no RNG, so nothing is
fabricated or non-reproducible.
"""
from __future__ import annotations

import hashlib

# Approximate real centroids for the 10 cities present in the dataset.
CITY_CENTROIDS: dict[str, tuple[float, float]] = {
    "Mumbai": (19.0760, 72.8777),
    "New Delhi": (28.6139, 77.2090),
    "Bengaluru": (12.9716, 77.5946),
    "Chennai": (13.0827, 80.2707),
    "Lucknow": (26.8467, 80.9462),
    "Ahmedabad": (23.0225, 72.5714),
    "Kolkata": (22.5726, 88.3639),
    "Jaipur": (26.9124, 75.7873),
    "Hyderabad": (17.3850, 78.4867),
    "Bhopal": (23.2599, 77.4126),
}

# Fallback: geographic center of India (used only if an unexpected city appears).
INDIA_CENTER = (22.9734, 78.6569)


def _deterministic_jitter(key: str, amplitude: float) -> tuple[float, float]:
    """Two reproducible offsets in [-amplitude, +amplitude] from a stable hash."""
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    a = (int.from_bytes(digest[0:4], "big") / 0xFFFFFFFF) * 2 - 1
    b = (int.from_bytes(digest[4:8], "big") / 0xFFFFFFFF) * 2 - 1
    return a * amplitude, b * amplitude


def canonical_coords(
    city: str, location_id: int, amplitude: float = 0.05
) -> tuple[float, float]:
    """Canonical (lat, lng) for a location: city centroid + deterministic jitter."""
    base = CITY_CENTROIDS.get(city, INDIA_CENTER)
    d_lat, d_lng = _deterministic_jitter(f"{city}:{location_id}", amplitude)
    return round(base[0] + d_lat, 6), round(base[1] + d_lng, 6)
