// Small 2D plan drawings for the library and design dialogs.

import * as rf from './rfmodel.js';

const MATERIAL_COLORS = {};

export function setMaterialColors(materials) {
  for (const m of materials) MATERIAL_COLORS[m.id] = m.color;
}

export function drawPlan(canvas, design, {time = 0, band = '5', links = true} = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width, cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#f3efe6';
  ctx.fillRect(0, 0, cssW, cssH);
  const W = Number(design.layout.space.width_m), H = Number(design.layout.space.height_m);
  const pad = 14;
  const s = Math.min((cssW - 2 * pad) / W, (cssH - 2 * pad) / H);
  const ox = (cssW - W * s) / 2, oy = (cssH - H * s) / 2;
  const X = (x) => ox + x * s, Y = (y) => oy + (H - y) * s;
  ctx.fillStyle = '#e9e4d8';
  ctx.fillRect(X(0), Y(H), W * s, H * s);
  ctx.strokeStyle = '#d0c9ba';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(W, H) > 60 ? 5 : 2;
  for (let x = 0; x <= W + 1e-9; x += step) { ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(H)); }
  for (let y = 0; y <= H + 1e-9; y += step) { ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); }
  ctx.stroke();
  const mats = (design.builder && design.builder.wall_materials) || [];
  (design.layout.walls || []).forEach((w, i) => {
    ctx.strokeStyle = MATERIAL_COLORS[mats[i]] || '#b8ad9a';
    ctx.lineWidth = Math.max(2, 0.18 * s);
    ctx.beginPath(); ctx.moveTo(X(w.start[0]), Y(w.start[1])); ctx.lineTo(X(w.end[0]), Y(w.end[1])); ctx.stroke();
  });
  const scene = rf.sceneAt(design, time);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(111, 62, 142, .7)';
  ctx.lineWidth = 1.2;
  for (const n of scene.nodes) {
    const path = n.node.path;
    if (!path || path.length < 2) continue;
    ctx.beginPath();
    path.forEach((w, i) => (i ? ctx.lineTo(X(w.position[0]), Y(w.position[1])) : ctx.moveTo(X(w.position[0]), Y(w.position[1]))));
    ctx.stroke();
  }
  if (links) {
    const best = rf.bestServing(scene, design.layout, band);
    for (const [sta, b] of Object.entries(best)) {
      const a = scene.byRole[b.ap].position, p = scene.byRole[sta].position;
      ctx.strokeStyle = rf.signal.snrColor(b.snr);
      ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.setLineDash([]);
  const colors = {gateway: '#c0392b', extender: '#d65f27', mobile: '#7a4b9c', static: '#3b3b3b'};
  const r = Math.max(2.2, Math.min(5, s * 0.25));
  for (const n of scene.nodes.filter((x) => x.kind === 'station')) {
    ctx.fillStyle = n.present ? colors[rf.kindClass(n.role, n.kind)] : '#c9c9c9';
    ctx.beginPath(); ctx.arc(X(n.position[0]), Y(n.position[1]), r, 0, Math.PI * 2); ctx.fill();
  }
  for (const n of scene.nodes.filter((x) => x.kind === 'fronthaul_ap')) {
    const cx = X(n.position[0]), cy = Y(n.position[1]), t = r * 2.1;
    ctx.fillStyle = n.present ? colors[rf.kindClass(n.role, n.kind)] : '#c9c9c9';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - t); ctx.lineTo(cx + t * 0.9, cy + t * 0.6); ctx.lineTo(cx - t * 0.9, cy + t * 0.6); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = '#7a726a';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${W} × ${H} m`, X(0), Y(0) + 12);
}
