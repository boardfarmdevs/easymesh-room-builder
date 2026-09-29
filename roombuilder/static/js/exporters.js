// Client-side graphical exports: raster screenshots (any size, optional title
// and legend), a projected vector SVG of the current camera, 3D models
// (glTF/GLB, OBJ, STL) and a WebM recording of the scenario playback.

import * as rf from './rfmodel.js';
import {state, setTime} from './store.js';
import {download} from './api.js';
import {AP_H, STA_H, WALL_H} from './scene3d.js';

const THREE = window.THREE;

function stamp() {
  const d = state.design;
  return `${d.id || 'room'}-${(state.timeMs / 1000).toFixed(1).replace('.', '_')}s`;
}

export async function screenshot(room, {scale = 1, format = 'png', transparent = false, overlay = false, width, height} = {}) {
  const rect = room.renderer.domElement.getBoundingClientRect();
  const w = width || Math.round(rect.width * scale), h = height || Math.round(rect.height * scale);
  const canvas = room.capture({width: w, height: h, transparent: transparent && format !== 'jpeg'});
  if (overlay) drawOverlay(canvas);
  const mime = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'}[format];
  if (format === 'jpeg' || !transparent) {
    const bg = document.createElement('canvas');
    bg.width = canvas.width; bg.height = canvas.height;
    const ctx = bg.getContext('2d');
    ctx.fillStyle = '#f3efe6';
    ctx.fillRect(0, 0, bg.width, bg.height);
    ctx.drawImage(canvas, 0, 0);
    return new Promise((resolve) => bg.toBlob((blob) => { download(blob, `${stamp()}.${format === 'jpeg' ? 'jpg' : format}`); resolve(); }, mime, 0.95));
  }
  return new Promise((resolve) => canvas.toBlob((blob) => { download(blob, `${stamp()}.${format}`); resolve(); }, mime, 0.95));
}

function drawOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / 1400;
  const d = state.design;
  ctx.fillStyle = '#2a2622';
  ctx.font = `650 ${Math.round(26 * s)}px "Source Sans 3", "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(d.title || d.layout.name, 24 * s, 42 * s);
  ctx.fillStyle = '#7a726a';
  ctx.font = `${Math.round(15 * s)}px "Source Sans 3", "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(`${d.layout.name}--${d.mobility.name} · ${d.layout.space.width_m} × ${d.layout.space.height_m} m · t = ${(state.timeMs / 1000).toFixed(1)} s of ${d.mobility.duration_ms / 1000} s · ${state.band} GHz`, 24 * s, 66 * s);
  const items = [['gateway', '#c0392b'], ['extender', '#d65f27'], ['mobile station', '#7a4b9c'], ['static station', '#3b3b3b']];
  let x = 24 * s;
  const y = canvas.height - 28 * s;
  ctx.font = `${Math.round(14 * s)}px "Source Sans 3", "Segoe UI", system-ui, sans-serif`;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + 6 * s, y - 5 * s, 6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a2622';
    ctx.fillText(label, x + 16 * s, y);
    x += (26 + label.length * 7.5) * s;
  }
  for (const [label, color] of [['weak', rf.signal.colors.red], ['fair', rf.signal.colors.yellow], ['strong', rf.signal.colors.green]]) {
    ctx.strokeStyle = color; ctx.lineWidth = 3 * s; ctx.setLineDash([8 * s, 5 * s]);
    ctx.beginPath(); ctx.moveTo(x, y - 5 * s); ctx.lineTo(x + 28 * s, y - 5 * s); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2a2622'; ctx.fillText(label + ' link', x + 34 * s, y);
    x += (52 + label.length * 7.5 + 30) * s;
  }
}

// ---- projected SVG of the current view ---------------------------------------
export function svgView(room) {
  const d = state.design;
  const cam = room.activeCamera;
  const el = room.renderer.domElement.getBoundingClientRect();
  const w = Math.round(el.width), h = Math.round(el.height);
  cam.updateMatrixWorld();
  const toScreen = (x, y, z) => {
    const v = new THREE.Vector3(x, z, -y);
    const view = v.clone().applyMatrix4(cam.matrixWorldInverse);
    v.project(cam);
    return {x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, depth: -view.z, behind: v.z > 1 || v.z < -1};
  };
  const prims = [];
  const W = Number(d.layout.space.width_m), H = Number(d.layout.space.height_m);
  const poly = (pts, attrs, depth) => prims.push({depth, svg: `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" ${attrs}/>`});
  const line = (a, b, attrs, depth) => prims.push({depth, svg: `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" ${attrs}/>`});
  // floor and grid always at the back
  const floor = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => toScreen(x, y, 0));
  poly(floor, 'fill="#e9e4d8" stroke="#d0c9ba"', 1e9);
  for (let x = 0; x <= W + 1e-9; x += 2) line(toScreen(x, 0, 0), toScreen(x, H, 0), 'stroke="#d0c9ba" stroke-width="1"', 1e9 - 1);
  for (let y = 0; y <= H + 1e-9; y += 2) line(toScreen(0, y, 0), toScreen(W, y, 0), 'stroke="#d0c9ba" stroke-width="1"', 1e9 - 1);
  // walls: box faces
  for (const wall of d.layout.walls || []) {
    const [x0, y0] = wall.start, [x1, y1] = wall.end;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / len * 0.06, ny = (x1 - x0) / len * 0.06;
    const c = [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]];
    const faces = [[0, 1], [1, 2], [2, 3], [3, 0]];
    for (const [i, j] of faces) {
      const pts = [toScreen(...c[i], 0), toScreen(...c[j], 0), toScreen(...c[j], WALL_H), toScreen(...c[i], WALL_H)];
      poly(pts, 'fill="#b8ad9a" fill-opacity="0.55" stroke="#8e8472" stroke-width="0.6"', pts.reduce((s, p) => s + p.depth, 0) / 4);
    }
    const top = c.map((p) => toScreen(...p, WALL_H));
    poly(top, 'fill="#c9bfae" fill-opacity="0.7" stroke="#8e8472" stroke-width="0.6"', top.reduce((s, p) => s + p.depth, 0) / 4 - 0.01);
    const mid = toScreen((x0 + x1) / 2, (y0 + y1) / 2, 0.01);
    prims.push({depth: 1e9 - 2, svg: `<text x="${mid.x.toFixed(1)}" y="${(mid.y + 14).toFixed(1)}" font-size="11" font-weight="600" fill="#5c5344" text-anchor="middle">${esc(`${wall.name || 'wall'}  ${wall.loss_db} dB`)}</text>`});
  }
  const scene = rf.sceneAt(d, state.timeMs);
  const best = rf.bestServing(scene, d.layout, state.band);
  if (state.view.links) {
    for (const [sta, b] of Object.entries(best)) {
      const a = scene.byRole[b.ap].position, p = scene.byRole[sta].position;
      const A = toScreen(a[0], a[1], AP_H), B = toScreen(p[0], p[1], STA_H);
      line(A, B, `stroke="${rf.signal.snrColor(b.snr)}" stroke-width="1.6" stroke-dasharray="6 4" opacity="0.8"`, (A.depth + B.depth) / 2);
    }
  }
  const colors = {gateway: '#c0392b', extender: '#d65f27', mobile: '#7a4b9c', static: '#3b3b3b'};
  const scale = Math.max(1, Math.min(2, Math.max(W, H) / 20));
  for (const n of scene.nodes) {
    const ap = n.kind === 'fronthaul_ap';
    const color = n.present ? colors[rf.kindClass(n.role, n.kind)] : '#c9c9c9';
    const [x, y] = n.position;
    const hgt = (ap ? AP_H : STA_H) * scale;
    const base = toScreen(x, y, 0), top = toScreen(x, y, hgt);
    const depth = base.depth;
    line(base, top, `stroke="${color}" stroke-width="${ap ? 3 : 1.5}"`, depth);
    if (ap) {
      const apex = toScreen(x, y, hgt + 0.7 * scale), b1 = toScreen(x + 0.45 * scale, y, hgt), b2 = toScreen(x - 0.45 * scale, y, hgt);
      poly([apex, b1, b2], `fill="${color}"`, depth - 0.01);
    } else {
      const edge = toScreen(x + 0.22 * scale, y, hgt);
      const r = Math.max(2, Math.hypot(edge.x - top.x, edge.y - top.y));
      prims.push({depth: depth - 0.01, svg: `<circle cx="${top.x.toFixed(1)}" cy="${top.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>`});
    }
    if (state.view.labels) {
      const label = ap ? rf.displayRole(n.role) : rf.shortRole(n.role);
      const lp = toScreen(x, y, hgt + (ap ? 0.95 : 0.42) * scale);
      const fs = ap ? 12 : 10, tw = label.length * fs * 0.6 + 10;
      prims.push({depth: -1e9, svg: `<g opacity="${n.present ? 1 : 0.4}"><rect x="${(lp.x - tw / 2).toFixed(1)}" y="${(lp.y - fs * 0.8).toFixed(1)}" width="${tw.toFixed(1)}" height="${(fs * 1.5).toFixed(1)}" rx="4" fill="${color}"/><text x="${lp.x.toFixed(1)}" y="${(lp.y + fs * 0.35).toFixed(1)}" font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle">${esc(label)}</text></g>`});
    }
  }
  prims.sort((a, b) => b.depth - a.depth);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="'Source Sans 3', 'Segoe UI', system-ui, sans-serif">
<rect width="100%" height="100%" fill="#f3efe6"/>
${prims.map((p) => p.svg).join('\n')}
<text x="16" y="28" font-size="18" font-weight="650" fill="#2a2622">${esc(d.title || d.layout.name)}</text>
<text x="16" y="46" font-size="12" fill="#7a726a">${esc(`${d.layout.name}--${d.mobility.name} · t = ${(state.timeMs / 1000).toFixed(1)} s · ${state.band} GHz`)}</text>
</svg>\n`;
  download(new Blob([svg], {type: 'image/svg+xml'}), `${stamp()}-view.svg`);
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

// ---- 3D models ---------------------------------------------------------------------
export function model3d(room, format) {
  const group = room.exportGroup();
  const name = state.design.id || 'room';
  if (format === 'glb' || format === 'gltf') {
    const exporter = new THREE.GLTFExporter();
    exporter.parse(group, (result) => {
      if (format === 'glb') download(new Blob([result], {type: 'model/gltf-binary'}), `${name}.glb`);
      else download(new Blob([JSON.stringify(result)], {type: 'model/gltf+json'}), `${name}.gltf`);
    }, {binary: format === 'glb', onlyVisible: true});
  } else if (format === 'obj') {
    download(new Blob([new THREE.OBJExporter().parse(group)], {type: 'text/plain'}), `${name}.obj`);
  } else if (format === 'stl') {
    download(new Blob([new THREE.STLExporter().parse(group, {binary: false})], {type: 'model/stl'}), `${name}.stl`);
  }
}

// ---- video --------------------------------------------------------------------------
export async function recordVideo(room, {speed = 4, fps = 30, onProgress} = {}) {
  const canvas = room.renderer.domElement;
  if (!canvas.captureStream || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record canvas video');
  const stream = canvas.captureStream(fps);
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, {mimeType: type, videoBitsPerSecond: 8_000_000});
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { recorder.onstop = resolve; });
  const duration = Number(state.design.mobility.duration_ms);
  const wasPlaying = state.playing;
  state.playing = false;
  setTime(0);
  recorder.start(250);
  const started = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const t = (performance.now() - started) * speed;
      setTime(Math.min(duration, t));
      room.sync();
      room.render();
      if (onProgress) onProgress(Math.min(1, t / duration));
      if (t >= duration) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await new Promise((r) => setTimeout(r, 300));
  recorder.stop();
  await done;
  if (wasPlaying) state.playing = false;
  download(new Blob(chunks, {type: 'video/webm'}), `${state.design.id || 'room'}-${speed}x.webm`);
}
