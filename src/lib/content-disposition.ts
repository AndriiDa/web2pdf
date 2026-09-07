/**
 * Content-Disposition header construction (RFC 6266).
 *
 * Lives outside the route so it can be unit-tested directly. It exists because
 * HTTP header values are Latin-1: a document title containing Cyrillic, CJK,
 * accented Latin or even an em dash throws when the header is built, which
 * surfaced as a generic INTERNAL error on download for most of the non-English
 * web.
 */

/** Characters that are unsafe in a filename on common operating systems. */
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"/\|?*]/g;

/**
 * Builds an attachment disposition carrying both an ASCII-safe `filename` that
 * every client understands and a percent-encoded UTF-8 `filename*` that modern
 * browsers prefer, so the real title survives.
 */
export function contentDispositionFor(title: string, extension = 'pdf'): string {
  const cleaned = title
    .replace(UNSAFE_FILENAME_CHARS, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);

  const name = cleaned === '' ? 'document' : cleaned;

  // A wholly non-ASCII title reduces to nothing here, so fall back explicitly
  // rather than emitting `filename=".pdf"`.
  const asciiBase = name
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .trim();
  const ascii = asciiBase === '' ? 'document' : asciiBase;

  return (
    `attachment; filename="${ascii}.${extension}"; ` +
    `filename*=UTF-8''${encodeURIComponent(name)}.${extension}`
  );
}
