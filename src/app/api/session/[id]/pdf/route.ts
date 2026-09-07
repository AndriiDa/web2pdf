/**
 * GET /api/session/:id/pdf — serves the current PDF.
 *
 * The body is STREAMED rather than returned as a buffered JSON payload. That
 * matters on Vercel, where a buffered response is capped at 4.5 MB but a
 * streamed one is not, and it lets the browser start rendering the first page
 * before the whole file has arrived.
 *
 * `?download=1` switches from inline preview to a save dialog.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/core/session-manager/store';
import { regenerateSession } from '@/core/convert-service';
import { toAppError, toPublicBody } from '@/lib/errors';
import { contentDispositionFor } from '@/lib/content-disposition';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const session = getSession(id);

    // Render on demand when edits have invalidated the cached PDF.
    if (session.cachedPdf === null) {
      await regenerateSession(session);
    }

    const pdf = session.cachedPdf;
    if (pdf === null) {
      throw new Error('pdf unavailable after regeneration');
    }

    const download = new URL(request.url).searchParams.get('download') === '1';
    const disposition = download ? contentDispositionFor(session.title) : 'inline';

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(pdf));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(pdf.length),
        'content-disposition': disposition,
        // The document changes as the user edits; never let a proxy cache it.
        'cache-control': 'no-store, must-revalidate',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(toPublicBody(appError), { status: appError.httpStatus });
  }
}
