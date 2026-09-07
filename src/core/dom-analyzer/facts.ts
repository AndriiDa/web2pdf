/**
 * `NodeFacts` — the serializable summary of a DOM element.
 *
 * This type is the seam between the browser and the pure scorers. The in-page
 * script reduces each element to these plain fields; every classifier then runs
 * as a pure function over `NodeFacts[]`, so ad and popup detection is fully
 * unit-testable from JSON fixtures with no Chromium (spec §37).
 */

import type { ElementId } from '@/core/types';

export interface NodeFacts {
  readonly id: ElementId;
  readonly parentId: ElementId | null;
  readonly childIds: readonly ElementId[];
  /** Uppercase tag name, e.g. "DIV". */
  readonly tag: string;
  readonly classNames: readonly string[];
  readonly elementId: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly ariaModal: boolean;

  // --- Geometry (viewport-relative, at capture width) ---------------------
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Fraction of the viewport this element covers, 0..1. */
  readonly viewportCoverage: number;

  // --- Computed style (only the properties detection needs) ---------------
  readonly position: string;
  readonly zIndex: number;
  readonly display: string;
  readonly visibility: string;
  readonly opacity: number;
  /** True when the background is a translucent/dark full-bleed colour. */
  readonly hasBackdropAppearance: boolean;
  readonly overflowHidden: boolean;

  // --- Content statistics -------------------------------------------------
  readonly textLength: number;
  /** Characters inside descendant <a> elements. */
  readonly linkTextLength: number;
  readonly linkCount: number;
  /** Paragraphs with more than 100 characters. */
  readonly longParagraphCount: number;
  readonly commaCount: number;
  readonly headingCount: number;
  readonly imageCount: number;
  /** Images at least 200x150 with alt text or a caption. */
  readonly meaningfulImageCount: number;
  readonly listItemCount: number;
  readonly tableRowCount: number;
  readonly inputCount: number;

  // --- Structural ---------------------------------------------------------
  readonly depth: number;
  readonly descendantCount: number;
  /** Hosts of descendant iframes, lowercased. */
  readonly iframeHosts: readonly string[];
  readonly iframeCount: number;
  /** Matches a known ad-slot attribute (data-ad-*, adsbygoogle, div-gpt-ad). */
  readonly hasAdSlotAttributes: boolean;
  /** Has a descendant that looks like a close/dismiss control. */
  readonly hasCloseButton: boolean;
  /** True when <body> had scrolling locked while this element was visible. */
  readonly bodyScrollLocked: boolean;
  /** Fixed height matching a standard ad unit (250/280/90/600px etc.). */
  readonly hasStandardAdDimensions: boolean;
}

/** Text density: characters per thousand square pixels. */
export function textDensity(facts: NodeFacts): number {
  const area = facts.width * facts.height;
  if (area <= 0) return 0;
  return (facts.textLength / area) * 1000;
}

/** Fraction of text inside links, 0..1. Navigation and ad blocks run high. */
export function linkDensity(facts: NodeFacts): number {
  if (facts.textLength <= 0) return 0;
  return Math.min(1, facts.linkTextLength / facts.textLength);
}
