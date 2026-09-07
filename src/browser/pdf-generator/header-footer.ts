/**
 * Running header and footer templates (spec §24).
 *
 * Chromium renders these into the page's margin boxes. Because the print
 * stylesheet sets `@page { margin: 0 }` and the geometry module already
 * subtracts header/footer bands from the usable content height, these can never
 * overlap body content — the space is reserved before pagination is planned.
 */

import type { PdfSettings } from '@/core/types';

/** Escapes text destined for the header/footer HTML templates. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shortens a URL so it fits on one line in the footer. */
function shortenUrl(rawUrl: string, maxLength = 90): string {
  try {
    const url = new URL(rawUrl);
    const display = `${url.hostname}${url.pathname}`.replace(/\/$/, '');
    return display.length <= maxLength ? display : `${display.slice(0, maxLength - 1)}…`;
  } catch {
    return rawUrl.slice(0, maxLength);
  }
}

const BASE_STYLE =
  'font-family: Helvetica, Arial, sans-serif; font-size: 8px; color: #666; ' +
  'width: 100%; padding: 0 17mm; box-sizing: border-box; ' +
  '-webkit-print-color-adjust: exact;';

export interface TemplateOptions {
  readonly settings: PdfSettings;
  readonly sourceUrl: string;
  readonly title: string;
}

export function buildHeaderTemplate(options: TemplateOptions): string {
  const { settings, title } = options;
  if (!settings.documentTitle && !title) return '<span></span>';

  const heading = escapeHtml(settings.documentTitle || title);
  return `<div style="${BASE_STYLE} text-align: left; border-bottom: 0.5px solid #ddd; padding-bottom: 2mm;">${heading}</div>`;
}

export function buildFooterTemplate(options: TemplateOptions): string {
  const { settings, sourceUrl } = options;
  const parts: string[] = [];

  if (settings.showSourceUrl && sourceUrl) {
    parts.push(`<span style="flex: 1; text-align: left;">${escapeHtml(shortenUrl(sourceUrl))}</span>`);
  }

  if (settings.showDate) {
    const date = new Date().toISOString().slice(0, 10);
    parts.push(`<span style="flex: 1; text-align: center;">${date}</span>`);
  }

  if (settings.pageNumbers) {
    // Chromium substitutes these spans with live values.
    parts.push(
      '<span style="flex: 1; text-align: right;">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span>' +
        '</span>',
    );
  }

  if (parts.length === 0) return '<span></span>';

  return `<div style="${BASE_STYLE} display: flex; align-items: center;">${parts.join('')}</div>`;
}

/** True when anything will actually be drawn in the header band. */
export function hasHeaderContent(options: TemplateOptions): boolean {
  return Boolean(options.settings.documentTitle || options.title);
}

/** True when anything will actually be drawn in the footer band. */
export function hasFooterContent(settings: PdfSettings): boolean {
  return settings.pageNumbers || settings.showSourceUrl || settings.showDate;
}
