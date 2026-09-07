import { describe, it, expect } from 'vitest';
import { normalizeInput, validateUrlSyntax, isRedirectTargetAllowed } from './index';
import { AppError } from '@/lib/errors';

/** Captures the AppError code thrown by a call, or null if it did not throw. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
}

describe('normalizeInput', () => {
  it('adds https:// to a bare hostname', () => {
    expect(normalizeInput('example.com')).toBe('https://example.com');
    expect(normalizeInput('  example.com/page  ')).toBe('https://example.com/page');
  });

  it('leaves an explicit scheme untouched', () => {
    expect(normalizeInput('http://example.com')).toBe('http://example.com');
    expect(normalizeInput('https://example.com')).toBe('https://example.com');
    // Dangerous schemes are preserved here so the validator can reject them
    // with a precise error rather than silently rewriting them to https.
    expect(normalizeInput('file:///etc/passwd')).toBe('file:///etc/passwd');
  });
});

describe('validateUrlSyntax — protocols', () => {
  it('accepts http and https', () => {
    expect(validateUrlSyntax('https://example.com').protocol).toBe('https:');
    expect(validateUrlSyntax('http://example.com').protocol).toBe('http:');
  });

  it('rejects dangerous schemes', () => {
    expect(codeOf(() => validateUrlSyntax('file:///etc/passwd'))).toBe('BLOCKED_PROTOCOL');
    expect(codeOf(() => validateUrlSyntax('data:text/html,<script>alert(1)</script>'))).toBe('BLOCKED_PROTOCOL');
    expect(codeOf(() => validateUrlSyntax('javascript:alert(1)'))).toBe('BLOCKED_PROTOCOL');
    expect(codeOf(() => validateUrlSyntax('ftp://example.com'))).toBe('BLOCKED_PROTOCOL');
    expect(codeOf(() => validateUrlSyntax('blob:https://example.com/x'))).toBe('BLOCKED_PROTOCOL');
  });
});

describe('validateUrlSyntax — host policy', () => {
  it('rejects loopback and private literals before any DNS call', () => {
    expect(codeOf(() => validateUrlSyntax('http://127.0.0.1'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://localhost:3000'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://10.0.0.5'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://192.168.1.1'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://[::1]'))).toBe('BLOCKED_HOST');
  });

  it('rejects the cloud metadata endpoint', () => {
    expect(codeOf(() => validateUrlSyntax('http://169.254.169.254/latest/meta-data/'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://metadata.google.internal/'))).toBe('BLOCKED_HOST');
  });

  it('rejects obfuscated loopback forms', () => {
    expect(codeOf(() => validateUrlSyntax('http://2130706433'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://0x7f000001'))).toBe('BLOCKED_HOST');
  });

  it('rejects embedded credentials', () => {
    expect(codeOf(() => validateUrlSyntax('https://user:pass@example.com'))).toBe('BLOCKED_HOST');
  });

  it('rejects internal-only hostnames', () => {
    expect(codeOf(() => validateUrlSyntax('http://intranet.corp'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://printer.local'))).toBe('BLOCKED_HOST');
    expect(codeOf(() => validateUrlSyntax('http://router'))).toBe('BLOCKED_HOST');
  });

  it('accepts ordinary public URLs', () => {
    expect(() => validateUrlSyntax('https://example.com/article?id=1#top')).not.toThrow();
    expect(() => validateUrlSyntax('https://en.wikipedia.org/wiki/PDF')).not.toThrow();
  });
});

describe('validateUrlSyntax — malformed input', () => {
  it('rejects empty and unparseable values', () => {
    expect(codeOf(() => validateUrlSyntax(''))).toBe('INVALID_URL');
    expect(codeOf(() => validateUrlSyntax('   '))).toBe('INVALID_URL');
    expect(codeOf(() => validateUrlSyntax('https://'))).toBe('INVALID_URL');
  });

  it('rejects absurdly long URLs', () => {
    expect(codeOf(() => validateUrlSyntax(`https://example.com/${'a'.repeat(3000)}`))).toBe('INVALID_URL');
  });
});

describe('isRedirectTargetAllowed', () => {
  it('permits public redirect targets', () => {
    expect(isRedirectTargetAllowed('https://example.com/final')).toBe(true);
  });

  it('blocks a redirect that pivots to internal space', () => {
    // The classic SSRF chain: public URL 302s to the metadata service.
    expect(isRedirectTargetAllowed('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isRedirectTargetAllowed('http://127.0.0.1:8080/admin')).toBe(false);
    expect(isRedirectTargetAllowed('file:///etc/passwd')).toBe(false);
  });
});
