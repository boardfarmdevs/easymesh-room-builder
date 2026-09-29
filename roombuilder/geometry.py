"""Canonical geometry and directed RF calculations for Golden Worlds.

A faithful port of ``wmdcfg/geometry.py``. Every function must return exactly
what the reference returns for the same input: the room builder's compiled
worlds are compared byte-for-byte with the reference goldens.

Parity notes kept deliberately:

* ``segments_cross`` counts only *proper* crossings. A path that touches a
  wall end, or a device standing exactly on a wall's line, adds no loss.
* SNR uses Python's ``round`` (round-half-to-even), not round-half-up.
* Shadowing is seeded per (seed, time, unordered pair, band) via SHA-256 and
  ``random.Random(...).gauss``.
"""

from __future__ import annotations

import hashlib
import math
import random
from typing import Any

from .model import ScenarioError


BANDS = ("2.4", "5", "6")


def point(value: Any, label: str = "position") -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ScenarioError(f"{label} must be [x, y]")
    result = (float(value[0]), float(value[1]))
    if not all(math.isfinite(item) for item in result):
        raise ScenarioError(f"{label} must contain finite coordinates")
    return result


def quantize_position(
    value: Any, *, quantum_m: float = 0.05, label: str = "position"
) -> tuple[float, float]:
    """Return a stable room coordinate on the declared interaction grid."""
    if not math.isfinite(quantum_m) or quantum_m <= 0:
        raise ValueError("quantum_m must be a positive finite number")
    x, y = point(value, label)
    digits = max(0, math.ceil(-math.log10(quantum_m)) + 1)
    return (
        round(round(x / quantum_m) * quantum_m, digits),
        round(round(y / quantum_m) * quantum_m, digits),
    )


def distance(a: Any, b: Any) -> float:
    return math.dist(point(a, "source position"), point(b, "destination position"))


def _orientation(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a: Any, b: Any, c: Any, d: Any) -> bool:
    """Return true only for a proper crossing of two segments.

    Endpoint and collinear contact is deliberately not a crossing.
    """
    a, b = point(a, "segment"), point(b, "segment")
    c, d = point(c, "wall"), point(d, "wall")
    ab_c = _orientation(a, b, c)
    ab_d = _orientation(a, b, d)
    cd_a = _orientation(c, d, a)
    cd_b = _orientation(c, d, b)
    return (ab_c > 0 > ab_d or ab_d > 0 > ab_c) and (
        cd_a > 0 > cd_b or cd_b > 0 > cd_a
    )


def wall_crossings(a: Any, b: Any, walls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return wall objects crossed by the straight RF path, in layout order."""
    return [
        wall
        for wall in walls
        if segments_cross(a, b, wall["start"], wall["end"])
    ]


def wall_loss(a: Any, b: Any, walls: list[dict[str, Any]]) -> float:
    return sum(float(wall["loss_db"]) for wall in wall_crossings(a, b, walls))


def deterministic_shadow(
    seed: int,
    time_ms: int,
    source: str,
    destination: str,
    band: str,
    sigma: float,
) -> float:
    if sigma == 0:
        return 0.0
    pair = sorted((source, destination))
    material = f"{seed}:{time_ms}:{pair[0]}:{pair[1]}:{band}".encode()
    local_seed = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
    return random.Random(local_seed).gauss(0, sigma)


def position_at_time(node: dict[str, Any], time_ms: int) -> tuple[float, float]:
    path = node.get("path")
    if not path:
        return point(node["position"], f"role {node['role']} position")
    if time_ms <= int(path[0]["time_ms"]):
        return point(path[0]["position"], "waypoint")
    for left, right in zip(path, path[1:]):
        start = int(left["time_ms"])
        end = int(right["time_ms"])
        if start <= time_ms <= end:
            a = point(left["position"], "waypoint")
            b = point(right["position"], "waypoint")
            fraction = (time_ms - start) / (end - start)
            return (
                a[0] + (b[0] - a[0]) * fraction,
                a[1] + (b[1] - a[1]) * fraction,
            )
    return point(path[-1]["position"], "waypoint")


def link_snr(
    propagation: dict[str, Any],
    band: str,
    separation: float,
    obstruction_loss: float,
    source_gain: float = 0.0,
    shadow: float = 0.0,
) -> int:
    """One band's clamped SNR, exactly as ``directed_link`` computes it."""
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    reference_distance = float(propagation["reference_distance_m"])
    exponent = float(propagation["path_loss_exponent"])
    path_loss = 10 * exponent * math.log10(
        max(separation, reference_distance) / reference_distance
    )
    value = round(
        float(propagation["reference_snr_db_by_band"][band])
        - path_loss
        - obstruction_loss
        + source_gain
        + shadow
    )
    return max(minimum, min(maximum, value))


def directed_link(
    source: dict[str, Any],
    destination: dict[str, Any],
    positions: dict[str, tuple[float, float]],
    present: dict[str, bool],
    layout: dict[str, Any],
    mobility: dict[str, Any],
    time_ms: int,
    link_class: str,
) -> dict[str, Any]:
    """Evaluate one directed link using the canonical Golden World model."""
    propagation = layout["propagation"]
    a = positions[source["role"]]
    b = positions[destination["role"]]
    separation = distance(a, b)
    obstruction_loss = wall_loss(a, b, layout.get("walls", []))
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    reference_distance = float(propagation["reference_distance_m"])
    exponent = float(propagation["path_loss_exponent"])
    sigma = float(propagation.get("shadowing_stddev_db", 0))
    seed = int(mobility.get("seed", 0))
    values = {}
    for band in BANDS:
        if not present[source["role"]] or not present[destination["role"]]:
            value = minimum
        else:
            path_loss = 10 * exponent * math.log10(
                max(separation, reference_distance) / reference_distance
            )
            source_gain = float((source.get("tx_gain_db_by_band") or {}).get(band, 0))
            value = round(
                float(propagation["reference_snr_db_by_band"][band])
                - path_loss
                - obstruction_loss
                + source_gain
                + deterministic_shadow(
                    seed,
                    time_ms,
                    source["role"],
                    destination["role"],
                    band,
                    sigma,
                )
            )
            value = max(minimum, min(maximum, value))
        values[band] = value
    return {
        "link_class": link_class,
        "source_role": source["role"],
        "destination_role": destination["role"],
        "distance_m": round(separation, 3),
        "wall_loss_db": obstruction_loss,
        "snr_db_by_band": values,
    }


def point_segment_distance(p: Any, a: Any, b: Any) -> float:
    """Shortest distance from point ``p`` to segment ``ab`` (builder helper)."""
    px, py = point(p)
    ax, ay = point(a)
    bx, by = point(b)
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


# --------------------------------------------------------------------------
# Compile fast path. Same arithmetic, same order, same results as
# ``wall_loss``/``directed_link``; walls are converted once and a bounding
# box test skips walls that cannot be crossed (disjoint boxes can never
# produce a proper crossing, so no result changes).
# --------------------------------------------------------------------------

def prepare_walls(walls: list[dict[str, Any]]) -> list[tuple]:
    prepared = []
    for wall in walls:
        c = point(wall["start"], "wall")
        d = point(wall["end"], "wall")
        prepared.append((c[0], c[1], d[0], d[1], float(wall["loss_db"]),
                         min(c[0], d[0]), max(c[0], d[0]), min(c[1], d[1]), max(c[1], d[1])))
    return prepared


def fast_wall_loss(a: tuple[float, float], b: tuple[float, float], prepared: list[tuple]):
    ax, ay = a
    bx, by = b
    lo_x, hi_x = (ax, bx) if ax < bx else (bx, ax)
    lo_y, hi_y = (ay, by) if ay < by else (by, ay)
    total = 0
    for cx, cy, dx, dy, loss, wx0, wx1, wy0, wy1 in prepared:
        if hi_x < wx0 or lo_x > wx1 or hi_y < wy0 or lo_y > wy1:
            continue
        ab_c = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        ab_d = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
        cd_a = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
        cd_b = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
        if (ab_c > 0 > ab_d or ab_d > 0 > ab_c) and (cd_a > 0 > cd_b or cd_b > 0 > cd_a):
            total += loss
    return total


def fast_directed_link(source, destination, positions, present, propagation, prepared, seed, time_ms, link_class):
    """``directed_link`` with pre-converted walls; identical output."""
    a = positions[source["role"]]
    b = positions[destination["role"]]
    separation = math.dist(a, b)
    obstruction_loss = fast_wall_loss(a, b, prepared)
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    reference_distance = float(propagation["reference_distance_m"])
    exponent = float(propagation["path_loss_exponent"])
    sigma = float(propagation.get("shadowing_stddev_db", 0))
    values = {}
    both = present[source["role"]] and present[destination["role"]]
    if both:
        path_loss = 10 * exponent * math.log10(max(separation, reference_distance) / reference_distance)
        gains = source.get("tx_gain_db_by_band") or {}
    for band in BANDS:
        if not both:
            value = minimum
        else:
            value = round(
                float(propagation["reference_snr_db_by_band"][band])
                - path_loss
                - obstruction_loss
                + float(gains.get(band, 0))
                + deterministic_shadow(seed, time_ms, source["role"], destination["role"], band, sigma)
            )
            value = max(minimum, min(maximum, value))
        values[band] = value
    return {
        "link_class": link_class,
        "source_role": source["role"],
        "destination_role": destination["role"],
        "distance_m": round(separation, 3),
        "wall_loss_db": obstruction_loss,
        "snr_db_by_band": values,
    }
