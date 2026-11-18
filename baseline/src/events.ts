import { Kafka, logLevel, Partitioners } from "kafkajs";
import { pool, tx, loop, check } from "./common.ts";
export const topic = "taxi-trips";
const kafka = new Kafka({
  clientId: process.env.ROLE ?? "baseline",
  brokers: [process.env.KAFKA_BROKER ?? "kafka:9092"],
  logLevel: logLevel.ERROR,
  retry: { retries: 5, initialRetryTime: 200 },
  requestTimeout: 3000,
});
export async function createTopic(): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  } finally {
    await admin.disconnect();
  }
}
export async function publish(): Promise<never> {
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  await producer.connect();
  return loop(async () => {
    await tx(async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM event_outbox WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      if (!rows[0]) return;
      const event = rows[0];
      await producer.send({
        topic,
        acks: -1,
        messages: [
          { key: String(event.trip_id), value: JSON.stringify({ id: event.id, ...event.payload }) },
        ],
      });
      await db.query("UPDATE event_outbox SET published_at=now() WHERE id=$1", [event.id]);
    });
  });
}
export async function consume(): Promise<void> {
  const consumer = kafka.consumer({
    groupId: process.env.CONSUMER_GROUP ?? "taxi-summary",
    sessionTimeout: 10000,
  });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      check(message.value, "missing event");
      const event = JSON.parse(message.value.toString());
      check(
        /^\d+$/.test(String(event.id)) &&
          /^\d+$/.test(String(event.trip_id)) &&
          typeof event.status === "string" &&
          Number.isFinite(Number(event.price)),
        "invalid event",
      );
      await tx(async (db) => {
        const receipt = await db.query(
          "INSERT INTO processed_events (event_id,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
          [event.id, event],
        );
        if (receipt.rowCount === 0) {
          const known = await db.query(
            "SELECT payload=$2::jsonb AS same FROM processed_events WHERE event_id=$1",
            [event.id, event],
          );
          check(known.rows[0].same, "event id reused", 409);
          await db.query("UPDATE processed_events SET deliveries=deliveries+1 WHERE event_id=$1", [
            event.id,
          ]);
          return;
        }
        await db.query(
          "INSERT INTO trip_summary (trip_id,status,price,source_version) VALUES ($1,$2,$3,$4) ON CONFLICT (trip_id) DO UPDATE SET status=EXCLUDED.status,price=EXCLUDED.price,source_version=EXCLUDED.source_version,updated_at=now() WHERE trip_summary.source_version<EXCLUDED.source_version",
          [event.trip_id, event.status, event.price, event.id],
        );
      });
      // The SQL transaction commits first. Redelivery after a crash is deduplicated there.
      await consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    },
  });
}
export async function summary(_method: string, path: string): Promise<unknown> {
  if (path === "/summary")
    return (
      await pool.query(
        "SELECT status,count(*)::int AS trips FROM trip_summary GROUP BY status ORDER BY status",
      )
    ).rows;
  const match = path.match(/^\/summary\/trips\/(\d+)$/);
  check(match, "not found", 404);
  const { rows } = await pool.query("SELECT * FROM trip_summary WHERE trip_id=$1", [match[1]]);
  check(rows[0], "summary not yet available", 404);
  return rows[0];
}
