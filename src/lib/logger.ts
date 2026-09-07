/**
 * Structured server-side logging (spec §39).
 *
 * Emits one JSON object per line so logs stay greppable in Vercel/Docker log
 * drains. Deliberately narrow: this logger records *what happened during
 * processing*, never page content, cookies, headers or credentials.
 */

import { getConfig, type LogLevel } from './config';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Values safe to place in a log line. Page text and DOM are intentionally not
 * representable here — callers must reduce them to counts or sizes first.
 */
export type LogValue = string | number | boolean | null | undefined;

export interface LogContext {
  readonly [key: string]: LogValue;
}

/** Processing stages, used for both logs and client-facing progress (§36). */
export type Stage =
  | 'validating'
  | 'launching'
  | 'loading'
  | 'rendering'
  | 'loading-images'
  | 'cleaning'
  | 'snapshotting'
  | 'print-layout'
  | 'paginating'
  | 'generating-pdf'
  | 'ready'
  | 'failed';

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[getConfig().logLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that stamps every line with additional fields. */
  child(bindings: LogContext): Logger;
}

export function createLogger(bindings: LogContext = {}): Logger {
  return {
    debug: (m, c) => emit('debug', m, { ...bindings, ...c }),
    info: (m, c) => emit('info', m, { ...bindings, ...c }),
    warn: (m, c) => emit('warn', m, { ...bindings, ...c }),
    error: (m, c) => emit('error', m, { ...bindings, ...c }),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger: Logger = createLogger();

/**
 * Reduces an error of unknown shape to a loggable string.
 * Used only for server-side logs — never sent to the client.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * Extracts just the hostname for logging. We record which host was processed
 * (useful for debugging) but never the full URL, which can carry tokens or
 * personal identifiers in its query string.
 */
export function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid-url';
  }
}
