/**
 * Shared domain types.
 *
 * These are deliberately plain and serializable: they cross the browser/server
 * boundary (via `page.evaluate`) and the server/client boundary (via JSON), so
 * nothing here may hold a DOM node, a class instance or a function.
 */

/** Branded id so a raw string can't be passed where an element id is required. */
export type ElementId = string & { readonly __brand: 'ElementId' };

export function asElementId(value: string): ElementId {
  return value as ElementId;
}

/** The attribute carrying `ElementId` in captured markup. */
export const ID_ATTRIBUTE = 'data-w2p-id';
/** Marks an element hidden (space preserved) in the print render. */
export const HIDDEN_ATTRIBUTE = 'data-w2p-hidden';

export type ElementState = 'visible' | 'hidden' | 'removed';

/** Why the automatic cleaner removed something — shown in the editor. */
export type RemovalReason =
  | 'ad'
  | 'popup'
  | 'cookie-banner'
  | 'sticky'
  | 'social'
  | 'chat-widget'
  | 'app-banner'
  | 'newsletter'
  | 'overlay'
  | 'manual';

/** Coarse semantic role, used for editor labels and pagination policy. */
export type BlockRole =
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'figure'
  | 'table'
  | 'list'
  | 'code'
  | 'quote'
  | 'container'
  | 'media'
  | 'other';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One node in the flat element index the editor renders. The client never
 * parses HTML to understand structure — it reads this tree.
 */
export interface ElementRecord {
  readonly id: ElementId;
  readonly parentId: ElementId | null;
  readonly childIds: readonly ElementId[];
  readonly tag: string;
  readonly role: BlockRole;
  /** Short human label for the context menu; sanitized, <= 80 chars. */
  readonly label: string;
  readonly rect: Rect;
  /** Set when the auto-cleaner removed this element. */
  readonly autoRemoved?: RemovalReason;
  /** True when the content scorer judged this meaningful; warns before removal. */
  readonly protected?: boolean;
  /** High noise score but also high content score — surfaced for review (§4). */
  readonly contested?: boolean;
}

// --- PDF settings (§25) ----------------------------------------------------

export type MarginPreset = 'narrow' | 'normal' | 'wide';

export interface PdfSettings {
  readonly margins: MarginPreset;
  readonly pageNumbers: boolean;
  readonly showSourceUrl: boolean;
  readonly showDate: boolean;
  readonly documentTitle: string;
}

export const DEFAULT_PDF_SETTINGS: PdfSettings = {
  margins: 'normal',
  pageNumbers: true,
  showSourceUrl: false,
  showDate: false,
  documentTitle: '',
};

// --- Editing actions (§34) -------------------------------------------------

export type Action =
  | { readonly t: 'remove'; readonly ids: readonly ElementId[] }
  | { readonly t: 'hide'; readonly ids: readonly ElementId[] }
  | { readonly t: 'restore'; readonly ids: readonly ElementId[] }
  | { readonly t: 'restoreAll' }
  | { readonly t: 'settings'; readonly patch: Partial<PdfSettings> };

/** Append-only log; `cursor` is the length of the applied prefix. */
export interface ActionLog {
  readonly entries: readonly Action[];
  readonly cursor: number;
}

// --- Result helper ---------------------------------------------------------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
