import type { ReactNode } from "react";
import { usePageTitle } from "../usePageTitle.ts";

export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
}: {
  kicker?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  usePageTitle(title);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-electric">{kicker}</p>
        )}
        <h1 className="page-title mt-1 text-3xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
