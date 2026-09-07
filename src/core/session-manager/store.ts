/**
 * Session store (spec §5).
 *
 * Deliberately in-memory: sessions are transient working state, not documents.
 * There is no history, no accounts and no database, so a Map with a TTL sweep
 * and a byte budget is the correct amount of infrastructure.
 *
 * Serverless caveat (documented in the README): instances are not shared, so a
 * session created on one instance may not be found by a later request routed
 * elsewhere. The snapshot design keeps that recoverable — the user reconverts —
 * rather than corrupting state.
 */

import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { ActionLog, ElementId, ElementRecord, PdfSettings } from '@/core/types';
import { DEFAULT_PDF_SETTINGS } from '@/core/types';
import type { PageSnapshot, SnapshotStats } from '@/browser/snapshot/capture';

export type SessionId = string & { readonly __brand: 'SessionId' };

export interface Session {
  readonly id: SessionId;
  readonly sourceUrl: string;
  readonly title: string;
  readonly createdAt: number;
  lastAccessedAt: number;
  /** Compressed snapshot HTML/CSS; typically 3-5x smaller in memory. */
  readonly compressedHtml: Buffer;
  readonly compressedCss: Buffer;
  readonly lang: string;
  readonly contentWidthPx: number;
  readonly elements: ReadonlyMap<ElementId, ElementRecord>;
  readonly externalAssets: ReadonlyMap<string, string>;
  readonly stats: SnapshotStats;
  log: ActionLog;
  settings: PdfSettings;
  /** Most recently rendered PDF, cached until the next edit. */
  cachedPdf: Buffer | null;
  cachedPdfPageCount: number;
  approximateBytes: number;
}

const sessions = new Map<SessionId, Session>();
let sweepTimer: NodeJS.Timeout | null = null;

/** Starts the TTL sweep lazily, and never keeps the process alive for it. */
function ensureSweeper(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    sweepExpired();
  }, 60_000);
  // `unref` matters: a pending timer would otherwise block process exit.
  sweepTimer.unref?.();
}

function totalBytes(): number {
  let total = 0;
  for (const session of sessions.values()) total += session.approximateBytes;
  return total;
}

/** Drops expired sessions; returns how many were removed. */
export function sweepExpired(): number {
  const ttl = getConfig().sessionTtlMs;
  const cutoff = Date.now() - ttl;
  let removed = 0;

  for (const [id, session] of sessions) {
    if (session.lastAccessedAt < cutoff) {
      sessions.delete(id);
      removed += 1;
    }
  }

  if (removed > 0) logger.debug('sessions swept', { removed, remaining: sessions.size });
  return removed;
}

/** Evicts least-recently-used sessions until the store fits its budget. */
function evictToFit(): void {
  const budget = getConfig().maxSessionStoreBytes;
  if (totalBytes() <= budget) return;

  const byAge = [...sessions.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (const session of byAge) {
    if (totalBytes() <= budget) break;
    sessions.delete(session.id);
    logger.info('session evicted for memory pressure', { sessionId: session.id });
  }
}

export interface CreateSessionInput {
  readonly snapshot: PageSnapshot;
}

/**
 * Stores a snapshot as a new session. The auto-cleanup result is seeded as
 * action-log entry 0, so undoing it is an ordinary undo.
 */
export function createSession(input: CreateSessionInput): Session {
  ensureSweeper();
  sweepExpired();

  const { snapshot } = input;
  const compressedHtml = gzipSync(Buffer.from(snapshot.html, 'utf8'));
  const compressedCss = gzipSync(Buffer.from(snapshot.css, 'utf8'));
  const id = randomUUID() as SessionId;

  const session: Session = {
    id,
    sourceUrl: snapshot.sourceUrl,
    title: snapshot.title,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    compressedHtml,
    compressedCss,
    lang: snapshot.lang,
    contentWidthPx: snapshot.contentWidthPx,
    elements: snapshot.elements,
    externalAssets: snapshot.externalAssets,
    stats: snapshot.stats,
    // Entry 0 is the automatic cleanup, applied.
    log:
      snapshot.autoRemovedIds.length > 0
        ? { entries: [{ t: 'remove', ids: snapshot.autoRemovedIds }], cursor: 1 }
        : { entries: [], cursor: 0 },
    settings: {
      ...DEFAULT_PDF_SETTINGS,
      documentTitle: snapshot.title,
    },
    cachedPdf: null,
    cachedPdfPageCount: 0,
    approximateBytes: compressedHtml.length + compressedCss.length + snapshot.elements.size * 200,
  };

  sessions.set(id, session);
  evictToFit();

  logger.info('session created', {
    sessionId: id,
    elements: snapshot.elements.size,
    bytes: session.approximateBytes,
  });

  return session;
}

/** Fetches a live session, refreshing its TTL. Throws if missing or expired. */
export function getSession(id: string): Session {
  const session = sessions.get(id as SessionId);
  if (!session) throw new AppError('SESSION_NOT_FOUND', `no session ${id}`);

  if (Date.now() - session.lastAccessedAt > getConfig().sessionTtlMs) {
    sessions.delete(session.id);
    throw new AppError('SESSION_EXPIRED', `session ${id} expired`);
  }

  session.lastAccessedAt = Date.now();
  return session;
}

/** Rebuilds the snapshot needed for rendering, decompressing on demand. */
export function snapshotOf(session: Session): PageSnapshot {
  return {
    html: gunzipSync(session.compressedHtml).toString('utf8'),
    css: gunzipSync(session.compressedCss).toString('utf8'),
    title: session.title,
    sourceUrl: session.sourceUrl,
    lang: session.lang,
    capturedAt: session.createdAt,
    contentWidthPx: session.contentWidthPx,
    elements: session.elements,
    autoRemovedIds: [],
    externalAssets: session.externalAssets,
    stats: session.stats,
  };
}

/** Invalidates the cached PDF after an edit. */
export function invalidatePdf(session: Session): void {
  session.cachedPdf = null;
  session.cachedPdfPageCount = 0;
}

export function storePdf(session: Session, pdf: Buffer, pageCount: number): void {
  // Replace rather than accumulate: only the latest PDF is ever served.
  session.approximateBytes += pdf.length - (session.cachedPdf?.length ?? 0);
  session.cachedPdf = pdf;
  session.cachedPdfPageCount = pageCount;
  evictToFit();
}

export function deleteSession(id: string): void {
  sessions.delete(id as SessionId);
}

/** Test helper: clears all state. */
export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}
