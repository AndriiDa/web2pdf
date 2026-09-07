'use client';

/**
 * The URL entry screen (§4).
 *
 * Deliberately minimal: one field, one button. Conversion is slow enough that
 * progress must be visible (§36), so the staged progress list runs while the
 * request is in flight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressStages, type StageKey } from '@/components/ProgressStages';

/** Ordered stages shown while a conversion runs. */
const STAGES: ReadonlyArray<{ key: StageKey; label: string; approxMs: number }> = [
  { key: 'validating', label: 'Checking the address', approxMs: 600 },
  { key: 'loading', label: 'Loading the website', approxMs: 4000 },
  { key: 'rendering', label: 'Rendering content', approxMs: 3000 },
  { key: 'loading-images', label: 'Loading images', approxMs: 3500 },
  { key: 'cleaning', label: 'Removing ads and popups', approxMs: 1500 },
  { key: 'print-layout', label: 'Preparing the print layout', approxMs: 1200 },
  { key: 'generating-pdf', label: 'Generating the PDF', approxMs: 2500 },
];

export default function HomePage(): React.ReactElement {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const timers = useRef<NodeJS.Timeout[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  /**
   * Advances the stage display on a schedule.
   *
   * The server does the work in one request, so these are estimates rather than
   * live events — but they are honest about ordering, and the final stage only
   * completes when the response actually arrives.
   */
  const startStageTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    setStageIndex(0);

    let elapsed = 0;
    STAGES.forEach((stage, index) => {
      if (index === 0) return;
      elapsed += STAGES[index - 1]?.approxMs ?? 1000;
      timers.current.push(
        setTimeout(() => {
          // Never let the estimate run past the last stage.
          setStageIndex((current) => Math.max(current, Math.min(index, STAGES.length - 1)));
        }, elapsed),
      );
    });
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;

      const trimmed = url.trim();
      if (trimmed === '') {
        setError('Please enter a web address.');
        return;
      }

      setError(null);
      setBusy(true);
      startStageTimers();

      try {
        const response = await fetch('/api/convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        });

        const payload: unknown = await response.json();

        if (!response.ok) {
          const message =
            (payload as { error?: { message?: string } } | null)?.error?.message ??
            'Something went wrong. Please try again.';
          setError(message);
          return;
        }

        const sessionId = (payload as { sessionId?: string }).sessionId;
        if (typeof sessionId !== 'string') {
          setError('Something went wrong. Please try again.');
          return;
        }

        router.push(`/editor/${sessionId}`);
      } catch {
        setError('Unable to reach the conversion service. Please try again.');
      } finally {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current = [];
        setBusy(false);
      }
    },
    [busy, router, startStageTimers, url],
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)]">
          Web page to clean A4 PDF
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-muted)]">
          Paste a link. We load the page in a real browser, strip the ads, popups and floating
          clutter, then lay the result out as a properly paginated A4 document you can edit before
          downloading.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="url" className="mb-2 block text-sm font-medium">
            Web address
          </label>
          <input
            id="url"
            name="url"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-[var(--color-line)] bg-white px-4 py-3 text-[15px] shadow-sm outline-none transition placeholder:text-gray-400 focus:border-[var(--color-accent)] disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-3 text-[15px] font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {busy ? 'Converting…' : 'Create PDF'}
        </button>
      </form>

      {error !== null && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {busy && (
        <div className="mt-8 rounded-lg border border-[var(--color-line)] bg-white p-5 shadow-sm">
          <ProgressStages stages={STAGES} activeIndex={stageIndex} />
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            Complex pages can take up to a minute. The browser is scrolling the page to trigger
            lazy-loaded content.
          </p>
        </div>
      )}

      <p className="mt-10 text-xs leading-relaxed text-[var(--color-muted)]">
        Only public http and https addresses can be converted. Nothing is stored: your session
        exists only while you are working, and no document history is kept.
      </p>
    </main>
  );
}
