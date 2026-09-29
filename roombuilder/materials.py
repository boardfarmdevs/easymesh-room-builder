"""Wall material presets.

The configurator models a wall as one band-independent ``loss_db`` added for
every proper crossing of the straight RF path. A *material* is only a builder
preset for that number plus a drawing style; exported layouts carry
``loss_db`` (and the wall ``name``), never the material itself.

The presets include the exact values used by the reference rooms: interior
5 dB (home layouts), concrete partition 12 dB (backhaul courtyard) and RF
isolation 70 dB (isolation wall).
"""

from __future__ import annotations

MATERIALS = [
    {
        "id": "glass", "label": "Glass / window", "loss_db": 2,
        "color": "#9fc5d6", "thickness_m": 0.06,
        "tip": "Clear glass partition or window. About 2 dB per crossing.",
    },
    {
        "id": "drywall", "label": "Drywall / stud partition", "loss_db": 3,
        "color": "#d9cdb8", "thickness_m": 0.10,
        "tip": "Plasterboard on studs, the lightest solid interior partition.",
    },
    {
        "id": "interior", "label": "Interior wall (lab default)", "loss_db": 5,
        "color": "#b8ad9a", "thickness_m": 0.12,
        "tip": "The value every wall in the reference home rooms uses (home-five-agent).",
    },
    {
        "id": "wood", "label": "Solid wood / door", "loss_db": 6,
        "color": "#b08a5a", "thickness_m": 0.08,
        "tip": "Solid timber wall or closed heavy door.",
    },
    {
        "id": "brick", "label": "Brick", "loss_db": 8,
        "color": "#b0654a", "thickness_m": 0.20,
        "tip": "Single-leaf brick or block wall.",
    },
    {
        "id": "concrete", "label": "Concrete partition", "loss_db": 12,
        "color": "#8f8f8a", "thickness_m": 0.20,
        "tip": "Matches the 12 dB courtyard partition in the reference backhaul rooms.",
    },
    {
        "id": "reinforced", "label": "Reinforced concrete", "loss_db": 18,
        "color": "#6f6f6b", "thickness_m": 0.30,
        "tip": "Load-bearing reinforced concrete, stairwell or core walls.",
    },
    {
        "id": "metal", "label": "Metal / shaft / racks", "loss_db": 30,
        "color": "#5d6874", "thickness_m": 0.10,
        "tip": "Elevator shafts, metal-clad walls, dense storage racks.",
    },
    {
        "id": "isolation", "label": "RF isolation (lab)", "loss_db": 70,
        "color": "#3e3a36", "thickness_m": 0.30,
        "tip": "Matches the 70 dB isolation wall that cuts a relay off in backhaul-isolation-recovery.",
    },
]

CUSTOM = {
    "id": "custom", "label": "Custom loss", "loss_db": None,
    "color": "#b8ad9a", "thickness_m": 0.12,
    "tip": "Any non-negative loss in dB. The configurator accepts fractional values.",
}

BY_ID = {item["id"]: item for item in MATERIALS}
BY_ID["custom"] = CUSTOM
DEFAULT_MATERIAL = "interior"


def infer_material(loss_db) -> str:
    """The preset whose loss equals ``loss_db`` exactly, else ``custom``."""
    try:
        value = float(loss_db)
    except (TypeError, ValueError):
        return "custom"
    for item in MATERIALS:
        if float(item["loss_db"]) == value:
            return item["id"]
    return "custom"


def catalog() -> dict:
    return {"default": DEFAULT_MATERIAL, "materials": MATERIALS + [CUSTOM]}
