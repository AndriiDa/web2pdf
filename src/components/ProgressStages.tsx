'use client';

/**
 * Staged progress display (§36).
 *
 * Shows which phase of the conversion is running so a long request never looks
 * like a frozen screen.
 */

export type StageKey =
  | 'validating'
  | 'loading'
  | 'rendering'
  | 'loading-images'
  | 'cleaning'
  | 'print-layout'
  | 'generating-pdf';

export interface StageDefinition {
  readonly key: StageKey;
  readonly label: string;
}

export interface ProgressStagesProps {
  readonly stages: ReadonlyArray<StageDefinition>;
  readonly activeIndex: number;
}

export function ProgressStages({ stages, activeIndex }: ProgressStagesProps): React.ReactElement {
  return (
    <ol className="space-y-2.5" aria-live="polite">
      {stages.map((stage, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;

        return (
          <li key={stage.key} className="flex items-center gap-3 text-sm">
            <span
              aria-hidden="true"
              className={[
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]',
                done
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                  : active
                    ? 'stage-active border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'border-[var(--color-line)] bg-white text-gray-300',
              ].join(' ')}
            >
              {done ? '✓' : index + 1}
            </span>
            <span
              className={
                done
                  ? 'text-[var(--color-muted)]'
                  : active
                    ? 'font-medium text-[var(--color-ink)]'
                    : 'text-gray-400'
              }
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
