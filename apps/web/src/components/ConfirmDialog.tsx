import { useEffect, useState, type ReactNode } from "react";

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  requireTyped,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  requireTyped?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const canConfirm = !requireTyped || typed.trim() === requireTyped;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="card relative z-10 w-full max-w-md rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-navy">
          {title}
        </h2>
        <div className="mt-2 text-sm text-slate-600">{body}</div>
        {requireTyped && (
          <label className="mt-4 block text-sm text-slate-700">
            Type <span className="font-mono font-semibold">{requireTyped}</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
            />
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={onConfirm}
            className={`rounded-xl px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-40 ${
              danger ? "bg-rose" : "bg-warn"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
