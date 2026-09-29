import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { __pool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.__pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__pool = new Pool({ connectionString: url });
  }
  return globalForDb.__pool;
}

export function makeDb(pool: Pool) {
  return drizzle(pool, { schema });
}
export type Db = ReturnType<typeof makeDb>;

export function getDb(): Db {
  return makeDb(getPool());
}
