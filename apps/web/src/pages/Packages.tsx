import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { pkr } from "../labels.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { useAuth } from "../auth.tsx";

interface PackageRow {
  id: number;
  code: string;
  name: string;
  speed_mbps: number;
  monthly_price: string;
  is_active: boolean;
  subscriber_count: number;
  assignment_count: number;
}

type Pending =
  | { kind: "deactivate" | "reactivate" | "delete"; pkg: PackageRow }
  | null;

export function Packages() {
  const { has } = useAuth();
  const canWrite = has("package:write");
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [speed, setSpeed] = useState("");
  const [price, setPrice] = useState("");

  function load() {
    api<{ rows: PackageRow[] }>("/api/packages")
      .then((r) => setRows(r.rows))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load packages"));
  }

  useEffect(load, []);

  function resetForm() {
    setEditingId(null);
    setCode("");
    setName("");
    setSpeed("");
    setPrice("");
  }

  function startEdit(p: PackageRow) {
    setError(null);
    setEditingId(p.id);
    setCode(p.code);
    setName(p.name);
    setSpeed(String(p.speed_mbps));
    setPrice(String(Number(p.monthly_price)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      code: code.trim(),
      name: name.trim(),
      speedMbps: Number(speed),
      monthlyPrice: Number(price),
    };
    try {
      if (editingId != null) {
        await api(`/api/packages/${editingId}`, { method: "PATCH", body });
      } else {
        await api("/api/packages", { method: "POST", body });
      }
      resetForm();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save package");
    } finally {
      setBusy(false);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    setError(null);
    setBusy(true);
    try {
      if (pending.kind === "delete") {
        await api(`/api/packages/${pending.pkg.id}`, { method: "DELETE" });
      } else {
        await api(`/api/packages/${pending.pkg.id}/${pending.kind}`, { method: "POST" });
      }
      if (editingId === pending.pkg.id) resetForm();
      setPending(null);
      load();
    } catch (err) {
      setPending(null);
      setError(err instanceof ApiError ? err.message : "Could not update package");
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy = pending
    ? pending.kind === "delete"
      ? {
          title: `Delete ${pending.pkg.code}?`,
          body: "This package has never been assigned. It will be removed completely.",
          confirmLabel: "Delete",
        }
      : pending.kind === "deactivate"
        ? {
            title: `Deactivate ${pending.pkg.code}?`,
            body: "Customers already on this plan keep it. You will not be able to assign it to new customers until you reactivate.",
            confirmLabel: "Deactivate",
          }
        : {
            title: `Reactivate ${pending.pkg.code}?`,
            body: "It will show up again when you assign a package on a customer.",
            confirmLabel: "Reactivate",
          }
    : null;

  return (
    <div className="page mx-auto max-w-4xl p-6 lg:p-8">
      <PageHeader
        kicker="Catalog"
        title="Packages"
        subtitle="Add as many plans as you need. Deactivate a plan to hide it from new customers. Delete only unused plans. Changing a package does not rewrite old invoices."
      />

      {canWrite && (
        <form onSubmit={onSubmit} className="card mt-8 grid gap-3 rounded-2xl p-5 sm:grid-cols-2">
          <p className="sm:col-span-2 text-sm font-semibold text-navy">
            {editingId != null ? "Edit package" : "Add a package"}
          </p>
          <input
            required
            placeholder="Code (PKG-20M)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputClass}
          />
          <input required placeholder="Name (20 Mbps Fiber)" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          <input required type="number" min={1} placeholder="Speed Mbps" value={speed} onChange={(e) => setSpeed(e.target.value)} className={inputClass} />
          <input required type="number" min={0} step={1} placeholder="List price PKR" value={price} onChange={(e) => setPrice(e.target.value)} className={inputClass} />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" disabled={busy} className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? "Saving…" : editingId != null ? "Save changes" : "Add package"}
            </button>
            {editingId != null && (
              <button type="button" onClick={resetForm} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {error && <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-warn">{error}</p>}
      {!rows && !error && <p className="mt-6 text-slate-500">Loading packages…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          No packages yet. Add one above, then open a customer and fill it in.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="table-wrap mt-6 overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Speed</th>
                <th className="px-4 py-3">List price</th>
                <th className="px-4 py-3">Subscribers</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={`border-b border-slate-100 last:border-0 ${p.is_active ? "" : "opacity-60"}`}>
                  <td className="px-4 py-3 font-medium">{p.code}</td>
                  <td className="px-4 py-3">
                    {p.name}
                    {!p.is_active ? <span className="ml-1 text-slate-500">(inactive)</span> : null}
                  </td>
                  <td className="px-4 py-3">{p.speed_mbps} Mbps</td>
                  <td className="px-4 py-3">{pkr(p.monthly_price)}</td>
                  <td className="px-4 py-3">{p.subscriber_count}</td>
                  <td className="px-4 py-3">
                    {canWrite && (
                      <div className="flex flex-wrap justify-end gap-3">
                        <button type="button" onClick={() => startEdit(p)} className="text-sm font-medium text-electric hover:underline">
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setPending({ kind: p.is_active ? "deactivate" : "reactivate", pkg: p })}
                          className="text-sm font-medium text-electric hover:underline"
                        >
                          {p.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                        {(p.assignment_count ?? p.subscriber_count) === 0 && (
                          <button
                            type="button"
                            onClick={() => setPending({ kind: "delete", pkg: p })}
                            className="text-sm font-medium text-rose hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending && confirmCopy && (
        <ConfirmDialog
          title={confirmCopy.title}
          body={confirmCopy.body}
          confirmLabel={confirmCopy.confirmLabel}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        />
      )}
    </div>
  );
}

const inputClass = "input-field rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none";
