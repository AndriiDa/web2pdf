import { describe, it, expect } from 'vitest';
import { classify } from './classify';
import { findContentSpine } from './main-content';
import { scoreContent, CONTENT_THRESHOLD } from './content-score';
import { scoreNoise, matchKeywords, NOISE_THRESHOLD } from '@/core/ad-detector/score';
import { isAdDomain, isContentDomain } from '@/core/ad-detector/ad-domains';
import type { NodeFacts } from './facts';
import { asElementId } from '@/core/types';

/**
 * Builds NodeFacts with neutral defaults, so each test states only what matters.
 * `id`/`parentId` accept plain strings and are branded here, keeping the test
 * fixtures readable.
 */
type FactsInput = Partial<Omit<NodeFacts, 'id' | 'parentId'>> & {
  id: string;
  parentId?: string;
};

function facts(partial: FactsInput): NodeFacts {
  return {
    id: asElementId(partial.id),
    parentId: partial.parentId === undefined ? null : asElementId(partial.parentId),
    childIds: partial.childIds ?? [],
    tag: partial.tag ?? 'DIV',
    classNames: partial.classNames ?? [],
    elementId: partial.elementId ?? '',
    role: partial.role ?? null,
    ariaLabel: partial.ariaLabel ?? null,
    ariaModal: partial.ariaModal ?? false,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 600,
    height: partial.height ?? 200,
    viewportCoverage: partial.viewportCoverage ?? 0.1,
    position: partial.position ?? 'static',
    zIndex: partial.zIndex ?? 0,
    display: partial.display ?? 'block',
    visibility: partial.visibility ?? 'visible',
    opacity: partial.opacity ?? 1,
    hasBackdropAppearance: partial.hasBackdropAppearance ?? false,
    overflowHidden: partial.overflowHidden ?? false,
    textLength: partial.textLength ?? 0,
    linkTextLength: partial.linkTextLength ?? 0,
    linkCount: partial.linkCount ?? 0,
    longParagraphCount: partial.longParagraphCount ?? 0,
    commaCount: partial.commaCount ?? 0,
    headingCount: partial.headingCount ?? 0,
    imageCount: partial.imageCount ?? 0,
    meaningfulImageCount: partial.meaningfulImageCount ?? 0,
    listItemCount: partial.listItemCount ?? 0,
    tableRowCount: partial.tableRowCount ?? 0,
    inputCount: partial.inputCount ?? 0,
    depth: partial.depth ?? 3,
    descendantCount: partial.descendantCount ?? 0,
    iframeHosts: partial.iframeHosts ?? [],
    iframeCount: partial.iframeCount ?? 0,
    hasAdSlotAttributes: partial.hasAdSlotAttributes ?? false,
    hasCloseButton: partial.hasCloseButton ?? false,
    bodyScrollLocked: partial.bodyScrollLocked ?? false,
    hasStandardAdDimensions: partial.hasStandardAdDimensions ?? false,
  };
}

/** A realistic article paragraph container. */
function articleBody(id: string, parentId?: string): NodeFacts {
  return facts({
    id,
    ...(parentId !== undefined ? { parentId } : {}),
    tag: 'ARTICLE',
    textLength: 4000,
    longParagraphCount: 8,
    commaCount: 45,
    headingCount: 3,
    meaningfulImageCount: 2,
    linkTextLength: 200,
    width: 660,
    height: 3000,
  });
}

describe('ad domain matching', () => {
  it('recognizes ad networks including subdomains', () => {
    expect(isAdDomain('doubleclick.net')).toBe(true);
    expect(isAdDomain('tpc.googlesyndication.com')).toBe(true);
    expect(isAdDomain('www.taboola.com')).toBe(true);
  });

  it('does not treat content embeds as ads', () => {
    expect(isContentDomain('www.youtube.com')).toBe(true);
    expect(isContentDomain('player.vimeo.com')).toBe(true);
    expect(isContentDomain('codepen.io')).toBe(true);
    expect(isAdDomain('example.com')).toBe(false);
  });
});

describe('matchKeywords — §9 substring safety', () => {
  it('scores a whole-token match at full strength', () => {
    expect(matchKeywords(facts({ id: '1', classNames: ['cookie-banner'] }))?.strength).toBe(1);
    expect(matchKeywords(facts({ id: '2', elementId: 'newsletter' }))?.strength).toBe(1);
  });

  it('scores an incidental substring far lower', () => {
    // A genuine article about cookies must not be treated like a cookie banner.
    const match = matchKeywords(facts({ id: '3', classNames: ['chocolatechipcookierecipe'] }));
    expect(match?.strength ?? 0).toBeLessThan(0.5);
  });

  it('returns null when nothing matches', () => {
    expect(matchKeywords(facts({ id: '4', classNames: ['prose', 'entry-body'] }))).toBeNull();
  });
});

describe('scoreNoise — the §9 keyword invariant', () => {
  it('NEVER removes on a keyword alone, however many match', () => {
    // Every keyword group hit at once, with no structural evidence at all.
    const keywordStuffed = facts({
      id: 'k',
      classNames: ['ad', 'promo', 'cookie', 'newsletter', 'popup', 'social', 'chat', 'sponsored'],
      elementId: 'advertisement-banner-subscribe',
      ariaLabel: 'advertisement promotion subscribe',
      textLength: 500,
      width: 600,
      height: 300,
    });

    const result = scoreNoise(keywordStuffed);
    expect(result.score).toBeLessThan(NOISE_THRESHOLD);
  });

  it('scores a real ad slot above the threshold', () => {
    const adSlot = facts({
      id: 'ad',
      classNames: ['ad-slot'],
      elementId: 'div-gpt-ad-12345',
      hasAdSlotAttributes: true,
      iframeHosts: ['tpc.googlesyndication.com'],
      iframeCount: 1,
      width: 728,
      height: 90,
      textLength: 0,
    });

    expect(scoreNoise(adSlot).score).toBeGreaterThanOrEqual(NOISE_THRESHOLD);
    expect(scoreNoise(adSlot).reason).toBe('ad');
  });

  it('scores a cookie consent modal above the threshold', () => {
    const banner = facts({
      id: 'cookie',
      classNames: ['cookie-consent-modal'],
      position: 'fixed',
      zIndex: 99999,
      viewportCoverage: 0.35,
      hasBackdropAppearance: true,
      hasCloseButton: true,
      role: 'dialog',
      ariaModal: true,
      bodyScrollLocked: true,
      textLength: 400,
      width: 800,
      height: 400,
    });

    const result = scoreNoise(banner);
    expect(result.score).toBeGreaterThanOrEqual(NOISE_THRESHOLD);
  });

  it('scores a plain article paragraph near zero', () => {
    const paragraph = facts({
      id: 'p',
      tag: 'P',
      textLength: 800,
      commaCount: 12,
      longParagraphCount: 1,
      width: 660,
      height: 300,
    });

    expect(scoreNoise(paragraph).score).toBeLessThan(NOISE_THRESHOLD);
  });

  it('does not flag a YouTube embed as an ad', () => {
    // §10: iframes are not ads by default.
    const embed = facts({
      id: 'yt',
      classNames: ['video-embed'],
      iframeHosts: ['www.youtube.com'],
      iframeCount: 1,
      width: 660,
      height: 371,
    });

    expect(scoreNoise(embed).score).toBeLessThan(NOISE_THRESHOLD);
  });
});

describe('scoreContent', () => {
  it('scores an article body as meaningful', () => {
    expect(scoreContent(articleBody('a')).score).toBeGreaterThanOrEqual(CONTENT_THRESHOLD);
  });

  it('scores an empty ad container as not meaningful', () => {
    const empty = facts({ id: 'e', width: 300, height: 250, textLength: 0 });
    expect(scoreContent(empty).score).toBeLessThan(CONTENT_THRESHOLD);
  });

  it('scores a link-dense navigation block as not meaningful', () => {
    const nav = facts({
      id: 'n',
      tag: 'NAV',
      textLength: 300,
      linkTextLength: 290,
      linkCount: 40,
      width: 660,
      height: 60,
    });
    expect(scoreContent(nav).score).toBeLessThan(CONTENT_THRESHOLD);
  });
});

describe('findContentSpine', () => {
  it('finds the article root and protects its ancestors', () => {
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('wrap')] });
    const wrap = facts({
      id: 'wrap',
      parentId: 'body',
      childIds: [asElementId('article')],
    });
    const article = { ...articleBody('article', 'wrap') };

    const spine = findContentSpine([body, wrap, article]);
    expect(spine.rootId).toBe(asElementId('article'));
    expect(spine.protectedIds.has(asElementId('wrap'))).toBe(true);
    expect(spine.protectedIds.has(asElementId('body'))).toBe(true);
  });

  it('works without an <article> element (§27)', () => {
    const wrap = facts({ id: 'wrap', childIds: [asElementId('inner')] });
    const inner = facts({
      id: 'inner',
      parentId: 'wrap',
      tag: 'DIV',
      textLength: 3000,
      longParagraphCount: 6,
      commaCount: 30,
    });

    const spine = findContentSpine([wrap, inner]);
    expect(spine.rootId).toBe(asElementId('inner'));
  });

  it('returns no spine for a page with no prose', () => {
    const spine = findContentSpine([facts({ id: 'x', textLength: 10 })]);
    expect(spine.rootId).toBeNull();
    expect(spine.protectedIds.size).toBe(0);
  });
});

describe('classify — the 2D decision', () => {
  it('removes an ad that sits inside the article body', () => {
    // Ads within the spine must still be removable (only ANCESTORS are immune).
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('article')] });
    const article = {
      ...articleBody('article', 'body'),
      childIds: [asElementId('ad')],
    };
    const ad = facts({
      id: 'ad',
      parentId: 'article',
      classNames: ['ad-slot'],
      hasAdSlotAttributes: true,
      iframeHosts: ['doubleclick.net'],
      width: 300,
      height: 250,
    });

    const result = classify([body, article, ad]);
    expect(result.removeIds).toContain(asElementId('ad'));
    expect(result.removeIds).not.toContain(asElementId('article'));
  });

  it('never removes the content spine, even when it scores as noise', () => {
    // A sticky, high-z-index wrapper that happens to hold the whole article.
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('sticky')] });
    const sticky = facts({
      id: 'sticky',
      parentId: 'body',
      childIds: [asElementId('article')],
      classNames: ['sticky-promo-wrapper'],
      position: 'sticky',
      zIndex: 99999,
      viewportCoverage: 0.9,
      hasBackdropAppearance: true,
    });
    const article = articleBody('article', 'sticky');

    const result = classify([body, sticky, article]);
    expect(result.removeIds).not.toContain(asElementId('sticky'));
    expect(result.removeIds).not.toContain(asElementId('article'));
  });

  it('marks a high-noise, high-content element as contested rather than removing it', () => {
    // A sponsored block that nevertheless contains real prose.
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('article'), asElementId('sponsored')] });
    const article = articleBody('article', 'body');
    const sponsored = facts({
      id: 'sponsored',
      parentId: 'body',
      classNames: ['sponsored', 'promo'],
      elementId: 'sponsored-content',
      position: 'sticky',
      zIndex: 5000,
      hasAdSlotAttributes: true,
      textLength: 2500,
      longParagraphCount: 6,
      commaCount: 30,
      headingCount: 2,
      meaningfulImageCount: 2,
      width: 660,
      height: 1200,
    });

    const result = classify([body, article, sponsored]);
    expect(result.contestedIds).toContain(asElementId('sponsored'));
    expect(result.removeIds).not.toContain(asElementId('sponsored'));
  });

  it('reports only the outermost element of a removed subtree', () => {
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('modal')] });
    const modal = facts({
      id: 'modal',
      parentId: 'body',
      childIds: [asElementId('modal-title')],
      classNames: ['newsletter-modal'],
      position: 'fixed',
      zIndex: 99999,
      viewportCoverage: 0.6,
      hasBackdropAppearance: true,
      role: 'dialog',
      ariaModal: true,
      hasCloseButton: true,
      width: 600,
      height: 400,
    });
    // The modal's own headline would score as noise on its own.
    const title = facts({
      id: 'modal-title',
      parentId: 'modal',
      classNames: ['newsletter-modal__title'],
      tag: 'H2',
      textLength: 40,
    });

    const result = classify([body, modal, title]);
    expect(result.removeIds).toContain(asElementId('modal'));
    // Descendants are implied by their parent, keeping the action log small.
    expect(result.removeIds).not.toContain(asElementId('modal-title'));
  });

  it('keeps an ordinary page untouched', () => {
    const body = facts({ id: 'body', tag: 'BODY', childIds: [asElementId('article')] });
    const article = articleBody('article', 'body');
    const para = facts({
      id: 'p1',
      parentId: 'article',
      tag: 'P',
      textLength: 900,
      commaCount: 14,
      longParagraphCount: 1,
    });

    const result = classify([body, article, para]);
    expect(result.removeIds).toHaveLength(0);
  });

  it('handles an empty document without throwing', () => {
    const result = classify([]);
    expect(result.removeIds).toHaveLength(0);
    expect(result.contentRootId).toBeNull();
  });
});
