"""Command line: run the web builder, or verify/compile/export rooms headlessly."""

from __future__ import annotations

import argparse
import json
import os
import sys
import webbrowser
from pathlib import Path

from . import __version__, library
from .design import (
    compile_design, design_from_layout_mobility, export_bundle, import_documents, normalize_design,
    pretty_json, world_id,
)
from .model import ScenarioError
from .placement import apply_placement, place_extenders
from .render import dxf, plan_svg
from .verify import format_report, verify_design
from .world import export_wmd, golden_json

# Designs live next to the application (the project directory) by default.
DEFAULT_DATA = Path(__file__).resolve().parent.parent / "designs"


def _read(path: str):
    text = Path(path).read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def load_design(paths: list[str]) -> dict:
    """A design from a design file, a layout (+mobility) pair or a world plan."""
    if len(paths) == 1 and not Path(paths[0]).exists():
        return library.get(paths[0])
    documents = [_read(path) for path in paths]
    layouts, mobilities = library.known_sources()
    design, notes = import_documents(documents, known_layouts=layouts, known_mobilities=mobilities)
    for note in notes:
        print(f"note: {note}", file=sys.stderr)
    return design


def _write(output: str | None, data) -> None:
    if isinstance(data, str):
        data = data.encode("utf-8")
    if output in (None, "-"):
        sys.stdout.buffer.write(data)
    else:
        Path(output).write_bytes(data)
        print(f"wrote {output}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="room-builder", description="EasyMesh room builder")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="run the web room builder")
    serve.add_argument("--host", default="127.0.0.1",
                       help="address to listen on; 0.0.0.0 for every interface (default: this machine only)")
    serve.add_argument("--port", type=int, default=8790, help="0 picks a free port")
    serve.add_argument("--data", default=str(DEFAULT_DATA), help="design store directory")
    serve.add_argument("--reference", help="reference repo or configurator dir for parity checks")
    serve.add_argument("--open", action="store_true", help="open a browser")
    serve.add_argument("--user", help="after binding the port, run as this user (start with sudo to use port 80)")
    serve.add_argument("--allow", action="append", default=[], metavar="CIDR",
                       help="only answer clients in this network, e.g. 192.168.2.0/24 (repeatable; "
                            "this machine is always allowed)")
    serve.add_argument("--quiet", action="store_true")

    sources_help = "a design JSON, a layout JSON (+ mobility JSON), a .world.json, or a library room id"
    verify = commands.add_parser("verify", help="run the room verification suite")
    verify.add_argument("sources", nargs="+", help=sources_help)
    verify.add_argument("--reference", help="reference repo or configurator dir for byte parity")
    verify.add_argument("--profile", help="override the lab profile")
    verify.add_argument("--band", default="5")
    verify.add_argument("--json", action="store_true")

    compile_cmd = commands.add_parser("compile", help="compile to a wmdcfg.world-plan.v1")
    compile_cmd.add_argument("sources", nargs="+", help=sources_help)
    compile_cmd.add_argument("-o", "--output")
    compile_cmd.add_argument("--pretty", action="store_true", help="indented instead of golden (jq -c) form")

    export = commands.add_parser("export", help="export a room")
    export.add_argument("sources", nargs="+", help=sources_help)
    export.add_argument("--format", required=True,
                        choices=["design", "layout", "mobility", "world", "wmd", "bundle", "svg", "dxf"])
    export.add_argument("--band", default=None, help="2.4, 5, 6 or all (wmd) / link band (svg)")
    export.add_argument("--time-ms", type=int, default=0)
    export.add_argument("--heatmap", action="store_true")
    export.add_argument("-o", "--output")

    place = commands.add_parser("place", help="optimise extender positions")
    place.add_argument("sources", nargs="+", help=sources_help)
    place.add_argument("--count", type=int, default=4)
    place.add_argument("--band", default="5")
    place.add_argument("--strategy", choices=["replace", "add"], default="replace")
    place.add_argument("--objective", choices=["area", "clients", "balanced"], default="balanced")
    place.add_argument("--target-snr", type=float, default=30)
    place.add_argument("--min-backhaul-snr", type=float, default=20)
    place.add_argument("-o", "--output", help="write the updated design here")

    site = commands.add_parser("build-site", help="build the static site (GitHub Pages): the UI plus the "
                                                  "builder running in the browser via Pyodide")
    site.add_argument("--out", default="site", help="output directory (replaced if it is a previous build)")
    site.add_argument("--pyodide", metavar="DIR", help="use a local Pyodide runtime directory instead of "
                                                       "downloading the pinned release")

    lib = commands.add_parser("library", help="list or export the example library")
    lib.add_argument("--export", metavar="DIR", help="write every room as a configurator tree")
    lib.add_argument("--check", action="store_true", help="verify every library room")
    lib.add_argument("--reference", help="also compare with a reference configurator")

    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            from .server import make_server, parse_networks

            try:
                allow = parse_networks(args.allow)
            except ValueError as error:
                print(f"room-builder: invalid --allow network: {error}", file=sys.stderr)
                return 2
            try:
                server = make_server(args.host, args.port, args.data, reference=args.reference, quiet=args.quiet,
                                     allow=allow, user=args.user)
            except KeyError:
                print(f"room-builder: no such user {args.user!r}", file=sys.stderr)
                return 2
            except PermissionError as error:
                hint = " Ports below 1024 need root: start with sudo and add --user $USER." if args.port < 1024 else ""
                print(f"room-builder: cannot listen on {args.host}:{args.port}: {error.strerror or error}.{hint}",
                      file=sys.stderr)
                return 2
            except OSError as error:
                print(f"room-builder: cannot listen on {args.host}:{args.port}: {error.strerror or error}. "
                      "Pick another --port (0 chooses a free one).", file=sys.stderr)
                return 2
            port = server.server_address[1]
            url = f"http://{args.host}:{port}/"
            print(f"EasyMesh room builder {__version__} on {url} (designs in {args.data})", file=sys.stderr)
            if hasattr(os, "geteuid") and os.geteuid() == 0:
                print("  warning: running as root; add --user NAME to drop privileges after binding", file=sys.stderr)
            if args.host not in ("127.0.0.1", "localhost", "::1"):
                print("  answers " + (", ".join(str(n) for n in allow) + " and this machine" if allow
                                      else "every client that can reach this port (no --allow given)"),
                      file=sys.stderr)
            sys.stderr.flush()
            if args.open:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            return 0
        if args.command == "library":
            return _library(args)
        if args.command == "build-site":
            from .site import PYODIDE_VERSION, build_site

            out = build_site(args.out, pyodide_dir=args.pyodide)
            size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
            print(f"built {out} ({size / 1e6:.1f} MB, Pyodide {PYODIDE_VERSION}); serve it with any static "
                  f"web server, e.g. python3 -m http.server --directory {out}", file=sys.stderr)
            return 0
        design = load_design(args.sources)
        if args.command == "verify":
            if args.profile:
                design["profile"] = args.profile
            report = verify_design(design, reference=args.reference, band=args.band)
            print(json.dumps(report, indent=2) if args.json else format_report(report))
            return 0 if report["passed"] else 1
        if args.command == "compile":
            plan = compile_design(design)
            _write(args.output, pretty_json(plan) if args.pretty else golden_json(plan))
            return 0
        if args.command == "export":
            return _export(design, args)
        if args.command == "place":
            result = place_extenders(design["layout"], design["mobility"], args.count, band=args.band,
                                     strategy=args.strategy, objective=args.objective,
                                     target_snr_db=args.target_snr, min_backhaul_snr_db=args.min_backhaul_snr,
                                     profile=design.get("profile", "configurator"))
            for item in result["placements"]:
                print(f"{item['role']:<12} {item['position'][0]:>7.2f} {item['position'][1]:>7.2f}  "
                      f"backhaul {item['backhaul_parent']} {item['backhaul_snr_db']} dB")
            for key in ("before", "after"):
                area = result[key].get("area", {})
                print(f"{key:>6}: coverage≥{args.target_snr:g} dB {area.get('coverage_pct')}%  "
                      f"mean {area.get('mean_snr_db')} dB  p10 {area.get('p10_snr_db')} dB")
            for note in result["notes"]:
                print(f"note: {note}")
            if args.output:
                _write(args.output, pretty_json(apply_placement(design, result)))
            return 0
    except ScenarioError as error:
        print(f"room-builder: {error}", file=sys.stderr)
        return 2
    return 0


def _export(design: dict, args) -> int:
    wid = world_id(design)
    fmt = args.format
    if fmt == "design":
        _write(args.output, pretty_json(design))
    elif fmt == "layout":
        _write(args.output, pretty_json(design["layout"]))
    elif fmt == "mobility":
        _write(args.output, pretty_json(design["mobility"]))
    elif fmt == "world":
        _write(args.output, golden_json(compile_design(design)))
    elif fmt == "wmd":
        _write(args.output, export_wmd(compile_design(design), args.band or "all"))
    elif fmt == "bundle":
        _write(args.output or f"{wid}-bundle.zip", export_bundle(design, verify_design(design)))
    elif fmt == "svg":
        _write(args.output, plan_svg(design, time_ms=args.time_ms, band=args.band or "5", heatmap=args.heatmap))
    elif fmt == "dxf":
        _write(args.output, dxf(design))
    return 0


def _library(args) -> int:
    rooms = library.entries()
    if args.export:
        root = Path(args.export)
        for room in rooms:
            design = library.get(room["id"])
            (root / "layouts").mkdir(parents=True, exist_ok=True)
            (root / "mobility").mkdir(parents=True, exist_ok=True)
            (root / "golden").mkdir(parents=True, exist_ok=True)
            (root / "layouts" / f"{design['layout']['name']}.json").write_text(pretty_json(design["layout"]))
            (root / "mobility" / f"{design['mobility']['name']}.json").write_text(pretty_json(design["mobility"]))
            (root / "golden" / f"{world_id(design)}.world.json").write_text(golden_json(compile_design(design)))
        print(f"exported {len(rooms)} rooms to {root}", file=sys.stderr)
        return 0
    if args.check:
        failed = 0
        for room in rooms:
            report = verify_design(library.get(room["id"]), reference=args.reference)
            status = "PASS" if report["passed"] else "FAIL"
            warn = report["counts"]["warn"]
            print(f"{status}  {room['id']:<44} {report['counts']['pass']} pass"
                  + (f", {warn} advisory" if warn else ""))
            if not report["passed"]:
                failed += 1
                for check in report["checks"]:
                    if check["status"] == "fail":
                        print(f"      {check['id']}: {check['detail']}")
        return 1 if failed else 0
    for room in rooms:
        size = "×".join(f"{value:g}" for value in room["size_m"])
        print(f"{room['category']:<11} {room['id']:<44} {size:>8} m  {room['agents']} AP  {room['stations']:>3} STA  "
              f"{room['duration_s']:>5g} s  {room['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
