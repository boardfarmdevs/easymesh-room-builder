// Tiny DOM helpers used by the panels and dialogs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

// A labelled input that commits on change. onCommit may throw to reject a value.
export function field({label, tip, tipKey, type = 'number', value, min, max, step, options, placeholder, onCommit, unit, rows, id, disabled}) {
  let input;
  if (type === 'select') {
    input = h('select', {id, disabled},
      options.map((o) => h('option', {value: o.value, selected: String(o.value) === String(value) ? true : null}, o.label)));
  } else if (type === 'textarea') {
    input = h('textarea', {id, rows: rows || 3, placeholder, disabled});
    input.value = value ?? '';
  } else if (type === 'checkbox') {
    input = h('input', {type: 'checkbox', id, disabled});
    input.checked = !!value;
    const wrap = h('label', {class: 'check', 'data-tip': tip, 'data-tip-key': tipKey}, input, ' ', label);
    input.addEventListener('change', () => commit(input.checked));
    function commit(v) { try { onCommit(v); } catch (error) { input.checked = !v; report(error); } }
    return wrap;
  } else {
    input = h('input', {type, id, min, max, step: step ?? (type === 'number' ? 'any' : null), placeholder, disabled});
    input.value = value ?? '';
  }
  const commit = () => {
    let v = input.value;
    if (type === 'number') {
      if (v.trim() === '') { input.classList.add('invalid'); return; }
      v = Number(v);
      if (!Number.isFinite(v)) { input.classList.add('invalid'); return; }
    }
    try {
      onCommit(v);
      input.classList.remove('invalid');
    } catch (error) {
      input.classList.add('invalid');
      report(error);
    }
  };
  input.addEventListener('change', commit);
  if (type === 'number' || type === 'text') {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  }
  const text = unit ? `${label} (${unit})` : label;
  return h('div', {class: 'fld'},
    h('label', {class: 'field', for: id, 'data-tip': tip, 'data-tip-key': tipKey}, text), input);
}

let reporter = (error) => console.error(error);
export function setReporter(fn) { reporter = fn; }
export function report(error) { reporter(error); }

export function segmented(options, value, onPick, {small = false, tip} = {}) {
  const seg = h('span', {class: 'seg' + (small ? ' small' : ''), role: 'group', 'data-tip': tip});
  for (const o of options) {
    seg.append(h('button', {type: 'button', 'aria-pressed': String(String(o.value) === String(value)), 'data-tip': o.tip,
      onclick: () => onPick(o.value)}, o.label));
  }
  return seg;
}

export function confirmDialog(message) {
  return window.confirm(message);
}

// replaceChildren that accepts nested arrays and skips null/false like h().
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}
