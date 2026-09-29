"""Golden World layout/mobility compiler.

A faithful port of ``wmdcfg/world.py`` (upstream a796f3a): validation messages, merge order,
hashing and the compiled ``wmdcfg.world-plan.v1`` are identical, so a room
built here produces the same ``golden_sha256`` as the reference compiler.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from .geometry import BANDS, directed_link, fast_directed_link, point, position_at_time, prepare_walls
from .model import ScenarioError
from .traffic import validate_traffic


LAYOUT_SCHEMA = "wmdcfg.world-layout.v1"
MOBILITY_SCHEMA = "wmdcfg.mobility.v1"
PLAN_SCHEMA = "wmdcfg.world-plan.v1"
KINDS = {"station", "fronthaul_ap"}
ROLE_PATTERN = r"[A-Za-z_][A-Za-z0-9_-]*"
TICK_RANGE_MS = (100, 60_000)
SNR_CLAMP = (-20, 60)


def _normalize_numbers(value: Any) -> Any:
    # JSON has one number type. Keep hashes stable when a serializer rewrites
    # an exact value such as 5.0 as 5.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_numbers(item) for key, item in value.items()}
    return value


def _canonical(value: Any) -> bytes:
    return json.dumps(
        _normalize_numbers(value), sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


canonical_hash = _hash
normalize_numbers = _normalize_numbers


def _validate_layout(layout: dict[str, Any]) -> None:
    if layout.get("schema") != "wmdcfg.world-layout.v1":
        raise ScenarioError("layout schema must be wmdcfg.world-layout.v1")
    space = layout.get("space") or {}
    width = float(space.get("width_m", 0))
    height = float(space.get("height_m", 0))
    if width <= 0 or height <= 0:
        raise ScenarioError("layout space must have positive width_m and height_m")
    if not isinstance(layout.get("name"), str) or not layout["name"]:
        raise ScenarioError("layout requires a non-empty name")
    propagation = layout.get("propagation") or {}
    references = propagation.get("reference_snr_db_by_band") or {}
    if set(references) != set(BANDS):
        raise ScenarioError(f"reference_snr_db_by_band must define {list(BANDS)}")
    if float(propagation.get("reference_distance_m", 0)) <= 0:
        raise ScenarioError("reference_distance_m must be positive")
    if float(propagation.get("path_loss_exponent", 0)) <= 0:
        raise ScenarioError("path_loss_exponent must be positive")
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    if minimum < -20 or maximum > 60 or minimum > maximum:
        raise ScenarioError("SNR clamp must remain inside [-20, 60]")

    roles: set[str] = set()
    for index, node in enumerate(layout.get("nodes", [])):
        role = node.get("role")
        if not isinstance(role, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", role):
            raise ScenarioError(f"layout node {index} has invalid role")
        if role in roles:
            raise ScenarioError(f"duplicate layout role {role}")
        roles.add(role)
        if node.get("kind") not in KINDS:
            raise ScenarioError(f"role {role} has unsupported kind {node.get('kind')!r}")
        # An AP on a wired backhaul (its LAN port on the controller's LAN): its backhaul
        # links make it a Wi-Fi extender's possible parent; the lab gives them RF only when
        # its HAL never connects its own backhaul station (wired_guard).
        if "backhaul" in node and (node["backhaul"] != "wired" or node.get("kind") != "fronthaul_ap"):
            raise ScenarioError(f"role {role}: backhaul may only be 'wired', on a fronthaul_ap")
        x, y = point(node.get("position"), f"role {role} position")
        if not (0 <= x <= width and 0 <= y <= height):
            raise ScenarioError(f"role {role} lies outside the world")

    if not any(node.get("kind") == "fronthaul_ap" for node in layout.get("nodes", [])):
        raise ScenarioError("layout defines no agents")
    for index, wall in enumerate(layout.get("walls", [])):
        start = point(wall.get("start"), f"wall {index} start")
        end = point(wall.get("end"), f"wall {index} end")
        if start == end:
            raise ScenarioError(f"wall {index} has zero length")
        if not all(0 <= point[0] <= width and 0 <= point[1] <= height for point in (start, end)):
            raise ScenarioError(f"wall {index} lies outside the world")
        if float(wall.get("loss_db", 0)) < 0:
            raise ScenarioError(f"wall {index} loss cannot be negative")


def playback_pause_points(document: dict[str, Any]) -> list[int]:
    pauses = document.get("pause_at_ms", [])
    duration = document.get("duration_ms")
    if (not isinstance(pauses, list)
            or (pauses and type(duration) is not int)
            or any(type(value) is not int or not 0 < value < duration for value in pauses)
            or pauses != sorted(set(pauses))):
        raise ScenarioError("pause_at_ms must be ordered unique integer times inside the duration")
    return pauses


def validate_ap_expectations(world: dict[str, Any]) -> None:
    """ap_expectations: at a pause checkpoint or at the final settle, the AP each named
    client must be on, e.g. [{"at": "final", "roles": {"sta_mobile_01": "extender_5"}}]."""
    expectations = world.get("ap_expectations")
    if expectations is None:
        return
    roles = world["roles"]
    pauses = set(world.get("pause_at_ms", []))
    if not isinstance(expectations, list) or not expectations:
        raise ScenarioError("ap_expectations must be a non-empty list")
    seen = set()
    for item in expectations:
        at = item.get("at") if isinstance(item, dict) else None
        if at != "final" and at not in pauses:
            raise ScenarioError("an ap_expectation is at 'final' or at a pause_at_ms checkpoint")
        if at in seen:
            raise ScenarioError(f"two ap_expectations at {at}")
        seen.add(at)
        wanted = item.get("roles")
        if not isinstance(wanted, dict) or not wanted:
            raise ScenarioError("an ap_expectation names its client roles")
        for station, ap in wanted.items():
            if roles.get(station) != "station" or roles.get(ap) != "fronthaul_ap":
                raise ScenarioError(f"ap_expectation {station} -> {ap}: a station on a fronthaul AP")


def backhaul_rf_policy(document: dict[str, Any]) -> str:
    policy = document.get("backhaul_rf", "fixed")
    if policy not in ("fixed", "geometry"):
        raise ScenarioError("backhaul_rf must be fixed or geometry")
    return policy


def _validate_mobility(mobility: dict[str, Any]) -> None:
    if mobility.get("schema") != "wmdcfg.mobility.v1":
        raise ScenarioError("mobility schema must be wmdcfg.mobility.v1")
    duration = int(mobility.get("duration_ms", 0))
    tick = int(mobility.get("tick_ms", 0))
    if duration <= 0 or not 100 <= tick <= 60_000:
        raise ScenarioError("mobility duration must be positive and tick must be 100ms..60s")
    if duration % tick:
        raise ScenarioError("mobility duration_ms must be an exact multiple of tick_ms")
    playback_pause_points(mobility)
    backhaul_rf_policy(mobility)
    if not isinstance(mobility.get("name"), str) or not mobility["name"]:
        raise ScenarioError("mobility requires a non-empty name")
    roles: set[str] = set()
    for index, node in enumerate(mobility.get("nodes", [])):
        role = node.get("role")
        if not isinstance(role, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", role):
            raise ScenarioError(f"mobility node {index} has invalid role")
        if role in roles:
            raise ScenarioError(f"duplicate mobility role {role}")
        roles.add(role)
        if node.get("kind", "station") not in KINDS:
            raise ScenarioError(f"role {role} has unsupported kind")
        path = node.get("path")
        if path:
            times = []
            for waypoint in path:
                time_ms = int(waypoint.get("time_ms", -1))
                point(waypoint.get("position"), f"role {role} waypoint")
                times.append(time_ms)
            if times != sorted(set(times)) or times[0] != 0 or times[-1] > duration:
                raise ScenarioError(
                    f"role {role} waypoints must be unique, ordered, start at zero and fit duration"
                )
        elif "position" not in node:
            raise ScenarioError(f"role {role} requires position or path")
        else:
            point(node["position"], f"role {role} position")
        intervals = node.get("presence", [[0, duration]])
        previous_end = -1
        for interval in intervals:
            if (
                not isinstance(interval, list)
                or len(interval) != 2
                or not 0 <= int(interval[0]) < int(interval[1]) <= duration
            ):
                raise ScenarioError(f"role {role} has invalid presence interval")
            if int(interval[0]) < previous_end:
                raise ScenarioError(f"role {role} has overlapping presence intervals")
            previous_end = int(interval[1])


validate_layout = _validate_layout
validate_mobility = _validate_mobility


def load_json(path: str | Path) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ScenarioError(f"{path}: invalid JSON: {error}") from error


def _merge_nodes(layout: dict[str, Any], mobility: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = {item["role"]: dict(item) for item in layout.get("nodes", [])}
    for moving in mobility.get("nodes", []):
        role = moving["role"]
        merged = dict(nodes.get(role, {}))
        merged.update(moving)
        merged.setdefault("kind", "station")
        nodes[role] = merged
    return [nodes[role] for role in sorted(nodes)]


merge_nodes = _merge_nodes


def _present(node: dict[str, Any], time_ms: int, duration_ms: int) -> bool:
    return any(
        int(start) <= time_ms < int(end)
        for start, end in node.get("presence", [[0, duration_ms]])
    )


is_present = _present


def compile_world(layout: dict[str, Any], mobility: dict[str, Any]) -> dict[str, Any]:
    _validate_layout(layout)
    _validate_mobility(mobility)
    nodes = _merge_nodes(layout, mobility)
    width = float(layout["space"]["width_m"])
    height = float(layout["space"]["height_m"])
    duration = int(mobility["duration_ms"])
    tick = int(mobility["tick_ms"])
    agents = [item for item in nodes if item["kind"] == "fronthaul_ap"]
    stations = [item for item in nodes if item["kind"] == "station"]
    if not stations:
        raise ScenarioError("world defines no stations")

    prepared = prepare_walls(layout.get("walls", []))
    propagation = layout["propagation"]
    seed = int(mobility.get("seed", 0))

    def link(source, destination, positions, presence, time_ms, link_class):
        # Same result as directed_link(...); see geometry.fast_directed_link.
        return fast_directed_link(source, destination, positions, presence, propagation, prepared, seed,
                                  time_ms, link_class)

    generations = []
    for time_ms in range(0, duration, tick):
        positions = {item["role"]: position_at_time(item, time_ms) for item in nodes}
        for role, (x, y) in positions.items():
            if not (0 <= x <= width and 0 <= y <= height):
                raise ScenarioError(f"role {role} leaves the world at {time_ms}ms")
        presence = {item["role"]: _present(item, time_ms, duration) for item in nodes}
        links = []
        for station in stations:
            for agent in agents:
                links.append(link(station, agent, positions, presence, time_ms, "fronthaul"))
                links.append(link(agent, station, positions, presence, time_ms, "fronthaul"))
        for index, left in enumerate(agents):
            for right in agents[index + 1 :]:
                links.append(link(left, right, positions, presence, time_ms, "backhaul"))
                links.append(link(right, left, positions, presence, time_ms, "backhaul"))
        generations.append(
            {
                "time_ms": time_ms,
                "positions": {
                    role: [round(point[0], 3), round(point[1], 3)]
                    for role, point in sorted(positions.items())
                },
                "present": {role: presence[role] for role in sorted(presence)},
                "links": sorted(
                    links,
                    key=lambda item: (
                        item["link_class"], item["source_role"], item["destination_role"]
                    ),
                ),
            }
        )
    wired = sorted(item["role"] for item in agents if item.get("backhaul") == "wired")
    result = {
        "schema": "wmdcfg.world-plan.v1",
        "name": f"{layout['name']}--{mobility['name']}",
        "layout": layout["name"],
        "mobility": mobility["name"],
        "tags": sorted(set(layout.get("tags", [])) | set(mobility.get("tags", []))),
        "layout_sha256": _hash(layout),
        "mobility_sha256": _hash(mobility),
        "tick_ms": tick,
        "duration_ms": duration,
        "bands": list(BANDS),
        "counts": {"agents": len(agents), "stations": len(stations)},
        "roles": {item["role"]: item["kind"] for item in nodes},
        **({"wired_backhaul": wired} if wired else {}),
        "walls": layout.get("walls", []),
        "generations": generations,
    }
    pauses = playback_pause_points(mobility)
    if pauses:
        result["pause_at_ms"] = list(pauses)
    for key in ("band_steering", "band_steering_expectations", "backhaul_rf", "traffic_experiment", "ap_expectations"):
        if key in mobility:
            result[key] = copy.deepcopy(mobility[key])
    validate_traffic(result)
    validate_ap_expectations(result)
    result["golden_sha256"] = _hash(result)
    # Keep the serialized artifact byte-stable across jq/Python versions.
    return _normalize_numbers(result)


def verify_world_plan(plan: dict[str, Any]) -> None:
    if plan.get("schema") != "wmdcfg.world-plan.v1":
        raise ScenarioError("world plan schema must be wmdcfg.world-plan.v1")
    claimed = plan.get("golden_sha256")
    unsigned = dict(plan)
    unsigned.pop("golden_sha256", None)
    if claimed != _hash(unsigned):
        raise ScenarioError("world plan golden_sha256 does not match its contents")
    playback_pause_points(plan)
    backhaul_rf_policy(plan)


def golden_json(plan: dict[str, Any]) -> str:
    """Serialize exactly like ``build-goldens.sh`` (``jq -c .`` of the plan).

    ``jq -c`` keeps key order and emits compact separators. The reference CLI
    writes ``json.dumps(indent=2, sort_keys=True)`` first, so keys are sorted.
    """
    return json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def _role_lines(plan: dict[str, Any]) -> list[str]:
    return [f"    role {role} : {kind}" for role, kind in sorted(plan["roles"].items())]


def export_wmd(plan: dict[str, Any], band: str) -> str:
    """Export one pair projection or simultaneous band-qualified links."""
    verify_world_plan(plan)
    if band not in (*BANDS, "all"):
        raise ScenarioError(f"projection band must be one of {list(BANDS)} or all")
    safe_name = re.sub(r"[^A-Za-z0-9_]", "_", plan["name"])
    all_bands = band == "all"
    lines = [
        f"# generated from world golden {plan['golden_sha256']}",
        (
            "# simultaneous 2.4/5/6GHz frequency-qualified values"
            if all_bands else
            f"# projection-band {band}GHz; current actuator is radio-pair, not per-frequency"
        ),
        f"scenario {safe_name}_{band.replace('.', '_')} {{",
        "    language 1",
        f"    tick {plan['tick_ms']}ms",
        (
            "    require frequency_qualified_snr"
            if all_bands else "    require radio_pair_snr"
        ),
        "    require atomic_generations",
        "    require readback",
        "    protect backhaul",
        "    restore captured",
        "",
        *_role_lines(plan),
        "",
    ]
    previous: dict[tuple[str, str, str | None], int] = {}
    if backhaul_rf_policy(plan) == "geometry":
        lines.insert(1, "# geometry backhaul requires the interactive room engine; this DSL export contains fronthaul only")
    for generation in plan["generations"]:
        current = {
            (item["source_role"], item["destination_role"], selected_band): int(
                item["snr_db_by_band"][selected_band]
            )
            for item in generation["links"]
            if item["link_class"] == "fronthaul"
            for selected_band in (BANDS if all_bands else (band,))
        }
        changed = current if not previous else {
            key: value for key, value in current.items() if previous.get(key) != value
        }
        lines.append(
            f"    phase t_{generation['time_ms']:08d} for {plan['tick_ms']}ms {{"
        )
        if changed:
            lines.append("        parallel {")
            emitted: set[tuple[str, str, str | None]] = set()
            for key in sorted(changed):
                if key in emitted:
                    continue
                source, destination, selected_band = key
                reverse = (destination, source, selected_band)
                qualification = (
                    f" band {selected_band}GHz" if selected_band is not None and all_bands
                    else ""
                )
                if reverse in changed and changed[reverse] == changed[key]:
                    lines.append(
                        f"            link {source} <-> {destination}{qualification} "
                        f"snr = {changed[key]}dB"
                    )
                    emitted.add(reverse)
                else:
                    lines.append(
                        f"            link {source} -> {destination}{qualification} "
                        f"snr = {changed[key]}dB"
                    )
                emitted.add(key)
            lines.append("        }")
        else:
            lines.append("        hold")
        lines.append("    }")
        previous = current
    lines.append("}")
    return "\n".join(lines) + "\n"
