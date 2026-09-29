"""File-backed design store with revision history.

``<root>/<id>.json`` holds the current design; ``<root>/.history/<id>/`` keeps
earlier revisions (newest ``HISTORY_LIMIT``) so a save can always be undone.
Writes are atomic (temporary file + rename). A save may pass the revision it
was based on; a mismatch raises ``Conflict`` instead of overwriting.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path

from .design import ID_PATTERN, normalize_design, now_iso, slugify
from .model import ScenarioError

HISTORY_LIMIT = 40


class Conflict(ScenarioError):
    pass


class NotFound(ScenarioError):
    pass


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def summarize(design: dict) -> dict:
    layout, mobility = design.get("layout", {}), design.get("mobility", {})
    nodes = {node.get("role"): node.get("kind") for node in layout.get("nodes", [])}
    for node in mobility.get("nodes", []):
        nodes[node.get("role")] = node.get("kind", nodes.get(node.get("role"), "station"))
    return {
        "id": design.get("id"),
        "title": design.get("title"),
        "description": design.get("description", ""),
        "profile": design.get("profile"),
        "revision": design.get("revision", 0),
        "updated_at": design.get("updated_at"),
        "created_at": design.get("created_at"),
        "size_m": [layout.get("space", {}).get("width_m"), layout.get("space", {}).get("height_m")],
        "walls": len(layout.get("walls", [])),
        "agents": sum(kind == "fronthaul_ap" for kind in nodes.values()),
        "stations": sum(kind == "station" for kind in nodes.values()),
        "mobile": sum(bool(node.get("path")) for node in mobility.get("nodes", [])),
        "duration_s": (mobility.get("duration_ms") or 0) / 1000,
        "tags": sorted(set(layout.get("tags", [])) | set(mobility.get("tags", []))),
    }


class DesignStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, design_id: str) -> Path:
        if not re.fullmatch(ID_PATTERN, design_id or ""):
            raise NotFound(f"invalid design id {design_id!r}")
        return self.root / f"{design_id}.json"

    def _history_dir(self, design_id: str) -> Path:
        return self.root / ".history" / design_id

    def list(self) -> list[dict]:
        items = []
        for path in sorted(self.root.glob("*.json")):
            try:
                design = json.loads(path.read_text(encoding="utf-8"))
                items.append(summarize(design))
            except (OSError, ValueError):
                continue
        return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)

    def exists(self, design_id: str) -> bool:
        return self._path(design_id).is_file()

    def get(self, design_id: str) -> dict:
        path = self._path(design_id)
        if not path.is_file():
            raise NotFound(f"no design {design_id!r}")
        return json.loads(path.read_text(encoding="utf-8"))

    def unique_id(self, wanted: str) -> str:
        base = slugify(wanted)
        candidate, index = base, 2
        while self._path(candidate).exists():
            candidate = f"{base[:94]}-{index}"
            index += 1
        return candidate

    def create(self, design: dict) -> dict:
        with self._lock:
            design = normalize_design(design)
            design["id"] = self.unique_id(design["id"])
            stamp = now_iso()
            design["created_at"] = design.get("created_at") or stamp
            design["updated_at"] = stamp
            design["revision"] = 1
            _atomic_write(self._path(design["id"]), json.dumps(design, indent=2, ensure_ascii=False) + "\n")
            return design

    def save(self, design: dict, expected_revision: int | None = None) -> dict:
        with self._lock:
            design = normalize_design(design)
            path = self._path(design["id"])
            if path.exists():
                current = json.loads(path.read_text(encoding="utf-8"))
                if expected_revision is not None and current.get("revision") != expected_revision:
                    raise Conflict(
                        f"design {design['id']!r} is at revision {current.get('revision')}, "
                        f"not {expected_revision}: it was saved elsewhere")
                self._archive(current)
                design["revision"] = int(current.get("revision", 0)) + 1
                design["created_at"] = current.get("created_at", design.get("created_at"))
            else:
                design["revision"] = 1
                design.setdefault("created_at", now_iso())
            design["updated_at"] = now_iso()
            _atomic_write(path, json.dumps(design, indent=2, ensure_ascii=False) + "\n")
            return design

    def _archive(self, design: dict) -> None:
        directory = self._history_dir(design["id"])
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{int(design.get('revision', 0)):06d}.json"
        _atomic_write(directory / name, json.dumps(design, indent=2, ensure_ascii=False) + "\n")
        entries = sorted(directory.glob("*.json"))
        for stale in entries[:-HISTORY_LIMIT]:
            stale.unlink(missing_ok=True)

    def delete(self, design_id: str) -> None:
        with self._lock:
            design = self.get(design_id)
            self._archive(design)
            self._path(design_id).unlink()

    def duplicate(self, design_id: str, title: str | None = None) -> dict:
        design = self.get(design_id)
        design["title"] = title or f"{design.get('title', design_id)} (copy)"
        design["id"] = self.unique_id(slugify(design["title"]))
        design.pop("created_at", None)
        return self.create(design)

    def history(self, design_id: str) -> list[dict]:
        directory = self._history_dir(design_id)
        result = []
        for path in sorted(directory.glob("*.json"), reverse=True):
            try:
                design = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            result.append({"revision": design.get("revision"), "updated_at": design.get("updated_at"),
                           "title": design.get("title")})
        return result

    def revision(self, design_id: str, revision: int) -> dict:
        path = self._history_dir(design_id) / f"{int(revision):06d}.json"
        if not path.is_file():
            raise NotFound(f"design {design_id!r} has no stored revision {revision}")
        return json.loads(path.read_text(encoding="utf-8"))

    def restore(self, design_id: str, revision: int) -> dict:
        old = self.revision(design_id, revision)
        current = self.get(design_id) if self.exists(design_id) else None
        return self.save(old, expected_revision=current.get("revision") if current else None)
