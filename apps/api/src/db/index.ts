import postgres from "postgres";

/**
 * Single pool, sized for the Ampere A1's memory budget. Postgres connections
 * cost roughly 10 MB each and the API, worker and scheduler share one server,
 * so keep each side modest rather than defaulting to 10 apiece.
 */
export function createSql(url = requireEnv("DATABASE_URL")) {
  return postgres(url, {
    max: Number(process.env.PG_POOL_MAX ?? 8),
    idle_timeout: 30,
    connect_timeout: 10,
    // Dates come back as plain "YYYY-MM-DD" strings, never JS Date objects,
    // so a timezone can never be silently applied to a billing date.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    onnotice: () => {},
  });
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export type Sql = ReturnType<typeof createSql>;
