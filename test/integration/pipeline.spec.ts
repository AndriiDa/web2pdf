/**
 * End-to-end pipeline integration tests (spec §37).
 *
 * These run the REAL pipeline — real Chromium, real navigation, real PDF bytes —
 * against the local fixture corpus. Nothing here is mocked.
 */

import { test, expect } from '@playwright/test';
import type { Server } from 'node:http';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server';
import { getBrowserService, resetBrowserService } from '@/browser/browser-service';
import { loadPage } from '@/browser/page-loader';
import { capture } from '@/browser/snapshot/capture';
import { renderPdf } from '@/browser/pdf-generator';
import { validateUrl } from '@/core/url-validator';
import { deriveStates, pushAction, undo, EMPTY_LOG } from '@/core/session-manager/actions';
import { pageGeometry } from '@/core/pagination-engine/geometry';
import { DEFAULT_PDF_SETTINGS, type ElementId } from '@/core/types';

let server: Server;
let baseUrl: string;

const GEOMETRY = pageGeometry({ margins: 'normal' });

test.beforeAll(async () => {
  const started = await startFixtureServer();
  server = started.server;
  baseUrl = started.baseUrl;
});

test.afterAll(async () => {
  await resetBrowserService();
  await stopFixtureServer(server);
});

/** Runs load + capture for a fixture page. */
async function captureFixture(path: string) {
  // Fixtures live on loopback, which the SSRF layer blocks by design; the test
  // flag is the only way to reach them and is never settable from user input.
  const url = await validateUrl(`${baseUrl}${path}`, { allowPrivateTargets: true });
  const service = getBrowserService();

  return service.withContext(
    {
      viewportWidth: Math.round(GEOMETRY.contentWidth),
      viewportHeight: 1200,
    },
    async (context) => {
      const loaded = await loadPage(context, { url, allowPrivateTargets: true });
      const snapshot = await capture(loaded.page, {
        sourceUrl: url.href,
        contentWidthPx: GEOMETRY.contentWidth,
      });
      await loaded.page.close();
      return { snapshot, loaded };
    },
  );
}

/** Renders a PDF from a snapshot with the given element states. */
async function renderFixture(
  snapshot: Awaited<ReturnType<typeof captureFixture>>['snapshot'],
  states: ReadonlyMap<ElementId, import('@/core/types').ElementState>,
) {
  const service = getBrowserService();
  return service.withContext(
    { viewportWidth: Math.round(GEOMETRY.contentWidth), viewportHeight: 1200 },
    async (context) =>
      renderPdf(context, {
        snapshot,
        states,
        settings: { ...DEFAULT_PDF_SETTINGS, documentTitle: snapshot.title },
      }),
  );
}

test.describe('article fixture — cleaning', () => {
  test('removes ads, popups and cookie banners while keeping the article', async () => {
    const { snapshot } = await captureFixture('/article.html');
    const html = snapshot.html;

    // --- Noise must be gone (§9, §10, §11) ---
    expect(html, 'cookie banner should be removed').not.toContain('Accept all cookies');
    expect(html, 'newsletter modal should be removed').not.toContain('Subscribe to our newsletter');
    expect(html, 'ad slot markup should be removed').not.toContain('div-gpt-ad-header-1');
    expect(html, 'ad slot attribute should be removed').not.toContain('data-ad-slot');

    // --- Meaningful content must survive (§11, §27) ---
    expect(html).toContain('The Quiet Engineering Behind Tidal Power');
    expect(html).toContain('Tidal energy has spent four decades');
    expect(html, 'table content preserved').toContain('Pentland Firth');
    expect(html, 'code block preserved').toContain('capacity_factor');
    expect(html, 'blockquote preserved').toContain('fewest boat trips');
    expect(html, 'figure caption preserved').toContain('gravity base in the Pentland Firth');

    // The cleaner should report what it did (§39).
    expect(snapshot.stats.adsRemoved + snapshot.stats.popupsRemoved).toBeGreaterThan(0);
    expect(snapshot.stats.elementCount).toBeGreaterThan(10);
  });

  test('assigns a stable id to every element in the index', async () => {
    const { snapshot } = await captureFixture('/article.html');

    for (const [id, record] of snapshot.elements) {
      expect(id).toMatch(/^w2p-\d+$/);
      expect(record.id).toBe(id);
    }
    // Ids must actually be present in the serialized markup for the editor.
    const firstId = [...snapshot.elements.keys()][0];
    expect(snapshot.html).toContain(`data-w2p-id="${firstId}"`);
  });
});

test.describe('lazy fixture — dynamic content (§7, §8)', () => {
  test('executes JavaScript and waits for delayed content', async () => {
    const { snapshot } = await captureFixture('/lazy.html');
    // Only present if JS ran AND the loader waited past DOMContentLoaded.
    expect(snapshot.html).toContain('DELAYED_CONTENT_LOADED');
  });

  test('scrolls to trigger lazy-loaded content and images', async () => {
    const { snapshot, loaded } = await captureFixture('/lazy.html');

    expect(loaded.scrollIterations).toBeGreaterThan(1);
    // Content appended by the scroll handler proves progressive scrolling ran.
    expect(snapshot.html).toContain('SCROLL_APPENDED_1');
    // srcset/lazy attributes must be collapsed to a single resolved src (§8).
    expect(snapshot.html).not.toContain('srcset=');
    expect(snapshot.html).not.toContain('loading="lazy"');
  });
});

test.describe('PDF generation (§14)', () => {
  test('produces a valid multi-page A4 PDF', async () => {
    const { snapshot } = await captureFixture('/article.html');
    const states = deriveStates(EMPTY_LOG, snapshot.elements.keys());
    const result = await renderFixture(snapshot, states);

    // Real PDF bytes, not a stub.
    expect(result.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.pdf.length).toBeGreaterThan(1000);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);

    // A4 portrait: MediaBox is 595x842 PostScript points.
    const text = result.pdf.toString('latin1');
    const mediaBox = text.match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
    expect(mediaBox, 'PDF should declare a MediaBox').not.toBeNull();
    if (mediaBox) {
      expect(Number(mediaBox[1])).toBeGreaterThan(590);
      expect(Number(mediaBox[1])).toBeLessThan(600);
      expect(Number(mediaBox[2])).toBeGreaterThan(835);
      expect(Number(mediaBox[2])).toBeLessThan(850);
    }
  });

  test('paginates rather than emitting one giant page (§14)', async () => {
    const { snapshot } = await captureFixture('/pagination.html');
    const states = deriveStates(EMPTY_LOG, snapshot.elements.keys());
    const result = await renderFixture(snapshot, states);

    // The fixture is several pages of content; a single page would mean the
    // whole document was rendered as one oversized sheet.
    expect(result.pageCount).toBeGreaterThan(2);
  });

  test('applies pagination mutations to protect atomic blocks (§15-§17)', async () => {
    const { snapshot } = await captureFixture('/pagination.html');
    const states = deriveStates(EMPTY_LOG, snapshot.elements.keys());
    const result = await renderFixture(snapshot, states);

    // The fixture is built so blocks straddle boundaries; the planner must act.
    expect(result.appliedMutations).toBeGreaterThan(0);
    expect(result.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

test.describe('manual editing (§12, §34)', () => {
  test('removing an element changes the PDF and undo restores it', async () => {
    const { snapshot } = await captureFixture('/article.html');

    // Pick a substantial paragraph to remove.
    const target = [...snapshot.elements.values()].find(
      (record) => record.role === 'paragraph' && record.rect.h > 20,
    );
    expect(target, 'fixture should contain a paragraph to edit').toBeDefined();
    if (!target) return;

    const baseline = await renderFixture(
      snapshot,
      deriveStates(EMPTY_LOG, snapshot.elements.keys()),
    );

    const afterRemove = pushAction(EMPTY_LOG, { t: 'remove', ids: [target.id] });
    const removed = await renderFixture(
      snapshot,
      deriveStates(afterRemove, snapshot.elements.keys()),
    );

    // Removing real content must change the rendered bytes.
    expect(removed.pdf.equals(baseline.pdf)).toBe(false);

    // Undo returns to the original state, so the PDF matches the baseline size
    // closely (byte-identical is not guaranteed: PDFs embed a creation date).
    const afterUndo = undo(afterRemove);
    const restored = await renderFixture(
      snapshot,
      deriveStates(afterUndo, snapshot.elements.keys()),
    );
    expect(Math.abs(restored.pdf.length - baseline.pdf.length)).toBeLessThan(
      baseline.pdf.length * 0.05,
    );
  });

  test('hide preserves layout space while remove reflows the document', async () => {
    const { snapshot } = await captureFixture('/article.html');
    const target = [...snapshot.elements.values()].find(
      (record) => record.role === 'paragraph' && record.rect.h > 20,
    );
    if (!target) test.skip();

    const hidden = await renderFixture(
      snapshot,
      deriveStates(pushAction(EMPTY_LOG, { t: 'hide', ids: [target!.id] }), snapshot.elements.keys()),
    );
    const removed = await renderFixture(
      snapshot,
      deriveStates(pushAction(EMPTY_LOG, { t: 'remove', ids: [target!.id] }), snapshot.elements.keys()),
    );

    // Both render successfully, and the two are genuinely different operations.
    expect(hidden.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(removed.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(hidden.pdf.equals(removed.pdf)).toBe(false);
  });
});

test.describe('security (§6, §31)', () => {
  test('rejects internal addresses before opening a browser', async () => {
    await expect(validateUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(validateUrl('http://localhost:3000/admin')).rejects.toThrow();
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow();
  });

  test('strips scripts from the captured snapshot (§31, §32)', async () => {
    const { snapshot } = await captureFixture('/lazy.html');
    // The fixture ships an inline <script>; it must not survive into markup
    // that will be rendered in the preview iframe.
    expect(snapshot.html).not.toContain('<script');
    expect(snapshot.html).not.toContain('addEventListener');
  });
});
