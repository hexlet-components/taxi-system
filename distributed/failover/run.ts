#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

// Optional teaching lab, ported from the course pilot. Only resources under this unique Compose project are removed.
const root = import.meta.dirname;
const output = resolve(process.argv[2] ?? "reports/failover");
const criteria = JSON.parse(readFileSync(resolve(root, "criteria.json"), "utf8"));
const work = mkdtempSync(resolve(tmpdir(), "system-design-pilot-"));
const project = `sdp-${process.pid}`;
const file = resolve(work, "compose.json");
const pgImage = "system-design-pilot-patroni:4.1.5";
const etcdImage = "gcr.io/etcd-development/etcd:v3.6.6";
const events: Record<string, unknown>[] = [];
let start = performance.now();
let activeCase = "";
mkdirSync(output, { recursive: true });

function docker(args: string[], input?: string, timeout = 15000): string {
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function compose(...args: string[]): string {
  return docker(["compose", "-p", project, "-f", file, ...args], undefined, 120000);
}
function signalController(service: string, signal: "STOP" | "CONT"): string {
  // PostgreSQL daemonizes; select Patroni by executable instead of stopping its database children.
  const pid = compose(
    "exec",
    "-T",
    service,
    "python3",
    "-c",
    "import psutil; print(next(p.pid for p in psutil.process_iter(['cmdline']) if '/opt/patroni/bin/patroni' in (p.info['cmdline'] or [])))",
  );
  assert(/^\d+$/.test(pid), "Expected a Patroni PID");
  compose("exec", "-T", service, "sh", "-c", `kill -${signal} ${pid}`);
  return pid;
}
function event(action: string, data: Record<string, unknown> = {}): void {
  events.push({
    case: activeCase,
    elapsedMs: Math.round(performance.now() - start),
    action,
    ...data,
  });
}
function sqlOn(service: string, sql: string, host = service): string {
  return compose(
    "exec",
    "-T",
    service,
    "psql",
    "-XAtq",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-h",
    host,
    "-d",
    "postgres",
    "-c",
    sql,
  );
}
function query(sql: string, host = "router"): string {
  return sqlOn("client", sql, host);
}
async function until(check: () => boolean, seconds = 45): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  let last: unknown;
  while (performance.now() < deadline) {
    try {
      if (check()) return;
    } catch (error) {
      last = error;
    }
    await delay(300);
  }
  throw new Error(`Condition timed out after ${seconds}s: ${String(last)}`);
}
function api(service: string, path: string): Record<string, any> {
  return JSON.parse(
    compose(
      "exec",
      "-T",
      "client",
      "curl",
      "-sf",
      "--max-time",
      "2",
      `http://${service}:8008${path}`,
    ),
  );
}
function leader(): string {
  return (
    ["p1", "p2", "p3"].find((name) => {
      try {
        return api(name, "/patroni").role === "primary";
      } catch {
        return false;
      }
    }) ?? ""
  );
}
function createStack(sync: boolean): void {
  const services: Record<string, any> = {};
  const cluster = [1, 2, 3].map((n) => `e${n}=http://e${n}:2380`).join(",");
  for (let n = 1; n <= 3; n++) {
    services[`e${n}`] = {
      image: etcdImage,
      mem_limit: "192m",
      cpus: 0.25,
      command: [
        "/usr/local/bin/etcd",
        `--name=e${n}`,
        "--listen-client-urls=http://0.0.0.0:2379",
        `--advertise-client-urls=http://e${n}:2379`,
        "--listen-peer-urls=http://0.0.0.0:2380",
        `--initial-advertise-peer-urls=http://e${n}:2380`,
        `--initial-cluster=${cluster}`,
        `--initial-cluster-token=${project}`,
        "--data-dir=/data",
      ],
      networks: ["control"],
    };
    const config = {
      scope: "taxi",
      name: `p${n}`,
      restapi: { listen: "0.0.0.0:8008", connect_address: `p${n}:8008` },
      etcd3: { hosts: ["e1:2379", "e2:2379", "e3:2379"] },
      bootstrap: {
        dcs: {
          ttl: 20,
          loop_wait: 1,
          retry_timeout: 3,
          synchronous_mode: sync,
          synchronous_mode_strict: sync,
          synchronous_node_count: 1,
          maximum_lag_on_failover: 1048576,
          check_timeline: true,
          postgresql: {
            use_pg_rewind: true,
            parameters: {
              wal_level: "replica",
              wal_log_hints: "on",
              max_wal_senders: 10,
              max_replication_slots: 10,
              shared_buffers: "32MB",
            },
          },
        },
        initdb: ["data-checksums"],
        pg_hba: ["host replication replicator all trust", "host all all all trust"],
      },
      postgresql: {
        listen: "0.0.0.0:5432",
        connect_address: `p${n}:5432`,
        data_dir: "/var/lib/postgresql/pilot",
        authentication: {
          superuser: { username: "postgres", password: "pilot" },
          replication: { username: "replicator", password: "pilot" },
          rewind: { username: "postgres", password: "pilot" },
        },
      },
      watchdog: { mode: "off" },
    };
    const configPath = resolve(work, `p${n}.json`);
    writeFileSync(configPath, JSON.stringify(config));
    services[`p${n}`] = {
      image: pgImage,
      init: true,
      mem_limit: "512m",
      cpus: 0.75,
      command: ["/config.json"],
      volumes: [`${configPath}:/config.json:ro`],
      networks: ["control", "data"],
    };
  }
  writeFileSync(
    resolve(work, "haproxy.cfg"),
    `global\n  maxconn 50\ndefaults\n  mode tcp\n  timeout connect 1s\n  timeout client 10s\n  timeout server 10s\nfrontend write\n  bind *:5432\n  default_backend primary\nbackend primary\n  option httpchk GET /primary\n  http-check expect status 200\n  default-server inter 300ms fall 2 rise 1 on-marked-down shutdown-sessions resolvers docker init-addr libc,none\n  server p1 p1:5432 check port 8008\n  server p2 p2:5432 check port 8008\n  server p3 p3:5432 check port 8008\nresolvers docker\n  nameserver dns 127.0.0.11:53\n  resolve_retries 3\n  timeout resolve 1s\n  timeout retry 1s\n  hold valid 1s\n`,
  );
  services.router = {
    image: "haproxy:3.2.7-alpine",
    mem_limit: "64m",
    cpus: 0.25,
    volumes: [`${resolve(work, "haproxy.cfg")}:/usr/local/etc/haproxy/haproxy.cfg:ro`],
    networks: ["data"],
  };
  services.client = {
    image: pgImage,
    entrypoint: ["sleep", "infinity"],
    mem_limit: "128m",
    cpus: 0.25,
    networks: ["data"],
  };
  writeFileSync(file, JSON.stringify({ services, networks: { control: {}, data: {} } }, null, 2));
}
async function reset(name: string, sync: boolean): Promise<void> {
  activeCase = name;
  events.length = 0;
  createStack(sync);
  start = performance.now();
  compose("up", "-d");
  await until(() => {
    const primary = leader();
    return (
      Boolean(primary) &&
      ["p1", "p2", "p3"].every((p) => api(p, "/patroni").state === "running") &&
      query("SELECT 1") === "1"
    );
  }, criteria.startupSeconds);
  if (sync) {
    await until(() => {
      const syncState = JSON.parse(
        compose(
          "exec",
          "-T",
          "e1",
          "etcdctl",
          "--endpoints=http://e1:2379",
          "get",
          "/service/taxi/sync",
          "--print-value-only",
        ) || "{}",
      );
      const sqlSync = query(
        "SELECT application_name FROM pg_stat_replication WHERE sync_state='sync'",
      );
      return syncState.leader === leader() && sqlSync !== "" && syncState.sync_standby === sqlSync;
    });
  }
  event("ready", { seconds: (performance.now() - start) / 1000, primary: leader() });
  query(
    "CREATE TABLE orders (operation_id text PRIMARY KEY, driver_id int UNIQUE NOT NULL, generation bigint NOT NULL DEFAULT 0)",
  );
}
function snapshot(host = "router"): unknown[] {
  return JSON.parse(
    query("SELECT coalesce(json_agg(t ORDER BY operation_id),'[]') FROM orders t", host),
  );
}
function acknowledge(id: string, driver: number, host = "router"): void {
  const result = query(
    `INSERT INTO orders(operation_id,driver_id) VALUES ('${id}',${driver}) ON CONFLICT(operation_id) DO NOTHING; SELECT '${id}'`,
    host,
  );
  assert(result.endsWith(id));
  event("ack", { id, driver, host });
}
function save(name: string, extra: Record<string, unknown>): void {
  const artifact = {
    name,
    platform: {
      os: process.platform,
      arch: process.arch,
      docker: JSON.parse(docker(["info", "--format", "{{json .}}"])).Architecture,
    },
    images: {
      postgres: {
        base: "postgres:18.7-bookworm",
        version: compose("exec", "-T", "client", "postgres", "--version"),
      },
      patroni: docker(["image", "inspect", pgImage, "--format", "{{.Id}}"]),
      etcd: docker(["image", "inspect", etcdImage, "--format", "{{json .RepoDigests}}"]),
      router: docker([
        "image",
        "inspect",
        "haproxy:3.2.7-alpine",
        "--format",
        "{{json .RepoDigests}}",
      ]),
    },
    events,
    ...extra,
  };
  writeFileSync(resolve(output, `${name}.json`), JSON.stringify(artifact, null, 2) + "\n");
  console.log(JSON.stringify({ name, rows: extra.rows, generation: extra.generation }));
}
async function teardown(): Promise<void> {
  try {
    writeFileSync(resolve(output, `${activeCase}.log`), compose("logs", "--no-color"));
  } catch {
    /* Preserve the original failure. */
  }
  // Unpause before stopping so Compose never waits on a frozen process.
  for (const service of ["p1", "p2", "p3"]) {
    try {
      compose("unpause", service);
    } catch {
      /* Not paused. */
    }
    try {
      signalController(service, "CONT");
    } catch {
      /* Not running. */
    }
  }
  compose("down", "-v", "--remove-orphans", "--timeout", "3");
}
async function stageOne(repeat: number): Promise<void> {
  await reset(`sql-fencing-${repeat}`, false);
  query(`CREATE TABLE lease (id int PRIMARY KEY, generation bigint NOT NULL, expires timestamptz NOT NULL);
    INSERT INTO lease VALUES(1,0,'-infinity');
    CREATE TABLE resource (id int PRIMARY KEY, generation bigint NOT NULL);
    INSERT INTO resource VALUES(1,0);
    CREATE FUNCTION apply_order(token bigint, op text, driver int) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE current_generation bigint;
    BEGIN
      SELECT generation INTO current_generation FROM resource WHERE id=1 FOR UPDATE;
      IF token <> current_generation THEN RETURN 'stale'; END IF;
      INSERT INTO orders VALUES(op,driver,token) ON CONFLICT(operation_id) DO NOTHING;
      RETURN 'accepted';
    END $$;`);
  const first = query(
    "UPDATE lease SET generation=generation+1, expires=clock_timestamp()+interval '1 second' WHERE id=1 AND expires<clock_timestamp() RETURNING generation",
  );
  query(`UPDATE resource SET generation=${first} WHERE id=1 AND generation<${first}`);
  // A real client process pauses before sending the retained old command.
  const paused = spawn(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      file,
      "exec",
      "-T",
      "client",
      "sh",
      "-c",
      `echo $$ >/tmp/holder; kill -STOP $$; exec psql -XAt -U postgres -h router -c "SELECT apply_order(${first},'late',9)"`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let oldResult = "";
  paused.stdout.on("data", (chunk) => {
    oldResult += chunk;
  });
  const completion = new Promise<number | null>((done) => paused.on("exit", done));
  await until(() => compose("exec", "-T", "client", "test", "-f", "/tmp/holder") === "");
  event("holder-paused", { generation: Number(first) });
  let next = "";
  await until(() => {
    next = query(
      "UPDATE lease SET generation=generation+1, expires=clock_timestamp()+interval '1 second' WHERE id=1 AND expires<clock_timestamp() RETURNING generation",
    );
    return next === "2";
  });
  query(`UPDATE resource SET generation=${next} WHERE id=1 AND generation<${next}`);
  event("activate", { generation: Number(next) });
  const accepted = query(`SELECT apply_order(${next},'new',1)`);
  assert.equal(accepted, "accepted");
  event("ack", { id: "new", driver: 1, generation: Number(next) });
  assert.equal(query(`SELECT apply_order(${next},'new',1)`), "accepted");
  event("ack", { id: "new", driver: 1, generation: Number(next) });
  compose("exec", "-T", "client", "sh", "-c", "kill -CONT $(cat /tmp/holder)");
  assert.equal(await completion, 0);
  assert.equal(oldResult.trim(), "stale");
  event("old-result", { result: oldResult.trim() });
  const primary = leader();
  // Restart PostgreSQL under Patroni without replacing persistent container storage.
  compose(
    "exec",
    "-T",
    primary,
    "pg_ctl",
    "-D",
    "/var/lib/postgresql/pilot",
    "restart",
    "-m",
    "fast",
    "-w",
  );
  await until(() => query(`SELECT apply_order(${first},'late-after-restart',10)`) === "stale");
  event("restart-old-result", { result: "stale" });
  assert.equal(Number(query("SELECT generation FROM resource WHERE id=1")), 2);
  assert.equal(Number(query("SELECT generation FROM lease WHERE id=1")), 2);
  let afterRestart = "";
  await until(() => {
    afterRestart = query(
      "UPDATE lease SET generation=generation+1, expires=clock_timestamp()+interval '1 second' WHERE id=1 AND expires<clock_timestamp() RETURNING generation",
    );
    return afterRestart === "3";
  });
  query(`UPDATE resource SET generation=${afterRestart} WHERE id=1 AND generation<${afterRestart}`);
  assert.equal(query(`SELECT apply_order(${next},'late-generation-two',11)`), "stale");
  event("reacquire-after-restart", {
    generation: Number(afterRestart),
    oldGenerationResult: "stale",
  });
  const generation = Number(query("SELECT generation FROM resource WHERE id=1"));
  const durableCoordinatorGeneration = Number(query("SELECT generation FROM lease WHERE id=1"));
  const rows = snapshot();
  save(activeCase, { generation, durableCoordinatorGeneration, rows });
}
async function failover(
  repeat: number,
  kind: "sync-network" | "async-loss" | "controller-pause",
): Promise<void> {
  await reset(`${kind}-${repeat}`, kind === "sync-network");
  const old = leader();
  acknowledge("before", 1);
  // Separate the known baseline from the deliberately unreplicated writes.
  // Check the baseline on every replica before either asynchronous failure.
  if (kind !== "sync-network") {
    await until(() =>
      ["p1", "p2", "p3"].every(
        (p) => query("SELECT count(*) FROM orders WHERE operation_id='before'", p) === "1",
      ),
    );
  }
  // Establish a direct persistent connection before the fault; read one command at a time.
  const connection = spawn(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      file,
      "exec",
      "-T",
      "client",
      "psql",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-h",
      old,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let directOutput = "";
  connection.stdout.on("data", (chunk) => {
    directOutput += chunk;
  });
  connection.stderr.on("data", () => {});
  connection.stdin.write("SELECT 'connected';\n");
  await until(() => directOutput.includes("connected"));
  let directExit: number | null | undefined;
  connection.on("exit", (code) => {
    directExit = code;
  });
  if (kind === "async-loss") {
    // Both standbys stay reachable and eligible, but cannot receive new WAL.
    compose(
      "exec",
      "-T",
      old,
      "sh",
      "-c",
      "sed -i '1i host replication replicator 127.0.0.1/32 trust\\nhost replication replicator ::1/128 trust\\nhost replication replicator all reject' /var/lib/postgresql/pilot/pg_hba.conf",
    );
    query("SELECT pg_reload_conf()", old);
    query("SELECT pg_terminate_backend(pid) FROM pg_stat_replication", old);
    await until(() => query("SELECT count(*) FROM pg_stat_replication", old) === "0");
    event("replication-blocked");
    for (let n = 0; n < 3; n++) acknowledge(`gap-${n}`, 10 + n, old);
    compose("stop", "-t", "0", old);
    event("primary-stopped");
  } else if (kind === "sync-network") {
    docker(["network", "disconnect", `${project}_control`, compose("ps", "-q", old)]);
    event("dcs-network-disconnected");
  } else {
    const pid = signalController(old, "STOP");
    const processStatus = compose("exec", "-T", old, "cat", `/proc/${pid}/status`);
    assert(processStatus.includes("T (stopped)"), "Patroni did not pause");
    assert.equal(query("SELECT pg_is_in_recovery()", old), "f");
    event("patroni-paused", { processState: "T", postgresStillRunning: true });
  }
  const failureTime = performance.now();
  let fresh = "";
  await until(() => {
    fresh =
      ["p1", "p2", "p3"]
        .filter((p) => p !== old)
        .find((p) => api(p, "/patroni").role === "primary") ?? "";
    return (
      Boolean(fresh) &&
      query("SELECT inet_server_addr()::text") ===
        query("SELECT inet_server_addr()::text", fresh) &&
      query("SELECT NOT pg_is_in_recovery()") === "t"
    );
  }, criteria.failoverSeconds);
  event("new-primary", { old, fresh, failoverSeconds: (performance.now() - failureTime) / 1000 });
  acknowledge("after", 2);
  const rows = snapshot();
  if (kind === "controller-pause") {
    connection.stdin.write(
      "INSERT INTO orders VALUES('stale-writer',99,0); SELECT 'stale-write-accepted';\n",
    );
    await until(() => directOutput.includes("stale-write-accepted"));
    event("old-write", { result: "accepted", id: "stale-writer", existingConnection: true });
    assert.equal(query("SELECT count(*) FROM orders WHERE operation_id='stale-writer'", old), "1");
    event("old-snapshot", { rows: snapshot(old) });
    signalController(old, "CONT");
  } else if (kind === "sync-network") {
    connection.stdin.write(
      "INSERT INTO orders VALUES('stale-writer',99,0); SELECT 'stale-write-accepted';\n",
    );
    await until(() => directExit !== undefined);
    event("old-connection-closed", { exit: directExit });
    let rejected = false;
    try {
      query("INSERT INTO orders VALUES('stale-writer',99,0)", old);
    } catch {
      rejected = true;
    }
    assert(rejected);
    event("old-write", { result: "rejected" });
    docker(["network", "connect", `${project}_control`, compose("ps", "-q", old)]);
  } else {
    compose("start", old);
  }
  connection.stdin.end();
  await until(
    () =>
      api(old, "/patroni").role === "replica" && query("SELECT pg_is_in_recovery()", old) === "t",
  );
  await until(() => JSON.stringify(snapshot(old)) === JSON.stringify(rows));
  event("former-primary-is-replica", { rows: snapshot(old) });
  const stats = docker([
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    ...compose("ps", "-q").split("\n"),
  ]);
  save(activeCase, {
    rows,
    old,
    fresh,
    directOutput,
    stats: stats.split("\n").map((line) => JSON.parse(line)),
  });
}

try {
  for (
    let repeat = 1;
    repeat <= (process.argv[4] ? Number(process.argv[4]) : criteria.repeats);
    repeat++
  ) {
    for (const kind of ["sql-fencing", "sync-network", "async-loss", "controller-pause"] as const) {
      if (process.argv[3] && process.argv[3] !== kind) continue;
      try {
        if (kind === "sql-fencing") await stageOne(repeat);
        else await failover(repeat, kind);
      } finally {
        await teardown();
      }
    }
  }
} catch (error) {
  writeFileSync(
    resolve(output, "failure.json"),
    JSON.stringify({ case: activeCase, error: String(error), events }, null, 2),
  );
  throw error;
}
