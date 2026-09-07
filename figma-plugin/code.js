// HTML to Figma Importer — plugin main thread.
// Receives the parsed .h2f document from the UI (images already decoded to
// Uint8Array) and rebuilds it as Figma frames, text and image fills.

figma.showUI(__html__, { width: 400, height: 480, themeColors: true });

let fontIndex = null;     // Map<lowercased family, {family, styles: string[]}>
const loadedFonts = new Set();
const failedFonts = new Set();
let imageHashes = {};
let svgImages = {};
let builtCount = 0;

// Settings live in clientStorage, which is per-user and local to this machine.
// Deliberately not setPluginData: that rides along inside the .fig file, so a
// shared document would hand everyone the password.
const SETTINGS_KEY = 'h2f.settings';
const DEFAULT_SETTINGS = { server: 'http://localhost:8787', password: '' };

async function loadSettings() {
  try {
    const s = await figma.clientStorage.getAsync(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, s || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

figma.ui.onmessage = async (msg) => {
  if (!msg) return;
  if (msg.type === 'close') { figma.closePlugin(); return; }

  if (msg.type === 'getSettings') {
    post('settings', '', { settings: await loadSettings() });
    return;
  }

  if (msg.type === 'saveSettings') {
    const s = {
      server: String((msg.settings && msg.settings.server) || '').trim() || DEFAULT_SETTINGS.server,
      password: String((msg.settings && msg.settings.password) || '')
    };
    try {
      await figma.clientStorage.setAsync(SETTINGS_KEY, s);
      post('settingsSaved', 'Saved on this computer.', { settings: s });
    } catch (e) {
      post('settingsSaved', '', { error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === 'import') {
    try {
      await importDoc(msg.doc);
    } catch (e) {
      post('error', String((e && e.message) || e));
    }
  }
};

function post(type, message, extra) {
  figma.ui.postMessage(Object.assign({ type, message }, extra || {}));
}

// ------------------------------------------------------------------ import

async function importDoc(doc) {
  if (!doc || doc.format !== 'h2f' || !doc.root) throw new Error('Not a valid .h2f capture file.');
  builtCount = 0;
  imageHashes = {};
  svgImages = {};

  post('status', 'Indexing available fonts…');
  const fonts = await figma.listAvailableFontsAsync();
  fontIndex = new Map();
  for (const f of fonts) {
    const key = f.fontName.family.toLowerCase();
    let entry = fontIndex.get(key);
    if (!entry) { entry = { family: f.fontName.family, styles: [] }; fontIndex.set(key, entry); }
    entry.styles.push(f.fontName.style);
  }
  await ensureFont({ family: 'Inter', style: 'Regular' });

  post('status', 'Registering images…');
  const images = doc.images || {};
  let i = 0;
  for (const id of Object.keys(images)) {
    const item = images[id];
    if (item.kind === 'svg' && item.text) {
      svgImages[id] = item.text;
    } else if (item.bytes && item.bytes.length) {
      try {
        imageHashes[id] = figma.createImage(item.bytes).hash;
      } catch (e) { /* unsupported image — leave a plain frame */ }
    }
    if (++i % 10 === 0) {
      post('status', 'Registering images… ' + i);
      await tick();
    }
  }

  post('status', 'Building layers…');
  const rootData = doc.root;
  const root = figma.createFrame();
  root.name = (doc.meta && doc.meta.title) || rootData.name || 'Imported page';
  root.resizeWithoutConstraints(Math.max(1, rootData.rect.w), Math.max(1, rootData.rect.h));
  root.x = Math.round(figma.viewport.center.x - rootData.rect.w / 2);
  root.y = Math.round(figma.viewport.center.y - rootData.rect.h / 2);
  root.clipsContent = true;
  applyElementStyle(root, rootData.style || {});
  figma.currentPage.appendChild(root);

  const total = doc.nodeCount || 0;
  for (const child of rootData.children || []) {
    await buildNode(child, root, 0, 0, total);
  }

  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  let summary = 'Imported ' + builtCount + ' layers.';
  const warnings = (doc.warnings || []).slice();
  if (failedFonts.size) {
    warnings.push('missing fonts replaced with Inter: ' + [...failedFonts].slice(0, 6).join(', '));
  }
  post('done', summary, { warnings });
  figma.notify('HTML import done — ' + builtCount + ' layers');
}

async function buildNode(n, parent, px, py, total) {
  if (!n || !n.rect) return;
  if (n.type === 'TEXT') {
    await buildText(n, parent, px, py);
  } else {
    await buildElement(n, parent, px, py, total);
  }
  builtCount++;
  if (builtCount % 150 === 0) {
    post('status', 'Building layers… ' + builtCount + (total ? ' / ' + total : ''));
    await tick();
  }
}

async function buildElement(n, parent, px, py, total) {
  const w = Math.max(0.01, n.rect.w);
  const h = Math.max(0.01, n.rect.h);
  let node = null;

  if (n.svg) {
    try {
      node = figma.createNodeFromSvg(n.svg);
      node.name = n.name || 'svg';
      // A mask image carries no colour of its own — repaint it in the colour
      // the page was showing through it.
      if (n.svgTint) tintVectors(node, n.svgTint);
    } catch (e) { node = null; }
  }

  if (!node) {
    node = figma.createFrame();
    node.name = n.name || 'div';
    node.resizeWithoutConstraints(w, h);
    node.fills = [];
    applyElementStyle(node, n.style || {});
    applyImageFill(node, n);
  } else if (n.style && n.style.opacity !== undefined) {
    node.opacity = n.style.opacity;
  }

  parent.appendChild(node);
  node.x = n.rect.x - px;
  node.y = n.rect.y - py;

  // an <img>/<video>/background pointing at an SVG file becomes a vector child
  if (n.image && svgImages[n.image.ref]) {
    attachSvgChild(node, svgImages[n.image.ref], w, h);
  }
  if (n.style && n.style.bgImage && svgImages[n.style.bgImage.ref] && (!n.image || n.style.bgImage.ref !== n.image.ref)) {
    attachSvgChild(node, svgImages[n.style.bgImage.ref], w, h);
  }

  for (const child of n.children || []) {
    await buildNode(child, node, n.rect.x, n.rect.y, total);
  }
}

// Recolour every painted shape inside an imported SVG.
function tintVectors(node, c) {
  const paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a === undefined ? 1 : c.a };
  const walk = (nd) => {
    if ('fills' in nd) {
      const f = nd.fills;
      if (f !== figma.mixed && Array.isArray(f) && f.length) {
        nd.fills = f.map((x) => (x.type === 'SOLID' ? Object.assign({}, x, paint) : x));
      }
    }
    if ('strokes' in nd && Array.isArray(nd.strokes) && nd.strokes.length) {
      nd.strokes = nd.strokes.map((x) => (x.type === 'SOLID' ? Object.assign({}, x, paint) : x));
    }
    if ('children' in nd) nd.children.forEach(walk);
  };
  walk(node);
}

function attachSvgChild(parentFrame, svgText, w, h) {
  try {
    const v = figma.createNodeFromSvg(svgText);
    parentFrame.appendChild(v);
    const sx = v.width ? w / v.width : 1;
    const sy = v.height ? h / v.height : 1;
    const s = Math.min(sx, sy);
    if (s > 0 && isFinite(s) && Math.abs(s - 1) > 0.01) v.rescale(s);
    v.x = (w - v.width) / 2;
    v.y = (h - v.height) / 2;
  } catch (e) { /* bad svg — ignore */ }
}

// ------------------------------------------------------------------- styles

function applyElementStyle(node, st) {
  const fills = [];
  if (st.bg && st.bg.a > 0) fills.push(solidPaint(st.bg));
  if (st.gradient) {
    const g = gradientPaint(st.gradient);
    if (g) fills.push(g);
  }
  if (st.bgImage && imageHashes[st.bgImage.ref]) {
    fills.push({ type: 'IMAGE', imageHash: imageHashes[st.bgImage.ref], scaleMode: st.bgImage.mode || 'FILL' });
  }
  node.fills = fills;

  if (st.borders) {
    const sides = st.borders; // [top, right, bottom, left]
    const present = sides.filter(Boolean);
    if (present.length) {
      node.strokes = [solidPaint(present[0].c)];
      node.strokeAlign = 'INSIDE';
      const ws = sides.map((s) => (s ? s.w : 0));
      if (ws.every((x) => x === ws[0])) {
        node.strokeWeight = ws[0];
      } else {
        node.strokeTopWeight = ws[0];
        node.strokeRightWeight = ws[1];
        node.strokeBottomWeight = ws[2];
        node.strokeLeftWeight = ws[3];
      }
    }
  }

  if (st.radius) {
    node.topLeftRadius = st.radius[0] || 0;
    node.topRightRadius = st.radius[1] || 0;
    node.bottomRightRadius = st.radius[2] || 0;
    node.bottomLeftRadius = st.radius[3] || 0;
  }

  if (st.shadows && st.shadows.length) {
    node.effects = st.shadows.map((s) => ({
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a },
      offset: { x: s.x, y: s.y },
      radius: Math.max(0, s.blur),
      spread: s.spread || 0,
      visible: true,
      blendMode: 'NORMAL'
    }));
  }

  if (st.opacity !== undefined) node.opacity = st.opacity;
  node.clipsContent = !!st.clip;
}

function applyImageFill(node, n) {
  if (!n.image || !imageHashes[n.image.ref]) return;
  const fills = node.fills === figma.mixed ? [] : node.fills.slice();
  fills.push({ type: 'IMAGE', imageHash: imageHashes[n.image.ref], scaleMode: n.image.mode || 'FILL' });
  node.fills = fills;
}

function solidPaint(c) {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a === undefined ? 1 : c.a };
}

function gradientPaint(g) {
  const stops = (g.stops || []).map((s) => ({
    position: Math.min(1, Math.max(0, s.p || 0)),
    color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a === undefined ? 1 : s.c.a }
  }));
  if (stops.length < 2) return null;
  if (g.type === 'radial') {
    return { type: 'GRADIENT_RADIAL', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops };
  }
  if (g.type === 'conic') {
    return { type: 'GRADIENT_ANGULAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops };
  }
  // CSS: 0deg points up, clockwise. Figma linear runs along +x of gradient space.
  const rad = (((g.angle || 180) - 90) * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const gt = [
    [c, s, 0.5 - 0.5 * c - 0.5 * s],
    [-s, c, 0.5 + 0.5 * s - 0.5 * c]
  ];
  return { type: 'GRADIENT_LINEAR', gradientTransform: gt, gradientStops: stops };
}

// -------------------------------------------------------------------- text

async function buildText(n, parent, px, py) {
  const ts = n.style || {};
  const font = resolveFont(ts);
  await ensureFont(font);

  const t = figma.createText();
  parent.appendChild(t);
  try {
    t.fontName = loadedFonts.has(fontKey(font)) ? font : { family: 'Inter', style: 'Regular' };
  } catch (e) {
    t.fontName = { family: 'Inter', style: 'Regular' };
  }
  t.characters = transformText(n.text || '', ts.tt);
  t.fontSize = Math.max(1, ts.fs || 16);
  if (ts.lh) t.lineHeight = { unit: 'PIXELS', value: ts.lh };
  if (ts.ls) t.letterSpacing = { unit: 'PIXELS', value: ts.ls };
  if (ts.color) t.fills = [solidPaint(ts.color)];
  if (ts.td === 'U') t.textDecoration = 'UNDERLINE';
  else if (ts.td === 'S') t.textDecoration = 'STRIKETHROUGH';
  t.textAlignHorizontal = ts.ta === 'center' ? 'CENTER' : ts.ta === 'right' || ts.ta === 'end' ? 'RIGHT' : ts.ta === 'justify' ? 'JUSTIFIED' : 'LEFT';
  if (n.va === 'C') t.textAlignVertical = 'CENTER';
  // Each captured text node is one visual line, so let the box hug its glyphs.
  // A fixed-width box re-wraps as soon as the original font is substituted, and
  // the extra line lands on top of whatever sits below it.
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
  t.name = (n.text || 'text').slice(0, 40);
  t.x = n.rect.x - px;
  t.y = n.rect.y - py;

  // Auto-width grows to the right, so re-anchor non-left-aligned text to keep
  // it where the page had it.
  if (t.width > n.rect.w + 0.5) {
    if (t.textAlignHorizontal === 'RIGHT') t.x = (n.rect.x + n.rect.w - t.width) - px;
    else if (t.textAlignHorizontal === 'CENTER') t.x = (n.rect.x + n.rect.w / 2 - t.width / 2) - px;
  }
}

function transformText(text, tt) {
  if (tt === 'uppercase') return text.toUpperCase();
  if (tt === 'lowercase') return text.toLowerCase();
  if (tt === 'capitalize') return text.replace(/\b\w/g, (c) => c.toUpperCase());
  return text;
}

const GENERIC_FAMILIES = {
  'system-ui': 'Inter', '-apple-system': 'Inter', 'blinkmacsystemfont': 'Inter',
  'segoe ui': 'Inter', 'ui-sans-serif': 'Inter', 'sans-serif': 'Inter',
  'serif': 'Georgia', 'ui-serif': 'Georgia',
  'monospace': 'Roboto Mono', 'ui-monospace': 'Roboto Mono'
};

function resolveFont(ts) {
  const want = (ts.ff || 'Inter').trim();
  const wantLower = want.toLowerCase();
  const mapped = GENERIC_FAMILIES[wantLower] || want;
  const candidates = [mapped, want, 'Inter', 'Roboto', 'Arial', 'Helvetica'];
  let entry = null;
  for (const cand of candidates) {
    entry = fontIndex.get(String(cand).toLowerCase());
    if (entry) {
      if (!fontIndex.get(wantLower) && cand === 'Inter' && wantLower !== 'inter') failedFonts.add(want);
      break;
    }
  }
  if (!entry) return { family: 'Inter', style: 'Regular' };
  return { family: entry.family, style: pickStyle(entry.styles, ts.fw || 400, !!ts.it) };
}

const WEIGHT_KEYS = [
  ['extralight', 200], ['ultralight', 200], ['extrabold', 800], ['ultrabold', 800],
  ['semibold', 600], ['demibold', 600], ['hairline', 100],
  ['thin', 100], ['light', 300], ['medium', 500], ['bold', 700],
  ['black', 900], ['heavy', 900], ['regular', 400], ['normal', 400], ['book', 400]
];

function styleWeight(style) {
  const s = style.toLowerCase().replace(/[\s-]/g, '');
  for (const [k, w] of WEIGHT_KEYS) if (s.includes(k)) return w;
  return 400;
}

function pickStyle(styles, wantWeight, wantItalic) {
  let best = styles[0] || 'Regular';
  let bestScore = Infinity;
  for (const style of styles) {
    const s = style.toLowerCase();
    const italic = s.includes('italic') || s.includes('oblique');
    const score = Math.abs(styleWeight(style) - wantWeight) + (italic === wantItalic ? 0 : 1000);
    if (score < bestScore) { bestScore = score; best = style; }
  }
  return best;
}

function fontKey(f) { return f.family + '|' + f.style; }

async function ensureFont(font) {
  const key = fontKey(font);
  if (loadedFonts.has(key)) return true;
  try {
    await figma.loadFontAsync(font);
    loadedFonts.add(key);
    return true;
  } catch (e) {
    failedFonts.add(font.family);
    return false;
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
