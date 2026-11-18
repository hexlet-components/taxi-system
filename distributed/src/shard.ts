import { createHash } from "node:crypto";
import { pool, tx, call, integer, uuid, requireValue, HttpError } from "./common.ts";
import type { PoolClient } from "pg";

type Row = Record<string, unknown>;
export type Snapshot = { drivers: Row[]; bookings: Row[]; outbox: Row[] };
export function snapshotHash(snapshot: Snapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify(snapshot, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
}
async function readSnapshot(db: PoolClient, city: number): Promise<Snapshot> {
  const snapshot = {} as Snapshot;
  for (const table of tables)
    snapshot[table] = (
      await db.query(
        `SELECT * FROM ${table} WHERE city=$1 ORDER BY ${table === "outbox" ? "booking, action" : "id"}`,
        [city],
      )
    ).rows;
  return snapshot;
}
const tables = ["drivers", "bookings", "outbox"] as const;
const node = process.env.NODE_NAME;

export async function seed(): Promise<void> {
  for (const city of [1, 2]) {
    const active = node === (city === 1 ? "node-a" : "node-b");
    await pool.query(
      "INSERT INTO shard_control (city, version, active) VALUES ($1,1,$2) ON CONFLICT DO NOTHING",
      [city, active],
    );
    // Seed only an empty initial owner. Restarts never replace moved data.
    if (active)
      await pool.query(
        "INSERT INTO drivers (city,id) SELECT $1, n FROM generate_series(1,20) AS n WHERE EXISTS (SELECT 1 FROM shard_control WHERE city=$1 AND transfer_id IS NULL) ON CONFLICT DO NOTHING",
        [city],
      );
  }
}
async function guard(db: PoolClient, city: number, version: number): Promise<void> {
  const { rows } = await db.query("SELECT * FROM shard_control WHERE city=$1 FOR SHARE", [city]);
  requireValue(rows[0]?.active && rows[0].version === version, "stale route or frozen shard");
}
async function booking(db: PoolClient, city: number, id: string): Promise<Row> {
  const { rows } = await db.query("SELECT * FROM bookings WHERE city=$1 AND id=$2 FOR UPDATE", [
    city,
    id,
  ]);
  requireValue(rows[0], "booking not found", 404);
  return rows[0];
}
async function enqueue(db: PoolClient, city: number, id: string, action: string): Promise<void> {
  await db.query(
    "INSERT INTO outbox (city,booking,action) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [city, id, action],
  );
}
async function control(action: string, body: Row): Promise<unknown> {
  const city = integer(body.city);
  const generation = integer(body.generation);
  const id = uuid(body.id);
  const intent =
    action !== "fence"
      ? await call<{
          city: number;
          source: string;
          target: string;
          old_version: number;
          stage: string;
        }>(`http://gateway:8080/transfers/${id}`)
      : undefined;
  if (intent) requireValue(intent.city === city, "different shard");
  // Opening requires the published placement. A map update alone never opens a writer.
  const placement =
    action === "open"
      ? await call<{ node: string; version: number }>(`http://gateway:8080/placements/${city}`)
      : undefined;
  return tx(async (db) => {
    const { rows } = await db.query("SELECT * FROM shard_control WHERE city=$1 FOR UPDATE", [city]);
    const current = rows[0];
    requireValue(current, "unknown shard", 404);
    if (action === "fence") {
      requireValue(generation >= current.generation, "stale controller");
      await db.query("UPDATE shard_control SET generation=$2 WHERE city=$1", [city, generation]);
      return { generation };
    }
    requireValue(generation === current.generation, "stale controller");
    if (action === "freeze") {
      requireValue(
        intent && intent.source === node && ["intent", "frozen"].includes(intent.stage),
        "source not authorized",
      );
      requireValue(current.active || current.transfer_id === id, "different transfer");
      requireValue(current.version === body.version, "stale version");
      await db.query(
        "UPDATE shard_control SET active=false, transfer_id=$2,snapshot_hash=NULL WHERE city=$1",
        [city, id],
      );
      return readSnapshot(db, city);
    }
    if (action === "install") {
      const snapshot = body.snapshot as Snapshot;
      requireValue(
        snapshot && tables.every((table) => Array.isArray(snapshot[table])),
        "invalid snapshot",
        400,
      );
      requireValue(
        tables.every((table) => snapshot[table].every((row) => row.city === city)),
        "snapshot belongs to another shard",
        400,
      );
      const hash = snapshotHash(snapshot);
      if (current.transfer_id === id && current.snapshot_hash !== null) {
        requireValue(
          current.transfer_id === id && current.snapshot_hash === hash,
          "different snapshot",
        );
        return { hash }; // Even after open, an acknowledged install never rewrites data.
      }
      requireValue(
        intent && intent.target === node && intent.stage === "frozen",
        "target not authorized",
      );
      requireValue(
        !current.active &&
          body.version === intent.old_version + 1 &&
          Number(body.version) > current.version,
        "target already in use",
      );
      for (const table of [...tables].reverse())
        await db.query(`DELETE FROM ${table} WHERE city=$1`, [city]);
      for (const table of tables) {
        // The schema supplies column names; user JSON never becomes SQL identifiers.
        await db.query(
          `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
          [JSON.stringify(snapshot[table])],
        );
      }
      requireValue(
        snapshotHash(await readSnapshot(db, city)) === hash,
        "snapshot verification failed",
      );
      await db.query(
        "UPDATE shard_control SET version=$2,transfer_id=$3,snapshot_hash=$4 WHERE city=$1",
        [city, body.version, id, hash],
      );
      return { hash };
    }
    requireValue(action === "open", "unknown control operation", 404);
    requireValue(
      placement &&
        placement.node === node &&
        placement.version === current.version &&
        current.transfer_id === id &&
        current.snapshot_hash,
      "placement not published",
    );
    await db.query("UPDATE shard_control SET active=true WHERE city=$1", [city]);
    return { active: true };
  });
}
export async function shard(
  method: string,
  path: string,
  body: Row,
  version: number,
): Promise<unknown> {
  if (method === "POST" && path.startsWith("/control/")) return control(path.split("/")[2], body);
  if (method === "GET" && path === "/work") {
    return (
      await pool.query(
        "SELECT o.*, b.amount, s.version FROM outbox o JOIN bookings b ON (b.city,b.id)=(o.city,o.booking) JOIN shard_control s ON s.city=o.city WHERE s.active AND NOT o.done AND o.attempts < 20 AND o.next_attempt <= now() ORDER BY o.next_attempt LIMIT 10",
      )
    ).rows;
  }
  const parts = path.split("/");
  requireValue(parts[1] === "cities" && parts[3] === "bookings", "unknown route", 404);
  const city = integer(Number(parts[2]));
  const id = parts[4] ? uuid(parts[4]) : uuid(body.id);
  return tx(async (db) => {
    await guard(db, city, version);
    if (method === "POST" && !parts[4]) {
      const driver = integer(body.driver),
        amount = integer(body.amount);
      // Lock driver first for both concurrent requests and retries of the same key.
      const { rows } = await db.query(
        "SELECT version FROM drivers WHERE city=$1 AND id=$2 FOR UPDATE",
        [city, driver],
      );
      requireValue(rows[0], "driver not found", 404);
      const previous = await db.query("SELECT * FROM bookings WHERE city=$1 AND id=$2", [city, id]);
      if (previous.rows[0]) {
        requireValue(
          previous.rows[0].driver === driver && previous.rows[0].amount === amount,
          "idempotency key reused with different input",
        );
        return previous.rows[0];
      }
      requireValue(rows[0].version === integer(body.driver_version), "driver version conflict");
      await db.query(
        "INSERT INTO bookings (city,id,driver,amount,state) VALUES ($1,$2,$3,$4,'reserving')",
        [city, id, driver, amount],
      );
      await db.query("UPDATE drivers SET version=version+1 WHERE city=$1 AND id=$2", [
        city,
        driver,
      ]);
      await enqueue(db, city, id, "reserve");
      return booking(db, city, id);
    }
    const current = await booking(db, city, id);
    if (method === "GET") return current;
    if (parts[5] === "cancel") {
      requireValue(current.state !== "completed", "completed booking requires a refund process");
      if (current.state !== "cancelled") {
        await db.query(
          "UPDATE bookings SET cancel_requested=true,state='compensating' WHERE city=$1 AND id=$2",
          [city, id],
        );
        await enqueue(db, city, id, "release");
      }
    } else if (parts[5] === "complete") {
      requireValue(
        current.state === "confirmed" || current.state === "completed",
        "booking not confirmed",
      );
      await db.query("UPDATE bookings SET state='completed' WHERE city=$1 AND id=$2", [city, id]);
    } else if (parts[5] === "result") {
      requireValue(body.action === "reserve" || body.action === "release", "unknown action", 400);
      const { rows } = await db.query(
        "SELECT * FROM outbox WHERE city=$1 AND booking=$2 AND action=$3 FOR UPDATE",
        [city, id, body.action],
      );
      requireValue(rows[0], "unknown command");
      if (rows[0].done) return current;
      if (body.error) {
        await db.query(
          "UPDATE outbox SET attempts=attempts+1,last_error=$4,next_attempt=now()+interval '0.3 seconds' WHERE city=$1 AND booking=$2 AND action=$3",
          [city, id, body.action, String(body.error)],
        );
        if (rows[0].attempts + 1 >= 20)
          await db.query(
            "UPDATE bookings SET state='blocked' WHERE city=$1 AND id=$2 AND state NOT IN ('cancelled','completed')",
            [city, id],
          );
      } else {
        requireValue(
          body.payment_state === "reserved" || body.payment_state === "released",
          "invalid payment result",
        );
        requireValue(
          body.action !== "release" || body.payment_state === "released",
          "release not confirmed",
        );
        await db.query(
          "UPDATE outbox SET done=true,last_error=NULL WHERE city=$1 AND booking=$2 AND action=$3",
          [city, id, body.action],
        );
        if (body.action === "release") {
          await db.query(
            "UPDATE bookings SET state='cancelled' WHERE city=$1 AND id=$2 AND cancel_requested",
            [city, id],
          );
        } else if (!current.cancel_requested) {
          requireValue(body.payment_state === "reserved", "reservation already closed");
          await db.query("UPDATE bookings SET state='confirmed' WHERE city=$1 AND id=$2", [
            city,
            id,
          ]);
        }
      }
    } else if (parts[5] === "retry") {
      await db.query(
        "UPDATE outbox SET attempts=0,last_error=NULL,next_attempt=now() WHERE city=$1 AND booking=$2 AND NOT done",
        [city, id],
      );
      if (current.state === "blocked")
        await db.query(
          "UPDATE bookings SET state=CASE WHEN cancel_requested THEN 'compensating' ELSE 'reserving' END WHERE city=$1 AND id=$2",
          [city, id],
        );
    } else throw new HttpError(404, "unknown operation");
    return booking(db, city, id);
  });
}
