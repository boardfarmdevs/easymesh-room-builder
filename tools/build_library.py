#!/usr/bin/env python3
"""Regenerate the example room library in roombuilder/library.

    python3 tools/build_library.py --reference /path/to/easymesh-medium

* ``reference`` rooms: every Golden World of the reference configurator, with
  layout and mobility copied verbatim, the expected golden_sha256 and the
  viewer's room-guide text. ``--reference`` is required to refresh them;
  without it the existing reference rooms are kept.
* authored rooms: defined below; extenders are placed by the room builder's
  own optimiser, so the positions are reproducible.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from roombuilder.design import LAB_PROPAGATION, PROPAGATION_PRESETS, design_from_layout_mobility, pretty_json  # noqa: E402
from roombuilder.materials import BY_ID  # noqa: E402
from roombuilder.placement import apply_placement, place_extenders  # noqa: E402
from roombuilder.verify import verify_design  # noqa: E402
from roombuilder.world import compile_world, load_json  # noqa: E402

LIBRARY = ROOT / "roombuilder" / "library"
REFERENCE_ORDER = [
    'home-a-private-client-room-walk', 'home-a-one-client-handover', 'home-a-stationary',
    'home-a-slow-walk-ten', 'home-b-slow-walk-ten', 'home-a-border-hover', 'home-a-fast-transit',
    'home-a-disappear-reappear', 'home-a-extender-loss-recovery', 'home-a-flash-crowd',
    'home-a-asymmetric-link', 'home-a-band-walk-small', 'large-room-perimeter-counter-roam',
    'large-room-extender-evacuation', 'fifty-client-counter-roam',
    'band-upgrade-24-5', 'band-upgrade-5-6', 'band-ap-counter-roam', 'traffic-low-high-off',
    'traffic-quieter-ap', 'rf-packet-size-counters', 'rf-asymmetric-ack', 'received-same-band-roam',
    'received-discovery-recovery', 'backhaul-branch-formation', 'backhaul-parent-handover',
    'backhaul-isolation-recovery',
]
# Rooms about the lab's wired extender (upstream worlds-wired/build-goldens.py WIRED_ROOMS):
# (native layout, mobility, world id). Their layout is worlds-wired/layouts/<layout>-wired.json.
WIRED_ROOMS = [
    ("home-five-agent", "wired-walk-in", "home-a-wired-walk-in"),
    ("home-five-agent", "wired-walk-out", "home-a-wired-walk-out"),
    ("home-five-agent", "wired-extender-loss-recovery", "home-a-wired-extender-loss-recovery"),
    ("backhaul-branches", "backhaul-wired-parent", "backhaul-wired-parent"),
]
WIRED_GUIDES = {
    "home-a-wired-walk-in": {
        "title": "Home A · Walk-in to the Wired Extender",
        "rf": "Home A plus extender_5, the lab's extender on a wired backhaul (bpiap-004), at (20, 7). "
              "sta_mobile_01 walks from (3, 3) to beside it during 2–18 s and stays.",
        "optimizer": "Steer the walker onto extender_5 once it is clearly the strongest AP. "
                     "ap_expectations: final → extender_5.",
        "watch": "Native BSSID of sta_mobile_01 at the end, and the controller topology showing extender_5 "
                 "on its LAN port.",
        "limits": "The wired backhaul is a LAN port, not RF; the room models extender_5's fronthaul like any AP's.",
    },
    "home-a-wired-walk-out": {
        "title": "Home A · Walk-out from the Wired Extender",
        "rf": "The walker starts beside extender_5 and walks to the north-west (3, 12) during 4–20 s. "
              "Checkpoint at 3 s.",
        "optimizer": "At 3 s the client is on extender_5; at the final settle it should be on extender_3.",
        "watch": "Serving AP at the 3 s checkpoint and after the walk.",
        "limits": "Expectations state the intended APs; native steering decides.",
    },
    "home-a-wired-extender-loss-recovery": {
        "title": "Home A · Wired Extender Loss / Recovery",
        "rf": "extender_5's fronthaul is unavailable during 20–60 s while three clients stay beside it; "
              "its LAN backhaul and container stay up.",
        "optimizer": "Its clients must leave during the outage and may return after recovery. "
                     "ap_expectations: final → extender_5 for all three.",
        "watch": "Client moves at 20 s and 60 s; final ownership on extender_5.",
        "limits": "Models RF visibility loss, not a LAN or hostapd failure.",
    },
    "backhaul-wired-parent": {
        "title": "Backhaul · Wired Extender as Parent",
        "rf": "Geometry backhaul in the branches courtyard with extender_5 wired at (60, 18), east of the 70 dB "
              "isolation wall. extender_3 and a nearby client move to (54, 14) during 2–10 s, pause at 12 s and "
              "return by 22 s: behind the wall only extender_5 is a usable backhaul parent.",
        "optimizer": "Native parent selection should reparent extender_3 to the wired extender while it is "
                     "east of the wall, then back after the return.",
        "watch": "At the 12 s pause compare applied AP-to-AP SNR with extender_3's actual parent.",
        "limits": "Needs the lab's wired_guard so the wired AP's own backhaul station never connects.",
    },
}


# ---------------------------------------------------------------------------
# reference rooms
# ---------------------------------------------------------------------------

def build_reference(reference: Path) -> list[dict]:
    worlds = reference / "configurator/worlds"
    guide = json.loads((HERE / "data/reference-room-guide.json").read_text())
    rooms = []
    for order, world_id in enumerate(REFERENCE_ORDER):
        golden = load_json(worlds / "golden" / f"{world_id}.world.json")
        layout = load_json(worlds / "layouts" / f"{golden['layout']}.json")
        mobility = load_json(worlds / "mobility" / f"{golden['mobility']}.json")
        entry = guide["entries"].get(world_id, {})
        design = design_from_layout_mobility(
            layout, mobility, design_id=world_id,
            title=entry.get("title") or world_id,
            description=entry.get("rf", ""),
            source={
                "kind": "reference",
                "project": "boardfarmdevs/easymesh-medium",
                "path": f"configurator/worlds/golden/{world_id}.world.json",
                "layout": golden["layout"], "mobility": golden["mobility"],
                "layout_sha256": golden["layout_sha256"], "mobility_sha256": golden["mobility_sha256"],
                "golden_sha256": golden["golden_sha256"],
            })
        design["builder"]["guide"] = {key: entry[key] for key in ("title", "rf", "optimizer", "watch", "limits")
                                      if key in entry}
        design["library"] = {"category": "reference", "order": order,
                             "highlights": _highlights(layout, mobility)}
        compiled = compile_world(layout, mobility)
        assert compiled["golden_sha256"] == golden["golden_sha256"], world_id
        rooms.append(design)
    wired_tree = reference / "configurator/worlds-wired"
    for order, (layout_name, mobility_name, world_id) in enumerate(WIRED_ROOMS, len(REFERENCE_ORDER)):
        golden = load_json(wired_tree / "golden" / f"{world_id}.world.json")
        layout = load_json(wired_tree / "layouts" / f"{layout_name}-wired.json")
        mobility = load_json(worlds / "mobility" / f"{mobility_name}.json")
        guide = WIRED_GUIDES[world_id]
        design = design_from_layout_mobility(
            layout, mobility, design_id=world_id, title=guide["title"], description=guide["rf"],
            source={
                "kind": "reference",
                "project": "boardfarmdevs/easymesh-medium",
                "path": f"configurator/worlds-wired/golden/{world_id}.world.json",
                "layout": golden["layout"], "mobility": golden["mobility"],
                "layout_sha256": golden["layout_sha256"], "mobility_sha256": golden["mobility_sha256"],
                "golden_sha256": golden["golden_sha256"],
            })
        design["builder"]["guide"] = dict(guide)
        design["library"] = {"category": "reference", "order": order,
                             "highlights": _highlights(layout, mobility)}
        assert compile_world(layout, mobility)["golden_sha256"] == golden["golden_sha256"], world_id
        rooms.append(design)
    return rooms


def _highlights(layout, mobility):
    items = []
    if layout.get("walls"):
        items.append(f"{len(layout['walls'])} walls")
    moving = sum(bool(n.get("path")) for n in mobility.get("nodes", []))
    if moving:
        items.append(f"{moving} moving")
    if any("presence" in n for n in mobility.get("nodes", [])):
        items.append("presence changes")
    for key, label in (("pause_at_ms", "checkpoints"), ("band_steering", "band steering"),
                       ("traffic_experiment", "traffic"), ("backhaul_rf", "geometry backhaul")):
        if mobility.get(key):
            items.append(label)
    if any(n.get("tx_gain_db_by_band") for n in mobility.get("nodes", []) + layout.get("nodes", [])):
        items.append("asymmetric uplink")
    if any(n.get("backhaul") == "wired" for n in layout.get("nodes", [])):
        items.append("wired backhaul")
    if mobility.get("ap_expectations"):
        items.append("AP expectations")
    return items


# ---------------------------------------------------------------------------
# authoring helpers
# ---------------------------------------------------------------------------

class Room:
    def __init__(self, room_id, title, width, height, *, category, order, profile="rdk-lab",
                 propagation=None, tags=(), description="", layout_name=None):
        self.id = room_id
        self.title = title
        self.width, self.height = width, height
        self.category, self.order, self.profile = category, order, profile
        self.propagation = dict(propagation or LAB_PROPAGATION)
        self.tags = list(tags)
        self.description = description
        self.layout_name = layout_name or room_id
        self.walls: list[dict] = []
        self.materials: list[str] = []
        self.nodes: list[dict] = []
        self.mobility_nodes: list[dict] = []
        self.guide: dict = {}
        self.mobility_extra: dict = {}

    # walls ---------------------------------------------------------------
    def wall(self, a, b, material="interior", name=None, gaps=()):
        """A wall from a to b, split around door gaps given as (centre_m_from_a, width_m)."""
        length = math.dist(a, b)
        ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
        cuts = sorted((c - w / 2, c + w / 2) for c, w in gaps)
        start = 0.0
        pieces = []
        for lo, hi in cuts:
            if lo > start + 1e-9:
                pieces.append((start, lo))
            start = hi
        if start < length - 1e-9:
            pieces.append((start, length))
        loss = BY_ID[material]["loss_db"]
        for index, (lo, hi) in enumerate(pieces):
            label = name if len(pieces) == 1 else f"{name}-{chr(97 + index)}"
            self.walls.append({
                "name": label,
                "start": [round(a[0] + ux * lo, 3), round(a[1] + uy * lo, 3)],
                "end": [round(a[0] + ux * hi, 3), round(a[1] + uy * hi, 3)],
                "loss_db": loss,
            })
            self.materials.append(material)

    def box(self, x0, y0, x1, y1, material="interior", name="room", doors=()):
        """Four walls; doors are (side, centre_m_along_side, width) with side in S/E/N/W."""
        sides = {"S": ((x0, y0), (x1, y0)), "E": ((x1, y0), (x1, y1)),
                 "N": ((x0, y1), (x1, y1)), "W": ((x0, y0), (x0, y1))}
        for side, (a, b) in sides.items():
            gaps = [(c, w) for s, c, w in doors if s == side]
            self.wall(a, b, material, f"{name}-{side.lower()}", gaps)

    def row(self, x0, x1, y_front, y_back, count, material, name, door_at=0.5, door_width=1.0,
            end_walls=True):
        """A row of equal rooms sharing one front wall and single dividers (no doubled walls).

        ``door_at`` is the door centre as a fraction of each room's width.
        """
        width = (x1 - x0) / count
        gaps = [((i + door_at) * width, door_width) for i in range(count)]
        self.wall((x0, y_front), (x1, y_front), material, f"{name}-front", gaps)
        for i in range(0 if end_walls else 1, count + 1 if end_walls else count):
            x = round(x0 + i * width, 3)
            if 0 < x < self.width:
                self.wall((x, min(y_front, y_back)), (x, max(y_front, y_back)), material, f"{name}-div{i}")

    # nodes ---------------------------------------------------------------
    def ap(self, role, x, y, **extra):
        self.nodes.append({"role": role, "kind": "fronthaul_ap", "position": [x, y], **extra})

    def sta(self, role, x, y, **extra):
        self.nodes.append({"role": role, "kind": "station", "position": [x, y], **extra})

    def move(self, role, points, *, speed=1.4, start_ms=0, dwell=None, kind=None, presence=None, **extra):
        node = {"role": role}
        if kind:
            node["kind"] = kind
        node.update(extra)
        node["path"] = walk(points, speed=speed, start_ms=start_ms, dwell=dwell or {})
        if presence is not None:
            node["presence"] = presence
        self.mobility_nodes.append(node)

    def appear(self, role, x, y, presence, **extra):
        self.mobility_nodes.append({"role": role, "position": [x, y], "presence": presence, **extra})

    def park(self, role, x, y):
        """A lab extender that exists but never transmits in this room."""
        self.nodes.append({"role": role, "kind": "fronthaul_ap", "position": [x, y]})
        self.mobility_nodes.append({"role": role, "kind": "fronthaul_ap", "position": [x, y], "presence": []})

    # build ---------------------------------------------------------------
    def build(self, *, mobility_name, duration_ms, tick_ms=2000, seed=1901, mobility_tags=(),
              place=0, place_objective="balanced", place_strategy="add"):
        layout = {
            "schema": "wmdcfg.world-layout.v1",
            "name": self.layout_name,
            "tags": sorted(self.tags),
            "space": {"width_m": self.width, "height_m": self.height},
            "propagation": self.propagation,
            "walls": self.walls,
            "nodes": self.nodes,
        }
        mobility = {
            "schema": "wmdcfg.mobility.v1",
            "name": mobility_name,
            "tags": sorted(mobility_tags),
            "duration_ms": duration_ms,
            "tick_ms": tick_ms,
            "seed": seed,
            **self.mobility_extra,
            "nodes": self.mobility_nodes,
        }
        design = design_from_layout_mobility(layout, mobility, design_id=self.id, title=self.title,
                                             description=self.description, profile=self.profile)
        design["builder"]["wall_materials"] = list(self.materials)
        if place:
            result = place_extenders(layout, mobility, place, strategy=place_strategy,
                                     objective=place_objective, profile=self.profile)
            design = apply_placement(design, result)
            # keep lab roles in a readable order
            design["layout"]["nodes"].sort(key=_node_order)
        design["builder"]["guide"] = {"title": self.title, **self.guide}
        design["library"] = {"category": self.category, "order": self.order,
                             "highlights": _highlights(design["layout"], design["mobility"])}
        return design


def _node_order(node):
    role = node["role"]
    if role == "gateway":
        return (0, role)
    if node["kind"] == "fronthaul_ap":
        return (1, len(role), role)
    return (2, role)


def walk(points, *, speed=1.4, start_ms=0, dwell):
    """Waypoints along points at speed; dwell={index: ms} holds at that point."""
    waypoints = []
    time_ms = 0
    if start_ms:
        waypoints.append({"time_ms": 0, "position": list(points[0])})
        time_ms = start_ms
    for index, p in enumerate(points):
        if index:
            seconds = math.dist(points[index - 1], p) / speed
            time_ms += max(100, int(math.ceil(seconds * 10)) * 100)
        if not waypoints or waypoints[-1]["time_ms"] != time_ms:
            waypoints.append({"time_ms": time_ms, "position": list(p)})
        if dwell.get(index):
            time_ms += dwell[index]
            waypoints.append({"time_ms": time_ms, "position": list(p)})
    return waypoints


def pool(start, count):
    return [f"sta_pool_{i:03d}" for i in range(start, start + count)]


# ---------------------------------------------------------------------------
# authored rooms
# ---------------------------------------------------------------------------

def authored() -> list[dict]:
    rooms = []

    # 1 ------------------------------------------------------------------
    r = Room("open-plan-template", "Open plan · lab template", 20, 14, category="starter", order=1,
             tags=["template", "open-plan", "five-agent", "static-10"],
             description="An empty 20 × 14 m floor with the lab's five agents placed by the optimiser and "
                         "ten static clients. Start here for a new lab room.")
    r.ap("gateway", 10, 7)
    for i, (x, y) in enumerate([(2, 2), (6, 11), (9, 3), (13, 12), (15, 5), (18, 9), (4, 7), (11, 9.5),
                                 (17, 1.5), (1.5, 12.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.guide = {
        "rf": "Free-space-like open floor with the lab's default propagation (54/50/47 dB at 1 m, exponent 2.2). "
              "No walls: every link is set by distance alone.",
        "optimizer": "Clients sit where the strongest AP is obvious; a policy should settle quickly and then stay "
                     "quiet. Use this as a control before adding walls.",
        "watch": "Every static client should keep its first association; no ping-pong.",
        "limits": "A template: add walls, movement and presence to turn it into an experiment.",
    }
    rooms.append(r.build(mobility_name="stationary", duration_ms=60000, mobility_tags=["stationary"], place=4))

    # 2 ------------------------------------------------------------------
    r = Room("minimal-canvas", "Minimal canvas (offline)", 12, 8, category="starter", order=2,
             profile="configurator", tags=["template", "offline"],
             description="The smallest valid world: one gateway and one client. Configurator profile, so any "
                         "roles and any number of agents are allowed.")
    r.ap("gateway", 6, 4)
    r.sta("sta_static_01", 9, 4)
    r.guide = {"rf": "One directed link pair per band.", "optimizer": "Nothing to decide: one AP.",
               "watch": "Use it to learn the editor.", "limits": "Not loadable in the live lab (missing agents)."}
    rooms.append(r.build(mobility_name="minimal", duration_ms=30000, tick_ms=1000))

    # 3 ------------------------------------------------------------------
    r = Room("four-rooms-template", "Four rooms with doorways", 20, 14, category="starter", order=3,
             tags=["template", "walls", "doors", "five-agent"],
             description="A cross of 5 dB interior walls with door gaps splits the floor into four rooms. "
                         "Two walkers cross through the doors while ten clients stay put.")
    r.wall((10, 0), (10, 14), "interior", "north-south", gaps=[(3.5, 1.0), (10.5, 1.0)])
    r.wall((0, 7), (20, 7), "interior", "east-west", gaps=[(4.5, 1.0), (15.5, 1.0)])
    r.ap("gateway", 5.5, 5.5)
    for i, (x, y) in enumerate([(2, 2), (7, 2.5), (13, 2), (18, 3), (2.5, 12), (7.5, 11), (12.5, 12.5),
                                 (17.5, 11.5), (4, 9.5), (16, 9)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(2, 4), (4.5, 5.5), (4.5, 8.5), (8, 10.5), (12, 10.5), (16, 11)],
           dwell={2: 4000})
    r.move("sta_mobile_02", [(18, 5), (15.5, 5.5), (15.5, 8.5), (12, 3.5), (8, 3.5), (3, 3)], speed=1.2,
           dwell={1: 3000})
    r.guide = {
        "rf": "Every wall crossing costs 5 dB; walking through a doorway crosses nothing, so links jump when "
              "a client leaves the gap.",
        "optimizer": "Walkers should be steered once per room change, after the new room's AP is clearly stronger.",
        "watch": "Serving AP before and after each doorway; no flapping while inside the gap.",
        "limits": "Straight-line model: doorways are exact gaps, not diffraction.",
    }
    rooms.append(r.build(mobility_name="doorway-walks", duration_ms=40000, tick_ms=1000,
                         mobility_tags=["mobile-2", "doors"], place=4))

    # 4 ------------------------------------------------------------------
    r = Room("studio-apartment", "Studio apartment", 9, 7, category="homes", order=1,
             tags=["home", "small", "parked-extenders"],
             description="A 63 m² studio with a drywall bathroom. The gateway and one extender serve it; the lab's "
                         "other three extenders are parked (always absent) so the room still loads in the lab.")
    r.box(0, 0, 3, 2.6, "drywall", "bath", doors=[("N", 2.2, 0.8)])
    r.wall((3, 4.8), (6, 4.8), "wood", "kitchen-counter")
    r.ap("gateway", 1.2, 5.8)
    r.ap("extender_1", 7.6, 1.2)
    r.park("extender_2", 8.5, 6.5)
    r.park("extender_3", 8.5, 6.0)
    r.park("extender_4", 8.0, 6.5)
    for i, (x, y) in enumerate([(4.5, 6.2), (7.8, 5.2), (1.5, 1.2), (5.5, 2.2), (6.8, 3.6), (2.2, 3.8)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(4.5, 3.5), (2.2, 3.2), (2.2, 1.4), (2.2, 3.2), (6.5, 5.5)], speed=0.8,
           dwell={2: 8000})
    r.guide = {
        "rf": "Short distances keep most links strong; the bathroom's 3 dB drywall and the 6 dB kitchen counter "
              "are the only obstructions. Parked extenders are RF-absent for the whole script.",
        "optimizer": "With two strong APs close together, steering should be rare; a laptop that visits the "
                     "bathroom may stay on its first AP.",
        "watch": "No churn between gateway and extender_1 while the walker dwells in the bathroom.",
        "limits": "Parking uses an empty presence list: the lab keeps those containers running with their "
                  "fronthaul off.",
    }
    rooms.append(r.build(mobility_name="studio-evening", duration_ms=40000, tick_ms=1000,
                         mobility_tags=["mobile-1", "parked"]))

    # 5 ------------------------------------------------------------------
    r = Room("two-bedroom-apartment", "Two-bedroom apartment", 14, 10, category="homes", order=2,
             tags=["home", "brick", "drywall"],
             description="Brick walls around the bedrooms, drywall around the bathroom and kitchen. Three "
                         "residents move between rooms with dwell times.")
    r.wall((0, 6), (8, 6), "brick", "bed1-south", gaps=[(6.0, 0.9)])
    r.wall((8, 4), (8, 10), "brick", "hall-west", gaps=[(3.1, 0.9)])
    r.wall((8, 4), (14, 4), "drywall", "kitchen-north", gaps=[(4.9, 0.9)])
    r.wall((11, 4), (11, 10), "brick", "bed2-west", gaps=[(1.2, 0.9)])
    r.wall((8, 7.6), (11, 7.6), "drywall", "bath-south", gaps=[(1.5, 0.8)])
    r.ap("gateway", 4, 3)
    for i, (x, y) in enumerate([(1.2, 1.0), (6.5, 1.5), (12.8, 1.0), (10.0, 2.5), (1.5, 9.0), (5.5, 8.5),
                                 (13.2, 9.2), (12.2, 6.0), (9.5, 9.2), (3.0, 4.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(2.5, 8), (6, 7), (6, 5), (4, 2.5), (9, 2), (12.5, 3.2), (12.5, 5.5), (12.8, 8.5)],
           dwell={3: 6000, 7: 5000})
    r.move("sta_mobile_02", [(13, 1.5), (9.5, 3), (8.7, 5.5), (9.5, 7), (9.5, 8.8)], speed=1.0,
           dwell={4: 10000})
    r.move("sta_mobile_03", [(1, 3), (7, 3.5), (7.5, 5), (6, 7), (2, 8.5)], speed=0.7)
    r.guide = {
        "rf": "Bedrooms sit behind 8 dB brick; the bathroom and kitchen behind 3 dB drywall. Doorways are real "
              "gaps, so a client in a doorway briefly sees the next room without loss.",
        "optimizer": "Expect one steering decision per room change for each walker, after the dwell starts.",
        "watch": "Walker 2 dwells in the bathroom for 10 s: its serving AP should stay stable there.",
        "limits": "Walls are band-independent in this model; real brick hurts 5/6 GHz more than 2.4 GHz.",
    }
    rooms.append(r.build(mobility_name="apartment-evening", duration_ms=60000, tick_ms=1000,
                         mobility_tags=["mobile-3", "dwell"], place=4))

    # 6 ------------------------------------------------------------------
    r = Room("l-shaped-house", "L-shaped house with garden", 24, 18, category="homes", order=3,
             tags=["home", "l-shape", "exterior", "garden"],
             description="The house occupies an L; the empty corner is the garden. Brick exterior walls separate "
                         "the garden from the house, so a client stepping outside loses 8 dB per wall.")
    # exterior of the L: house = [0,24]x[0,9] ∪ [0,12]x[9,18]
    r.wall((12, 9), (24, 9), "brick", "garden-south", gaps=[(4.0, 1.0)])
    r.wall((12, 9), (12, 18), "brick", "garden-west", gaps=[(5.0, 1.0)])
    r.wall((6, 0), (6, 9), "drywall", "living-east", gaps=[(6.5, 1.0)])
    r.wall((0, 9), (12, 9), "drywall", "upper-south", gaps=[(3.0, 1.0), (9.0, 1.0)])
    r.wall((6, 9), (6, 18), "drywall", "upper-mid", gaps=[(3.0, 0.9)])
    r.wall((17, 0), (17, 9), "brick", "garage", gaps=[(7.0, 2.5)])
    r.ap("gateway", 9, 4)
    for i, (x, y) in enumerate([(1.5, 1.5), (4, 7.5), (10.5, 1.5), (14.5, 6.0), (21.5, 3), (2.5, 12),
                                 (4.5, 16.5), (8.5, 13), (10.5, 16.8), (15, 2)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(3, 3), (5, 6.5), (9, 6.5), (16, 7.5), (16, 12), (20, 15), (22, 12), (16, 10),
                             (16, 7.5), (10, 7)], dwell={5: 15000})
    r.move("sta_mobile_02", [(9, 16), (8, 12), (6.8, 12), (3, 10.5), (3, 7.5), (8, 7.5)], speed=1.0,
           dwell={3: 5000})
    r.guide = {
        "rf": "Two 8 dB brick walls face the garden; a client in the far garden corner reaches most APs through "
              "one or two of them. Upstairs-style rooms are split by 3 dB drywall.",
        "optimizer": "The garden walker should move to whichever extender sees the garden through the doorway, "
                     "then return after re-entering.",
        "watch": "At 15 s of garden dwell, compare the dashed best link with the actual association.",
        "limits": "Outdoor propagation uses the indoor exponent; no ground reflection is modelled.",
    }
    rooms.append(r.build(mobility_name="garden-visit", duration_ms=80000, tick_ms=2000,
                         mobility_tags=["mobile-2", "outdoor"], place=4))

    # 7 ------------------------------------------------------------------
    r = Room("double-wall-extension", "Extension behind a double wall", 18, 10, category="homes", order=4,
             tags=["home", "double-wall", "stacked-walls"],
             description="An old house and its extension share two parallel brick walls 20 cm apart. A path "
                         "through both adds 16 dB; the shared doorway adds nothing.")
    r.wall((9.0, 0), (9.0, 10), "brick", "old-house", gaps=[(4.5, 1.0)])
    r.wall((9.2, 0), (9.2, 10), "brick", "extension", gaps=[(4.5, 1.0)])
    r.wall((0, 6), (5, 6), "drywall", "kitchen")
    r.ap("gateway", 2.5, 2.5)
    for i, (x, y) in enumerate([(1, 8.5), (4, 9), (7.5, 8), (6.5, 1.2), (3.5, 4.5), (11, 1.5), (13.5, 8.5),
                                 (16.5, 1.5), (16.8, 8.8), (12, 5.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(4, 4), (7.5, 4.5), (10.5, 4.5), (14, 3), (16, 5.5)], speed=1.0, dwell={4: 12000})
    r.move("sta_mobile_02", [(15, 8), (10.5, 5.3), (7.5, 5.3), (4, 8)], speed=1.2, start_ms=10000)
    r.guide = {
        "rf": "Two overlapping brick walls (8 + 8 dB) separate the halves; the doorway at y ≈ 4.5 m is open in "
              "both. The optimiser keeps an extender on each side so the double wall is rarely crossed.",
        "optimizer": "Clients in the extension should be served from an extension-side AP; crossing back through "
                     "the doorway should trigger one move.",
        "watch": "Inspect a link from the gateway to sta_static_09: wall_loss_db is 16.",
        "limits": "The builder shows the 'stacked walls' hint for overlapping walls; here they are parallel, not "
                  "overlapping, which is the recommended way to model a double wall.",
    }
    rooms.append(r.build(mobility_name="through-the-doorway", duration_ms=50000, tick_ms=1000,
                         mobility_tags=["mobile-2", "double-wall"], place=4))

    # 8 ------------------------------------------------------------------
    r = Room("villa-concrete-core", "Villa with a concrete core", 30, 24, category="homes", order=5,
             tags=["home", "large-home", "reinforced-concrete"],
             description="A reinforced-concrete stair core (18 dB) stands in the middle of an open villa floor. "
                         "Walkers circle it, so the core repeatedly blocks the gateway.")
    r.box(12, 9, 18, 15, "reinforced", "core", doors=[("S", 3, 1.2)])
    r.wall((0, 16), (8, 16), "drywall", "suite", gaps=[(6.5, 1.0)])
    r.wall((22, 0), (22, 8), "brick", "garage", gaps=[(4.0, 1.2)])
    r.ap("gateway", 15, 7)
    for i, (x, y) in enumerate([(2, 2), (8, 4), (26, 3), (28, 12), (25, 20), (18, 22), (10, 21), (2, 19),
                                 (4, 11), (20, 17.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    loop = [(10, 7.5), (20, 7.5), (20, 17), (10, 17), (10, 7.5)]
    r.move("sta_mobile_01", loop + [(20, 7.5)], speed=1.2)
    r.move("sta_mobile_02", list(reversed(loop)) + [(10, 17)], speed=1.0, start_ms=4000)
    r.move("sta_mobile_03", [(15, 7.8), (15, 11.5), (15, 7.8)], speed=0.6, dwell={1: 10000})
    r.guide = {
        "rf": "The 18 dB core casts an RF shadow; clients behind it lose the gateway even at short distance.",
        "optimizer": "Two walkers circle the core in opposite directions: each should hand over to the extender "
                     "on its side of the core, once per side.",
        "watch": "sta_mobile_03 walks into the stairwell (inside the core) and dwells for 10 s.",
        "limits": "The core is modelled as four walls; the inside of the stairwell is RF-shielded except "
                  "through the door gap.",
    }
    rooms.append(r.build(mobility_name="around-the-core", duration_ms=90000, tick_ms=2000,
                         mobility_tags=["mobile-3", "opposite-directions"], place=4))

    # 9 ------------------------------------------------------------------
    r = Room("open-office-meeting-rooms", "Open office with glass meeting rooms", 36, 22,
             category="workplaces", order=1, tags=["office", "glass", "concrete-core", "clients-30"],
             description="Thirty clients: desks in the open area, glass meeting rooms along the north wall and a "
                         "concrete service core. Six people walk to meetings and their laptops sleep on the way.")
    # one glass front with a door per room, and shared glass dividers (no doubled walls)
    r.wall((0, 16), (36, 16), "glass", "meeting-front", gaps=[(1.5, 1.0), (8.5, 1.0), (15.5, 1.0), (22.5, 1.0),
                                                                 (29.5, 1.0)])
    for x in (7, 14, 21, 28):
        r.wall((x, 16), (x, 22), "glass", f"meeting-divider-{x}")
    r.box(15, 6, 21, 11, "concrete", "core", doors=[("W", 2.5, 1.0)])
    r.ap("gateway", 18, 3)
    desks = [(2, 2), (5, 2), (8, 2), (11, 2), (24, 2), (27, 2), (30, 2), (33, 2), (2, 6), (5, 6),
             (8, 6), (11, 6), (24, 6), (27, 6), (30, 6), (33, 6), (2, 11), (5, 11), (8, 11), (11, 11),
             (24, 12), (27, 12), (30, 12), (33, 12)]
    names = [f"sta_static_{i:02d}" for i in range(1, 11)] + pool(21, 14)
    for role, (x, y) in zip(names, desks):
        r.sta(role, x + 0.5, y + 0.5)
    meetings = [((5.5, 3.5), (3.5, 13.5), (3.5, 19)), ((9.5, 7.5), (8.5, 13.5), (8.5, 19)),
                ((25.5, 3.5), (22.5, 13.5), (22.5, 19)), ((28.5, 7.5), (29.5, 13.5), (29.5, 19.5)),
                ((31.5, 3.5), (15.5, 13.5), (15.5, 19)), ((3.5, 7.5), (1.5, 13.5), (1.5, 19))]
    for i, (desk, door, seat) in enumerate(meetings, 1):
        r.move(f"sta_mobile_{i:02d}", [desk, door, seat], speed=1.2, start_ms=3000 * i,
               presence=[[0, 6000 + 3000 * i], [12000 + 3000 * i, 60000]])
    r.guide = {
        "rf": "Glass costs only 2 dB, so meeting rooms stay well covered; the 12 dB concrete core is the main "
              "obstruction. Laptops drop off air for 6 s while being carried.",
        "optimizer": "Returning laptops must re-associate without ghost or duplicate entries; the 24 desk "
                     "clients should stay put.",
        "watch": "Client count drops by one for 6 s per walker, then recovers in the meeting room.",
        "limits": "Needs the 100-client pool (30 clients). Presence gaps model sleep, not roaming.",
    }
    rooms.append(r.build(mobility_name="to-the-meetings", duration_ms=60000, tick_ms=1000,
                         mobility_tags=["mobile-6", "presence", "clients-30"], place=4))

    # 10 -----------------------------------------------------------------
    r = Room("school-corridor-flash-crowd", "School corridor · class change", 40, 16, category="workplaces",
             order=2, tags=["school", "corridor", "brick", "flash-crowd", "clients-32"],
             description="Eight classrooms off a corridor. Twenty pupils' tablets join classroom 2 at 20 s and "
                         "leave at 50 s, while a teacher walks the corridor.")
    r.row(0, 40, 9, 16, 4, "brick", "north", door_width=1.2)
    r.row(0, 40, 7, 0, 4, "brick", "south", door_width=1.2)
    r.ap("gateway", 20, 8)
    for i, (x, y) in enumerate([(3, 3), (7, 4), (13, 3), (17, 5), (23, 2), (33, 4), (4, 12), (26, 13),
                                 (35, 12), (15, 14)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    for index, role in enumerate(pool(21, 20)):
        x = 11.5 + (index % 5) * 1.6
        y = 10.8 + (index // 5) * 1.2
        r.appear(role, round(x, 2), round(y, 2), [[20000, 50000]])
    r.move("sta_mobile_01", [(1, 8), (39, 8), (1, 8)], speed=1.4)
    r.move("sta_mobile_02", [(5, 5), (5, 8), (15, 8), (15, 12), (15, 8), (5, 8), (5, 5)], speed=1.2,
           dwell={3: 20000})
    r.guide = {
        "rf": "Each classroom is enclosed in 8 dB brick with a 1.2 m door; the corridor is open. Twenty tablets "
              "appear together in one classroom.",
        "optimizer": "The flash crowd should spread over nearby APs only when load-aware policy is enabled; "
                     "signal-only policy keeps them on the strongest AP.",
        "watch": "Topology gains exactly 20 clients at 20 s and loses them at 50 s — no ghosts.",
        "limits": "Needs the 100-client pool (32 clients). Presence does not generate traffic load.",
    }
    rooms.append(r.build(mobility_name="class-change", duration_ms=60000, tick_ms=2000,
                         mobility_tags=["flash-crowd", "mobile-2"], place=4))

    # 11 -----------------------------------------------------------------
    r = Room("hotel-floor", "Hotel floor · guest walk", 60, 12, category="workplaces", order=3,
             tags=["hotel", "corridor", "metal-shaft", "long-building"],
             description="Sixteen rooms off a 60 m corridor with a metal lift shaft at one end. A guest walks from "
                         "the lift to the far room; staff roam the corridor.")
    r.row(4, 60, 7, 12, 8, "drywall", "rooms-north", door_at=1 / 7, door_width=0.9)
    r.row(4, 60, 5, 0, 8, "drywall", "rooms-south", door_at=6 / 7, door_width=0.9)
    r.box(0.5, 7.5, 3.5, 11.5, "metal", "lift", doors=[("S", 1.5, 1.2)])
    r.ap("gateway", 3, 6)
    for i, (x, y) in enumerate([(6, 10), (13, 3), (20, 10), (27, 2), (34, 10), (41, 3), (48, 10), (55, 2),
                                 (58, 10.5), (10, 1.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(2, 9), (2, 6), (58, 6), (58.2, 3)], speed=1.2, dwell={1: 3000})
    r.move("sta_mobile_02", [(30, 6), (5, 6), (55, 6), (30, 6)], speed=1.25)
    r.guide = {
        "rf": "A long, thin building: coverage is limited by distance along the corridor rather than walls. "
              "The lift is a 30 dB metal box.",
        "optimizer": "The guest should hand over along a chain of extenders in order, never skipping back.",
        "watch": "Serving AP sequence of sta_mobile_01; check that backhaul still reaches the far extender.",
        "limits": "With backhaul_rf fixed the live lab keeps its startup backhaul regardless of distance.",
    }
    rooms.append(r.build(mobility_name="guest-walk", duration_ms=90000, tick_ms=2000,
                         mobility_tags=["mobile-2", "long-walk"], place=4))

    # 12 -----------------------------------------------------------------
    r = Room("warehouse-racks", "Warehouse with metal racks", 60, 40, category="large", order=1,
             propagation=PROPAGATION_PRESETS["open-hall"]["propagation"],
             tags=["warehouse", "metal", "industrial", "open-hall"],
             description="Six 40 m rows of metal racking (30 dB) make RF corridors. Forklift terminals drive the "
                         "aisles; hand scanners stay at the packing benches.")
    for i in range(6):
        x = 12 + i * 7
        r.wall((x, 6), (x, 34), "metal", f"rack{i + 1}")
    r.box(0, 30, 8, 40, "brick", "office", doors=[("E", 3, 1.2)])
    r.ap("gateway", 4, 35)
    for i, (x, y) in enumerate([(2, 2), (5, 3), (8, 2.5), (57, 2), (57, 38), (30, 38), (30, 2), (2, 25),
                                 (6, 33), (3, 38)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    for i, x in enumerate([15.5, 22.5, 36.5, 50.5], 1):
        r.move(f"sta_mobile_{i:02d}", [(x, 3), (x, 37), (x, 3)], speed=2.5, start_ms=5000 * (i - 1))
    r.guide = {
        "rf": "Free-space exponent 2.0, but every rack row costs 30 dB: an AP effectively serves one or two "
              "aisles. Open ends of the aisles let signal around the racks.",
        "optimizer": "Forklifts move at 2.5 m/s along aisles; expect handovers at the aisle ends where the "
                     "next AP becomes visible.",
        "watch": "Coverage heatmap on 5 GHz: shadows behind each rack row.",
        "limits": "Racks are single walls; real racking loss depends on stock.",
    }
    rooms.append(r.build(mobility_name="forklift-shift", duration_ms=60000, tick_ms=1000,
                         mobility_tags=["mobile-4", "fast"], place=4, place_objective="area"))

    # 13 -----------------------------------------------------------------
    r = Room("exhibition-hall-50", "Exhibition hall · 50 visitors", 50, 50, category="large", order=2,
             tags=["hall", "crowd", "clients-50", "glass-booths"],
             description="A 50 × 50 m hall with glass-walled booths. Fifty clients: exhibitors stay at their "
                         "booths, ten visitors walk loops through the aisles.")
    for bx in (8, 22, 36):
        for by in (8, 22, 36):
            r.box(bx, by, bx + 6, by + 6, "glass", f"booth{bx}-{by}", doors=[("S", 3, 2)])
    r.ap("gateway", 25, 3)
    exhibitors = [f"sta_static_{i:02d}" for i in range(1, 11)] + pool(21, 30)
    spots = [(bx + dx, by + dy) for bx in (8, 22, 36) for by in (8, 22, 36) for dx, dy in ((1.5, 1.5), (4.5, 4.5))]
    spots += [(3, 3), (47, 3), (3, 47), (47, 47), (25, 47), (3, 25), (47, 25), (18, 30), (32, 18), (18, 18),
              (32, 32), (10, 45), (40, 45), (45, 10), (5, 12), (12, 5), (38, 5), (45, 40), (5, 38), (25, 16),
              (16, 25), (34, 25)]
    for role, (x, y) in zip(exhibitors, spots):
        r.sta(role, x, y)
    aisles = [(4, 4), (46, 4), (46, 18.5), (4, 18.5), (4, 32.5), (46, 32.5), (46, 46), (4, 46)]
    for i in range(1, 11):
        shift = (i - 1) % len(aisles)
        route = aisles[shift:] + aisles[:shift] + [aisles[shift]]
        r.move(f"sta_mobile_{i:02d}", route[:-1], speed=1.3 + 0.1 * (i % 4))
    r.guide = {
        "rf": "Glass booths barely attenuate (2 dB); distance dominates in a 50 m hall.",
        "optimizer": "Ten visitors walking different phases of the same loop give a steady stream of handovers; "
                     "fifty clients load the controller's candidate collection.",
        "watch": "Room and topology must both show exactly 50 online clients.",
        "limits": "Needs the 100-client pool. Crowd bodies are not modelled.",
    }
    rooms.append(r.build(mobility_name="visitor-loops", duration_ms=180000, tick_ms=4000,
                         mobility_tags=["mobile-10", "clients-50"], place=4, place_objective="area"))

    # 14 -----------------------------------------------------------------
    r = Room("hundred-client-arena", "Arena · 100 clients (pool limit)", 60, 40, category="stress", order=1,
             tags=["stress", "clients-100", "open-plan"],
             description="The lab's full 100-client pool in one open arena: 90 seated spectators and ten walkers.")
    r.ap("gateway", 30, 20)
    seated = [f"sta_static_{i:02d}" for i in range(1, 11)] + pool(21, 80)
    positions = []
    for row in range(6):
        for col in range(15):
            positions.append((4 + col * 3.7, 3 + row * 1.4 if row < 3 else 37 - (row - 3) * 1.4))
    for role, (x, y) in zip(seated, positions):
        r.sta(role, round(x, 2), round(y, 2))
    for i in range(1, 11):
        y = 8 + i * 2.2
        r.move(f"sta_mobile_{i:02d}", [(3, y), (57, y), (3, y)], speed=1.1 + 0.05 * i)
    r.guide = {
        "rf": "No walls: pure distance. The stress is the client count, not the geometry.",
        "optimizer": "Candidate collection and decisions for 100 clients per cycle; walkers produce a steady "
                     "trickle of handovers.",
        "watch": "Measurement freshness and decision latency as the roster reaches 100.",
        "limits": "Exactly the lab's CLIENT_CAPACITY; one more client is rejected.",
    }
    rooms.append(r.build(mobility_name="arena-walkers", duration_ms=120000, tick_ms=3000,
                         mobility_tags=["clients-100", "mobile-10"], place=4, place_objective="area"))

    # 15 -----------------------------------------------------------------
    r = Room("border-ping-pong", "Border ping-pong", 24, 10, category="stress", order=2,
             tags=["stress", "hysteresis", "border", "parked-extenders"],
             description="Two extenders face each other; a client hovers ±0.6 m around the exact midpoint every "
                         "two seconds. Good policy does not follow it back and forth.")
    r.ap("gateway", 1, 1)
    r.ap("extender_1", 6, 5)
    r.ap("extender_2", 18, 5)
    r.park("extender_3", 1, 9)
    r.park("extender_4", 2, 9)
    for i, (x, y) in enumerate([(3, 3), (7, 8), (17, 2), (21, 8), (9, 4.5), (15, 5.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.mobility_nodes.append({"role": "sta_mobile_01", "path": [
        {"time_ms": t, "position": [12 + (0.6 if (t // 2000) % 2 else -0.6), 5.2]} for t in range(0, 60001, 2000)]})
    r.guide = {
        "rf": "Symmetric geometry: at the midpoint both extenders give the same SNR; the client oscillates "
              "1.2 m across it every tick.",
        "optimizer": "Hysteresis and cooldowns should keep one association; each steer is a ping-pong.",
        "watch": "Count handovers of sta_mobile_01: the ideal is zero or one.",
        "limits": "SNR differences at ±0.6 m are 1–2 dB, inside typical hysteresis.",
    }
    rooms.append(r.build(mobility_name="hover-midpoint", duration_ms=60000, tick_ms=2000,
                         mobility_tags=["ping-pong"]))

    # 16 -----------------------------------------------------------------
    r = Room("extender-outage-walk", "Extender outage during a walk", 24, 16, category="stress", order=3,
             tags=["stress", "extender-loss", "walls"],
             description="extender_2 loses its fronthaul from 20 s to 50 s while two clients walk into its area. "
                         "Its clients must find another AP, then may return.")
    r.wall((12, 0), (12, 16), "interior", "spine", gaps=[(4, 1.2), (12, 1.2)])
    r.wall((12, 8), (24, 8), "interior", "east", gaps=[(6, 1.2)])
    r.ap("gateway", 6, 8)
    for i, (x, y) in enumerate([(2, 2), (8, 3), (3, 13), (9, 14), (14, 2.5), (20, 3), (22, 6.5), (15, 12),
                                 (21, 13.5), (18, 10)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.move("sta_mobile_01", [(3, 6), (10, 4), (13, 4), (19, 5), (19, 5.5)], speed=0.8, dwell={3: 20000})
    r.move("sta_mobile_02", [(8, 12), (14, 12), (18, 9), (18, 6.5), (21, 5)], speed=0.6)
    r.guide = {
        "rf": "Presence gap on extender_2's fronthaul: all its fronthaul links drop to the −20 dB floor for 30 s. "
              "Backhaul and container stay up in the live lab.",
        "optimizer": "Its clients must leave within the outage; after recovery, returning is optional but must "
                     "not oscillate.",
        "watch": "Clients near extender_2 at 20 s; recovery associations after 50 s.",
        "limits": "Models RF visibility loss, not a hostapd crash.",
    }
    design = r.build(mobility_name="outage-walk", duration_ms=70000, tick_ms=2000,
                     mobility_tags=["extender-loss", "mobile-2"], place=4)
    east = next(n for n in design["layout"]["nodes"] if n["role"] == "extender_2")
    design["mobility"]["nodes"].append({"role": "extender_2", "kind": "fronthaul_ap",
                                        "position": list(east["position"]),
                                        "presence": [[0, 20000], [50000, 70000]]})
    design["library"]["highlights"] = _highlights(design["layout"], design["mobility"])
    rooms.append(design)

    # 17 -----------------------------------------------------------------
    r = Room("asymmetric-uplink-sensors", "Weak-uplink IoT sensors", 20, 14, category="stress", order=4,
             tags=["stress", "asymmetric", "iot"],
             description="Four battery sensors transmit 15–20 dB weaker than they receive. Their downlink looks "
                         "healthy while the AP barely hears them.")
    r.wall((7, 0), (7, 9), "interior", "hall-west")
    r.wall((13, 5), (13, 14), "interior", "hall-east")
    r.ap("gateway", 10, 7)
    for i, (x, y) in enumerate([(2, 2), (4, 11), (17, 2), (18, 12), (10, 1.5), (10, 12.5)], 1):
        r.sta(f"sta_static_{i:02d}", x, y)
    for i, (x, y) in enumerate([(1.5, 7), (18.5, 7), (5, 3.5), (15, 10.5)], 7):
        r.sta(f"sta_static_{i:02d}", x, y, tx_gain_db_by_band={"2.4": -15, "5": -18, "6": -20})
    r.move("sta_mobile_01", [(2, 12), (10, 10), (18, 3)], speed=0.5,
           tx_gain_db_by_band={"2.4": -8, "5": -10, "6": -12})
    r.guide = {
        "rf": "tx_gain_db_by_band lowers every link the sensors transmit (uplink) while AP→sensor links keep "
              "the geometric value, so each pair has two different SNRs.",
        "optimizer": "Policies that rank by downlink RCPI alone will pick APs that cannot hear the sensor; "
                     "uplink-aware policy should prefer closer APs.",
        "watch": "Click a sensor: the inspector lists both directions per band.",
        "limits": "A scenario SNR offset, not native transmit-power control.",
    }
    rooms.append(r.build(mobility_name="weak-uplink", duration_ms=60000, tick_ms=2000,
                         mobility_tags=["asymmetric", "mobile-1"], place=4))

    # 18 -----------------------------------------------------------------
    r = Room("band-steering-traffic-demo", "Band steering + traffic demo", 30, 16, category="stress", order=5,
             tags=["band-steering", "traffic", "checkpoints"],
             description="Two profiled clients and a bounded UDP experiment: a dual-band laptop walks away and "
                         "back while a 2.4 GHz-only camera stays pinned, with checkpoints for inspection.")
    r.wall((15, 0), (15, 16), "brick", "partition", gaps=[(8, 1.2)])
    r.ap("gateway", 5, 8)
    r.ap("extender_1", 25, 8)
    r.park("extender_2", 29, 1)
    r.park("extender_3", 29, 15)
    r.park("extender_4", 1, 15)
    r.sta("sta_static_01", 5.6, 8.4)
    r.sta("sta_static_02", 6, 7)
    for i, (x, y) in enumerate([(3, 3), (9, 13), (22, 3), (27, 13), (11, 2), (20, 12), (26, 3), (8, 10)], 3):
        r.sta(f"sta_static_{i:02d}", x, y)
    r.mobility_nodes.append({"role": "sta_static_01", "path": [
        {"time_ms": 0, "position": [5.6, 8.4]}, {"time_ms": 2000, "position": [5.6, 8.4]},
        {"time_ms": 11000, "position": [14, 8.1]}, {"time_ms": 16000, "position": [14, 8.1]},
        {"time_ms": 25000, "position": [5.6, 8.4]}]})
    r.mobility_extra = {
        "pause_at_ms": [12000, 26000],
        "band_steering": {
            "sta_static_01": {"allowed_bands": ["2.4", "5", "6"], "initial_band": "5"},
            "sta_static_02": {"allowed_bands": ["2.4"], "initial_band": "2.4"},
        },
        "band_steering_expectations": [
            {"time_ms": 0, "roles": {"sta_static_01": {"band": "6", "ap": "gateway"},
                                     "sta_static_02": {"band": "2.4", "ap": "gateway"}}},
            {"time_ms": 12000, "roles": {"sta_static_01": {"band": "2.4", "ap": "gateway"},
                                         "sta_static_02": {"band": "2.4", "ap": "gateway"}}},
            {"time_ms": 30000, "roles": {"sta_static_01": {"band": "6", "ap": "gateway"},
                                         "sta_static_02": {"band": "2.4", "ap": "gateway"}}},
        ],
        "traffic_experiment": {"schema": "easymesh.room-traffic.v1", "phases": [
            {"role": "sta_static_01", "start_ms": 3000, "end_ms": 10000, "mode": "udp", "offered_mbps": 2,
             "payload_bytes": 1200},
            {"role": "sta_static_01", "start_ms": 17000, "end_ms": 24000, "mode": "udp", "offered_mbps": 6,
             "payload_bytes": 1200},
        ]},
    }
    r.guide = {
        "rf": "Close to the gateway all three bands are strong; at the partition the 6 and 5 GHz links weaken "
              "first. Only gateway and extender_1 transmit.",
        "optimizer": "Upgrade to 6 GHz near the gateway, fall back to 2.4 GHz at the far point, upgrade again on "
                     "return. The 2.4 GHz-only camera must never be steered off 2.4.",
        "watch": "At the 12 s and 26 s checkpoints compare native band/BSSID with the signed expectations; "
                 "the traffic inspector shows 2 then 6 Mbps offered.",
        "limits": "Expectations are the author's intent, checked by the room guide, not enforced by RF.",
    }
    rooms.append(r.build(mobility_name="band-and-traffic", duration_ms=30000, tick_ms=1000,
                         mobility_tags=["band-steering", "traffic", "checkpoints"]))

    # 19 -----------------------------------------------------------------
    r = Room("geometry-backhaul-relay-chain", "Relay chain · geometry backhaul", 70, 14, category="stress",
             order=6, tags=["backhaul", "geometry", "relay-chain", "long-building"],
             description="A 70 m building where only a chain of relays reaches the far end. backhaul_rf is "
                         "'geometry', so AP-to-AP RF follows the room; extender_4 walks out of range and back.")
    for x in (14, 28, 42, 56):
        r.wall((x, 0), (x, 14), "concrete", f"firewall-{x}", gaps=[(7, 2)])
    r.ap("gateway", 4, 7)
    r.ap("extender_1", 17.5, 7.2)
    r.ap("extender_2", 31, 6.8)
    r.ap("extender_3", 44.5, 7.2)
    r.ap("extender_4", 58, 6.8)
    for i, x in enumerate([2, 9, 16, 23, 30, 37, 44, 51, 58, 66], 1):
        r.sta(f"sta_static_{i:02d}", x, 3 if i % 2 else 11)
    r.move("extender_4", [(58, 6.8), (58, 6.8), (67, 12.5), (67, 12.5), (58, 6.8)], speed=1.0,
           kind="fronthaul_ap", dwell={1: 2000, 3: 6000})
    r.move("sta_mobile_01", [(2, 7), (68, 7)], speed=1.3)
    r.mobility_extra = {"backhaul_rf": "geometry", "pause_at_ms": [16000]}
    r.guide = {
        "rf": "12 dB concrete firewalls every 14 m with aligned 2 m openings: each relay sees its neighbours "
              "at ≈ 25 dB but the next-but-one only below 20 dB, so a chain beats any direct link. Geometry "
              "backhaul applies AP-to-AP RF from the room during load and playback.",
        "optimizer": "Native parent selection should form a chain gateway → e1 → e2 → e3 → e4; the external "
                     "optimizer only steers clients. When extender_4 moves away its parent link weakens.",
        "watch": "At the 16 s checkpoint compare applied bidirectional 5 GHz SNR with the actual parent tree.",
        "limits": ".wmd exports stay fronthaul-only; geometry backhaul needs the interactive room engine.",
    }
    rooms.append(r.build(mobility_name="relay-chain", duration_ms=60000, tick_ms=1000,
                         mobility_tags=["geometry", "backhaul", "mobile-1"]))
    return rooms


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, help="reference repository checkout")
    parser.add_argument("--check", action="store_true", help="only verify, do not write")
    args = parser.parse_args()
    LIBRARY.mkdir(parents=True, exist_ok=True)
    rooms = authored()
    if args.reference:
        rooms += build_reference(args.reference)
    failures = 0
    for design in rooms:
        report = verify_design(design)
        status = "ok" if report["passed"] else "FAIL"
        advisories = [c["id"] + ": " + str(c["detail"]) for c in report["checks"] if c["status"] == "warn"]
        print(f"{status:4} {design['id']:<44} {report['counts']}")
        for line in advisories:
            print(f"       advisory {line[:160]}")
        if not report["passed"]:
            failures += 1
            for check in report["checks"]:
                if check["status"] == "fail":
                    print(f"       {check['id']}: {check['detail']}")
        if not args.check:
            design.pop("created_at", None)
            design.pop("updated_at", None)
            design["revision"] = 0
            (LIBRARY / f"{design['id']}.design.json").write_text(pretty_json(design), encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
