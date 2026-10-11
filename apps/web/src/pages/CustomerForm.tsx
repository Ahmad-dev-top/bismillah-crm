import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { missingLabel, pkr } from "../labels.ts";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { usePageTitle } from "../usePageTitle.ts";

interface PackageRow {
  id: number;
  code: string;
  name: string;
  speed_mbps: number;
  monthly_price: string;
  is_active: boolean;
}

interface AreaRow {
  id: number;
  name: string;
  is_active: boolean;
}

interface ProfileResponse {
  customer: {
    id: string;
    customer_code: string;
    full_name: string;
    status: string;
    missing_fields: string[];
    primary_phone: string | null;
    cnic: string | null;
    address: string | null;
    area_id: number | null;
    package_id: number | null;
    monthly_price: string | null;
    billing_anchor_day: number | null;
    installation_date: string | null;
    current_expiry_date: string | null;
    connection_type: string | null;
    ip_address: string | null;
    mac_address: string | null;
    router_model: string | null;
    onu_serial: string | null;
    notes: string | null;
  };
  whatsapp: { msisdn: string; is_primary: boolean }[];
}

export function CustomerForm() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const isNew = !id;

  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(isNew);

  const [fullName, setFullName] = useState("");
  const [customerCode, setCustomerCode] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [cnic, setCnic] = useState("");
  const [address, setAddress] = useState("");
  const [areaId, setAreaId] = useState("");
  const [packageId, setPackageId] = useState("");
  const [monthlyPrice, setMonthlyPrice] = useState("");
  const [billingAnchorDay, setBillingAnchorDay] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [connectionType, setConnectionType] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [macAddress, setMacAddress] = useState("");
  const [routerModel, setRouterModel] = useState("");
  const [onuSerial, setOnuSerial] = useState("");
  const [notes, setNotes] = useState("");
  usePageTitle(isNew ? "Add customer" : "Complete customer");

  useEffect(() => {
    api<{ rows: PackageRow[] }>("/api/packages?active=true").then((r) => setPackages(r.rows)).catch(() => setPackages([]));
    api<{ rows: AreaRow[] }>("/api/areas").then((r) => setAreas(r.rows.filter((a) => a.is_active))).catch(() => setAreas([]));
  }, []);

  useEffect(() => {
    if (!id) return;
    api<ProfileResponse>(`/api/customers/${id}`)
      .then((r) => {
        const c = r.customer;
        setFullName(c.full_name);
        setCustomerCode(c.customer_code ?? "");
        setPhone(c.primary_phone ?? "");
        setWhatsapp(r.whatsapp.find((w) => w.is_primary)?.msisdn ?? "");
        setCnic(c.cnic ?? "");
        setAddress(c.address ?? "");
        setAreaId(c.area_id != null ? String(c.area_id) : "");
        setPackageId(c.package_id != null ? String(c.package_id) : "");
        setMonthlyPrice(c.monthly_price != null ? String(Number(c.monthly_price)) : "");
        setBillingAnchorDay(c.billing_anchor_day != null ? String(c.billing_anchor_day) : "");
        setExpiryDate(c.current_expiry_date ? c.current_expiry_date.slice(0, 10) : "");
        setInstallationDate(c.installation_date ? c.installation_date.slice(0, 10) : "");
        setConnectionType(c.connection_type ?? "");
        setIpAddress(c.ip_address ?? "");
        setMacAddress(c.mac_address ?? "");
        setRouterModel(c.router_model ?? "");
        setOnuSerial(c.onu_serial ?? "");
        setNotes(c.notes ?? "");
        setStatus(c.status);
        setMissing(c.missing_fields ?? []);
        setLoaded(true);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load customer"));
  }, [id]);

  const selectedPkg = packages.find((p) => String(p.id) === packageId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const body: Record<string, unknown> = {
      fullName: fullName.trim(),
    };
    if (customerCode.trim()) body.customerCode = customerCode.trim();
    if (phone.trim()) body.phone = phone.trim();
    if (whatsapp.trim()) body.whatsapp = whatsapp.trim();
    if (cnic.trim()) body.cnic = cnic.trim();
    if (address.trim()) body.address = address.trim();
    if (areaId) body.areaId = Number(areaId);
    if (packageId) body.packageId = Number(packageId);
    if (monthlyPrice.trim()) body.monthlyPrice = Number(monthlyPrice);
    if (billingAnchorDay) body.billingAnchorDay = Number(billingAnchorDay);
    if (expiryDate) body.expiryDate = expiryDate;
    if (installationDate) body.installationDate = installationDate;
    if (connectionType) body.connectionType = connectionType;
    if (ipAddress.trim()) body.ipAddress = ipAddress.trim();
    if (macAddress.trim()) body.macAddress = macAddress.trim();
    if (routerModel.trim()) body.routerModel = routerModel.trim();
    if (onuSerial.trim()) body.onuSerial = onuSerial.trim();
    if (notes.trim()) body.notes = notes.trim();

    if (packageId && !monthlyPrice.trim()) {
      setError("Monthly price is required when assigning a package. The list price is not copied automatically.");
      setBusy(false);
      return;
    }

    try {
      if (isNew) {
        const created = await api<{ id: string }>("/api/customers", { method: "POST", body });
        nav(`/customers/${created.id}`);
      } else {
        await api(`/api/customers/${id}`, { method: "PATCH", body });
        nav(`/customers/${id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded && !error) return <div className="p-8 text-slate-500">Loading form…</div>;

  return (
    <div className="page mx-auto max-w-3xl p-6 lg:p-8">
      <p className="text-sm">
        <Link to={id ? `/customers/${id}` : "/customers"} className="text-electric hover:underline">
          ← Back
        </Link>
      </p>
      <h1 className="page-title mt-2 text-3xl font-bold">{isNew ? "Add customer" : "Complete customer"}</h1>
      <p className="mt-1 text-sm text-slate-500">
        Leave a gap blank if you do not know it yet. Package and price are never invented.
      </p>

      {status && (
        <div className="mt-4">
          <StatusBadge status={status} />
        </div>
      )}
      {missing.length > 0 && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Still missing: {missing.map(missingLabel).join(", ")}
        </p>
      )}

      <form onSubmit={onSubmit} className="card mt-6 space-y-6 rounded-2xl p-6">
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Identity</legend>
          <Field label="Customer code" required={!isNew}>
            <input
              required={!isNew}
              value={customerCode}
              onChange={(e) => setCustomerCode(e.target.value)}
              placeholder={isNew ? "Leave blank for the next BI- number" : "BI-000124"}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-500">
              {isNew
                ? "Optional. If you leave this empty, the next BI- number is assigned."
                : "Must be unique. Old invoices keep their original invoice numbers."}
            </p>
          </Field>
          <Field label="Full name" required>
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="03xx…" className={inputClass} />
          </Field>
          <Field label="WhatsApp">
            <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="Defaults to phone" className={inputClass} />
          </Field>
          <Field label="CNIC">
            <input value={cnic} onChange={(e) => setCnic(e.target.value)} placeholder="xxxxx-xxxxxxx-x" className={inputClass} />
          </Field>
          <Field label="Area">
            <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
          </Field>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Package and price</legend>
          <Field label="Package">
            <select value={packageId} onChange={(e) => setPackageId(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.speed_mbps} Mbps)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Monthly price (PKR)">
            <input
              type="number"
              min={1}
              step={1}
              value={monthlyPrice}
              onChange={(e) => setMonthlyPrice(e.target.value)}
              placeholder="Type the real price"
              className={inputClass}
            />
            {selectedPkg && (
              <p className="mt-1 text-xs text-slate-500">
                List price {pkr(selectedPkg.monthly_price)} — informational only. Type the amount this customer pays.
              </p>
            )}
          </Field>
          <Field label="Billing day (1–31)">
            <input
              type="number"
              min={1}
              max={31}
              value={billingAnchorDay}
              onChange={(e) => setBillingAnchorDay(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Expiry date">
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => {
                setExpiryDate(e.target.value);
                if (e.target.value.length === 10 && !billingAnchorDay) {
                  setBillingAnchorDay(String(Number(e.target.value.slice(8, 10))));
                }
              }}
              className={inputClass}
            />
          </Field>
          <Field label="Installation date">
            <input type="date" value={installationDate} onChange={(e) => setInstallationDate(e.target.value)} className={inputClass} />
          </Field>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Connection</legend>
          <Field label="Type">
            <select value={connectionType} onChange={(e) => setConnectionType(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              <option value="FIBER">Fiber</option>
              <option value="PTP_WIRELESS">PtP wireless</option>
              <option value="CABLE">Cable</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="IP address">
            <input value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} className={inputClass} />
          </Field>
          <Field label="MAC">
            <input value={macAddress} onChange={(e) => setMacAddress(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Router">
            <input value={routerModel} onChange={(e) => setRouterModel(e.target.value)} className={inputClass} />
          </Field>
          <Field label="ONU serial">
            <input value={onuSerial} onChange={(e) => setOnuSerial(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputClass} />
          </Field>
        </fieldset>

        {error && <p className="rounded-md bg-orange-50 px-3 py-2 text-sm text-warn">{error}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={busy}
            className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <Link to={id ? `/customers/${id}` : "/customers"} className="rounded-md px-4 py-2 text-sm text-slate-600">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

const inputClass =
  "input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none";

function Field({
  label,
  children,
  required,
  className,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`block text-sm text-slate-700 ${className ?? ""}`}>
      {label}
      {required ? " *" : ""}
      {children}
    </label>
  );
}
