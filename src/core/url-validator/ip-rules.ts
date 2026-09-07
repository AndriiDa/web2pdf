/**
 * IP address classification for SSRF defence (spec §6).
 *
 * Pure and dependency-free so the whole block list is unit-testable without
 * DNS or a network. The policy is deny-by-default: an address is allowed only
 * when it is a well-formed public unicast address.
 */

/** Parses dotted-quad IPv4 into a 32-bit unsigned integer, or null. */
export function parseIPv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    // Reject empty, non-numeric, and zero-padded forms ("010" is octal in some
    // parsers, a classic SSRF bypass).
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;

    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/** Builds the integer mask for a CIDR prefix length. */
function maskFor(prefixBits: number): number {
  return prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
}

interface V4Range {
  readonly cidr: string;
  readonly base: number;
  readonly bits: number;
  readonly reason: string;
}

function range(cidr: string, reason: string): V4Range {
  const [addr, bitsRaw] = cidr.split('/');
  const base = parseIPv4(addr ?? '');
  const bits = Number(bitsRaw);
  if (base === null || !Number.isInteger(bits)) {
    throw new Error(`Invalid CIDR in block list: ${cidr}`);
  }
  return { cidr, base, bits, reason };
}

/**
 * Blocked IPv4 space. Covers RFC1918 private ranges, loopback, link-local
 * (which includes the 169.254.169.254 cloud metadata endpoint), carrier-grade
 * NAT, and the various reserved/special-purpose blocks.
 */
export const BLOCKED_IPV4_RANGES: readonly V4Range[] = [
  range('0.0.0.0/8', 'unspecified / this-network'),
  range('10.0.0.0/8', 'private network'),
  range('100.64.0.0/10', 'carrier-grade NAT'),
  range('127.0.0.0/8', 'loopback'),
  range('169.254.0.0/16', 'link-local / cloud metadata'),
  range('172.16.0.0/12', 'private network'),
  range('192.0.0.0/24', 'IETF protocol assignments'),
  range('192.0.2.0/24', 'documentation (TEST-NET-1)'),
  range('192.88.99.0/24', '6to4 relay anycast'),
  range('192.168.0.0/16', 'private network'),
  range('198.18.0.0/15', 'benchmarking'),
  range('198.51.100.0/24', 'documentation (TEST-NET-2)'),
  range('203.0.113.0/24', 'documentation (TEST-NET-3)'),
  range('224.0.0.0/4', 'multicast'),
  range('240.0.0.0/4', 'reserved'),
];

export interface IpVerdict {
  readonly blocked: boolean;
  /** Why it was blocked. Server-side diagnostics only — never shown to users. */
  readonly reason: string | null;
}

const ALLOWED: IpVerdict = { blocked: false, reason: null };

function blockedBecause(reason: string): IpVerdict {
  return { blocked: true, reason };
}

function checkIPv4(value: string): IpVerdict {
  const addr = parseIPv4(value);
  if (addr === null) return blockedBecause('malformed IPv4 address');

  for (const r of BLOCKED_IPV4_RANGES) {
    // `>>> 0` is required: bitwise AND yields a *signed* 32-bit int in JS, so
    // any address with the high bit set (172.x, 169.254.x, 224.x) would
    // otherwise compare as negative against the unsigned base and slip through.
    if (((addr & maskFor(r.bits)) >>> 0) === r.base) {
      return blockedBecause(`${r.reason} (${r.cidr})`);
    }
  }
  return ALLOWED;
}

/**
 * Expands an IPv6 address into its 8 hextets. Handles "::" compression.
 * Returns null when the address is malformed.
 */
export function parseIPv6(value: string): number[] | null {
  let text = value.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Drop a zone index (fe80::1%eth0) before parsing.
  const zoneAt = text.indexOf('%');
  if (zoneAt !== -1) text = text.slice(0, zoneAt);
  if (text === '') return null;

  // An IPv4-mapped tail (::ffff:127.0.0.1) is converted to two hextets so the
  // embedded address is classified rather than silently allowed.
  const v4Match = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match?.[1]) {
    const v4 = parseIPv4(v4Match[1]);
    if (v4 === null) return null;
    const high = (v4 >>> 16).toString(16);
    const low = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, v4Match.index)}${high}:${low}`;
  }

  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [before = '', after = ''] = text.split('::');
    head = before === '' ? [] : before.split(':');
    tail = after === '' ? [] : after.split(':');
    if (head.length + tail.length > 7) return null;
  } else {
    head = text.split(':');
    tail = [];
    if (head.length !== 8) return null;
  }

  const groups: number[] = [];
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  const zeros = 8 - head.length - tail.length;
  for (let i = 0; i < zeros; i += 1) groups.push(0);
  for (const group of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }

  return groups.length === 8 ? groups : null;
}

function checkIPv6(value: string): IpVerdict {
  const groups = parseIPv6(value);
  if (groups === null) return blockedBecause('malformed IPv6 address');

  const [g0 = 0, g1 = 0] = groups;
  const isAllZero = groups.every((g) => g === 0);

  if (isAllZero) return blockedBecause('unspecified address (::)');
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return blockedBecause('loopback (::1)');
  }
  // IPv4-mapped/compatible: re-check the embedded IPv4 against the v4 table.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    const verdict = checkIPv4(embedded);
    return verdict.blocked ? blockedBecause(`IPv4-mapped ${verdict.reason}`) : ALLOWED;
  }
  if ((g0 & 0xfe00) === 0xfc00) return blockedBecause('unique local address (fc00::/7)');
  if ((g0 & 0xffc0) === 0xfe80) return blockedBecause('link-local (fe80::/10)');
  if (g0 === 0xff00 || (g0 & 0xff00) === 0xff00) return blockedBecause('multicast (ff00::/8)');
  // NAT64 well-known prefix can reach internal v4 space via a translator.
  if (g0 === 0x0064 && g1 === 0xff9b) return blockedBecause('NAT64 well-known prefix');
  if (g0 === 0x2001 && g1 === 0x0db8) return blockedBecause('documentation (2001:db8::/32)');

  return ALLOWED;
}

/**
 * Classifies a literal IP address. Anything not provably public is blocked.
 */
export function checkIpAddress(value: string): IpVerdict {
  const trimmed = value.trim();
  if (trimmed === '') return blockedBecause('empty address');

  if (trimmed.includes(':')) return checkIPv6(trimmed);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return checkIPv4(trimmed);

  // Bare decimal/hex/octal integers ("2130706433", "0x7f000001") are valid
  // host forms for many resolvers and are a well-known loopback bypass.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
    return blockedBecause('non-dotted numeric host form');
  }

  return blockedBecause('not an IP address');
}

/**
 * Hostnames that must never be resolved, independent of what DNS returns.
 * DNS results are still checked separately — this is an early, cheap reject.
 */
const BLOCKED_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^ip6-\w+$/i,
  // Internal/non-routable TLDs per RFC 6762 / RFC 8375 and common convention.
  /\.local$/i,
  /\.internal$/i,
  /\.intranet$/i,
  /\.private$/i,
  /\.corp$/i,
  /\.home$/i,
  /\.lan$/i,
  /\.localdomain$/i,
  // Cloud metadata service names.
  /^metadata\.google\.internal$/i,
  /^metadata$/i,
  /^instance-data$/i,
];

export function isBlockedHostname(hostname: string): IpVerdict {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return blockedBecause('empty hostname');

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(host)) return blockedBecause(`blocked hostname pattern ${pattern.source}`);
  }
  // A hostname with no dot is a bare/internal name (e.g. "router", "wiki").
  if (!host.includes('.')) return blockedBecause('unqualified internal hostname');

  return ALLOWED;
}
