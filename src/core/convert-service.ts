/**
 * Conversion orchestration: URL in, session out.
 *
 * Ties together validation, browser lifecycle, loading, capture and session
 * creation, applying the global processing budget and the concurrency limit.
 * API routes stay thin — none of this logic lives in a route handler (§42).
 */

import { getConfig } from '@/lib/config';
import { AppError, toAppError } from '@/lib/errors';
import { createLogger, safeHostname, type Stage } from '@/lib/logger';
import { validateUrl } from '@/core/url-validator';
import { getBrowserService } from '@/browser/browser-service';
import { loadPage } from '@/browser/page-loader';
import { capture } from '@/browser/snapshot/capture';
import { renderPdf } from '@/browser/pdf-generator';
import { pageGeometry } from '@/core/pagination-engine/geometry';
import { createSession, snapshotOf, storePdf, type Session } from '@/core/session-manager/store';
import { deriveSettings, deriveStates } from '@/core/session-manager/actions';
import { hasFooterContent, hasHeaderContent } from '@/browser/pdf-generator/header-footer';

/** In-flight browser jobs, capped by MAX_CONCURRENT_JOBS (§29). */
let activeJobs = 0;

/** Runs `fn` under the concurrency limit, rejecting rather than queueing. */
async function withJobSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = getConfig().maxConcurrentJobs;
  if (activeJobs >= limit) {
    throw new AppError('BUSY', `at capacity: ${activeJobs}/${limit}`);
  }
  activeJobs += 1;
  try {
    return await fn();
  } finally {
    activeJobs -= 1;
  }
}

/** Rejects with a clear error once the total processing budget is exhausted. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError('PROCESSING_TIMEOUT', `exceeded ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ProgressCallback = (stage: Stage) => void;

export interface ConvertResult {
  readonly session: Session;
}

/**
 * Converts a URL into a ready session with a rendered first PDF.
 */
export async function convertUrl(
  rawUrl: string,
  onProgress?: ProgressCallback,
): Promise<ConvertResult> {
  const config = getConfig();
  const log = createLogger({ host: safeHostname(rawUrl) });
  const started = Date.now();

  return withJobSlot(async () =>
    withDeadline(
      (async () => {
        onProgress?.('validating');
        const url = await validateUrl(rawUrl, {
          allowPrivateTargets: config.allowPrivateTargets,
        });

        // The capture viewport MUST equal the print content width, or every
        // measured rect is wrong and the preview will not match the PDF.
        const geometry = pageGeometry({ margins: 'normal' });
        const contentWidth = Math.round(geometry.contentWidth);

        onProgress?.('launching');
        const service = getBrowserService();

        const snapshot = await service.withContext(
          {
            viewportWidth: contentWidth,
            viewportHeight: 1200,
            pinnedAddresses: url.pinnedAddresses,
            hostname: url.hostname,
            port: url.port,
          },
          async (context) => {
            const loaded = await loadPage(context, {
              url,
              allowPrivateTargets: config.allowPrivateTargets,
              log,
              onStage: (stage) => onProgress?.(stage as Stage),
            });

            onProgress?.('cleaning');
            try {
              return await capture(loaded.page, {
                sourceUrl: url.href,
                contentWidthPx: geometry.contentWidth,
                log,
              });
            } finally {
              await loaded.page.close().catch(() => undefined);
            }
          },
        );

        onProgress?.('snapshotting');
        const session = createSession({ snapshot });

        // Render the first PDF immediately so the editor opens with both panes
        // populated rather than an empty preview.
        onProgress?.('generating-pdf');
        await regenerateSession(session);

        onProgress?.('ready');
        log.info('conversion complete', {
          sessionId: session.id,
          durationMs: Date.now() - started,
          pageCount: session.cachedPdfPageCount,
          elements: session.elements.size,
          adsRemoved: snapshot.stats.adsRemoved,
          popupsRemoved: snapshot.stats.popupsRemoved,
        });

        return { session };
      })(),
      config.maxProcessingTimeMs,
    ),
  ).catch((error: unknown) => {
    const appError = toAppError(error);
    log.error('conversion failed', {
      code: appError.code,
      detail: appError.detail,
      durationMs: Date.now() - started,
    });
    throw appError;
  });
}

/**
 * Re-renders the PDF for a session from its stored snapshot plus current edits.
 * Used after every editing action and on explicit regenerate.
 */
export async function regenerateSession(session: Session): Promise<void> {
  const log = createLogger({ sessionId: session.id });
  const snapshot = snapshotOf(session);
  const states = deriveStates(session.log, session.elements.keys());
  const settings = deriveSettings(session.log, session.settings);

  const geometry = pageGeometry({
    margins: settings.margins,
    hasHeader: hasHeaderContent({ settings, sourceUrl: session.sourceUrl, title: session.title }),
    hasFooter: hasFooterContent(settings),
  });

  const service = getBrowserService();
  const result = await withJobSlot(async () =>
    service.withContext(
      {
        viewportWidth: Math.round(geometry.contentWidth),
        viewportHeight: 1200,
      },
      async (context) => renderPdf(context, { snapshot, states, settings, log }),
    ),
  );

  storePdf(session, result.pdf, result.pageCount);
}
