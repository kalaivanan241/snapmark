// Snapmark editor: vector annotations over a screenshot, rendered to one canvas.
// Shapes live in image-pixel coordinates; sizes set in the UI are points (× capture scale).

const CAPTURE_ID = Number(new URLSearchParams(location.search).get('id'));
const ACCENT = '#FF6A3D';

const TOOLS = {
  select: ['Select', 'V', 'Click to select · Drag to move · Double-click text to edit · ⌫ to delete'],
  crop: ['Crop', 'C', 'Drag the edges to crop · Return to apply · Esc to cancel'],
  pen: ['Pen', 'P', 'Draw freehand · Strokes auto-smooth'],
  marker: ['Highlighter', 'H', 'Drag across text to highlight · Hold ⇧ for a straight stroke'],
  arrow: ['Arrow', 'A', 'Drag to draw · ⇧ snaps to 15°'],
  line: ['Line', 'L', 'Drag to draw · ⇧ snaps to 15°'],
  rect: ['Rectangle', 'R', 'Drag to draw · ⇧ for a square · ⌥ to draw from the center'],
  ellipse: ['Ellipse', 'O', 'Drag to draw · ⇧ for a circle · ⌥ to draw from the center'],
  text: ['Text', 'T', 'Click to add text · ⌘B bold · Esc or ⌘↵ to finish'],
  step: ['Step counter', 'N', 'Click to drop the next number · ⌥-click to restart at 1'],
  blur: ['Blur', 'B', 'Drag over anything private to pixelate it'],
  spot: ['Spotlight', 'S', 'Drag to spotlight an area · Everything else dims'],
  zoom: ['Magnifier', 'M', 'Drag to place a 2× loupe'],
  eraser: ['Eraser', 'E', 'Click or drag across annotations to remove them'],
};
const RAIL = ['select', 'crop', '|', 'pen', 'marker', 'arrow', 'line', 'rect', 'ellipse', '|', 'text', 'step', '|', 'blur', 'spot', 'zoom', 'eraser'];
const COLORS = [['Red', '#E5372C'], ['Orange', '#FF9F0A'], ['Yellow', '#FFD60A'], ['Green', '#30D158'], ['Blue', '#0A84FF'], ['Purple', '#BF5AF2'], ['White', '#FFFFFF'], ['Black', '#111113']];
const FRAMES = [
  ['No background', 'none', 'repeating-conic-gradient(#2C2D33 0% 25%, #1A1B1F 0% 50%) 50% / 10px 10px'],
  ['Indigo', '#3B3F8C'], ['Clay', '#B65A3C'], ['Moss', '#3F6B4E'], ['Sand', '#D9CBB3'], ['Graphite', '#2E3038'],
];
const STROKES = [[2, 'Thin'], [4, 'Medium'], [8, 'Thick']];
const DASHES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
const FILLS = [['none', 'None'], ['soft', 'Tint'], ['solid', 'Solid']];

const BOX = new Set(['rect', 'ellipse', 'blur', 'spot', 'zoom']);
const LINES = new Set(['line', 'arrow']);
const PATHS = new Set(['pen', 'marker']);
const DRAWN = new Set([...BOX, ...LINES, ...PATHS]);
// Which inspector controls apply to each tool / shape type.
const USES = {
  select: 'color stroke dash fill shadow', crop: '', eraser: '',
  pen: 'color stroke dash shadow', marker: 'color stroke', arrow: 'color stroke dash shadow', line: 'color stroke dash shadow',
  rect: 'color stroke dash fill shadow', ellipse: 'color stroke dash fill shadow', text: 'color stroke fill shadow',
  step: 'color stroke shadow', blur: 'stroke', spot: '', zoom: 'color stroke shadow',
};
const DASHABLE = new Set(['pen', 'line', 'arrow', 'rect', 'ellipse']);
const FILLABLE = new Set(['rect', 'ellipse', 'text']);
const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' };
const FONT = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(`snapmark.${key}`) || '{}') }; } catch { return { ...fallback }; }
}
function store(key, value) {
  try { localStorage.setItem(`snapmark.${key}`, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const S = {
  info: null, img: null, W: 0, H: 0, k: 1,
  shapes: [], sel: null, nextId: 1,
  tool: load('ui', { tool: 'arrow' }).tool,
  prevTool: 'arrow',
  style: load('style', { color: '#E5372C', stroke: 4, dash: 'solid', fill: 'none', shadow: true, bold: true }),
  frame: load('frame', { on: false, bg: '#3B3F8C', pad: 40 }),
  crop: null, cropDraft: null,
  view: { zoom: 1, panX: 0, panY: 0, fit: true },
  undo: [], redo: [],
  eyedrop: false, pinned: false, saved: null, saveDir: '~/Pictures/Snapmark',
};
if (!TOOLS[S.tool] || S.tool === 'crop') S.tool = 'arrow';

const stage = $('#stage');
const canvas = $('#view');
const ctx = canvas.getContext('2d');
const ta = $('#text-edit');
const measureCtx = document.createElement('canvas').getContext('2d');
let dpr = window.devicePixelRatio || 1;
let renderScale = 1;   // canvas pixels per image pixel for the current render (shadows aren't transformed)
let act = null;        // pointer interaction in progress
let textEdit = null;   // { id | null, x, y } while the text box is open
let spaceDown = false;
let sampler = null;
const pixelCache = new Map();

// ---- Geometry -------------------------------------------------------------------------------

const full = () => ({ x: 0, y: 0, w: S.W, h: S.H });
const cropping = () => S.tool === 'crop';
const docRect = () => (cropping() ? full() : S.crop || full());
const framePad = () => (S.frame.on && !cropping() ? S.frame.pad * S.k : 0);
function contentRect() {
  const b = docRect(), p = framePad();
  return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p };
}
const toImg = (sx, sy) => ({ x: (sx - S.view.panX) / S.view.zoom, y: (sy - S.view.panY) / S.view.zoom });
const toScr = (x, y) => ({ x: x * S.view.zoom + S.view.panX, y: y * S.view.zoom + S.view.panY });
const norm = (r) => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const selected = () => S.shapes.find((s) => s.id === S.sel) || null;
const textSize = (s) => (8 + s.stroke * 2) * S.k;
const stepRadius = (s) => (6 + s.stroke * 1.5) * S.k;
const markerWidth = (s) => Math.max(s.stroke * 3.5, 10) * S.k;

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
const inkOn = (hex) => (luminance(hex) > 0.62 ? '#111113' : '#FFFFFF');

function textBox(s) {
  const size = textSize(s);
  measureCtx.font = `${s.bold ? 700 : 500} ${size}px ${FONT}`;
  const lines = s.text.split('\n');
  const tw = Math.max(size * 0.3, ...lines.map((l) => measureCtx.measureText(l).width));
  const padX = s.fill === 'none' ? 0 : size * 0.6, padY = s.fill === 'none' ? 0 : size * 0.35;
  return { x: s.x, y: s.y, w: tw + 2 * padX, h: lines.length * size * 1.25 + 2 * padY, padX, padY, size, lines };
}

function bbox(s) {
  if (BOX.has(s.type)) return norm(s);
  if (LINES.has(s.type)) return norm({ x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 });
  if (PATHS.has(s.type)) {
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    const half = (s.type === 'marker' ? markerWidth(s) : s.stroke * S.k) / 2;
    const x = Math.min(...xs) - half, y = Math.min(...ys) - half;
    return { x, y, w: Math.max(...xs) + half - x, h: Math.max(...ys) + half - y };
  }
  if (s.type === 'text') return textBox(s);
  if (s.type === 'step') {
    const r = stepRadius(s);
    return { x: s.x - r, y: s.y - r, w: 2 * r, h: 2 * r };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function hits(s, p, tol) {
  const lw = s.stroke * S.k;
  const r = BOX.has(s.type) ? norm(s) : null;
  switch (s.type) {
    case 'pen':
    case 'marker': {
      const half = (s.type === 'marker' ? markerWidth(s) : lw) / 2 + tol;
      if (s.pts.length === 1) return Math.hypot(p.x - s.pts[0][0], p.y - s.pts[0][1]) <= half;
      for (let i = 1; i < s.pts.length; i++) {
        if (distSeg(p.x, p.y, s.pts[i - 1][0], s.pts[i - 1][1], s.pts[i][0], s.pts[i][1]) <= half) return true;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return distSeg(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= lw / 2 + tol + (s.type === 'arrow' ? lw : 0);
    case 'rect': {
      const outer = p.x >= r.x - lw / 2 - tol && p.x <= r.x + r.w + lw / 2 + tol && p.y >= r.y - lw / 2 - tol && p.y <= r.y + r.h + lw / 2 + tol;
      if (!outer) return false;
      if (s.fill !== 'none') return true;
      const m = lw / 2 + tol;
      return !(p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.h - m);
    }
    case 'ellipse': {
      const rx = r.w / 2, ry = r.h / 2, cx = r.x + rx, cy = r.y + ry;
      const v = Math.hypot((p.x - cx) / (rx || 1), (p.y - cy) / (ry || 1));
      if (s.fill !== 'none') return v <= 1 + tol / Math.max(1, Math.min(rx, ry));
      return Math.abs(v - 1) * Math.min(rx, ry) <= lw / 2 + tol;
    }
    case 'zoom': {
      const rad = Math.min(r.w, r.h) / 2;
      return Math.hypot(p.x - (r.x + r.w / 2), p.y - (r.y + r.h / 2)) <= rad + tol;
    }
    case 'blur':
    case 'spot':
      return p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
    case 'text': {
      const b = textBox(s);
      return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
    }
    case 'step':
      return Math.hypot(p.x - s.x, p.y - s.y) <= stepRadius(s) + tol;
  }
  return false;
}

function hitShape(p) {
  const tol = 6 / S.view.zoom;
  for (let i = S.shapes.length - 1; i >= 0; i--) if (hits(S.shapes[i], p, tol)) return S.shapes[i];
  return null;
}

function handles(s) {
  if (LINES.has(s.type)) return [['p1', s.x1, s.y1], ['p2', s.x2, s.y2]];
  if (!BOX.has(s.type)) return [];
  const r = norm(s), cx = r.x + r.w / 2, cy = r.y + r.h / 2, R = r.x + r.w, B = r.y + r.h;
  const corners = [['nw', r.x, r.y], ['ne', R, r.y], ['sw', r.x, B], ['se', R, B]];
  if (s.type === 'zoom') return corners;
  return [...corners, ['n', cx, r.y], ['s', cx, B], ['w', r.x, cy], ['e', R, cy]];
}

function handleAt(s, sx, sy) {
  for (const [name, hx, hy] of handles(s)) {
    const q = toScr(hx, hy);
    if (Math.abs(q.x - sx) <= 7 && Math.abs(q.y - sy) <= 7) return name;
  }
  return null;
}

// ---- Rendering -----------------------------------------------------------------------------

function setShadow(c, blur, dy, color) {
  c.shadowColor = color;
  c.shadowBlur = blur * renderScale;
  c.shadowOffsetX = 0;
  c.shadowOffsetY = dy * renderScale;
}

function dashFor(s, lw) {
  if (!DASHABLE.has(s.type)) return [];
  if (s.dash === 'dashed') return [lw * 3, lw * 2];
  if (s.dash === 'dotted') return [0.01, lw * 2];
  return [];
}

function strokePath(c, pts) {
  c.beginPath();
  if (pts.length === 1) {
    c.arc(pts[0][0], pts[0][1], c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
  const last = pts[pts.length - 1];
  c.lineTo(last[0], last[1]);
  c.stroke();
}

function drawArrow(c, s, lw, dash) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const head = Math.min(len * 0.75, Math.max(lw * 3.6, 12 * S.k));
  const half = head * 0.55;
  const bx = s.x2 - ux * head, by = s.y2 - uy * head;
  c.setLineDash(dash);
  c.beginPath();
  c.moveTo(s.x1, s.y1);
  c.lineTo(bx + ux * head * 0.3, by + uy * head * 0.3);
  c.stroke();
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(s.x2, s.y2);
  c.lineTo(bx - uy * half, by + ux * half);
  c.lineTo(bx + uy * half, by - ux * half);
  c.closePath();
  c.lineWidth = Math.max(1, lw * 0.4);
  c.fill();
  c.stroke();
}

function drawText(c, s) {
  const b = textBox(s);
  const ink = s.fill === 'solid' ? inkOn(s.color) : s.color;
  if (s.fill !== 'none') {
    c.save();
    if (s.fill === 'soft') c.globalAlpha = 0.18;
    c.beginPath();
    c.roundRect(b.x, b.y, b.w, b.h, Math.min(8 * S.k, b.size * 0.5));
    c.fill();
    c.restore();
    c.shadowColor = 'transparent';
  }
  c.font = `${s.bold ? 700 : 500} ${b.size}px ${FONT}`;
  c.textBaseline = 'top';
  const lh = b.size * 1.25, top = b.y + b.padY + (lh - b.size) / 2;
  if (s.fill === 'none') {
    // A contrasting outline keeps bare text legible on any background.
    c.save();
    c.shadowColor = 'transparent';
    c.lineWidth = Math.max(2 * S.k, b.size * 0.16);
    c.strokeStyle = luminance(s.color) > 0.5 ? 'rgba(17,17,19,0.85)' : 'rgba(255,255,255,0.92)';
    b.lines.forEach((l, i) => c.strokeText(l, b.x + b.padX, top + i * lh));
    c.restore();
  }
  c.fillStyle = ink;
  b.lines.forEach((l, i) => c.fillText(l, b.x + b.padX, top + i * lh));
}

function drawStep(c, s) {
  const r = stepRadius(s);
  c.beginPath();
  c.arc(s.x, s.y, r, 0, Math.PI * 2);
  c.fill();
  c.shadowColor = 'transparent';
  c.fillStyle = inkOn(s.color);
  c.font = `700 ${r * (s.n > 9 ? 0.85 : 1.05)}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(s.n), s.x, s.y + r * 0.04);
}

/// Pixelated copy of the screenshot for a given block size, aligned to the image grid.
function pixelated(block) {
  const key = Math.round(block);
  if (pixelCache.has(key)) return pixelCache.get(key);
  let src = S.img, sw = S.W, sh = S.H;
  const tw = Math.ceil(S.W / key), th = Math.ceil(S.H / key);
  // Halve repeatedly so each output cell is an average, not a single sampled pixel.
  while (sw / 2 > tw && sh / 2 > th) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(sw / 2);
    c.height = Math.ceil(sh / 2);
    c.getContext('2d').drawImage(src, 0, 0, sw, sh, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  out.getContext('2d').drawImage(src, 0, 0, sw, sh, 0, 0, S.W / key, S.H / key);
  pixelCache.set(key, out);
  return out;
}

function drawBlur(c, s) {
  const r = norm(s);
  const block = Math.max(4, s.stroke * 3) * S.k;
  const pix = pixelated(block);
  const key = Math.round(block);
  c.beginPath();
  c.roundRect(r.x, r.y, r.w, r.h, 4 * S.k);
  c.clip();
  c.imageSmoothingEnabled = false;
  c.drawImage(pix, 0, 0, pix.width, pix.height, 0, 0, pix.width * key, pix.height * key);
}

function drawMagnifier(c, s) {
  const r = norm(s);
  const rad = Math.min(r.w, r.h) / 2;
  if (rad < 2) return;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  c.beginPath();
  c.arc(cx, cy, rad, 0, Math.PI * 2);
  c.fillStyle = '#000';
  c.fill();
  c.shadowColor = 'transparent';
  c.save();
  c.clip();
  c.drawImage(S.img, cx - rad / 2, cy - rad / 2, rad, rad, cx - rad, cy - rad, rad * 2, rad * 2);
  c.restore();
  c.beginPath();
  c.arc(cx, cy, rad, 0, Math.PI * 2);
  c.stroke();
}

function drawSpots(c, spots) {
  if (!spots.length) return;
  c.save();
  c.beginPath();
  c.rect(0, 0, S.W, S.H);
  for (const s of spots) {
    const r = norm(s);
    c.roundRect(r.x, r.y, r.w, r.h, 8 * S.k);
  }
  c.fillStyle = 'rgba(0, 0, 0, 0.55)';
  c.fill('evenodd');
  c.restore();
}

function drawShape(c, s) {
  const lw = s.stroke * S.k;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = lw;
  if (s.shadow && s.type !== 'marker' && s.type !== 'blur') setShadow(c, 6 * S.k, 2 * S.k, 'rgba(0, 0, 0, 0.32)');
  const dash = dashFor(s, lw);
  switch (s.type) {
    case 'pen':
      c.setLineDash(dash);
      strokePath(c, s.pts);
      break;
    case 'marker':
      c.globalAlpha = 0.42;
      c.globalCompositeOperation = 'multiply';
      c.lineWidth = markerWidth(s);
      c.lineCap = 'butt';
      strokePath(c, s.pts);
      break;
    case 'line':
      c.setLineDash(dash);
      c.beginPath();
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2, s.y2);
      c.stroke();
      break;
    case 'arrow':
      drawArrow(c, s, lw, dash);
      break;
    case 'rect':
    case 'ellipse': {
      const r = norm(s);
      c.beginPath();
      if (s.type === 'rect') c.roundRect(r.x, r.y, r.w, r.h, Math.min(6 * S.k, r.w / 2, r.h / 2));
      else c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (s.fill !== 'none') {
        c.save();
        if (s.fill === 'soft') c.globalAlpha = 0.16;
        c.fill();
        c.restore();
      }
      c.setLineDash(dash);
      c.stroke();
      break;
    }
    case 'text':
      drawText(c, s);
      break;
    case 'step':
      drawStep(c, s);
      break;
    case 'blur':
      drawBlur(c, s);
      break;
    case 'zoom':
      drawMagnifier(c, s);
      break;
  }
  c.restore();
}

/// The screenshot, its annotations and (optionally) the export frame.
function renderDoc(c, { hideId = null } = {}) {
  const b = docRect(), p = framePad(), k = S.k;
  const radius = p > 0 ? 10 * k : 0;
  if (p > 0) {
    if (S.frame.bg !== 'none') {
      c.fillStyle = S.frame.bg;
      c.beginPath();
      c.roundRect(b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p, Math.min(16 * k, p));
      c.fill();
    }
    c.save();
    const blur = Math.min(40, S.frame.pad) * k;
    setShadow(c, blur, blur * 0.4, 'rgba(0, 0, 0, 0.45)');
    c.fillStyle = '#000';
    c.beginPath();
    c.roundRect(b.x, b.y, b.w, b.h, radius);
    c.fill();
    c.restore();
  }
  c.save();
  c.beginPath();
  c.roundRect(b.x, b.y, b.w, b.h, radius);
  c.clip();
  c.drawImage(S.img, 0, 0);
  const visible = S.shapes.filter((s) => s.id !== hideId);
  let spotsDrawn = false;
  for (const s of visible) {
    if (s.type === 'spot') {
      if (!spotsDrawn) drawSpots(c, visible.filter((v) => v.type === 'spot'));
      spotsDrawn = true;
    } else {
      drawShape(c, s);
    }
  }
  c.restore();
}

function drawSelectionUI(c) {
  const s = selected();
  if (!s || textEdit || cropping()) return;
  const z = S.view.zoom;
  c.save();
  c.strokeStyle = ACCENT;
  c.lineWidth = 1 / z;
  if (!LINES.has(s.type)) {
    const b = bbox(s), pad = 4 / z;
    c.beginPath();
    c.roundRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad, 6 / z);
    c.stroke();
  }
  c.lineWidth = 1.5 / z;
  for (const [, hx, hy] of handles(s)) {
    c.beginPath();
    c.roundRect(hx - 5 / z, hy - 5 / z, 10 / z, 10 / z, 3 / z);
    c.fillStyle = '#fff';
    c.fill();
    c.stroke();
  }
  c.restore();
}

function drawCropUI(c) {
  const d = S.cropDraft;
  if (!d) return;
  const z = S.view.zoom;
  c.save();
  c.beginPath();
  c.rect(0, 0, S.W, S.H);
  c.rect(d.x, d.y, d.w, d.h);
  c.fillStyle = 'rgba(8, 9, 12, 0.62)';
  c.fill('evenodd');
  c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  c.lineWidth = 1 / z;
  c.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    c.moveTo(d.x + d.w * f, d.y); c.lineTo(d.x + d.w * f, d.y + d.h);
    c.moveTo(d.x, d.y + d.h * f); c.lineTo(d.x + d.w, d.y + d.h * f);
  }
  c.stroke();
  c.strokeStyle = '#fff';
  c.lineWidth = 1.5 / z;
  c.strokeRect(d.x, d.y, d.w, d.h);
  c.fillStyle = '#fff';
  c.shadowColor = 'rgba(0,0,0,0.4)';
  c.shadowBlur = 4 * dpr;
  for (const [, hx, hy] of cropHandles(d)) {
    c.beginPath();
    c.arc(hx, hy, 6 / z, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

let raf = 0;
let drawTimer = 0;
function requestDraw() {
  if (raf) return;
  const run = () => { cancelAnimationFrame(raf); clearTimeout(drawTimer); raf = 0; draw(); };
  raf = requestAnimationFrame(run);
  // WebKit pauses rAF for occluded windows; keep the canvas current anyway.
  drawTimer = setTimeout(run, 100);
}

function draw() {
  if (!S.img) return;
  const z = S.view.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderScale = z * dpr;
  ctx.setTransform(renderScale, 0, 0, renderScale, S.view.panX * dpr, S.view.panY * dpr);
  ctx.imageSmoothingEnabled = renderScale < 2;
  ctx.imageSmoothingQuality = 'high';
  renderDoc(ctx, { hideId: textEdit && textEdit.id });
  drawSelectionUI(ctx);
  if (cropping()) drawCropUI(ctx);
  if (textEdit) layoutTextarea();
  placeMini();
  updateZoomLabels();
}

// ---- Export ------------------------------------------------------------------------------------

function exportCanvas() {
  if (cropping()) setTool(S.prevTool);
  if (textEdit) commitText();
  const b = docRect(), p = framePad();
  const c = document.createElement('canvas');
  c.width = Math.round(b.w + 2 * p);
  c.height = Math.round(b.h + 2 * p);
  const x = c.getContext('2d');
  const prev = renderScale;
  renderScale = 1;
  x.translate(p - b.x, p - b.y);
  renderDoc(x);
  renderScale = prev;
  return c;
}

async function exportPNG() {
  const c = exportCanvas();
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const idHeader = { headers: { 'x-capture-id': String(CAPTURE_ID) } };

async function doCopy() {
  try {
    await invoke('editor_copy', await exportPNG());
    toast('Copied to clipboard');
  } catch (e) { toast(String(e), true); }
}

async function doSave() {
  try {
    const path = await invoke('editor_save', await exportPNG(), idHeader);
    S.saved = path;
    toast(`Saved to ${path}`);
    renderFoot();
  } catch (e) { toast(String(e), true); }
}

async function doSaveAs() {
  try {
    const path = await invoke('editor_save_as', await exportPNG(), idHeader);
    if (path) toast(`Saved to ${path}`);
  } catch (e) { toast(String(e), true); }
}

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('#toast');
  t.className = `toast show${err ? ' err' : ''}`;
  t.innerHTML = `${icon(err ? 'close' : 'check', 14, 2.2)}<span></span>`;
  t.querySelector('span').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2200);
}

// ---- History -----------------------------------------------------------------------------------

function snapshot() {
  return JSON.stringify({ shapes: S.shapes, crop: S.crop });
}
function pushUndo() {
  S.undo.push(snapshot());
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  coalesce = null;
}
let coalesce = null;
function pushUndoCoalesced(key) {
  const now = performance.now();
  if (coalesce && coalesce.key === key && coalesce.id === S.sel && now - coalesce.t < 900) { coalesce.t = now; return; }
  pushUndo();
  coalesce = { key, id: S.sel, t: now };
}
function restore(json) {
  const o = JSON.parse(json);
  S.shapes = o.shapes;
  S.crop = o.crop;
  if (!selected()) S.sel = null;
  afterDocChange();
}
function undo() {
  if (textEdit) commitText();
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  restore(S.undo.pop());
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  restore(S.redo.pop());
}
function afterDocChange() {
  if (S.view.fit) fit();
  refreshUI();
  requestDraw();
}

// ---- View --------------------------------------------------------------------------------------

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  if (S.view.fit) fit(); else requestDraw();
}

function fit() {
  if (!S.img) return;
  const r = stage.getBoundingClientRect(), c = contentRect(), m = 48;
  const z = Math.min((r.width - 2 * m) / c.w, (r.height - 2 * m) / c.h, 1 / S.k);
  S.view = { zoom: z, panX: (r.width - c.w * z) / 2 - c.x * z, panY: (r.height - c.h * z) / 2 - c.y * z, fit: true };
  requestDraw();
}

function zoomAt(z, sx, sy) {
  const p = toImg(sx, sy);
  S.view.zoom = clamp(z, 0.05, 16);
  S.view.panX = sx - p.x * S.view.zoom;
  S.view.panY = sy - p.y * S.view.zoom;
  S.view.fit = false;
  requestDraw();
}
function zoomCentered(z) {
  const r = stage.getBoundingClientRect();
  zoomAt(z, r.width / 2, r.height / 2);
}

function updateZoomLabels() {
  const pct = `${Math.round(S.view.zoom * 100)}%`;
  $('#zoom-label').textContent = pct;
  $('#zoom-pct').textContent = pct;
}

// ---- Tools & style ---------------------------------------------------------------------------

function setTool(t, { applyCrop = true } = {}) {
  if (!TOOLS[t]) return;
  if (textEdit) commitText();
  if (S.tool === t) return;
  if (S.tool === 'crop') {
    if (applyCrop) commitCrop();
    S.cropDraft = null;
  }
  if (t === 'crop') {
    S.prevTool = S.tool;
    S.cropDraft = { ...(S.crop || full()) };
  }
  if (t !== 'select' && !DRAWN.has(t)) S.sel = null;
  S.tool = t;
  S.eyedrop = false;
  store('ui', { tool: t === 'crop' ? S.prevTool : t });
  $('#crop-bar').classList.toggle('open', t === 'crop');
  afterDocChange();
}

function commitCrop() {
  const d = S.cropDraft;
  if (!d) return;
  const r = { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) };
  const isFull = r.x <= 0 && r.y <= 0 && r.w >= S.W && r.h >= S.H;
  const next = isFull || r.w < 4 || r.h < 4 ? null : r;
  if (JSON.stringify(next) !== JSON.stringify(S.crop)) {
    pushUndo();
    S.crop = next;
  }
}

function activeType() {
  const s = selected();
  return s ? s.type : S.tool;
}

function current(key) {
  const s = selected();
  return s && key in s ? s[key] : S.style[key];
}

function applies(s, key) {
  if (key === 'color') return !['blur', 'spot'].includes(s.type);
  if (key === 'stroke') return s.type !== 'spot';
  if (key === 'dash') return DASHABLE.has(s.type);
  if (key === 'fill') return FILLABLE.has(s.type);
  if (key === 'shadow') return !['blur', 'spot', 'marker'].includes(s.type);
  if (key === 'bold') return s.type === 'text';
  return false;
}

function setStyle(key, value) {
  const s = selected();
  if (s && applies(s, key) && s[key] !== value) {
    pushUndoCoalesced(key);
    s[key] = value;
  }
  S.style[key] = value;
  store('style', S.style);
  refreshUI();
  requestDraw();
}

function newShape(type, p) {
  const st = S.style;
  const base = { id: S.nextId++, type, color: st.color, stroke: st.stroke, shadow: st.shadow };
  if (BOX.has(type)) return { ...base, x: p.x, y: p.y, w: 0, h: 0, dash: st.dash, fill: st.fill };
  if (LINES.has(type)) return { ...base, x1: p.x, y1: p.y, x2: p.x, y2: p.y, dash: st.dash };
  if (PATHS.has(type)) return { ...base, pts: [[p.x, p.y]], dash: st.dash };
  return base;
}

function nextStep() {
  const steps = S.shapes.filter((s) => s.type === 'step');
  return steps.length ? steps[steps.length - 1].n + 1 : 1;
}

function moveShape(s, o, dx, dy) {
  if (LINES.has(s.type)) Object.assign(s, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
  else if (PATHS.has(s.type)) s.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  else Object.assign(s, { x: o.x + dx, y: o.y + dy });
}

function snapAngle(ax, ay, bx, by) {
  const len = Math.hypot(bx - ax, by - ay);
  const step = Math.PI / 12;
  const a = Math.round(Math.atan2(by - ay, bx - ax) / step) * step;
  return { x: ax + Math.cos(a) * len, y: ay + Math.sin(a) * len };
}

function boxFromDrag(start, p, square, fromCenter) {
  let dx = p.x - start.x, dy = p.y - start.y;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  return fromCenter ? norm({ x: start.x - dx, y: start.y - dy, w: dx * 2, h: dy * 2 }) : norm({ x: start.x, y: start.y, w: dx, h: dy });
}

function resizeBox(o, handle, p, keepRatio) {
  let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
  if (handle.includes('w')) l = p.x;
  if (handle.includes('e')) r = p.x;
  if (handle.includes('n')) t = p.y;
  if (handle.includes('s')) b = p.y;
  if (keepRatio && handle.length === 2 && o.w && o.h) {
    const ratio = o.w / o.h, w = Math.abs(r - l), h = Math.abs(b - t);
    if (w / h > ratio) {
      const nh = w / ratio;
      if (handle.includes('n')) t = b - Math.sign(b - t || 1) * nh; else b = t + Math.sign(b - t || 1) * nh;
    } else {
      const nw = h * ratio;
      if (handle.includes('w')) l = r - Math.sign(r - l || 1) * nw; else r = l + Math.sign(r - l || 1) * nw;
    }
  }
  return norm({ x: l, y: t, w: r - l, h: b - t });
}

// ---- Crop interaction ------------------------------------------------------------------------

function cropHandles(d) {
  const R = d.x + d.w, B = d.y + d.h, cx = d.x + d.w / 2, cy = d.y + d.h / 2;
  return [['nw', d.x, d.y], ['ne', R, d.y], ['sw', d.x, B], ['se', R, B], ['n', cx, d.y], ['s', cx, B], ['w', d.x, cy], ['e', R, cy]];
}

function cropHandleAt(sx, sy) {
  const d = S.cropDraft;
  for (const [name, hx, hy] of cropHandles(d)) {
    const q = toScr(hx, hy);
    if (Math.abs(q.x - sx) <= 9 && Math.abs(q.y - sy) <= 9) return name;
  }
  const p = toImg(sx, sy), tol = 6 / S.view.zoom;
  const inY = p.y > d.y && p.y < d.y + d.h, inX = p.x > d.x && p.x < d.x + d.w;
  if (inY && Math.abs(p.x - d.x) <= tol) return 'w';
  if (inY && Math.abs(p.x - d.x - d.w) <= tol) return 'e';
  if (inX && Math.abs(p.y - d.y) <= tol) return 'n';
  if (inX && Math.abs(p.y - d.y - d.h) <= tol) return 's';
  return null;
}

function clampToImage(r) {
  const x = clamp(r.x, 0, S.W), y = clamp(r.y, 0, S.H);
  return { x, y, w: clamp(r.x + r.w, 0, S.W) - x, h: clamp(r.y + r.h, 0, S.H) - y };
}

// ---- Text editing ------------------------------------------------------------------------------

function textDraft() {
  const s = textEdit.id ? S.shapes.find((v) => v.id === textEdit.id) : null;
  const st = s || S.style;
  return { type: 'text', x: textEdit.x, y: textEdit.y, text: ta.value || ' ', color: st.color, stroke: st.stroke, fill: st.fill, bold: st.bold ?? true };
}

function startTextEdit(shape, p) {
  commitText();
  S.sel = shape ? shape.id : null;
  if (shape) {
    textEdit = { id: shape.id, x: shape.x, y: shape.y };
    ta.value = shape.text;
  } else {
    textEdit = { id: null, x: p.x, y: p.y - (8 + S.style.stroke * 2) * S.k * 0.62 };
    ta.value = '';
  }
  ta.style.display = 'block';
  layoutTextarea();
  ta.focus();
  ta.select();
  refreshUI();
  requestDraw();
}

function layoutTextarea() {
  if (!textEdit) return;
  const d = textDraft();
  const b = textBox(d);
  const z = S.view.zoom;
  const fs = b.size * z;
  const q = toScr(d.x, d.y);
  ta.style.left = `${q.x}px`;
  ta.style.top = `${q.y}px`;
  ta.style.width = `${b.w * z + fs}px`;
  ta.style.height = `${b.h * z}px`;
  ta.style.padding = `${b.padY * z}px ${b.padX * z}px`;
  ta.style.fontSize = `${fs}px`;
  ta.style.fontWeight = d.bold ? '700' : '500';
  ta.style.color = d.fill === 'solid' ? inkOn(d.color) : d.color;
  ta.style.background = d.fill === 'solid' ? d.color : d.fill === 'soft' ? `${d.color}2E` : 'transparent';
  ta.style.borderRadius = `${Math.min(8 * S.k, b.size * 0.5) * z}px`;
  ta.style.textShadow = d.fill === 'none' ? `0 0 ${Math.max(1, fs * 0.08)}px ${luminance(d.color) > 0.5 ? '#000' : '#fff'}` : 'none';
}

function commitText() {
  if (!textEdit) return;
  const te = textEdit;
  textEdit = null;
  ta.style.display = 'none';
  ta.blur();
  const text = ta.value.replace(/\s+$/, '');
  if (te.id) {
    const s = S.shapes.find((v) => v.id === te.id);
    if (s && !text) { pushUndo(); S.shapes = S.shapes.filter((v) => v !== s); S.sel = null; }
    else if (s && text !== s.text) { pushUndo(); s.text = text; }
  } else if (text) {
    pushUndo();
    const st = S.style;
    const s = { id: S.nextId++, type: 'text', x: te.x, y: te.y, text, color: st.color, stroke: st.stroke, fill: st.fill, shadow: st.shadow, bold: st.bold ?? true };
    S.shapes.push(s);
    S.sel = s.id;
  }
  refreshUI();
  requestDraw();
}

ta.addEventListener('input', layoutTextarea);
ta.addEventListener('blur', () => setTimeout(commitText, 0));
ta.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) { e.preventDefault(); commitText(); }
  else if (e.metaKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const s = textEdit.id && S.shapes.find((v) => v.id === textEdit.id);
    if (s) { pushUndo(); s.bold = !s.bold; } else setStyle('bold', !(S.style.bold ?? true));
    layoutTextarea();
  }
});

// ---- Pointer interaction ---------------------------------------------------------------------

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

function sampleColor(p) {
  if (!sampler) {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;
    sampler = c.getContext('2d', { willReadFrequently: true });
    sampler.drawImage(S.img, 0, 0);
  }
  const x = clamp(Math.floor(p.x), 0, S.W - 1), y = clamp(Math.floor(p.y), 0, S.H - 1);
  const [r, g, b] = sampler.getImageData(x, y, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function eraseAt(p) {
  const hit = hitShape(p);
  if (!hit) return;
  S.shapes = S.shapes.filter((s) => s !== hit);
  if (S.sel === hit.id) S.sel = null;
  act.removed++;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!S.img || (e.button !== 0 && e.button !== 1)) return;
  // Keep focus where it is (e.g. a text box we're about to open).
  e.preventDefault();
  closePops();
  if (textEdit) { commitText(); if (S.tool === 'text') return; }
  const { sx, sy } = localPoint(e);
  const p = toImg(sx, sy);
  canvas.setPointerCapture(e.pointerId);

  if (spaceDown || e.button === 1) {
    act = { kind: 'pan', sx, sy, x0: S.view.panX, y0: S.view.panY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (S.eyedrop) {
    S.eyedrop = false;
    setStyle('color', sampleColor(p));
    return;
  }
  if (S.tool === 'crop') {
    const h = cropHandleAt(sx, sy);
    const d = S.cropDraft;
    if (h) act = { kind: 'crop-resize', handle: h, orig: { ...d } };
    else if (p.x > d.x && p.x < d.x + d.w && p.y > d.y && p.y < d.y + d.h) act = { kind: 'crop-move', start: p, orig: { ...d } };
    else act = { kind: 'crop-new', start: p };
    return;
  }

  const sel = selected();
  const h = sel && handleAt(sel, sx, sy);
  if (h) {
    pushUndo();
    act = { kind: 'resize', id: sel.id, handle: h, orig: JSON.parse(JSON.stringify(sel)) };
    return;
  }

  const tool = S.tool;
  if (tool === 'select') {
    const hit = hitShape(p);
    S.sel = hit ? hit.id : null;
    if (hit) {
      pushUndo();
      act = { kind: 'move', id: hit.id, start: p, orig: JSON.parse(JSON.stringify(hit)), moved: false };
    }
  } else if (tool === 'eraser') {
    pushUndo();
    act = { kind: 'erase', removed: 0 };
    eraseAt(p);
  } else if (tool === 'text') {
    const hit = hitShape(p);
    startTextEdit(hit && hit.type === 'text' ? hit : null, p);
  } else if (tool === 'step') {
    pushUndo();
    const s = { ...newShape('step', p), x: p.x, y: p.y, n: e.altKey ? 1 : nextStep() };
    S.shapes.push(s);
    S.sel = s.id;
  } else if (DRAWN.has(tool)) {
    pushUndo();
    const s = newShape(tool, p);
    S.shapes.push(s);
    S.sel = null;
    act = { kind: 'draw', id: s.id, start: p };
  }
  refreshUI();
  requestDraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!S.img) return;
  const { sx, sy } = localPoint(e);
  const p = toImg(sx, sy);
  if (!act) return updateCursor(sx, sy, p);
  const s = act.id ? S.shapes.find((v) => v.id === act.id) : null;
  switch (act.kind) {
    case 'pan':
      S.view.panX = act.x0 + sx - act.sx;
      S.view.panY = act.y0 + sy - act.sy;
      S.view.fit = false;
      break;
    case 'draw':
      if (BOX.has(s.type)) Object.assign(s, boxFromDrag(act.start, p, e.shiftKey || s.type === 'zoom', e.altKey));
      else if (LINES.has(s.type)) {
        const end = e.shiftKey ? snapAngle(s.x1, s.y1, p.x, p.y) : p;
        s.x2 = end.x;
        s.y2 = end.y;
      } else if (s.type === 'marker' && e.shiftKey) {
        const end = snapAngle(s.pts[0][0], s.pts[0][1], p.x, p.y);
        s.pts = [s.pts[0], [end.x, end.y]];
      } else {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > 1.5 / S.view.zoom) s.pts.push([p.x, p.y]);
      }
      break;
    case 'move': {
      const dx = p.x - act.start.x, dy = p.y - act.start.y;
      if (Math.hypot(dx, dy) * S.view.zoom > 1) act.moved = true;
      moveShape(s, act.orig, dx, dy);
      break;
    }
    case 'resize':
      if (act.handle === 'p1' || act.handle === 'p2') {
        const n = act.handle === 'p1' ? 1 : 2, o = n === 1 ? 2 : 1;
        const end = e.shiftKey ? snapAngle(s[`x${o}`], s[`y${o}`], p.x, p.y) : p;
        s[`x${n}`] = end.x;
        s[`y${n}`] = end.y;
      } else {
        let r = resizeBox(norm(act.orig), act.handle, p, e.shiftKey || s.type === 'zoom');
        if (s.type === 'zoom') r = { ...r, h: r.w };
        Object.assign(s, r);
      }
      break;
    case 'erase':
      eraseAt(p);
      break;
    case 'crop-new':
      S.cropDraft = clampToImage(boxFromDrag(act.start, p, e.shiftKey, false));
      break;
    case 'crop-move': {
      const o = act.orig;
      S.cropDraft = { ...o, x: clamp(o.x + p.x - act.start.x, 0, S.W - o.w), y: clamp(o.y + p.y - act.start.y, 0, S.H - o.h) };
      break;
    }
    case 'crop-resize':
      S.cropDraft = clampToImage(resizeBox(act.orig, act.handle, p, e.shiftKey));
      break;
  }
  refreshMeta();
  requestDraw();
});

function endPointer(e) {
  if (!act) return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const s = act.id ? S.shapes.find((v) => v.id === act.id) : null;
  if (act.kind === 'draw' && s) {
    const z = S.view.zoom;
    let tiny = false;
    if (BOX.has(s.type)) tiny = s.w * z < 4 || s.h * z < 4;
    else if (LINES.has(s.type)) tiny = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * z < 4;
    else if (s.type === 'marker') tiny = s.pts.length < 2;
    if (tiny) {
      S.shapes = S.shapes.filter((v) => v !== s);
      S.undo.pop();
    } else {
      S.sel = s.id;
    }
  }
  if (act.kind === 'move' && !act.moved) S.undo.pop();
  if (act.kind === 'erase' && !act.removed) S.undo.pop();
  if (act.kind === 'crop-new' && S.cropDraft.w < 4) S.cropDraft = { ...(S.crop || full()) };
  act = null;
  const { sx, sy } = localPoint(e);
  updateCursor(sx, sy, toImg(sx, sy));
  refreshUI();
  requestDraw();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('dblclick', (e) => {
  const { sx, sy } = localPoint(e);
  const hit = hitShape(toImg(sx, sy));
  if (hit && hit.type === 'text' && (S.tool === 'select' || DRAWN.has(S.tool))) startTextEdit(hit);
  else if (S.tool === 'crop') setTool(S.prevTool);
});

function updateCursor(sx, sy, p) {
  let cur = 'crosshair';
  if (spaceDown) cur = 'grab';
  else if (S.eyedrop) cur = 'crosshair';
  else if (S.tool === 'crop') {
    const h = cropHandleAt(sx, sy), d = S.cropDraft;
    cur = h ? HANDLE_CURSOR[h] : p.x > d.x && p.x < d.x + d.w && p.y > d.y && p.y < d.y + d.h ? 'move' : 'crosshair';
  } else {
    const sel = selected();
    const h = sel && handleAt(sel, sx, sy);
    if (h) cur = HANDLE_CURSOR[h];
    else if (S.tool === 'select') cur = hitShape(p) ? 'move' : 'default';
    else if (S.tool === 'text') cur = 'text';
    else if (S.tool === 'eraser') cur = hitShape(p) ? 'pointer' : 'default';
  }
  canvas.style.cursor = cur;
}

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { sx, sy } = localPoint(e);
  if (e.ctrlKey || e.metaKey) zoomAt(S.view.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), sx, sy);
  else {
    S.view.panX -= e.deltaX;
    S.view.panY -= e.deltaY;
    S.view.fit = false;
    requestDraw();
  }
}, { passive: false });

// Safari-style trackpad pinch.
let gestureZoom = 1;
stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureZoom = S.view.zoom; });
stage.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  const { sx, sy } = localPoint(e);
  zoomAt(gestureZoom * e.scale, sx, sy);
});
stage.addEventListener('gestureend', (e) => e.preventDefault());

// ---- Selection actions -------------------------------------------------------------------------

function deleteSelected() {
  const s = selected();
  if (!s) return;
  pushUndo();
  S.shapes = S.shapes.filter((v) => v !== s);
  S.sel = null;
  refreshUI();
  requestDraw();
}

function duplicate() {
  const s = selected();
  if (!s) return;
  pushUndo();
  const copy = JSON.parse(JSON.stringify(s));
  copy.id = S.nextId++;
  if (copy.type === 'step') copy.n = nextStep();
  const o = 16 * S.k;
  moveShape(copy, JSON.parse(JSON.stringify(copy)), o, o);
  S.shapes.push(copy);
  S.sel = copy.id;
  refreshUI();
  requestDraw();
}

function bringToFront() {
  const s = selected();
  if (!s) return;
  pushUndo();
  S.shapes = [...S.shapes.filter((v) => v !== s), s];
  requestDraw();
}

function nudge(dx, dy) {
  const s = selected();
  if (!s) return;
  pushUndoCoalesced('nudge');
  moveShape(s, JSON.parse(JSON.stringify(s)), dx * S.k, dy * S.k);
  requestDraw();
}

function placeMini() {
  const mini = $('#mini');
  const s = selected();
  if (!s || act || textEdit || cropping()) { mini.style.display = 'none'; return; }
  const b = bbox(s);
  const tl = toScr(b.x, b.y), br = toScr(b.x + b.w, b.y + b.h);
  const r = stage.getBoundingClientRect();
  mini.style.display = 'flex';
  $('#mini-color').style.display = applies(s, 'color') ? '' : 'none';
  $('#mini-color .dot').style.background = s.color;
  const w = mini.offsetWidth, h = mini.offsetHeight;
  let left = br.x + 16;
  if (left + w > r.width - 8) left = tl.x - 16 - w;
  if (left < 8) left = clamp(br.x - w, 8, r.width - w - 8);
  const top = clamp((tl.y + br.y) / 2 - h / 2, 8, r.height - h - 60);
  mini.style.left = `${left}px`;
  mini.style.top = `${top}px`;
}

function closePops() {
  $('#mini-pal').classList.remove('open');
  $('#zoom-menu').classList.remove('open');
}

// ---- Keyboard ------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.target === ta) return;
  const key = e.key.toLowerCase();
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === ' ' && !meta) {
    if (!spaceDown) { spaceDown = true; if (!act) canvas.style.cursor = 'grab'; }
    e.preventDefault();
    return;
  }
  if (meta) {
    if (key === 'z') e.shiftKey ? redo() : undo();
    else if (key === 'c') doCopy();
    else if (key === 's') e.shiftKey ? doSaveAs() : doSave();
    else if (key === 'd') duplicate();
    else if (key === '0') fit();
    else if (key === '1') zoomCentered(1 / S.k);
    else if (key === '=' || key === '+') zoomCentered(S.view.zoom * 1.25);
    else if (key === '-') zoomCentered(S.view.zoom / 1.25);
    else if (key === 'w') appWindow.close();
    else return;
    e.preventDefault();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    closePops();
    if (S.eyedrop) S.eyedrop = false;
    else if (cropping()) setTool(S.prevTool, { applyCrop: false });
    else S.sel = null;
    refreshUI();
    requestDraw();
    return;
  }
  if (e.key === 'Enter') {
    if (cropping()) setTool(S.prevTool);
    else if (selected() && selected().type === 'text') startTextEdit(selected());
    e.preventDefault();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selected()) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key.startsWith('Arrow') && selected()) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    nudge(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0);
    return;
  }
  if (e.altKey) return;
  if (/^[1-8]$/.test(e.key)) { setStyle('color', COLORS[Number(e.key) - 1][1]); return; }
  if (e.key === '[' || e.key === ']') { setStyle('stroke', clamp(current('stroke') + (e.key === ']' ? 1 : -1), 1, 16)); return; }
  const t = Object.keys(TOOLS).find((name) => TOOLS[name][1].toLowerCase() === key);
  if (t) setTool(t);
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    if (!act) canvas.style.cursor = '';
  }
});
window.addEventListener('blur', () => { spaceDown = false; });

// ---- Inspector & chrome --------------------------------------------------------------------

function buildChrome() {
  $('#undo').innerHTML = icon('undo');
  $('#redo').innerHTML = icon('redo');
  $('#zoom-chev').innerHTML = icon('chevron', 12, 2);
  $('#pin-top').innerHTML = icon('pin');
  $('#save-as').innerHTML = icon('folder');
  $('#save-ic').innerHTML = icon('save', 16, 1.9);
  $('#copy-ic').innerHTML = icon('copy', 16, 2);
  $('#mini-dup').innerHTML = icon('duplicate', 15, 1.9);
  $('#mini-front').innerHTML = icon('front', 15, 1.9);
  $('#mini-del').innerHTML = icon('trash', 15, 1.9);
  $('#eyedrop').innerHTML = `${icon('picker', 14, 1.9)}Pick from image`;
  $('#foot-ic').innerHTML = icon('checkCircle', 16, 2);

  const rail = $('#rail');
  for (const t of RAIL) {
    if (t === '|') { rail.insertAdjacentHTML('beforeend', '<div class="div"></div>'); continue; }
    const [name, key] = TOOLS[t];
    rail.insertAdjacentHTML('beforeend', `<button type="button" class="tool" data-tool="${t}" aria-label="${name} (${key})" title="${name} (${key})">${icon(t, 20)}</button>`);
  }
  rail.insertAdjacentHTML('beforeend', `<div class="spacer"></div><button type="button" class="tool recap" id="recapture" aria-label="Recapture" title="New capture">${icon('recapture', 20)}</button>`);
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) setTool(b.dataset.tool);
  });
  $('#recapture').addEventListener('click', () => invoke('start_capture_cmd', { mode: 'area' }));

  $('#swatches').innerHTML = COLORS.map(([n, hex]) => `<button type="button" class="swatch" data-color="${hex}" aria-label="${n}" title="${n}" style="background:${hex}"></button>`).join('')
    + '<label class="swatch custom" title="Custom color"><input type="color" id="custom-color" aria-label="Custom color"></label>';
  $('#swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) setStyle('color', b.dataset.color);
  });
  $('#custom-color').addEventListener('input', (e) => setStyle('color', e.target.value.toUpperCase()));
  $('#eyedrop').addEventListener('click', () => { S.eyedrop = !S.eyedrop; refreshUI(); });

  $('#strokes').innerHTML = STROKES.map(([w, label]) => `<button type="button" data-stroke="${w}" aria-label="${label} stroke" title="${label}"><span class="bar" style="height:${clamp(w, 2, 7)}px"></span></button>`).join('');
  $('#strokes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stroke]');
    if (b) setStyle('stroke', Number(b.dataset.stroke));
  });
  $('#stroke').addEventListener('input', (e) => setStyle('stroke', Number(e.target.value)));

  const seg = (list, attr) => list.map(([v, label]) => `<button type="button" data-${attr}="${v}">${label}</button>`).join('');
  $('#dashes').innerHTML = seg(DASHES, 'dash');
  $('#dashes').addEventListener('click', (e) => { const b = e.target.closest('[data-dash]'); if (b) setStyle('dash', b.dataset.dash); });
  $('#fills').innerHTML = seg(FILLS, 'fill');
  $('#fills').addEventListener('click', (e) => { const b = e.target.closest('[data-fill]'); if (b) setStyle('fill', b.dataset.fill); });
  $('#shadow').addEventListener('click', () => setStyle('shadow', !current('shadow')));

  $('#frames').innerHTML = FRAMES.map(([n, v, css]) => `<button type="button" data-frame="${v}" aria-label="${n}" title="${n}" style="background:${css || v}"></button>`).join('');
  $('#frames').addEventListener('click', (e) => {
    const b = e.target.closest('[data-frame]');
    if (!b) return;
    S.frame.bg = b.dataset.frame;
    S.frame.on = true;
    frameChanged();
  });
  $('#frame').addEventListener('click', () => { S.frame.on = !S.frame.on; frameChanged(); });
  $('#pad').addEventListener('input', (e) => { S.frame.pad = Number(e.target.value); S.frame.on = true; frameChanged(); });

  $('#mini-pal').innerHTML = COLORS.map(([n, hex]) => `<button type="button" data-color="${hex}" aria-label="${n}" style="background:${hex}"></button>`).join('');
  $('#mini-color').addEventListener('click', (e) => { e.stopPropagation(); $('#mini-pal').classList.toggle('open'); });
  $('#mini-pal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) { setStyle('color', b.dataset.color); $('#mini-pal').classList.remove('open'); }
  });
  $('#mini-dup').addEventListener('click', duplicate);
  $('#mini-front').addEventListener('click', bringToFront);
  $('#mini-del').addEventListener('click', deleteSelected);

  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#copy').addEventListener('click', doCopy);
  $('#save').addEventListener('click', doSave);
  $('#save-as').addEventListener('click', doSaveAs);
  $('#pin-top').addEventListener('click', async () => {
    S.pinned = !S.pinned;
    await appWindow.setAlwaysOnTop(S.pinned);
    refreshUI();
  });
  $('#zoom-btn').addEventListener('click', (e) => {
    const item = e.target.closest('[data-z]');
    if (item) {
      e.stopPropagation();
      const z = item.dataset.z;
      if (z === 'fit') fit(); else if (z === 'actual') zoomCentered(1 / S.k); else zoomCentered(Number(z));
      closePops();
      return;
    }
    $('#zoom-menu').classList.toggle('open');
  });
  $('#zoom-in').addEventListener('click', () => zoomCentered(S.view.zoom * 1.25));
  $('#zoom-out').addEventListener('click', () => zoomCentered(S.view.zoom / 1.25));
  $('#zoom-fit').addEventListener('click', fit);
  $('#crop-apply').addEventListener('click', () => setTool(S.prevTool));
  $('#crop-cancel').addEventListener('click', () => setTool(S.prevTool, { applyCrop: false }));
  $('#crop-reset').addEventListener('click', () => { S.cropDraft = full(); requestDraw(); refreshMeta(); });
  $('.insp-foot').addEventListener('click', () => { if (S.saved) invoke('reveal_capture', { id: CAPTURE_ID }); });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#mini') && !e.target.closest('#zoom-btn')) closePops();
  });
}

function frameChanged() {
  store('frame', S.frame);
  afterDocChange();
}

function refreshMeta() {
  if (!S.img) return;
  const b = cropping() ? S.cropDraft : contentRect();
  const edited = S.shapes.length > 0 || S.crop || S.frame.on;
  const k = Math.round(S.k * 100) / 100;
  $('#meta').textContent = `${Math.round(b.w)} × ${Math.round(b.h)} · @${k}x${edited ? ' · Edited' : ''}`;
}

function renderFoot() {
  const foot = $('#foot');
  if (S.saved) {
    foot.innerHTML = 'Saved · <b></b>';
    foot.querySelector('b').textContent = S.saved.replace(/^.*\//, '');
    $('.insp-foot').title = `${S.saved} — click to reveal in Finder`;
    $('.insp-foot').style.cursor = 'pointer';
  } else {
    foot.innerHTML = 'Auto-copied on capture · ⌘S saves to <b></b>';
    foot.querySelector('b').textContent = S.saveDir;
  }
}

function refreshUI() {
  const type = activeType();
  const uses = USES[type] ?? '';
  const sel = selected();

  for (const b of document.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool));
  const [name, key] = TOOLS[type] || TOOLS[S.tool];
  $('#tool-name').textContent = sel ? `${name}` : TOOLS[S.tool][0];
  $('#tool-key').textContent = sel ? key : TOOLS[S.tool][1];

  $('#sec-color').hidden = !uses.includes('color');
  $('#sec-stroke').hidden = !uses.includes('stroke');
  $('#sec-dash').hidden = !uses.includes('dash');
  $('#sec-fill').hidden = !uses.includes('fill');
  $('#shadow').hidden = !uses.includes('shadow');
  $('#shadow').style.display = uses.includes('shadow') ? '' : 'none';

  const color = current('color');
  $('#hex').textContent = color.toUpperCase();
  for (const b of document.querySelectorAll('#swatches [data-color]')) {
    const on = b.dataset.color.toUpperCase() === color.toUpperCase();
    const ring = b.dataset.color === '#111113' ? '#ECECEF' : b.dataset.color;
    b.style.boxShadow = on ? `0 0 0 2px var(--panel), 0 0 0 4px ${ring}` : 'inset 0 0 0 1px rgba(255,255,255,0.14)';
    b.setAttribute('aria-pressed', String(on));
  }
  $('#eyedrop').classList.toggle('on', S.eyedrop);

  const stroke = current('stroke');
  $('#stroke-lbl').textContent = type === 'text' || type === 'step' ? 'Size' : type === 'blur' ? 'Block size' : 'Stroke';
  $('#stroke-val').textContent = `${stroke} px`;
  $('#stroke').value = stroke;
  for (const b of document.querySelectorAll('#strokes button')) b.setAttribute('aria-pressed', String(Number(b.dataset.stroke) === stroke));
  for (const b of document.querySelectorAll('#dashes button')) b.setAttribute('aria-pressed', String(b.dataset.dash === current('dash')));
  for (const b of document.querySelectorAll('#fills button')) b.setAttribute('aria-pressed', String(b.dataset.fill === current('fill')));
  const shadow = !!current('shadow');
  $('#shadow .switch').classList.toggle('on', shadow);
  $('#shadow').setAttribute('aria-checked', String(shadow));

  $('#frame .switch').classList.toggle('on', S.frame.on);
  $('#frame').setAttribute('aria-checked', String(S.frame.on));
  for (const b of document.querySelectorAll('#frames button')) {
    const on = b.dataset.frame === S.frame.bg;
    b.style.boxShadow = on ? `0 0 0 2px var(--panel), 0 0 0 4px ${ACCENT}` : 'inset 0 0 0 1px rgba(255,255,255,0.12)';
  }
  $('#pad').value = S.frame.pad;
  $('#pad-val').textContent = `${S.frame.pad} px`;

  $('#undo').disabled = !S.undo.length;
  $('#redo').disabled = !S.redo.length;
  $('#pin-top').classList.toggle('on', S.pinned);

  $('#hint').textContent = S.eyedrop ? 'Click anywhere on the screenshot to pick its color · Esc to cancel' : TOOLS[S.tool][2];
  const n = S.shapes.length;
  $('#counts').textContent = `${n} annotation${n === 1 ? '' : 's'}${sel ? ' · 1 selected' : ''}`;
  refreshMeta();
}

// ---- Boot --------------------------------------------------------------------------------------

async function init() {
  buildChrome();
  try {
    S.info = await invoke('capture_info', { id: CAPTURE_ID });
    S.img = await createImageBitmap(pngBlob(await invoke('capture_image', { id: CAPTURE_ID })));
  } catch (e) {
    $('#name').textContent = 'Capture unavailable';
    $('#hint').textContent = String(e);
    return;
  }
  S.W = S.img.width;
  S.H = S.img.height;
  S.k = S.info.scale > 0 ? S.info.scale : 1;
  S.saved = S.info.saved;
  $('#name').textContent = S.info.name;
  document.title = S.info.name;
  invoke('save_dir_label').then((d) => { S.saveDir = d; renderFoot(); });
  renderFoot();
  new ResizeObserver(resize).observe(stage);
  resize();
  refreshUI();
}

init();
