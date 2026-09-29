// Modal dialogs: new room, library, open/history, save as, import, export,
// manual and keyboard shortcuts. Styled like the viewer's room guide.

import * as rf from './rfmodel.js';
import * as ops from './ops.js';
import {state, setDesign, markSaved, emit, isDirty} from './store.js';
import {api, download} from './api.js';
import {h, fmt, fill} from './dom.js';
import {drawPlan} from './thumb.js';
import * as exporters from './exporters.js';

let ui = null;
let room = null;

export function initDialogs(uiHooks, roomScene) {
  ui = uiHooks;
  room = roomScene;
}

function dialog(titleText, {cls = '', body = [], footer = [], onClose} = {}) {
  const dlg = h('dialog', {class: 'panel ' + cls},
    h('header', {}, h('h2', {}, titleText), h('button', {onclick: () => dlg.close(), autofocus: true}, 'Close')),
    ...body, footer.length ? h('footer', {}, ...footer) : null);
  document.getElementById('dialogs').append(dlg);
  dlg.addEventListener('close', () => { if (onClose) onClose(); dlg.remove(); });
  dlg.showModal();
  return dlg;
}

function storagePlace() {
  return {browser: 'in this browser (export a Design JSON to move it elsewhere)',
    memory: 'in this page only — this browser blocks site storage, so export a Design JSON to keep it'}[state.meta.storage] || 'on this server';
}

function confirmDiscard() {
  return !isDirty() || window.confirm('The current room has unsaved changes. Discard them?');
}

// ---------------------------------------------------------------- new
export function openNew() {
  if (!confirmDiscard()) return;
  const title = h('input', {type: 'text', value: 'New room'});
  const width = h('input', {type: 'number', value: '20', min: '1', step: '0.5'});
  const height = h('input', {type: 'number', value: '14', min: '1', step: '0.5'});
  const profile = h('select', {}, state.meta.profiles.profiles.map((p) => h('option', {value: p.id, selected: p.id === 'rdk-lab' ? true : null}, p.label)));
  const template = h('select', {},
    h('option', {value: 'lab'}, 'Lab starter: gateway + 4 optimised extenders + 10 static clients'),
    h('option', {value: 'gateway'}, 'Gateway only (add everything yourself)'),
    h('option', {value: 'box'}, 'Lab starter inside four exterior brick walls'),
    h('option', {value: 'empty'}, 'Empty floor (no devices)'));
  const status = h('span', {class: 'status'});
  const create = h('button', {class: 'primary', onclick: async () => {
    const W = Number(width.value), H = Number(height.value);
    if (!(W > 0 && H > 0)) { status.textContent = 'Enter a positive size.'; return; }
    create.disabled = true;
    fill(status, h('span', {class: 'spinner'}), ' Building…');
    try {
      let design = await api.newDesign({title: title.value || 'New room', width_m: W, height_m: H, profile: profile.value});
      design.layout.name = design.id;
      const t = template.value;
      if (t === 'empty') design.layout.nodes = [];
      if (t === 'box') {
        const m = 0.2;
        ops.roomBox(design, [m, m], [W - m, H - m], 'brick', 8, 'exterior');
      }
      if (t === 'lab' || t === 'box') {
        const cols = Math.ceil(Math.sqrt(10 * W / H)), rows = Math.ceil(10 / cols);
        let k = 0;
        for (let j = 0; j < rows && k < 10; j++) for (let i = 0; i < cols && k < 10; i++, k++) {
          ops.addNode(design, {kind: 'station', position: [rf.round3((i + 0.5) * W / cols + 0.37), rf.round3((j + 0.5) * H / rows + 0.23)].map((v, a) => Math.min(a ? H - 0.3 : W - 0.3, v)), lab: true});
        }
        const placed = await api.place(design, {count: 4, strategy: 'add', objective: 'balanced'});
        design = placed.design;
      }
      dlg.close();
      setDesign(design, {kind: 'new'});
      emit('fit');
      ui.toast(`Created “${design.title}”. Draw walls with W, add devices with E and C.`);
    } catch (error) {
      status.textContent = error.message;
      create.disabled = false;
    }
  }}, 'Create room');
  const dlg = dialog('New room', {
    cls: 'narrow',
    body: [h('div', {class: 'body'},
      h('label', {class: 'field'}, 'Title'), title,
      h('div', {class: 'grid2'}, h('div', {}, h('label', {class: 'field'}, 'Width x (m)'), width), h('div', {}, h('label', {class: 'field'}, 'Depth y (m)'), height)),
      h('label', {class: 'field'}, 'Lab profile'), profile,
      h('label', {class: 'field'}, 'Start from'), template,
      h('p', {class: 'help'}, 'Any size the configurator accepts is fine: the builder scales markers like the viewer does for large rooms. You can resize, stretch or shrink the room later (Room → Size).'))],
    footer: [status, create],
  });
}

// ---------------------------------------------------------------- library
export async function openLibrary() {
  let data;
  try { data = await api.library(); } catch (error) { ui.toast(error.message, true); return; }
  const nav = h('nav', {'aria-label': 'Library rooms'});
  const detail = h('section', {tabindex: '0'});
  const search = h('input', {type: 'search', class: 'search', placeholder: 'Search rooms, tags…'});
  const status = h('span', {class: 'status'});
  let chosen = null;
  const openBtn = h('button', {class: 'primary', disabled: true, onclick: async () => {
    if (!chosen || !confirmDiscard()) return;
    try {
      const design = await api.libraryRoom(chosen.id);
      delete design.library;
      dlg.close();
      setDesign(design, {kind: 'library', id: chosen.id});
      emit('fit');
      ui.toast(`Opened “${design.title}” from the library. Save to keep your changes.`);
    } catch (error) { status.textContent = error.message; }
  }}, 'Open room');
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    const groups = {};
    for (const room of data.rooms) {
      const hay = [room.id, room.title, room.description, ...(room.tags || []), ...(room.highlights || [])].join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      (groups[room.category] = groups[room.category] || []).push(room);
    }
    fill(nav, search, ...Object.entries(data.categories).filter(([k]) => groups[k]).map(([k, label]) => [
      h('h3', {}, label),
      groups[k].map((room) => h('button', {'aria-pressed': String(chosen && chosen.id === room.id),
        onmouseenter: () => show(room), onfocus: () => show(room), onclick: () => show(room, true), ondblclick: () => openBtn.click()},
      h('strong', {}, room.title), h('small', {}, `${room.size_m.join(' × ')} m · ${room.agents} AP · ${room.stations} STA · ${room.duration_s} s${room.highlights && room.highlights.length ? ' · ' + room.highlights.join(', ') : ''}`)))]).flat());
  };
  let showToken = 0;
  const show = async (room, pick = false) => {
    if (pick) { chosen = room; openBtn.disabled = false; renderList(); }
    const token = ++showToken;
    const canvas = h('canvas', {class: 'thumb', style: {height: '260px'}});
    const g = room.guide || {};
    fill(detail, 
      h('h3', {class: 'detail-title'}, room.title),
      h('code', {class: 'mono'}, room.id),
      h('p', {class: 'muted'}, `${room.size_m.join(' × ')} m · ${room.walls} walls · ${room.agents} agents · ${room.stations} clients (${room.mobile} moving) · ${room.duration_s} s · profile ${room.profile}`),
      canvas,
      room.description ? h('p', {style: {marginTop: '10px'}}, room.description) : null,
      g.rf ? [h('h4', {}, 'Simulated RF'), h('p', {}, g.rf)] : null,
      g.optimizer ? [h('h4', {}, 'Expected optimizer behavior'), h('p', {}, g.optimizer)] : null,
      g.watch ? [h('h4', {}, 'Evidence to check in both views'), h('p', {}, g.watch)] : null,
      g.limits ? [h('h4', {}, 'What this does not prove'), h('p', {}, g.limits)] : null,
      room.source && room.source.golden_sha256 ? h('p', {class: 'help'}, 'Reference golden_sha256 ', h('span', {class: 'mono'}, room.source.golden_sha256), ' — the builder reproduces it byte for byte.') : null,
      h('p', {class: 'help'}, (room.tags || []).map((t) => h('span', {class: 'chip'}, t))));
    try {
      const design = await api.libraryRoom(room.id);
      if (token === showToken) drawPlan(canvas, design, {band: state.band});
    } catch (_e) { /* thumbnail optional */ }
  };
  search.addEventListener('input', renderList);
  const dlg = dialog('Room library', {
    body: [h('div', {class: 'split'}, nav, detail)],
    footer: [status, h('span', {class: 'help'}, 'Opening a library room makes an unsaved copy.'), openBtn],
  });
  renderList();
  const first = data.rooms[0];
  if (first) show(first, true);
  search.focus();
}

// ---------------------------------------------------------------- open
export async function openDesigns() {
  let list;
  try { list = (await api.designs()).designs; } catch (error) { ui.toast(error.message, true); return; }
  const nav = h('nav', {});
  const detail = h('section', {});
  const status = h('span', {class: 'status'});
  let chosen = null;
  const search = h('input', {type: 'search', class: 'search', placeholder: 'Search saved designs…'});
  const openBtn = h('button', {class: 'primary', disabled: true, onclick: async () => {
    if (!chosen || !confirmDiscard()) return;
    try {
      const design = await api.design(chosen.id);
      dlg.close();
      setDesign(design, {kind: 'store', id: design.id, revision: design.revision});
      emit('fit');
    } catch (error) { status.textContent = error.message; }
  }}, 'Open');
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    const items = list.filter((d) => !q || [d.id, d.title, d.description, ...(d.tags || [])].join(' ').toLowerCase().includes(q));
    fill(nav, search, items.length ? items.map((d) => h('button', {'aria-pressed': String(chosen && chosen.id === d.id), onclick: () => pick(d), ondblclick: () => openBtn.click()},
      h('strong', {}, d.title || d.id), h('small', {}, `${(d.updated_at || '').replace('T', ' ').slice(0, 16)} · rev ${d.revision} · ${d.size_m.join(' × ')} m · ${d.agents} AP · ${d.stations} STA`)))
      : h('p', {class: 'help'}, list.length ? 'No match.' : `No saved designs yet. Use Save (Ctrl+S) to keep your work ${storagePlace()}.`));
  };
  const pick = async (d) => {
    chosen = d;
    openBtn.disabled = false;
    renderList();
    const canvas = h('canvas', {class: 'thumb', style: {height: '240px'}});
    const history = h('div', {}, h('span', {class: 'spinner'}));
    fill(detail, h('h3', {class: 'detail-title'}, d.title || d.id), h('code', {class: 'mono'}, d.id),
      h('p', {class: 'muted'}, `${d.size_m.join(' × ')} m · ${d.walls} walls · ${d.agents} agents · ${d.stations} clients · ${d.duration_s} s · profile ${d.profile}`),
      canvas, d.description ? h('p', {style: {marginTop: '8px'}}, d.description) : null,
      h('div', {class: 'row', style: {margin: '10px 0'}},
        h('button', {onclick: async () => {
          const title = window.prompt('Title for the copy', `${d.title} (copy)`);
          if (!title) return;
          try { const copy = await api.duplicate(d.id, title); list.unshift({...d, ...copy, id: copy.id, title: copy.title}); list = (await api.designs()).designs; renderList(); status.textContent = `Duplicated as ${copy.id}.`; } catch (error) { status.textContent = error.message; }
        }}, 'Duplicate'),
        h('button', {class: 'danger', onclick: async () => {
          if (!window.confirm(`Delete “${d.title}”? Its last revision stays in the history folder on the server.`)) return;
          try { await api.remove(d.id); list = list.filter((x) => x.id !== d.id); chosen = null; openBtn.disabled = true; renderList(); fill(detail, ); status.textContent = 'Deleted.'; } catch (error) { status.textContent = error.message; }
        }}, 'Delete')),
      h('h4', {}, 'Revision history'), history);
    try {
      const design = await api.design(d.id);
      drawPlan(canvas, design, {band: state.band});
      const revs = (await api.history(d.id)).history;
      fill(history, revs.length ? h('table', {}, h('tr', {}, h('th', {}, 'Revision'), h('th', {}, 'Saved'), h('th', {}, '')),
        revs.map((r) => h('tr', {}, h('td', {}, String(r.revision)), h('td', {}, (r.updated_at || '').replace('T', ' ').slice(0, 19)),
          h('td', {}, h('button', {class: 'small', onclick: async () => {
            if (!confirmDiscard()) return;
            try {
              const old = await api.revision(d.id, r.revision);
              const current = await api.design(d.id);
              dlg.close();
              setDesign(old, {kind: 'store', id: d.id, revision: current.revision});
              state.savedSnapshot = JSON.stringify(current);
              emit('design', {reason: 'load'});
              ui.toast(`Opened revision ${r.revision}. Save to make it the current version (revision ${current.revision + 1}).`);
            } catch (error) { status.textContent = error.message; }
          }}, 'Open')))))
        : h('p', {class: 'help'}, 'Only one revision so far.'));
    } catch (error) { history.textContent = error.message; }
  };
  search.addEventListener('input', renderList);
  const dlg = dialog('Open design', {body: [h('div', {class: 'split'}, nav, detail)], footer: [status, openBtn]});
  renderList();
  if (list[0]) pick(list[0]);
}

// ---------------------------------------------------------------- save
export async function save({as = false} = {}) {
  const d = state.design;
  if (as || state.origin.kind !== 'store') return saveAs();
  try {
    const saved = await api.save(d, state.origin.revision);
    markSaved(saved, {kind: 'store', id: saved.id, revision: saved.revision});
    ui.toast(`Saved “${saved.title}” (revision ${saved.revision}).`);
  } catch (error) {
    if (error.status === 409) {
      if (window.confirm(`${error.message}\n\nSave your version as a copy instead?`)) saveAs();
    } else ui.toast(error.message, true);
  }
}

export function saveAs() {
  const d = state.design;
  const title = h('input', {type: 'text', value: d.title || 'Untitled room'});
  const status = h('span', {class: 'status'});
  const dlg = dialog('Save as', {
    cls: 'narrow',
    body: [h('div', {class: 'body'},
      h('label', {class: 'field'}, 'Title'), title,
      h('p', {class: 'help'}, `The design is stored ${storagePlace()} under an id made from the title (a number is added if it exists). The id is also the exported world ID; the layout and scenario names stay as they are.`))],
    footer: [status, h('button', {class: 'primary', onclick: async () => {
      const copy = JSON.parse(JSON.stringify(d));
      copy.title = title.value.trim() || 'Untitled room';
      copy.id = copy.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'room';
      delete copy.source;
      try {
        const created = await api.create(copy);
        dlg.close();
        markSaved(created, {kind: 'store', id: created.id, revision: created.revision});
        ui.toast(`Saved as “${created.title}” (${created.id}).`);
      } catch (error) { status.textContent = error.message; }
    }}, 'Save')],
  });
  title.select();
}

// ---------------------------------------------------------------- import
export function openImport(files = null) {
  const status = h('span', {class: 'status'});
  const notes = h('div', {});
  const input = h('input', {type: 'file', multiple: true, accept: '.json,.wmd,application/json'});
  const paste = h('textarea', {rows: 6, placeholder: '…or paste JSON here (a design, a layout, a mobility or a .world.json)'});
  const target = h('div', {class: 'drop-target'}, 'Drop files here: a layout + mobility pair, a compiled .world.json or a builder design', h('br'), input);
  const run = async (documents) => {
    fill(status, h('span', {class: 'spinner'}), ' Importing…');
    try {
      const result = await api.importDocuments(documents, state.design);
      fill(notes, h('ul', {class: 'notes'}, result.notes.map((n) => h('li', {}, n))));
      status.textContent = '';
      const openBtn = h('button', {class: 'primary', onclick: () => {
        if (!confirmDiscard()) return;
        dlg.close();
        setDesign(result.design, {kind: 'import'});
        emit('fit');
        ui.toast(`Imported “${result.design.title}”. Save to keep it.`);
      }}, 'Open imported room');
      notes.append(openBtn);
    } catch (error) {
      fill(notes, h('div', {class: 'notes warn'}, error.message));
      status.textContent = '';
    }
  };
  const readFiles = async (list) => {
    const documents = [];
    for (const file of list) {
      const text = await file.text();
      try { documents.push(JSON.parse(text)); } catch (_e) { documents.push(text); }
    }
    run(documents);
  };
  input.addEventListener('change', () => readFiles([...input.files]));
  target.addEventListener('dragover', (e) => { e.preventDefault(); target.classList.add('over'); });
  target.addEventListener('dragleave', () => target.classList.remove('over'));
  target.addEventListener('drop', (e) => { e.preventDefault(); target.classList.remove('over'); readFiles([...e.dataTransfer.files]); });
  const dlg = dialog('Import', {
    cls: 'medium',
    body: [h('div', {class: 'body'}, target, h('div', {style: {marginTop: '10px'}}, paste),
      h('p', {class: 'help'}, 'A compiled world is rebuilt exactly when its layout and mobility are in the library; otherwise the room size, propagation, transmit adjustments, paths and presence are reconstructed from the generations and checked by recompiling. A mobility on its own is applied to the current layout.'),
      notes)],
    footer: [status, h('button', {onclick: () => {
      const text = paste.value.trim();
      if (!text) return;
      try { run([JSON.parse(text)]); } catch (_e) { run([text]); }
    }}, 'Import pasted text')],
  });
  if (files && files.length) readFiles(files);
}

// ---------------------------------------------------------------- export
export function openExport() {
  const d = state.design;
  const band = h('select', {style: {width: 'auto'}}, ['all', '2.4', '5', '6'].map((b) => h('option', {value: b}, b === 'all' ? 'all bands' : b + ' GHz')));
  const heat = h('input', {type: 'checkbox'});
  const scale = h('select', {style: {width: 'auto'}}, [1, 2, 3, 4].map((s) => h('option', {value: s, selected: s === 2 ? true : null}, s + '×')));
  const transparent = h('input', {type: 'checkbox'});
  const overlay = h('input', {type: 'checkbox', checked: true});
  const speed = h('select', {style: {width: 'auto'}}, [1, 2, 4, 8, 16].map((s) => h('option', {value: s, selected: s === 4 ? true : null}, s + '×')));
  const status = h('span', {class: 'status'});
  const server = (kind, options = {}) => async () => {
    fill(status, h('span', {class: 'spinner'}), ' Exporting…');
    try {
      const {blob, filename} = await api.exportFile(kind, d, options);
      download(blob, filename);
      status.textContent = `Downloaded ${filename}.`;
    } catch (error) { status.textContent = error.message; }
  };
  const item = (title, text, fn, tip) => h('button', {onclick: fn, 'data-tip': tip}, h('strong', {}, title), h('span', {}, text));
  const dlg = dialog('Export', {
    body: [h('div', {class: 'body'},
      h('div', {class: 'row', style: {flexWrap: 'wrap', gap: '14px', marginBottom: '6px'}},
        h('label', {class: 'check'}, '.wmd / SVG band ', band),
        h('label', {class: 'check'}, 'Image scale ', scale),
        h('label', {class: 'check'}, transparent, ' transparent background'),
        h('label', {class: 'check'}, overlay, ' title & legend on images'),
        h('label', {class: 'check'}, heat, ' heatmap in the SVG plan'),
        h('label', {class: 'check'}, 'Video speed ', speed)),
      h('div', {class: 'export-grid'},
        h('h4', {}, 'Configurator (wmdcfg)'),
        item('Lab bundle (.zip)', 'layouts/, mobility/, golden/ in the configurator tree layout, .wmd for every band, the build-goldens.sh line, room-guide entry, verification report.', server('bundle')),
        item('Layout JSON', `wmdcfg.world-layout.v1 → worlds/layouts/${d.layout.name}.json`, server('layout')),
        item('Mobility JSON', `wmdcfg.mobility.v1 → worlds/mobility/${d.mobility.name}.json`, server('mobility')),
        item('Golden world', 'wmdcfg.world-plan.v1, compact and byte-identical to build-goldens.sh output.', server('world')),
        item('World (indented)', 'Same plan, indented for reading and diffs.', server('world', {options: {pretty: true}})),
        item('.wmd scenario', 'world-export projection for the selected band (all = frequency-qualified).', () => server('wmd', {band: band.value})()),
        item('Verification report', 'JSON report of every check in the verification suite.', server('verification')),
        h('h4', {}, 'Builder'),
        item('Design JSON', 'roombuilder.design.v1: layout + mobility + materials, notes and guide. Re-import anywhere.', server('design')),
        h('h4', {}, 'Images'),
        item('PNG screenshot', 'Current camera at the chosen scale.', () => exporters.screenshot(room, {scale: Number(scale.value), format: 'png', transparent: transparent.checked, overlay: overlay.checked})),
        item('JPEG', 'Current camera, paper background.', () => exporters.screenshot(room, {scale: Number(scale.value), format: 'jpeg', overlay: overlay.checked})),
        item('WebP', 'Current camera, smaller files.', () => exporters.screenshot(room, {scale: Number(scale.value), format: 'webp', transparent: transparent.checked, overlay: overlay.checked})),
        item('4K PNG', '3840 × 2160 render of the current camera.', () => exporters.screenshot(room, {width: 3840, height: 2160, format: 'png', transparent: transparent.checked, overlay: overlay.checked})),
        item('SVG view (vector)', 'The current camera projected to scalable vector graphics.', () => exporters.svgView(room)),
        item('SVG floor plan', 'Architectural top-down plan: walls by material, devices, paths, links, legend and scale bar.', () => server('svg', {band: band.value === 'all' ? state.band : band.value, time_ms: Math.round(state.timeMs), options: {heatmap: heat.checked}})()),
        item('DXF plan (CAD)', 'AutoCAD R12 drawing in metres: walls on one layer per material, devices, paths and labels.', server('dxf')),
        h('h4', {}, '3D models'),
        item('glTF binary (.glb)', 'Walls, floor and devices for Blender, three.js or any glTF viewer.', () => exporters.model3d(room, 'glb')),
        item('glTF (.gltf)', 'Same, JSON form.', () => exporters.model3d(room, 'gltf')),
        item('OBJ', 'Wavefront OBJ meshes.', () => exporters.model3d(room, 'obj')),
        item('STL', 'Meshes for 3D printing a room model.', () => exporters.model3d(room, 'stl')),
        h('h4', {}, 'Motion'),
        item('WebM video', 'Records the whole scenario from 0 s at the chosen speed from the current camera.', async () => {
          dlg.close();
          ui.toast('Recording… keep this tab visible.');
          try { await exporters.recordVideo(room, {speed: Number(speed.value), onProgress: (f) => { document.getElementById('toast').textContent = `Recording ${Math.round(f * 100)}%`; }}); ui.toast('Video saved.'); } catch (error) { ui.toast(error.message, true); }
        })))],
    footer: [status],
  });
}

// ---------------------------------------------------------------- manual / shortcuts
export function openManual(anchor = '') {
  const frame = h('iframe', {src: 'manual.html' + anchor, title: 'Room builder manual'});
  dialog('Room builder manual', {body: [frame], footer: [h('a', {href: 'manual.html', target: '_blank', rel: 'noopener'}, 'Open separately')]});
}

export function openShortcuts() {
  const rows = [
    ['V W R D E C P M', 'Select · Wall · Box · Door · Agent · Client · Path · Measure'],
    ['3 · T · G', '3D orbit · Plan (top, orthographic) · Walk-through'],
    ['F', 'Fit the room in view'], ['H', 'Toggle the coverage heatmap'], ['B', 'Cycle band 2.4 / 5 / 6 GHz'],
    ['Space', 'Play / pause (stops at checkpoints)'], ['[ ]', 'Step one tick back / forward'], ['Home / End', 'Start / end of the script'],
    ['Delete / Backspace', 'Delete the selection'], ['Ctrl+D', 'Duplicate the selected device'], ['Arrows', 'Nudge the selection by the snap (Shift ×10)'],
    ['Esc', 'Finish the current drawing, then clear the selection'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'], ['Ctrl+O', 'Open a saved design'], ['Ctrl+E', 'Export'], ['?', 'This list'],
    ['Wall tool', 'type a length + Enter · Shift 15° · Alt free · right-click / Esc finishes · click the first point to close'],
    ['Dragging', 'Alt disables snapping · Alt-drag a mobile client moves its whole path · dragging it at a later time adds a keyframe'],
    ['Walk view', 'W/A/S/D or arrows move · drag to look · wheel steps'],
  ];
  dialog('Keyboard and mouse', {cls: 'medium', body: [h('div', {class: 'body'}, h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {style: {textAlign: 'left'}}, v)))))]});
}
