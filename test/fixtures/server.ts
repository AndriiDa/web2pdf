/**
 * Static server for the integration-test fixture corpus (spec §37).
 *
 * Serves the pages in `pages/` plus generated SVG images, so the full pipeline
 * can run against real URLs in real Chromium without any external network
 * access. Bound to 127.0.0.1 only.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

// Resolved from the repo root rather than import.meta, so this file works
// under both the CJS transpilation Playwright uses and native ESM.
const PAGES_DIR = join(process.cwd(), 'test', 'fixtures', 'pages');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Generates a deterministic SVG placeholder, so fixtures have real images with
 * genuine intrinsic dimensions without committing binary files.
 */
function placeholderSvg(width: number, height: number, label: string, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 62%, 55%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 45) % 360}, 58%, 38%)"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <text x="50%" y="50%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(height / 8)}"
        text-anchor="middle" dominant-baseline="middle">${label}</text>
</svg>`;
}

/** Images referenced by the fixtures, generated on demand. */
const IMAGES: Record<string, { w: number; h: number; label: string; hue: number }> = {
  '/img/turbine.svg': { w: 900, h: 500, label: 'Turbine', hue: 200 },
  '/img/photo-a.svg': { w: 800, h: 260, label: 'Photo A', hue: 20 },
  '/img/photo-b.svg': { w: 800, h: 260, label: 'Photo B', hue: 140 },
  '/img/tall.svg': { w: 800, h: 2400, label: 'Very Tall', hue: 280 },
};

export function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    const image = IMAGES[pathname];
    if (image) {
      const svg = placeholderSvg(image.w, image.h, image.label, image.hue);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(svg);
      return;
    }

    const name = pathname === '/' ? '/article.html' : pathname;
    // Path traversal guard: only plain filenames from the fixtures directory.
    if (!/^\/[a-z0-9._-]+$/i.test(name)) {
      res.writeHead(400).end('bad request');
      return;
    }

    const filePath = join(PAGES_DIR, name);
    readFile(filePath)
      .then((content) => {
        const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
        res.end(content);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      });
  });
}

/** Starts the server on an ephemeral port and resolves its base URL. */
export async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createFixtureServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server failed to bind a port');
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function stopFixtureServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
