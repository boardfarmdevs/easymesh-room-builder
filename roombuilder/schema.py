"""Property catalog of the configurator scenario language.

Every property the configurator (and the live room) accepts, with where it
lives, its constraints and an explanation. The web UI builds its forms and
hover tips from this catalog, so the documentation and the editor cannot
drift apart. Constraints mirror ``world.py``, ``traffic.py`` and ``bands.py``.
"""

from __future__ import annotations

PROPERTIES = [
    # ---------------------------------------------------------------- layout
    {"key": "layout.name", "doc": "layout", "type": "string", "pattern": "[a-zA-Z0-9_-]{1,100}",
     "label": "Layout name",
     "tip": "Name of the wmdcfg.world-layout.v1 document. The compiled world is named "
            "<layout>--<mobility>, and the live room loads worlds/layouts/<name>.json by this name, "
            "so keep it to letters, digits, '-' and '_'."},
    {"key": "layout.tags", "doc": "layout", "type": "string[]", "label": "Layout tags",
     "tip": "Free-form labels merged (sorted, de-duplicated) with the mobility tags into the world's tags."},
    {"key": "layout.space.width_m", "doc": "layout", "type": "number", "min_exclusive": 0, "unit": "m",
     "label": "Room width (x)",
     "tip": "Floor size along x. Every node, waypoint and wall end must stay inside 0..width at every tick."},
    {"key": "layout.space.height_m", "doc": "layout", "type": "number", "min_exclusive": 0, "unit": "m",
     "label": "Room depth (y)",
     "tip": "Floor size along y. The viewer draws plan y into the screen (scene −z)."},
    {"key": "layout.propagation.reference_distance_m", "doc": "layout", "type": "number",
     "min_exclusive": 0, "unit": "m", "default": 1, "label": "Reference distance",
     "tip": "Distance at which the reference SNR applies. Closer than this, path loss is zero "
            "(two devices on top of each other get the reference SNR, not more)."},
    {"key": "layout.propagation.reference_snr_db_by_band", "doc": "layout", "type": "object<band,number>",
     "unit": "dB", "default": {"2.4": 54, "5": 50, "6": 47}, "label": "Reference SNR by band",
     "tip": "SNR at the reference distance for 2.4, 5 and 6 GHz. All three bands are required. "
            "Lab default 54/50/47 dB: higher bands start weaker, like real radios."},
    {"key": "layout.propagation.path_loss_exponent", "doc": "layout", "type": "number",
     "min_exclusive": 0, "default": 2.2, "label": "Path-loss exponent",
     "tip": "Log-distance exponent n: loss = 10·n·log10(d / d0). 2.0 is free space; the lab homes use 2.2, "
            "the backhaul courtyards 2.8. Higher values shrink every cell."},
    {"key": "layout.propagation.shadowing_stddev_db", "doc": "layout", "type": "number", "min": 0,
     "default": 0, "unit": "dB", "label": "Shadowing σ",
     "tip": "Standard deviation of seeded Gaussian shadowing added per (tick, unordered pair, band). "
            "0 keeps every link deterministic from geometry alone. The mobility seed selects the sequence."},
    {"key": "layout.propagation.minimum_snr_db", "doc": "layout", "type": "integer", "min": -20, "max": 60,
     "default": -20, "unit": "dB", "label": "SNR floor",
     "tip": "Lower clamp. Absent roles get exactly this value on all their links. Must stay in [-20, 60]."},
    {"key": "layout.propagation.maximum_snr_db", "doc": "layout", "type": "integer", "min": -20, "max": 60,
     "default": 60, "unit": "dB", "label": "SNR ceiling",
     "tip": "Upper clamp, at most 60 dB (the .wmd language rejects anything outside [-20, 60])."},
    {"key": "layout.walls[].name", "doc": "layout", "type": "string", "label": "Wall name",
     "tip": "Optional label. The viewer writes '<name>  <loss> dB' on the floor beside the wall."},
    {"key": "layout.walls[].start", "doc": "layout", "type": "point", "unit": "m", "label": "Wall start",
     "tip": "[x, y] inside the room. Start and end must differ."},
    {"key": "layout.walls[].end", "doc": "layout", "type": "point", "unit": "m", "label": "Wall end",
     "tip": "[x, y] inside the room."},
    {"key": "layout.walls[].loss_db", "doc": "layout", "type": "number", "min": 0, "unit": "dB",
     "label": "Wall loss",
     "tip": "Added once for every proper crossing of the straight line between two devices, on all bands. "
            "Touching a wall end, or standing exactly on its line, adds nothing. Two walls side by side "
            "add both losses."},
    {"key": "layout.nodes[].role", "doc": "layout", "type": "string", "pattern": "[A-Za-z_][A-Za-z0-9_-]*",
     "label": "Role",
     "tip": "Physical identity bound to a container in the lab (gateway → bpibroadband, extender_1 → bpiap, "
            "sta_static_01 → wlan-client …). Roles never follow association."},
    {"key": "layout.nodes[].kind", "doc": "layout", "type": "enum", "values": ["fronthaul_ap", "station"],
     "label": "Kind",
     "tip": "fronthaul_ap: an EasyMesh agent serving clients (the gateway is Agent-1). station: a client."},
    {"key": "layout.nodes[].position", "doc": "layout", "type": "point", "unit": "m", "label": "Position",
     "tip": "[x, y] inside the room. The compiler rounds positions to 1 mm in the world plan."},
    {"key": "layout.nodes[].backhaul", "doc": "layout", "type": "enum", "values": ["wired"],
     "label": "Wired backhaul",
     "tip": "Only 'wired', only on a fronthaul_ap: its LAN port is on the controller's LAN, so it needs no "
            "Wi-Fi backhaul but keeps AP-to-AP links and can be a Wi-Fi extender's backhaul parent. The lab "
            "gives those links RF only when the AP's HAL never connects its own backhaul station (wired_guard). "
            "The lab's wired extender is extender_5 (bpiap-004)."},
    {"key": "nodes[].tx_gain_db_by_band", "doc": "layout|mobility", "type": "object<band,number>",
     "unit": "dB", "label": "Transmit adjustment",
     "tip": "Per-band offset added to every link this role transmits. A negative station value makes the "
            "uplink (station→AP) weaker than the downlink: the asymmetric-link rooms use −7/−10/−12 dB and "
            "−45 dB. It is a scenario SNR offset, not native transmit-power control."},
    # -------------------------------------------------------------- mobility
    {"key": "mobility.name", "doc": "mobility", "type": "string", "pattern": "[a-zA-Z0-9_-]{1,100}",
     "label": "Scenario name",
     "tip": "Name of the wmdcfg.mobility.v1 document; the second half of the world name."},
    {"key": "mobility.tags", "doc": "mobility", "type": "string[]", "label": "Scenario tags",
     "tip": "Merged into the world's tags."},
    {"key": "mobility.duration_ms", "doc": "mobility", "type": "integer", "min_exclusive": 0, "unit": "ms",
     "label": "Duration",
     "tip": "Script length. Must be an exact multiple of the tick. Checkpoint pauses add wall-clock waiting "
            "on top of this."},
    {"key": "mobility.tick_ms", "doc": "mobility", "type": "integer", "min": 100, "max": 60000, "unit": "ms",
     "label": "Tick",
     "tip": "One RF generation per tick (100 ms … 60 s). Positions are sampled at tick times, so a fast walk "
            "with a long tick jumps. The reference rooms use 1000–5000 ms."},
    {"key": "mobility.seed", "doc": "mobility", "type": "integer", "label": "Seed",
     "tip": "Seeds the deterministic shadowing sequence. Irrelevant while shadowing σ is 0."},
    {"key": "mobility.pause_at_ms", "doc": "mobility", "type": "integer[]", "unit": "ms",
     "label": "Checkpoint pauses",
     "tip": "Ordered, unique times strictly inside the duration where playback stops (live and preview) so "
            "the optimizer can measure stable RF. Viewer-only: .wmd exports do not contain them."},
    {"key": "mobility.backhaul_rf", "doc": "mobility", "type": "enum", "values": ["fixed", "geometry"],
     "default": "fixed", "label": "Backhaul RF policy",
     "tip": "fixed (default): the live lab keeps its protected startup AP-to-AP RF. geometry: AP-to-AP links "
            "follow the room (walls, distance) during load, play and drag; native software selects parents. "
            ".wmd exports stay fronthaul-only."},
    {"key": "mobility.nodes[].role", "doc": "mobility", "type": "string", "label": "Role",
     "tip": "A mobility node overrides (merges over) the layout node with the same role, or adds a new role."},
    {"key": "mobility.nodes[].kind", "doc": "mobility", "type": "enum", "values": ["station", "fronthaul_ap"],
     "default": "station", "label": "Kind",
     "tip": "Defaults to station when the role is new. Set fronthaul_ap to move or hide an agent."},
    {"key": "mobility.nodes[].path", "doc": "mobility", "type": "waypoint[]", "label": "Path",
     "tip": "Waypoints {time_ms, position}: times unique, ascending, the first exactly 0 and the last ≤ duration. "
            "Positions interpolate linearly; after the last waypoint the role holds still. Repeating a position "
            "at a later time makes a dwell."},
    {"key": "mobility.nodes[].position", "doc": "mobility", "type": "point", "unit": "m",
     "label": "Position (no path)",
     "tip": "A fixed position for a role without a path, e.g. a client that only appears or disappears."},
    {"key": "mobility.nodes[].presence", "doc": "mobility", "type": "interval[]", "unit": "ms",
     "default": "[[0, duration]]", "label": "Presence",
     "tip": "Half-open [start, end) intervals when the role is on air, ordered and non-overlapping inside the "
            "duration. While absent, every link of the role is the SNR floor. For an extender this removes its "
            "fronthaul only; the live lab keeps the container running."},
    {"key": "mobility.band_steering", "doc": "mobility", "type": "object<role,profile>",
     "label": "Band-steering profiles",
     "tip": "At most four initially present stations: {allowed_bands, initial_band, measurement_mode?}. "
            "initial_band must be allowed. measurement_mode 'received_same_band' requires exactly one band and "
            "uses AP→client passive reception instead of HAL candidate RCPI."},
    {"key": "mobility.band_steering_expectations", "doc": "mobility", "type": "checkpoint[]",
     "label": "Band/AP expectations",
     "tip": "Signed checkpoints [{time_ms, roles: {role: {band, ap}}}] that the room guide and acceptance use "
            "to state which AP and band a profiled client should end up on."},
    {"key": "mobility.ap_expectations", "doc": "mobility", "type": "checkpoint[]",
     "label": "AP expectations",
     "tip": "Which AP each named client must be on at a checkpoint or at the final settle: "
            "[{at: 'final' | a pause_at_ms time, roles: {station: fronthaul_ap}}]. Non-empty, one entry per "
            "'at', every role a station and every target an AP. Used by the wired-extender rooms."},
    {"key": "mobility.traffic_experiment", "doc": "mobility", "type": "traffic",
     "label": "Traffic experiment",
     "tip": "schema easymesh.room-traffic.v1 with 1–4 ordered, non-overlapping phases inside the first 60 s. "
            "Each phase ≤ 20 s from an initially present station, payload 64–1200 bytes. ICMP: 1–200 packets/s. "
            "UDP (mode 'udp'): 0.1–12 offered Mbps and ≤ 2000 datagrams/s."},
]

BY_KEY = {item["key"]: item for item in PROPERTIES}


def catalog() -> dict:
    return {
        "schemas": {
            "layout": "wmdcfg.world-layout.v1",
            "mobility": "wmdcfg.mobility.v1",
            "world": "wmdcfg.world-plan.v1",
            "traffic": "easymesh.room-traffic.v1",
            "design": "roombuilder.design.v1",
        },
        "bands": ["2.4", "5", "6"],
        "snr_clamp_db": [-20, 60],
        "tick_range_ms": [100, 60000],
        "model": "clamp(reference[b] − 10·n·log10(max(d, d0)/d0) − Σ crossed wall loss + tx_adjustment[b] "
                 "+ seeded shadowing), rounded half-to-even",
        "properties": PROPERTIES,
    }
