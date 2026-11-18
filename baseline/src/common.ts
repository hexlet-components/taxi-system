import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { PoolClient } from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 1000,
  statement_timeout: 3000,
});
export async function tx<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function loop(run: () => Promise<void>): Promise<never> {
  for (;;) {
    try {
      await run();
    } catch (error) {
      console.error(String(error));
    }
    await delay(200);
  }
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function check(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new HttpError(status, message);
}
export function serve(
  handler: (
    method: string,
    path: string,
    body: Record<string, unknown>,
    key: string | undefined,
  ) => Promise<unknown>,
): void {
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += String(chunk);
        check(text.length < 65536, "body too large", 413);
      }
      const body: unknown = text ? JSON.parse(text) : {};
      check(body && typeof body === "object" && !Array.isArray(body), "JSON object required");
      const path = new URL(req.url ?? "/", "http://local").pathname;
      const result =
        path === "/health"
          ? (await pool.query("SELECT 1"), { ready: true })
          : await handler(
              req.method ?? "GET",
              path,
              body as Record<string, unknown>,
              typeof req.headers["idempotency-key"] === "string"
                ? req.headers["idempotency-key"]
                : undefined,
            );
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      res
        .writeHead(error instanceof HttpError ? error.status : 503, {
          "content-type": "application/json",
        })
        .end(JSON.stringify({ error: String(error) }));
    }
  });
  server.requestTimeout = 5000;
  server.listen(8080, "0.0.0.0");
}
