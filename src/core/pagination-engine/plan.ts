/**
 * The break planner (spec §15-§19) — the core of intelligent pagination.
 *
 * This is a PURE function over measured geometry, so the whole algorithm is
 * unit-testable without a browser. The browser layer measures blocks, calls
 * `planBreaks`, and applies the returned mutations.
 *
 * The model: with `@page { margin: 0 }` and a single flat flow, page boundary
 * k sits at exactly `k * contentHeight`. We therefore never have to ask
 * Chromium where it intends to break — we compute it, and insert spacers to
 * move that intent where we want it.
 *
 * Termination (the part that is easy to get wrong) rests on three guards:
 *   1. Pushes only ever move a block FORWARD, so page indices are
 *      non-decreasing — a well-founded order that cannot cycle.
 *   2. Each block may be pushed at most once per run, which kills the
 *      mutual-displacement oscillation (push A -> B straddles -> push B ->
 *      A moves -> ...).
 *   3. Hard iteration and wall-clock caps; on exhaustion we accept the current
 *      layout rather than failing. That is safe because a push only ever adds
 *      whitespace, so no content can be clipped by giving up.
 */

import type { BlockRole, ElementId } from '@/core/types';

/** A measured block, produced in-browser and consumed here as plain data. */
export interface Block {
  readonly id: ElementId;
  /** Top offset within the continuous content flow, in CSS pixels. */
  readonly top: number;
  readonly height: number;
  readonly role: BlockRole;
  /** Must never be divided across a page boundary (images, figures, rows). */
  readonly atomic: boolean;
  /** May be divided if too tall (code blocks, long lists). */
  readonly splittable: boolean;
  /** Following blocks that must stay with this one (headings: >= 1). */
  readonly keepWithNext: number;
  /** Heading level 1-6, when role is 'heading'. */
  readonly level?: number;
  /** Line height, used for line-granular splitting of code blocks. */
  readonly lineHeight?: number;
}

export type MutationKind =
  /** Insert vertical space before the block to push it to the next page. */
  | 'push'
  /** Scale the block down so it fits within one page. */
  | 'scale'
  /** Permit an internal break (used for oversized splittable blocks). */
  | 'allow-split';

export interface Mutation {
  readonly kind: MutationKind;
  readonly id: ElementId;
  /** For `push`: spacer height in px. For `scale`: the factor (0 < s <= 1). */
  readonly value: number;
  /** Why this mutation exists — surfaced in logs and tests. */
  readonly reason: string;
}

export interface BreakPlan {
  readonly mutations: readonly Mutation[];
  readonly iterations: number;
  readonly converged: boolean;
  /** Blocks that could not be placed cleanly; reported, never fatal. */
  readonly warnings: readonly string[];
}

export interface PlanOptions {
  readonly contentHeight: number;
  readonly maxIterations?: number;
  /** Wall-clock budget; `now` is injectable so tests stay deterministic. */
  readonly budgetMs?: number;
  readonly now?: () => number;
  /**
   * Minimum lines kept on each side of a split inside a splittable block,
   * so code never breaks leaving a single dangling line.
   */
  readonly minLinesPerFragment?: number;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_BUDGET_MS = 5_000;
const DEFAULT_MIN_LINES = 2;

/**
 * A heading followed by a short block should keep two blocks together, not one:
 * a heading plus a single one-line paragraph stranded at a page bottom looks
 * nearly as broken as an orphaned heading.
 */
const SHORT_BLOCK_PX = 60;

/** Never shrink content below this factor; past it, text stops being readable. */
export const MIN_SCALE = 0.7;

function pageEnd(top: number, contentHeight: number): number {
  return (Math.floor(top / contentHeight) + 1) * contentHeight;
}

/**
 * Plans page breaks for a measured document.
 *
 * `blocks` must be in document order with `top` values from a single
 * continuous flow (i.e. measured against the print container, not the viewport).
 */
export function planBreaks(blocks: readonly Block[], options: PlanOptions): BreakPlan {
  const contentHeight = options.contentHeight;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  const minLines = options.minLinesPerFragment ?? DEFAULT_MIN_LINES;

  const mutations: Mutation[] = [];
  const warnings: string[] = [];

  if (blocks.length === 0 || contentHeight <= 0) {
    return { mutations, iterations: 0, converged: true, warnings };
  }

  // Working offsets, mutated as we push blocks down.
  const offsets = new Map<ElementId, number>();
  for (const block of blocks) offsets.set(block.id, block.top);

  /** Guard 2: a block may be pushed at most once per run. */
  const pushed = new Set<ElementId>();
  /** Blocks already scaled, so we do not scale repeatedly. */
  const scaled = new Set<ElementId>();
  const splitAllowed = new Set<ElementId>();

  const started = now();
  let iterations = 0;
  let converged = false;

  while (iterations < maxIterations) {
    iterations += 1;
    let mutatedThisPass = false;

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block === undefined) continue;

      const top = offsets.get(block.id) ?? block.top;
      const height = block.height;
      const bottom = top + height;
      const boundary = pageEnd(top, contentHeight);
      const straddles = bottom > boundary;

      // --- Oversized blocks: taller than a whole page (§15, §17) ------------
      if (height > contentHeight) {
        if (!scaled.has(block.id) && isShrinkable(block)) {
          // Scale to fit one page. Never distorts: the caller applies a uniform
          // factor, preserving aspect ratio (§17).
          const factor = contentHeight / height;
          if (factor >= MIN_SCALE) {
            scaled.add(block.id);
            mutations.push({
              kind: 'scale',
              id: block.id,
              value: factor,
              reason: `block taller than page (${Math.round(height)}px > ${Math.round(contentHeight)}px)`,
            });
            shiftFollowing(blocks, offsets, i, height * (factor - 1));
            mutatedThisPass = true;
            continue;
          }
          // Below the readability floor, scaling would do more harm than the
          // break it avoids, so fall through to splitting instead.
        }

        if (!splitAllowed.has(block.id)) {
          splitAllowed.add(block.id);
          mutations.push({
            kind: 'allow-split',
            id: block.id,
            value: block.lineHeight ?? 0,
            reason: 'oversized block split across pages',
          });
          if (block.atomic && !block.splittable) {
            warnings.push(
              `Element ${block.id} is taller than one page and cannot be scaled; it will span pages.`,
            );
          }
          mutatedThisPass = true;
        }
        continue;
      }

      // --- Atomic blocks straddling a boundary (§15, §17, §18) --------------
      if (straddles && block.atomic && !pushed.has(block.id)) {
        const spacer = boundary - top;
        // A zero-height spacer means the block already starts exactly on the
        // boundary; pushing would add a blank page.
        if (spacer > 0.5) {
          pushed.add(block.id);
          mutations.push({
            kind: 'push',
            id: block.id,
            value: spacer,
            reason: `${block.role} would split across a page boundary`,
          });
          applyPush(blocks, offsets, i, spacer);
          mutatedThisPass = true;
          continue;
        }
      }

      // --- Orphaned headings (§16) ------------------------------------------
      if (block.role === 'heading' && block.keepWithNext > 0 && !pushed.has(block.id)) {
        const companions = collectCompanions(blocks, i, block.keepWithNext);
        if (companions.length > 0) {
          const last = companions[companions.length - 1];
          if (last !== undefined) {
            const lastTop = offsets.get(last.id) ?? last.top;
            const groupBottom = lastTop + last.height;
            const groupHeight = groupBottom - top;

            // Only push when the group *can* fit on a fresh page. Otherwise the
            // heading would be pushed forever without ever being satisfied.
            if (groupBottom > boundary && groupHeight <= contentHeight) {
              const spacer = boundary - top;
              if (spacer > 0.5) {
                pushed.add(block.id);
                mutations.push({
                  kind: 'push',
                  id: block.id,
                  value: spacer,
                  reason: `heading would be orphaned at the foot of a page`,
                });
                applyPush(blocks, offsets, i, spacer);
                mutatedThisPass = true;
                continue;
              }
            }
          }
        }
      }

      // --- Splittable blocks: enforce line-granular orphans (§19) -----------
      if (straddles && block.splittable && !block.atomic) {
        const lineHeight = block.lineHeight ?? 0;
        if (lineHeight > 0 && !pushed.has(block.id)) {
          const linesBeforeBreak = Math.floor((boundary - top) / lineHeight);
          const totalLines = Math.max(1, Math.round(height / lineHeight));
          const linesAfterBreak = totalLines - linesBeforeBreak;

          // Too few lines on either side: move the whole block instead of
          // leaving one dangling line behind or ahead.
          if (linesBeforeBreak < minLines || linesAfterBreak < minLines) {
            const spacer = boundary - top;
            if (spacer > 0.5 && height <= contentHeight) {
              pushed.add(block.id);
              mutations.push({
                kind: 'push',
                id: block.id,
                value: spacer,
                reason: 'split would leave too few lines on a page',
              });
              applyPush(blocks, offsets, i, spacer);
              mutatedThisPass = true;
              continue;
            }
          }
        }
      }
    }

    if (!mutatedThisPass) {
      converged = true;
      break;
    }

    // Guard 3: wall-clock budget.
    if (now() - started > budgetMs) {
      warnings.push('Pagination budget exhausted; using the best layout found so far.');
      break;
    }
  }

  if (!converged && warnings.length === 0) {
    warnings.push('Pagination did not fully converge; using the best layout found so far.');
  }

  return { mutations, iterations, converged, warnings };
}

/** Images, figures and tables can be scaled down without losing information. */
function isShrinkable(block: Block): boolean {
  return block.role === 'image' || block.role === 'figure' || block.role === 'table';
}

/**
 * Pushing a block down moves it and everything after it (guard 1: forward only).
 */
function applyPush(
  blocks: readonly Block[],
  offsets: Map<ElementId, number>,
  fromIndex: number,
  delta: number,
): void {
  for (let j = fromIndex; j < blocks.length; j += 1) {
    const other = blocks[j];
    if (other === undefined) continue;
    offsets.set(other.id, (offsets.get(other.id) ?? other.top) + delta);
  }
}

/** Scaling a block changes the offsets of everything after it, but not itself. */
function shiftFollowing(
  blocks: readonly Block[],
  offsets: Map<ElementId, number>,
  fromIndex: number,
  delta: number,
): void {
  for (let j = fromIndex + 1; j < blocks.length; j += 1) {
    const other = blocks[j];
    if (other === undefined) continue;
    offsets.set(other.id, (offsets.get(other.id) ?? other.top) + delta);
  }
}

/**
 * Collects the blocks a heading must stay with. Extends past `count` when the
 * immediate next block is very short, so a heading plus a one-liner is not
 * treated as satisfied.
 */
function collectCompanions(blocks: readonly Block[], index: number, count: number): Block[] {
  const result: Block[] = [];
  let wanted = count;

  for (let j = index + 1; j < blocks.length && result.length < wanted; j += 1) {
    const next = blocks[j];
    if (next === undefined) continue;
    // A following heading means the first heading has no body to keep with.
    if (next.role === 'heading') break;
    result.push(next);
    if (result.length === 1 && next.height < SHORT_BLOCK_PX && wanted < 2) {
      wanted = 2;
    }
  }

  return result;
}

/**
 * Recomputes final offsets after applying a plan. Used by tests and by the
 * renderer to report the page count without a second measurement pass.
 */
export function applyPlan(
  blocks: readonly Block[],
  plan: BreakPlan,
): Map<ElementId, { top: number; height: number }> {
  const result = new Map<ElementId, { top: number; height: number }>();
  const pushes = new Map<ElementId, number>();
  const scales = new Map<ElementId, number>();

  for (const mutation of plan.mutations) {
    if (mutation.kind === 'push') {
      pushes.set(mutation.id, (pushes.get(mutation.id) ?? 0) + mutation.value);
    } else if (mutation.kind === 'scale') {
      scales.set(mutation.id, mutation.value);
    }
  }

  let cumulativeShift = 0;
  for (const block of blocks) {
    cumulativeShift += pushes.get(block.id) ?? 0;
    const scale = scales.get(block.id) ?? 1;
    const height = block.height * scale;
    result.set(block.id, { top: block.top + cumulativeShift, height });
    cumulativeShift += height - block.height;
  }

  return result;
}
