"""Coverage analysis and optimal extender placement.

Both use the configurator's own propagation model (log-distance path loss,
proper wall crossings, per-band reference SNR and transmit adjustment), so a
placement that looks good here is good in the compiled world. Shadowing is a
zero-mean random term and is left out of the optimisation.

Placement objective (maximised):

* each sample point contributes ``u(best SNR)`` where ``u`` rises linearly
  from ``target − 25 dB`` to ``target`` and keeps a small bonus above it;
* samples are a floor grid ("area"), every client position over the whole
  scenario ("clients"), or both with equal weight ("balanced");

subject to a *backhaul tree*: every placed extender must reach the gateway
or a wired extender through wireless AP-to-AP hops whose weaker direction is
at least ``min_backhaul_snr_db`` on the backhaul band. A wired extender is
on the controller's LAN, so it is a root of the tree and a possible Wi-Fi
parent (the compiler gives it AP-to-AP links since upstream a796f3a); it
never needs a Wi-Fi backhaul itself. OpenSync pods neither need nor provide one.

Search: greedy selection over a candidate grid, candidate-swap improvement,
then continuous pattern-search refinement down to the configurator's 5 cm
interaction quantum. Deterministic for identical input.
"""

from __future__ import annotations

import math
import statistics
import time
from typing import Any

from .geometry import BANDS, point_segment_distance, position_at_time, quantize_position
from .lab import next_role
from .model import ScenarioError
from .world import is_present, merge_nodes, validate_layout

WORK_BUDGET = 2_400_000  # candidate × sample × max(1, walls) evaluations for the matrix


class RFModel:
    """Fast, allocation-light evaluation of the canonical link model."""

    def __init__(self, layout: dict):
        propagation = layout["propagation"]
        self.reference = {band: float(propagation["reference_snr_db_by_band"][band]) for band in BANDS}
        self.d0 = float(propagation["reference_distance_m"])
        self.exponent = float(propagation["path_loss_exponent"])
        self.minimum = int(propagation.get("minimum_snr_db", -20))
        self.maximum = int(propagation.get("maximum_snr_db", 60))
        self.walls = []
        for wall in layout.get("walls", []):
            (cx, cy), (dx, dy) = wall["start"], wall["end"]
            cx, cy, dx, dy = float(cx), float(cy), float(dx), float(dy)
            self.walls.append((cx, cy, dx, dy, float(wall["loss_db"]),
                               min(cx, dx), max(cx, dx), min(cy, dy), max(cy, dy)))
        self.width = float(layout["space"]["width_m"])
        self.height = float(layout["space"]["height_m"])

    def wall_loss(self, ax: float, ay: float, bx: float, by: float) -> float:
        loss = 0.0
        lo_x, hi_x = (ax, bx) if ax < bx else (bx, ax)
        lo_y, hi_y = (ay, by) if ay < by else (by, ay)
        for cx, cy, dx, dy, wall_loss, wx0, wx1, wy0, wy1 in self.walls:
            if hi_x < wx0 or lo_x > wx1 or hi_y < wy0 or lo_y > wy1:
                continue
            ab_c = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
            ab_d = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
            if not (ab_c > 0 > ab_d or ab_d > 0 > ab_c):
                continue
            cd_a = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
            cd_b = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
            if cd_a > 0 > cd_b or cd_b > 0 > cd_a:
                loss += wall_loss
        return loss

    def raw_snr(self, a, b, band: str, gain: float = 0.0) -> float:
        distance = math.hypot(b[0] - a[0], b[1] - a[1])
        path_loss = 10 * self.exponent * math.log10(max(distance, self.d0) / self.d0)
        return self.reference[band] - path_loss - self.wall_loss(a[0], a[1], b[0], b[1]) + gain

    def snr(self, a, b, band: str, gain: float = 0.0) -> int:
        """Exactly the compiled link value (without shadowing)."""
        return max(self.minimum, min(self.maximum, round(self.raw_snr(a, b, band, gain))))

    def clamp(self, value: float) -> float:
        return max(float(self.minimum), min(float(self.maximum), value))

    def vector(self, source, samples, band: str, gain: float = 0.0) -> list[float]:
        sx, sy = source
        log10 = math.log10
        d0, n10 = self.d0, 10 * self.exponent
        reference = self.reference[band] + gain
        lo, hi = float(self.minimum), float(self.maximum)
        out = []
        append = out.append
        wall_loss = self.wall_loss
        for tx, ty in samples:
            distance = math.hypot(tx - sx, ty - sy)
            value = reference - n10 * log10((distance if distance > d0 else d0) / d0)
            if self.walls:
                value -= wall_loss(sx, sy, tx, ty)
            append(hi if value > hi else lo if value < lo else value)
        return out


# --------------------------------------------------------------------------
# Scene extraction
# --------------------------------------------------------------------------

def nodes_at(layout: dict, mobility: dict, time_ms: int = 0) -> list[dict]:
    duration = int(mobility.get("duration_ms", 60000))
    result = []
    for node in merge_nodes(layout, mobility):
        try:
            position = position_at_time(node, time_ms)
        except (KeyError, ScenarioError):
            continue
        result.append({
            "role": node["role"], "kind": node.get("kind", "station"), "position": position,
            "present": is_present(node, time_ms, duration),
            "wired": node.get("backhaul") == "wired",
            "gain": {band: float((node.get("tx_gain_db_by_band") or {}).get(band, 0)) for band in BANDS},
        })
    return result


def is_pod(role: str) -> bool:
    return role.startswith("pod_")


def client_samples(layout: dict, mobility: dict, limit: int = 400) -> list[tuple[float, float]]:
    """Every client position at every tick, thinned evenly to ``limit``."""
    duration = int(mobility.get("duration_ms", 60000))
    tick = max(100, int(mobility.get("tick_ms", 2000)))
    points = []
    for node in merge_nodes(layout, mobility):
        if node.get("kind", "station") != "station":
            continue
        times = range(0, duration, tick) if node.get("path") else [0]
        for time_ms in times:
            if not is_present(node, time_ms, duration):
                continue
            try:
                points.append(position_at_time(node, time_ms))
            except (KeyError, ScenarioError):
                break
    if len(points) > limit:
        step = len(points) / limit
        points = [points[int(i * step)] for i in range(limit)]
    return points


def grid(width: float, height: float, target: int, minimum_cell: float = 0.25):
    cell = max(minimum_cell, math.sqrt(width * height / max(1, target)))
    cols = max(1, int(math.ceil(width / cell)))
    rows = max(1, int(math.ceil(height / cell)))
    cw, ch = width / cols, height / rows
    points = [((i + 0.5) * cw, (j + 0.5) * ch) for j in range(rows) for i in range(cols)]
    return points, cols, rows, cw, ch


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------

def coverage_metrics(best: list[float], target: float) -> dict:
    if not best:
        return {}
    ordered = sorted(best)
    return {
        "mean_snr_db": round(statistics.fmean(best), 1),
        "median_snr_db": round(statistics.median(best), 1),
        "p10_snr_db": round(ordered[int(0.1 * (len(ordered) - 1))], 1),
        "min_snr_db": round(ordered[0], 1),
        "coverage_pct": round(100 * sum(value >= target for value in best) / len(best), 1),
        "fair_pct": round(100 * sum(value >= 16 for value in best) / len(best), 1),
        "holes_pct": round(100 * sum(value < 10 for value in best) / len(best), 1),
        "samples": len(best),
    }


def coverage(layout: dict, mobility: dict, *, band: str = "5", time_ms: int = 0,
             resolution: float | None = None, target_snr_db: float = 30) -> dict:
    """Best fronthaul SNR (AP → point) over a floor grid at one time."""
    validate_layout(layout)
    model = RFModel(layout)
    aps = [node for node in nodes_at(layout, mobility, time_ms)
           if node["kind"] == "fronthaul_ap" and node["present"]]
    if resolution:
        cols = max(1, int(math.ceil(model.width / resolution)))
        rows = max(1, int(math.ceil(model.height / resolution)))
        cw, ch = model.width / cols, model.height / rows
        samples = [((i + 0.5) * cw, (j + 0.5) * ch) for j in range(rows) for i in range(cols)]
    else:
        samples, cols, rows, cw, ch = grid(model.width, model.height, 4000)
    if cols * rows > 250_000:
        raise ScenarioError("coverage grid too fine; use a coarser resolution")
    best = [float(model.minimum)] * len(samples)
    owner = [None] * len(samples)
    for ap in aps:
        vector = model.vector(ap["position"], samples, band, ap["gain"][band])
        for index, value in enumerate(vector):
            if value > best[index]:
                best[index] = value
                owner[index] = ap["role"]
    return {
        "band": band, "time_ms": time_ms, "cols": cols, "rows": rows,
        "cell_m": [cw, ch], "values": [round(value, 1) for value in best], "owner": owner,
        "metrics": coverage_metrics(best, target_snr_db),
    }


# --------------------------------------------------------------------------
# Placement
# --------------------------------------------------------------------------

def _utility(value: float, target: float) -> float:
    low = target - 25.0
    base = (value - low) / 25.0
    base = 0.0 if base < 0 else 1.0 if base > 1 else base
    bonus = (value - target) / 20.0
    bonus = 0.0 if bonus < 0 else 1.0 if bonus > 1 else bonus
    return base + 0.04 * bonus


def place_extenders(layout: dict, mobility: dict, count: int = 4, *, band: str = "5",
                    backhaul_band: str = "5", strategy: str = "replace", objective: str = "balanced",
                    target_snr_db: float = 30, min_backhaul_snr_db: float = 20,
                    min_spacing_m: float | None = None, wall_clearance_m: float = 0.3,
                    edge_margin_m: float = 0.3, profile: str = "configurator") -> dict:
    """Choose extender positions for the best coverage with a connected backhaul.

    ``strategy="replace"`` re-positions the existing Wi-Fi extenders (reusing
    their roles, adding or removing roles to reach ``count``);
    ``strategy="add"`` keeps every existing AP and adds ``count`` new ones.
    """
    started = time.monotonic()
    validate_layout(layout)
    if band not in BANDS or backhaul_band not in BANDS:
        raise ScenarioError("band must be 2.4, 5 or 6")
    if strategy not in ("replace", "add"):
        raise ScenarioError("strategy must be replace or add")
    if objective not in ("area", "clients", "balanced"):
        raise ScenarioError("objective must be area, clients or balanced")
    count = int(count)
    if not 0 <= count <= 32:
        raise ScenarioError("place between 0 and 32 extenders")
    model = RFModel(layout)
    width, height = model.width, model.height
    spacing = float(min_spacing_m) if min_spacing_m is not None else max(1.5, min(6.0, min(width, height) / 5))
    notes: list[str] = []

    scene = nodes_at(layout, mobility, 0)
    aps = [node for node in scene if node["kind"] == "fronthaul_ap"]
    gateway = next((node for node in aps if node["role"] == "gateway"), None)
    if gateway is None:
        raise ScenarioError("place a gateway (role 'gateway') before optimising extenders")
    movable = sorted((node for node in aps if node["role"].startswith("extender_") and not node["wired"]),
                     key=lambda node: (len(node["role"]), node["role"]))
    if strategy == "replace":
        fixed = [node for node in aps if node is not gateway and node not in movable]
        roles = [node["role"] for node in movable[:count]]
        removed = [node["role"] for node in movable[count:]]
        taken = {node["role"] for node in scene} - set(removed)
    else:
        fixed = [node for node in aps if node is not gateway]
        roles, removed = [], []
        taken = {node["role"] for node in scene}
    taken |= set(roles)
    while len(roles) < count:
        role = next_role(taken, "fronthaul_ap", profile_id=profile)
        roles.append(role)
        taken.add(role)

    # --- samples ----------------------------------------------------------------
    walls = max(1, len(model.walls))
    client_points = client_samples(layout, mobility, limit=240)
    area_points = grid(width, height, 420 if walls < 8 else 300)[0]
    if objective == "clients" and not client_points:
        notes.append("No clients in the room yet: optimised floor coverage instead.")
        objective = "area"
    if objective == "area" or (objective == "balanced" and not client_points):
        samples, weights = area_points, [1.0] * len(area_points)
        area_n = len(area_points)
    elif objective == "clients":
        samples, weights = client_points, [1.0] * len(client_points)
        area_n = 0
    else:
        samples = area_points + client_points
        weights = [0.5 / len(area_points)] * len(area_points) + [0.5 / len(client_points)] * len(client_points)
        area_n = len(area_points)
    total_weight = sum(weights)

    def score(best: list[float]) -> float:
        return sum(w * _utility(v, target_snr_db) for w, v in zip(weights, best)) / total_weight

    def merged(best, vector):
        return [a if a > b else b for a, b in zip(best, vector)]

    # --- candidates ---------------------------------------------------------------
    candidate_target = max(40, min(300, int(WORK_BUDGET / (len(samples) * walls))))
    raw_candidates, cand_cols, cand_rows, cand_cw, cand_ch = grid(width, height, candidate_target * 1.3)
    wall_list = layout.get("walls", [])

    def admissible(p) -> bool:
        x, y = p
        if not (edge_margin_m <= x <= width - edge_margin_m and edge_margin_m <= y <= height - edge_margin_m):
            return False
        return all(point_segment_distance(p, wall["start"], wall["end"]) >= wall_clearance_m
                   for wall in wall_list)

    candidates = [p for p in raw_candidates if admissible(p)]
    if not candidates and count:
        raise ScenarioError("no admissible extender positions: the room is too small or too walled-in")

    # --- the fixed part of the network ------------------------------------------
    base_best = [float(model.minimum)] * len(samples)
    for node in [gateway] + fixed:
        if node["present"]:
            base_best = merged(base_best, model.vector(node["position"], samples, band, node["gain"][band]))
    before_best = base_best
    if strategy == "replace":
        for node in movable:
            if node["present"]:
                before_best = merged(before_best, model.vector(node["position"], samples, band,
                                                               node["gain"][band]))
    fixed_points = [gateway["position"]] + [node["position"] for node in fixed]
    # Roots are on the controller's LAN: the gateway and every wired extender.
    wired_roots = [(node["role"], node["position"]) for node in fixed if node["wired"] and node["present"]]
    backhaul_anchors = [("gateway", gateway["position"])] + wired_roots + [
        (node["role"], node["position"]) for node in fixed if not node["wired"] and not is_pod(node["role"])]
    roots = set(range(1 + len(wired_roots)))

    def hop(a, b) -> float:
        return min(model.raw_snr(a, b, backhaul_band), model.raw_snr(b, a, backhaul_band))

    # Only anchors that themselves reach a root can carry a new extender.
    reachable = set(roots)
    frontier = sorted(roots)
    while frontier:
        current_anchor = frontier.pop()
        for index, (_name, q) in enumerate(backhaul_anchors):
            if index not in reachable and hop(backhaul_anchors[current_anchor][1], q) >= min_backhaul_snr_db:
                reachable.add(index)
                frontier.append(index)
    live_anchors = [backhaul_anchors[i][1] for i in sorted(reachable)]
    for index, (name, _q) in enumerate(backhaul_anchors):
        if index not in reachable:
            notes.append(f"Existing AP {name} has no ≥ {min_backhaul_snr_db:g} dB backhaul path to the gateway "
                         "or a wired extender.")

    def tree(points) -> tuple[bool, list]:
        """Breadth-first backhaul tree from the roots; parent and SNR per point."""
        nodes = backhaul_anchors + [(roles[i], p) for i, p in enumerate(points)]
        reached, parents, frontier = set(roots), {}, sorted(roots)
        while frontier:
            current = frontier.pop(0)
            for index in range(len(nodes)):
                if index in reached:
                    continue
                value = hop(nodes[current][1], nodes[index][1])
                if value >= min_backhaul_snr_db:
                    reached.add(index)
                    parents[index] = (nodes[current][0], value)
                    frontier.append(index)
        offset = len(backhaul_anchors)
        links = []
        for i, p in enumerate(points):
            if offset + i in parents:
                parent, value = parents[offset + i]
            else:
                parent, value = max(((name, hop(q, p)) for j, (name, q) in enumerate(nodes) if j != offset + i),
                                    key=lambda item: item[1], default=(None, None))
            links.append((parent, None if value is None else round(model.clamp(value))))
        return sum(offset + i in reached for i in range(len(points))), links

    def one_hop_ok(p, placed) -> bool:
        return any(hop(p, q) >= min_backhaul_snr_db for q in live_anchors) or any(
            hop(p, q) >= min_backhaul_snr_db for q in placed)

    def spaced(p, others) -> bool:
        return all(math.hypot(p[0] - q[0], p[1] - q[1]) >= spacing for q in others)

    cache: dict[int, list[float]] = {}

    def vector_of(index: int) -> list[float]:
        if index not in cache:
            cache[index] = model.vector(candidates[index], samples, band)
        return cache[index]

    # --- greedy -------------------------------------------------------------------
    chosen: list[int] = []
    current = base_best[:]
    relaxed = False
    for slot in range(count):
        placed = [candidates[i] for i in chosen]
        best_choice = None
        for strict in (True, False):
            for index, p in enumerate(candidates):
                if index in chosen or not spaced(p, fixed_points + placed):
                    continue
                if strict and not one_hop_ok(p, placed):
                    continue
                value = score(merged(current, vector_of(index)))
                if best_choice is None or value > best_choice[0] + 1e-12:
                    best_choice = (value, index)
            if best_choice is not None:
                relaxed |= not strict
                break
        if best_choice is None:
            notes.append(f"Only {slot} of {count} extenders fit with {spacing:.1f} m spacing.")
            roles = roles[:slot]
            break
        chosen.append(best_choice[1])
        current = merged(current, vector_of(best_choice[1]))
    if relaxed:
        notes.append(f"Some positions cannot keep a ≥ {min_backhaul_snr_db:g} dB backhaul hop; "
                     "they were placed for coverage — check the backhaul column.")

    # --- candidate swaps ------------------------------------------------------------
    points = [candidates[i] for i in chosen]
    current_score = score(current)
    connected = tree(points)[0]
    for _round in range(2):
        improved = False
        for slot in range(len(chosen)):
            partial = base_best
            for other, index in enumerate(chosen):
                if other != slot:
                    partial = merged(partial, vector_of(index))
            others = [p for k, p in enumerate(points) if k != slot]
            for index, p in enumerate(candidates):
                if index in chosen or not spaced(p, fixed_points + others):
                    continue
                value = score(merged(partial, vector_of(index)))
                if value <= current_score + 1e-9:
                    continue
                trial = points[:slot] + [p] + points[slot + 1:]
                trial_connected = tree(trial)[0]
                if trial_connected < connected:
                    continue
                chosen[slot], points, current_score, connected = index, trial, value, trial_connected
                improved = True
                break
        if not improved:
            break

    # --- continuous refinement -----------------------------------------------------
    vectors = [vector_of(i) for i in chosen]
    step = math.sqrt(cand_cw * cand_ch) / 2
    directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (0.7071, 0.7071), (-0.7071, 0.7071),
                  (0.7071, -0.7071), (-0.7071, -0.7071)]
    connected = tree(points)[0]
    while step >= 0.05 and points:
        for _iteration in range(4):
            moved = False
            for slot in range(len(points)):
                partial = base_best
                for other, vector in enumerate(vectors):
                    if other != slot:
                        partial = merged(partial, vector)
                others = [p for k, p in enumerate(points) if k != slot]
                for dx, dy in directions:
                    p = (points[slot][0] + dx * step, points[slot][1] + dy * step)
                    if not admissible(p) or not spaced(p, fixed_points + others):
                        continue
                    vector = model.vector(p, samples, band)
                    value = score(merged(partial, vector))
                    if value <= current_score + 1e-9:
                        continue
                    trial = points[:slot] + [p] + points[slot + 1:]
                    trial_connected = tree(trial)[0]
                    if trial_connected < connected:
                        continue
                    points, vectors[slot], current_score, connected = trial, vector, value, trial_connected
                    moved = True
            if not moved:
                break
        step /= 2

    # --- results -------------------------------------------------------------------
    final = []
    for slot, p in enumerate(points):
        q = quantize_position(p)
        trial = final + [q] + points[slot + 1:]
        if not admissible(q) or tree(trial)[0] < tree(final + list(points[slot:]))[0]:
            q = (round(p[0], 3), round(p[1], 3))
        final.append(q)
    connected_count, links = tree(final)
    connected = connected_count == len(final)
    after_best = base_best
    for p in final:
        after_best = merged(after_best, model.vector(p, samples, band))
    placements = [{"role": role, "position": [p[0], p[1]], "backhaul_parent": parent, "backhaul_snr_db": snr}
                  for role, p, (parent, snr) in zip(roles, final, links)]
    if count and not connected:
        notes.append("The backhaul tree is not fully connected at the requested threshold.")
    return {
        "band": band, "backhaul_band": backhaul_band, "objective": objective, "strategy": strategy,
        "target_snr_db": target_snr_db, "min_backhaul_snr_db": min_backhaul_snr_db,
        "min_spacing_m": round(spacing, 2), "placements": placements, "removed": removed,
        "backhaul_connected": connected,
        "before": _split_metrics(before_best, area_n, target_snr_db),
        "after": _split_metrics(after_best, area_n, target_snr_db),
        "candidates": len(candidates), "samples": len(samples),
        "notes": notes, "elapsed_ms": round((time.monotonic() - started) * 1000),
    }


def _split_metrics(best: list[float], area_n: int, target: float) -> dict:
    metrics = {}
    if area_n:
        metrics["area"] = coverage_metrics(best[:area_n], target)
    if len(best) > area_n:
        metrics["clients"] = coverage_metrics(best[area_n:], target)
    return metrics


def apply_placement(design: dict, result: dict) -> dict:
    """Return a copy of ``design`` with the placement written into the layout."""
    import copy

    updated = copy.deepcopy(design)
    layout = updated["layout"]
    removed = set(result.get("removed", []))
    layout["nodes"] = [node for node in layout.get("nodes", []) if node["role"] not in removed]
    mobility_nodes = updated["mobility"].get("nodes", [])
    updated["mobility"]["nodes"] = [node for node in mobility_nodes if node["role"] not in removed]
    by_role = {node["role"]: node for node in layout["nodes"]}
    for placement in result["placements"]:
        node = by_role.get(placement["role"])
        if node is None:
            node = {"role": placement["role"], "kind": "fronthaul_ap", "position": placement["position"]}
            layout["nodes"].append(node)
            by_role[node["role"]] = node
        else:
            node["position"] = list(placement["position"])
        for moving in updated["mobility"].get("nodes", []):
            if moving["role"] == placement["role"] and "path" not in moving and "position" in moving:
                moving["position"] = list(placement["position"])
    return updated
