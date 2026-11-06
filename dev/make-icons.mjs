// Renders dev/icon.html in headless Chrome and writes icons/icon{16,32,48,128}.png.
// Usage: node dev/make-icons.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9371;
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sc-icons-'))}`], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let list;
  for (let i = 0; i < 50 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(100); } }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.navigate', { url: pathToFileURL(join(root, 'dev', 'icon.html')).href });
  await sleep(800);
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(icons)', returnByValue: true });
  const icons = JSON.parse(r.result.value);
  mkdirSync(join(root, 'icons'), { recursive: true });
  for (const [sz, url] of Object.entries(icons)) writeFileSync(join(root, 'icons', `icon${sz}.png`), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', Object.keys(icons).join(', '));
  ws.close();
} finally { proc.kill(); }
