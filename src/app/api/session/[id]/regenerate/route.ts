/**
 * POST /api/session/:id/regenerate — re-renders the PDF from the snapshot.
 *
 * This is the operation that makes the snapshot architecture pay off: no
 * network access to the origin site, no live browser held open between edits.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/core/session-manager/store';
import { regenerateSession } from '@/core/convert-service';
import { toAppError, toPublicBody } from '@/lib/errors';
import { sessionSummary } from '../summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const session = getSession(id);
    await regenerateSession(session);
    return NextResponse.json(sessionSummary(session));
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
