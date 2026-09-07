/**
 * GET /api/session/:id/preview — the cleaned document for the editor iframe.
 *
 * Isolation strategy (§32):
 *  - served from an API route, rendered in an iframe with `sandbox` that
 *    OMITS `allow-scripts`, so no script in this document can ever execute;
 *  - sanitized server-side as a second layer, stripping scripts, handlers and
 *    dangerous URL schemes;
 *  - a restrictive CSP header as a third layer.
 *
 * Because scripts cannot run inside the frame, the PARENT owns interactivity:
 * it reaches in through `contentDocument` to attach hover and click handling.
 * The document itself is inert markup.
 */

import { getSession, snapshotOf } from '@/core/session-manager/store';
import { toAppError, toPublicBody } from '@/lib/errors';
import { NextResponse } from 'next/server';
import { deriveSettings, deriveStates } from '@/core/session-manager/actions';
import { buildPrintDocument, removedIdList } from '@/browser/print-layout-engine/apply';
import { pageGeometry } from '@/core/pagination-engine/geometry';
import { sanitizePreviewHtml, stripElementsById } from '@/lib/sanitize';
import { hasFooterContent, hasHeaderContent } from '@/browser/pdf-generator/header-footer';
import { ID_ATTRIBUTE } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Editor affordances (§35). Kept subtle so selecting an element does not
 * visibly change the document layout — outlines draw outside the box.
 */
const EDITOR_CSS = `
[${ID_ATTRIBUTE}] { cursor: pointer; }
[${ID_ATTRIBUTE}]:hover {
  outline: 1px dashed rgba(37, 99, 235, 0.55);
  outline-offset: 1px;
}
[data-w2p-selected="1"] {
  outline: 2px solid #2563eb !important;
  outline-offset: 2px;
  background-color: rgba(37, 99, 235, 0.06) !important;
}
[data-w2p-contested="1"] {
  outline: 1px dotted rgba(217, 119, 6, 0.8);
  outline-offset: 1px;
}
`;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const session = getSession(id);

    const snapshot = snapshotOf(session);
    const states = deriveStates(session.log, session.elements.keys());
    const settings = deriveSettings(session.log, session.settings);

    const geometry = pageGeometry({
      margins: settings.margins,
      hasHeader: hasHeaderContent({ settings, sourceUrl: session.sourceUrl, title: session.title }),
      hasFooter: hasFooterContent(settings),
    });

    // Removed elements are stripped from the served markup entirely, matching
    // what the PDF renderer does, so the two views agree (§13).
    const removed = new Set(removedIdList(states));

    let html = buildPrintDocument({
      snapshot,
      states,
      settings,
      contentWidthPx: geometry.contentWidth,
      showPageGuides: true,
      contentHeightPx: geometry.contentHeight,
    });

    // Removed elements are DETACHED, exactly as the PDF renderer detaches them.
    // Hiding them with CSS instead would leave the preview and the PDF
    // describing different documents, and §12 forbids covering content rather
    // than removing it.
    html = stripElementsById(html, removed);
    html = sanitizePreviewHtml(html);

    // Mark contested elements so the editor can highlight them for review.
    const contestedIds: string[] = [];
    for (const [elementId, record] of session.elements) {
      if (record.contested && !removed.has(elementId)) contestedIds.push(elementId);
    }

    const injected = html.replace(
      '</head>',
      `<style id="w2p-editor-css">${EDITOR_CSS}</style>
<style id="w2p-contested-css">${
        contestedIds.length > 0
          ? `${contestedIds.map((cid) => `[${ID_ATTRIBUTE}="${cid}"]`).join(',')} { outline: 1px dotted rgba(217,119,6,.8); outline-offset: 1px; }`
          : ''
      }</style>
</head>`,
    );

    return new Response(injected, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, must-revalidate',
        'x-content-type-options': 'nosniff',
        // Third isolation layer: even if markup slipped through sanitization,
        // no script may execute and no network request may leave this frame.
        'content-security-policy':
          "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; " +
          "font-src data:; script-src 'none'; frame-ancestors 'self'; form-action 'none'",
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
