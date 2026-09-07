/**
 * User-facing error taxonomy (spec §28).
 *
 * The rule this module enforces: every failure reaching the client is one of a
 * fixed set of codes with a hand-written, non-technical message. Stack traces,
 * filesystem paths, internal hostnames and library errors stay server-side.
 */

export type ErrorCode =
  // URL / SSRF validation
  | 'INVALID_URL'
  | 'BLOCKED_PROTOCOL'
  | 'BLOCKED_HOST'
  | 'DNS_FAILED'
  // Navigation
  | 'UNREACHABLE'
  | 'NAVIGATION_TIMEOUT'
  | 'ACCESS_DENIED'
  | 'PAGE_TOO_LARGE'
  | 'PROCESSING_TIMEOUT'
  // Rendering / PDF
  | 'RENDER_FAILED'
  | 'PDF_FAILED'
  | 'BROWSER_UNAVAILABLE'
  // Session
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'INVALID_ACTION'
  // Capacity
  | 'BUSY'
  | 'INTERNAL';

const USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: 'That does not look like a valid web address. Please check it and try again.',
  BLOCKED_PROTOCOL: 'Only http:// and https:// web addresses can be converted.',
  BLOCKED_HOST: 'This address cannot be converted for security reasons.',
  DNS_FAILED: 'We could not find that website. Please check the address and try again.',

  UNREACHABLE: 'Unable to load this webpage.',
  NAVIGATION_TIMEOUT: 'The webpage took too long to finish loading.',
  ACCESS_DENIED: 'This website refused the request. It may block automated access.',
  PAGE_TOO_LARGE: 'This webpage is too large to convert.',
  PROCESSING_TIMEOUT: 'The webpage took too long to process.',

  RENDER_FAILED: 'The page could not be converted safely.',
  PDF_FAILED: 'We could not create the PDF for this page.',
  BROWSER_UNAVAILABLE: 'The conversion service is temporarily unavailable. Please try again.',

  SESSION_NOT_FOUND: 'This editing session no longer exists. Please convert the page again.',
  SESSION_EXPIRED: 'This editing session has expired. Please convert the page again.',
  INVALID_ACTION: 'That edit could not be applied.',

  BUSY: 'The service is busy right now. Please try again in a moment.',
  INTERNAL: 'Something went wrong. Please try again.',
};

const STATUS_CODES: Partial<Record<ErrorCode, number>> = {
  INVALID_URL: 400,
  BLOCKED_PROTOCOL: 400,
  BLOCKED_HOST: 403,
  DNS_FAILED: 400,
  UNREACHABLE: 502,
  NAVIGATION_TIMEOUT: 504,
  ACCESS_DENIED: 502,
  PAGE_TOO_LARGE: 413,
  PROCESSING_TIMEOUT: 504,
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 410,
  INVALID_ACTION: 400,
  BUSY: 503,
  BROWSER_UNAVAILABLE: 503,
};

/**
 * An error with a safe public message and an optional private detail.
 * `detail` is for server logs only and must never be serialized to a response.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string) {
    super(USER_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  get userMessage(): string {
    return USER_MESSAGES[this.code];
  }

  get httpStatus(): number {
    return STATUS_CODES[this.code] ?? 500;
  }
}

/**
 * Normalizes any thrown value into an AppError. Unrecognized errors collapse to
 * INTERNAL, preserving their text as private `detail` for the logs only.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof Error) {
    const message = error.message;

    // Playwright surfaces its failure modes as message prefixes.
    if (/Timeout .*exceeded|TimeoutError/i.test(message)) {
      return new AppError('NAVIGATION_TIMEOUT', message);
    }
    if (/net::ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(message)) {
      return new AppError('DNS_FAILED', message);
    }
    if (/net::ERR_CONNECTION|net::ERR_ABORTED|net::ERR_/i.test(message)) {
      return new AppError('UNREACHABLE', message);
    }
    if (/Target (page|closed)|Browser has been closed|crashed/i.test(message)) {
      return new AppError('BROWSER_UNAVAILABLE', message);
    }
    return new AppError('INTERNAL', message);
  }

  return new AppError('INTERNAL', String(error));
}

/** The only error shape that may cross the network to a client. */
export interface PublicErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export function toPublicBody(error: AppError): PublicErrorBody {
  return { error: { code: error.code, message: error.userMessage } };
}
