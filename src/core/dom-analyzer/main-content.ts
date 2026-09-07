/**
 * Main-content detection — the "content spine" (spec §27).
 *
 * Finds the deepest element that contains all of the substantial prose, then
 * hard-protects it and its ancestors. This is the single highest-value safety
 * rule in the cleaner: whatever the noise scorer believes, the chain of
 * elements wrapping the article can never be removed, so a page can never come
 * back blank.
 *
 * Deliberately does NOT assume `<article>` exists (§27) — it works from text
 * distribution, falling back to semantic tags only as a tie-breaker.
 */

import type { ElementId } from '@/core/types';
import type { NodeFacts } from './facts';

/** A paragraph must exceed this length to count as substantial prose. */
const SUBSTANTIAL_PARAGRAPH_CHARS = 100;

export interface ContentSpine {
  /** The element judged to be the article root, if one was found. */
  readonly rootId: ElementId | null;
  /** Root plus all of its ancestors — never removable. */
  readonly protectedIds: ReadonlySet<ElementId>;
}

/** Walks from an element up to the document root. */
function ancestorsOf(
  id: ElementId,
  byId: ReadonlyMap<ElementId, NodeFacts>,
): ElementId[] {
  const chain: ElementId[] = [];
  let current: ElementId | null = id;
  let guard = 0;

  while (current !== null && guard < 1000) {
    chain.push(current);
    current = byId.get(current)?.parentId ?? null;
    guard += 1;
  }

  return chain;
}

/**
 * Finds the deepest common ancestor of every element carrying substantial prose.
 *
 * Using the *deepest common ancestor* (rather than the highest-scoring single
 * element) is what makes this robust on pages that split an article across
 * several sibling sections.
 */
export function findContentSpine(allFacts: readonly NodeFacts[]): ContentSpine {
  const byId = new Map<ElementId, NodeFacts>();
  for (const facts of allFacts) byId.set(facts.id, facts);

  // Candidates: elements that directly hold substantial prose. `longParagraphCount`
  // is inclusive of descendants, so we prefer the leafiest holders by taking
  // elements whose own text is substantial and which contain few children.
  const candidates = allFacts.filter(
    (f) =>
      f.textLength >= SUBSTANTIAL_PARAGRAPH_CHARS &&
      f.longParagraphCount >= 1 &&
      // Skip the html/body wrappers, which trivially contain everything.
      f.tag !== 'BODY' &&
      f.tag !== 'HTML',
  );

  if (candidates.length === 0) {
    return { rootId: null, protectedIds: new Set() };
  }

  // Intersect the ancestor chains of all candidates; the deepest shared
  // ancestor is the article root.
  const chains = candidates.map((c) => ancestorsOf(c.id, byId));
  const firstChain = chains[0];
  if (firstChain === undefined) return { rootId: null, protectedIds: new Set() };

  let rootId: ElementId | null = null;
  // Walk the first candidate's chain from the leaf upward; the first ancestor
  // shared by every candidate is the deepest common one.
  for (const candidateAncestor of firstChain) {
    const sharedByAll = chains.every((chain) => chain.includes(candidateAncestor));
    if (sharedByAll) {
      rootId = candidateAncestor;
      break;
    }
  }

  if (rootId === null) return { rootId: null, protectedIds: new Set() };

  // Protect the root and every ancestor above it. Descendants are NOT protected:
  // ads inside the article body must still be removable (§10).
  const protectedIds = new Set<ElementId>(ancestorsOf(rootId, byId));
  return { rootId, protectedIds };
}
