/**
 * Central runtime configuration, read once from the environment.
 *
 * Every knob has a production-safe default so the app runs with an empty
 * environment. Values are validated and clamped here rather than at each call
 * site, so downstream modules can treat them as trustworthy numbers.
 */

export type BrowserMode = 'local' | 'serverless';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Reads a positive integer, falling back when unset/invalid/out of range. */
function intFromEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function stringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/**
 * Detects a serverless host. Vercel and Lambda both set these; we never guess
 * from the platform alone, because the @sparticuz/chromium binary is Linux-only
 * and would fail confusingly if selected on a developer's Windows/macOS box.
 */
function detectBrowserMode(): BrowserMode {
  const configured = stringFromEnv('BROWSER_MODE', 'auto').toLowerCase();
  if (configured === 'local' || configured === 'serverless') return configured;

  const isServerlessHost =
    process.env.VERCEL === '1' ||
    process.env.VERCEL_ENV !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_VERSION !== undefined;

  return isServerlessHost ? 'serverless' : 'local';
}

function detectLogLevel(): LogLevel {
  const raw = stringFromEnv('LOG_LEVEL', 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

export interface AppConfig {
  readonly appUrl: string;
  readonly browserMode: BrowserMode;
  readonly chromiumRemotePackUrl: string | null;

  readonly maxProcessingTimeMs: number;
  readonly browserTimeoutMs: number;
  readonly pdfTimeoutMs: number;
  readonly paginationBudgetMs: number;

  readonly maxPageSizeBytes: number;
  readonly maxPageHeightPx: number;
  readonly maxScrollIterations: number;
  readonly maxInlineImageBytes: number;
  readonly maxResourceBytes: number;

  readonly maxConcurrentJobs: number;
  readonly sessionTtlMs: number;
  readonly maxSessionStoreBytes: number;

  readonly logLevel: LogLevel;
  /**
   * Permits conversion of loopback/private addresses. Exists solely so the e2e
   * suite can drive the real UI against its local fixture server. Never enable
   * in production: it disables the SSRF host policy.
   */
  readonly allowPrivateTargets: boolean;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const remotePack = stringFromEnv('CHROMIUM_REMOTE_PACK_URL', '');

  cached = {
    appUrl: stringFromEnv('APP_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    browserMode: detectBrowserMode(),
    chromiumRemotePackUrl: remotePack === '' ? null : remotePack,

    maxProcessingTimeMs: intFromEnv('MAX_PROCESSING_TIME_MS', 120_000, 10_000, 900_000),
    browserTimeoutMs: intFromEnv('BROWSER_TIMEOUT_MS', 45_000, 5_000, 300_000),
    pdfTimeoutMs: intFromEnv('PDF_TIMEOUT_MS', 60_000, 5_000, 300_000),
    paginationBudgetMs: intFromEnv('PAGINATION_BUDGET_MS', 5_000, 500, 60_000),

    maxPageSizeBytes: intFromEnv('MAX_PAGE_SIZE_BYTES', 12 * 1024 * 1024, 256 * 1024),
    maxPageHeightPx: intFromEnv('MAX_PAGE_HEIGHT_PX', 80_000, 2_000, 500_000),
    maxScrollIterations: intFromEnv('MAX_SCROLL_ITERATIONS', 40, 1, 500),
    maxInlineImageBytes: intFromEnv('MAX_INLINE_IMAGE_BYTES', 512 * 1024, 1024),
    maxResourceBytes: intFromEnv('MAX_RESOURCE_BYTES', 10 * 1024 * 1024, 64 * 1024),

    maxConcurrentJobs: intFromEnv('MAX_CONCURRENT_JOBS', 2, 1, 32),
    sessionTtlMs: intFromEnv('SESSION_TTL_MS', 30 * 60_000, 60_000),
    maxSessionStoreBytes: intFromEnv('MAX_SESSION_STORE_BYTES', 256 * 1024 * 1024, 8 * 1024 * 1024),

    logLevel: detectLogLevel(),
    allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1',
  };

  return cached;
}

/** Test-only: drops the memoized config so env changes take effect. */
export function resetConfigCache(): void {
  cached = null;
}
