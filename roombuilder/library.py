"""Example room library.

Library rooms are ordinary design documents in ``roombuilder/library``. The
``reference`` category holds every Golden World of the reference configurator
with its layout and mobility copied verbatim; each records the expected
``golden_sha256`` and the test suite recompiles them to prove parity.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .design import normalize_design
from .model import ScenarioError
from .store import summarize
from .world import canonical_hash

LIBRARY_DIR = Path(__file__).resolve().parent / "library"
CATEGORIES = {
    "starter": "Starter templates",
    "homes": "Homes & apartments",
    "workplaces": "Offices, schools & venues",
    "large": "Large and industrial spaces",
    "stress": "Optimizer stress tests",
    "reference": "Reference lab rooms (golden parity)",
}


@lru_cache(maxsize=1)
def _index() -> dict:
    items = {}
    for path in sorted(LIBRARY_DIR.glob("*.design.json")):
        design = json.loads(path.read_text(encoding="utf-8"))
        items[design["id"]] = design
    return items


def reload() -> None:
    _index.cache_clear()


def entries() -> list[dict]:
    result = []
    for design in _index().values():
        library = design.get("library", {})
        summary = summarize(design)
        summary.update(category=library.get("category", "starter"), order=library.get("order", 100),
                       highlights=library.get("highlights", []),
                       source=design.get("source"), guide=(design.get("builder") or {}).get("guide"))
        result.append(summary)
    order = list(CATEGORIES)
    return sorted(result, key=lambda item: (order.index(item["category"]) if item["category"] in order else 99,
                                            item["order"], item["title"]))


def get(design_id: str) -> dict:
    design = _index().get(design_id)
    if design is None:
        raise ScenarioError(f"no library room {design_id!r}")
    return normalize_design(design)


def known_sources() -> tuple[dict, dict]:
    """Layouts and mobilities by name, for exact world-plan imports."""
    layouts, mobilities = {}, {}
    for design in _index().values():
        layouts.setdefault(design["layout"]["name"], design["layout"])
        mobilities.setdefault(design["mobility"]["name"], design["mobility"])
    return layouts, mobilities


def sources_by_hash() -> tuple[dict, dict]:
    layouts, mobilities = {}, {}
    for design in _index().values():
        layouts[canonical_hash(design["layout"])] = design["layout"]
        mobilities[canonical_hash(design["mobility"])] = design["mobility"]
    return layouts, mobilities
