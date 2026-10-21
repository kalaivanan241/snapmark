// Shared helpers for every Snapmark window. Loaded as a classic script before the page script.

const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const listen = TAURI.event.listen;
const appWindow = TAURI.window.getCurrentWindow();

window.addEventListener('error', (e) => invoke('js_log', { message: `${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {}));
window.addEventListener('unhandledrejection', (e) => invoke('js_log', { message: `unhandled: ${e.reason}` }).catch(() => {}));

// Icon paths from the design, drawn on a 24-unit grid.
const ICON_PATHS = {
  area: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>',
  logo: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="m9 15 6-6"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  full: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  picker: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/>',
  then: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3.5 3.5V15h-11v-2.5L10 9z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>',
  save: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  reveal: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  select: '<path d="M5 3.5 19 10l-6.5 2L10 18.5z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
  line: '<path d="M5 19 19 5"/>',
  rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  step: '<circle cx="12" cy="12" r="9"/><path d="M10.5 9.5 12.5 8v8"/>',
  blur: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  spot: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4.5"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6M8 11h6"/>',
  eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  recapture: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/>',
  duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>',
  front: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 16 9 5 9-5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  power: '<path d="M12 3v8"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  shield: '<path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z"/><path d="M12 9v4M12 16h.01"/>',
};

function icon(name, size = 18, stroke = 1.75) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" stroke-width="${stroke}" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

// "ctrl+shift+4" → "⌃⇧4"
function hotkeyLabel(accel) {
  if (!accel) return '';
  const sym = { ctrl: '⌃', control: '⌃', shift: '⇧', alt: '⌥', option: '⌥', cmd: '⌘', command: '⌘', super: '⌘', meta: '⌘', cmdorctrl: '⌘', commandorcontrol: '⌘' };
  const order = ['⌃', '⌥', '⇧', '⌘'];
  const mods = [];
  let key = '';
  for (const part of accel.split('+').map((p) => p.trim().toLowerCase())) {
    if (sym[part]) mods.push(sym[part]);
    else key = part.replace(/^key/, '').replace(/^digit/, '').toUpperCase();
  }
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.join('') + key;
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function pngBlob(buf) {
  return new Blob([buf], { type: 'image/png' });
}

async function captureObjectURL(id) {
  return URL.createObjectURL(pngBlob(await invoke('capture_image', { id })));
}

function $(sel, root = document) {
  return root.querySelector(sel);
}
