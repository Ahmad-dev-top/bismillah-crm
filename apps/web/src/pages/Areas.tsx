import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { useAuth } from "../auth.tsx";

interface AreaRow {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  customer_count: number;
}

export function Areas() {
  const { has } = useAuth();
  const [rows, setRows] = useState<AreaRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  function load() {
    api<{ rows: AreaRow[] }>("/api/areas")
      .then((r) => setRows(r.rows))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load areas"));
  }

  useEffect(load, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/areas", { method: "POST", body: { name: name.trim() } });
      setName("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create area");
    }
  }

  return (
    <div className="page mx-auto max-w-3xl p-6 lg:p-8">
      <PageHeader
        kicker="Coverage"
        title="Areas"
        subtitle="Optional. Assign an area on the customer form when you know it."
      />

      {has("area:write") && (
        <form onSubmit={onCreate} className="card mt-8 flex gap-3 rounded-2xl p-4">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Area name"
            className="input-field flex-1 rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
          <button type="submit" className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white">
            Add area
          </button>
        </form>
      )}

      {error && <p className="mt-4 text-warn">{error}</p>}
      {!rows && !error && <p className="mt-6 text-slate-500">Loading areas…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          No areas yet.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="card mt-6 divide-y divide-slate-100 rounded-2xl">
          {rows.map((a) => (
            <li key={a.id} className={`flex items-center justify-between px-4 py-3 text-sm ${a.is_active ? "" : "opacity-50"}`}>
              <span className="font-medium text-navy">
                {a.name}
                {!a.is_active ? " (inactive)" : ""}
              </span>
              <span className="text-slate-500">{a.customer_count} customers</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
