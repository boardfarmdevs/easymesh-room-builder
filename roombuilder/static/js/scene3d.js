// Three.js room scene. Geometry, colours, lights and the orbit camera are
// taken from the reference room viewer (worlds/viewer/index.html) so a room
// looks identical in the builder and in the lab; builder overlays (handles,
// previews, heatmap, ghosts) are added on top.

import * as rf from './rfmodel.js';
import {state} from './store.js';

const THREE = window.THREE;
export const AP_H = 2.2, STA_H = 0.9, WALL_H = 2.6;
export const COL = {
  gateway: 0xc0392b, extender: 0xd65f27, mobile: 0x7a4b9c, static: 0x3b3b3b,
  floor: 0xe9e4d8, grid: 0xd0c9ba, wall: 0xb8ad9a, absent: 0xc9c9c9,
  path: 0x6f3e8e, select: 0xd65f27, handle: 0x6f3e8e, ghost: 0x6f3e8e,
};
export const DEFAULT_ANGLES = Object.freeze({theta: -0.9, phi: 0.95});
const P = (x, y, z) => new THREE.Vector3(x, z, -y);   // plan (x, y) + height -> scene

// ---- text sprites (viewer textTexture/makeSprite) ------------------------------
function textTexture(text, {fg = '#fff', bg = null, font = 'bold 44px system-ui, sans-serif', pad = 18} = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  c.width = Math.ceil(tw + pad * 2); c.height = 64;
  ctx.font = font; ctx.textBaseline = 'middle';
  if (bg) {
    ctx.fillStyle = bg;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(c.width - r, 0); ctx.quadraticCurveTo(c.width, 0, c.width, r);
    ctx.lineTo(c.width, c.height - r); ctx.quadraticCurveTo(c.width, c.height, c.width - r, c.height);
    ctx.lineTo(r, c.height); ctx.quadraticCurveTo(0, c.height, 0, c.height - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = fg; ctx.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter; tex.anisotropy = 4;
  return {tex, aspect: c.width / c.height};
}

function makeSprite(text, color, height, opts = {}) {
  const t = textTexture(text, Object.assign({bg: color}, opts));
  const mat = new THREE.SpriteMaterial({map: t.tex, depthTest: false, transparent: true});
  const sp = new THREE.Sprite(mat);
  sp.scale.set(height * t.aspect, height, 1);
  sp.userData.labelText = text;
  sp.userData.labelHeight = height;
  sp.userData.labelColor = color;
  sp.renderOrder = 10;
  return sp;
}

function setSpriteLabel(sprite, text, color) {
  if (sprite.userData.labelText === text && sprite.userData.labelColor === color) return;
  const rendered = textTexture(text, {bg: color});
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.map = rendered.tex;
  sprite.material.needsUpdate = true;
  const h = sprite.userData.labelHeight;
  sprite.scale.set(h * rendered.aspect, h, 1);
  sprite.userData.labelText = text;
  sprite.userData.labelColor = color;
}

function makeFloorText(text, x0, y0, x1, y1, height) {
  const t = textTexture(text, {fg: '#5c5344', font: '600 40px system-ui, sans-serif', pad: 6});
  const mat = new THREE.MeshBasicMaterial({map: t.tex, transparent: true, depthWrite: false});
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(height * t.aspect, height), mat);
  plane.rotation.x = -Math.PI / 2;
  let ang = Math.atan2(y1 - y0, x1 - x0);
  if (ang > Math.PI / 2 + 1e-6 || ang <= -Math.PI / 2 + 1e-6) ang += Math.PI;
  const g = new THREE.Group();
  g.position.copy(P((x0 + x1) / 2, (y0 + y1) / 2, 0.012));
  g.rotation.y = -ang;
  plane.position.z = 0.45 + height / 2;
  g.add(plane);
  return g;
}

function makeSignalGauge() {
  const group = new THREE.Group();
  const bars = [];
  for (let index = 0; index < 10; index++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.065, 0.055),
      new THREE.MeshBasicMaterial({color: rf.signal.colors.grey, transparent: true, opacity: 1, depthTest: false}));
    bar.position.y = 0.10 + index * 0.082;
    bar.renderOrder = 11;
    group.add(bar);
    bars.push(bar);
  }
  return {group, bars};
}

function roomCameraRadius(size, aspect, fieldOfView, theta, phi) {
  const vertical = Math.tan(fieldOfView * Math.PI / 360) / 1.08;
  const horizontal = vertical * Math.max(0.1, aspect);
  const markerHeight = 3.5 * Math.max(1, Math.min(2, Math.max(size.width, size.height) / 20));
  let radius = 6;
  for (const offsetX of [-size.width / 2, size.width / 2]) {
    for (const offsetZ of [-size.height / 2, size.height / 2]) {
      for (const offsetY of [0, markerHeight]) {
        const right = offsetX * Math.cos(theta) - offsetZ * Math.sin(theta);
        const up = -offsetX * Math.cos(phi) * Math.sin(theta) + offsetY * Math.sin(phi) - offsetZ * Math.cos(phi) * Math.cos(theta);
        const depth = offsetX * Math.sin(phi) * Math.sin(theta) + offsetY * Math.cos(phi) + offsetZ * Math.sin(phi) * Math.cos(theta);
        radius = Math.max(radius, depth + Math.abs(right) / horizontal, depth + Math.abs(up) / vertical);
      }
    }
  }
  return radius;
}

function lineSegments(material, renderOrder = 0) {
  const obj = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  obj.renderOrder = renderOrder;
  obj.frustumCulled = false;
  return obj;
}

function setSegments(obj, pts, cols) {
  const g = obj.geometry;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  if (cols) g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeBoundingSphere();
  if (obj.computeLineDistances) obj.computeLineDistances();
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
}

export class RoomScene {
  constructor(container, {materials = {}} = {}) {
    this.container = container;
    this.materials = materials;
    this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcbbfae, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(-8, 25, 14);
    this.scene.add(sun);
    this.orbit = {target: new THREE.Vector3(10, 0, -7), r: 30, theta: DEFAULT_ANGLES.theta, phi: DEFAULT_ANGLES.phi};
    this.plan = {cx: 10, cy: 7, zoom: 1, span: 20};
    this.walk = {x: 2, y: 2, yaw: 0.6, pitch: -0.05, eye: 1.6};
    this.mode = 'orbit';
    this.autoFit = true;
    this.fittedRadius = 30;
    this.world = null;
    this.key = null;
    this.dirty = true;
    this.frameHooks = [];
    this.ray = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      for (const hook of this.frameHooks) hook();
      if (this.dirty) this.render();
    };
    requestAnimationFrame(loop);
  }

  get activeCamera() { return this.mode === 'plan' ? this.ortho : this.camera; }

  requestRender() { this.dirty = true; }

  render() {
    this.dirty = false;
    this.renderer.render(this.scene, this.activeCamera);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitIfAuto();
    this.placeCamera();
  }

  // ---- cameras -----------------------------------------------------------------
  roomSize() {
    const d = state.design;
    return d ? {width: Number(d.layout.space.width_m), height: Number(d.layout.space.height_m)} : {width: 20, height: 14};
  }

  fitIfAuto() { if (this.autoFit) this.fit(false); }

  fit(resetAngles = true) {
    const size = this.roomSize();
    if (resetAngles) { this.orbit.theta = DEFAULT_ANGLES.theta; this.orbit.phi = DEFAULT_ANGLES.phi; }
    this.orbit.target.set(size.width / 2, 0, -size.height / 2);
    this.fittedRadius = roomCameraRadius(size, this.camera.aspect, this.camera.fov, this.orbit.theta, this.orbit.phi);
    this.orbit.r = this.fittedRadius;
    this.plan.cx = size.width / 2; this.plan.cy = size.height / 2; this.plan.zoom = 1;
    this.autoFit = true;
    this.placeCamera();
  }

  placeCamera() {
    const {target, r, theta, phi} = this.orbit;
    this.camera.fov = this.mode === 'walk' ? 62 : 40;
    if (this.mode === 'walk') {
      const {x, y, yaw, pitch, eye} = this.walk;
      this.camera.position.copy(P(x, y, eye));
      const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw));
      this.camera.lookAt(this.camera.position.clone().add(dir));
      this.camera.near = 0.05;
      this.camera.far = 1000;
    } else {
      this.camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi),
        target.z + r * Math.sin(phi) * Math.cos(theta));
      this.camera.lookAt(target);
      this.camera.near = 0.1;
      this.camera.far = Math.max(500, r * 4);
    }
    this.camera.updateProjectionMatrix();
    // plan: orthographic straight down, plan +y up on screen
    const size = this.roomSize();
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    const margin = 1.12;
    let halfH = Math.max(size.height / 2, size.width / 2 / aspect) * margin + 1.2;
    halfH /= this.plan.zoom;
    const halfW = halfH * aspect;
    Object.assign(this.ortho, {left: -halfW, right: halfW, top: halfH, bottom: -halfH});
    this.ortho.position.set(this.plan.cx, 200, -this.plan.cy);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(this.plan.cx, 0, -this.plan.cy);
    this.ortho.updateProjectionMatrix();
    this.planScale = h / (2 * halfH);   // pixels per metre
    this.requestRender();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.world) this.world.root.traverse((o) => { if (o.userData && o.userData.planOnly) o.visible = mode === 'plan'; });
    if (mode === 'walk') this.spawnWalker();
    this.placeCamera();
    this.sync(true);
  }

  // Start the walk-through just outside the south-west corner, at eye
  // height, looking across the room: an entrance view of the whole floor.
  spawnWalker() {
    const size = this.roomSize();
    const back = Math.max(2.5, Math.max(size.width, size.height) * 0.12);
    this.walk.x = -back;
    this.walk.y = -back;
    this.walk.yaw = Math.atan2(size.height / 2 + back, size.width / 2 + back);
    this.walk.pitch = -0.12;
  }

  orbitBy(dx, dy) {
    this.autoFit = false;
    if (this.mode === 'walk') {
      this.walk.yaw -= dx * 0.004;
      this.walk.pitch = Math.max(-1.3, Math.min(1.3, this.walk.pitch - dy * 0.004));
    } else if (this.mode === 'plan') {
      this.panBy(dx, dy);
      return;
    } else {
      this.orbit.theta -= dx * 0.006;
      this.orbit.phi = Math.min(1.45, Math.max(0.15, this.orbit.phi - dy * 0.006));
    }
    this.placeCamera();
  }

  panBy(dx, dy) {
    this.autoFit = false;
    if (this.mode === 'plan') {
      this.plan.cx -= dx / this.planScale;
      this.plan.cy += dy / this.planScale;
    } else if (this.mode === 'walk') {
      this.walkMove(-dy * 0.02, dx * 0.02);
      return;
    } else {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      this.orbit.target.addScaledVector(right, -dx * this.orbit.r / 700).addScaledVector(up, dy * this.orbit.r / 700);
    }
    this.placeCamera();
  }

  zoomBy(deltaY, clientX, clientY) {
    this.autoFit = false;
    if (this.mode === 'plan') {
      const before = this.floorPoint(clientX, clientY);
      this.plan.zoom = Math.min(40, Math.max(0.3, this.plan.zoom * (1 - deltaY * 0.0012)));
      this.placeCamera();
      const after = this.floorPoint(clientX, clientY);
      if (before && after) { this.plan.cx += before[0] - after[0]; this.plan.cy += before[1] - after[1]; this.placeCamera(); }
    } else if (this.mode === 'walk') {
      this.walkMove(-deltaY * 0.01, 0);
    } else {
      this.orbit.r = Math.min(Math.max(90, this.fittedRadius * 3), Math.max(3, this.orbit.r * (1 + deltaY * 0.0012)));
      this.placeCamera();
    }
  }

  walkMove(forward, strafe) {
    const {yaw} = this.walk;
    const size = this.roomSize();
    this.walk.x = Math.max(-5, Math.min(size.width + 5, this.walk.x + Math.cos(yaw) * forward + Math.sin(yaw) * strafe));
    this.walk.y = Math.max(-5, Math.min(size.height + 5, this.walk.y + Math.sin(yaw) * forward - Math.cos(yaw) * strafe));
    this.placeCamera();
  }

  // ---- picking -----------------------------------------------------------------------
  ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  floorPoint(clientX, clientY) {
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.activeCamera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.floorPlane, hit)) return null;
    return [hit.x, -hit.z];
  }

  pick(clientX, clientY) {
    if (!this.world) return null;
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.activeCamera);
    this.ray.params.Line = {threshold: 0.15};
    const groups = [
      ['handle', this.world.handles],
      ['waypoint', this.world.waypointPicks],
      ['node', this.world.pickables],
      ['wall', this.world.walls],
    ];
    for (const [type, objects] of groups) {
      const visible = objects.filter((o) => o.visible !== false && (!o.parent || o.parent.visible !== false));
      const hits = this.ray.intersectObjects(visible, false);
      if (hits.length) return Object.assign({type}, hits[0].object.userData);
    }
    return null;
  }

  // ---- world build --------------------------------------------------------------------
  structureKey(design) {
    const scene = rf.mergeNodes(design.layout, design.mobility).map((n) => [n.role, n.kind, n.backhaul || '']);
    return JSON.stringify([design.layout.space, design.layout.walls, design.builder && design.builder.wall_materials,
      scene, state.view.labels, state.view.wallLabels, state.view.gauges, state.view.materialTint, state.view.fineGrid,
      state.selection && state.selection.type === 'wall' ? state.selection.index : null, this.mode === 'walk']);
  }

  sync(force = false) {
    const design = state.design;
    if (!design) return;
    const key = this.structureKey(design);
    if (force || key !== this.key) {
      this.key = key;
      this.build(design);
    }
    this.update();
  }

  build(design) {
    if (this.world) { this.scene.remove(this.world.root); disposeTree(this.world.root); }
    const root = new THREE.Group();
    const W = Number(design.layout.space.width_m), H = Number(design.layout.space.height_m);
    const markerScale = this.mode === 'walk' ? 1 : Math.max(1, Math.min(2, Math.max(W, H) / 20));
    const labelScale = this.mode === 'walk' ? 0.55 : 1;   // world-sized labels look huge at eye height

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({color: COL.floor}));
    floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, -0.01, -H / 2);
    root.add(floor);
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({transparent: true, opacity: 0.62, depthWrite: false}));
    heat.rotation.x = -Math.PI / 2; heat.position.set(W / 2, -0.004, -H / 2);
    heat.visible = false;
    heat.renderOrder = 0;
    root.add(heat);
    if (state.view.fineGrid) {
      const fine = [];
      const step = state.snap >= 0.25 ? state.snap : 0.5;
      for (let x = 0; x <= W + 1e-9; x += step) fine.push(P(x, 0, -0.002), P(x, H, -0.002));
      for (let y = 0; y <= H + 1e-9; y += step) fine.push(P(0, y, -0.002), P(W, y, -0.002));
      root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fine),
        new THREE.LineBasicMaterial({color: 0xe3dccd})));
    }
    const gridPts = [];
    for (let x = 0; x <= W + 1e-9; x += 2) gridPts.push(P(x, 0, 0), P(x, H, 0));
    for (let y = 0; y <= H + 1e-9; y += 2) gridPts.push(P(0, y, 0), P(W, y, 0));
    if (W % 2) gridPts.push(P(W, 0, 0), P(W, H, 0));
    if (H % 2) gridPts.push(P(0, H, 0), P(W, H, 0));
    root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), new THREE.LineBasicMaterial({color: COL.grid})));

    // walls (viewer: 0.12 m thick, 2.6 m high, translucent, stencil-marked)
    const walls = [];
    const materials = (design.builder && design.builder.wall_materials) || [];
    const selectedWall = state.selection && state.selection.type === 'wall' ? state.selection.index : -1;
    (design.layout.walls || []).forEach((w, index) => {
      const [x0, y0] = w.start, [x1, y1] = w.end;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (!(len > 0)) return;
      const material = this.materials[materials[index]] || null;
      const tint = state.view.materialTint && material;
      const thickness = tint ? Math.max(0.06, material.thickness_m || 0.12) : 0.12;
      const color = tint ? new THREE.Color(material.color) : new THREE.Color(COL.wall);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, thickness),
        new THREE.MeshLambertMaterial({color, transparent: true, opacity: tint ? 0.7 : 0.55,
          stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp}));
      m.renderOrder = 1;
      m.position.copy(P((x0 + x1) / 2, (y0 + y1) / 2, WALL_H / 2));
      m.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      m.userData = {wall: index};
      root.add(m);
      walls.push(m);
      if (index === selectedWall) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry),
          new THREE.LineBasicMaterial({color: COL.select, depthTest: false, transparent: true, opacity: 0.95}));
        edges.renderOrder = 6;
        m.add(edges);
      }
      const stroke = new THREE.Mesh(new THREE.PlaneGeometry(len, Math.max(0.1, thickness)),
        new THREE.MeshBasicMaterial({color: tint ? color.clone().multiplyScalar(0.8) : new THREE.Color(0x8e8472)}));
      stroke.rotation.x = -Math.PI / 2;
      stroke.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      stroke.position.copy(P((x0 + x1) / 2, (y0 + y1) / 2, WALL_H + 0.02));
      stroke.renderOrder = 4;
      stroke.userData = {planOnly: true};
      stroke.visible = this.mode === 'plan';
      root.add(stroke);
      if (state.view.wallLabels) {
        const ft = makeFloorText(`${w.name || 'wall ' + (index + 1)}  ${w.loss_db} dB`, x0, y0, x1, y1, 0.5);
        root.add(ft);
      }
    });

    // wall end handles for the selected wall
    const handles = [];
    if (selectedWall >= 0 && design.layout.walls[selectedWall]) {
      const w = design.layout.walls[selectedWall];
      for (const [which, p] of [['start', w.start], ['end', w.end]]) {
        const handle = new THREE.Mesh(new THREE.SphereGeometry(0.2 * markerScale, 16, 12),
          new THREE.MeshBasicMaterial({color: COL.handle, depthTest: false}));
        handle.position.copy(P(p[0], p[1], WALL_H + 0.05));
        handle.renderOrder = 13;
        handle.userData = {wall: selectedWall, end: which};
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, WALL_H, 6),
          new THREE.MeshBasicMaterial({color: COL.handle, transparent: true, opacity: 0.6, depthTest: false}));
        stem.position.copy(P(p[0], p[1], WALL_H / 2));
        stem.renderOrder = 12;
        root.add(handle, stem);
        handles.push(handle);
      }
    }

    // nodes
    const nodes = {};
    const pickables = [];
    for (const node of rf.mergeNodes(design.layout, design.mobility)) {
      const role = node.role;
      const kind = rf.kindClass(role, node.kind);
      const ap = node.kind === 'fronthaul_ap';
      const color = COL[kind];
      const grp = new THREE.Group();
      const h = ap ? AP_H : STA_H;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(ap ? 0.09 : 0.03, ap ? 0.09 : 0.03, h, 8),
        new THREE.MeshLambertMaterial({color}));
      post.position.y = h / 2; grp.add(post);
      const head = ap
        ? new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.7, 4), new THREE.MeshLambertMaterial({color}))
        : new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshLambertMaterial({color}));
      head.position.y = ap ? h + 0.35 : h;
      head.userData = {role};
      grp.add(head);
      // generous invisible pick target along the post
      const pickTarget = new THREE.Mesh(new THREE.CylinderGeometry(ap ? 0.5 : 0.35, ap ? 0.5 : 0.35, h + (ap ? 0.8 : 0.4), 8),
        new THREE.MeshBasicMaterial({visible: false}));
      pickTarget.position.y = (h + (ap ? 0.8 : 0.4)) / 2;
      pickTarget.userData = {role};
      grp.add(pickTarget);
      pickables.push(head, pickTarget);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), new THREE.MeshBasicMaterial({color, side: THREE.DoubleSide}));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005; ring.visible = false; grp.add(ring);
      const hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.58, 32),
        new THREE.MeshBasicMaterial({color, side: THREE.DoubleSide, transparent: true, opacity: 0.45}));
      hoverRing.rotation.x = -Math.PI / 2; hoverRing.position.y = 0.004; hoverRing.visible = false; grp.add(hoverRing);
      let tag = null;
      if (state.view.labels) {
        tag = makeSprite(ap ? rf.displayRole(role) : rf.shortRole(role), '#' + new THREE.Color(color).getHexString(), (ap ? 0.5 : 0.36) * labelScale);
        tag.position.y = ap ? h + 0.95 : h + 0.42;
        grp.add(tag);
      }
      let gauge = null;
      if (role !== 'gateway' && state.view.gauges) {
        gauge = makeSignalGauge();
        if (labelScale !== 1) gauge.group.scale.setScalar(0.7);
        gauge.group.position.x = ap ? 0.65 : 0.36;
        gauge.group.position.y = ap ? h - 0.45 : 0;
        if (ap) {
          gauge.label = makeSprite('RF —', '#80401f', 0.26);
          gauge.label.position.y = -0.13;
          gauge.group.add(gauge.label);
        }
        grp.add(gauge.group);
      }
      grp.scale.setScalar(markerScale);
      root.add(grp);
      nodes[role] = {grp, post, head, ring, hoverRing, tag, gauge, color, ap, h, kind};
    }

    const links = lineSegments(new THREE.LineDashedMaterial({vertexColors: true, dashSize: 0.34, gapSize: 0.22, transparent: true, opacity: 0.72}));
    const trails = lineSegments(new THREE.LineBasicMaterial({color: COL.mobile, transparent: true, opacity: 0.45}));
    const paths = lineSegments(new THREE.LineDashedMaterial({color: COL.path, dashSize: 0.35, gapSize: 0.16, transparent: true, opacity: 0.55, depthTest: false}), 8);
    const selectedPath = lineSegments(new THREE.LineDashedMaterial({color: COL.path, dashSize: 0.35, gapSize: 0.16, transparent: true, opacity: 0.95, depthTest: false}), 9);
    const backhaul = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.88, depthWrite: false}));
    backhaul.renderOrder = 2; backhaul.frustumCulled = false;
    const backhaulOccluded = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide,
      transparent: true, opacity: 0.88, depthWrite: false, depthFunc: THREE.GreaterDepth, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc}));
    backhaulOccluded.renderOrder = 3; backhaulOccluded.frustumCulled = false;
    const simBackhaul = backhaul.clone(); simBackhaul.material = backhaul.material.clone(); simBackhaul.geometry = new THREE.BufferGeometry();
    const simBackhaulOccluded = backhaulOccluded.clone(); simBackhaulOccluded.material = backhaulOccluded.material.clone(); simBackhaulOccluded.geometry = new THREE.BufferGeometry();
    root.add(links, trails, paths, selectedPath, backhaul, backhaulOccluded, simBackhaul, simBackhaulOccluded);

    const waypointGroup = new THREE.Group();
    root.add(waypointGroup);

    this.scene.add(root);
    this.world = {root, nodes, pickables, walls, handles, heat, links, trails, paths, selectedPath, backhaul, backhaulOccluded,
      simBackhaul, simBackhaulOccluded, waypointGroup, waypointPicks: [], waypointKey: null, W, H, markerScale, heatKey: null};
    if (this.autoFit) this.fit(false);
    this.requestRender();
  }

  // ---- per-frame update --------------------------------------------------------------
  update() {
    const design = state.design;
    const world = this.world;
    if (!design || !world) return;
    const overrides = state.preview && state.preview.positions;
    const scene = rf.sceneAt(design, state.timeMs, overrides);
    this.current = scene;
    const band = state.band;
    const best = rf.bestServing(scene, design.layout, band);
    const mesh = rf.meshPeers(scene, design.layout, band);
    const sel = state.selection;
    const selectedRole = sel && (sel.type === 'node' || sel.type === 'waypoint') ? sel.role : null;
    const hoverRole = state.hover && state.hover.role;

    for (const role in world.nodes) {
      const n = world.nodes[role];
      const entry = scene.byRole[role];
      if (!entry) { n.grp.visible = false; continue; }
      n.grp.visible = true;
      n.grp.position.copy(P(entry.position[0], entry.position[1], 0));
      const present = entry.present;
      const mat = n.head.material;
      if (!present) {
        mat.color.setHex(COL.absent); mat.transparent = true; mat.opacity = 0.35;
        n.post.material.color.setHex(COL.absent);
      } else {
        mat.color.setHex(n.color); mat.transparent = false; mat.opacity = 1;
        n.post.material.color.setHex(n.color);
      }
      if (n.tag) n.tag.material.opacity = present ? 1 : 0.4;
      n.ring.visible = role === selectedRole;
      n.hoverRing.visible = role === hoverRole && role !== selectedRole;
      if (n.gauge) {
        n.gauge.group.visible = n.ap || present;
        let level = 0, peerRole = null, label = 'RF —';
        if (n.ap) {
          if (entry.wired) label = 'wired';
          else if (mesh[role] && present) { level = rf.signal.snrLevel(mesh[role].snr); peerRole = mesh[role].role; label = 'RF ' + mesh[role].snr + ' dB'; }
        } else if (best[role]) { level = rf.signal.snrLevel(best[role].snr); peerRole = best[role].ap; }
        for (let i = 0; i < n.gauge.bars.length; i++) n.gauge.bars[i].material.color.set(rf.signal.segmentColor(i, level));
        if (n.gauge.label) setSpriteLabel(n.gauge.label, label, '#80401f');
        const peer = peerRole && scene.byRole[peerRole];
        n.gauge.group.position.x = (peer && peer.position[0] >= entry.position[0] ? -1 : 1) * (n.ap ? 0.65 : 0.36);
      }
    }

    // best serving links (viewer: dashed, coloured by SNR on the band)
    const lp = [], lc = [];
    if (state.view.links) {
      for (const sta in best) {
        const a = scene.byRole[best[sta].ap].position, b = scene.byRole[sta].position;
        const c = new THREE.Color(rf.signal.snrColor(best[sta].snr));
        lp.push(a[0], AP_H, -a[1], b[0], STA_H, -b[1]);   // viewer: unscaled heights
        lc.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    setSegments(world.links, lp, lc);

    // backhaul ribbons on the floor
    const bp = [], bc = [];
    const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present);   // wired APs have AP-to-AP links too
    if (state.view.backhaul === 'viewer') {
      for (let i = 0; i < aps.length; i++) {
        for (let j = i + 1; j < aps.length; j++) {
          const l = aps[i], r = aps[j];
          const parent = l.role === 'gateway' || r.role === 'gateway' ? 'gateway' : l.role;
          appendRibbon(bp, bc, l.position, r.position, parent);
        }
      }
    } else if (state.view.backhaul === 'tree') {
      for (const edge of rf.backhaulTree(scene, design.layout, '5')) {
        appendRibbon(bp, bc, scene.byRole[edge.parent].position, scene.byRole[edge.child].position, edge.parent,
          {width: edge.weak ? 0.05 : 0.11});
      }
    }
    setMesh(world.backhaul, bp, bc);
    setMesh(world.backhaulOccluded, bp, bc.map((v) => v * 0.7 + 0.3));
    const sp = [], sc = [];
    if (state.view.links) {
      for (const [role, peer] of Object.entries(mesh)) {
        appendDashedRibbon(sp, sc, scene.byRole[peer.role].position, scene.byRole[role].position, peer.role);
      }
    }
    setMesh(world.simBackhaul, sp, sc);
    setMesh(world.simBackhaulOccluded, sp, sc.map((v) => v * 0.7 + 0.3));

    // trails up to now and planned paths
    const tp = [], pp = [], spp = [];
    for (const node of scene.nodes) {
      const path = node.node.path;
      if (!path || path.length < 2) continue;
      const target = node.role === selectedRole ? spp : pp;
      if (state.view.paths || node.role === selectedRole) {
        for (let i = 1; i < path.length; i++) {
          target.push(path[i - 1].position[0], 0.03, -path[i - 1].position[1], path[i].position[0], 0.03, -path[i].position[1]);
        }
      }
      if (state.view.trails && node.kind === 'station') {
        const tick = Math.max(100, Number(design.mobility.tick_ms) || 1000);
        let prev = null;
        for (let t = 0; t <= state.timeMs; t += tick) {
          const q = rf.positionAtTime(node.node, t);
          if (prev && (prev[0] !== q[0] || prev[1] !== q[1])) tp.push(prev[0], 0.02, -prev[1], q[0], 0.02, -q[1]);
          prev = q;
        }
        if (prev) {
          const q = node.position;
          if (prev[0] !== q[0] || prev[1] !== q[1]) tp.push(prev[0], 0.02, -prev[1], q[0], 0.02, -q[1]);
        }
      }
    }
    setSegments(world.trails, tp);
    setSegments(world.paths, pp);
    setSegments(world.selectedPath, spp);
    this.updateWaypoints(design, selectedRole);
    this.updateHeatmap(design, scene);
    this.updateOverlays();
    this.requestRender();
  }

  updateWaypoints(design, selectedRole) {
    const world = this.world;
    const node = selectedRole ? rf.mergeNodes(design.layout, design.mobility).find((n) => n.role === selectedRole) : null;
    const path = node && node.path && node.path.length ? node.path : null;
    const sel = state.selection;
    const key = JSON.stringify([selectedRole, path, sel && sel.type === 'waypoint' ? sel.index : null, world.markerScale]);
    if (key === world.waypointKey) return;
    world.waypointKey = key;
    disposeTree(world.waypointGroup);
    world.waypointGroup.clear();
    world.waypointPicks = [];
    if (!path) return;
    path.forEach((w, index) => {
      const active = sel && sel.type === 'waypoint' && sel.index === index;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.36, 28),
        new THREE.MeshBasicMaterial({color: active ? COL.select : COL.path, side: THREE.DoubleSide, depthTest: false}));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(P(w.position[0], w.position[1], 0.03));
      ring.renderOrder = 9;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.4, 20), new THREE.MeshBasicMaterial({visible: false, side: THREE.DoubleSide}));
      disc.rotation.x = -Math.PI / 2;
      disc.position.copy(P(w.position[0], w.position[1], 0.05));
      disc.userData = {role: selectedRole, index};
      const label = makeSprite((w.time_ms / 1000).toFixed(w.time_ms % 1000 ? 1 : 0) + ' s', active ? '#d65f27' : '#6f3e8e', 0.3);
      label.position.copy(P(w.position[0], w.position[1], 0.45));
      label.renderOrder = 12;
      world.waypointGroup.add(ring, disc, label);
      world.waypointPicks.push(disc);
    });
  }

  updateHeatmap(design, scene) {
    const world = this.world;
    world.heat.visible = !!state.view.heatmap;
    if (!state.view.heatmap) return;
    const W = world.W, H = world.H;
    const dragging = !!(state.preview && (state.preview.positions || state.preview.walls));
    const target = dragging ? 7000 : 26000;
    const cell = Math.sqrt(W * H / target);
    const cols = Math.max(8, Math.min(512, Math.round(W / cell))), rows = Math.max(8, Math.min(512, Math.round(H / cell)));
    const aps = scene.nodes.filter((n) => n.kind === 'fronthaul_ap' && n.present).map((n) => [n.role, n.position, n.gain]);
    const key = JSON.stringify([state.band, state.view.heatStyle, cols, rows, aps, design.layout.walls, design.layout.propagation]);
    if (key === world.heatKey) return;
    world.heatKey = key;
    const grid = rf.coverageGrid(design.layout, scene, state.band, cols, rows);
    this.lastCoverage = grid;
    const canvas = document.createElement('canvas');
    canvas.width = cols; canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(cols, rows);
    const banded = state.view.heatStyle !== 'continuous';
    const parse = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const bandColors = {red: parse(rf.signal.colors.red), yellow: parse(rf.signal.colors.yellow), green: parse(rf.signal.colors.green)};
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = grid.values[j * cols + i];
        let rgb;
        if (banded) {
          const hex = rf.signal.snrColor(Math.round(v));
          rgb = hex === rf.signal.colors.green ? bandColors.green : hex === rf.signal.colors.yellow ? bandColors.yellow
            : hex === rf.signal.colors.red ? bandColors.red : [180, 180, 180];
        } else rgb = rf.heatColor(v);
        const k = ((rows - 1 - j) * cols + i) * 4;   // canvas row 0 is plan y = H
        image.data[k] = rgb[0]; image.data[k + 1] = rgb[1]; image.data[k + 2] = rgb[2]; image.data[k + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = banded ? THREE.NearestFilter : THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    if (world.heat.material.map) world.heat.material.map.dispose();
    world.heat.material.map = tex;
    world.heat.material.needsUpdate = true;
  }

  // ---- overlays: previews, ghosts, measure --------------------------------------------
  updateOverlays() {
    disposeTree(this.overlay);
    this.overlay.clear();
    const design = state.design;
    const scale = this.world ? this.world.markerScale : 1;
    const preview = state.preview || {};
    // wall drawing preview
    for (const seg of preview.ghostWalls || []) {
      const [x0, y0] = seg.start, [x1, y1] = seg.end;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.01) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.12),
        new THREE.MeshBasicMaterial({color: seg.color || 0x6f3e8e, transparent: true, opacity: 0.35, depthWrite: false}));
      m.position.copy(P((x0 + x1) / 2, (y0 + y1) / 2, WALL_H / 2));
      m.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      m.renderOrder = 5;
      this.overlay.add(m);
      if (seg.label) {
        const s = makeSprite(seg.label, '#6f3e8e', 0.34 * scale);
        s.position.copy(P((x0 + x1) / 2, (y0 + y1) / 2, WALL_H + 0.4));
        this.overlay.add(s);
      }
    }
    if (preview.snap) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 24),
        new THREE.MeshBasicMaterial({color: preview.snap.kind === 'end' ? 0xd65f27 : 0x6f3e8e, side: THREE.DoubleSide, depthTest: false}));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(P(preview.snap.point[0], preview.snap.point[1], 0.04));
      ring.renderOrder = 14;
      this.overlay.add(ring);
    }
    if (preview.measure) {
      const {a, b, label} = preview.measure;
      const line = lineSegments(new THREE.LineDashedMaterial({color: 0x087ea4, dashSize: 0.25, gapSize: 0.12, depthTest: false}), 14);
      setSegments(line, [a[0], 1.2, -a[1], b[0], 1.2, -b[1]]);
      const drops = lineSegments(new THREE.LineBasicMaterial({color: 0x087ea4, transparent: true, opacity: 0.6, depthTest: false}), 14);
      setSegments(drops, [a[0], 0, -a[1], a[0], 1.2, -a[1], b[0], 0, -b[1], b[0], 1.2, -b[1]]);
      this.overlay.add(line, drops);
      for (const p of [a, b]) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1 * scale, 12, 8), new THREE.MeshBasicMaterial({color: 0x087ea4, depthTest: false}));
        dot.position.copy(P(p[0], p[1], 1.2)); dot.renderOrder = 14;
        this.overlay.add(dot);
      }
      if (label) {
        const s = makeSprite(label, '#087ea4', 0.36 * scale);
        s.position.copy(P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1.75));
        this.overlay.add(s);
      }
    }
    if (preview.rect) {
      const {a, b} = preview.rect;
      const pts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
      for (let i = 0; i < 4; i++) {
        const p = pts[i], q = pts[(i + 1) % 4];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.01) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.12),
          new THREE.MeshBasicMaterial({color: 0x6f3e8e, transparent: true, opacity: 0.3, depthWrite: false}));
        m.position.copy(P((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, WALL_H / 2));
        m.rotation.y = -Math.atan2(q[1] - p[1], q[0] - p[0]);
        this.overlay.add(m);
      }
      const s = makeSprite(`${Math.abs(b[0] - a[0]).toFixed(2)} × ${Math.abs(b[1] - a[1]).toFixed(2)} m`, '#6f3e8e', 0.36 * scale);
      s.position.copy(P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, WALL_H + 0.5));
      this.overlay.add(s);
    }
    if (preview.cursor) {
      const ghost = preview.cursor;
      const ap = ghost.kind === 'fronthaul_ap';
      const body = ap ? new THREE.ConeGeometry(0.58, 0.88, 4) : new THREE.SphereGeometry(0.3, 16, 12);
      const m = new THREE.Mesh(body, new THREE.MeshBasicMaterial({color: ghost.color || COL.ghost, transparent: true, opacity: 0.45, wireframe: true, depthTest: false}));
      m.position.copy(P(ghost.point[0], ghost.point[1], (ap ? AP_H + 0.44 : STA_H) * scale));
      m.scale.setScalar(scale);
      m.renderOrder = 12;
      this.overlay.add(m);
      if (ghost.label) {
        const s = makeSprite(ghost.label, '#6f3e8e', 0.34 * scale);
        s.position.copy(P(ghost.point[0], ghost.point[1], (ap ? AP_H + 1.2 : STA_H + 0.6) * scale));
        this.overlay.add(s);
      }
    }
    // optimiser proposal ghosts
    if (state.placement && design) {
      for (const item of state.placement.placements || []) {
        const [x, y] = item.position;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.58, 0.88, 4),
          new THREE.MeshBasicMaterial({color: 0x6f3e8e, transparent: true, opacity: 0.55, wireframe: true, depthTest: false}));
        cone.position.copy(P(x, y, (AP_H + 0.44) * scale)); cone.scale.setScalar(scale); cone.renderOrder = 12;
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.52 * scale, 0.72 * scale, 32),
          new THREE.MeshBasicMaterial({color: 0x6f3e8e, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthTest: false}));
        ring.rotation.x = -Math.PI / 2; ring.position.copy(P(x, y, 0.03)); ring.renderOrder = 12;
        const s = makeSprite(rf.displayRole(item.role) + ' ?', '#6f3e8e', 0.4 * scale);
        s.position.copy(P(x, y, (AP_H + 1.25) * scale));
        this.overlay.add(cone, ring, s);
        if (item.backhaul_parent && state.current_scene_positions !== undefined) { /* drawn via links */ }
      }
      const pts = [];
      const byRole = Object.fromEntries((state.placement.placements || []).map((p) => [p.role, p.position]));
      for (const item of state.placement.placements || []) {
        const parent = byRole[item.backhaul_parent] || (this.current && this.current.byRole[item.backhaul_parent] && this.current.byRole[item.backhaul_parent].position);
        if (parent) pts.push(parent[0], 0.05, -parent[1], item.position[0], 0.05, -item.position[1]);
      }
      const bh = lineSegments(new THREE.LineDashedMaterial({color: 0x6f3e8e, dashSize: 0.4, gapSize: 0.2, depthTest: false}), 12);
      setSegments(bh, pts);
      this.overlay.add(bh);
    }
  }

  // ---- export helpers -------------------------------------------------------------------
  capture({width, height, transparent = false, background = '#f3efe6'} = {}) {
    const renderer = this.renderer;
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const ratio = renderer.getPixelRatio();
    const w = width || Math.round(size.x * ratio), h = height || Math.round(size.y * ratio);
    const cam = this.activeCamera;
    const saved = {aspect: this.camera.aspect};
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    if (cam === this.camera) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    else { const s = this.ortho; const halfH = (s.top - s.bottom) / 2; s.left = -halfH * w / h; s.right = halfH * w / h; s.updateProjectionMatrix(); }
    renderer.setClearColor(new THREE.Color(background), transparent ? 0 : 1);
    renderer.render(this.scene, cam);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h);
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size.x, size.y, false);
    this.camera.aspect = saved.aspect;
    this.camera.updateProjectionMatrix();
    this.placeCamera();
    this.render();
    return canvas;
  }

  // Meshes of the room for 3D export (no sprites, handles or overlays).
  exportGroup() {
    const group = new THREE.Group();
    if (!this.world) return group;
    this.world.root.traverse((o) => {
      if (!o.isMesh || !o.visible || o.material.visible === false) return;
      if (o.userData && (o.userData.end || o.userData.index !== undefined || o.userData.planOnly)) return;
      if (o.geometry.type === 'PlaneGeometry' && o.material.map) return;   // floor text / heatmap
      if (o.parent && o.parent.visible === false) return;
      const source = o.material;
      const material = new THREE.MeshStandardMaterial({color: source.color ? source.color.clone() : 0xffffff,
        roughness: 0.9, metalness: 0, transparent: !!source.transparent, opacity: source.opacity ?? 1, side: source.side});
      const copy = new THREE.Mesh(o.geometry.clone(), material);
      o.updateWorldMatrix(true, false);
      copy.applyMatrix4(o.matrixWorld);
      copy.name = o.userData && o.userData.role ? o.userData.role : o.userData && o.userData.wall !== undefined ? 'wall-' + o.userData.wall : o.name;
      group.add(copy);
    });
    return group;
  }
}

function appendRibbon(points, colors, start, end, parentRole, {width = 0.09, offset = 0} = {}) {
  const deltaX = end[0] - start[0], deltaZ = start[1] - end[1];
  const length = Math.hypot(deltaX, deltaZ);
  if (!Number.isFinite(length) || length < 0.0001) return;
  const offsetX = -deltaZ / length * width / 2, offsetZ = deltaX / length * width / 2;
  const centerX = -deltaZ / length * offset, centerZ = deltaX / length * offset;
  const corners = [
    [start[0] + centerX + offsetX, 0.035, -start[1] + centerZ + offsetZ],
    [start[0] + centerX - offsetX, 0.035, -start[1] + centerZ - offsetZ],
    [end[0] + centerX + offsetX, 0.035, -end[1] + centerZ + offsetZ],
    [end[0] + centerX - offsetX, 0.035, -end[1] + centerZ - offsetZ],
  ];
  const color = new THREE.Color(parentRole === 'gateway' ? COL.gateway : COL.extender);
  for (const index of [0, 1, 2, 2, 1, 3]) {
    points.push(...corners[index]);
    colors.push(color.r, color.g, color.b);
  }
}

function appendDashedRibbon(points, colors, start, end, parentRole) {
  const deltaX = end[0] - start[0], deltaY = end[1] - start[1];
  const length = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(length) || length < 0.0001) return;
  for (let distance = 0; distance < length; distance += 0.54) {
    const finish = Math.min(length, distance + 0.32);
    const first = [start[0] + deltaX * distance / length, start[1] + deltaY * distance / length];
    const last = [start[0] + deltaX * finish / length, start[1] + deltaY * finish / length];
    appendRibbon(points, colors, first, last, parentRole, {width: 0.026, offset: 0.14});
  }
}

function setMesh(mesh, points, colors) {
  mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  mesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  mesh.geometry.computeBoundingSphere();
}
