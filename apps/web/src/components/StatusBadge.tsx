const TONE: Record<string, string> = {
  INCOMPLETE: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  ACTIVE: "bg-emerald/10 text-emerald ring-1 ring-emerald/20",
  PAYMENT_DUE: "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
  OVERDUE: "bg-rose/10 text-rose ring-1 ring-rose/20",
  SUSPENDED: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  INACTIVE: "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
};

const LABEL: Record<string, string> = {
  INACTIVE: "Deactivated",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[status] ?? "bg-slate-200 text-slate-700"}`}
    >
      {LABEL[status] ?? status.replaceAll("_", " ")}
    </span>
  );
}
