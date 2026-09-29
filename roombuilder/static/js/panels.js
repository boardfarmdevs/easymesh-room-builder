// Sidebar tabs (Room, Walls, Devices, Motion, Scenario, Check).

import * as rf from './rfmodel.js';
import * as ops from './ops.js';
import {state, on, emit, transact, select, setTool, setView, savePrefs} from './store.js';
import {h, field, fmt, segmented, report, fill} from './dom.js';
import {TIPS} from './tips.js';
import {api} from './api.js';

const TICKS = [100, 200, 250, 500, 1000, 2000, 3000, 4000, 5000, 10000, 30000, 60000];
let activeTab = 'room';
const stale = new Set();
let ui = null;

export function initPanels(uiHooks) {
  ui = uiHooks;
  const tabs = document.getElementById('tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  on('design', (info) => refreshAll(info));
  on('selection', () => { markStale('walls', 'devices', 'motion'); refreshVisible(); });
  on('view', () => { markStale('room'); refreshVisible(); });
  on('lint', () => { markStale('check'); refreshVisible(); updateCheckCount(); });
  on('placement', () => { markStale('devices'); refreshVisible(); });
  let timeTimer = null;
  on('time', () => {
    if (activeTab !== 'motion' && activeTab !== 'scenario' && activeTab !== 'check') return;
    markStale(activeTab);
    if (state.playing) return;
    clearTimeout(timeTimer);
    timeTimer = setTimeout(refreshVisible, 150);
  });
  on('playing', () => { if (!state.playing) { markStale(activeTab); refreshVisible(); } });
  for (const name of ['room', 'walls', 'devices', 'motion', 'scenario', 'check']) {
    const panel = document.getElementById('tab-' + name);
    panel.addEventListener('focusout', () => setTimeout(() => {
      if (!panel.contains(document.activeElement) && stale.has(name) && activeTab === name) render(name);
    }, 0));
  }
  on('showTab', (name) => showTab(name));
}

export function showTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== 'tab-' + name;
  render(name);
  emit('tabShown', name);
}

function markStale(...names) { for (const n of names) stale.add(n); }

function refreshAll() {
  markStale('room', 'walls', 'devices', 'motion', 'scenario', 'check');
  refreshVisible();
}

function refreshVisible() {
  const panel = document.getElementById('tab-' + activeTab);
  const focused = panel.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (focused) return;
  if (stale.has(activeTab)) render(activeTab);
}

function render(name) {
  if (!state.design || !state.meta) return;
  stale.delete(name);
  const panel = document.getElementById('tab-' + name);
  const scroll = panel.closest('aside').scrollTop;
  const builders = {room: roomTab, walls: wallsTab, devices: devicesTab, motion: motionTab, scenario: scenarioTab, check: checkTab};
  fill(panel, ...builders[name]());
  panel.closest('aside').scrollTop = scroll;
}

function card(title, ...children) {
  return h('section', {class: 'card'}, title ? h('h2', {}, title) : null, ...children);
}

function edit(label, fn, options) {
  try { return transact(label, fn, options); } catch (error) { report(error); throw error; }
}

// ======================================================================= Room
function roomTab() {
  const d = state.design;
  const L = d.layout, M = d.mobility;
  const profiles = state.meta.profiles.profiles;
  const profile = profiles.find((p) => p.id === d.profile) || profiles[0];
  const prop = rf.propagationOf(L);
  const presets = state.meta.propagation_presets;
  const example = rf.BANDS.map((b) => {
    const l = rf.linkSnr(prop, b, [0, 0], [10, 0], [{start: [5, -1], end: [5, 1], loss_db: 5}]);
    return `${b} GHz ${l.snr} dB`;
  }).join(' · ');

  const tipIndex = Math.floor(Date.now() / 60000) % TIPS.length;
  const tipBox = h('p', {class: 'help'}, TIPS[tipIndex]);
  let tipAt = tipIndex;

  return [
    card('Design',
      field({label: 'Description', type: 'textarea', rows: 2, value: d.description, tip: 'Free text kept in the design and the export bundle README.',
        onCommit: (v) => edit('Edit description', (x) => { x.description = v; })}),
      field({label: 'Lab profile', type: 'select', value: d.profile, tip: profile.tip,
        options: profiles.map((p) => ({value: p.id, label: p.label})),
        onCommit: (v) => edit('Change lab profile', (x) => { x.profile = v; })}),
      h('p', {class: 'help'}, profile.tip),
      h('div', {class: 'grid2'},
        field({label: 'Layout name', type: 'text', value: L.name, tipKey: 'layout.name',
          onCommit: (v) => { if (!rf.NAME_PATTERN.test(v)) throw new Error('Use 1–100 of a-z, A-Z, 0-9, - and _'); edit('Rename layout', (x) => { x.layout.name = v; }); }}),
        field({label: 'Scenario name', type: 'text', value: M.name, tipKey: 'mobility.name',
          onCommit: (v) => { if (!rf.NAME_PATTERN.test(v)) throw new Error('Use 1–100 of a-z, A-Z, 0-9, - and _'); edit('Rename scenario', (x) => { x.mobility.name = v; }); }})),
      field({label: 'Layout tags', type: 'text', value: (L.tags || []).join(', '), tipKey: 'layout.tags', placeholder: 'home, walls, five-agent',
        onCommit: (v) => edit('Edit layout tags', (x) => { x.layout.tags = v.split(',').map((s) => s.trim()).filter(Boolean); })}),
      h('p', {class: 'help'}, 'World ID ', h('b', {class: 'mono'}, d.id), ' → compiles as ', h('span', {class: 'mono'}, `${L.name}--${M.name}`))),
    card('Room size',
      h('div', {class: 'grid2'},
        field({label: 'Width x', unit: 'm', value: L.space.width_m, min: 0.5, step: 0.5, tipKey: 'layout.space.width_m',
          onCommit: (v) => resize(v, Number(L.space.height_m))}),
        field({label: 'Depth y', unit: 'm', value: L.space.height_m, min: 0.5, step: 0.5, tipKey: 'layout.space.height_m',
          onCommit: (v) => resize(Number(L.space.width_m), v)})),
      h('label', {class: 'check', 'data-tip': 'On: resizing scales every wall, device and waypoint with the room. Off: the room grows or shrinks around its contents.'},
        h('input', {type: 'checkbox', id: 'scaleContents', checked: state.scaleContents ? true : null,
          onchange: (e) => { state.scaleContents = e.target.checked; }}), ' Scale contents with the room'),
      h('div', {class: 'row'},
        h('button', {class: 'small', 'data-tip': 'Shrink or grow the room to just contain every wall end, device and waypoint (rounded up to 0.5 m).',
          onclick: () => { const b = ops.contentBounds(state.design); resize(Math.max(1, Math.ceil(b.maxX * 2) / 2), Math.max(1, Math.ceil(b.maxY * 2) / 2), 'extend'); }}, 'Fit to contents'),
        h('button', {class: 'small', 'data-tip': 'Double the floor area in place (contents unchanged).',
          onclick: () => resize(Number(L.space.width_m) * 1.5, Number(L.space.height_m) * 1.5, 'extend')}, 'Grow ×1.5'),
        h('span', {class: 'help'}, `${fmt(L.space.width_m * L.space.height_m, 1)} m²`))),
    card('Propagation',
      field({label: 'Preset', type: 'select', value: '', tip: 'Load a set of propagation values used by the reference rooms.',
        options: [{value: '', label: 'Apply a preset…'}, ...Object.entries(presets).map(([k, v]) => ({value: k, label: v.label}))],
        onCommit: (v) => { if (v) edit('Apply propagation preset', (x) => { x.layout.propagation = JSON.parse(JSON.stringify(presets[v].propagation)); }); }}),
      h('div', {class: 'grid3'},
        ...rf.BANDS.map((b) => field({label: `Ref SNR ${b}`, unit: 'dB', value: prop.reference_snr_db_by_band[b], tipKey: 'layout.propagation.reference_snr_db_by_band',
          onCommit: (v) => edit('Edit reference SNR', (x) => { x.layout.propagation.reference_snr_db_by_band[b] = v; })}))),
      h('div', {class: 'grid3'},
        field({label: 'Exponent n', value: prop.path_loss_exponent, min: 0.1, step: 0.1, tipKey: 'layout.propagation.path_loss_exponent',
          onCommit: (v) => { if (!(v > 0)) throw new Error('The exponent must be positive'); edit('Edit exponent', (x) => { x.layout.propagation.path_loss_exponent = v; }); }}),
        field({label: 'Ref distance', unit: 'm', value: prop.reference_distance_m, min: 0.01, step: 0.1, tipKey: 'layout.propagation.reference_distance_m',
          onCommit: (v) => { if (!(v > 0)) throw new Error('Must be positive'); edit('Edit reference distance', (x) => { x.layout.propagation.reference_distance_m = v; }); }}),
        field({label: 'Shadowing σ', unit: 'dB', value: prop.shadowing_stddev_db, min: 0, step: 0.5, tipKey: 'layout.propagation.shadowing_stddev_db',
          onCommit: (v) => { if (v < 0) throw new Error('Must be ≥ 0'); edit('Edit shadowing', (x) => { x.layout.propagation.shadowing_stddev_db = v; }); }})),
      h('div', {class: 'grid2'},
        field({label: 'SNR floor', unit: 'dB', value: prop.minimum_snr_db, min: -20, max: 60, step: 1, tipKey: 'layout.propagation.minimum_snr_db',
          onCommit: (v) => { if (!(Number.isInteger(v) && v >= -20 && v <= prop.maximum_snr_db)) throw new Error('Integer in [-20, ceiling]'); edit('Edit SNR floor', (x) => { x.layout.propagation.minimum_snr_db = v; }); }}),
        field({label: 'SNR ceiling', unit: 'dB', value: prop.maximum_snr_db, min: -20, max: 60, step: 1, tipKey: 'layout.propagation.maximum_snr_db',
          onCommit: (v) => { if (!(Number.isInteger(v) && v <= 60 && v >= prop.minimum_snr_db)) throw new Error('Integer in [floor, 60]'); edit('Edit SNR ceiling', (x) => { x.layout.propagation.maximum_snr_db = v; }); }})),
      h('p', {class: 'help'}, 'Example — 10 m through one 5 dB wall: ', h('b', {}, example)),
      prop.shadowing_stddev_db > 0 ? h('p', {class: 'help'}, 'Shadowing is included in the compiled world (seeded by the scenario seed); the live preview shows the geometric mean.') : null),
    card('Editing',
      h('div', {class: 'grid2'},
        field({label: 'Snap grid', type: 'select', value: state.snap, tip: 'Grid for placing walls and devices. Alt while dragging disables snapping. Wall ends also snap to other wall ends and to walls.',
          options: [0.01, 0.05, 0.1, 0.25, 0.5, 1].map((v) => ({value: v, label: v + ' m'})),
          onCommit: (v) => { state.snap = Number(v); savePrefs(); emit('view'); }}),
        field({label: 'Walk speed', unit: 'm/s', value: state.walkSpeed, min: 0.1, step: 0.1,
          tip: 'Used by the Path tool and Retime to turn distances into waypoint times. 0.6 stroll · 1.4 walk · 3.0 run.',
          onCommit: (v) => { if (!(v > 0)) throw new Error('Must be positive'); state.walkSpeed = v; savePrefs(); }}))),
    card('View',
      viewCheck('links', 'Strongest simulated links (stations + extenders)', 'Dashed line from each client to its strongest present AP on the selected band, coloured by the viewer\'s signal meter.'),
      h('div', {class: 'row', style: {margin: '4px 0'}}, h('span', {class: 'help', style: {margin: 0}}, 'Backhaul'),
        segmented([{value: 'viewer', label: 'Viewer (all pairs)', tip: 'Exactly what the offline viewer draws: a floor ribbon between every pair of wireless APs.'},
          {value: 'tree', label: 'Predicted tree', tip: 'Breadth-first tree from the gateway using hops ≥ 20 dB on 5 GHz; weak fallbacks are thin.'},
          {value: 'off', label: 'Off'}], state.view.backhaul, (v) => { setView({backhaul: v}); savePrefs(); }, {small: true})),
      viewCheck('trails', 'Mobile trails up to now', 'Purple floor trail of every moving client, sampled at the tick like the viewer.'),
      viewCheck('paths', 'Planned paths of all roles', 'Dashed purple waypoint paths; the selected role\'s path is always shown with draggable waypoints.'),
      viewCheck('labels', 'Device labels', 'Agent-1 / Extender-N / m01 / s01 badges.'),
      viewCheck('wallLabels', 'Wall names and losses on the floor'),
      viewCheck('gauges', 'Signal gauges', '10-segment meters: best downlink for clients, strongest mesh peer (RF xx dB) for extenders.'),
      viewCheck('materialTint', 'Tint walls by material and thickness', 'Off reproduces the viewer exactly: every wall 12 cm, taupe, translucent.'),
      viewCheck('fineGrid', 'Fine snap grid on the floor'),
      h('div', {class: 'row', style: {margin: '4px 0'}}, viewCheck('heatmap', 'Coverage heatmap', 'Best AP→point SNR on the selected band (H).'),
        segmented([{value: 'banded', label: 'Meter bands'}, {value: 'continuous', label: 'Continuous'}], state.view.heatStyle,
          (v) => { setView({heatStyle: v}); savePrefs(); }, {small: true}))),
    card('Tip',
      tipBox,
      h('button', {class: 'small', onclick: () => { tipAt = (tipAt + 1) % TIPS.length; tipBox.textContent = TIPS[tipAt]; }}, 'Next tip')),
  ];
}

function viewCheck(key, label, tip) {
  return field({type: 'checkbox', label, tip, value: state.view[key], onCommit: (v) => { setView({[key]: v}); savePrefs(); }});
}

function resize(width, height, forced) {
  if (!(width > 0 && height > 0)) throw new Error('The room needs a positive size');
  const mode = forced || (state.scaleContents ? 'scale' : 'extend');
  const d = state.design;
  if (mode === 'extend') {
    const b = ops.contentBounds(d);
    if (b.maxX > width || b.maxY > height) {
      throw new Error(`Contents reach (${fmt(b.maxX)}, ${fmt(b.maxY)}) m; enable "Scale contents" or move them first`);
    }
  }
  edit(`Resize room to ${fmt(width)} × ${fmt(height)} m`, (x) => ops.resizeRoom(x, width, height, mode));
  emit('fit');
}

// ======================================================================= Walls
function wallsTab() {
  const d = state.design;
  const mats = state.meta.materials.materials;
  const walls = d.layout.walls || [];
  const wallMats = (d.builder && d.builder.wall_materials) || [];
  const sel = state.selection && state.selection.type === 'wall' ? state.selection.index : -1;
  const palette = h('div', {class: 'materials'}, mats.map((m) => h('button', {
    class: 'material', 'aria-pressed': String(state.activeMaterial === m.id), 'data-tip': m.tip,
    onclick: () => { state.activeMaterial = m.id; savePrefs(); emit('material'); markStale('walls'); refreshVisible(); },
  }, h('span', {class: 'swatch', style: {background: m.color}}), m.label, h('span', {class: 'db'}, m.loss_db === null ? '' : m.loss_db + ' dB'))));
  const totals = {};
  for (let i = 0; i < walls.length; i++) {
    const m = wallMats[i] || 'custom';
    totals[m] = (totals[m] || 0) + Math.hypot(walls[i].end[0] - walls[i].start[0], walls[i].end[1] - walls[i].start[1]);
  }
  const list = walls.length ? h('div', {class: 'list'}, walls.map((w, i) => {
    const m = mats.find((x) => x.id === wallMats[i]) || mats.find((x) => x.id === 'custom');
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    return h('div', {class: 'item' + (i === sel ? ' selected' : ''), onclick: () => { select({type: 'wall', index: i}); emit('focusSelection'); }},
      h('span', {class: 'swatch', style: {background: m.color}}),
      h('span', {}, w.name || `wall ${i + 1}`, h('span', {class: 'muted'}, ` · ${fmt(len)} m`)),
      h('b', {}, `${fmt(w.loss_db)} dB`));
  })) : h('div', {class: 'list'}, h('div', {class: 'empty'}, 'No walls yet. Choose a material, then draw with the Wall tool (W) or drag a Box (R).'));
  return [
    card('Material',
      h('p', {class: 'help'}, 'The configurator knows one number per wall: the loss added on every band each time the direct path properly crosses it. The material sets that number and the drawing style.'),
      palette,
      state.activeMaterial === 'custom' ? field({label: 'Custom loss', unit: 'dB', value: state.customLoss, min: 0, step: 0.5, tipKey: 'layout.walls[].loss_db',
        onCommit: (v) => { if (v < 0) throw new Error('Loss cannot be negative'); state.customLoss = v; }}) : null,
      h('div', {class: 'row', style: {marginTop: '8px'}},
        h('button', {onclick: () => setTool('wall'), 'data-tip': 'Draw walls (W)'}, 'Draw walls'),
        h('button', {onclick: () => setTool('room'), 'data-tip': 'Drag a rectangle of four walls (R)'}, 'Room box'),
        h('button', {onclick: () => setTool('door'), 'data-tip': 'Cut door gaps (D)'}, 'Door gap')),
      field({label: 'Door width', unit: 'm', value: state.doorWidth, min: 0.3, step: 0.1, tip: 'Gap width cut by the Door tool and the wall menu.',
        onCommit: (v) => { if (!(v > 0.1)) throw new Error('Too narrow'); state.doorWidth = v; savePrefs(); }})),
    card(`Walls (${walls.length})`, list,
      walls.length ? h('p', {class: 'help'}, Object.entries(totals).map(([m, len]) => `${(mats.find((x) => x.id === m) || {label: m}).label}: ${fmt(len, 1)} m`).join(' · ')) : null,
      walls.length ? h('div', {class: 'row'},
        h('button', {class: 'small', 'data-tip': 'Give every wall the active material and its loss.',
          onclick: () => {
            const m = mats.find((x) => x.id === state.activeMaterial);
            const loss = m.loss_db === null ? state.customLoss : m.loss_db;
            edit('Set all walls to ' + m.label, (x) => x.layout.walls.forEach((_w, i) => ops.setWallMaterial(x, i, m.id, loss)));
          }}, 'Apply material to all'),
        h('button', {class: 'small danger', onclick: () => { if (confirm(`Delete all ${walls.length} walls?`)) edit('Delete all walls', (x) => { x.layout.walls = []; x.builder.wall_materials = []; }); }}, 'Delete all')) : null),
    card('Tips',
      h('p', {class: 'help'}, h('b', {}, 'Double walls: '), 'select a wall and use ', h('b', {}, 'Double'), ' in its panel for a parallel copy 20 cm away — both losses add up.'),
      h('p', {class: 'help'}, h('b', {}, 'Precise walls: '), 'switch to ', h('b', {}, 'Plan'), ' view, start a wall, type its length (e.g. ', h('kbd', {}, '3.6'), ') and press ', h('kbd', {}, 'Enter'), '. Hold ', h('kbd', {}, 'Shift'), ' for 15° steps.'),
      h('p', {class: 'help'}, h('b', {}, 'Room edges: '), 'walls along the room boundary never change a link — every device is inside the room. Exterior walls matter only around courtyards or gardens inside the room.')),
  ];
}

// ======================================================================= Devices
function devicesTab() {
  const d = state.design;
  const nodes = rf.mergeNodes(d.layout, d.mobility);
  const scene = rf.sceneAt(d, state.timeMs);
  const best = rf.bestServing(scene, d.layout, state.band);
  const sel = state.selection && state.selection.role;
  const aps = nodes.filter((n) => n.kind === 'fronthaul_ap');
  const stas = nodes.filter((n) => n.kind === 'station');
  const row = (n) => {
    const entry = scene.byRole[n.role];
    const kc = rf.kindClass(n.role, n.kind);
    const extra = n.kind === 'station' ? (best[n.role] ? `${rf.displayRole(best[n.role].ap)} ${best[n.role].snr} dB` : 'offline')
      : (n.backhaul === 'wired' ? 'wired' : entry && entry.present ? 'on air' : 'absent');
    return h('div', {class: 'item' + (n.role === sel ? ' selected' : ''), onclick: () => { select({type: 'node', role: n.role}); emit('focusSelection'); }},
      h('span', {class: 'swatch round', style: {background: entry && !entry.present ? '#c9c9c9' : `var(--${kc})`}}),
      h('span', {}, n.kind === 'fronthaul_ap' ? rf.displayRole(n.role) : n.role, n.path && n.path.length > 1 ? h('span', {class: 'muted'}, ' · moving') : null),
      h('span', {class: 'muted'}, extra));
  };
  return [
    card('Add',
      h('div', {class: 'row'},
        h('button', {onclick: () => setTool('ap'), 'data-tip': 'Then click the floor (E). The first agent is the gateway.'}, '+ Agent'),
        h('button', {onclick: () => setTool('client'), 'data-tip': 'Then click the floor (C).'}, '+ Client'),
        h('button', {onclick: () => setTool('path'), 'data-tip': 'Click empty floor to create a mobile client, then its waypoints (P).'}, '+ Mobile client')),
      bulkClients()),
    placementCard(),
    card(`Agents (${aps.length})`, h('div', {class: 'list'}, aps.length ? aps.map(row) : h('div', {class: 'empty'}, 'Add the gateway first.'))),
    card(`Clients (${stas.length})`, h('div', {class: 'list'}, stas.length ? stas.map(row) : h('div', {class: 'empty'}, 'No clients: the configurator needs at least one station.'))),
  ];
}

function bulkClients() {
  const count = h('input', {type: 'number', value: '10', min: '1', max: '100', step: '1', style: {width: '64px'}});
  const pattern = h('select', {style: {width: 'auto'}},
    h('option', {value: 'grid'}, 'even grid'), h('option', {value: 'random'}, 'scattered'), h('option', {value: 'cluster'}, 'cluster at selection'));
  return h('div', {class: 'row', style: {marginTop: '8px'}, 'data-tip': 'Adds static clients using the next free lab roles (sta_static_01…10, then sta_pool_021…). Positions keep 30 cm from walls; scattered uses a fixed seed so results repeat.'},
    h('span', {class: 'help', style: {margin: 0}}, 'Add'), count, h('span', {class: 'help', style: {margin: 0}}, 'clients'), pattern,
    h('button', {class: 'small', onclick: () => addBulk(Number(count.value), pattern.value)}, 'Add'));
}

function addBulk(count, pattern) {
  const d = state.design;
  if (!(count >= 1 && count <= 200)) throw new Error('Choose 1–200 clients');
  const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const center = state.selection && state.selection.role && rf.sceneAt(d, state.timeMs).byRole[state.selection.role];
  const points = [];
  const ok = (p) => p[0] > 0.3 && p[1] > 0.3 && p[0] < W - 0.3 && p[1] < H - 0.3 &&
    (d.layout.walls || []).every((w) => rf.pointSegmentDistance(p, w.start, w.end) >= 0.3) &&
    points.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.25);
  if (pattern === 'grid') {
    const cols = Math.ceil(Math.sqrt(count * W / H)), rows = Math.ceil(count / cols);
    for (let j = 0; j < rows && points.length < count; j++) {
      for (let i = 0; i < cols && points.length < count; i++) {
        let p = [rf.round3((i + 0.5) * W / cols), rf.round3((j + 0.5) * H / rows)];
        for (let k = 0; k < 20 && !ok(p); k++) p = [rf.round3(p[0] + (rand() - 0.5) * 0.8), rf.round3(p[1] + (rand() - 0.5) * 0.8)];
        if (ok(p)) points.push(p);
      }
    }
  } else {
    const c = pattern === 'cluster' && center ? center.position : null;
    for (let k = 0; k < count * 60 && points.length < count; k++) {
      const p = c ? [rf.round3(c[0] + (rand() - 0.5) * 4), rf.round3(c[1] + (rand() - 0.5) * 4)] : [rf.round3(0.3 + rand() * (W - 0.6)), rf.round3(0.3 + rand() * (H - 0.6))];
      if (ok(p)) points.push(p);
    }
  }
  edit(`Add ${points.length} clients`, (x) => { for (const p of points) ops.addNode(x, {kind: 'station', position: p, lab: x.profile !== 'configurator'}); });
  ui.toast(`Added ${points.length} clients.`);
}

function placementCard() {
  const d = state.design;
  const extenders = rf.mergeNodes(d.layout, d.mobility).filter((n) => n.kind === 'fronthaul_ap' && n.role !== 'gateway' && n.backhaul !== 'wired');
  const opts = state.placementOptions = state.placementOptions || {count: Math.max(4, extenders.length) || 4, band: '5', strategy: 'replace',
    objective: 'balanced', target_snr_db: 30, min_backhaul_snr_db: 20, min_spacing_m: ''};
  const result = state.placement;
  const set = (k) => (v) => { opts[k] = v; };
  const body = [
    h('p', {class: 'help'}, 'Place N extenders for the best coverage. Every extender keeps a Wi-Fi backhaul hop to the gateway or another extender, never stands on a wall line, and respects a minimum spacing.'),
    h('div', {class: 'grid3'},
      field({label: 'Extenders', value: opts.count, min: 0, max: 32, step: 1, tip: 'How many extenders to place (the lab uses 4).', onCommit: (v) => { if (!(Number.isInteger(v) && v >= 0 && v <= 32)) throw new Error('0–32'); opts.count = v; }}),
      field({label: 'Band', type: 'select', value: opts.band, options: rf.BANDS.map((b) => ({value: b, label: b + ' GHz'})), tip: 'Fronthaul band to optimise.', onCommit: set('band')}),
      field({label: 'Target', unit: 'dB', value: opts.target_snr_db, step: 1, tip: 'SNR a point needs to count as well covered. Utility rises linearly from target − 25 dB to the target.', onCommit: set('target_snr_db')})),
    h('div', {class: 'grid3'},
      field({label: 'Mode', type: 'select', value: opts.strategy, tip: 'Replace re-positions the existing extenders (keeping their roles); Add keeps every AP and adds new ones.',
        options: [{value: 'replace', label: 'Replace'}, {value: 'add', label: 'Add'}], onCommit: set('strategy')}),
      field({label: 'Optimise', type: 'select', value: opts.objective, tip: 'Floor area, client positions over the whole scenario, or both equally.',
        options: [{value: 'balanced', label: 'Area + clients'}, {value: 'area', label: 'Floor area'}, {value: 'clients', label: 'Clients'}], onCommit: set('objective')}),
      field({label: 'Backhaul ≥', unit: 'dB', value: opts.min_backhaul_snr_db, step: 1, tip: 'Minimum 5 GHz SNR (weaker direction) of each extender\'s hop toward the gateway.', onCommit: set('min_backhaul_snr_db')})),
    h('div', {class: 'row', style: {marginTop: '8px'}},
      h('button', {class: 'primary', id: 'btnOptimize', onclick: runPlacement}, result && result.pending ? 'Optimising…' : 'Optimise placement'),
      result && !result.pending ? h('button', {id: 'btnApplyPlacement', onclick: applyPlacement, 'data-tip': 'Write the proposed positions into the layout (one undo step).'}, 'Apply') : null,
      result && !result.pending ? h('button', {id: 'btnDiscardPlacement', onclick: () => { state.placement = null; emit('placement'); emit('overlay'); }}, 'Discard') : null),
  ];
  if (result && result.error) body.push(h('div', {class: 'notes warn'}, result.error));
  if (result && result.placements) {
    const a = result.after.area || result.after.clients || {}, b = result.before.area || result.before.clients || {};
    body.push(h('table', {},
      h('tr', {}, h('th', {}, 'Role'), h('th', {}, 'x'), h('th', {}, 'y'), h('th', {}, 'Backhaul')),
      result.placements.map((p) => h('tr', {}, h('td', {}, rf.displayRole(p.role)), h('td', {}, fmt(p.position[0])), h('td', {}, fmt(p.position[1])),
        h('td', {}, `${p.backhaul_parent ? rf.displayRole(p.backhaul_parent) : '—'} ${p.backhaul_snr_db ?? ''} dB`)))));
    body.push(h('div', {class: 'metric-grid', style: {marginTop: '6px'}},
      h('span', {}, `Area ≥ ${result.target_snr_db} dB`), h('b', {}, `${fmt(b.coverage_pct, 1)}% → ${fmt(a.coverage_pct, 1)}%`),
      h('span', {}, 'Mean best SNR'), h('b', {}, `${fmt(b.mean_snr_db, 1)} → ${fmt(a.mean_snr_db, 1)} dB`),
      h('span', {}, '10th percentile'), h('b', {}, `${fmt(b.p10_snr_db, 1)} → ${fmt(a.p10_snr_db, 1)} dB`),
      result.after.clients ? [h('span', {}, 'Clients: mean'), h('b', {}, `${fmt((result.before.clients || {}).mean_snr_db, 1)} → ${fmt(result.after.clients.mean_snr_db, 1)} dB`)] : null,
      h('span', {}, 'Backhaul tree'), h('b', {}, result.backhaul_connected ? 'connected' : 'incomplete')));
    if (result.removed && result.removed.length) body.push(h('p', {class: 'help'}, 'Removes: ' + result.removed.join(', ')));
    for (const note of result.notes || []) body.push(h('p', {class: 'help'}, note));
    body.push(h('p', {class: 'help'}, `${result.candidates} candidates × ${result.samples} samples in ${result.elapsed_ms} ms. Purple ghosts in the room show the proposal.`));
  }
  return h('section', {class: 'card purple'}, h('h2', {}, 'Place extenders optimally ', h('span', {class: 'badge purple'}, 'RF MODEL')), ...body);
}

async function runPlacement() {
  const opts = state.placementOptions;
  state.placement = {pending: true};
  emit('placement');
  try {
    const result = await api.place(state.design, {
      count: opts.count, band: opts.band, strategy: opts.strategy, objective: opts.objective,
      target_snr_db: opts.target_snr_db, min_backhaul_snr_db: opts.min_backhaul_snr_db,
      min_spacing_m: opts.min_spacing_m === '' ? null : opts.min_spacing_m,
    });
    state.placement = result;
  } catch (error) {
    state.placement = {error: error.message};
  }
  emit('placement');
  emit('overlay');
}

function applyPlacement() {
  const result = state.placement;
  if (!result || !result.design) return;
  edit(`Place ${result.placements.length} extenders`, (x) => {
    x.layout = result.design.layout;
    x.mobility = result.design.mobility;
  });
  ui.toast(`Placed ${result.placements.length} extenders. Area ≥ ${result.target_snr_db} dB: ${fmt((result.after.area || {}).coverage_pct, 1)}%.`);
  state.placement = null;
  emit('placement');
  emit('overlay');
}

// ======================================================================= Motion
function motionTab() {
  const d = state.design, M = d.mobility;
  const tick = Number(M.tick_ms);
  const pauses = M.pause_at_ms || [];
  const role = state.selection && (state.selection.type === 'node' || state.selection.type === 'waypoint') ? state.selection.role : null;
  const nodes = rf.mergeNodes(d.layout, d.mobility);
  const moving = nodes.filter((n) => (n.path && n.path.length > 1) || n.presence !== undefined);
  const parts = [
    card('Script',
      h('div', {class: 'grid3'},
        field({label: 'Duration', unit: 's', value: M.duration_ms / 1000, min: tick / 1000, step: tick / 1000, tipKey: 'mobility.duration_ms',
          onCommit: (v) => {
            const ms = Math.max(tick, Math.round(v * 1000 / tick) * tick);
            edit('Change duration', (x) => ops.setDuration(x, ms));
            if (ms !== Math.round(v * 1000)) ui.toast(`Rounded to ${ms / 1000} s: the duration must be a whole number of ${tick} ms ticks.`);
          }}),
        field({label: 'Tick', type: 'select', value: tick, tipKey: 'mobility.tick_ms',
          options: [...new Set([...TICKS, tick])].sort((a, b) => a - b).map((t) => ({value: t, label: t >= 1000 ? t / 1000 + ' s' : t + ' ms'})),
          onCommit: (v) => {
            const t = Number(v);
            const ms = Math.max(t, Math.round(M.duration_ms / t) * t);
            edit('Change tick', (x) => { x.mobility.tick_ms = t; ops.setDuration(x, ms); });
            ui.toast(`${ms / t} generations of ${t} ms${ms !== M.duration_ms ? `; duration adjusted to ${ms / 1000} s` : ''}.`);
          }}),
        field({label: 'Seed', value: M.seed ?? 0, step: 1, tipKey: 'mobility.seed',
          onCommit: (v) => { if (!Number.isInteger(v)) throw new Error('Integer seed'); edit('Change seed', (x) => { x.mobility.seed = v; }); }})),
      field({label: 'Backhaul RF', type: 'select', value: M.backhaul_rf || 'fixed', tipKey: 'mobility.backhaul_rf',
        options: [{value: 'fixed', label: 'fixed — protected startup backhaul (default)'}, {value: 'geometry', label: 'geometry — AP-to-AP RF follows the room'}],
        onCommit: (v) => edit('Change backhaul policy', (x) => { if (v === 'fixed') delete x.mobility.backhaul_rf; else x.mobility.backhaul_rf = v; })}),
      field({label: 'Scenario tags', type: 'text', value: (M.tags || []).join(', '), tipKey: 'mobility.tags',
        onCommit: (v) => edit('Edit scenario tags', (x) => { x.mobility.tags = v.split(',').map((s) => s.trim()).filter(Boolean); })}),
      h('label', {class: 'field', 'data-tip-key': 'mobility.pause_at_ms'}, 'Checkpoints'),
      h('div', {}, pauses.length ? pauses.map((t) => h('span', {class: 'chip'}, `${t / 1000} s`,
        h('button', {'aria-label': 'remove', onclick: () => edit('Remove checkpoint', (x) => {
          x.mobility.pause_at_ms = x.mobility.pause_at_ms.filter((p) => p !== t);
          if (!x.mobility.pause_at_ms.length) delete x.mobility.pause_at_ms;
          ops.dropOrphanApExpectations(x);
        })}, '×'))) : h('span', {class: 'help'}, 'none'),
      h('button', {class: 'small', 'data-tip': 'Add a checkpoint at the current time (must be strictly inside the script).',
        onclick: () => {
          const t = Math.round(state.timeMs / 100) * 100;
          if (!(t > 0 && t < M.duration_ms)) throw report(new Error('Move the playhead strictly inside the script first'));
          edit('Add checkpoint', (x) => { x.mobility.pause_at_ms = [...new Set([...(x.mobility.pause_at_ms || []), t])].sort((a, b) => a - b); });
        }}, `+ at ${(state.timeMs / 1000).toFixed(1)} s`)),
      h('p', {class: 'help'}, `${M.duration_ms / tick} generations · ${moving.length} moving/appearing role${moving.length === 1 ? '' : 's'}`)),
  ];
  if (role) parts.push(roleMotionCard(role));
  else parts.push(card('Selected role', h('p', {class: 'help'}, 'Select a client or agent to edit its path, presence and movement templates.')));
  parts.push(card('Moving and appearing roles', moving.length ? h('div', {class: 'list'}, moving.map((n) => {
    const s = ops.pathSummary(n);
    return h('div', {class: 'item' + (n.role === role ? ' selected' : ''), onclick: () => select({type: 'node', role: n.role})},
      h('span', {class: 'swatch round', style: {background: `var(--${rf.kindClass(n.role, n.kind)})`}}),
      h('span', {}, n.role),
      h('span', {class: 'muted'}, [s ? `${fmt(s.length_m, 1)} m · ${fmt(s.speed, 2)} m/s` : null, n.presence !== undefined ? `${n.presence.length} on-air span${n.presence.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')));
  })) : h('p', {class: 'help'}, 'Nothing moves yet. Select a client and press P to draw a path.')));
  return parts;
}

function roleMotionCard(role) {
  const d = state.design, M = d.mobility;
  const node = ops.merged(d, role);
  if (!node) return card('Selected role');
  const duration = Number(M.duration_ms);
  const s = ops.pathSummary(node);
  const path = node.path || [];
  const presence = node.presence === undefined ? null : node.presence;
  const speedInput = h('input', {type: 'number', value: String(state.walkSpeed), min: '0.1', step: '0.1', style: {width: '64px'}});
  const pathTable = path.length ? h('table', {},
    h('tr', {}, h('th', {}, '#'), h('th', {}, 'time s'), h('th', {}, 'x'), h('th', {}, 'y'), h('th', {}, '')),
    path.map((w, i) => h('tr', {class: state.selection && state.selection.type === 'waypoint' && state.selection.index === i ? 'best' : ''},
      h('td', {}, String(i + 1)),
      h('td', {}, numCell(w.time_ms / 1000, i === 0, (v) => setWaypointTime(role, i, v))),
      h('td', {}, numCell(w.position[0], false, (v) => setWaypoint(role, i, 0, v))),
      h('td', {}, numCell(w.position[1], false, (v) => setWaypoint(role, i, 1, v))),
      h('td', {}, i > 0 ? h('button', {class: 'small', 'aria-label': 'delete waypoint', onclick: () => edit('Delete waypoint', (x) => { ops.mobilityNode(x, role).path.splice(i, 1); })}, '×') : null)))) : null;
  const presenceRows = presence ? presence.map((iv, i) => h('div', {class: 'row', style: {margin: '3px 0'}},
    h('span', {class: 'help', style: {margin: 0}}, 'on air'),
    numCell(iv[0] / 1000, false, (v) => setInterval(role, i, 0, v)), h('span', {}, '→'), numCell(iv[1] / 1000, false, (v) => setInterval(role, i, 1, v)),
    h('span', {class: 'help', style: {margin: 0}}, 's'),
    h('button', {class: 'small', onclick: () => edit('Remove presence span', (x) => { ops.setPresence(x, role, presence.filter((_p, k) => k !== i)); })}, '×'))) : [];
  return card(`Selected · ${node.kind === 'fronthaul_ap' ? rf.displayRole(role) : role}`,
    h('h3', {}, 'Path'),
    s ? h('p', {class: 'help'}, `${s.waypoints} waypoints · ${fmt(s.length_m, 1)} m in ${fmt(s.duration_ms / 1000, 1)} s · average ${fmt(s.speed, 2)} m/s`)
      : h('p', {class: 'help'}, 'Static. Press P and click the floor to add waypoints, or drag the device at a later time to create a keyframe.'),
    pathTable,
    h('div', {class: 'row', style: {marginTop: '6px', flexWrap: 'wrap'}},
      path.length > 1 ? [h('button', {class: 'small', 'data-tip': 'Recompute waypoint times at a constant speed; dwells (repeated positions) keep their length.',
        onclick: () => { const v = Number(speedInput.value); if (!(v > 0)) return; edit(`Retime ${role}`, (x) => { ops.retimePath(x, role, v); fitDuration(x, role); }); }}, 'Retime at'), speedInput,
        h('span', {class: 'help', style: {margin: 0}}, 'm/s'),
        h('button', {class: 'small', 'data-tip': 'Remove the path; the role stays where it is at the current time.',
          onclick: () => edit(`Make ${role} static`, (x) => ops.removePath(x, role, state.timeMs))}, 'Make static')]
        : h('button', {class: 'small', onclick: () => { select({type: 'node', role}); setTool('path'); }}, 'Draw path (P)')),
    node.kind === 'station' ? h('div', {class: 'row', style: {marginTop: '6px', flexWrap: 'wrap'}, 'data-tip': 'Replace the path with a generated movement from the current position at the walk speed.'},
      h('span', {class: 'help', style: {margin: 0}}, 'Templates'),
      h('button', {class: 'small', onclick: () => template(role, 'perimeter')}, 'Room loop'),
      h('button', {class: 'small', onclick: () => template(role, 'cross')}, 'Cross & back'),
      h('button', {class: 'small', onclick: () => template(role, 'hover')}, 'Border hover'),
      h('button', {class: 'small', onclick: () => template(role, 'wander')}, 'Wander')) : null,
    h('h3', {'data-tip-key': 'mobility.nodes[].presence'}, 'Presence'),
    h('p', {class: 'help'}, presence === null ? 'On air for the whole script.' : presence.length ? `${presence.length} on-air span${presence.length > 1 ? 's' : ''}.` : 'Never on air (parked).'),
    ...presenceRows,
    h('div', {class: 'row', style: {flexWrap: 'wrap'}},
      h('button', {class: 'small', onclick: () => edit(`${role} off air from ${(state.timeMs / 1000).toFixed(1)} s`, (x) => ops.setPresenceFrom(x, role, state.timeMs, false))}, `Absent from ${(state.timeMs / 1000).toFixed(1)} s`),
      h('button', {class: 'small', onclick: () => edit(`${role} on air from ${(state.timeMs / 1000).toFixed(1)} s`, (x) => ops.setPresenceFrom(x, role, state.timeMs, true))}, `Present from ${(state.timeMs / 1000).toFixed(1)} s`),
      h('button', {class: 'small', onclick: () => edit(`${role} always on air`, (x) => ops.setPresence(x, role, null))}, 'Always'),
      role !== 'gateway' ? h('button', {class: 'small', 'data-tip': 'Keep the role (the lab binds it) but never transmit: presence [].',
        onclick: () => edit(`Park ${role}`, (x) => ops.setPresence(x, role, []))}, 'Park') : null),
    h('p', {class: 'help'}, `Script: 0 → ${duration / 1000} s. Presence spans are [start, end).`));
}

function numCell(value, disabled, onCommit) {
  const input = h('input', {type: 'number', step: 'any', disabled, style: {width: '64px', padding: '1px 4px'}});
  input.value = fmt(value, 3);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) { input.classList.add('invalid'); return; }
    try { onCommit(v); } catch (error) { input.classList.add('invalid'); report(error); }
  });
  return input;
}

function setWaypoint(role, index, axis, value) {
  const W = Number(state.design.layout.space[axis ? 'height_m' : 'width_m']);
  if (value < 0 || value > W) throw new Error(`Must stay inside 0..${W} m`);
  edit('Edit waypoint', (x) => {
    const mob = ops.mobilityNode(x, role);
    mob.path[index].position[axis] = rf.round3(value);
    const lay = ops.layoutNode(x, role);
    if (index === 0 && lay) lay.position = mob.path[0].position.slice();
  });
}

function setWaypointTime(role, index, seconds) {
  const ms = Math.round(seconds * 1000);
  const mob = ops.mobilityNode(state.design, role);
  const prev = mob.path[index - 1], next = mob.path[index + 1];
  if (prev && ms <= prev.time_ms) throw new Error('Waypoint times must increase');
  if (next && ms >= next.time_ms) throw new Error('Waypoint times must increase');
  if (ms > state.design.mobility.duration_ms) throw new Error('After the end of the script');
  edit('Retime waypoint', (x) => { ops.mobilityNode(x, role).path[index].time_ms = ms; });
}

function setInterval(role, index, which, seconds) {
  const ms = Math.round(seconds * 1000);
  const node = ops.merged(state.design, role);
  const next = node.presence.map((iv) => iv.slice());
  next[index][which] = ms;
  const duration = state.design.mobility.duration_ms;
  let prevEnd = -1;
  for (const [s, e] of next) {
    if (!(0 <= s && s < e && e <= duration)) throw new Error('Each span needs 0 ≤ start < end ≤ duration');
    if (s < prevEnd) throw new Error('Spans must be ordered and must not overlap');
    prevEnd = e;
  }
  edit('Edit presence', (x) => ops.setPresence(x, role, next));
}

function fitDuration(x, role) {
  const mob = ops.mobilityNode(x, role);
  const last = mob.path[mob.path.length - 1].time_ms;
  const tick = Number(x.mobility.tick_ms);
  if (last > x.mobility.duration_ms) x.mobility.duration_ms = Math.ceil(last / tick) * tick;
}

function template(role, kind) {
  const d = state.design;
  const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
  const start = rf.sceneAt(d, 0).byRole[role].position;
  const m = Math.min(1.5, W / 6, H / 6);
  let points;
  if (kind === 'perimeter') points = [start, [m, m], [W - m, m], [W - m, H - m], [m, H - m], [m, m]];
  else if (kind === 'cross') points = [start, [W - start[0], H - start[1]], start];
  else if (kind === 'hover') {
    points = [start];
    for (let i = 0; i < 12; i++) points.push([rf.round3(start[0] + (i % 2 ? 0.6 : -0.6)), start[1]]);
  } else {
    let seed = role.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 2147483647;
    const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    points = [start];
    for (let i = 0; i < 8; i++) points.push([rf.round3(m + rand() * (W - 2 * m)), rf.round3(m + rand() * (H - 2 * m))]);
  }
  points = points.map((p) => [Math.min(W, Math.max(0, rf.round3(p[0]))), Math.min(H, Math.max(0, rf.round3(p[1])))]);
  edit(`Apply ${kind} path to ${role}`, (x) => {
    const mob = ops.ensurePath(x, role);
    mob.path = [{time_ms: 0, position: points[0]}];
    for (const p of points.slice(1)) ops.appendWaypoint(x, role, p, kind === 'hover' ? 0.6 : state.walkSpeed);
    if (kind === 'hover') {
      const tick = Number(x.mobility.tick_ms);
      mob.path.forEach((w, i) => { w.time_ms = i * tick; });
    }
    fitDuration(x, role);
  });
  ui.toast(`Applied "${kind}" to ${role}. Press Space to watch it.`);
}

// ======================================================================= Scenario
function scenarioTab() {
  const d = state.design, M = d.mobility;
  const nodes = rf.mergeNodes(d.layout, d.mobility);
  const stations = nodes.filter((n) => n.kind === 'station').map((n) => n.role);
  const aps = nodes.filter((n) => n.kind === 'fronthaul_ap').map((n) => n.role);
  const profiles = M.band_steering || {};
  const guide = (d.builder && d.builder.guide) || {};
  const traffic = M.traffic_experiment ? M.traffic_experiment.phases : [];
  const bandBoxes = (role, profile) => h('span', {}, rf.BANDS.map((b) => h('label', {class: 'check', style: {display: 'inline-flex', marginRight: '8px'}},
    h('input', {type: 'checkbox', checked: profile.allowed_bands.includes(b) ? true : null, onchange: (e) => edit('Edit allowed bands', (x) => {
      const p = x.mobility.band_steering[role];
      p.allowed_bands = rf.BANDS.filter((bb) => (bb === b ? e.target.checked : p.allowed_bands.includes(bb)));
      if (!p.allowed_bands.includes(p.initial_band) && p.allowed_bands.length) p.initial_band = p.allowed_bands[0];
      if (p.measurement_mode && p.allowed_bands.length !== 1) delete p.measurement_mode;
    })}), b)));
  const expectations = M.band_steering_expectations || [];
  return [
    card('Band steering profiles',
      h('p', {class: 'help', 'data-tip-key': 'mobility.band_steering'}, 'Up to four initially present clients with explicit band permissions. The live room applies them to the client\'s supplicant; the offline compiler only carries them.'),
      Object.entries(profiles).map(([role, p]) => h('div', {class: 'card soft'},
        h('div', {class: 'row'}, h('b', {}, role), h('button', {class: 'small danger', style: {marginLeft: 'auto'}, onclick: () => edit('Remove band profile', (x) => {
          delete x.mobility.band_steering[role];
          if (!Object.keys(x.mobility.band_steering).length) delete x.mobility.band_steering;
        })}, 'Remove')),
        h('div', {}, h('span', {class: 'help'}, 'Allowed '), bandBoxes(role, p)),
        h('div', {class: 'grid2'},
          field({label: 'Initial band', type: 'select', value: p.initial_band, options: p.allowed_bands.map((b) => ({value: b, label: b + ' GHz'})),
            onCommit: (v) => edit('Edit initial band', (x) => { x.mobility.band_steering[role].initial_band = v; })}),
          field({label: 'Measurement', type: 'select', value: p.measurement_mode || '', tip: 'received_same_band: use AP→client passive reception for serving and target RCPI; needs exactly one allowed band.',
            options: [{value: '', label: 'native candidates'}, {value: 'received_same_band', label: 'received_same_band'}],
            onCommit: (v) => edit('Edit measurement mode', (x) => {
              const q = x.mobility.band_steering[role];
              if (v) { if (q.allowed_bands.length !== 1) throw new Error('received_same_band needs exactly one allowed band'); q.measurement_mode = v; } else delete q.measurement_mode;
            })})))),
      Object.keys(profiles).length < 4 ? h('div', {class: 'row'},
        h('select', {id: 'bsRole', style: {width: 'auto'}}, stations.filter((r) => !profiles[r]).map((r) => h('option', {value: r}, r))),
        h('button', {class: 'small', onclick: () => {
          const r = document.getElementById('bsRole').value;
          if (r) edit('Add band profile', (x) => { x.mobility.band_steering = Object.assign(x.mobility.band_steering || {}, {[r]: {allowed_bands: ['2.4', '5', '6'], initial_band: '5'}}); });
        }}, '+ Profile')) : h('p', {class: 'help'}, 'Four profiles is the maximum.')),
    card('Band / AP expectations',
      h('p', {class: 'help', 'data-tip-key': 'mobility.band_steering_expectations'}, 'Signed checkpoints stating which AP and band each profiled client should use. Typically at 0 s, each pause and the end.'),
      expectations.map((item, index) => h('div', {class: 'card soft'},
        h('div', {class: 'row'}, h('b', {}, `at ${item.time_ms / 1000} s`), h('button', {class: 'small danger', style: {marginLeft: 'auto'},
          onclick: () => edit('Remove expectation', (x) => { x.mobility.band_steering_expectations.splice(index, 1); if (!x.mobility.band_steering_expectations.length) delete x.mobility.band_steering_expectations; })}, 'Remove')),
        Object.entries(item.roles).map(([role, exp]) => h('div', {class: 'grid3'},
          h('span', {class: 'help'}, role),
          field({label: 'band', type: 'select', value: exp.band, options: rf.BANDS.map((b) => ({value: b, label: b})),
            onCommit: (v) => edit('Edit expectation', (x) => { x.mobility.band_steering_expectations[index].roles[role].band = v; })}),
          field({label: 'AP', type: 'select', value: exp.ap, options: aps.map((a) => ({value: a, label: a})),
            onCommit: (v) => edit('Edit expectation', (x) => { x.mobility.band_steering_expectations[index].roles[role].ap = v; })}))))),
      Object.keys(profiles).length ? h('button', {class: 'small', onclick: () => {
        const t = Math.round(state.timeMs);
        const scene = rf.sceneAt(state.design, t);
        edit('Add expectation', (x) => {
          const list = x.mobility.band_steering_expectations = x.mobility.band_steering_expectations || [];
          if (list.some((e) => e.time_ms === t)) throw new Error('An expectation already exists at this time');
          const roles = {};
          for (const [r, p] of Object.entries(x.mobility.band_steering)) {
            const best = rf.bestServing(scene, x.layout, p.initial_band)[r];
            roles[r] = {band: p.initial_band, ap: best ? best.ap : 'gateway'};
          }
          list.push({time_ms: t, roles});
          list.sort((a, b) => a.time_ms - b.time_ms);
        });
      }}, `+ at ${(state.timeMs / 1000).toFixed(1)} s (predicted best AP)`) : h('p', {class: 'help'}, 'Add a band profile first.')),
    apExpectationsCard(stations, aps),
    card('Traffic experiment',
      h('p', {class: 'help', 'data-tip-key': 'mobility.traffic_experiment'}, '1–4 ordered phases in the first 60 s, each ≤ 20 s, from an initially present client. ICMP 1–200 packets/s or UDP 0.1–12 Mbps; payload 64–1200 bytes.'),
      traffic.map((p, index) => trafficPhase(p, index, stations)),
      traffic.length < 4 && stations.length ? h('button', {class: 'small', onclick: () => edit('Add traffic phase', (x) => {
        const phases = x.mobility.traffic_experiment ? x.mobility.traffic_experiment.phases : [];
        const start = phases.length ? phases[phases.length - 1].end_ms : 5000;
        if (start >= Math.min(60000, x.mobility.duration_ms)) throw new Error('No room left inside the first 60 s of the script');
        phases.push({role: stations[0], start_ms: start, end_ms: Math.min(start + 5000, 60000, x.mobility.duration_ms), mode: 'udp', offered_mbps: 1, payload_bytes: 1200});
        x.mobility.traffic_experiment = {schema: 'easymesh.room-traffic.v1', phases};
      })}, '+ Phase') : null),
    card('Room guide',
      h('p', {class: 'help'}, 'Text for the viewer\'s "Browse rooms · RF & optimizer guide". Exported as a room-guide entry in the lab bundle.'),
      ['rf', 'optimizer', 'watch', 'limits'].map((key) => field({
        label: {rf: 'Simulated RF', optimizer: 'Expected optimizer behavior', watch: 'Evidence to check in both views', limits: 'What this does not prove'}[key],
        type: 'textarea', rows: 2, value: guide[key] || '',
        onCommit: (v) => edit('Edit room guide', (x) => { x.builder.guide = Object.assign({}, x.builder.guide || {}, {[key]: v}); }),
      }))),
    card('Notes', field({label: 'Private notes (not exported to the lab)', type: 'textarea', rows: 3, value: (d.builder && d.builder.notes) || '',
      onCommit: (v) => edit('Edit notes', (x) => { x.builder.notes = v; })})),
  ];
}

// ap_expectations: at 'final' or a checkpoint, the AP each named client must be on.
function apExpectationsCard(stations, aps) {
  const M = state.design.mobility;
  const list = M.ap_expectations || [];
  const pauses = M.pause_at_ms || [];
  const label = (at) => (at === 'final' ? 'final settle' : `checkpoint ${at / 1000} s`);
  const free = ['final', ...pauses].filter((at) => !list.some((item) => item.at === at));
  const update = (label2, fn) => edit(label2, (x) => {
    fn(x.mobility);
    x.mobility.ap_expectations = x.mobility.ap_expectations.filter((item) => Object.keys(item.roles).length);
    if (!x.mobility.ap_expectations.length) delete x.mobility.ap_expectations;
  });
  const entry = (item, index) => {
    const station = h('select', {style: {width: 'auto'}}, stations.filter((r) => !item.roles[r]).map((r) => h('option', {value: r}, r)));
    const ap = h('select', {style: {width: 'auto'}}, aps.map((r) => h('option', {value: r}, rf.displayRole(r))));
    return h('div', {class: 'card soft'},
      h('div', {class: 'row'}, h('b', {}, label(item.at)), h('button', {class: 'small danger', style: {marginLeft: 'auto'},
        onclick: () => update('Remove AP expectation', (m) => { m.ap_expectations.splice(index, 1); })}, 'Remove')),
      Object.entries(item.roles).map(([sta, target]) => h('div', {class: 'row', style: {margin: '3px 0'}},
        h('span', {class: 'help', style: {margin: 0, minWidth: '110px'}}, sta), h('span', {}, '→'),
        h('select', {style: {width: 'auto'}, onchange: (e) => update('Edit AP expectation', (m) => { m.ap_expectations[index].roles[sta] = e.target.value; })},
          aps.map((r) => h('option', {value: r, selected: r === target ? true : null}, rf.displayRole(r)))),
        h('button', {class: 'small', 'aria-label': 'remove client', onclick: () => update('Edit AP expectation', (m) => { delete m.ap_expectations[index].roles[sta]; })}, '×'))),
      h('div', {class: 'row', style: {marginTop: '4px'}}, station, h('span', {}, '→'), ap,
        h('button', {class: 'small', onclick: () => { if (station.value) update('Edit AP expectation', (m) => { m.ap_expectations[index].roles[station.value] = ap.value; }); }}, '+')));
  };
  const at = h('select', {style: {width: 'auto'}}, free.map((v) => h('option', {value: String(v)}, label(v))));
  return card('AP expectations',
    h('p', {class: 'help', 'data-tip-key': 'mobility.ap_expectations'}, 'Which AP each named client must be on at the final settle or at a checkpoint. The wired-extender rooms use it; each entry needs at least one client.'),
    list.map(entry),
    free.length && stations.length && aps.length ? h('div', {class: 'row'}, at,
      h('button', {class: 'small', onclick: () => {
        const value = at.value === 'final' ? 'final' : Number(at.value);
        const scene = rf.sceneAt(state.design, value === 'final' ? state.design.mobility.duration_ms - 1 : value);
        const best = rf.bestServing(scene, state.design.layout, state.band);
        const first = stations.find((r) => best[r]) || stations[0];
        edit('Add AP expectation', (x) => {
          x.mobility.ap_expectations = [...(x.mobility.ap_expectations || []),
            {at: value, roles: {[first]: best[first] ? best[first].ap : aps[0]}}];
        });
      }}, '+ Expectation (predicted best AP)'))
      : h('p', {class: 'help'}, free.length ? 'Add clients and agents first.' : 'Every checkpoint and the final settle already have one; add a checkpoint in Motion.'));
}

function trafficPhase(p, index, stations) {
  const udp = p.mode === 'udp';
  const update = (fn) => edit('Edit traffic phase', (x) => fn(x.mobility.traffic_experiment.phases[index]));
  return h('div', {class: 'card soft'},
    h('div', {class: 'row'}, h('b', {}, `Phase ${index + 1}`), h('button', {class: 'small danger', style: {marginLeft: 'auto'}, onclick: () => edit('Remove traffic phase', (x) => {
      x.mobility.traffic_experiment.phases.splice(index, 1);
      if (!x.mobility.traffic_experiment.phases.length) delete x.mobility.traffic_experiment;
    })}, 'Remove')),
    h('div', {class: 'grid3'},
      field({label: 'Client', type: 'select', value: p.role, options: stations.map((r) => ({value: r, label: r})), onCommit: (v) => update((q) => { q.role = v; })}),
      field({label: 'Start', unit: 's', value: p.start_ms / 1000, step: 0.5, onCommit: (v) => update((q) => { q.start_ms = Math.round(v * 1000); })}),
      field({label: 'End', unit: 's', value: p.end_ms / 1000, step: 0.5, onCommit: (v) => update((q) => { q.end_ms = Math.round(v * 1000); })})),
    h('div', {class: 'grid3'},
      field({label: 'Mode', type: 'select', value: udp ? 'udp' : 'icmp', options: [{value: 'udp', label: 'UDP'}, {value: 'icmp', label: 'ICMP'}],
        onCommit: (v) => update((q) => {
          if (v === 'udp') { delete q.packets_per_second; q.mode = 'udp'; q.offered_mbps = 1; } else { delete q.mode; delete q.offered_mbps; q.packets_per_second = 30; }
        })}),
      udp ? field({label: 'Offered', unit: 'Mbps', value: p.offered_mbps, step: 0.1, onCommit: (v) => update((q) => { q.offered_mbps = v; })})
        : field({label: 'Rate', unit: 'pps', value: p.packets_per_second, step: 1, onCommit: (v) => update((q) => { q.packets_per_second = Math.round(v); })}),
      field({label: 'Payload', unit: 'B', value: p.payload_bytes, step: 1, onCommit: (v) => update((q) => { q.payload_bytes = Math.round(v); })})));
}

// ======================================================================= Check
function checkTab() {
  const lint = state.lint;
  const d = state.design;
  const scene = rf.sceneAt(d, state.timeMs);
  const parts = [];
  if (!lint) {
    parts.push(card(null, h('p', {class: 'help'}, h('span', {class: 'spinner'}), ' Checking…')));
  } else {
    const s = lint.summary;
    const cls = s.error ? 'err' : s.warning ? 'warn' : 'ok';
    parts.push(h('section', {class: 'card status-card ' + cls},
      h('strong', {}, s.error ? `${s.error} error${s.error > 1 ? 's' : ''} — the configurator would reject this room`
        : s.warning ? `Compiles · ${s.warning} warning${s.warning > 1 ? 's' : ''}` : 'Compiles cleanly'),
      s.compiles ? h('div', {class: 'metric-grid', style: {marginTop: '6px'}},
        h('span', {}, 'Generations'), h('b', {}, String(s.generations)),
        h('span', {}, 'Agents / stations'), h('b', {}, `${s.agents} / ${s.stations}`),
        h('span', {}, 'Directed links per tick'), h('b', {}, String(s.links_per_generation)),
        h('span', {}, 'golden_sha256'), h('b', {class: 'mono', title: s.golden_sha256}, s.golden_sha256.slice(0, 16) + '…')) : null));
    const findings = lint.findings || [];
    parts.push(card(`Findings (${findings.length})`, findings.length ? findings.map((f) => h('div', {class: 'finding', onclick: () => {
      if (f.role) { select({type: 'node', role: f.role}); emit('focusSelection'); } else if (f.wall !== undefined) { select({type: 'wall', index: f.wall}); emit('focusSelection'); }
    }}, h('span', {class: 'lvl ' + f.level}, f.level.toUpperCase()), h('span', {}, f.message), f.tip ? h('span', {class: 'tip'}, f.tip) : null))
      : h('p', {class: 'help'}, 'No findings.')));
  }
  const verify = state.verification;
  parts.push(card('Verification suite',
    h('p', {class: 'help'}, 'Runs the room through every configurator function a Golden World passes on its way into the lab: validation, compile, golden hash, determinism, .wmd export for every band (parsed back), metadata rules, lab admission and RF sanity', state.meta.reference ? ' — plus byte parity with the reference wmdcfg on this server.' : state.meta.storage === 'browser' ? '.' : '. Start the server with --reference to add byte parity with the reference wmdcfg.'),
    h('button', {class: 'primary', onclick: runVerify}, verify && verify.pending ? 'Running…' : 'Run verification'),
    verify && verify.checks ? h('div', {style: {marginTop: '8px'}},
      h('p', {class: 'help'}, h('b', {}, verify.passed ? 'PASSED' : 'FAILED'), ` · ${verify.counts.pass} pass · ${verify.counts.fail} fail · ${verify.counts.warn} advisory · ${verify.counts.skip} skipped`),
      verify.checks.map((c) => h('div', {class: 'check-row'}, h('span', {class: 'st ' + c.status}, c.status.toUpperCase()),
        h('span', {}, h('b', {}, c.title), c.detail ? h('div', {class: 'detail'}, String(c.detail)) : null)))) : null,
    verify && verify.error ? h('div', {class: 'notes warn'}, verify.error) : null));
  // coverage stats (instant, JS model)
  const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
  const cell = Math.sqrt(W * H / 6000);
  const rows = rf.BANDS.map((b) => {
    const grid = rf.coverageGrid(d.layout, scene, b, Math.max(4, Math.round(W / cell)), Math.max(4, Math.round(H / cell)));
    const st = rf.coverageStats(grid.values, 30);
    return h('tr', {}, h('td', {}, b + ' GHz'), h('td', {}, fmt(st.mean, 1)), h('td', {}, fmt(st.p10, 1)), h('td', {}, fmt(st.coverage_pct, 1) + '%'), h('td', {}, fmt(st.holes_pct, 1) + '%'));
  });
  const best = rf.bestServing(scene, d.layout, state.band);
  const clientSnrs = Object.values(best).map((b) => b.snr);
  parts.push(card(`Coverage at ${(state.timeMs / 1000).toFixed(1)} s`,
    h('table', {}, h('tr', {}, h('th', {}, 'Band'), h('th', {}, 'mean'), h('th', {}, 'p10'), h('th', {}, '≥ 30 dB'), h('th', {}, '< 10 dB')), rows),
    clientSnrs.length ? h('p', {class: 'help'}, `Clients on ${state.band} GHz: min ${Math.min(...clientSnrs)} dB, mean ${fmt(clientSnrs.reduce((a, b) => a + b, 0) / clientSnrs.length, 1)} dB, ${clientSnrs.filter((v) => v < 16).length} in the red.`) : null,
    h('p', {class: 'help'}, 'Floor-grid statistics of the best AP→point SNR (no shadowing). The heatmap (H) shows the same field.')));
  return parts;
}

async function runVerify() {
  state.verification = {pending: true};
  markStale('check'); refreshVisible();
  try { state.verification = await api.verify(state.design, state.band); } catch (error) { state.verification = {error: error.message}; }
  markStale('check'); refreshVisible();
}

function updateCheckCount() {
  const el = document.getElementById('checkCount');
  const s = state.lint && state.lint.summary;
  if (!s) { el.textContent = ''; el.className = 'count'; return; }
  el.textContent = s.error ? String(s.error) : s.warning ? String(s.warning) : '';
  el.className = 'count ' + (s.error ? 'err' : s.warning ? 'warn' : '');
}
