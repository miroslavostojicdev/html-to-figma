// HTML to Figma — background service worker.
// Two jobs: run a capture at an exact CSS width (via the DevTools Protocol),
// and fetch image URLs on behalf of the content script (host_permissions
// bypass page CORS), re-encoding anything Figma can't ingest (webp/avif) to
// PNG and downsizing oversized bitmaps.

const MAX_DIM = 4000;      // Figma rejects images over 4096px on a side
const RETINA = 2;          // keep 2x the on-screen size so zooming stays crisp

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'H2F_FETCH_IMAGES' && Array.isArray(msg.items)) {
    fetchAll(msg.items).then(sendResponse).catch((e) => sendResponse({ __error: String(e) }));
    return true; // async response
  }
  if (msg && msg.type === 'H2F_RUN') {
    runCapture(msg.tabId, msg.options || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

// ----------------------------------------------------------- capture driver

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Render the page at an exact CSS width before measuring it.
// Without this the design arrives at whatever the browser window happens to be,
// and responsive sites serve a different layout per width — so "1920" has to
// actually mean 1920, not "1920 if your monitor is big enough".
async function runCapture(tabId, options) {
  const width = Math.round(Number(options.width) || 0);
  const target = { tabId };
  let attached = false;

  try {
    if (width > 0) {
      const height = Math.round(Number(options.height) || 1080);
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
      } catch (e) {
        return { ok: false, error: attachError(e) };
      }
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width, height,
        deviceScaleFactor: 1,
        mobile: !!options.mobile,
        screenWidth: width, screenHeight: height
      });
      // Media queries, responsive <img srcset> and JS resize handlers all need
      // a beat to react before anything is worth measuring.
      await sleep(600);
    }

    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const res = await chrome.tabs.sendMessage(tabId, { type: 'H2F_CAPTURE', options });
    return res || { ok: false, error: 'No response from the page.' };
  } finally {
    if (attached) {
      try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* tab may be gone */ }
      try { await chrome.debugger.detach(target); } catch (e) { /* already detached */ }
    }
  }
}

function attachError(e) {
  const m = String((e && e.message) || e);
  if (/already attached|Another debugger/i.test(m)) {
    return 'Chrome DevTools is open on this tab. Close it (or pick "Current window size") and try again.';
  }
  return 'Could not set the capture width: ' + m;
}

async function fetchAll(items) {
  const out = {};
  await Promise.all(items.map(async (it) => {
    out[it.key] = await fetchOne(it.url, it.w, it.h);
  }));
  return out;
}

async function fetchOne(url, displayW, displayH) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok && res.status !== 0) return { error: 'HTTP ' + res.status };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const blob = await res.blob();
    if (blob.size === 0) return { error: 'empty' };
    const isSvg = type.includes('svg') ||
      (url.startsWith('data:image/svg')) ||
      (!type && url.split('?')[0].toLowerCase().endsWith('.svg'));
    if (isSvg) {
      const text = await blob.text();
      if (text.length > 300000) return { error: 'svg-too-large' };
      return { kind: 'svg', text };
    }
    return await encodeBitmap(blob, type || blob.type || '', displayW, displayH);
  } catch (e) {
    return { error: String(e) };
  }
}

async function encodeBitmap(blob, type, displayW, displayH) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    return { error: 'decode-failed' };
  }
  try {
    const { width, height } = bmp;
    const scale = targetScale(width, height, displayW, displayH);
    const figmaNative = /png|jpe?g|gif/.test(type);
    if (scale >= 1 && figmaNative) {
      return { kind: 'bitmap', base64: await blobToBase64(blob), w: width, h: height };
    }
    const w = Math.max(1, Math.round(width * Math.min(1, scale)));
    const h = Math.max(1, Math.round(height * Math.min(1, scale)));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return { kind: 'bitmap', base64: await blobToBase64(png), w, h };
  } finally {
    bmp.close();
  }
}

// Scale factor to apply to the decoded image. >= 1 means "leave it alone".
// Photos are stored far larger than they are ever drawn — a 6000x4000 shot in a
// 366px carousel slide is ~40x more pixels than the design will ever show.
function targetScale(width, height, displayW, displayH) {
  let scale = 1;
  if (displayW > 0 && displayH > 0) {
    scale = Math.max((displayW * RETINA) / width, (displayH * RETINA) / height);
  }
  return Math.min(scale, MAX_DIM / width, MAX_DIM / height);
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
