"""The room builder's JSON API, independent of any transport.

``WebApi.handle(method, path, body)`` takes a request and returns a
``Response``. The local HTTP server (``server.py``) calls it for ``/api/...``
requests, and the static GitHub Pages build calls the very same function
inside the browser through Pyodide, so both deployments run one code path.
"""

from __future__ import annotations

import json
import re
import traceback
import urllib.parse
from dataclasses import dataclass, field

from . import __version__, library, materials, schema
from .design import (
    DESIGN_SCHEMA, PROPAGATION_PRESETS, compile_design, export_bundle, import_documents, new_design,
    normalize_design, pretty_json, world_id,
)
from .geometry import BANDS
from .lab import profile_catalog
from .lint import lint
from .model import ScenarioError
from .placement import apply_placement, coverage, place_extenders
from .render import dxf, plan_svg
from .store import Conflict, DesignStore, NotFound
from .verify import verify_design
from .world import export_wmd, golden_json

MAX_BODY = 64 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str = "error"):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass
class Response:
    status: int
    content_type: str
    body: bytes
    headers: dict = field(default_factory=dict)


def json_response(value, status: int = 200) -> Response:
    return Response(status, "application/json; charset=utf-8", json.dumps(value, ensure_ascii=False).encode("utf-8"))


def file_response(data: bytes | str, filename: str, content_type: str) -> Response:
    if isinstance(data, str):
        data = data.encode("utf-8")
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename)
    return Response(200, content_type, data, {"Content-Disposition": f'attachment; filename="{safe}"'})


def _design_arg(body: dict) -> dict:
    design = body.get("design")
    if not isinstance(design, dict):
        raise ApiError(400, "request requires a design object", "bad_request")
    try:
        return normalize_design(design)
    except ScenarioError as error:
        raise ApiError(422, str(error), "invalid_design") from error


def _band(value, default="5") -> str:
    band = str(value if value is not None else default)
    if band not in BANDS and band != "all":
        raise ApiError(400, "band must be 2.4, 5, 6 or all", "bad_request")
    return band


def _parse_body(raw: bytes | str | None) -> dict:
    if raw is None or raw == b"" or raw == "":
        return {}
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_BODY:
        raise ApiError(413, "request body too large", "too_large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError(400, f"invalid JSON body: {error}", "bad_json") from error
    if not isinstance(value, dict):
        raise ApiError(400, "JSON body must be an object", "bad_request")
    return value


class WebApi:
    """All ``/api`` routes. ``storage`` tells the UI where designs live."""

    def __init__(self, data_dir, reference: str | None = None, storage: str = "server"):
        self.store = DesignStore(data_dir)
        self.reference = reference
        self.storage = storage

    def handle(self, method: str, path: str, body: bytes | str | None = None) -> Response:
        """``path`` is the URL path including ``/api``, e.g. ``/api/library``."""
        path = urllib.parse.unquote(urllib.parse.urlparse(path).path)
        if not path.startswith("/api/"):
            return json_response({"error": "not found", "code": "not_found"}, 404)
        try:
            return self._route(method.upper(), path[4:], body)
        except ApiError as error:
            return json_response({"error": str(error), "code": error.code}, error.status)
        except Conflict as error:
            return json_response({"error": str(error), "code": "conflict"}, 409)
        except NotFound as error:
            return json_response({"error": str(error), "code": "not_found"}, 404)
        except ScenarioError as error:
            return json_response({"error": str(error), "code": "scenario"}, 422)
        except Exception as error:  # pragma: no cover - defensive
            traceback.print_exc()
            return json_response({"error": f"internal error: {error}", "code": "internal"}, 500)

    def _route(self, method: str, path: str, raw_body) -> Response:
        store = self.store
        parts = [part for part in path.split("/") if part]
        route = "/".join(parts)

        if method in ("GET", "HEAD") and route == "health":
            return json_response({"status": "ok", "version": __version__, "reference": bool(self.reference),
                                  "storage": self.storage})
        if method in ("GET", "HEAD") and route == "meta":
            return json_response({
                "version": __version__,
                "design_schema": DESIGN_SCHEMA,
                "materials": materials.catalog(),
                "profiles": profile_catalog(),
                "schema": schema.catalog(),
                "propagation_presets": PROPAGATION_PRESETS,
                "library_categories": library.CATEGORIES,
                "reference": bool(self.reference),
                "storage": self.storage,
            })
        if method in ("GET", "HEAD") and route == "schema":
            return json_response(schema.catalog())
        if method in ("GET", "HEAD") and route == "library":
            return json_response({"categories": library.CATEGORIES, "rooms": library.entries()})
        if method in ("GET", "HEAD") and len(parts) == 2 and parts[0] == "library":
            return json_response(library.get(parts[1]))

        # designs --------------------------------------------------------------
        if parts[:1] == ["designs"]:
            if method == "GET" and len(parts) == 1:
                return json_response({"designs": store.list()})
            if method == "POST" and len(parts) == 1:
                body = _parse_body(raw_body)
                design = body.get("design") or new_design(body.get("title") or "Untitled room")
                created = store.create(_design_arg({"design": design}))
                return json_response(created, 201)
            if len(parts) >= 2:
                design_id = parts[1]
                if method == "GET" and len(parts) == 2:
                    return json_response(store.get(design_id))
                if method == "PUT" and len(parts) == 2:
                    body = _parse_body(raw_body)
                    design = _design_arg(body)
                    design["id"] = design_id
                    base = body.get("base_revision")
                    return json_response(store.save(design, expected_revision=base if isinstance(base, int) else None))
                if method == "DELETE" and len(parts) == 2:
                    store.delete(design_id)
                    return json_response({"deleted": design_id})
                if method == "POST" and parts[2:] == ["duplicate"]:
                    body = _parse_body(raw_body)
                    return json_response(store.duplicate(design_id, body.get("title")), 201)
                if method == "GET" and parts[2:] == ["history"]:
                    return json_response({"history": store.history(design_id)})
                if method == "GET" and len(parts) == 4 and parts[2] == "history":
                    return json_response(store.revision(design_id, int(parts[3])))
                if method == "POST" and parts[2:] == ["restore"]:
                    body = _parse_body(raw_body)
                    return json_response(store.restore(design_id, int(body.get("revision", -1))))
            raise ApiError(404, "unknown designs route", "not_found")

        if method != "POST":
            raise ApiError(404, f"unknown route {route}", "not_found")
        body = _parse_body(raw_body)

        if route == "new":
            design = new_design(body.get("title") or "Untitled room",
                                float(body.get("width_m") or 20), float(body.get("height_m") or 14),
                                profile=body.get("profile") or "rdk-lab")
            return json_response(design)
        if route == "lint":
            design = _design_arg(body)
            result = lint(design, band=_band(body.get("band")))
            plan = result.pop("compiled")
            return json_response({**result, "golden_sha256": plan["golden_sha256"] if plan else None})
        if route == "compile":
            return json_response(compile_design(_design_arg(body)))
        if route == "verify":
            design = _design_arg(body)
            return json_response(verify_design(design, reference=self.reference, band=_band(body.get("band"))))
        if route == "place":
            design = _design_arg(body)
            result = place_extenders(
                design["layout"], design["mobility"], int(body.get("count", 4)),
                band=_band(body.get("band")), backhaul_band=_band(body.get("backhaul_band")),
                strategy=body.get("strategy", "replace"), objective=body.get("objective", "balanced"),
                target_snr_db=float(body.get("target_snr_db", 30)),
                min_backhaul_snr_db=float(body.get("min_backhaul_snr_db", 20)),
                min_spacing_m=float(body["min_spacing_m"]) if body.get("min_spacing_m") not in (None, "") else None,
                wall_clearance_m=float(body.get("wall_clearance_m", 0.3)),
                profile=design.get("profile", "configurator"))
            result["design"] = apply_placement(design, result)
            return json_response(result)
        if route == "coverage":
            design = _design_arg(body)
            resolution = body.get("resolution")
            return json_response(coverage(design["layout"], design["mobility"], band=_band(body.get("band")),
                                          time_ms=int(body.get("time_ms", 0)),
                                          resolution=float(resolution) if resolution else None,
                                          target_snr_db=float(body.get("target_snr_db", 30))))
        if route == "import":
            documents = body.get("documents")
            if not isinstance(documents, list) or not documents:
                raise ApiError(400, "import requires a non-empty documents list", "bad_request")
            base = normalize_design(body["base"]) if isinstance(body.get("base"), dict) else None
            layouts, mobilities = library.known_sources()
            design, notes = import_documents(documents, base=base, known_layouts=layouts,
                                             known_mobilities=mobilities)
            return json_response({"design": design, "notes": notes})
        if parts[:1] == ["export"] and len(parts) == 2:
            return self._export(parts[1], body)
        raise ApiError(404, f"unknown route {route}", "not_found")

    def _export(self, kind: str, body: dict) -> Response:
        design = _design_arg(body)
        wid = world_id(design)
        band = _band(body.get("band"), "all" if kind == "wmd" else "5")
        options = body.get("options") or {}
        if kind == "design":
            return file_response(pretty_json(design), f"{wid}.design.json", "application/json")
        if kind == "layout":
            return file_response(pretty_json(design["layout"]), f"{design['layout']['name']}.json", "application/json")
        if kind == "mobility":
            return file_response(pretty_json(design["mobility"]), f"{design['mobility']['name']}.json",
                                 "application/json")
        if kind == "world":
            plan = compile_design(design)
            text = pretty_json(plan) if options.get("pretty") else golden_json(plan)
            return file_response(text, f"{wid}.world.json", "application/json")
        if kind == "wmd":
            plan = compile_design(design)
            return file_response(export_wmd(plan, band), f"{wid}-{band.replace('.', '_')}.wmd", "text/plain")
        if kind == "bundle":
            report = verify_design(design, reference=self.reference)
            return file_response(export_bundle(design, report), f"{wid}-bundle.zip", "application/zip")
        if kind == "svg":
            text = plan_svg(design, time_ms=int(body.get("time_ms", 0)), band=band if band != "all" else "5",
                            heatmap=bool(options.get("heatmap")), links=options.get("links", True),
                            paths=options.get("paths", True), labels=options.get("labels", True),
                            legend=options.get("legend", True),
                            material_colors=options.get("material_colors", True))
            return file_response(text, f"{wid}-plan.svg", "image/svg+xml")
        if kind == "dxf":
            return file_response(dxf(design), f"{wid}-plan.dxf", "application/dxf")
        if kind == "verification":
            report = verify_design(design, reference=self.reference)
            return file_response(pretty_json(report), f"{wid}-verification.json", "application/json")
        raise ApiError(404, f"unknown export {kind!r}", "not_found")
