import { setTimeout as delay } from "node:timers/promises";
import { pool, tx, integer, requireValue, HttpError } from "./common.ts";
let fault: { action: string; delay_ms: number; unavailable: boolean } = {
  action: "reserve",
  delay_ms: 0,
  unavailable: false,
};
let inFlight = 0;
export async function payments(
  method: string,
  path: string,
  body: Record<string, unknown>,
  budget: number,
): Promise<unknown> {
  if (path === "/admin/fault" && method === "POST") {
    requireValue(["reserve", "release"].includes(String(body.action)), "unknown action", 400);
    const ms = Number(body.delay_ms ?? 0);
    requireValue(Number.isInteger(ms) && ms >= 0 && ms <= 5000, "invalid delay", 400);
    fault = { action: String(body.action), delay_ms: ms, unavailable: body.unavailable === true };
    return fault;
  }
  const parts = path.split("/");
  requireValue(parts[1] === "reservations" && parts[2], "unknown route", 404);
  const id = decodeURIComponent(parts[2]);
  if (method === "GET")
    return (
      (await pool.query("SELECT * FROM reservations WHERE id=$1", [id])).rows[0] ?? {
        state: "absent",
      }
    );
  requireValue(
    method === "POST" && ["reserve", "release"].includes(parts[3]),
    "unknown operation",
    404,
  );
  requireValue(Number.isFinite(budget) && budget > 0, "request budget expired", 408);
  requireValue(inFlight < 8, "payment capacity exhausted", 503);
  const action = parts[3],
    amount = integer(body.amount);
  const injected = { ...fault };
  if (injected.action === action && injected.unavailable)
    throw new HttpError(503, "injected payment failure");
  inFlight += 1;
  try {
    const result = await tx(async (db) => {
      // Release creates a terminal tombstone even if reserve has not arrived yet.
      await db.query(
        "INSERT INTO reservations (id,amount,state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, amount, action === "reserve" ? "reserved" : "released"],
      );
      const { rows } = await db.query("SELECT * FROM reservations WHERE id=$1 FOR UPDATE", [id]);
      requireValue(rows[0].amount === amount, "operation amount changed");
      if (action === "release")
        await db.query("UPDATE reservations SET state='released' WHERE id=$1", [id]);
      return (await db.query("SELECT * FROM reservations WHERE id=$1", [id])).rows[0];
    });
    // Delay starts after COMMIT. A caller's timeout cannot roll back this effect.
    if (injected.action === action && injected.delay_ms) await delay(injected.delay_ms);
    return result;
  } finally {
    inFlight -= 1;
  }
}
