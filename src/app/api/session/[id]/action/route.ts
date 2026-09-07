/**
 * POST /api/session/:id/action — applies an editing action (§34).
 *
 * Accepts small command payloads (remove/hide/restore/undo/redo/settings)
 * rather than whole documents. The PDF is invalidated but NOT re-rendered here:
 * the client batches edits and calls /regenerate when it wants new output, so a
 * burst of clicks does not launch a browser per click.
 */

import { NextResponse } from 'next/server';
import { getSession, invalidatePdf } from '@/core/session-manager/store';
import { isValidAction, pushAction, redo, undo } from '@/core/session-manager/actions';
import { AppError, toAppError, toPublicBody } from '@/lib/errors';
import { asElementId, type Action } from '@/core/types';
import { sessionSummary } from '../summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RequestBody {
  readonly action?: unknown;
  readonly command?: unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const session = getSession(id);

    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      throw new AppError('INVALID_ACTION', 'malformed JSON body');
    }

    // Undo/redo move the cursor; they are not appended to the log.
    if (body.command === 'undo') {
      session.log = undo(session.log);
    } else if (body.command === 'redo') {
      session.log = redo(session.log);
    } else {
      if (!isValidAction(body.action)) {
        throw new AppError('INVALID_ACTION', 'unrecognized action payload');
      }

      const incoming = body.action;
      // Re-brand ids after validation so downstream code sees ElementIds.
      const action: Action =
        incoming.t === 'remove' || incoming.t === 'hide' || incoming.t === 'restore'
          ? { t: incoming.t, ids: incoming.ids.map((value) => asElementId(String(value))) }
          : incoming;

      session.log = pushAction(session.log, action);
    }

    // The cached PDF no longer matches the document.
    invalidatePdf(session);

    return NextResponse.json(sessionSummary(session));
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
