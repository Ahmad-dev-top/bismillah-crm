import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { formatDate, missingLabel, pkr } from "../labels.ts";
import { useAuth } from "../auth.tsx";

interface CustomerRow {
  id: string;
  customer_code: string;
  full_name: string;
  primary_phone: string | null;
  status: string;
  current_expiry_date: string | null;
  missing_fields: string[];
  area_name: string | null;
  package_name: string | null;
  monthly_price: string | null;
  amount_due: string;
}

const STATUSES = ["", "INCOMPLETE", "ACTIVE", "PAYMENT_DUE", "OVERDUE", "SUSPENDED", "INACTIVE"];
const PAGE = 50;

const EXPIRING_LABEL: Record<string, string> = {
  "0": "Expiring today",
  "1": "Expiring tomorrow",
  "2": "Expiring in 2 days",
};

export function Customers() {
  const { has } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const expiringInDays = params.get("expiringInDays");
  const hasExpiring = expiringInDays !== null && expiringInDays !== "";
  const all = params.get("all") === "1";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const offset = Number(params.get("offset") ?? 0);

  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(q);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CustomerRow | null>(null);
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);

  useEffect(() => {
    setSearch(q);
  }, [q]);

  useEffect(() => {
    const query = new URLSearchParams();
    query.set("limit", String(PAGE));
    query.set("offset", String(offset));
    if (status) query.set("status", status);
    if (q) query.set("q", q);
    if (hasExpiring) query.set("expiringInDays", expiringInDays);

    setLoading(true);
    setError(null);
    api<{ rows: CustomerRow[]; total: number }>(`/api/customers?${query}`)
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load customers"))
      .finally(() => setLoading(false));
  }, [status, q, offset, hasExpiring, expiringInDays, reload]);

  function setFilter(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!("offset" in next)) merged.delete("offset");
    setParams(merged);
  }

  const expiringLabel = hasExpiring ? (EXPIRING_LABEL[expiringInDays] ?? `Expiring in ${expiringInDays} days`) : null;
  const canDelete = has("customer:delete");
  const canWrite = has("customer:write");

  async function purgeOne() {
    if (!pendingDelete) return;
    const row = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/customers/${row.id}/purge`, {
        method: "POST",
        body: { confirm: "DELETE" },
      });
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete customer");
    } finally {
      setBusy(false);
    }
  }

  async function purgeAll() {
    setConfirmPurgeAll(false);
    setBusy(true);
    setError(null);
    try {
      await api("/api/customers/purge-all", {
        method: "POST",
        body: { confirm: "DELETE ALL CUSTOMERS" },
      });
      setRows([]);
      setTotal(0);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete customers");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page mx-auto max-w-6xl p-6 lg:p-8">
      <PageHeader
        kicker="Directory"
        title={status === "INACTIVE" ? "Deactivated customers" : "Customers"}
        subtitle={
          status === "INACTIVE"
            ? "Deactivated customers stay here until you activate them again. Delete removes them completely."
            : "Live customers, first account at the top. Incomplete records stay flagged until you fill package, price, and phone. Deactivated customers are under Deactivated."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/customers?status=INACTIVE"
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm ${
                status === "INACTIVE"
                  ? "bg-navy text-white"
                  : "border border-slate-200 bg-white text-slate-700"
              }`}
            >
              Deactivated
            </Link>
            {canDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmPurgeAll(true)}
                className="rounded-xl border border-rose/30 bg-white px-4 py-2.5 text-sm font-semibold text-rose shadow-sm disabled:opacity-40"
              >
                Delete all
              </button>
            )}
            {canWrite && (
              <Link to="/customers/new" className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white">
                Add customer
              </Link>
            )}
          </div>
        }
      />

      <form
        className="card mt-8 flex flex-wrap gap-3 rounded-2xl p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(all || hasExpiring ? { q: search.trim(), all: all ? "1" : "", status } : { q: search.trim(), status });
        }}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, code, phone…"
          className="input-field min-w-56 flex-1 rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
        />
        <select
          value={status}
          onChange={(e) => {
            if (!e.target.value) setFilter({ all: hasExpiring ? "" : "1", status: "" });
            else setFilter({ status: e.target.value, all: "" });
          }}
          className="input-field rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
        >
          <option value="">All live customers</option>
          {STATUSES.filter(Boolean).map((s) => (
            <option key={s} value={s}>
              {s === "INACTIVE" ? "Deactivated" : s.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-xl bg-navy px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110">
          Search
        </button>
      </form>

      {(hasExpiring || q || (status && status !== "INCOMPLETE") || all) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          {status && (
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
              Status: {status === "INACTIVE" ? "Deactivated" : status.replaceAll("_", " ")}
            </span>
          )}
          {all && !status && <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">All live customers</span>}
          {expiringLabel && (
            <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-800 ring-1 ring-sky-200">{expiringLabel}</span>
          )}
          {q && <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">Search: {q}</span>}
          <button
            type="button"
            onClick={() => setParams(new URLSearchParams())}
            className="font-medium text-electric hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {error && <p className="mt-6 text-warn">{error}</p>}
      {loading && rows === null && <p className="mt-6 text-slate-500">Loading customers…</p>}
      {!error && rows && rows.length === 0 && !loading && (
        <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-10 text-center text-slate-500">
          No customers match these filters.
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <p className="mt-6 text-sm text-slate-500">
            {loading ? "Updating…" : `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
          </p>
          <div className={`table-wrap mt-2 overflow-x-auto rounded-2xl ${loading ? "opacity-60" : ""}`}>
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/95 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Package</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3">Missing</th>
                  {canDelete && <th className="px-4 py-3 text-right"> </th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-b border-slate-100 last:border-0"
                    onClick={() => nav(`/customers/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") nav(`/customers/${r.id}`);
                    }}
                    tabIndex={0}
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link
                        to={`/customers/${r.id}`}
                        className="text-electric hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.customer_code}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-navy">{r.full_name}</div>
                      <div className="text-xs text-slate-500">{r.primary_phone ?? "No phone"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">{r.package_name ?? "—"}</td>
                    <td className="px-4 py-3">{r.area_name ?? "—"}</td>
                    <td className="px-4 py-3">{formatDate(r.current_expiry_date)}</td>
                    <td className="px-4 py-3">{pkr(r.amount_due)}</td>
                    <td className="px-4 py-3 text-xs text-warn">
                      {(r.missing_fields ?? []).map(missingLabel).join(", ") || "—"}
                    </td>
                    {canDelete && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(r);
                          }}
                          className="text-sm font-medium text-rose hover:underline disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {total > PAGE && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setFilter({ offset: String(Math.max(0, offset - PAGE)) })}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={offset + PAGE >= total}
              onClick={() => setFilter({ offset: String(offset + PAGE) })}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.full_name}?`}
          body={`${pendingDelete.customer_code} will be removed permanently, including invoices, payments, and WhatsApp history. Deactivate instead if you only want them off the live list.`}
          confirmLabel="Delete permanently"
          requireTyped={pendingDelete.customer_code}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void purgeOne()}
        />
      )}
      {confirmPurgeAll && (
        <ConfirmDialog
          title="Delete every customer?"
          body="This removes every customer in the CRM, not just the current list. Invoices, payments, and WhatsApp records go with them. Packages and areas stay. This cannot be undone."
          confirmLabel="Delete all customers"
          requireTyped="DELETE ALL CUSTOMERS"
          danger
          onCancel={() => setConfirmPurgeAll(false)}
          onConfirm={() => void purgeAll()}
        />
      )}
    </div>
  );
}
