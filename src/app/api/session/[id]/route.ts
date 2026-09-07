/**
 * GET /api/session/:id — current session state (element tree and metadata).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/core/session-manager/store';
import { toAppError, toPublicBody } from '@/lib/errors';
import { sessionSummary } from './summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const session = getSession(id);
    return NextResponse.json(sessionSummary(session));
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
