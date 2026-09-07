// HTML to Figma — content script.
// Walks the rendered DOM, snapshots layout + computed styles into a JSON tree,
// asks the background worker to fetch/encode images, then downloads a gzipped
// .h2f file that the companion Figma plugin can import.
(() => {
  if (window.__H2F_LOADED__) return;
  window.__H2F_LOADED__ = true;

  const MAX_NODES = 12000;
  const MAX_IMAGE_B64 = 12 * 1024 * 1024;   // per image, after encoding
  const MAX_TOTAL_IMAGE_B64 = 120 * 1024 * 1024;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE', 'BASE',
    'HEAD', 'SOURCE', 'TRACK', 'PARAM', 'DATALIST', 'MAP', 'AREA', 'WBR', 'BR',
    'OBJECT', 'EMBED', 'COL', 'COLGROUP'
  ]);

  let busy = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'H2F_CAPTURE') {
      if (busy) { sendResponse({ ok: false, error: 'A capture is already running.' }); return; }
      busy = true;
      capture(msg.options || {})
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.stack) || e) }))
        .finally(() => { busy = false; });
      return true; // keep the message channel open for the async response
    }
  });

  // ---------------------------------------------------------------- colors

  const colorCanvas = document.createElement('canvas');
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });

  function parseColor(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (!str || str === 'none' || str === 'transparent') return null;
    let m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) return rgba(+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]);
    m = str.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/);
    if (m) return rgba(+m[1] / 255, +m[2] / 255, +m[3] / 255, pctOrNum(m[4]));
    m = str.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/);
    if (m) return rgba(+m[1], +m[2], +m[3], pctOrNum(m[4]));
    if (str[0] === '#') return hexColor(str);
    // Anything else (oklch, lab, named colors): let the canvas normalize it.
    try {
      colorCtx.fillStyle = '#000000';
      colorCtx.fillStyle = str;
      const v = colorCtx.fillStyle;
      if (v !== str) return parseColor(v);
    } catch (e) { /* ignore */ }
    return null;
  }

  function pctOrNum(s) {
    if (s === undefined) return 1;
    return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  }

  function hexColor(str) {
    let h = str.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return rgba(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
  }

  function rgba(r, g, b, a) {
    return { r: round4(r), g: round4(g), b: round4(b), a: round4(isNaN(a) ? 1 : a) };
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const round4 = (n) => Math.round(n * 10000) / 10000;

  // ---------------------------------------------------------- string utils

  function splitTopLevel(str, sep) {
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // ------------------------------------------------------------- gradients

  function parseGradient(str) {
    const m = str.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s);
    if (!m) return null;
    const kind = m[2];
    const args = splitTopLevel(m[3], ',');
    if (!args.length) return null;

    let angle = 180; // CSS default: to bottom
    let first = args[0];
    let stopArgs = args;

    if (kind === 'linear') {
      const ang = first.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/);
      if (ang) {
        const v = parseFloat(ang[1]);
        angle = ang[2] === 'deg' ? v
          : ang[2] === 'grad' ? v * 0.9
          : ang[2] === 'rad' ? (v * 180) / Math.PI
          : v * 360;
        stopArgs = args.slice(1);
      } else if (/^to\s/.test(first)) {
        const dirs = { top: 0, right: 90, bottom: 180, left: 270 };
        const words = first.replace(/^to\s+/, '').trim().split(/\s+/);
        if (words.length === 1) angle = dirs[words[0]] !== undefined ? dirs[words[0]] : 180;
        else {
          const map = { 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 };
          angle = map[words.join(' ')] !== undefined ? map[words.join(' ')] : 180;
        }
        stopArgs = args.slice(1);
      }
    } else if (!/^(rgb|hsl|#|color\(|[a-z]+\s*$)/i.test(first) || /\b(at|circle|ellipse|closest|farthest|from)\b/.test(first)) {
      // radial/conic geometry prelude — drop it
      if (!parseColor(splitTopLevel(first, ' ')[0])) stopArgs = args.slice(1);
    }

    const stops = [];
    for (const s of stopArgs) {
      const tokens = splitTopLevel(s, ' ');
      let color = null;
      const positions = [];
      for (const t of tokens) {
        if (/%$/.test(t)) positions.push(parseFloat(t) / 100);
        else if (/px$/.test(t) || /^-?[\d.]+(deg|turn|rad)$/.test(t)) positions.push(null);
        else {
          const c = parseColor(t);
          if (c) color = c;
        }
      }
      if (color) stops.push({ c: color, p: positions.length ? positions[0] : null });
    }
    if (stops.length < 2) return null;
    // fill in missing positions by linear interpolation
    if (stops[0].p === null) stops[0].p = 0;
    if (stops[stops.length - 1].p === null) stops[stops.length - 1].p = 1;
    let i = 0;
    while (i < stops.length) {
      if (stops[i].p === null) {
        let j = i;
        while (stops[j].p === null) j++;
        const prev = stops[i - 1].p, next = stops[j].p;
        for (let k = i; k < j; k++) stops[k].p = prev + ((next - prev) * (k - i + 1)) / (j - i + 1);
        i = j;
      } else i++;
    }
    let last = 0;
    for (const s of stops) { s.p = Math.min(1, Math.max(last, s.p)); last = s.p; }
    return { type: kind, angle: round2(angle), stops };
  }

  // --------------------------------------------------------------- shadows

  function parseShadows(str) {
    if (!str || str === 'none') return [];
    const out = [];
    for (const part of splitTopLevel(str, ',')) {
      const colorMatch = part.match(/rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-fA-F]{3,8}/);
      const color = colorMatch ? parseColor(colorMatch[0]) : rgba(0, 0, 0, 1);
      if (!color) continue;
      const rest = colorMatch ? part.replace(colorMatch[0], '') : part;
      const inset = /\binset\b/.test(rest);
      const lens = (rest.match(/-?[\d.]+(?:px)?/g) || []).map(parseFloat).filter((n) => !isNaN(n));
      if (lens.length < 2) continue;
      out.push({
        x: round2(lens[0]), y: round2(lens[1]),
        blur: round2(lens[2] || 0), spread: round2(lens[3] || 0),
        c: color, inset: inset || undefined
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- styles

  function sideBorder(cs, side) {
    const w = parseFloat(cs['border' + side + 'Width']);
    const style = cs['border' + side + 'Style'];
    if (!w || w <= 0 || style === 'none' || style === 'hidden') return null;
    const c = parseColor(cs['border' + side + 'Color']);
    if (!c || c.a === 0) return null;
    return { w: round2(w), c };
  }

  function radiusPx(value, rect) {
    if (!value) return 0;
    const v = parseFloat(value);
    if (isNaN(v) || v <= 0) return 0;
    if (String(value).includes('%')) return round2((Math.min(rect.width, rect.height) * v) / 100);
    return round2(v);
  }

  function bgSizeMode(bgSize) {
    if (/cover/.test(bgSize)) return 'FILL';
    if (/contain/.test(bgSize)) return 'FIT';
    return 'FILL';
  }

  function objectFitMode(fit) {
    if (fit === 'contain' || fit === 'scale-down') return 'FIT';
    if (fit === 'none') return 'CROP';
    return 'FILL';
  }

  function unquoteUrl(layer) {
    const m = layer.match(/^url\(\s*(['"]?)(.*?)\1\s*\)$/s);
    return m ? m[2] : null;
  }

  function firstMaskUrl(cs) {
    const raw = (cs.maskImage && cs.maskImage !== 'none') ? cs.maskImage
      : (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ? cs.webkitMaskImage : '';
    if (!raw) return null;
    return unquoteUrl(splitTopLevel(raw, ',')[0]);
  }

  function elementStyle(cs, rect, ctx, el) {
    const st = {};
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0) st.bg = bg;

    const bgi = cs.backgroundImage;
    if (bgi && bgi !== 'none') {
      const layer = splitTopLevel(bgi, ',')[0];
      const url = unquoteUrl(layer);
      if (url) {
        if (ctx.includeImages) {
          const ref = ctx.addImage(url, rect.width, rect.height);
          if (ref) st.bgImage = { ref, mode: bgSizeMode(cs.backgroundSize) };
        }
      } else if (layer.includes('gradient')) {
        const g = parseGradient(layer);
        if (g) st.gradient = g;
      }
    }

    // Icon systems routinely paint a flat colour through a mask image. Reading
    // only the colour turns every one of them into a solid square, so capture
    // the mask shape and carry the colour along as a tint instead.
    const maskRaw = firstMaskUrl(cs);
    if (maskRaw && ctx.includeImages) {
      const ref = ctx.addImage(maskRaw, rect.width, rect.height);
      if (ref) {
        st.mask = { ref, tint: st.bg || parseColor(cs.color) || rgba(0, 0, 0, 1) };
        delete st.bg; // the colour is only visible through the mask
      }
    }

    const borders = [sideBorder(cs, 'Top'), sideBorder(cs, 'Right'), sideBorder(cs, 'Bottom'), sideBorder(cs, 'Left')];
    if (borders.some(Boolean)) st.borders = borders;

    const rad = [
      radiusPx(cs.borderTopLeftRadius, rect), radiusPx(cs.borderTopRightRadius, rect),
      radiusPx(cs.borderBottomRightRadius, rect), radiusPx(cs.borderBottomLeftRadius, rect)
    ];
    if (rad.some((v) => v > 0)) st.radius = rad;

    const shadows = parseShadows(cs.boxShadow);
    if (shadows.length) st.shadows = shadows;

    const op = parseFloat(cs.opacity);
    if (!isNaN(op) && op < 1) st.opacity = round4(op);

    if (/(hidden|clip|auto|scroll)/.test(cs.overflow) || el.tagName === 'IMG' || el.tagName === 'VIDEO') st.clip = true;

    return st;
  }

  function textStyle(cs) {
    const dec = cs.textDecorationLine || cs.textDecoration || '';
    return {
      ff: firstFamily(cs.fontFamily),
      fs: round2(parseFloat(cs.fontSize) || 16),
      fw: parseInt(cs.fontWeight, 10) || 400,
      it: /italic|oblique/.test(cs.fontStyle) || undefined,
      lh: cs.lineHeight === 'normal' ? undefined : round2(parseFloat(cs.lineHeight)),
      ls: cs.letterSpacing === 'normal' ? undefined : round2(parseFloat(cs.letterSpacing) || 0),
      color: parseColor(cs.color) || rgba(0, 0, 0, 1),
      ta: cs.textAlign,
      td: /underline/.test(dec) ? 'U' : /line-through/.test(dec) ? 'S' : undefined,
      tt: cs.textTransform !== 'none' ? cs.textTransform : undefined,
      pre: /^pre/.test(cs.whiteSpace) || undefined
    };
  }

  function firstFamily(fontFamily) {
    const fam = splitTopLevel(fontFamily || '', ',')[0] || 'Inter';
    return fam.replace(/^['"]|['"]$/g, '').trim();
  }

  // ----------------------------------------------------------------- names

  function nameOf(el) {
    let n = el.tagName.toLowerCase();
    if (el.id) n += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) {
      n += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return n.slice(0, 60);
  }

  // ------------------------------------------------------------------- svg

  function svgMarkup(el, cs, rect) {
    try {
      const clone = el.cloneNode(true);
      clone.setAttribute('width', String(Math.max(1, Math.round(rect.width))));
      clone.setAttribute('height', String(Math.max(1, Math.round(rect.height))));
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      let s = new XMLSerializer().serializeToString(clone);
      const color = cs.color || 'rgb(0, 0, 0)';
      s = s.replace(/currentColor/g, color);
      if (s.length > 200000) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------ composed DOM

  function compChildren(el) {
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (el.tagName === 'SLOT') {
      try {
        const assigned = el.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      } catch (e) { /* ignore */ }
    }
    return Array.from(el.childNodes);
  }

  // ----------------------------------------------------------------- inputs

  function inputText(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return { text: (opt && opt.textContent.trim()) || '', placeholder: false };
    }
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio', 'hidden', 'file', 'image', 'range', 'color'].includes(type)) return null;
      if (type === 'password' && el.value) return { text: '•'.repeat(el.value.length), placeholder: false };
      if (el.value) return { text: el.value, placeholder: false };
      if (el.placeholder) return { text: el.placeholder, placeholder: true };
      return null;
    }
    if (tag === 'TEXTAREA') {
      if (el.value) return { text: el.value, placeholder: false };
      if (el.placeholder) return { text: el.placeholder, placeholder: true };
    }
    return null;
  }

  // ------------------------------------------------------------------ clip

  // Culling is done against a *clip rectangle*, not the element's own box.
  // A carousel track is the motivating case: the sliding list is shifted far
  // off-screen by a transform, but its slides paint inside the track's window.
  // Judging the list by its own box would drop every slide with it.

  function intersects(box, clip) {
    return box.x + box.w > clip.x + 0.5 && box.y + box.h > clip.y + 0.5 &&
           box.x < clip.x + clip.w - 0.5 && box.y < clip.y + clip.h - 0.5;
  }

  // Clip applied to an element's descendants. Empty result ⇒ nothing inside
  // this element can be visible, so the whole subtree is safe to drop.
  function clipForChildren(cs, box, clip, ctx) {
    const clipX = cs.overflowX !== 'visible';
    const clipY = cs.overflowY !== 'visible';
    if (!clipX && !clipY) return clip;
    let { x, y, w, h } = clip;
    if (clipX) {
      const l = Math.max(x, box.x), r = Math.min(x + w, box.x + box.w);
      x = l; w = r - l;
    }
    if (clipY) {
      const t = Math.max(y, box.y), b = Math.min(y + h, box.y + box.h);
      y = t; h = b - t;
    }
    if (w <= 0 || h <= 0) return { x, y, w, h };
    // "Include off-screen slides" widens each clip window so that carousel
    // slides parked outside it still come through (Figma clips them anyway).
    const s = ctx.slack;
    return s ? { x: x - s, y: y - s, w: w + 2 * s, h: h + 2 * s } : { x, y, w, h };
  }

  // ------------------------------------------------------------------ walk

  function serializeElement(el, ctx, clip) {
    const out = [];
    if (!el || !el.tagName || SKIP_TAGS.has(el.tagName)) return out;
    if (el.tagName === 'IFRAME') { ctx.warn('iframes are skipped (cross-document)'); return out; }
    if (ctx.count >= MAX_NODES) { ctx.truncated = true; return out; }

    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return out; }
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return out;

    if (cs.display === 'contents') {
      for (const child of compChildren(el)) {
        if (child.nodeType === Node.ELEMENT_NODE) out.push(...serializeElement(child, ctx, clip));
      }
      return out;
    }

    const r = el.getBoundingClientRect();
    const x = r.left + ctx.sx - ctx.box.x;
    const y = r.top + ctx.sy - ctx.box.y;
    const box = { x, y, w: r.width, h: r.height };

    // Descendants are confined to this; if it collapses, the subtree is invisible.
    const childClip = clipForChildren(cs, box, clip, ctx);
    if (childClip.w <= 0 || childClip.h <= 0) return out;
    const visible = intersects(box, clip);

    // screen-reader-only pattern: 1x1 clipped box
    if (r.width <= 1 && r.height <= 1 && (cs.overflow.includes('hidden') || cs.clipPath !== 'none' || (cs.clip && cs.clip !== 'auto'))) return out;

    if (el instanceof SVGSVGElement) {
      if (!visible) return out;
      const svg = svgMarkup(el, cs, r);
      if (svg) {
        ctx.count++;
        out.push({ type: 'ELEMENT', name: nameOf(el), rect: rect4(x, y, r), svg, style: pickOpacity(cs) });
      }
      return out;
    }
    if (el instanceof SVGElement) return out; // inner svg elements ride along with their root

    const node = {
      type: 'ELEMENT',
      name: nameOf(el),
      rect: rect4(x, y, r),
      style: elementStyle(cs, r, ctx, el),
      children: []
    };
    ctx.count++;

    // media
    const tag = el.tagName;
    if (tag === 'IMG' && ctx.includeImages) {
      const src = el.currentSrc || el.src;
      if (src) {
        const ref = ctx.addImage(src, r.width, r.height);
        if (ref) node.image = { ref, mode: objectFitMode(cs.objectFit) };
      }
    } else if (tag === 'CANVAS' && ctx.includeImages) {
      try {
        const du = el.toDataURL('image/png');
        const ref = ctx.addImage(du, r.width, r.height);
        if (ref) node.image = { ref, mode: 'FILL' };
      } catch (e) { ctx.warn('a canvas was tainted and could not be captured'); }
    } else if (tag === 'VIDEO' && ctx.includeImages && el.poster) {
      const ref = ctx.addImage(el.poster, r.width, r.height);
      if (ref) node.image = { ref, mode: 'FILL' };
    }

    // form controls render their value as synthetic text
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const it = inputText(el);
      if (it && it.text) {
        const ts = textStyle(cs);
        if (it.placeholder) {
          try {
            const pc = parseColor(getComputedStyle(el, '::placeholder').color);
            if (pc) ts.color = pc;
          } catch (e) { /* ignore */ }
        }
        const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) || 0;
        const padR = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth) || 0;
        node.children.push({
          type: 'TEXT',
          text: it.text,
          rect: { x: round2(x + padL), y: round2(y), w: round2(Math.max(4, r.width - padL - padR)), h: round2(r.height) },
          style: ts,
          va: tag === 'TEXTAREA' ? undefined : 'C'
        });
        ctx.count++;
      }
      out.push(node);
      return out; // never recurse into form controls
    }

    // children (composed tree: pierces open shadow roots and slots)
    const ts = textStyle(cs);
    for (const child of compChildren(el)) {
      if (ctx.count >= MAX_NODES) { ctx.truncated = true; break; }
      if (child.nodeType === Node.TEXT_NODE) {
        node.children.push(...serializeTextNode(child, ts, ctx, childClip));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        node.children.push(...serializeElement(child, ctx, childClip));
      }
    }

    // An off-screen element is kept only as a container for visible descendants
    // (this is what carries a shifted carousel track and its slides).
    if (!visible && !node.children.length) { ctx.count--; return out; }

    // prune invisible empty wrappers
    const st = node.style;
    const paints = st.bg || st.gradient || st.bgImage || st.mask || st.borders || st.shadows || node.image || node.svg;
    if (!paints && !node.children.length) { ctx.count--; return out; }

    out.push(node);
    return out;
  }

  function serializeTextNode(textNode, ts, ctx, clip) {
    const raw = textNode.nodeValue;
    if (!raw || !raw.trim()) return [];
    let range;
    try {
      range = document.createRange();
      range.selectNodeContents(textNode);
    } catch (e) { return []; }

    // Multi-line text is emitted one node per visual line. The browser has
    // already decided where every line breaks; a single fixed-size Figma text
    // box would re-wrap that text differently once the original font is
    // substituted, and collide with whatever sits below it.
    const rects = range.getClientRects();
    if (rects.length > 1 && raw.length <= 3000 && !ts.pre) {
      const out = [];
      for (const line of splitByLine(textNode, raw)) {
        const n = textNodeFrom(line.text, line.rect, ts, ctx, clip);
        if (n) out.push(n);
      }
      if (out.length) return out;
    }

    const n = textNodeFrom(ts.pre ? raw : raw.replace(/\s+/g, ' ').trim(),
                           range.getBoundingClientRect(), ts, ctx, clip);
    return n ? [n] : [];
  }

  function textNodeFrom(text, r, ts, ctx, clip) {
    if (!text || !text.trim()) return null;
    if (r.width < 0.5 || r.height < 0.5) return null;
    const x = r.left + ctx.sx - ctx.box.x;
    const y = r.top + ctx.sy - ctx.box.y;
    if (!intersects({ x, y, w: r.width, h: r.height }, clip)) return null;
    ctx.count++;
    return { type: 'TEXT', text, rect: rect4(x, y, r), style: ts };
  }

  // Group the characters of a text node by the line box they landed on.
  function splitByLine(textNode, raw) {
    const r = document.createRange();
    const lines = [];
    let cur = null;
    for (let i = 0; i < raw.length; i++) {
      let rc;
      try {
        r.setStart(textNode, i);
        r.setEnd(textNode, i + 1);
        rc = r.getBoundingClientRect();
      } catch (e) { continue; }
      // a space swallowed by the line break has no box of its own
      if (!rc.width && !rc.height) { if (cur) cur.text += raw[i]; continue; }
      if (!cur || Math.abs(rc.top - cur.top) > Math.max(2, rc.height * 0.5)) {
        cur = { text: raw[i], left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom };
        lines.push(cur);
      } else {
        cur.text += raw[i];
        cur.left = Math.min(cur.left, rc.left);
        cur.top = Math.min(cur.top, rc.top);
        cur.right = Math.max(cur.right, rc.right);
        cur.bottom = Math.max(cur.bottom, rc.bottom);
      }
    }
    return lines
      .map((l) => ({
        text: l.text.replace(/\s+/g, ' ').trim(),
        rect: { left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }
      }))
      .filter((l) => l.text);
  }

  function rect4(x, y, r) {
    return { x: round2(x), y: round2(y), w: round2(Math.max(0, r.width)), h: round2(Math.max(0, r.height)) };
  }

  function pickOpacity(cs) {
    const op = parseFloat(cs.opacity);
    return !isNaN(op) && op < 1 ? { opacity: round4(op) } : {};
  }

  // --------------------------------------------------------------- preload

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Lazy images only load once they scroll into view, and a sticky header that
  // is currently "stuck" measures at the wrong offset. Walk the page once, then
  // return to the top so every rect is read from a settled, scroll-zero state.
  async function preloadPage(maxMs) {
    const t0 = Date.now();
    const docEl = document.documentElement;
    const pageH = () => Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const step = Math.max(200, Math.round(window.innerHeight * 0.8));
    for (let y = 0; y < pageH() && Date.now() - t0 < maxMs; y += step) {
      window.scrollTo(0, y);
      await sleep(100);
    }
    window.scrollTo(0, pageH());
    await sleep(200);
    window.scrollTo(0, 0);
    await sleep(350); // let sticky/fixed headers unstick before we measure

    // Wait on stragglers, but briefly: a single image that never resolves
    // (no src, blocked, or a tracking pixel) must not hold the whole capture
    // hostage for the rest of the budget.
    const pending = [...document.images].filter((i) => !i.complete && i.getAttribute('src'));
    if (pending.length) {
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((done) => {
          i.addEventListener('load', done, { once: true });
          i.addEventListener('error', done, { once: true });
        }))),
        sleep(Math.min(3000, Math.max(0, maxMs - (Date.now() - t0))))
      ]);
    }
    await sleep(100);
  }

  // ---------------------------------------------------------------- capture

  async function capture(options) {
    const mode = options.mode === 'viewport' ? 'viewport' : 'full';
    const includeImages = options.includeImages !== false;

    // A full-page capture is measured from the top with everything loaded;
    // a viewport capture has to leave the user where they are.
    if (mode === 'full' && options.preload !== false) await preloadPage(20000);

    const docEl = document.documentElement;
    const pageW = Math.max(docEl.scrollWidth, docEl.clientWidth);
    const pageH = Math.max(docEl.scrollHeight, docEl.clientHeight);
    const sx = window.scrollX, sy = window.scrollY;

    const ctx = {
      sx, sy,
      box: mode === 'viewport'
        ? { x: sx, y: sy, w: window.innerWidth, h: window.innerHeight }
        : { x: 0, y: 0, w: pageW, h: pageH },
      includeImages,
      // How far outside each clip window to keep going. 0 captures exactly what
      // is visible; a positive value pulls in the parked slides of carousels.
      slack: options.includeOffscreen ? 8000 : 0,
      count: 0,
      truncated: false,
      imageIds: new Map(),
      imageSizes: new Map(),
      warnings: new Set(),
      addImage(url, dw, dh) {
        try { url = new URL(url, location.href).href; } catch (e) { return null; }
        if (!/^(https?|data|blob):/.test(url)) return null;
        let id = this.imageIds.get(url);
        if (!id) { id = 'img' + (this.imageIds.size + 1); this.imageIds.set(url, id); }
        // Remember the largest box the image is drawn in, so the fetcher can
        // downscale a 6000px photo that only ever renders at 366px.
        const w = Math.ceil(dw || 0), h = Math.ceil(dh || 0);
        const prev = this.imageSizes.get(url);
        if (!prev || w * h > prev.w * prev.h) this.imageSizes.set(url, { w, h });
        return id;
      },
      warn(msg) { this.warnings.add(msg); }
    };

    const bodyCs = getComputedStyle(document.body);
    const htmlCs = getComputedStyle(docEl);
    const rootBg = parseColor(htmlCs.backgroundColor) || parseColor(bodyCs.backgroundColor) || rgba(1, 1, 1, 1);
    if (rootBg.a === 0) { rootBg.r = 1; rootBg.g = 1; rootBg.b = 1; rootBg.a = 1; }

    const children = serializeElement(document.body, ctx, { x: 0, y: 0, w: ctx.box.w, h: ctx.box.h });
    if (ctx.truncated) ctx.warn('page truncated at ' + MAX_NODES + ' layers');

    // blob: URLs are only fetchable from the page itself — resolve them here
    const blobUrls = [...ctx.imageIds.keys()].filter((u) => u.startsWith('blob:'));
    const blobData = {};
    for (const u of blobUrls) {
      try {
        const b = await fetch(u).then((r) => r.blob());
        blobData[u] = await blobToDataUrl(b);
      } catch (e) { /* ignore */ }
    }

    // fetch + encode images via the background worker (bypasses page CORS)
    const images = {};
    let totalB64 = 0, imageErrors = 0;
    const urls = [...ctx.imageIds.keys()];
    for (let i = 0; i < urls.length; i += 4) {
      const originals = urls.slice(i, i + 4);
      const chunk = originals.map((u) => {
        const size = ctx.imageSizes.get(u) || { w: 0, h: 0 };
        return { url: blobData[u] || u, key: u, w: size.w, h: size.h };
      });
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'H2F_FETCH_IMAGES', items: chunk });
      } catch (e) { res = null; }
      for (let j = 0; j < originals.length; j++) {
        const item = res && res[originals[j]];
        const id = ctx.imageIds.get(originals[j]);
        if (!item || item.error) { imageErrors++; continue; }
        const size = item.base64 ? item.base64.length : (item.text ? item.text.length : 0);
        if (size > MAX_IMAGE_B64 || totalB64 + size > MAX_TOTAL_IMAGE_B64) {
          ctx.warn('some images were skipped to keep the file size manageable');
          continue;
        }
        totalB64 += size;
        images[id] = item;
      }
    }
    if (imageErrors) ctx.warn(imageErrors + ' image(s) could not be fetched');

    resolveMasks(children, images);

    const doc = {
      format: 'h2f',
      version: 1,
      meta: {
        url: location.href,
        title: document.title || location.hostname,
        capturedAt: new Date().toISOString(),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        mode
      },
      root: {
        type: 'ELEMENT',
        name: (document.title || location.hostname || 'Page').slice(0, 80),
        rect: { x: 0, y: 0, w: round2(ctx.box.w), h: round2(ctx.box.h) },
        style: { bg: rootBg, clip: true },
        children
      },
      images,
      nodeCount: ctx.count,
      warnings: [...ctx.warnings]
    };

    if (options.returnDoc) {
      // debug/testing path: hand the raw document back instead of downloading
      return { ok: true, nodeCount: ctx.count, imageCount: Object.keys(images).length, pageSize: { w: Math.round(ctx.box.w), h: Math.round(ctx.box.h) }, warnings: [...ctx.warnings], doc };
    }

    const gz = await gzipJson(doc);
    const host = (location.hostname || 'page').replace(/[^a-z0-9.-]/gi, '_');
    const filename = host + '_' + Math.round(ctx.box.w) + 'w_' + Date.now() + '.h2f';
    downloadBlob(gz, filename);

    return {
      ok: true,
      nodeCount: ctx.count,
      imageCount: Object.keys(images).length,
      bytes: gz.size,
      filename,
      pageSize: { w: Math.round(ctx.box.w), h: Math.round(ctx.box.h) },
      warnings: [...ctx.warnings]
    };
  }

  // A mask that resolved to SVG becomes a real vector the plugin can tint;
  // a raster mask falls back to its own shape, which is still far better than
  // the filled rectangle you get from the background colour alone.
  function resolveMasks(nodes, images) {
    for (const n of nodes) {
      const st = n.style;
      if (st && st.mask) {
        const item = images[st.mask.ref];
        if (item && item.kind === 'svg' && item.text) {
          n.svg = item.text;
          n.svgTint = st.mask.tint;
        } else if (item) {
          n.image = { ref: st.mask.ref, mode: 'FIT' };
        }
        delete st.mask;
      }
      if (n.children) resolveMasks(n.children, images);
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function gzipJson(obj) {
    const json = JSON.stringify(obj);
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).blob();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
})();
