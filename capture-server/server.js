#!/usr/bin/env node
// HTML to Figma — local capture service.
//
// Gives the Figma plugin a "paste a URL, pick a width, import" path. A Figma
// plugin cannot render a webpage itself: its sandbox has no DOM for the target
// page, cross-origin fetch from the plugin iframe is blocked, and a modern site
// renders nothing without running its JavaScript. So we drive a real Chrome over
// the DevTools Protocol and run the *same* content.js the Chrome extension uses,
// which keeps one serializer as the single source of truth.
//
// No npm dependencies: Node 22+ ships a global WebSocket, which is all CDP needs.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.H2F_PORT || 8787);
const EXT_DIR = path.join(__dirname, '..', 'chrome-extension');
const NAV_TIMEOUT = 45000;

// ------------------------------------------------------------------ chrome

function findChrome() {
  if (process.env.H2F_CHROME) return process.env.H2F_CHROME;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      path.join(la, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* keep looking */ }
  }
  return null;
}

let chromeProc = null;
let chromeWsUrl = null;
let profileDir = null;

async function launchChrome() {
  if (chromeWsUrl && chromeProc) return chromeWsUrl;
  const bin = findChrome();
  if (!bin) throw new Error('Could not find Chrome. Set H2F_CHROME to the full path of chrome.exe.');

  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2f-profile-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    '--hide-scrollbars',
    // This is a throwaway profile that only ever loads the page being captured.
    // Relaxing web security lets that page fetch its own images cross-origin,
    // exactly as the extension's service worker is able to.
    '--disable-web-security',
    '--allow-running-insecure-content',
    'about:blank'
  ];

  chromeProc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.on('exit', () => { chromeProc = null; chromeWsUrl = null; });

  chromeWsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start in time')), 20000);
    chromeProc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    chromeProc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return chromeWsUrl;
}

function shutdownChrome() {
  try { if (chromeProc) chromeProc.kill(); } catch (e) { /* already gone */ }
  chromeProc = null;
  chromeWsUrl = null;
  try { if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
process.on('exit', shutdownChrome);
process.on('SIGINT', () => { shutdownChrome(); process.exit(0); });
process.on('SIGTERM', () => { shutdownChrome(); process.exit(0); });

// --------------------------------------------------------------------- CDP

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        const list = this.handlers.get(m.method);
        if (list) list.forEach((fn) => fn(m.params));
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('CDP connection failed: ' + url)));
    });
  }

  send(method, params, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() { try { this.ws.close(); } catch (e) { /* already closed */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- capture

// Sensible viewport height per width, used when the caller only names a width.
const SIZES = {
  1920: 1080, 1600: 900, 1440: 900, 1366: 768, 1280: 800,
  1024: 768, 834: 1112, 768: 1024, 430: 932, 390: 844, 375: 812
};

async function capture(url, width, height, opts) {
  const browserWs = await launchChrome();
  const cdp = await CDP.connect(browserWs);
  let targetId = null;

  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = attached.sessionId;

    await cdp.send('Page.enable', {}, S);
    await cdp.send('Runtime.enable', {}, S);
    await cdp.send('Network.enable', {}, S);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
      screenWidth: width,
      screenHeight: height
    }, S);
    if (width < 600) {
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
      }, S);
    }

    // Navigate, then wait for the network to go quiet — a site that streams in
    // its content needs more than the load event before it is worth measuring.
    let inflight = 0;
    let lastActivity = Date.now();
    cdp.on('Network.requestWillBeSent', () => { inflight++; lastActivity = Date.now(); });
    const settle = () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); };
    cdp.on('Network.loadingFinished', settle);
    cdp.on('Network.loadingFailed', settle);

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    const nav = await cdp.send('Page.navigate', { url }, S);
    if (nav.errorText) throw new Error('Could not load the page: ' + nav.errorText);
    await Promise.race([loaded, sleep(NAV_TIMEOUT)]);

    const idleDeadline = Date.now() + 12000;
    while (Date.now() < idleDeadline) {
      if (inflight <= 0 && Date.now() - lastActivity > 800) break;
      await sleep(200);
    }

    // Run the extension's own serializer inside the page. background.js rides
    // along and is wired up through a chrome.runtime shim, so image fetching,
    // PNG re-encoding and downscaling behave exactly as they do in the extension.
    const contentJs = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
    const options = {
      mode: 'full',
      includeImages: opts.includeImages !== false,
      includeOffscreen: opts.includeOffscreen !== false,
      returnDoc: true
    };

    const bootstrap = [
      '(async () => {',
      '  const listeners = [];',
      '  window.chrome = { runtime: {',
      '    onMessage: { addListener: (fn) => listeners.push(fn) },',
      '    sendMessage: (msg) => new Promise((resolve) => { listeners[0](msg, null, resolve); })',
      '  }};',
      backgroundJs,
      '  ;window.__H2F_LOADED__ = false;',
      contentJs,
      '  ;const res = await new Promise((done) => listeners[1](',
      '    { type: "H2F_CAPTURE", options: ' + JSON.stringify(options) + ' }, null, done));',
      '  if (!res || !res.ok) throw new Error(res && res.error ? res.error : "capture failed");',
      '  return JSON.stringify(res.doc);',
      '})()'
    ].join('\n');

    const out = await cdp.send('Runtime.evaluate', {
      expression: bootstrap,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000
    }, S);

    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error('Capture failed in the page: ' +
        ((d.exception && d.exception.description) || d.text || 'unknown error'));
    }
    return JSON.parse(out.result.value);
  } finally {
    if (targetId) {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* tab already gone */ }
    }
    cdp.close();
  }
}

// -------------------------------------------------------------------- http

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

function json(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}

const truthy = (v) => v !== false && v !== 'false' && v !== '0';
let busy = false;

const handler = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'h2f-capture', port: PORT, busy });
  }
  if (u.pathname !== '/capture') {
    return json(res, 404, { ok: false, error: 'Not found. Use /capture or /health.' });
  }

  let params = Object.fromEntries(u.searchParams);
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      params = Object.assign(params, JSON.parse(Buffer.concat(chunks).toString() || '{}'));
    } catch (e) {
      return json(res, 400, { ok: false, error: 'Bad JSON body.' });
    }
  }

  let target = String(params.url || '').trim();
  if (!target) return json(res, 400, { ok: false, error: 'Missing "url".' });
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  try { new URL(target); } catch (e) {
    return json(res, 400, { ok: false, error: 'That is not a valid URL.' });
  }

  const width = Math.max(240, Math.min(3840, Math.round(Number(params.width) || 1920)));
  const height = Math.max(320, Math.min(2400, Math.round(Number(params.height) || SIZES[width] || 1080)));

  if (busy) {
    return json(res, 429, { ok: false, error: 'A capture is already running. Try again in a moment.' });
  }
  busy = true;
  const started = Date.now();
  console.log('[capture] ' + target + ' @ ' + width + 'x' + height);
  try {
    const doc = await capture(target, width, height, {
      includeImages: truthy(params.includeImages),
      includeOffscreen: truthy(params.includeOffscreen)
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const imgs = Object.keys(doc.images || {}).length;
    console.log('[capture] done in ' + secs + 's — ' + doc.nodeCount + ' layers, ' + imgs + ' images');
    json(res, 200, { ok: true, doc });
  } catch (e) {
    console.error('[capture] failed: ' + (e && e.message));
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  } finally {
    busy = false;
  }
};

// Bind both loopback stacks. Figma's plugin sandbox reaches us by the name
// "localhost", which on Windows commonly resolves to ::1 first — binding only
// 127.0.0.1 would leave that lookup refused. Loopback only, never 0.0.0.0: this
// service renders arbitrary URLs on request and must not be reachable from the
// network.
const HOSTS = ['127.0.0.1', '::1'];
let bound = 0;

function banner() {
  const chrome = findChrome();
  console.log('HTML to Figma capture service — http://localhost:' + PORT);
  console.log(chrome ? 'Chrome: ' + chrome : 'WARNING: no Chrome found — set H2F_CHROME to chrome.exe');
  console.log('Leave this running, then use "Import from URL" in the Figma plugin.');
}

for (const host of HOSTS) {
  const s = http.createServer(handler);
  s.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' is already in use. Set H2F_PORT to pick another.');
      process.exit(1);
    }
    // A machine without IPv6 simply has no ::1 to bind; the IPv4 listener carries it.
    if (e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') {
      console.error('listen ' + host + ': ' + e.message);
    }
  });
  s.listen(PORT, host, () => { if (bound++ === 0) banner(); });
}
