"""Band-steering client profiles.

Port of ``validate_profiles`` from ``gen/demo/room_demo/band_profiles.py``:
the live room rejects a world whose ``band_steering`` metadata fails these
rules, although the offline compiler only copies the metadata.
"""

from __future__ import annotations

import copy

from .model import ScenarioError

MAX_PROFILES = 4
MEASUREMENT_MODES = ("received_same_band",)


def validate_profiles(world):
    profiles = world.get("band_steering", {})
    if not isinstance(profiles, dict) or len(profiles) > 4:
        raise ScenarioError("band steering supports at most four explicitly profiled clients")
    for role, profile in profiles.items():
        if world["roles"].get(role) != "station" or not world["generations"][0]["present"].get(role):
            raise ScenarioError("band profiles require an initially present bound station")
        if (not isinstance(profile, dict) or not {"allowed_bands", "initial_band"} <= set(profile)
                or set(profile) - {"allowed_bands", "initial_band", "measurement_mode"}):
            raise ScenarioError("band profiles require allowed_bands and initial_band")
        bands = profile["allowed_bands"]
        if (not isinstance(bands, list) or not bands or any(band not in ("2.4", "5", "6") for band in bands)
                or len(set(bands)) != len(bands) or profile["initial_band"] not in bands):
            raise ScenarioError("invalid or duplicate allowed bands or initial band")
        if "measurement_mode" in profile and (
                profile["measurement_mode"] != "received_same_band" or len(bands) != 1):
            raise ScenarioError("received_same_band requires exactly one allowed band")
    return copy.deepcopy(profiles)


def validate_expectations(world):
    """Structural checks for ``band_steering_expectations`` checkpoints.

    The reference copies this metadata verbatim; the room guide and live
    acceptance read ``time_ms`` and per-role ``band``/``ap``. These checks keep
    builder output readable by those consumers.
    """
    expectations = world.get("band_steering_expectations")
    if expectations is None:
        return None
    if not isinstance(expectations, list):
        raise ScenarioError("band_steering_expectations must be a list of checkpoints")
    previous = -1
    for index, item in enumerate(expectations):
        if not isinstance(item, dict) or set(item) != {"time_ms", "roles"}:
            raise ScenarioError(f"expectation {index} requires exactly time_ms and roles")
        time_ms = item["time_ms"]
        if type(time_ms) is not int or not 0 <= time_ms <= world["duration_ms"] or time_ms <= previous:
            raise ScenarioError(f"expectation {index} time_ms must be ordered inside the duration")
        previous = time_ms
        if not isinstance(item["roles"], dict) or not item["roles"]:
            raise ScenarioError(f"expectation {index} requires roles")
        for role, expected in item["roles"].items():
            if world["roles"].get(role) != "station":
                raise ScenarioError(f"expectation {index} names unknown station {role!r}")
            if not isinstance(expected, dict) or set(expected) != {"band", "ap"}:
                raise ScenarioError(f"expectation {index} role {role} requires band and ap")
            if expected["band"] not in ("2.4", "5", "6"):
                raise ScenarioError(f"expectation {index} role {role} has invalid band")
            if world["roles"].get(expected["ap"]) != "fronthaul_ap":
                raise ScenarioError(f"expectation {index} role {role} names unknown AP {expected['ap']!r}")
    return copy.deepcopy(expectations)
