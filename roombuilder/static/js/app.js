// EasyMesh room builder: application wiring.

import * as rf from './rfmodel.js';
import * as ops from './ops.js';
import {state, on, emit, setDesign, transact, undo, redo, history, select, setTool, setTime, setBand, setView,
  isDirty, loadPrefs, savePrefs, saveDraft, loadDraft} from './store.js';
import {api} from './api.js';
import {engineMode} from './backend.js';
import {RoomScene} from './scene3d.js';
import {initTimeline, togglePlay, stop} from './timeline.js';
import {initPanels, showTab} from './panels.js';
import {initHud, openMenu, hideMenu, duplicateNode} from './hud.js';
import {initTools} from './tools.js';
import * as dialogs from './dialogs.js';
import {installTooltips, setCatalog, hide as hideTip} from './tips.js';
import {setReporter} from './dom.js';
import {setMaterialColors} from './thumb.js';
import * as exporters from './exporters.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');

function fail(message) {
  const e = $('#err');
  e.style.display = 'block';
  e.textContent = message;
}

// Static build: the engine did not start. Explain filtered downloads, the usual cause.
function engineFailed(message) {
  const filtered = /replaced by other content|magic word|CompileError|HTTP [45]\d\d|fetch|NetworkError|Load failed|dynamically imported module|import|no result after/i.test(message);
  const e = $('#err');
  e.style.display = 'block';
  e.innerHTML = `<strong>The room builder engine could not start.</strong><p class="mono"></p>` + (filtered
    ? `<p>One of the engine's files did not arrive intact. On company-managed computers a web filter, proxy or security
       software often blocks or replaces large downloads such as WebAssembly (<code>.wasm</code>) and <code>.zip</code> files —
       the same filters often stop diagrams (for example Mermaid) that load scripts from other sites.</p>
       <ul><li>Ask for <code>${location.hostname}</code> to be allowed, including <code>.wasm</code>, <code>.mjs</code> and <code>.zip</code> files.</li>
       <li>Or use a builder served with <code>./room-builder serve</code> (for example the lab's): it runs its Python on the server and downloads no engine.</li></ul>`
    : `<p>Reload the page; if it persists, use a builder served with <code>./room-builder serve</code>.</p>`);
  e.querySelector('p.mono').textContent = message;
}

// Shown by the static (GitHub Pages) build when the browser has no WebAssembly.
const NO_WASM_HELP = `<strong>This browser has WebAssembly switched off, so this published copy of the room builder cannot run here.</strong>
<p>It runs the builder's Python inside the page with WebAssembly. Security settings remove WebAssembly when they turn off the JavaScript JIT:
Microsoft Edge's <em>Enhanced security for the web</em> does this on sites it considers unfamiliar, and some managed laptops block the JIT by policy.</p>
<ul>
<li><b>Edge:</b> edge://settings/privacy → <em>Enhance your security on the web</em> → <em>Exceptions</em> → add <code>${location.hostname}</code>.
On a managed laptop your administrator can add it to the <code>EnhanceSecurityModeBypassListDomains</code> policy.</li>
<li><b>Chrome (managed):</b> the <code>JavaScriptJitAllowedForSites</code> policy.</li>
<li>Or use a builder served with <code>./room-builder serve</code> (for example the lab's): its Python runs on the server and it needs no WebAssembly.</li>
</ul>`;

let toastTimer = null;
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', !!error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 3600);
}
setReporter((error) => toast(error && error.message ? error.message : String(error), true));

async function main() {
  if (typeof window.THREE === 'undefined') { fail('The bundled three.js renderer failed to load.'); return; }
  loadPrefs();
  try {
    state.meta = await api.meta();
  } catch (error) {
    if (error.code === 'no-wasm') { fail(''); $('#err').innerHTML = NO_WASM_HELP; }
    else if (engineMode === 'pyodide') engineFailed(error.message);
    else fail('Cannot reach the room builder server: ' + error.message);
    return;
  }
  if (state.meta.storage === 'memory') {
    setTimeout(() => toast('This browser blocks site storage: designs last until you close the page. Export a Design JSON to keep one.', true), 1500);
  }
  setCatalog(state.meta.schema);
  setMaterialColors(state.meta.materials.materials);
  installTooltips();

  const materials = Object.fromEntries(state.meta.materials.materials.map((m) => [m.id, m]));
  const room = new RoomScene(stage, {materials});
  window.roomBuilder = {state, room, rf, ops, transact, setTime, setBand, setTool, select, emit};   // console & test hook

  const ui = {
    toast,
    dragInfo: (text) => { $('#cursorReadout').dataset.drag = text || ''; if (text) $('#cursorReadout').textContent = text; },
    openMenu, hideMenu,
    focusProperties: () => { const first = $('#propsHud input'); if (first) first.focus(); },
  };
  initTimeline($('#timeline'));
  initPanels(ui);
  initHud(ui);
  const tools = initTools(room, stage, ui);
  dialogs.initDialogs(ui, room);

  // ---- scene sync ----------------------------------------------------------------------
  let syncQueued = false;
  const sync = () => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; room.sync(); });
  };
  on('design', sync);
  on('time', sync);
  on('view', () => { sync(); updateToolbar(); });
  on('selection', sync);
  on('overlay', sync);
  on('placement', sync);
  on('fit', () => { room.fit(); sync(); });
  on('focusSelection', () => focusSelection(room));

  // ---- design card ----------------------------------------------------------------------
  const title = $('#designTitle');
  title.addEventListener('change', () => {
    const v = title.value.trim();
    if (v) transact('Rename design', (d) => { d.title = v; });
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); e.stopPropagation(); });
  const refreshCard = () => {
    const d = state.design;
    if (!d) return;
    if (document.activeElement !== title) title.value = d.title || '';
    const nodes = rf.mergeNodes(d.layout, d.mobility);
    const agents = nodes.filter((n) => n.kind === 'fronthaul_ap').length;
    const where = {store: `saved · rev ${state.origin.revision}`, library: 'library copy', import: 'imported', new: 'new'}[state.origin.kind] || '';
    $('#designMeta').textContent = `${d.id} · ${d.layout.space.width_m} × ${d.layout.space.height_m} m · ${(d.layout.walls || []).length} walls · ${agents} agents · ${nodes.length - agents} clients · ${d.mobility.duration_ms / 1000} s · ${where}`;
    const dirty = isDirty();
    const s = $('#saveState');
    s.textContent = dirty ? '● unsaved' : state.origin.kind === 'store' ? 'saved' : '';
    s.classList.toggle('dirty', dirty);
    $('#roomName').textContent = 'Room: ' + (d.title || roomName(d));
    document.title = `${d.title || d.id} · EasyMesh room builder`;
  };
  on('design', refreshCard);
  on('history', () => {
    refreshCard();
    const hst = history();
    $('#btnUndo').disabled = !hst.undo;
    $('#btnRedo').disabled = !hst.redo;
    $('#btnUndo').dataset.tip = hst.undo ? `Undo “${hst.undo}” (Ctrl+Z)` : 'Nothing to undo';
    $('#btnRedo').dataset.tip = hst.redo ? `Redo “${hst.redo}” (Ctrl+Shift+Z)` : 'Nothing to redo';
  });

  $('#btnNew').addEventListener('click', dialogs.openNew);
  $('#btnLibrary').addEventListener('click', dialogs.openLibrary);
  $('#btnOpen').addEventListener('click', dialogs.openDesigns);
  $('#btnSave').addEventListener('click', () => dialogs.save());
  $('#btnSaveAs').addEventListener('click', () => dialogs.saveAs());
  $('#btnImport').addEventListener('click', () => dialogs.openImport());
  $('#btnExport').addEventListener('click', dialogs.openExport);
  $('#openManual').addEventListener('click', (e) => { e.preventDefault(); dialogs.openManual(); });

  // ---- toolbar ----------------------------------------------------------------------------
  $('#toolSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
  $('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setMode(b.dataset.view); });
  $('#btnFit').addEventListener('click', () => { room.fit(); });
  $('#btnUndo').addEventListener('click', doUndo);
  $('#btnRedo').addEventListener('click', doRedo);
  $('#btnHeat').addEventListener('click', () => { setView({heatmap: !state.view.heatmap}); savePrefs(); });
  $('#btnShot').addEventListener('click', () => exporters.screenshot(room, {scale: 2, format: 'png', overlay: true}));
  $('#btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen().catch(() => toast('Full screen is not available here.', true));
  });
  document.addEventListener('fullscreenchange', () => $('#btnFullscreen').setAttribute('aria-pressed', String(!!document.fullscreenElement)));
  $('#checkBadge').addEventListener('click', () => showTab('check'));

  function setMode(mode) {
    state.view.mode = mode;
    room.setMode(mode);
    emit('view');
    tools.updateHint();
  }
  function updateToolbar() {
    for (const b of document.querySelectorAll('#toolSeg [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool));
    for (const b of document.querySelectorAll('#viewSeg [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === room.mode));
    $('#btnHeat').setAttribute('aria-pressed', String(!!state.view.heatmap));
  }
  on('tool', () => { updateToolbar(); renderToolOptions(); });
  on('material', renderToolOptions);

  // Per-tool options strip under the toolbar.
  function renderToolOptions() {
    const box = $('#toolOptions');
    const tool = state.tool;
    box.replaceChildren();
    const mats = state.meta.materials.materials;
    const addMaterials = () => {
      const row = document.createElement('span');
      row.className = 'mat-row';
      for (const m of mats) {
        const b = document.createElement('button');
        b.className = 'material small';
        b.setAttribute('aria-pressed', String(state.activeMaterial === m.id));
        b.dataset.tip = m.tip;
        const short = m.label.split(' (')[0].split(' / ')[0].replace('Interior wall', 'Interior').replace('Reinforced concrete', 'Reinforced').replace('Concrete partition', 'Concrete').replace('RF isolation', 'Isolation').replace('Solid wood', 'Wood').replace('Custom loss', 'Custom');
        b.innerHTML = `<span class="swatch" style="background:${m.color}"></span>${short}<span class="db">${m.loss_db === null ? '' : m.loss_db}</span>`;
        b.addEventListener('click', () => { state.activeMaterial = m.id; savePrefs(); renderToolOptions(); emit('material'); });
        row.append(b);
      }
      box.append(row);
      if (state.activeMaterial === 'custom') box.append(numberOption('Loss dB', state.customLoss, (v) => { state.customLoss = v; }, 0.5));
    };
    if (tool === 'wall' || tool === 'room') addMaterials();
    if (tool === 'door') box.append(numberOption('Door width m', state.doorWidth, (v) => { state.doorWidth = v; savePrefs(); }, 0.1));
    if (tool === 'path') {
      box.append(numberOption('Walk speed m/s', state.walkSpeed, (v) => { state.walkSpeed = v; savePrefs(); }, 0.1));
      for (const [label, v] of [['stroll', 0.6], ['walk', 1.4], ['run', 3.0]]) {
        const b = document.createElement('button');
        b.className = 'small';
        b.textContent = `${label} ${v}`;
        b.addEventListener('click', () => { state.walkSpeed = v; savePrefs(); renderToolOptions(); });
        box.append(b);
      }
    }
    if (tool !== 'select' && tool !== 'measure') {
      const sel = document.createElement('label');
      sel.innerHTML = 'snap <select>' + [0.01, 0.05, 0.1, 0.25, 0.5, 1].map((v) => `<option value="${v}"${v === state.snap ? ' selected' : ''}>${v} m</option>`).join('') + '</select>';
      sel.querySelector('select').addEventListener('change', (e) => { state.snap = Number(e.target.value); savePrefs(); });
      sel.dataset.tip = 'Grid snap. Alt disables snapping while you click or drag.';
      box.append(sel);
    }
    box.classList.toggle('show', box.childElementCount > 0);
  }
  function numberOption(label, value, set, step) {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'number'; input.value = value; input.step = step; input.min = '0';
    input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v) && v > 0) set(v); });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.append(label, ' ', input);
    return wrap;
  }

  // ---- keyboard ----------------------------------------------------------------------------
  const TOOL_KEYS = {v: 'select', w: 'wall', r: 'room', d: 'door', e: 'ap', c: 'client', p: 'path', m: 'measure'};
  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (ctrl && key === 'y') { e.preventDefault(); doRedo(); return; }
    if (ctrl && key === 's') { e.preventDefault(); dialogs.save({as: e.shiftKey}); return; }
    if (ctrl && key === 'o') { e.preventDefault(); dialogs.openDesigns(); return; }
    if (ctrl && key === 'e') { e.preventDefault(); dialogs.openExport(); return; }
    if (ctrl && e.altKey && key === 'n') { e.preventDefault(); dialogs.openNew(); return; }
    if (ctrl && key === 'd') {
      e.preventDefault();
      if (state.selection && state.selection.type === 'node') duplicateNode(state.selection.role);
      return;
    }
    if (ctrl) return;
    if (room.mode === 'walk' && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      walkKeys.add(key); e.preventDefault(); return;
    }
    if (tools.handleKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') {
      hideMenu();
      if (room.mode === 'walk') { setMode('orbit'); return; }
      if (state.tool !== 'select') { setTool('select'); return; }
      select(null);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Home') { stop(); setTime(0); return; }
    if (e.key === 'End') { stop(); setTime(state.design.mobility.duration_ms); return; }
    if (e.key === '[' || e.key === ']') {
      stop();
      const tick = Number(state.design.mobility.tick_ms);
      const t = e.key === ']' ? Math.floor(state.timeMs / tick + 1) * tick : Math.ceil(state.timeMs / tick - 1) * tick;
      setTime(t);
      return;
    }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); nudge(e); return; }
    if (e.key === '?') { dialogs.openShortcuts(); return; }
    if (TOOL_KEYS[key] && !e.altKey) { setTool(TOOL_KEYS[key]); return; }
    if (key === 'f') { room.fit(); return; }
    if (key === 't') { setMode(room.mode === 'plan' ? 'orbit' : 'plan'); return; }
    if (key === '3') { setMode('orbit'); return; }
    if (key === 'g') { setMode(room.mode === 'walk' ? 'orbit' : 'walk'); return; }
    if (key === 'h') { setView({heatmap: !state.view.heatmap}); savePrefs(); return; }
    if (key === 'b') { const i = rf.BANDS.indexOf(state.band); setBand(rf.BANDS[(i + 1) % 3]); return; }
  });
  const walkKeys = new Set();
  window.addEventListener('keyup', (e) => walkKeys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => walkKeys.clear());
  room.frameHooks.push(() => {
    if (room.mode !== 'walk' || !walkKeys.size) return;
    const f = (walkKeys.has('w') || walkKeys.has('arrowup') ? 1 : 0) - (walkKeys.has('s') || walkKeys.has('arrowdown') ? 1 : 0);
    const s = (walkKeys.has('d') ? 1 : 0) - (walkKeys.has('a') ? 1 : 0);
    const turn = (walkKeys.has('arrowleft') ? 1 : 0) - (walkKeys.has('arrowright') ? 1 : 0);
    room.walk.yaw += turn * 0.035;
    room.walkMove(f * 0.08, s * 0.08);
  });

  function doUndo() { const label = undo(); if (label) toast(`Undid “${label}”`); }
  function doRedo() { const label = redo(); if (label) toast(`Redid “${label}”`); }

  function deleteSelection() {
    const s = state.selection;
    if (!s) return;
    if (s.type === 'node') transact(`Delete ${s.role}`, (d) => ops.deleteNode(d, s.role));
    else if (s.type === 'wall') transact('Delete wall', (d) => ops.deleteWall(d, s.index));
    else if (s.type === 'waypoint') {
      if (s.index === 0) { toast('The first waypoint (0 s) cannot be deleted; use Make static instead.', true); return; }
      transact('Delete waypoint', (d) => { ops.mobilityNode(d, s.role).path.splice(s.index, 1); });
      select({type: 'node', role: s.role});
      return;
    }
    select(null);
  }

  function nudge(e) {
    const s = state.selection;
    if (!s) return;
    const step = (state.snap || 0.1) * (e.shiftKey ? 10 : 1);
    const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
    const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
    const W = Number(state.design.layout.space.width_m), H = Number(state.design.layout.space.height_m);
    try {
      if (s.type === 'node') {
        const p = rf.sceneAt(state.design, state.timeMs).byRole[s.role].position;
        const q = [Math.min(W, Math.max(0, p[0] + dx)), Math.min(H, Math.max(0, p[1] + dy))];
        transact(`Nudge ${s.role}`, (d) => ops.moveNode(d, s.role, q, state.timeMs), {coalesce: 'nudge-' + s.role});
      } else if (s.type === 'wall') {
        const w = state.design.layout.walls[s.index];
        const xs = [w.start[0] + dx, w.end[0] + dx], ys = [w.start[1] + dy, w.end[1] + dy];
        if (Math.min(...xs) < 0 || Math.max(...xs) > W || Math.min(...ys) < 0 || Math.max(...ys) > H) return;
        transact('Nudge wall', (d) => ops.moveWall(d, s.index, dx, dy), {coalesce: 'nudge-wall-' + s.index});
      } else if (s.type === 'waypoint') {
        transact('Nudge waypoint', (d) => {
          const w = ops.mobilityNode(d, s.role).path[s.index];
          w.position = [rf.round3(Math.min(W, Math.max(0, w.position[0] + dx))), rf.round3(Math.min(H, Math.max(0, w.position[1] + dy)))];
        }, {coalesce: 'nudge-wp'});
      }
    } catch (error) { toast(error.message, true); }
  }

  // ---- live validation (server lint), badge and draft autosave ------------------------------
  let lintTimer = null, lintSeq = 0;
  const scheduleLint = () => {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(async () => {
      const seq = ++lintSeq;
      try {
        const result = await api.lint(state.design, state.band);
        if (seq !== lintSeq) return;
        state.lint = result;
      } catch (error) {
        state.lint = {findings: [{level: 'error', code: 'server', message: error.message}], summary: {error: 1, warning: 0, info: 0, compiles: false}};
      }
      emit('lint');
      updateBadge();
    }, 350);
  };
  function updateBadge() {
    const badge = $('#checkBadge');
    const s = state.lint && state.lint.summary;
    if (!s) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.className = 'check-badge ' + (s.error ? 'err' : s.warning ? 'warn' : 'ok');
    badge.textContent = s.error ? `✕ ${s.error} error${s.error > 1 ? 's' : ''} — won't compile` : s.warning ? `⚠ ${s.warning} warning${s.warning > 1 ? 's' : ''} · compiles` : '✓ compiles · lab-ready';
    // Hovering the badge lists what it is about; clicking opens the Check tab.
    const shown = state.lint.findings.filter((f) => f.level === (s.error ? 'error' : 'warning')).slice(0, 6);
    const lines = shown.map((f) => '• ' + f.message);
    if (s.error) lines.unshift("The configurator would reject this room:");
    else if (s.warning) lines.unshift('The room compiles; these are advisories:');
    else lines.unshift('Compiles and passes the lab admission rules for the selected profile.');
    const source = state.design.source;
    if (s.warning && !s.error && source && source.kind === 'reference') lines.push('These come from the reference room as shipped; editing them breaks golden-hash parity.');
    lines.push('Click for details and the verification suite.');
    badge.dataset.tip = lines.join('\n');
  }
  let draftTimer = null;
  on('design', (info) => {
    if (info && info.reason === 'load') { state.verification = null; }
    scheduleLint();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 800);
    if (info && info.reason === 'load') updateUrl();
  });
  on('view', () => { if (state.lint) scheduleLint(); });
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { saveDraft(); e.preventDefault(); e.returnValue = ''; } });

  function updateUrl() {
    const params = new URLSearchParams();
    if (state.origin.kind === 'store' && state.origin.id) params.set('design', state.origin.id);
    else if (state.origin.kind === 'library' && state.origin.id) params.set('room', state.origin.id);
    const q = params.toString();
    history_replace(q ? '?' + q : location.pathname);
  }
  function history_replace(url) { try { window.history.replaceState(null, '', url); } catch (_e) { /* file:// */ } }

  // ---- drag & drop import anywhere --------------------------------------------------------------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropZone').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropZone').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropZone').hidden = true;
    if (document.querySelector('dialog[open]')) return;
    if (e.dataTransfer.files.length) dialogs.openImport([...e.dataTransfer.files]);
  });

  // ---- pane divider -----------------------------------------------------------------------------
  initDivider();

  // ---- first design --------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  let loaded = false;
  try {
    if (params.get('design')) {
      const d = await api.design(params.get('design'));
      setDesign(d, {kind: 'store', id: d.id, revision: d.revision});
      loaded = true;
    } else if (params.get('room')) {
      const d = await api.libraryRoom(params.get('room'));
      delete d.library;
      setDesign(d, {kind: 'library', id: params.get('room')});
      loaded = true;
    }
  } catch (error) { toast(error.message, true); }
  if (!loaded) {
    const draft = loadDraft();
    if (draft && draft.design && draft.design.schema === 'roombuilder.design.v1') {
      setDesign(draft.design, draft.origin && draft.origin.kind === 'store' ? {kind: 'import'} : draft.origin);
      if (draft.origin && draft.origin.kind === 'store') {
        state.origin = draft.origin;
        try { const saved = await api.design(draft.origin.id); state.savedSnapshot = JSON.stringify(saved); } catch (_e) { state.savedSnapshot = null; }
        emit('history');
      }
      toast('Restored your last working room from this browser.');
    } else {
      const d = await api.libraryRoom('home-a-private-client-room-walk');
      delete d.library;
      setDesign(d, {kind: 'library', id: 'home-a-private-client-room-walk'});
      showWelcome();
    }
  }
  updateToolbar();
  renderToolOptions();
  showTab('room');
  room.fit();
  sync();
}

function roomName(d) {
  return `${d.layout.name}--${d.mobility.name}`.split('--').map((part) => {
    const words = part.replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }).join(' — ');
}

function focusSelection(room) {
  const s = state.selection;
  if (!s || !state.design) return;
  let p = null;
  if (s.type === 'node' || s.type === 'waypoint') {
    const entry = rf.sceneAt(state.design, state.timeMs).byRole[s.role];
    p = entry && entry.position;
  } else if (s.type === 'wall') {
    const w = state.design.layout.walls[s.index];
    p = w && [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];
  }
  if (!p) return;
  room.autoFit = false;
  if (room.mode === 'plan') { room.plan.cx = p[0]; room.plan.cy = p[1]; }
  else room.orbit.target.set(p[0], 0, -p[1]);
  room.placeCamera();
}

function initDivider() {
  const handle = document.getElementById('paneDivider');
  const root = document.body;
  let saved = null;
  try { saved = Number(localStorage.getItem('roombuilder.panel')); } catch (_e) { /* optional */ }
  if (saved && saved >= 240 && saved <= 800) root.style.setProperty('--panel-w', saved + 'px');
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => { dragging = true; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(260, Math.min(760, e.clientX));
    root.style.setProperty('--panel-w', w + 'px');
  });
  handle.addEventListener('pointerup', () => {
    dragging = false;
    try { localStorage.setItem('roombuilder.panel', parseInt(getComputedStyle(root).getPropertyValue('--panel-w'), 10)); } catch (_e) { /* optional */ }
  });
  handle.addEventListener('dblclick', () => root.style.setProperty('--panel-w', '380px'));
  handle.addEventListener('keydown', (e) => {
    const w = parseInt(getComputedStyle(root).getPropertyValue('--panel-w'), 10) || 380;
    if (e.key === 'ArrowLeft') root.style.setProperty('--panel-w', Math.max(260, w - 20) + 'px');
    if (e.key === 'ArrowRight') root.style.setProperty('--panel-w', Math.min(760, w + 20) + 'px');
  });
}

function showWelcome() {
  try { if (localStorage.getItem('roombuilder.welcomed')) return; } catch (_e) { /* optional */ }
  const box = document.createElement('div');
  box.className = 'welcome';
  box.innerHTML = `<h2>Welcome to the EasyMesh room builder</h2>
    <p class="help">This is the lab's default room, <b>Home A · Default Private Client Walk</b>, exactly as the room viewer shows it. Everything you build compiles with the same model as <span class="mono">wmdcfg world-compile</span>.</p>
    <ol>
      <li><b>Library…</b> opens 50 example rooms; <b>New…</b> starts from a size.</li>
      <li>Draw walls with <kbd>W</kbd> (pick a material first), boxes with <kbd>R</kbd>, doors with <kbd>D</kbd>.</li>
      <li>Add agents <kbd>E</kbd> and clients <kbd>C</kbd>, or let <b>Devices → Place extenders optimally</b> do it.</li>
      <li>Give clients paths with <kbd>P</kbd>, press <kbd>Space</kbd> to play, and watch links, gauges and the heatmap <kbd>H</kbd>.</li>
      <li><b>Check</b> runs the verification suite; <b>Export…</b> writes a lab-ready bundle.</li>
    </ol>
    <p class="help">Hover any control for an explanation. <kbd>?</kbd> lists every shortcut; the Manual explains the configurator language.</p>
    <div class="row" style="justify-content:flex-end"><button id="welcomeManual">Open the manual</button><button class="primary" id="welcomeGo">Start building</button></div>`;
  document.getElementById('stage').append(box);
  const close = () => { box.remove(); try { localStorage.setItem('roombuilder.welcomed', '1'); } catch (_e) { /* optional */ } };
  box.querySelector('#welcomeGo').addEventListener('click', close);
  box.querySelector('#welcomeManual').addEventListener('click', () => { close(); dialogs.openManual(); });
}

main().catch((error) => { console.error(error); fail(error.message || String(error)); });
