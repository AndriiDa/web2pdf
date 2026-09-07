/**
 * In-page block measurement for the pagination engine.
 *
 * Two halves, both injected into the print document:
 *  - `measureBlocksInPage` reduces the DOM to the `Block[]` the pure planner
 *    consumes.
 *  - `applyMutationsInPage` writes the planner's decisions back.
 *
 * The critical performance rule is that all reads happen in one batch before
 * any write. Interleaving them forces a layout recalculation per element, which
 * turns a long article from ~50ms into tens of seconds.
 */

import type { Block } from '@/core/pagination-engine/plan';
import type { Mutation } from '@/core/pagination-engine/plan';
import type { BlockRole, ElementId } from '@/core/types';

export interface MeasureOptions {
  readonly idAttribute: string;
  readonly contentHeight: number;
  readonly rootId: string;
}

export interface MeasureResult {
  readonly blocks: Block[];
  readonly totalHeight: number;
}

/**
 * Walks the print container and returns the "block frontier": the shallowest
 * elements that are either atomic or small enough to place as a unit. Descends
 * into a tall <section> (it may legitimately span pages) but stops at a
 * <figure> (it must not).
 */
export function measureBlocksInPage(options: MeasureOptions): MeasureResult {
  const root = document.getElementById(options.rootId);
  if (!root) return { blocks: [], totalHeight: 0 };

  const ATOMIC_TAGS = new Set(['IMG', 'PICTURE', 'FIGURE', 'TABLE', 'TR', 'BLOCKQUOTE', 'SVG', 'CANVAS']);
  const SPLITTABLE_TAGS = new Set(['PRE', 'UL', 'OL', 'DL']);
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  const rootTop = root.getBoundingClientRect().top + window.scrollY;
  const blocks: Block[] = [];

  function roleOf(tag: string): BlockRole {
    if (HEADING_TAGS.has(tag)) return 'heading';
    if (tag === 'P') return 'paragraph';
    if (tag === 'IMG' || tag === 'PICTURE') return 'image';
    if (tag === 'FIGURE') return 'figure';
    if (tag === 'TABLE' || tag === 'TR') return 'table';
    if (tag === 'UL' || tag === 'OL' || tag === 'DL') return 'list';
    if (tag === 'PRE') return 'code';
    if (tag === 'BLOCKQUOTE') return 'quote';
    if (tag === 'CANVAS' || tag === 'SVG' || tag === 'VIDEO') return 'media';
    return 'other';
  }

  function lineHeightOf(el: Element): number {
    const style = window.getComputedStyle(el);
    const parsed = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    // `normal` resolves to roughly 1.2x the font size.
    const fontSize = Number.parseFloat(style.fontSize);
    return Number.isFinite(fontSize) ? fontSize * 1.2 : 16;
  }

  function visit(el: Element): void {
    const rect = el.getBoundingClientRect();
    const height = rect.height;
    if (height <= 0) return;

    const tag = el.tagName;
    const atomic = ATOMIC_TAGS.has(tag);
    const splittable = SPLITTABLE_TAGS.has(tag);
    const isHeading = HEADING_TAGS.has(tag);

    // Frontier rule: stop descending when the element is atomic, or small
    // enough that placing it whole is always the right call.
    const smallEnough = height <= options.contentHeight * 0.5;
    const isLeaf = el.children.length === 0;

    if (atomic || isHeading || smallEnough || isLeaf || splittable) {
      const id = el.getAttribute(options.idAttribute);
      if (id !== null) {
        blocks.push({
          id: id as ElementId,
          top: rect.top + window.scrollY - rootTop,
          height,
          role: roleOf(tag),
          atomic: atomic || isHeading,
          splittable,
          // §16: a heading must keep at least one following block with it.
          keepWithNext: isHeading ? 1 : 0,
          ...(isHeading ? { level: Number(tag.slice(1)) } : {}),
          ...(splittable || tag === 'PRE' ? { lineHeight: lineHeightOf(el) } : {}),
        });
      }
      return;
    }

    for (const child of Array.from(el.children)) visit(child);
  }

  for (const child of Array.from(root.children)) visit(child);

  // Document order by vertical position, which is what the planner assumes.
  blocks.sort((a, b) => a.top - b.top);

  return { blocks, totalHeight: root.getBoundingClientRect().height };
}

export interface ApplyOptions {
  readonly idAttribute: string;
  readonly mutations: Mutation[];
}

/**
 * Applies the planner's mutations. Pushes become spacer divs rather than
 * `break-before`, so the document stays a single continuous flow that the
 * measurement model still describes accurately.
 */
export function applyMutationsInPage(options: ApplyOptions): number {
  let applied = 0;

  for (const mutation of options.mutations) {
    const el = document.querySelector(`[${options.idAttribute}="${mutation.id}"]`);
    if (!el) continue;

    if (mutation.kind === 'push') {
      const spacer = document.createElement('div');
      spacer.className = 'w2p-spacer';
      spacer.style.height = `${mutation.value}px`;
      spacer.setAttribute('aria-hidden', 'true');
      el.parentNode?.insertBefore(spacer, el);
      applied += 1;
    } else if (mutation.kind === 'scale') {
      const element = el as HTMLElement;
      const rect = element.getBoundingClientRect();
      element.classList.add('w2p-scaled');
      element.style.transform = `scale(${mutation.value})`;
      // A transformed element keeps its ORIGINAL layout box, so the fragmenter
      // would still reserve the unscaled height. Wrapping with an explicit
      // height reconciles the visual and layout boxes.
      const wrapper = document.createElement('div');
      wrapper.style.height = `${rect.height * mutation.value}px`;
      wrapper.style.overflow = 'hidden';
      element.parentNode?.insertBefore(wrapper, element);
      wrapper.appendChild(element);
      applied += 1;
    } else if (mutation.kind === 'allow-split') {
      const element = el as HTMLElement;
      element.style.breakInside = 'auto';
      element.style.pageBreakInside = 'auto';
      applied += 1;
    }
  }

  return applied;
}
