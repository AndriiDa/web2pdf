import { describe, it, expect } from 'vitest';
import { contentDispositionFor } from './content-disposition';

/** Throws exactly where the real response would: header values are Latin-1. */
function asHeader(value: string): void {
  new Headers({ 'Content-Disposition': value });
}

describe('contentDispositionFor — download requirements', () => {
  it('never emits a header that fails Latin-1 encoding', () => {
    // The regression this module exists for: a Cyrillic title used to throw
    // "Cannot convert argument to a ByteString" and surfaced as INTERNAL.
    for (const title of ['Привет мир', '日本語のタイトル', 'Café résumé', 'Dash — title']) {
      expect(() => asHeader(contentDispositionFor(title))).not.toThrow();
    }
  });

  it('keeps the real title in filename* so non-English names survive', () => {
    const result = contentDispositionFor('Привет мир');
    expect(result).toContain(`filename*=UTF-8''${encodeURIComponent('Привет-мир')}.pdf`);
  });

  it('falls back to document.pdf when a title reduces to no ASCII', () => {
    expect(contentDispositionFor('日本語')).toContain('filename="document.pdf"');
  });

  it('leaves an ASCII title intact rather than mangling it', () => {
    expect(contentDispositionFor('plain report')).toContain('filename="plain-report.pdf"');
  });

  it('strips characters that are unsafe in a filename', () => {
    const result = contentDispositionFor('a/b:c*d?e"f');
    expect(result).toContain('filename="abcdef.pdf"');
  });

  it('does not let a quote in the title break out of the quoted string', () => {
    const result = contentDispositionFor('"quoted"');
    expect(result).toContain('filename="quoted.pdf"');
    expect(() => asHeader(result)).not.toThrow();
  });

  it('falls back to document.pdf for a blank title', () => {
    expect(contentDispositionFor('   ')).toContain('filename="document.pdf"');
  });

  it('caps the length so long titles cannot produce an unusable filename', () => {
    const result = contentDispositionFor('x'.repeat(200));
    expect(result).toContain(`filename="${'x'.repeat(80)}.pdf"`);
  });

  it('honours a caller-supplied extension', () => {
    expect(contentDispositionFor('report', 'html')).toContain('filename="report.html"');
  });
});
