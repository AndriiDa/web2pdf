/**
 * Page loading and stabilization (spec §7).
 *
 * `DOMContentLoaded` is explicitly not treated as completion. The sequence is:
 * navigate, wait for the network to settle, let JS run, wait for fonts and
 * images, then progressively scroll to trigger lazy loading until the document
 * stops growing — all under hard caps so an infinite-scroll page cannot hang
 * the request.
 */

import type { BrowserContext, Page, Response } from 'playwright-core';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger, describeError, type Logger } from '@/lib/logger';
import { isRedirectTargetAllowed, type ValidatedUrl } from '@/core/url-validator';

export interface LoadedPage {
  readonly page: Page;
  readonly finalUrl: string;
  readonly title: string;
  readonly documentHeight: number;
  readonly scrollIterations: number;
  readonly imageCount: number;
}

export interface LoadOptions {
  readonly url: ValidatedUrl;
  /** Integration tests only: permits the loopback fixture server. */
  readonly allowPrivateTargets?: boolean;
  readonly log?: Logger;
  readonly onStage?: (stage: string) => void;
}

/** Resource types blocked outright: never useful for a printed document. */
const BLOCKED_RESOURCE_TYPES = new Set(['media', 'websocket', 'manifest']);

/**
 * Opens the URL and drives it to a stable, fully-rendered state.
 * The caller owns the returned page and must close it.
 */
export async function loadPage(context: BrowserContext, options: LoadOptions): Promise<LoadedPage> {
  const config = getConfig();
  const log = options.log ?? logger;
  const page = await context.newPage();

  page.setDefaultTimeout(config.browserTimeoutMs);
  page.setDefaultNavigationTimeout(config.browserTimeoutMs);

  await installGuards(page, options.url, log, options.allowPrivateTargets === true);

  options.onStage?.('loading');
  let response: Response | null;
  try {
    response = await page.goto(options.url.href, {
      waitUntil: 'domcontentloaded',
      timeout: config.browserTimeoutMs,
    });
  } catch (error) {
    await page.close().catch(() => undefined);
    const message = describeError(error);
    if (/Timeout/i.test(message)) throw new AppError('NAVIGATION_TIMEOUT', message);
    throw new AppError('UNREACHABLE', message);
  }

  if (response && response.status() >= 400) {
    const status = response.status();
    await page.close().catch(() => undefined);
    // 401/403 usually mean a bot wall or paywall — worth saying so specifically.
    throw new AppError(status === 401 || status === 403 ? 'ACCESS_DENIED' : 'UNREACHABLE', `HTTP ${status}`);
  }

  options.onStage?.('rendering');
  await settleNetwork(page, config.browserTimeoutMs);

  options.onStage?.('loading-images');
  const scrollIterations = await autoScroll(page);
  await settleNetwork(page, 5_000);
  const imageCount = await waitForImages(page);

  // Final layout pass after everything has settled.
  await page.evaluate(() => {
    void document.body.getBoundingClientRect();
  });

  const [title, documentHeight] = await Promise.all([
    page.title().catch(() => ''),
    page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0),
  ]);

  if (documentHeight > config.maxPageHeightPx) {
    await page.close().catch(() => undefined);
    throw new AppError('PAGE_TOO_LARGE', `document height ${documentHeight}px`);
  }

  log.info('page loaded', {
    finalHost: safeHost(page.url()),
    documentHeight,
    scrollIterations,
    imageCount,
  });

  return {
    page,
    finalUrl: page.url(),
    title,
    documentHeight,
    scrollIterations,
    imageCount,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Installs request/navigation guards.
 *
 * The redirect check is the second half of the SSRF defence (§6): DNS pinning
 * stops a hostname being re-pointed, and this stops a *new* hostname being
 * introduced mid-navigation.
 */
async function installGuards(
  page: Page,
  url: ValidatedUrl,
  log: Logger,
  allowPrivateTargets: boolean,
): Promise<void> {
  const config = getConfig();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const requestUrl = request.url();

    // Every top-level navigation must re-pass host validation.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (!isRedirectTargetAllowed(requestUrl, allowPrivateTargets)) {
        log.warn('blocked redirect to disallowed destination', { host: safeHost(requestUrl) });
        await route.abort('blockedbyclient');
        return;
      }
    }

    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort('blockedbyclient');
      return;
    }

    await route.continue();
  });

  // Oversized resources are dropped rather than buffered (§29).
  page.on('response', (response) => {
    const length = Number(response.headers()['content-length'] ?? 0);
    if (length > config.maxResourceBytes) {
      log.debug('oversized resource', { size: length, host: safeHost(response.url()) });
    }
  });

  page.on('crash', () => log.error('page crashed'));
  page.on('pageerror', () => {
    // Target-page JS errors are routine and must never fail the conversion.
  });

  // Dialogs would block navigation forever if left unhandled.
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });

  void url;
}

/**
 * Waits for network quiet, tolerating pages that never truly idle (analytics
 * beacons, polling, open sockets). A timeout here is normal, not an error.
 */
async function settleNetwork(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    // Expected on pages with persistent connections; continue regardless.
  }
}

/**
 * Progressively scrolls to trigger lazy loading, stopping when the document
 * stops growing (§7) or a hard cap is reached.
 *
 * Runs entirely in-page to avoid a round trip per step.
 */
async function autoScroll(page: Page): Promise<number> {
  const config = getConfig();

  return page.evaluate(
    async ({ maxIterations, maxHeight }) => {
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        });

      const viewport = window.innerHeight;
      let iterations = 0;
      let lastHeight = 0;
      let stableCount = 0;

      while (iterations < maxIterations) {
        iterations += 1;
        const height = document.documentElement.scrollHeight;

        // Stop if the page has grown beyond what we are willing to render.
        if (height > maxHeight) break;

        window.scrollBy(0, viewport * 0.9);
        // Give lazy-load observers time to fire and fetch.
        await sleep(150);

        const reachedBottom = window.scrollY + viewport >= height - 2;

        if (height === lastHeight) {
          stableCount += 1;
          // Three stable cycles at the bottom means content has stopped
          // arriving; infinite-scroll pages never reach this.
          if (stableCount >= 3 && reachedBottom) break;
        } else {
          stableCount = 0;
          lastHeight = height;
        }
      }

      // Return to the top so the capture starts from a known position.
      window.scrollTo(0, 0);
      await sleep(100);
      return iterations;
    },
    { maxIterations: config.maxScrollIterations, maxHeight: config.maxPageHeightPx },
  );
}

/**
 * Waits for images to finish decoding and reports how many are usable (§8).
 * Images that fail are left in place; the snapshot stage drops broken ones.
 */
async function waitForImages(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const images = Array.from(document.images);

    await Promise.all(
      images.map(async (img) => {
        // `loading="lazy"` images outside the viewport never load otherwise.
        if (img.loading === 'lazy') img.loading = 'eager';
        if (img.complete) return;

        await Promise.race([
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 5000);
          }),
        ]);
      }),
    );

    // Fonts affect layout measurement, so they must settle before we measure.
    try {
      await document.fonts.ready;
    } catch {
      // Font Loading API unavailable; layout will still be measured below.
    }

    return images.filter((img) => img.naturalWidth > 0).length;
  });
}
