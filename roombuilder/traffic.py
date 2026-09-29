"""Bounded room traffic experiments (port of ``wmdcfg/traffic_profile.py``)."""

from __future__ import annotations

import copy

from .model import ScenarioError


SCHEMA = "easymesh.room-traffic.v1"
MAX_PHASES = 4
MAX_PHASE_MS = 20_000
MAX_END_MS = 60_000
PAYLOAD_RANGE = (64, 1200)
ICMP_PPS_RANGE = (1, 200)
UDP_MBPS_RANGE = (0.1, 12)
UDP_MAX_DATAGRAMS = 2000


def validate_phase(phase):
    common = {"role", "start_ms", "end_ms", "payload_bytes"}
    if not isinstance(phase, dict):
        raise ScenarioError("invalid traffic phase fields")
    udp = phase.get("mode") == "udp"
    fields = common | ({"mode", "offered_mbps"} if udp else {"packets_per_second"})
    if set(phase) != fields:
        raise ScenarioError("invalid traffic phase fields")
    if any(type(phase[field]) is not int for field in fields - {"role", "mode", "offered_mbps"}):
        raise ScenarioError("traffic timing, packet rate and size must be integers")
    if not (0 <= phase["start_ms"] < phase["end_ms"] <= 60000
            and phase["end_ms"] - phase["start_ms"] <= 20000
            and 64 <= phase["payload_bytes"] <= 1200):
        raise ScenarioError("traffic is bounded to 20 seconds per phase and 64..1200-byte payloads")
    if udp:
        rate = phase["offered_mbps"]
        if (type(rate) not in (int, float) or not 0.1 <= rate <= 12
                or rate * 1000000 > 2000 * 8 * phase["payload_bytes"]):
            raise ScenarioError("UDP is bounded to 0.1..12 offered Mbps and 2000 datagrams/s")
    elif not 1 <= phase["packets_per_second"] <= 200:
        raise ScenarioError("ICMP is bounded to 200 packets/s")


def validate_traffic(world):
    profile = world.get("traffic_experiment")
    if profile is None:
        return None
    if (not isinstance(profile, dict) or set(profile) != {"schema", "phases"}
            or profile["schema"] != "easymesh.room-traffic.v1"):
        raise ScenarioError("traffic_experiment requires schema and phases")
    phases = profile["phases"]
    if not isinstance(phases, list) or not 1 <= len(phases) <= 4:
        raise ScenarioError("traffic experiments require one to four non-overlapping phases")
    previous_end = 0
    for phase in phases:
        validate_phase(phase)
        role = phase["role"]
        if (not isinstance(role, str) or world["roles"].get(role) != "station"
                or not world["generations"][0]["present"].get(role)):
            raise ScenarioError("traffic source must be an initially present bound station")
        if not previous_end <= phase["start_ms"] < phase["end_ms"] <= min(60000, world["duration_ms"]):
            raise ScenarioError("traffic phases must be ordered and end within the first 60 seconds")
        previous_end = phase["end_ms"]
    return copy.deepcopy(profile)
