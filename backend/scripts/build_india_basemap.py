"""Build the frontend's offline India basemap from vendored boundary geometry.

Run once, commit the output. There is no tile service, no map API and no map
library anywhere in this project: the browser is handed a few thousand already
projected SVG coordinates and draws them itself.

    ./.venv/Scripts/python.exe scripts/build_india_basemap.py

Input  ``backend/data/geo/india-districts.geojson.gz`` — Census-2011 boundaries
       of India, fetched once from
       https://raw.githubusercontent.com/udit-001/india-maps-data/main/geojson/india.geojson
       which redistributes the DataMeet Census-2011 maps (CC-BY-SA 2.5 IN), and
       reduced here to two properties: the state name and whether the feature is
       a state or one of its districts. Vendored so the build stays offline and
       reproducible.
Output ``frontend/src/components/geo/india-basemap.ts``

The source carries a state-level polygon for 34 of the 36 states and union
territories alongside their districts, so the outlines are read straight from it
rather than dissolved. Chandigarh and Lakshadweep have no state-level polygon;
their districts stand in, which for a city and an island group is the same
shape. Two things then happen, and only here, so the runtime stays cheap:

1. *Project.* Web Mercator, the projection every map of India is drawn in, so
   the coastline the eye knows is the coastline that appears:

       x = lon,  y = -(180/pi) * ln(tan(pi/4 + lat_rad/2))

   The client repeats this exact formula for the dataset's coordinates, and the
   emitted view box is in the same units, so a plotted point cannot drift from
   the land under it.
2. *Simplify.* Douglas-Peucker, then rounding to three decimals (~110 m). The
   panel is a few hundred pixels wide; anything finer is bytes the user pays for
   and cannot see. District borders are texture, so they are cut harder than the
   state outlines that carry the country's silhouette.
"""
from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "backend" / "data" / "geo" / "india-districts.geojson.gz"
TARGET = ROOT / "frontend" / "src" / "components" / "geo" / "india-basemap.ts"

# Douglas-Peucker tolerances, in degrees.
STATE_EPSILON = 0.01
DISTRICT_EPSILON = 0.09
# A ring smaller than this across the diagonal of its bounding box is a sandbank
# at panel scale. Low enough (~1.7 km) to keep Lakshadweep, whose atolls are the
# smallest inhabited land in the country.
MIN_RING_SPAN = 0.015
DECIMALS = 3
PAD = 0.3  # degrees of projected space around the country

Point = tuple[float, float]


def mercator(lon: float, lat: float) -> Point:
    """Web Mercator in degree-ish units, y increasing downwards (SVG's way)."""
    clamped = max(-85.0, min(85.0, lat))
    y = math.degrees(math.log(math.tan(math.pi / 4 + math.radians(clamped) / 2)))
    return (lon, -y)


def rings_of(geometry: dict) -> list[list[Point]]:
    kind = geometry["type"]
    if kind == "Polygon":
        polygons = [geometry["coordinates"]]
    elif kind == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:  # pragma: no cover - the source carries nothing else
        return []
    out: list[list[Point]] = []
    for polygon in polygons:
        for ring in polygon:
            points = [(float(x), float(y)) for x, y, *_ in ring]
            if len(points) < 4:
                continue
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            if math.hypot(max(xs) - min(xs), max(ys) - min(ys)) < MIN_RING_SPAN:
                continue
            out.append(points)
    return out


def simplify(points: list[Point], epsilon: float) -> list[Point]:
    """Douglas-Peucker, iteratively so a long coastline cannot blow the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        ax, ay = points[start]
        bx, by = points[end]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, at = -1.0, start
        for index in range(start + 1, end):
            px, py = points[index]
            if norm == 0:
                distance = math.hypot(px - ax, py - ay)
            else:
                distance = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if distance > worst:
                worst, at = distance, index
        if worst > epsilon:
            keep[at] = True
            stack.append((start, at))
            stack.append((at, end))
    return [point for point, kept in zip(points, keep) if kept]


def path_data(rings: list[list[Point]], epsilon: float) -> tuple[str, int]:
    """Projected, simplified rings as one closed SVG path."""
    parts: list[str] = []
    vertices = 0
    for ring in rings:
        points = simplify([mercator(lon, lat) for lon, lat in ring], epsilon)
        if len(points) < 4:
            continue
        vertices += len(points)
        head, *rest = points
        body = "".join(f"L{x:.{DECIMALS}f} {y:.{DECIMALS}f}" for x, y in rest)
        parts.append(f"M{head[0]:.{DECIMALS}f} {head[1]:.{DECIMALS}f}{body}Z")
    return "".join(parts), vertices


def main() -> None:
    with gzip.open(SOURCE, "rt", encoding="utf-8") as handle:
        collection = json.load(handle)

    outlines: dict[str, list[list[Point]]] = {}
    districts: dict[str, list[list[Point]]] = {}
    for feature in collection["features"]:
        properties = feature["properties"]
        name = str(properties.get("st_nm") or "").strip() or "Unknown"
        target = outlines if properties.get("level") == "state" else districts
        target.setdefault(name, []).extend(rings_of(feature["geometry"]))
    # Chandigarh and Lakshadweep have no state-level polygon in the source.
    for name, rings in districts.items():
        if name not in outlines:
            outlines[name] = list(rings)

    states: list[tuple[str, str]] = []
    state_vertices = 0
    for name in sorted(outlines):
        data, count = path_data(outlines[name], STATE_EPSILON)
        if not data:
            continue
        states.append((name, data))
        state_vertices += count

    interior: list[list[Point]] = []
    for name in sorted(districts):
        # Skipped where the districts *are* the outline, to avoid a doubled stroke.
        if len(districts[name]) > 1:
            interior.extend(districts[name])
    district_lines, district_vertices = path_data(interior, DISTRICT_EPSILON)

    xs: list[float] = []
    ys: list[float] = []
    for rings in outlines.values():
        for ring in rings:
            for lon, lat in ring:
                x, y = mercator(lon, lat)
                xs.append(x)
                ys.append(y)
    min_x, max_x = min(xs) - PAD, max(xs) + PAD
    min_y, max_y = min(ys) - PAD, max(ys) + PAD

    body = "\n".join(
        f"  {{ name: {json.dumps(name)}, d: {json.dumps(data)} }}," for name, data in states
    )
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        f'''/**
 * India basemap geometry - GENERATED, do not edit by hand.
 *
 * Written by `backend/scripts/{Path(__file__).name}` from the vendored
 * Census-2011 boundaries in `backend/data/geo/india-districts.geojson.gz`
 * (DataMeet, via udit-001/india-maps-data, CC-BY-SA 2.5 IN), projected to Web
 * Mercator and simplified with Douglas-Peucker. The runtime ships coordinates
 * rather than a map library: no tile service, no geocoder, no API key, nothing
 * fetched at render time.
 *
 * Coordinates are in projected degrees, y already flipped for SVG. Anything
 * plotted over them must go through `project()` in `./projection.ts`, which is
 * the same formula the generator used.
 */
export interface StateOutline {{
  /** Census spelling of the state or union territory. */
  readonly name: string;
  /** Its boundary, as one or more closed SVG subpaths. */
  readonly d: string;
}}

/** Projected bounds of the whole country, with a small margin. */
export const INDIA_BOUNDS = {{
  minX: {min_x:.{DECIMALS}f},
  minY: {min_y:.{DECIMALS}f},
  maxX: {max_x:.{DECIMALS}f},
  maxY: {max_y:.{DECIMALS}f},
}} as const;

export const INDIA_VIEWBOX =
  '{min_x:.{DECIMALS}f} {min_y:.{DECIMALS}f} {max_x - min_x:.{DECIMALS}f} {max_y - min_y:.{DECIMALS}f}';

/** State and union-territory boundaries, alphabetical. */
export const INDIA_STATES: readonly StateOutline[] = [
{body}
];

/** District boundaries - texture under the state lines, drawn faintly. */
export const INDIA_DISTRICT_LINES =
  {json.dumps(district_lines)};
''',
        encoding="utf-8",
    )
    print(
        f"states={len(states)} state_vertices={state_vertices} "
        f"district_vertices={district_vertices} "
        f"bytes={TARGET.stat().st_size} -> {TARGET.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
