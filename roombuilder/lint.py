"""Design checks with actionable tips.

``lint`` runs the configurator's own validation (errors that ``wmdcfg
world-compile`` would raise), the live-lab admission rules of the selected
profile, and builder heuristics for RF pitfalls that the configurator accepts
silently (a device standing on a wall line, a wall hidden behind another).
Every finding names the object it refers to so the UI can select it.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .bands import validate_expectations, validate_profiles
from .geometry import BANDS, point_segment_distance, position_at_time
from .lab import lab_findings
from .model import ScenarioError
from .placement import RFModel, is_pod, nodes_at
from .world import compile_world, merge_nodes, validate_layout, validate_mobility

WALL_LINE_TOLERANCE_M = 0.05
VIEWER_MIN_SIZE = (20, 14)


def _finding(level: str, code: str, message: str, tip: str = "", **target) -> dict:
    item = {"level": level, "code": code, "message": message}
    if tip:
        item["tip"] = tip
    item.update({key: value for key, value in target.items() if value is not None})
    return item


def lint(design: dict, *, band: str = "5", compiled: dict | None = None) -> dict:
    """Return ``{"findings": [...], "compiled": plan | None, "summary": {...}}``."""
    layout = design.get("layout", {})
    mobility = design.get("mobility", {})
    findings: list[dict] = []
    plan = compiled

    # 1. configurator validation (what wmdcfg would reject) ---------------------
    for label, validator, document in (("layout", validate_layout, layout),
                                       ("mobility", validate_mobility, mobility)):
        try:
            validator(document)
        except ScenarioError as error:
            findings.append(_finding("error", f"{label}.invalid", str(error), _tip_for(str(error)),
                                     **_target_from_message(str(error))))
    if plan is None and not any(f["level"] == "error" for f in findings):
        try:
            plan = compile_world(layout, mobility)
        except ScenarioError as error:
            findings.append(_finding("error", "world.compile", str(error), _tip_for(str(error)),
                                     **_target_from_message(str(error))))
    if plan is not None:
        for check, validator in (("band-steering", validate_profiles),
                                 ("expectations", validate_expectations)):
            try:
                validator(plan)
            except ScenarioError as error:
                findings.append(_finding("error", f"scenario.{check}", str(error),
                                         "The live room rejects the world when this metadata is invalid."))
        for item in lab_findings(plan, layout, mobility, design.get("profile", "configurator")):
            findings.append(_finding(item["level"], item["code"], item["message"],
                                     _lab_tip(item["code"]), role=item.get("role")))

    # 2. naming used by the live room -------------------------------------------
    for key, document in (("layout", layout), ("mobility", mobility)):
        name = document.get("name")
        if isinstance(name, str) and name and not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", name):
            findings.append(_finding("warning", f"{key}.name",
                                     f"{key} name {name!r} is not a lab file name",
                                     "The live room loads worlds/<kind>/<name>.json: use letters, digits, - and _."))

    # 3. geometry heuristics -------------------------------------------------------
    try:
        findings.extend(_geometry_findings(layout, mobility))
    except (KeyError, TypeError, ValueError, ScenarioError):
        pass
    if plan is not None:
        try:
            findings.extend(_rf_findings(layout, mobility, plan, band))
        except (KeyError, TypeError, ValueError, ScenarioError):
            pass
    order = {"error": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda item: order.get(item["level"], 3))
    summary = {level: sum(item["level"] == level for item in findings) for level in order}
    summary["compiles"] = plan is not None
    if plan is not None:
        summary.update(golden_sha256=plan["golden_sha256"], generations=len(plan["generations"]),
                       agents=plan["counts"]["agents"], stations=plan["counts"]["stations"],
                       links_per_generation=len(plan["generations"][0]["links"]))
    return {"findings": findings, "compiled": plan, "summary": summary}


def _geometry_findings(layout: dict, mobility: dict) -> list[dict]:
    findings = []
    walls = layout.get("walls", [])
    width = float(layout["space"]["width_m"])
    height = float(layout["space"]["height_m"])
    if width < VIEWER_MIN_SIZE[0] or height < VIEWER_MIN_SIZE[1]:
        findings.append(_finding(
            "info", "viewer.room-size",
            f"The reference viewer draws this {width:g}×{height:g} m room on a "
            f"{max(width, 20):g}×{max(height, 14):g} m floor when it opens only the .world.json",
            "World plans do not carry the room size; the viewer infers at least 20×14 m from positions. "
            "The live room reads the real size from the installed layout."))
    duration = int(mobility.get("duration_ms", 0) or 0)
    tick = int(mobility.get("tick_ms", 0) or 0)
    nodes = merge_nodes(layout, mobility)
    # Sample exactly the compiled generations (0 .. duration - tick).
    generation_times = list(range(0, duration, tick)) if duration > 0 and tick > 0 else [0]
    for node in nodes:
        role = node["role"]
        times = generation_times if node.get("path") else [0]
        reported = set()
        for time_ms in times:
            try:
                p = position_at_time(node, time_ms)
            except (KeyError, ScenarioError):
                break
            for index, wall in enumerate(walls):
                if index in reported:
                    continue
                if point_segment_distance(p, wall["start"], wall["end"]) < WALL_LINE_TOLERANCE_M:
                    reported.add(index)
                    name = wall.get("name") or index
                    standing = rf_static_at(node, time_ms, tick, wall)
                    if standing:
                        findings.append(_finding(
                            "warning", "geometry.on-wall",
                            f"{role} stands on wall {name} at t={time_ms / 1000:g} s",
                            "A link from a point on a wall's line never 'properly crosses' that wall, so it adds "
                            "no loss to any of the device's links while it stands there. Keep devices at least "
                            "5 cm off wall lines.",
                            role=role, wall=index))
                    else:
                        findings.append(_finding(
                            "info", "geometry.crosses-on-tick",
                            f"{role} passes through wall {name} exactly at the t={time_ms / 1000:g} s tick",
                            "That one generation ignores the wall for this device (a one-tick RF blip). Shift "
                            "the path or its timing slightly if the blip matters.",
                            role=role, wall=index))
        # A path segment running along a wall line also escapes its loss.
        path = node.get("path") or []
        for left, right in zip(path, path[1:]):
            if duration and int(left["time_ms"]) >= duration:
                break
            for index, wall in enumerate(walls):
                if (point_segment_distance(left["position"], wall["start"], wall["end"]) < WALL_LINE_TOLERANCE_M
                        and point_segment_distance(right["position"], wall["start"], wall["end"]) < WALL_LINE_TOLERANCE_M):
                    findings.append(_finding(
                        "warning", "geometry.walk-along-wall",
                        f"{role} walks along wall {wall.get('name') or index}",
                        "While on the wall line the wall is ignored; offset the path by a few centimetres.",
                        role=role, wall=index))
        if node.get("kind", "station") == "station" and node.get("path") and "mobile" not in role and role.startswith("sta_"):
            findings.append(_finding(
                "info", "viewer.static-colour",
                f"{role} moves but the viewer colours it as a static client (dark)",
                "The viewer picks purple only for role names containing 'mobile'. Lab bindings are by role, "
                "so renaming changes which container walks.", role=role))
        if tick and node.get("path"):
            for left, right in zip(node["path"], node["path"][1:]):
                dt = int(right["time_ms"]) - int(left["time_ms"])
                if dt <= 0:
                    continue
                speed = math.dist(left["position"], right["position"]) / (dt / 1000)
                if speed > 3.2:
                    findings.append(_finding(
                        "info", "motion.fast",
                        f"{role} moves at {speed:.1f} m/s between {int(left['time_ms']) / 1000:g} s and "
                        f"{int(right['time_ms']) / 1000:g} s",
                        "Faster than a run (3 m/s). Fine for stress rooms like fast-transit; "
                        "with a long tick the client jumps between generations.", role=role))
                    break
                if speed * tick / 1000 > 4:
                    findings.append(_finding(
                        "info", "motion.coarse-tick",
                        f"{role} moves {speed * tick / 1000:.1f} m per tick",
                        "Each generation is one RF snapshot; shorten the tick for a smoother RF sequence.",
                        role=role))
                    break
        last_time = max((int(w["time_ms"]) for w in node.get("path") or []), default=0)
        if duration and node.get("path") and last_time < duration * 0.5 and len(node["path"]) > 1:
            findings.append(_finding(
                "info", "motion.early-stop",
                f"{role} stops moving at {last_time / 1000:g} s of {duration / 1000:g} s",
                "After its last waypoint a role holds still until the end.", role=role))
    # overlapping or duplicate walls
    for i, a in enumerate(walls):
        for j in range(i + 1, len(walls)):
            b = walls[j]
            if _collinear_overlap(a, b):
                findings.append(_finding(
                    "info", "geometry.stacked-walls",
                    f"walls {a.get('name') or i} and {b.get('name') or j} overlap on one line",
                    "Both losses are added when a path crosses them. That is how to model a double wall; "
                    "remove one if it was accidental.", wall=j))
    return findings


def rf_static_at(node: dict, time_ms: int, tick: int, wall: dict) -> bool:
    """True when the role is still on the wall line one tick earlier or later (not a pass-through)."""
    if not node.get("path") or time_ms == 0:
        return True
    for other in (time_ms - tick, time_ms + tick):
        if other < 0:
            continue
        try:
            q = position_at_time(node, other)
        except (KeyError, ScenarioError):
            continue
        if point_segment_distance(q, wall["start"], wall["end"]) < WALL_LINE_TOLERANCE_M:
            return True
    return False


def _collinear_overlap(a: dict, b: dict, tolerance: float = 1e-6) -> bool:
    (ax, ay), (bx, by) = a["start"], a["end"]
    (cx, cy), (dx, dy) = b["start"], b["end"]
    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)
    if abs(orient(ax, ay, bx, by, cx, cy)) > tolerance or abs(orient(ax, ay, bx, by, dx, dy)) > tolerance:
        return False
    length = math.hypot(bx - ax, by - ay)
    if length == 0:
        return False
    ux, uy = (bx - ax) / length, (by - ay) / length
    t0 = sorted([0.0, length])
    t1 = sorted([(cx - ax) * ux + (cy - ay) * uy, (dx - ax) * ux + (dy - ay) * uy])
    return min(t0[1], t1[1]) - max(t0[0], t1[0]) > tolerance


def _rf_findings(layout: dict, mobility: dict, plan: dict, band: str) -> list[dict]:
    findings = []
    model = RFModel(layout)
    roles = plan["roles"]
    weak_clients: dict[str, tuple[int, int]] = {}
    for generation in plan["generations"]:
        best: dict[str, int] = {}
        for link in generation["links"]:
            if link["link_class"] != "fronthaul" or roles[link["source_role"]] != "fronthaul_ap":
                continue
            if not generation["present"][link["source_role"]] or not generation["present"][link["destination_role"]]:
                continue
            value = link["snr_db_by_band"][band]
            station = link["destination_role"]
            best[station] = max(best.get(station, -99), value)
        for station, value in best.items():
            if value < 10 and (station not in weak_clients or value < weak_clients[station][0]):
                weak_clients[station] = (value, generation["time_ms"])
    for station, (value, time_ms) in sorted(weak_clients.items()):
        findings.append(_finding(
            "warning", "rf.coverage-hole",
            f"{station} drops to {value} dB best {band} GHz SNR at t={time_ms / 1000:g} s",
            "Below ~10 dB the client barely associates. Intended for coverage-hole tests; otherwise add or "
            "move an extender (Devices → Place extenders).", role=station))
    # backhaul of every wireless extender at t=0
    scene = {node["role"]: node for node in nodes_at(layout, mobility, 0)}
    # Wi-Fi extenders need a backhaul peer; wired extenders are on the LAN and can be that peer.
    candidates = [role for role, kind in roles.items() if kind == "fronthaul_ap" and not is_pod(role)]
    for role in candidates:
        if role == "gateway" or scene[role]["wired"]:
            continue
        a = scene[role]["position"]
        peers = [(min(model.snr(a, scene[p]["position"], "5"), model.snr(scene[p]["position"], a, "5")), p)
                 for p in candidates if p != role]
        if not peers:
            continue
        value, peer = max(peers)
        if value < 20:
            findings.append(_finding(
                "warning" if value < 12 else "info", "rf.backhaul-weak",
                f"{role}: strongest 5 GHz mesh peer is {peer} at {value} dB",
                "EasyMesh extenders need a Wi-Fi backhaul; the native policy wants roughly ≥ 20 dB "
                "(RCPI ≥ 50 at −85 dBm for a target). With backhaul_rf 'fixed' the live lab keeps its "
                "protected startup RF anyway.", role=role))
    return findings


def _tip_for(message: str) -> str:
    tips = [
        ("exact multiple", "Set the duration to a whole number of ticks (Motion → Duration snaps for you)."),
        ("leaves the world", "A waypoint or interpolated position lies outside the room. Drag the waypoint "
                             "inside or enlarge the room."),
        ("lies outside the world", "Enlarge the room (Room → Size) or move the object inside."),
        ("waypoints must be unique", "Waypoint times must start at 0, increase strictly and end within the "
                                     "duration. Use Motion → Retime by speed."),
        ("presence interval", "Presence intervals are [start, end) inside the duration, ordered and "
                              "non-overlapping."),
        ("no stations", "Add at least one client (C)."),
        ("no agents", "Add the gateway (E on an empty room)."),
        ("pause_at_ms", "Checkpoints must be unique integer times strictly inside the duration."),
        ("zero length", "Delete the wall or drag one end away."),
        ("SNR clamp", "The configurator only accepts SNR clamps inside [-20, 60] dB."),
        ("traffic", "See Scenario → Traffic experiment for the bounds of each phase."),
    ]
    for needle, tip in tips:
        if needle in message:
            return tip
    return ""


def _lab_tip(code: str) -> str:
    return {
        "lab.mesh-missing": "The live lab has a fixed set of agents; every one must appear in the room "
                            "(it may be hidden with a presence interval).",
        "lab.mesh-unbound": "Rename the AP to a bound role, or switch the profile to 'Configurator only'.",
        "lab.station-unbound": "Use Devices → Rename to pick a bound client role.",
        "lab.gateway": "Agent-1 (gateway) must be on air at t=0.",
        "lab.capacity": "The lab provisions 100 clients.",
        "lab.cohorts": "Pool worlds split clients evenly into private and IoT cohorts.",
    }.get(code, "")


def _target_from_message(message: str) -> dict:
    match = re.search(r"role (\S+?)(?::| |$)", message)
    if match:
        return {"role": match.group(1).strip("'\"")}
    match = re.search(r"wall (\d+)", message)
    if match:
        return {"wall": int(match.group(1))}
    return {}
