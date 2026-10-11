export const MISSING_FIELD_LABEL: Record<string, string> = {
  full_name: "Name",
  phone: "Phone",
  primary_phone: "Phone",
  package: "Package",
  monthly_price: "Monthly price",
  billing_anchor_day: "Billing day",
  expiry_date: "Expiry date",
};

export function missingLabel(field: string): string {
  return MISSING_FIELD_LABEL[field] ?? field.replaceAll("_", " ");
}

export function pkr(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `Rs. ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Spec: the expiry job is midnight, rendered as 12:00 AM (Midnight). */
export const EXPIRY_NOTICE_TIME = "12:00 AM (Midnight)";

export function todayInKarachi(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
}

export const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "JAZZCASH", label: "JazzCash" },
  { value: "EASYPAISA", label: "Easypaisa" },
  { value: "RAAST", label: "Raast" },
  { value: "ONLINE_TRANSFER", label: "Online transfer" },
  { value: "OTHER", label: "Other" },
] as const;
