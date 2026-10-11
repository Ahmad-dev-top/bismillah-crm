/** Packages and areas. Editing a package never rewrites historical invoices —
 *  those snapshot name/speed/price at issue time. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sql } from "../db/index.ts";
import { requirePermission } from "../server.ts";

const packageSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
  speedMbps: z.coerce.number().int().positive(),
  monthlyPrice: z.coerce.number().nonnegative(),
  description: z.string().max(1000).optional().nullable(),
});

function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function zodError(parsed: { error: z.ZodError }): string {
  return parsed.error.issues[0]?.message ?? "Invalid package";
}

const areaSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
});

export async function registerAdminRoutes(app: FastifyInstance, sql: Sql) {
  app.get("/api/packages", { preHandler: requirePermission("package:read") },
    async (req) => {
      const q = req.query as { active?: string };
      const rows = await sql`
        SELECT p.id, p.code, p.name, p.speed_mbps, p.monthly_price, p.description,
               p.is_active, p.created_at,
               COUNT(s.id) FILTER (WHERE s.ended_on IS NULL)::int AS subscriber_count,
               COUNT(s.id)::int AS assignment_count
          FROM packages p
          LEFT JOIN subscriptions s ON s.package_id = p.id
         ${q.active === "true" ? sql`WHERE p.is_active` : sql``}
         GROUP BY p.id
         ORDER BY p.speed_mbps, p.code`;
      return { rows };
    });

  app.post("/api/packages", { preHandler: requirePermission("package:write") },
    async (req, reply) => {
      const parsed = packageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: zodError(parsed), issues: parsed.error.issues });
      }
      const p = parsed.data;
      try {
        const [row] = await sql`
          INSERT INTO packages (code, name, speed_mbps, monthly_price, description)
          VALUES (${p.code}, ${p.name}, ${p.speedMbps}, ${p.monthlyPrice}, ${p.description ?? null})
          RETURNING *`;
        await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                  VALUES (${(req.user as { sub: string }).sub}, 'package.create', 'package', ${String(row!.id)},
                          ${sql.json(row as object)})`;
        return reply.code(201).send(row);
      } catch (err) {
        if (pgCode(err) === "23505") {
          return reply.code(409).send({ error: `A package with code "${p.code}" already exists. Use a different code.` });
        }
        throw err;
      }
    });

  app.patch("/api/packages/:id", { preHandler: requirePermission("package:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = packageSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: zodError(parsed), issues: parsed.error.issues });
      }
      const [before] = await sql`SELECT * FROM packages WHERE id = ${Number(id)}`;
      if (!before) return reply.code(404).send({ error: "Package not found" });
      const p = parsed.data;
      try {
        const [after] = await sql`
          UPDATE packages SET
            code          = COALESCE(${p.code ?? null}, code),
            name          = COALESCE(${p.name ?? null}, name),
            speed_mbps    = COALESCE(${p.speedMbps ?? null}, speed_mbps),
            monthly_price = COALESCE(${p.monthlyPrice ?? null}, monthly_price),
            description   = COALESCE(${p.description ?? null}, description)
          WHERE id = ${Number(id)} RETURNING *`;
        await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
                  VALUES (${(req.user as { sub: string }).sub}, 'package.update', 'package', ${id},
                          ${sql.json(before as object)}, ${sql.json(after as object)})`;
        return after;
      } catch (err) {
        if (pgCode(err) === "23505") {
          return reply.code(409).send({ error: `A package with code "${p.code}" already exists.` });
        }
        throw err;
      }
    });

  app.delete("/api/packages/:id", { preHandler: requirePermission("package:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const pkgId = Number(id);
      const [pkg] = await sql`SELECT id, code FROM packages WHERE id = ${pkgId}`;
      if (!pkg) return reply.code(404).send({ error: "Package not found" });
      const [{ n }] = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM subscriptions WHERE package_id = ${pkgId}`;
      if (Number(n) > 0) {
        return reply.code(409).send({
          error: "This package has been assigned to customers. Deactivate it instead of deleting.",
        });
      }
      await sql`DELETE FROM packages WHERE id = ${pkgId}`;
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data)
                VALUES (${(req.user as { sub: string }).sub}, 'package.delete', 'package', ${id},
                        ${sql.json(pkg as object)})`;
      return { id: pkgId, deleted: true };
    });

  app.post("/api/packages/:id/deactivate", { preHandler: requirePermission("package:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE packages SET is_active = false WHERE id = ${Number(id)} RETURNING id`;
      if (!row) return reply.code(404).send({ error: "Package not found" });
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                VALUES (${(req.user as { sub: string }).sub}, 'package.deactivate', 'package', ${id},
                        ${sql.json({ is_active: false })})`;
      return { id: row.id, deactivated: true };
    });

  app.post("/api/packages/:id/reactivate", { preHandler: requirePermission("package:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE packages SET is_active = true WHERE id = ${Number(id)} RETURNING id`;
      if (!row) return reply.code(404).send({ error: "Package not found" });
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                VALUES (${(req.user as { sub: string }).sub}, 'package.reactivate', 'package', ${id},
                        ${sql.json({ is_active: true })})`;
      return { id: row.id, reactivated: true };
    });

  app.get("/api/areas", { preHandler: requirePermission("customer:read") },
    async () => {
      const rows = await sql`
        SELECT a.id, a.name, a.description, a.is_active, a.created_at,
               COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL)::int AS customer_count
          FROM areas a
          LEFT JOIN customers c ON c.area_id = a.id
         GROUP BY a.id
         ORDER BY a.name`;
      return { rows };
    });

  app.post("/api/areas", { preHandler: requirePermission("area:write") },
    async (req, reply) => {
      const parsed = areaSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid area", issues: parsed.error.issues });
      }
      const [row] = await sql`
        INSERT INTO areas (name, description)
        VALUES (${parsed.data.name}, ${parsed.data.description ?? null})
        RETURNING *`;
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                VALUES (${(req.user as { sub: string }).sub}, 'area.create', 'area', ${String(row!.id)},
                        ${sql.json(row as object)})`;
      return reply.code(201).send(row);
    });

  app.patch("/api/areas/:id", { preHandler: requirePermission("area:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = areaSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid update", issues: parsed.error.issues });
      }
      const [before] = await sql`SELECT * FROM areas WHERE id = ${Number(id)}`;
      if (!before) return reply.code(404).send({ error: "Area not found" });
      const a = parsed.data;
      const [after] = await sql`
        UPDATE areas SET
          name        = COALESCE(${a.name ?? null}, name),
          description = COALESCE(${a.description ?? null}, description),
          is_active   = COALESCE(${a.isActive ?? null}, is_active)
        WHERE id = ${Number(id)} RETURNING *`;
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
                VALUES (${(req.user as { sub: string }).sub}, 'area.update', 'area', ${id},
                        ${sql.json(before as object)}, ${sql.json(after as object)})`;
      return after;
    });
}
