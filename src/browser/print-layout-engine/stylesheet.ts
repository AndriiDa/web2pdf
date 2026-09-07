/**
 * The controlled print environment (spec §20, §26).
 *
 * Original page CSS is deliberately NOT trusted: real sites ship sticky
 * headers, fixed overlays, viewport-relative units, dark mode, animations and
 * complex grids, none of which survive pagination sensibly. This stylesheet is
 * injected last and overrides those behaviours so the document has a stable
 * width, predictable typography and normal block flow — which is exactly what
 * the measurement pass in the pagination engine assumes.
 */

import type { MarginPreset, PdfSettings } from '@/core/types';
import { HIDDEN_ATTRIBUTE } from '@/core/types';
import { marginMm, mm, A4_WIDTH_MM } from '@/core/pagination-engine/geometry';

export interface PrintStylesheetOptions {
  readonly settings: PdfSettings;
  readonly contentWidthPx: number;
}

/**
 * `@page` uses `margin: 0` and the document supplies its own padding.
 * That keeps the content flow one continuous, measurable column: page boundary
 * k is exactly `k * contentHeight`, which is what makes the break planner's
 * arithmetic valid.
 */
export function buildPrintStylesheet(options: PrintStylesheetOptions): string {
  const { settings, contentWidthPx } = options;
  // Margins are applied via page.pdf() options rather than @page, so the
  // content flow stays one continuous measurable column (see pagination plan).
  void settings;

  return `
/* ---- Page geometry (§14) ---- */
@page {
  size: ${mm(A4_WIDTH_MM)} ${mm(297)};
  margin: 0;
}

/* ---- Reset the site's viewport-dependent behaviour (§26) ---- */
html, body {
  width: ${contentWidthPx}px !important;
  min-width: 0 !important;
  max-width: ${contentWidthPx}px !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: visible !important;
  background: #ffffff !important;
  color: #111111 !important;
  font-size: 11pt;
  line-height: 1.55;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Sticky/fixed positioning cannot survive pagination: an element pinned to the
   viewport would repeat or float over every page. Force normal flow. */
*, *::before, *::after {
  position: static !important;
  float: none !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
  will-change: auto !important;
  backdrop-filter: none !important;
  filter: none !important;
  box-shadow: none !important;
  max-width: 100% !important;
}

/* Flex and grid fragment unreliably across pages in Chromium, and
   break-inside:avoid is not honoured inside them. Collapse to block flow. */
[data-w2p-print] *,
body * {
  display: revert;
}
body [style*="position:fixed"],
body [style*="position: fixed"] {
  display: none !important;
}

/* Restore block layout for common flex/grid containers while leaving inline
   elements alone, so text formatting survives.

   Deliberately does NOT reset the height property: many sites size real
   content boxes (media blocks, spacers, aspect-ratio wrappers) with an
   explicit height, and forcing height:auto collapses them to nothing, so the
   content vanishes from the PDF. Only max-height is lifted, since that is what
   clips content, and overflow is made visible so nothing is cropped. */
div, section, article, main, aside, header, footer, nav, figure, form, ul, ol, dl {
  display: block !important;
  width: auto !important;
  max-height: none !important;
  overflow: visible !important;
}

/* ---- The print container: one continuous measurable column ---- */
#w2p-print-root {
  width: ${contentWidthPx}px;
  margin: 0 auto;
  padding: 0;
  box-sizing: border-box;
  background: #ffffff;
}

/* ---- Typography (§20) ---- */
body, p, li, td, th, blockquote, figcaption, dd, dt {
  font-family: "Georgia", "Times New Roman", serif;
  color: #111111;
}
h1, h2, h3, h4, h5, h6 {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #000000;
  line-height: 1.25;
  margin: 1.1em 0 0.45em;
  /* §16: a heading must not be the last thing on a page. */
  break-after: avoid-page;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
  orphans: 3;
  widows: 3;
}
h1 { font-size: 22pt; }
h2 { font-size: 17pt; }
h3 { font-size: 14pt; }
h4 { font-size: 12pt; }
h5, h6 { font-size: 11pt; }

p {
  margin: 0 0 0.75em;
  /* Never strand a single line of a paragraph across a page break. */
  orphans: 3;
  widows: 3;
}

a {
  /* §23: links stay clickable and readable, never rendered as raw URLs. */
  color: #0b4fa8;
  text-decoration: underline;
}

/* ---- Images (§8, §17) ---- */
img, picture, svg, canvas, video {
  max-width: 100% !important;
  height: auto !important;
  break-inside: avoid;
  page-break-inside: avoid;
  object-fit: contain;
}
figure {
  margin: 1em 0;
  /* Keeps an image and its caption together as one unit. */
  break-inside: avoid;
  page-break-inside: avoid;
}
figcaption {
  font-size: 9pt;
  color: #444444;
  margin-top: 0.35em;
  break-before: avoid;
  page-break-before: avoid;
}

/* ---- Tables (§18) ---- */
table {
  border-collapse: collapse;
  width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed;
  font-size: 9.5pt;
  margin: 1em 0;
}
/* Chromium repeats these on every page a table spans — exactly what §18 wants. */
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
th, td {
  border: 1px solid #cccccc;
  padding: 4px 6px;
  text-align: left;
  vertical-align: top;
  word-break: break-word;
  overflow-wrap: anywhere;
}
th { background: #f3f3f3; font-weight: 600; }

/* ---- Code (§19) ---- */
pre {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 8.5pt;
  line-height: 1.45;
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 3px;
  padding: 8px 10px;
  /* Wrap rather than clip; large blocks may split between pages. */
  white-space: pre-wrap !important;
  overflow-wrap: break-word;
  word-break: break-word;
  overflow: visible !important;
  break-inside: auto;
}
code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.92em;
  overflow-wrap: break-word;
}
pre code { font-size: inherit; background: none; padding: 0; }

blockquote {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid #d0d0d0;
  color: #333333;
  break-inside: avoid;
  page-break-inside: avoid;
}

ul, ol { margin: 0 0 0.8em; padding-left: 1.5em; }
li { margin: 0.2em 0; }

hr { border: none; border-top: 1px solid #dddddd; margin: 1.2em 0; }

/* ---- Interactive chrome has no place in a document (§20, §22) ---- */
button, input, select, textarea {
  /* Preserve the visible state; drop the interactive affordances. */
  appearance: none !important;
  -webkit-appearance: none !important;
  box-shadow: none !important;
}
video::-webkit-media-controls, audio { display: none !important; }

/* ---- Editing state (§12) ---- */
/* Hidden keeps the box and its space; removal detaches the node entirely, so
   there is no rule for it here. */
[${HIDDEN_ATTRIBUTE}] { visibility: hidden !important; }
/* visibility inherits, but a descendant can re-assert it — force the subtree. */
[${HIDDEN_ATTRIBUTE}] * { visibility: hidden !important; }

/* ---- Pagination helpers injected by the break planner ---- */
.w2p-spacer {
  display: block;
  width: 100%;
  /* Height is set inline per spacer by the planner. */
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
}
.w2p-atomic {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}
.w2p-scaled {
  transform-origin: top left;
}
`.trim();
}

/** Margin size in px for a preset, for callers that need pixels not mm. */
export function marginPx(preset: MarginPreset): number {
  return marginMm(preset) * (96 / 25.4);
}
