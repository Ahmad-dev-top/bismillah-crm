/**
 * One-off staff account so you can sign in.
 * Local:  node --env-file=.env --experimental-strip-types scripts/create-local-admin.ts
 * VM:     ADMIN_PASSWORD='…' node --env-file=/etc/bismillah/api.env --experimental-strip-types scripts/create-local-admin.ts
 *
 * On a public VM, ADMIN_PASSWORD is required. The local default is only for
 * this Windows laptop and must not be used in production.
 */
import argon2 from "argon2";
import postgres from "postgres";

const isProd = process.env.NODE_ENV === "production";
const email = process.env.ADMIN_EMAIL ?? "admin@localhost";
const password = process.env.ADMIN_PASSWORD ?? (isProd ? "" : "ChangeMe123!");

if (!password) {
  throw new Error("ADMIN_PASSWORD is required (do not use the local default on the VM)");
}

const hash = await argon2.hash(password, { type: argon2.argon2id });
const sql = postgres(process.env.DATABASE_URL!);
const [role] = await sql`SELECT id FROM roles WHERE code = 'SUPER_ADMIN'`;
if (!role) throw new Error("SUPER_ADMIN role missing — apply ops/schema.sql first.");
await sql`
  INSERT INTO users (email, full_name, password_hash, role_id)
  VALUES (${email}, 'Admin', ${hash}, ${role.id})
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
`;
await sql.end();
console.log("Created", email);
