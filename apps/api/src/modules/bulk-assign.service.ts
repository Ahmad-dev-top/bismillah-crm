/**
 * Bulk-assign a package and monthly price to INCOMPLETE customers that share
 * a legacy_group (the numeric PPPoE prefix, e.g. "10" in "10mwaseem").
 *
 * There are 15 such groups and 548 imported customers with no package or
 * price. This is how those gaps get filled without inventing a number: the
 * operator supplies monthlyPrice, and a request without one is rejected.
 *
 * Writes nothing unless confirm === true. Dry-run is the default.
 */

import { z } from "zod";
import { todayInKarachi } from "@bi/domain";
import type { Sql } from "../db/index.ts";
import { computeMissingFields } from "./completeness.ts";

export { computeMissingFields } from "./completeness.ts";

export class BulkAssignError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BulkAssignError";
    this.statusCode = statusCode;
  }
}

/**
 * monthlyPrice has no default and is not taken from packages.monthly_price.
 * If the operator does not send it, the request fails.
 */
export const bulkAssignSchema = z.object({
  legacyGroup: z.string().trim().min(1).max(32),
  packageId: z.number().int().positive(),
  monthlyPrice: z.number({ required_error: "monthlyPrice is required" }).finite().positive(),
  confirm: z.boolean().optional().default(false),
});

export type BulkAssignInput = z.infer<typeof bulkAssignSchema> & {
  actorId?: string | null;
};

export interface BulkAssignResult {
  dryRun: boolean;
  legacyGroup: string;
  package: {
    id: number;
    code: string;
    name: string;
    speedMbps: number;
    listPrice: number;
  };
  monthlyPrice: number;
  matched: number;
  assigned: number;
  skippedAlreadySubscribed: number;
  becameActive: number;
  remainedIncomplete: number;
  remainingMissing: Record<string, number>;
  sampleCustomerCodes: string[];
}

interface Candidate {
  id: string;
  customer_code: string;
  full_name: string;
  primary_phone: string | null;
  billing_anchor_day: number | null;
  status: string;
  missing_fields: string[];
  installation_date: string | null;
  has_subscription: boolean;
}

export async function listLegacyGroups(sql: Sql) {
  const rows = await sql<{
    legacy_group: string;
    customers: number;
    incomplete: number;
    without_subscription: number;
  }[]>`
    SELECT c.legacy_group,
           COUNT(*)::int AS customers,
           COUNT(*) FILTER (WHERE c.status = 'INCOMPLETE')::int AS incomplete,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM subscriptions s
                WHERE s.customer_id = c.id AND s.ended_on IS NULL
             )
           )::int AS without_subscription
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND c.legacy_group IS NOT NULL
     GROUP BY c.legacy_group
     ORDER BY c.legacy_group`;
  return rows;
}

export async function listPackages(sql: Sql) {
  return sql<{
    id: number;
    code: string;
    name: string;
    speed_mbps: number;
    monthly_price: string;
    is_active: boolean;
  }[]>`
    SELECT id, code, name, speed_mbps, monthly_price, is_active
      FROM packages
     ORDER BY speed_mbps, code`;
}

export async function bulkAssignPackage(
  sql: Sql,
  input: BulkAssignInput,
): Promise<BulkAssignResult> {
  if (input.monthlyPrice === undefined || input.monthlyPrice === null) {
    throw new BulkAssignError("monthlyPrice is required; refusing to invent a price.");
  }
  if (!(input.monthlyPrice > 0) || !Number.isFinite(input.monthlyPrice)) {
    throw new BulkAssignError("monthlyPrice must be a positive number.");
  }

  const [pkg] = await sql<{
    id: number;
    code: string;
    name: string;
    speed_mbps: number;
    monthly_price: string;
    is_active: boolean;
  }[]>`
    SELECT id, code, name, speed_mbps, monthly_price, is_active
      FROM packages WHERE id = ${input.packageId}`;

  if (!pkg) {
    throw new BulkAssignError(`Package ${input.packageId} not found.`, 404);
  }
  if (!pkg.is_active) {
    throw new BulkAssignError(
      `Package ${pkg.code} is inactive; reactivate it before assigning.`,
      409,
    );
  }

  const candidates = await sql<Candidate[]>`
    SELECT c.id,
           c.customer_code,
           c.full_name,
           c.primary_phone,
           c.billing_anchor_day,
           c.status,
           c.missing_fields,
           c.installation_date,
           EXISTS (
             SELECT 1 FROM subscriptions s
              WHERE s.customer_id = c.id AND s.ended_on IS NULL
           ) AS has_subscription
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND c.legacy_group = ${input.legacyGroup}
       AND c.status = 'INCOMPLETE'
     ORDER BY c.customer_code`;

  const assignable = candidates.filter((c) => !c.has_subscription);
  const skippedAlreadySubscribed = candidates.length - assignable.length;

  const remainingMissing: Record<string, number> = {};
  let wouldBecomeActive = 0;
  let wouldRemainIncomplete = 0;

  for (const c of assignable) {
    const missing = computeMissingFields({
      fullName: c.full_name,
      primaryPhone: c.primary_phone,
      billingAnchorDay: c.billing_anchor_day,
      hasSubscription: true,
    });
    if (missing.length === 0) wouldBecomeActive++;
    else wouldRemainIncomplete++;
    for (const f of missing) remainingMissing[f] = (remainingMissing[f] ?? 0) + 1;
  }

  const result: BulkAssignResult = {
    dryRun: !input.confirm,
    legacyGroup: input.legacyGroup,
    package: {
      id: pkg.id,
      code: pkg.code,
      name: pkg.name,
      speedMbps: pkg.speed_mbps,
      listPrice: Number(pkg.monthly_price),
    },
    monthlyPrice: input.monthlyPrice,
    matched: candidates.length,
    assigned: input.confirm ? 0 : assignable.length,
    skippedAlreadySubscribed,
    becameActive: input.confirm ? 0 : wouldBecomeActive,
    remainedIncomplete: input.confirm ? 0 : wouldRemainIncomplete,
    remainingMissing: input.confirm ? {} : remainingMissing,
    sampleCustomerCodes: assignable.slice(0, 20).map((c) => c.customer_code),
  };

  if (!input.confirm) return result;

  const startedOnDefault = todayInKarachi();
  const actorId = input.actorId ?? null;

  const written = await sql.begin(async (tx) => {
    const locked = await tx<Candidate[]>`
      SELECT c.id,
             c.customer_code,
             c.full_name,
             c.primary_phone,
             c.billing_anchor_day,
             c.status,
             c.missing_fields,
             c.installation_date,
             EXISTS (
               SELECT 1 FROM subscriptions s
                WHERE s.customer_id = c.id AND s.ended_on IS NULL
             ) AS has_subscription
        FROM customers c
       WHERE c.deleted_at IS NULL
         AND c.legacy_group = ${input.legacyGroup}
         AND c.status = 'INCOMPLETE'
       ORDER BY c.customer_code
         FOR UPDATE OF c`;

    let assigned = 0;
    let becameActive = 0;
    let remainedIncomplete = 0;
    let skipped = 0;
    const writtenMissing: Record<string, number> = {};
    const codes: string[] = [];

    for (const c of locked) {
      if (c.has_subscription) {
        skipped++;
        continue;
      }

      const startedOn = c.installation_date ?? startedOnDefault;

      try {
        await tx`
          INSERT INTO subscriptions (customer_id, package_id, monthly_price, started_on)
          VALUES (${c.id}, ${input.packageId}, ${input.monthlyPrice}, ${startedOn})`;
      } catch (err) {
        if (isUniqueViolation(err)) {
          skipped++;
          continue;
        }
        throw err;
      }

      const missing = computeMissingFields({
        fullName: c.full_name,
        primaryPhone: c.primary_phone,
        billingAnchorDay: c.billing_anchor_day,
        hasSubscription: true,
      });
      const nextStatus = missing.length === 0 ? "ACTIVE" : "INCOMPLETE";

      await tx`
        UPDATE customers
           SET missing_fields = ${missing},
               status = ${nextStatus}
         WHERE id = ${c.id}
           AND status = 'INCOMPLETE'`;

      await tx`
        INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
        VALUES (
          ${actorId},
          'customer.bulk_assign_package',
          'customer',
          ${c.id},
          ${tx.json({
            status: c.status,
            missing_fields: c.missing_fields,
            subscription: null,
          })},
          ${tx.json({
            status: nextStatus,
            missing_fields: missing,
            packageId: input.packageId,
            monthlyPrice: input.monthlyPrice,
            legacyGroup: input.legacyGroup,
          })}
        )`;

      assigned++;
      if (nextStatus === "ACTIVE") becameActive++;
      else remainedIncomplete++;
      for (const f of missing) writtenMissing[f] = (writtenMissing[f] ?? 0) + 1;
      if (codes.length < 20) codes.push(c.customer_code);
    }

    return { assigned, becameActive, remainedIncomplete, skipped, writtenMissing, codes };
  });

  result.dryRun = false;
  result.assigned = written.assigned;
  result.skippedAlreadySubscribed = written.skipped;
  result.becameActive = written.becameActive;
  result.remainedIncomplete = written.remainedIncomplete;
  result.remainingMissing = written.writtenMissing;
  result.sampleCustomerCodes = written.codes;
  result.matched = written.assigned + written.skipped;
  return result;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
