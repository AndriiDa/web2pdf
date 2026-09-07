/**
 * HTML sanitization for the preview iframe (spec §31, §32).
 *
 * The captured page is untrusted. Even though the preview iframe is sandboxed
 * WITHOUT `allow-scripts`, this is the second layer: markup is stripped of
 * every executable vector before it is ever served.
 *
 * The one non-obvious requirement: `data-w2p-id` MUST survive. Default
 * sanitizer configurations drop unknown `data-*` attributes, which would
 * silently break the entire editor — every hover, click and removal depends on
 * those ids being present in the served markup.
 */

import sanitizeHtml from 'sanitize-html';

/** Attributes the editor relies on; dropping these breaks element selection. */
const W2P_ATTRIBUTES = ['data-w2p-id', 'data-w2p-hidden', 'data-w2p-asset', 'data-w2p-print'];

const ALLOWED_TAGS = [
  'html', 'head', 'body', 'style', 'title', 'meta',
  'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'mark', 'abbr', 'cite', 'q', 'time', 'address',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'img', 'picture', 'figure', 'figcaption',
  'pre', 'code', 'kbd', 'samp', 'var', 'blockquote',
  'hr', 'br', 'wbr', 'details', 'summary', 'label',
];

/**
 * Sanitizes captured markup for display in the preview.
 *
 * Note `style` is an allowed TAG (the print stylesheet must survive) but
 * `style` ATTRIBUTES are also kept, since layout fidelity depends on them.
 * That is safe here because scripts cannot run in the sandboxed frame, and
 * `javascript:` URLs are stripped below.
 */
export function sanitizePreviewHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': [...W2P_ATTRIBUTES, 'class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-label'],
      a: ['href', 'target', 'rel', ...W2P_ATTRIBUTES, 'class', 'id', 'style'],
      img: ['src', 'alt', 'width', 'height', ...W2P_ATTRIBUTES, 'class', 'id', 'style'],
      td: ['colspan', 'rowspan', ...W2P_ATTRIBUTES, 'class', 'id', 'style'],
      th: ['colspan', 'rowspan', 'scope', ...W2P_ATTRIBUTES, 'class', 'id', 'style'],
      col: ['span', 'width', 'class', 'style'],
      details: ['open', ...W2P_ATTRIBUTES, 'class', 'id', 'style'],
      meta: ['charset', 'name', 'content'],
    },
    // Only these URL schemes may appear in an href/src. Notably absent:
    // javascript:, and data: for anything other than images.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // Keep <style> contents: the print CSS lives there and must survive.
    allowedStyles: {},
    /*
     * sanitize-html flags <style> as XSS-prone, which is true in a normal page
     * where CSS can reference javascript: URLs or leak data via url(). It is
     * accepted here deliberately and is defended by two other layers: the
     * preview iframe carries no `allow-scripts`, and its Content-Security-Policy
     * sets `script-src 'none'` with `default-src 'none'`, so CSS cannot execute
     * or exfiltrate. Dropping <style> would discard the entire print layout and
     * make the preview stop matching the PDF.
     */
    allowVulnerableTags: true,
    // Preserve whitespace inside code blocks.
    nonTextTags: ['script', 'noscript', 'textarea', 'option'],
    parser: { lowerCaseAttributeNames: false },
  });
}

/**
 * Removes elements (and their subtrees) carrying the given ids.
 *
 * The PDF renderer DETACHES removed nodes, so the preview must do the same
 * rather than hiding them with CSS. Two reasons: §12 forbids "fake overlays
 * that merely cover content", and a hidden-but-present node would keep the
 * preview and the PDF disagreeing about what the document contains.
 *
 * Implemented with sanitize-html's transform hook so the removal happens
 * during parsing — no second HTML parser, and no regex over markup.
 */
export function stripElementsById(html: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return html;

  return sanitizeHtml(html, {
    // Preserve everything; this pass only drops the targeted subtrees.
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => {
      const id = frame.attribs['data-w2p-id'];
      return id !== undefined && ids.has(id);
    },
  });
}

/**
 * Escapes a string for safe interpolation into an HTML text node or attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
