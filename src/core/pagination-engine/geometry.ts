/**
 * A4 page geometry (spec §14).
 *
 * Pure arithmetic, no browser. The invariant that makes the whole pipeline work
 * (plan §2): the page is captured at exactly `contentWidth`, so every measured
 * rectangle is valid at print time and the preview matches the PDF.
 */

import type { MarginPreset } from '@/core/types';

/** CSS reference pixel: 96 dpi, so 1mm = 96/25.4 px. */
export const PX_PER_MM = 96 / 25.4;

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/** True A4 in CSS pixels: 793.7 x 1122.5. */
export const A4_WIDTH_PX = A4_WIDTH_MM * PX_PER_MM;
export const A4_HEIGHT_PX = A4_HEIGHT_MM * PX_PER_MM;

/** Margin presets in millimetres (§25). */
const MARGIN_MM: Record<MarginPreset, number> = {
  narrow: 10,
  normal: 17.5,
  wide: 25,
};

/** Vertical space reserved for the running header/footer, in mm (§24). */
const HEADER_MM = 8;
const FOOTER_MM = 10;

export interface PageGeometry {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  /** Usable width — and the mandated capture viewport width. */
  readonly contentWidth: number;
  /** Usable height per page, after margins and header/footer reservations. */
  readonly contentHeight: number;
  readonly headerHeight: number;
  readonly footerHeight: number;
}

export interface GeometryOptions {
  readonly margins: MarginPreset;
  /** Reserve header space only when something is actually rendered there. */
  readonly hasHeader?: boolean;
  readonly hasFooter?: boolean;
}

/**
 * Computes page geometry. Header/footer bands are subtracted from the content
 * height rather than drawn over it, which is how §24 "must not overlap the
 * content" is guaranteed structurally instead of by tuning.
 */
export function pageGeometry(options: GeometryOptions): PageGeometry {
  const marginPx = MARGIN_MM[options.margins] * PX_PER_MM;
  const headerHeight = options.hasHeader === true ? HEADER_MM * PX_PER_MM : 0;
  const footerHeight = options.hasFooter === true ? FOOTER_MM * PX_PER_MM : 0;

  const contentWidth = A4_WIDTH_PX - marginPx * 2;
  const contentHeight = A4_HEIGHT_PX - marginPx * 2 - headerHeight - footerHeight;

  return {
    pageWidth: A4_WIDTH_PX,
    pageHeight: A4_HEIGHT_PX,
    marginTop: marginPx,
    marginRight: marginPx,
    marginBottom: marginPx,
    marginLeft: marginPx,
    contentWidth,
    contentHeight,
    headerHeight,
    footerHeight,
  };
}

/** Zero-based page index containing a given y offset in the content flow. */
export function pageIndexAt(y: number, contentHeight: number): number {
  if (contentHeight <= 0) return 0;
  return Math.floor(y / contentHeight);
}

/** The y offset where the page containing `y` ends. */
export function pageEndAfter(y: number, contentHeight: number): number {
  return (pageIndexAt(y, contentHeight) + 1) * contentHeight;
}

/** Total pages needed for a flow of the given height. */
export function pageCountFor(totalHeight: number, contentHeight: number): number {
  if (contentHeight <= 0) return 1;
  return Math.max(1, Math.ceil(totalHeight / contentHeight));
}

/** Millimetre string for CSS `@page`, avoiding float noise in the stylesheet. */
export function mm(value: number): string {
  return `${Math.round(value * 1000) / 1000}mm`;
}

/** Margin size in millimetres, for building the print stylesheet. */
export function marginMm(preset: MarginPreset): number {
  return MARGIN_MM[preset];
}
