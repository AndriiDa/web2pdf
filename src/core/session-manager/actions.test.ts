import { describe, it, expect } from 'vitest';
import {
  EMPTY_LOG,
  pushAction,
  undo,
  redo,
  canUndo,
  canRedo,
  deriveStates,
  deriveSettings,
  resolveEffectiveState,
  removedIds,
  hiddenIds,
  isValidAction,
} from './actions';
import { asElementId, type ElementId, type ActionLog } from '@/core/types';

const a = asElementId('a');
const b = asElementId('b');
const c = asElementId('c');
const ALL: ElementId[] = [a, b, c];

describe('action log', () => {
  it('appends actions and advances the cursor', () => {
    const log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    expect(log.entries).toHaveLength(1);
    expect(log.cursor).toBe(1);
  });

  it('moves the cursor on undo and redo without losing entries', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    log = pushAction(log, { t: 'hide', ids: [b] });
    expect(canUndo(log)).toBe(true);
    expect(canRedo(log)).toBe(false);

    log = undo(log);
    expect(log.cursor).toBe(1);
    expect(log.entries).toHaveLength(2);
    expect(canRedo(log)).toBe(true);

    log = redo(log);
    expect(log.cursor).toBe(2);
  });

  it('is a no-op at the ends of history', () => {
    expect(undo(EMPTY_LOG)).toEqual(EMPTY_LOG);
    const log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    expect(redo(log)).toEqual(log);
  });

  it('discards the redo branch when a new action follows an undo', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    log = pushAction(log, { t: 'remove', ids: [b] });
    log = undo(log);
    log = pushAction(log, { t: 'hide', ids: [c] });

    expect(log.entries).toHaveLength(2);
    expect(log.cursor).toBe(2);
    expect(canRedo(log)).toBe(false);
    // The discarded action must not reappear.
    const states = deriveStates(log, ALL);
    expect(states.get(b)).toBe('visible');
    expect(states.get(c)).toBe('hidden');
  });
});

describe('deriveStates', () => {
  it('starts with everything visible', () => {
    const states = deriveStates(EMPTY_LOG, ALL);
    expect([...states.values()]).toEqual(['visible', 'visible', 'visible']);
  });

  it('applies remove and hide distinctly', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    log = pushAction(log, { t: 'hide', ids: [b] });
    const states = deriveStates(log, ALL);

    expect(states.get(a)).toBe('removed');
    expect(states.get(b)).toBe('hidden');
    expect(states.get(c)).toBe('visible');
  });

  it('lets a later action override an earlier one', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    log = pushAction(log, { t: 'restore', ids: [a] });
    expect(deriveStates(log, ALL).get(a)).toBe('visible');
  });

  it('restoreAll clears every modification', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a, b] });
    log = pushAction(log, { t: 'hide', ids: [c] });
    log = pushAction(log, { t: 'restoreAll' });

    const states = deriveStates(log, ALL);
    expect([...states.values()].every((s) => s === 'visible')).toBe(true);
  });

  it('reflects only the applied prefix, so undo restores content', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    expect(deriveStates(log, ALL).get(a)).toBe('removed');

    log = undo(log);
    expect(deriveStates(log, ALL).get(a)).toBe('visible');

    log = redo(log);
    expect(deriveStates(log, ALL).get(a)).toBe('removed');
  });

  it('ignores ids that are not part of the document', () => {
    const log = pushAction(EMPTY_LOG, { t: 'remove', ids: [asElementId('ghost')] });
    const states = deriveStates(log, ALL);
    expect(states.size).toBe(3);
    expect(states.has(asElementId('ghost'))).toBe(false);
  });

  it('treats auto-cleanup seeded as entry 0 like any other action', () => {
    // This is what makes "undo the ad remover" work with no special casing.
    const seeded: ActionLog = { entries: [{ t: 'remove', ids: [a, b] }], cursor: 1 };
    expect(deriveStates(seeded, ALL).get(a)).toBe('removed');

    const undone = undo(seeded);
    expect(deriveStates(undone, ALL).get(a)).toBe('visible');
  });
});

describe('resolveEffectiveState — inheritance', () => {
  // Tree: a -> b -> c
  const parentOf = (id: ElementId): ElementId | null => {
    if (id === c) return b;
    if (id === b) return a;
    return null;
  };

  it('propagates removal to descendants', () => {
    const log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    const states = deriveStates(log, ALL);
    expect(resolveEffectiveState(c, states, parentOf)).toBe('removed');
  });

  it('propagates hiding to descendants', () => {
    const log = pushAction(EMPTY_LOG, { t: 'hide', ids: [a] });
    const states = deriveStates(log, ALL);
    expect(resolveEffectiveState(c, states, parentOf)).toBe('hidden');
  });

  it('lets removal on an ancestor win over hiding on a child', () => {
    let log = pushAction(EMPTY_LOG, { t: 'hide', ids: [c] });
    log = pushAction(log, { t: 'remove', ids: [a] });
    const states = deriveStates(log, ALL);
    expect(resolveEffectiveState(c, states, parentOf)).toBe('removed');
  });

  it('leaves siblings unaffected', () => {
    const log = pushAction(EMPTY_LOG, { t: 'remove', ids: [b] });
    const states = deriveStates(log, ALL);
    expect(resolveEffectiveState(a, states, parentOf)).toBe('visible');
  });

  it('does not hang on a cyclic parent chain', () => {
    const cyclic = (id: ElementId): ElementId => (id === a ? b : a);
    const states = deriveStates(EMPTY_LOG, ALL);
    expect(resolveEffectiveState(a, states, cyclic)).toBe('visible');
  });
});

describe('state extraction helpers', () => {
  it('separates removed from hidden ids', () => {
    let log = pushAction(EMPTY_LOG, { t: 'remove', ids: [a] });
    log = pushAction(log, { t: 'hide', ids: [b] });
    const states = deriveStates(log, ALL);

    expect(removedIds(states)).toEqual([a]);
    expect(hiddenIds(states)).toEqual([b]);
  });
});

describe('deriveSettings', () => {
  it('returns defaults for an empty log', () => {
    const settings = deriveSettings(EMPTY_LOG);
    expect(settings.margins).toBe('normal');
    expect(settings.pageNumbers).toBe(true);
  });

  it('folds patches in order', () => {
    let log = pushAction(EMPTY_LOG, { t: 'settings', patch: { margins: 'wide' } });
    log = pushAction(log, { t: 'settings', patch: { pageNumbers: false } });
    log = pushAction(log, { t: 'settings', patch: { margins: 'narrow' } });

    const settings = deriveSettings(log);
    expect(settings.margins).toBe('narrow');
    expect(settings.pageNumbers).toBe(false);
  });

  it('is undoable like any other action', () => {
    let log = pushAction(EMPTY_LOG, { t: 'settings', patch: { margins: 'wide' } });
    log = undo(log);
    expect(deriveSettings(log).margins).toBe('normal');
  });
});

describe('isValidAction', () => {
  it('accepts well-formed actions', () => {
    expect(isValidAction({ t: 'remove', ids: ['x'] })).toBe(true);
    expect(isValidAction({ t: 'restoreAll' })).toBe(true);
    expect(isValidAction({ t: 'settings', patch: { margins: 'wide' } })).toBe(true);
  });

  it('rejects malformed or hostile payloads', () => {
    expect(isValidAction(null)).toBe(false);
    expect(isValidAction('remove')).toBe(false);
    expect(isValidAction({ t: 'drop-database' })).toBe(false);
    expect(isValidAction({ t: 'remove', ids: [] })).toBe(false);
    expect(isValidAction({ t: 'remove', ids: [123] })).toBe(false);
    // Oversized payloads are a cheap denial-of-service vector.
    expect(isValidAction({ t: 'remove', ids: Array(6000).fill('x') })).toBe(false);
    expect(isValidAction({ t: 'remove', ids: ['y'.repeat(200)] })).toBe(false);
  });
});
