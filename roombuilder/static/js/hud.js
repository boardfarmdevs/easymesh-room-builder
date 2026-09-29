// Floating properties panel for the selection, in the viewer's dark HUD style,
// plus the right-click context menu.

import * as rf from './rfmodel.js';
import * as ops from './ops.js';
import {state, on, emit, transact, select, setTool, setTime} from './store.js';
import {h, fmt, report, fill} from './dom.js';

let hud = null;
let ui = null;
let allBands = false;
let stale = false;

export function initHud(uiHooks) {
  ui = uiHooks;
  hud = document.getElementById('propsHud');
  makeDraggable(hud);
  const refresh = () => {
    if (hud.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { stale = true; return; }
    render();
  };
  on('selection', render);
  on('design', refresh);
  let last = 0;
  on('time', () => {
    const now = performance.now();
    if (state.playing && now - last < 250) return;   // throttle the link table while playing
    last = now;
    refresh();
  });
  on('playing', refresh);
  on('view', refresh);
  hud.addEventListener('focusout', () => setTimeout(() => { if (stale && !hud.contains(document.activeElement)) { stale = false; render(); } }, 0));
}

function edit(label, fn, options) {
  try { return transact(label, fn, options); } catch (error) { report(error); return undefined; }
}

function numInput(value, onCommit, {step = 'any', width = '70px', min, max} = {}) {
  const input = h('input', {type: 'number', step, min, max, style: {width}});
  input.value = fmt(value, 3);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) { input.classList.add('invalid'); return; }
    try { onCommit(v); input.classList.remove('invalid'); } catch (error) { input.classList.add('invalid'); report(error); }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
  return input;
}

function textInput(value, onCommit) {
  const input = h('input', {type: 'text', spellcheck: 'false'});
  input.value = value;
  input.addEventListener('change', () => { try { onCommit(input.value.trim()); input.classList.remove('invalid'); } catch (error) { input.classList.add('invalid'); report(error); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
  return input;
}

export function render() {
  const sel = state.selection;
  if (!sel || !state.design) { hud.hidden = true; return; }
  let content = null;
  if (sel.type === 'node') content = nodePanel(sel.role);
  else if (sel.type === 'wall') content = wallPanel(sel.index);
  else if (sel.type === 'waypoint') content = waypointPanel(sel.role, sel.index);
  if (!content) { hud.hidden = true; return; }
  fill(hud, ...content);
  hud.hidden = false;
}

function title(text, kind) {
  return h('div', {class: 'hud-title'}, h('span', {}, text, kind ? h('span', {class: 'kind'}, '  ' + kind) : null),
    h('button', {class: 'close', 'aria-label': 'Close', onclick: () => select(null)}, '×'));
}

function snrCell(v) {
  const bg = rf.signal.snrColor(v);
  return h('span', {class: 'snr', style: {background: bg, color: rf.signal.colors.yellow === bg || rf.signal.colors.grey === bg ? '#111827' : '#fff'}}, String(v));
}

// ---------------------------------------------------------------- node
function nodePanel(role) {
  const d = state.design;
  const node = ops.merged(d, role);
  if (!node) return null;
  const scene = rf.sceneAt(d, state.timeMs, state.preview && state.preview.positions);
  const entry = scene.byRole[role];
  const ap = node.kind === 'fronthaul_ap';
  const lay = ops.layoutNode(d, role);
  const mobile = node.path && node.path.length > 0;
  const s = ops.pathSummary(node);
  const gains = node.tx_gain_db_by_band || {};
  const kindLabel = ap ? (role === 'gateway' ? 'gateway · Agent-1' : node.backhaul === 'wired' ? 'agent · wired backhaul' : 'agent') : mobile ? 'mobile client' : 'static client';
  const links = rf.linksFor(scene, d.layout, role).sort((a, b) => b.rx[state.band] - a.rx[state.band] || (a.role < b.role ? -1 : 1));
  const best = ap ? null : rf.bestServing(scene, d.layout, state.band)[role];
  const bands = allBands ? rf.BANDS : [state.band];
  const rows = links.slice(0, 40).map((l) => h('tr', {class: best && best.ap === l.role ? 'best' : ''},
    h('td', {}, l.kind === 'fronthaul_ap' ? rf.displayRole(l.role) : rf.shortRole(l.role), l.present ? null : h('span', {class: 'muted'}, ' (off)')),
    h('td', {}, fmt(l.distance_m, 1)),
    h('td', {}, l.wall_loss_db ? `${fmt(l.wall_loss_db)}` : '0'),
    bands.map((b) => [h('td', {}, snrCell(l.rx[b])), h('td', {}, snrCell(l.tx[b]))])));
  const header = h('tr', {}, h('th', {}, 'Peer'), h('th', {}, 'm'), h('th', {}, 'wall dB'),
    bands.map((b) => [h('th', {title: `${b} GHz, peer → ${role}`}, `↓${allBands ? b : ''}`), h('th', {title: `${b} GHz, ${role} → peer`}, `↑${allBands ? b : ''}`)]));
  const position = entry ? entry.position : [0, 0];
  const parts = [
    title(ap ? rf.displayRole(role) : role, kindLabel),
    h('div', {class: 'hud-grid'},
      h('span', {}, 'Role'), h('b', {}, role),
      h('span', {}, 'At'), h('b', {}, `${(state.timeMs / 1000).toFixed(1)} s · ${entry && entry.present ? 'on air' : 'absent'}`),
      best ? [h('span', {}, `Best ${state.band} GHz`), h('b', {}, `${rf.displayRole(best.ap)} · ${best.snr} dB`)] : null),
    h('label', {class: 'field', 'data-tip-key': 'layout.nodes[].role'}, 'Rename role'),
    textInput(role, (v) => {
      if (v === role) return;
      if (!rf.ROLE_PATTERN.test(v)) throw new Error('Role names start with a letter or _ and use letters, digits, _ and -');
      edit(`Rename ${role} → ${v}`, (x) => ops.renameRole(x, role, v));
      select({type: 'node', role: v});
    }),
    h('label', {class: 'field', 'data-tip-key': 'layout.nodes[].position'}, mobile ? `Position at ${(state.timeMs / 1000).toFixed(1)} s (edits the keyframe)` : 'Position x, y (m)'),
    h('div', {class: 'row'},
      numInput(position[0], (v) => moveTo([v, position[1]])), numInput(position[1], (v) => moveTo([position[0], v])),
      h('button', {onclick: () => emit('focusSelection'), 'data-tip': 'Centre the camera on this device.'}, 'Focus')),
  ];
  function moveTo(p) {
    const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
    if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) throw new Error(`Inside 0..${W} × 0..${H} m`);
    edit(`Move ${role}`, (x) => ops.moveNode(x, role, p, state.timeMs));
  }
  if (ap && lay) {
    parts.push(h('label', {class: 'check', 'data-tip-key': 'layout.nodes[].backhaul'},
      h('input', {type: 'checkbox', checked: node.backhaul === 'wired' ? true : null,
        onchange: (e) => edit(`${e.target.checked ? 'Wire' : 'Unwire'} ${role}`, (x) => ops.setWired(x, role, e.target.checked))}),
      ' Wired backhaul (LAN to the controller; can be a Wi-Fi extender\'s parent)'));
  }
  parts.push(h('label', {class: 'field', 'data-tip-key': 'nodes[].tx_gain_db_by_band'}, 'Transmit adjustment by band (dB)'),
    h('div', {class: 'row'}, rf.BANDS.map((b) => h('span', {class: 'row', style: {gap: '3px'}}, h('span', {class: 'muted'}, b),
      numInput(gains[b] || 0, (v) => edit(`Transmit adjustment ${role}`, (x) => ops.setGain(x, role, Object.assign({}, gains, {[b]: v}))), {width: '52px', step: 1})))));
  const presence = node.presence;
  parts.push(h('div', {class: 'hud-grid', style: {marginTop: '8px'}},
    h('span', {}, 'Path'), h('b', {}, s ? `${s.waypoints} pts · ${fmt(s.length_m, 1)} m · ${fmt(s.speed, 2)} m/s` : 'static'),
    h('span', {}, 'Presence'), h('b', {}, presence === undefined ? 'always' : presence.length ? presence.map(([a, b]) => `${a / 1000}–${b / 1000} s`).join(', ') : 'parked (never)')));
  const actions = h('div', {class: 'actions'},
    node.kind === 'station' ? h('button', {onclick: () => { setTool('path'); }, 'data-tip': 'Add waypoints with the Path tool (P).'}, mobile ? 'Extend path' : 'Add path') : null,
    mobile ? h('button', {onclick: () => edit(`Make ${role} static`, (x) => ops.removePath(x, role, state.timeMs))}, 'Make static') : null,
    ap && role !== 'gateway' && !mobile ? h('button', {onclick: () => edit(`Add path to ${role}`, (x) => { ops.ensurePath(x, role); }), 'data-tip': 'Moving agents are allowed (extender evacuation, backhaul rooms). Then drag it at a later time.'}, 'Make movable') : null,
    role !== 'gateway' ? h('button', {onclick: () => edit(`${role} ${entry && entry.present ? 'off' : 'on'} air from ${(state.timeMs / 1000).toFixed(1)} s`,
      (x) => ops.setPresenceFrom(x, role, state.timeMs, !(entry && entry.present))), 'data-tip': 'Toggle presence from the current time to the end.'},
    entry && entry.present ? 'Disappear from here' : 'Appear from here') : null,
    h('button', {onclick: () => duplicateNode(role), 'data-tip': 'Copy with the next free role, 1 m to the right (Ctrl+D).'}, 'Duplicate'),
    h('button', {class: 'danger', onclick: () => { edit(`Delete ${role}`, (x) => ops.deleteNode(x, role)); select(null); }}, 'Delete'));
  parts.push(actions);
  parts.push(h('div', {class: 'row', style: {marginTop: '8px', justifyContent: 'space-between'}},
    h('b', {}, `Links at ${(state.timeMs / 1000).toFixed(1)} s`),
    h('button', {class: 'small', onclick: () => { allBands = !allBands; render(); }}, allBands ? `${state.band} GHz only` : 'All bands')));
  parts.push(links.length ? h('table', {}, header, rows) : h('p', {class: 'note'}, ap ? 'No clients or mesh peers yet.' : 'No agents yet.'));
  parts.push(h('p', {class: 'note'}, '↓ peer → this device · ↑ this device → peer. Same model as world-compile, without seeded shadowing.'));
  return parts;
}

export function duplicateNode(role) {
  const d = state.design;
  const node = ops.merged(d, role);
  if (!node) return;
  const entry = rf.sceneAt(d, state.timeMs).byRole[role];
  const W = Number(d.layout.space.width_m);
  const p = [Math.min(W, rf.round3(entry.position[0] + 1)), entry.position[1]];
  const newRole = edit(`Duplicate ${role}`, (x) => {
    const name = rf.nextRole(ops.roles(x), node.kind, {mobile: /mobile/.test(role), lab: x.profile !== 'configurator'});
    const lay = ops.layoutNode(x, role), mob = ops.mobilityNode(x, role);
    if (lay) x.layout.nodes.push(Object.assign(JSON.parse(JSON.stringify(lay)), {role: name, position: p}));
    if (mob) {
      const copy = JSON.parse(JSON.stringify(mob));
      copy.role = name;
      const dx = p[0] - entry.position[0];
      if (copy.path) for (const w of copy.path) w.position = [Math.min(W, rf.round3(w.position[0] + dx)), w.position[1]];
      if (copy.position) copy.position = p;
      x.mobility.nodes.push(copy);
    }
    return name;
  });
  if (newRole) select({type: 'node', role: newRole});
}

// ---------------------------------------------------------------- wall
function wallPanel(index) {
  const d = state.design;
  const wall = (d.layout.walls || [])[index];
  if (!wall) return null;
  const mats = state.meta.materials.materials;
  const matId = (d.builder.wall_materials || [])[index] || 'custom';
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const angle = Math.atan2(wall.end[1] - wall.start[1], wall.end[0] - wall.start[0]) * 180 / Math.PI;
  const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
  const setEnd = (which, axis, v) => {
    const max = axis ? H : W;
    if (v < 0 || v > max) throw new Error(`Inside 0..${max} m`);
    edit('Edit wall', (x) => {
      const w = x.layout.walls[index];
      w[which][axis] = rf.round3(v);
      if (w.start[0] === w.end[0] && w.start[1] === w.end[1]) throw new Error('A wall needs two different ends');
    });
  };
  const setPolar = (length, degrees) => {
    const a = degrees * Math.PI / 180;
    const end = [rf.round3(wall.start[0] + Math.cos(a) * length), rf.round3(wall.start[1] + Math.sin(a) * length)];
    if (end[0] < 0 || end[1] < 0 || end[0] > W || end[1] > H) throw new Error('That end would leave the room');
    if (!(length > 0)) throw new Error('Length must be positive');
    edit('Edit wall', (x) => { x.layout.walls[index].end = end; });
  };
  const crossingClients = rf.sceneAt(d, state.timeMs).nodes.filter((n) => rf.pointSegmentDistance(n.position, wall.start, wall.end) < 0.05);
  return [
    title(wall.name || `wall ${index + 1}`, 'wall'),
    h('label', {class: 'field', 'data-tip-key': 'layout.walls[].name'}, 'Name'),
    textInput(wall.name || '', (v) => edit('Rename wall', (x) => { if (v) x.layout.walls[index].name = v; else delete x.layout.walls[index].name; })),
    h('label', {class: 'field'}, 'Material'),
    h('select', {onchange: (e) => {
      const m = mats.find((x) => x.id === e.target.value);
      edit('Change wall material', (x) => ops.setWallMaterial(x, index, m.id, m.loss_db));
    }}, mats.map((m) => h('option', {value: m.id, selected: m.id === matId ? true : null}, `${m.label}${m.loss_db === null ? '' : ' · ' + m.loss_db + ' dB'}`))),
    h('label', {class: 'field', 'data-tip-key': 'layout.walls[].loss_db'}, 'Loss per crossing (dB, all bands)'),
    numInput(wall.loss_db, (v) => {
      if (v < 0) throw new Error('Loss cannot be negative');
      const preset = mats.find((m) => m.loss_db === v);
      edit('Change wall loss', (x) => ops.setWallMaterial(x, index, preset ? preset.id : 'custom', v));
    }, {step: 0.5, width: '90px'}),
    h('label', {class: 'field'}, 'Start x, y'),
    h('div', {class: 'row'}, numInput(wall.start[0], (v) => setEnd('start', 0, v)), numInput(wall.start[1], (v) => setEnd('start', 1, v))),
    h('label', {class: 'field'}, 'End x, y'),
    h('div', {class: 'row'}, numInput(wall.end[0], (v) => setEnd('end', 0, v)), numInput(wall.end[1], (v) => setEnd('end', 1, v))),
    h('label', {class: 'field'}, 'Length (m) and angle (°) from the start'),
    h('div', {class: 'row'}, numInput(len, (v) => setPolar(v, angle)), numInput(angle, (v) => setPolar(len, v))),
    crossingClients.length ? h('p', {class: 'note'}, `⚠ ${crossingClients.map((n) => n.role).join(', ')} stand on this wall's line: the wall adds no loss to their links.`) : null,
    h('div', {class: 'actions'},
      h('button', {onclick: () => { const i = edit('Double wall', (x) => ops.duplicateParallel(x, index, 0.2)); if (i !== undefined) select({type: 'wall', index: i}); },
        'data-tip': 'Parallel copy 20 cm away: paths through both add both losses (a double wall).'}, 'Double'),
      h('button', {onclick: () => edit('Split wall', (x) => ops.splitWall(x, index)), 'data-tip': 'Split into two walls at the middle.'}, 'Split'),
      h('button', {onclick: () => {
        const mid = [(wall.start[0] + wall.end[0]) / 2, (wall.start[1] + wall.end[1]) / 2];
        edit('Cut door gap', (x) => ops.cutGap(x, index, mid, state.doorWidth));
        select(null);
      }, 'data-tip': `Cut a ${state.doorWidth} m door in the middle (Door tool D picks the spot).`}, 'Door'),
      h('button', {onclick: () => edit('Flip wall', (x) => { const w = x.layout.walls[index]; [w.start, w.end] = [w.end, w.start]; }), 'data-tip': 'Swap start and end (only changes which side the floor label sits).'}, 'Flip'),
      h('button', {class: 'danger', onclick: () => { edit('Delete wall', (x) => ops.deleteWall(x, index)); select(null); }}, 'Delete')),
    h('p', {class: 'note'}, 'Drag the wall to move it; drag its purple end handles to reshape (Shift = 15°, Alt = free).'),
  ];
}

// ---------------------------------------------------------------- waypoint
function waypointPanel(role, index) {
  const d = state.design;
  const mob = ops.mobilityNode(d, role);
  if (!mob || !mob.path || !mob.path[index]) return null;
  const w = mob.path[index];
  const prev = mob.path[index - 1], next = mob.path[index + 1];
  const speedIn = prev ? Math.hypot(w.position[0] - prev.position[0], w.position[1] - prev.position[1]) / ((w.time_ms - prev.time_ms) / 1000) : null;
  return [
    title(`${role} · waypoint ${index + 1}/${mob.path.length}`, 'path'),
    h('label', {class: 'field', 'data-tip-key': 'mobility.nodes[].path'}, 'Time (s)'),
    numInput(w.time_ms / 1000, (v) => {
      const ms = Math.round(v * 1000);
      if (index === 0) throw new Error('The first waypoint is always at 0 s');
      if ((prev && ms <= prev.time_ms) || (next && ms >= next.time_ms)) throw new Error('Times must increase along the path');
      if (ms > d.mobility.duration_ms) throw new Error('After the end of the script');
      edit('Retime waypoint', (x) => { ops.mobilityNode(x, role).path[index].time_ms = ms; });
    }),
    h('label', {class: 'field'}, 'Position x, y (m)'),
    h('div', {class: 'row'},
      numInput(w.position[0], (v) => edit('Move waypoint', (x) => { ops.mobilityNode(x, role).path[index].position[0] = rf.round3(v); })),
      numInput(w.position[1], (v) => edit('Move waypoint', (x) => { ops.mobilityNode(x, role).path[index].position[1] = rf.round3(v); }))),
    h('div', {class: 'hud-grid', style: {marginTop: '6px'}},
      h('span', {}, 'Speed into it'), h('b', {}, speedIn === null ? '—' : `${fmt(speedIn, 2)} m/s`)),
    h('div', {class: 'actions'},
      h('button', {onclick: () => setTime(w.time_ms)}, 'Go to time'),
      h('button', {'data-tip': 'Hold here for 5 s: inserts a repeated waypoint and shifts later ones.', onclick: () => edit('Add dwell', (x) => {
        const path = ops.mobilityNode(x, role).path;
        for (let i = index + 1; i < path.length; i++) path[i].time_ms += 5000;
        path.splice(index + 1, 0, {time_ms: w.time_ms + 5000, position: w.position.slice()});
        const last = path[path.length - 1].time_ms, tick = Number(x.mobility.tick_ms);
        if (last > x.mobility.duration_ms) x.mobility.duration_ms = Math.ceil(last / tick) * tick;
      })}, 'Dwell +5 s'),
      index > 0 ? h('button', {class: 'danger', onclick: () => { edit('Delete waypoint', (x) => { ops.mobilityNode(x, role).path.splice(index, 1); }); select({type: 'node', role}); }}, 'Delete') : null,
      h('button', {onclick: () => select({type: 'node', role})}, 'Select client')),
    h('p', {class: 'note'}, 'Drag the purple ring to move it. Drag the client itself at another time to add a keyframe.'),
  ];
}

// ---------------------------------------------------------------- context menu
export function openMenu(hit, floor, clientX, clientY) {
  const menu = document.getElementById('contextMenu');
  const stage = document.getElementById('stage').getBoundingClientRect();
  const items = [];
  const add = (label, fn, cls) => items.push(h('button', {class: cls, onclick: () => { hideMenu(); try { fn(); } catch (error) { report(error); } }}, label));
  const d = state.design;
  let heading = 'Room';
  if (hit && hit.type === 'node') {
    const role = hit.role;
    const node = ops.merged(d, role);
    const entry = rf.sceneAt(d, state.timeMs).byRole[role];
    heading = node.kind === 'fronthaul_ap' ? rf.displayRole(role) : role;
    select({type: 'node', role});
    if (node.kind === 'station') add(node.path && node.path.length ? 'Extend path (P)' : 'Draw path (P)', () => setTool('path'));
    if (node.path && node.path.length > 1) add('Make static here', () => transact(`Make ${role} static`, (x) => ops.removePath(x, role, state.timeMs)));
    if (role !== 'gateway') add(entry.present ? `Disappear from ${(state.timeMs / 1000).toFixed(1)} s` : `Appear from ${(state.timeMs / 1000).toFixed(1)} s`,
      () => transact('Toggle presence', (x) => ops.setPresenceFrom(x, role, state.timeMs, !entry.present)));
    if (role !== 'gateway') add('Park (never on air)', () => transact(`Park ${role}`, (x) => ops.setPresence(x, role, [])));
    if (node.presence !== undefined) add('Always on air', () => transact(`${role} always on air`, (x) => ops.setPresence(x, role, null)));
    if (node.kind === 'fronthaul_ap' && ops.layoutNode(d, role)) add(node.backhaul === 'wired' ? 'Use Wi-Fi backhaul' : 'Wired backhaul', () => transact('Toggle wired backhaul', (x) => ops.setWired(x, role, node.backhaul !== 'wired')));
    add('Duplicate', () => duplicateNode(role));
    add('Focus camera', () => emit('focusSelection'));
    items.push(h('hr'));
    add('Delete', () => { transact(`Delete ${role}`, (x) => ops.deleteNode(x, role)); select(null); }, 'danger');
  } else if (hit && hit.type === 'wall') {
    const index = hit.wall;
    heading = d.layout.walls[index].name || `wall ${index + 1}`;
    select({type: 'wall', index});
    if (floor) add(`Cut a ${state.doorWidth} m door here`, () => transact('Cut door gap', (x) => ops.cutGap(x, index, floor, state.doorWidth)));
    add('Double (parallel copy)', () => transact('Double wall', (x) => ops.duplicateParallel(x, index, 0.2)));
    add('Split in the middle', () => transact('Split wall', (x) => ops.splitWall(x, index)));
    for (const m of state.meta.materials.materials.filter((m) => m.loss_db !== null)) {
      add(`Material: ${m.label} (${m.loss_db} dB)`, () => transact('Change wall material', (x) => ops.setWallMaterial(x, index, m.id, m.loss_db)));
    }
    items.push(h('hr'));
    add('Delete wall', () => { transact('Delete wall', (x) => ops.deleteWall(x, index)); select(null); }, 'danger');
  } else if (hit && hit.type === 'waypoint') {
    heading = `${hit.role} · waypoint ${hit.index + 1}`;
    select({type: 'waypoint', role: hit.role, index: hit.index});
    add('Go to its time', () => setTime(ops.mobilityNode(d, hit.role).path[hit.index].time_ms));
    if (hit.index > 0) add('Delete waypoint', () => { transact('Delete waypoint', (x) => { ops.mobilityNode(x, hit.role).path.splice(hit.index, 1); }); select({type: 'node', role: hit.role}); }, 'danger');
  } else if (floor) {
    const inside = floor[0] >= 0 && floor[1] >= 0 && floor[0] <= Number(d.layout.space.width_m) && floor[1] <= Number(d.layout.space.height_m);
    if (!inside) return;
    heading = `Floor (${floor[0].toFixed(1)}, ${floor[1].toFixed(1)})`;
    const p = [rf.snapValue(floor[0], state.snap), rf.snapValue(floor[1], state.snap)];
    const addNode = (kind, mobile) => {
      const role = transact('Add device', (x) => ops.addNode(x, {kind, position: p, mobile, lab: x.profile !== 'configurator'}));
      select({type: 'node', role});
    };
    add('Add agent here', () => addNode('fronthaul_ap', false));
    add('Add static client here', () => addNode('station', false));
    add('Add mobile client here', () => { addNode('station', true); setTool('path'); });
    add('Measure from here', () => setTool('measure'));
  }
  if (!items.length) return;
  fill(menu, h('strong', {}, heading), ...items);
  menu.hidden = false;
  const x = Math.min(clientX - stage.left, stage.width - 210), y = Math.min(clientY - stage.top, stage.height - menu.offsetHeight - 10);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
}

export function hideMenu() {
  document.getElementById('contextMenu').hidden = true;
}

function makeDraggable(panel) {
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.hud-title');
    if (!handle || e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(), parent = panel.parentElement.getBoundingClientRect();
    drag = {dx: e.clientX - r.left, dy: e.clientY - r.top, parent};
    panel.setPointerCapture(e.pointerId);
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const left = Math.max(0, Math.min(drag.parent.width - panel.offsetWidth, e.clientX - drag.parent.left - drag.dx));
    const top = Math.max(0, Math.min(drag.parent.height - 60, e.clientY - drag.parent.top - drag.dy));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  });
  panel.addEventListener('pointerup', () => { drag = null; });
  panel.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.hud-title')) return;
    panel.style.left = ''; panel.style.top = ''; panel.style.right = '';
  });
}
