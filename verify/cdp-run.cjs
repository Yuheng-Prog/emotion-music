/**
 * 零依赖 CDP 驱动器（纯 node 内置模块，不依赖 ws / puppeteer）
 *
 * 用法: node verify/cdp-run.cjs <probe.js> <out.json> [--shot out.png] [--w 1600] [--h 1000] [--extra "a|b"]
 *
 *  - 启动本机 Chrome 无头实例并开启远程调试端口（默认 9333）
 *  - 打开 http://127.0.0.1:8787/
 *  - 把 probe.js 包进 async IIFE 里 Runtime.evaluate，await 其 Promise
 *  - 可选截图
 *  - 全程收集 console 日志、未捕获异常与网络失败
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const args = process.argv.slice(2);
const probeFile = args[0];
const outFile = args[1];
const shotIdx = args.indexOf('--shot');
const shotFile = shotIdx >= 0 ? args[shotIdx + 1] : null;
const vw = (() => {
  const i = args.indexOf('--w');
  return i >= 0 ? Number(args[i + 1]) : 1600;
})();
const vh = (() => {
  const i = args.indexOf('--h');
  return i >= 0 ? Number(args[i + 1]) : 1000;
})();
const extraIdx = args.indexOf('--extra');
const extraArgs = extraIdx >= 0 ? args[extraIdx + 1].split('|') : [];

const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Edge not found');
}

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/* ---------------- 最小 WebSocket 客户端 ---------------- */

class MiniWS {
  constructor(url) {
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    this.closed = false;
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    });
    this.req.on('upgrade', (res, socket) => {
      this.socket = socket;
      socket.on('data', (d) => this._onData(d));
      socket.on('close', () => {
        this.closed = true;
      });
      this.onopen && this.onopen();
    });
    this.req.on('error', (e) => this.onerror && this.onerror(e));
    this.req.end();
  }

  on(event, fn) {
    if (event === 'message') this.handlers.push(fn);
    else if (event === 'open') this.onopen = fn;
    else if (event === 'error') this.onerror = fn;
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x1) {
        const txt = payload.toString('utf8');
        if (fin) this.handlers.forEach((h) => h(txt));
      } else if (opcode === 0x8) {
        this.closed = true;
        try {
          this.socket.end();
        } catch {}
      } else if (opcode === 0x9) {
        this._frame(0xa, payload);
      }
    }
  }

  _frame(opcode, data) {
    const payload = Buffer.from(data);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch {}
  }

  send(text) {
    this._frame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try {
      this._frame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {}
  }
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const chrome = findChrome();
  const profileDir = path.join(os.tmpdir(), 'cdp-profile-' + Date.now());
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${vw},${vh}`,
      '--disable-gpu-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--enable-unsafe-swiftshader',
      ...extraArgs,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const report = { console: [], errors: [], failed: [] };

  try {
    let ver = null;
    for (let i = 0; i < 80; i++) {
      try {
        ver = JSON.parse(await httpGet('/json/version'));
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!ver) throw new Error('devtools not ready');
    report.browser = ver['Browser'];

    const targets = JSON.parse(await httpGet('/json/list'));
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');

    const ws = new MiniWS(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
      setTimeout(() => rej(new Error('ws open timeout')), 8000);
    });

    let msgId = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description ?? a.type))
          .join(' ');
        report.console.push(m.params.type + ': ' + txt);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        report.errors.push(
          m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown'
        );
      }
      if (m.method === 'Network.loadingFailed') {
        report.failed.push(m.params.errorText + ' / ' + (m.params.type || ''));
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, (m) =>
          m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)
        );
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: vw,
      height: vh,
      deviceScaleFactor: 1,
      mobile: false
    });

    await send('Page.navigate', { url: process.env.CDP_URL || 'http://127.0.0.1:8787/' });
    await sleep(2500);

    const src = fs.readFileSync(probeFile, 'utf8');
    const wrapped = `(async () => {\n${src}\n})()`;
    const evalRes = await send('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      timeout: 240000
    });

    if (evalRes.exceptionDetails) {
      report.probeError =
        evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text;
    } else {
      report.result = evalRes.result?.value;
    }

    if (shotFile) {
      await sleep(700);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
      report.screenshot = path.basename(shotFile);
    }

    ws.close();
  } catch (e) {
    report.fatal = e.message;
  } finally {
    try {
      child.kill();
    } catch {}
    await sleep(400);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }

  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  process.exit(0);
})();
