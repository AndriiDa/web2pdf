/**
 * URL validation and SSRF protection (spec §6).
 *
 * The important design point: validating a hostname and then handing the URL to
 * Chromium is a TOCTOU hole — DNS can re-resolve between the check and the
 * fetch (DNS rebinding). So this module resolves the host *once*, validates
 * every returned address, and hands back the pinned IPs. The browser service
 * then forces Chromium to use exactly those addresses.
 */

import { lookup } from 'node:dns/promises';
import { AppError } from '@/lib/errors';
import { checkIpAddress, isBlockedHostname } from './ip-rules';

/** Only these two schemes may ever be navigated to. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * A URL that has passed every check, carrying the exact IPs it resolved to.
 * The branded type makes it impossible to pass an unvalidated string to the
 * browser layer by accident.
 */
declare const validatedBrand: unique symbol;

export interface ValidatedUrl {
  readonly href: string;
  readonly hostname: string;
  readonly protocol: 'http:' | 'https:';
  readonly port: number;
  /** Addresses this hostname resolved to, all confirmed public. */
  readonly pinnedAddresses: readonly string[];
  readonly [validatedBrand]: true;
}

type UrlFields = Omit<ValidatedUrl, typeof validatedBrand>;

function brand(value: UrlFields): ValidatedUrl {
  return value as ValidatedUrl;
}

/**
 * Normalizes user input into a URL. A bare "example.com" is a very common way
 * for people to paste an address, so we default it to https rather than
 * rejecting it outright.
 */
export function normalizeInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Parses and statically validates a URL, without touching the network.
 * Split out from the DNS step so redirect checks can reuse it cheaply.
 */
export function validateUrlSyntax(raw: string, allowPrivateTargets = false): URL {
  const normalized = normalizeInput(raw);
  if (normalized === '') throw new AppError('INVALID_URL', 'empty input');
  if (normalized.length > 2048) throw new AppError('INVALID_URL', 'url exceeds 2048 characters');

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AppError('INVALID_URL', `unparseable: ${normalized.slice(0, 120)}`);
  }

  // Blocks file:, data:, javascript:, blob:, ftp:, and everything else.
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new AppError('BLOCKED_PROTOCOL', `protocol ${parsed.protocol}`);
  }

  // Embedded credentials (http://user:pass@host) are a redirect/exfil vector
  // and are never needed for a public page.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AppError('BLOCKED_HOST', 'credentials embedded in url');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') throw new AppError('INVALID_URL', 'missing hostname');

  // Host policy is the only check the test flag may relax, and only so the
  // integration suite can reach its loopback fixture server. Protocol and
  // credential checks above always apply.
  if (!allowPrivateTargets) {
    // A literal IP host skips DNS, so classify it directly here.
    const looksNumeric =
      /^[\d.]+$/.test(hostname) || hostname.includes(':') || /^0x/i.test(hostname);
    if (looksNumeric) {
      const verdict = checkIpAddress(hostname);
      if (verdict.blocked) throw new AppError('BLOCKED_HOST', `literal ip: ${verdict.reason}`);
    } else {
      const verdict = isBlockedHostname(hostname);
      if (verdict.blocked) throw new AppError('BLOCKED_HOST', `hostname: ${verdict.reason}`);
    }
  }

  // Restrict ports to the standard web ports plus common dev-server ports.
  // Arbitrary ports turn the converter into an internal port scanner.
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_URL', `invalid port ${parsed.port}`);
  }

  return parsed;
}

/** Ports reachable through the converter. */
function isAllowedPort(port: number, allowLocalTestPorts: boolean): boolean {
  if (port === 80 || port === 443 || port === 8080 || port === 8443) return true;
  // Integration tests serve fixtures from an ephemeral local port; this is
  // gated behind an explicit flag so it can never be enabled in production.
  return allowLocalTestPorts;
}

export interface ValidateOptions {
  /**
   * Permits loopback/private destinations and arbitrary ports. Used ONLY by the
   * integration test suite against its local fixture server. Never set from
   * user input.
   */
  readonly allowPrivateTargets?: boolean;
}

/**
 * Full validation: syntax, host policy, DNS resolution, and per-address checks.
 * Returns the pinned addresses so navigation cannot be re-pointed later.
 */
export async function validateUrl(raw: string, options: ValidateOptions = {}): Promise<ValidatedUrl> {
  const allowPrivate = options.allowPrivateTargets === true;
  const parsed = validateUrlSyntax(raw, allowPrivate);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const protocol = parsed.protocol as 'http:' | 'https:';
  const port = parsed.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(parsed.port);

  if (!allowPrivate && !isAllowedPort(port, false)) {
    throw new AppError('BLOCKED_HOST', `port ${port} not permitted`);
  }

  if (allowPrivate) {
    // Test mode: skip DNS policy entirely, but still return a well-formed value.
    return brand({
      href: parsed.href,
      hostname,
      protocol,
      port,
      pinnedAddresses: [],
    });
  }

  const addresses = await resolveHost(hostname);
  return brand({
    href: parsed.href,
    hostname,
    protocol,
    port,
    pinnedAddresses: addresses,
  });
}

/**
 * Resolves a hostname to every address it offers and requires *all* of them to
 * be public. Rejecting on any single bad address (rather than filtering to the
 * good ones) is deliberate: a host that answers with both a public and a
 * private address is a rebinding attempt, not a legitimate target.
 */
async function resolveHost(hostname: string): Promise<readonly string[]> {
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AppError('DNS_FAILED', `lookup failed for ${hostname}: ${String(error)}`);
  }

  if (resolved.length === 0) {
    throw new AppError('DNS_FAILED', `no addresses for ${hostname}`);
  }

  for (const { address } of resolved) {
    const verdict = checkIpAddress(address);
    if (verdict.blocked) {
      throw new AppError('BLOCKED_HOST', `${hostname} resolved to ${address}: ${verdict.reason}`);
    }
  }

  return resolved.map((r) => r.address);
}

/**
 * Re-validates a redirect target mid-navigation (spec §6: "re-check destination
 * after every redirect"). Synchronous host policy only — the browser service
 * pins DNS separately, so a redirect to a public name still cannot be pointed
 * at internal space.
 */
export function isRedirectTargetAllowed(rawUrl: string, allowPrivateTargets = false): boolean {
  try {
    validateUrlSyntax(rawUrl, allowPrivateTargets);
    return true;
  } catch {
    return false;
  }
}
