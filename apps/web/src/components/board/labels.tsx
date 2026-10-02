const LABEL_STYLES = [
  'bg-rose-100 text-rose-800',
  'bg-amber-100 text-amber-800',
  'bg-emerald-100 text-emerald-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-pink-100 text-pink-800',
  'bg-teal-100 text-teal-800',
  'bg-lime-100 text-lime-800',
];

export function labelStyle(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 33 + label.charCodeAt(i)) >>> 0;
  return LABEL_STYLES[h % LABEL_STYLES.length]!;
}

export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${labelStyle(label)}`}
    >
      {label}
      {onRemove ? (
        <button
          onClick={onRemove}
          aria-label={`Remove label ${label}`}
          className="opacity-60 hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
