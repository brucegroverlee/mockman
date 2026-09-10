/**
 * Minimal static server for verifying the interception engine in a real browser,
 * without needing the whole extension installed.
 *
 * Serves the built interceptor plus a test page, and a couple of *real* endpoints
 * so passthrough can be checked as well as mocking.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const HERE = import.meta.dirname;
const DIST = process.argv[2];
const PORT = 8899;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  /*
   * CORS, so the page can make a genuinely cross-origin request to itself.
   *
   * The page is served from 127.0.0.1 and fetches localhost — same server,
   * different origin — which is what makes the browser send a real preflight.
   * That matters: the interception path for a cross-origin call with a
   * preflight is not the same as for a same-origin one, and it is the shape
   * real apps actually use.
   */
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-force-preflight',
      'access-control-max-age': '0',
    });
    res.end();
    return;
  }

  if (path === '/api/cors') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ crossOrigin: true }));
    return;
  }
  if (path === '/api/cors-404') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ missing: true }));
    return;
  }

  // Real endpoints, to prove unmatched requests still reach the network.
  if (path === '/api/real') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ real: true, via: 'network' }));
    return;
  }
  if (path === '/api/xhr-real') {
    res.writeHead(201, { 'content-type': 'application/json', 'x-real-header': 'yes' });
    res.end(JSON.stringify({ xhrReal: true }));
    return;
  }

  try {
    let file;
    if (path.startsWith('/dist/')) {
      file = join(DIST, normalize(path.slice('/dist/'.length)));
    } else {
      file = join(HERE, path === '/' ? 'index.html' : normalize(path));
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
// No host, so both 127.0.0.1 and localhost reach it whichever family the
// resolver picks. The cross-origin check depends on being able to load the page
// from one and fetch the other.
}).listen(PORT, () => {
  console.log(`verify server on http://127.0.0.1:${PORT}`);
});
