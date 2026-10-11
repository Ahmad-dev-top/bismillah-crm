/**
 * Completeness of a customer record. Missing data is flagged, never filled
 * with a guess. INCOMPLETE is correct until staff supply the real values
 * in the app.
 */

export function computeMissingFields(row: {
  fullName: string | null;
  primaryPhone: string | null;
  billingAnchorDay: number | null;
  hasSubscription: boolean;
}): string[] {
  const missing: string[] = [];
  if (!row.fullName?.trim()) missing.push("full_name");
  if (!row.primaryPhone) missing.push("phone");
  if (!row.hasSubscription) {
    missing.push("package");
    missing.push("monthly_price");
  }
  if (row.billingAnchorDay == null) missing.push("billing_anchor_day");
  return missing;
}

export const MISSING_FIELD_LABEL: Record<string, string> = {
  full_name: "Name",
  phone: "Phone",
  primary_phone: "Phone",
  package: "Package",
  monthly_price: "Monthly price",
  billing_anchor_day: "Billing day",
  expiry_date: "Expiry date",
};
