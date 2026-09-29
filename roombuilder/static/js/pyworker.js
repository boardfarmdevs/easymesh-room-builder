// Runs the room builder's Python API (roombuilder.webapi) in the browser for
// the static site build. Designs are kept in IndexedDB via Pyodide's IDBFS.

// Each start-up step names itself in errors, so a blocked or altered file is identifiable.
async function step(label, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${label}: ${(error && error.message) || error}`);
  }
}

async function download(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

// A web filter that blocks or replaces a file makes Pyodide hang instead of fail,
// so check the first bytes of each binary first (a block page is HTML, not wasm/zip).
async function checkStart(path, magic) {
  const response = await fetch(new URL(path, import.meta.url), {headers: {Range: `bytes=0-${magic.length - 1}`}});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const head = new Uint8Array(await response.arrayBuffer());
  if (!magic.every((byte, i) => head[i] === byte)) {
    throw new Error(`the file was replaced by other content (${response.headers.get('Content-Type') || 'unknown type'})`);
  }
}

function withinMinutes(minutes, promise) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(
    () => reject(new Error(`no result after ${minutes} minutes`)), minutes * 60000))]);
}

const WASM = [0x00, 0x61, 0x73, 0x6d], ZIP = [0x50, 0x4b, 0x03, 0x04];

const ready = (async () => {
  self.postMessage({progress: 'Starting the room builder engine… (the first visit downloads about 14 MB)'});
  await step('checking pyodide/pyodide.asm.wasm', () => checkStart('../pyodide/pyodide.asm.wasm', WASM));
  await step('checking pyodide/python_stdlib.zip', () => checkStart('../pyodide/python_stdlib.zip', ZIP));
  await step('checking py/roombuilder.zip', () => checkStart('../py/roombuilder.zip', ZIP));
  const {loadPyodide} = await step('loading pyodide/pyodide.mjs', () => import('../pyodide/pyodide.mjs'));
  const py = await step('starting the Python runtime (pyodide/pyodide.asm.wasm, python_stdlib.zip)',
    () => withinMinutes(4, loadPyodide({indexURL: new URL('../pyodide/', import.meta.url).href})));
  const zip = await step('downloading the builder (py/roombuilder.zip)', () => download('../py/roombuilder.zip'));
  py.unpackArchive(zip, 'zip', {extractDir: '/app'});
  py.FS.mkdirTree('/designs');
  let storage = 'browser';   // IndexedDB; 'memory' when the browser blocks it (designs last for this page only)
  try {
    py.FS.mount(py.FS.filesystems.IDBFS, {}, '/designs');
    await new Promise((resolve, reject) => py.FS.syncfs(true, (error) => (error ? reject(error) : resolve())));
  } catch (_error) {
    storage = 'memory';
  }
  persist = storage === 'browser';
  py.globals.set('STORAGE', storage);
  py.runPython(`
import sys
sys.path.insert(0, "/app")
from js import Object
from pyodide.ffi import to_js
from roombuilder.webapi import WebApi
api = WebApi("/designs", storage=STORAGE)

def handle(method, path, body):
    r = api.handle(method, path, body)
    return to_js({"status": r.status, "body": r.body,
                  "headers": {"Content-Type": r.content_type, **r.headers}}, dict_converter=Object.fromEntries)
`);
  self.postMessage({progress: null});
  return {py, handle: py.globals.get('handle')};
})();

let persist = false;
let queue = Promise.resolve();   // one request at a time, in order
self.onmessage = ({data}) => { queue = queue.then(() => serve(data)); };

async function serve({id, method, path, body}) {
  try {
    const {py, handle} = await ready;
    const result = handle(method, path, body);
    const reply = {id, status: result.status, headers: result.headers, body: result.body};
    if (persist && method !== 'GET' && path.startsWith('/api/designs')) await new Promise((resolve) => py.FS.syncfs(false, resolve));
    self.postMessage(reply, [reply.body.buffer]);
  } catch (error) {
    self.postMessage({id, error: String((error && error.message) || error)});
  }
}
