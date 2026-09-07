import { describe, it, expect } from 'vitest';
import { planBreaks, applyPlan, MIN_SCALE, type Block } from './plan';
import { pageGeometry, pageIndexAt, pageCountFor, A4_WIDTH_PX, A4_HEIGHT_PX } from './geometry';
import { asElementId, type BlockRole } from '@/core/types';

/** Page height used across these tests — round numbers keep them readable. */
const H = 1000;

let seq = 0;
function block(partial: Partial<Block> & { top: number; height: number }): Block {
  seq += 1;
  const role: BlockRole = partial.role ?? 'paragraph';
  return {
    id: partial.id ?? asElementId(`b${seq}`),
    top: partial.top,
    height: partial.height,
    role,
    atomic: partial.atomic ?? false,
    splittable: partial.splittable ?? false,
    keepWithNext: partial.keepWithNext ?? 0,
    ...(partial.level !== undefined ? { level: partial.level } : {}),
    ...(partial.lineHeight !== undefined ? { lineHeight: partial.lineHeight } : {}),
  };
}

/** Rebuilds a contiguous flow, so `top` values are always consistent. */
function flow(specs: Array<Partial<Block> & { height: number }>): Block[] {
  let top = 0;
  return specs.map((spec) => {
    const b = block({ ...spec, top });
    top += spec.height;
    return b;
  });
}

describe('geometry', () => {
  it('computes true A4 dimensions in CSS pixels', () => {
    expect(A4_WIDTH_PX).toBeCloseTo(793.7, 1);
    expect(A4_HEIGHT_PX).toBeCloseTo(1122.5, 1);
  });

  it('derives content box from the margin preset', () => {
    const normal = pageGeometry({ margins: 'normal' });
    const narrow = pageGeometry({ margins: 'narrow' });
    const wide = pageGeometry({ margins: 'wide' });

    expect(narrow.contentWidth).toBeGreaterThan(normal.contentWidth);
    expect(normal.contentWidth).toBeGreaterThan(wide.contentWidth);
    // Normal margins (17.5mm each side) leave ~661px of usable width.
    expect(normal.contentWidth).toBeCloseTo(661.4, 0);
  });

  it('subtracts header/footer bands from the content height so they cannot overlap', () => {
    const plain = pageGeometry({ margins: 'normal' });
    const withBands = pageGeometry({ margins: 'normal', hasHeader: true, hasFooter: true });
    expect(withBands.contentHeight).toBeLessThan(plain.contentHeight);
  });

  it('maps offsets to page indices', () => {
    expect(pageIndexAt(0, H)).toBe(0);
    expect(pageIndexAt(999, H)).toBe(0);
    expect(pageIndexAt(1000, H)).toBe(1);
    expect(pageCountFor(2500, H)).toBe(3);
    expect(pageCountFor(0, H)).toBe(1);
  });
});

describe('planBreaks — atomic blocks (§15, §17)', () => {
  it('pushes an image that would straddle a page boundary', () => {
    // Image spans 900..1300, crossing the boundary at 1000.
    const blocks = flow([
      { height: 900 },
      { height: 400, role: 'image', atomic: true },
    ]);

    const plan = planBreaks(blocks, { contentHeight: H });
    const push = plan.mutations.find((m) => m.kind === 'push');

    expect(push).toBeDefined();
    expect(push?.id).toBe(blocks[1]?.id);
    expect(push?.value).toBeCloseTo(100, 5); // 1000 - 900

    // After the push the image starts exactly on page 2 and is intact.
    const final = applyPlan(blocks, plan);
    const image = final.get(blocks[1]!.id)!;
    expect(image.top).toBeCloseTo(1000, 5);
    expect(pageIndexAt(image.top, H)).toBe(1);
    expect(pageIndexAt(image.top + image.height - 1, H)).toBe(1);
  });

  it('leaves an image alone when it already fits on the page', () => {
    const blocks = flow([{ height: 200 }, { height: 400, role: 'image', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });
    expect(plan.mutations).toHaveLength(0);
    expect(plan.converged).toBe(true);
  });

  it('does not push a block that starts exactly on a boundary', () => {
    // Starting at 1000 means it already begins page 2; a push would insert a
    // blank page.
    const blocks = flow([{ height: 1000 }, { height: 400, role: 'image', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });
    expect(plan.mutations.filter((m) => m.kind === 'push')).toHaveLength(0);
  });

  it('never splits a figure, keeping image and caption together', () => {
    const blocks = flow([
      { height: 850 },
      { height: 300, role: 'figure', atomic: true },
    ]);
    const plan = planBreaks(blocks, { contentHeight: H });
    const final = applyPlan(blocks, plan);
    const fig = final.get(blocks[1]!.id)!;
    expect(pageIndexAt(fig.top, H)).toBe(pageIndexAt(fig.top + fig.height - 1, H));
  });
});

describe('planBreaks — oversized blocks (§17)', () => {
  it('refuses to scale below the readability floor and splits instead', () => {
    // Fitting 1500px into 1000px needs a 0.667 factor, below MIN_SCALE (0.7).
    // Shrinking that far would make the content unreadable, which is worse than
    // the page break it avoids — so the planner must decline to scale.
    const blocks = flow([{ height: 1500, role: 'image', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });

    expect(1000 / 1500).toBeLessThan(MIN_SCALE);
    expect(plan.mutations.find((m) => m.kind === 'scale')).toBeUndefined();
    expect(plan.mutations.some((m) => m.kind === 'allow-split')).toBe(true);
    expect(plan.converged).toBe(true);
  });

  it('scales when the required factor stays at or above the readability floor', () => {
    // 1000/1250 = 0.8, comfortably above MIN_SCALE, so scaling is preferred.
    const blocks = flow([{ height: 1250, role: 'image', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });

    const scale = plan.mutations.find((m) => m.kind === 'scale');
    expect(scale).toBeDefined();
    expect(scale?.value ?? 0).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(scale?.value).toBeCloseTo(0.8, 5);
  });

  it('scales a moderately over-tall image rather than splitting it', () => {
    const blocks = flow([{ height: 1200, role: 'image', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });
    const scale = plan.mutations.find((m) => m.kind === 'scale');
    expect(scale?.value).toBeCloseTo(1000 / 1200, 5);

    const final = applyPlan(blocks, plan);
    expect(final.get(blocks[0]!.id)!.height).toBeCloseTo(1000, 5);
  });

  it('allows a controlled split for an unshrinkable oversized block, with a warning', () => {
    const blocks = flow([{ height: 3000, role: 'other', atomic: true }]);
    const plan = planBreaks(blocks, { contentHeight: H });

    expect(plan.mutations.some((m) => m.kind === 'allow-split')).toBe(true);
    expect(plan.warnings.length).toBeGreaterThan(0);
    // Critically: it still terminates rather than pushing forever.
    expect(plan.converged).toBe(true);
  });
});

describe('planBreaks — orphaned headings (§16)', () => {
  it('pushes a heading stranded at the foot of a page', () => {
    // Heading at 950..990 with its paragraph starting at 990 — the heading sits
    // alone at the bottom of page 1.
    const blocks = flow([
      { height: 950 },
      { height: 40, role: 'heading', keepWithNext: 1, level: 2 },
      { height: 300 },
    ]);

    const plan = planBreaks(blocks, { contentHeight: H });
    const push = plan.mutations.find((m) => m.id === blocks[1]?.id);
    expect(push).toBeDefined();
    expect(push?.reason).toContain('orphan');

    // Heading and its paragraph now share page 2.
    const final = applyPlan(blocks, plan);
    const heading = final.get(blocks[1]!.id)!;
    const para = final.get(blocks[2]!.id)!;
    expect(pageIndexAt(heading.top, H)).toBe(pageIndexAt(para.top, H));
  });

  it('leaves a heading alone when it already sits with its content', () => {
    const blocks = flow([
      { height: 200 },
      { height: 40, role: 'heading', keepWithNext: 1 },
      { height: 300 },
    ]);
    const plan = planBreaks(blocks, { contentHeight: H });
    expect(plan.mutations).toHaveLength(0);
  });

  it('accepts the break when heading plus content cannot fit any page', () => {
    // The companion is taller than a whole page, so no push can ever satisfy
    // the constraint. This must terminate, not loop.
    const blocks = flow([
      { height: 950 },
      { height: 40, role: 'heading', keepWithNext: 1 },
      { height: 5000 },
    ]);

    const plan = planBreaks(blocks, { contentHeight: H, maxIterations: 8 });
    expect(plan.iterations).toBeLessThanOrEqual(8);
    expect(plan.mutations.filter((m) => m.id === blocks[1]?.id)).toHaveLength(0);
  });
});

describe('planBreaks — code blocks (§19)', () => {
  it('permits a large code block to split across pages', () => {
    const blocks = flow([
      { height: 600 },
      { height: 800, role: 'code', splittable: true, lineHeight: 20 },
    ]);
    const plan = planBreaks(blocks, { contentHeight: H });
    // 400px (20 lines) before the break, 400px after: both sides are ample, so
    // splitting is allowed and no push is emitted.
    expect(plan.mutations.filter((m) => m.kind === 'push')).toHaveLength(0);
  });

  it('pushes a code block when the split would strand a single line', () => {
    // Only 20px (1 line) would remain on page 1 before the boundary.
    const blocks = flow([
      { height: 980 },
      { height: 300, role: 'code', splittable: true, lineHeight: 20 },
    ]);
    const plan = planBreaks(blocks, { contentHeight: H, minLinesPerFragment: 2 });
    const push = plan.mutations.find((m) => m.kind === 'push');
    expect(push).toBeDefined();
    expect(push?.reason).toContain('too few lines');
  });
});

describe('planBreaks — termination guarantees', () => {
  it('converges on a long realistic document', () => {
    const specs: Array<Partial<Block> & { height: number }> = [];
    for (let i = 0; i < 120; i += 1) {
      specs.push({ height: 40, role: 'heading', keepWithNext: 1 });
      specs.push({ height: 180 });
      if (i % 3 === 0) specs.push({ height: 320, role: 'image', atomic: true });
    }

    const plan = planBreaks(flow(specs), { contentHeight: H });
    expect(plan.converged).toBe(true);
    // Real documents settle in a couple of passes.
    expect(plan.iterations).toBeLessThanOrEqual(4);
  });

  it('terminates on adversarial input designed to oscillate', () => {
    // Blocks sized to keep re-straddling as earlier ones are pushed.
    const specs: Array<Partial<Block> & { height: number }> = [];
    for (let i = 0; i < 200; i += 1) {
      specs.push({ height: 999, role: 'image', atomic: true });
    }

    const plan = planBreaks(flow(specs), { contentHeight: H, maxIterations: 8 });
    expect(plan.iterations).toBeLessThanOrEqual(8);
    // Each block is pushed at most once (guard 2).
    const pushIds = plan.mutations.filter((m) => m.kind === 'push').map((m) => m.id);
    expect(new Set(pushIds).size).toBe(pushIds.length);
  });

  it('respects the wall-clock budget with an injected clock', () => {
    let fakeTime = 0;
    // Every call advances 10s, so the budget is blown after the first pass.
    const now = (): number => {
      fakeTime += 10_000;
      return fakeTime;
    };

    const specs = Array.from({ length: 400 }, () => ({
      height: 950,
      role: 'image' as BlockRole,
      atomic: true,
    }));

    const plan = planBreaks(flow(specs), { contentHeight: H, budgetMs: 5_000, now });
    expect(plan.iterations).toBeLessThan(8);
    expect(plan.warnings.some((w) => w.includes('budget'))).toBe(true);
  });

  it('handles empty input and degenerate geometry without throwing', () => {
    expect(planBreaks([], { contentHeight: H }).converged).toBe(true);
    expect(planBreaks(flow([{ height: 100 }]), { contentHeight: 0 }).converged).toBe(true);
  });

  it('only ever moves blocks forward, never backward (guard 1)', () => {
    const blocks = flow([
      { height: 900 },
      { height: 400, role: 'image', atomic: true },
      { height: 700, role: 'image', atomic: true },
      { height: 200 },
    ]);

    const plan = planBreaks(blocks, { contentHeight: H });
    const final = applyPlan(blocks, plan);

    for (const b of blocks) {
      expect(final.get(b.id)!.top).toBeGreaterThanOrEqual(b.top);
    }
  });

  it('produces a layout where no atomic block straddles a boundary', () => {
    const blocks = flow([
      { height: 300 },
      { height: 400, role: 'image', atomic: true },
      { height: 250 },
      { height: 380, role: 'figure', atomic: true },
      { height: 500 },
      { height: 420, role: 'image', atomic: true },
      { height: 150 },
      { height: 300, role: 'table', atomic: true },
    ]);

    const plan = planBreaks(blocks, { contentHeight: H });
    const final = applyPlan(blocks, plan);

    for (const b of blocks) {
      if (!b.atomic) continue;
      const placed = final.get(b.id)!;
      const startPage = pageIndexAt(placed.top, H);
      const endPage = pageIndexAt(placed.top + placed.height - 1, H);
      expect(endPage, `atomic block ${b.id} (${b.role}) straddles a page break`).toBe(startPage);
    }
  });
});
