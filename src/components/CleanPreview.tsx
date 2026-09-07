'use client';

/**
 * The clean-page editor pane (§12, §32, §35).
 *
 * The document is rendered in a sandboxed iframe WITHOUT `allow-scripts`, so
 * nothing from the source page can execute. `allow-same-origin` is present so
 * this parent can reach `contentDocument` and attach hover/click handling —
 * that combination is safe precisely because scripts are disabled inside.
 *
 * The parent owns all interactivity; the frame is inert markup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const ID_ATTRIBUTE = 'data-w2p-id';

export interface SelectionInfo {
  readonly id: string;
  readonly label: string;
  /** Position for the floating action menu, in parent coordinates. */
  readonly x: number;
  readonly y: number;
}

export interface CleanPreviewProps {
  readonly sessionId: string;
  readonly revision: number;
  readonly zoom: number;
  readonly onSelect: (selection: SelectionInfo | null) => void;
  readonly selectedId: string | null;
}

export function CleanPreview({
  sessionId,
  revision,
  zoom,
  onSelect,
  selectedId,
}: CleanPreviewProps): React.ReactElement {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);

  // `revision` in the URL forces a reload whenever the document changes.
  const src = `/api/session/${sessionId}/preview?rev=${revision}`;

  /**
   * Attaches editor behaviour to the frame document.
   *
   * Uses capture-phase listeners so a click reaches us before any anchor
   * default action, and blocks navigation: clicking a link must select the
   * element, not navigate the preview away.
   */
  const attachHandlers = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc) return;

    const findTarget = (node: EventTarget | null): HTMLElement | null => {
      let current = node as HTMLElement | null;
      while (current && current.nodeType === 1) {
        if (current.hasAttribute?.(ID_ATTRIBUTE)) return current;
        current = current.parentElement;
      }
      return null;
    };

    const handleClick = (event: MouseEvent): void => {
      // Never let the untrusted document navigate or submit anything.
      event.preventDefault();
      event.stopPropagation();

      const target = findTarget(event.target);
      if (!target) {
        onSelect(null);
        return;
      }

      const id = target.getAttribute(ID_ATTRIBUTE);
      if (id === null) return;

      // Translate frame coordinates into parent coordinates for the menu.
      const rect = target.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;

      onSelect({
        id,
        label: describeElement(target),
        x: (frameRect?.left ?? 0) + rect.left * zoom + 8,
        y: (frameRect?.top ?? 0) + (rect.top - scrollTop) * zoom + rect.height * zoom + 6,
      });
    };

    // Capture phase: intercepts before the document's own default behaviour.
    doc.addEventListener('click', handleClick, true);
    // Belt and braces — the sandbox already forbids navigation.
    doc.addEventListener('submit', (event) => event.preventDefault(), true);

    return () => {
      doc.removeEventListener('click', handleClick, true);
    };
  }, [onSelect, zoom]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let detach: (() => void) | undefined;
    const handleLoad = (): void => {
      setLoading(false);
      detach = attachHandlers();
    };

    frame.addEventListener('load', handleLoad);
    return () => {
      frame.removeEventListener('load', handleLoad);
      detach?.();
    };
  }, [attachHandlers, src]);

  // Reflect the current selection inside the frame without re-fetching it.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;

    for (const previous of Array.from(doc.querySelectorAll('[data-w2p-selected]'))) {
      previous.removeAttribute('data-w2p-selected');
    }
    if (selectedId !== null) {
      doc.querySelector(`[${ID_ATTRIBUTE}="${cssEscape(selectedId)}"]`)?.setAttribute(
        'data-w2p-selected',
        '1',
      );
    }
  }, [selectedId, revision, loading]);

  return (
    <div className="relative h-full overflow-auto bg-[var(--color-canvas)]">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 text-sm text-[var(--color-muted)]">
          Loading document…
        </div>
      )}
      <div
        className="mx-auto my-6 bg-white shadow-sm"
        style={{
          width: `${794 * zoom}px`,
          transition: 'width 120ms ease',
        }}
      >
        <iframe
          ref={frameRef}
          src={src}
          title="Cleaned web page"
          /*
           * No `allow-scripts`: source-page JavaScript can never execute.
           * `allow-same-origin` lets this parent attach editor handlers, which
           * is only safe because scripting is disabled.
           */
          sandbox="allow-same-origin"
          className="block w-full border-0"
          style={{
            height: '1400px',
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            width: `${100 / zoom}%`,
          }}
        />
      </div>
    </div>
  );
}

/** Builds a short human description of an element for the action menu. */
function describeElement(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ');

  if (tag === 'img') return 'Image';
  if (tag === 'figure') return 'Figure';
  if (tag === 'table') return 'Table';
  if (tag === 'pre') return 'Code block';
  if (/^h[1-6]$/.test(tag)) return `Heading: ${truncate(text, 40)}`;
  if (text.length > 0) return truncate(text, 48);
  return `<${tag}>`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Minimal attribute-selector escaping; ids are internally generated. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
