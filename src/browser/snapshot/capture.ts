/**
 * Snapshot capture: turns a live page into a self-contained document.
 *
 * This is the boundary that makes the whole architecture work (plan §1). After
 * this runs, the origin site is never contacted again: every PDF regeneration
 * renders the stored snapshot in a fresh short-lived context. That is what
 * makes the app work on serverless (where the instance handling a regenerate is
 * a different frozen instance) and what stops idle sessions from pinning
 * browser processes.
 */

import type { Page } from 'playwright-core';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger, type Logger } from '@/lib/logger';
import { classify } from '@/core/dom-analyzer/classify';
import type { NodeFacts } from '@/core/dom-analyzer/facts';
import {
  ID_ATTRIBUTE,
  asElementId,
  type ElementId,
  type ElementRecord,
  type BlockRole,
  type RemovalReason,
} from '@/core/types';
import { extractFactsInPage, type ExtractionResult } from './scripts/extract-facts';
import { inlineAssetsInPage, type InlineResult } from './scripts/inline-assets';

export interface PageSnapshot {
  /** Self-contained body HTML; every element carries `data-w2p-id`. */
  readonly html: string;
  /** Pruned CSS from the origin page, matching surviving elements only. */
  readonly css: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly lang: string;
  readonly capturedAt: number;
  /** The width the page was laid out at — must equal the print content width. */
  readonly contentWidthPx: number;
  /** Flat element index the editor renders. */
  readonly elements: ReadonlyMap<ElementId, ElementRecord>;
  /** Ids the auto-cleaner decided to remove, seeded as action-log entry 0. */
  readonly autoRemovedIds: readonly ElementId[];
  /** Large images served from the session rather than inlined. */
  readonly externalAssets: ReadonlyMap<string, string>;
  readonly stats: SnapshotStats;
}

export interface SnapshotStats {
  readonly htmlBytes: number;
  readonly elementCount: number;
  readonly imageCount: number;
  readonly inlinedImages: number;
  readonly droppedImages: number;
  readonly adsRemoved: number;
  readonly popupsRemoved: number;
  readonly contestedCount: number;
}

export interface CaptureOptions {
  readonly sourceUrl: string;
  readonly contentWidthPx: number;
  readonly log?: Logger;
}

/** Maps a tag to the coarse role used for editor labels and pagination. */
function roleForTag(tag: string): BlockRole {
  if (/^H[1-6]$/.test(tag)) return 'heading';
  switch (tag) {
    case 'P':
      return 'paragraph';
    case 'IMG':
    case 'PICTURE':
      return 'image';
    case 'FIGURE':
      return 'figure';
    case 'TABLE':
      return 'table';
    case 'UL':
    case 'OL':
    case 'DL':
      return 'list';
    case 'PRE':
    case 'CODE':
      return 'code';
    case 'BLOCKQUOTE':
      return 'quote';
    case 'VIDEO':
    case 'AUDIO':
    case 'CANVAS':
    case 'SVG':
      return 'media';
    case 'DIV':
    case 'SECTION':
    case 'ARTICLE':
    case 'MAIN':
    case 'ASIDE':
    case 'HEADER':
    case 'FOOTER':
    case 'NAV':
      return 'container';
    default:
      return 'other';
  }
}

/** Builds a short, safe label for the editor's context menu. */
function labelFor(facts: NodeFacts, role: BlockRole): string {
  const tag = facts.tag.toLowerCase();
  if (role === 'image') return 'Image';
  if (role === 'figure') return 'Figure';
  if (role === 'table') return `Table (${facts.tableRowCount} rows)`;
  if (role === 'code') return 'Code block';
  if (role === 'list') return `List (${facts.listItemCount} items)`;
  return `<${tag}>`;
}

/**
 * Captures the page. Runs extraction, classification and serialization in that
 * order, so removals are applied before CSS is pruned and assets are inlined —
 * removed subtrees then cost nothing in the stored snapshot.
 */
export async function capture(page: Page, options: CaptureOptions): Promise<PageSnapshot> {
  const config = getConfig();
  const log = options.log ?? logger;

  // --- 1. Extract facts and assign stable ids ------------------------------
  const extraction: ExtractionResult = await page.evaluate(extractFactsInPage, ID_ATTRIBUTE);
  log.debug('facts extracted', {
    elements: extraction.facts.length,
    totalElements: extraction.totalElements,
  });

  // --- 2. Classify (pure, runs server-side) --------------------------------
  const classification = classify(extraction.facts);
  const reasonById = new Map<ElementId, RemovalReason>();
  const contested = new Set<ElementId>(classification.contestedIds);
  const protectedIds = new Set<ElementId>();
  for (const item of classification.classifications) {
    if (item.decision === 'remove') reasonById.set(item.id, item.reason);
    if (item.isProtected) protectedIds.add(item.id);
  }

  let adsRemoved = 0;
  let popupsRemoved = 0;
  for (const id of classification.removeIds) {
    const reason = reasonById.get(id);
    if (reason === 'ad') adsRemoved += 1;
    else popupsRemoved += 1;
  }

  // --- 3. Detach the auto-removed subtrees in-page -------------------------
  // Detaching (rather than display:none) means the serialized HTML never
  // carries the removed content at all.
  await page.evaluate(
    ({ ids, attribute }) => {
      for (const id of ids) {
        document.querySelector(`[${attribute}="${id}"]`)?.remove();
      }
    },
    { ids: [...classification.removeIds] as string[], attribute: ID_ATTRIBUTE },
  );

  // --- 4. Serialize to a self-contained document ---------------------------
  const inlined: InlineResult = await page.evaluate(inlineAssetsInPage, {
    maxInlineImageBytes: config.maxInlineImageBytes,
    idAttribute: ID_ATTRIBUTE,
  });

  const htmlBytes = Buffer.byteLength(inlined.html, 'utf8');
  if (htmlBytes > config.maxPageSizeBytes) {
    throw new AppError('PAGE_TOO_LARGE', `snapshot ${htmlBytes} bytes`);
  }

  // --- 5. Build the element index the editor renders -----------------------
  const removed = new Set<ElementId>(classification.removeIds);
  const elements = new Map<ElementId, ElementRecord>();

  // Parent index built once; a per-element rebuild would be O(n^2) on long pages.
  const parentOf = new Map<ElementId, ElementId | null>();
  for (const facts of extraction.facts) parentOf.set(facts.id, facts.parentId);

  for (const facts of extraction.facts) {
    // Skip anything detached above, and anything inside it.
    if (removed.has(facts.id) || hasRemovedAncestor(facts.id, parentOf, removed)) continue;

    const role = roleForTag(facts.tag);
    elements.set(facts.id, {
      id: facts.id,
      parentId: facts.parentId,
      childIds: facts.childIds.filter((childId) => !removed.has(childId)),
      tag: facts.tag,
      role,
      label: labelFor(facts, role),
      rect: { x: facts.x, y: facts.y, w: facts.width, h: facts.height },
      ...(protectedIds.has(facts.id) ? { protected: true } : {}),
      ...(contested.has(facts.id) ? { contested: true } : {}),
    });
  }

  const externalAssets = new Map<string, string>();
  for (const asset of inlined.externalAssets) externalAssets.set(asset.hash, asset.url);

  const stats: SnapshotStats = {
    htmlBytes,
    elementCount: elements.size,
    imageCount: inlined.inlinedImageCount + inlined.droppedImageCount,
    inlinedImages: inlined.inlinedImageCount,
    droppedImages: inlined.droppedImageCount,
    adsRemoved,
    popupsRemoved,
    contestedCount: contested.size,
  };

  log.info('snapshot captured', {
    htmlBytes,
    elements: elements.size,
    adsRemoved,
    popupsRemoved,
    contested: contested.size,
    inlinedImages: inlined.inlinedImageCount,
  });

  return {
    html: inlined.html,
    css: inlined.css,
    title: extraction.title,
    sourceUrl: options.sourceUrl,
    lang: extraction.lang,
    capturedAt: Date.now(),
    contentWidthPx: options.contentWidthPx,
    elements,
    // Seeded as action-log entry 0 so "undo the ad remover" needs no special
    // case — it is just an undo like any other.
    autoRemovedIds: classification.removeIds,
    externalAssets,
    stats,
  };
}

/** True when any ancestor of `id` was removed. */
function hasRemovedAncestor(
  id: ElementId,
  parentOf: ReadonlyMap<ElementId, ElementId | null>,
  removed: ReadonlySet<ElementId>,
): boolean {
  let parentId = parentOf.get(id) ?? null;
  let guard = 0;
  while (parentId !== null && guard < 1000) {
    if (removed.has(parentId)) return true;
    parentId = parentOf.get(parentId) ?? null;
    guard += 1;
  }
  return false;
}

export { asElementId };
