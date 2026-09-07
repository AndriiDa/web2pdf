/**
 * Builds the print document from a snapshot plus the user's edits.
 *
 * The output is a complete standalone HTML document with no external
 * references, used for BOTH the PDF render and the preview iframe — which is
 * what makes §13's "the preview reflects the actual PDF" true rather than
 * approximate.
 */

import type { ElementId, ElementState, PdfSettings } from '@/core/types';
import { ID_ATTRIBUTE } from '@/core/types';
import type { PageSnapshot } from '@/browser/snapshot/capture';
import { buildPrintStylesheet } from './stylesheet';

/** Id of the container the pagination engine measures against. */
export const PRINT_ROOT_ID = 'w2p-print-root';

export interface BuildDocumentOptions {
  readonly snapshot: PageSnapshot;
  readonly states: ReadonlyMap<ElementId, ElementState>;
  readonly settings: PdfSettings;
  readonly contentWidthPx: number;
  /** Base URL for large images kept out of the HTML, e.g. /api/session/x/asset. */
  readonly assetBaseUrl?: string;
  /** Draws page-boundary guides. Preview only — never in the PDF. */
  readonly showPageGuides?: boolean;
  readonly contentHeightPx?: number;
}

/**
 * Escapes a value for safe use inside an HTML attribute selector context.
 * Ids are generated internally (`w2p-<n>`), but this keeps the contract
 * explicit rather than relying on that.
 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Produces the CSS that applies the user's edits.
 *
 * Removal is NOT done here: removed nodes are stripped from the markup
 * entirely (§12 forbids "fake overlays that merely cover content"), and
 * detaching them is also what lets the pagination pass measure reality.
 */
function buildStateCss(states: ReadonlyMap<ElementId, ElementState>): string {
  const hidden: string[] = [];
  for (const [id, state] of states) {
    if (state === 'hidden') hidden.push(`[${ID_ATTRIBUTE}="${safeId(id)}"]`);
  }
  if (hidden.length === 0) return '';

  // Space is preserved; only painting is suppressed.
  return `${hidden.join(',\n')} { visibility: hidden !important; }\n` +
    `${hidden.map((s) => `${s} *`).join(',\n')} { visibility: hidden !important; }`;
}

/** Optional dashed guides showing where pages will break, for the preview. */
function buildPageGuideCss(contentHeightPx: number): string {
  return `
#${PRINT_ROOT_ID} {
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent ${contentHeightPx - 1}px,
    rgba(220, 38, 38, 0.35) ${contentHeightPx - 1}px,
    rgba(220, 38, 38, 0.35) ${contentHeightPx}px
  );
}`.trim();
}

/**
 * Ids whose elements must be detached before rendering.
 *
 * The removal itself happens at each consumer: the PDF renderer detaches them
 * in-page via page.evaluate, and the preview route strips them during
 * sanitization. Both detach rather than hide, so the two views agree (§12).
 */
export function removedIdList(states: ReadonlyMap<ElementId, ElementState>): string[] {
  const ids: string[] = [];
  for (const [id, state] of states) {
    if (state === 'removed') ids.push(safeId(id));
  }
  return ids;
}

/**
 * Assembles the standalone print document.
 *
 * No <script> tags are emitted: the preview iframe runs with scripts disabled,
 * and the PDF renderer applies removals through `page.evaluate` instead. That
 * keeps the same markup safe for both consumers (§31, §32).
 */
export function buildPrintDocument(options: BuildDocumentOptions): string {
  const { snapshot, states, settings, contentWidthPx } = options;

  const printCss = buildPrintStylesheet({ settings, contentWidthPx });
  const stateCss = buildStateCss(states);
  const guideCss =
    options.showPageGuides && options.contentHeightPx
      ? buildPageGuideCss(options.contentHeightPx)
      : '';

  // Origin CSS is inserted BEFORE the print stylesheet so our rules win.
  return `<!DOCTYPE html>
<html lang="${escapeAttribute(snapshot.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${contentWidthPx}">
<title>${escapeHtml(settings.documentTitle || snapshot.title)}</title>
<style id="w2p-origin-css">
${snapshot.css}
</style>
<style id="w2p-print-css">
${printCss}
</style>
<style id="w2p-state-css">
${stateCss}
${guideCss}
</style>
</head>
<body>
<div id="${PRINT_ROOT_ID}" data-w2p-print="1">
${snapshot.html}
</div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
