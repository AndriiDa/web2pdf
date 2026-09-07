/**
 * Noise scoring: advertising, popups, overlays and floating UI (spec §9-§11).
 *
 * A weighted multi-signal scorer, never a class-name blocklist. The key safety
 * property, required by §9 ("avoid deleting normal content simply because it
 * contains one of these words"): the maximum keyword weight is strictly BELOW
 * the removal threshold, so a keyword match can never remove anything on its
 * own — it can only push an already-suspicious element over the line.
 *
 * Pure function over `NodeFacts`, so it unit-tests from JSON with no browser.
 */

import type { RemovalReason } from '@/core/types';
import { linkDensity, textDensity, type NodeFacts } from '@/core/dom-analyzer/facts';
import { isAdDomain, isContentDomain } from './ad-domains';

export interface Signal {
  readonly name: string;
  readonly weight: number;
  /** Normalized strength, 0..1. */
  readonly value: number;
}

/** Score at or above which an element is considered noise. */
export const NOISE_THRESHOLD = 5.0;

/**
 * Keyword weight. Deliberately below NOISE_THRESHOLD: this is the structural
 * guarantee that a word alone never deletes content.
 */
const KEYWORD_WEIGHT = 1.2;

const WEIGHTS = {
  fixedOrSticky: 2.5,
  highZIndex: 1.5,
  viewportCoverage: 3.0,
  backdrop: 2.5,
  adNetworkIframe: 3.5,
  adSlotAttributes: 3.0,
  keywords: KEYWORD_WEIGHT,
  lowTextDensity: 1.5,
  highLinkDensity: 1.5,
  closeButton: 2.0,
  dialogRole: 2.5,
  emptyAdSlot: 2.0,
  scrollLock: 1.5,
  standardAdSize: 1.5,
} as const;

/** Keyword groups. Each maps to the reason reported to the user. */
const KEYWORD_GROUPS: ReadonlyArray<{ reason: RemovalReason; words: readonly string[] }> = [
  {
    reason: 'cookie-banner',
    words: ['cookie', 'cookies', 'consent', 'gdpr', 'ccpa', 'privacy-banner', 'cmp'],
  },
  {
    reason: 'newsletter',
    words: ['newsletter', 'subscribe', 'subscription', 'signup', 'sign-up', 'register'],
  },
  {
    reason: 'ad',
    words: [
      'ad', 'ads', 'adv', 'advert', 'advertisement', 'advertising', 'adslot', 'ad-slot',
      'adbox', 'ad-box', 'adunit', 'ad-unit', 'adwrapper', 'ad-wrapper', 'banner',
      'sponsor', 'sponsored', 'promo', 'promotion', 'promoted', 'dfp', 'gpt', 'taboola',
      'outbrain', 'adsense', 'doubleclick',
    ],
  },
  {
    reason: 'popup',
    words: ['popup', 'pop-up', 'modal', 'lightbox', 'overlay', 'interstitial', 'dialog'],
  },
  {
    reason: 'social',
    words: ['share', 'sharing', 'social', 'follow-us', 'addthis', 'sharethis'],
  },
  {
    reason: 'chat-widget',
    words: ['chat', 'livechat', 'intercom', 'zendesk', 'drift', 'messenger', 'support-widget'],
  },
  {
    reason: 'app-banner',
    words: ['app-banner', 'smartbanner', 'install-app', 'get-app', 'download-app'],
  },
];

/** Standard IAB ad heights; a fixed box at these sizes is a strong hint. */
const STANDARD_AD_HEIGHTS = [50, 60, 90, 100, 250, 280, 400, 600];
const STANDARD_AD_WIDTHS = [120, 160, 200, 234, 250, 300, 320, 336, 468, 728, 970];

/**
 * Splits identifiers into tokens. Whole-token matches score full strength;
 * matches buried inside a longer token score much lower, which is what stops
 * "article-cookies-explainer" from being treated like "cookie-banner".
 */
function tokenize(values: readonly string[]): { tokens: Set<string>; joined: string } {
  const tokens = new Set<string>();
  const parts: string[] = [];

  for (const value of values) {
    const lower = value.toLowerCase();
    parts.push(lower);
    for (const token of lower.split(/[^a-z0-9]+/)) {
      if (token !== '') tokens.add(token);
    }
  }

  return { tokens, joined: parts.join(' ') };
}

export interface KeywordMatch {
  readonly reason: RemovalReason;
  /** 0..1 — 1.0 for a whole-token hit, 0.2 for a substring hit. */
  readonly strength: number;
}

/**
 * Finds the strongest keyword signal. Saturating: extra hits never raise the
 * value above 1.0, so keyword stuffing cannot compound into a removal.
 */
export function matchKeywords(facts: NodeFacts): KeywordMatch | null {
  const { tokens, joined } = tokenize([
    ...facts.classNames,
    facts.elementId,
    facts.ariaLabel ?? '',
  ]);

  let best: KeywordMatch | null = null;

  for (const group of KEYWORD_GROUPS) {
    for (const word of group.words) {
      if (tokens.has(word)) {
        return { reason: group.reason, strength: 1 };
      }
      // Substring hits are weak evidence — a word inside a longer identifier
      // is usually incidental.
      if (best === null && word.length >= 5 && joined.includes(word)) {
        best = { reason: group.reason, strength: 0.2 };
      }
    }
  }

  return best;
}

export interface NoiseResult {
  readonly score: number;
  readonly signals: readonly Signal[];
  /** Best guess at what this element is, used for the editor label. */
  readonly reason: RemovalReason;
}

function signal(name: string, weight: number, value: number): Signal {
  return { name, weight, value: Math.max(0, Math.min(1, value)) };
}

/**
 * Scores an element for "noise-ness". Higher means more likely to be an ad,
 * popup, overlay or other intrusive UI.
 */
export function scoreNoise(facts: NodeFacts): NoiseResult {
  const signals: Signal[] = [];
  let reason: RemovalReason = 'ad';

  const isFixed = facts.position === 'fixed' || facts.position === 'sticky';
  if (isFixed) {
    signals.push(signal('fixedOrSticky', WEIGHTS.fixedOrSticky, 1));
    reason = 'sticky';
  }

  if (facts.zIndex > 999) {
    // Log scale: z-index 1000 and 999999 are both "high", not 1000x different.
    const normalized = Math.min(1, Math.log10(facts.zIndex) / 7);
    signals.push(signal('highZIndex', WEIGHTS.highZIndex, normalized));
  }

  // Large viewport coverage only means "overlay" when the element floats above
  // the page; a big static container is just a layout wrapper.
  if (isFixed && facts.viewportCoverage > 0.25) {
    signals.push(signal('viewportCoverage', WEIGHTS.viewportCoverage, facts.viewportCoverage));
    reason = 'overlay';
  }

  if (facts.hasBackdropAppearance) {
    signals.push(signal('backdrop', WEIGHTS.backdrop, 1));
    reason = 'overlay';
  }

  // Ad iframes: content embeds (YouTube, maps, CodePen) are excluded first, so
  // §10's "do not remove content just because it is an iframe" holds.
  const adHosts = facts.iframeHosts.filter((host) => !isContentDomain(host) && isAdDomain(host));
  if (adHosts.length > 0) {
    signals.push(signal('adNetworkIframe', WEIGHTS.adNetworkIframe, 1));
    reason = 'ad';
  }

  if (facts.hasAdSlotAttributes) {
    signals.push(signal('adSlotAttributes', WEIGHTS.adSlotAttributes, 1));
    reason = 'ad';
  }

  const keyword = matchKeywords(facts);
  if (keyword) {
    signals.push(signal('keywords', WEIGHTS.keywords, keyword.strength));
    // Only let a keyword name the reason when it is a confident, whole-token
    // match; otherwise keep whatever the structural signals concluded.
    if (keyword.strength >= 1) reason = keyword.reason;
  }

  const density = textDensity(facts);
  const area = facts.width * facts.height;
  if (area > 5000 && density < 0.5) {
    signals.push(signal('lowTextDensity', WEIGHTS.lowTextDensity, 1 - Math.min(1, density / 0.5)));
  }

  if (facts.textLength > 0) {
    const links = linkDensity(facts);
    if (links > 0.6) {
      signals.push(signal('highLinkDensity', WEIGHTS.highLinkDensity, (links - 0.6) / 0.4));
    }
  }

  if (facts.hasCloseButton && (isFixed || facts.ariaModal || facts.role === 'dialog')) {
    signals.push(signal('closeButton', WEIGHTS.closeButton, 1));
  }

  if (facts.ariaModal || facts.role === 'dialog' || facts.role === 'alertdialog') {
    signals.push(signal('dialogRole', WEIGHTS.dialogRole, 1));
    reason = 'popup';
  }

  // An empty reserved box at standard ad dimensions is an unfilled ad slot.
  const standardSize =
    STANDARD_AD_WIDTHS.includes(Math.round(facts.width)) ||
    STANDARD_AD_HEIGHTS.includes(Math.round(facts.height));
  if (standardSize && facts.height > 0) {
    signals.push(signal('standardAdSize', WEIGHTS.standardAdSize, 1));
  }
  if (standardSize && facts.textLength < 20 && facts.imageCount === 0 && area > 5000) {
    signals.push(signal('emptyAdSlot', WEIGHTS.emptyAdSlot, 1));
    reason = 'ad';
  }

  if (facts.bodyScrollLocked && isFixed) {
    signals.push(signal('scrollLock', WEIGHTS.scrollLock, 1));
    reason = 'popup';
  }

  const score = signals.reduce((total, s) => total + s.weight * s.value, 0);
  return { score, signals, reason };
}

/** Convenience for tests and logging. */
export function isNoisy(facts: NodeFacts): boolean {
  return scoreNoise(facts).score >= NOISE_THRESHOLD;
}
