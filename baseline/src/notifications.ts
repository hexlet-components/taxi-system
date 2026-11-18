import { setTimeout as delay } from "node:timers/promises";
import { pool, tx, loop, check, HttpError } from "./common.ts";
let control = { delayMs: 0, failRate: 0 };
export async function notifications(
  method: string,
  path: string,
  body: Record<string, unknown>,
  key: string | undefined,
): Promise<unknown> {
  if (path === "/_control" && method === "POST") {
    check(
      Number.isInteger(body.delayMs ?? 0) &&
        Number(body.delayMs ?? 0) >= 0 &&
        Number(body.delayMs ?? 0) <= 5000,
      "invalid delay",
    );
    check(
      body.failRate === undefined || body.failRate === 0 || body.failRate === 1,
      "failRate must be 0 or 1",
    );
    control = { delayMs: Number(body.delayMs ?? 0), failRate: Number(body.failRate ?? 0) };
    return control;
  }
  if (path.startsWith("/deliveries/") && method === "GET") {
    const { rows } = await pool.query("SELECT * FROM receipts WHERE trip_id=$1", [
      path.split("/")[2],
    ]);
    check(rows[0], "notification not yet accepted", 404);
    return rows[0];
  }
  check(path === "/notify" && method === "POST", "not found", 404);
  check(key, "missing key");
  check(Number.isSafeInteger(body.tripId) && Number(body.tripId) > 0, "invalid tripId");
  const fault = { ...control };
  if (fault.failRate === 1) throw new HttpError(503, "injected notification failure");
  const receipt = await tx(async (db) => {
    await db.query(
      "INSERT INTO receipts (operation_key,trip_id,payload) VALUES ($1,$2,$3) ON CONFLICT (operation_key) DO UPDATE SET requests=receipts.requests+1",
      [key, body.tripId, body],
    );
    const { rows } = await db.query(
      "SELECT *,payload=$2::jsonb AS same FROM receipts WHERE operation_key=$1",
      [key, body],
    );
    check(rows[0].same, "idempotency key reused with different input", 409);
    return rows[0];
  });
  // The receipt is durable before the response, so a timeout leaves an unknown outcome.
  await delay(fault.delayMs);
  return { accepted: true, key: receipt.operation_key };
}
export async function notify(): Promise<never> {
  return loop(async () => {
    await tx(async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM notification_jobs WHERE delivered_at IS NULL AND next_attempt<=now() AND attempts<20 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      if (!rows[0]) return;
      const job = rows[0];
      try {
        const response = await fetch("http://notifications:8080/notify", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": job.operation_key },
          body: JSON.stringify(job.payload),
          signal: AbortSignal.timeout(500),
        });
        const result = await response.json();
        check(response.ok && result.accepted === true, "notification not confirmed", 503);
        await db.query(
          "UPDATE notification_jobs SET delivered_at=now(),last_error=NULL WHERE id=$1",
          [job.id],
        );
      } catch (error) {
        await db.query(
          "UPDATE notification_jobs SET attempts=attempts+1,last_error=$2,next_attempt=now()+interval '0.5 seconds' WHERE id=$1",
          [job.id, String(error)],
        );
      }
    });
  });
}
