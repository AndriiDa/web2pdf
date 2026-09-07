'use client';

/**
 * The editor workspace (§4, §13).
 *
 * Desktop: cleaned page on the left, real PDF on the right.
 * Mobile: the same two views as tabs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CleanPreview, type SelectionInfo } from '@/components/CleanPreview';
import { PdfPreview } from '@/components/PdfPreview';
import { SettingsPanel } from '@/components/SettingsPanel';
import type { PdfSettings } from '@/core/types';

interface ElementView {
  readonly id: string;
  readonly label: string;
  readonly state: 'visible' | 'hidden' | 'removed';
  readonly protected?: boolean;
  readonly contested?: boolean;
}

interface SessionState {
  readonly sessionId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly elements: readonly ElementView[];
  readonly settings: PdfSettings;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly pageCount: number;
  readonly stats: {
    readonly adsRemoved: number;
    readonly popupsRemoved: number;
    readonly contestedCount: number;
  };
  readonly revision: number;
}

type Tab = 'clean' | 'pdf';

export default function EditorPage(): React.ReactElement {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sessionId = params.sessionId;

  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [zoom, setZoom] = useState(0.85);
  const [tab, setTab] = useState<Tab>('clean');
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped only when the PDF should be re-fetched, so edits do not thrash it. */
  const [pdfRevision, setPdfRevision] = useState(0);
  const [dirty, setDirty] = useState(false);

  // --- Loading -------------------------------------------------------------
  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/session/${sessionId}`, { cache: 'no-store' });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        setError(
          (payload as { error?: { message?: string } } | null)?.error?.message ??
            'This session could not be loaded.',
        );
        return;
      }
      const data = (await response.json()) as SessionState;
      setSession(data);
      setPdfRevision((current) => (current === 0 ? data.revision + 1 : current));
    } catch {
      setError('Unable to reach the server.');
    }
  }, [sessionId]);

  useEffect(() => {
    // Deferred to a macrotask so the fetch's setState lands after this effect
    // returns rather than synchronously within it (React 19 cascading renders).
    const timer = setTimeout(() => {
      void loadSession();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadSession]);

  // --- Actions -------------------------------------------------------------
  const sendAction = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/session/${sessionId}/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          setError(
            (payload as { error?: { message?: string } } | null)?.error?.message ??
              'That change could not be applied.',
          );
          return;
        }

        const data = (await response.json()) as SessionState;
        setSession(data);
        setSelection(null);
        setDirty(true);
      } catch {
        setError('Unable to reach the server.');
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const regenerate = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/session/${sessionId}/regenerate`, { method: 'POST' });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        setError(
          (payload as { error?: { message?: string } } | null)?.error?.message ??
            'The PDF could not be regenerated.',
        );
        return;
      }
      const data = (await response.json()) as SessionState;
      setSession(data);
      setPdfRevision((current) => current + 1);
      setDirty(false);
    } catch {
      setError('Unable to reach the server.');
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const updateSettings = useCallback(
    (patch: Partial<PdfSettings>) => {
      void sendAction({ action: { t: 'settings', patch } });
    },
    [sendAction],
  );

  // Keyboard shortcuts for the operations people expect in an editor.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;

      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        void sendAction({ command: 'undo' });
      } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
        event.preventDefault();
        void sendAction({ command: 'redo' });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sendAction]);

  const visibleCount = useMemo(
    () => session?.elements.filter((element) => element.state === 'visible').length ?? 0,
    [session],
  );

  if (error !== null && session === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
        <h1 className="mb-2 text-lg font-semibold">Session unavailable</h1>
        <p className="mb-6 text-sm text-[var(--color-muted)]">{error}</p>
        <button
          type="button"
          onClick={() => router.push('/')}
          className="mx-auto rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Start over
        </button>
      </main>
    );
  }

  if (session === null) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[var(--color-muted)]">
        Loading session…
      </main>
    );
  }

  const selected = selection
    ? session.elements.find((element) => element.id === selection.id)
    : undefined;

  return (
    <div className="flex h-screen flex-col">
      {/* ---- Toolbar ---- */}
      <header className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-white px-3 py-2">
        <button
          type="button"
          onClick={() => router.push('/')}
          className="rounded px-2 py-1.5 text-sm text-[var(--color-muted)] hover:bg-gray-100"
          title="Convert a different page"
        >
          ← New
        </button>

        <div className="mx-1 h-5 w-px bg-[var(--color-line)]" />

        <ToolbarButton
          label="Undo"
          disabled={!session.canUndo || busy}
          onClick={() => void sendAction({ command: 'undo' })}
        />
        <ToolbarButton
          label="Redo"
          disabled={!session.canRedo || busy}
          onClick={() => void sendAction({ command: 'redo' })}
        />
        <ToolbarButton
          label="Restore all"
          disabled={busy}
          onClick={() => void sendAction({ action: { t: 'restoreAll' } })}
        />

        <div className="mx-1 h-5 w-px bg-[var(--color-line)]" />

        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={busy}
          className={[
            'rounded px-3 py-1.5 text-sm font-medium transition',
            dirty
              ? 'bg-[var(--color-accent)] text-white hover:bg-blue-700'
              : 'border border-[var(--color-line)] text-[var(--color-muted)] hover:bg-gray-50',
            busy ? 'cursor-not-allowed opacity-60' : '',
          ].join(' ')}
        >
          {busy ? 'Working…' : dirty ? 'Regenerate PDF' : 'Regenerate'}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-1 sm:flex">
            <ToolbarButton label="−" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))} />
            <span className="w-11 text-center text-xs tabular-nums text-[var(--color-muted)]">
              {Math.round(zoom * 100)}%
            </span>
            <ToolbarButton label="+" title="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))} />
          </div>

          <span className="hidden rounded bg-gray-100 px-2 py-1 text-xs text-[var(--color-muted)] md:inline">
            A4 · {session.pageCount || '—'} {session.pageCount === 1 ? 'page' : 'pages'}
          </span>

          <ToolbarButton label="Settings" onClick={() => setShowSettings((value) => !value)} />

          <a
            href={`/api/session/${sessionId}/pdf?download=1&rev=${pdfRevision}`}
            className="rounded bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-white hover:bg-black"
          >
            Download PDF
          </a>
        </div>

        {showSettings && (
          <SettingsPanel
            settings={session.settings}
            onChange={updateSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
      </header>

      {/* ---- Status strip ---- */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-line)] bg-white/60 px-3 py-1.5 text-xs text-[var(--color-muted)]">
        <span className="truncate font-medium text-[var(--color-ink)]">{session.title}</span>
        <span>{session.stats.adsRemoved} ads removed</span>
        <span>{session.stats.popupsRemoved} popups removed</span>
        <span>{visibleCount} elements</span>
        {session.stats.contestedCount > 0 && (
          <span className="text-[var(--color-warn)]">
            {session.stats.contestedCount} kept for review
          </span>
        )}
        {dirty && <span className="text-[var(--color-accent)]">Edits pending — regenerate to update the PDF</span>}
      </div>

      {/* ---- Mobile tabs ---- */}
      <div className="flex shrink-0 border-b border-[var(--color-line)] bg-white lg:hidden">
        <TabButton active={tab === 'clean'} onClick={() => setTab('clean')}>
          Clean page
        </TabButton>
        <TabButton active={tab === 'pdf'} onClick={() => setTab('pdf')}>
          PDF preview
        </TabButton>
      </div>

      {/* ---- Panes ---- */}
      <div className="relative flex min-h-0 flex-1">
        <section
          className={[
            'min-h-0 flex-1 border-r border-[var(--color-line)]',
            tab === 'clean' ? 'block' : 'hidden',
            'lg:block lg:w-1/2',
          ].join(' ')}
          aria-label="Cleaned web page editor"
        >
          <CleanPreview
            sessionId={sessionId}
            revision={session.revision}
            zoom={zoom}
            onSelect={setSelection}
            selectedId={selection?.id ?? null}
          />
        </section>

        <section
          className={[
            'min-h-0 flex-1',
            tab === 'pdf' ? 'block' : 'hidden',
            'lg:block lg:w-1/2',
          ].join(' ')}
          aria-label="PDF preview"
        >
          <PdfPreview sessionId={sessionId} revision={pdfRevision} zoom={zoom} />
        </section>

        {/* ---- Floating selection menu (§12, §35) ---- */}
        {selection && (
          <div
            className="fixed z-40 rounded-lg border border-[var(--color-line)] bg-white p-1 shadow-lg"
            style={{ left: `${selection.x}px`, top: `${selection.y}px` }}
            role="menu"
          >
            <div className="max-w-[220px] truncate border-b border-[var(--color-line)] px-2 py-1 text-[11px] text-[var(--color-muted)]">
              {selection.label}
            </div>
            {selected?.protected && (
              <div className="px-2 py-1 text-[11px] text-[var(--color-warn)]">
                Looks like main content
              </div>
            )}
            <div className="flex gap-0.5 p-0.5">
              <MenuButton
                onClick={() => void sendAction({ action: { t: 'remove', ids: [selection.id] } })}
              >
                Remove
              </MenuButton>
              <MenuButton
                onClick={() => void sendAction({ action: { t: 'hide', ids: [selection.id] } })}
              >
                Hide
              </MenuButton>
              <MenuButton
                onClick={() => void sendAction({ action: { t: 'restore', ids: [selection.id] } })}
              >
                Restore
              </MenuButton>
              <MenuButton onClick={() => setSelection(null)}>Cancel</MenuButton>
            </div>
          </div>
        )}
      </div>

      {error !== null && (
        <div
          role="alert"
          className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 underline"
            aria-label="Dismiss error"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className="rounded px-2.5 py-1.5 text-sm text-[var(--color-ink)] transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
}

function MenuButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className="rounded px-2 py-1 text-xs text-[var(--color-ink)] transition hover:bg-[var(--color-accent-soft)]"
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-1 px-4 py-2 text-sm transition',
        active
          ? 'border-b-2 border-[var(--color-accent)] font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-muted)]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
