"""Live-lab profiles: which rooms a running EasyMesh lab can actually load.

The offline configurator accepts any roles. The live room server
(``gen/demo/room_demo/worlds.py`` ``BoundWorlds.select``) additionally binds
every role to an existing container and refuses worlds that do not fit the
provisioned lab. These profiles reproduce those checks so a design can be
tested against the lab it is meant for before it is installed.
"""

from __future__ import annotations

import math
import re

from .model import ScenarioError

CLIENT_CAPACITY = 100
NAMED_STATIONS = [f"sta_static_{i:02d}" for i in range(1, 11)] + [
    f"sta_mobile_{i:02d}" for i in range(1, 11)]
POOL_STATIONS = [f"sta_pool_{i:03d}" for i in range(21, CLIENT_CAPACITY + 1)]
NATIVE_MESH = ["gateway", "extender_1", "extender_2", "extender_3", "extender_4"]

PROFILES = {
    "configurator": {
        "label": "Configurator only (any roles)",
        "tip": "Checks only what wmdcfg world-compile, verify and world-export accept. "
               "Use it for offline RF studies with any number of agents and clients.",
        "mesh": None,
        "wired": [],
        "pods": [],
    },
    "rdk-lab": {
        "label": "RDK lab · 5 native agents",
        "tip": "The default Banana Pi RDK-B lab: gateway (Agent-1) plus extender_1..4, "
               "20 named clients and the optional 100-client pool.",
        "mesh": NATIVE_MESH,
        "wired": [],
        "pods": [],
    },
    "rdk-lab-wired": {
        "label": "RDK lab + wired extender_5",
        "tip": "Adds bpiap-004 as extender_5 on a wired backhaul (worlds-wired). "
               "extender_5 must carry backhaul: wired.",
        "mesh": NATIVE_MESH + ["extender_5"],
        "wired": ["extender_5"],
        "pods": [],
    },
    "rdk-lab-pods": {
        "label": "RDK lab + 2 OpenSync pods",
        "tip": "Adds pod_1 and pod_2 (EMOSA adapter, worlds-pods). Pods serve 2.4 GHz only; "
               "their 5/6 GHz links are skipped by the compiler's binding step.",
        "mesh": NATIVE_MESH + ["pod_1", "pod_2"],
        "wired": [],
        "pods": ["pod_1", "pod_2"],
    },
    "rdk-lab-pods-wired": {
        "label": "RDK lab + pods + wired extender_5",
        "tip": "Both variants together (worlds-pods-wired).",
        "mesh": NATIVE_MESH + ["pod_1", "pod_2", "extender_5"],
        "wired": ["extender_5"],
        "pods": ["pod_1", "pod_2"],
    },
}
DEFAULT_PROFILE = "rdk-lab"
NAME_PATTERN = r"[a-zA-Z0-9_-]{1,100}"


def profile_catalog() -> dict:
    return {
        "default": DEFAULT_PROFILE,
        "client_capacity": CLIENT_CAPACITY,
        "named_stations": NAMED_STATIONS,
        "pool_range": [POOL_STATIONS[0], POOL_STATIONS[-1]],
        "profiles": [
            {"id": key, **{k: v for k, v in value.items()}} for key, value in PROFILES.items()
        ],
    }


def bound_station(role: str) -> bool:
    return role in NAMED_STATIONS or role in POOL_STATIONS


def lab_findings(plan: dict, layout: dict, mobility: dict, profile_id: str) -> list[dict]:
    """Live-room admission problems for a compiled world under a lab profile.

    Each finding is ``{"level": "error"|"warning"|"info", "code", "message", "role"?}``.
    Errors are conditions ``BoundWorlds.select`` (or the client pool) rejects.
    """
    profile = PROFILES.get(profile_id)
    if profile is None:
        return [{"level": "error", "code": "lab.profile", "message": f"unknown lab profile {profile_id!r}"}]
    findings: list[dict] = []

    def add(level, code, message, role=None):
        item = {"level": level, "code": code, "message": message}
        if role:
            item["role"] = role
        findings.append(item)

    name = plan.get("name", "")
    if not 1 <= len(name) <= 200:
        add("error", "lab.world-name", "the live room requires a world name of 1..200 characters")
    for key, label in (("layout", "layout"), ("mobility", "mobility")):
        value = plan.get(key)
        if not isinstance(value, str) or not re.fullmatch(NAME_PATTERN, value):
            add("error", f"lab.{key}-name",
                f"the live room resolves the {label} by file name; use 1..100 of [a-zA-Z0-9_-]")
    if plan.get("bands") != ["2.4", "5", "6"]:
        add("error", "lab.bands", "world must retain the existing 2.4/5/6 GHz bands")
    roles = plan.get("roles", {})
    first = plan["generations"][0]
    if first["time_ms"] != 0:
        add("error", "lab.start", "world must start at time zero")
    if not any(kind == "station" for kind in roles.values()):
        add("error", "lab.clients", "world requires at least one bound client")
    if not any(first["present"][role] for role, kind in roles.items() if kind == "station"):
        add("error", "lab.clients-online", "world requires at least one initially online client")
    if not 100 <= plan.get("tick_ms", 0) <= 60000:
        add("error", "lab.tick", "world tick must be 100..60000 milliseconds")
    for role, position in first["positions"].items():
        for value, maximum in zip(position, (layout["space"]["width_m"], layout["space"]["height_m"])):
            if not math.isfinite(value) or not 0 <= value <= maximum:
                add("error", "lab.position", f"role {role!r} position is outside the room", role)

    if profile["mesh"] is None:
        return findings

    mesh = {role for role, kind in roles.items() if kind == "fronthaul_ap"}
    expected = set(profile["mesh"])
    for role in sorted(expected - mesh):
        add("error", "lab.mesh-missing",
            f"world must retain every existing mesh role; {role} is missing", role)
    for role in sorted(mesh - expected):
        add("error", "lab.mesh-unbound",
            f"role {role!r} is not bound with kind 'fronthaul_ap' in this lab", role)
    if first["present"].get("gateway") is not True:
        add("error", "lab.gateway", "Agent-1/gateway must remain present")
    wired = set(plan.get("wired_backhaul", []))
    for role in sorted(set(profile["wired"]) & mesh - wired):
        add("error", "lab.wired", f"{role} is the lab's wired extender; set backhaul: wired", role)
    for role in sorted(wired - set(profile["wired"])):
        add("error", "lab.wired-unbound",
            f"{role} is marked wired but this lab's {role} has a Wi-Fi backhaul", role)
    for role in profile["pods"]:
        if role in mesh:
            add("info", "lab.pod-band",
                f"{role} is an OpenSync pod: it serves 2.4 GHz only; its 5/6 GHz links are skipped at binding",
                role)

    stations = sorted(role for role, kind in roles.items() if kind == "station")
    for role in stations:
        if not bound_station(role):
            add("error", "lab.station-unbound",
                f"role {role!r} is not bound with kind 'station' in this lab "
                "(use sta_static_01..10, sta_mobile_01..10 or sta_pool_021..100)", role)
    for role in stations:
        if role in {*NATIVE_MESH, "pod_1", "pod_2", "extender_5"}:
            add("error", "lab.kind", f"role {role!r} is a mesh device in this lab", role)
    count = len(stations)
    if count > CLIENT_CAPACITY:
        add("error", "lab.capacity",
            f"world exceeds the provisioned client pool: {count} clients > {CLIENT_CAPACITY}")
    pool_roles = [role for role in stations if role in POOL_STATIONS]
    if pool_roles:
        add("info", "lab.pool",
            f"{len(pool_roles)} pool clients: load this room on a lab provisioned with the 100-client pool")
        if count % 2:
            add("warning", "lab.cohorts",
                "the client pool requires balanced private/IoT cohorts: use an even number of clients")
    return findings


def next_role(existing: set[str], kind: str, mobile: bool = False, profile_id: str = DEFAULT_PROFILE) -> str:
    """Suggest the next free role name for a new device under a profile."""
    profile = PROFILES.get(profile_id) or PROFILES["configurator"]
    if kind == "fronthaul_ap":
        if "gateway" not in existing:
            return "gateway"
        index = 1
        while f"extender_{index}" in existing:
            index += 1
        return f"extender_{index}"
    prefix = "sta_mobile_" if mobile else "sta_static_"
    for index in range(1, 11):
        role = f"{prefix}{index:02d}"
        if role not in existing:
            return role
    if profile["mesh"] is not None:
        for role in POOL_STATIONS:
            if role not in existing:
                return role
        raise ScenarioError("the lab's 100-client pool is exhausted")
    index = 11
    while True:
        role = f"{prefix}{index:02d}" if index < 100 else f"{prefix}{index}"
        if role not in existing:
            return role
        index += 1
