/**
 * The session view returned to the client.
 *
 * Deliberately excludes the snapshot HTML: the client renders the document
 * through the sandboxed preview route, never by receiving markup it might
 * inject into the app itself (§31). Only the element tree and metadata travel
 * as JSON, which also keeps responses well under the 4.5 MB platform cap.
 */

import type { Session } from '@/core/session-manager/store';
import { canRedo, canUndo, deriveSettings, deriveStates } from '@/core/session-manager/actions';
import type { ElementState, PdfSettings } from '@/core/types';

export interface ElementView {
  readonly id: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly tag: string;
  readonly role: string;
  readonly label: string;
  readonly state: ElementState;
  readonly protected?: boolean;
  readonly contested?: boolean;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly elements: readonly ElementView[];
  readonly settings: PdfSettings;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly pageCount: number;
  readonly stats: {
    readonly adsRemoved: number;
    readonly popupsRemoved: number;
    readonly contestedCount: number;
    readonly imageCount: number;
    readonly elementCount: number;
  };
  /** Changes whenever the document changes, so the client can bust its cache. */
  readonly revision: number;
}

export function sessionSummary(session: Session): SessionSummary {
  const states = deriveStates(session.log, session.elements.keys());
  const settings = deriveSettings(session.log, session.settings);

  const elements: ElementView[] = [];
  for (const [id, record] of session.elements) {
    elements.push({
      id,
      parentId: record.parentId,
      childIds: [...record.childIds],
      tag: record.tag,
      role: record.role,
      label: record.label,
      state: states.get(id) ?? 'visible',
      ...(record.protected ? { protected: true } : {}),
      ...(record.contested ? { contested: true } : {}),
    });
  }

  return {
    sessionId: session.id,
    sourceUrl: session.sourceUrl,
    title: session.title,
    elements,
    settings,
    canUndo: canUndo(session.log),
    canRedo: canRedo(session.log),
    pageCount: session.cachedPdfPageCount,
    stats: {
      adsRemoved: session.stats.adsRemoved,
      popupsRemoved: session.stats.popupsRemoved,
      contestedCount: session.stats.contestedCount,
      imageCount: session.stats.imageCount,
      elementCount: session.stats.elementCount,
    },
    // Must identify the DOCUMENT STATE, not the history position: the cursor
    // alone repeats across different states (remove then undo returns it to a
    // previous value), so the preview iframe URL would not change and the
    // stale document would stay on screen. Hashing the derived states makes
    // the revision change exactly when the visible document changes.
    revision: documentRevision(states),
  };
}

/**
 * A stable 31-bit hash of the current visibility state of every element.
 * Equal documents produce equal revisions; any change produces a new one.
 */
function documentRevision(states: ReadonlyMap<string, ElementState>): number {
  let hash = 0x811c9dc5;
  for (const [id, state] of states) {
    if (state === 'visible') continue;
    const token = `${id}:${state};`;
    for (let i = 0; i < token.length; i += 1) {
      hash = (Math.imul(hash ^ token.charCodeAt(i), 0x01000193) >>> 0);
    }
  }
  return hash % 0x7fffffff;
}
