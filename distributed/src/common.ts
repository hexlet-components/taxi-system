import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import type { PoolClient } from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 1000,
  statement_timeout: 2000,
});
export const nodes: Record<string, string> = {
  "node-a": process.env.NODE_A_URL ?? "http://node-a:8080",
  "node-b": process.env.NODE_B_URL ?? "http://node-b:8080",
};
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export function integer(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && Number(value) > 0, "positive integer required", 400);
  return Number(value);
}
export function uuid(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    "UUID required",
    400,
  );
  return value;
}
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
export async function call<T = Record<string, unknown>>(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  timeout = 1000,
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined && method !== "GET") options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, String(result.error));
  return result as T;
}
export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    requireValue(body.length < 2_000_000, "body too large", 413);
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}
export function serve(
  handler: (
    method: string,
    path: string,
    body: Record<string, unknown>,
    request: IncomingMessage,
  ) => Promise<unknown>,
): void {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://local").pathname;
      const result =
        path === "/health"
          ? (await pool.query("SELECT 1"), { ready: true })
          : await handler(request.method ?? "GET", path, await readBody(request), request);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof pg.DatabaseError && ["23505", "23503"].includes(error.code ?? "")
            ? 409
            : 503;
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.requestTimeout = 5000;
  server.listen(8080, "0.0.0.0");
}
