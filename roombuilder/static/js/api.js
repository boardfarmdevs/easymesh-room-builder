// Thin client for the room builder's JSON API.

import {transport} from './backend.js';

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(method, path, body) {
  const response = await transport(method, '/api/' + path, body);
  const type = response.headers.get('Content-Type') || '';
  if (!response.ok) {
    let message = response.statusText;
    if (type.includes('json')) { const data = await response.json(); message = data.error || message; throw new ApiError(message, response.status, data.code); }
    throw new ApiError(message, response.status, 'http');
  }
  if (type.includes('application/json') && !response.headers.get('Content-Disposition')) return response.json();
  return response;
}

export const api = {
  meta: () => request('GET', 'meta'),
  library: () => request('GET', 'library'),
  libraryRoom: (id) => request('GET', 'library/' + encodeURIComponent(id)),
  designs: () => request('GET', 'designs'),
  design: (id) => request('GET', 'designs/' + encodeURIComponent(id)),
  create: (design) => request('POST', 'designs', {design}),
  save: (design, baseRevision) => request('PUT', 'designs/' + encodeURIComponent(design.id), {design, base_revision: baseRevision}),
  remove: (id) => request('DELETE', 'designs/' + encodeURIComponent(id)),
  duplicate: (id, title) => request('POST', `designs/${encodeURIComponent(id)}/duplicate`, {title}),
  history: (id) => request('GET', `designs/${encodeURIComponent(id)}/history`),
  revision: (id, rev) => request('GET', `designs/${encodeURIComponent(id)}/history/${rev}`),
  restore: (id, revision) => request('POST', `designs/${encodeURIComponent(id)}/restore`, {revision}),
  newDesign: (options) => request('POST', 'new', options),
  lint: (design, band) => request('POST', 'lint', {design, band}),
  compile: (design) => request('POST', 'compile', {design}),
  verify: (design, band) => request('POST', 'verify', {design, band}),
  place: (design, options) => request('POST', 'place', Object.assign({design}, options)),
  coverage: (design, options) => request('POST', 'coverage', Object.assign({design}, options)),
  importDocuments: (documents, base) => request('POST', 'import', {documents, base}),
  // Returns {blob, filename}
  async exportFile(kind, design, options = {}) {
    const response = await request('POST', 'export/' + kind, Object.assign({design}, options));
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    return {blob: await response.blob(), filename: match ? match[1] : kind};
  },
};

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
