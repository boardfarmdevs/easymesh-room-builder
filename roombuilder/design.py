"""The room builder's design document and its conversions.

A design wraps the two configurator source documents *verbatim*:

* ``layout``   – ``wmdcfg.world-layout.v1`` (space, propagation, walls, fixed nodes)
* ``mobility`` – ``wmdcfg.mobility.v1`` (duration, tick, paths, presence, metadata)

plus builder-only metadata (wall materials, notes, room guide text) that is
never exported into the configurator documents. Because the configurator
documents are stored as-is, exporting a design and compiling it with the
reference ``wmdcfg world-compile`` yields the same ``golden_sha256`` as
compiling it here.
"""

from __future__ import annotations

import copy
import datetime as _dt
import io
import json
import math
import re
import statistics
import zipfile
from typing import Any

from . import __version__
from .geometry import BANDS
from .lab import DEFAULT_PROFILE, PROFILES
from .materials import DEFAULT_MATERIAL, infer_material
from .model import ScenarioError
from .world import (
    LAYOUT_SCHEMA, MOBILITY_SCHEMA, PLAN_SCHEMA, canonical_hash, compile_world,
    export_wmd, golden_json, verify_world_plan,
)

DESIGN_SCHEMA = "roombuilder.design.v1"
ID_PATTERN = r"[a-z0-9][a-z0-9_-]{0,99}"
LAB_PROPAGATION = {
    "reference_distance_m": 1,
    "reference_snr_db_by_band": {"2.4": 54, "5": 50, "6": 47},
    "path_loss_exponent": 2.2,
    "shadowing_stddev_db": 0,
    "minimum_snr_db": -20,
    "maximum_snr_db": 60,
}
PROPAGATION_PRESETS = {
    "home": {
        "label": "Home / office (lab default)",
        "tip": "54/50/47 dB at 1 m, exponent 2.2: every home, lane and large-room reference layout.",
        "propagation": LAB_PROPAGATION,
    },
    "courtyard": {
        "label": "Courtyard / campus (backhaul rooms)",
        "tip": "52/48/45 dB at 1 m, exponent 2.8: the reference backhaul-branches and courtyard layouts.",
        "propagation": {**LAB_PROPAGATION, "reference_snr_db_by_band": {"2.4": 52, "5": 48, "6": 45},
                        "path_loss_exponent": 2.8},
    },
    "open-hall": {
        "label": "Open hall / warehouse",
        "tip": "Line-of-sight dominated space: exponent 2.0 (free space).",
        "propagation": {**LAB_PROPAGATION, "path_loss_exponent": 2.0},
    },
    "dense-office": {
        "label": "Dense office with clutter",
        "tip": "Exponent 3.0 approximates furniture and people without drawing every obstacle.",
        "propagation": {**LAB_PROPAGATION, "path_loss_exponent": 3.0},
    },
}


def slugify(text: str, fallback: str = "room") -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", str(text).lower()).strip("-_")
    slug = re.sub(r"-{2,}", "-", slug)[:100].strip("-_")
    return slug or fallback


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def new_layout(name: str = "untitled-room", width: float = 20, height: float = 14) -> dict:
    return {
        "schema": LAYOUT_SCHEMA,
        "name": name,
        "tags": [],
        "space": {"width_m": width, "height_m": height},
        "propagation": copy.deepcopy(LAB_PROPAGATION),
        "walls": [],
        "nodes": [
            {"role": "gateway", "kind": "fronthaul_ap", "position": [round(width / 2, 2), round(height / 2, 2)]},
        ],
    }


def new_mobility(name: str = "stationary") -> dict:
    return {
        "schema": MOBILITY_SCHEMA,
        "name": name,
        "tags": [],
        "duration_ms": 60000,
        "tick_ms": 2000,
        "seed": 1701,
        "nodes": [],
    }


def new_design(title: str = "Untitled room", width: float = 20, height: float = 14,
               profile: str = DEFAULT_PROFILE, design_id: str | None = None) -> dict:
    slug = design_id or slugify(title)
    stamp = now_iso()
    return {
        "schema": DESIGN_SCHEMA,
        "id": slug,
        "title": title,
        "description": "",
        "profile": profile,
        "created_at": stamp,
        "updated_at": stamp,
        "revision": 0,
        "generator": f"roombuilder {__version__}",
        "layout": new_layout(slug, width, height),
        "mobility": new_mobility("stationary"),
        "builder": {"wall_materials": [], "notes": "", "view": {"band": "5"}},
    }


def normalize_design(design: dict) -> dict:
    """Fill optional fields and keep ``builder.wall_materials`` aligned with walls."""
    if not isinstance(design, dict) or design.get("schema") != DESIGN_SCHEMA:
        raise ScenarioError(f"design schema must be {DESIGN_SCHEMA}")
    result = copy.deepcopy(design)
    if not isinstance(result.get("layout"), dict) or not isinstance(result.get("mobility"), dict):
        raise ScenarioError("design requires layout and mobility documents")
    result.setdefault("title", result["layout"].get("name", "Untitled room"))
    result.setdefault("id", slugify(result["title"]))
    if not re.fullmatch(ID_PATTERN, str(result["id"])):
        result["id"] = slugify(str(result["id"]))
    result.setdefault("description", "")
    if result.get("profile") not in PROFILES:
        result["profile"] = DEFAULT_PROFILE
    result.setdefault("revision", 0)
    builder = result.setdefault("builder", {})
    walls = result["layout"].get("walls", [])
    materials = list(builder.get("wall_materials") or [])
    materials = materials[: len(walls)]
    for wall in walls[len(materials):]:
        materials.append(infer_material(wall.get("loss_db")))
    builder["wall_materials"] = materials
    builder.setdefault("notes", "")
    builder.setdefault("view", {"band": "5"})
    return result


def layout_of(design: dict) -> dict:
    return copy.deepcopy(design["layout"])


def mobility_of(design: dict) -> dict:
    return copy.deepcopy(design["mobility"])


def world_id(design: dict) -> str:
    return design.get("id") or slugify(design["layout"].get("name", "room"))


def compile_design(design: dict) -> dict:
    return compile_world(design["layout"], design["mobility"])


# --------------------------------------------------------------------------
# Detection and import
# --------------------------------------------------------------------------

def detect_kind(document: Any) -> str:
    if isinstance(document, str):
        return "wmd" if re.search(r"^\s*scenario\s+\S+\s*\{", document, re.M) else "unknown"
    if not isinstance(document, dict):
        return "unknown"
    return {
        DESIGN_SCHEMA: "design",
        LAYOUT_SCHEMA: "layout",
        MOBILITY_SCHEMA: "mobility",
        PLAN_SCHEMA: "world",
    }.get(document.get("schema"), "unknown")


def design_from_layout_mobility(layout: dict, mobility: dict, *, title: str | None = None,
                                design_id: str | None = None, profile: str | None = None,
                                description: str = "", source: dict | None = None) -> dict:
    name = layout.get("name", "room")
    design = new_design(title or f"{name} — {mobility.get('name', 'scenario')}",
                        design_id=design_id or slugify(f"{name}-{mobility.get('name', '')}"),
                        profile=profile or guess_profile(layout, mobility))
    design["layout"] = copy.deepcopy(layout)
    design["mobility"] = copy.deepcopy(mobility)
    design["description"] = description
    design["builder"]["wall_materials"] = [infer_material(w.get("loss_db")) for w in layout.get("walls", [])]
    if source:
        design["source"] = copy.deepcopy(source)
    return normalize_design(design)


def guess_profile(layout: dict, mobility: dict) -> str:
    roles = {node.get("role") for node in layout.get("nodes", [])} | {
        node.get("role") for node in mobility.get("nodes", [])}
    has_native = {"gateway", "extender_1", "extender_2", "extender_3", "extender_4"} <= roles
    if not has_native:
        return "configurator"
    pods = {"pod_1", "pod_2"} <= roles
    wired = "extender_5" in roles
    return {(False, False): "rdk-lab", (False, True): "rdk-lab-wired",
            (True, False): "rdk-lab-pods", (True, True): "rdk-lab-pods-wired"}[(pods, wired)]


def import_documents(documents: list, *, base: dict | None = None,
                     known_layouts: dict | None = None,
                     known_mobilities: dict | None = None) -> tuple[dict, list[str]]:
    """Build a design from any mix of configurator documents.

    Accepts a design, a layout (+ optional mobility), a mobility alone (merged
    into ``base``'s layout), or a compiled world plan. Returns the design and
    human-readable notes about what was reconstructed.
    """
    notes: list[str] = []
    by_kind: dict[str, list] = {}
    for document in documents:
        by_kind.setdefault(detect_kind(document), []).append(document)
    if by_kind.get("wmd"):
        raise ScenarioError(
            ".wmd scenarios hold per-link SNR phases, not geometry: a room cannot be rebuilt from one. "
            "Import the layout/mobility JSON or the compiled .world.json instead.")
    if by_kind.get("unknown"):
        raise ScenarioError("unrecognized document: expected a design, layout, mobility or world plan JSON")
    for kind, items in by_kind.items():
        if len(items) > 1:
            raise ScenarioError(f"import one {kind} document at a time")
    if "design" in by_kind:
        if len(by_kind) > 1:
            raise ScenarioError("a design already contains its layout and mobility")
        return normalize_design(by_kind["design"][0]), ["Opened room builder design."]
    if "world" in by_kind:
        if len(by_kind) > 1:
            raise ScenarioError("a compiled world already contains its layout and mobility")
        return design_from_world(by_kind["world"][0], known_layouts or {}, known_mobilities or {})
    layout = by_kind.get("layout", [None])[0]
    mobility = by_kind.get("mobility", [None])[0]
    if layout is None:
        if base is None:
            raise ScenarioError("a mobility document needs a layout: import both, or open a room first")
        layout = copy.deepcopy(base["layout"])
        notes.append(f"Scenario '{mobility.get('name')}' applied to the current layout '{layout.get('name')}'.")
    if mobility is None:
        mobility = copy.deepcopy(base["mobility"]) if base else new_mobility()
        notes.append("No mobility supplied: " + (
            "kept the current scenario." if base else "created a 60 s stationary scenario."))
    design = design_from_layout_mobility(layout, mobility)
    notes.append(f"Imported layout '{layout.get('name')}' and scenario '{mobility.get('name')}' verbatim.")
    return design, notes


# --------------------------------------------------------------------------
# World plan reconstruction
# --------------------------------------------------------------------------

def _compress_path(times: list[int], points: list[list[float]]) -> list[dict]:
    """Fewest waypoints that reproduce every sampled position exactly.

    Waypoints sit on samples. A run of samples is merged into one straight,
    constant-speed segment only if interpolating between its ends and
    rounding to the compiler's 1 mm gives back every sample in between.
    """
    if not times:
        return []

    def reproduces(i: int, j: int) -> bool:
        a, b = points[i], points[j]
        span = times[j] - times[i]
        for k in range(i + 1, j):
            f = (times[k] - times[i]) / span
            guess = [round(a[0] + (b[0] - a[0]) * f, 3), round(a[1] + (b[1] - a[1]) * f, 3)]
            if guess != [round(points[k][0], 3), round(points[k][1], 3)]:
                return False
        return True

    keep = [0]
    anchor = 0
    while anchor < len(times) - 1:
        end = anchor + 1
        while end + 1 < len(times) and reproduces(anchor, end + 1):
            end += 1
        keep.append(end)
        anchor = end
    waypoints = [{"time_ms": times[i], "position": list(points[i])} for i in keep]
    # drop trailing waypoints that only repeat the final position (a hold)
    while len(waypoints) > 1 and waypoints[-1]["position"] == waypoints[-2]["position"]:
        waypoints.pop()
    return waypoints


def _intervals(times: list[int], flags: list[bool], duration: int) -> list[list[int]]:
    intervals, start = [], None
    for time_ms, flag in zip(times, flags):
        if flag and start is None:
            start = time_ms
        elif not flag and start is not None:
            intervals.append([start, time_ms])
            start = None
    if start is not None:
        intervals.append([start, duration])
    return intervals


def _fit_propagation(plan: dict) -> tuple[dict, dict, list[str]]:
    """Least-squares fit of reference SNR (per band) and a shared exponent.

    Uses unclamped links between present nodes, assuming a 1 m reference
    distance. Returns (propagation, per-source gains, notes).
    """
    notes = []
    roles = plan["roles"]
    minimum, maximum = -20, 60
    absent_values = set()
    samples = {band: [] for band in BANDS}
    for generation in plan["generations"]:
        present = generation["present"]
        for link in generation["links"]:
            both = present.get(link["source_role"]) and present.get(link["destination_role"])
            for band in BANDS:
                value = link["snr_db_by_band"][band]
                if not both:
                    absent_values.add(value)
                    continue
                samples[band].append((link, value))
    if len(absent_values) == 1:
        minimum = absent_values.pop()
    # AP-sourced links carry no transmit adjustment in every reference room.
    rows = []
    for band in BANDS:
        for link, value in samples[band]:
            if roles.get(link["source_role"]) != "fronthaul_ap":
                continue
            if not minimum < value < maximum:
                continue
            x = 10 * math.log10(max(link["distance_m"], 1.0))
            rows.append((band, x, value + link["wall_loss_db"]))
    if len(rows) < 3:
        notes.append("Too few unclamped links to fit propagation; used the lab default.")
        return copy.deepcopy(LAB_PROPAGATION), {}, notes
    # Solve y = R_b - n * x by normal equations with per-band intercepts.
    index = {band: i for i, band in enumerate(BANDS)}
    size = len(BANDS) + 1
    ata = [[0.0] * size for _ in range(size)]
    aty = [0.0] * size
    for band, x, y in rows:
        vector = [0.0] * size
        vector[index[band]] = 1.0
        vector[-1] = -x
        for i in range(size):
            aty[i] += vector[i] * y
            for j in range(size):
                ata[i][j] += vector[i] * vector[j]
    solution = _solve(ata, aty)
    if solution is None:
        notes.append("Link geometry was degenerate; used the lab default propagation.")
        return copy.deepcopy(LAB_PROPAGATION), {}, notes
    exponent, references = _snap_propagation(rows, solution[-1],
                                             {band: solution[index[band]] for band in BANDS})
    residuals = [y - (references[band] - exponent * x) for band, x, y in rows]
    spread = statistics.pstdev(residuals) if len(residuals) > 1 else 0.0
    sigma = 0
    if spread > 0.75:
        sigma = round(math.sqrt(max(0.0, spread ** 2 - 1 / 12)), 1)
        notes.append(f"Link residuals suggest seeded shadowing (σ≈{sigma} dB); the exact seed cannot be "
                     "recovered, so reconstructed links will differ by the shadowing term.")
    propagation = {
        "reference_distance_m": 1,
        "reference_snr_db_by_band": references,
        "path_loss_exponent": exponent,
        "shadowing_stddev_db": sigma,
        "minimum_snr_db": minimum,
        "maximum_snr_db": maximum,
    }
    # Per-source transmit adjustment from station-sourced links.
    gains: dict[str, dict[str, float]] = {}
    for band in BANDS:
        per_role: dict[str, list[float]] = {}
        for link, value in samples[band]:
            if not minimum < value < maximum:
                continue
            x = 10 * math.log10(max(link["distance_m"], 1.0))
            expected = references[band] - exponent * x - link["wall_loss_db"]
            per_role.setdefault(link["source_role"], []).append(value - expected)
        for role, values in per_role.items():
            mean = statistics.fmean(values)
            if abs(mean) >= 0.75:
                gains.setdefault(role, {})[band] = round(mean)
    for role, by_band in gains.items():
        for band in BANDS:
            by_band.setdefault(band, 0)
    return propagation, gains, notes


def _snap_propagation(rows, exponent_fit: float, reference_fit: dict) -> tuple[float, dict]:
    """Pick the nearby exponent/reference values that reproduce the most links.

    The least-squares fit is biased by integer SNR rounding; authored rooms
    use round values (2.2, 2.8, 54 dB), so test a small neighbourhood and
    keep the combination with the most exact integer matches.
    """
    subset = rows if len(rows) <= 6000 else rows[:: len(rows) // 6000 + 1]
    exponents = sorted({round(exponent_fit + step * 0.01, 2) for step in range(-15, 16)}
                       | {round(round(exponent_fit * 20) / 20 + step * 0.05, 2) for step in (-1, 0, 1)})
    exponents = [value for value in exponents if value > 0]
    best = None
    for exponent in exponents:
        references, matches = {}, 0
        for band in BANDS:
            band_rows = [(x, y) for b, x, y in subset if b == band]
            centre = round(reference_fit[band])
            choice = max(
                (centre + delta for delta in (-2, -1, 0, 1, 2)),
                key=lambda value: (sum(round(value - exponent * x) == y for x, y in band_rows),
                                   -abs(value - reference_fit[band])))
            references[band] = choice
            matches += sum(round(choice - exponent * x) == y for x, y in band_rows)
        roundness = 0 if abs(exponent * 20 - round(exponent * 20)) < 1e-9 else 1
        key = (matches, -roundness, -abs(exponent - exponent_fit))
        if best is None or key > best[0]:
            best = (key, exponent, references)
    return best[1], best[2]


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    size = len(vector)
    augmented = [row[:] + [value] for row, value in zip(matrix, vector)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda r: abs(augmented[r][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            return None
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        for row in range(size):
            if row != column:
                factor = augmented[row][column] / augmented[column][column]
                for k in range(column, size + 1):
                    augmented[row][k] -= factor * augmented[column][k]
    return [augmented[i][size] / augmented[i][i] for i in range(size)]


def design_from_world(plan: dict, known_layouts: dict, known_mobilities: dict) -> tuple[dict, list[str]]:
    """Rebuild an editable design from a compiled ``.world.json``.

    When the plan's layout/mobility are known (library or lab tree) and their
    hashes match, the sources are used verbatim and the result is exact.
    Otherwise geometry, paths, presence, propagation and transmit gains are
    reconstructed from the generations and checked by recompiling.
    """
    notes: list[str] = []
    try:
        verify_world_plan(plan)
    except ScenarioError as error:
        notes.append(f"Warning: {error}; importing the geometry anyway.")
    layout = known_layouts.get(plan.get("layout"))
    mobility = known_mobilities.get(plan.get("mobility"))
    layout_exact = layout is not None and canonical_hash(layout) == plan.get("layout_sha256")
    mobility_exact = mobility is not None and canonical_hash(mobility) == plan.get("mobility_sha256")
    if layout_exact and mobility_exact:
        design = design_from_layout_mobility(layout, mobility, design_id=slugify(plan["name"]))
        notes.append("Matched the world's layout and mobility sources by hash: exact import.")
        return design, notes

    generations = plan.get("generations") or []
    if not generations:
        raise ScenarioError("world plan has no generations")
    roles = plan["roles"]
    times = [g["time_ms"] for g in generations]
    duration = int(plan["duration_ms"])
    wired = set(plan.get("wired_backhaul", []))
    walls = copy.deepcopy(plan.get("walls", []))
    if layout_exact:
        propagation = copy.deepcopy(layout["propagation"])
        gains: dict = {}
        space = copy.deepcopy(layout["space"])
        notes.append(f"Layout '{plan['layout']}' matched by hash; reconstructing the scenario only.")
    else:
        propagation, gains, fit_notes = _fit_propagation(plan)
        notes.extend(fit_notes)
        max_x = max([p[0] for g in generations for p in g["positions"].values()] +
                    [end[0] for wall in walls for end in (wall["start"], wall["end"])] + [1])
        max_y = max([p[1] for g in generations for p in g["positions"].values()] +
                    [end[1] for wall in walls for end in (wall["start"], wall["end"])] + [1])
        wall_x = max([end[0] for wall in walls for end in (wall["start"], wall["end"])] + [0])
        wall_y = max([end[1] for wall in walls for end in (wall["start"], wall["end"])] + [0])
        space = {"width_m": max(wall_x, math.ceil(max_x + 1)) if max_x > wall_x else wall_x or 1,
                 "height_m": max(wall_y, math.ceil(max_y + 1)) if max_y > wall_y else wall_y or 1}
        notes.append(
            f"World plans do not record the room size; inferred {space['width_m']}×{space['height_m']} m "
            "from walls and positions.")
        notes.append(
            "Propagation fitted from links: reference SNR "
            + "/".join(str(propagation["reference_snr_db_by_band"][b]) for b in BANDS)
            + f" dB, exponent {propagation['path_loss_exponent']}.")

    layout_nodes, mobility_nodes = [], []
    for role in sorted(roles):
        kind = roles[role]
        positions = [g["positions"][role] for g in generations]
        present = [bool(g["present"][role]) for g in generations]
        moving = any(p != positions[0] for p in positions)
        always = all(present)
        node_gain = gains.get(role)
        if not moving and always:
            node = {"role": role, "kind": kind, "position": list(positions[0])}
            if role in wired:
                node["backhaul"] = "wired"
            if node_gain:
                node["tx_gain_db_by_band"] = node_gain
            layout_nodes.append(node)
            continue
        entry: dict[str, Any] = {"role": role}
        if kind == "fronthaul_ap":
            base = {"role": role, "kind": kind, "position": list(positions[0])}
            if role in wired:
                base["backhaul"] = "wired"
            layout_nodes.append(base)
            entry["kind"] = kind
        if node_gain:
            entry["tx_gain_db_by_band"] = node_gain
        if moving:
            entry["path"] = _compress_path(times, positions)
        else:
            entry["position"] = list(positions[0])
        if not always:
            entry["presence"] = _intervals(times, present, duration)
        mobility_nodes.append(entry)

    rebuilt_layout = layout if layout_exact else {
        "schema": LAYOUT_SCHEMA,
        "name": plan.get("layout") or "imported-layout",
        "tags": list(plan.get("tags", [])),
        "space": space,
        "propagation": propagation,
        "walls": walls,
        "nodes": layout_nodes,
    }
    if layout_exact:
        layout_roles = {node["role"] for node in layout.get("nodes", [])}
        mobility_nodes = [node for node in mobility_nodes if node["role"] not in layout_roles
                          or "path" in node or "presence" in node or "tx_gain_db_by_band" in node]
    rebuilt_mobility: dict[str, Any] = {
        "schema": MOBILITY_SCHEMA,
        "name": plan.get("mobility") or "imported-scenario",
        "tags": [],
        "duration_ms": duration,
        "tick_ms": int(plan["tick_ms"]),
        "seed": 0,
        "nodes": mobility_nodes,
    }
    for key in ("pause_at_ms", "backhaul_rf", "band_steering", "band_steering_expectations",
                "traffic_experiment", "ap_expectations"):
        if key in plan:
            rebuilt_mobility[key] = copy.deepcopy(plan[key])
    design = design_from_layout_mobility(rebuilt_layout, rebuilt_mobility, design_id=slugify(plan["name"]))
    design["source"] = {"kind": "world-plan", "name": plan.get("name"),
                        "golden_sha256": plan.get("golden_sha256")}
    notes.extend(_agreement_notes(plan, design))
    return design, notes


def _agreement_notes(plan: dict, design: dict) -> list[str]:
    try:
        rebuilt = compile_design(design)
    except ScenarioError as error:
        return [f"Reconstructed design does not compile yet: {error}"]
    total = same = 0
    positions_same = presence_same = True
    for original, new in zip(plan["generations"], rebuilt["generations"]):
        positions_same &= original["positions"] == new["positions"]
        presence_same &= original["present"] == new["present"]
        new_links = {(l["source_role"], l["destination_role"]): l for l in new["links"]}
        for link in original["links"]:
            other = new_links.get((link["source_role"], link["destination_role"]))
            for band in BANDS:
                total += 1
                same += bool(other) and other["snr_db_by_band"][band] == link["snr_db_by_band"][band]
    ratio = same / total * 100 if total else 100.0
    notes = [f"Recompiled check: {ratio:.2f}% of {total} directed link values reproduce exactly; "
             f"positions {'match' if positions_same else 'differ'}; presence {'matches' if presence_same else 'differs'}."]
    if rebuilt["golden_sha256"] == plan.get("golden_sha256"):
        notes.append("The rebuilt design reproduces the original golden_sha256.")
    else:
        notes.append("golden_sha256 differs from the original because the source documents were "
                     "reconstructed; the RF sequence is what the check above compares.")
    return notes


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def pretty_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def build_goldens_line(design: dict) -> str:
    return (f"emit {design['layout']['name']}.json {design['mobility']['name']}.json "
            f"{world_id(design)}.world.json")


def room_guide_entry(design: dict) -> str | None:
    guide = (design.get("builder") or {}).get("guide")
    if not guide:
        return None
    mobility = design["mobility"]
    stations = compile_design(design)["counts"]["stations"]
    entry = {
        "title": guide.get("title") or design.get("title"),
        "seconds": mobility["duration_ms"] // 1000,
        "clients": stations,
        "pauses": [value // 1000 for value in mobility.get("pause_at_ms", [])],
        **({"backhaul": "geometry"} if mobility.get("backhaul_rf") == "geometry" else {}),
        **{key: guide.get(key, "") for key in ("rf", "optimizer", "watch", "limits")},
    }
    return f"    '{world_id(design)}': " + json.dumps(entry, indent=6, ensure_ascii=False) + ","


def export_bundle(design: dict, verification: dict | None = None) -> bytes:
    """A zip laid out like the configurator tree, ready to copy into the lab."""
    plan = compile_design(design)
    wid = world_id(design)
    layout_name = design["layout"]["name"]
    mobility_name = design["mobility"]["name"]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        root = f"{wid}/"
        archive.writestr(root + "design.json", pretty_json(design))
        archive.writestr(root + f"worlds/layouts/{layout_name}.json", pretty_json(design["layout"]))
        archive.writestr(root + f"worlds/mobility/{mobility_name}.json", pretty_json(design["mobility"]))
        archive.writestr(root + f"worlds/golden/{wid}.world.json", golden_json(plan))
        for band in (*BANDS, "all"):
            archive.writestr(root + f"scenarios/{wid}-{band.replace('.', '_')}.wmd", export_wmd(plan, band))
        archive.writestr(root + "build-goldens.emit", build_goldens_line(design) + "\n")
        guide = room_guide_entry(design)
        if guide:
            archive.writestr(root + "room-guide-entry.js", guide + "\n")
        if verification is not None:
            archive.writestr(root + "verification.json", pretty_json(verification))
        archive.writestr(root + "README.md", _bundle_readme(design, plan))
    return buffer.getvalue()


def _bundle_readme(design: dict, plan: dict) -> str:
    wid = world_id(design)
    return f"""# {design.get('title', wid)}

Exported by the EasyMesh room builder ({design.get('generator', 'roombuilder')}).

{design.get('description', '').strip()}

| | |
| --- | --- |
| World ID | `{wid}` |
| Layout | `{design['layout']['name']}` ({design['layout']['space']['width_m']} × {design['layout']['space']['height_m']} m, {len(design['layout'].get('walls', []))} walls) |
| Mobility | `{design['mobility']['name']}` ({plan['duration_ms'] / 1000:g} s, tick {plan['tick_ms']} ms) |
| Agents / stations | {plan['counts']['agents']} / {plan['counts']['stations']} |
| golden_sha256 | `{plan['golden_sha256']}` |

## Install into the configurator tree

The labs' rooms live in easymesh-medium (`configurator/worlds`); the labs take them at
the medium commit they pin.

```sh
cp worlds/layouts/{design['layout']['name']}.json   <easymesh-medium>/configurator/worlds/layouts/
cp worlds/mobility/{design['mobility']['name']}.json <easymesh-medium>/configurator/worlds/mobility/
cp worlds/golden/{wid}.world.json   <easymesh-medium>/configurator/worlds/golden/
# add this line to worlds/build-goldens.sh, then run it with --check:
{build_goldens_line(design)}
```

`scenarios/*.wmd` are the `world-export` projections (2.4, 5, 6 GHz and all
bands); they validate with `python3 -m wmdcfg.cli validate`.
"""
