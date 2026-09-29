"""Vector exports of a room: an SVG floor plan and a DXF drawing.

The SVG uses the room viewer's palette (paper floor, taupe walls, red
gateway, orange extenders, purple mobile and dark static clients, and the
signal meter's red/yellow/green link colours) so reports match the 3D views.
Plan y points up (north); the viewer draws plan y into the screen.
"""

from __future__ import annotations

import html
import math

from .geometry import BANDS, position_at_time
from .materials import BY_ID as MATERIALS
from .placement import RFModel, coverage, nodes_at
from .world import merge_nodes

PALETTE = {
    "paper": "#f3efe6", "panel": "#faf8f3", "ink": "#2a2622", "muted": "#7a726a", "rule": "#d9d2c5",
    "floor": "#e9e4d8", "grid": "#d0c9ba", "wall": "#b8ad9a", "wall_text": "#5c5344",
    "gateway": "#c0392b", "extender": "#d65f27", "mobile": "#7a4b9c", "static": "#3b3b3b",
    "absent": "#c9c9c9", "path": "#6f3e8e", "red": "#dc2626", "yellow": "#eab308", "green": "#15803d",
    "grey": "#d1d5db",
}
FONT = "'Source Sans 3', 'Segoe UI', system-ui, sans-serif"


def signal_level(snr: float) -> int:
    """The viewer's 10-segment meter level for an SNR (fixed −91 dBm noise)."""
    if snr is None or not math.isfinite(snr):
        return 0
    rssi = snr - 91
    if rssi < -110 or rssi > 0:
        return 0
    return max(1, min(10, math.floor((rssi + 90) / 5) + 1))


def snr_color(snr: float) -> str:
    level = signal_level(snr)
    index = level - 1
    if index < 0:
        return PALETTE["grey"]
    return PALETTE["red"] if index < 3 else PALETTE["yellow"] if index < 7 else PALETTE["green"]


def kind_color(role: str, kind: str) -> str:
    if role == "gateway":
        return PALETTE["gateway"]
    if kind == "fronthaul_ap":
        return PALETTE["extender"]
    return PALETTE["mobile"] if "mobile" in role else PALETTE["static"]


def display_role(role: str) -> str:
    if role == "gateway":
        return "Agent-1"
    if role.startswith("extender_"):
        return "Extender-" + role[9:]
    return short_role(role)


def short_role(role: str) -> str:
    if role == "gateway":
        return "gw"
    for prefix, short in (("extender_", "e"), ("sta_mobile_", "m"), ("sta_static_", "s")):
        if role.startswith(prefix):
            return short + role[len(prefix):]
    return role


def _esc(text) -> str:
    return html.escape(str(text), quote=True)


def plan_svg(design: dict, *, time_ms: int = 0, band: str = "5", heatmap: bool = False,
             links: bool = True, paths: bool = True, labels: bool = True, legend: bool = True,
             material_colors: bool = True, px_per_m: float | None = None) -> str:
    layout, mobility = design["layout"], design["mobility"]
    width = float(layout["space"]["width_m"])
    height = float(layout["space"]["height_m"])
    scale = px_per_m or max(12.0, min(48.0, 1000.0 / max(width, height)))
    margin_left, margin_top = 60.0, 70.0
    legend_h = 86.0 if legend else 0.0
    canvas_w = width * scale + margin_left + 40
    canvas_h = height * scale + margin_top + 50 + legend_h

    def X(x):
        return margin_left + x * scale

    def Y(y):
        return margin_top + (height - y) * scale

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {canvas_w:.1f} {canvas_h:.1f}" '
        f'width="{canvas_w:.0f}" height="{canvas_h:.0f}" font-family="{FONT}">',
        f'<rect width="100%" height="100%" fill="{PALETTE["paper"]}"/>',
        f'<text x="{margin_left}" y="30" font-size="20" font-weight="650" fill="{PALETTE["ink"]}">'
        f'{_esc(design.get("title") or layout["name"])}</text>',
        f'<text x="{margin_left}" y="50" font-size="12" fill="{PALETTE["muted"]}">'
        f'layout {_esc(layout["name"])} · mobility {_esc(mobility["name"])} · {width:g} × {height:g} m · '
        f't = {time_ms / 1000:g} s · {band} GHz</text>',
        f'<rect x="{X(0):.2f}" y="{Y(height):.2f}" width="{width * scale:.2f}" height="{height * scale:.2f}" '
        f'fill="{PALETTE["floor"]}" stroke="{PALETTE["rule"]}"/>',
    ]
    if heatmap:
        grid = coverage(layout, mobility, band=band, time_ms=time_ms,
                        resolution=max(width, height) / 90)
        cw, ch = grid["cell_m"]
        out.append('<g opacity="0.55">')
        for j in range(grid["rows"]):
            for i in range(grid["cols"]):
                value = grid["values"][j * grid["cols"] + i]
                out.append(f'<rect x="{X(i * cw):.2f}" y="{Y((j + 1) * ch):.2f}" width="{cw * scale + 0.4:.2f}" '
                           f'height="{ch * scale + 0.4:.2f}" fill="{snr_color(value)}"/>')
        out.append("</g>")
    grid_lines = []
    step = 2 if max(width, height) <= 60 else 5
    x = 0.0
    while x <= width + 1e-9:
        grid_lines.append(f'M{X(x):.2f} {Y(0):.2f}V{Y(height):.2f}')
        x += step
    y = 0.0
    while y <= height + 1e-9:
        grid_lines.append(f'M{X(0):.2f} {Y(y):.2f}H{X(width):.2f}')
        y += step
    out.append(f'<path d="{" ".join(grid_lines)}" stroke="{PALETTE["grid"]}" stroke-width="1" fill="none"/>')
    # axis ticks
    for value in range(0, int(width) + 1, step * (2 if width > 40 else 1)):
        out.append(f'<text x="{X(value):.1f}" y="{Y(0) + 16:.1f}" font-size="10" text-anchor="middle" '
                   f'fill="{PALETTE["muted"]}">{value}</text>')
    for value in range(0, int(height) + 1, step * (2 if height > 40 else 1)):
        out.append(f'<text x="{X(0) - 8:.1f}" y="{Y(value) + 3:.1f}" font-size="10" text-anchor="end" '
                   f'fill="{PALETTE["muted"]}">{value}</text>')
    materials = (design.get("builder") or {}).get("wall_materials", [])
    for index, wall in enumerate(layout.get("walls", [])):
        material = MATERIALS.get(materials[index] if index < len(materials) else "interior", MATERIALS["interior"])
        color = material["color"] if material_colors else PALETTE["wall"]
        thickness = max(2.5, (material.get("thickness_m") or 0.12) * scale)
        (x0, y0), (x1, y1) = wall["start"], wall["end"]
        out.append(f'<line x1="{X(x0):.2f}" y1="{Y(y0):.2f}" x2="{X(x1):.2f}" y2="{Y(y1):.2f}" '
                   f'stroke="{color}" stroke-width="{thickness:.2f}" stroke-linecap="butt"/>')
        if labels:
            angle = math.degrees(math.atan2(-(y1 - y0), x1 - x0))
            if angle > 90 or angle <= -90:
                angle += 180
            mx, my = X((x0 + x1) / 2), Y((y0 + y1) / 2)
            label = f'{wall.get("name") or f"wall {index + 1}"}  {wall["loss_db"]:g} dB'
            out.append(f'<text transform="translate({mx:.1f} {my:.1f}) rotate({angle:.1f}) translate(0 -{thickness / 2 + 4:.1f})" '
                       f'font-size="10.5" font-weight="600" text-anchor="middle" fill="{PALETTE["wall_text"]}">{_esc(label)}</text>')
    scene = {node["role"]: node for node in nodes_at(layout, mobility, time_ms)}
    if paths:
        for node in merge_nodes(layout, mobility):
            path = node.get("path") or []
            if len(path) < 2:
                continue
            color = PALETTE["path"]
            points = " ".join(f'{X(w["position"][0]):.2f},{Y(w["position"][1]):.2f}' for w in path)
            out.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="1.6" '
                       f'stroke-dasharray="6 4" opacity="0.75"/>')
            for waypoint in path:
                out.append(f'<circle cx="{X(waypoint["position"][0]):.2f}" cy="{Y(waypoint["position"][1]):.2f}" '
                           f'r="3" fill="{PALETTE["panel"]}" stroke="{color}" stroke-width="1.4"/>')
    if links:
        model = RFModel(layout)
        aps = [n for n in scene.values() if n["kind"] == "fronthaul_ap" and n["present"]]
        for node in scene.values():
            if node["kind"] != "station" or not node["present"] or not aps:
                continue
            # strongest downlink, ties broken by role name like the viewer
            best = min(((-model.snr(ap["position"], node["position"], band, ap["gain"][band]), ap["role"])
                        for ap in aps))
            best = (-best[0], best[1])
            ap = scene[best[1]]
            out.append(f'<line x1="{X(ap["position"][0]):.2f}" y1="{Y(ap["position"][1]):.2f}" '
                       f'x2="{X(node["position"][0]):.2f}" y2="{Y(node["position"][1]):.2f}" '
                       f'stroke="{snr_color(best[0])}" stroke-width="1.6" stroke-dasharray="5 3" opacity="0.8"/>')
    for role in sorted(scene, key=lambda r: scene[r]["kind"] == "fronthaul_ap"):
        node = scene[role]
        color = kind_color(role, node["kind"]) if node["present"] else PALETTE["absent"]
        cx, cy = X(node["position"][0]), Y(node["position"][1])
        if node["kind"] == "fronthaul_ap":
            size = 9
            out.append(f'<path d="M{cx:.2f} {cy - size:.2f} L{cx + size * 0.9:.2f} {cy + size * 0.6:.2f} '
                       f'L{cx - size * 0.9:.2f} {cy + size * 0.6:.2f}Z" fill="{color}" stroke="#fff" stroke-width="1.2"/>')
            text, font = display_role(role), 11
        else:
            out.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="4.6" fill="{color}" stroke="#fff" stroke-width="1"/>')
            text, font = short_role(role), 9.5
        if labels:
            w = len(text) * font * 0.58 + 8
            ty = cy - (20 if node["kind"] == "fronthaul_ap" else 15)
            out.append(f'<rect x="{cx - w / 2:.2f}" y="{ty - font:.2f}" width="{w:.2f}" height="{font + 5:.2f}" '
                       f'rx="3.5" fill="{color}"/>')
            out.append(f'<text x="{cx:.2f}" y="{ty + 0.5:.2f}" font-size="{font}" font-weight="700" '
                       f'text-anchor="middle" fill="#fff">{_esc(text)}</text>')
    # scale bar
    bar = 5 if width >= 12 else 1
    sx, sy = X(width) - bar * scale, Y(0) + 32
    out.append(f'<path d="M{sx:.1f} {sy:.1f}h{bar * scale:.1f}" stroke="{PALETTE["ink"]}" stroke-width="2"/>')
    out.append(f'<text x="{sx + bar * scale / 2:.1f}" y="{sy - 5:.1f}" font-size="10" text-anchor="middle" '
               f'fill="{PALETTE["ink"]}">{bar} m</text>')
    if legend:
        ly = Y(0) + 56
        items = [("gateway", PALETTE["gateway"], "tri"), ("extender", PALETTE["extender"], "tri"),
                 ("mobile client", PALETTE["mobile"], "dot"), ("static client", PALETTE["static"], "dot")]
        lx = margin_left
        for label, color, shape in items:
            if shape == "tri":
                out.append(f'<path d="M{lx + 6:.1f} {ly - 7:.1f}l6 10h-12z" fill="{color}"/>')
            else:
                out.append(f'<circle cx="{lx + 6:.1f}" cy="{ly - 2:.1f}" r="4.5" fill="{color}"/>')
            out.append(f'<text x="{lx + 16:.1f}" y="{ly + 2:.1f}" font-size="11" fill="{PALETTE["ink"]}">{label}</text>')
            lx += 24 + len(label) * 6.2
        ly += 20
        lx = margin_left
        for label, color in (("weak link", PALETTE["red"]), ("fair", PALETTE["yellow"]), ("strong", PALETTE["green"])):
            out.append(f'<path d="M{lx:.1f} {ly - 3:.1f}h22" stroke="{color}" stroke-width="2" stroke-dasharray="5 3"/>')
            out.append(f'<text x="{lx + 28:.1f}" y="{ly + 1:.1f}" font-size="11" fill="{PALETTE["ink"]}">{label}</text>')
            lx += 44 + len(label) * 6.2
        out.append(f'<path d="M{lx:.1f} {ly - 3:.1f}h22" stroke="{PALETTE["path"]}" stroke-width="1.6" stroke-dasharray="6 4"/>')
        out.append(f'<text x="{lx + 28:.1f}" y="{ly + 1:.1f}" font-size="11" fill="{PALETTE["ink"]}">planned path</text>')
        out.append(f'<text x="{margin_left}" y="{ly + 20:.1f}" font-size="10" fill="{PALETTE["muted"]}">'
                   f'Links: strongest AP→client on {band} GHz, coloured like the viewer\'s signal meter '
                   f'(red &lt; 16 dB, yellow 16–35 dB, green ≥ 36 dB). Wall labels show configured loss.</text>')
    out.append("</svg>")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------
# DXF (AutoCAD R12 ASCII), units: metres
# --------------------------------------------------------------------------

_ACI = {"WALLS": 8, "APS": 1, "GATEWAY": 1, "CLIENTS": 5, "PATHS": 6, "TEXT": 7, "ROOM": 9}


def dxf(design: dict) -> str:
    layout, mobility = design["layout"], design["mobility"]
    width = float(layout["space"]["width_m"])
    height = float(layout["space"]["height_m"])
    materials = (design.get("builder") or {}).get("wall_materials", [])
    layers = set(_ACI)
    entities: list[str] = []

    def line(layer, x0, y0, x1, y1):
        entities.extend(["0", "LINE", "8", layer, "10", f"{x0:.4f}", "20", f"{y0:.4f}", "30", "0.0",
                         "11", f"{x1:.4f}", "21", f"{y1:.4f}", "31", "0.0"])

    def circle(layer, x, y, r):
        entities.extend(["0", "CIRCLE", "8", layer, "10", f"{x:.4f}", "20", f"{y:.4f}", "30", "0.0",
                         "40", f"{r:.4f}"])

    def text(layer, x, y, h, value, angle=0.0):
        value = str(value).replace("\n", " ")
        entities.extend(["0", "TEXT", "8", layer, "10", f"{x:.4f}", "20", f"{y:.4f}", "30", "0.0",
                         "40", f"{h:.4f}", "1", value, "50", f"{angle:.3f}"])

    for x0, y0, x1, y1 in ((0, 0, width, 0), (width, 0, width, height), (width, height, 0, height), (0, height, 0, 0)):
        line("ROOM", x0, y0, x1, y1)
    for index, wall in enumerate(layout.get("walls", [])):
        material = materials[index] if index < len(materials) else "interior"
        layer = f"WALLS_{material.upper()}"
        layers.add(layer)
        (x0, y0), (x1, y1) = wall["start"], wall["end"]
        line(layer, x0, y0, x1, y1)
        angle = math.degrees(math.atan2(y1 - y0, x1 - x0))
        if angle > 90 or angle <= -90:
            angle += 180
        text("TEXT", (x0 + x1) / 2, (y0 + y1) / 2 + 0.15, 0.25,
             f"{wall.get('name') or f'wall {index + 1}'} {wall['loss_db']:g} dB", angle)
    for node in merge_nodes(layout, mobility):
        try:
            x, y = position_at_time(node, 0)
        except KeyError:
            continue
        role = node["role"]
        if node.get("kind") == "fronthaul_ap":
            layer = "GATEWAY" if role == "gateway" else "APS"
            for (ax, ay), (bx, by) in (((0, 0.35), (0.3, -0.2)), ((0.3, -0.2), (-0.3, -0.2)), ((-0.3, -0.2), (0, 0.35))):
                line(layer, x + ax, y + ay, x + bx, y + by)
            text("TEXT", x + 0.4, y + 0.2, 0.3, display_role(role))
        else:
            circle("CLIENTS", x, y, 0.18)
            text("TEXT", x + 0.25, y + 0.15, 0.22, short_role(role))
        path = node.get("path") or []
        for left, right in zip(path, path[1:]):
            line("PATHS", *left["position"], *right["position"])
    header = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "6",
              "9", "$EXTMIN", "10", "0.0", "20", "0.0", "30", "0.0",
              "9", "$EXTMAX", "10", f"{width:.4f}", "20", f"{height:.4f}", "30", "0.0", "0", "ENDSEC"]
    tables = ["0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(layers))]
    for layer in sorted(layers):
        color = _ACI.get(layer, 8)
        tables += ["0", "LAYER", "2", layer, "70", "0", "62", str(color), "6", "CONTINUOUS"]
    tables += ["0", "ENDTAB", "0", "ENDSEC"]
    body = ["0", "SECTION", "2", "ENTITIES", *entities, "0", "ENDSEC", "0", "EOF"]
    return "\n".join(header + tables + body) + "\n"
