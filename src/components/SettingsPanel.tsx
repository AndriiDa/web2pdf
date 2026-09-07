'use client';

/**
 * PDF settings (§25). Deliberately small: paper and orientation are fixed for
 * the MVP, so the only real choices are margins and what appears in the
 * header/footer.
 */

import type { MarginPreset, PdfSettings } from '@/core/types';

export interface SettingsPanelProps {
  readonly settings: PdfSettings;
  readonly onChange: (patch: Partial<PdfSettings>) => void;
  readonly onClose: () => void;
}

const MARGIN_OPTIONS: ReadonlyArray<{ value: MarginPreset; label: string; hint: string }> = [
  { value: 'narrow', label: 'Narrow', hint: '10 mm' },
  { value: 'normal', label: 'Normal', hint: '17.5 mm' },
  { value: 'wide', label: 'Wide', hint: '25 mm' },
];

export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: SettingsPanelProps): React.ReactElement {
  return (
    <div className="absolute right-4 top-14 z-30 w-72 rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">PDF settings</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="rounded px-1.5 py-0.5 text-sm text-[var(--color-muted)] hover:bg-gray-100"
        >
          ✕
        </button>
      </div>

      <dl className="mb-4 space-y-1 text-xs text-[var(--color-muted)]">
        <div className="flex justify-between">
          <dt>Paper</dt>
          <dd className="font-medium text-[var(--color-ink)]">A4 (210 × 297 mm)</dd>
        </div>
        <div className="flex justify-between">
          <dt>Orientation</dt>
          <dd className="font-medium text-[var(--color-ink)]">Portrait</dd>
        </div>
      </dl>

      <fieldset className="mb-4">
        <legend className="mb-2 text-xs font-medium text-[var(--color-ink)]">Margins</legend>
        <div className="grid grid-cols-3 gap-1.5">
          {MARGIN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange({ margins: option.value })}
              className={[
                'rounded border px-2 py-1.5 text-xs transition',
                settings.margins === option.value
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'border-[var(--color-line)] text-[var(--color-muted)] hover:bg-gray-50',
              ].join(' ')}
            >
              <span className="block">{option.label}</span>
              <span className="block text-[10px] opacity-70">{option.hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium text-[var(--color-ink)]">
          Header and footer
        </legend>

        <Toggle
          label="Page numbers"
          checked={settings.pageNumbers}
          onChange={(checked) => onChange({ pageNumbers: checked })}
        />
        <Toggle
          label="Source URL"
          checked={settings.showSourceUrl}
          onChange={(checked) => onChange({ showSourceUrl: checked })}
        />
        <Toggle
          label="Generation date"
          checked={settings.showDate}
          onChange={(checked) => onChange({ showDate: checked })}
        />
      </fieldset>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-xs font-medium">Document title</span>
        <input
          type="text"
          value={settings.documentTitle}
          onChange={(event) => onChange({ documentTitle: event.target.value })}
          className="w-full rounded border border-[var(--color-line)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
        Changes apply when you regenerate the PDF.
      </p>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <label className="flex cursor-pointer items-center justify-between text-xs">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
      />
    </label>
  );
}
