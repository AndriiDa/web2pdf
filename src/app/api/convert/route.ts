/**
 * POST /api/convert — converts a URL into an editing session.
 *
 * Runs on the Node.js runtime (Chromium cannot run on the Edge runtime) with a
 * generous maxDuration, since a heavy page can legitimately take a minute to
 * load, clean and render.
 */

import { NextResponse } from 'next/server';
import { convertUrl } from '@/core/convert-service';
import { toAppError, toPublicBody } from '@/lib/errors';
import { sessionSummary } from '../session/[id]/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel: 300s is the default maximum on every plan with fluid compute.
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  let url: unknown;
  try {
    const body: unknown = await request.json();
    url = (body as { url?: unknown } | null)?.url;
  } catch {
    const error = toAppError(new Error('invalid JSON body'));
    return NextResponse.json(toPublicBody(error), { status: 400 });
  }

  if (typeof url !== 'string' || url.trim() === '') {
    return NextResponse.json(
      { error: { code: 'INVALID_URL', message: 'Please enter a web address.' } },
      { status: 400 },
    );
  }

  try {
    const { session } = await convertUrl(url);
    return NextResponse.json({ status: 'ready', ...sessionSummary(session) });
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
