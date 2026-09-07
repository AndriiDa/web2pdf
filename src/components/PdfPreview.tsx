'use client';

/**
 * PDF preview pane (§13B).
 *
 * Renders the ACTUAL generated PDF with pdf.js, so what the user sees is the
 * real output rather than an HTML approximation of it. pdf.js is imported
 * dynamically because it is browser-only and would break server rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PdfPreviewProps {
  readonly sessionId: string;
  readonly revision: number;
  readonly zoom: number;
  readonly onPageCount?: (count: number) => void;
}

interface RenderState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly message?: string;
}

export function PdfPreview({
  sessionId,
  revision,
  zoom,
  onPageCount,
}: PdfPreviewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: 'idle' });
  /** Guards against a stale render finishing after a newer one started. */
  const renderToken = useRef(0);

  const render = useCallback(async () => {
    const token = ++renderToken.current;
    const container = containerRef.current;
    if (!container) return;

    setState({ status: 'loading' });

    try {
      // pdf.js ships ESM-only browser builds; importing at module scope would
      // break the server render.
      const pdfjs = await import('pdfjs-dist');

      // The worker must be served as a real URL, not bundled inline.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();

      const response = await fetch(`/api/session/${sessionId}/pdf?rev=${revision}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message =
          (payload as { error?: { message?: string } } | null)?.error?.message ??
          'The PDF could not be generated.';
        if (token === renderToken.current) setState({ status: 'error', message });
        return;
      }

      const data = await response.arrayBuffer();
      if (token !== renderToken.current) return;

      // `destroy()` lives on the loading task, not the document proxy, and is
      // what tears down the worker — so keep the task around to clean up.
      const loadingTask = pdfjs.getDocument({ data });
      const document = await loadingTask.promise;
      if (token !== renderToken.current) {
        void loadingTask.destroy();
        return;
      }

      onPageCount?.(document.numPages);
      container.replaceChildren();

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (token !== renderToken.current) return;

        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: zoom * 1.25 });

        const canvas = window.document.createElement('canvas');
        canvas.className = 'pdf-page-canvas mx-auto mb-4 block';
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const context = canvas.getContext('2d');
        if (!context) continue;

        container.appendChild(canvas);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
      }

      if (token === renderToken.current) setState({ status: 'ready' });
      void loadingTask.destroy();
    } catch (error) {
      if (token === renderToken.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? 'The PDF preview could not be displayed.' : 'Unknown error',
        });
      }
    }
  }, [onPageCount, revision, sessionId, zoom]);

  useEffect(() => {
    // Deferred to a microtask so the first setState lands after this effect
    // returns, rather than synchronously inside it (which React 19 flags as a
    // cascading render).
    const timer = setTimeout(() => {
      void render();
    }, 0);

    return () => {
      clearTimeout(timer);
      // Invalidate any in-flight render on unmount or re-run.
      renderToken.current += 1;
    };
  }, [render]);

  return (
    <div className="relative h-full overflow-auto bg-[var(--color-canvas)] p-6">
      {state.status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 text-sm text-[var(--color-muted)]">
          Rendering PDF…
        </div>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mx-auto max-w-md rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {state.message}
        </div>
      )}

      <div ref={containerRef} />
    </div>
  );
}
