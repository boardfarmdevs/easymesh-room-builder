// Bottom timeline: play/pause, scrubbing, speed, band, checkpoints and one
// lane per moving or presence-changing role (presence bars, waypoint ticks).

import {state, on, emit, setTime, setBand, select} from './store.js';
import {mergeNodes, displayRole} from './rfmodel.js';
import {fill} from './dom.js';

let els = null;
let lastTick = 0;
let checkpointHold = null;

export function initTimeline(root) {
  root.innerHTML = `
    <div class="tl-bar">
      <button id="tlPlay" class="primary" data-tip="Play or pause (Space). Playback stops at checkpoints like the live room.">Play</button>
      <button id="tlStart" class="small" data-tip="Jump to the start (Home)." aria-label="Jump to start">⇤</button>
      <div class="tl-time"><span id="tlNow">0.0 s</span><small id="tlMax"></small></div>
      <div class="tl-scrub"><div class="tl-marks" id="tlMarks"></div>
        <input type="range" id="tlScrub" min="0" max="1000" value="0" step="1" aria-label="time" data-tip="Scrub the scenario. Dragging a mobile client at a later time adds a keyframe there."></div>
      <span class="seg small" id="tlSpeed" role="group" aria-label="speed">
        <button data-speed="0.5">½×</button><button data-speed="1" aria-pressed="true">1×</button>
        <button data-speed="2">2×</button><button data-speed="4">4×</button><button data-speed="10">10×</button>
      </span>
      <span class="seg small" id="tlBand" role="group" aria-label="band" data-tip="Band used for link colours, gauges and the heatmap.">
        <button data-band="2.4">2.4 GHz</button><button data-band="5" aria-pressed="true">5 GHz</button><button data-band="6">6 GHz</button>
      </span>
      <span class="tl-status" id="tlStatus" role="status"></span>
      <button id="tlLanes" class="small" aria-expanded="false" data-tip="Show a lane per moving or appearing role: presence (bars), waypoints (ticks) and checkpoints (amber).">Lanes ▴</button>
    </div>
    <div class="tl-lanes" id="tlLaneBox"></div>`;
  els = {
    play: root.querySelector('#tlPlay'), start: root.querySelector('#tlStart'), now: root.querySelector('#tlNow'),
    max: root.querySelector('#tlMax'), scrub: root.querySelector('#tlScrub'), marks: root.querySelector('#tlMarks'),
    speed: root.querySelector('#tlSpeed'), band: root.querySelector('#tlBand'), status: root.querySelector('#tlStatus'),
    lanesBtn: root.querySelector('#tlLanes'), lanes: root.querySelector('#tlLaneBox'),
  };
  els.play.addEventListener('click', togglePlay);
  els.start.addEventListener('click', () => { stop(); setTime(0); });
  els.scrub.addEventListener('input', () => {
    stop();
    const d = duration();
    setTime(Number(els.scrub.value) / 1000 * d);
  });
  els.speed.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    state.speed = Number(b.dataset.speed);
    for (const x of els.speed.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  });
  els.band.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-band]');
    if (b) setBand(b.dataset.band);
  });
  els.lanesBtn.addEventListener('click', () => {
    const open = !document.body.classList.contains('timeline-open');
    document.body.classList.toggle('timeline-open', open);
    els.lanesBtn.setAttribute('aria-expanded', String(open));
    els.lanesBtn.textContent = open ? 'Lanes ▾' : 'Lanes ▴';
    try { localStorage.setItem('roombuilder.lanes', open ? '1' : '0'); } catch (_e) { /* optional */ }
  });
  try { if (localStorage.getItem('roombuilder.lanes') === '1') els.lanesBtn.click(); } catch (_e) { /* optional */ }
  els.lanes.addEventListener('click', (e) => {
    const lane = e.target.closest('.lane');
    if (!lane) return;
    const track = lane.querySelector('.track');
    const r = track.getBoundingClientRect();
    if (e.clientX >= r.left) setTime((e.clientX - r.left) / r.width * duration());
    select({type: 'node', role: lane.dataset.role});
  });
  on('time', refreshTime);
  on('design', () => { renderMarks(); renderLanes(); refreshTime(); });
  on('selection', renderLanes);
  on('view', () => {
    for (const x of els.band.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.band === state.band));
  });
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (!state.playing) { lastTick = now; return; }
    const dt = Math.min(250, now - lastTick) * state.speed;
    lastTick = now;
    advance(dt);
  };
  requestAnimationFrame(frame);
}

function duration() { return state.design ? Number(state.design.mobility.duration_ms) || 0 : 0; }

function advance(dt) {
  const d = duration();
  const before = state.timeMs;
  let next = before + dt;
  const pauses = (state.design.mobility.pause_at_ms || []).filter((t) => t > before && t <= next);
  if (pauses.length && checkpointHold !== pauses[0]) {
    checkpointHold = pauses[0];
    setTime(pauses[0]);
    stop(`Checkpoint at ${pauses[0] / 1000} s — the live room waits here for convergence. Press Play to continue.`);
    return;
  }
  if (next >= d) {
    setTime(d);
    stop('End of script.');
    return;
  }
  setTime(next);
}

export function togglePlay() {
  if (state.playing) { stop(); return; }
  if (state.timeMs >= duration()) setTime(0);
  state.playing = true;
  lastTick = performance.now();
  els.play.textContent = 'Pause';
  els.status.textContent = '';
  emit('playing');
}

export function stop(message = '') {
  if (state.playing) emit('playing');
  state.playing = false;
  if (els) {
    els.play.textContent = 'Play';
    els.status.textContent = message;
  }
  if (!message) checkpointHold = null;
}

function refreshTime() {
  if (!els || !state.design) return;
  const d = duration();
  els.now.textContent = (state.timeMs / 1000).toFixed(1) + ' s';
  els.max.textContent = 'of ' + d / 1000 + ' s';
  els.scrub.value = d ? String(Math.round(state.timeMs / d * 1000)) : '0';
  for (const head of els.lanes.querySelectorAll('.playhead')) head.style.left = (d ? state.timeMs / d * 100 : 0) + '%';
}

function renderMarks() {
  if (!els || !state.design) return;
  const d = duration();
  fill(els.marks, ...(state.design.mobility.pause_at_ms || []).map((t) => {
    const s = document.createElement('span');
    s.style.left = (t / d * 100) + '%';
    s.title = `checkpoint ${t / 1000} s`;
    return s;
  }));
}

function renderLanes() {
  if (!els || !state.design) return;
  const design = state.design;
  const d = duration();
  const nodes = mergeNodes(design.layout, design.mobility).filter((n) => (n.path && n.path.length > 1) || n.presence !== undefined);
  const selected = state.selection && state.selection.role;
  if (!nodes.length) {
    els.lanes.innerHTML = '<div class="empty-lanes">No moving or appearing roles yet. Use the Path tool (P) or set presence in Motion.</div>';
    return;
  }
  const pauses = design.mobility.pause_at_ms || [];
  fill(els.lanes, ...nodes.map((n) => {
    const lane = document.createElement('div');
    lane.className = 'lane' + (n.role === selected ? ' selected' : '');
    lane.dataset.role = n.role;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n.kind === 'fronthaul_ap' ? displayRole(n.role) : n.role;
    const track = document.createElement('div');
    track.className = 'track';
    const intervals = n.presence === undefined ? [[0, d]] : n.presence;
    for (const [s, e] of intervals) {
      const bar = document.createElement('span');
      bar.className = 'present' + (n.kind === 'fronthaul_ap' ? ' ap' : '');
      bar.style.left = (s / d * 100) + '%';
      bar.style.width = ((e - s) / d * 100) + '%';
      track.appendChild(bar);
    }
    for (const w of n.path || []) {
      const tick = document.createElement('span');
      tick.className = 'wp';
      tick.style.left = (w.time_ms / d * 100) + '%';
      tick.title = `${(w.time_ms / 1000).toFixed(1)} s → (${w.position[0]}, ${w.position[1]})`;
      track.appendChild(tick);
    }
    for (const t of pauses) {
      const p = document.createElement('span');
      p.className = 'pause';
      p.style.left = (t / d * 100) + '%';
      track.appendChild(p);
    }
    const head = document.createElement('span');
    head.className = 'playhead';
    head.style.left = (state.timeMs / d * 100) + '%';
    track.appendChild(head);
    lane.append(name, track);
    return lane;
  }));
}
