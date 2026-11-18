import { pool, call, nodes, requireValue, uuid } from "./common.ts";
import type { IncomingMessage } from "node:http";
export async function gateway(
  method: string,
  path: string,
  body: Record<string, unknown>,
  request: IncomingMessage,
): Promise<unknown> {
  const parts = path.split("/");
  if (parts[1] === "transfers" && method === "GET") {
    const result = await pool.query(
      "SELECT city,source,target,old_version,stage FROM transfers WHERE id=$1",
      [uuid(parts[2])],
    );
    requireValue(result.rows[0], "transfer not found", 404);
    return result.rows[0];
  }
  const city = Number(parts[2]);
  const { rows } = await pool.query("SELECT * FROM placements WHERE city=$1", [city]);
  requireValue(rows[0], "city not found", 404);
  if (parts[1] === "placements" && method === "GET") return rows[0];
  requireValue(parts[1] === "cities" && parts[3] === "bookings", "unknown route", 404);
  if (method === "POST" && !parts[4]) body.id = uuid(request.headers["idempotency-key"]);
  return call(`${nodes[rows[0].node]}${path}`, method, method === "GET" ? undefined : body, {
    "x-route-version": String(rows[0].version),
  });
}
