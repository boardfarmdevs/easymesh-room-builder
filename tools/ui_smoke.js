#!/usr/bin/env node
// Browser smoke test of the room builder UI.
//
//   npm install playwright-core          (once, anywhere on NODE_PATH or in tools/)
//   xvfb-run -a node tools/ui_smoke.js   (WebGL needs a display; Xvfb works)
//
// Starts `python3 -m roombuilder serve --port 0` on a temporary design store
// (or, with SITE_URL=http://host:port/, tests an already served static site
// build from `room-builder build-site`), drives the real UI through the main
// workflows and checks the resulting design after each step. Set CHROMIUM=/path/to/chrome to choose a browser;
// by default the Playwright cache is searched. SHOTS=dir saves screenshots.

'use strict';
const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({chromium} = require('playwright-core')); } catch (_e) {
  try { ({chromium} = require(path.join(__dirname, 'node_modules', 'playwright-core'))); } catch (_e2) {
    console.error('playwright-core is not installed: npm install playwright-core'); process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).sort().reverse()) {
    const candidate = path.join(cache, dir, 'chrome-linux64', 'chrome');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-m', 'roombuilder', 'serve', '--port', '0', '--data', dataDir, '--quiet'], {cwd: ROOT});
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/on (http:\/\/[^/]+\/)/);
      if (match) resolve({child, url: match[1]});
    });
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + buffer)));
  });
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); } catch (error) {
    results.push(['FAIL', name, error.message]); console.log('FAIL', name, '—', error.message);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roombuilder-ui-'));
  const {child, url} = process.env.SITE_URL ? {child: null, url: process.env.SITE_URL} : await startServer(dataDir);
  const shots = process.env.SHOTS;
  const browser = await chromium.launch({headless: false, executablePath: findChromium(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']});
  const context = await browser.newContext({viewport: {width: 1500, height: 900}, acceptDownloads: true});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('roombuilder.welcomed', '1'); } catch (_e) { /* */ } });
  const shot = async (name) => { if (shots) await page.screenshot({path: path.join(shots, name + '.png')}); };
  const design = () => page.evaluate(() => window.roomBuilder.state.design);
  const floor = (x, y) => page.evaluate(([x, y]) => {
    const {room} = window.roomBuilder; const v = new THREE.Vector3(x, 0, -y); v.project(room.activeCamera);
    const r = room.renderer.domElement.getBoundingClientRect();
    return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height};
  }, [x, y]);
  const head = (role) => page.evaluate((role) => {
    const {room} = window.roomBuilder; const n = room.world.nodes[role];
    const v = new THREE.Vector3(); n.head.getWorldPosition(v); v.project(room.activeCamera);
    const r = room.renderer.domElement.getBoundingClientRect();
    return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height};
  }, role);

  try {
    await check('loads the default room', async () => {
      await page.goto(url + '?room=home-a-slow-walk-ten');
      await page.waitForFunction(() => window.roomBuilder && window.roomBuilder.room.world, null, {timeout: 120000});
      const d = await design();
      assert(d.id === 'home-a-slow-walk-ten', 'wrong room ' + d.id);
      await page.waitForFunction(() => window.roomBuilder.state.lint, null, {timeout: 60000});
      await shot('01-loaded');
    });
    await check('camera drags rotate by exactly the pointer step in every direction', async () => {
      const cam = () => page.evaluate(() => { const o = window.roomBuilder.room.orbit; return {t: o.theta, p: o.phi}; });
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, -1], [-1, 1], [1, 1]];
      let x = 520, y = 160, worst = 0;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let k = 0; k < 42; k++) {
        const [dx, dy] = dirs[Math.floor(k / 6)];
        const before = await cam();
        x += dx * 3; y += dy * 3;
        await page.mouse.move(x, y);
        const after = await cam();
        worst = Math.max(worst, Math.abs(after.t - (before.t - dx * 3 * 0.006)),
          Math.abs(after.p - Math.min(1.45, Math.max(0.15, before.p - dy * 3 * 0.006))));
      }
      await page.mouse.up();
      assert(worst < 1e-9, `orbit jumped by up to ${worst} rad in one pointer event`);
      await page.evaluate(() => window.roomBuilder.room.fit());
    });
    await check('selecting a device opens the properties panel', async () => {
      const p = await head('extender_2');
      await page.mouse.click(p.x, p.y);
      await page.waitForSelector('#propsHud:not([hidden])');
      assert((await page.textContent('#propsHud')).includes('Extender-2'), 'panel does not name Extender-2');
    });
    await check('heatmap and plan view', async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('h');
      await page.keyboard.press('t');
      await page.waitForTimeout(400);
      const ok = await page.evaluate(() => window.roomBuilder.room.mode === 'plan' && window.roomBuilder.room.world.heat.visible);
      assert(ok, 'plan/heatmap not active');
      await shot('02-plan-heat');
      await page.keyboard.press('h');
    });
    await check('draws two walls with snapping', async () => {
      const walls = (await design()).layout.walls.length;
      await page.keyboard.press('w');
      for (const [x, y] of [[2, 4], [5, 4], [5, 1.5]]) { const p = await floor(x, y); await page.mouse.move(p.x, p.y, {steps: 3}); await page.mouse.click(p.x, p.y); }
      await page.keyboard.press('Escape');
      const d = await design();
      assert(d.layout.walls.length === walls + 2, 'expected two new walls');
      const last = d.layout.walls.slice(-2).map((w) => [w.start, w.end]);
      assert(JSON.stringify(last) === JSON.stringify([[[2, 4], [5, 4]], [[5, 4], [5, 1.5]]]), 'wall ends not snapped: ' + JSON.stringify(last));
    });
    await check('cuts a door gap', async () => {
      await page.keyboard.press('d');
      const p = await floor(3.5, 4);
      await page.mouse.move(p.x, p.y, {steps: 2});
      await page.mouse.click(p.x, p.y);
      const names = (await design()).layout.walls.map((w) => w.name);
      assert(names.some((n) => /-a$/.test(n)) && names.some((n) => /-b$/.test(n)), 'wall was not split around a door');
    });
    await check('draws a path for a new mobile client', async () => {
      await page.keyboard.press('p');
      for (const [x, y] of [[3, 6], [8, 6], [8, 11]]) { const p = await floor(x, y); await page.mouse.move(p.x, p.y, {steps: 3}); await page.mouse.click(p.x, p.y); }
      await page.keyboard.press('Enter');
      const d = await design();
      const node = d.mobility.nodes[d.mobility.nodes.length - 1];
      assert(node.path && node.path.length === 3, 'expected 3 waypoints, got ' + JSON.stringify(node));
      assert(node.path[0].time_ms === 0 && node.path[2].time_ms > node.path[1].time_ms, 'waypoint times not increasing');
    });
    await check('undo and redo', async () => {
      await page.keyboard.press('Escape');
      const before = JSON.stringify(await design());
      await page.keyboard.press('Control+z');
      const undone = JSON.stringify(await design());
      await page.keyboard.press('Control+Shift+z');
      assert(undone !== before && JSON.stringify(await design()) === before, 'undo/redo did not round-trip');
    });
    await check('dragging a walker at a later time adds a keyframe', async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('3');
      await page.evaluate(() => window.roomBuilder.setTime(40000));
      await page.waitForTimeout(300);
      const p = await head('sta_mobile_05');
      await page.mouse.click(p.x, p.y);
      await page.mouse.move(p.x, p.y); await page.mouse.down();
      await page.mouse.move(p.x + 40, p.y - 60, {steps: 8}); await page.mouse.up();
      const d = await design();
      const walker = d.mobility.nodes.find((n) => n.role === 'sta_mobile_05');
      assert(walker.path.some((w) => w.time_ms === 40000), 'no waypoint at 40 s: ' + JSON.stringify(walker.path));
      await shot('03-keyframe');
    });
    await check('optimiser proposes and applies extenders', async () => {
      await page.evaluate(() => window.roomBuilder.setTime(0));
      await page.click('#tabs button[data-tab=devices]');
      await page.click('#btnOptimize');
      await page.waitForFunction(() => window.roomBuilder.state.placement && window.roomBuilder.state.placement.placements, null, {timeout: 60000});
      await shot('04-optimiser');
      await page.click('#btnApplyPlacement');
      assert(!(await page.evaluate(() => window.roomBuilder.state.placement)), 'proposal not cleared');
    });
    await check('lints and verifies', async () => {
      await page.click('#tabs button[data-tab=check]');
      await page.waitForTimeout(800);
      await page.click('text=Run verification');
      await page.waitForFunction(() => window.roomBuilder.state.verification && window.roomBuilder.state.verification.checks, null, {timeout: 60000});
      const v = await page.evaluate(() => window.roomBuilder.state.verification);
      assert(v.passed, 'verification failed: ' + JSON.stringify(v.checks.filter((c) => c.status === 'fail')));
      await shot('05-check');
    });
    await check('exports a lab bundle and an SVG plan', async () => {
      await page.keyboard.press('Control+e');
      const [bundle] = await Promise.all([page.waitForEvent('download'), page.click('text=Lab bundle (.zip)')]);
      assert(/bundle\.zip$/.test(bundle.suggestedFilename()), 'bundle name ' + bundle.suggestedFilename());
      const [svg] = await Promise.all([page.waitForEvent('download'), page.click('text=SVG floor plan')]);
      const file = await svg.path();
      assert(fs.readFileSync(file, 'utf8').startsWith('<svg'), 'SVG export is not SVG');
      await page.click('dialog header button');
    });
    await check('saves, and reopens from the store', async () => {
      await page.keyboard.press('Control+s');
      await page.fill('dialog input[type=text]', 'Smoke test room');
      await page.click('dialog footer button.primary');
      await page.waitForFunction(() => window.roomBuilder.state.origin.kind === 'store', null, {timeout: 10000});
      await page.keyboard.press('Control+o');
      await page.waitForSelector('dialog nav button');
      assert((await page.textContent('dialog nav')).includes('Smoke test room'), 'saved design not listed');
      await page.click('dialog header button');
    });
    await check('library room opens', async () => {
      await page.click('#btnLibrary');
      await page.fill('dialog input[type=search]', 'warehouse');
      await page.click('dialog nav button');
      page.once('dialog', (d) => d.accept());
      await page.click('dialog footer button.primary');
      await page.waitForFunction(() => window.roomBuilder.state.design.id === 'warehouse-racks', null, {timeout: 10000});
      await shot('06-warehouse');
    });
    await check('no page errors', async () => { assert(!errors.length, errors.join('\n')); });
  } finally {
    await browser.close();
    if (child) child.kill();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
