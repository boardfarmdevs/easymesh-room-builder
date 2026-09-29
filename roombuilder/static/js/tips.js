// Hover and focus tips. Any element with data-tip (free text) or data-tip-key
// (a configurator property key from /api/meta's schema catalog) gets a tip in
// the viewer's dark HUD style. Tips for configurator properties also show the
// document they live in and their constraints.

let catalog = {};
let timer = null;
let current = null;

export function setCatalog(schema) {
  catalog = {};
  for (const item of (schema && schema.properties) || []) catalog[item.key] = item;
}

export function describe(key) {
  return catalog[key] || null;
}

function constraintText(item) {
  const parts = [];
  if (item.doc) parts.push(item.doc === 'layout|mobility' ? 'layout or mobility' : item.doc);
  if (item.type) parts.push(item.type);
  if (item.min !== undefined) parts.push(`≥ ${item.min}`);
  if (item.min_exclusive !== undefined) parts.push(`> ${item.min_exclusive}`);
  if (item.max !== undefined) parts.push(`≤ ${item.max}`);
  if (item.unit) parts.push(item.unit);
  if (item.values) parts.push(item.values.join(' | '));
  if (item.default !== undefined) parts.push(`default ${typeof item.default === 'object' ? JSON.stringify(item.default) : item.default}`);
  return parts.join(' · ');
}

function contentFor(el) {
  const key = el.getAttribute('data-tip-key');
  const text = el.getAttribute('data-tip');
  const tip = document.createElement('div');
  if (key && catalog[key]) {
    const item = catalog[key];
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = item.label || key;
    tip.appendChild(title);
    const body = document.createElement('div');
    body.textContent = item.tip;
    tip.appendChild(body);
    if (text) { const extra = document.createElement('div'); extra.style.marginTop = '4px'; extra.textContent = text; tip.appendChild(extra); }
    const meta = document.createElement('div');
    meta.className = 'tip-meta';
    meta.textContent = key + ' · ' + constraintText(item);
    tip.appendChild(meta);
    return tip;
  }
  if (!text) return null;
  tip.textContent = text;
  return tip;
}

function show(el) {
  const box = document.getElementById('tooltip');
  const content = contentFor(el);
  if (!content) return;
  box.replaceChildren(content);
  box.hidden = false;
  const r = el.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let left = r.left + Math.min(r.width / 2, 40);
  let top = r.bottom + 8;
  if (top + bh > window.innerHeight - 8) top = r.top - bh - 8;
  left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
  box.style.left = left + 'px';
  box.style.top = Math.max(8, top) + 'px';
  current = el;
}

export function hide() {
  clearTimeout(timer);
  const box = document.getElementById('tooltip');
  if (box) box.hidden = true;
  current = null;
}

export function installTooltips(root = document) {
  const find = (target) => target && target.closest && target.closest('[data-tip], [data-tip-key]');
  root.addEventListener('pointerover', (e) => {
    const el = find(e.target);
    if (!el || el === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), 380);
  });
  root.addEventListener('pointerout', (e) => {
    const el = find(e.target);
    if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) hide();
  });
  root.addEventListener('focusin', (e) => {
    const el = find(e.target);
    if (el) { clearTimeout(timer); timer = setTimeout(() => show(el), 600); }
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// One-line guidance shown in the bottom-right hint for the active tool.
export const TOOL_HINTS = {
  select: 'click to select · drag devices, walls, wall ends and waypoints · drag empty space to orbit · Shift-drag to pan · scroll to zoom · right-click for actions · Space plays',
  wall: 'click to start a wall · click to end it (the chain continues) · Shift snaps to 15° · type a length + Enter · Alt disables snapping · Esc or right-click finishes',
  room: 'drag a rectangle to add four walls of the active material · Alt disables snapping',
  door: 'click a wall to cut a door gap of the chosen width · RF passes the gap with no wall loss',
  ap: 'click the floor to add an agent · the first one becomes the gateway (Agent-1) · keep ≥ 30 cm from walls',
  client: 'click the floor to add a static client · Shift-click adds a mobile one ready for a path',
  path: 'click a client, then click the floor to add waypoints timed by the walk speed · Enter / double-click finishes · Backspace removes the last waypoint',
  measure: 'click two points: distance, crossed walls and predicted SNR per band · a third click starts again',
};

export const VIEW_HINTS = {
  plan: 'Plan view: exact top-down drawing · drag empty space or Shift-drag to pan · scroll zooms around the cursor',
  walk: 'Walk view: drag to look around · W/A/S/D or arrows move · scroll steps · Esc returns to 3D',
};

// Rotating tips shown in the Room tab.
export const TIPS = [
  'Walls add their loss only when the straight line between two devices properly crosses them. A device exactly on a wall line ignores that wall — keep devices a few centimetres away.',
  'To model a double wall, draw two parallel walls about 20 cm apart (Walls → Double). Overlapping walls also add both losses, but are easy to create by accident.',
  'A door is just a gap between two walls. Links through the gap see no wall loss at all.',
  'The live lab needs the gateway plus extender_1..4. For a smaller home, park the spare extenders: Devices → select → "Park (never on air)".',
  'Positions and presence are keyed to physical roles. Moving sta_static_03 moves the lab container bound to it (wlan-client-002), never "whatever client is on AP-2".',
  'Drag a mobile client at a later time to add a keyframe: the path bends through the new point without retyping times.',
  'Checkpoints (pause_at_ms) stop playback so the optimizer can measure stable RF. They are viewer/room metadata only; .wmd exports do not contain them.',
  'backhaul_rf "geometry" makes AP-to-AP RF follow the room during playback; "fixed" keeps the lab\'s protected startup backhaul.',
  'World plans don\'t carry the room size. The reference viewer opening just a .world.json shows at least 20 × 14 m; the live room uses the installed layout.',
  'Export → Lab bundle writes layouts/, mobility/ and golden/ exactly where the configurator tree expects them, plus the build-goldens.sh line.',
  'The heatmap uses the same model as the compiler; the optimizer maximises coverage while keeping every extender on a ≥ 20 dB backhaul hop.',
  'Transmit adjustment (tx_gain_db_by_band) on a client makes its uplink weaker than its downlink — the asymmetric-link rooms use −7/−10/−12 dB.',
];
