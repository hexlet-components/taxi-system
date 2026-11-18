#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

type Row = { operation_id: string; driver_id: number; generation: number };
type Event = {
  action: string;
  id?: string;
  driver?: number;
  result?: string;
  rows?: Row[];
  seconds?: number;
  failoverSeconds?: number;
  generation?: number;
  exit?: number;
  processState?: string;
  postgresStillRunning?: boolean;
};
type History = {
  name: string;
  rows: Row[];
  generation?: number;
  durableCoordinatorGeneration?: number;
  events: Event[];
};
const directory = resolve(process.argv[2] ?? "reports/failover");
const criteria = JSON.parse(readFileSync(new URL("./criteria.json", import.meta.url), "utf8"));

// This checker reads only saved client histories and SQL snapshots. It never uses process logs.
function verify(history: History): string {
  const { rows, events, name } = history;
  assert.equal(new Set(rows.map((r) => r.operation_id)).size, rows.length, "duplicate effect");
  assert.equal(new Set(rows.map((r) => r.driver_id)).size, rows.length, "driver assigned twice");
  assert(
    events.some((e) => e.action === "ready" && e.seconds! <= criteria.startupSeconds),
    "startup budget exceeded",
  );
  for (const event of events.filter((e) => e.action === "new-primary")) {
    assert(event.failoverSeconds! <= criteria.failoverSeconds, "failover budget exceeded");
  }
  const acknowledged = [
    ...new Set(
      events
        .filter((e) => e.action === "ack" || (e.action === "old-write" && e.result === "accepted"))
        .map((e) => e.id!),
    ),
  ];
  const present = new Set(rows.map((r) => r.operation_id));
  const missing = acknowledged.filter((id) => !present.has(id));
  if (name.startsWith("sql-fencing-")) {
    assert.equal(history.generation, 3);
    assert.equal(history.durableCoordinatorGeneration, 3);
    assert(events.some((e) => e.action === "holder-paused" && e.generation === 1));
    assert(events.some((e) => e.action === "activate" && e.generation === 2));
    assert.deepEqual(rows, [{ operation_id: "new", driver_id: 1, generation: 2 }]);
    assert(events.some((e) => e.action === "old-result" && e.result === "stale"));
    assert(events.some((e) => e.action === "restart-old-result" && e.result === "stale"));
    assert(events.some((e) => e.action === "reacquire-after-restart" && e.generation === 3));
    assert.equal(missing.length, 0);
    return "safe-fencing";
  }
  assert(
    events.some(
      (e) =>
        e.action === "former-primary-is-replica" && JSON.stringify(e.rows) === JSON.stringify(rows),
    ),
    "former primary not reconciled",
  );
  if (name.startsWith("async-loss-")) {
    const blocked = events.findIndex((e) => e.action === "replication-blocked");
    assert(blocked >= 0);
    assert(events.findIndex((e) => e.id === "gap-0") > blocked);
    assert.deepEqual(missing.sort(), ["gap-0", "gap-1", "gap-2"]);
    return "acknowledged-data-loss";
  }
  if (name.startsWith("sync-network-")) {
    assert.deepEqual(missing, []);
    assert(events.some((e) => e.action === "old-connection-closed" && e.exit !== 0));
    assert(events.some((e) => e.action === "old-write" && e.result === "rejected"));
    return "safe-with-running-controller";
  }
  assert(name.startsWith("controller-pause-"));
  assert.deepEqual(missing, ["stale-writer"]);
  assert(
    events.some(
      (e) =>
        e.action === "patroni-paused" && e.processState === "T" && e.postgresStillRunning === true,
    ),
  );
  assert(events.some((e) => e.action === "old-write" && e.result === "accepted"));
  assert(
    events.some(
      (e) =>
        e.action === "old-snapshot" && e.rows?.some((row) => row.operation_id === "stale-writer"),
    ),
  );
  assert(!present.has("stale-writer"));
  return "unsafe-stale-primary";
}

const files = readdirSync(directory)
  .filter((name) => /^(sql-fencing|sync-network|async-loss|controller-pause)-\d+\.json$/.test(name))
  .sort();
assert.equal(files.length, criteria.repeats * 4, "incomplete pilot");
for (const file of files) {
  const history: History = JSON.parse(readFileSync(resolve(directory, file), "utf8"));
  assert.equal(file, `${history.name}.json`);
  console.log(`${history.name}: ${verify(history)}`);
  // Negative controls prove that lost confirmations and duplicates cannot pass as successful executions.
  const duplicate = structuredClone(history);
  duplicate.rows.push(duplicate.rows[0]!);
  assert.throws(() => verify(duplicate), /duplicate effect/);
  const invariant = structuredClone(history);
  invariant.rows.push({
    operation_id: "invariant-violation",
    driver_id: invariant.rows[0]!.driver_id,
    generation: 0,
  });
  assert.throws(() => verify(invariant), /driver assigned twice/);
  if (!history.name.startsWith("async-loss")) {
    const lost = structuredClone(history);
    lost.rows = lost.rows.filter(
      (row) => row.operation_id !== "before" && row.operation_id !== "new",
    );
    assert.throws(() => verify(lost));
  }
}
for (const kind of ["sql-fencing", "sync-network", "async-loss", "controller-pause"]) {
  for (let repeat = 1; repeat <= criteria.repeats; repeat++)
    assert(files.includes(`${kind}-${repeat}.json`));
}
console.log(
  `PASS: ${files.length} histories and negative controls; intentionally unsafe categories were detected`,
);
