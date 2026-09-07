// HTML to Figma — popup logic.
// The capture itself is driven by the service worker: it owns the viewport
// override, so the debugger is always detached even if this popup closes.

const statusEl = document.getElementById('status');
const btnFull = document.getElementById('full');
const btnViewport = document.getElementById('viewport');
const chkImages = document.getElementById('images');
const chkOffscreen = document.getElementById('offscreen');
const selWidth = document.getElementById('width');

// Viewport heights to pair with each width. Height barely affects a full-page
// capture, but it decides how much lazy content loads per scroll step.
const HEIGHTS = { 1920: 1080, 1440: 900, 1280: 800, 1024: 768, 768: 1024, 390: 844 };

btnFull.addEventListener('click', () => run('full'));
btnViewport.addEventListener('click', () => run('viewport'));

function setStatus(html, cls) {
  statusEl.className = cls || '';
  statusEl.innerHTML = html;
}

function setBusy(b) {
  btnFull.disabled = b;
  btnViewport.disabled = b;
  selWidth.disabled = b;
}

async function run(mode) {
  const width = Number(selWidth.value) || 0;
  setBusy(true);
  setStatus(
    '<span class="spin"></span>Capturing at ' + (width ? width + 'px' : 'the current window size') +
    '… the page will scroll itself to load lazy images.'
  );
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');
    if (/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
      throw new Error('This page cannot be captured (browser-internal page).');
    }

    const res = await chrome.runtime.sendMessage({
      type: 'H2F_RUN',
      tabId: tab.id,
      options: {
        mode,
        includeImages: chkImages.checked,
        includeOffscreen: chkOffscreen.checked,
        width,
        height: HEIGHTS[width] || 1080,
        mobile: width > 0 && width < 600
      }
    });

    if (!res) throw new Error('No response from the page.');
    if (!res.ok) throw new Error(res.error || 'Capture failed.');

    const mb = (res.bytes / 1024 / 1024).toFixed(1);
    let msg = `Done — ${res.nodeCount} layers, ${res.imageCount} images (${mb} MB)`;
    if (res.pageSize) msg += `\nDesign size: ${res.pageSize.w} × ${res.pageSize.h}`;
    msg += `\nSaved to Downloads: ${res.filename}`;
    if (res.warnings && res.warnings.length) msg += '\nNote: ' + res.warnings.join('; ');
    setStatus(msg, 'ok');
  } catch (e) {
    let m = String((e && e.message) || e);
    if (m.includes('Cannot access') || m.includes('cannot be scripted')) {
      m = 'Chrome does not allow capturing this page (store/internal page).';
    }
    setStatus(m, 'err');
  } finally {
    setBusy(false);
  }
}
