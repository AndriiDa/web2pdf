/**
 * Content scoring — the protection half of the classifier (spec §27).
 *
 * This exists to VETO removals. Noise detection alone is reckless: a cookie
 * banner full of legal prose and a sponsored block inside an article both score
 * high on noise signals, and so would a genuine article section that happens to
 * be sticky. Scoring "how meaningful is this?" independently gives the
 * classifier a second axis to reason on (see `classify.ts`).
 */

import { linkDensity, textDensity, type NodeFacts } from './facts';
import type { Signal } from '@/core/ad-detector/score';

/** Score at or above which an element is treated as meaningful content. */
export const CONTENT_THRESHOLD = 4.0;

const WEIGHTS = {
  semanticTag: 3.0,
  textDensity: 2.5,
  paragraphCount: 2.0,
  headingStructure: 1.5,
  meaningfulImages: 1.5,
  commaCount: 1.0,
  listOrTable: 1.0,
  lowLinkDensity: 1.5,
} as const;

/** Tags that assert "this is the document body" rather than chrome. */
const SEMANTIC_CONTENT_TAGS = new Set(['ARTICLE', 'MAIN']);
const SEMANTIC_ROLES = new Set(['main', 'article', 'document']);

function signal(name: string, weight: number, value: number): Signal {
  return { name, weight, value: Math.max(0, Math.min(1, value)) };
}

export interface ContentResult {
  readonly score: number;
  readonly signals: readonly Signal[];
}

/** Scores how likely an element is to hold meaningful page content. */
export function scoreContent(facts: NodeFacts): ContentResult {
  const signals: Signal[] = [];

  if (SEMANTIC_CONTENT_TAGS.has(facts.tag) || (facts.role && SEMANTIC_ROLES.has(facts.role))) {
    signals.push(signal('semanticTag', WEIGHTS.semanticTag, 1));
  }

  // Text density, log-normalized: prose runs far denser than chrome.
  const density = textDensity(facts);
  if (density > 0) {
    const normalized = Math.min(1, Math.log10(1 + density) / Math.log10(1 + 8));
    signals.push(signal('textDensity', WEIGHTS.textDensity, normalized));
  }

  // Saturates at 5 paragraphs — beyond that it is certainly an article body.
  if (facts.longParagraphCount > 0) {
    signals.push(
      signal('paragraphCount', WEIGHTS.paragraphCount, Math.min(1, facts.longParagraphCount / 5)),
    );
  }

  if (facts.headingCount > 0 && facts.textLength > 200) {
    signals.push(signal('headingStructure', WEIGHTS.headingStructure, 1));
  }

  if (facts.meaningfulImageCount > 0) {
    signals.push(
      signal('meaningfulImages', WEIGHTS.meaningfulImages, Math.min(1, facts.meaningfulImageCount / 3)),
    );
  }

  // Comma count is Readability's oldest heuristic and still one of the best
  // proxies for real prose as opposed to lists of links.
  if (facts.commaCount > 0) {
    signals.push(signal('commaCount', WEIGHTS.commaCount, Math.min(1, facts.commaCount / 10)));
  }

  if (facts.tableRowCount > 3 || facts.listItemCount > 3) {
    signals.push(signal('listOrTable', WEIGHTS.listOrTable, 1));
  }

  // Low link density distinguishes prose from navigation and link farms.
  if (facts.textLength > 100) {
    const links = linkDensity(facts);
    if (links < 0.3) {
      signals.push(signal('lowLinkDensity', WEIGHTS.lowLinkDensity, 1 - links / 0.3));
    }
  }

  const score = signals.reduce((total, s) => total + s.weight * s.value, 0);
  return { score, signals };
}

export function isMeaningful(facts: NodeFacts): boolean {
  return scoreContent(facts).score >= CONTENT_THRESHOLD;
}
