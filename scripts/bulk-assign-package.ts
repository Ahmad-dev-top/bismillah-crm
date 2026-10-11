#!/usr/bin/env node --experimental-strip-types
/**
 * Assign a package and monthly price to INCOMPLETE customers sharing a
 * legacy_group (the numeric PPPoE prefix: "10" in "10mwaseem").
 *
 *   DATABASE_URL=postgres://... \
 *   node --experimental-strip-types scripts/bulk-assign-package.ts --list-groups
 *
 *   DATABASE_URL=postgres://... \
 *   node --experimental-strip-types scripts/bulk-assign-package.ts --list-packages
 *
 *   DATABASE_URL=postgres://... \
 *   node --experimental-strip-types scripts/bulk-assign-package.ts <legacyGroup> <packageId> <monthlyPrice> [--commit]
 *
 * Without --commit it only prints the dry-run counts. Nothing is written
 * until you have read the numbers and agreed with them. monthlyPrice is
 * required and is never taken from the package's list price.
 */
import { createSql } from "../apps/api/src/db/index.ts";
import {
  bulkAssignPackage,
  listLegacyGroups,
  listPackages,
} from "../apps/api/src/modules/bulk-assign.service.ts";

const args = process.argv.slice(2);
const doCommit = args.includes("--commit");
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

function usage(exit = 1): never {
  console.error(`usage:
  bulk-assign-package.ts --list-groups
  bulk-assign-package.ts --list-packages
  bulk-assign-package.ts <legacyGroup> <packageId> <monthlyPrice> [--commit]`);
  process.exit(exit);
}

if (flags.has("--help") || flags.has("-h")) usage(0);

if (!flags.has("--list-groups") && !flags.has("--list-packages")) {
  if (positional.length < 3) usage();
}

const sql = createSql();
let exitCode = 0;

try {
  if (flags.has("--list-groups")) {
    const groups = await listLegacyGroups(sql);
    if (groups.length === 0) {
      console.log("No legacy_group values on non-deleted customers.");
    } else {
      console.log("legacy_group  customers  incomplete  without_subscription");
      for (const g of groups) {
        console.log(
          `${String(g.legacy_group).padEnd(13)} ${String(g.customers).padStart(9)}  ${String(g.incomplete).padStart(10)}  ${String(g.without_subscription).padStart(20)}`,
        );
      }
    }
  } else if (flags.has("--list-packages")) {
    const packages = await listPackages(sql);
    if (packages.length === 0) {
      console.log("No packages. Insert rows into packages before assigning.");
    } else {
      console.log("id  code       name                  Mbps  list_price  active");
      for (const p of packages) {
        console.log(
          `${String(p.id).padEnd(3)} ${p.code.padEnd(10)} ${p.name.padEnd(20)} ${String(p.speed_mbps).padStart(4)}  ${String(p.monthly_price).padStart(10)}  ${p.is_active}`,
        );
      }
    }
  } else {
    const [legacyGroup, packageIdRaw, priceRaw] = positional;
    if (!legacyGroup || packageIdRaw === undefined || priceRaw === undefined) usage();

    const packageId = Number(packageIdRaw);
    const monthlyPrice = Number(priceRaw);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      console.error("packageId must be a positive integer. Use --list-packages.");
      exitCode = 1;
    } else if (!Number.isFinite(monthlyPrice) || monthlyPrice <= 0) {
      console.error("monthlyPrice is required and must be a positive number. Refusing to invent a price.");
      exitCode = 1;
    } else {
      const result = await bulkAssignPackage(sql, {
        legacyGroup,
        packageId,
        monthlyPrice,
        confirm: doCommit,
      });

      console.log(result.dryRun ? "\n--- DRY RUN (nothing written) ---" : "\n--- COMMITTED ---");
      console.log(`Group          : ${result.legacyGroup}`);
      console.log(`Package        : ${result.package.code} (${result.package.name}, ${result.package.speedMbps} Mbps)`);
      console.log(`List price     : ${result.package.listPrice}  (informational — not used)`);
      console.log(`Assigned price : ${result.monthlyPrice}`);
      console.log(`Matched        : ${result.matched}`);
      console.log(`Assigned       : ${result.assigned}`);
      console.log(`Already on pkg : ${result.skippedAlreadySubscribed}`);
      console.log(`Become ACTIVE  : ${result.becameActive}`);
      console.log(`Stay INCOMPLETE: ${result.remainedIncomplete}`);
      if (Object.keys(result.remainingMissing).length) {
        console.log("Still missing  :", result.remainingMissing);
      }
      if (result.sampleCustomerCodes.length) {
        console.log("Sample codes   :", result.sampleCustomerCodes.join(", "));
      }
      if (result.dryRun) {
        console.log("\nDry run. Re-run with --commit to write these subscriptions.");
      }
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(exitCode);
