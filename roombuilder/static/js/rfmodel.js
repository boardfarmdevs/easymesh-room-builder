// Pure geometry + link-budget model shared by every part of the builder UI.
//
// Mirrors roombuilder/geometry.py and world.py (themselves ports of wmdcfg),
// including Python's round-half-to-even, proper-crossing-only walls and the
// layout/mobility merge. No DOM or Three.js here: tests/js runs it in node and
// compares it with the Python compiler.

export const BANDS = ['2.4', '5', '6'];
export const DEFAULT_PROPAGATION = Object.freeze({
  reference_distance_m: 1,
  reference_snr_db_by_band: {'2.4': 54, '5': 50, '6': 47},
  path_loss_exponent: 2.2,
  shadowing_stddev_db: 0,
  minimum_snr_db: -20,
  maximum_snr_db: 60,
});

// Python round(): halves go to the even neighbour.
export function pyRound(x) {
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

// Proper crossings only: touching an end or running along a wall is not a crossing.
export function segmentsCross(a, b, c, d) {
  const abC = orientation(a, b, c), abD = orientation(a, b, d);
  const cdA = orientation(c, d, a), cdB = orientation(c, d, b);
  return ((abC > 0 && abD < 0) || (abD > 0 && abC < 0)) &&
    ((cdA > 0 && cdB < 0) || (cdB > 0 && cdA < 0));
}

export function wallCrossings(a, b, walls) {
  const out = [];
  for (let i = 0; i < (walls || []).length; i++) {
    if (segmentsCross(a, b, walls[i].start, walls[i].end)) out.push(i);
  }
  return out;
}

export function wallLoss(a, b, walls) {
  let loss = 0;
  for (const wall of walls || []) if (segmentsCross(a, b, wall.start, wall.end)) loss += Number(wall.loss_db);
  return loss;
}

export function propagationOf(layout) {
  const p = (layout && layout.propagation) || {};
  return {
    reference_distance_m: Number(p.reference_distance_m ?? 1),
    reference_snr_db_by_band: Object.assign({}, DEFAULT_PROPAGATION.reference_snr_db_by_band, p.reference_snr_db_by_band || {}),
    path_loss_exponent: Number(p.path_loss_exponent ?? 2.2),
    shadowing_stddev_db: Number(p.shadowing_stddev_db ?? 0),
    minimum_snr_db: Math.trunc(Number(p.minimum_snr_db ?? -20)),
    maximum_snr_db: Math.trunc(Number(p.maximum_snr_db ?? 60)),
  };
}

// Unrounded SNR before the clamp; used for smooth heatmaps.
export function rawSnr(prop, band, a, b, walls, gain = 0) {
  const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d0 = prop.reference_distance_m;
  const pathLoss = 10 * prop.path_loss_exponent * Math.log10(Math.max(distance, d0) / d0);
  return Number(prop.reference_snr_db_by_band[band]) - pathLoss - wallLoss(a, b, walls) + Number(gain || 0);
}

// Exactly one band of wmdcfg's directed_link (without seeded shadowing).
export function linkSnr(prop, band, a, b, walls, gain = 0) {
  const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d0 = prop.reference_distance_m;
  const crossed = wallCrossings(a, b, walls);
  const loss = crossed.reduce((sum, i) => sum + Number(walls[i].loss_db), 0);
  const pathLoss = 10 * prop.path_loss_exponent * Math.log10(Math.max(distance, d0) / d0);
  const value = pyRound(Number(prop.reference_snr_db_by_band[band]) - pathLoss - loss + Number(gain || 0));
  return {
    snr: Math.max(prop.minimum_snr_db, Math.min(prop.maximum_snr_db, value)),
    distance_m: distance, wall_loss_db: loss, walls: crossed, path_loss_db: pathLoss,
  };
}

export function positionAtTime(node, t) {
  const path = node.path;
  if (!path || !path.length) return [Number(node.position[0]), Number(node.position[1])];
  if (t <= path[0].time_ms) return [Number(path[0].position[0]), Number(path[0].position[1])];
  for (let i = 0; i + 1 < path.length; i++) {
    const l = path[i], r = path[i + 1];
    if (l.time_ms <= t && t <= r.time_ms) {
      const f = (t - l.time_ms) / (r.time_ms - l.time_ms);
      return [l.position[0] + (r.position[0] - l.position[0]) * f, l.position[1] + (r.position[1] - l.position[1]) * f];
    }
  }
  const last = path[path.length - 1];
  return [Number(last.position[0]), Number(last.position[1])];
}

export function isPresent(node, t, duration) {
  const intervals = node.presence === undefined ? [[0, duration]] : node.presence;
  return intervals.some(([start, end]) => start <= t && t < end);
}

// wmdcfg world._merge_nodes: mobility fields override layout fields, sorted by role.
export function mergeNodes(layout, mobility) {
  const nodes = new Map();
  for (const item of (layout && layout.nodes) || []) nodes.set(item.role, Object.assign({}, item));
  for (const moving of (mobility && mobility.nodes) || []) {
    const merged = Object.assign({}, nodes.get(moving.role) || {}, moving);
    if (!merged.kind) merged.kind = 'station';
    nodes.set(moving.role, merged);
  }
  return [...nodes.keys()].sort(pySortCompare).map((role) => nodes.get(role));
}

// Python sorts str by code point, which differs from localeCompare.
export function pySortCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Every role's position/presence at time t.
export function sceneAt(design, t, overrides = null) {
  const layout = design.layout, mobility = design.mobility;
  const duration = Number(mobility.duration_ms) || 0;
  const nodes = [];
  const byRole = {};
  for (const node of mergeNodes(layout, mobility)) {
    let position;
    try {
      position = overrides && overrides[node.role] ? overrides[node.role] : positionAtTime(node, t);
    } catch (_e) { continue; }
    if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) continue;
    const entry = {
      role: node.role, kind: node.kind || 'station', position,
      present: isPresent(node, t, duration), wired: node.backhaul === 'wired',
      gain: Object.fromEntries(BANDS.map((b) => [b, Number((node.tx_gain_db_by_band || {})[b] || 0)])),
      mobile: !!(node.path && node.path.length), node,
    };
    nodes.push(entry);
    byRole[node.role] = entry;
  }
  return {nodes, byRole, time_ms: t};
}

// Strongest present AP -> station downlink per station (viewer bestServing).
export function bestServing(scene, layout, band) {
  const prop = propagationOf(layout), walls = layout.walls || [];
  const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present);
  const best = {};
  for (const sta of scene.nodes) {
    if (sta.kind !== 'station' || !sta.present) continue;
    let choice = null;
    for (const ap of aps) {
      const link = linkSnr(prop, band, ap.position, sta.position, walls, ap.gain[band]);
      if (!choice || link.snr > choice.snr || (link.snr === choice.snr && ap.role < choice.ap)) {
        choice = {ap: ap.role, snr: link.snr, link};
      }
    }
    if (choice) best[sta.role] = choice;
  }
  return best;
}

// All links of one role at this instant: both directions, all bands.
export function linksFor(scene, layout, role) {
  const prop = propagationOf(layout), walls = layout.walls || [];
  const self = scene.byRole[role];
  if (!self) return [];
  const out = [];
  for (const peer of scene.nodes) {
    if (peer.role === role) continue;
    const apPair = self.kind === 'fronthaul_ap' && peer.kind === 'fronthaul_ap';
    if (self.kind === 'station' && peer.kind === 'station') continue;
    const both = self.present && peer.present;
    const down = {}, up = {};
    let geometry = null;
    for (const band of BANDS) {
      const d = linkSnr(prop, band, peer.position, self.position, walls, peer.gain[band]);
      const u = linkSnr(prop, band, self.position, peer.position, walls, self.gain[band]);
      down[band] = both ? d.snr : prop.minimum_snr_db;
      up[band] = both ? u.snr : prop.minimum_snr_db;
      geometry = d;
    }
    out.push({
      role: peer.role, kind: peer.kind, link_class: apPair ? 'backhaul' : 'fronthaul', present: peer.present,
      distance_m: geometry.distance_m, wall_loss_db: geometry.wall_loss_db, walls: geometry.walls,
      rx: down, tx: up,
    });
  }
  return out;
}

// Strongest mesh peer for each Wi-Fi extender (the viewer's thin floor dashes).
// A wired AP needs no Wi-Fi backhaul but can be the peer (the configurator of 28 September 2026).
export function meshPeers(scene, layout, band) {
  const prop = propagationOf(layout), walls = layout.walls || [];
  const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present);
  const result = {};
  for (const ap of aps) {
    if (ap.role === 'gateway' || ap.wired) continue;
    let best = null;
    for (const peer of aps) {
      if (peer.role === ap.role) continue;
      const link = linkSnr(prop, band, peer.position, ap.position, walls, peer.gain[band]);
      if (!best || link.snr > best.snr || (link.snr === best.snr && peer.role < best.role)) best = {role: peer.role, snr: link.snr};
    }
    if (best) result[ap.role] = best;
  }
  return result;
}

// Breadth-first predicted backhaul tree (weaker direction of each hop) from the
// roots on the controller's LAN: the gateway and every wired AP.
export function backhaulTree(scene, layout, band, threshold = 20) {
  const prop = propagationOf(layout), walls = layout.walls || [];
  const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present && !n.role.startsWith('pod_'));
  const roots = aps.filter((n) => n.role === 'gateway' || n.wired);
  const edges = [];
  if (!roots.length) return edges;
  const reached = new Set(roots.map((n) => n.role));
  let frontier = roots;
  while (frontier.length) {
    const next = [];
    for (const parent of frontier) {
      const candidates = [];
      for (const child of aps) {
        if (reached.has(child.role)) continue;
        const a = linkSnr(prop, band, parent.position, child.position, walls).snr;
        const b = linkSnr(prop, band, child.position, parent.position, walls).snr;
        const value = Math.min(a, b);
        if (value >= threshold) candidates.push({child, value});
      }
      for (const {child, value} of candidates) {
        if (reached.has(child.role)) continue;
        reached.add(child.role);
        edges.push({parent: parent.role, child: child.role, snr: value});
        next.push(child);
      }
    }
    frontier = next;
  }
  for (const ap of aps) {
    if (reached.has(ap.role)) continue;
    let best = null;
    for (const peer of aps) {
      if (peer.role === ap.role) continue;
      const value = Math.min(linkSnr(prop, band, peer.position, ap.position, walls).snr,
        linkSnr(prop, band, ap.position, peer.position, walls).snr);
      if (!best || value > best.snr) best = {parent: peer.role, child: ap.role, snr: value, weak: true};
    }
    if (best) edges.push(best);
  }
  return edges;
}

// Best fronthaul SNR over a floor grid (row-major, row 0 at y = 0).
export function coverageGrid(layout, scene, band, cols, rows) {
  const prop = propagationOf(layout), walls = layout.walls || [];
  const W = Number(layout.space.width_m), H = Number(layout.space.height_m);
  const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present);
  const values = new Float32Array(cols * rows).fill(prop.minimum_snr_db);
  const owner = new Int16Array(cols * rows).fill(-1);
  const cw = W / cols, ch = H / rows;
  const d0 = prop.reference_distance_m, n10 = 10 * prop.path_loss_exponent;
  aps.forEach((ap, index) => {
    const ref = Number(prop.reference_snr_db_by_band[band]) + ap.gain[band];
    const [ax, ay] = ap.position;
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * ch;
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cw;
        const d = Math.hypot(x - ax, y - ay);
        let v = ref - n10 * Math.log10(Math.max(d, d0) / d0);
        if (walls.length) v -= wallLoss(ap.position, [x, y], walls);
        v = Math.max(prop.minimum_snr_db, Math.min(prop.maximum_snr_db, v));
        const k = j * cols + i;
        if (v > values[k]) { values[k] = v; owner[k] = index; }
      }
    }
  });
  return {values, owner, cols, rows, cw, ch, aps: aps.map((a) => a.role)};
}

export function coverageStats(values, target = 30) {
  const n = values.length;
  if (!n) return null;
  const sorted = Float32Array.from(values).sort();
  let sum = 0, cov = 0, fair = 0, holes = 0;
  for (const v of values) { sum += v; if (v >= target) cov++; if (v >= 16) fair++; if (v < 10) holes++; }
  return {
    mean: sum / n, median: sorted[Math.floor(n / 2)], p10: sorted[Math.floor(0.1 * (n - 1))],
    coverage_pct: 100 * cov / n, fair_pct: 100 * fair / n, holes_pct: 100 * holes / n,
  };
}

// ---- the viewer's 10-segment signal meter (signal-meter.js) ----------------
export const signal = Object.freeze({
  colors: Object.freeze({red: '#dc2626', yellow: '#eab308', green: '#15803d', grey: '#d1d5db'}),
  segmentCount: 10,
  noiseFloorDbm: -91,
  rssiLevel(rssi) {
    if (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi < -110 || rssi > 0) return 0;
    return Math.max(1, Math.min(10, Math.floor((rssi + 90) / 5) + 1));
  },
  snrLevel(snr) { return typeof snr === 'number' && Number.isFinite(snr) ? this.rssiLevel(snr - 91) : 0; },
  segmentColor(index, level) {
    if (index < 0 || index >= 10 || index >= level) return this.colors.grey;
    return index < 3 ? this.colors.red : index < 7 ? this.colors.yellow : this.colors.green;
  },
  snrColor(snr) { const level = this.snrLevel(snr); return this.segmentColor(level - 1, level); },
});

// Continuous heatmap colour (red -> amber -> green), same anchors as the meter.
export function heatColor(snr) {
  const stops = [[-20, [120, 20, 20]], [5, [220, 38, 38]], [16, [234, 179, 8]], [36, [21, 128, 61]], [60, [10, 90, 45]]];
  if (snr <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (snr <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const f = (snr - a) / (b - a);
      return ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
    }
  }
  return stops[stops.length - 1][1];
}

// ---- role naming (viewer) --------------------------------------------------
export function shortRole(role) {
  if (role === 'gateway') return 'gw';
  if (role.startsWith('extender_')) return 'e' + role.slice(9);
  if (role.startsWith('sta_mobile_')) return 'm' + role.slice(11);
  if (role.startsWith('sta_static_')) return 's' + role.slice(11);
  return role;
}

export function displayRole(role) {
  if (role === 'gateway') return 'Agent-1';
  if (role.startsWith('extender_')) return 'Extender-' + role.slice(9);
  return shortRole(role);
}

// Colour class exactly as the viewer derives it (role name based for clients).
export function kindClass(role, kind) {
  if (role === 'gateway') return 'gateway';
  if (kind === 'fronthaul_ap') return 'extender';
  return /mobile/.test(role) ? 'mobile' : 'static';
}

export const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export function nextRole(existing, kind, {mobile = false, lab = true} = {}) {
  if (kind === 'fronthaul_ap') {
    if (!existing.has('gateway')) return 'gateway';
    let i = 1;
    while (existing.has('extender_' + i)) i++;
    return 'extender_' + i;
  }
  const prefix = mobile ? 'sta_mobile_' : 'sta_static_';
  for (let i = 1; i <= 10; i++) {
    const role = prefix + String(i).padStart(2, '0');
    if (!existing.has(role)) return role;
  }
  if (lab) {
    for (let i = 21; i <= 100; i++) {
      const role = 'sta_pool_' + String(i).padStart(3, '0');
      if (!existing.has(role)) return role;
    }
  }
  let i = 11;
  for (;;) {
    const role = prefix + String(i).padStart(2, '0');
    if (!existing.has(role)) return role;
    i++;
  }
}

// ---- small geometry helpers ------------------------------------------------
export function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return {t, point: [a[0] + t * dx, a[1] + t * dy], length: Math.sqrt(len2)};
}

export function round3(v) { return Math.round(v * 1000) / 1000; }
export function snapValue(v, step) { return step > 0 ? round3(Math.round(v / step) * step) : round3(v); }

export function pathLength(path) {
  let total = 0;
  for (let i = 1; i < (path || []).length; i++) {
    total += Math.hypot(path[i].position[0] - path[i - 1].position[0], path[i].position[1] - path[i - 1].position[1]);
  }
  return total;
}
