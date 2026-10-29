CREATE DATABASE IF NOT EXISTS sink_demo;
CREATE TABLE sink_demo.trip_raw
(
    source_topic String,
    source_partition UInt64,
    source_offset UInt64,
    event_id String,
    trip_id UInt64,
    version UInt64,
    city_id UInt64,
    occurred_at DateTime('UTC'),
    amount_cents UInt64
)
ENGINE = MergeTree
ORDER BY (trip_id, version, event_id);
CREATE TABLE sink_demo.trip_queue
(
    event_id String,
    trip_id UInt64,
    version UInt64,
    city_id UInt64,
    occurred_at DateTime('UTC'),
    amount_cents UInt64
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'trip.completed.demo',
    kafka_group_name = 'sink-demo',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_max_block_size = 100,
    kafka_flush_interval_ms = 1000;
CREATE MATERIALIZED VIEW sink_demo.trip_ingest
TO sink_demo.trip_raw AS
SELECT _topic AS source_topic, toUInt64(_partition) AS source_partition, _offset AS source_offset,
       event_id, trip_id, version, city_id, occurred_at, amount_cents
FROM sink_demo.trip_queue;
CREATE VIEW sink_demo.trip_current AS
SELECT trip_id, argMax(tuple(city_id, occurred_at, amount_cents), version) AS state
FROM sink_demo.trip_raw
GROUP BY trip_id;
