// Where API calls go. Normally to the Python server (fetch). On the static
// site build (meta roombuilder-backend = pyodide) the same Python API runs in
// the browser, in a worker (pyworker.js). Either way callers get a Response.

const mode = (document.querySelector('meta[name="roombuilder-backend"]') || {}).content || 'server';
const pending = new Map();
let worker = null;
let nextId = 0;

function status(text) {
  const el = document.getElementById('engineStatus');
  if (el) { el.hidden = !text; el.textContent = text || ''; }
}

function startWorker() {
  worker = new Worker(new URL('./pyworker.js', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    if ('progress' in data) { status(data.progress); return; }
    const call = pending.get(data.id);
    pending.delete(data.id);
    if (!call) return;
    if (data.error) { status(null); call.reject(new Error(data.error)); }
    else call.resolve(new Response(data.body, {status: data.status, headers: data.headers}));
  };
  worker.onerror = (event) => {
    status('The in-browser engine failed to start: ' + (event.message || 'unknown error'));
    for (const call of pending.values()) call.reject(new Error('The in-browser engine failed to start'));
    pending.clear();
  };
}

export const engineMode = mode;

export function transport(method, path, body) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  if (mode !== 'pyodide') {
    return fetch(path, {method, headers: json === undefined ? {} : {'Content-Type': 'application/json'}, body: json});
  }
  if (typeof WebAssembly !== 'object') {
    // Hardened browsers (Edge enhanced security, JIT-blocking policies) remove WebAssembly.
    return Promise.reject(Object.assign(new Error('WebAssembly is switched off in this browser'), {code: 'no-wasm'}));
  }
  if (!worker) startWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({id, method, path, body: json === undefined ? null : json});
  });
}
