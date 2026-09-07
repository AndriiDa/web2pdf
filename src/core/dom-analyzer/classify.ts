/**
 * The classifier: where noise and content scores meet (spec §9-§11, §27).
 *
 * Noise and content signals are CORRELATED exactly where the decision is hard —
 * a sponsored block inside an article, or a cookie banner containing three
 * paragraphs of legal prose, both score high on each axis. Collapsing them into
 * a single number by subtraction throws away the information needed to tell
 * "both low" (uncertain) from "both high" (contested), which want opposite
 * treatment. So the decision is two-dimensional:
 *
 *                  content low        content high
 *   noise high      REMOVE            CONTESTED (keep, flag for the user)
 *   noise low       KEEP              KEEP (protected)
 *
 * Two structural rules complete it:
 *   - noise propagates DOWN: a modal's headline is not content.
 *   - content propagates UP: a sticky wrapper containing the article is not noise.
 *
 * Plus the content spine: ancestors of the article root are never removable.
 */

import type { ElementId, RemovalReason } from '@/core/types';
import { NOISE_THRESHOLD, scoreNoise, type Signal } from '@/core/ad-detector/score';
import { CONTENT_THRESHOLD, scoreContent } from './content-score';
import { findContentSpine } from './main-content';
import type { NodeFacts } from './facts';

export type Decision = 'remove' | 'keep' | 'contested';

export interface Classification {
  readonly id: ElementId;
  readonly noiseScore: number;
  readonly contentScore: number;
  readonly decision: Decision;
  readonly reason: RemovalReason;
  /** True when the content spine or an ancestor's content score protects it. */
  readonly isProtected: boolean;
  readonly signals: readonly Signal[];
}

export interface ClassifyResult {
  readonly classifications: readonly Classification[];
  /** Ids the cleaner should remove — top-most only, never their descendants. */
  readonly removeIds: readonly ElementId[];
  /** High-noise but meaningful; kept and surfaced in the editor. */
  readonly contestedIds: readonly ElementId[];
  readonly contentRootId: ElementId | null;
}

/**
 * Classifies every element in one pass over the fact table.
 */
export function classify(allFacts: readonly NodeFacts[]): ClassifyResult {
  const byId = new Map<ElementId, NodeFacts>();
  for (const facts of allFacts) byId.set(facts.id, facts);

  const spine = findContentSpine(allFacts);

  // Pass 1: independent scores for every element.
  const noise = new Map<ElementId, ReturnType<typeof scoreNoise>>();
  const content = new Map<ElementId, number>();
  for (const facts of allFacts) {
    noise.set(facts.id, scoreNoise(facts));
    content.set(facts.id, scoreContent(facts).score);
  }

  // Pass 2: propagate content scores UP. An element wrapping meaningful content
  // inherits protection, which stops a sticky/high-z-index wrapper around the
  // article from being removed for its positioning alone.
  const maxDescendantContent = new Map<ElementId, number>();
  // Children always appear after parents in document order, so a reverse walk
  // visits every descendant before its ancestor.
  for (let i = allFacts.length - 1; i >= 0; i -= 1) {
    const facts = allFacts[i];
    if (facts === undefined) continue;

    let best = content.get(facts.id) ?? 0;
    for (const childId of facts.childIds) {
      best = Math.max(best, maxDescendantContent.get(childId) ?? 0);
    }
    maxDescendantContent.set(facts.id, best);
  }

  // Pass 3: the two-dimensional decision.
  const classifications: Classification[] = [];
  const decisions = new Map<ElementId, Decision>();

  for (const facts of allFacts) {
    const noiseResult = noise.get(facts.id);
    const ownContent = content.get(facts.id) ?? 0;
    if (noiseResult === undefined) continue;

    const inheritedContent = maxDescendantContent.get(facts.id) ?? 0;
    const isSpineProtected = spine.protectedIds.has(facts.id);
    // A container wrapping the article root inherits its protection.
    const wrapsContent = inheritedContent >= CONTENT_THRESHOLD;
    const isProtected = isSpineProtected || wrapsContent;

    let decision: Decision;
    if (noiseResult.score < NOISE_THRESHOLD) {
      decision = 'keep';
    } else if (isSpineProtected) {
      // The spine is inviolable: never remove, never even flag as contested.
      decision = 'keep';
    } else if (ownContent >= CONTENT_THRESHOLD || wrapsContent) {
      // Both axes high: genuinely ambiguous, so keep it and let the user decide.
      decision = 'contested';
    } else {
      decision = 'remove';
    }

    decisions.set(facts.id, decision);
    classifications.push({
      id: facts.id,
      noiseScore: noiseResult.score,
      contentScore: ownContent,
      decision,
      reason: noiseResult.reason,
      isProtected,
      signals: noiseResult.signals,
    });
  }

  // Pass 4: propagate removal DOWN, and collapse to top-most removals only.
  // Sending just the outermost id keeps the action log small and makes restore
  // resurrect the whole subtree naturally.
  const removeIds: ElementId[] = [];
  const contestedIds: ElementId[] = [];

  for (const facts of allFacts) {
    const decision = decisions.get(facts.id);
    if (decision === 'contested') {
      contestedIds.push(facts.id);
      continue;
    }
    if (decision !== 'remove') continue;

    // Skip when an ancestor is already being removed.
    let ancestorRemoved = false;
    let parentId = facts.parentId;
    let guard = 0;
    while (parentId !== null && guard < 1000) {
      if (decisions.get(parentId) === 'remove') {
        ancestorRemoved = true;
        break;
      }
      parentId = byId.get(parentId)?.parentId ?? null;
      guard += 1;
    }

    if (!ancestorRemoved) removeIds.push(facts.id);
  }

  return {
    classifications,
    removeIds,
    contestedIds,
    contentRootId: spine.rootId,
  };
}
