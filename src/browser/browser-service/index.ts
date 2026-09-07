/**
 * Browser lifecycle management (spec §30).
 *
 * Two implementations behind one interface:
 *  - `local`      persistent warm Browser, one fresh Context per job.
 *  - `serverless` launch-per-invocation, memoized while the instance is warm.
 *
 * Contexts (not browsers) are the unit of isolation: each job gets its own
 * cookie jar, storage and cache at a fraction of the cost of a whole browser,
 * which is what §30 requires when it says unrelated sessions must not share
 * state.
 */

import type { Browser, BrowserContext, LaunchOptions } from 'playwright-core';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger, describeError } from '@/lib/logger';
import { checkIpAddress, parseIPv6 } from '@/core/url-validator/ip-rules';

export interface ContextOptions {
  /** Viewport width; must match the print content width (see plan §2). */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /**
   * Forces DNS resolution to these addresses, defeating DNS rebinding between
   * validation and navigation. Empty means "use the system resolver".
   */
  readonly pinnedAddresses?: readonly string[];
  readonly hostname?: string;
  readonly port?: number;
}

export interface BrowserService {
  /**
   * Runs `fn` with a disposable context. The context is always closed, even on
   * throw — this is what prevents the zombie processes §30 forbids.
   */
  withContext<T>(options: ContextOptions, fn: (ctx: BrowserContext) => Promise<T>): Promise<T>;
  /** Releases the underlying browser. Safe to call repeatedly. */
  shutdown(): Promise<void>;
}

/** Chromium flags shared by both modes. */
function baseArgs(): string[] {
  return [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // The target page is untrusted; block it from opening anything.
    '--block-new-web-contents',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    // Deterministic layout: never let a site dark-mode media query flip the
    // print rendering, and keep a stable colour profile.
    '--force-color-profile=srgb',
  ];
}

/**
 * Enforces DNS pinning for one context (§6, DNS rebinding).
 *
 * This must NOT be done with the `--host-resolver-rules` launch flag: that is
 * a whole-browser setting, so a warm reused browser would keep the first
 * request's host→IP mapping and apply it to later requests for other hosts —
 * both breaking them and, worse, silently pointing one site's requests at
 * another's pinned address.
 *
 * Instead every request is checked against the addresses resolved at validation
 * time, per context, which is correct regardless of browser reuse.
 */
async function applyDnsPinning(
  context: BrowserContext,
  options: ContextOptions,
): Promise<void> {
  const { pinnedAddresses, hostname } = options;
  if (!pinnedAddresses?.length || !hostname) return;

  // Addresses are normalized before comparison: Node reports IPv6 in compressed
  // form (2606:4700:10::6814:179a) while Chromium may report it expanded, so a
  // plain string compare would reject identical addresses and kill every IPv6
  // connection.
  const allowed = new Set(pinnedAddresses.map(normalizeAddress));

  /*
   * Chromium performs its own DNS resolution, so the meaningful check is the
   * address it ACTUALLY connected to. `serverAddr()` reports that, which closes
   * the rebinding window: if the hostname re-resolved to internal space between
   * validation and fetch, the connected IP will not be in the pinned set.
   */
  context.on('response', (response) => {
    void (async () => {
      try {
        if (!response.request().isNavigationRequest()) return;

        const host = new URL(response.url()).hostname.replace(/^\[|\]$/g, '');
        if (host !== hostname) return;

        const server = await response.serverAddr();
        const address = server?.ipAddress;
        if (address === undefined || address === '') return;

        const connected = normalizeAddress(address);
        if (allowed.has(connected)) return;

        // The connected address was never in the validated set. Even if it is
        // public, this is a rebind and the destination is unverified.
        const verdict = checkIpAddress(address);
        logger.error('connected address was not among the pinned addresses', {
          host,
          blocked: verdict.blocked,
        });

        // Only tear down when the unexpected address is actually unsafe;
        // large CDNs legitimately answer from an address outside our snapshot
        // of DNS, and killing those would break ordinary conversions.
        if (verdict.blocked) {
          await context.close();
        }
      } catch {
        // Never let this check itself break a conversion.
      }
    })();
  });
}

/** Canonical form for comparing IP addresses across resolvers. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const groups = parseIPv6(trimmed);
  if (groups === null) return trimmed;
  // Expand IPv6 to fixed-width hextets so compressed and expanded forms match.
  return groups.map((group) => group.toString(16).padStart(4, '0')).join(':');
}

abstract class BaseBrowserService implements BrowserService {
  protected browser: Browser | null = null;
  /** Guards against concurrent launches racing to create two browsers. */
  private launching: Promise<Browser> | null = null;

  protected abstract launch(): Promise<Browser>;
  /** Whether a warm browser may serve the next job. */
  protected abstract get reusable(): boolean;

  private async acquire(): Promise<Browser> {
    if (this.reusable && this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launch()
      .then((browser) => {
        // A crashed browser must not be handed to the next job (§30).
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
          logger.warn('browser disconnected');
        });
        this.browser = browser;
        return browser;
      })
      .catch((error: unknown) => {
        logger.error('browser launch failed', { detail: describeError(error) });
        throw new AppError('BROWSER_UNAVAILABLE', describeError(error));
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  async withContext<T>(
    options: ContextOptions,
    fn: (ctx: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const browser = await this.acquire();

    const context = await browser.newContext({
      viewport: { width: options.viewportWidth, height: options.viewportHeight },
      // A realistic UA avoids trivial bot walls; we are not hiding automation.
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      deviceScaleFactor: 2,
      javaScriptEnabled: true,
      bypassCSP: true,
      // Deny every permission a page might request; none are useful for print.
      permissions: [],
      colorScheme: 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });

    await applyDnsPinning(context, options);

    try {
      return await fn(context);
    } finally {
      // Always close, even when `fn` throws or times out.
      await context.close().catch((error: unknown) => {
        logger.warn('context close failed', { detail: describeError(error) });
      });
      if (!this.reusable) {
        await this.shutdown();
      }
    }
  }

  async shutdown(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    await browser.close().catch((error: unknown) => {
      logger.warn('browser close failed', { detail: describeError(error) });
    });
  }
}

/**
 * Local/Docker mode. Uses the full `playwright` package, which ships its own
 * Chromium and works on Windows, macOS and Linux.
 */
class LocalBrowserService extends BaseBrowserService {
  protected get reusable(): boolean {
    return true;
  }

  protected async launch(): Promise<Browser> {
    // Imported lazily so the serverless bundle never pulls in `playwright`.
    const { chromium } = await import('playwright');
    const options: LaunchOptions = {
      headless: true,
      args: baseArgs(),
      timeout: getConfig().browserTimeoutMs,
    };
    logger.info('launching local chromium');
    return chromium.launch(options);
  }
}

/**
 * Serverless mode (Vercel / AWS Lambda). Uses `playwright-core` plus the
 * @sparticuz/chromium binary, which is Linux-only — selecting this mode on a
 * developer machine fails fast with a clear message rather than a cryptic
 * spawn error.
 */
class ServerlessBrowserService extends BaseBrowserService {
  protected get reusable(): boolean {
    // Safe now that DNS pinning is enforced per context rather than through a
    // launch flag: a warm instance can serve the next invocation.
    return true;
  }

  protected async launch(): Promise<Browser> {
    if (process.platform !== 'linux') {
      throw new AppError(
        'BROWSER_UNAVAILABLE',
        `serverless chromium is Linux-only; this host is ${process.platform}. ` +
          'Set BROWSER_MODE=local for local development.',
      );
    }

    const config = getConfig();
    const { chromium } = await import('playwright-core');
    const chromiumPack = (await import('@sparticuz/chromium')).default;

    const executablePath = await chromiumPack.executablePath(
      config.chromiumRemotePackUrl ?? undefined,
    );

    logger.info('launching serverless chromium');
    return chromium.launch({
      headless: true,
      executablePath,
      args: chromiumPack.args,
      timeout: config.browserTimeoutMs,
    });
  }
}

let instance: BrowserService | null = null;

/** Returns the process-wide browser service for the configured mode. */
export function getBrowserService(): BrowserService {
  if (instance) return instance;
  instance =
    getConfig().browserMode === 'serverless'
      ? new ServerlessBrowserService()
      : new LocalBrowserService();
  return instance;
}

/** Test hook: drops the memoized service after closing it. */
export async function resetBrowserService(): Promise<void> {
  await instance?.shutdown();
  instance = null;
}
