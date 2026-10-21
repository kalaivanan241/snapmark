// Capture overlay: a frozen image of the display with area / window / full-screen / colour picking.
// All geometry here is in display points (CSS px == points, since the window covers the display).

const MODES = [
  ['area', 'Area', 'area', 'A'],
  ['window', 'Window', 'window', 'W'],
  ['full', 'Full screen', 'full', 'F'],
  ['color', 'Pick color', 'picker', 'P'],
];
const TIMERS = [0, 3, 5, 10];
const AFTERS = [['card', 'Show card'], ['editor', 'Open editor'], ['save', 'Save to folder'], ['pin', 'Pin to screen']];
const HINTS = {
  area: 'Drag to select · Click a window to snap to it · Space to move · ⇧ to lock ratio · ↵ to capture · Esc to cancel',
  window: 'Hover to pick a window · Click to capture · Esc to cancel',
  full: 'Click anywhere or press ↵ to capture this display · Esc to cancel',
  color: 'Click to copy the color as hex · Arrow keys nudge · Esc to cancel',
};
const RATIOS = [[16, 9], [16, 10], [4, 3], [3, 2], [1, 1], [21, 9], [9, 16], [3, 4], [2, 3], [10, 16]];
const HANDLE_HIT = 10;
const MIN_DRAG = 4;

const stage = $('#stage');
const shot = $('#shot');
const focusEl = $('#focus');
const dim = $('#dim');
const badge = $('#badge');
const loupe = $('#loupe');
const loupeCtx = $('#loupe canvas').getContext('2d');
const hud = $('#hud');

let session = null;   // SessionInfo from Rust
let token = null;
let mode = 'area';
let sel = null;       // {x, y, w, h}
let drag = null;
let hoverWin = null;
let cursor = { x: -1, y: -1 };
let spaceDown = false;
let shiftDown = false;
let timerIdx = 0;
let afterIdx = 0;
let bitmap = null;
let sampler = null;   // 2D context holding the full-resolution pixels
let objectURL = null;
let scale = 2;        // image pixels per point
const LABEL = appWindow.label; // one overlay window per display

// Keep the overlays on every display in step (mode, timer, "then", single selection).
function broadcast(change) {
  TAURI.event.emit('overlay:sync', { from: LABEL, ...change }).catch(() => {});
}

// ---- HUD -------------------------------------------------------------------------------

function buildHud() {
  $('#modes').innerHTML = MODES.map(([key, label, ic, k]) =>
    `<button type="button" class="mode" data-mode="${key}" title="${label} (${k})">${icon(ic, 20)}<span>${label}</span></button>`).join('');
  $('#cancel').innerHTML = icon('close', 18, 2);
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => { setMode(b.dataset.mode); broadcast({ mode }); });
  $('#timer').addEventListener('click', () => { timerIdx = (timerIdx + 1) % TIMERS.length; savePrefs(); renderHud(); broadcast({ timerIdx }); });
  $('#after').addEventListener('click', () => { afterIdx = (afterIdx + 1) % AFTERS.length; savePrefs(); renderHud(); broadcast({ afterIdx }); });
  $('#go').addEventListener('click', commit);
  $('#cancel').addEventListener('click', cancel);
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) hud.addEventListener(ev, (e) => e.stopPropagation());
  hud.addEventListener('pointerenter', () => { loupe.style.display = 'none'; });
}

function renderHud() {
  for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  const t = TIMERS[timerIdx];
  $('#timer').innerHTML = `${icon('timer', 18)}<span class="lbl"><small>Timer</small><b>${t ? `${t} s` : 'Off'}</b></span>`;
  $('#after').innerHTML = `${icon('then', 18)}<span class="lbl"><small>Then</small><b>${AFTERS[afterIdx][1]}</b></span>`;
  $('#go').style.display = mode === 'color' ? 'none' : '';
  $('#hint').textContent = HINTS[mode];
}

function savePrefs() {
  invoke('set_capture_prefs', { timer: TIMERS[timerIdx], after: AFTERS[afterIdx][0] }).catch(() => {});
}

function setMode(m) {
  if (!MODES.some(([k]) => k === m)) return;
  mode = m;
  drag = null;
  if (m !== 'area') sel = null;
  hoverWin = m === 'window' ? windowAt(cursor.x, cursor.y) : null;
  stage.className = `mode-${m}`;
  renderHud();
  render();
}

// ---- Session lifecycle -----------------------------------------------------------------

async function begin() {
  const info = await invoke('overlay_session');
  if (!info || info.token === token) return;
  token = info.token;
  session = info;
  scale = info.width / info.wPts;
  sel = null;
  drag = null;
  hoverWin = null;
  timerIdx = Math.max(0, TIMERS.indexOf(info.timer));
  afterIdx = Math.max(0, AFTERS.findIndex(([k]) => k === info.after));

  const blob = pngBlob(await invoke('overlay_image'));
  bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  sampler = c.getContext('2d', { willReadFrequently: true });
  sampler.drawImage(bitmap, 0, 0);
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = URL.createObjectURL(blob);
  shot.src = objectURL;
  await shot.decode().catch(() => {});

  setMode(info.mode);
  await invoke('overlay_present', { token });
}

function teardown() {
  session = null;
  sel = null;
  drag = null;
  hoverWin = null;
  focusEl.style.display = 'none';
  badge.style.display = 'none';
  loupe.style.display = 'none';
  shot.removeAttribute('src');
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  bitmap = null;
  sampler = null;
}

function cancel() {
  if (!session) return;
  teardown();
  invoke('overlay_cancel');
}

function commit() {
  if (!session) return;
  const args = { mode, timer: TIMERS[timerIdx], after: AFTERS[afterIdx][0], rect: null, windowId: null };
  if (mode === 'color') return;
  if (mode === 'area') {
    if (sel && sel.w >= 2 && sel.h >= 2) args.rect = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    else args.mode = 'full';
  }
  if (mode === 'window') {
    if (!hoverWin) return;
    args.windowId = hoverWin.id;
  }
  teardown();
  invoke('overlay_commit', { args }).catch((e) => console.error(e));
}

function pickColor() {
  const px = pixelAt(cursor.x, cursor.y);
  if (!px) return;
  teardown();
  invoke('overlay_pick_color', { hex: px.hex });
}

// ---- Geometry helpers --------------------------------------------------------------------

function clampRect(r) {
  const W = session.wPts, H = session.hPts;
  const x = Math.max(0, Math.min(r.x, W)), y = Math.max(0, Math.min(r.y, H));
  return { x, y, w: Math.max(0, Math.min(r.x + r.w, W) - x), h: Math.max(0, Math.min(r.y + r.h, H) - y) };
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function windowAt(x, y) {
  if (!session) return null;
  return session.windows.find((w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) || null;
}

function handleAt(x, y) {
  if (!sel) return null;
  const { x: l, y: t, w, h } = sel;
  const r = l + w, b = t + h, cx = l + w / 2, cy = t + h / 2;
  const pts = { nw: [l, t], ne: [r, t], sw: [l, b], se: [r, b], n: [cx, t], s: [cx, b], w: [l, cy], e: [r, cy] };
  for (const [name, [hx, hy]] of Object.entries(pts)) {
    if (Math.abs(x - hx) <= HANDLE_HIT && Math.abs(y - hy) <= HANDLE_HIT) return name;
  }
  // Grab the edges anywhere along their length too.
  const inY = y > t && y < b, inX = x > l && x < r;
  if (inY && Math.abs(x - l) <= 5) return 'w';
  if (inY && Math.abs(x - r) <= 5) return 'e';
  if (inX && Math.abs(y - t) <= 5) return 'n';
  if (inX && Math.abs(y - b) <= 5) return 's';
  return null;
}

function inside(r, x, y) {
  return r && x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
}

function pixelAt(x, y) {
  if (!sampler) return null;
  const px = Math.min(bitmap.width - 1, Math.max(0, Math.floor(x * scale)));
  const py = Math.min(bitmap.height - 1, Math.max(0, Math.floor(y * scale)));
  const [r, g, b] = sampler.getImageData(px, py, 1, 1).data;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { px, py, hex };
}

function ratioLabel(w, h) {
  if (!w || !h) return '';
  for (const [a, b] of RATIOS) if (Math.abs(w / h - a / b) < 0.01) return `${a}:${b}`;
  return '';
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

// ---- Pointer & keyboard -------------------------------------------------------------------

stage.addEventListener('pointerdown', (e) => {
  if (!session || e.button !== 0) return;
  const p = { x: e.clientX, y: e.clientY };
  if (mode === 'color') return pickColor();
  if (mode === 'full') return commit();
  if (mode === 'window') {
    hoverWin = windowAt(p.x, p.y);
    return commit();
  }
  stage.setPointerCapture(e.pointerId);
  const h = handleAt(p.x, p.y);
  if (h) drag = { kind: 'resize', handle: h, start: p, orig: { ...sel } };
  else if (inside(sel, p.x, p.y)) drag = { kind: 'move', start: p, orig: { ...sel } };
  else {
    drag = { kind: 'new', anchor: p, start: p, last: p, moved: false };
    sel = null;
    broadcast({ clearSel: true });
  }
  render();
});

stage.addEventListener('pointermove', (e) => {
  if (!session) return;
  cursor = { x: e.clientX, y: e.clientY };
  if (mode === 'window') hoverWin = windowAt(cursor.x, cursor.y);
  if (drag) updateDrag(cursor);
  else if (mode === 'area') {
    const h = handleAt(cursor.x, cursor.y);
    stage.style.cursor = h ? CURSORS[h] : inside(sel, cursor.x, cursor.y) ? 'move' : '';
  }
  render();
});

stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  stage.releasePointerCapture(e.pointerId);
  if (drag.kind === 'new' && !drag.moved) {
    // A click (no drag) snaps the selection to the window under the pointer.
    const w = windowAt(e.clientX, e.clientY);
    sel = w ? clampRect(w) : null;
  }
  if (sel && (sel.w < 2 || sel.h < 2)) sel = null;
  drag = null;
  render();
});

stage.addEventListener('dblclick', (e) => {
  if (mode === 'area' && inside(sel, e.clientX, e.clientY)) commit();
});

function updateDrag(p) {
  const W = session.wPts, H = session.hPts;
  if (drag.kind === 'new') {
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) >= MIN_DRAG) drag.moved = true;
    if (!drag.moved) return;
    if (spaceDown) {
      // Space held: move the whole selection instead of resizing it.
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      drag.anchor = { x: drag.anchor.x + dx, y: drag.anchor.y + dy };
    }
    drag.last = p;
    let end = { ...p };
    if (shiftDown) {
      const s = Math.max(Math.abs(p.x - drag.anchor.x), Math.abs(p.y - drag.anchor.y));
      end = { x: drag.anchor.x + Math.sign(p.x - drag.anchor.x || 1) * s, y: drag.anchor.y + Math.sign(p.y - drag.anchor.y || 1) * s };
    }
    sel = clampRect(rectFrom(drag.anchor, end));
  } else if (drag.kind === 'move') {
    const o = drag.orig;
    sel = {
      x: Math.max(0, Math.min(W - o.w, o.x + p.x - drag.start.x)),
      y: Math.max(0, Math.min(H - o.h, o.y + p.y - drag.start.y)),
      w: o.w, h: o.h,
    };
  } else if (drag.kind === 'resize') {
    const o = drag.orig, hd = drag.handle;
    let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
    if (hd.includes('w')) l = p.x;
    if (hd.includes('e')) r = p.x;
    if (hd.includes('n')) t = p.y;
    if (hd.includes('s')) b = p.y;
    if (shiftDown && o.w && o.h && hd.length === 2) {
      const ratio = o.w / o.h;
      const w = Math.abs(r - l), h = Math.abs(b - t);
      if (w / h > ratio) {
        const nh = w / ratio;
        if (hd.includes('n')) t = b - Math.sign(b - t || 1) * nh; else b = t + Math.sign(b - t || 1) * nh;
      } else {
        const nw = h * ratio;
        if (hd.includes('w')) l = r - Math.sign(r - l || 1) * nw; else r = l + Math.sign(r - l || 1) * nw;
      }
    }
    sel = clampRect(rectFrom({ x: l, y: t }, { x: r, y: b }));
  }
}

window.addEventListener('keydown', (e) => {
  if (!session) return;
  if (e.key === 'Shift') shiftDown = true;
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (drag) { drag = null; render(); } else cancel();
    return;
  }
  if (e.key === 'Enter') {
    if (mode === 'color') pickColor(); else commit();
    return;
  }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (mode === 'area' && sel) {
      sel = { ...sel, x: Math.max(0, Math.min(session.wPts - sel.w, sel.x + dx)), y: Math.max(0, Math.min(session.hPts - sel.h, sel.y + dy)) };
    } else {
      // Nudge the loupe by a single pixel for precise colour picking.
      cursor = { x: cursor.x + dx / scale, y: cursor.y + dy / scale };
    }
    render();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const m = MODES.find(([, , , k]) => k.toLowerCase() === e.key.toLowerCase());
  if (m) { setMode(m[0]); broadcast({ mode: m[0] }); }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftDown = false;
  if (e.key === ' ') spaceDown = false;
});

// ---- Rendering ----------------------------------------------------------------------------

function placeFocus(r, cls) {
  focusEl.className = cls;
  focusEl.style.display = 'block';
  focusEl.style.left = `${r.x}px`;
  focusEl.style.top = `${r.y}px`;
  focusEl.style.width = `${r.w}px`;
  focusEl.style.height = `${r.h}px`;
}

function placeBadge(r, main, ratio, inset) {
  badge.style.display = 'flex';
  $('#badge-main').textContent = main;
  const rl = $('#badge-ratio');
  rl.textContent = ratio;
  rl.style.display = ratio ? '' : 'none';
  const above = r.y - 36;
  badge.style.left = `${Math.max(8, Math.min(r.x, session.wPts - 260))}px`;
  badge.style.top = `${inset || above < 8 ? r.y + (inset ? 16 : 8) : above}px`;
  if (inset) badge.style.left = `${r.x + 16}px`;
}

const px = (v) => Math.round(v * scale);

function render() {
  if (!session) return;
  focusEl.style.display = 'none';
  badge.style.display = 'none';
  dim.style.display = 'none';
  // Hide the HUD while dragging over it so it never hides the area being picked.
  const hb = hud.getBoundingClientRect();
  document.body.classList.toggle('hud-hidden', !!(drag && sel && sel.y + sel.h > hb.top - 40));

  if (mode === 'area') {
    if (sel && sel.w > 0 && sel.h > 0) {
      placeFocus(sel, 'area' + (drag && drag.kind === 'new' ? '' : ' has-handles'));
      placeBadge(sel, `${px(sel.w)} × ${px(sel.h)}`, ratioLabel(px(sel.w), px(sel.h)));
    } else {
      dim.style.display = 'block';
    }
  } else if (mode === 'window') {
    if (hoverWin) {
      placeFocus(hoverWin, 'window');
      const name = hoverWin.app || 'Window';
      placeBadge(hoverWin, `${name} · ${px(hoverWin.w)} × ${px(hoverWin.h)}`, '');
    } else {
      dim.style.display = 'block';
    }
  } else if (mode === 'full') {
    const all = { x: 0, y: 0, w: session.wPts, h: session.hPts };
    placeFocus(all, 'full');
    placeBadge(all, `This display · ${session.width} × ${session.height}`, '', true);
  }
  renderLoupe();
}

function renderLoupe() {
  const overHud = (() => {
    const r = hud.getBoundingClientRect();
    return cursor.x >= r.left && cursor.x <= r.right && cursor.y >= r.top && cursor.y <= r.bottom;
  })();
  const show = sampler && cursor.x >= 0 && !overHud && (mode === 'color' || (mode === 'area' && (!sel || (drag && drag.kind !== 'move'))));
  if (!show) {
    loupe.style.display = 'none';
    return;
  }
  const info = pixelAt(cursor.x, cursor.y);
  const N = 15, Z = 240 / N; // 15×15 pixels on a 240px (2x) canvas
  const ctx = loupeCtx;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 240, 240);
  ctx.drawImage(bitmap, info.px - (N >> 1), info.py - (N >> 1), N, N, 0, 0, 240, 240);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#FF6A3D';
  const c = (N >> 1) * Z;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.strokeRect(c, c, Z, Z);
  ctx.fillStyle = accent;
  ctx.fillRect(c + Z / 2 - 2, 0, 4, c - 4);
  ctx.fillRect(c + Z / 2 - 2, c + Z + 4, 4, 240 - c - Z - 4);
  ctx.fillRect(0, c + Z / 2 - 2, c - 4, 4);
  ctx.fillRect(c + Z + 4, c + Z / 2 - 2, 240 - c - Z - 4, 4);

  $('#loupe-xy').textContent = `${info.px}, ${info.py}`;
  $('#loupe-hex').textContent = info.hex;
  $('#loupe-sw').style.background = info.hex;
  loupe.style.display = 'flex';
  const W = session.wPts, H = session.hPts, LW = 130, LH = 160;
  let lx = cursor.x + 24, ly = cursor.y + 24;
  if (lx + LW > W) lx = cursor.x - 24 - LW;
  if (ly + LH > H) ly = cursor.y - 24 - LH;
  loupe.style.left = `${lx}px`;
  loupe.style.top = `${ly}px`;
}

// ---- Boot ---------------------------------------------------------------------------------

buildHud();
listen('overlay:begin', () => begin().catch((e) => { console.error(e); cancel(); }));
listen('overlay:mode', (e) => setMode(e.payload));
listen('overlay:end', () => { if (session) teardown(); });
listen('overlay:sync', (e) => {
  const c = e.payload;
  if (!session || c.from === LABEL) return;
  if (c.mode && c.mode !== mode) setMode(c.mode);
  if (c.timerIdx !== undefined) timerIdx = c.timerIdx;
  if (c.afterIdx !== undefined) afterIdx = c.afterIdx;
  if (c.clearSel && !drag) sel = null;
  renderHud();
  render();
});
// The pointer moved to another display: drop this one's loupe and window highlight.
stage.addEventListener('pointerleave', () => {
  cursor = { x: -1, y: -1 };
  if (mode === 'window') hoverWin = null;
  render();
});
window.addEventListener('blur', () => { spaceDown = shiftDown = false; });
begin().catch(() => {});
