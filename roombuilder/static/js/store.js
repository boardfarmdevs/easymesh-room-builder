// Application state, undo/redo and change notification.
//
// The design is plain JSON. Every edit goes through `transact(label, fn)`,
// which snapshots the previous design for undo, applies `fn(design)` and
// notifies listeners. Continuous gestures (drags, typing) pass a `coalesce`
// key so a whole gesture is one undo step.

import {clone} from './ops.js';

const listeners = new Map();
const UNDO_LIMIT = 200;

export const state = {
  meta: null,             // /api/meta: materials, profiles, schema catalog, presets
  design: null,
  origin: {kind: 'new', id: null, revision: null},   // where the design came from / is saved
  savedSnapshot: null,
  selection: null,        // {type:'node', role} | {type:'wall', index} | {type:'waypoint', role, index}
  hover: null,
  tool: 'select',
  timeMs: 0,
  playing: false,
  speed: 1,
  band: '5',
  activeMaterial: 'interior',
  customLoss: 5,
  doorWidth: 0.9,
  walkSpeed: 1.4,
  snap: 0.1,
  lint: null,
  preview: null,          // transient overrides during drags {positions:{role:[x,y]}, walls:{i:{start,end}}}
  placement: null,        // optimiser proposal shown as ghosts
  view: {
    mode: 'orbit',        // orbit | plan | walk
    links: true, backhaul: 'viewer', trails: true, paths: false, labels: true, wallLabels: true,
    gauges: true, heatmap: false, heatStyle: 'banded', materialTint: false, fineGrid: false,
  },
};

const undoStack = [];
const redoStack = [];
let lastCoalesce = null;
let lastCoalesceAt = 0;

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) {
    try { fn(detail); } catch (error) { console.error(error); }
  }
}

export function setDesign(design, origin) {
  state.design = design;
  state.origin = Object.assign({kind: 'new', id: null, revision: null}, origin || {});
  state.savedSnapshot = origin && origin.kind === 'store' ? JSON.stringify(design) : null;
  state.selection = null;
  state.preview = null;
  state.placement = null;
  state.timeMs = 0;
  state.playing = false;
  undoStack.length = 0;
  redoStack.length = 0;
  lastCoalesce = null;
  if (design.builder && design.builder.view && design.builder.view.band) state.band = design.builder.view.band;
  emit('design', {reason: 'load'});
  emit('selection');
  emit('time');
  emit('history');
}

export function isDirty() {
  if (!state.design) return false;
  if (state.savedSnapshot === null) return undoStack.length > 0 || state.origin.kind === 'import';
  return JSON.stringify(state.design) !== state.savedSnapshot;
}

export function markSaved(design, origin) {
  state.design = design;
  state.origin = Object.assign({}, state.origin, origin || {});
  state.savedSnapshot = JSON.stringify(design);
  emit('design', {reason: 'saved'});
  emit('history');
}

// Apply an edit. Returns fn's result. Throws (and rolls back) on error.
export function transact(label, fn, {coalesce = null, quiet = false} = {}) {
  const before = JSON.stringify(state.design);
  const draft = clone(state.design);
  const result = fn(draft);
  const after = JSON.stringify(draft);
  if (after === before) return result;
  const now = performance.now();
  if (!(coalesce && coalesce === lastCoalesce && now - lastCoalesceAt < 1500)) {
    undoStack.push({label, snapshot: before});
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  lastCoalesce = coalesce;
  lastCoalesceAt = now;
  redoStack.length = 0;
  state.design = draft;
  emit('design', {reason: 'edit', label, quiet});
  emit('history');
  return result;
}

export function endGesture() { lastCoalesce = null; }

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  redoStack.push({label: entry.label, snapshot: JSON.stringify(state.design)});
  state.design = JSON.parse(entry.snapshot);
  lastCoalesce = null;
  validateSelection();
  emit('design', {reason: 'undo', label: entry.label});
  emit('history');
  return entry.label;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return null;
  undoStack.push({label: entry.label, snapshot: JSON.stringify(state.design)});
  state.design = JSON.parse(entry.snapshot);
  lastCoalesce = null;
  validateSelection();
  emit('design', {reason: 'redo', label: entry.label});
  emit('history');
  return entry.label;
}

export function history() {
  return {
    undo: undoStack.length ? undoStack[undoStack.length - 1].label : null,
    redo: redoStack.length ? redoStack[redoStack.length - 1].label : null,
    depth: undoStack.length,
  };
}

export function select(selection) {
  state.selection = selection;
  emit('selection');
}

export function validateSelection() {
  const s = state.selection;
  if (!s || !state.design) return;
  if (s.type === 'wall' && !(state.design.layout.walls || [])[s.index]) state.selection = null;
  if ((s.type === 'node' || s.type === 'waypoint')) {
    const exists = (state.design.layout.nodes || []).some((n) => n.role === s.role) ||
      (state.design.mobility.nodes || []).some((n) => n.role === s.role);
    if (!exists) state.selection = null;
  }
  emit('selection');
}

export function setTool(tool) {
  if (state.tool === tool) return;
  state.tool = tool;
  emit('tool');
}

export function setTime(t) {
  const duration = state.design ? Number(state.design.mobility.duration_ms) : 0;
  state.timeMs = Math.max(0, Math.min(duration, Math.round(t)));
  emit('time');
}

export function setBand(band) {
  state.band = band;
  emit('view');
}

export function setView(patch) {
  Object.assign(state.view, patch);
  emit('view');
}

export function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('roombuilder.prefs') || '{}');
    Object.assign(state.view, saved.view || {});
    for (const key of ['snap', 'walkSpeed', 'doorWidth', 'activeMaterial']) if (key in saved) state[key] = saved[key];
  } catch (_e) { /* preferences are optional */ }
}

export function savePrefs() {
  try {
    const view = Object.assign({}, state.view);
    localStorage.setItem('roombuilder.prefs', JSON.stringify({
      view, snap: state.snap, walkSpeed: state.walkSpeed, doorWidth: state.doorWidth, activeMaterial: state.activeMaterial,
    }));
  } catch (_e) { /* ignore */ }
}

// Autosaved draft of the working design (a per-browser convenience, not storage).
export function saveDraft() {
  try {
    if (state.design) localStorage.setItem('roombuilder.draft', JSON.stringify({design: state.design, origin: state.origin, at: Date.now()}));
  } catch (_e) { /* ignore */ }
}

export function loadDraft() {
  try { return JSON.parse(localStorage.getItem('roombuilder.draft') || 'null'); } catch (_e) { return null; }
}
