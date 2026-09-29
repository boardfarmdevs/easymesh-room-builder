// Pointer and keyboard interaction on the 3D stage: selection, dragging,
// drawing walls and rooms, cutting doors, placing devices, drawing paths and
// measuring. Drags are previewed (state.preview) and committed once on
// release, so every gesture is a single undo step.

import * as rf from './rfmodel.js';
import * as ops from './ops.js';
import {state, transact, select, setTool, emit, on} from './store.js';
import {TOOL_HINTS, VIEW_HINTS} from './tips.js';

const WALL_TOLERANCE = 0.05;   // m: closer than this, a wall ignores the device (no proper crossing)

export function initTools(room, stage, ui) {
  const canvas = room.renderer.domElement;
  let gesture = null;
  let chain = null;        // wall drawing: {points: [[x,y]...], typed: ''}
  let pathRole = null;     // path drawing target
  let pathAdded = 0;       // waypoints added since the target was chosen
  let measure = null;      // {a, b, locked}
  let lastClick = 0;

  const W = () => Number(state.design.layout.space.width_m);
  const H = () => Number(state.design.layout.space.height_m);
  const clampRoom = (p) => [Math.min(W(), Math.max(0, p[0])), Math.min(H(), Math.max(0, p[1]))];
  const preview = (patch) => { state.preview = patch ? Object.assign({}, state.preview || {}, patch) : null; room.update(); };
  const clearPreview = (...keys) => {
    if (!state.preview) return;
    for (const k of keys) delete state.preview[k];
    if (!Object.keys(state.preview).length) state.preview = null;
    room.update();
  };

  // ---- snapping -----------------------------------------------------------------------
  function snap(raw, {alt = false, shift = false, from = null, walls = true} = {}) {
    if (!raw) return null;
    let p = raw.slice();
    let kind = 'grid';
    if (alt) return {point: clampRoom([rf.round3(p[0]), rf.round3(p[1])]), kind: 'free'};
    const tolerance = Math.max(0.12, 14 / (room.mode === 'plan' ? room.planScale : 40));
    if (walls) {
      let bestEnd = null;
      for (const w of state.design.layout.walls || []) {
        for (const q of [w.start, w.end]) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < tolerance * 2.2 && (!bestEnd || d < bestEnd.d)) bestEnd = {d, q};
        }
      }
      if (bestEnd) return {point: bestEnd.q.slice(), kind: 'end'};
      for (const edge of [[0, 0, W(), 0], [W(), 0, W(), H()], [0, H(), W(), H()], [0, 0, 0, H()]]) {
        const pr = rf.projectOnSegment(p, [edge[0], edge[1]], [edge[2], edge[3]]);
        if (Math.hypot(pr.point[0] - p[0], pr.point[1] - p[1]) < tolerance) { p = pr.point; kind = 'edge'; }
      }
    }
    if (shift && from) {
      const dx = p[0] - from[0], dy = p[1] - from[1];
      const len = rf.snapValue(Math.hypot(dx, dy), state.snap);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      return {point: clampRoom([rf.round3(from[0] + Math.cos(angle) * len), rf.round3(from[1] + Math.sin(angle) * len)]), kind: 'angle'};
    }
    if (walls && kind !== 'edge') {
      for (const w of state.design.layout.walls || []) {
        const pr = rf.projectOnSegment(p, w.start, w.end);
        if (Math.hypot(pr.point[0] - p[0], pr.point[1] - p[1]) < tolerance * 0.8) {
          return {point: clampRoom(pr.point.map(rf.round3)), kind: 'on-wall'};
        }
      }
    }
    return {point: clampRoom([rf.snapValue(p[0], state.snap), rf.snapValue(p[1], state.snap)]), kind};
  }

  // Keep a device a few centimetres off any wall line so the wall still counts.
  function offWalls(p) {
    let q = p.slice();
    let nudged = false;
    for (let pass = 0; pass < 3; pass++) {
      for (const w of state.design.layout.walls || []) {
        const pr = rf.projectOnSegment(q, w.start, w.end);
        const d = Math.hypot(q[0] - pr.point[0], q[1] - pr.point[1]);
        if (d < WALL_TOLERANCE) {
          const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1];
          const len = Math.hypot(dx, dy) || 1;
          let nx = -dy / len, ny = dx / len;
          if (d > 1e-9 && ((q[0] - pr.point[0]) * nx + (q[1] - pr.point[1]) * ny) < 0) { nx = -nx; ny = -ny; }
          q = clampRoom([rf.round3(pr.point[0] + nx * 0.1), rf.round3(pr.point[1] + ny * 0.1)]);
          nudged = true;
        }
      }
    }
    return {point: q, nudged};
  }

  function devicePoint(raw, alt) {
    const s = snap(raw, {alt, walls: false});
    if (!s) return null;
    const off = offWalls(s.point);
    return off;
  }

  // ---- hover / readout --------------------------------------------------------------
  function readout(point) {
    const el = document.getElementById('cursorReadout');
    if (!point || !state.design) { el.textContent = ''; return; }
    const scene = room.current;
    let text = `x ${point[0].toFixed(2)} m · y ${point[1].toFixed(2)} m`;
    if (scene && point[0] >= 0 && point[1] >= 0 && point[0] <= W() && point[1] <= H()) {
      const prop = rf.propagationOf(state.design.layout);
      let best = null;
      for (const ap of scene.nodes) {
        if (ap.kind !== 'fronthaul_ap' || !ap.present) continue;
        const l = rf.linkSnr(prop, state.band, ap.position, point, state.design.layout.walls, ap.gain[state.band]);
        if (!best || l.snr > best.snr) best = {role: ap.role, snr: l.snr};
      }
      if (best) text += ` · best ${state.band} GHz here: ${rf.displayRole(best.role)} ${best.snr} dB`;
    }
    el.textContent = text;
  }

  function setHover(hit) {
    const before = JSON.stringify(state.hover);
    state.hover = hit && hit.role ? {role: hit.role} : hit && hit.wall !== undefined ? {wall: hit.wall} : null;
    stage.classList.toggle('hovering', !!hit && state.tool === 'select');
    if (JSON.stringify(state.hover) !== before) room.update();
  }

  // ---- gestures -------------------------------------------------------------------------
  canvas.addEventListener('pointerdown', (e) => {
    ui.hideMenu();
    canvas.focus({preventScroll: true});
    if (!state.design) return;
    const start = {x: e.clientX, y: e.clientY};
    if (e.button === 1 || (e.button === 0 && room.mode === 'walk')) {
      gesture = {type: e.button === 1 ? 'pan' : 'look', ...start, moved: false};
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const floor = room.floorPoint(e.clientX, e.clientY);
    if (state.tool === 'select') {
      const hit = e.shiftKey ? null : room.pick(e.clientX, e.clientY);
      if (hit && hit.type === 'handle') {
        gesture = {type: 'wallEnd', wall: hit.wall, end: hit.end, ...start, moved: false};
      } else if (hit && hit.type === 'waypoint') {
        select({type: 'waypoint', role: hit.role, index: hit.index});
        gesture = {type: 'waypoint', role: hit.role, index: hit.index, ...start, moved: false};
      } else if (hit && hit.type === 'node') {
        if (!(state.selection && state.selection.role === hit.role && state.selection.type === 'node')) select({type: 'node', role: hit.role});
        const entry = room.current && room.current.byRole[hit.role];
        gesture = {type: 'node', role: hit.role, origin: entry ? entry.position.slice() : floor, floor, ...start, moved: false};
      } else if (hit && hit.type === 'wall') {
        select({type: 'wall', index: hit.wall});
        gesture = {type: 'wall', wall: hit.wall, floor, ...start, moved: false};
      } else {
        gesture = {type: e.shiftKey || room.mode === 'plan' ? 'pan' : 'orbit', ...start, moved: false, clickEmpty: true};
      }
    } else if (state.tool === 'room' && floor) {
      const s = snap(floor, {alt: e.altKey});
      gesture = {type: 'rect', a: s.point, ...start, moved: false};
    } else {
      gesture = {type: 'click', floor, ...start, moved: false, shift: e.shiftKey, alt: e.altKey};
    }
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.design) return;
    const floor = room.floorPoint(e.clientX, e.clientY);
    readout(floor);
    if (!gesture) {
      hoverMove(e, floor);
      return;
    }
    // Camera drags use the step since the previous pointer event, exactly like
    // the reference viewer (never movementX, never the total since pointerdown).
    const stepX = e.clientX - (gesture.lastX ?? gesture.x), stepY = e.clientY - (gesture.lastY ?? gesture.y);
    gesture.lastX = e.clientX;
    gesture.lastY = e.clientY;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    const beyondClick = Math.abs(dx) + Math.abs(dy) > 3;
    if (gesture.type === 'orbit' || gesture.type === 'look' || gesture.type === 'pan') {
      if (beyondClick) gesture.moved = true;
      (gesture.type === 'pan' ? room.panBy.bind(room) : room.orbitBy.bind(room))(stepX, stepY);
      if (gesture.moved) stage.classList.add('dragging');
      return;
    }
    if (!gesture.moved && !beyondClick) return;
    gesture.moved = true;
    switch (gesture.type) {
      case 'click':
        // a tool click that turned into a drag moves the camera from here on
        gesture.type = room.mode === 'plan' ? 'pan' : 'orbit';
        (gesture.type === 'pan' ? room.panBy.bind(room) : room.orbitBy.bind(room))(stepX, stepY);
        stage.classList.add('dragging');
        break;
      case 'node': {
        if (!floor || !gesture.floor) break;
        stage.classList.add('dragging');
        const raw = [gesture.origin[0] + floor[0] - gesture.floor[0], gesture.origin[1] + floor[1] - gesture.floor[1]];
        const p = devicePoint(raw, e.altKey);
        gesture.target = p.point;
        gesture.translate = e.altKey;
        preview({positions: {[gesture.role]: p.point}});
        ui.dragInfo(`${gesture.role} → (${p.point[0].toFixed(2)}, ${p.point[1].toFixed(2)})${p.nudged ? ' · kept off the wall line' : ''}`);
        break;
      }
      case 'wall': {
        if (!floor || !gesture.floor) break;
        stage.classList.add('dragging');
        const w = state.design.layout.walls[gesture.wall];
        let ddx = rf.snapValue(floor[0] - gesture.floor[0], e.altKey ? 0 : state.snap);
        let ddy = rf.snapValue(floor[1] - gesture.floor[1], e.altKey ? 0 : state.snap);
        const xs = [w.start[0] + ddx, w.end[0] + ddx], ys = [w.start[1] + ddy, w.end[1] + ddy];
        if (Math.min(...xs) < 0) ddx -= Math.min(...xs); if (Math.max(...xs) > W()) ddx -= Math.max(...xs) - W();
        if (Math.min(...ys) < 0) ddy -= Math.min(...ys); if (Math.max(...ys) > H()) ddy -= Math.max(...ys) - H();
        gesture.delta = [ddx, ddy];
        preview({ghostWalls: [{start: [w.start[0] + ddx, w.start[1] + ddy], end: [w.end[0] + ddx, w.end[1] + ddy],
          label: `Δ ${ddx.toFixed(2)}, ${ddy.toFixed(2)} m`}]});
        break;
      }
      case 'wallEnd': {
        if (!floor) break;
        stage.classList.add('dragging');
        const w = state.design.layout.walls[gesture.wall];
        const other = gesture.end === 'start' ? w.end : w.start;
        const s = snap(floor, {alt: e.altKey, shift: e.shiftKey, from: other});
        gesture.point = s.point;
        const seg = gesture.end === 'start' ? {start: s.point, end: other} : {start: other, end: s.point};
        const len = Math.hypot(seg.end[0] - seg.start[0], seg.end[1] - seg.start[1]);
        preview({ghostWalls: [{...seg, label: `${len.toFixed(2)} m`}], snap: {point: s.point, kind: s.kind}});
        break;
      }
      case 'waypoint': {
        if (!floor) break;
        stage.classList.add('dragging');
        const p = devicePoint(floor, e.altKey).point;
        gesture.point = p;
        const node = ops.merged(state.design, gesture.role);
        const path = node.path.map((w, i) => i === gesture.index ? {time_ms: w.time_ms, position: p} : w);
        const at = rf.positionAtTime({path}, state.timeMs);
        preview({positions: {[gesture.role]: at}, snap: {point: p, kind: 'grid'}});
        break;
      }
      case 'rect': {
        if (!floor) break;
        const s = snap(floor, {alt: e.altKey});
        gesture.b = s.point;
        preview({rect: {a: gesture.a, b: s.point}, snap: {point: s.point, kind: s.kind}});
        break;
      }
      default: break;
    }
  });

  function hoverMove(e, floor) {
    const tool = state.tool;
    if (room.mode === 'walk') return;
    if (tool === 'select') {
      setHover(room.pick(e.clientX, e.clientY));
      return;
    }
    stage.classList.remove('hovering');
    if (!floor) return;
    if (tool === 'wall') {
      const from = chain && chain.points.length ? chain.points[chain.points.length - 1] : null;
      const s = snap(floor, {alt: e.altKey, shift: e.shiftKey, from});
      chain = chain || {points: [], typed: ''};
      chain.cursor = s.point;
      chain.shift = e.shiftKey;
      const ghosts = [];
      if (from) {
        let end = s.point;
        if (chain.typed) end = typedEnd(from, s.point, chain.typed);
        const len = Math.hypot(end[0] - from[0], end[1] - from[1]);
        const angle = Math.atan2(end[1] - from[1], end[0] - from[0]) * 180 / Math.PI;
        ghosts.push({start: from, end, label: `${chain.typed ? chain.typed + ' ⏎' : len.toFixed(2) + ' m'} · ${angle.toFixed(0)}°`});
      }
      preview({ghostWalls: ghosts, snap: {point: s.point, kind: s.kind}});
    } else if (tool === 'ap' || tool === 'client') {
      const p = devicePoint(floor, e.altKey).point;
      const mobile = tool === 'client' && e.shiftKey;
      const kind = tool === 'ap' ? 'fronthaul_ap' : 'station';
      const role = rf.nextRole(ops.roles(state.design), kind, {mobile, lab: state.design.profile !== 'configurator'});
      preview({cursor: {point: p, kind, label: tool === 'ap' ? rf.displayRole(role) : rf.shortRole(role)}});
    } else if (tool === 'door') {
      const hit = room.pick(e.clientX, e.clientY);
      if (hit && hit.type === 'wall') {
        const w = state.design.layout.walls[hit.wall];
        const pr = rf.projectOnSegment(floor, w.start, w.end);
        const dx = (w.end[0] - w.start[0]) / pr.length, dy = (w.end[1] - w.start[1]) / pr.length;
        const half = state.doorWidth / 2;
        preview({ghostWalls: [{start: [pr.point[0] - dx * half, pr.point[1] - dy * half], end: [pr.point[0] + dx * half, pr.point[1] + dy * half],
          color: 0xd65f27, label: `door ${state.doorWidth} m`}]});
      } else clearPreview('ghostWalls');
    } else if (tool === 'measure') {
      const s = snap(floor, {alt: e.altKey});
      if (measure && !measure.locked) { measure.b = s.point; showMeasure(); }
      preview({snap: {point: s.point, kind: s.kind}});
    } else if (tool === 'path') {
      const node = pathRole && ops.merged(state.design, pathRole);
      if (node && node.path && node.path.length) {
        const last = node.path[node.path.length - 1].position;
        const p = devicePoint(floor, e.altKey).point;
        const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
        preview({ghostWalls: [], measure: {a: last, b: p, label: `+${(d / state.walkSpeed).toFixed(1)} s at ${state.walkSpeed} m/s`}});
      } else {
        const hit = room.pick(e.clientX, e.clientY);
        stage.classList.toggle('hovering', !!(hit && hit.type === 'node'));
      }
    }
  }

  canvas.addEventListener('pointerup', (e) => {
    const g = gesture;
    gesture = null;
    stage.classList.remove('dragging');
    ui.dragInfo(null);
    if (!g) return;
    try {
      if (g.type === 'node' && g.moved && g.target) {
        const node = ops.merged(state.design, g.role);
        const keyframe = node.path && node.path.length && !g.translate;
        transact(keyframe ? `Keyframe ${g.role} at ${(state.timeMs / 1000).toFixed(1)} s` : `Move ${g.role}`,
          (d) => ops.moveNode(d, g.role, g.target, state.timeMs, {translatePath: g.translate}));
        clearPreview('positions');
        if (keyframe && state.timeMs > 0 && !node.path.some((w) => w.time_ms === Math.round(state.timeMs))) {
          ui.toast(`Added a waypoint for ${g.role} at ${(state.timeMs / 1000).toFixed(1)} s. Alt-drag moves the whole path.`);
        }
      } else if (g.type === 'wall' && g.moved && g.delta) {
        transact('Move wall', (d) => ops.moveWall(d, g.wall, g.delta[0], g.delta[1]));
        clearPreview('ghostWalls');
      } else if (g.type === 'wallEnd' && g.moved && g.point) {
        transact('Reshape wall', (d) => {
          const w = d.layout.walls[g.wall];
          const other = g.end === 'start' ? w.end : w.start;
          if (Math.hypot(other[0] - g.point[0], other[1] - g.point[1]) < 0.01) throw new Error('A wall needs two different ends');
          w[g.end] = g.point.map(rf.round3);
        });
        clearPreview('ghostWalls', 'snap');
      } else if (g.type === 'waypoint' && g.moved && g.point) {
        transact(`Move waypoint ${g.index + 1} of ${g.role}`, (d) => {
          const mob = ops.mobilityNode(d, g.role);
          mob.path[g.index].position = g.point.map(rf.round3);
          const lay = ops.layoutNode(d, g.role);
          if (g.index === 0 && lay) lay.position = g.point.map(rf.round3);
        });
        clearPreview('positions', 'snap');
      } else if (g.type === 'rect' && g.moved && g.b) {
        const [a, b] = [g.a, g.b];
        if (Math.abs(b[0] - a[0]) > 0.05 && Math.abs(b[1] - a[1]) > 0.05) {
          const {material, loss} = activeMaterial();
          transact('Add room box', (d) => ops.roomBox(d, a, b, material, loss));
          ui.toast(`Added 4 walls (${Math.abs(b[0] - a[0]).toFixed(2)} × ${Math.abs(b[1] - a[1]).toFixed(2)} m). Use the Door tool to cut doorways.`);
        }
        clearPreview('rect', 'snap');
      } else if (g.type === 'orbit' || g.type === 'pan') {
        if (!g.moved && g.clickEmpty) select(null);
      } else if (g.type === 'click' && !g.moved) {
        toolClick(e, g);
      }
    } catch (error) {
      ui.toast(error.message || String(error), true);
      state.preview = null;
      room.update();
    }
  });

  canvas.addEventListener('pointercancel', () => {
    gesture = null;
    state.preview = null;
    stage.classList.remove('dragging');
    room.update();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    room.zoomBy(e.deltaY, e.clientX, e.clientY);
  }, {passive: false});

  canvas.addEventListener('dblclick', (e) => {
    if (state.tool === 'wall') finishChain();
    else if (state.tool === 'path') finishPath();
    else if (state.tool === 'select') {
      const hit = room.pick(e.clientX, e.clientY);
      if (hit && hit.type === 'node') ui.focusProperties();
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.tool === 'wall' && chain && chain.points.length) { finishChain(); return; }
    if (state.tool === 'path' && pathRole) { finishPath(); return; }
    if (state.tool === 'measure') { measure = null; showMeasure(); clearPreview('measure'); return; }
    const hit = room.pick(e.clientX, e.clientY);
    const floor = room.floorPoint(e.clientX, e.clientY);
    ui.openMenu(hit, floor, e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerleave', () => {
    if (!gesture) { setHover(null); readout(null); }
    if (state.tool !== 'select' && !gesture) clearPreview('cursor', 'snap', 'ghostWalls');
  });

  // ---- tool clicks -------------------------------------------------------------------------
  function activeMaterial() {
    const material = state.activeMaterial;
    const entry = state.meta.materials.materials.find((m) => m.id === material);
    const loss = material === 'custom' || !entry ? Number(state.customLoss) : entry.loss_db;
    return {material, loss};
  }

  function toolClick(e, g) {
    const floor = g.floor;
    const tool = state.tool;
    if (tool === 'wall') {
      if (!floor) return;
      const from = chain && chain.points.length ? chain.points[chain.points.length - 1] : null;
      const s = snap(floor, {alt: g.alt, shift: g.shift, from});
      addChainPoint(chain && chain.typed && from ? typedEnd(from, s.point, chain.typed) : s.point);
    } else if (tool === 'door') {
      const hit = room.pick(e.clientX, e.clientY);
      if (!hit || hit.type !== 'wall') { ui.toast('Click on a wall to cut a door gap.'); return; }
      transact('Cut door gap', (d) => ops.cutGap(d, hit.wall, floor, state.doorWidth));
      clearPreview('ghostWalls');
      ui.toast(`Cut a ${state.doorWidth} m door gap. Links through the gap see no wall loss.`);
    } else if (tool === 'ap' || tool === 'client') {
      if (!floor) return;
      const p = devicePoint(floor, g.alt);
      if (p.point[0] < 0 || p.point[1] < 0) return;
      const kind = tool === 'ap' ? 'fronthaul_ap' : 'station';
      const mobile = tool === 'client' && g.shift;
      const role = transact(`Add ${kind === 'station' ? 'client' : 'agent'}`, (d) =>
        ops.addNode(d, {kind, position: p.point, mobile, lab: d.profile !== 'configurator'}));
      select({type: 'node', role});
      if (p.nudged) ui.toast('Placed 10 cm off the wall line so the wall keeps attenuating this device.');
      else if (role === 'gateway') ui.toast('Added the gateway (Agent-1). Next agents become extender_1, extender_2…');
    } else if (tool === 'measure') {
      if (!floor) return;
      const s = snap(floor, {alt: g.alt});
      if (!measure || measure.locked) measure = {a: s.point, b: s.point, locked: false};
      else { measure.b = s.point; measure.locked = true; }
      showMeasure();
    } else if (tool === 'path') {
      // Clicking a client chooses the path target; once waypoints are being
      // added, every click adds one (press Enter to switch to another client).
      const hit = room.pick(e.clientX, e.clientY);
      const target = hit && hit.type === 'node' ? ops.merged(state.design, hit.role) : null;
      if (target && target.kind === 'station' && hit.role !== pathRole && !pathAdded) {
        pathRole = hit.role;
        select({type: 'node', role: hit.role});
        const n = target.path ? target.path.length : 0;
        ui.toast(n > 1 ? `Extending ${hit.role}'s path (${n} waypoints). Click the floor to add more.`
          : `Drawing a path for ${hit.role}. Click the floor to add waypoints; Enter finishes.`);
        return;
      }
      if (!floor) return;
      const p = devicePoint(floor, g.alt).point;
      if (!pathRole) {
        const role = transact('Add mobile client', (d) => ops.addNode(d, {kind: 'station', position: p, mobile: true, lab: d.profile !== 'configurator'}));
        pathRole = role;
        pathAdded = 0;
        select({type: 'node', role});
        ui.toast(`Created ${role}. Click the floor to add waypoints; Enter finishes.`);
        return;
      }
      pathAdded++;
      transact(`Add waypoint to ${pathRole}`, (d) => {
        ops.appendWaypoint(d, pathRole, p, state.walkSpeed);
        const mob = ops.mobilityNode(d, pathRole);
        const last = mob.path[mob.path.length - 1].time_ms;
        if (last > d.mobility.duration_ms) {
          const tick = Number(d.mobility.tick_ms);
          d.mobility.duration_ms = Math.ceil(last / tick) * tick;
        }
      }, {coalesce: 'path-' + pathRole});
      const node = ops.merged(state.design, pathRole);
      const last = node.path[node.path.length - 1].time_ms;
      if (last === state.design.mobility.duration_ms) ui.toast(`Extended the script to ${last / 1000} s to fit the path.`);
    }
  }

  function typedEnd(from, cursor, typed) {
    const len = Number(typed);
    if (!(len > 0)) return cursor;
    const angle = Math.atan2(cursor[1] - from[1], cursor[0] - from[0]);
    return clampRoom([rf.round3(from[0] + Math.cos(angle) * len), rf.round3(from[1] + Math.sin(angle) * len)]);
  }

  function addChainPoint(p) {
    chain = chain || {points: [], typed: ''};
    chain.typed = '';
    const from = chain.points[chain.points.length - 1];
    if (from) {
      if (Math.hypot(p[0] - from[0], p[1] - from[1]) < 0.02) return;
      const {material, loss} = activeMaterial();
      transact('Draw wall', (d) => ops.addWall(d, from, p, material, loss));
      const first = chain.points[0];
      if (chain.points.length >= 2 && Math.hypot(p[0] - first[0], p[1] - first[1]) < 0.02) { finishChain('Closed the outline.'); return; }
    }
    chain.points.push(p);
  }

  function finishChain(message) {
    const count = chain ? Math.max(0, chain.points.length - 1) : 0;
    chain = null;
    clearPreview('ghostWalls', 'snap');
    if (count) ui.toast(message || `Drew ${count} wall${count > 1 ? 's' : ''}. Select one to change its material or loss.`);
  }

  function finishPath() {
    if (!pathRole) return;
    const node = ops.merged(state.design, pathRole);
    const s = ops.pathSummary(node);
    ui.toast(s ? `${pathRole}: ${s.waypoints} waypoints, ${s.length_m.toFixed(1)} m in ${(s.duration_ms / 1000).toFixed(1)} s. Press Space to preview.`
      : `${pathRole} has no movement yet.`);
    pathRole = null;
    pathAdded = 0;
    clearPreview('measure');
  }

  function showMeasure() {
    const hud = document.getElementById('measureHud');
    if (!measure) { hud.hidden = true; clearPreview('measure'); return; }
    const {a, b} = measure;
    const prop = rf.propagationOf(state.design.layout);
    const walls = state.design.layout.walls || [];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const crossed = rf.wallCrossings(a, b, walls);
    preview({measure: {a, b, label: `${d.toFixed(2)} m · ${crossed.length} wall${crossed.length === 1 ? '' : 's'}`}});
    const rows = rf.BANDS.map((band) => {
      const l = rf.linkSnr(prop, band, a, b, walls);
      return `<tr><td>${band} GHz</td><td><span class="snr" style="background:${rf.signal.snrColor(l.snr)};color:${rf.signal.snrColor(l.snr) === rf.signal.colors.yellow ? '#111' : '#fff'}">${l.snr}</span> dB</td><td>${l.path_loss_db.toFixed(1)} dB</td></tr>`;
    }).join('');
    const wallList = crossed.map((i) => `${walls[i].name || 'wall ' + (i + 1)} (${walls[i].loss_db} dB)`).join(', ') || 'none';
    hud.innerHTML = `<div class="hud-title"><span>Measure</span><button class="close" aria-label="Close">×</button></div>
      <div class="hud-grid"><span>From</span><b>(${a[0].toFixed(2)}, ${a[1].toFixed(2)})</b><span>To</span><b>(${b[0].toFixed(2)}, ${b[1].toFixed(2)})</b>
      <span>Distance</span><b>${d.toFixed(3)} m</b><span>Walls crossed</span><b>${crossed.length} · ${crossed.reduce((s, i) => s + Number(walls[i].loss_db), 0)} dB</b></div>
      <div class="note">${wallList}</div>
      <table><tr><th>Band</th><th>SNR</th><th>Path loss</th></tr>${rows}</table>
      <div class="note">As if an agent stood at the first point (no transmit adjustment). ${measure.locked ? 'Click again to start a new measurement.' : 'Click to fix the end point.'}</div>`;
    hud.hidden = false;
    hud.querySelector('.close').addEventListener('click', () => { measure = null; showMeasure(); });
  }

  // ---- keyboard ------------------------------------------------------------------------------
  function handleKey(e) {
    if (state.tool === 'wall' && chain && chain.points.length) {
      if (/^[0-9.]$/.test(e.key)) { chain.typed = (chain.typed || '') + e.key; refreshChain(); return true; }
      if (e.key === 'Backspace' && chain.typed) { chain.typed = chain.typed.slice(0, -1); refreshChain(); return true; }
      if (e.key === 'Enter') {
        if (chain.typed && chain.cursor) addChainPoint(typedEnd(chain.points[chain.points.length - 1], chain.cursor, chain.typed));
        else finishChain();
        refreshChain();
        return true;
      }
      if (e.key === 'Escape') { finishChain(); return true; }
    }
    if (state.tool === 'path' && pathRole) {
      if (e.key === 'Enter' || e.key === 'Escape') { finishPath(); return true; }
      if (e.key === 'Backspace') {
        transact(`Remove last waypoint of ${pathRole}`, (d) => {
          const mob = ops.mobilityNode(d, pathRole);
          if (mob && mob.path && mob.path.length > 1) mob.path.pop();
        });
        return true;
      }
    }
    if (state.tool === 'measure' && e.key === 'Escape' && measure) { measure = null; showMeasure(); return true; }
    return false;
  }

  function refreshChain() {
    if (!chain || !chain.cursor) return;
    const from = chain.points[chain.points.length - 1];
    if (!from) return;
    const end = chain.typed ? typedEnd(from, chain.cursor, chain.typed) : chain.cursor;
    const len = Math.hypot(end[0] - from[0], end[1] - from[1]);
    preview({ghostWalls: [{start: from, end, label: chain.typed ? `${chain.typed} m ⏎` : `${len.toFixed(2)} m`}]});
  }

  function onToolChange() {
    if (chain) finishChain();
    if (pathRole && state.tool !== 'path') finishPath();
    if (state.tool !== 'measure' && measure) { measure = null; showMeasure(); }
    state.preview = null;
    for (const t of ['select', 'wall', 'room', 'door', 'ap', 'client', 'path', 'measure']) stage.classList.toggle('tool-' + t, state.tool === t);
    if (state.tool === 'path' && state.selection && state.selection.type === 'node') {
      const node = ops.merged(state.design, state.selection.role);
      if (node && node.kind === 'station') { pathRole = state.selection.role; pathAdded = 0; }
    }
    updateHint();
    room.update();
  }

  function updateHint() {
    const hint = document.getElementById('hint');
    hint.textContent = VIEW_HINTS[room.mode] || TOOL_HINTS[state.tool] || '';
  }

  on('tool', onToolChange);
  on('view', updateHint);
  onToolChange();

  return {handleKey, updateHint, cancel() { if (chain) finishChain(); if (pathRole) finishPath(); }, get pathRole() { return pathRole; }};
}
