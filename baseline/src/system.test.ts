import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { before, after, test } from "node:test";
const project = `taxi-baseline-check-${process.pid}`;
function compose(...args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "-p", project, "-f", "compose.yml", "-f", "compose.test.yml", ...args],
    {
      encoding: "utf8",
      timeout: 240000,
      env: { ...process.env, WEB_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function sql(service: string, statement: string): string {
  return compose(
    "exec",
    "-T",
    service,
    "psql",
    "-U",
    "postgres",
    "-d",
    "taxi",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    statement,
  );
}
let api: string, notifier: string;
type Trip = { id: number; status: string; price: number };
async function http<T = Trip>(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
    signal: AbortSignal.timeout(4000),
  };
  if (body !== undefined && method !== "GET") options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  return { status: response.status, headers: response.headers, data: (await response.json()) as T };
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  let last: unknown;
  const end = performance.now() + timeout;
  do {
    try {
      const value = await read();
      last = value;
      if (accept(value)) return value;
    } catch (error) {
      last = String(error);
    }
    await delay(150);
  } while (performance.now() < end);
  throw new Error(`condition timed out: ${JSON.stringify(last)}`);
}
async function create(key = randomUUID()) {
  const result = await http(
    `${api}/trips`,
    "POST",
    { passengerId: 1, pickupAddress: "Лесная, 10", destinationAddress: "Садовая, 5" },
    { "idempotency-key": key },
  );
  assert([200, 201].includes(result.status), JSON.stringify(result));
  return result.data;
}
async function view(id: number, status = "searching") {
  return until(
    () => http(`${api}/summary/trips/${id}`),
    (r) => r.status === 200 && r.data.status === status,
  );
}
async function delivered(id: number) {
  await until(
    async () => sql("db", `SELECT delivered_at IS NOT NULL FROM notification_jobs WHERE id=${id}`),
    (r) => r === "t",
  );
}
async function control(delayMs = 0, failRate = 0) {
  assert.equal((await http(`${notifier}/_control`, "POST", { delayMs, failRate })).status, 200);
}
let first: Trip;
before(() => {
  compose("build", "app");
  compose("up", "-d", "--wait");
  api = `http://${compose("port", "nginx", "8080")}`;
  notifier = `http://${compose("port", "notifications", "8080")}`;
});
after(() => {
  mkdirSync("reports", { recursive: true });
  try {
    writeFileSync(`reports/${project}.log`, compose("logs", "--no-color"));
  } finally {
    compose("down", "-v", "--remove-orphans", "--timeout", "2");
  }
});
test("the load balancer uses both unchanged monolith instances", async () => {
  const seen = new Set<string>();
  for (let n = 0; n < 8; n++) {
    const response = await http<{ instance: string }>(`${api}/health`);
    assert.equal(response.status, 200);
    seen.add(response.data.instance);
  }
  assert.deepEqual([...seen].sort(), ["app", "app2"]);
});
test("one creation reaches primary, replica, Kafka summary and notification owner", async () => {
  first = await create();
  await view(first.id);
  await delivered(first.id);
  const history = await until(
    () => http<Trip[]>(`${api}/passengers/1/trips`),
    (r) => r.status === 200 && r.data.some((t) => t.id === first.id),
  );
  assert.equal(history.headers.get("x-source"), "replica");
  assert.equal(sql("db", `SELECT count(*) FROM event_outbox WHERE trip_id=${first.id}`), "1");
  assert.equal((await http(`${api}/deliveries/${first.id}`)).status, 200);
});
test("idempotent replay creates one trip, one event and one notification job", async () => {
  const key = randomUUID();
  const a = await create(key),
    b = await create(key);
  assert.equal(a.id, b.id);
  assert.equal(sql("db", `SELECT count(*) FROM event_outbox WHERE trip_id=${a.id}`), "1");
  assert.equal(sql("db", `SELECT count(*) FROM notification_jobs WHERE id=${a.id}`), "1");
});
test("a rejected transaction leaves no outbox event or notification job", async () => {
  const before = sql(
    "db",
    "SELECT (SELECT count(*) FROM trips),(SELECT count(*) FROM event_outbox),(SELECT count(*) FROM notification_jobs)",
  );
  const rejected = await http(
    `${api}/trips`,
    "POST",
    { passengerId: 99999, pickupAddress: "A", destinationAddress: "B" },
    { "idempotency-key": randomUUID() },
  );
  assert(rejected.status >= 400);
  assert.equal(
    sql(
      "db",
      "SELECT (SELECT count(*) FROM trips),(SELECT count(*) FROM event_outbox),(SELECT count(*) FROM notification_jobs)",
    ),
    before,
  );
});
test("stopped consumer leaves a stale view while creation continues, then catches up", async () => {
  compose("stop", "consumer");
  const trip = await create();
  assert.equal((await http(`${api}/trips/${trip.id}`)).status, 200);
  assert.equal((await http(`${api}/summary/trips/${trip.id}`)).status, 404);
  assert.equal((await http(`${api}/summary/trips/${first.id}`)).status, 200);
  compose("start", "consumer");
  await view(trip.id);
});
test("creation persists work while Kafka is down and publication resumes", async () => {
  compose("stop", "kafka");
  const trip = await create();
  assert.equal(
    sql("db", `SELECT published_at IS NULL FROM event_outbox WHERE trip_id=${trip.id}`),
    "t",
  );
  compose("start", "kafka");
  await view(trip.id);
});
test("a failed notification is retried independently of the request", async () => {
  await control(0, 1);
  const started = performance.now();
  const trip = await create();
  assert(performance.now() - started < 3000);
  await view(trip.id);
  await until(
    async () => Number(sql("db", `SELECT attempts FROM notification_jobs WHERE id=${trip.id}`)),
    (n) => n > 0,
  );
  assert.equal(
    sql("db", `SELECT delivered_at IS NULL FROM notification_jobs WHERE id=${trip.id}`),
    "t",
  );
  await control();
  await delivered(trip.id);
});
test("a lost notification response survives worker restart with one receiver effect", async () => {
  await control(1500);
  const trip = await create();
  await until(
    () => http(`${api}/deliveries/${trip.id}`),
    (r) => r.status === 200,
  );
  compose("stop", "notification-worker");
  await control();
  compose("start", "notification-worker");
  await delivered(trip.id);
  assert.equal(
    sql("notifications-db", `SELECT count(*) FROM receipts WHERE trip_id=${trip.id}`),
    "1",
  );
  assert(
    Number(sql("notifications-db", `SELECT requests FROM receipts WHERE trip_id=${trip.id}`)) >= 2,
  );
});
test("replayed old events cannot revert an updated trip projection", async () => {
  const trip = await create();
  await view(trip.id);
  const oldest = sql("db", `SELECT min(id) FROM event_outbox WHERE trip_id=${trip.id}`);
  assert.equal((await http(`${api}/trips/${trip.id}/accept`, "POST", { driverId: 1 })).status, 200);
  await view(trip.id, "accepted");
  sql("db", `UPDATE event_outbox SET published_at=NULL WHERE id=${oldest}`);
  await until(
    async () =>
      Number(sql("summary-db", `SELECT deliveries FROM processed_events WHERE event_id=${oldest}`)),
    (n) => n >= 2,
  );
  assert.equal((await http(`${api}/summary/trips/${trip.id}`)).data.status, "accepted");
  compose("restart", "consumer");
  await view(trip.id, "accepted");
});
