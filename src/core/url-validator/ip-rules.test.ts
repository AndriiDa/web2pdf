import { describe, it, expect } from 'vitest';
import { checkIpAddress, isBlockedHostname, parseIPv4, parseIPv6 } from './ip-rules';

describe('parseIPv4', () => {
  it('parses valid dotted-quad addresses', () => {
    expect(parseIPv4('0.0.0.0')).toBe(0);
    expect(parseIPv4('127.0.0.1')).toBe(2130706433);
    expect(parseIPv4('255.255.255.255')).toBe(4294967295);
    expect(parseIPv4('93.184.216.34')).toBe(1572395042);
  });

  it('rejects octal-style zero padding, a known SSRF bypass', () => {
    // "010.0.0.1" is 8.0.0.1 to some parsers and 10.0.0.1 to others.
    expect(parseIPv4('010.0.0.1')).toBeNull();
    expect(parseIPv4('127.0.0.01')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('a.b.c.d')).toBeNull();
    expect(parseIPv4('')).toBeNull();
  });
});

describe('checkIpAddress — IPv4', () => {
  it('blocks loopback', () => {
    expect(checkIpAddress('127.0.0.1').blocked).toBe(true);
    expect(checkIpAddress('127.255.255.254').blocked).toBe(true);
  });

  it('blocks 0.0.0.0 and the this-network block', () => {
    expect(checkIpAddress('0.0.0.0').blocked).toBe(true);
    expect(checkIpAddress('0.1.2.3').blocked).toBe(true);
  });

  it('blocks the RFC1918 private ranges', () => {
    expect(checkIpAddress('10.0.0.1').blocked).toBe(true);
    expect(checkIpAddress('172.16.0.1').blocked).toBe(true);
    expect(checkIpAddress('172.31.255.255').blocked).toBe(true);
    expect(checkIpAddress('192.168.1.1').blocked).toBe(true);
  });

  it('allows public addresses adjacent to private ranges', () => {
    // 172.15.x and 172.32.x sit just outside 172.16.0.0/12.
    expect(checkIpAddress('172.15.255.255').blocked).toBe(false);
    expect(checkIpAddress('172.32.0.0').blocked).toBe(false);
    expect(checkIpAddress('11.0.0.1').blocked).toBe(false);
  });

  it('blocks link-local and the cloud metadata endpoint', () => {
    expect(checkIpAddress('169.254.0.1').blocked).toBe(true);
    const metadata = checkIpAddress('169.254.169.254');
    expect(metadata.blocked).toBe(true);
    expect(metadata.reason).toContain('metadata');
  });

  it('blocks carrier-grade NAT, multicast and reserved space', () => {
    expect(checkIpAddress('100.64.0.1').blocked).toBe(true);
    expect(checkIpAddress('224.0.0.1').blocked).toBe(true);
    expect(checkIpAddress('240.0.0.1').blocked).toBe(true);
    expect(checkIpAddress('255.255.255.255').blocked).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(checkIpAddress('93.184.216.34').blocked).toBe(false);
    expect(checkIpAddress('8.8.8.8').blocked).toBe(false);
    expect(checkIpAddress('1.1.1.1').blocked).toBe(false);
  });

  it('blocks non-dotted numeric host forms that decode to loopback', () => {
    // http://2130706433/ and http://0x7f000001/ both reach 127.0.0.1.
    expect(checkIpAddress('2130706433').blocked).toBe(true);
    expect(checkIpAddress('0x7f000001').blocked).toBe(true);
    expect(checkIpAddress('017700000001').blocked).toBe(true);
  });
});

describe('parseIPv6', () => {
  it('expands compressed notation', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it('parses full form and strips zone indices', () => {
    expect(parseIPv6('fe80:0:0:0:0:0:0:1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects malformed input', () => {
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('gggg::1')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIPv6('')).toBeNull();
  });
});

describe('checkIpAddress — IPv6', () => {
  it('blocks loopback and unspecified', () => {
    expect(checkIpAddress('::1').blocked).toBe(true);
    expect(checkIpAddress('::').blocked).toBe(true);
    expect(checkIpAddress('[::1]').blocked).toBe(true);
  });

  it('blocks unique-local and link-local ranges', () => {
    expect(checkIpAddress('fc00::1').blocked).toBe(true);
    expect(checkIpAddress('fd12:3456::1').blocked).toBe(true);
    expect(checkIpAddress('fe80::1').blocked).toBe(true);
  });

  it('blocks IPv4-mapped addresses that wrap a private address', () => {
    // ::ffff:127.0.0.1 must not slip past the v4 loopback rule.
    expect(checkIpAddress('::ffff:127.0.0.1').blocked).toBe(true);
    expect(checkIpAddress('::ffff:169.254.169.254').blocked).toBe(true);
    expect(checkIpAddress('::ffff:192.168.0.1').blocked).toBe(true);
  });

  it('allows an IPv4-mapped public address', () => {
    expect(checkIpAddress('::ffff:93.184.216.34').blocked).toBe(false);
  });

  it('blocks multicast and the NAT64 prefix', () => {
    expect(checkIpAddress('ff02::1').blocked).toBe(true);
    expect(checkIpAddress('64:ff9b::7f00:1').blocked).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(checkIpAddress('2606:2800:220:1:248:1893:25c8:1946').blocked).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost and its variants', () => {
    expect(isBlockedHostname('localhost').blocked).toBe(true);
    expect(isBlockedHostname('LOCALHOST').blocked).toBe(true);
    expect(isBlockedHostname('app.localhost').blocked).toBe(true);
  });

  it('blocks internal-only TLDs', () => {
    expect(isBlockedHostname('printer.local').blocked).toBe(true);
    expect(isBlockedHostname('db.internal').blocked).toBe(true);
    expect(isBlockedHostname('wiki.corp').blocked).toBe(true);
    expect(isBlockedHostname('nas.home').blocked).toBe(true);
  });

  it('blocks cloud metadata hostnames', () => {
    expect(isBlockedHostname('metadata.google.internal').blocked).toBe(true);
    expect(isBlockedHostname('metadata').blocked).toBe(true);
  });

  it('blocks unqualified single-label hostnames', () => {
    expect(isBlockedHostname('router').blocked).toBe(true);
    expect(isBlockedHostname('intranet-server').blocked).toBe(true);
  });

  it('allows ordinary public hostnames', () => {
    expect(isBlockedHostname('example.com').blocked).toBe(false);
    expect(isBlockedHostname('en.wikipedia.org').blocked).toBe(false);
    // Trailing dot (fully-qualified form) must not change the verdict.
    expect(isBlockedHostname('example.com.').blocked).toBe(false);
  });

  it('does not block a public host merely for containing a blocked word', () => {
    expect(isBlockedHostname('localhost-tools.com').blocked).toBe(false);
    expect(isBlockedHostname('mycorp.example.com').blocked).toBe(false);
  });
});
