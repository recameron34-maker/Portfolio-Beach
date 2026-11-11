/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts and the check; the shapes are written as JSDoc */
// A small static file server for the media scripts and the site check. It serves one directory
// under an optional base path (for example /portfolio-beach/), answers a real 404 for a file that
// is not there (so the check can see a broken link) and never leaves its root directory.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * @param {string} directory the folder to serve
 * @param {{ base?: string, port?: number }} [options] base is the path prefix the folder is served under
 * @returns {Promise<{ origin: string, url: string, hits: Map<string, number>, close: () => Promise<void> }>}
 */
export async function serveStatic(directory, options = {}) {
  const root = resolve(directory);
  const base = `/${(options.base ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  /** Path and status of every request, so a check can list what answered 404. */
  const hits = new Map();
  const server = createServer((req, res) => {
    const send = (status, file) => {
      hits.set(req.url ?? '', status);
      if (file === undefined) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(status === 404 ? 'Not found' : 'Bad request');
        return;
      }
      const size = statSync(file).size;
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      // Byte ranges, so a <video> element can seek as it does on a real static host.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range !== null && (range[1] !== '' || range[2] !== '')) {
        const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end =
          range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(status, {
        'content-type': type,
        'content-length': size,
        'accept-ranges': 'bytes',
      });
      createReadStream(file).pipe(res);
    };
    let path;
    try {
      path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]);
    } catch {
      send(400);
      return;
    }
    if (!path.startsWith(base)) {
      send(404);
      return;
    }
    let file = resolve(root, `.${sep}${path.slice(base.length)}`);
    if (file !== root && !file.startsWith(root + sep)) {
      send(404);
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      // What a static host with a 404 page does: the page, with the status.
      const notFound = join(root, '404.html');
      send(404, existsSync(notFound) ? notFound : undefined);
      return;
    }
    send(200, file);
  });
  await new Promise((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}${base}`,
    hits,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
