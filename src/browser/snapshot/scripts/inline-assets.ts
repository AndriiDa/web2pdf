/**
 * In-page serialization to a self-contained document (plan §1).
 *
 * Runs inside the target page. Produces HTML that renders identically without
 * any network access, so PDF regeneration never re-fetches the origin site and
 * the preview cannot leak requests back to it.
 *
 * Three jobs:
 *  1. Prune CSS to only the rules that match surviving elements.
 *  2. Resolve images to their actually-rendered source, inlining small ones.
 *  3. Freeze canvases and other live content into static equivalents.
 */

export interface InlineOptions {
  readonly maxInlineImageBytes: number;
  readonly idAttribute: string;
}

export interface InlineResult {
  readonly html: string;
  readonly css: string;
  /** Images too large to inline, to be served as session assets. */
  readonly externalAssets: Array<{ readonly hash: string; readonly url: string }>;
  readonly inlinedImageCount: number;
  readonly droppedImageCount: number;
}

/** The function injected into the page. Must be fully self-contained. */
export async function inlineAssetsInPage(options: InlineOptions): Promise<InlineResult> {
  const externalAssets: Array<{ hash: string; url: string }> = [];
  let inlinedImageCount = 0;
  let droppedImageCount = 0;

  /** Short stable hash for asset identity. */
  function hashString(value: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).padStart(16, '0').slice(0, 16);
  }

  // --- 1. CSS pruning ------------------------------------------------------
  /**
   * Keeps only rules that match something still in the document. This drops the
   * responsive, dark-mode and sticky rules §26 warns about, and shrinks a
   * typical framework stylesheet by an order of magnitude.
   */
  function collectMatchingCss(): string {
    const kept: string[] = [];

    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        // Cross-origin stylesheets throw here; those elements keep their
        // computed styles via the print stylesheet instead.
        const cssRules = (sheet as CSSStyleSheet).cssRules;
        if (!cssRules) continue;
        rules = cssRules;
      } catch {
        continue;
      }

      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (document.querySelector(rule.selectorText)) kept.push(rule.cssText);
          } catch {
            // Invalid or unsupported selector: skip it.
          }
        } else if (rule instanceof CSSFontFaceRule) {
          kept.push(rule.cssText);
        } else if (rule instanceof CSSMediaRule) {
          // Keep only print and all-media rules; screen-width rules would
          // reflow the fixed-width print container unpredictably.
          const media = rule.conditionText || '';
          if (media.includes('print') || media === 'all' || media === '') {
            kept.push(rule.cssText);
          }
        }
      }
    }

    return kept.join('\n');
  }

  // --- 2. Images -----------------------------------------------------------
  /** Re-encodes an image through canvas, producing a data URI. */
  function toDataUri(img: HTMLImageElement): string | null {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      // PNG preserves transparency; JPEG is far smaller for photographs.
      const hasAlpha = /\.png($|\?)/i.test(img.currentSrc || img.src);
      return canvas.toDataURL(hasAlpha ? 'image/png' : 'image/jpeg', 0.82);
    } catch {
      // Tainted canvas (cross-origin image without CORS) — cannot read pixels.
      return null;
    }
  }

  function processImages(): void {
    for (const img of Array.from(document.images)) {
      // §8: resolve srcset/lazy loading to the candidate actually rendered.
      const resolved = img.currentSrc || img.src;

      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
      img.removeAttribute('data-src');
      img.removeAttribute('data-srcset');
      img.removeAttribute('data-lazy-src');

      if (!resolved || img.naturalWidth === 0) {
        // Broken or never-loaded image: remove it rather than print a gap.
        img.remove();
        droppedImageCount += 1;
        continue;
      }

      // Lock in the intrinsic ratio so layout cannot shift during re-render.
      img.setAttribute('width', String(img.naturalWidth));
      img.setAttribute('height', String(img.naturalHeight));

      if (resolved.startsWith('data:')) {
        inlinedImageCount += 1;
        continue;
      }

      const estimatedBytes = img.naturalWidth * img.naturalHeight * 0.4;
      if (estimatedBytes <= options.maxInlineImageBytes) {
        const dataUri = toDataUri(img);
        if (dataUri) {
          img.src = dataUri;
          inlinedImageCount += 1;
          continue;
        }
      }

      // Too large (or cross-origin tainted): serve it as a session asset.
      const hash = hashString(resolved);
      externalAssets.push({ hash, url: resolved });
      img.setAttribute('data-w2p-asset', hash);
      img.src = resolved;
    }
  }

  // --- 3. Live content -> static equivalents (§21, §22) --------------------
  function freezeDynamicContent(): void {
    // Charts drawn to canvas only survive as images.
    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      try {
        if (canvas.width === 0 || canvas.height === 0) continue;
        const dataUri = canvas.toDataURL('image/png');
        const img = document.createElement('img');
        img.src = dataUri;
        img.width = canvas.width;
        img.height = canvas.height;
        const idAttr = canvas.getAttribute(options.idAttribute);
        if (idAttr) img.setAttribute(options.idAttribute, idAttr);
        canvas.replaceWith(img);
      } catch {
        // Tainted canvas: leave it, the print CSS will size it sensibly.
      }
    }

    // §21: keep the poster frame, drop the player.
    for (const video of Array.from(document.querySelectorAll('video'))) {
      const poster = video.getAttribute('poster');
      const idAttr = video.getAttribute(options.idAttribute);
      if (poster) {
        const img = document.createElement('img');
        img.src = poster;
        if (idAttr) img.setAttribute(options.idAttribute, idAttr);
        video.replaceWith(img);
      } else {
        // No poster: a blank video box is worse than nothing (§21).
        video.remove();
      }
    }

    // Scripts and live regions must never reach the snapshot.
    for (const el of Array.from(
      document.querySelectorAll('script, noscript, template, link[rel="preload"], iframe'),
    )) {
      el.remove();
    }

    // Expand details so their content is visible in print (§22).
    for (const details of Array.from(document.querySelectorAll('details'))) {
      details.setAttribute('open', '');
    }

    // Inputs keep their current value as static text (§22).
    for (const input of Array.from(document.querySelectorAll('input'))) {
      if (input.value) input.setAttribute('value', input.value);
    }
  }

  processImages();
  freezeDynamicContent();
  const css = collectMatchingCss();

  return {
    html: document.body.innerHTML,
    css,
    externalAssets,
    inlinedImageCount,
    droppedImageCount,
  };
}
