// Design edit operations. Each takes the design (mutated in place by the
// store's transaction) and keeps layout, mobility and builder metadata
// consistent: wall materials stay aligned with walls, renames and deletions
// reach band-steering, expectations and traffic phases, and every mobility
// node keeps a position or path as wmdcfg requires.

import {BANDS, mergeNodes, positionAtTime, round3, pathLength, nextRole, projectOnSegment} from './rfmodel.js';

export function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function roles(design) {
  return new Set(mergeNodes(design.layout, design.mobility).map((n) => n.role));
}

export function merged(design, role) {
  return mergeNodes(design.layout, design.mobility).find((n) => n.role === role) || null;
}

export function layoutNode(design, role) { return (design.layout.nodes || []).find((n) => n.role === role) || null; }
export function mobilityNode(design, role) { return (design.mobility.nodes || []).find((n) => n.role === role) || null; }

function materials(design) {
  design.builder = design.builder || {};
  const list = design.builder.wall_materials = design.builder.wall_materials || [];
  while (list.length < design.layout.walls.length) list.push('custom');
  list.length = design.layout.walls.length;
  return list;
}

// ---------------------------------------------------------------- walls
export function uniqueWallName(design, base) {
  const names = new Set((design.layout.walls || []).map((w) => w.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function addWall(design, start, end, material, lossDb, name) {
  design.layout.walls = design.layout.walls || [];
  materials(design);
  const wall = {
    name: name || uniqueWallName(design, `wall-${design.layout.walls.length + 1}`),
    start: [round3(start[0]), round3(start[1])], end: [round3(end[0]), round3(end[1])], loss_db: lossDb,
  };
  design.layout.walls.push(wall);
  design.builder.wall_materials.push(material);
  return design.layout.walls.length - 1;
}

export function deleteWall(design, index) {
  materials(design);
  design.layout.walls.splice(index, 1);
  design.builder.wall_materials.splice(index, 1);
}

export function setWallMaterial(design, index, material, lossDb) {
  materials(design);
  design.builder.wall_materials[index] = material;
  if (lossDb !== null && lossDb !== undefined) design.layout.walls[index].loss_db = lossDb;
}

export function moveWall(design, index, dx, dy) {
  const wall = design.layout.walls[index];
  wall.start = [round3(wall.start[0] + dx), round3(wall.start[1] + dy)];
  wall.end = [round3(wall.end[0] + dx), round3(wall.end[1] + dy)];
}

// Cut a door-sized gap centred on a point of the wall: one wall becomes two.
export function cutGap(design, index, point, width) {
  const wall = design.layout.walls[index];
  const {t, length} = projectOnSegment(point, wall.start, wall.end);
  const half = width / 2 / length;
  const t0 = Math.max(0, t - half), t1 = Math.min(1, t + half);
  const at = (f) => [round3(wall.start[0] + (wall.end[0] - wall.start[0]) * f), round3(wall.start[1] + (wall.end[1] - wall.start[1]) * f)];
  const mats = materials(design);
  const material = mats[index];
  const pieces = [];
  if (t0 * length > 0.05) pieces.push([wall.start, at(t0)]);
  if ((1 - t1) * length > 0.05) pieces.push([at(t1), wall.end]);
  design.layout.walls.splice(index, 1);
  mats.splice(index, 1);
  const base = wall.name || `wall-${index + 1}`;
  pieces.forEach(([a, b], k) => {
    const copy = Object.assign({}, wall, {start: a, end: b, name: pieces.length > 1 ? uniqueWallName(design, `${base}-${'ab'[k]}`) : base});
    design.layout.walls.splice(index + k, 0, copy);
    mats.splice(index + k, 0, material);
  });
  return pieces.length;
}

export function splitWall(design, index) {
  const wall = design.layout.walls[index];
  const mid = [round3((wall.start[0] + wall.end[0]) / 2), round3((wall.start[1] + wall.end[1]) / 2)];
  const mats = materials(design);
  const second = Object.assign({}, wall, {start: mid, end: wall.end.slice(), name: uniqueWallName(design, (wall.name || 'wall') + '-b')});
  wall.end = mid;
  design.layout.walls.splice(index + 1, 0, second);
  mats.splice(index + 1, 0, mats[index]);
}

// A parallel copy offset by `offset` metres: the way to model a double wall.
export function duplicateParallel(design, index, offset = 0.2) {
  const wall = design.layout.walls[index];
  const dx = wall.end[0] - wall.start[0], dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * offset, ny = dx / len * offset;
  const W = design.layout.space.width_m, H = design.layout.space.height_m;
  const clampP = (p) => [Math.min(W, Math.max(0, round3(p[0]))), Math.min(H, Math.max(0, round3(p[1])))];
  const copy = Object.assign({}, clone(wall), {
    name: uniqueWallName(design, (wall.name || 'wall') + '-2'),
    start: clampP([wall.start[0] + nx, wall.start[1] + ny]), end: clampP([wall.end[0] + nx, wall.end[1] + ny]),
  });
  const mats = materials(design);
  design.layout.walls.splice(index + 1, 0, copy);
  mats.splice(index + 1, 0, mats[index]);
  return index + 1;
}

export function roomBox(design, a, b, material, lossDb, prefix = 'room') {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const base = uniqueWallName(design, prefix);
  const sides = [['s', [x0, y0], [x1, y0]], ['e', [x1, y0], [x1, y1]], ['n', [x1, y1], [x0, y1]], ['w', [x0, y1], [x0, y0]]];
  const indices = [];
  for (const [side, p, q] of sides) indices.push(addWall(design, p, q, material, lossDb, `${base}-${side}`));
  return indices;
}

// ---------------------------------------------------------------- nodes
export function addNode(design, {role, kind, position, mobile = false, lab = true}) {
  const existing = roles(design);
  const name = role || nextRole(existing, kind, {mobile, lab});
  const p = [round3(position[0]), round3(position[1])];
  if (mobile) {
    design.mobility.nodes.push({role: name, path: [{time_ms: 0, position: p}]});
  } else {
    design.layout.nodes.push({role: name, kind, position: p});
  }
  return name;
}

export function deleteNode(design, role) {
  design.layout.nodes = design.layout.nodes.filter((n) => n.role !== role);
  design.mobility.nodes = design.mobility.nodes.filter((n) => n.role !== role);
  const m = design.mobility;
  if (m.band_steering) {
    delete m.band_steering[role];
    if (!Object.keys(m.band_steering).length) delete m.band_steering;
  }
  if (m.band_steering_expectations) {
    for (const item of m.band_steering_expectations) {
      delete item.roles[role];
      for (const [sta, exp] of Object.entries(item.roles)) if (exp.ap === role) delete item.roles[sta];
    }
    m.band_steering_expectations = m.band_steering_expectations.filter((item) => Object.keys(item.roles).length);
    if (!m.band_steering_expectations.length) delete m.band_steering_expectations;
  }
  if (m.traffic_experiment) {
    m.traffic_experiment.phases = m.traffic_experiment.phases.filter((p) => p.role !== role);
    if (!m.traffic_experiment.phases.length) delete m.traffic_experiment;
  }
  if (m.ap_expectations) {
    for (const item of m.ap_expectations) {
      delete item.roles[role];
      for (const [sta, ap] of Object.entries(item.roles)) if (ap === role) delete item.roles[sta];
    }
    m.ap_expectations = m.ap_expectations.filter((item) => Object.keys(item.roles).length);
    if (!m.ap_expectations.length) delete m.ap_expectations;
  }
}

export function renameRole(design, from, to) {
  if (from === to) return;
  if (roles(design).has(to)) throw new Error(`role ${to} already exists`);
  for (const n of design.layout.nodes) if (n.role === from) n.role = to;
  for (const n of design.mobility.nodes) if (n.role === from) n.role = to;
  const m = design.mobility;
  if (m.band_steering && m.band_steering[from]) { m.band_steering[to] = m.band_steering[from]; delete m.band_steering[from]; }
  for (const item of m.band_steering_expectations || []) {
    if (item.roles[from]) { item.roles[to] = item.roles[from]; delete item.roles[from]; }
    for (const exp of Object.values(item.roles)) if (exp.ap === from) exp.ap = to;
  }
  for (const phase of (m.traffic_experiment || {}).phases || []) if (phase.role === from) phase.role = to;
  for (const item of m.ap_expectations || []) {
    if (item.roles[from]) { item.roles[to] = item.roles[from]; delete item.roles[from]; }
    for (const [sta, ap] of Object.entries(item.roles)) if (ap === from) item.roles[sta] = to;
  }
}

// Move a role to p. With a path, time t selects the keyframe: an existing
// waypoint at t moves, otherwise a new waypoint is inserted at t.
export function moveNode(design, role, p, t = 0, {translatePath = false} = {}) {
  const q = [round3(p[0]), round3(p[1])];
  const mob = mobilityNode(design, role);
  const lay = layoutNode(design, role);
  if (mob && mob.path && mob.path.length) {
    if (translatePath) {
      const current = positionAtTime(mob, t);
      const dx = q[0] - current[0], dy = q[1] - current[1];
      for (const w of mob.path) w.position = [round3(w.position[0] + dx), round3(w.position[1] + dy)];
      if (lay && lay.position) lay.position = mob.path[0].position.slice();
      return;
    }
    setKeyframe(mob, Math.round(t), q);
    if (lay && lay.position && Math.round(t) === 0) lay.position = q.slice();
    return;
  }
  if (mob && mob.position) mob.position = q.slice();
  if (lay) lay.position = q.slice();
  if (!mob && !lay) throw new Error(`no role ${role}`);
}

export function setKeyframe(mob, t, q) {
  const path = mob.path;
  const existing = path.find((w) => w.time_ms === t);
  if (existing) { existing.position = q; return; }
  const index = path.findIndex((w) => w.time_ms > t);
  const waypoint = {time_ms: t, position: q};
  if (index < 0) path.push(waypoint); else path.splice(index, 0, waypoint);
}

// Give a role a path (keeps any layout node for its kind and static metadata).
export function ensurePath(design, role) {
  const node = merged(design, role);
  let mob = mobilityNode(design, role);
  const start = positionAtTime(node, 0);
  if (!mob) {
    mob = {role};
    if (!layoutNode(design, role)) mob.kind = node.kind;
    design.mobility.nodes.push(mob);
  }
  if (!mob.path || !mob.path.length) {
    mob.path = [{time_ms: 0, position: [round3(start[0]), round3(start[1])]}];
    delete mob.position;
  }
  if (node.kind === 'fronthaul_ap' && !mob.kind) mob.kind = 'fronthaul_ap';
  return mob;
}

export function removePath(design, role, t = 0) {
  const mob = mobilityNode(design, role);
  if (!mob || !mob.path) return;
  const p = positionAtTime(mob, t).map(round3);
  delete mob.path;
  const lay = layoutNode(design, role);
  if (lay) {
    lay.position = p;
    if (mob.presence === undefined && !mob.tx_gain_db_by_band && (!mob.kind || mob.kind === lay.kind)) {
      design.mobility.nodes = design.mobility.nodes.filter((n) => n !== mob);
    } else {
      mob.position = p;
    }
  } else {
    mob.position = p;
  }
}

export function appendWaypoint(design, role, p, speed) {
  const mob = ensurePath(design, role);
  const last = mob.path[mob.path.length - 1];
  const dist = Math.hypot(p[0] - last.position[0], p[1] - last.position[1]);
  const dt = Math.max(100, Math.ceil(dist / Math.max(0.05, speed) * 10) * 100);
  mob.path.push({time_ms: last.time_ms + dt, position: [round3(p[0]), round3(p[1])]});
  return mob.path.length - 1;
}

// Re-time a path at constant speed, keeping dwell (repeated position) durations.
export function retimePath(design, role, speed, startMs = 0) {
  const mob = mobilityNode(design, role);
  if (!mob || !mob.path) return;
  const path = mob.path;
  const out = [{time_ms: 0, position: path[0].position}];
  let t = startMs;
  if (startMs > 0) out.push({time_ms: startMs, position: path[0].position});
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dist = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1]);
    const dt = dist < 1e-9 ? (b.time_ms - a.time_ms) : Math.max(100, Math.ceil(dist / speed * 10) * 100);
    t += dt;
    out.push({time_ms: t, position: b.position});
  }
  mob.path = out.filter((w, i, arr) => i === 0 || w.time_ms > arr[i - 1].time_ms);
}

export function setPresence(design, role, intervals) {
  let mob = mobilityNode(design, role);
  const node = merged(design, role);
  if (!mob) {
    mob = {role, position: positionAtTime(node, 0).map(round3)};
    if (node.kind === 'fronthaul_ap') mob.kind = 'fronthaul_ap';
    design.mobility.nodes.push(mob);
  }
  if (intervals === null) delete mob.presence; else mob.presence = intervals;
  cleanupMobilityNode(design, role);
}

export function setGain(design, role, gains) {
  const target = mobilityNode(design, role) && (mobilityNode(design, role).tx_gain_db_by_band || !layoutNode(design, role))
    ? mobilityNode(design, role) : layoutNode(design, role) || mobilityNode(design, role);
  const clean = {};
  let any = false;
  for (const b of BANDS) { const v = Number(gains[b] || 0); clean[b] = v; if (v) any = true; }
  if (any) target.tx_gain_db_by_band = clean; else delete target.tx_gain_db_by_band;
}

export function setWired(design, role, wired) {
  const lay = layoutNode(design, role);
  if (!lay) throw new Error('wired backhaul is a layout property: the AP must exist in the layout');
  if (wired) lay.backhaul = 'wired'; else delete lay.backhaul;
}

// A mobility node that only repeats its layout node can go.
export function cleanupMobilityNode(design, role) {
  const mob = mobilityNode(design, role), lay = layoutNode(design, role);
  if (!mob || !lay) return;
  const keys = Object.keys(mob).filter((k) => k !== 'role');
  const redundant = keys.every((k) => (k === 'kind' && mob.kind === lay.kind) ||
    (k === 'position' && JSON.stringify(mob.position) === JSON.stringify(lay.position)));
  if (redundant) design.mobility.nodes = design.mobility.nodes.filter((n) => n !== mob);
}

// ---------------------------------------------------------------- room
export function resizeRoom(design, width, height, mode = 'extend') {
  const W0 = Number(design.layout.space.width_m), H0 = Number(design.layout.space.height_m);
  if (mode === 'scale') {
    const sx = width / W0, sy = height / H0;
    const s = (p) => [round3(p[0] * sx), round3(p[1] * sy)];
    for (const w of design.layout.walls) { w.start = s(w.start); w.end = s(w.end); }
    for (const n of design.layout.nodes) if (n.position) n.position = s(n.position);
    for (const n of design.mobility.nodes) {
      if (n.position) n.position = s(n.position);
      for (const w of n.path || []) w.position = s(w.position);
    }
  }
  design.layout.space.width_m = width;
  design.layout.space.height_m = height;
}

// Smallest room that still contains every wall end, node and waypoint.
export function contentBounds(design) {
  let maxX = 0, maxY = 0;
  const see = (p) => { maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); };
  for (const w of design.layout.walls) { see(w.start); see(w.end); }
  for (const n of design.layout.nodes) if (n.position) see(n.position);
  for (const n of design.mobility.nodes) { if (n.position) see(n.position); for (const w of n.path || []) see(w.position); }
  return {maxX, maxY};
}

export function translateAll(design, dx, dy) {
  const t = (p) => [round3(p[0] + dx), round3(p[1] + dy)];
  for (const w of design.layout.walls) { w.start = t(w.start); w.end = t(w.end); }
  for (const n of design.layout.nodes) if (n.position) n.position = t(n.position);
  for (const n of design.mobility.nodes) { if (n.position) n.position = t(n.position); for (const w of n.path || []) w.position = t(w.position); }
}

// Change the script duration; paths/presences/pauses/traffic beyond it are trimmed.
export function setDuration(design, durationMs) {
  const m = design.mobility;
  m.duration_ms = durationMs;
  for (const n of m.nodes) {
    if (n.path) {
      const inside = n.path.filter((w) => w.time_ms <= durationMs);
      if (inside.length < n.path.length && inside.length) {
        const cut = positionAtTime(n, durationMs).map(round3);
        if (inside[inside.length - 1].time_ms < durationMs) inside.push({time_ms: durationMs, position: cut});
      }
      n.path = inside.length ? inside : [n.path[0]];
    }
    if (n.presence) {
      n.presence = n.presence.filter(([s]) => s < durationMs).map(([s, e]) => [s, Math.min(e, durationMs)]);
    }
  }
  if (m.pause_at_ms) {
    m.pause_at_ms = m.pause_at_ms.filter((t) => t > 0 && t < durationMs);
    if (!m.pause_at_ms.length) delete m.pause_at_ms;
  }
  dropOrphanApExpectations(design);
}

// ap_expectations may only sit at 'final' or at an existing checkpoint.
export function dropOrphanApExpectations(design) {
  const m = design.mobility;
  if (!m.ap_expectations) return;
  const pauses = new Set(m.pause_at_ms || []);
  m.ap_expectations = m.ap_expectations.filter((item) => item.at === 'final' || pauses.has(item.at));
  if (!m.ap_expectations.length) delete m.ap_expectations;
}

export function pathSummary(node) {
  if (!node || !node.path || node.path.length < 2) return null;
  const length = pathLength(node.path);
  const time = node.path[node.path.length - 1].time_ms - node.path[0].time_ms;
  return {waypoints: node.path.length, length_m: length, duration_ms: time, speed: time ? length / (time / 1000) : 0};
}

// ---------------------------------------------------------------- presence spans
// Mark [start, end) present or absent in a role's intervals (undefined = always).
export function presenceSpan(intervals, start, end, present, duration) {
  const base = intervals === undefined ? [[0, duration]] : intervals.map((i) => i.slice());
  const marks = new Set([0, duration, start, end]);
  for (const [s, e] of base) { marks.add(s); marks.add(e); }
  const points = [...marks].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  const on = (t) => (t >= start && t < end) ? present : base.some(([s, e]) => s <= t && t < e);
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i], e = points[i + 1];
    if (e <= s || !on(s)) continue;
    if (out.length && out[out.length - 1][1] === s) out[out.length - 1][1] = e; else out.push([s, e]);
  }
  if (out.length === 1 && out[0][0] === 0 && out[0][1] === duration) return undefined;
  return out;
}

export function setPresenceFrom(design, role, t, present) {
  const node = merged(design, role);
  const duration = Number(design.mobility.duration_ms);
  const next = presenceSpan(node.presence, Math.round(t), duration, present, duration);
  setPresence(design, role, next === undefined ? null : next);
}
