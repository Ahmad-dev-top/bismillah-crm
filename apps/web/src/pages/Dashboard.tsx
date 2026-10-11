import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { pkr } from "../labels.ts";

interface DashboardData {
  businessDate: string;
  customers: {
    total: string;
    active: string;
    payment_due: string;
    overdue: string;
    suspended: string;
    inactive: string;
    incomplete: string;
    expiring_today: string;
    expiring_tomorrow: string;
    expiring_in_2_days: string;
  };
  billing: { outstanding: string; customers_with_dues: string };
  todayPayments: { amount: string; count: string };
  notifications: { sent: string; failed: string; skipped: string; queued: string };
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardData>("/api/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load dashboard"));
  }, []);

  if (error) {
    return <div className="p-8 text-warn">{error}</div>;
  }
  if (!data) {
    return <div className="p-8 text-slate-500">Loading dashboard…</div>;
  }

  const c = data.customers;
  const incomplete = Number(c.incomplete);
  const cards = [
    { label: "Incomplete", value: c.incomplete, to: "/customers?status=INCOMPLETE", tone: "warn" },
    { label: "Active", value: c.active, to: "/customers?status=ACTIVE", tone: "ok" },
    { label: "Payment due", value: c.payment_due, to: "/customers?status=PAYMENT_DUE", tone: "amber" },
    { label: "Overdue", value: c.overdue, to: "/customers?status=OVERDUE", tone: "rose" },
    { label: "Expiring today", value: c.expiring_today, to: "/customers?expiringInDays=0", tone: "cyan" },
    { label: "Expiring tomorrow", value: c.expiring_tomorrow, to: "/customers?expiringInDays=1", tone: "cyan" },
    { label: "Expiring in 2 days", value: c.expiring_in_2_days, to: "/customers?expiringInDays=2", tone: "navy" },
    { label: "Deactivated", value: c.inactive, to: "/customers?status=INACTIVE", tone: "navy" },
    { label: "All customers", value: c.total, to: "/customers?all=1", tone: "navy" },
  ];

  const toneValue: Record<string, string> = {
    warn: "text-warn",
    ok: "text-emerald",
    amber: "text-amber-600",
    rose: "text-rose",
    cyan: "text-sky-600",
    navy: "text-navy",
  };
  const toneBar: Record<string, string> = {
    warn: "from-warn to-amber-400",
    ok: "from-emerald to-cyan",
    amber: "from-amber-400 to-warn",
    rose: "from-rose to-orange-400",
    cyan: "from-cyan to-electric",
    navy: "from-electric to-navy",
  };

  return (
    <div className="page mx-auto max-w-6xl p-6 lg:p-8">
      <PageHeader
        kicker="Overview"
        title="Dashboard"
        subtitle={`Business date ${data.businessDate} (Asia/Karachi)`}
      />

      {incomplete > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warn/25 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p>
            <span className="font-semibold">{incomplete} customers</span> are incomplete. They cannot be billed or
            messaged until package, price, and phone are filled.
          </p>
          <Link to="/customers?status=INCOMPLETE" className="font-semibold text-electric hover:underline">
            Open list →
          </Link>
        </div>
      )}

      <div className="stagger mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="card card-hover group relative overflow-hidden rounded-2xl p-5"
          >
            <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${toneBar[card.tone]}`} />
            <p className="text-sm font-medium text-slate-500">{card.label}</p>
            <p className={`mt-2 text-4xl font-bold tracking-tight ${toneValue[card.tone]}`}>{card.value}</p>
            <p className="mt-3 text-xs font-medium text-electric opacity-0 transition group-hover:opacity-100">
              View list →
            </p>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="card rounded-2xl p-6">
          <p className="text-sm font-medium text-slate-500">Outstanding dues</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-navy">{pkr(data.billing.outstanding)}</p>
          <p className="mt-1 text-sm text-slate-500">{data.billing.customers_with_dues} customers</p>
        </div>
        <div className="card rounded-2xl p-6">
          <p className="text-sm font-medium text-slate-500">Payments today</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-emerald">{pkr(data.todayPayments.amount)}</p>
          <p className="mt-1 text-sm text-slate-500">{data.todayPayments.count} receipts</p>
        </div>
        <div className="card rounded-2xl p-6">
          <p className="text-sm font-medium text-slate-500">WhatsApp today</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-navy">
            {data.notifications.sent}
            <span className="text-lg font-semibold text-slate-400"> sent</span>
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {data.notifications.queued} queued · {data.notifications.failed} failed · {data.notifications.skipped} skipped
          </p>
        </div>
      </div>
    </div>
  );
}
