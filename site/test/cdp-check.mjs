// Run the browser self-check in headless Chromium and report what it printed.
//
//   node test/cdp-check.mjs            # serves dist/ itself
//
// Two things this does that `chromium --dump-dom` cannot. It waits for the page to actually
// finish - dump-dom snapshots at the load event, which is before the WASM codecs have even
// been fetched, so it always reports "running..." - and it surfaces console messages and
// uncaught exceptions, without which a module that fails to import looks identical to one
// that is merely slow.
//
// The static server runs inside this process and dies with it, so there is no stray listener
// to hunt down afterwards. Node's built-in WebSocket speaks DevTools; no dependency.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PATH = process.argv[2] ?? '/check/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, p);
  try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch {}
  try {
    statSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'favcon-cdp.'));
const PORT = 9333 + (process.pid % 500);
const chrome = spawn('chromium', [
  '--headless', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, base + PATH,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code, ...msg) => {
  try { chrome.kill(); } catch {}
  server.close();
  rmSync(profile, { recursive: true, force: true });
  for (const m of msg) if (m) console.log(m);
  process.exit(code);
};

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  await sleep(150);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* still coming up */ }
}
if (!target) finish(1, 'could not reach the browser');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const noise = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    noise.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    noise.push(`uncaught: ${d.exception?.description ?? d.text}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    noise.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  }
};
const send = (method, params) => new Promise((res) => {
  const n = ++id;
  pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send('Runtime.enable', {});
await send('Log.enable', {});
// The page may already have loaded and failed before the listeners attached, so reload now
// that they are on - otherwise an import error is invisible and looks like a hang.
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: false });

let text = '';
for (let i = 0; i < 400; i++) {                 // up to ~60 s; the 2.4 MB resvg wasm dominates
  const r = await send('Runtime.evaluate', {
    expression: "document.getElementById('out')?.textContent ?? ''", returnByValue: true,
  });
  text = r.result?.result?.value ?? '';
  if (/(^|\n)(OK|FAIL)/.test(text)) break;
  await sleep(150);
}
finish(/(^|\n)OK$/.test(text.trim()) ? 0 : 1,
       text || '(the page printed nothing)',
       noise.length ? '\n--- browser said ---\n' + noise.join('\n') : '');
