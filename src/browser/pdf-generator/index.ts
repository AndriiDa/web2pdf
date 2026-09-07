/**
 * PDF generation (spec §8, §14-§19).
 *
 * The sequence that makes pagination intelligent rather than accidental:
 *   1. Build the print document from snapshot + edits.
 *   2. Load it into a blank page at exactly the print content width.
 *   3. Detach removed elements so measurement sees the real layout.
 *   4. Measure blocks -> plan breaks (pure) -> apply mutations. Repeat to a
 *      fixed point.
 *   5. Render with `preferCSSPageSize`, so the stylesheet's @page rule wins.
 */

import type { BrowserContext } from 'playwright-core';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger, describeError, type Logger } from '@/lib/logger';
import { ID_ATTRIBUTE, type ElementId, type ElementState, type PdfSettings } from '@/core/types';
import { planBreaks, type Block } from '@/core/pagination-engine/plan';
import { pageGeometry, pageCountFor } from '@/core/pagination-engine/geometry';
import type { PageSnapshot } from '@/browser/snapshot/capture';
import { buildPrintDocument, removedIdList, PRINT_ROOT_ID } from '@/browser/print-layout-engine/apply';
import { measureBlocksInPage, applyMutationsInPage, type MeasureResult } from '@/browser/snapshot/scripts/measure';
import {
  buildFooterTemplate,
  buildHeaderTemplate,
  hasFooterContent,
  hasHeaderContent,
} from './header-footer';

export interface RenderOptions {
  readonly snapshot: PageSnapshot;
  readonly states: ReadonlyMap<ElementId, ElementState>;
  readonly settings: PdfSettings;
  readonly log?: Logger;
}

export interface RenderResult {
  readonly pdf: Buffer;
  readonly pageCount: number;
  readonly appliedMutations: number;
  readonly paginationConverged: boolean;
  readonly warnings: readonly string[];
}

/** Passes to run before accepting the layout; the planner also caps itself. */
const MAX_LAYOUT_PASSES = 3;

/**
 * Renders a PDF from a snapshot. Uses a fresh page inside the supplied context,
 * always closing it, so no browser state leaks between renders.
 */
export async function renderPdf(
  context: BrowserContext,
  options: RenderOptions,
): Promise<RenderResult> {
  const config = getConfig();
  const log = options.log ?? logger;
  const { snapshot, states, settings } = options;

  const templateOptions = {
    settings,
    sourceUrl: snapshot.sourceUrl,
    title: snapshot.title,
  };
  const wantsHeader = hasHeaderContent(templateOptions);
  const wantsFooter = hasFooterContent(settings);

  const geometry = pageGeometry({
    margins: settings.margins,
    hasHeader: wantsHeader,
    hasFooter: wantsFooter,
  });

  const html = buildPrintDocument({
    snapshot,
    states,
    settings,
    contentWidthPx: geometry.contentWidth,
  });

  const page = await context.newPage();

  try {
    page.setDefaultTimeout(config.pdfTimeoutMs);

    // The document is fully self-contained, so nothing is fetched from the
    // origin site here — `domcontentloaded` is genuinely complete.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: config.pdfTimeoutMs });
    await page.setViewportSize({
      width: Math.round(geometry.contentWidth),
      height: Math.round(geometry.pageHeight),
    });

    // Detach removed elements. Detaching (never display:none) is what lets the
    // measurement pass below see the true post-edit layout.
    const removed = removedIdList(states);
    if (removed.length > 0) {
      await page.evaluate(
        ({ ids, attribute }) => {
          for (const id of ids) {
            document.querySelector(`[${attribute}="${id}"]`)?.remove();
          }
        },
        { ids: removed, attribute: ID_ATTRIBUTE },
      );
    }

    // Images must be decoded before anything is measured, or every height is
    // wrong and the whole plan is built on sand.
    await waitForLayoutReady(page);

    // --- The pagination fixpoint ------------------------------------------
    let appliedMutations = 0;
    let converged = false;
    const warnings: string[] = [];
    let totalHeight = 0;

    for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass += 1) {
      const measurement: MeasureResult = await page.evaluate(measureBlocksInPage, {
        idAttribute: ID_ATTRIBUTE,
        contentHeight: geometry.contentHeight,
        rootId: PRINT_ROOT_ID,
      });

      totalHeight = measurement.totalHeight;
      if (measurement.blocks.length === 0) {
        converged = true;
        break;
      }

      const plan = planBreaks(measurement.blocks as Block[], {
        contentHeight: geometry.contentHeight,
        budgetMs: config.paginationBudgetMs,
      });

      warnings.push(...plan.warnings);

      if (plan.mutations.length === 0) {
        converged = true;
        break;
      }

      const applied = await page.evaluate(applyMutationsInPage, {
        idAttribute: ID_ATTRIBUTE,
        mutations: [...plan.mutations],
      });
      appliedMutations += applied;

      // Let the browser reflow before the next measurement pass.
      await page.evaluate(() => {
        void document.body.getBoundingClientRect();
      });
    }

    // --- Render -------------------------------------------------------------
    const pdf = await page.pdf({
      // `preferCSSPageSize` hands page geometry to the stylesheet's @page rule,
      // which is what the measurement model assumes.
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: wantsHeader || wantsFooter,
      headerTemplate: wantsHeader ? buildHeaderTemplate(templateOptions) : '<span></span>',
      footerTemplate: wantsFooter ? buildFooterTemplate(templateOptions) : '<span></span>',
      margin: {
        top: `${geometry.marginTop + geometry.headerHeight}px`,
        bottom: `${geometry.marginBottom + geometry.footerHeight}px`,
        left: `${geometry.marginLeft}px`,
        right: `${geometry.marginRight}px`,
      },
      // page.pdf() takes no timeout option; the page default set above applies.
    });

    // Count pages from the PDF itself rather than estimating from the document
    // height: the estimate ignores how Chromium actually fragments the flow
    // (repeated table headers, avoided breaks) and drifts on long documents.
    const pageCount = countPdfPages(pdf) ?? pageCountFor(totalHeight, geometry.contentHeight);

    log.info('pdf rendered', {
      bytes: pdf.length,
      pageCount,
      appliedMutations,
      converged,
      warnings: warnings.length,
    });

    return {
      pdf,
      pageCount,
      appliedMutations,
      paginationConverged: converged,
      warnings,
    };
  } catch (error) {
    log.error('pdf generation failed', { detail: describeError(error) });
    throw new AppError('PDF_FAILED', describeError(error));
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Waits until images have decoded and fonts are ready, so measured heights are
 * final. Without this the plan is computed against a half-laid-out document.
 */
async function waitForLayoutReady(page: import('playwright-core').Page): Promise<void> {
  await page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(
      images.map(async (img) => {
        if (img.complete) return;
        await Promise.race([
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 3000);
          }),
        ]);
      }),
    );

    try {
      await document.fonts.ready;
    } catch {
      // Font Loading API unavailable; measurement proceeds regardless.
    }

    void document.body.getBoundingClientRect();
  });
}

/**
 * Reads the true page count from generated PDF bytes.
 *
 * Prefers the page-tree /Count entry, which is authoritative, and falls back to
 * counting /Type /Page objects. Returns null when neither is found, so the
 * caller can fall back to the height-based estimate.
 */
function countPdfPages(pdf: Buffer): number | null {
  const text = pdf.toString('latin1');

  /*
   * Count leaf page objects directly. The negative lookahead skips "/Type
   * /Pages" tree nodes.
   *
   * Deliberately NOT read from a /Count entry: Chromium emits a multi-level
   * page tree, so a document can contain several /Count values (8, 8, 8, 3, 27)
   * where only the root's is the true total. Picking the first match reported
   * 8 pages for a 27-page document. Counting leaves has no such ambiguity.
   */
  const leaves = text.match(/\/Type\s*\/Page(?![s])/g);
  return leaves && leaves.length > 0 ? leaves.length : null;
}
