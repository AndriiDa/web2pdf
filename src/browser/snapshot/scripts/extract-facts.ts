/**
 * In-page DOM analysis: assigns stable ids and reduces every element to
 * `NodeFacts` for the pure classifiers.
 *
 * This module is serialized into the page via `page.evaluate`, so it must be
 * self-contained: no imports at runtime, no closures over server state. Types
 * are erased at compile time, so importing them is safe.
 */

import type { NodeFacts } from '@/core/dom-analyzer/facts';
import type { ElementId } from '@/core/types';

/** Returned by the in-page pass. */
export interface ExtractionResult {
  readonly facts: NodeFacts[];
  readonly title: string;
  readonly lang: string;
  readonly totalElements: number;
}

/**
 * The function injected into the page. Declared as a plain function (not an
 * arrow bound to module scope) so Playwright can serialize it cleanly.
 */
export function extractFactsInPage(idAttribute: string): ExtractionResult {
  /** Tags that never carry printable content. */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD',
    'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'TITLE',
  ]);

  /** Elements worth giving an id and offering to the editor. */
  const MEANINGFUL_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION',
    'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'EMBED', 'OBJECT',
    'PRE', 'CODE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'ASIDE', 'DIV', 'MAIN',
    'HEADER', 'FOOTER', 'NAV', 'FORM', 'HR', 'ADDRESS', 'DETAILS', 'SUMMARY',
    'BUTTON', 'A', 'SPAN', 'INS',
  ]);

  const AD_ATTRIBUTE_PATTERNS = [
    'data-ad', 'data-ad-slot', 'data-ad-client', 'data-ad-format',
    'data-google-query-id', 'data-adunit', 'data-ad-unit', 'data-adtest',
  ];

  const CLOSE_PATTERNS = /^(close|dismiss|×|✕|✖|x|no thanks|not now|cerrar|schließen|fermer)$/i;

  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const bodyStyle = window.getComputedStyle(document.body);
  const bodyScrollLocked =
    bodyStyle.overflow === 'hidden' || bodyStyle.position === 'fixed';

  const facts: NodeFacts[] = [];
  let counter = 0;
  let totalElements = 0;

  /** Parses z-index, treating `auto` and invalid values as 0. */
  function parseZIndex(value: string): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** Detects a translucent or dark full-bleed background (a modal backdrop). */
  function looksLikeBackdrop(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    const coversViewport =
      rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
    if (!coversViewport) return false;

    const bg = style.backgroundColor;
    const rgba = bg.match(/rgba?\(([^)]+)\)/);
    if (!rgba?.[1]) return false;

    const parts = rgba[1].split(',').map((p) => Number.parseFloat(p.trim()));
    const alpha = parts.length >= 4 ? (parts[3] ?? 1) : 1;
    // A visible-but-translucent full-screen layer is the classic backdrop.
    if (alpha > 0.05 && alpha < 0.95) return true;
    // Fully opaque dark overlays also count when they sit above content.
    const [r = 255, g = 255, b = 255] = parts;
    return alpha >= 0.95 && r + g + b < 200 && parseZIndex(style.zIndex) > 100;
  }

  function hasCloseControl(el: Element): boolean {
    const candidates = el.querySelectorAll('button, a, [role="button"], [aria-label], span, div');
    const limit = Math.min(candidates.length, 40);
    for (let i = 0; i < limit; i += 1) {
      const candidate = candidates[i];
      if (!candidate) continue;
      const label = candidate.getAttribute('aria-label') ?? '';
      const text = (candidate.textContent ?? '').trim();
      const className = candidate.className;
      const classText = typeof className === 'string' ? className : '';
      if (CLOSE_PATTERNS.test(label.trim()) || CLOSE_PATTERNS.test(text)) return true;
      if (/\b(close|dismiss)\b/i.test(classText) || /\b(close|dismiss)\b/i.test(label)) return true;
    }
    return false;
  }

  function hasAdAttributes(el: Element): boolean {
    for (const name of AD_ATTRIBUTE_PATTERNS) {
      if (el.hasAttribute(name)) return true;
    }
    const id = el.id.toLowerCase();
    if (id.startsWith('div-gpt-ad') || id.startsWith('google_ads')) return true;
    const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    return className.includes('adsbygoogle');
  }

  /** Collects hosts of descendant iframes, so ad networks can be recognized. */
  function iframeHostsOf(el: Element): string[] {
    const hosts: string[] = [];
    const iframes = el.querySelectorAll('iframe');
    const limit = Math.min(iframes.length, 20);
    for (let i = 0; i < limit; i += 1) {
      const src = iframes[i]?.getAttribute('src') ?? '';
      if (src === '') continue;
      try {
        hosts.push(new URL(src, document.baseURI).hostname.toLowerCase());
      } catch {
        // Malformed src: ignore rather than fail the whole extraction.
      }
    }
    return hosts;
  }

  function countLongParagraphs(el: Element): number {
    const paragraphs = el.querySelectorAll('p');
    let count = 0;
    for (let i = 0; i < paragraphs.length; i += 1) {
      if ((paragraphs[i]?.textContent ?? '').trim().length > 100) count += 1;
    }
    // An element that IS a long paragraph counts as one.
    if (el.tagName === 'P' && (el.textContent ?? '').trim().length > 100) count += 1;
    return count;
  }

  function countMeaningfulImages(el: Element): number {
    const images = el.querySelectorAll('img');
    let count = 0;
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      if (!img) continue;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const described = img.alt.trim() !== '' || img.closest('figure') !== null;
      if (w >= 200 && h >= 150 && described) count += 1;
    }
    return count;
  }

  function linkTextLengthOf(el: Element): number {
    const links = el.querySelectorAll('a');
    let total = 0;
    for (let i = 0; i < links.length; i += 1) {
      total += (links[i]?.textContent ?? '').trim().length;
    }
    return total;
  }

  /** Depth-first walk assigning ids in document order. */
  function walk(el: Element, parentId: ElementId | null, depth: number): ElementId | null {
    totalElements += 1;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (!MEANINGFUL_TAGS.has(el.tagName)) {
      // Still descend: a wrapper we skip may contain meaningful children.
      for (const child of Array.from(el.children)) walk(child, parentId, depth + 1);
      return null;
    }

    counter += 1;
    const id = `w2p-${counter}` as ElementId;
    el.setAttribute(idAttribute, id);

    const childIds: ElementId[] = [];
    for (const child of Array.from(el.children)) {
      const childId = walk(child, id, depth + 1);
      if (childId !== null) childIds.push(childId);
    }

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const text = (el.textContent ?? '').trim();
    const linkText = linkTextLengthOf(el);
    const hosts = iframeHostsOf(el);

    facts.push({
      id,
      parentId,
      childIds,
      tag: el.tagName,
      classNames: typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [],
      elementId: el.id,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      ariaModal: el.getAttribute('aria-modal') === 'true',

      x: rect.x,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      viewportCoverage: Math.min(1, (rect.width * rect.height) / viewportArea),

      position: style.position,
      zIndex: parseZIndex(style.zIndex),
      display: style.display,
      visibility: style.visibility,
      opacity: Number.parseFloat(style.opacity) || 1,
      hasBackdropAppearance: looksLikeBackdrop(el, style, rect),
      overflowHidden: style.overflow === 'hidden',

      textLength: text.length,
      linkTextLength: linkText,
      linkCount: el.querySelectorAll('a').length,
      longParagraphCount: countLongParagraphs(el),
      commaCount: (text.match(/[,،、]/g) ?? []).length,
      headingCount: el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      imageCount: el.querySelectorAll('img,picture').length,
      meaningfulImageCount: countMeaningfulImages(el),
      listItemCount: el.querySelectorAll('li').length,
      tableRowCount: el.querySelectorAll('tr').length,
      inputCount: el.querySelectorAll('input,textarea,select').length,

      depth,
      descendantCount: el.querySelectorAll('*').length,
      iframeHosts: hosts,
      iframeCount: hosts.length,
      hasAdSlotAttributes: hasAdAttributes(el),
      hasCloseButton: hasCloseControl(el),
      bodyScrollLocked,
      hasStandardAdDimensions: false,
    });

    return id;
  }

  walk(document.body, null, 0);

  return {
    facts,
    title: document.title,
    lang: document.documentElement.lang || 'en',
    totalElements,
  };
}
