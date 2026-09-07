/**
 * Action log and derived state (spec §12, §34).
 *
 * Everything here is a pure function over plain data, so undo/redo semantics
 * are fully unit-testable without a browser or a session store.
 *
 * The design point: the session stores *actions*, never DOM. Visible state is a
 * fold over the applied prefix of the log. Undo moves the cursor back; redo
 * moves it forward. Automatic cleanup is seeded as entry 0, so "undo what the
 * ad remover did" uses exactly the same machinery as manual editing.
 */

import type {
  Action,
  ActionLog,
  ElementId,
  ElementState,
  PdfSettings,
} from '@/core/types';
import { DEFAULT_PDF_SETTINGS } from '@/core/types';

export const EMPTY_LOG: ActionLog = { entries: [], cursor: 0 };

/**
 * Appends an action, discarding any redo branch first.
 *
 * Truncating on a new action after undo is standard editor behaviour: the
 * redone-away future is unreachable once history diverges.
 */
export function pushAction(log: ActionLog, action: Action): ActionLog {
  const kept = log.entries.slice(0, log.cursor);
  return { entries: [...kept, action], cursor: kept.length + 1 };
}

export function canUndo(log: ActionLog): boolean {
  return log.cursor > 0;
}

export function canRedo(log: ActionLog): boolean {
  return log.cursor < log.entries.length;
}

export function undo(log: ActionLog): ActionLog {
  return canUndo(log) ? { entries: log.entries, cursor: log.cursor - 1 } : log;
}

export function redo(log: ActionLog): ActionLog {
  return canRedo(log) ? { entries: log.entries, cursor: log.cursor + 1 } : log;
}

/**
 * Folds the applied prefix into per-element visibility.
 *
 * Only explicitly-acted ids are stored; descendant effects are resolved at
 * render time. That keeps a log entry O(1) rather than O(subtree), and lets
 * restoring a parent correctly resurrect children the user never touched.
 */
export function deriveStates(
  log: ActionLog,
  allIds: Iterable<ElementId>,
): Map<ElementId, ElementState> {
  const states = new Map<ElementId, ElementState>();
  for (const id of allIds) states.set(id, 'visible');

  for (let i = 0; i < log.cursor && i < log.entries.length; i += 1) {
    const action = log.entries[i];
    if (action === undefined) continue;

    switch (action.t) {
      case 'remove':
        for (const id of action.ids) if (states.has(id)) states.set(id, 'removed');
        break;
      case 'hide':
        for (const id of action.ids) if (states.has(id)) states.set(id, 'hidden');
        break;
      case 'restore':
        for (const id of action.ids) if (states.has(id)) states.set(id, 'visible');
        break;
      case 'restoreAll':
        for (const id of states.keys()) states.set(id, 'visible');
        break;
      case 'settings':
        // Settings do not affect element visibility.
        break;
    }
  }

  return states;
}

/** Folds settings patches over the defaults, in log order. */
export function deriveSettings(log: ActionLog, base: PdfSettings = DEFAULT_PDF_SETTINGS): PdfSettings {
  let settings = base;
  for (let i = 0; i < log.cursor && i < log.entries.length; i += 1) {
    const action = log.entries[i];
    if (action?.t === 'settings') {
      settings = { ...settings, ...action.patch };
    }
  }
  return settings;
}

/**
 * Resolves effective state including inheritance: an element inside a removed
 * ancestor is itself removed, and inside a hidden ancestor is hidden.
 *
 * `parentOf` lets this work directly on the flat element index.
 */
export function resolveEffectiveState(
  id: ElementId,
  states: ReadonlyMap<ElementId, ElementState>,
  parentOf: (id: ElementId) => ElementId | null,
): ElementState {
  let strongest: ElementState = 'visible';
  let current: ElementId | null = id;
  // Bounded to avoid pathological cycles in a malformed tree.
  let guard = 0;

  while (current !== null && guard < 1000) {
    const state = states.get(current);
    // Removal wins outright; hidden only upgrades from visible.
    if (state === 'removed') return 'removed';
    if (state === 'hidden') strongest = 'hidden';
    current = parentOf(current);
    guard += 1;
  }

  return strongest;
}

/** Ids whose own state is `removed` — used to detach nodes before printing. */
export function removedIds(states: ReadonlyMap<ElementId, ElementState>): ElementId[] {
  const result: ElementId[] = [];
  for (const [id, state] of states) if (state === 'removed') result.push(id);
  return result;
}

/** Ids whose own state is `hidden` — rendered with `visibility: hidden`. */
export function hiddenIds(states: ReadonlyMap<ElementId, ElementState>): ElementId[] {
  const result: ElementId[] = [];
  for (const [id, state] of states) if (state === 'hidden') result.push(id);
  return result;
}

/** Validates a client-supplied action before it enters the log. */
export function isValidAction(value: unknown): value is Action {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { t?: unknown; ids?: unknown; patch?: unknown };

  switch (candidate.t) {
    case 'remove':
    case 'hide':
    case 'restore':
      return (
        Array.isArray(candidate.ids) &&
        candidate.ids.length > 0 &&
        candidate.ids.length <= 5000 &&
        candidate.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
      );
    case 'restoreAll':
      return true;
    case 'settings':
      return typeof candidate.patch === 'object' && candidate.patch !== null;
    default:
      return false;
  }
}
