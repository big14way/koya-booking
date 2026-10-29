import pg from "pg";

// Return timestamptz columns as Date and bigint (seq) as string.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
});

export type Tx = pg.PoolClient;

/** Run fn inside a transaction. Return { rollback: true } from fn to roll back instead of commit. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T & { rollback?: boolean }>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(result.rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
