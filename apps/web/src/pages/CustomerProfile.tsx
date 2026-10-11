import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { EXPIRY_NOTICE_TIME, formatDate, missingLabel, PAYMENT_METHODS, pkr, todayInKarachi } from "../labels.ts";
import { useAuth } from "../auth.tsx";
import { usePageTitle } from "../usePageTitle.ts";

interface Profile {
  customer: Record<string, unknown> & {
    id: string;
    customer_code: string;
    full_name: string;
    status: string;
    missing_fields: string[];
    primary_phone: string | null;
    area_name: string | null;
    package_name: string | null;
    monthly_price: string | null;
    current_expiry_date: string | null;
    billing_anchor_day: number | null;
    address: string | null;
    cnic: string | null;
    notes: string | null;
    connection_type: string | null;
    ip_address: string | null;
    mac_address: string | null;
    legacy_username: string | null;
    legacy_group: string | null;
  };
  whatsapp: { msisdn: string; state: string; is_primary: boolean }[];
  invoices: { id: string; invoice_no: string; period_end: string; total: string; amount_paid: string; status: string }[];
  payments: { id: string; receipt_no: string; amount: string; paid_on: string; method: string }[];
  notifications: { id: string; notification_type: string; status: string; scheduled_for: string; skip_reason: string | null }[];
  notes: { id: number; body: string; created_at: string }[];
  timeline: { action: string; created_at: string }[];
}

export function CustomerProfile() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { has } = useAuth();
  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmPay, setConfirmPay] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payOk, setPayOk] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [paidOn, setPaidOn] = useState(todayInKarachi);
  const [reference, setReference] = useState("");
  const [invoiceId, setInvoiceId] = useState("");

  usePageTitle(data?.customer.full_name ?? "Customer");

  function load() {
    if (!id) return;
    api<Profile>(`/api/customers/${id}`)
      .then((profile) => {
        setData(profile);
        const due = openDue(profile.invoices);
        setAmount((current) => (current.trim() === "" ? (due > 0 ? String(due) : "") : current));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load customer"));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function deactivate() {
    if (!id) return;
    try {
      await api(`/api/customers/${id}`, { method: "DELETE" });
      setConfirmDeactivate(false);
      load();
    } catch (e) {
      setConfirmDeactivate(false);
      setError(e instanceof ApiError ? e.message : "Could not deactivate customer");
    }
  }

  async function activate() {
    if (!id) return;
    try {
      await api(`/api/customers/${id}/restore`, { method: "POST" });
      nav("/customers");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not activate customer");
    }
  }

  async function purge() {
    if (!id) return;
    setConfirmPurge(false);
    setPurgeBusy(true);
    setError(null);
    try {
      await api(`/api/customers/${id}/purge`, { method: "POST", body: { confirm: "DELETE" } });
      nav("/customers");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete customer");
    } finally {
      setPurgeBusy(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied((cur) => (cur === value ? null : cur)), 1600);
    } catch {
      /* clipboard may be denied */
    }
  }

  async function submitPayment() {
    if (!id) return;
    setConfirmPay(false);
    setError(null);
    setPayOk(null);
    setPayBusy(true);
    try {
      const result = await api<{ receiptNo: string; surplusRupees: number }>("/api/payments", {
        method: "POST",
        body: {
          customerId: id,
          amountRupees: Number(amount),
          paidOn,
          method,
          referenceNo: reference.trim() || undefined,
          invoiceId: invoiceId || undefined,
        },
      });
      setAmount("");
      setReference("");
      setInvoiceId("");
      setPayOk(
        result.surplusRupees > 0
          ? `Receipt ${result.receiptNo} recorded. Extra Rs. ${result.surplusRupees} is on account. Reminders will not send for settled bills.`
          : `Receipt ${result.receiptNo} recorded. Reminders will not send for this paid bill.`,
      );
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not record payment");
    } finally {
      setPayBusy(false);
    }
  }

  if (error && !data) return <div className="p-8 text-warn">{error}</div>;
  if (!data) return <div className="p-8 text-slate-500">Loading customer…</div>;

  const c = data.customer;
  const missing = c.missing_fields ?? [];
  const due = openDue(data.invoices);
  const openInvoices = data.invoices.filter((i) =>
    i.status === "UNPAID" || i.status === "PARTIALLY_PAID" || i.status === "OVERDUE",
  );

  return (
    <div className="page mx-auto max-w-5xl p-6 lg:p-8">
      <p className="text-sm">
        <button type="button" onClick={() => nav(-1)} className="text-electric hover:underline">
          ← Back to list
        </button>
      </p>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-electric">{c.customer_code}</p>
          <h1 className="page-title mt-1 text-3xl font-bold">{c.full_name}</h1>
          <div className="mt-3">
            <StatusBadge status={c.status} />
          </div>
        </div>
        <div className="flex gap-2">
          {has("customer:write") && (
            <Link
              to={`/customers/${c.id}/edit`}
              className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
            >
              Complete / edit
            </Link>
          )}
          {has("customer:delete") && (
            <>
              {c.status === "INACTIVE" ? (
                <button
                  type="button"
                  onClick={() => void activate()}
                  className="rounded-xl border border-emerald/30 bg-white px-4 py-2.5 text-sm font-semibold text-emerald shadow-sm"
                >
                  Activate
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeactivate(true)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm"
                >
                  Deactivate
                </button>
              )}
              <button
                type="button"
                disabled={purgeBusy}
                onClick={() => setConfirmPurge(true)}
                className="rounded-xl border border-rose/30 bg-white px-4 py-2.5 text-sm font-semibold text-rose shadow-sm disabled:opacity-40"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-rose/20 bg-rose/10 px-3 py-2 text-sm text-rose">{error}</p>
      )}
      {missing.length > 0 && (
        <div className="mt-6 rounded-2xl border border-warn/25 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">Incomplete.</span> Still needs{" "}
          {missing.map(missingLabel).join(", ")}. Fill these in yourself — the app will not invent them.
        </div>
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card title="Identity">
          <Row
            label="Phone"
            value={c.primary_phone}
            onCopy={c.primary_phone ? () => void copy(c.primary_phone as string) : undefined}
            copied={copied === c.primary_phone}
          />
          <Row label="CNIC" value={c.cnic} />
          <Row label="Area" value={c.area_name} />
          <Row label="Address" value={c.address} />
          <Row label="Legacy user" value={c.legacy_username} />
          <Row label="Legacy group" value={c.legacy_group} />
        </Card>
        <Card title="Billing">
          <Row label="Package" value={c.package_name} />
          <Row label="Monthly price" value={pkr(c.monthly_price)} />
          <Row label="Expiry" value={formatDate(c.current_expiry_date)} />
          <Row label="Billing day" value={c.billing_anchor_day != null ? String(c.billing_anchor_day) : null} />
          <Row label="Expiry notice" value={EXPIRY_NOTICE_TIME} />
          <Row label="Amount due" value={pkr(due)} />
        </Card>
        <Card title="Connection">
          <Row label="Type" value={c.connection_type} />
          <Row label="IP" value={c.ip_address} />
          <Row label="MAC" value={c.mac_address} />
        </Card>
        <Card title="WhatsApp">
          {data.whatsapp.length === 0 && <p className="text-sm text-slate-500">No number on record.</p>}
          {data.whatsapp.map((w) => (
            <Row
              key={w.msisdn}
              label={w.is_primary ? "Primary" : "Number"}
              value={`${w.msisdn} (${w.state})`}
              onCopy={() => void copy(w.msisdn)}
              copied={copied === w.msisdn}
            />
          ))}
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Invoices</h2>
        {data.invoices.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">None yet. Invoices are created after package and price are set.</p>
        ) : (
          <Table
            headers={["Invoice", "Expiry", "Total", "Paid", "Status"]}
            rows={data.invoices.map((i) => [i.invoice_no, formatDate(i.period_end), pkr(i.total), pkr(i.amount_paid), i.status])}
          />
        )}
      </section>

      {has("payment:write") && (
        <section className="card mt-8 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-navy">Record payment</h2>
          <p className="mt-1 text-sm text-slate-500">
            Confirm a fee received at the counter. Once the bill is settled, WhatsApp reminders for that cycle are not sent.
          </p>
          {payOk && <p className="mt-3 text-sm font-medium text-emerald">{payOk}</p>}
          {data.invoices.length === 0 ? (
            <p className="mt-3 text-sm text-amber-800">
              No invoice yet. Complete package and price first. Incomplete customers are not messaged.
            </p>
          ) : due <= 0 ? (
            <p className="mt-3 text-sm text-emerald">No amount due. Reminders will not send for paid bills.</p>
          ) : (
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmPay(true);
              }}
            >
              <label className="block text-sm text-slate-700">
                Amount (PKR)
                <input
                  required
                  type="number"
                  min={1}
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={inputClass}
                />
                <span className="mt-1 block text-xs text-slate-500">Open due {pkr(due)}</span>
              </label>
              <label className="block text-sm text-slate-700">
                Method
                <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-slate-700">
                Paid on
                <input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputClass} />
              </label>
              <label className="block text-sm text-slate-700">
                Apply to invoice
                <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className={inputClass}>
                  <option value="">Oldest unpaid first</option>
                  {openInvoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.invoice_no} · due {pkr(Number(i.total) - Number(i.amount_paid))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-slate-700 sm:col-span-2">
                Reference (optional)
                <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank slip, JazzCash ID…" className={inputClass} />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={payBusy || !amount}
                  className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {payBusy ? "Recording…" : "Record payment"}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Payments</h2>
        {data.payments.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No payments recorded.</p>
        ) : (
          <Table
            headers={["Receipt", "Date", "Amount", "Method"]}
            rows={data.payments.map((p) => [p.receipt_no, formatDate(p.paid_on), pkr(p.amount), p.method])}
          />
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-navy">Notifications</h2>
        {data.notifications.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No WhatsApp messages yet.</p>
        ) : (
          <Table
            headers={["Type", "Status", "Skip reason"]}
            rows={data.notifications.map((n) => [
              n.notification_type.replaceAll("_", " "),
              n.status,
              n.skip_reason ?? "—",
            ])}
          />
        )}
      </section>

      {c.notes && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-navy">Notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{c.notes}</p>
        </section>
      )}

      {confirmDeactivate && (
        <ConfirmDialog
          title="Deactivate this customer?"
          body="They move to Deactivated customers and stop getting WhatsApp reminders. You can activate them again. Delete only if you want them gone completely."
          confirmLabel="Deactivate"
          onCancel={() => setConfirmDeactivate(false)}
          onConfirm={() => void deactivate()}
        />
      )}
      {confirmPurge && (
        <ConfirmDialog
          title={`Delete ${c.full_name}?`}
          body={`${c.customer_code} will be removed permanently, including invoices, payments, and WhatsApp history. This cannot be undone.`}
          confirmLabel="Delete permanently"
          requireTyped={c.customer_code}
          danger
          onCancel={() => setConfirmPurge(false)}
          onConfirm={() => void purge()}
        />
      )}
      {confirmPay && (
        <ConfirmDialog
          title="Confirm this payment?"
          body={`Record ${pkr(amount)} (${PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method}). Settled bills will not get WhatsApp reminders.`}
          confirmLabel="Record payment"
          onCancel={() => setConfirmPay(false)}
          onConfirm={() => void submitPayment()}
        />
      )}
    </div>
  );
}

function openDue(invoices: Profile["invoices"]): number {
  return invoices.reduce((sum, i) => {
    if (i.status === "PAID" || i.status === "CANCELLED") return sum;
    const left = Number(i.total) - Number(i.amount_paid);
    return sum + (Number.isFinite(left) && left > 0 ? left : 0);
  }, 0);
}

const inputClass =
  "input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card rounded-2xl p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <dl className="mt-3 space-y-2">{children}</dl>
    </div>
  );
}

function Row({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string | null | undefined;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="flex items-center justify-end gap-2 text-right text-navy">
        <span>{value || "—"}</span>
        {value && onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="text-xs font-medium text-electric hover:underline"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </dd>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap mt-3 overflow-x-auto rounded-2xl">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-4 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {r.map((cell, j) => (
                <td key={j} className="px-4 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
