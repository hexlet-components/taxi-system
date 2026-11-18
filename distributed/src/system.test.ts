import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { before, after, test } from "node:test";

const project = `taxi-check-${process.pid}`;
function compose(...args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "-p", project, "-f", "compose.yml", "-f", "compose.test.yml", ...args],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, WEB_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function address(service: string, port = "8080"): string {
  return `http://${compose("port", service, port)}`;
}
let gateway: string, payments: string;
let common: typeof import("./common.ts");
let controller: typeof import("./transfer.ts");
const accepted = new Map<string, number>();
type Booking = { id: string; city: number; state: string; cancel_requested: boolean };
async function http<T = Booking>(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T }> {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
    signal: AbortSignal.timeout(4000),
  };
  if (body !== undefined && method !== "GET") options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  return { status: response.status, data: (await response.json()) as T };
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 12_000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  let last: T | undefined;
  do {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch {
      // During an intentional restart the socket may close before readiness returns.
    }
    await delay(80);
  } while (performance.now() < deadline);
  throw new Error(`condition timed out: ${JSON.stringify(last)}`);
}
function path(city: number, id: string): string {
  return `${gateway}/cities/${city}/bookings/${id}`;
}
async function create(city: number, driver: number, id = randomUUID(), version = 1) {
  const result = await http(
    `${gateway}/cities/${city}/bookings`,
    "POST",
    { driver, amount: 900, driver_version: version },
    { "idempotency-key": id },
  );
  if (result.status === 200) accepted.set(id, city);
  return result;
}
async function state(city: number, id: string, expected: string) {
  return until(
    () => http(path(city, id)),
    (result) => result.status === 200 && result.data.state === expected,
  );
}
async function fault(action = "reserve", delay_ms = 0, unavailable = false) {
  assert.equal(
    (await http(`${payments}/admin/fault`, "POST", { action, delay_ms, unavailable })).status,
    200,
  );
}
async function reservation(city: number, id: string) {
  return http<{ state: string }>(`${payments}/reservations/${city}-${id}`);
}

before(async () => {
  compose("up", "-d", "--build", "--wait");
  gateway = address("gateway");
  payments = address("payments");
  process.env.DATABASE_URL = `postgres://postgres:local-demo-only@${compose("port", "coordinator", "5432")}/taxi`;
  process.env.NODE_A_URL = address("node-a");
  process.env.NODE_B_URL = address("node-b");
  common = await import("./common.ts");
  controller = await import("./transfer.ts");
});
after(async () => {
  mkdirSync("reports", { recursive: true });
  writeFileSync(`reports/${project}.log`, compose("logs", "--no-color"));
  if (common) await common.pool.end();
  compose("down", "-v", "--remove-orphans", "--timeout", "2");
});

test("both cities route to independent owners and confirm a booking", async () => {
  for (const city of [1, 2]) {
    const result = await create(city, 1);
    assert.equal(result.status, 200);
    await state(city, result.data.id, "confirmed");
    assert.equal((await reservation(city, result.data.id)).data.state, "reserved");
  }
});
test("idempotency preserves one booking and rejects changed input", async () => {
  const id = randomUUID();
  assert.equal((await create(1, 2, id)).status, 200);
  await state(1, id, "confirmed");
  assert.equal((await create(1, 2, id)).data.id, id);
  const mismatch = await http(
    `${gateway}/cities/1/bookings`,
    "POST",
    { driver: 2, amount: 901, driver_version: 1 },
    { "idempotency-key": id },
  );
  assert.equal(mismatch.status, 409);
  await http(`${path(1, id)}/cancel`, "POST", {});
  await state(1, id, "cancelled");
  assert.equal((await create(1, 2, id)).data.state, "cancelled");
});
test("two requests cannot assign one driver at the same version", async () => {
  const results = await Promise.all([create(1, 3), create(1, 3)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});
test("outbox survives a stopped worker and a restarted shard", async () => {
  compose("stop", "worker");
  const result = await create(1, 4);
  assert.equal(result.data.state, "reserving");
  compose("restart", "node-a");
  common.nodes["node-a"] = address("node-a");
  compose("start", "worker");
  await state(1, result.data.id, "confirmed");
});
test("a payment committed before timeout is recovered after orchestrator restart", async () => {
  await fault("reserve", 1500);
  const result = await create(1, 5);
  await until(
    () => reservation(1, result.data.id),
    (r) => r.data.state === "reserved",
  );
  assert.equal((await http(path(1, result.data.id))).data.state, "reserving");
  compose("stop", "worker");
  compose("restart", "node-a");
  common.nodes["node-a"] = address("node-a");
  await fault();
  compose("start", "worker");
  await state(1, result.data.id, "confirmed");
});
test("cancellation wins over late reserve and closes the reservation", async () => {
  await fault("reserve", 1500);
  const result = await create(1, 6);
  await until(
    () => reservation(1, result.data.id),
    (r) => r.data.state === "reserved",
  );
  assert.equal(
    (await http(`${path(1, result.data.id)}/cancel`, "POST", {})).data.cancel_requested,
    true,
  );
  await state(1, result.data.id, "cancelled");
  await fault();
  // Deliver a delayed reserve result explicitly after completed compensation.
  const late = await http(
    `${common.nodes["node-a"]}/cities/1/bookings/${result.data.id}/result`,
    "POST",
    { action: "reserve", payment_state: "reserved" },
    { "x-route-version": "1" },
  );
  assert.equal(late.data.state, "cancelled");
  assert.equal((await reservation(1, result.data.id)).data.state, "released");
});
test("unconfirmed release keeps compensation pending and restart resumes it", async () => {
  const result = await create(1, 7);
  await state(1, result.data.id, "confirmed");
  await fault("release", 0, true);
  await http(`${path(1, result.data.id)}/cancel`, "POST", {});
  await delay(500);
  assert.equal((await http(path(1, result.data.id))).data.state, "compensating");
  assert.equal((await reservation(1, result.data.id)).data.state, "reserved");
  compose("restart", "worker");
  await fault();
  await state(1, result.data.id, "cancelled");
});
test("release before reserve is terminal, with immutable payment input", async () => {
  const url = `${payments}/reservations/${randomUUID()}`;
  assert.equal(
    (await http<{ state: string }>(`${url}/release`, "POST", { amount: 900 })).data.state,
    "released",
  );
  assert.equal(
    (await http<{ state: string }>(`${url}/reserve`, "POST", { amount: 900 })).data.state,
    "released",
  );
  assert.equal((await http(`${url}/reserve`, "POST", { amount: 901 })).status, 409);
});
test("bounded retries become blocked and explicit retry restores progress", async () => {
  await fault("reserve", 0, true);
  const result = await create(1, 8);
  await state(1, result.data.id, "blocked");
  assert.equal((await reservation(1, result.data.id)).data.state, "absent");
  await fault();
  assert.equal((await http(`${path(1, result.data.id)}/retry`, "POST", {})).status, 200);
  await state(1, result.data.id, "confirmed");
});
test("interrupted transfer resumes; stale controllers and old routes cannot write", async () => {
  const baseline = await Promise.all(
    [...accepted].map(async ([id, city]) => (await http(path(city, id))).data),
  );
  const old = await controller.acquire("old", 1500);
  const move = await controller.begin(1, "node-b", old);
  await assert.rejects(controller.resume(move.id, old, "copied"), /stopped after copied/);
  await delay(1600);
  await assert.rejects(controller.begin(2, "node-a", old), /lease expired/);
  const fresh = await controller.acquire("fresh");
  try {
    await controller.resume(move.id, fresh);
    for (const previous of baseline)
      assert.deepEqual((await http(path(previous.city, previous.id))).data, previous);
    const stale = await http(`${common.nodes["node-b"]}/control/install`, "POST", {
      city: 1,
      id: move.id,
      generation: old.generation,
      version: 2,
      snapshot: (await controller.readTransfer(move.id)).snapshot,
    });
    assert.equal(stale.status, 409);
    const id = randomUUID();
    const result = await create(1, 9, id);
    assert.equal(result.status, 200);
    await state(1, id, "confirmed");
    const duplicate = await http(`${common.nodes["node-b"]}/control/install`, "POST", {
      city: 1,
      id: move.id,
      generation: fresh.generation,
      version: 2,
      snapshot: (await controller.readTransfer(move.id)).snapshot,
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await http(path(1, id))).data.state, "confirmed");
    compose("restart", "node-a");
    common.nodes["node-a"] = address("node-a");
    await until(
      () => http(`${common.nodes["node-a"]}/health`),
      (r) => r.status === 200,
    );
    const oldRoute = await http(
      `${common.nodes["node-a"]}/cities/1/bookings/${id}`,
      "GET",
      undefined,
      { "x-route-version": "1" },
    );
    assert.equal(oldRoute.status, 409);
    const staleWrite = await http(
      `${common.nodes["node-a"]}/cities/1/bookings`,
      "POST",
      { id: randomUUID(), driver: 12, driver_version: 1, amount: 900 },
      { "x-route-version": "1" },
    );
    assert.equal(staleWrite.status, 409);
    const other = await create(2, 2);
    assert.equal(other.status, 200);
    await state(2, other.data.id, "confirmed");
    await assert.rejects(controller.resume(move.id, old), /stale controller/);
  } finally {
    await controller.release(fresh);
  }
});
test("a later transfer can move current data back with a new map version", async () => {
  const lease = await controller.acquire("return");
  try {
    const move = await controller.begin(1, "node-a", lease);
    await controller.resume(move.id, lease);
    const route = await http<{ version: number }>(`${gateway}/placements/1`);
    assert.equal(route.data.version, 3);
    const result = await create(1, 10);
    assert.equal(result.status, 200);
    await state(1, result.data.id, "confirmed");
  } finally {
    await controller.release(lease);
  }
});
test("one stopped data owner does not stop reads of the other city", async () => {
  const result = await create(2, 3);
  await state(2, result.data.id, "confirmed");
  compose("stop", "node-a", "db-a");
  try {
    assert.equal((await http(path(2, result.data.id))).data.state, "confirmed");
    assert.equal((await create(1, 11)).status, 503);
  } finally {
    compose("start", "db-a", "node-a");
  }
});
