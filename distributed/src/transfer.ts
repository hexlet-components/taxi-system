import { randomUUID } from "node:crypto";
import { pool, tx, call, nodes, requireValue, integer, uuid } from "./common.ts";
import type { PoolClient } from "pg";
import type { Snapshot } from "./shard.ts";
export type Transfer = {
  id: string;
  city: number;
  source: string;
  target: string;
  old_version: number;
  stage: string;
  snapshot: Snapshot | null;
};
export type Lease = { generation: number; owner: string };
export async function acquire(owner: string, ttlMs = 30_000): Promise<Lease> {
  const { rows } = await pool.query(
    "UPDATE controller SET generation=generation+1,owner=$1,expires_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=1 AND expires_at < clock_timestamp() RETURNING generation,owner",
    [owner, integer(ttlMs)],
  );
  requireValue(rows[0], "controller lease is still held");
  return rows[0];
}
async function leased<T>(lease: Lease, operation: (db: PoolClient) => Promise<T>): Promise<T> {
  return tx(async (db) => {
    const { rows } = await db.query("SELECT * FROM controller WHERE id=1 FOR UPDATE");
    requireValue(
      rows[0].generation === lease.generation && rows[0].owner === lease.owner,
      "stale controller",
    );
    const valid = await db.query(
      "SELECT expires_at > clock_timestamp() AS valid FROM controller WHERE id=1",
    );
    requireValue(valid.rows[0].valid, "controller lease expired");
    return operation(db);
  });
}
export async function release(lease: Lease): Promise<void> {
  await pool.query(
    "UPDATE controller SET expires_at='-infinity' WHERE id=1 AND generation=$1 AND owner=$2",
    [lease.generation, lease.owner],
  );
}
export async function begin(
  city: number,
  target: string,
  lease: Lease,
  id = randomUUID(),
): Promise<Transfer> {
  requireValue(nodes[target], "unknown target", 400);
  return leased(lease, async (db) => {
    const { rows } = await db.query("SELECT * FROM placements WHERE city=$1 FOR UPDATE", [
      integer(city),
    ]);
    requireValue(rows[0] && rows[0].node !== target, "source and target must differ");
    return (
      await db.query(
        "INSERT INTO transfers (id,city,source,target,old_version,stage) VALUES ($1,$2,$3,$4,$5,'intent') RETURNING *",
        [uuid(id), city, rows[0].node, target, rows[0].version],
      )
    ).rows[0];
  });
}
export async function readTransfer(id: string): Promise<Transfer> {
  const { rows } = await pool.query("SELECT * FROM transfers WHERE id=$1", [uuid(id)]);
  requireValue(rows[0], "transfer not found", 404);
  return rows[0];
}
export async function resume(id: string, lease: Lease, stopAfter?: string): Promise<Transfer> {
  let transfer = await readTransfer(id);
  const send = (node: string, action: string, extra: Record<string, unknown> = {}) =>
    call(`${nodes[node]}/control/${action}`, "POST", {
      city: transfer.city,
      id,
      generation: lease.generation,
      ...extra,
    });
  await leased(lease, async () => undefined);
  for (const node of [transfer.source, transfer.target]) await send(node, "fence");
  const advance = async (stage: string, snapshot?: Snapshot) => {
    await leased(lease, async (db) => {
      const result = await db.query(
        "UPDATE transfers SET stage=$3,snapshot=COALESCE($4::jsonb,snapshot) WHERE id=$1 AND stage=$2",
        [id, transfer.stage, stage, snapshot ? JSON.stringify(snapshot) : null],
      );
      requireValue(result.rowCount === 1, "transfer stage changed");
    });
    transfer = await readTransfer(id);
    if (stage === stopAfter) throw new Error(`controller stopped after ${stage}; resume ${id}`);
  };
  if (transfer.stage === "intent") {
    const snapshot = (await send(transfer.source, "freeze", {
      version: transfer.old_version,
    })) as unknown as Snapshot;
    await advance("frozen", snapshot);
  }
  if (transfer.stage === "frozen") {
    await send(transfer.target, "install", {
      version: transfer.old_version + 1,
      snapshot: transfer.snapshot,
    });
    await advance("copied");
  }
  if (transfer.stage === "copied") {
    await leased(lease, async (db) => {
      const result = await db.query(
        "UPDATE placements SET node=$4,version=version+1 WHERE city=$1 AND node=$2 AND version=$3",
        [transfer.city, transfer.source, transfer.old_version, transfer.target],
      );
      requireValue(result.rowCount === 1, "placement changed");
      await db.query("UPDATE transfers SET stage='published' WHERE id=$1", [id]);
    });
    transfer = await readTransfer(id);
    if (stopAfter === "published")
      throw new Error(`controller stopped after published; resume ${id}`);
  }
  if (transfer.stage === "published") {
    await send(transfer.target, "open");
    await advance("done");
  }
  return transfer;
}
if (import.meta.main) {
  const [command, value, target] = process.argv.slice(2);
  const lease = await acquire(randomUUID());
  try {
    const transfer =
      command === "start" ? await begin(Number(value), target, lease) : await readTransfer(value);
    console.log(JSON.stringify(await resume(transfer.id, lease, process.env.STOP_AFTER), null, 2));
  } finally {
    await release(lease);
    await pool.end();
  }
}
