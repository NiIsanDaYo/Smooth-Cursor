// Static server for dev/test on two origins (127.0.0.1:8801 and :8802) for cross-origin iframes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'test');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.cur': 'image/x-icon' };
const handler = async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(root, p || 'index.html'));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'text/html; charset=utf-8' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
};
for (const port of [8801, 8802]) createServer(handler).listen(port, '127.0.0.1');
console.log('serving dev/test on http://127.0.0.1:8801 and :8802');
