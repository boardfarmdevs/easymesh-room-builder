"""Room verification suite.

Runs a design through every function a Golden World passes on its way into
the lab and reports each as a named check:

* the configurator's layout/mobility validation, compile, golden hash
  verification and ``.wmd`` export for every band (parsed and validated back);
* determinism, numeric normalisation and design round-trip;
* the live room's admission rules for the selected lab profile;
* band-steering, expectation and traffic metadata rules;
* RF sanity (coverage holes, backhaul), advisory only;
* optionally, byte-for-byte parity with a reference ``wmdcfg`` checkout.

``status`` is ``pass``, ``fail``, ``warn`` (advisory) or ``skip``.
"""

from __future__ import annotations

import copy
import importlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .bands import validate_expectations, validate_profiles
from .design import compile_design, design_from_layout_mobility, world_id
from .geometry import BANDS
from .lab import lab_findings
from .lint import lint
from .model import ScenarioError
from .traffic import validate_traffic
from .wmd import parse, validate_scenario
from .world import (
    canonical_hash, compile_world, export_wmd, golden_json, validate_ap_expectations, validate_layout,
    validate_mobility, verify_world_plan,
)

REFERENCE_ENV = "ROOMBUILDER_REFERENCE"


class Suite:
    def __init__(self):
        self.checks: list[dict] = []

    def run(self, check_id: str, title: str, function: Callable[[], Any], *, advisory: bool = False) -> Any:
        started = time.monotonic()
        entry = {"id": check_id, "title": title}
        try:
            result = function()
            if isinstance(result, tuple) and result and result[0] in ("warn", "skip", "pass"):
                entry["status"], entry["detail"] = result[0], result[1]
                result = result[2] if len(result) > 2 else None
            else:
                entry["status"] = "pass"
                entry["detail"] = result if isinstance(result, str) else ""
        except (ScenarioError, AssertionError, ValueError, KeyError, TypeError) as error:
            entry["status"] = "warn" if advisory else "fail"
            entry["detail"] = str(error) or error.__class__.__name__
            result = None
        entry["ms"] = round((time.monotonic() - started) * 1000, 1)
        self.checks.append(entry)
        return result


def load_reference(path: str | None = None):
    """Import ``wmdcfg`` from a reference configurator directory, if given."""
    path = path or os.environ.get(REFERENCE_ENV)
    if not path:
        return None
    root = Path(path)
    if (root / "gen/wmediumd/configurator/wmdcfg").is_dir():
        root = root / "gen/wmediumd/configurator"
    if not (root / "wmdcfg" / "world.py").is_file():
        raise ScenarioError(f"{path} is not a wmdcfg configurator directory")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    world = importlib.import_module("wmdcfg.world")
    parser = importlib.import_module("wmdcfg.parser")
    compiler = importlib.import_module("wmdcfg.compiler")
    return {"root": str(root), "world": world, "parser": parser, "compiler": compiler}


def verify_design(design: dict, *, reference: str | None = None, band: str = "5") -> dict:
    suite = Suite()
    layout, mobility = design["layout"], design["mobility"]

    suite.run("configurator.layout", "Layout is a valid wmdcfg.world-layout.v1",
              lambda: validate_layout(layout) or f"{layout['space']['width_m']}×{layout['space']['height_m']} m, "
                                                 f"{len(layout.get('walls', []))} walls, {len(layout.get('nodes', []))} nodes")
    suite.run("configurator.mobility", "Mobility is a valid wmdcfg.mobility.v1",
              lambda: validate_mobility(mobility) or f"{mobility['duration_ms'] / 1000:g} s at "
                                                     f"{mobility['tick_ms']} ms ticks, {len(mobility.get('nodes', []))} nodes")
    plan = suite.run("configurator.compile", "world-compile produces a world plan", lambda: _compiled(layout, mobility))
    if plan is None:
        for check_id, title in (("configurator.verify", "Golden hash verifies"),):
            suite.checks.append({"id": check_id, "title": title, "status": "skip",
                                 "detail": "the world does not compile", "ms": 0})
        return _report(design, suite, None)

    suite.run("configurator.verify", "verify_world_plan accepts the golden hash",
              lambda: verify_world_plan(plan) or plan["golden_sha256"])
    suite.run("configurator.deterministic", "Compiling twice gives an identical plan",
              lambda: _assert(compile_world(copy.deepcopy(layout), copy.deepcopy(mobility)) == plan,
                              "second compile differs") or "identical")
    suite.run("configurator.number-normalisation", "An int/float rewrite keeps the golden hash",
              lambda: verify_world_plan(json.loads(json.dumps(plan).replace(".0,", ","))) or "stable")
    suite.run("configurator.links", "Every generation has every directed AP/client and mesh-peer link",
              lambda: _check_links(plan))
    suite.run("configurator.bounds", "Every role stays inside the room at every tick",
              lambda: _check_bounds(plan, layout))
    for export_band in (*BANDS, "all"):
        suite.run(f"wmd.{export_band}", f"world-export --band {export_band} parses and validates",
                  lambda b=export_band: _check_wmd(plan, b))
    suite.run("scenario.traffic", "Traffic experiment meets the room bounds",
              lambda: ("skip", "no traffic experiment") if plan.get("traffic_experiment") is None
              else f"{len(validate_traffic(plan)['phases'])} phases valid")
    suite.run("scenario.band-steering", "Band-steering profiles are admissible",
              lambda: _optional(plan, "band_steering", lambda: validate_profiles(plan)))
    suite.run("scenario.expectations", "Band/AP expectations reference real roles",
              lambda: _optional(plan, "band_steering_expectations", lambda: validate_expectations(plan)))
    suite.run("scenario.ap-expectations", "AP expectations are at 'final' or a checkpoint and name a client on an AP",
              lambda: _optional(plan, "ap_expectations", lambda: validate_ap_expectations(plan)))
    suite.run("design.roundtrip", "Design → layout/mobility → design is lossless",
              lambda: _check_roundtrip(design))
    profile = design.get("profile", "configurator")
    suite.run(f"lab.{profile}", f"Live room admits the world ({profile})",
              lambda: _check_lab(plan, layout, mobility, profile))
    findings = lint(design, band=band, compiled=plan)["findings"]
    geometry = [f for f in findings if f["code"].startswith("geometry.") and f["level"] == "warning"]
    suite.run("rf.wall-geometry", "No device stands on or walks along a wall line",
              lambda: ("warn", "; ".join(f["message"] for f in geometry[:6])) if geometry else "clear",
              advisory=True)
    rf = [f for f in findings if f["code"].startswith("rf.")]
    suite.run("rf.coverage", f"Clients and extenders have usable {band} GHz links",
              lambda: ("warn", "; ".join(f["message"] for f in rf[:6])) if rf else "no holes, backhaul ≥ 20 dB",
              advisory=True)
    source = design.get("source") or {}
    if source.get("golden_sha256") and source.get("kind") == "reference":
        suite.run("reference.golden", "Reproduces the reference golden_sha256", lambda: _check_reference_golden(design, plan))
    ref = None
    try:
        ref = load_reference(reference)
    except (ScenarioError, ImportError) as error:
        suite.checks.append({"id": "reference.load", "title": "Load reference wmdcfg", "status": "fail",
                             "detail": str(error), "ms": 0})
    if ref is not None:
        suite.run("reference.compile", "Reference wmdcfg compiles the same bytes",
                  lambda: _check_reference_compile(ref, layout, mobility, plan))
        suite.run("reference.export", "Reference world-export emits the same .wmd for every band",
                  lambda: _check_reference_export(ref, plan))
    return _report(design, suite, plan)


def _check_reference_golden(design: dict, plan: dict):
    source = design["source"]
    edited = [name for name, key in (("layout", "layout_sha256"), ("mobility", "mobility_sha256"))
              if source.get(key) and canonical_hash(design[name]) != source[key]]
    if edited:
        return ("skip", f"{' and '.join(edited)} edited since it was copied from the reference room")
    _assert(plan["golden_sha256"] == source["golden_sha256"], f"{plan['golden_sha256']} != {source['golden_sha256']}")
    return source["golden_sha256"]


def _compiled(layout, mobility):
    plan = compile_world(layout, mobility)
    return ("pass", f"{len(plan['generations'])} generations · {plan['counts']['agents']} agents · "
                    f"{plan['counts']['stations']} stations · {len(plan['generations'][0]['links'])} links/tick", plan)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _optional(plan, key, function):
    if key not in plan:
        return ("skip", f"no {key}")
    function()
    return f"{len(plan[key])} entries valid"


def _check_links(plan: dict) -> str:
    roles = plan["roles"]
    # Every directed AP/client and AP/AP pair, wired APs included (room_demo/worlds.py, upstream a796f3a).
    expected = {
        (source, destination) for source in roles for destination in roles
        if source != destination and "fronthaul_ap" in (roles[source], roles[destination])
    }
    for generation in plan["generations"]:
        pairs = [(link["source_role"], link["destination_role"]) for link in generation["links"]]
        _assert(len(pairs) == len(set(pairs)), f"duplicate link at {generation['time_ms']} ms")
        _assert(set(pairs) == expected, f"missing or unknown links at {generation['time_ms']} ms")
        for link in generation["links"]:
            expected_class = "backhaul" if all(roles[r] == "fronthaul_ap" for r in (link["source_role"], link["destination_role"])) else "fronthaul"
            _assert(link["link_class"] == expected_class, "wrong link class")
            _assert(set(link["snr_db_by_band"]) == set(BANDS), "missing band")
            for value in link["snr_db_by_band"].values():
                _assert(-20 <= value <= 60, f"SNR {value} outside [-20, 60]")
            _assert(link["distance_m"] >= 0 and link["wall_loss_db"] >= 0, "negative distance or loss")
    return f"{len(expected)} directed links × {len(plan['generations'])} generations"


def _check_bounds(plan: dict, layout: dict) -> str:
    width, height = layout["space"]["width_m"], layout["space"]["height_m"]
    for generation in plan["generations"]:
        for role, (x, y) in generation["positions"].items():
            _assert(0 <= x <= width and 0 <= y <= height, f"{role} outside at {generation['time_ms']} ms")
    return f"inside {width}×{height} m"


def _check_wmd(plan: dict, band: str) -> str:
    text = export_wmd(plan, band)
    scenario = parse(text)
    validate_scenario(scenario)
    return f"{len(scenario.phases)} phases, {len(text.splitlines())} lines"


def _check_roundtrip(design: dict) -> str:
    # Equal source hashes imply an equal golden hash (compile is deterministic, checked above).
    rebuilt = design_from_layout_mobility(design["layout"], design["mobility"])
    _assert(canonical_hash(rebuilt["layout"]) == canonical_hash(design["layout"]), "layout changed")
    _assert(canonical_hash(rebuilt["mobility"]) == canonical_hash(design["mobility"]), "mobility changed")
    return "layout and mobility hashes unchanged"


def _check_lab(plan, layout, mobility, profile) -> Any:
    items = lab_findings(plan, layout, mobility, profile)
    errors = [item["message"] for item in items if item["level"] == "error"]
    if errors:
        raise AssertionError("; ".join(errors[:6]) + (f" (+{len(errors) - 6} more)" if len(errors) > 6 else ""))
    warnings = [item["message"] for item in items if item["level"] == "warning"]
    if warnings:
        return ("warn", "; ".join(warnings))
    if profile == "configurator":
        return "offline profile: no lab binding required"
    return "all roles bind; gateway present; clients online"


def _check_reference_compile(ref, layout, mobility, plan) -> str:
    theirs = ref["world"].compile_world(copy.deepcopy(layout), copy.deepcopy(mobility))
    _assert(golden_json(theirs) == golden_json(plan), "reference compile differs from room builder compile")
    return f"byte-identical ({ref['root']})"


def _check_reference_export(ref, plan) -> str:
    for band in (*BANDS, "all"):
        theirs = ref["world"].export_wmd(plan, band)
        _assert(theirs == export_wmd(plan, band), f"band {band} export differs")
        ref["compiler"].validate_scenario(ref["parser"].parse(theirs))
    return "identical for 2.4, 5, 6 and all"


def _report(design: dict, suite: Suite, plan: dict | None) -> dict:
    counts = {status: sum(check["status"] == status for check in suite.checks)
              for status in ("pass", "fail", "warn", "skip")}
    return {
        "schema": "roombuilder.verification.v1",
        "generator": f"roombuilder {__version__}",
        "design": world_id(design),
        "profile": design.get("profile"),
        "golden_sha256": plan["golden_sha256"] if plan else None,
        "passed": counts["fail"] == 0,
        "counts": counts,
        "checks": suite.checks,
    }


def format_report(report: dict) -> str:
    marks = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "skip": "SKIP"}
    lines = [f"{report['design']}  [{report.get('profile')}]"]
    for check in report["checks"]:
        detail = f" — {check['detail']}" if check.get("detail") else ""
        lines.append(f"  {marks[check['status']]}  {check['id']:<28} {check['title']}{detail}")
    c = report["counts"]
    lines.append(f"  => {'PASSED' if report['passed'] else 'FAILED'}: {c['pass']} pass, {c['fail']} fail, "
                 f"{c['warn']} warn, {c['skip']} skip")
    return "\n".join(lines)
